// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const sandbox = mkdtempSync(join(tmpdir(), "talaris-tasks-"));
process.env.TALARIS_DATA_DIR = join(sandbox, "data");
process.env.TALARIS_PROJECTS = join(sandbox, "Projects");
process.env.TALARIS_CONFIG_DIR = join(sandbox, "config");
process.env.TALARIS_STATE_DIR = join(sandbox, "state");
process.env.TALARIS_KEY = randomBytes(32).toString("base64");

const entities = await import("../src/entities.js");
const tasks = await import("../src/tasks.js");
const lists = await import("../src/lists.js");

after(() => rmSync(sandbox, { recursive: true, force: true }));

const day = (n: number) => lists.resolveDate(`today${n >= 0 ? "+" : "-"}${Math.abs(n)}`);
const status = (id: string) => entities.getEntity(id).properties.status;

test("a new task is not started; completing stamps it, reopening clears the stamp", () => {
  const t = tasks.createTask({ title: "Write the report" });
  assert.equal(status(t.id), "not_started");
  entities.updateEntity(t.id, { properties: { status: "done" } });
  assert.match(String(entities.getEntity(t.id).properties.done_at), /^\d{4}-\d\d-\d\dT\d\d:\d\d$/);
  entities.updateEntity(t.id, { properties: { status: "in_progress" } });
  assert.equal(entities.getEntity(t.id).properties.done_at, undefined);
});

test("a recurring task brings its next occurrence once, in its series, until the series ends", () => {
  const t = tasks.createTask({ title: "Water the plants", start: day(-1), due: day(0) });
  tasks.setRecurrence(t.id, { anchor: "schedule", freq: "weekly", interval: 1, end: { type: "after", count: 2 } });
  entities.updateEntity(t.id, { properties: { status: "done" } });
  const nextId = entities.getEntity(t.id)["talaris:next"] as string;
  assert.ok(nextId, "the next occurrence was made");
  const next = entities.getEntity(nextId);
  assert.equal(next.properties.status, "not_started");
  assert.deepEqual(next.properties.schedule, { start: day(6), end: day(7) }, "the whole span moved a week");
  assert.equal(next["talaris:series"], entities.getEntity(t.id)["talaris:series"], "it joined the series");
  // Reopened and completed again: no second next occurrence (Hermes made one).
  entities.updateEntity(t.id, { properties: { status: "not_started" } });
  entities.updateEntity(t.id, { properties: { status: "done" } });
  assert.equal(entities.findEntities({ q: "Water the plants", limit: 10 }).length, 2);
  // The second of two: the series ends, nothing more is made.
  entities.updateEntity(nextId, { properties: { status: "done" } });
  assert.equal(entities.getEntity(nextId)["talaris:next"], undefined);
  assert.equal(entities.findEntities({ q: "Water the plants", limit: 10 }).length, 2);
});

test("a rule the format refuses is refused here, by its reason", () => {
  const t = tasks.createTask({ title: "Haircut", due: day(3) });
  assert.throws(() => tasks.setRecurrence(t.id, { anchor: "completion", freq: "weekly", interval: 4, byWeekday: ["WE"] }), /weekday pattern/);
  const r = tasks.setRecurrence(t.id, { anchor: "completion", freq: "weekly", interval: 4 });
  assert.equal(r.summary, "Every 4 weeks, from completion");
});

test("the starting lists hold what they say", () => {
  lists.resetStartersForTests();
  const byName = new Map(lists.allLists().map((l) => [l.name, l]));
  assert.deepEqual([...byName.keys()], ["Today", "Upcoming", "Available", "Unscheduled", "Done recently"]);
  const late = tasks.createTask({ title: "Late thing", due: day(-2) });
  const soon = tasks.createTask({ title: "Soon thing", due: day(3) });
  const none = tasks.createTask({ title: "Someday thing" });
  const shown = (name: string) => lists.showList(byName.get(name)!.id).rows.map((r) => r.title);
  assert.ok(shown("Today").includes("Late thing"));
  assert.ok(!shown("Today").includes("Soon thing"));
  assert.ok(shown("Upcoming").includes("Soon thing"));
  assert.ok(shown("Unscheduled").includes("Someday thing"));
  assert.ok(lists.showList(byName.get("Today")!.id).rows.find((r) => r.id === late.id)?.overdue);
  entities.updateEntity(soon.id, { properties: { status: "done" } });
  assert.ok(shown("Done recently").includes("Soon thing"));
  assert.ok(!shown("Upcoming").includes("Soon thing"), "done is not upcoming");
  void none;
});

