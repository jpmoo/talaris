// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore

// A project with no description given one by Morgan, from its tasks done and to do; none without tasks.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const sandbox = mkdtempSync(join(tmpdir(), "talaris-projdesc-"));
process.env.TALARIS_DATA_DIR = join(sandbox, "data");
process.env.TALARIS_PROJECTS = join(sandbox, "Projects");
process.env.TALARIS_CONFIG_DIR = join(sandbox, "config");
process.env.TALARIS_STATE_DIR = join(sandbox, "state");
process.env.TALARIS_KEY = randomBytes(32).toString("base64");
process.env.HEYMORGAN_SOCKET = join(sandbox, "morgan.sock");

const projects = await import("../src/projects.js");
const entities = await import("../src/entities.js");
const tasks = await import("../src/tasks.js");
const { describeProjects, projectTasksText, BY_MORGAN } = await import("../src/project-describe.js");

// A stand-in Morgan: what it was told, and an answer said back as 1.9 does — or as an older Morgan, without `what`.
const told: { text: string; name: string; what?: string }[] = [];
let old = false;
const morgan = createServer((sock) => sock.on("data", (d) => {
  const body = JSON.parse(d.toString().replace(/^describe /, ""));
  told.push(body);
  sock.end(`${JSON.stringify({ ok: true, text: `About ${body.name}.`, ...(old ? {} : { what: body.what ?? "file" }) })}\n`);
}));
await new Promise<void>((r) => morgan.listen(process.env.HEYMORGAN_SOCKET, r));
after(() => { morgan.close(); rmSync(sandbox, { recursive: true, force: true }); });

projects.ensureHome();
const garden = projects.createProject("Garden");
const empty = projects.createProject("Empty");
const said = projects.createProject("Said");
tasks.taskProjects();
const entityOf = (id: string) => entities.bySource({ kind: "talaris-project", key: id })!;
tasks.createTask({ title: "Order compost", projects: [entityOf(garden.id).id] });
const sown = tasks.createTask({ title: "Sow tomatoes", projects: [entityOf(garden.id).id] });
tasks.setDone(sown.id, true);
tasks.createTask({ title: "Something", projects: [entityOf(said.id).id] });
entities.updateEntity(entityOf(said.id).id, { properties: { description: "Mine." } });

test("Morgan is told a project's tasks, to do and done", () => {
  const text = projectTasksText(entityOf(garden.id).id);
  assert.match(text, /Still to do:\n- Order compost/);
  assert.match(text, /Done:\n- Sow tomatoes/);
  assert.equal(projectTasksText(entityOf(empty.id).id), "");
});

test("an older Morgan, which takes it for a file: nothing written", async () => {
  old = true;
  assert.deepEqual(await describeProjects(), { described: 0, morganAway: true });
  assert.equal(entityOf(garden.id).properties.description, undefined);
  old = false;
});

test("described from its tasks; one with no tasks, or a description already, left as it is", async () => {
  told.length = 0;
  assert.deepEqual(await describeProjects(), { described: 1 });
  assert.deepEqual(told.map((t) => [t.name, t.what]), [["Garden", "project"]]);
  assert.equal(entityOf(garden.id).properties.description, "About Garden.");
  assert.equal(entityOf(garden.id)[BY_MORGAN], "About Garden.");
  assert.equal(entityOf(empty.id).properties.description, undefined);
  assert.equal(entityOf(said.id).properties.description, "Mine.");
  // Asked again: nothing left to describe.
  told.length = 0;
  assert.deepEqual(await describeProjects(), { described: 0 });
  assert.equal(told.length, 0);
});
