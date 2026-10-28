// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore

import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, renameSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { allRecords, createEntity, findEntities, forgetFiles, getEntity, getFile, putFile, reloadEntities, sealedList, sealedPut, types, updateEntity, type Entity, type EntityType, type Relation } from "./entities.js";
import { createDay, createNote, isDay, isUndated, reconcileNotes, writeDay, writeNote } from "./notes.js";
import { keepLinks, linkedBytes, refreshLinks } from "./links.js";
import { cursor, newEra, since, type Change } from "./feed.js";
import { createProject, renameProject } from "./projects.js";
import { PROJECT_SOURCE, projectIdOf } from "./filing.js";
import { allSeries } from "./tasks.js";
import { addMember, createList, getList, isCondition, putList, removeMember, show, updateList, type Condition, type List } from "./lists.js";
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

// ------------------------------------------------------------ collections: membership and placement, written

/*
 * The format's writes on a collection's members (*Adding and removing a
 * member*, *Moving a card*): `PUT` makes a membership (with its region) and
 * changes nothing if it is there; `PATCH` moves it (`region`, null for no
 * region in particular); `DELETE` unmakes it, the object untouched, and is a
 * success if it was not there. A region the collection does not declare is
 * refused, never stored; a smart list's membership is its rule's, so it is
 * not written (a matrix's placements are, its rule only filling its drawer).
 * Entering a region does what the region says (a tag, a status), as a drag
 * in the Tasks panel does (lists.ts).
 */
export interface MemberAnswer { ok: boolean; reports: string[]; collection?: Record<string, unknown> }
function regionNames(l: List): string[] {
  const shown = show(l).list;
  return (shown.placement?.regions ?? []).map((r) => (typeof r === "string" ? r : r.name));
}
export function writeMember(verb: "PUT" | "PATCH" | "DELETE", collectionId: string, objectId: string, body: { region?: string | null; context?: unknown }): MemberAnswer {
  let l: List;
  try { l = getList(collectionId); } catch { return { ok: false, reports: ["collection.not-found"] }; }
  try { getEntity(objectId); } catch { return { ok: false, reports: ["member.object-not-found"] }; }
  if (body.context !== undefined) return { ok: false, reports: ["placement.context-on-semantic: this collection's placement is a judgment, not furniture"] };
  const queried = l.membership.mode === "query" && l.kind !== "matrix";
  const has = l.members.some((m) => m.object === objectId) || (queried && show(l).rows.some((r) => r.id === objectId));
  if (verb === "DELETE") {
    if (!has) return { ok: true, reports: [] };
    if (queried) return { ok: false, reports: ["collection.membership-is-a-rule: what it holds is its rule's"] };
    removeMember(collectionId, objectId);
    return { ok: true, reports: [], collection: collectionOf(getList(collectionId)) };
  }
  if (body.region !== undefined && body.region !== null && !regionNames(l).includes(body.region)) {
    return { ok: false, reports: [`placement.unknown-region: ${body.region} is not one of this collection's regions`] };
  }
  if (verb === "PUT" && has) return { ok: true, reports: [], collection: collectionOf(l) };
  if (verb === "PATCH" && !has) return { ok: false, reports: ["member.not-a-member: put it in first"] };
  if (queried && verb === "PUT") return { ok: false, reports: ["collection.membership-is-a-rule: what it holds is its rule's"] };
  addMember(collectionId, objectId, body.region === undefined ? {} : { region: body.region === null ? "" : body.region });
  return { ok: true, reports: [], collection: collectionOf(getList(collectionId)) };
}

/**
 * A collection made through the binding (*Making a collection*): at the id
 * asked for; one already there answers as it stands, unchanged.
 */
