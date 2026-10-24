// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Conflict, NotFound } from "./projects.js";
import { seal, unseal } from "./seal.js";
import { newId, writeAtomic } from "./store.js";
import { ENTITIES_DIR, storeKey } from "./vault.js";

/**
 * Entities: people, notes, projects, tasks and events — the things with
 * standing of their own (DESIGN, *Entities*).
 *
 * **Each one is a pkm-interchange object**, stored as the format has it:
 * `properties` keyed by its type's own fields, `content` for a body, declared
 * `reference` fields for the links a type declares, and `relations` for the
 * ones nobody declared. Keys this code does not know are kept as they came.
 * Talaris's own keys go under `talaris:`.
 *
 * **Kinds are read from types, never from names.** A type is found by the
 * profile it declares (`contact`, `event`, `task`, `note`) or, for the one
 * thing the format has no profile for, by `talaris:role` on the type — so a
 * person renaming "Person" to "Contact" changes nothing here.
 *
 * On disk, sealed: one file per entity, holding it and the relations going out
 * of it; one per type; one per attached file, named by its hash. What links to
 * what, and what came from where, is read from those at start into an index
 * that is only ever a cache.
 */

export interface Field {
  key: string;
  kind: string;
  required?: boolean;
  many?: boolean;
  targetType?: string;
  options?: string[];
  [extra: string]: unknown;
}

export interface EntityType {
  id: string;
  name: string;
  fields: Field[];
  profiles?: Record<string, Record<string, unknown>>;
  [extra: string]: unknown;
}

export interface Entity {
  id: string;
  type?: string;
  stub?: boolean;
  suggests?: string;
  properties: Record<string, unknown>;
  content?: string;
  tags?: string[];
  archived?: boolean;
  created: string;
  updated: string;
  version: number;
  [extra: string]: unknown;
}

export interface Relation {
  from: string;
  to: string;
  type: string;
  via?: string;
  field?: string;
  [extra: string]: unknown;
}

/** Where an entity also lives — a calendar's event, a canvas's note, a page. */
export interface Source {
  kind: string;
  key: string;
}

export interface Attachment {
  kind: "attachment";
  filename: string;
  mediaType?: string;
  sha256: string;
}

/** The roles Talaris itself needs a type for, each found by what the type declares. */
export type Role = "person" | "event" | "task" | "note" | "project";
const PROFILE_OF: Record<Role, string | null> = { person: "contact", event: "event", task: "task", note: "note", project: null };

/**
 * The types Talaris starts with. Their names are only names — the user's to
 * change; what makes each what it is is its profile, or `talaris:role`.
 */
export const BUILT_IN: EntityType[] = [
  {
    id: "t_person", name: "Person", "talaris:role": "person",
    fields: [
      { key: "title", kind: "text", required: true },
      { key: "emails", kind: "text", many: true },
      { key: "phones", kind: "text", many: true },
      { key: "organization", kind: "text" },
      { key: "notes", kind: "richtext" },
    ],
    profiles: { contact: { title: "title", email: "emails", phone: "phones" } },
  },
  {
    id: "t_event", name: "Event", "talaris:role": "event",
    fields: [
      { key: "title", kind: "text", required: true },
      { key: "start", kind: "datetime" },
      { key: "end", kind: "datetime" },
      { key: "allDay", kind: "boolean" },
      { key: "location", kind: "text" },
      { key: "organizer", kind: "reference", targetType: "t_person" },
      { key: "attendees", kind: "reference", targetType: "t_person", many: true },
      { key: "notes", kind: "richtext" },
    ],
    profiles: { event: { title: "title", start: "start", end: "end", location: "location" } },
  },
  {
    id: "t_task", name: "Task", "talaris:role": "task",
    fields: [
      { key: "title", kind: "text", required: true },
      { key: "status", kind: "enum", options: ["todo", "doing", "done"] },
      { key: "due", kind: "date" },
      { key: "project", kind: "reference", targetType: "t_project", many: true },
    ],
    profiles: { task: { title: "title", due: "due", status: "status", completeValues: ["done"] } },
  },
  {
    id: "t_note", name: "Note", "talaris:role": "note",
    fields: [
      { key: "title", kind: "text" },
      { key: "body", kind: "richtext" },
      { key: "people", kind: "reference", targetType: "t_person", many: true },
      { key: "events", kind: "reference", targetType: "t_event", many: true },
      { key: "project", kind: "reference", targetType: "t_project", many: true },
    ],
    // The body is a declared field, not the reserved `content`: a mention
    // found in it has to name a field the type declares (the format's
    // `inline.field-not-declared`), and `content` is not one.
    profiles: { note: { title: "title", body: "body" } },
  },
  {
    id: "t_project", name: "Project", "talaris:role": "project",
    fields: [
      { key: "title", kind: "text", required: true },
      { key: "description", kind: "richtext" },
    ],
  },
];

