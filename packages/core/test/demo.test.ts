// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const sandbox = mkdtempSync(join(tmpdir(), "talaris-demo-"));
process.env.TALARIS_DATA_DIR = join(sandbox, "data");
process.env.TALARIS_PROJECTS = join(sandbox, "Projects");
process.env.TALARIS_CONFIG_DIR = join(sandbox, "config");
process.env.TALARIS_STATE_DIR = join(sandbox, "state");
process.env.TALARIS_DEMO_ROOT = sandbox;
process.env.TALARIS_KEY = randomBytes(32).toString("base64");

const projects = await import("../src/projects.js");
const { seedDemo } = await import("../src/demo-seed.js");
const lists = await import("../src/lists.js");
const entities = await import("../src/entities.js");
const tasks = await import("../src/tasks.js");

after(() => rmSync(sandbox, { recursive: true, force: true }));

test("the demo world is made once: projects, people, tasks in every state, collections, notes, events", () => {
  projects.ensureHome();
  assert.equal(seedDemo(), true);
  assert.equal(seedDemo(), false, "made once; Reset makes it again");
  const names = projects.listProjects().map((p) => p.name).sort();
  assert.deepEqual(names, ["Board Report", "Community Garden", "Home", "Kitchen Remodel", "Website Refresh"]);
  assert.ok(entities.findEntities({ kind: "contact" }).length >= 6);
  const all = lists.findTasks({});
  assert.ok(all.some((r) => r.overdue), "something overdue");
  assert.ok(all.some((r) => r.complete), "something done");
  assert.ok(all.some((r) => r.recurring), "something repeating");
  assert.ok(all.some((r) => r.start && r.due && r.start < r.due), "something spanning days");
  const kinds = lists.allLists().map((l) => l.kind).sort();
  assert.deepEqual(kinds, ["board", "list", "matrix", "table"]);
  const matrix = lists.allLists().find((l) => l.kind === "matrix")!;
  assert.ok(lists.showList(matrix.id).rows.length >= 8, "cards placed");
  const cal = JSON.parse(readFileSync(join(sandbox, "calendar.json"), "utf8"));
  assert.ok(cal.calendars.length && cal.events.length);
  assert.ok(existsSync(join(sandbox, "seeded")));
  assert.ok(tasks.shapeOf(entities.getEntity(all[0]!.id)));
});
