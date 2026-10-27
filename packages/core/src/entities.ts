// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Conflict, NotFound } from "./projects.js";
import { seal, unseal } from "./seal.js";
import { newId, writeAtomic } from "./store.js";
import { ENTITIES_DIR, storeKey } from "./vault.js";
import { record, reloadFeed } from "./feed.js";

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
export type Role = "person" | "event" | "task" | "note" | "project" | "file" | "daily";
const PROFILE_OF: Record<Role, string | null> = { person: "contact", event: "event", task: "task", note: "note", project: null, file: null, daily: "journal" };

/**
 * The types Talaris starts with. Their names are only names — the user's to
 * change; what makes each what it is is its profile, or `talaris:role`.
 */
export const BUILT_IN: EntityType[] = [
  {
    // A contact card's fields (vCard's, by and large), so a person can be tied
    // to cards in contacts accounts and say what they say. Version 2 added role
    // and the rest; `notes` is shown as the description. Version 3: the
    // `contact` profile's slots, as the format now names them.
    id: "t_person", name: "Person", "talaris:role": "person", "talaris:version": 3,
    fields: [
      { key: "title", kind: "text", required: true, "talaris:label": "Name" },
      { key: "emails", kind: "text", many: true },
      { key: "phones", kind: "text", many: true },
      { key: "organization", kind: "text" },
      { key: "role", kind: "text" },
      { key: "pronouns", kind: "text" },
      { key: "notes", kind: "richtext", "talaris:label": "Description" },
      { key: "image", kind: "attachment" },
      { key: "files", kind: "attachment", many: true },
      { key: "addresses", kind: "text", many: true },
      { key: "birthday", kind: "date" },
      { key: "websites", kind: "text", many: true },
    ],
    profiles: { contact: { title: "title", email: "emails", phone: "phones", organization: "organization", role: "role", body: "notes" } },
  },
  {
    // Version 2: files kept with an event (an agenda, the slides). Version 3:
    // the `event` profile's slots, its people among them.
    id: "t_event", name: "Event", "talaris:role": "event", "talaris:version": 3,
    fields: [
      { key: "title", kind: "text", required: true },
      { key: "start", kind: "datetime" },
      { key: "end", kind: "datetime" },
      { key: "allDay", kind: "boolean" },
      { key: "location", kind: "text" },
      { key: "organizer", kind: "reference", targetType: "t_person" },
      { key: "attendees", kind: "reference", targetType: "t_person", many: true },
      { key: "notes", kind: "richtext" },
      { key: "files", kind: "attachment", many: true },
    ],
    profiles: { event: { title: "title", start: "start", end: "end", location: "location", attendees: "attendees", organizer: "organizer", body: "notes" } },
  },
  {
    // Hermes' task, field for field, so a sync maps one to one (DESIGN, Tasks).
    // Version 5: the task profile says which field is its project. Version 6:
    // and which is its notes (`body`), so a sync carries them.
    id: "t_task", name: "Task", "talaris:role": "task", "talaris:version": 6,
    fields: [
      { key: "title", kind: "text", required: true },
      { key: "description", kind: "richtext" },
      { key: "schedule", kind: "datespan", startLabel: "Available", endLabel: "Due" },
      {
        key: "status", kind: "enum",
        options: ["not_started", "in_progress", "blocked", "done", "archived", "wont_do"],
        "talaris:labels": { not_started: "Not started", in_progress: "In progress", blocked: "Blocked", done: "Done", archived: "Archived", wont_do: "Won't do" },
        "talaris:colors": { not_started: "#868c92", in_progress: "#5fa4b5", blocked: "#c26b6b", done: "#8aa878", archived: "#6c7277", wont_do: "#6c7277" },
      },
      { key: "project", kind: "reference", targetType: "t_project", many: true },
      // Stamped by the core when a task is finished: shown, never asked for (talaris:auto).
      { key: "done_at", kind: "datetime", "talaris:auto": true },
      // Files kept with the task: the format's attachment values, the bytes
      // sealed beside the entities, once each by their hash.
      { key: "attachments", kind: "attachment", many: true },
    ],
    "talaris:defaultStatus": "not_started",
    profiles: {
      task: {
        title: "title", start: { field: "schedule", part: "start" }, due: { field: "schedule", part: "end" },
        status: "status", completeValues: ["done", "archived", "wont_do"], project: "project", body: "description",
      },
    },
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
    // Version 2: it says it is a project (the format's `project` profile).
    id: "t_project", name: "Project", "talaris:role": "project", "talaris:version": 2,
    fields: [
      { key: "title", kind: "text", required: true },
      { key: "description", kind: "richtext" },
    ],
    profiles: { project: { title: "title", body: "description" } },
  },
  {
    // A daily note (pages.ts, Home's `Daily/<date>`), as the live binding hands
    // it out (notes.ts): a note that is the page for a day — the format's
    // `journal` profile, its date the day's identity.
    id: "t_daily", name: "Daily note", "talaris:role": "daily",
    fields: [
      { key: "title", kind: "text" },
      { key: "date", kind: "date", required: true },
      { key: "body", kind: "richtext" },
    ],
    profiles: { note: { title: "title", body: "body" }, journal: { date: "date" } },
  },
  {
    // A file in Files (files.ts): one in a project's folder, given an entity
    // when it is first tagged (a `file` source, `<project>/<path>`), or a
    // shortcut to a file elsewhere (`talaris:shortcut`, its project), whose
    // `file` is a link. No profile: the format has no kind for a file, and a
    // sync carries none.
    id: "t_file", name: "File", "talaris:role": "file",
    fields: [
      { key: "title", kind: "text", required: true, "talaris:label": "Name" },
      { key: "file", kind: "attachment" },
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
    const had = ix.types.get(t.id);
    const behind = had && Number(t["talaris:version"] ?? 1) > Number(had["talaris:version"] ?? 1);
    if (!had || behind) {
      // A built-in type grown since: the new shape, keeping the name it was
      // given and any fields somebody added to it.
      const mine = new Set(t.fields.map((f) => f.key));
      // A field a person set (its statuses, say: talaris:edited) stays theirs.
      const theirs = new Map((had?.fields ?? []).filter((f) => f["talaris:edited"]).map((f) => [f.key, f]));
      const fields = t.fields.map((f) => theirs.get(f.key) ?? f);
      // Its profiles: a slot new in the built-in added, every slot already there kept as it was (its statuses, set by hand).
      const profiles = had ? { ...(had.profiles ?? {}), ...Object.fromEntries(Object.entries(t.profiles ?? {}).map(([n, m]) => [n, { ...m, ...(had.profiles?.[n] ?? {}) }])) } : t.profiles;
      const merged = had ? { ...t, name: had.name, fields: [...fields, ...had.fields.filter((f) => !mine.has(f.key))], ...(profiles ? { profiles } : {}),
        ...(had["talaris:defaultStatus"] !== undefined ? { "talaris:defaultStatus": had["talaris:defaultStatus"] } : {}) } : t;
      writeSealed(join(dir("types"), safe(t.id)), merged);
      ix.types.set(t.id, merged);
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
  reloadFeed();
}

// ------------------------------------------------------------ what else is kept

/**
 * Other sealed records beside the entities — series, lists — each a folder of
 * their own, one file per record, by id.
 */
export function sealedList<T>(folder: string): T[] {
  load();
  const d = dir(folder);
  mkdirSync(d, { recursive: true });
  return readdirSync(d).filter((n) => !n.startsWith(".")).map((n) => readSealed<T>(join(d, n)));
}
export function sealedPut(folder: string, id: string, value: unknown): void {
  load();
  writeSealed(join(dir(folder), safe(id)), value);
}
export function sealedDrop(folder: string, id: string): void {
  rmSync(join(dir(folder), safe(id)), { force: true });
}
/** Whether a store has been through something once (a dotfile, so never read as one of its records); marked when asked. */
export function sealedOnce(folder: string, what: string): boolean {
  const mark = join(dir(folder), "." + safe(what));
  if (existsSync(mark)) return true;
  mkdirSync(dir(folder), { recursive: true });
  writeFileSync(mark, "");
  return false;
}

/**
 * What happens when an entity is made or changed, beyond the change itself:
 * completing a task stamps it, and a recurring one brings its next (tasks.ts).
 * Hooks see the entity before and after; a hook that changes it again goes
 * through `updateEntity` like anything else.
 */
type Hook = (before: Entity | null, after: Entity) => void;
const hooks: Hook[] = [];
export function onChange(hook: Hook): void {
  hooks.push(hook);
}
function changed(before: Entity | null, after: Entity): Entity {
  for (const h of hooks) h(before, after);
  return load().records.get(after.id)?.object ?? after;
}

function put(rec: Record_): Entity {
  const ix = load();
  const existed = ix.records.has(rec.object.id);
  indexOut(ix, rec.object.id);
  writeSealed(join(dir("objects"), safe(rec.object.id)), rec);
  indexIn(ix, rec);
  // Every write, in order, for a follower (feed.ts): one row about the object.
  record(rec.object.id, existed ? "update" : "create");
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
    if (typeof key === "string" && typeof o.properties[key] === "string" && o.properties[key]) return plainText(o.properties[key] as string);
  }
  if (typeof o.properties.title === "string" && o.properties.title) return plainText(o.properties.title);
  return firstLine(plainText(bodyOf(o))) ?? "Untitled";
}

/** A mention (`[@Name](talaris:id)`) read as the words it shows. */
const plainText = (t: string) => t.replace(/\[([^\]\n]*)\]\(talaris:[A-Za-z0-9_-]+\)/g, "$1");

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
  /** When it last changed (or was made): what lists of connections are ordered by, newest first. */
  updated?: string;
}