// ------------------------------------------------------------ on disk

const dir = (part: string) => join(ENTITIES_DIR, part);
const safe = (id: string) => {
  if (!/^[A-Za-z0-9_.:-]{1,120}$/.test(id) || id.startsWith(".")) throw new NotFound(`no entity ${id}`);
  return id.replace(/:/g, "%3A");
};

function writeSealed(path: string, value: unknown): void {
  writeAtomic(path, seal(storeKey(), JSON.stringify(value)));
}

function readSealed<T>(path: string): T {
  return JSON.parse(unseal(storeKey(), readFileSync(path)).toString("utf8")) as T;
}

interface Record_ {
  object: Entity;
  relations: Relation[];
}

// ------------------------------------------------------------ the index

interface Index {
  types: Map<string, EntityType>;
  records: Map<string, Record_>;
  /** Who points at an id: by a reference field, or a relation. */
  incoming: Map<string, Set<string>>;
  sources: Map<string, string>;
  emails: Map<string, string>;
}

let index: Index | null = null;

const sourceKey = (s: Source) => `${s.kind}\u0000${s.key}`;
const sourcesOf = (o: Entity): Source[] => (Array.isArray(o["talaris:sources"]) ? (o["talaris:sources"] as Source[]) : []);

function referenceTargets(o: Entity, types: Map<string, EntityType>): { field: string; to: string }[] {
  const type = o.type ? types.get(o.type) : undefined;
  if (!type) return [];
  const out: { field: string; to: string }[] = [];
  for (const f of type.fields) {
    if (f.kind !== "reference") continue;
    const v = o.properties[f.key];
    for (const to of Array.isArray(v) ? v : v ? [v] : []) if (typeof to === "string") out.push({ field: f.key, to });
  }
  return out;
}

function indexIn(ix: Index, rec: Record_): void {
  const o = rec.object;
  ix.records.set(o.id, rec);
  for (const { to } of referenceTargets(o, ix.types)) addIn(ix, to, o.id);
  for (const r of rec.relations) addIn(ix, r.to, o.id);
  for (const s of sourcesOf(o)) ix.sources.set(sourceKey(s), o.id);
  for (const e of emailsOf(ix, o)) ix.emails.set(e, o.id);
}

function indexOut(ix: Index, id: string): void {
  const rec = ix.records.get(id);
  if (!rec) return;
  for (const { to } of referenceTargets(rec.object, ix.types)) ix.incoming.get(to)?.delete(id);
  for (const r of rec.relations) ix.incoming.get(r.to)?.delete(id);
  for (const s of sourcesOf(rec.object)) if (ix.sources.get(sourceKey(s)) === id) ix.sources.delete(sourceKey(s));
  for (const e of emailsOf(ix, rec.object)) if (ix.emails.get(e) === id) ix.emails.delete(e);
  ix.records.delete(id);
}

