// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const sandbox = mkdtempSync(join(tmpdir(), "talaris-ctx-"));
process.env.TALARIS_DATA_DIR = join(sandbox, "data");
process.env.TALARIS_PROJECTS = join(sandbox, "Projects");
process.env.TALARIS_CONFIG_DIR = join(sandbox, "config");
process.env.TALARIS_STATE_DIR = join(sandbox, "state");
process.env.TALARIS_KEY = randomBytes(32).toString("base64");

const entities = await import("../src/entities.js");
const tasks = await import("../src/tasks.js");
const { contextFor } = await import("../src/context.js");

after(() => rmSync(sandbox, { recursive: true, force: true }));

test("context: what holds the words, and what the things it names touch, though they never say it", () => {
  const rich = entities.createEntity({ role: "person", properties: { title: "Rich Gelson" } });
  entities.createEntity({ role: "person", properties: { title: "Max Richter" } });
  const lunch = tasks.createTask({ title: "Book the lunch" });
  entities.connect(lunch.id, rich.id, { type: "mentions" });
  const note = entities.createEntity({ role: "note", properties: { title: "Thoughts after the board meeting" } });
  entities.connect(note.id, rich.id, { type: "about" });
  const done = tasks.createTask({ title: "Send the photos" });
  entities.connect(done.id, rich.id, { type: "mentions" });
  tasks.setDone(done.id, true);

  const c = contextFor("rich");
  assert.deepEqual(c.hits.map((h) => h.title).sort(), ["Max Richter", "Rich Gelson"], "both hold the letters");
  assert.deepEqual(c.about.map((a) => a.focus.title), ["Rich Gelson"], "only the one it names whole is opened out");
  const related = c.about[0]!.related;
  assert.deepEqual(related.map((r) => r.title).slice(-1), ["Send the photos"], "the done task last");
  assert.ok(related.some((r) => r.title === "Thoughts after the board meeting" && r.kind === "note" && r.incoming && r.how === "people"), "filed where a note declares people");;
  assert.equal(related.find((r) => r.title === "Book the lunch")!.done, false);
  assert.deepEqual(contextFor("  ").hits, []);
});

test("a note's projects: those it names, and those the people it names are tied to — never one guessed", async () => {
  const { projectsNamedIn } = await import("../src/context.js");
  const budget = entities.createEntity({ role: "project", properties: { title: "Budget" } });
  const planning = entities.createEntity({ role: "project", properties: { title: "Planning" } });
  const lorraine = entities.createEntity({ role: "person", properties: { title: "Lorraine Bell" } });
  entities.connect(lorraine.id, budget.id, { type: "project" });
  // Two people called Will: neither is named by "Will" alone.
  const will = entities.createEntity({ role: "person", properties: { title: "Will Ames" } });
  entities.createEntity({ role: "person", properties: { title: "Will Cho" } });
  entities.connect(will.id, planning.id, { type: "project" });
  // Someone in every project says nothing about which one.
  const everywhere = entities.createEntity({ role: "person", properties: { title: "Pat Rowe" } });
  for (const t of ["A", "B", "C", "D"]) entities.connect(everywhere.id, entities.createEntity({ role: "project", properties: { title: `Project ${t}` } }).id, { type: "project" });

  const titles = (text: string) => projectsNamedIn(text).map((p) => p.title);
  assert.deepEqual(titles("Lorraine prefers email to calls"), ["Budget"], "a first name only one person has");
  assert.deepEqual(projectsNamedIn("Lorraine prefers email")[0]!.via, ["Lorraine Bell"]);
  assert.deepEqual(titles("The planning retreat is in March"), [], "a project's name only as written: lower case is a word");
  assert.deepEqual(titles("Planning retreat is in March"), ["Planning"]);
  assert.deepEqual(titles("Will said he would call"), [], "a first name two people share");
  assert.deepEqual(titles("Will Ames will call"), ["Planning"], "a whole name");
  assert.deepEqual(titles("Pat Rowe likes tea"), [], "tied to too many to say which");
  assert.deepEqual(titles("Likes oat milk"), []);
});
