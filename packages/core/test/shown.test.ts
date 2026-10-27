// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore

// What Settings leaves out of Glance and of a thing's connections: finished tasks, archived things, the old.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const sandbox = mkdtempSync(join(tmpdir(), "talaris-shown-"));
process.env.TALARIS_DATA_DIR = join(sandbox, "data");
process.env.TALARIS_PROJECTS = join(sandbox, "Projects");
process.env.TALARIS_CONFIG_DIR = join(sandbox, "config");
process.env.TALARIS_STATE_DIR = join(sandbox, "state");
process.env.TALARIS_KEY = randomBytes(32).toString("base64");
process.env.HEYMORGAN_SOCKET = join(sandbox, "no-morgan.sock");

const projects = await import("../src/projects.js");
const entities = await import("../src/entities.js");
const tasks = await import("../src/tasks.js");
const files = await import("../src/files.js");
const { glance } = await import("../src/glance.js");
const shown = await import("../src/shown.js");

after(() => { files.stopAll(); rmSync(sandbox, { recursive: true, force: true }); });

mkdirSync(process.env.TALARIS_CONFIG_DIR!, { recursive: true });
const settings = (s: object) => writeFileSync(join(process.env.TALARIS_CONFIG_DIR!, "config.json"), JSON.stringify({ shown: s }));

projects.ensureHome();
const garden = projects.createProject("Garden");
tasks.taskProjects();
const pe = entities.bySource({ kind: "talaris-project", key: garden.id })!.id;
const open = tasks.createTask({ title: "Order compost", projects: [pe] });
const done = tasks.createTask({ title: "Sow tomatoes", projects: [pe] });
tasks.setDone(done.id, true);
const titles = () => glance(garden.id).nodes.map((n) => n.title);

test("nothing left out unless Settings says", () => {
  settings({});
  assert.ok(titles().includes("Sow tomatoes"));
  assert.equal(glance(garden.id).hidden, undefined);
});

test("finished tasks left out of a glance, and counted", () => {
  settings({ done: true });
  assert.ok(titles().includes("Order compost"));
  assert.ok(!titles().includes("Sow tomatoes"));
  assert.equal(glance(garden.id).hidden, 1);
  // The middle is always shown, finished or not.
  assert.equal(glance(garden.id, 1, `e:${done.id}`).nodes[0]!.title, "Sow tomatoes");
});

test("too old, by when it last changed: an entity, and anything with a date", () => {
  const s = { olderThan: 30 };
  const old = new Date(Date.now() - 40 * 86_400_000).toISOString();
  assert.equal(shown.leftOut({ ...entities.getEntity(open.id), updated: old }, s), true);
  assert.equal(shown.leftOut(entities.getEntity(open.id), s), false);
  assert.equal(shown.tooOld(undefined, s), false, "no date, never too old");
  assert.equal(shown.leftOut({ ...entities.getEntity(open.id), archived: true }, { archived: true }), true);
});
