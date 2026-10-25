// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { newRecovery, recoveryPublic, seal, sealTo, unseal, unsealWith, SealError } from "./seal.js";
import { writeJson } from "./store.js";

/**
 * The store's key, and the recovery key behind it.
 *
 * The key is 32 random bytes in the login keyring; the core asks for it
 * through `keyring.py` (libsecret, which Node has no binding for). Beside the
 * store, in `vault.json`, are only things that are safe to be seen: the
 * recovery key's public half, the store key sealed to it, and a check that a
 * key is the right one.
 *
 * **A key is never made over existing data.** A keyring that is locked, or not
 * up yet, makes the store *locked* — try again — never empty. A keyring that
 * certainly has no key, beside a vault that exists, makes it locked too, until
 * the recovery key opens the sealed copy and puts the key back.
 */

function xdg(name: string, fallback: string): string {
  const value = process.env[name];
  return value && value.trim() ? value : join(homedir(), fallback);
}

export const DATA_DIR = process.env.TALARIS_DATA_DIR ?? join(xdg("XDG_DATA_HOME", ".local/share"), "talaris");
export const ENTITIES_DIR = join(DATA_DIR, "entities");
const VAULT = join(ENTITIES_DIR, "vault.json");
const KEYRING = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "keyring.py");
const STORE_KEY = "store-key";
const PENDING = "recovery-pending";
const CHECK = "talaris";

export class Locked extends Error {}

interface Vault {
  created: string;
  publicKey: string;
  wrapped: string;
  check: string;
  recoveryKept: boolean;
}

let key: Buffer | null = null;
// Under test (TALARIS_KEY) there is no keyring: the pending recovery key waits here.
let pendingHere: string | null = null;

function keyring(verb: string, name: string, input?: string): { code: number; out: string; err: string } {
  try {
    const out = execFileSync("python3", [KEYRING, verb, name], { input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 15000 });
    return { code: 0, out: out.trim(), err: "" };
  } catch (e) {
    const x = e as { status?: number; stderr?: string };
    return { code: x.status ?? 2, out: "", err: String(x.stderr ?? "").trim() };
  }
}

const testing = () => Boolean(process.env.TALARIS_KEY);

function readVault(): Vault | null {
  return existsSync(VAULT) ? (JSON.parse(readFileSync(VAULT, "utf8")) as Vault) : null;
}

function checks(k: Buffer, vault: Vault): boolean {
  try {
    return unseal(k, Buffer.from(vault.check, "base64")).toString() === CHECK;
  } catch {
    return false;
  }
}

function setPending(recoveryKey: string): void {
  if (testing()) pendingHere = recoveryKey;
  else keyring("set", PENDING, recoveryKey + "\n");
}

/** Make the store's vault: only where there is none. */
function create(): Buffer {
  let k: Buffer;
  if (testing()) {
    k = Buffer.from(process.env.TALARIS_KEY!, "base64");
  } else {
    const made = keyring("make", STORE_KEY);
    if (made.code === 0) k = Buffer.from(made.out, "base64");
    else if (made.code === 3) k = Buffer.from(keyring("get", STORE_KEY).out, "base64"); // kept from a store since removed
    else throw new Locked(made.err || "the login keyring is not available yet");
  }
  const { recoveryKey, publicKey } = newRecovery();
  const vault: Vault = {
    created: new Date().toISOString(),
    publicKey,
    wrapped: sealTo(publicKey, k).toString("base64"),
    check: seal(k, CHECK).toString("base64"),
    recoveryKept: false,
  };
  writeJson(VAULT, vault);
  setPending(recoveryKey);
  return k;
}

/** The store's key, or `Locked` saying why not. */
export function storeKey(): Buffer {
  if (key) return key;
  const vault = readVault();
  if (!vault) return (key = create());
  let k: Buffer;
  if (testing()) {
    k = Buffer.from(process.env.TALARIS_KEY!, "base64");
  } else {
    const got = keyring("get", STORE_KEY);
    if (got.code === 1) throw new Locked("the keyring has no key for this store: open it with the recovery key");
    if (got.code !== 0) throw new Locked(got.err || "the login keyring is not available yet");
    k = Buffer.from(got.out, "base64");
  }
  if (!checks(k, vault)) throw new Locked("the keyring's key does not open this store: open it with the recovery key");
  return (key = k);
}

export function vaultPublicKey(): string {
  storeKey();
  return readVault()!.publicKey;
}

