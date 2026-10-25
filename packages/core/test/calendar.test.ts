// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const sandbox = mkdtempSync(join(tmpdir(), "talaris-cal-"));
process.env.TALARIS_DATA_DIR = join(sandbox, "data");
process.env.TALARIS_PROJECTS = join(sandbox, "Projects");
process.env.TALARIS_CONFIG_DIR = join(sandbox, "config");
process.env.TALARIS_STATE_DIR = join(sandbox, "state");
process.env.TALARIS_KEY = randomBytes(32).toString("base64");

const tasks = await import("../src/tasks.js");
const lists = await import("../src/lists.js");
const entities = await import("../src/entities.js");

after(() => rmSync(sandbox, { recursive: true, force: true }));

test("the calendar's tasks: each whose span from available to due touches the days on show", () => {
  const long = tasks.createTask({ title: "Write the report", start: "2026-11-02", due: "2026-11-05" });
  const dueOnly = tasks.createTask({ title: "Call the bank", due: "2026-11-04T15:00" });
  tasks.createTask({ title: "Later", start: "2026-11-09", due: "2026-11-10" });
  tasks.createTask({ title: "Undated" });
  const week = lists.tasksOnDays("2026-11-03", "2026-11-04").map((r) => r.title);
  assert.deepEqual(week, ["Write the report"], "a day inside a span");
  assert.deepEqual(lists.tasksOnDays("2026-11-01", "2026-11-08").map((r) => r.title), ["Write the report", "Call the bank"]);
  tasks.setDone(long.id, true);
  assert.equal(lists.tasksOnDays("2026-11-01", "2026-11-08").find((r) => r.id === long.id)!.complete, true, "done ones stay, ticked");
  assert.ok(dueOnly);
});

test("ticked done and opened again by what the type says; moved by whole days, times kept", () => {
  const t = tasks.createTask({ title: "Plan the retreat", start: "2026-11-02", due: "2026-11-03T09:30" });
  const shape = tasks.shapeOf(entities.getEntity(t.id))!;
  tasks.setDone(t.id, true);
  assert.ok(shape.complete.includes(String(entities.getEntity(t.id).properties[shape.statusKey])));
  tasks.setDone(t.id, false);
  assert.ok(!shape.complete.includes(String(entities.getEntity(t.id).properties[shape.statusKey])));
  tasks.shiftTask(t.id, 30);
  assert.deepEqual(tasks.spanOf(entities.getEntity(t.id)), { start: "2026-12-02", due: "2026-12-03T09:30" });
  tasks.shiftTask(t.id, -1);
  assert.deepEqual(tasks.spanOf(entities.getEntity(t.id)), { start: "2026-12-01", due: "2026-12-02T09:30" });
});
