// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore

import { forgetFiles,
  allRecords,
  bySource,
  putType,
  createEntity,
  deleteEntity,
  findEntities,
  getEntity,
  onChange,
  sealedDrop,
  sealedList,
  sealedPut,
  typeFor,
  types,
  updateEntity,
  putFile,
  type Attachment,
  type Entity,
  type EntityType,
} from "./entities.js";
import { Conflict, NotFound, createProject, listProjects } from "./projects.js";
import { nextSpan, ruleErrors, summary, type Rule, type Span } from "./recurrence.js";
// Mentions in a task's words are kept as edges wherever tasks are used, not only through the server.
import "./mentions.js";
import { newId } from "./store.js";

/**
 * Tasks (DESIGN, *Tasks*): Hermes' task, read from its code, and its behaviour
 * on completion — with two of Hermes' bugs left out.
 *
 * **What a task is** is read from its type's task profile: the status field
 * and the values that count as complete, the datespan whose start is
 * "available" and end is "due". Never from a type's name.
 *
 * **Completing** stamps `done_at`; leaving complete clears it. A task in a
 * series brings its next occurrence — **once**: the completed task remembers
 * the one it brought (`talaris:next`), so un-completing and completing again
 * does not bring a second (Hermes did). And the new occurrence joins its
 * series at once (Hermes left it out, so "end after N" never ended).
 *
 * **Series** are the format's: `{id, rule, horizon, instances}`, kept sealed
 * beside the entities. The schedule anchor counts from the series' first due
 * date, kept on it as `talaris:origin`.
 */

export interface Series {
  id: string;
  rule: Rule;
  horizon: number;
  instances: string[];
  "talaris:origin"?: string;
  [extra: string]: unknown;
}

const SERIES = "series";

export function allSeries(): Series[] {
  return sealedList<Series>(SERIES);
}

function seriesOf(id: string): Series | null {
  return allSeries().find((s) => s.id === id) ?? null;
}

// ------------------------------------------------------------ reading a task through its profile

export interface TaskShape {
  type: EntityType;
  titleKey: string;
  statusKey: string;
  complete: string[];
  defaultStatus: string;
  spanKey: string | null;
  doneKey: string;
}

/** How a type is a task, if it is one: read from what it declares. */
export function taskShape(t: EntityType | undefined): TaskShape | null {
  const p = t?.profiles?.task;
  if (!t || !p || typeof p.status !== "string") return null;
  const start = p.start as { field?: string } | undefined;
  const due = p.due as { field?: string } | string | undefined;
  const span = typeof due === "object" && due?.field ? due.field : typeof start === "object" && start?.field ? start.field : null;
  const statusField = t.fields.find((f) => f.key === p.status);
  return {
    type: t,
    titleKey: typeof p.title === "string" ? p.title : "title",
    statusKey: p.status,
    complete: Array.isArray(p.completeValues) ? (p.completeValues as string[]) : [],
    defaultStatus: String(t["talaris:defaultStatus"] ?? statusField?.options?.[0] ?? ""),
    spanKey: span,
    doneKey: t.fields.some((f) => f.key === "done_at") ? "done_at" : "talaris:done_at",
  };
}

export function shapeOf(o: Entity): TaskShape | null {
  return taskShape(types().find((t) => t.id === o.type));
}

export function isComplete(o: Entity, shape = shapeOf(o)): boolean {
  return Boolean(shape && shape.complete.includes(String(o.properties[shape.statusKey] ?? "")));
}

/**
 * A task ticked done, or opened again, as its type says: done is the first of
 * its complete values; open again, its default status (or the first that is
 * not complete). What completing does besides (a stamp, the next of a
 * series) follows as it does for any change of status.
 */