/** The recovery key opens the sealed copy of the store's key and puts it back in the keyring. */
export function unlock(recoveryKey: string): void {
  const vault = readVault();
  if (!vault) throw new Locked("there is no store to open");
  if (recoveryPublic(recoveryKey) !== vault.publicKey) throw new SealError("that is not this store's recovery key");
  const k = unsealWith(recoveryKey, Buffer.from(vault.wrapped, "base64"));
  if (!checks(k, vault)) throw new SealError("the sealed key does not open this store");
  if (!testing()) keyring("set", STORE_KEY, k.toString("base64") + "\n");
  key = k;
}

export interface RecoveryState {
  locked: string | null;
  kept: boolean;
  /** Shown until it is said to be kept; then nowhere, ever. */
  pending: string | null;
  publicKey: string | null;
}

export function recoveryState(): RecoveryState {
  let locked: string | null = null;
  try { storeKey(); } catch (e) { locked = (e as Error).message; }
  const vault = readVault();
  let pending: string | null = null;
  if (vault && !vault.recoveryKept && !locked) {
    pending = testing() ? pendingHere : (keyring("get", PENDING).out || null);
  }
  return { locked, kept: vault?.recoveryKept ?? false, pending, publicKey: vault?.publicKey ?? null };
}

/** The recovery key is written down: it is forgotten here. */
export function recoveryKept(): void {
  const vault = readVault();
  if (!vault) return;
  writeJson(VAULT, { ...vault, recoveryKept: true });
  if (testing()) pendingHere = null;
  else keyring("forget", PENDING);
}

/** A new recovery key; the store's key sealed again to it. Old backups still need the old one. */
export function replaceRecovery(): string {
  const k = storeKey();
  const vault = readVault()!;
  const { recoveryKey, publicKey } = newRecovery();
  writeJson(VAULT, { ...vault, publicKey, wrapped: sealTo(publicKey, k).toString("base64"), recoveryKept: false });
  setPending(recoveryKey);
  return recoveryKey;
}

/** The vault as a backup carries it: the public half and the sealed key, nothing secret. */
export function vaultForBackup(): Pick<Vault, "publicKey" | "wrapped" | "check"> {
  storeKey();
  const v = readVault()!;
  return { publicKey: v.publicKey, wrapped: v.wrapped, check: v.check };
}

/**
 * A revived backup's key becomes this store's: what was sealed with it — an
 * encrypted project synced in from elsewhere — opens again. The recovery key
 * has already proved itself by opening the backup.
 */
export function adopt(from: Pick<Vault, "publicKey" | "wrapped" | "check">, recoveryKey: string): void {
  if (recoveryPublic(recoveryKey) !== from.publicKey) throw new SealError("that is not this backup's recovery key");
  const k = unsealWith(recoveryKey, Buffer.from(from.wrapped, "base64"));
  if (!checks(k, { ...from, created: "", recoveryKept: true })) throw new SealError("the backup's key does not open its own check");
  if (!testing()) {
    const set = keyring("set", STORE_KEY, k.toString("base64") + "\n");
    if (set.code !== 0) throw new Locked(set.err || "the login keyring would not take the key");
  }
  const previous = readVault();
  writeJson(VAULT, { created: previous?.created ?? new Date().toISOString(), ...from, recoveryKept: true });
  key = k;
}

/** Under test: start again with no key and no vault in memory. */
export function forgetKeyForTests(): void {
  key = null;
  pendingHere = null;
}

// ------------------------------------------------------------ other secrets

/*
 * A plugin's secrets (an access key, a password) in the login keyring beside
 * the store's own key, by name — never in a file. Under test there is no
 * keyring, and they are kept in memory.
 */
const heldHere = new Map<string, string>();

/** A secret, or null when the keyring has none. Locked or not running is an error to try again, never "none". */
export function getSecret(name: string): string | null {
  if (testing()) return heldHere.get(name) ?? null;
  const got = keyring("get", name);
  if (got.code === 1) return null;
  if (got.code !== 0) throw new Locked(got.err || "the login keyring is not available yet");
  return got.out;
}

export function setSecret(name: string, value: string): void {
  if (testing()) { heldHere.set(name, value); return; }
  const done = keyring("set", name, value + "\n");
  if (done.code !== 0) throw new Locked(done.err || "the login keyring is not available yet");
}

export function forgetSecret(name: string): void {
  if (testing()) { heldHere.delete(name); return; }
  keyring("forget", name);
}
