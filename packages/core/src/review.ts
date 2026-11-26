// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore

/**
 * The weekly review (DESIGN, *The weekly review*; brought from Hermes Notes, its reflection note left behind): an
 * ordered set of steps marched through once a week, brought by a recurring "Do weekly review" task.
 *
 * - **The steps.** A template that comes every week, in an order of your own; steps for this week only; each ticked
 *   when done, the ticks cleared when the next review opens. A step may point at a thing (its card) or a collection,
 *   or at nothing — something done outside Talaris and only ticked here.
 * - **The task that brings it.** A repeating task Talaris keeps: due on the weekday chosen, available some days
 *   before, filed in the projects chosen. Its next occurrence opening is what starts a new review. Found by its series
 *   (`series`, kept here), never by its title or its type's name.
 * - **Yours, so it syncs**: one record of the small sealed stores (`sealed:review/weekly`), field by field.
 *
 * A machine's desktop says when it opens (surfaces, review_panel.py): a notification, and the panel.
 */

import { randomBytes } from "node:crypto";
import { sealedList, sealedPut, getEntity, updateEntity } from "./entities.js";
import { createTask, isComplete, recurrenceOf, seriesOf, setRecurrence, shapeOf, spanOf, updateTask } from "./tasks.js";
import { getList } from "./lists.js";
import { Conflict as BadRequest, NotFound } from "./projects.js";
import { WEEKDAYS } from "./recurrence.js";

const STORE = "review";
const ID = "weekly";
const TITLE = "Do weekly review";
const MOST = 100;

export interface Link { kind: "thing" | "list"; id: string }
export interface Step { id: string; description: string; link: Link | null }
export interface Review {
  /** 0 = Sunday … 6 = Saturday: the task's due weekday. Null: no review. */
  dueWeekday: number | null;
  /** Days before the due date it becomes available (0: no available date). */
  availableDaysPrior: number;
  /** The projects the task is filed in. */
  project: string[];
  /** The template: steps every week. */
  steps: Step[];
  /** This review: its key (the day it opened), steps for this week only, those ticked, and the order of them all. */
  cycle: { key: string; extras: Step[]; done: string[]; order: string[] };
  /** The task's series. */
  series: string | null;
}

const EMPTY: Review = { dueWeekday: null, availableDaysPrior: 0, project: [], steps: [], cycle: { key: "", extras: [], done: [], order: [] }, series: null };

function load(): Review {
  const kept = sealedList<Record<string, unknown>>(STORE).find((x) => x && x.id === ID) as Partial<Review> | undefined;
  return { ...EMPTY, ...(kept ?? {}), cycle: { ...EMPTY.cycle, ...((kept?.cycle as Review["cycle"]) ?? {}) } };
}
function save(r: Review): void {
  sealedPut(STORE, ID, { id: ID, ...r });
}

const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const nextOn = (from: Date, weekday: number) => addDays(new Date(from.getFullYear(), from.getMonth(), from.getDate()), (weekday - from.getDay() + 7) % 7);
const newId = () => `rs_${randomBytes(6).toString("hex")}`;

/** The coming review's dates: due on the weekday, available so many days before. */
function span(r: Review, now = new Date()): { start?: string; due: string } {
  const due = nextOn(now, r.dueWeekday!);
  return { ...(r.availableDaysPrior > 0 ? { start: ymd(addDays(due, -r.availableDaysPrior)) } : {}), due: ymd(due) };
}

/** The live review task: its series' latest occurrence not done, if any. */
function activeTask(r: Review) {
  if (!r.series) return null;
  const s = seriesOf(r.series);
  for (const id of [...(s?.instances ?? [])].reverse()) {
    try {
      const o = getEntity(id);
      if (shapeOf(o) && !isComplete(o)) return o;
    } catch { /* gone */ }
  }
  return null;
}

