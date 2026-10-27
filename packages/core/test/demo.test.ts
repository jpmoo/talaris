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

test("the demo world is made once: projects, people, tasks in every state, collections, notes, events", async () => {
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
  // Morgan's threads, made up; and the garden's list, holding its canvas, a file, and a thread brought in by a shortcut.
  const { threads } = await import("../src/threads.js");
  const { listTree } = await import("../src/filelists.js");
  assert.equal(threads().length, 4);
  const garden = projects.listProjects().find((p) => p.name === "Community Garden")!;
  const tree = listTree(garden.id);
  assert.equal(tree[0]!.name, "Workday");
  assert.equal(tree[0]!.count, 3);
  const cal = JSON.parse(readFileSync(join(sandbox, "calendar.json"), "utf8"));
  assert.ok(cal.calendars.length && cal.events.length);
  assert.ok(existsSync(join(sandbox, "seeded")));
  assert.ok(tasks.shapeOf(entities.getEntity(all[0]!.id)));
});

test("the demo is made to show ties: each planted one is suggested", async () => {
  const suggest = await import("../src/suggest.js");
  const filetext = await import("../src/filetext.js");
  const id = (title: string, kind?: string) => entities.findEntities({ q: title, ...(kind ? { kind } : {}) }).find((s) => s.title === title)!.id;
  const offered = (key: string) => suggest.suggestionsFor(key).suggestions;
  const has = (key: string, title: string, how: string) => offered(key).some((s) => s.title === title && s.ways.some((w) => w.how === how));

  const priya = `e:${id("Call Priya about the donate button on phones")}`;
  assert.ok(has(priya, "Priya Raman", "mention"), "a plain name: a mention offered");
  const daniel = offered(`e:${id("Send Daniel the board packet")}`).filter((s) => s.kind === "person").map((s) => s.title).sort();
  assert.deepEqual(daniel, ["Daniel Okafor", "Daniel Park"], "one of two Daniels");
  const sams = entities.findEntities({ q: "Sam Whitaker", kind: "contact" });
  assert.equal(sams.length, 2);
  assert.ok(has(`e:${sams[0]!.id}`, "Sam Whitaker", "merge"), "Sam twice: merge");
  assert.ok(has(`e:${id("M. Bell", "contact")}`, "Marcus Bell", "merge"), "one address, two names: merge");
  const compost = entities.findEntities({ q: "Fix the compost bin latch", kind: "task" });
  assert.equal(compost.length, 2);
  assert.ok(has(`e:${compost[0]!.id}`, "Fix the compost bin latch", "merge"), "a task twice: merge");
  assert.ok(has("page:notes/Maya", "Maya Chen", "connect"), "a page called by her name: about her");
  assert.ok(offered("page:notes/Spring fundraiser").some((s) => s.title.startsWith("Daniel")), "a name in a page of no project");
  const minutes = projects.listProjects().find((p) => p.name === "Board Report")!;
  assert.ok(offered(`file:${minutes.id}/Files/March minutes.md`).some((s) => s.title === "Lena Novak"), "a file names a person");
  const kitchen = projects.listProjects().find((p) => p.name === "Kitchen Remodel")!;
  assert.match(await filetext.textOf(join(kitchen.folder, "Files", "Permit checklist.pdf")), /Sam Whitaker will pull the permit/, "the PDF reads");
});
