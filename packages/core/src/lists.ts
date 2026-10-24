// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore

import { allRecords, getEntity, profilesOf, sealedDrop, sealedList, sealedPut, titleOf, typeFor, types, updateEntity, type Entity, type EntityType } from "./entities.js";
import { Conflict, NotFound } from "./projects.js";
import { newId } from "./store.js";
import { isComplete, shapeOf, spanOf } from "./tasks.js";

/**
 * Lists: the Tasks panel's saved views — `pkm-interchange` collections, kept
 * sealed beside the entities (DESIGN, *Tasks → Lists*).
 *
 * - **Membership** is `explicit` (members dragged into order) or a `query`;
 *   a query is live (`materialized: false`, run at every look, its order not
 *   the user's) or a snapshot (`materialized: true`, filled when asked, then
 *   edited by hand until refreshed).
 * - **Order** is the format's: `order.sort`, keys `{field, part}` or
 *   `{meta}`, missing values last in either direction, byte-wise unless both
 *   numbers, ties to `position`; `groupBy` one key. No `sort` means the
 *   positions are the order — somebody arranged them.
 * - **Placement** for a board or a matrix is semantic: named regions. A board
 *   is bound to a field (`talaris:bind`, its options the columns), so a card's
 *   column *is* its value; a matrix's regions are its own, and entering one can
 *   add a tag or set a status (`talaris:enter`) — the meaning is said, never a
 *   coordinate.
 * - **Views** (`talaris:view`): how a list is drawn — the list's format, a
 *   table's columns. Furniture, under the prefix.
 *
 * The query language is Hermes' (groups of all/any, nested; conditions on
 * kind, dates, tags, fields, text, attachments), with `state` (open or
 * complete) and `profile` (a kind by what a type declares) added, so a list
 * of tasks never names a type.
 */

export type Condition =
  | { kind: "group"; match: "all" | "any"; items: Condition[] }
  | { kind: "profile"; profile: string; op?: "is" | "isNot" }
  | { kind: "type"; typeId: string; op?: "is" | "isNot" }
  | { kind: "created" | "edited"; op: "before" | "after"; date: string }
  | { kind: "tag"; tag: string; op?: "include" | "exclude" }
  | { kind: "property"; key: string; op: "eq" | "neq" | "contains" | "lt" | "gt" | "empty" | "notEmpty"; value?: string }
  | { kind: "state"; value: "open" | "complete" }
  | { kind: "text"; value: string }
  | { kind: "hasAttachment"; has: boolean };

export type SortKey = { field: string; part?: "start" | "end" } | { meta: "type" | "created" | "updated" };

export interface Region {
  name: string;
  label?: string;
  "talaris:color"?: string;
  /** What entering the region does: add a tag, set a status. Leaving can take the tag away. */
  "talaris:enter"?: { tag?: string; status?: string; untagOnLeave?: boolean };
  [extra: string]: unknown;
}

export interface Member {
  object: string;
  position: string;
  region?: string;
  [extra: string]: unknown;
}

export interface List {
  id: string;
  name: string;
  kind: "list" | "table" | "board" | "matrix" | "calendar";
  membership: { mode: "explicit" } | { mode: "query"; materialized: boolean; query: Condition };
  members: Member[];
  placement?: { semantic: boolean; regions: (string | Region)[]; "talaris:columns"?: number };
  order?: { sort?: { by: SortKey; direction?: "ascending" | "descending" }[]; groupBy?: SortKey };
  archived?: boolean;
  "talaris:bind"?: string;
  "talaris:view"?: Record<string, unknown>;
  "talaris:starter"?: string;
  "talaris:position"?: string;
  [extra: string]: unknown;
}

const LISTS = "lists";

// ------------------------------------------------------------ positions

/**
 * Fractional positions: strings that sort byte-wise, and always have room
 * between two. Opaque to everyone else — the format says compare, never parse.
 */
const DIGITS = "0123456789abcdefghijklmnopqrstuvwxyz";
export function between(a: string | null, b: string | null): string {
  const lo = a ?? "";
  const hi = b ?? "";
  let out = "";
  for (let i = 0; ; i++) {
    const x = i < lo.length ? DIGITS.indexOf(lo[i]!) : 0;
    const y = i < hi.length ? DIGITS.indexOf(hi[i]!) : DIGITS.length;
    if (y - x > 1) return out + DIGITS[Math.floor((x + y) / 2)];
    out += DIGITS[x];
  }
}