/** The task made, or set again to the schedule and projects (its progress kept); made to repeat weekly on the day. */
function provision(r: Review): Review {
  if (r.dueWeekday === null) return r;
  const when = span(r);
  const rule = { anchor: "schedule" as const, freq: "weekly" as const, interval: 1, byWeekday: [WEEKDAYS[r.dueWeekday]!], end: { type: "never" as const } };
  let task = activeTask(r);
  if (task) {
    updateTask(task.id, { start: when.start ?? "", due: when.due });
    const projects = new Set((task.properties?.project as string[] | undefined) ?? []);
    const want = new Set(r.project);
    updateTask(task.id, { addProjects: [...want].filter((p) => !projects.has(p)), removeProjects: [...projects].filter((p) => !want.has(p)) });
    } else {
    task = createTask({ title: TITLE, ...when, ...(r.project.length ? { projects: r.project } : {}) });
  }
  updateEntity(task.id, { "talaris:weeklyReview": true });
  const { series } = setRecurrence(task.id, rule);
  return { ...r, series: series?.id ?? r.series };
}

/** Adopt a task already there (one brought from Hermes Notes) as the review's, rather than making another. */
export function adopt(taskId: string, cfg: { dueWeekday?: number; availableDaysPrior?: number; project?: string[] } = {}): Review {
  const o = getEntity(taskId);
  if (!shapeOf(o)) throw new BadRequest("not a task");
  const kept = load();
  const r: Review = {
    ...kept,
    ...(typeof cfg.dueWeekday === "number" ? { dueWeekday: Math.max(0, Math.min(6, Math.trunc(cfg.dueWeekday))) } : {}),
    ...(typeof cfg.availableDaysPrior === "number" ? { availableDaysPrior: Math.max(0, Math.min(6, Math.trunc(cfg.availableDaysPrior))) } : {}),
    ...(Array.isArray(cfg.project) ? { project: cfg.project.map(String) } : {}),
  };
  const rec = recurrenceOf(taskId);
  let next: Review = { ...r, series: typeof o["talaris:series"] === "string" ? (o["talaris:series"] as string) : null };
  if (!rec.rule && next.dueWeekday !== null) {
    updateEntity(taskId, { "talaris:weeklyReview": true });
    const rule = { anchor: "schedule" as const, freq: "weekly" as const, interval: 1, byWeekday: [WEEKDAYS[next.dueWeekday]!], end: { type: "never" as const } };
    next = { ...next, series: setRecurrence(taskId, rule).series?.id ?? null };
  } else if (!next.series) {
    throw new BadRequest("set the weekday first");
  }
  save(next);
  return next;
}

function compose(r: Review): Step[] {
  const byId = new Map<string, Step>([...r.steps, ...r.cycle.extras].map((s) => [s.id, s]));
  const ids: string[] = [];
  for (const id of r.cycle.order) if (byId.has(id) && !ids.includes(id)) ids.push(id);
  for (const s of [...r.steps, ...r.cycle.extras]) if (!ids.includes(s.id)) ids.push(s.id);
  return ids.map((id) => byId.get(id)!);
}

function labelOf(link: Link | null): string | null {
  if (!link) return null;
  try {
    if (link.kind === "list") return getList(link.id).name;
    const o = getEntity(link.id);
    return String(o.properties?.title ?? o.properties?.name ?? "Untitled");
  } catch { return "Gone"; }
}

/**
 * The review as it stands: its schedule, the task's dates, whether it is open, the steps with this week's ticks. A
 * review newly open clears the last one's ticks and this-week steps (kept, since that is a change that must travel).
 */
export function state(now = new Date()) {
  let r = load();
  if (r.dueWeekday === null) return { configured: false as const, dueWeekday: null, availableDaysPrior: r.availableDaysPrior, project: r.project, steps: r.steps.map((s) => ({ ...s, label: labelOf(s.link), template: true, done: false })) };
  const task = activeTask(r);
  const when = task ? spanOf(task) : {};
  const available = when.start?.slice(0, 10) ?? null, due = when.due?.slice(0, 10) ?? null;
  const key = available ?? due ?? "";
  const open = key ? ymd(now) >= key : true;
  if (open && key && r.cycle.key !== key) {
    r = { ...r, cycle: { key, extras: [], done: [], order: [] } };
    save(r);
  }
  const done = new Set(r.cycle.done);
  const steps = compose(r).map((s) => ({ ...s, label: labelOf(s.link), template: r.steps.some((t) => t.id === s.id), done: done.has(s.id) }));
  return {
    configured: true as const, dueWeekday: r.dueWeekday, availableDaysPrior: r.availableDaysPrior, project: r.project,
    task: task ? { id: task.id, available, due, done: false } : null,
    open, key, steps, allDone: steps.length > 0 && steps.every((s) => s.done),
  };
}

