// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore

/**
 * Sync's records (docs/SYNC.md, *Records*): every change Talaris makes, as a
 * small record of what changed — these fields of this thing, never the whole
 * thing — appended, sealed, to a log only this machine writes. The other
 * machines read it and apply it (step 3); nothing here reads another's.
 *
 * **Off until this machine syncs.** A Talaris on one machine writes no log:
 * `sync/on` in the data folder says it does (written when sync is set up).
 *
 * **The clock** is a hybrid logical clock (*Order*): wall time, carried forward
 * past anything already seen, a counter within one instant, and the machine
 * to break the last tie — so two machines agree which of two records is later
 * whatever their clocks say.
 *
 * **Batches.** What one action changes is one batch, applied whole or not at
 * all. Everything written in one turn of the event loop is one batch, and
 * `inBatch` holds one open across an action's awaits.
 *
 * **Applying.** A record from another machine is applied through the same
 * code a local change goes through (step 3), with `applying` set, so it is
 * not written out again as this machine's.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";
import { DATA_DIR, storeKey } from "./vault.js";
import { STATE_DIR } from "./paths.js";
import { seal, unseal } from "./seal.js";

// ------------------------------------------------------------ this machine

export interface Machine { id: string; name: string }
const MACHINE = () => join(STATE_DIR, "machine.json");
let me: Machine | null = null;

/** This machine: an id of its own, made once and kept with the machine's state (never synced), and its name. */
export function machine(): Machine {
  if (me) return me;
  try {
    me = JSON.parse(readFileSync(MACHINE(), "utf8")) as Machine;
  } catch {
    me = { id: `m_${randomBytes(6).toString("base64url").toLowerCase().replace(/[^a-z0-9]/g, "")}`, name: hostname() };
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(MACHINE(), JSON.stringify(me));
  }
  return me;
}

// ------------------------------------------------------------ the clock

/** A moment: wall time (ms), a counter within it, and whose. Compared in that order. */
export interface Stamp { t: number; c: number; m: string }
let lastStamp: { t: number; c: number } = { t: 0, c: 0 };

/** The next moment here: never before one already made or seen. */
export function tick(): Stamp {
  const now = Date.now();
  lastStamp = now > lastStamp.t ? { t: now, c: 0 } : { t: lastStamp.t, c: lastStamp.c + 1 };
  return { ...lastStamp, m: machine().id };
}

/** Another machine's moment, seen: this clock carried past it (step 3, as its records are applied). */
export function observe(s: Stamp): void {
  const now = Date.now();
  const t = Math.max(now, lastStamp.t, s.t);
  const c = t === lastStamp.t && t === s.t ? Math.max(lastStamp.c, s.c) + 1 : t === lastStamp.t ? lastStamp.c + 1 : t === s.t ? s.c + 1 : 0;
  lastStamp = { t, c };
}

/** Which is later: negative if a is before b. */
export function compare(a: Stamp, b: Stamp): number {
  return a.t - b.t || a.c - b.c || (a.m < b.m ? -1 : a.m > b.m ? 1 : 0);
}

// ------------------------------------------------------------ records

/**
 * One change. `of` names the thing (`e:<id>` an entity; others as docs/SYNC.md lists them). A plain field is
 * `set` to a value or `unset`; a set-like field (tags, a reference field of many, relations, sources) has members
 * `add`ed and `remove`d, so two machines adding different members both keep theirs. `gone`: deleted.
 */
export interface Change {
  of: string;
  set?: Record<string, unknown>;
  unset?: string[];
  add?: Record<string, unknown[]>;
  remove?: Record<string, unknown[]>;
  gone?: true;
}
export interface Rec extends Change { at: Stamp; batch: string }

const SYNC_DIR = () => join(DATA_DIR, "sync");
/** This machine's log: lines of sealed records, a new file every LOG_LINES. */
const LOG_DIR = () => join(SYNC_DIR(), "log", machine().id);
const LOG_LINES = 5000;

/** Whether this machine syncs (and so writes its log). Asked each time: set up or stopped while running is heard. */
export function syncing(): boolean {
  return existsSync(join(SYNC_DIR(), "on"));
}
/** Sync set up, or stopped, on this machine (Settings, Sync; and under test). */
export function setSyncing(on: boolean): void {
  mkdirSync(SYNC_DIR(), { recursive: true });
  const f = join(SYNC_DIR(), "on");
  if (on) writeFileSync(f, new Date().toISOString());
  else rmSync(f, { force: true });
}

