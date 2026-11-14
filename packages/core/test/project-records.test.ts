// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore
//
// Sync's records of a project's files (project-records.ts): pages with the base a merge needs, canvases item by
// item, a project's own files entry by entry; moves, copies and deletes said; nothing while sync is off.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const sandbox = mkdtempSync(join(tmpdir(), "talaris-precords-"));
process.env.TALARIS_DATA_DIR = join(sandbox, "data");
process.env.TALARIS_PROJECTS = join(sandbox, "Projects");
process.env.TALARIS_CONFIG_DIR = join(sandbox, "config");
process.env.TALARIS_STATE_DIR = join(sandbox, "state");
process.env.TALARIS_KEY = randomBytes(32).toString("base64");

const records = await import("../src/records.js");
const projects = await import("../src/projects.js");
const pages = await import("../src/pages.js");
const canvases = await import("../src/canvases.js");
const pr = await import("../src/project-records.js");
after(() => rmSync(sandbox, { recursive: true, force: true }));
pr.startRecordingProjects();
projects.ensureHome();
const plan = projects.createProject("Plan");
const log = () => records.ownLog();
const last = (of: string) => log().filter((r) => r.of === of).pop();

test("off: a page written, nothing recorded", () => {
  pages.writePage(plan.id, "Quiet", "Not recorded.");
  assert.equal(log().length, 0);
});

test("a page: its words, and the hash of what they replaced", () => {
  records.setSyncing(true);
  pages.writePage(plan.id, "Budget", "First.");
  const a = last(`page:${plan.id}/Budget`)!;
  assert.equal(a.set!.text, "First.");
  assert.equal(a.set!.was, null);
  pages.writePage(plan.id, "Budget", "Second.");
  const b = last(`page:${plan.id}/Budget`)!;
  assert.equal(b.set!.text, "Second.");
  assert.equal(typeof b.set!.was, "string");
});

test("a page moved: said on its old place, with where it went", () => {
  pages.movePage(plan.id, "Budget", null, "Budget 2027");
  const m = last(`page:${plan.id}/Budget`)!;
  assert.equal(m.set!.movedTo, `${plan.id}/Budget 2027`);
});

test("a page deleted: gone", () => {
  pages.writePage(plan.id, "Scratch", "x");
  pages.deletePage(plan.id, "Scratch");
  assert.equal(last(`page:${plan.id}/Scratch`)!.gone, true);
});

test("a canvas: each card its own record; one moved, only it", () => {
  const top = { id: canvases.canvasTree(plan.id).id };
  const doc = canvases.readCanvas(plan.id, top.id);
  const items = [{ id: "it_a", kind: "note", x: 0, y: 0, w: 100, h: 60, text: "A" }, { id: "it_b", kind: "note", x: 200, y: 0, w: 100, h: 60, text: "B" }];
  const saved = canvases.writeCanvas(plan.id, { ...doc, items } as never);
  const before = log().length;
  const moved = saved.items.map((i: { id: string; x: number }) => (i.id === "it_a" ? { ...i, x: 50 } : i));
  canvases.writeCanvas(plan.id, { ...saved, items: moved } as never);
  const now = log().slice(before);
  assert.deepEqual(now.map((r) => r.of).filter((o) => o.startsWith("item:")), [`item:${top.id}/it_a`]);
  assert.deepEqual(now.find((r) => r.of === `item:${top.id}/it_a`)!.set, { x: 50 });
  assert.ok(!now.some((r) => r.of === `canvas:${top.id}` && r.set && "talaris:rev" in r.set), "its revision is the machine's own");
});

test("a project's own file: entry by entry", () => {
  pages.writePage(plan.id, "Look", "words");
  pages.setPageLook(plan.id, "Look", { paper: "#e3edf5" });
  const r = last(`pfile:${plan.id}/writing-look.json`)!;
  assert.deepEqual(Object.keys(r.set!), ["Look"]);
});

test("the project renamed: its name, as a field", () => {
  projects.renameProject(plan.id, "Plan B");
  const r = last(`project:${plan.id}`)!;
  assert.equal(r.set!.name, "Plan B");
});
