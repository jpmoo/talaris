// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore

// One rule each, read one way: a task through its type's profile whatever its
// fields are called, complete by one reading, filed under a project by one
// function, a project named by one resolver, overdue by one rule.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const sandbox = mkdtempSync(join(tmpdir(), "talaris-profile-"));
process.env.TALARIS_DATA_DIR = join(sandbox, "data");
process.env.TALARIS_PROJECTS = join(sandbox, "Projects");
process.env.TALARIS_CONFIG_DIR = join(sandbox, "config");
process.env.TALARIS_STATE_DIR = join(sandbox, "state");
process.env.TALARIS_KEY = randomBytes(32).toString("base64");

const entities = await import("../src/entities.js");
const projects = await import("../src/projects.js");
const tasks = await import("../src/tasks.js");
const lists = await import("../src/lists.js");
const filing = await import("../src/filing.js");
const profile = await import("../src/profile.js");
const { isOverdue, localDate, localMinute } = await import("../src/localtime.js");

after(() => rmSync(sandbox, { recursive: true, force: true }));

// The task type, renamed field by field — as a person may — with its profile saying where each part is.
const built = entities.typeFor("task");
entities.putType({
  ...built,
  fields: [
    { key: "name", kind: "text", required: true },
    { key: "notes", kind: "richtext" },
    { key: "when", kind: "datespan" },
    { key: "state", kind: "enum", options: ["open", "going", "finished"] },
    { key: "filedIn", kind: "reference", targetType: "t_project", many: true },
    { key: "done_at", kind: "datetime" },
  ],
  "talaris:defaultStatus": "open",
  profiles: { task: {
    title: "name", status: "state", completeValues: ["finished"], body: "notes", project: "filedIn",
    start: { field: "when", part: "from" }, due: { field: "when", part: "until" },
  } },
});

projects.ensureHome();
const garden = projects.createProject("Garden");
const gardenShed = projects.createProject("Garden Shed");
tasks.taskProjects();
const gardenE = filing.projectEntity(garden.id)!;
const shedE = filing.projectEntity(gardenShed.id)!;
const day = (n: number) => lists.resolveDate(`today${n >= 0 ? "+" : "-"}${Math.abs(n)}`);

test("a task is written and read through its type's profile, whatever its fields are called", () => {
  const t = tasks.createTask({ title: "Turn the compost", description: "Both bins", start: day(-1), due: day(2), status: "going", projects: [gardenE.id] });
  const p = entities.getEntity(t.id).properties;
  assert.deepEqual(p, { name: "Turn the compost", notes: "Both bins", when: { from: day(-1), until: day(2) }, state: "going", filedIn: [gardenE.id] });
  assert.deepEqual(tasks.spanOf(entities.getEntity(t.id)), { start: day(-1), due: day(2) });
  const row = lists.showProject(gardenE.id).rows.find((r) => r.id === t.id)!;
  assert.equal(row.body, "Both bins");
  assert.equal(row.due, day(2));
  assert.deepEqual(row.projects, [{ id: gardenE.id, title: "Garden" }]);

  // Changed by meaning: each part where the type keeps it.
  tasks.updateTask(t.id, { due: day(3), start: "", body: "One bin", addProjects: [shedE.id], removeProjects: [gardenE.id] });
  const q = entities.getEntity(t.id).properties;
  assert.deepEqual(q.when, { until: day(3) });
  assert.equal(q.notes, "One bin");
  assert.deepEqual(q.filedIn, [shedE.id]);
  tasks.shiftTask(t.id, 1);
  assert.deepEqual(entities.getEntity(t.id).properties.when, { until: day(4) });
  assert.deepEqual(lists.findTasks({ project: shedE.id }).map((r) => r.id), [t.id]);
  assert.deepEqual(lists.findTasks({ status: "going" }).map((r) => r.id), [t.id]);
});

test("a status is one the type offers, the person's own among them", () => {
  const t = tasks.createTask({ title: "Mend the fence" });
  assert.equal(entities.getEntity(t.id).properties.state, "open", "the type's default");
  assert.throws(() => tasks.updateTask(t.id, { status: "not_started" }), /status is one of open, going, finished/);
  tasks.setStatuses([{ value: "open", label: "Open" }, { label: "Someday" }, { value: "finished", label: "Finished", complete: true }], "open", { going: "open" });
  tasks.updateTask(t.id, { status: "someday" });
  assert.equal(entities.getEntity(t.id).properties.state, "someday");
  tasks.setDone(t.id, true);
  assert.equal(entities.getEntity(t.id).properties.state, "finished");
  assert.match(String(entities.getEntity(t.id).properties.done_at), /^\d{4}-\d\d-\d\dT\d\d:\d\d$/);
});