export function makeCollection(id: string, body: Record<string, unknown>, by?: { id: string; name: string }): MemberAnswer & { created?: boolean } {
  if (typeof body.id === "string" && body.id !== id) return { ok: false, reports: ["create.id-mismatch"] };
  try { return { ok: true, created: false, reports: [], collection: collectionOf(getList(id)) }; } catch { /* not there: made */ }
  const kind = String(body.kind ?? "list");
  if (!["list", "table", "board", "matrix", "calendar"].includes(kind)) return { ok: false, reports: [`collection.kind-not-kept: Talaris keeps list, table, board, matrix and calendar, not ${kind}`] };
  // A rule comes only in Talaris's own words (lists.ts, isCondition): one in another app's is not one it can run,
  // so a smart collection whose rule could not be put into them is kept in step by whoever made it, member by member.
  const m = body.membership as { mode?: string; query?: unknown } | undefined;
  if (m?.mode === "query" && !isCondition(m.query)) return { ok: false, reports: ["collection.rule-not-runnable: a rule in Talaris's own conditions"] };
  const made = createList({ id, name: String(body.name ?? "Untitled"), kind: kind as List["kind"],
    ...(m?.mode === "query" ? { query: m.query as Condition } : {}),
    // A board's field: its options are the columns, a card's column its value.
    ...(kind === "board" && typeof body.bind === "string" ? { bind: body.bind } : {}),
    ...(body.placement && kind !== "board" ? { placement: body.placement as List["placement"] } : {}),
    ...(body.order ? { order: body.order as List["order"] } : {}),
    extra: { ...Object.fromEntries(Object.entries(body).filter(([k]) => k.includes(":") && !k.startsWith("talaris:"))),
      ...(by ? { "talaris:syncedBy": by.name, "talaris:syncedPlugin": by.id } : {}) } });
  return { ok: true, created: true, reports: [], collection: collectionOf(made) };
}

/**
 * A synced collection's definition, kept in step with the app it is paired
 * with (Talaris's own route, not the format's: the format writes only a
 * collection's prefixed keys): its name, its regions, its order, its rule —
 * a rule only in Talaris's words, or none (its members then kept by hand, by
 * whoever keeps it in step). Marked as synced, and by what, so the Tasks
 * panel can say so.
 */
