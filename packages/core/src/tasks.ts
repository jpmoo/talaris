// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore

import {
  allRecords,
  bySource,
  putType,
  createEntity,
  findEntities,
  getEntity,
  onChange,
  sealedDrop,
  sealedList,
  sealedPut,
  typeFor,
  types,
  updateEntity,
  type Entity,
  type EntityType,
} from "./entities.js";
import { Conflict, NotFound, createProject, listProjects } from "./projects.js";
import { nextSpan, ruleErrors, summary, type Rule, type Span } from "./recurrence.js";
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
export function taskProjects(): { id: string; title: string; archived?: boolean; workspace?: string }[] {
  const type = typeFor("project");
  for (const p of listProjects()) {
    const source = { kind: "talaris-project", key: p.id };
    const known = bySource(source);
    if (!known) createEntity({ type: type.id, properties: { title: p.name }, sources: [source] });
    else if (known.properties.title !== p.name) updateEntity(known.id, { properties: { title: p.name } });
  }
  return findEntities({ kind: "project", limit: 1000, archived: true }).map((s) => {
    const e = getEntity(s.id);
    const ws = ((e["talaris:sources"] as { kind: string; key: string }[] | undefined) ?? []).find((x) => x.kind === "talaris-project");
    return { id: s.id, title: s.title, ...(e.archived ? { archived: true } : {}), ...(ws ? { workspace: ws.key } : {}) };
  });
}

/**
 * A new project, made from Tasks (or by Morgan): a Talaris project — its
 * folder under the projects root, its canvas and its writing, its place in
 * the bar's list — and the same project for tasks to be filed under. One
 * thing, not a task project beside a workspace of the same name.
 */
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
}

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
    return { value, label, color: d.color, complete: Boolean(d.complete) };
  });
  if (new Set(statuses.map((s) => s.value)).size !== statuses.length) throw new Conflict("two statuses with one name");
  if (!statuses.some((s) => s.complete)) throw new Conflict("at least one status counts as done");
  if (!statuses.some((s) => !s.complete)) throw new Conflict("at least one status is not done");
  const values = new Set(statuses.map((s) => s.value));
  if (!values.has(defaultValue) || statuses.find((s) => s.value === defaultValue)!.complete) {
    throw new Conflict("a new task starts in a status that is not done");
  }
  // Whatever held a status now gone goes where it was told to, or to the start.
  const gone = (field.options ?? []).filter((v) => !values.has(v));
  for (const g of gone) {
    const to = moveTo[g] ?? defaultValue;
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
    profiles: { ...type.profiles, task: { ...type.profiles!.task, completeValues: statuses.filter((s) => s.complete).map((s) => s.value) } },
  };
  putType(next);
  if (gone.length) {
    for (const r of allRecords()) {
      const o = r.object;
      if (o.type !== type.id) continue;
      const v = String(o.properties[field.key] ?? "");
      if (gone.includes(v)) updateEntity(o.id, { properties: { [field.key]: moveTo[v] ?? defaultValue } });
    }
  }
  return next;
}
