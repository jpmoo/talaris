// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore

import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, renameSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { allRecords, createEntity, findEntities, getEntity, getFile, putFile, reloadEntities, sealedList, sealedPut, types, updateEntity, type Entity, type EntityType, type Relation } from "./entities.js";
import { cursor, newEra, since, type Change } from "./feed.js";
import { allSeries } from "./tasks.js";
import { show, type List } from "./lists.js";
import { ENTITIES_DIR } from "./vault.js";
import { seal } from "./seal.js";
import { storeKey } from "./vault.js";
import { writeAtomic } from "./store.js";

/**
 * The entity store as a `pkm-interchange/0` envelope, and back.
 *
 * This is Talaris's own reading of the format, written from the specification
 * and not from Hermes' code: two implementations that agree are what make the
 * format mean anything. The export is what a backup is, and what a plugin
 * syncing with another tool speaks.
 *
 * **What is claimed is what is done.** The manifest below says relations,
 * attachments (and their files, when asked for) and stable ids, and nothing
 * else; it is held against the checker by the tests.
 */

export const FORMAT = "pkm-interchange/0";

export interface Envelope {
  format: string;
  producer: { name: string; version: string; stableIds?: boolean; [k: string]: unknown };
  conformance?: Record<string, unknown>;
  types?: EntityType[];
  objects?: Entity[];
  relations?: Relation[];
  /** What could not be said: present even when empty, which is itself the statement. */
  findings?: Finding[];
  [extra: string]: unknown;
}

export interface Finding {
  code: string;
  severity: "info" | "reduced" | "error";
  message: string;
  object?: string;
}

/**
 * Level 1 until the fixture suite says otherwise: the round trip is tested
 * here, but a claim is what the format's own cases have measured, not what
 * this code believes of itself (Hermes' rule, kept).
 */
export const MANIFEST = {
  produce: 1,
  consume: 1,
  operate: 0,
  bindings: ["file"],
  profiles: ["contact", "event", "note", "task", "project"],
  features: ["relations", "attachments"],
  unsupported: ["hierarchy"],
};

const PRODUCER_VERSION = "0.1.0";

/** Every attachment value in an object's properties, wherever it sits. */
function attachmentsIn(value: unknown, found: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (Array.isArray(value)) for (const v of value) attachmentsIn(v, found);
  else if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    if (o.kind === "attachment" && typeof o.filename === "string") found.push(o);
    else for (const v of Object.values(o)) attachmentsIn(v, found);
  }
  return found;
}

/**
 * The store as an envelope. With `bytes`, each attached file travels inside it
 * (a backup); without, by name and hash (a sync, which fetches what it lacks).
 */
export function exportEnvelope(options: { bytes?: boolean } = {}): Envelope {
  const objects: Entity[] = [];
  const relations: Relation[] = [];
  const findings: Finding[] = [];
  for (const rec of allRecords()) {
    let o = rec.object;
    if (options.bytes) {
      o = structuredClone(o);
      for (const a of attachmentsIn(o.properties)) {
        const bytes = getFile(String(a.sha256 ?? ""));
        if (bytes) a.bytes = bytes.toString("base64");
        else findings.push({ code: "attachment.known-missing", severity: "reduced", object: o.id,
          message: `${String(a.filename)} is known by its hash and this store does not have the file` });
      }
    }
    objects.push(o);
    // Kept as they were made, `from` and all: an edge goes out as it came in.
    relations.push(...rec.relations.map((r) => (r.from === rec.object.id ? r : { ...r, from: rec.object.id })));
  }
  const collections = sealedList<List>("lists").map(collectionOf);
  const series = allSeries();
  // Declared as they are present, never more: the checker holds the manifest
  // to the data (conformance.undeclared-feature), and a promise is the data.
  const features = [...MANIFEST.features, ...(options.bytes ? ["attachment-bytes"] : [])];
  if (series.length) features.push("series");
  if (collections.some((c) => c.placement)) features.push("placement");
  if (collections.some((c) => (c.membership as { mode?: string })?.mode === "query")) features.push("derivations");
  if (collections.some((c) => (c.order as { sort?: unknown; groupBy?: unknown } | undefined)?.sort || (c.order as { groupBy?: unknown } | undefined)?.groupBy)) features.push("ordering");
  return {
    format: FORMAT,
    producer: { name: "talaris", version: PRODUCER_VERSION, stableIds: true },
    conformance: { ...MANIFEST, features },
    types: types(),
    objects,
    relations,
    ...(collections.length ? { collections } : {}),
    ...(series.length ? { series } : {}),
    findings,
  };
}