/** Set while a record from another machine is being applied: what it changes is not this machine's to write out. */
export let applying = false;
export function whileApplying<T>(f: () => T): T {
  const was = applying;
  applying = true;
  try { return f(); } finally { applying = was; }
}
/** Inside applying, a change that is this machine's own all the same (a merge both machines need): written out. */
export function applyingOff<T>(f: () => T): T {
  const was = applying;
  applying = false;
  try { return f(); } finally { applying = was; }
}

let openBatch: string | null = null;
let held = 0;
/** One action's batch, held open across its awaits. */
export async function inBatch<T>(f: () => Promise<T> | T): Promise<T> {
  if (!openBatch) openBatch = randomUUID();
  held++;
  try { return await f(); } finally { if (--held === 0) closeSoon(); }
}
function batchNow(): string {
  if (!openBatch) { openBatch = randomUUID(); closeSoon(); }
  return openBatch;
}
function closeSoon(): void {
  // The end of this turn of the event loop ends the batch, unless an action holds it open.
  setImmediate(() => { if (held === 0) openBatch = null; });
}

/** Who wants each record as it is written (the transport, step 4; tests). */
const listeners: ((r: Rec) => void)[] = [];
export function onWritten(f: (r: Rec) => void): void { listeners.push(f); }

/** A change made here, written to this machine's log — if this machine syncs, and the change is its own. */
export function write(change: Change): Rec | null {
  if (applying || !syncing()) return null;
  if (!change.gone && isEmpty(change)) return null;
  const rec: Rec = { ...change, at: tick(), batch: batchNow() };
  append(rec);
  for (const f of listeners) { try { f(rec); } catch { /* a listener's trouble is its own */ } }
  return rec;
}

const isEmpty = (c: Change) => !Object.keys(c.set ?? {}).length && !(c.unset ?? []).length
  && !Object.values(c.add ?? {}).some((v) => v.length) && !Object.values(c.remove ?? {}).some((v) => v.length);

function currentLog(): string {
  const dir = LOG_DIR();
  mkdirSync(dir, { recursive: true });
  const logs = readdirSync(dir).filter((n) => /^\d{6}$/.test(n)).sort();
  let name = logs[logs.length - 1] ?? "000001";
  const path = join(dir, name);
  if (existsSync(path) && lineCount(path) >= LOG_LINES) name = String(Number(name) + 1).padStart(6, "0");
  return join(dir, name);
}
const lines = new Map<string, number>();
function lineCount(path: string): number {
  if (!lines.has(path)) lines.set(path, statSync(path).size ? readFileSync(path, "utf8").split("\n").filter(Boolean).length : 0);
  return lines.get(path)!;
}
function append(rec: Rec): void {
  const path = currentLog();
  appendFileSync(path, seal(storeKey(), JSON.stringify(rec)).toString("base64") + "\n");
  lines.set(path, lineCount(path) + 1);
}

// ------------------------------------------------------------ trimming

/**
 * Records compacted (docs/SYNC.md, *Trimming*): what applying them comes to, with nothing else. Per thing and field,
 * the latest set or unset; per member of a set, the latest add or remove; every delete. Each keeps its own moment,
 * so the result, applied anywhere, is what applying them all was — later records from other machines still win or
 * lose against them as before. In the order of their moments.
 */
export function compact(recs: Rec[]): Rec[] {
  type Slot = { at: Stamp; batch: string; kind: "set" | "unset" | "add" | "remove" | "gone"; field?: string; value?: unknown };
  const latest = new Map<string, Slot>();
  const take = (key: string, slot: Slot) => {
    const had = latest.get(key);
    if (!had || compare(slot.at, had.at) >= 0) latest.set(key, slot);
  };
  const gones: { of: string; at: Stamp; batch: string }[] = [];
  for (const r of recs) {
    const base = { at: r.at, batch: r.batch };
    for (const [f, v] of Object.entries(r.set ?? {})) take(`${r.of}\0f\0${f}`, { ...base, kind: "set", field: f, value: v });
    for (const f of r.unset ?? []) take(`${r.of}\0f\0${f}`, { ...base, kind: "unset", field: f });
    for (const [f, ms] of Object.entries(r.add ?? {})) for (const m of ms) take(`${r.of}\0m\0${f}\0${JSON.stringify(m)}`, { ...base, kind: "add", field: f, value: m });
    for (const [f, ms] of Object.entries(r.remove ?? {})) for (const m of ms) take(`${r.of}\0m\0${f}\0${JSON.stringify(m)}`, { ...base, kind: "remove", field: f, value: m });
    if (r.gone) gones.push({ of: r.of, ...base });
  }
  // Back into records: one per thing and moment.
  const out = new Map<string, Rec>();
  const recFor = (of: string, at: Stamp, batch: string): Rec => {
    const key = `${of}\0${at.t}.${at.c}.${at.m}`;
    let r = out.get(key);
    if (!r) { r = { of, at, batch }; out.set(key, r); }
    return r;
  };
  for (const [key, slot] of latest) {
    const of = key.slice(0, key.indexOf("\0"));
    const r = recFor(of, slot.at, slot.batch);
    if (slot.kind === "set") (r.set ??= {})[slot.field!] = slot.value;
    else if (slot.kind === "unset") (r.unset ??= []).push(slot.field!);
    else if (slot.kind === "add") ((r.add ??= {})[slot.field!] ??= []).push(slot.value);
    else (((r.remove ??= {})[slot.field!] ??= []).push(slot.value));
  }
  for (const g of gones) recFor(g.of, g.at, g.batch).gone = true;
  return [...out.values()].sort((a, b) => compare(a.at, b.at));
}