test("a list by hand keeps the order it was given", () => {
  const l = lists.createList({ name: "Errands" });
  const a = tasks.createTask({ title: "A" }), b = tasks.createTask({ title: "B" }), c = tasks.createTask({ title: "C" });
  lists.addMember(l.id, a.id);
  lists.addMember(l.id, b.id);
  lists.addMember(l.id, c.id, { after: a.id, before: b.id });
  assert.deepEqual(lists.showList(l.id).rows.map((r) => r.title), ["A", "C", "B"]);
  assert.equal(lists.showList(l.id).manual, true);
});

test("a snapshot is filled once and then is the person's; a live query is never", () => {
  const q = { kind: "group" as const, match: "all" as const, items: [{ kind: "text" as const, value: "zebra" }] };
  tasks.createTask({ title: "zebra one" });
  const snap = lists.createList({ name: "Snap", query: q, materialized: true });
  const live = lists.createList({ name: "Live", query: q });
  tasks.createTask({ title: "zebra two" });
  assert.equal(lists.showList(snap.id).rows.length, 1, "the snapshot holds what was there");
  assert.equal(lists.showList(live.id).rows.length, 2, "the live one sees what is there");
  assert.equal(lists.showList(live.id).manual, false);
  lists.refresh(snap.id);
  assert.equal(lists.showList(snap.id).rows.length, 2);
});

test("on a board, a card's column is its status", () => {
  const board = lists.createList({ name: "Board", kind: "board", query: { kind: "group", match: "all", items: [{ kind: "text", value: "boardcard" }] } });
  const t = tasks.createTask({ title: "boardcard" });
  assert.equal(lists.showList(board.id).rows[0]?.region, "not_started");
  lists.addMember(board.id, t.id, { region: "blocked" });
  assert.equal(status(t.id), "blocked");
  const regions = board.placement!.regions.map((r) => (typeof r === "string" ? r : r.name));
  assert.deepEqual(regions, ["not_started", "in_progress", "blocked", "done", "archived", "wont_do"]);
});

test("a matrix region's meaning is done on entering, and the drawer holds what is not placed", () => {
  const m = lists.createList({ name: "Eisenhower", kind: "matrix", query: { kind: "group", match: "all", items: [{ kind: "text", value: "quadrant" }] } });
  const placement = { ...m.placement!, regions: m.placement!.regions.map((r) => (typeof r === "string" ? { name: r } : r)) };
  placement.regions[0] = { ...placement.regions[0]!, "talaris:enter": { tag: "urgent", untagOnLeave: true, status: "in_progress" } };
  lists.updateList(m.id, { placement });
  const t = tasks.createTask({ title: "quadrant task" });
  tasks.createTask({ title: "quadrant other" });
  assert.equal(lists.showList(m.id).drawer?.length, 2);
  lists.addMember(m.id, t.id, { region: "do" });
  assert.deepEqual(entities.getEntity(t.id).tags, ["urgent"]);
  assert.equal(status(t.id), "in_progress");
  assert.equal(lists.showList(m.id).drawer?.length, 1);
  lists.addMember(m.id, t.id, { region: "plan" });
  assert.deepEqual(entities.getEntity(t.id).tags, [], "leaving took the tag back");
});

test("missing values sort last whichever way, and groups follow the field's options", () => {
  const l = lists.createList({
    name: "By due", query: { kind: "group", match: "all", items: [{ kind: "text", value: "sortme" }] },
    order: { sort: [{ by: { field: "schedule", part: "end" }, direction: "descending" }], groupBy: { field: "status" } },
  });
  tasks.createTask({ title: "sortme none" });
  tasks.createTask({ title: "sortme early", due: day(1) });
  const late = tasks.createTask({ title: "sortme late", due: day(9) });
  entities.updateEntity(late.id, { properties: { status: "in_progress" } });
  const s = lists.showList(l.id);
  assert.deepEqual(s.rows.map((r) => r.title), ["sortme late", "sortme early", "sortme none"]);
  assert.deepEqual(s.groups?.map((g) => g.key), ["not_started", "in_progress"]);
});

test("positions always have room between", () => {
  let a = lists.between(null, null);
  const b = lists.between(a, null);
  for (let i = 0; i < 30; i++) {
    const m = lists.between(a, b);
    assert.ok(a < m && m < b, `${a} < ${m} < ${b}`);
    a = m;
  }
});

