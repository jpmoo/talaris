// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore
//
// One machine of a two-machine sync test (sync-folder.test.ts): its own data, projects and state folders from
// the environment, one step from argv[2], what it finds printed as JSON.

const D = new URL("../../src/", import.meta.url).href;
const records = await import(D + "records.js");
const projects = await import(D + "projects.js");
const pages = await import(D + "pages.js");
const entities = await import(D + "entities.js");
const canvases = await import(D + "canvases.js");
const pr = await import(D + "project-records.js");
const folder = await import(D + "sync-folder.js");
const seed = await import(D + "sync-seed.js");
const { writeFileSync, mkdirSync, readFileSync, existsSync } = await import("node:fs");
const { join } = await import("node:path");
pr.startRecordingProjects();
folder.startSync();
const step = process.argv[2];
const arg = process.argv[3] ? JSON.parse(process.argv[3]) : {};
const out = {};
const plan = () => projects.listProjects().find((p) => p.name === "Plan");

if (step === "first") {
  records.setSyncing(true);
  const home = projects.ensureHome();
  const p = projects.createProject("Plan");
  pages.writePage(p.id, "Shared", "alpha\nbeta\ngamma\ndelta");
  const t = entities.createEntity({ type: entities.typeFor("task").id, properties: { title: "Call Ann" } });
  mkdirSync(join(p.folder, "Files"), { recursive: true });
  writeFileSync(join(p.folder, "Files", "budget.txt"), "the budget, in bytes");
  const cv = canvases.canvasTree(p.id).id;
  const doc = canvases.readCanvas(p.id, cv);
  canvases.writeCanvas(p.id, { ...doc, items: [{ id: "it_x", kind: "note", x: 10, y: 20, w: 80, h: 40, text: "On the canvas" }] });
  seed.seed();
  folder.tick();
  Object.assign(out, { home: home.id, plan: p.id, task: t.id, canvas: cv });
}
if (step === "join") {
  // As join.js does: filled before Talaris first starts here, so it makes no Home of its own.
  records.setSyncing(true);
  folder.tick();
  projects.ensureHome(); // Talaris's first start: the Home that came is the Home
  const p = plan();
  out.home = projects.listProjects().find((x) => x.home)?.id;
  out.plan = p?.id;
  out.page = p ? pages.readPage(p.id, "Shared") : null;
  try { out.task = entities.getEntity(arg.task).properties.title; } catch { out.task = null; }
  out.file = p && existsSync(join(p.folder, "Files", "budget.txt")) ? readFileSync(join(p.folder, "Files", "budget.txt"), "utf8") : null;
  try { out.card = canvases.readCanvas(p.id, arg.canvas).items.find((i) => i.id === "it_x")?.text ?? null; } catch { out.card = null; }
}
if (step === "edit") {
  const p = plan();
  pages.writePage(p.id, "Shared", arg.text);
  folder.tick();
}
if (step === "sync") {
  folder.tick();
  const p = plan();
  out.page = pages.readPage(p.id, "Shared");
}
console.log(JSON.stringify(out));
