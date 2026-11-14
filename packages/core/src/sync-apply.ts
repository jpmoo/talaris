// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore

/**
 * Another machine's records, applied here (docs/SYNC.md, *Merging*; step 3).
 *
 * **Every field keeps the moment it last changed** — a clock per field of each
 * thing (`Clock`), kept as this machine writes its own records and as it
 * applies another's. A record changes a field only if it is later than what
 * the field has: the same field changed on two machines before either heard
 * of the other's ends the same on both, whichever arrives first.
 *
 * **Sets merge by member**: tags, a field of many, a thing's connections — each
 * member's being in or out has its own moment, so a project added here and
 * another there are both kept.
 *
 * **A delete wins**: the thing's moment of going is kept (a tombstone), and a
 * record about it from before it went, or from a machine that had not heard,
 * does not bring it back.
 *
 * **Nothing is lost without trace**: the value that lost — this machine's,
 * overwritten by a later one, or the other's, too late — goes into the replaced
 * log (`replaced`), from which it can be had back.
 *
 * Applied with `whileApplying` (records.ts), so nothing applied is written out
 * again as this machine's; entities through `writeFlat` (entities.ts), which
 * skips the hooks a change made here runs.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { DATA_DIR, storeKey } from "./vault.js";
import { seal, unseal } from "./seal.js";
import { writeAtomic } from "./store.js";
import { compare, observe, onWritten, whileApplying, type Rec, type Stamp } from "./records.js";
import { deleteFlat, readFlat, setsOf, writeFlat } from "./entities.js";

// ------------------------------------------------------------ clocks

interface Clock {
  /** Each plain field's last change. */
  fields: Record<string, Stamp>;
  /** Each set-like field's members: in or out, and when that was said. */
  members: Record<string, Record<string, { in: boolean; at: Stamp }>>;
  /** When the thing went, if it did. */
  gone?: Stamp;
}

const CLOCKS = () => join(DATA_DIR, "sync", "clocks");
const clockFile = (of: string) => join(CLOCKS(), createHash("sha256").update(of).digest("hex").slice(0, 32));
const clocks = new Map<string, Clock>();

function clockOf(of: string): Clock {
  const kept = clocks.get(of);
  if (kept) return kept;
  let c: Clock = { fields: {}, members: {} };
  const f = clockFile(of);
  if (existsSync(f)) {
    try { c = JSON.parse(unseal(storeKey(), readFileSync(f)).toString("utf8")) as Clock; } catch { /* started again */ }
  }
  clocks.set(of, c);
  return c;
}
function keep(of: string, c: Clock): void {
  mkdirSync(CLOCKS(), { recursive: true });
  writeAtomic(clockFile(of), seal(storeKey(), JSON.stringify(c)));
}
const memberKey = (x: unknown) => (typeof x === "string" ? x : JSON.stringify(x));
const later = (a: Stamp, b: Stamp | undefined) => !b || compare(a, b) > 0;

/** A record of this machine's, written: its fields' moments, so another's earlier change does not undo it. */
function noteOwn(r: Rec): void {
  const c = clockOf(r.of);
  if (r.gone) c.gone = r.at;
  for (const k of [...Object.keys(r.set ?? {}), ...(r.unset ?? [])]) c.fields[k] = r.at;
  for (const [op, inn] of [[r.add, true], [r.remove, false]] as const) {
    for (const [k, list] of Object.entries(op ?? {})) {
      const m = (c.members[k] ??= {});
      for (const x of list) m[memberKey(x)] = { in: inn, at: r.at };
    }
  }
  keep(r.of, c);
}
onWritten(noteOwn);

// ------------------------------------------------------------ the replaced log

export interface Replaced { of: string; field: string; value: unknown; lostAt: Stamp; wonAt: Stamp; when: string }
const REPLACED = () => join(DATA_DIR, "sync", "replaced");

function replaced(of: string, field: string, value: unknown, lostAt: Stamp, wonAt: Stamp): void {
  if (value === undefined) return;
  mkdirSync(join(DATA_DIR, "sync"), { recursive: true });
  const row: Replaced = { of, field, value, lostAt, wonAt, when: new Date().toISOString() };
  appendFileSync(REPLACED(), seal(storeKey(), JSON.stringify(row)).toString("base64") + "\n");
}