export function summary(o: Entity): Summary {
  return {
    id: o.id, title: titleOf(o), kinds: profilesOf(o), type: o.type, updated: o.updated,
    ...(o.stub ? { stub: true } : {}), ...(o.archived ? { archived: true } : {}),
  };
}

/**
 * Entities matching words, of a kind if asked: every word somewhere in the
 * title, the text properties, or the body. Titles first, then the rest.
 */
export function findEntities(options: { q?: string; kind?: string; limit?: number; archived?: boolean; prefer?: string; near?: Set<string> } = {}): Summary[] {
  const words = (options.q ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const found: { s: Summary; score: number }[] = [];
  for (const { object: o } of load().records.values()) {
    if (o.archived && !options.archived) continue;
    if (options.kind && !profilesOf(o).includes(options.kind)) continue;
    const title = titleOf(o).toLowerCase();
    const rest = [JSON.stringify(o.properties), o.content ?? ""].join(" ").toLowerCase();
    if (!words.every((w) => title.includes(w) || rest.includes(w))) continue;
    // A title that starts with what was typed, then one with a word that does,
    // then one holding it anywhere, then a match only in its other words: "chu"
    // finds Chuck before dschumacher@…. Within each, the kind preferred first
    // (people, for an @).
    const wordStart = (w: string) => new RegExp(`(^|[^\\p{L}\\p{N}])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "u").test(title);
    const score = words.length === 0 ? 0
      : title.startsWith(words[0]!) && words.every((w) => title.includes(w)) ? 4
      : words.every(wordStart) ? 3
      : words.every((w) => title.includes(w)) ? 2 : 1;
    const preferred = options.prefer && profilesOf(o).includes(options.prefer) ? 1 : 0;
    // Tied to the project being worked in: ahead of all but a much closer match.
    const near = options.near?.has(o.id) ? 3 : 0;
    found.push({ s: summary(o), score: score * 2 + preferred + near });
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

/*
 * A linked file (links.ts) is an attachment saying where a file is on disk;
 * whatever holds the link has the file read when it is looked at again, and
 * its bytes handed to whoever may read the thing. So a link is made only by
 * Talaris's own code — linking a file the person chose, moving one, putting
 * one back — never taken from a write: a plugin, a sync or Morgan writing a
 * task could otherwise name any file of the person's, and have it read and
 * carried off. A write that carries a link the thing already had, unchanged,
 * keeps it (a sync rewriting a task's files keeps their links).
 */
const LINK_MARKS = ["talaris:link", "talaris:missing"];
let trustedDepth = 0;
/** Writes made inside `f` may make links: Talaris's own linking, and a revived backup of the person's own. */
export function trusted<T>(f: () => T): T {
  trustedDepth++;
  try { return f(); } finally { trustedDepth--; }
}
const isAttachment = (x: unknown): x is Record<string, unknown> => Boolean(x) && typeof x === "object" && (x as { kind?: unknown }).kind === "attachment";
/** A write's properties, with any link it did not have before taken off. */
function withoutNewLinks(props: Record<string, unknown> | undefined, before: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!props || trustedDepth > 0) return props;
  const had = (key: string) => {
    const v = before?.[key];
    return (Array.isArray(v) ? v : v ? [v] : []).filter(isAttachment);
  };
  const clean = (key: string, x: unknown) => {
    if (!isAttachment(x) || !LINK_MARKS.some((m) => m in x)) return x;
    const link = x["talaris:link"] as { path?: unknown } | undefined;
    const same = had(key).some((a) => a.sha256 === x.sha256 && (a["talaris:link"] as { path?: unknown } | undefined)?.path === link?.path);
    if (same) return x;
    const { ["talaris:link"]: _l, ["talaris:missing"]: _m, ...rest } = x;
    return rest;
  };
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(props)) out[k] = Array.isArray(v) ? v.map((x) => clean(k, x)) : clean(k, v);
  return out;
}

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
  const { id, role, sources, properties: given, ...rest } = input;
  const properties = withoutNewLinks(given, undefined);
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
  return changed(null, put({ object: o, relations: [] }));
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
  const { properties: given, content, sources, version: _v, ...rest } = patch;
  const properties = withoutNewLinks(given, o.properties);
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
  return changed(o, put({ object: next, relations: rec.relations }));
}

/** Removed for good. What pointed at it now points at nothing, and says so when read. */
export function deleteEntity(id: string): void {
  const ix = load();
  if (!ix.records.has(id)) throw new NotFound(`no entity ${id}`);
  // Its files go with it, unless something else still names them (`forgetFiles`).
  const files = hashesNamed(ix.records.get(id)!.object.properties);
  indexOut(ix, id);
  rmSync(join(dir("objects"), safe(id)), { force: true });
  record(id, "delete");
  if (files.length) forgetFiles(files);
}

/** The hashes of the files a property bag names. */
function hashesNamed(props: Record<string, unknown> | undefined): string[] {
  const out: string[] = [];
  for (const v of Object.values(props ?? {})) {
    for (const x of Array.isArray(v) ? v : [v]) {
      if (x && typeof x === "object" && (x as { kind?: string }).kind === "attachment" && typeof (x as { sha256?: unknown }).sha256 === "string") out.push((x as { sha256: string }).sha256);
    }
  }
  return out;
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

/**
 * The edges an entity's text makes (`mentions`, `via: "inline"`), set to
 * exactly these: the others it has are left alone. Unchanged, nothing is
 * written. Not a change of the entity's own, so its hooks are not run again.
 */
export function setInlineRelations(from: string, edges: { to: string; field: string }[]): void {
  const ix = load();
  const rec = ix.records.get(from);
  if (!rec) return;
  const others = rec.relations.filter((r) => r.via !== "inline");
  const inline = edges.map((e) => ({ from, to: e.to, type: "mentions", via: "inline", field: e.field }));
  const before = rec.relations.filter((r) => r.via === "inline").map((r) => `${r.to} ${r.field}`).sort().join("|");
  const after = inline.map((r) => `${r.to} ${r.field}`).sort().join("|");
  if (before === after) return;
  put({ object: rec.object, relations: [...others, ...inline] });
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
/**
 * Addresses that are not anybody: a calendar's own (Google gives every shared
 * calendar and every room an address, and they turn up as invitees), and the
 * no-reply kind. An event's people are made from its invitees, so these are
 * left out there rather than made into people.
 */
const NOT_A_PERSON = /@(group|resource|import|group\.v)\.calendar\.google\.com$|^(no-?reply|do-?not-?reply|calendar-notification)@/i;
export const isPersonAddress = (email: string): boolean => /@/.test(email) && !NOT_A_PERSON.test(email.trim());

/** A name that is only an address — what a person is called until their name is known. */
const onlyAddress = (title: unknown): boolean => typeof title !== "string" || !title.trim() || /^[^\s@]+@[^\s@]+$/.test(title.trim());

export function personFor(email: string, name?: string, extra: { sources?: Source[] } = {}): Entity {
  const known = byEmail(email);
  if (known) {
    const type = typeFor("person");
    const titleKey = String(type.profiles?.contact?.title ?? "title");
    // Known by name once a name is known: an address stands in only until then.
    const real = name && !/@/.test(name) ? name.trim() : "";
    if (real && onlyAddress(known.properties[titleKey]) && known.type === type.id) return updateEntity(known.id, { properties: { [titleKey]: real } });
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
  const organizer = e.organizer?.email && isPersonAddress(e.organizer.email) ? personFor(e.organizer.email, e.organizer.name).id : undefined;
  const seen = new Set<string>();
  const attendees: string[] = [];
  const attendance: Record<string, string> = {};
  for (const a of e.attendees ?? []) {
    if (!a.email || !isPersonAddress(a.email)) continue;
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

/**
 * Files no entity names any more, freed (*Files*: a file nothing names is the
 * producer's to free). Only the hashes given are looked at — those an
 * attachment was just taken away from — and one still named anywhere stays.
 */
export function forgetFiles(hashes: string[]): string[] {
  const named = new Set<string>();
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (v && typeof v === "object") {
      const a = v as { kind?: string; sha256?: unknown };
      // A link keeps no copy (links.ts): only a value the store holds the bytes for keeps them here.
      if (a.kind === "attachment" && typeof a.sha256 === "string" && !(v as Record<string, unknown>)["talaris:link"]) named.add(a.sha256);
    }
  };
  for (const r of load().records.values()) for (const v of Object.values(r.object.properties ?? {})) walk(v);
  const freed: string[] = [];
  for (const h of new Set(hashes)) {
    if (!/^[0-9a-f]{64}$/.test(h) || named.has(h)) continue;
    rmSync(join(dir("blobs"), h), { force: true });
    freed.push(h);
  }
  return freed;
}

export function fileHashes(): string[] {
  load();
  return readdirSync(dir("blobs")).filter((n) => /^[0-9a-f]{64}$/.test(n));
}

/**
 * People made, before it was known better, from addresses that are nobody's
 * (`isPersonAddress`): taken out of the events that list them, then gone.
 * Run as the core starts; with none left, it costs one look at the people.
 * Answers how many went.
 */
export function forgetNonPeople(): number {
  const type = typeFor("person");
  const emailKey = String(type.profiles?.contact?.email ?? "emails");
  const gone = new Set<string>();
  for (const { object: o } of load().records.values()) {
    if (o.type !== type.id) continue;
    const emails = (Array.isArray(o.properties[emailKey]) ? o.properties[emailKey] : []) as string[];
    if (emails.length && emails.every((e) => !isPersonAddress(String(e)))) gone.add(o.id);
  }
  if (!gone.size) return 0;
  for (const { object: o } of [...load().records.values()]) {
    if (gone.has(o.id)) continue;
    const patch: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(o.properties)) {
      if (Array.isArray(v) && v.some((x) => gone.has(x as string))) {
        const rest = v.filter((x) => !gone.has(x as string));
        patch[k] = rest.length ? rest : null;
      } else if (typeof v === "string" && gone.has(v)) patch[k] = null;
    }
    if (Object.keys(patch).length) updateEntity(o.id, { properties: patch });
  }
  for (const id of gone) deleteEntity(id);
  return gone.size;
}

// ------------------------------------------------------------ people

export interface PersonRow {
  id: string;
  title: string;
  organization?: string;
  role?: string;
  email?: string;
  /** Their picture, a kept file by hash (`GET /files/:sha`). */
  image?: string;
  updated: string;
  /** Contact cards they are tied to: "book/uid", as the address books know them. */
  ties: string[];
  /** Not to be offered contact cards to tie to (`talaris:noContact`). */
  noContact?: boolean;
}

/** Every person, as People lists them: enough to group, sort and show a row. */
/**
 * The organizations that are the person's own — work, a board they sit on —
 * marked in People, for its "My organizations" filter. Names, as people's
 * organization fields have them; matched without regard to case.
 */
export function myOrganizations(): string[] {
  return sealedList<{ id?: string; names?: string[] }>("people-prefs").find((x) => x.id === "mine")?.names ?? [];
}
export function setMyOrganizations(names: string[]): string[] {
  const kept = [...new Set(names.filter((n) => typeof n === "string" && n.trim()).map((n) => n.trim()))];
  sealedPut("people-prefs", "mine", { id: "mine", names: kept });
  return kept;
}

export function listPeople(): PersonRow[] {
  const type = typeFor("person");
  const c = type.profiles?.contact ?? {};
  const titleKey = String(c.title ?? "title"), emailKey = String(c.email ?? "emails");
  const out: PersonRow[] = [];
  for (const { object: o } of load().records.values()) {
    if (o.type !== type.id || o.stub || o.archived) continue;
    const p = o.properties;
    const emails = Array.isArray(p[emailKey]) ? (p[emailKey] as unknown[]).map(String) : [];
    const image = p.image as { sha256?: string } | undefined;
    const ties = ((o["talaris:sources"] as Source[] | undefined) ?? []).filter((s) => s.kind === "eds-contact").map((s) => s.key);
    out.push({
      id: o.id, title: String(p[titleKey] ?? "") || emails[0] || "Unnamed", updated: o.updated, ties,
      ...(typeof p.organization === "string" && p.organization.trim() ? { organization: p.organization.trim() } : {}),
      ...(typeof p.role === "string" && p.role.trim() ? { role: p.role.trim() } : {}),
      ...(emails[0] ? { email: emails[0] } : {}),
      ...(image?.sha256 ? { image: image.sha256 } : {}),
      ...(o["talaris:noContact"] ? { noContact: true } : {}),
    });
  }
  return out.sort((a, b) => a.title.localeCompare(b.title));
}

/** A person tied to a contact card ("book/uid"), or untied from it. Nothing of the card is copied. */
export function tieContact(id: string, key: string, on: boolean): Entity {
  const o = getEntity(id);
  if (o.type !== typeFor("person").id) throw new Conflict("only a person is tied to a contact");
  if (!/^[^/]+\/.+/.test(key)) throw new Conflict("a card is known by its book and its id");
  const sources = ((o["talaris:sources"] as Source[] | undefined) ?? []).filter((s) => !(s.kind === "eds-contact" && s.key === key));
  return updateEntity(id, { "talaris:sources": on ? [...sources, { kind: "eds-contact", key }] : sources });
}

/** Cards a person was deleted from: not brought back as people on the next reading. */
const FORGOTTEN = "forgotten-cards";

export interface Card {
  key: string;
  name?: string;
  emails?: string[];
  phones?: string[];
  org?: string;
  role?: string;
}

/**
 * An address-book card as a person: the one already tied to it; else the
 * one with its address, tied to it now; else one made from it, tied. What
 * the card says fills only what the person has empty. A card forgotten (its
 * person deleted) and a person marked never to be offered a contact are left
 * alone. Answers the person, or null.
 */
export function personFromCard(card: Card): Entity | null {
  if (!/^[^/]+\/.+/.test(card.key)) throw new Conflict("a card is known by its book and its id");
  const source: Source = { kind: "eds-contact", key: card.key };
  if (sealedList<{ key: string }>(FORGOTTEN).some((f) => f.key === card.key)) return null;
  const tied = bySource(source);
  if (tied) return tied;
  const type = typeFor("person");
  const c = type.profiles?.contact ?? {};
  const titleKey = String(c.title ?? "title"), emailKey = String(c.email ?? "emails"), phoneKey = String(c.phone ?? "phones");
  const emails = (card.emails ?? []).map((e) => e.trim().toLowerCase()).filter((e) => e.includes("@") && isPersonAddress(e));
  const found = emails.map((e) => byEmail(e)).find((x) => x && x.type === type.id) ?? null;
  if (found?.["talaris:noContact"]) return null;
  const name = (card.name ?? "").trim();
  if (!found && !name && !emails.length) return null;
  const fill = (o: Entity | null): Record<string, unknown> => {
    const p = o?.properties ?? {};
    const out: Record<string, unknown> = {};
    const empty = (k: string) => p[k] === undefined || p[k] === null || p[k] === "" || (Array.isArray(p[k]) && !(p[k] as unknown[]).length);
    if (name && (empty(titleKey) || /^[^\s@]+@[^\s@]+$/.test(String(p[titleKey] ?? "")))) out[titleKey] = name;
    const had = new Set(((p[emailKey] as string[] | undefined) ?? []).map((e) => e.toLowerCase()));
    const moreEmails = emails.filter((e) => !had.has(e));
    if (moreEmails.length) out[emailKey] = [...(p[emailKey] as string[] | undefined ?? []), ...moreEmails];
    if (card.phones?.length && empty(phoneKey)) out[phoneKey] = card.phones;
    if (card.org && empty("organization")) out.organization = card.org;
    if (card.role && empty("role")) out.role = card.role;
    return out;
  };
  if (found) {
    const sources = ((found["talaris:sources"] as Source[] | undefined) ?? []);
    return updateEntity(found.id, { properties: fill(found), "talaris:sources": [...sources, source] });
  }
  return createEntity({ type: type.id, properties: fill(null), sources: [source] });
}

/** A person deleted: the cards they were tied to are not to make them again. */
export function forgetCardsOf(id: string): void {
  const o = getEntity(id);
  for (const s of ((o["talaris:sources"] as Source[] | undefined) ?? []).filter((x) => x.kind === "eds-contact")) {
    sealedPut(FORGOTTEN, s.key.replace(/[^A-Za-z0-9_-]/g, "_"), { key: s.key });
  }
}

