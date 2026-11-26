// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore

/**
 * Signing in to Talaris on the web (docs/WEB.md, *Signing in*): one person, passkeys, no passwords.
 *
 * - **Passkeys** (WebAuthn): only their public halves are kept here, named, listed and removable.
 * - **A passkey is added** only with a one-time code printed by `talaris-web passkey` on the machine itself — never
 *   from the web alone: the first passkey, and one to replace a lost one, come the same way.
 * - **A session** is a random token in a cookie (HttpOnly, Secure, SameSite=Strict, path /talaris), kept here only
 *   as its hash; good for 30 days from its last use; listed and revocable.
 * - **Failures slow down**, by address: each failed try doubles the wait before the next is heard.
 *
 * Kept in `~/.config/talaris/web.json` (0600), beside the machine's own keys.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse,
} from "@simplewebauthn/server";

const FILE = process.env.TALARIS_WEB_STATE ?? join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "talaris", "web.json");
const SESSION_DAYS = 30;
const CODE_MINUTES = 10;
export const COOKIE = "talaris_session";

/** Where Talaris is reached: the passkeys are bound to this name, and only pages from this origin may use them. */
export const RP_ID = process.env.TALARIS_WEB_RP_ID ?? "app.schoolahead.today";
export const ORIGIN = process.env.TALARIS_WEB_ORIGIN ?? `https://${RP_ID}`;
const RP_NAME = "Talaris";
const USER_ID = new TextEncoder().encode("talaris-owner");

const hash = (s) => createHash("sha256").update(s).digest("hex");

function load() {
  try { return JSON.parse(readFileSync(FILE, "utf8")); } catch { return { passkeys: [], sessions: [], codes: [] }; }
}
function save(state) {
  mkdirSync(dirname(FILE), { recursive: true, mode: 0o700 });
  writeFileSync(`${FILE}.new`, JSON.stringify(state, null, 2), { mode: 0o600 });
  renameSync(`${FILE}.new`, FILE);
}

// ------------------------------------------------------------ one-time codes (talaris-web passkey)

/** A code that lets one passkey be added, for ten minutes: printed on the machine, never shown on the web. */
export function makeCode() {
  const code = randomBytes(5).toString("hex").toUpperCase().replace(/(.{5})/, "$1-");
  const state = load();
  state.codes = (state.codes || []).filter((c) => c.until > Date.now());
  state.codes.push({ hash: hash(code.replace(/-/g, "")), until: Date.now() + CODE_MINUTES * 60_000 });
  save(state);
  return code;
}
function takeCode(code) {
  const want = hash(String(code || "").toUpperCase().replace(/[^0-9A-F]/g, ""));
  const state = load();
  const found = (state.codes || []).find((c) => c.until > Date.now() && timingSafeEqual(Buffer.from(c.hash), Buffer.from(want)));
  if (!found) return false;
  state.codes = state.codes.filter((c) => c !== found);
  save(state);
  return true;
}

// ------------------------------------------------------------ slowing down failures

const failures = new Map(); // address → {n, until}
export function waitFor(addr) {
  const f = failures.get(addr);
  return f && f.until > Date.now() ? Math.ceil((f.until - Date.now()) / 1000) : 0;
}
function failed(addr) {
  const f = failures.get(addr) ?? { n: 0, until: 0 };
  f.n += 1;
  f.until = Date.now() + Math.min(2 ** f.n, 900) * 1000;
  failures.set(addr, f);
}
const succeeded = (addr) => failures.delete(addr);

// ------------------------------------------------------------ challenges, held briefly

const challenges = new Map(); // id → {challenge, until, kind}
function hold(kind, challenge) {
  const id = randomBytes(16).toString("hex");
  challenges.set(id, { challenge, kind, until: Date.now() + 5 * 60_000 });
  for (const [k, v] of challenges) if (v.until < Date.now()) challenges.delete(k);
  return id;
}
function take(id, kind) {
  const c = challenges.get(id);
  challenges.delete(id);
  return c && c.kind === kind && c.until > Date.now() ? c.challenge : null;
}

// ------------------------------------------------------------ passkeys

export const hasPasskeys = () => (load().passkeys || []).length > 0;

/** Adding a passkey: allowed with a fresh one-time code, or while signed in (and then asked again by the passkey). */
export async function registerOptions({ code, signedIn, addr }) {
  if (waitFor(addr)) return { error: `Wait ${waitFor(addr)} s`, status: 429 };
  if (!signedIn && !takeCode(code)) { failed(addr); return { error: "That code is not right, or it has run out", status: 403 }; }
  succeeded(addr);
  const state = load();
  const options = await generateRegistrationOptions({
    rpName: RP_NAME, rpID: RP_ID, userID: USER_ID, userName: "you", userDisplayName: "You",
    attestationType: "none",
    excludeCredentials: (state.passkeys || []).map((p) => ({ id: p.id, transports: p.transports })),
    authenticatorSelection: { residentKey: "required", userVerification: "required" },
  });
  return { options, hold: hold("register", options.challenge) };
}