// ------------------------------------------------------------ dates in queries

const pad = (n: number) => String(n).padStart(2, "0");
function localDay(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** `today`, `today+N`, `today-N`, `now` — in this machine's time — or the value as it is. */
export function resolveDate(v: string, asOf = new Date()): string {
  const t = v.trim();
  if (t === "now") return `${localDay(asOf)}T${pad(asOf.getHours())}:${pad(asOf.getMinutes())}`;
  const m = /^today\s*([+-])\s*(\d+)$/.exec(t);
  if (t === "today") return localDay(asOf);
  if (m) {
    const d = new Date(asOf);
    d.setDate(d.getDate() + (m[1] === "+" ? 1 : -1) * Number(m[2]));
    return localDay(d);
  }
  return t;
}

// ------------------------------------------------------------ the query, run

function propertyValue(o: Entity, key: string): unknown {
  const [field, part] = key.split(".");
  const v = field === "title" ? titleOf(o) : o.properties[field!];
  if (part && v && typeof v === "object") return (v as Record<string, unknown>)[part === "due" ? "end" : part];
  return v;
}

const isBlank = (v: unknown) => v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);
const asText = (v: unknown) => (typeof v === "string" ? v : Array.isArray(v) ? v.join(" ") : v === undefined || v === null ? "" : JSON.stringify(v));

function hasAttachment(o: Entity): boolean {
  const walk = (v: unknown): boolean =>
    Array.isArray(v) ? v.some(walk) : v && typeof v === "object" ? (v as { kind?: string }).kind === "attachment" || Object.values(v).some(walk) : false;
  return walk(o.properties);
}

