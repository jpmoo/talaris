// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore
//
// Another machine's records applied (sync-apply.ts): made here as they were made there; the later change to a
// field wins on both machines whichever arrives first; different fields both stand; sets merge by member; a
// delete wins and stays; what lost is kept; nothing applied is written out again as this machine's.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";

const sandbox = mkdtempSync(join(tmpdir(), "talaris-apply-"));
process.env.TALARIS_DATA_DIR = join(sandbox, "data");
process.env.TALARIS_PROJECTS = join(sandbox, "Projects");
process.env.TALARIS_CONFIG_DIR = join(sandbox, "config");
process.env.TALARIS_STATE_DIR = join(sandbox, "state");
process.env.TALARIS_KEY = randomBytes(32).toString("base64");

import type { Rec } from "../src/records.js";
const records = await import("../src/records.js");
const entities = await import("../src/entities.js");
const sync = await import("../src/sync-apply.js");
// Every import before the first test: a test run while an import is awaited ends the file early, and its
// clean-up takes the sandbox with it.
const projects = await import("../src/projects.js");
const pages = await import("../src/pages.js");
const canvases = await import("../src/canvases.js");
const pr = await import("../src/project-records.js");
const merge3 = await import("../src/merge3.js");
const { createHash } = await import("node:crypto");
after(() => rmSync(sandbox, { recursive: true, force: true }));
records.setSyncing(true);

// The other machine: its records, stamped as its clock would, `ms` from now.
const OTHER = "m_other";
let c = 0;
const at = (ms: number) => ({ t: Date.now() + ms, c: c++, m: OTHER });
const remote = (of: string, change: Partial<Rec>, ms = 0): Rec => ({ of, ...change, at: at(ms), batch: randomUUID() }) as Rec;
const task = () => entities.typeFor("task").id;
const projectsKey = () => entities.types().find((t) => t.id === task())!.fields.find((f) => f.kind === "reference" && f.many)!.key;

test("made there: made here, at its own id, and not written out again as this machine's", () => {
  const n = records.ownLog().length;
  sync.apply(remote("e:e_fromother", { set: { type: task(), "p.title": "From the mini", created: new Date().toISOString() } }));
  assert.equal(entities.getEntity("e_fromother").properties.title, "From the mini");
  assert.equal(records.ownLog().length, n);
});

test("the same field on both machines: the later wins, and the earlier is kept", () => {
  const e = entities.createEntity({ type: task(), properties: { title: "Mine" } });
  // Theirs from before mine: mine stands, theirs is kept as replaced.
  sync.apply(remote(`e:${e.id}`, { set: { "p.title": "Theirs, earlier" } }, -60_000));
  assert.equal(entities.getEntity(e.id).properties.title, "Mine");
  assert.equal(sync.replacedFor(`e:${e.id}`)[0]!.value, "Theirs, earlier");
  // Theirs from after mine: theirs wins, mine is kept as replaced.
  sync.apply(remote(`e:${e.id}`, { set: { "p.title": "Theirs, later" } }, 60_000));
  assert.equal(entities.getEntity(e.id).properties.title, "Theirs, later");
  assert.equal(sync.replacedFor(`e:${e.id}`)[0]!.value, "Mine");
});

test("different fields on the two machines: both stand", () => {
  const e = entities.createEntity({ type: task(), properties: { title: "Call Ann" } });
  entities.updateEntity(e.id, { properties: { title: "Call Ann back" } });
  sync.apply(remote(`e:${e.id}`, { set: { archived: true } }, -60_000));
  const now = entities.getEntity(e.id);
  assert.equal(now.properties.title, "Call Ann back");
  assert.equal(now.archived, true);
});

test("a set: a project added here and another there, both kept", () => {
  const proj = entities.typeFor("project").id;
  const a = entities.createEntity({ type: proj, properties: { title: "A" } });
  const b = entities.createEntity({ type: proj, properties: { title: "B" } });
  const k = projectsKey();
  const e = entities.createEntity({ type: task(), properties: { title: "In two", [k]: [a.id] } });
  sync.apply(remote(`e:${e.id}`, { add: { [`p.${k}`]: [b.id] } }, -60_000));
  assert.deepEqual([...(entities.getEntity(e.id).properties[k] as string[])].sort(), [a.id, b.id].sort());
});

test("deleted there: gone here, kept in the replaced log, and not brought back by an older change", () => {
  const e = entities.createEntity({ type: task(), properties: { title: "Doomed" } });
  sync.apply(remote(`e:${e.id}`, { gone: true }, 1000));
  assert.throws(() => entities.getEntity(e.id));
  assert.equal(sync.replacedFor(`e:${e.id}`)[0]!.field, "*");
  sync.apply(remote(`e:${e.id}`, { set: { type: task(), "p.title": "Edited before it went" } }, 500));
  assert.throws(() => entities.getEntity(e.id));
});

test("deleted here, edited there later: still gone — the delete wins", () => {
  const e = entities.createEntity({ type: task(), properties: { title: "Gone here" } });
  entities.deleteEntity(e.id);
  sync.apply(remote(`e:${e.id}`, { set: { "p.title": "Edited there" } }, 60_000));
  assert.throws(() => entities.getEntity(e.id));
});