export function defineCollection(id: string, d: { name?: string; placement?: unknown; order?: unknown; membership?: { mode?: string; query?: unknown }; bind?: string; synced?: boolean }, by: { id: string; name: string }): MemberAnswer {
  try { getList(id); } catch { return { ok: false, reports: ["collection.not-found"] }; }
  // No longer synced (its other side gone): the mark taken off, the collection kept as it stands.
  if (d.synced === false) {
    const l = getList(id);
    delete l["talaris:syncedBy"];
    delete l["talaris:syncedPlugin"];
    putList(l);
    return { ok: true, reports: [], collection: collectionOf(getList(id)) };
  }
  if (d.membership?.mode === "query" && !isCondition(d.membership.query)) return { ok: false, reports: ["collection.rule-not-runnable: a rule in Talaris's own conditions"] };
  updateList(id, {
    ...(typeof d.name === "string" && d.name.trim() ? { name: d.name } : {}),
    ...(d.placement && getList(id).kind !== "board" ? { placement: d.placement as List["placement"] } : {}),
    ...(typeof d.bind === "string" && getList(id).kind === "board" ? { bind: d.bind } : {}),
    ...(d.order !== undefined ? { order: (d.order as List["order"]) ?? null } : {}),
    ...(d.membership ? { query: d.membership.mode === "query" ? (d.membership.query as Condition) : null } : {}),
  });
  const now = getList(id);
  now["talaris:syncedBy"] = by.name;
  now["talaris:syncedPlugin"] = by.id;
  putList(now);
  return { ok: true, reports: [], collection: collectionOf(getList(id)) };
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
export const LIVE_MANIFEST = { ...MANIFEST, operate: 4, bindings: ["file", "http"], features: [...MANIFEST.features, "attachment-files"] };

/** The live manifest as the data bears it out: a feature declared because it is there (series, when tasks repeat). */
export function liveManifest(): typeof LIVE_MANIFEST {
  return { ...LIVE_MANIFEST, features: [...LIVE_MANIFEST.features, ...(allSeries().length ? ["series"] : [])] };
}

/**
 * A read: everything, or what changed since a cursor, or one profile's
 * objects, or what matches some words — always a whole envelope, every type
 * an object points at travelling with it (all of them: there are few).
 */
export function readEnvelope(q: { since?: string; profile?: string; q?: string; collections?: boolean } = {}): Envelope & { cursor: string; changes?: Change[] } {
  // The undated notes' entities as their files are now (notes.ts): edited in another editor, moved, deleted;
  // and linked files looked at again (links.ts): changed, a new hash; gone, marked missing.
  reconcileNotes();
  refreshLinks();
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
  // Collections (Tasks' boards, matrices, smart lists) only when asked for (`?collections=1`): a sync pairing them with
  // another app's. Each with its members as they are now — what a smart one's rule matches, what a matrix has placed where.
  const { collections: lists, ...rest } = whole;
  return {
    ...rest,
    ...(q.collections && lists ? { collections: lists } : {}),
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
  /** The body (*The body*): beside `set`, replaced whole; `unset: ["content"]` removes it. */
  content?: string;
  /** Filed away (`true`) or brought back (`false`), beside `set`; untouched when not named (fixtures/archive.json). */
  archived?: boolean;
}

/** What a patch asks of the body: replaced, removed, or — named by neither — kept. */
export function bodyOf(p: WritePatch): { body: "keep" } | { body: "set"; content: string } | { body: "clear" } {
  if ((p.unset ?? []).includes("content")) return { body: "clear" };
  if (typeof p.content === "string") return { body: "set", content: p.content };
  return { body: "keep" };
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
export function applyPatch(object: { properties?: Record<string, unknown>; tags?: string[]; version?: number | string; content?: string | null; archived?: boolean }, p: WritePatch): WriteAnswer {
  const add = p.addTags ?? [];
  const drop = p.removeTags ?? [];
  if (add.some((t) => drop.includes(t))) return { ok: false, object, fidelity: "full", reports: ["tags.added-and-removed"] };
  if (p.version !== undefined && object.version !== undefined && String(p.version) !== String(object.version)) {
    return { ok: false, conflict: true, object, fidelity: "full", reports: [] };
  }
  const properties = { ...(object.properties ?? {}) };
  for (const [k, v] of Object.entries(p.set ?? {})) properties[k] = v;
  // `content` in `unset` is the body, never a property of that name.
  for (const k of p.unset ?? []) if (k !== "content") delete properties[k];
  const body = bodyOf(p);
  const { content: was, ...rest } = object;
  const content = body.body === "set" ? body.content : body.body === "clear" ? undefined : (was ?? undefined);
  let tags = object.tags;
  if (add.length || drop.length) {
    const next = (object.tags ?? []).filter((t) => !drop.includes(t));
    for (const t of add) if (!next.includes(t)) next.push(t);
    tags = next;
  }
  const archived = typeof p.archived === "boolean" ? { archived: p.archived } : {};
  return { ok: true, object: { ...rest, properties, ...(content !== undefined && content !== null ? { content } : {}), ...(tags !== undefined ? { tags } : {}), ...archived }, fidelity: "full", reports: [] };
}

/**
 * A file over the live binding, by its hash (*Files*), as a rule: the address
 * must be the bytes' own hash; a put of one held changes nothing; a get of one
 * not held is said. Pure, so the fixtures measure what the routes do.
 */
export function fileRule(held: (sha: string) => boolean, op: string, sha256: string, bytes?: Buffer): { ok: boolean; created?: boolean; reports: string[] } {
  if (op === "put") {
    if (!/^[0-9a-f]{64}$/.test(sha256) || createHash("sha256").update(bytes ?? Buffer.alloc(0)).digest("hex") !== sha256) return { ok: false, reports: ["file.hash-mismatch"] };
    return { ok: true, created: !held(sha256), reports: [] };
  }
  if (op === "get") return held(sha256) ? { ok: true, reports: [] } : { ok: false, reports: ["file.not-held"] };
  return { ok: false, reports: ["file.op"] };
}
/** Whether this store can answer a file's bytes: kept, or a linked file that is still that file (links.ts). */
const holds = (sha: string) => { try { return getFile(sha) !== null || linkedBytes(sha) !== null; } catch { return false; } };

/** A file handed over at /interchange/files/<sha256>: kept, by the rule above. */
export function putInterchangeFile(sha256: string, bytes: Buffer): { ok: boolean; created?: boolean; reports: string[] } {
  const ruled = fileRule(holds, "put", sha256, bytes);
  if (ruled.ok && ruled.created) putFile(bytes, sha256);
  return ruled;
}
/** A file asked for by its hash: its bytes, or why not. */
export function getInterchangeFile(sha256: string): { ok: boolean; bytes?: Buffer; reports: string[] } {
  const ruled = fileRule(holds, "get", sha256);
  return ruled.ok ? { ...ruled, bytes: getFile(sha256) ?? linkedBytes(sha256)! } : ruled;
}

/**
 * Attachment values in a write, taken in: bytes handed inline are kept as a
 * file (and dropped from the value — the hash says which); a value naming a
 * hash not held is kept as a known-missing file, and said.
 */
function absorbFiles(props: Record<string, unknown> | undefined, reports: string[]): Record<string, unknown> | undefined {
  if (!props) return props;
  const one = (v: unknown): unknown => {
    if (!v || typeof v !== "object" || (v as { kind?: string }).kind !== "attachment") return v;
    const a = { ...(v as Record<string, unknown>) };
    if (typeof a.bytes === "string" && a.bytes) {
      const bytes = Buffer.from(a.bytes, "base64");
      const sha = createHash("sha256").update(bytes).digest("hex");
      if (typeof a.sha256 === "string" && a.sha256 !== sha) { reports.push("attachment.hash-mismatch"); return undefined; }
      putFile(bytes, String(a.filename ?? "attachment"), typeof a.mediaType === "string" ? a.mediaType : undefined);
      a.sha256 = sha;
      delete a.bytes;
    } else if (typeof a.sha256 === "string" && !holds(a.sha256)) {
      reports.push("attachment.known-missing");
    }
    return a;
  };
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(props)) out[k] = Array.isArray(v) ? v.map(one).filter((x) => x !== undefined) : one(v);
  return out;
}
/** The hashes of every attachment a property bag names. */
function hashesIn(props: Record<string, unknown> | undefined, keys?: string[]): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(props ?? {})) {
    if (keys && !keys.includes(k)) continue;
    for (const x of Array.isArray(v) ? v : [v]) if (x && typeof x === "object" && (x as { kind?: string }).kind === "attachment" && typeof (x as { sha256?: unknown }).sha256 === "string") out.push((x as { sha256: string }).sha256);
  }
  return out;
}