export function configure(b: { dueWeekday?: number | null; availableDaysPrior?: number; project?: string[] }) {
  const r = load();
  const next: Review = {
    ...r,
    dueWeekday: b.dueWeekday === undefined ? r.dueWeekday : b.dueWeekday === null ? null : Math.max(0, Math.min(6, Math.trunc(b.dueWeekday))),
    availableDaysPrior: b.availableDaysPrior === undefined ? r.availableDaysPrior : Math.max(0, Math.min(6, Math.trunc(b.availableDaysPrior))),
    project: Array.isArray(b.project) ? b.project.slice(0, 20).map(String) : r.project,
  };
  save(provision(next));
  return state();
}

const linkOf = (l: unknown): Link | null => {
  const x = l as Partial<Link> | null;
  return x && (x.kind === "thing" || x.kind === "list") && typeof x.id === "string" && x.id ? { kind: x.kind, id: x.id } : null;
};

/** A step added: to the template (every week), or to this week only. */
export function addStep(b: { description?: string; link?: unknown; scope?: "template" | "cycle" }) {
  const r = load();
  const step: Step = { id: newId(), description: String(b.description ?? "").slice(0, 4000), link: linkOf(b.link) };
  if (!step.description && !step.link) throw new BadRequest("a step says something or points at something");
  if (b.scope === "cycle") {
    if (r.cycle.extras.length >= MOST) throw new BadRequest("that is enough steps");
    save({ ...r, cycle: { ...r.cycle, extras: [...r.cycle.extras, step], order: [...compose(r).map((s) => s.id), step.id] } });
  } else {
    if (r.steps.length >= MOST) throw new BadRequest("that is enough steps");
    save({ ...r, steps: [...r.steps, step] });
  }
  return state();
}

export function changeStep(id: string, b: { description?: string; link?: unknown }) {
  const r = load();
  const edit = (s: Step): Step => s.id !== id ? s : {
    ...s, ...(b.description !== undefined ? { description: String(b.description).slice(0, 4000) } : {}), ...(b.link !== undefined ? { link: linkOf(b.link) } : {}),
  };
  if (![...r.steps, ...r.cycle.extras].some((s) => s.id === id)) throw new NotFound(`no step ${id}`);
  save({ ...r, steps: r.steps.map(edit), cycle: { ...r.cycle, extras: r.cycle.extras.map(edit) } });
  return state();
}

export function removeStep(id: string) {
  const r = load();
  save({ ...r, steps: r.steps.filter((s) => s.id !== id),
    cycle: { ...r.cycle, extras: r.cycle.extras.filter((s) => s.id !== id), done: r.cycle.done.filter((d) => d !== id), order: r.cycle.order.filter((d) => d !== id) } });
  return state();
}

/** The steps in a new order: this week's, and the template's in that order too. */
export function order(ids: string[]) {
  const r = load();
  const pos = new Map(ids.map((id, i) => [id, i]));
  const steps = [...r.steps].sort((a, b) => (pos.get(a.id) ?? 1e9) - (pos.get(b.id) ?? 1e9));
  save({ ...r, steps, cycle: { ...r.cycle, order: ids.filter((id) => [...r.steps, ...r.cycle.extras].some((s) => s.id === id)) } });
  return state();
}

export function tick(id: string, done: boolean) {
  const r = load();
  if (![...r.steps, ...r.cycle.extras].some((s) => s.id === id)) throw new NotFound(`no step ${id}`);
  const set = new Set(r.cycle.done);
  if (done) set.add(id); else set.delete(id);
  save({ ...r, cycle: { ...r.cycle, done: [...set] } });
  return state();
}
