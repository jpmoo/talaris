// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore

import {
  bySource,
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
import { Conflict, NotFound, listProjects } from "./projects.js";
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

export function createTaskProject(title: string): Entity {
  const name = title.trim();
  if (!name) throw new Conflict("a project has a name");
  return createEntity({ type: typeFor("project").id, properties: { title: name } });
}
