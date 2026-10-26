// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore

/**
 * Two of one kind made one (DESIGN, *Suggestions*): the same person entered
 * twice, one task written twice. Rare, and only ever asked for.
 *
 * The one kept keeps its own; what it lacks it takes from the other — an empty
 * field filled, lists joined, tags, files, where else it lives (a calendar's,
 * an address book's). Whatever pointed at the other — a field, a link, a
 * mention in words, a page's — points at the kept one now, and what the other
 * pointed at, the kept one does. The other is then gone, and its id still leads
 * to the kept one (`mergedInto`), so a link kept somewhere outside is not lost.
 *
 * A thing another app keeps in step (a plugin's `<plugin>:link`) is not the
 * one to go: the sync would read its going as a deletion. Of two such, neither
 * goes — they are merged in that app, and the sync brings it.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  connections, deleteEntity, getEntity, link, relationsFrom, types, unlink, updateEntity, type Entity, type Source,
} from "./entities.js";
import { placeOf } from "./mentionables.js";
import { readPage, writePage } from "./pages.js";
import { Conflict, NotFound } from "./projects.js";
import { seal, unseal } from "./seal.js";
import { writeAtomic } from "./store.js";
import { DATA_DIR, storeKey } from "./vault.js";

/** The plugin keeping a thing in step with another app, if one does. */
export function syncedBy(o: Entity): string | null {
  const k = Object.keys(o.properties ?? {}).find((x) => x.endsWith(":link") && !x.startsWith("talaris:"));
  return k ? k.slice(0, -5) : null;
}

const ALIASES = () => join(DATA_DIR, "merged.sealed");
let aliases: Record<string, string> | null = null;
function aliasMap(): Record<string, string> {
  if (aliases) return aliases;
  aliases = {};
  if (existsSync(ALIASES())) {
    try { aliases = JSON.parse(unseal(storeKey(), readFileSync(ALIASES())).toString("utf8")) as Record<string, string>; } catch { /* none */ }
  }
  return aliases;
}

/** Where an id merged away now leads: the one it became, followed to the end; null if it was never merged. */
export function mergedInto(id: string): string | null {
  const map = aliasMap();
  let at = map[id];
  for (let i = 0; at && map[at] && i < 20; i++) at = map[at];
  return at ?? null;
}

const empty = (v: unknown) => v === undefined || v === null || v === "" || (Array.isArray(v) && !v.length);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** `drop` made part of `keep`, and gone. Answers the kept one. */
export function mergeEntities(dropId: string, keepId: string): Entity {
  if (dropId === keepId) throw new Conflict("a thing cannot be merged with itself");
  const drop = getEntity(dropId), keep = getEntity(keepId);
  if (drop.type !== keep.type) throw new Conflict("only two of one kind can be merged");
  const by = syncedBy(drop);
  if (by) {
    if (syncedBy(keep)) throw new Conflict(`both are kept in step by ${by}: merge them there, and the sync brings it`);
    throw new Conflict(`${by} keeps ${dropId} in step: keep that one instead`);
  }
  const type = types().find((t) => t.id === keep.type);
  const refs = new Set(type?.fields.filter((f) => f.kind === "reference").map((f) => f.key) ?? []);

  // What the kept one lacks, from the other; lists joined.
  const props: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(drop.properties)) {
    if (k === "title" || empty(v)) continue;
    const have = keep.properties[k];
    if (empty(have)) props[k] = v;
    else if (Array.isArray(have) && Array.isArray(v)) {
      const joined = [...have];
      for (const x of v) if (!joined.some((y) => same(x, y)) && x !== keepId) joined.push(x);
      if (joined.length !== have.length) props[k] = joined;
    }
  }
  // A reference to itself (one of the two pointing at the other): taken out.
  for (const k of refs) {
    const v = props[k] ?? keep.properties[k];
    if (Array.isArray(v) && v.some((x) => x === dropId || x === keepId)) props[k] = v.filter((x) => x !== dropId && x !== keepId);
    else if (v === dropId || v === keepId) props[k] = null;
  }
  const tags = [...new Set([...(keep.tags ?? []), ...(drop.tags ?? [])])];
  const sources = (drop["talaris:sources"] as Source[] | undefined) ?? [];
  const outgoing = relationsFrom(dropId).filter((r) => r.via !== "inline" && r.to !== keepId);

  // Whatever pointed at the other, pointed at the kept one.
  const c = connections(dropId);
  const swapText = (s: string) => s.split(`(talaris:${dropId})`).join(`(talaris:${keepId})`);
  for (const from of new Set(c.in.map((x) => x.entity.id))) {
    if (from === keepId) continue;
    const o = getEntity(from);
    const patch: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(o.properties)) {
      if (Array.isArray(v) && v.includes(dropId)) patch[k] = [...new Set(v.map((x) => (x === dropId ? keepId : x)))];
      else if (v === dropId) patch[k] = keepId;
      else if (typeof v === "string" && v.includes(`talaris:${dropId}`)) patch[k] = swapText(v);
    }
    const content = typeof o.content === "string" && o.content.includes(`talaris:${dropId}`) ? swapText(o.content) : undefined;
    if (Object.keys(patch).length || content !== undefined) updateEntity(from, { properties: patch, ...(content !== undefined ? { content } : {}) });
    // A page's words are in the page.
    const place = placeOf(o);
    if (place?.kind === "page") {
      try {
        const text = readPage(place.project, place.where);
        if (text.includes(`talaris:${dropId}`)) writePage(place.project, place.where, swapText(text));
      } catch { /* sealed and locked: its mention stays, and leads here by the alias */ }
    }
    for (const r of relationsFrom(from).filter((x) => x.to === dropId && x.via !== "inline")) {
      unlink({ from, to: dropId, type: r.type });
      link({ ...r, to: keepId });
    }
  }

  // Its files taken over before it goes, so they are not forgotten with it; where else it lives, after (one place, one thing).
  updateEntity(keepId, { properties: props, tags });
  deleteEntity(dropId);
  for (const r of outgoing) {
    try { link({ ...r, from: keepId }); } catch (e) { if (!(e instanceof NotFound)) throw e; }
  }
  const kept = sources.length ? updateEntity(keepId, { sources }) : getEntity(keepId);
  const map = aliasMap();
  map[dropId] = keepId;
  writeAtomic(ALIASES(), seal(storeKey(), JSON.stringify(map)));
  return kept;
}