test("complete is one reading: an empty status is no status, and a status in a part is read", () => {
  const type = { profiles: { task: { status: "s", completeValues: ["", "done"] } } };
  assert.equal(profile.isCompleteBy(type, { properties: { s: "" } }), false, "empty is no value, even listed");
  assert.equal(profile.isCompleteBy(type, { properties: { s: "done" } }), true);
  const parted = { profiles: { task: { status: { field: "meta", part: "status" }, completeValues: ["done"] } } };
  assert.equal(profile.isCompleteBy(parted, { properties: { meta: { status: "done" } } }), true);
  // The store's tasks read the same way.
  const t = tasks.createTask({ title: "Read the same" });
  const o = entities.getEntity(t.id);
  const shape = tasks.shapeOf(o)!;
  for (const v of ["", "open", "finished"]) {
    const x = { ...o, properties: { ...o.properties, state: v } };
    assert.equal(tasks.isComplete(x, shape), profile.isCompleteBy(shape.type, x), v);
  }
});

test("filed under a project: its type's project slot, else a reference to a project; never words that hold its id", () => {
  const filed = tasks.createTask({ title: "Plant the beds", projects: [gardenE.id] });
  const named = tasks.createTask({ title: "Mentions it", description: `see ${gardenE.id}` });
  // A note's type names no project slot: its reference to a project files it.
  const note = entities.createEntity({ role: "note", properties: { title: "Garden plan", project: [gardenE.id] } });
  assert.deepEqual(filing.filedUnder(entities.getEntity(filed.id)), [gardenE.id]);
  assert.deepEqual(filing.filedUnder(entities.getEntity(named.id)), []);
  assert.deepEqual(filing.filedUnder(note), [gardenE.id]);
  const shown = lists.showProject(gardenE.id).rows.map((r) => r.id);
  assert.ok(shown.includes(filed.id) && shown.includes(note.id));
  assert.ok(!shown.includes(named.id), "an id in the words is not filing");
  assert.equal(filing.folderProjectOf(entities.getEntity(filed.id)), garden.id);
  assert.equal(filing.folderProjectOf(entities.getEntity(named.id)), projects.ensureHome().id, "filed nowhere: Home's");
});

test("a project by name: id, its entity's id, code, exact name, then part of one; notes and home are Home", () => {
  const home = projects.ensureHome();
  assert.equal(filing.resolveProject(garden.id).id, garden.id);
  assert.equal(filing.resolveProject(gardenE.id).id, garden.id);
  assert.equal(filing.resolveProject(garden.code.toLowerCase()).id, garden.id);
  assert.equal(filing.resolveProject("garden").id, garden.id, "exact, any case, before a name that holds it");
  assert.equal(filing.resolveProject("shed").id, gardenShed.id);
  assert.equal(filing.resolveProject("Garden").entity, gardenE.id);
  for (const w of ["notes", "Unaffiliated", "home", ""]) assert.equal(filing.resolveProject(w).id, home.id, w);
  assert.equal(filing.resolveProject("home").entity, undefined, "nothing is filed under Home");
  assert.throws(() => filing.resolveProject("Orchard"), /no project called Orchard/);
});

test("overdue is one rule: a time once it has passed, a date from the next day — in a row and in finding", () => {
  const at = new Date(2026, 9, 27, 14, 30);
  assert.equal(isOverdue("2026-10-26", at), true);
  assert.equal(isOverdue("2026-10-27", at), false, "a date is in time all its day");
  assert.equal(isOverdue("2026-10-27T14:00", at), true, "a time once passed");
  assert.equal(isOverdue("2026-10-27T15:00", at), false);
  assert.equal(isOverdue(undefined, at), false);

  const now = new Date();
  const earlier = localMinute(new Date(now.getTime() - 2 * 3600_000));
  const later = localMinute(new Date(now.getTime() + 2 * 3600_000));
  const made = {
    yesterday: tasks.createTask({ title: "ovrdu yesterday", due: day(-1) }).id,
    today: tasks.createTask({ title: "ovrdu today", due: localDate(now) }).id,
    earlier: tasks.createTask({ title: "ovrdu earlier", due: earlier }).id,
    later: tasks.createTask({ title: "ovrdu later", due: later }).id,
  };
  const want = [made.yesterday, made.earlier].sort();
  const found = lists.findTasks({ when: "overdue", text: "ovrdu" }).map((r) => r.id).sort();
  assert.deepEqual(found, want, "finding");
  const rows = lists.findTasks({ text: "ovrdu" }).filter((r) => r.overdue).map((r) => r.id).sort();
  assert.deepEqual(rows, want, "a row's own mark agrees");
});
