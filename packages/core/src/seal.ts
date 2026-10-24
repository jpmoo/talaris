// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore

import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  type KeyObject,
} from "node:crypto";

/**
 * Sealing: what Talaris stores, it stores encrypted.
 *
 * - **With the store's key** (`seal`/`unseal`): AES-256-GCM, a fresh nonce
 *   each time. Entities, their files, and an encrypted project's pages.
 * - **To the recovery key** (`sealTo`/`unsealWith`): X25519 to the recovery
 *   key's public half, then the same. Backups, and the store's key itself, so
 *   that a lost keyring is not lost data. Talaris keeps only the public half —
 *   enough to seal, never enough to open.
 *
 * Every sealed thing starts with a short mark saying which it is, so a file
 * read back can say "this is sealed" rather than "this is broken JSON".
 */

const STORE_MARK = Buffer.from("TLS1");
const RECOVERY_MARK = Buffer.from("TLR1");
const NONCE = 12;
const TAG = 16;

export class SealError extends Error {}

export function isSealed(data: Buffer): boolean {
  return data.length > 4 && (data.subarray(0, 4).equals(STORE_MARK) || data.subarray(0, 4).equals(RECOVERY_MARK));
}

function gcm(key: Buffer, data: Buffer, mark: Buffer, extra: Buffer = Buffer.alloc(0)): Buffer {
  const nonce = randomBytes(NONCE);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const body = Buffer.concat([cipher.update(data), cipher.final()]);
  return Buffer.concat([mark, extra, nonce, body, cipher.getAuthTag()]);
}

function ungcm(key: Buffer, data: Buffer, from: number): Buffer {
  const nonce = data.subarray(from, from + NONCE);
  const tag = data.subarray(data.length - TAG);
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(data.subarray(from + NONCE, data.length - TAG)), decipher.final()]);
  } catch {
    throw new SealError("this was sealed with a different key, or has been damaged");
  }
}

export function seal(key: Buffer, data: Buffer | string): Buffer {
  return gcm(key, typeof data === "string" ? Buffer.from(data, "utf8") : data, STORE_MARK);
}

export function unseal(key: Buffer, data: Buffer): Buffer {
  if (!data.subarray(0, 4).equals(STORE_MARK)) throw new SealError("not sealed with the store's key");
  return ungcm(key, data, 4);
}

// ------------------------------------------------------------ the recovery key

// X25519 keys travel raw; Node wants them wrapped in their DER headers.
const PKCS8 = Buffer.from("302e020100300506032b656e04220420", "hex");
const SPKI = Buffer.from("302a300506032b656e032100", "hex");

const privateFrom = (raw: Buffer): KeyObject => createPrivateKey({ key: Buffer.concat([PKCS8, raw]), format: "der", type: "pkcs8" });
const publicFrom = (raw: Buffer): KeyObject => createPublicKey({ key: Buffer.concat([SPKI, raw]), format: "der", type: "spki" });
const rawPublic = (key: KeyObject): Buffer => key.export({ format: "der", type: "spki" }).subarray(SPKI.length);
const rawPrivate = (key: KeyObject): Buffer => key.export({ format: "der", type: "pkcs8" }).subarray(PKCS8.length);

function wrapKey(shared: Buffer, ephemeral: Buffer): Buffer {
  return Buffer.from(hkdfSync("sha256", shared, ephemeral, "talaris recovery", 32));
}

/** A new recovery key: the private half to show once, the public half to keep. */
export function newRecovery(): { recoveryKey: string; publicKey: string } {
  const { privateKey, publicKey } = generateKeyPairSync("x25519");
  return { recoveryKey: formatRecovery(rawPrivate(privateKey)), publicKey: rawPublic(publicKey).toString("base64") };
}

/** The public half of a recovery key, to check that one typed in is the right one. */
export function recoveryPublic(recoveryKey: string): string {
  return rawPublic(createPublicKey(privateFrom(parseRecovery(recoveryKey)))).toString("base64");
}

export function sealTo(publicKey: string, data: Buffer | string): Buffer {
  const { privateKey, publicKey: mine } = generateKeyPairSync("x25519");
  const ephemeral = rawPublic(mine);
  const shared = diffieHellman({ privateKey, publicKey: publicFrom(Buffer.from(publicKey, "base64")) });
  return gcm(wrapKey(shared, ephemeral), typeof data === "string" ? Buffer.from(data, "utf8") : data, RECOVERY_MARK, ephemeral);
}

export function unsealWith(recoveryKey: string, data: Buffer): Buffer {
  if (!data.subarray(0, 4).equals(RECOVERY_MARK)) throw new SealError("not sealed to a recovery key");
  const ephemeral = data.subarray(4, 36);
  const shared = diffieHellman({ privateKey: privateFrom(parseRecovery(recoveryKey)), publicKey: publicFrom(ephemeral) });
  try {
    return ungcm(wrapKey(shared, ephemeral), data, 36);
  } catch {
    throw new SealError("that recovery key does not open this");
  }
}

// Written down by a person: base32 (no 0/1/8/9 to misread), in groups of four.
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function formatRecovery(raw: Buffer): string {
  let bits = "";
  for (const byte of raw) bits += byte.toString(2).padStart(8, "0");
  let out = "";
  for (let i = 0; i < bits.length; i += 5) out += ALPHABET[parseInt(bits.slice(i, i + 5).padEnd(5, "0"), 2)];
  return out.match(/.{1,4}/g)!.join("-");
}

function parseRecovery(text: string): Buffer {
  const clean = text.toUpperCase().replace(/[^A-Z2-7]/g, "");
  if (clean.length !== 52) throw new SealError("a recovery key is 52 letters and digits");
  let bits = "";
  for (const c of clean) bits += ALPHABET.indexOf(c).toString(2).padStart(5, "0");
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length && bytes.length < 32; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}
