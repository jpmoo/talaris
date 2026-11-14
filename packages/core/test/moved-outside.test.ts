// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore
//
// A page renamed or moved outside Talaris (a file manager; another machine, docs/SYNC.md) is the same note: its
// entity, and what is connected to it, kept. And a day made here has its date's id, the same on every machine.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const sandbox = mkdtempSync(join(tmpdir(), "talaris-moved-"));
process.env.TALARIS_DATA_DIR = join(sandbox, "data");
process.env.TALARIS_PROJECTS = join(sandbox, "Projects");
process.env.TALARIS_CONFIG_DIR = join(sandbox, "config");
process.env.TALARIS_STATE_DIR = join(sandbox, "state");
process.env.TALARIS_KEY = randomBytes(32).toString("base64");

const projects = await import("../src/projects.js");
const pages = await import("../src/pages.js");
const notes = await import("../src/notes.js");
const entities = await import("../src/entities.js");

after(() => rmSync(sandbox, { recursive: true, force: true }));
const home = projects.ensureHome();
const plan = projects.createProject("Plan");
const file = (p: { folder: string }, path: string) => join(p.folder, "Writing", `${path}.md`);
const noteAt = (projectId: string, path: string) => entities.bySource({ kind: "page", key: `${projectId}/${path}` });

test("renamed in a file manager: the same note, under its new name", () => {
  pages.writePage(plan.id, "Budget", "Lines for the budget.");
  notes.reconcileNotes();
  const before = noteAt(plan.id, "Budget")!;
  const person = entities.createEntity({ type: entities.typeFor("person").id, properties: { title: "Ann" } });
  entities.link({ from: person.id, to: before.id, type: "about" });
  renameSync(file(plan, "Budget"), file(plan, "Budget 2027"));
  notes.reconcileNotes();
  assert.equal(noteAt(plan.id, "Budget"), null);
  const after_ = noteAt(plan.id, "Budget 2027")!;
  assert.equal(after_.id, before.id);
  assert.equal(after_.properties.title, "Budget 2027");
  assert.ok(entities.connections(person.id).out.some((c) => c.entity.id === before.id));
});

test("moved to another project in a file manager: still the same note", () => {
  const before = noteAt(plan.id, "Budget 2027")!;
  mkdirSync(join(home.folder, "Writing", "Pages"), { recursive: true });
  renameSync(file(plan, "Budget 2027"), file(home, "Pages/Budget 2027"));
  notes.reconcileNotes();
  assert.equal(noteAt(home.id, "Pages/Budget 2027")!.id, before.id);
});

test("unsure — two new pages with the same words — it is not guessed: gone, and each made", () => {
  pages.writePage(plan.id, "Twin", "Same words.");
  notes.reconcileNotes();
  const before = noteAt(plan.id, "Twin")!;
  renameSync(file(plan, "Twin"), file(plan, "Twin A"));
  pages.writePage(plan.id, "Twin B", "Same words.");
  notes.reconcileNotes();
  const a = noteAt(plan.id, "Twin A")!, b = noteAt(plan.id, "Twin B")!;
  assert.notEqual(a.id, before.id);
  assert.notEqual(b.id, before.id);
});

test("a page deleted is still gone", () => {
  pages.writePage(plan.id, "Scratch", "Throwaway.");
  notes.reconcileNotes();
  const id = noteAt(plan.id, "Scratch")!.id;
  rmSync(file(plan, "Scratch"));
  notes.reconcileNotes();
  assert.throws(() => entities.getEntity(id));
});

test("a day made here has its date's id", () => {
  pages.writePage(home.id, "Daily/2026-11-14", "Set up the mini.");
  notes.reconcileDays();
  const day = entities.bySource({ kind: "page", key: `${home.id}/Daily/2026-11-14` })!;
  assert.equal(day.id, notes.dayId("2026-11-14"));
  assert.equal(day.id, "e_day20261114");
});
