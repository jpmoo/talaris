// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { ENTITIES_DIR } from "./vault.js";

/**
 * The change feed (pkm-interchange, *The live binding → The change feed*):
 * every write to an entity, in order, as `{ seq, object, op }` — `create`,
 * `update` or `delete`, about the object and never about a row of storage — so
 * a follower can ask what happened since it last looked (`?since=`).
 *
 * Only ids and what happened, in a plain file beside the sealed objects: the
 * objects say what they are, this says only that they moved.
 *
 * The cursor is `<era>.<seq>`, opaque to a client. The era changes when the
 * store is replaced (a revival) and the feed is pruned from the front when it
 * grows long; a cursor from another era, or from before what is kept, is
 * answered 410 Gone so the follower reads everything again — never with the
 * changes that happen to be left, which would leave it quietly missing objects.
 */

export interface Change {
  seq: number;
  object: string;
  op: "create" | "update" | "delete";
}

const FILE = () => join(ENTITIES_DIR, "feed.jsonl");
const META = () => join(ENTITIES_DIR, "feed.json");
const KEEP = 50_000;

interface Meta { era: string; floor: number }
let rows: Change[] | null = null;
let meta: Meta | null = null;

function load(): { rows: Change[]; meta: Meta } {
  if (rows && meta) return { rows, meta };
  // Asked before the store has been opened (a fresh one): its folder, first.
  mkdirSync(ENTITIES_DIR, { recursive: true });
  try {
    meta = JSON.parse(readFileSync(META(), "utf8")) as Meta;
  } catch {
    meta = { era: randomBytes(4).toString("hex"), floor: 0 };
    writeFileSync(META(), JSON.stringify(meta));
  }
  rows = [];
  if (existsSync(FILE())) {
    for (const line of readFileSync(FILE(), "utf8").split("\n")) {
      if (!line.trim()) continue;
      try { rows.push(JSON.parse(line) as Change); } catch { /* a torn last line */ }
    }
  }
  return { rows, meta };
}

const last = () => { const { rows: r, meta: m } = load(); return r.length ? r[r.length - 1]!.seq : m.floor; };

/** A change happened to an object. */
/** Who wants to hear that something changed (plugins.ts: a sync, told at once rather than at its next look). */
const listeners: (() => void)[] = [];
export function onRecord(f: () => void): void { listeners.push(f); }

export function record(object: string, op: Change["op"]): void {
  const { rows: r, meta: m } = load();
  const row = { seq: last() + 1, object, op };
  r.push(row);
  for (const f of listeners) { try { f(); } catch { /* a listener's trouble is its own */ } }
  appendFileSync(FILE(), JSON.stringify(row) + "\n");
  // Long: the oldest go, and a cursor from before them is answered Gone.
  if (r.length > KEEP * 1.2) {
    const kept = r.slice(-KEEP);
    m.floor = kept[0]!.seq - 1;
    rows = kept;
    writeFileSync(FILE(), kept.map((x) => JSON.stringify(x)).join("\n") + "\n");
    writeFileSync(META(), JSON.stringify(m));
  }
}

/** Where the store is now. */
export function cursor(): string {
  return `${load().meta.era}.${last()}`;
}

export class Gone extends Error {}

/** What happened after a cursor, in order; Gone when the feed cannot say. */
export function since(c: string): Change[] {
  const { rows: r, meta: m } = load();
  const [era, at] = c.split(".");
  const seq = Number(at);
  if (era !== m.era || !Number.isInteger(seq) || seq < m.floor || seq > last()) {
    throw new Gone("that cursor is from before what this feed keeps — read everything again");
  }
  return r.filter((x) => x.seq > seq);
}

/** The store was replaced whole (a revival): every cursor before now is Gone. */
export function newEra(): void {
  const m: Meta = { era: randomBytes(4).toString("hex"), floor: 0 };
  rows = [];
  meta = m;
  writeFileSync(FILE(), "");
  writeFileSync(META(), JSON.stringify(m));
}

/** Read again from disk (under test, after the store moves). */
export function reloadFeed(): void {
  rows = null;
  meta = null;
}