test("Talaris's own projects are projects tasks can be filed under", async () => {
  const projects = await import("../src/projects.js");
  projects.createProject("Ogham");
  const list = tasks.taskProjects();
  const ogham = list.find((p) => p.title === "Ogham");
  assert.ok(ogham?.workspace, "known by its workspace");
  const t = tasks.createTask({ title: "Draw the map", projects: [ogham!.id] });
  assert.deepEqual(lists.showProject(ogham!.id).rows.map((r) => r.id), [t.id]);
  assert.equal(tasks.taskProjects().filter((p) => p.title === "Ogham").length, 1, "made once");
});

test("an export with tasks, series and lists passes the format's checker, declaring what it carries", async () => {
  const { existsSync } = await import("node:fs");
  const { homedir } = await import("node:os");
  const { execFileSync } = await import("node:child_process");
  const ix = await import("../src/interchange.js");
  const env = ix.exportEnvelope();
  assert.ok((env.series as unknown[]).length >= 1);
  assert.ok((env.collections as unknown[]).length >= 5);
  for (const f of ["series", "placement", "derivations", "ordering"]) assert.ok((env.conformance!.features as string[]).includes(f), f);
  const assess = join(homedir(), "Documents/Scripts/hermesnotes/pkm-interchange/check/src/assess.js");
  if (!existsSync(assess)) return;
  const script = `import { assess } from ${JSON.stringify(assess)}; import { readFileSync } from "node:fs";
    process.stdout.write(JSON.stringify(assess(JSON.parse(readFileSync(0, "utf8")))));`;
  const out = JSON.parse(execFileSync("node", ["--input-type=module", "-e", script], { input: JSON.stringify(env), encoding: "utf8" }));
  const failed = out.checks.filter((c: { ok: boolean }) => !c.ok);
  assert.deepEqual(failed, [], JSON.stringify(failed));
});

test("statuses are the person's: renamed, recolored, added, taken away with their tasks moved", () => {
  const board = lists.createList({ name: "Status board", kind: "board", query: { kind: "group", match: "all", items: [{ kind: "text", value: "statuscard" }] } });
  const t = tasks.createTask({ title: "statuscard" });
  entities.updateEntity(t.id, { properties: { status: "blocked" } });
  tasks.setStatuses([
    { value: "not_started", label: "To do", color: "#868c92" },
    { value: "in_progress", label: "Doing" },
    { label: "Waiting on someone", color: "#c7a55a" },
    { value: "done", label: "Done", complete: true },
    { value: "wont_do", label: "Dropped", complete: true },
  ], "not_started", { blocked: "waiting_on_someone" });
  assert.equal(status(t.id), "waiting_on_someone", "blocked's task moved where it was told");
  const shape = tasks.taskShape(entities.typeFor("task"))!;
  assert.deepEqual(shape.complete, ["done", "wont_do"]);
  const cols = lists.showList(board.id).list.placement!.regions.map((r) => (typeof r === "string" ? r : r.label));
  assert.deepEqual(cols, ["To do", "Doing", "Waiting on someone", "Done", "Dropped"], "the board follows at once");
  assert.throws(() => tasks.setStatuses([{ label: "Only", complete: true }], "only"), /not done/);
  // A newer built-in task type keeps statuses a person set.
  entities.reloadEntities();
  assert.equal(tasks.taskShape(entities.typeFor("task"))!.complete.length, 2);
});

test("a project made from Tasks is a Talaris project: a folder, a workspace, and one entity", async () => {
  const projects = await import("../src/projects.js");
  const e = tasks.createTaskProject("Garden");
  assert.ok(projects.listProjects().some((p) => p.name === "Garden"), "a real project, in the bar's list");
  assert.equal(tasks.taskProjects().filter((p) => p.title === "Garden").length, 1);
  assert.equal(tasks.taskProjects().find((p) => p.title === "Garden")!.id, e.id);
});

test("Home is not a project: never listed, and what was filed there is filed nowhere", async () => {
  const projects = await import("../src/projects.js");
  const home = projects.ensureHome();
  // As it was before Home was left out: a mirrored Home with a task under it.
  const mirrored = entities.createEntity({ role: "project", properties: { title: "Home" }, sources: [{ kind: "talaris-project", key: home.id }] });
  const t = tasks.createTask({ title: "Filed at home", projects: [mirrored.id] });
  const listed = tasks.taskProjects();
  assert.ok(!listed.some((p) => p.title === "Home"));
  assert.equal(entities.getEntity(t.id).properties.project, undefined);
  assert.throws(() => entities.getEntity(mirrored.id), /no entity/);
});