export function setDone(id: string, done: boolean): Entity {
  const o = getEntity(id);
  const shape = shapeOf(o);
  if (!shape) throw new Conflict("not a task");
  const options = shape.type.fields.find((f) => f.key === shape.statusKey)?.options ?? [];
  const value = done ? shape.complete.find((v) => options.length === 0 || options.includes(v)) ?? shape.complete[0]
    : shape.complete.includes(shape.defaultStatus) ? options.find((v) => !shape.complete.includes(v)) : shape.defaultStatus;
  if (!value) throw new Conflict(done ? "its type says no status is done" : "its type has no open status");
  return updateEntity(id, { properties: { [shape.statusKey]: value } });
}

/** A task's dates moved by whole days, available and due together, each keeping its time of day. */
export function shiftTask(id: string, days: number): Entity {
  const o = getEntity(id);
  const shape = shapeOf(o);
  if (!shape?.spanKey) throw new Conflict("not a task with dates");
  if (!Number.isInteger(days) || Math.abs(days) > 3660) throw new Conflict("a whole number of days");
  const move = (v?: string) => {
    if (!v || !/^\d{4}-\d\d-\d\d/.test(v)) return v;
    const d = new Date(`${v.slice(0, 10)}T12:00:00`);
    d.setDate(d.getDate() + days);
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}${v.slice(10)}`;
  };
  const was = (o.properties[shape.spanKey] ?? {}) as { start?: string; end?: string };
  return updateEntity(id, { properties: { [shape.spanKey]: { ...was, ...(was.start ? { start: move(was.start) } : {}), ...(was.end ? { end: move(was.end) } : {}) } } });
}

export function spanOf(o: Entity, shape = shapeOf(o)): Span {
  const v = shape?.spanKey ? (o.properties[shape.spanKey] as { start?: string; end?: string } | undefined) : undefined;
  return { start: v?.start || undefined, due: v?.end || undefined };
}

const nowLocal = () => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};

// ------------------------------------------------------------ what completing does

let busy = false;

onChange((before, after) => {
  const shape = shapeOf(after);
  if (!shape || busy) return;
  busy = true;
  try {
    // A new task takes its type's default status.
    if (!before && !after.properties[shape.statusKey] && shape.defaultStatus) {
      updateEntity(after.id, { properties: { [shape.statusKey]: shape.defaultStatus } });
      return;
    }
    const was = before ? isComplete(before, shape) : false;
    const now = isComplete(after, shape);
    if (was === now) return;
    if (!now) {
      // Open again: the stamp goes. What it brought, if anything, stays brought.
      updateEntity(after.id, { properties: { [shape.doneKey]: null } });
      return;
    }
    const stamp = nowLocal();
    updateEntity(after.id, { properties: { [shape.doneKey]: stamp } });
    spawnNext(getEntity(after.id), shape, stamp.slice(0, 10));
  } finally {
    busy = false;
  }
});

/** The next occurrence of a completed task in a series, once. */
function spawnNext(o: Entity, shape: TaskShape, completed: string): Entity | null {
  if (o["talaris:next"]) return null; // brought already, the first time it was completed
  const seriesId = o["talaris:series"];
  if (typeof seriesId !== "string" || !shape.spanKey) return null;
  const series = seriesOf(seriesId);
  if (!series) return null;
  const span = nextSpan(series.rule, spanOf(o, shape), completed, series["talaris:origin"], series.instances.length);
  if (!span) return null;
  const properties: Record<string, unknown> = { ...o.properties };
  delete properties[shape.doneKey];
  properties[shape.statusKey] = shape.defaultStatus;
  properties[shape.spanKey] = { ...(span.start ? { start: span.start } : {}), ...(span.due ? { end: span.due } : {}) };
  const next = createEntity({
    type: o.type,
    properties,
    ...(o.tags?.length ? { tags: [...o.tags] } : {}),
    "talaris:series": series.id,
  });
  sealedPut(SERIES, series.id, { ...series, instances: [...series.instances, next.id] });
  updateEntity(o.id, { "talaris:next": next.id });
  return getEntity(next.id);
}

// ------------------------------------------------------------ making and changing tasks

export interface NewTask {
  title: string;
  description?: string;
  start?: string;
  due?: string;
  status?: string;
  projects?: string[];
  tags?: string[];
  [extra: string]: unknown;
}

export function createTask(t: NewTask): Entity {
  const type = typeFor("task");
  const shape = taskShape(type)!;
  const properties: Record<string, unknown> = { [shape.titleKey]: t.title.trim() || "Untitled" };
  if (t.description) properties.description = t.description;
  if (shape.spanKey && (t.start || t.due)) properties[shape.spanKey] = { ...(t.start ? { start: t.start } : {}), ...(t.due ? { end: t.due } : {}) };
  if (t.status) properties[shape.statusKey] = t.status;
  if (t.projects?.length) properties.project = t.projects;
  return createEntity({ type: type.id, properties, ...(t.tags?.length ? { tags: t.tags } : {}) });
}

/**
 * A task's recurrence: a rule makes it the first instance of a series (or
 * changes the series it is in); null takes it out of its series, which stays,
 * with its history, for the instances already made.
 */
export function setRecurrence(taskId: string, rule: Rule | null): { series: Series | null; summary: string } {
  const o = getEntity(taskId);
  const shape = shapeOf(o);
  if (!shape) throw new Conflict("only a task recurs");
  const current = typeof o["talaris:series"] === "string" ? seriesOf(o["talaris:series"] as string) : null;
  if (!rule) {
    if (current) updateEntity(taskId, { "talaris:series": undefined });
    return { series: null, summary: "" };
  }
  const span = spanOf(o, shape);
  const origin = span.due ?? span.start;
  // Monthly and yearly rules say their day; taken from the task's date when not given.
  const filled: Rule = { end: { type: "never" }, ...rule };
  if ((filled.freq === "monthly" || filled.freq === "yearly") && origin) {
    filled.byMonthDay ??= Number(origin.slice(8, 10));
    if (filled.anchor === "schedule") filled.monthEnd ??= "clamp";
  }
  const errors = ruleErrors(filled, 1);
  if (errors.length) throw new Conflict(errors.map((e) => e.message).join("; "));
  if (!origin) throw new Conflict("a recurring task needs a date to recur from");
  const series: Series = current
    ? { ...current, rule: filled }
    : { id: newId("s"), rule: filled, horizon: 1, instances: [taskId], "talaris:origin": origin.slice(0, 10) };
  sealedPut(SERIES, series.id, series);
  if (!current) updateEntity(taskId, { "talaris:series": series.id });
  return { series, summary: summary(filled) };
}

export function recurrenceOf(taskId: string): { rule: Rule | null; summary: string } {
  const o = getEntity(taskId);
  const s = typeof o["talaris:series"] === "string" ? seriesOf(o["talaris:series"] as string) : null;
  return s ? { rule: s.rule, summary: summary(s.rule) } : { rule: null, summary: "" };
}

/** A series nobody points at any more, tidied away (its instances keep their history). */
export function dropSeries(id: string): void {
  if (!seriesOf(id)) throw new NotFound(`no series ${id}`);
  sealedDrop(SERIES, id);
}

// ------------------------------------------------------------ projects

/**
 * The projects tasks are filed under: project entities — and every Talaris
 * project (a folder, a workspace) is one, made the first time it is asked for,
 * known by its source so a rename in either place is the same project.
 */
export function taskProjects(): { id: string; title: string; archived?: boolean; workspace?: string; group?: string; description?: string; position?: number }[] {
  const type = typeFor("project");
  for (const p of listProjects()) {
    // Home is the scratchpad, not a project: nothing is filed under it. One
    // mirrored before that was decided goes, and what was filed there is
    // simply filed nowhere.
    if (p.home) {
      unfileHome(p.id);
      continue;
    }
    const source = { kind: "talaris-project", key: p.id };
    const known = bySource(source);
    if (!known) createEntity({ type: type.id, properties: { title: p.name }, sources: [source] });
    else if (known.properties.title !== p.name) updateEntity(known.id, { properties: { title: p.name } });
  }
  return findEntities({ kind: "project", limit: 1000, archived: true }).map((s) => {
    const e = getEntity(s.id);
    const ws = ((e["talaris:sources"] as { kind: string; key: string }[] | undefined) ?? []).find((x) => x.kind === "talaris-project");
    // Its group is Tasks' own way of arranging the list (`talaris:group`): no folder, no meaning anywhere else.
    const group = typeof e["talaris:group"] === "string" && e["talaris:group"] ? (e["talaris:group"] as string) : undefined;
    const description = typeof e.properties.description === "string" && e.properties.description ? e.properties.description : undefined;
    // Its place in Tasks' column, dragged there (`talaris:position`); none yet, after those that have one, by name.
    const position = typeof e["talaris:position"] === "number" ? (e["talaris:position"] as number) : undefined;
    return { id: s.id, title: s.title, ...(e.archived ? { archived: true } : {}), ...(ws ? { workspace: ws.key } : {}), ...(group ? { group } : {}), ...(description ? { description } : {}),
      ...(position !== undefined ? { position } : {}) };
  }).sort((a, b) => (a.position ?? Infinity) - (b.position ?? Infinity) || a.title.localeCompare(b.title, undefined, { sensitivity: "base" }));
}

/**
 * Tasks' column in the order it was dragged into: the projects, each with its
 * place (and, dropped beside one in another group, that group), and the
 * groups themselves. Only what changed is written.
 */
export function orderProjects(order: { id: string; group?: string | null }[]): void {
  order.forEach(({ id, group }, i) => {
    const e = getEntity(id);
    const patch: Record<string, unknown> = {};
    if (e["talaris:position"] !== i) patch["talaris:position"] = i;
    if (group !== undefined && (e["talaris:group"] ?? null) !== (group || null)) patch["talaris:group"] = group || null;
    if (Object.keys(patch).length) updateEntity(id, patch);
  });
}
const PREFS = "tasks-prefs";
export function groupOrder(): string[] {
  const kept = sealedList<{ id?: string; order?: string[] }>(PREFS).find((x) => x.id === "groups");
  return kept?.order ?? [];
}
export function setGroupOrder(names: string[]): string[] {
  const order = [...new Set(names.filter((n) => typeof n === "string" && n.trim()))];
  sealedPut(PREFS, "groups", { id: "groups", order });
  return order;
}

/*
 * The column as Tasks shows it — and the bar's project menu with it: groups
 * and projects in no group, side by side in one order, each group holding
 * its projects in theirs. The order of the top is kept beside the groups'
 * (`groups`, a group by its name, a project as `project:<id>`); a group or
 * a project never placed comes after those that were, groups first, groups
 * by name and projects in their own order.
 */
type ProjectRow = ReturnType<typeof taskProjects>[number];
export type ColumnEntry = { kind: "group"; name: string; projects: ProjectRow[] } | { kind: "project"; project: ProjectRow };
const topKey = (x: ColumnEntry) => (x.kind === "group" ? x.name : `project:${x.project.id}`);

export function projectColumn(): ColumnEntry[] {
  const live = taskProjects().filter((p) => !p.archived);
  const groups = [...new Set(live.filter((p) => p.group).map((p) => p.group!))];
  const entries: ColumnEntry[] = [
    ...groups.map((name) => ({ kind: "group" as const, name, projects: live.filter((p) => p.group === name) })),
    ...live.filter((p) => !p.group).map((project) => ({ kind: "project" as const, project })),
  ];
  const order = groupOrder();
  const rank = (x: ColumnEntry) => { const i = order.indexOf(topKey(x)); return i < 0 ? Infinity : i; };
  return entries.map((x, i) => ({ x, i })).sort((a, b) =>
    rank(a.x) - rank(b.x)
    || (a.x.kind === b.x.kind ? (a.x.kind === "group" && b.x.kind === "group" ? a.x.name.localeCompare(b.x.name, undefined, { sensitivity: "base" }) : a.i - b.i) : a.x.kind === "group" ? -1 : 1),
  ).map(({ x }) => x);
}

/** The column, arranged: each project's place and group, and the top's order, from one list. */
export function arrangeColumn(entries: ({ kind: "group"; name: string; projects: string[] } | { kind: "project"; id: string })[]): ColumnEntry[] {
  const flat: { id: string; group: string | null }[] = [];
  const top: string[] = [];
  for (const x of entries) {
    if (x.kind === "group" && typeof x.name === "string" && x.name.trim()) {
      top.push(x.name);
      for (const id of x.projects ?? []) flat.push({ id, group: x.name });
    } else if (x.kind === "project" && typeof x.id === "string") {
      top.push(`project:${x.id}`);
      flat.push({ id: x.id, group: null });
    }
  }
  orderProjects(flat);
  setGroupOrder(top);
  return projectColumn();
}

/**
 * A new project, made from Tasks (or by Morgan): a Talaris project — its
 * folder under the projects root, its canvas and its writing, its place in
 * the bar's list — and the same project for tasks to be filed under. One
 * thing, not a task project beside a workspace of the same name.
 */
function unfileHome(homeId: string): void {
  const home = bySource({ kind: "talaris-project", key: homeId });
  if (!home) return;
  for (const r of allRecords()) {
    const v = r.object.properties.project;
    if (Array.isArray(v) && v.includes(home.id)) {
      const rest = v.filter((x) => x !== home.id);
      updateEntity(r.object.id, { properties: { project: rest.length ? rest : null } });
    }
  }
  deleteEntity(home.id);
}

export function createTaskProject(title: string): Entity {
  const name = title.trim();
  if (!name) throw new Conflict("a project has a name");
  const made = createProject(name);
  taskProjects();
  const e = bySource({ kind: "talaris-project", key: made.id });
  if (!e) throw new Conflict("the project was made but is not listed for tasks");
  return e;
}

// ------------------------------------------------------------ the statuses, the person's to define

export interface StatusDef {
  /** The name tasks hold; made once from the label, never changed after. */
  value?: string;
  label: string;
  color?: string;
  /** Counts as complete: done, and won't do, as Hermes has them. */
  complete?: boolean;
  /**
   * What it means to other apps (pkm-interchange: the task profile's `states`):
   * one of the five shared states — a finished status done or cancelled, an
   * open one not started, in progress or waiting. Unsaid, a sync holds it.
   */
  state?: string;
}
const OPEN_STATES = ["not-started", "in-progress", "waiting"], DONE_STATES = ["done", "cancelled"];

/**
 * The task type's statuses, as a person sets them: their order, words,
 * colors, which count as complete, and which a new task starts with. A
 * status keeps its name when its label changes — tasks, board columns and a
 * sync all point at the name. One taken away moves its tasks to another
 * (`moveTo`, by value), so nothing is left holding a status that is gone.
 */
export function setStatuses(defs: StatusDef[], defaultValue: string, moveTo: Record<string, string> = {}): EntityType {
  const type = typeFor("task");
  const shape = taskShape(type);
  if (!shape) throw new Conflict("the task type has no status");
  const field = type.fields.find((f) => f.key === shape.statusKey)!;
  if (!defs.length) throw new Conflict("a task has at least one status");
  const taken = new Set<string>();
  const slug = (label: string) => {
    const base = label.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "status";
    let v = base;
    for (let n = 2; taken.has(v); n++) v = `${base}_${n}`;
    return v;
  };
  for (const d of defs) if (d.value) taken.add(d.value);
  const statuses = defs.map((d) => {
    const label = d.label.trim();
    if (!label) throw new Conflict("a status has words");
    const value = d.value || slug(label);
    taken.add(value);
    if (d.color && !/^#[0-9a-fA-F]{6}$/.test(d.color)) throw new Conflict(`${label}: a color like #8aa878`);
    const state = d.state ? String(d.state) : undefined;
    if (state && !(d.complete ? DONE_STATES : OPEN_STATES).includes(state)) {
      throw new Conflict(`${label}: ${d.complete ? "a finished status means done or cancelled" : "an open status means not started, in progress or waiting"}`);
    }
    return { value, label, color: d.color, complete: Boolean(d.complete), ...(state ? { state } : {}) };
  });
  if (new Set(statuses.map((s) => s.value)).size !== statuses.length) throw new Conflict("two statuses with one name");
  if (!statuses.some((s) => s.complete)) throw new Conflict("at least one status counts as done");
  if (!statuses.some((s) => !s.complete)) throw new Conflict("at least one status is not done");
  const values = new Set(statuses.map((s) => s.value));
  if (!values.has(defaultValue) || statuses.find((s) => s.value === defaultValue)!.complete) {
    throw new Conflict("a new task starts in a status that is not done");
  }
  // Whatever held a status now gone goes where it was told to; else a
  // finished status's tasks to a finished status (not reopened), an open
  // one's to the start.
  const wasComplete = new Set(shape.complete);
  const firstComplete = statuses.find((x) => x.complete)!.value;
  const fallback = (g: string) => moveTo[g] ?? (wasComplete.has(g) ? firstComplete : defaultValue);
  const gone = (field.options ?? []).filter((v) => !values.has(v));
  for (const g of gone) {
    const to = fallback(g);
    if (!values.has(to)) throw new Conflict(`tasks in ${g} need a status that is still there`);
  }
  const next: EntityType = {
    ...type,
    "talaris:defaultStatus": defaultValue,
    fields: type.fields.map((f) => f.key !== field.key ? f : {
      ...f,
      options: statuses.map((s) => s.value),
      "talaris:labels": Object.fromEntries(statuses.map((s) => [s.value, s.label])),
      "talaris:colors": Object.fromEntries(statuses.filter((s) => s.color).map((s) => [s.value, s.color!])),
      // Set by a person: a newer built-in task type keeps these as they are.
      "talaris:edited": true,
    }),
    // Finished, and what each means, rebuilt from the statuses as they are: nothing of one taken away is left behind.
    profiles: { ...type.profiles, task: (() => {
      const { states: _was, ...task } = type.profiles!.task as Record<string, unknown>;
      const states = Object.fromEntries(statuses.filter((s) => s.state).map((s) => [s.value, s.state!]));
      return { ...task, completeValues: statuses.filter((s) => s.complete).map((s) => s.value), ...(Object.keys(states).length ? { states } : {}) };
    })() },
  };
  putType(next);
  if (gone.length) {
    for (const r of allRecords()) {
      const o = r.object;
      if (o.type !== type.id) continue;
      const v = String(o.properties[field.key] ?? "");
      if (gone.includes(v)) updateEntity(o.id, { properties: { [field.key]: fallback(v) } });
    }
  }
  return next;
}