/**
 * A list as a format collection. A live query's members are its answer now —
 * a snapshot for reference, as the format says (`materialized: false`); a
 * board's members carry the column their value puts them in; the list's own
 * keys go as they are, `talaris:` ones included.
 */
function collectionOf(l: List): Record<string, unknown> {
  const shown = show(l);
  const members = shown.rows.map((r) => ({
    object: r.id,
    position: r.position,
    ...(l.placement && r.region ? { region: r.region } : {}),
  }));
  const { members: _kept, ...rest } = l;
  return { ...rest, members };
}

/**
 * An envelope into the store, **replacing what is there** — a revival. The
 * store as it was is moved aside first and put back if anything goes wrong.
 *
 * Nothing is coerced quietly: what cannot be kept whole is reported, and a
 * file that does not match its hash fails the import.
 */
export function importEnvelope(env: Envelope): { findings: Finding[]; counts: { types: number; objects: number; relations: number; files: number } } {
  if (env.format !== FORMAT) throw new Error(`not a ${FORMAT} envelope (${String(env.format)})`);
  const findings: Finding[] = [];
  const ids = new Set<string>();
  for (const o of env.objects ?? []) {
    if (!o || typeof o.id !== "string") throw new Error("an object without an id");
    if (ids.has(o.id)) throw new Error(`two objects with the id ${o.id}`);
    ids.add(o.id);
  }
  // Check every carried file before anything is touched.
  for (const o of env.objects ?? []) {
    for (const a of attachmentsIn(o.properties)) {
      if (typeof a.bytes === "string" && a.bytes) {
        if (typeof a.sha256 !== "string") throw new Error(`attachment.hash-missing: ${String(a.filename)} on ${o.id}`);
        const got = createHash("sha256").update(Buffer.from(a.bytes, "base64")).digest("hex");
        if (got !== a.sha256) throw new Error(`a file on ${o.id} (${String(a.filename)}) does not match its hash`);
      } else if (typeof a.sha256 === "string") {
        findings.push({ code: "attachment.known-missing", severity: "reduced", object: o.id,
          message: `${String(a.filename)} is known and was not carried; it is kept as a file this store does not have` });
      }
    }
  }

  const aside = `${ENTITIES_DIR}.before-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const parts = ["objects", "types", "lists", "series"];
  mkdirSync(aside, { recursive: true });
  for (const d of parts) if (existsSync(join(ENTITIES_DIR, d))) renameSync(join(ENTITIES_DIR, d), join(aside, d));
  try {
    for (const d of parts) mkdirSync(join(ENTITIES_DIR, d), { recursive: true });
    const k = storeKey();
    let files = 0;
    for (const t of env.types ?? []) writeAtomic(join(ENTITIES_DIR, "types", t.id.replace(/:/g, "%3A")), seal(k, JSON.stringify(t)));
    const out = new Map<string, Relation[]>();
    for (const r of env.relations ?? []) {
      if (!ids.has(r.from)) {
        findings.push({ code: "relation.dangling", severity: "reduced", message: `an edge from ${r.from}, which did not arrive, was dropped` });
        continue;
      }
      out.set(r.from, [...(out.get(r.from) ?? []), r]);
    }
    for (const o of env.objects ?? []) {
      const object = structuredClone(o);
      for (const a of attachmentsIn(object.properties)) {
        if (typeof a.bytes === "string" && a.bytes) {
          putFile(Buffer.from(a.bytes, "base64"), String(a.filename));
          files++;
          delete a.bytes;
        }
      }
      if (typeof object.version !== "number") object.version = 1;
      // Edges are kept with the object they go out of; `from` is where they are.
      const relations = out.get(o.id) ?? [];
      writeAtomic(join(ENTITIES_DIR, "objects", o.id.replace(/:/g, "%3A")), seal(k, JSON.stringify({ object, relations })));
    }
    // Lists and series, as they came: their own keys are this store's.
    for (const c of (env.collections as List[] | undefined) ?? []) sealedPut("lists", c.id, c);
    for (const se of (env.series as { id: string }[] | undefined) ?? []) sealedPut("series", se.id, se);
    reloadEntities();
    // A store replaced whole: every follower's cursor is from another world now.
    newEra();
    rmSync(aside, { recursive: true, force: true });
    return { findings, counts: { types: env.types?.length ?? 0, objects: env.objects?.length ?? 0, relations: env.relations?.length ?? 0, files } };
  } catch (e) {
    for (const d of parts) {
      rmSync(join(ENTITIES_DIR, d), { recursive: true, force: true });
      if (existsSync(join(aside, d))) renameSync(join(aside, d), join(ENTITIES_DIR, d));
    }
    rmSync(aside, { recursive: true, force: true });
    reloadEntities();
    throw e;
  }
}

/** For the tests: how many sealed entity files there are on disk. */
export function onDisk(): number {
  return existsSync(join(ENTITIES_DIR, "objects")) ? readdirSync(join(ENTITIES_DIR, "objects")).filter((n) => !n.startsWith(".")).length : 0;
}

// ------------------------------------------------------------ the live binding
//
// pkm-interchange's *live binding*, over the core's socket (server.ts,
// `/interchange` and `/conformance`): the same envelope a file carries, with a
// cursor to follow; a create at an id the client chose, that never edits; and
// a partial write — `set`, `unset`, tags added and removed, at a version —
// that never touches what it does not name. What a write sets in motion (a
// task finished stamps its time and brings its next) is the store's own
// doing, through the same `updateEntity` every other surface uses: this owns
// none of it.

/**
 * What this Talaris answers live: the file manifest, with the binding and the
 * level its writes earn (measure.ts). Its lists — Tasks' boards, matrices and
 * smart lists — are Talaris's own views and travel in the file export (a
 * backup), not over the live binding, whose writes are objects: so the live
 * answer carries no collections, and claims none of what they would need.
 */
export const LIVE_MANIFEST = { ...MANIFEST, operate: 4, bindings: ["file", "http"] };

/** The live manifest as the data bears it out: a feature declared because it is there (series, when tasks repeat). */
export function liveManifest(): typeof LIVE_MANIFEST {
  return { ...LIVE_MANIFEST, features: [...LIVE_MANIFEST.features, ...(allSeries().length ? ["series"] : [])] };
}

/**
 * A read: everything, or what changed since a cursor, or one profile's
 * objects, or what matches some words — always a whole envelope, every type
 * an object points at travelling with it (all of them: there are few).
 */
export function readEnvelope(q: { since?: string; profile?: string; q?: string } = {}): Envelope & { cursor: string; changes?: Change[] } {
  const at = cursor();
  const whole = exportEnvelope();
  let objects = whole.objects ?? [];
  let changes: Change[] | undefined;
  if (q.since) {
    // The last row about an object is the one that counts — in both directions.
    const rows = since(q.since);
    const latest = new Map<string, Change>();
    for (const r of rows) latest.set(r.object, r);
    changes = [...latest.values()].sort((a, b) => a.seq - b.seq);
    const moved = new Set([...latest.values()].filter((r) => r.op !== "delete").map((r) => r.object));
    objects = objects.filter((o) => moved.has(o.id));
  }
  if (q.profile) {
    const of = new Set(types().filter((t) => t.profiles && q.profile! in t.profiles).map((t) => t.id));
    objects = objects.filter((o) => o.type && of.has(o.type));
  }
  if (q.q) {
    // Most relevant first, and no scores: the order is the answer.
    const order = findEntities({ q: q.q, limit: 500 }).map((s) => s.id);
    const byId = new Map(objects.map((o) => [o.id, o]));
    objects = order.map((id) => byId.get(id)).filter((o): o is Entity => Boolean(o));
  }
  const ids = new Set(objects.map((o) => o.id));
  const narrowed = Boolean(q.since || q.profile || q.q);
  const { collections: _lists, ...rest } = whole;
  return {
    ...rest,
    conformance: liveManifest(),
    cursor: at,
    objects,
    relations: narrowed ? (whole.relations ?? []).filter((r) => ids.has(r.from)) : whole.relations,
    ...(narrowed ? { series: undefined } : {}),
    ...(changes ? { changes } : {}),
  };
}

export interface WritePatch {
  set?: Record<string, unknown>;
  unset?: string[];
  addTags?: string[];
  removeTags?: string[];
  version?: number | string;
}
export interface WriteAnswer {
  ok: boolean;
  conflict?: boolean;
  created?: boolean;
  /** The object as it stands now (a version, as a client sent it or the store keeps it, opaque either way). */
  object?: Record<string, unknown> & { properties?: Record<string, unknown>; tags?: string[] };
  fidelity: "full" | "reduced";
  reports: string[];
  cursor?: string;
}

/**
 * A partial write, as a rule: what `set` names is set, what `unset` names
 * goes, every other property — known or not — stays; tags are added and
 * removed one by one, the same one both ways refused; a stale version is
 * refused rather than merged. Pure, so the fixtures measure the rule the
 * route applies (measure.ts).
 */
export function applyPatch(object: { properties?: Record<string, unknown>; tags?: string[]; version?: number | string }, p: WritePatch): WriteAnswer {
  const add = p.addTags ?? [];
  const drop = p.removeTags ?? [];
  if (add.some((t) => drop.includes(t))) return { ok: false, object, fidelity: "full", reports: ["tags.added-and-removed"] };
  if (p.version !== undefined && object.version !== undefined && String(p.version) !== String(object.version)) {
    return { ok: false, conflict: true, object, fidelity: "full", reports: [] };
  }
  const properties = { ...(object.properties ?? {}) };
  for (const [k, v] of Object.entries(p.set ?? {})) properties[k] = v;
  for (const k of p.unset ?? []) delete properties[k];
  let tags = object.tags;
  if (add.length || drop.length) {
    const next = (object.tags ?? []).filter((t) => !drop.includes(t));
    for (const t of add) if (!next.includes(t)) next.push(t);
    tags = next;
  }
  return { ok: true, object: { ...object, properties, ...(tags !== undefined ? { tags } : {}) }, fidelity: "full", reports: [] };
}

/** A partial write to the store: the rule above, then the store's own update, which does what a write does. */
export function patchObject(id: string, p: WritePatch): WriteAnswer {
  const now = getEntity(id);
  const ruled = applyPatch(now, p);
  if (!ruled.ok) return { ...ruled, object: now as unknown as WriteAnswer["object"] };
  const properties: Record<string, unknown> = { ...(p.set ?? {}) };
  for (const k of p.unset ?? []) properties[k] = null;
  const written = updateEntity(id, {
    properties,
    ...(p.addTags?.length || p.removeTags?.length ? { tags: ruled.object!.tags ?? [] } : {}),
    version: now.version,
  });
  // As it stands now — the store's doing included (a time stamped, a next occurrence made).
  return { ok: true, object: getEntity(written.id) as unknown as WriteAnswer["object"], fidelity: "full", reports: [], cursor: cursor() };
}

/**
 * Bringing an object into being at the id the client chose, as a rule: the
 * body's id and the address must agree; an id already taken answers with what
 * is there, unchanged; a type the store does not have is refused and said so.
 */
export function createRule(
  body: { id?: string; type?: string; properties?: Record<string, unknown>; content?: string; tags?: string[] },
  at: string,
  existing: Record<string, unknown> | null,
  knownType: (id: string) => boolean,
): WriteAnswer | null {
  if (body.id !== undefined && body.id !== at) return { ok: false, created: false, fidelity: "full", reports: ["create.id-mismatch"] };
  if (existing) return { ok: true, created: false, object: existing, fidelity: "full", reports: [] };
  if (!body.type || !knownType(body.type)) return { ok: false, created: false, fidelity: "reduced", reports: ["create.unknown-type"] };
  return null;
}

/** A create in the store: the rule, then the store's own create, which never edits. */
export function createObject(at: string, body: { id?: string; type?: string; properties?: Record<string, unknown>; content?: string; tags?: string[] }): WriteAnswer {
  let existing: Record<string, unknown> | null = null;
  try { existing = getEntity(at) as unknown as Record<string, unknown>; } catch { /* free */ }
  const ruled = createRule(body, at, existing, (t) => types().some((x) => x.id === t));
  if (ruled) return { ...ruled, cursor: cursor() };
  const made = createEntity({ id: at, type: body.type, properties: body.properties ?? {}, ...(body.content ? { content: body.content } : {}), ...(body.tags ? { tags: body.tags } : {}) });
  return { ok: true, created: true, object: made as unknown as WriteAnswer["object"], fidelity: "full", reports: [], cursor: cursor() };
}

/** What a follower concludes from a feed: the last word about each object is the one that counts. */
export function follow(feed: { seq?: number; object: string; op: string }[]): { alive: string[]; gone: string[] } {
  const last = new Map<string, string>();
  for (const r of [...feed].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))) last.set(r.object, r.op);
  const alive: string[] = [], gone: string[] = [];
  for (const [id, op] of last) (op === "delete" ? gone : alive).push(id);
  return { alive, gone };
}