/** What was replaced, newest first, for one thing or all (Settings, Sync; a card's "changed elsewhere"). */
export function replacedFor(of?: string): Replaced[] {
  if (!existsSync(REPLACED())) return [];
  const out: Replaced[] = [];
  for (const line of readFileSync(REPLACED(), "utf8").split("\n")) {
    if (!line) continue;
    try {
      const r = JSON.parse(unseal(storeKey(), Buffer.from(line, "base64")).toString("utf8")) as Replaced;
      if (!of || r.of === of) out.push(r);
    } catch { /* a torn last line */ }
  }
  return out.reverse();
}

// ------------------------------------------------------------ applying

/** Applies one record from another machine; says whether anything here changed. */
export function apply(r: Rec): boolean {
  observe(r.at);
  if (r.of.startsWith("e:")) return whileApplying(() => applyEntity(r));
  return false; // pages, canvases, a project's files: step 3b
}

/** A batch: applied in its order, whole. */
export function applyBatch(recs: Rec[]): number {
  let n = 0;
  for (const r of recs) if (apply(r)) n++;
  return n;
}

function applyEntity(r: Rec): boolean {
  const id = r.of.slice(2);
  const c = clockOf(r.of);
  const had = readFlat(id);
  // Deleted: it goes, and is remembered gone; what it had is kept in the replaced log.
  if (r.gone) {
    if (c.gone && !later(r.at, c.gone)) return false;
    c.gone = r.at;
    keep(r.of, c);
    if (had) {
      replaced(r.of, "*", had, r.at, r.at);
      deleteFlat(id);
      return true;
    }
    return false;
  }
  // Gone already, said by a delete: a change to it from any machine does not bring it back.
  if (c.gone) {
    for (const [k, v] of Object.entries(r.set ?? {})) replaced(r.of, k, v, r.at, c.gone);
    return false;
  }
  const fields: Record<string, unknown> = { ...(had ?? {}) };
  let changed = false;
  // Plain fields: the later moment wins.
  for (const [k, v] of Object.entries(r.set ?? {})) {
    if (later(r.at, c.fields[k])) {
      if (c.fields[k] && JSON.stringify(fields[k]) !== JSON.stringify(v)) replaced(r.of, k, fields[k], c.fields[k]!, r.at);
      fields[k] = v;
      c.fields[k] = r.at;
      changed = true;
    } else if (JSON.stringify(fields[k]) !== JSON.stringify(v)) {
      replaced(r.of, k, v, r.at, c.fields[k]!);
    }
  }
  for (const k of r.unset ?? []) {
    if (later(r.at, c.fields[k])) {
      if (fields[k] !== undefined && c.fields[k]) replaced(r.of, k, fields[k], c.fields[k]!, r.at);
      delete fields[k];
      c.fields[k] = r.at;
      changed = true;
    }
  }
  // Set-like fields: member by member.
  const sets = setsOf((fields.type as string | undefined) ?? undefined);
  for (const [op, inn] of [[r.add, true], [r.remove, false]] as const) {
    for (const [k, list] of Object.entries(op ?? {})) {
      const m = (c.members[k] ??= {});
      const now = new Map((Array.isArray(fields[k]) ? fields[k] as unknown[] : fields[k] == null ? [] : [fields[k]]).map((x) => [memberKey(x), x]));
      for (const x of list) {
        const key = memberKey(x);
        if (!later(r.at, m[key]?.at)) continue;
        m[key] = { in: inn, at: r.at };
        if (inn && !now.has(key)) { now.set(key, x); changed = true; }
        if (!inn && now.has(key)) { now.delete(key); changed = true; }
      }
      // A one-value field that is a set only in its records stays one value.
      fields[k] = sets.has(k) || k === "relations" ? [...now.values()] : [...now.values()][0];
    }
  }
  keep(r.of, c);
  if (!changed) return false;
  if (!fields.type) return false; // nothing yet to make it from: its creating record has not come
  writeFlat(id, fields);
  return true;
}

/** Under test: every clock forgotten, as on a machine that has never synced. */
export function forgetClocks(): void {
  clocks.clear();
  rmSync(CLOCKS(), { recursive: true, force: true });
}