/** A partial write to the store: the rule above, then the store's own update, which does what a write does. */
export function patchObject(id: string, p: WritePatch): WriteAnswer {
  reconcileNotes();
  const now = getEntity(id);
  const ruled = applyPatch(now, p);
  if (!ruled.ok) return { ...ruled, object: now as unknown as WriteAnswer["object"] };
  const reports: string[] = [];
  // A file named by hash that this thing links stays a link (links.ts): a sync knows nothing of links.
  const set = absorbFiles(keepLinks(now.properties, p.set), reports);
  const body = bodyOf(p);
  const propUnset = (p.unset ?? []).filter((k) => k !== "content");
  // The files the touched fields named before, and what they name now: the rest are let go, and freed if nothing else names them.
  const touched = [...Object.keys(p.set ?? {}), ...propUnset];
  const before = hashesIn(now.properties, touched);
  const release = () => { const after = new Set(hashesIn(set, touched)); forgetFiles(before.filter((h) => !after.has(h))); };
  // A daily note is its day's page: words to it (notes.ts); the date is its identity; anything else is the entity's.
  if (isDay(id)) {
    writeDay(id, set ?? {}, body.body === "set" ? body.content : body.body === "clear" ? "" : undefined);
    const rest: Record<string, unknown> = Object.fromEntries(Object.entries(set ?? {}).filter(([k]) => !["title", "date", "body"].includes(k)));
    for (const k of propUnset) if (!["title", "date", "body"].includes(k)) rest[k] = null;
    if (Object.keys(rest).length || p.addTags?.length || p.removeTags?.length) {
      updateEntity(id, { ...(Object.keys(rest).length ? { properties: rest } : {}), ...(p.addTags?.length || p.removeTags?.length ? { tags: ruled.object!.tags ?? [] } : {}) });
    }
    if (typeof p.archived === "boolean") updateEntity(id, { archived: p.archived });
    release();
    return { ok: true, created: false, object: getEntity(id) as unknown as WriteAnswer["object"], fidelity: reports.length ? "reduced" : "full", reports, cursor: cursor() };
  }
  // An undated note is its file: a title renames it, words are written to it (notes.ts); anything else is the entity's.
  if (isUndated(id)) {
    const e = writeNote(id, set ?? {}, body.body === "set" ? body.content : body.body === "clear" ? "" : undefined);
    const own = new Set([types().find((t) => t.id === e.type)?.profiles?.note?.title, types().find((t) => t.id === e.type)?.profiles?.note?.body].filter((x): x is string => typeof x === "string"));
    const rest: Record<string, unknown> = Object.fromEntries(Object.entries(set ?? {}).filter(([k]) => !own.has(k)));
    for (const k of propUnset) if (!own.has(k)) rest[k] = null;
    if (Object.keys(rest).length || p.addTags?.length || p.removeTags?.length) {
      updateEntity(id, { ...(Object.keys(rest).length ? { properties: rest } : {}), ...(p.addTags?.length || p.removeTags?.length ? { tags: ruled.object!.tags ?? [] } : {}) });
    }
    if (typeof p.archived === "boolean") updateEntity(id, { archived: p.archived });
    release();
    return { ok: true, object: getEntity(id) as unknown as WriteAnswer["object"], fidelity: reports.length ? "reduced" : "full", reports, cursor: cursor() };
  }
  // A project's name is its project's (the bar, the switcher, Tasks): renamed there, as Tasks' own sheet does,
  // or the store would put the old one back the next time it reads the projects.
  const ws = projectIdOf(now);
  const titleKey = types().find((t) => t.id === now.type)?.profiles?.project?.title;
  if (ws && typeof titleKey === "string" && typeof p.set?.[titleKey] === "string" && (p.set[titleKey] as string).trim()) renameProject(ws, p.set[titleKey] as string);
  const properties: Record<string, unknown> = { ...(set ?? {}) };
  for (const k of propUnset) properties[k] = null;
  const written = updateEntity(id, {
    properties,
    ...(body.body === "set" ? { content: body.content } : body.body === "clear" ? { content: null } : {}),
    ...(p.addTags?.length || p.removeTags?.length ? { tags: ruled.object!.tags ?? [] } : {}),
    // Filed away or brought back, in the same version-checked write.
    ...(typeof p.archived === "boolean" ? { archived: p.archived } : {}),
    version: now.version,
  });
  release();
  // As it stands now — the store's doing included (a time stamped, a next occurrence made).
  return { ok: true, object: getEntity(written.id) as unknown as WriteAnswer["object"], fidelity: reports.length ? "reduced" : "full", reports, cursor: cursor() };
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
  // A project is a project — a folder, a desktop — whoever makes it: made as Tasks makes one, its entity at the id asked for.
  const projectTitle = types().find((t) => t.id === body.type)?.profiles?.project?.title;
  if (typeof projectTitle === "string") {
    const name = String(body.properties?.[projectTitle] ?? "").trim();
    if (!name) return { ok: false, created: false, fidelity: "full", reports: ["create.project-needs-a-name"], cursor: cursor() };
    let folder;
    try { folder = createProject(name); } catch (e) { return { ok: false, created: false, fidelity: "full", reports: [`create.project-refused: ${(e as Error).message}`], cursor: cursor() }; }
    const made = createEntity({ id: at, type: body.type, properties: body.properties ?? {}, sources: [{ kind: PROJECT_SOURCE, key: folder.id }] });
    return { ok: true, created: true, object: made as unknown as WriteAnswer["object"], fidelity: "full", reports: [], cursor: cursor() };
  }
  const reports: string[] = [];
  const properties = absorbFiles(body.properties, reports) ?? {};
  // A page for a day made through the binding is that day's daily note (notes.ts), the date its identity; never a second one for the day.
  const dayField = types().find((t) => t.id === body.type)?.profiles?.journal?.date;
  if (typeof dayField === "string" && typeof properties[dayField] === "string") {
    const bodyField = types().find((t) => t.id === body.type)?.profiles?.note?.body;
    const words = bodyField === "content" || typeof bodyField !== "string" ? body.content ?? "" : String(properties[bodyField] ?? "");
    let made;
    try { made = createDay(at, String(properties[dayField]), words); }
    catch (e) { return { ok: false, created: false, fidelity: "full", reports: [(e as Error).message], cursor: cursor() }; }
    if (body.tags?.length) updateEntity(made.id, { tags: body.tags });
    return { ok: true, created: true, object: getEntity(made.id) as unknown as WriteAnswer["object"], fidelity: reports.length ? "reduced" : "full", reports, cursor: cursor() };
  }
  // A note made through the binding is an undated note: one of Home's Pages, at the id asked for (notes.ts).
  const noteTitle = types().find((t) => t.id === body.type)?.profiles?.note?.title;
  if (typeof noteTitle === "string" && !types().find((t) => t.id === body.type)?.profiles?.task) {
    const bodyField = types().find((t) => t.id === body.type)?.profiles?.note?.body;
    const words = bodyField === "content" || typeof bodyField !== "string" ? body.content ?? "" : String(properties[bodyField] ?? "");
    const made = createNote(at, String(properties[noteTitle] ?? "").trim(), words);
    // Everything else it came with stays on it, known or not: the file holds the title and the words, the entity the rest.
    const rest = Object.fromEntries(Object.entries(properties).filter(([k]) => k !== noteTitle && k !== bodyField));
    if (Object.keys(rest).length || body.tags?.length) updateEntity(made.id, { ...(Object.keys(rest).length ? { properties: rest } : {}), ...(body.tags?.length ? { tags: body.tags } : {}) });
    return { ok: true, created: true, object: getEntity(made.id) as unknown as WriteAnswer["object"], fidelity: reports.length ? "reduced" : "full", reports, cursor: cursor() };
  }
  const made = createEntity({ id: at, type: body.type, properties, ...(body.content ? { content: body.content } : {}), ...(body.tags ? { tags: body.tags } : {}) });
  return { ok: true, created: true, object: made as unknown as WriteAnswer["object"], fidelity: reports.length ? "reduced" : "full", reports, cursor: cursor() };
}

/** What a follower concludes from a feed: the last word about each object is the one that counts. */
export function follow(feed: { seq?: number; object: string; op: string }[]): { alive: string[]; gone: string[] } {
  const last = new Map<string, string>();
  for (const r of [...feed].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))) last.set(r.object, r.op);
  const alive: string[] = [], gone: string[] = [];
  for (const [id, op] of last) (op === "delete" ? gone : alive).push(id);
  return { alive, gone };
}