test("arriving twice, or out of order, the same end", () => {
  const e = entities.createEntity({ type: task(), properties: { title: "Start" } });
  const one = remote(`e:${e.id}`, { set: { "p.title": "One" } }, 600_000);
  const two = remote(`e:${e.id}`, { set: { "p.title": "Two" } }, 1_200_000);
  sync.apply(two); sync.apply(one); sync.apply(two);
  assert.equal(entities.getEntity(e.id).properties.title, "Two");
});

// ------------------------------------------------------------ pages, canvases, a project's files

pr.startRecordingProjects();
projects.ensureHome();
const plan = projects.createProject("Shared");
const h = (t: string) => createHash("sha256").update(t).digest("hex").slice(0, 16);

test("merge3: changes to different lines both kept; the same lines changed differently, not clean", () => {
  const base = "one\ntwo\nthree\nfour";
  assert.deepEqual(merge3.merge3(base, "ONE\ntwo\nthree\nfour", "one\ntwo\nthree\nFOUR"), { text: "ONE\ntwo\nthree\nFOUR", clean: true });
  assert.equal(merge3.merge3(base, "one\nTWO\nthree\nfour", "one\nZWEI\nthree\nfour").clean, false);
});

test("a page made there: made here", () => {
  sync.apply(remote(`page:${plan.id}/From there`, { set: { text: "Hello from the mini.", was: null } }));
  assert.equal(pages.readPage(plan.id, "From there"), "Hello from the mini.");
});

test("a page changed there from the text it has here: taken as it is", () => {
  pages.writePage(plan.id, "Notes", "first line\nsecond line");
  sync.apply(remote(`page:${plan.id}/Notes`, { set: { text: "first line\nsecond line\nthird, from the mini", was: h("first line\nsecond line") } }, 600_000));
  assert.equal(pages.readPage(plan.id, "Notes"), "first line\nsecond line\nthird, from the mini");
});

test("a page changed on both, in different places: merged, and the merge written out for the other", () => {
  const base = "alpha\nbeta\ngamma\ndelta";
  pages.writePage(plan.id, "Both", base);
  pages.writePage(plan.id, "Both", "ALPHA here\nbeta\ngamma\ndelta");
  const n = records.ownLog().length;
  sync.apply(remote(`page:${plan.id}/Both`, { set: { text: "alpha\nbeta\ngamma\nDELTA there", was: h(base) } }, 1_800_000));
  assert.equal(pages.readPage(plan.id, "Both"), "ALPHA here\nbeta\ngamma\nDELTA there", JSON.stringify(sync.replacedFor(`page:${plan.id}/Both`).map((r) => r.field)));
  assert.ok(records.ownLog().slice(n).some((r) => r.of === `page:${plan.id}/Both` && r.set?.text === "ALPHA here\nbeta\ngamma\nDELTA there"));
});

test("a page moved there: moved here", () => {
  pages.writePage(plan.id, "Old name", "words");
  sync.apply(remote(`page:${plan.id}/Old name`, { set: { movedTo: `${plan.id}/New name` } }, 2_400_000));
  assert.equal(pages.readPage(plan.id, "New name"), "words");
  assert.throws(() => pages.readPage(plan.id, "Old name"));
});

test("a card moved there, another here: both moves stand", () => {
  const cv = canvases.canvasTree(plan.id).id;
  const doc = canvases.readCanvas(plan.id, cv);
  const items = [{ id: "it_1", kind: "note", x: 0, y: 0, w: 80, h: 40, text: "1" }, { id: "it_2", kind: "note", x: 0, y: 100, w: 80, h: 40, text: "2" }];
  const saved = canvases.writeCanvas(plan.id, { ...doc, items } as never);
  canvases.writeCanvas(plan.id, { ...saved, items: saved.items.map((i: { id: string }) => (i.id === "it_1" ? { ...i, x: 300 } : i)) } as never);
  sync.apply(remote(`item:${cv}/it_2`, { set: { y: 500 } }, 3_000_000));
  const now = canvases.readCanvas(plan.id, cv).items as Array<{ id: string; x: number; y: number }>;
  assert.equal(now.find((i) => i.id === "it_1")!.x, 300);
  assert.equal(now.find((i) => i.id === "it_2")!.y, 500);
});

test("a project renamed there: renamed here", () => {
  sync.apply(remote(`project:${plan.id}`, { set: { name: "Shared, renamed" } }, 3_600_000));
  assert.equal(projects.findProject(plan.id).name, "Shared, renamed");
});

test("a page's look set there, another's here: both kept, entry by entry", () => {
  pages.writePage(plan.id, "Look here", "x");
  pages.setPageLook(plan.id, "Look here", { paper: "#ffffff" });
  pages.writePage(plan.id, "Look there", "y");
  sync.apply(remote(`pfile:${plan.id}/writing-look.json`, { set: { "Look there": { paper: "#000000" } } }, 4_200_000));
  assert.equal(pages.pageLook(plan.id, "Look here").paper, "#ffffff");
  assert.equal(pages.pageLook(plan.id, "Look there").paper, "#000000");
});

test("a list's member added there, another here: both", () => {
  entities.sealedPut("lists", "c_both", { id: "c_both", name: "Both", members: ["e_here"] });
  sync.apply(remote("sealed:lists/c_both", { add: { members: ["e_there"] } }, 4_800_000));
  const l = entities.sealedList<{ id: string; members: string[] }>("lists").find((x) => x.id === "c_both")!;
  assert.deepEqual([...l.members].sort(), ["e_here", "e_there"]);
});