function addIn(ix: Index, to: string, from: string): void {
  let set = ix.incoming.get(to);
  if (!set) ix.incoming.set(to, (set = new Set()));
  set.add(from);
}

function emailsOf(ix: Index, o: Entity): string[] {
  const type = o.type ? ix.types.get(o.type) : undefined;
  const field = type?.profiles?.contact?.email;
  if (typeof field !== "string") return [];
  const v = o.properties[field];
  return (Array.isArray(v) ? v : v ? [v] : []).filter((x): x is string => typeof x === "string").map((x) => x.trim().toLowerCase());
}

function load(): Index {
  if (index) return index;
  storeKey(); // locked stops here, before anything is read
  for (const d of ["objects", "types", "blobs"]) mkdirSync(dir(d), { recursive: true });
  const ix: Index = { types: new Map(), records: new Map(), incoming: new Map(), sources: new Map(), emails: new Map() };
  for (const name of readdirSync(dir("types"))) {
    if (name.startsWith(".")) continue;
    const t = readSealed<EntityType>(join(dir("types"), name));
    ix.types.set(t.id, t);
  }
  for (const t of BUILT_IN) {
    if (!ix.types.has(t.id)) {
      writeSealed(join(dir("types"), safe(t.id)), t);
      ix.types.set(t.id, t);
    }
  }
  for (const name of readdirSync(dir("objects"))) {
    if (name.startsWith(".")) continue;
    indexIn(ix, readSealed<Record_>(join(dir("objects"), name)));
  }
  return (index = ix);
}

/** Read again from disk (after a revival, or under test). */
export function reloadEntities(): void {
  index = null;
}

function put(rec: Record_): Entity {
  const ix = load();
  indexOut(ix, rec.object.id);
  writeSealed(join(dir("objects"), safe(rec.object.id)), rec);
  indexIn(ix, rec);
  return rec.object;
}

// ------------------------------------------------------------ types

export function types(): EntityType[] {
  return [...load().types.values()];
}

export function typeFor(role: Role): EntityType {
  const ix = load();
  const profile = PROFILE_OF[role];
  for (const t of ix.types.values()) if (t["talaris:role"] === role) return t;
  if (profile) for (const t of ix.types.values()) if (t.profiles?.[profile]) return t;
  throw new NotFound(`no type is a ${role}`);
}

export function putType(t: EntityType): EntityType {
  const ix = load();
  if (!t.id || !t.name || !Array.isArray(t.fields)) throw new Conflict("a type has an id, a name and fields");
  writeSealed(join(dir("types"), safe(t.id)), t);
  ix.types.set(t.id, t);
  return t;
}

/** The profiles an entity's type declares — what kind of thing it is, read from the type. */
export function profilesOf(o: Entity): string[] {
  const t = o.type ? load().types.get(o.type) : undefined;
  const out = Object.keys(t?.profiles ?? {});
  if (t?.["talaris:role"] === "project") out.push("project");
  return out;
}

/** Its title, read through its type's profiles; else the property called title; else its first line. */
export function titleOf(o: Entity): string {
  const t = o.type ? load().types.get(o.type) : undefined;
  for (const map of Object.values(t?.profiles ?? {})) {
    const key = map.title;
    if (typeof key === "string" && typeof o.properties[key] === "string" && o.properties[key]) return o.properties[key] as string;
  }
  if (typeof o.properties.title === "string" && o.properties.title) return o.properties.title;
  return firstLine(bodyOf(o)) ?? "Untitled";
}

/** Its body: where its type's note profile says, else the reserved `content`. */
export function bodyOf(o: Entity): string {
  const t = o.type ? load().types.get(o.type) : undefined;
  const key = t?.profiles?.note?.body;
  if (typeof key === "string" && key !== "content" && typeof o.properties[key] === "string") return o.properties[key] as string;
  return typeof o.content === "string" ? o.content : "";
}