export async function register({ hold: held, response, name }) {
  const expectedChallenge = take(held, "register");
  if (!expectedChallenge) return { error: "That took too long: start again", status: 400 };
  let v;
  try {
    v = await verifyRegistrationResponse({ response, expectedChallenge, expectedOrigin: ORIGIN, expectedRPID: RP_ID, requireUserVerification: true });
  } catch (e) { return { error: e.message, status: 400 }; }
  if (!v.verified || !v.registrationInfo) return { error: "The passkey could not be checked", status: 400 };
  const { credential } = v.registrationInfo;
  const state = load();
  state.passkeys = state.passkeys || [];
  state.passkeys.push({
    id: credential.id, publicKey: Buffer.from(credential.publicKey).toString("base64url"), counter: credential.counter,
    transports: credential.transports || [], name: String(name || "A passkey").slice(0, 60), added: new Date().toISOString(), used: null,
  });
  save(state);
  return { ok: true };
}

export async function signInOptions({ addr }) {
  if (waitFor(addr)) return { error: `Wait ${waitFor(addr)} s`, status: 429 };
  const options = await generateAuthenticationOptions({ rpID: RP_ID, userVerification: "required", allowCredentials: [] });
  return { options, hold: hold("signin", options.challenge) };
}

export async function signIn({ hold: held, response, addr, device }) {
  if (waitFor(addr)) return { error: `Wait ${waitFor(addr)} s`, status: 429 };
  const expectedChallenge = take(held, "signin");
  const state = load();
  const key = (state.passkeys || []).find((p) => p.id === response?.id);
  if (!expectedChallenge || !key) { failed(addr); return { error: "That passkey is not one of Talaris's", status: 403 }; }
  let v;
  try {
    v = await verifyAuthenticationResponse({
      response, expectedChallenge, expectedOrigin: ORIGIN, expectedRPID: RP_ID, requireUserVerification: true,
      credential: { id: key.id, publicKey: Buffer.from(key.publicKey, "base64url"), counter: key.counter, transports: key.transports },
    });
  } catch (e) { failed(addr); return { error: e.message, status: 403 }; }
  if (!v.verified) { failed(addr); return { error: "The passkey could not be checked", status: 403 }; }
  succeeded(addr);
  key.counter = v.authenticationInfo.newCounter;
  key.used = new Date().toISOString();
  const token = randomBytes(32).toString("base64url");
  state.sessions = (state.sessions || []).filter((s) => s.until > Date.now());
  state.sessions.push({ hash: hash(token), id: randomBytes(6).toString("hex"), device: String(device || "").slice(0, 120),
    passkey: key.name, started: new Date().toISOString(), seen: new Date().toISOString(), until: Date.now() + SESSION_DAYS * 86_400_000 });
  save(state);
  return { ok: true, token };
}

// ------------------------------------------------------------ sessions

/** The session a cookie names, kept alive by its use; or null. */
export function session(token) {
  if (!token) return null;
  const state = load();
  const s = (state.sessions || []).find((x) => x.hash === hash(token) && x.until > Date.now());
  if (!s) return null;
  // Its use renews it — written at most once an hour, not on every request.
  if (Date.now() - Date.parse(s.seen) > 3_600_000) {
    s.seen = new Date().toISOString();
    s.until = Date.now() + SESSION_DAYS * 86_400_000;
    save(state);
  }
  return s;
}

export function signOut(token) {
  const state = load();
  state.sessions = (state.sessions || []).filter((s) => s.hash !== hash(token || ""));
  save(state);
}

/** What Settings on the web lists: the passkeys and the sessions, nothing secret. */
export function listed(current) {
  const state = load();
  return {
    passkeys: (state.passkeys || []).map(({ id, name, added, used }) => ({ id, name, added, used })),
    sessions: (state.sessions || []).filter((s) => s.until > Date.now())
      .map(({ id, device, passkey, started, seen, hash: h }) => ({ id, device, passkey, started, seen, current: h === current?.hash })),
  };
}

export function removePasskey(id) {
  const state = load();
  if ((state.passkeys || []).length <= 1) return { error: "The last passkey stays: add another first", status: 400 };
  state.passkeys = state.passkeys.filter((p) => p.id !== id);
  save(state);
  return { ok: true };
}

export function endSession(id) {
  const state = load();
  state.sessions = (state.sessions || []).filter((s) => s.id !== id);
  save(state);
  return { ok: true };
}

export const stateFile = () => FILE;
export const stateExists = () => existsSync(FILE);