export function matches(o: Entity, c: Condition, asOf = new Date()): boolean {
  switch (c.kind) {
    case "group": {
      if (!c.items.length) return true;
      return c.match === "any" ? c.items.some((x) => matches(o, x, asOf)) : c.items.every((x) => matches(o, x, asOf));
    }
    case "profile": {
      const has = profilesOf(o).includes(c.profile);
      return c.op === "isNot" ? !has : has;
    }
    case "type":
      return c.op === "isNot" ? o.type !== c.typeId : o.type === c.typeId;
    case "created":
    case "edited": {
      const at = (c.kind === "created" ? o.created : o.updated).slice(0, 16);
      const v = resolveDate(c.date, asOf);
      return c.op === "before" ? at < v : at > v;
    }
    case "tag": {
      const has = (o.tags ?? []).map((t) => t.toLowerCase()).includes(c.tag.toLowerCase());
      return c.op === "exclude" ? !has : has;
    }
    case "property": {
      const v = propertyValue(o, c.key);
      const want = c.value === undefined ? "" : resolveDate(String(c.value), asOf);
      switch (c.op) {
        case "empty": return isBlank(v);
        case "notEmpty": return !isBlank(v);
        case "eq": return Array.isArray(v) ? v.includes(want) : asText(v) === want;
        case "neq": return Array.isArray(v) ? !v.includes(want) : asText(v) !== want;
        case "contains": return Array.isArray(v) ? v.some((x) => asText(x).toLowerCase().includes(want.toLowerCase())) : asText(v).toLowerCase().includes(want.toLowerCase());
        // Both sides present, compared as text: ISO dates and times sort right that way.
        case "lt": return !isBlank(v) && want !== "" && asText(v) < want;
        case "gt": return !isBlank(v) && want !== "" && asText(v) > want;
      }
      return false;
    }
    case "state": {
      const shape = shapeOf(o);
      if (!shape) return false;
      return c.value === "complete" ? isComplete(o, shape) : !isComplete(o, shape);
    }
    case "text": {
      const words = c.value.toLowerCase().split(/\s+/).filter(Boolean);
      const hay = `${titleOf(o)} ${JSON.stringify(o.properties)} ${o.content ?? ""}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    }
    case "hasAttachment":
      return hasAttachment(o) === c.has;
  }
  return false;
}

export function runQuery(q: Condition, options: { archived?: boolean; asOf?: Date } = {}): Entity[] {
  return allRecords()
    .map((r) => r.object)
    .filter((o) => !o.stub && Boolean(o.archived) === Boolean(options.archived) && matches(o, q, options.asOf));
}

// ------------------------------------------------------------ sorting and grouping

function keyValue(o: Entity, by: SortKey, typeName: Map<string, string>): unknown {
  if ("meta" in by) return by.meta === "type" ? typeName.get(o.type ?? "") ?? "" : by.meta === "created" ? o.created : o.updated;
  if (by.field === "title") return titleOf(o);
  const v = o.properties[by.field];
  if (by.part && v && typeof v === "object") return (v as Record<string, unknown>)[by.part];
  return v;
}

/** The format's comparison: missing last whichever way; numbers as numbers; everything else byte-wise. */
function compare(a: unknown, b: unknown, descending: boolean): number {
  const ma = isBlank(a), mb = isBlank(b);
  if (ma || mb) return ma === mb ? 0 : ma ? 1 : -1;
  let r: number;
  if (typeof a === "number" && typeof b === "number") r = a - b;
  else {
    const x = asText(a), y = asText(b);
    r = x < y ? -1 : x > y ? 1 : 0;
  }
  return descending ? -r : r;
}

export function sortEntities(rows: { o: Entity; position: string }[], order: List["order"]): { o: Entity; position: string }[] {
  const typeName = new Map(types().map((t) => [t.id, t.name]));
  const keys = order?.sort ?? [];
  return [...rows].sort((a, b) => {
    for (const k of keys) {
      const r = compare(keyValue(a.o, k.by, typeName), keyValue(b.o, k.by, typeName), k.direction === "descending");
      if (r) return r;
    }
    return a.position < b.position ? -1 : a.position > b.position ? 1 : 0;
  });
}

// ------------------------------------------------------------ lists kept

export function allLists(options: { archived?: boolean } = {}): List[] {
  ensureStarters();
  return sealedList<List>(LISTS)
    .filter((l) => Boolean(l.archived) === Boolean(options.archived))
    .sort((a, b) => String(a["talaris:position"] ?? "").localeCompare(String(b["talaris:position"] ?? "")) || a.name.localeCompare(b.name));
}

export function getList(id: string): List {
  const l = sealedList<List>(LISTS).find((x) => x.id === id);
  if (!l) throw new NotFound(`no list ${id}`);
  return l;
}

function putList(l: List): List {
  sealedPut(LISTS, l.id, l);
  return l;
}

export interface NewList {
  name: string;
  kind?: List["kind"];
  query?: Condition | null;
  materialized?: boolean;
  order?: List["order"];
  placement?: List["placement"];
  bind?: string;
  view?: Record<string, unknown>;
}

export function createList(n: NewList): List {
  const name = n.name.trim();
  if (!name) throw new Conflict("a list has a name");
  const lists = sealedList<List>(LISTS);
  const last = lists.map((l) => String(l["talaris:position"] ?? "")).sort().pop() ?? null;
  const l: List = {
    id: newId("c"),
    name,
    kind: n.kind ?? "list",
    membership: n.query ? { mode: "query", materialized: Boolean(n.materialized), query: n.query } : { mode: "explicit" },
    members: [],
    ...(n.order ? { order: n.order } : {}),
    ...(n.placement ? { placement: n.placement } : {}),
    ...(n.bind ? { "talaris:bind": n.bind } : {}),
    ...(n.view ? { "talaris:view": n.view } : {}),
    "talaris:position": between(last, null),
  };
  defaultsFor(l);
  if (l.membership.mode === "query" && l.membership.materialized) materialize(l);
  return putList(l);
}

/** A board with nothing said is bound to the task's status; a matrix starts as two by two. */
function defaultsFor(l: List): void {
  if (l.kind === "board" && !l["talaris:bind"]) l["talaris:bind"] = "status";
  if (l.kind === "board") l.placement = { semantic: true, regions: statusRegions(l["talaris:bind"]!) };
  if (l.kind === "matrix" && !l.placement) {
    l.placement = {
      semantic: true, "talaris:columns": 2,
      regions: [
        { name: "do", label: "Urgent · important" }, { name: "plan", label: "Important, not urgent" },
        { name: "delegate", label: "Urgent, not important" }, { name: "drop", label: "Neither" },
      ],
    };
  }
}

function statusRegions(key: string): Region[] {
  const field = typeFor("task").fields.find((f) => f.key === key);
  const labels = (field?.["talaris:labels"] ?? {}) as Record<string, string>;
  const colors = (field?.["talaris:colors"] ?? {}) as Record<string, string>;
  return (field?.options ?? []).map((o) => ({ name: o, label: labels[o] ?? o, ...(colors[o] ? { "talaris:color": colors[o] } : {}) }));
}

export interface ListPatch {
  name?: string;
  kind?: List["kind"];
  query?: Condition | null;
  materialized?: boolean;
  order?: List["order"] | null;
  placement?: List["placement"];
  bind?: string;
  view?: Record<string, unknown>;
  archived?: boolean;
  position?: { after?: string | null; before?: string | null };
}

export function updateList(id: string, p: ListPatch): List {
  const l = getList(id);
  if (p.name !== undefined) {
    if (!p.name.trim()) throw new Conflict("a list has a name");
    l.name = p.name.trim();
  }
  if (p.kind) l.kind = p.kind;
  if (p.query !== undefined || p.materialized !== undefined) {
    const q = p.query === undefined ? (l.membership.mode === "query" ? l.membership.query : null) : p.query;
    const mat = p.materialized ?? (l.membership.mode === "query" ? l.membership.materialized : false);
    l.membership = q ? { mode: "query", materialized: mat, query: q } : { mode: "explicit" };
    if (q && mat) materialize(l);
  }
  if (p.order === null) delete l.order;
  else if (p.order) l.order = p.order;
  if (p.bind) l["talaris:bind"] = p.bind;
  if (p.placement) l.placement = p.placement;
  if (p.view) l["talaris:view"] = { ...(l["talaris:view"] ?? {}), ...p.view };
  if (p.archived !== undefined) l.archived = p.archived || undefined;
  if (p.position) {
    const at = (x?: string | null) => (x ? String(getList(x)["talaris:position"] ?? "") : null);
    l["talaris:position"] = between(at(p.position.after), at(p.position.before));
  }
  defaultsFor(l);
  return putList(l);
}

export function deleteList(id: string): void {
  const l = getList(id);
  if (!l.archived) throw new Conflict("a list is archived before it is deleted");
  sealedDrop(LISTS, id);
}

/** A snapshot list filled again from its query: what was arranged by hand is replaced. */
export function materialize(l: List): List {
  if (l.membership.mode !== "query") throw new Conflict("only a list made by a query is refreshed from it");
  let at: string | null = null;
  l.members = runQuery(l.membership.query).map((o) => ({ object: o.id, position: (at = between(at, null)) }));
  return l;
}

export function refresh(id: string): List {
  return putList(materialize(getList(id)));
}

// ------------------------------------------------------------ members by hand

export function addMember(id: string, object: string, where: { region?: string; after?: string | null; before?: string | null } = {}): List {
  const l = getList(id);
  getEntity(object);
  const others = l.members.filter((m) => m.object !== object);
  const posOf = (x?: string | null) => (x ? others.find((m) => m.object === x)?.position ?? null : null);
  const last = others.map((m) => m.position).sort().pop() ?? null;
  const position = where.after !== undefined || where.before !== undefined ? between(posOf(where.after), posOf(where.before)) : between(last, null);
  const before = l.members.find((m) => m.object === object);
  const member: Member = { ...(before ?? {}), object, position, ...(where.region !== undefined ? { region: where.region } : {}) };
  if (where.region === "") delete member.region;
  l.members = [...others, member];
  // A list bound to a field: being placed in a column is having that value.
  if (l["talaris:bind"] && where.region) updateEntity(object, { properties: { [l["talaris:bind"]]: where.region } });
  else if (l.kind === "matrix" && where.region !== undefined) enterRegion(l, object, before?.region, where.region);
  return putList(l);
}

export function removeMember(id: string, object: string): List {
  const l = getList(id);
  const was = l.members.find((m) => m.object === object);
  l.members = l.members.filter((m) => m.object !== object);
  if (l.kind === "matrix" && was?.region) enterRegion(l, object, was.region, "");
  return putList(l);
}

/** A matrix region's meaning, done: entering adds its tag or sets its status; leaving can take the tag back. */
function enterRegion(l: List, object: string, from: string | undefined, to: string): void {
  if (from === to) return;
  const region = (name?: string) => (l.placement?.regions ?? []).map((r) => (typeof r === "string" ? { name: r } : r)).find((r) => r.name === name) as Region | undefined;
  const o = getEntity(object);
  const tags = new Set(o.tags ?? []);
  const left = region(from)?.["talaris:enter"];
  if (left?.tag && left.untagOnLeave) tags.delete(left.tag);
  const entered = region(to)?.["talaris:enter"];
  if (entered?.tag) tags.add(entered.tag);
  const props: Record<string, unknown> = {};
  const shape = shapeOf(o);
  if (entered?.status && shape) props[shape.statusKey] = entered.status;
  updateEntity(object, { tags: [...tags], ...(Object.keys(props).length ? { properties: props } : {}) });
}

// ------------------------------------------------------------ a list, as the panel draws it

export interface Row {
  id: string;
  title: string;
  kinds: string[];
  type?: string;
  status?: string;
  complete?: boolean;
  start?: string;
  due?: string;
  doneAt?: string;
  overdue?: boolean;
  projects?: { id: string; title: string }[];
  tags?: string[];
  recurring?: boolean;
  body?: string;
  region?: string;
  position: string;
  fields: Record<string, unknown>;
}

function rowOf(o: Entity, position: string, region: string | undefined, today: string, now: string): Row {
  const shape = shapeOf(o);
  const span = shape ? spanOf(o, shape) : {};
  const complete = shape ? isComplete(o, shape) : undefined;
  const due = span.due;
  const overdue = Boolean(shape && !complete && due && (due.length > 10 ? due < now : due < today));
  const projects = (Array.isArray(o.properties.project) ? o.properties.project : o.properties.project ? [o.properties.project] : [])
    .filter((x): x is string => typeof x === "string")
    .map((id) => { try { return { id, title: titleOf(getEntity(id)) }; } catch { return null; } })
    .filter((x): x is { id: string; title: string } => Boolean(x));
  return {
    id: o.id, title: titleOf(o), kinds: profilesOf(o), type: o.type, position,
    ...(shape ? { status: String(o.properties[shape.statusKey] ?? ""), complete } : {}),
    ...(span.start ? { start: span.start } : {}), ...(due ? { due } : {}),
    ...(shape && o.properties[shape.doneKey] ? { doneAt: String(o.properties[shape.doneKey]) } : {}),
    ...(overdue ? { overdue } : {}),
    ...(projects.length ? { projects } : {}),
    ...(o.tags?.length ? { tags: o.tags } : {}),
    ...(o["talaris:series"] ? { recurring: true } : {}),
    ...(typeof o.properties.description === "string" && o.properties.description ? { body: o.properties.description as string } : {}),
    ...(region !== undefined ? { region } : {}),
    fields: o.properties,
  };
}

export interface Shown {
  list: List;
  rows: Row[];
  /** A matrix fed by a query: what matches and is not placed yet. */
  drawer?: Row[];
  groups?: { key: string | null; label: string; rows: string[] }[];
  /** A live query's order is the query's: not the user's to drag. */
  manual: boolean;
}

export function showList(id: string, asOf = new Date()): Shown {
  return show(getList(id), asOf);
}

/** A project's tasks, as a list that is not kept: everything that names the project. */
export function showProject(projectId: string, asOf = new Date()): Shown {
  const title = titleOf(getEntity(projectId));
  const virtual: List = {
    id: `project:${projectId}`, name: title, kind: "list", members: [],
    membership: { mode: "query", materialized: false, query: { kind: "group", match: "all", items: [{ kind: "property", key: "project", op: "contains", value: projectId }] } },
    order: { sort: [{ by: { field: "schedule", part: "end" } }, { by: { field: "title" } }] },
  };
  return show(virtual, asOf);
}

export function show(list: List, asOf = new Date()): Shown {
  // A board's columns are its field's options as they are now: statuses
  // added, renamed or recolored since it was made are its columns at once.
  const l: List = list["talaris:bind"] ? { ...list, placement: { semantic: true, regions: statusRegions(list["talaris:bind"]) } } : list;
  const today = resolveDate("today", asOf);
  const now = resolveDate("now", asOf);
  const live = l.membership.mode === "query" && !l.membership.materialized;
  let rows: { o: Entity; position: string; region?: string }[];
  let drawer: Entity[] | undefined;
  const objects = new Map(allRecords().map((r) => [r.object.id, r.object]));
  if (l.kind === "matrix") {
    // Placed by hand, always; a query decides which placed cards still show
    // and fills the drawer with the ones not placed.
    const placed = l.members.filter((m) => objects.get(m.object) && !objects.get(m.object)!.archived);
    const q = l.membership.mode === "query" ? l.membership.query : null;
    rows = placed.filter((m) => !q || matches(objects.get(m.object)!, q, asOf)).map((m) => ({ o: objects.get(m.object)!, position: m.position, region: m.region }));
    if (q) {
      const has = new Set(placed.map((m) => m.object));
      drawer = runQuery(q, { asOf }).filter((o) => !has.has(o.id));
    }
  } else if (live) {
    let at: string | null = null;
    rows = runQuery((l.membership as { query: Condition }).query, { asOf }).map((o) => ({ o, position: (at = between(at, null)) }));
  } else {
    rows = l.members.filter((m) => objects.get(m.object) && !objects.get(m.object)!.archived).map((m) => ({ o: objects.get(m.object)!, position: m.position, region: m.region }));
  }
  const sorted = sortEntities(rows, l.order) as typeof rows;
  const bind = l["talaris:bind"];
  const out = sorted.map((r) => rowOf(r.o, r.position, bind ? String(r.o.properties[bind] ?? "") : r.region, today, now));
  const shown: Shown = { list: l, rows: out, manual: !live && !l.order?.sort?.length };
  if (drawer) shown.drawer = sortEntities(drawer.map((o) => ({ o, position: "" })), l.order).map((r) => rowOf(r.o, "", undefined, today, now));
  if (l.order?.groupBy) shown.groups = group(sorted.map((r) => r.o), l.order.groupBy);
  return shown;
}

/** Groups by one key, in its field's option order where it has one, missing in a last group of its own. */
function group(objects: Entity[], by: SortKey): Shown["groups"] {
  const typeName = new Map(types().map((t) => [t.id, t.name]));
  const keyOf = (o: Entity): string | null => {
    if ("meta" in by) return by.meta === "type" ? o.type ?? null : (by.meta === "created" ? o.created : o.updated).slice(0, 10);
    const v = keyValue(o, by, typeName);
    if (isBlank(v)) return null;
    return Array.isArray(v) ? asText(v[0]) : asText(v).slice(0, by.part ? 10 : undefined);
  };
  const field: EntityType["fields"][number] | undefined = "field" in by ? typeFor("task").fields.find((f) => f.key === by.field) : undefined;
  const labels = (field?.["talaris:labels"] ?? {}) as Record<string, string>;
  const label = (k: string | null) => {
    if (k === null) return "None";
    if ("meta" in by && by.meta === "type") return typeName.get(k) ?? k;
    if ("field" in by && by.field === "project") { try { return titleOf(getEntity(k)); } catch { return k; } }
    return labels[k] ?? k;
  };
  const buckets = new Map<string | null, string[]>();
  for (const o of objects) {
    const k = keyOf(o);
    buckets.set(k, [...(buckets.get(k) ?? []), o.id]);
  }
  const options = field?.options ?? [];
  const keys = [...buckets.keys()].sort((a, b) => {
    if (a === null || b === null) return a === b ? 0 : a === null ? 1 : -1;
    const ia = options.indexOf(a), ib = options.indexOf(b);
    if (ia >= 0 || ib >= 0) return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib);
    return a < b ? -1 : a > b ? 1 : 0;
  });
  return keys.map((k) => ({ key: k, label: label(k), rows: buckets.get(k)! }));
}

// ------------------------------------------------------------ the lists a person starts with

const task: Condition = { kind: "profile", profile: "task" };
const open: Condition = { kind: "state", value: "open" };
const STARTERS: { key: string; name: string; query: Condition; order: List["order"]; view?: Record<string, unknown> }[] = [
  {
    key: "today", name: "Today",
    query: { kind: "group", match: "all", items: [task, open, { kind: "property", key: "schedule.end", op: "lt", value: "today+1" }] },
    order: { sort: [{ by: { field: "schedule", part: "end" } }, { by: { field: "title" } }] },
  },
  {
    key: "upcoming", name: "Upcoming",
    query: { kind: "group", match: "all", items: [task, open, { kind: "property", key: "schedule.end", op: "gt", value: "today" }, { kind: "property", key: "schedule.end", op: "lt", value: "today+8" }] },
    order: { sort: [{ by: { field: "schedule", part: "end" } }], groupBy: { field: "schedule", part: "end" } },
  },
  {
    key: "available", name: "Available",
    query: { kind: "group", match: "all", items: [task, open, { kind: "property", key: "schedule.start", op: "lt", value: "today+1" }] },
    order: { sort: [{ by: { field: "schedule", part: "end" } }, { by: { field: "title" } }] },
  },
  {
    key: "unscheduled", name: "Unscheduled",
    query: { kind: "group", match: "all", items: [task, open, { kind: "property", key: "schedule.start", op: "empty" }, { kind: "property", key: "schedule.end", op: "empty" }] },
    order: { sort: [{ by: { meta: "created" }, direction: "descending" }] },
  },
  {
    key: "done", name: "Done recently",
    query: { kind: "group", match: "all", items: [task, { kind: "state", value: "complete" }, { kind: "property", key: "done_at", op: "gt", value: "today-7" }] },
    order: { sort: [{ by: { field: "done_at" }, direction: "descending" }] },
  },
];

let started = false;
/** Made once, then the person's own: renamed, changed, deleted like any other. */
function ensureStarters(): void {
  if (started) return;
  started = true;
  const lists = sealedList<List>(LISTS);
  if (lists.some((l) => l["talaris:starter"]) || lists.length) return;
  let at: string | null = null;
  for (const s of STARTERS) {
    putList({
      id: newId("c"), name: s.name, kind: "list", members: [],
      membership: { mode: "query", materialized: false, query: s.query },
      order: s.order, "talaris:starter": s.key, "talaris:position": (at = between(at, null)),
      "talaris:view": { format: "checklist", ...(s.view ?? {}) },
    });
  }
}

/** Under test: let the starters be made again in a fresh store. */
export function resetStartersForTests(): void {
  started = false;
}

// ------------------------------------------------------------ finding tasks, for Morgan

export interface TaskQuery {
  /** A status, `open`, `complete`, or several separated by commas. */
  status?: string;
  /** overdue, today (and overdue), tomorrow, week, available, unscheduled — or a date: due by then. */
  when?: string;
  project?: string;
  tag?: string;
  text?: string;
  list?: string;
  limit?: number;
}

/** Tasks by the questions people ask of them; the conditions are the same a list would hold. */
export function findTasks(q: TaskQuery): Row[] {
  const items: Condition[] = [{ kind: "profile", profile: "task" }];
  const statuses = (q.status ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (statuses.length === 1 && (statuses[0] === "open" || statuses[0] === "complete")) items.push({ kind: "state", value: statuses[0] as "open" | "complete" });
  else if (statuses.length) items.push({ kind: "group", match: "any", items: statuses.map((s) => ({ kind: "property" as const, key: "status", op: "eq" as const, value: s })) });
  const end = (op: "lt" | "gt", value: string): Condition => ({ kind: "property", key: "schedule.end", op, value });
  const openOnly = () => { if (!statuses.length) items.push({ kind: "state", value: "open" }); };
  switch (q.when) {
    case undefined: case "": break;
    case "overdue": items.push(end("lt", "today")); openOnly(); break;
    case "today": items.push(end("lt", "today+1")); openOnly(); break;
    case "tomorrow": items.push(end("lt", "today+2")); openOnly(); break;
    case "week": items.push(end("lt", "today+7")); openOnly(); break;
    case "available": items.push({ kind: "property", key: "schedule.start", op: "lt", value: "today+1" }); openOnly(); break;
    case "unscheduled": items.push({ kind: "property", key: "schedule.start", op: "empty" }, { kind: "property", key: "schedule.end", op: "empty" }); openOnly(); break;
    default:
      if (!/^\d{4}-\d\d-\d\d$/.test(q.when)) throw new Conflict("when is overdue, today, tomorrow, week, available, unscheduled or a date");
      items.push(end("lt", resolveDate(`${q.when}`) + "~"));
      openOnly();
  }
  if (q.project) items.push({ kind: "property", key: "project", op: "contains", value: q.project });
  if (q.tag) items.push({ kind: "tag", tag: q.tag });
  if (q.text) items.push({ kind: "text", value: q.text });
  const query: Condition = { kind: "group", match: "all", items };
  const order: List["order"] = { sort: [{ by: { field: "schedule", part: "end" } }, { by: { field: "title" } }] };
  let rows: Row[];
  if (q.list) {
    const shown = showList(q.list);
    const keep = new Set(runQuery(query).map((o) => o.id));
    rows = shown.rows.filter((r) => keep.has(r.id));
  } else {
    rows = show({ id: "find", name: "find", kind: "list", members: [], membership: { mode: "query", materialized: false, query }, order }).rows;
  }
  return rows.slice(0, q.limit ?? 50);
}