function firstLine(text: string): string | undefined {
  // A line of Markdown, as words: no heading marks, no colored-text tags.
  const line = text.split("\n").find((l) => l.trim());
  return line?.replace(/<[^>]+>/g, "").replace(/^#+\s*/, "").trim().slice(0, 80) || undefined;
}

// ------------------------------------------------------------ reading

export function getEntity(id: string): Entity {
  const rec = load().records.get(id);
  if (!rec) throw new NotFound(`no entity ${id}`);
  return rec.object;
}

export function relationsFrom(id: string): Relation[] {
  return load().records.get(id)?.relations ?? [];
}

export function bySource(source: Source): Entity | null {
  const ix = load();
  const id = ix.sources.get(sourceKey(source));
  return id ? ix.records.get(id)!.object : null;
}

export function byEmail(email: string): Entity | null {
  const ix = load();
  const id = ix.emails.get(email.trim().toLowerCase());
  return id ? ix.records.get(id)?.object ?? null : null;
}

export interface Summary {
  id: string;
  title: string;
  kinds: string[];
  type?: string;
  stub?: boolean;
  archived?: boolean;
}

export function summary(o: Entity): Summary {
  return {
    id: o.id, title: titleOf(o), kinds: profilesOf(o), type: o.type,
    ...(o.stub ? { stub: true } : {}), ...(o.archived ? { archived: true } : {}),
  };
}

/**
 * Entities matching words, of a kind if asked: every word somewhere in the
 * title, the text properties, or the body. Titles first, then the rest.
 */
export function findEntities(options: { q?: string; kind?: string; limit?: number; archived?: boolean } = {}): Summary[] {
  const words = (options.q ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const found: { s: Summary; score: number }[] = [];
  for (const { object: o } of load().records.values()) {
    if (o.archived && !options.archived) continue;
    if (options.kind && !profilesOf(o).includes(options.kind)) continue;
    const title = titleOf(o).toLowerCase();
    const rest = [JSON.stringify(o.properties), o.content ?? ""].join(" ").toLowerCase();
    if (!words.every((w) => title.includes(w) || rest.includes(w))) continue;
    const score = words.length === 0 ? 0 : words.every((w) => title.includes(w)) ? (title.startsWith(words[0]!) ? 3 : 2) : 1;
    found.push({ s: summary(o), score });
  }
  found.sort((a, b) => b.score - a.score || a.s.title.localeCompare(b.s.title));
  return found.slice(0, options.limit ?? 50).map((f) => f.s);
}

export interface Connection {
  /** `field` for a declared reference (its key), `relation` for an edge (its type). */
  by: "field" | "relation";
  name: string;
  via?: string;
  entity: Summary;
}

/**
 * Everything an entity touches, both ways: what its fields and edges point at,
 * and what points at it. "Who was at this event" is its `attendees` going out;
 * "what is this person in" is everything coming in.
 */
export function connections(id: string): { entity: Entity; out: Connection[]; in: Connection[] } {
  const ix = load();
  const rec = ix.records.get(id);
  if (!rec) throw new NotFound(`no entity ${id}`);
  const known = (to: string) => ix.records.get(to)?.object;
  const out: Connection[] = [];
  for (const { field, to } of referenceTargets(rec.object, ix.types)) {
    const t = known(to);
    if (t) out.push({ by: "field", name: field, entity: summary(t) });
  }
  for (const r of rec.relations) {
    const t = known(r.to);
    if (t) out.push({ by: "relation", name: r.type, ...(r.via ? { via: r.via } : {}), entity: summary(t) });
  }
  const in_: Connection[] = [];
  for (const from of ix.incoming.get(id) ?? []) {
    const f = ix.records.get(from);
    if (!f) continue;
    for (const { field, to } of referenceTargets(f.object, ix.types)) {
      if (to === id) in_.push({ by: "field", name: field, entity: summary(f.object) });
    }
    for (const r of f.relations) {
      if (r.to === id) in_.push({ by: "relation", name: r.type, ...(r.via ? { via: r.via } : {}), entity: summary(f.object) });
    }
  }
  return { entity: rec.object, out, in: in_ };
}

// ------------------------------------------------------------ writing

const now = () => new Date().toISOString();

export interface NewEntity {
  id?: string;
  type?: string;
  role?: Role;
  stub?: boolean;
  suggests?: string;
  properties?: Record<string, unknown>;
  content?: string;
  tags?: string[];
  sources?: Source[];
  [extra: string]: unknown;
}

/**
 * Make an entity. A caller may name it (`id`): asked again with the same id,
 * it answers with the one already made rather than making a second.
 */
export function createEntity(input: NewEntity): Entity {
  const ix = load();
  if (input.id && ix.records.has(input.id)) return ix.records.get(input.id)!.object;
  const { id, role, sources, properties, ...rest } = input;
  const type = input.stub && !input.type && !role ? undefined : input.type ?? typeFor(role ?? "note").id;
  if (type && !ix.types.has(type)) throw new Conflict(`no type ${type}`);
  for (const s of sources ?? []) {
    if (ix.sources.has(sourceKey(s))) throw new Conflict(`${s.kind} ${s.key} is already an entity`);
  }
  const o: Entity = {
    id: id ?? newId("e"),
    ...(type ? { type } : {}),
    ...rest,
    properties: { ...(properties ?? {}) },
    created: now(),
    updated: now(),
    version: 1,
    ...(sources?.length ? { "talaris:sources": sources } : {}),
  };
  delete (o as { role?: unknown }).role;
  return put({ object: o, relations: [] });
}

export interface Patch {
  type?: string;
  properties?: Record<string, unknown>;
  content?: string | null;
  tags?: string[];
  archived?: boolean;
  stub?: boolean;
  sources?: Source[];
  /** Only if the entity is still at this version. */
  version?: number;
  [extra: string]: unknown;
}

/**
 * Change an entity. `properties` are merged — a key set to null is removed —
 * so a write names only what it changes, and what it does not know stays.
 */
export function updateEntity(id: string, patch: Patch): Entity {
  const ix = load();
  const rec = ix.records.get(id);
  if (!rec) throw new NotFound(`no entity ${id}`);
  const o = rec.object;
  if (patch.version !== undefined && patch.version !== o.version) {
    throw new Conflict(`entity ${id} has changed since version ${patch.version}`);
  }
  const { properties, content, sources, version: _v, ...rest } = patch;
  const next: Entity = { ...o, ...rest, properties: { ...o.properties }, updated: now(), version: o.version + 1 };
  if (patch.type !== undefined && !ix.types.has(patch.type)) throw new Conflict(`no type ${patch.type}`);
  for (const [k, v] of Object.entries(properties ?? {})) {
    if (v === null || v === "") delete next.properties[k];
    else next.properties[k] = v;
  }
  if (content === null) delete next.content;
  else if (content !== undefined) next.content = content;
  if (patch.stub === false) delete next.stub;
  if (sources) {
    const all = [...sourcesOf(o)];
    for (const s of sources) {
      const owner = ix.sources.get(sourceKey(s));
      if (owner && owner !== id) throw new Conflict(`${s.kind} ${s.key} is already another entity`);
      if (!all.some((x) => sourceKey(x) === sourceKey(s))) all.push(s);
    }
    next["talaris:sources"] = all;
  }
  return put({ object: next, relations: rec.relations });
}

/** Removed for good. What pointed at it now points at nothing, and says so when read. */
export function deleteEntity(id: string): void {
  const ix = load();
  if (!ix.records.has(id)) throw new NotFound(`no entity ${id}`);
  indexOut(ix, id);
  rmSync(join(dir("objects"), safe(id)), { force: true });
}

const sameEdge = (a: Relation, b: Relation) => a.to === b.to && a.type === b.type && (a.via ?? "") === (b.via ?? "") && (a.field ?? "") === (b.field ?? "");

/** An edge from one entity to another. Making the same one twice is one edge. */
export function link(r: Relation): Relation {
  const ix = load();
  const rec = ix.records.get(r.from);
  if (!rec) throw new NotFound(`no entity ${r.from}`);
  if (!ix.records.has(r.to)) throw new NotFound(`no entity ${r.to}`);
  if (!r.type) throw new Conflict("a relation has a type");
  if (rec.relations.some((x) => sameEdge(x, r))) return r;
  put({ object: { ...rec.object, updated: now(), version: rec.object.version + 1 }, relations: [...rec.relations, r] });
  return r;
}

/**
 * Connect one entity to another the way the format would want it said: in a
 * field its type declares for that kind of thing, where there is one (a note's
 * `people`, an event's `attendees`), else as an edge. A declared reference is
 * what other tools keep — Hermes stores fields and mentions, and carries a bare
 * edge without showing it — and the format says not to state it twice.
 */
export function connect(from: string, to: string, edge: { type?: string; via?: string } = {}): Connection {
  const ix = load();
  const rec = ix.records.get(from);
  const target = ix.records.get(to)?.object;
  if (!rec) throw new NotFound(`no entity ${from}`);
  if (!target) throw new NotFound(`no entity ${to}`);
  const type = rec.object.type ? ix.types.get(rec.object.type) : undefined;
  const field = type?.fields.find((f) => f.kind === "reference" && f.targetType && f.targetType === target.type);
  if (field) {
    const v = rec.object.properties[field.key];
    const list = Array.isArray(v) ? v : v ? [v] : [];
    if (!list.includes(to)) updateEntity(from, { properties: { [field.key]: field.many ? [...list, to] : to } });
    return { by: "field", name: field.key, entity: summary(target) };
  }
  link({ from, to, type: edge.type || "links", via: edge.via ?? "edge" });
  return { by: "relation", name: edge.type || "links", via: edge.via ?? "edge", entity: summary(target) };
}

/** Undo a connection, field or edge, whichever it was. */
export function disconnect(from: string, to: string): void {
  const ix = load();
  const rec = ix.records.get(from);
  if (!rec) throw new NotFound(`no entity ${from}`);
  const type = rec.object.type ? ix.types.get(rec.object.type) : undefined;
  const props: Record<string, unknown> = {};
  for (const f of type?.fields ?? []) {
    if (f.kind !== "reference") continue;
    const v = rec.object.properties[f.key];
    if (Array.isArray(v) && v.includes(to)) props[f.key] = v.filter((x) => x !== to).length ? v.filter((x) => x !== to) : null;
    else if (v === to) props[f.key] = null;
  }
  if (Object.keys(props).length) updateEntity(from, { properties: props });
  unlink({ from, to, type: "" });
}

export function unlink(r: Relation): void {
  const ix = load();
  const rec = ix.records.get(r.from);
  if (!rec) throw new NotFound(`no entity ${r.from}`);
  const kept = rec.relations.filter((x) => !(x.to === r.to && (!r.type || x.type === r.type)));
  if (kept.length === rec.relations.length) return;
  put({ object: { ...rec.object, updated: now(), version: rec.object.version + 1 }, relations: kept });
}

// ------------------------------------------------------------ people and events

/**
 * The person with this email: known already, or made now. A name given later
 * fills an empty one, never replaces one somebody chose.
 */
export function personFor(email: string, name?: string, extra: { sources?: Source[] } = {}): Entity {
  const known = byEmail(email);
  if (known) {
    const type = typeFor("person");
    const titleKey = String(type.profiles?.contact?.title ?? "title");
    if (name && !known.properties[titleKey] && known.type === type.id) return updateEntity(known.id, { properties: { [titleKey]: name } });
    return known;
  }
  const type = typeFor("person");
  const contact = type.profiles?.contact ?? {};
  return createEntity({
    type: type.id,
    properties: { [String(contact.title ?? "title")]: name || email, [String(contact.email ?? "emails")]: [email.trim()] },
    sources: extra.sources,
  });
}

export interface MirroredEvent {
  /** Where it lives: the calendar's own id for it. */
  source: Source;
  /**
   * What else it is known by — its iCalendar UID, the same in every account
   * that sees it — so one meeting seen through two accounts is one entity.
   */
  also?: Source[];
  title: string;
  start?: string;
  end?: string;
  allDay?: boolean;
  location?: string;
  organizer?: { email: string; name?: string };
  attendees?: { email: string; name?: string; status?: string }[];
}

/**
 * An event from a calendar, as an entity: made the first time, brought up to
 * date after. Only what the calendar owns is overwritten; anything Talaris
 * added — notes, links, tags — is left. Its people are made or found by email.
 * Unchanged, it is not written at all.
 */
export function mirrorEvent(e: MirroredEvent): Entity {
  const type = typeFor("event");
  const organizer = e.organizer?.email ? personFor(e.organizer.email, e.organizer.name).id : undefined;
  const seen = new Set<string>();
  const attendees: string[] = [];
  const attendance: Record<string, string> = {};
  for (const a of e.attendees ?? []) {
    if (!a.email) continue;
    const p = personFor(a.email, a.name).id;
    if (seen.has(p)) continue;
    seen.add(p);
    attendees.push(p);
    if (a.status) attendance[p] = a.status;
  }
  const properties: Record<string, unknown> = {
    title: e.title || "Untitled",
    start: e.start ?? null,
    end: e.end ?? null,
    allDay: e.allDay ? true : null,
    location: e.location || null,
    organizer: organizer ?? null,
    attendees: attendees.length ? attendees : null,
  };
  const sources = [e.source, ...(e.also ?? [])];
  const known = sources.map(bySource).find((x) => x) ?? null;
  if (!known) {
    const clean = Object.fromEntries(Object.entries(properties).filter(([, v]) => v !== null));
    return createEntity({ type: type.id, properties: clean, sources, ...(attendees.length ? { "talaris:attendance": attendance } : {}) });
  }
  const newSource = sources.some((s) => !sourcesOf(known).some((x) => sourceKey(x) === sourceKey(s)));
  const changed = newSource || Object.entries(properties).some(([k, v]) => JSON.stringify(known.properties[k] ?? null) !== JSON.stringify(v))
    || JSON.stringify(known["talaris:attendance"] ?? {}) !== JSON.stringify(attendees.length ? attendance : {});
  if (!changed) return known;
  return updateEntity(known.id, { properties, sources, "talaris:attendance": attendees.length ? attendance : undefined });
}

// ------------------------------------------------------------ attachments

/**
 * A file kept for an entity, by its hash: the same file twice is stored once.
 * Answers the attachment value to put in a field.
 */
export function putFile(bytes: Buffer, filename: string, mediaType?: string): Attachment {
  load();
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const path = join(dir("blobs"), sha256);
  if (!existsSync(path)) writeAtomic(path, seal(storeKey(), bytes));
  return { kind: "attachment", filename, ...(mediaType ? { mediaType } : {}), sha256 };
}

export function getFile(sha256: string): Buffer | null {
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new NotFound(`no file ${sha256}`);
  const path = join(dir("blobs"), sha256);
  if (!existsSync(path)) return null;
  const bytes = unseal(storeKey(), readFileSync(path));
  if (createHash("sha256").update(bytes).digest("hex") !== sha256) throw new Conflict(`file ${sha256} does not match its hash`);
  return bytes;
}

export function allRecords(): Record_[] {
  return [...load().records.values()];
}

export function fileHashes(): string[] {
  load();
  return readdirSync(dir("blobs")).filter((n) => /^[0-9a-f]{64}$/.test(n));
}