/**
 * This machine's own log files before `before` (names, NNNNNN), compacted into the first of them, the rest deleted —
 * never the file being written to. Answers what was dropped, and the compacted file's lines (sync-folder.ts writes
 * the same to the folder). Nothing done with fewer than two files to fold.
 */
export function compactOwnLog(before: string): { kept: string; dropped: string[]; lines: number } | null {
  const dir = LOG_DIR();
  if (!existsSync(dir)) return null;
  const all = readdirSync(dir).filter((n) => /^\d{6}$/.test(n)).sort();
  const last = all[all.length - 1];
  const old = all.filter((n) => n < before && n !== last);
  if (old.length < 2) return null;
  const recs: Rec[] = [];
  for (const name of old) {
    for (const line of readFileSync(join(dir, name), "utf8").split("\n")) {
      if (!line) continue;
      try { recs.push(JSON.parse(unseal(storeKey(), Buffer.from(line, "base64")).toString("utf8")) as Rec); } catch { /* torn */ }
    }
  }
  const kept = old[0]!;
  const out = compact(recs).map((r) => seal(storeKey(), JSON.stringify(r)).toString("base64")).join("\n") + "\n";
  const tmp = join(dir, `${kept}.part`);
  writeFileSync(tmp, out);
  renameSync(tmp, join(dir, kept));
  for (const n of old.slice(1)) rmSync(join(dir, n), { force: true });
  for (const n of old) lines.delete(join(dir, n));
  return { kept, dropped: old.slice(1), lines: out.split("\n").filter(Boolean).length };
}

/** This machine's log, read back (step 4's transport; tests). */
export function ownLog(): Rec[] {
  const dir = LOG_DIR();
  if (!existsSync(dir)) return [];
  const out: Rec[] = [];
  for (const name of readdirSync(dir).filter((n) => /^\d{6}$/.test(n)).sort()) {
    for (const line of readFileSync(join(dir, name), "utf8").split("\n")) {
      if (!line) continue;
      try { out.push(JSON.parse(unseal(storeKey(), Buffer.from(line, "base64")).toString("utf8")) as Rec); } catch { /* a torn last line */ }
    }
  }
  return out;
}

// ------------------------------------------------------------ what changed

/**
 * The difference between two versions of a thing, as a change: plain fields set or unset, set-like fields as
 * members added and removed. `sets` names the set-like fields; `skip`, what is the machine's own bookkeeping.
 */
export function diff(of: string, before: Record<string, unknown> | null, after: Record<string, unknown>,
  sets: Set<string> = new Set(), skip: Set<string> = new Set()): Change {
  const change: Change = { of, set: {}, unset: [], add: {}, remove: {} };
  const was = before ?? {};
  for (const k of new Set([...Object.keys(was), ...Object.keys(after)])) {
    if (skip.has(k)) continue;
    const a = was[k], b = after[k];
    if (sets.has(k)) {
      const A = members(a), B = members(b);
      const added = [...B.keys()].filter((x) => !A.has(x)).map((x) => B.get(x));
      const removed = [...A.keys()].filter((x) => !B.has(x)).map((x) => A.get(x));
      if (added.length) change.add![k] = added;
      if (removed.length) change.remove![k] = removed;
      continue;
    }
    if (b === undefined) { if (a !== undefined) change.unset!.push(k); continue; }
    if (JSON.stringify(a) !== JSON.stringify(b)) change.set![k] = b;
  }
  return change;
}
const members = (v: unknown): Map<string, unknown> => new Map((Array.isArray(v) ? v : v == null ? [] : [v]).map((x) => [typeof x === "string" ? x : JSON.stringify(x), x]));