// ------------------------------------------------------------ files kept with a task

/** The task type's attachment field, found by its kind. */
function filesKey(o: Entity): string {
  const t = types().find((x) => x.id === o.type);
  const f = t?.fields.find((x) => x.kind === "attachment" && x.many);
  if (!f) throw new Conflict("this kind of thing keeps no files");
  return f.key;
}

/** A file kept with a task: stored once by its hash, named on the task. Kept twice, it is there once. */
export function attachFile(taskId: string, bytes: Buffer, filename: string, mediaType?: string): Attachment {
  const o = getEntity(taskId);
  const key = filesKey(o);
  const value = putFile(bytes, filename, mediaType);
  const now = Array.isArray(o.properties[key]) ? (o.properties[key] as Attachment[]) : [];
  if (!now.some((a) => a.sha256 === value.sha256)) updateEntity(taskId, { properties: { [key]: [...now, value] } });
  return value;
}

/** Taken off the task. The bytes stay in the store, as another task may keep the same file. */
export function detachFile(taskId: string, sha256: string): void {
  const o = getEntity(taskId);
  const key = filesKey(o);
  const now = Array.isArray(o.properties[key]) ? (o.properties[key] as Attachment[]) : [];
  const rest = now.filter((a) => a.sha256 !== sha256);
  if (rest.length !== now.length) {
    updateEntity(taskId, { properties: { [key]: rest.length ? rest : null } });
    // Taken off, and named by nothing else: the file goes too.
    forgetFiles([sha256]);
  }
}
