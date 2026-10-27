// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore

// Canvases and Morgan's threads as things Files lists, reads and connects; and lists.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";

const sandbox = mkdtempSync(join(tmpdir(), "talaris-things-"));
process.env.TALARIS_DATA_DIR = join(sandbox, "data");
process.env.TALARIS_PROJECTS = join(sandbox, "Projects");
process.env.TALARIS_CONFIG_DIR = join(sandbox, "config");
process.env.TALARIS_STATE_DIR = join(sandbox, "state");
process.env.TALARIS_KEY = randomBytes(32).toString("base64");
process.env.HEYMORGAN_SOCKET = join(sandbox, "no-morgan.sock");

const projects = await import("../src/projects.js");
const canvases = await import("../src/canvases.js");
const pages = await import("../src/pages.js");
const files = await import("../src/files.js");
const threads = await import("../src/threads.js");
const meaning = await import("../src/meaning.js");
const suggest = await import("../src/suggest.js");
const entities = await import("../src/entities.js");
const filelists = await import("../src/filelists.js");
const context = await import("../src/context.js");

after(() => { files.stopAll(); rmSync(sandbox, { recursive: true, force: true }); });

mkdirSync(process.env.TALARIS_CONFIG_DIR!, { recursive: true });
writeFileSync(join(process.env.TALARIS_CONFIG_DIR!, "config.json"), JSON.stringify({ meaning: { on: true, url: "http://model.test", model: "test-embed", describe: false } }));
meaning.setEmbedder(async (_s, texts) => texts.map((t) => {
  const v = new Float32Array(64);
  for (const w of t.toLowerCase().match(/[a-z]+/g) ?? []) {
    if (w.length < 4) continue;
    const h = createHash("sha256").update(w).digest();
    v[h[0]! % 64]! += 1;
  }
  let n = 0; for (const x of v) n += x * x; n = Math.sqrt(n) || 1;
  return v.map((x) => x / n);
}));

const home = projects.ensureHome();
const garden = projects.createProject("Garden");
const bare = projects.createProject("Bare");
const T = 1792900000000;
const thread = (n: number, title: string, summary: string, ts: number[]) => ({ id: `${ts[0]}-${n}`, t0: ts[0]!, t1: ts.at(-1)!, title, summary, exchanges: ts.length, ts });

test("a canvas's words, read top to bottom and left to right", () => {
  const top = canvases.readCanvas(garden.id, canvases.canvasTree(garden.id).id);
  top.items.push({ id: "b", x: 300, y: 10, w: 100, h: 60, text: "Raised beds" }, { id: "a", x: 10, y: 0, w: 100, h: 60, text: "Tomato seedlings" },
    { id: "c", x: 10, y: 200, w: 100, h: 60, kind: "card", entity: "x", seen: { title: "Order compost" } });
  canvases.writeCanvas(garden.id, top);
  const words = canvases.canvasWords(canvases.readCanvas(garden.id, top.id));
  assert.ok(words.indexOf("Tomato seedlings") < words.indexOf("Raised beds") && words.indexOf("Raised beds") < words.indexOf("Order compost"), words);
});

test("canvases and threads are rows in Files: canvases in their project, threads in Home", () => {
  threads.setThreads([thread(0, "Garden canvas talk", "Tomato seedlings wilted in the raised beds; order compost.", [T, T + 1000]),
    thread(1, "Dinner plans", "Pasta on Friday.", [T + 5000])]);
  const rows = files.listFiles().rows;
  const canvas = rows.find((r) => r.type === "canvas" && r.project === garden.id)!;
  assert.ok(canvas, "the garden's canvas");
  assert.equal(canvas.thing, `canvas:${garden.id}/${canvas.key.split("/")[1]}`);
  const t = rows.find((r) => r.key === `t:${T}-0`)!;
  assert.equal(t.project, home.id);
  assert.equal(t.type, "conversation");
  assert.equal(files.listFiles({ project: garden.id, type: "conversation" }).rows.length, 0, "threads live in Home");
  assert.equal(files.fileCounts().type.conversation, 2);
});

test("canvases and threads are read and embedded; a thread's description is Morgan's summary until written over", async () => {
  await meaning.reindex();
  const rows = files.listFiles().rows;
  const states = meaning.fileReadStates(rows);
  const canvas = rows.find((r) => r.type === "canvas" && r.project === garden.id)!;
  assert.equal(states.read[canvas.key], "read");
  assert.equal(states.read[`t:${T}-0`], "read");
  // A canvas with nothing on it: read, nothing in it — and near nothing, so suggested for nothing.
  const empty = rows.find((r) => r.type === "canvas" && r.project === bare.id)!;
  assert.equal(states.read[empty.key], "nowords");
  assert.equal(suggest.suggestionsFor(empty.thing!).suggestions.length, 0);
  assert.equal(suggest.thing(empty.thing!).title, "Bare canvas");
  assert.match(states.about[`t:${T}-0`]!, /wilted/);
  const key = `thread:${home.id}/${T}-0`;
  assert.ok(meaning.editPageDescription(key, "Blight, and what to do about it"));
  assert.deepEqual(meaning.thingDescription(key), { about: "Blight, and what to do about it", aboutByYou: true, read: true });
  assert.ok(meaning.editPageDescription(key, ""));
  assert.match(meaning.thingDescription(key).about, /wilted/);
  // The passes the edits set off, finished, and one more: what is read now is the summary alone.
  while (meaning.meaningStatus().indexing) await new Promise((r) => setTimeout(r, 10));
  await meaning.reindex();
});

test("a thread is suggested for a canvas it shares its matter with, and connects", async () => {
  const cv = canvases.canvasTree(garden.id).id;
  const s = suggest.suggestionsFor(`canvas:${garden.id}/${cv}`).suggestions.find((x) => x.key === `thread:${home.id}/${T}-0`);
  assert.ok(s, "the blight thread");
  assert.equal(s!.kind, "conversation");
  const way = s!.ways.find((w) => w.how === "connect")!;
  assert.match(suggest.accept(`canvas:${garden.id}/${cv}`, s!.key, way).said, /connected/);
  const e = threads.threadEntity(`${T}-0`);
  assert.equal(suggest.keyOfEntity(e), `thread:${home.id}/${T}-0`);
  assert.ok(entities.connections(e.id).in.length + entities.connections(e.id).out.length > 0);
});

test("a thread merged by Morgan: its id leads to the kept one, and what was tied to it follows", () => {
  const was = threads.threadEntity(`${T}-0`);
  const ties = entities.connections(was.id).in.length + entities.connections(was.id).out.length;
  // Morgan merged the blight thread into a newer one holding its exchanges.
  const moved = threads.setThreads([thread(0, "Garden troubles", "Blight, and slugs on the raised beds.", [T + 9000, T, T + 1000]),
    thread(1, "Dinner plans", "Pasta on Friday.", [T + 5000])]);
  assert.equal(moved.moved, 1);
  assert.equal(threads.currentId(`${T}-0`), `${T + 9000}-0`);
  const now = threads.threadEntity(`${T + 9000}-0`);
  assert.equal(entities.connections(now.id).in.length + entities.connections(now.id).out.length, ties);
  assert.equal(threads.threadById(`${T}-0`)?.title, "Garden troubles");
});

test("a thread brought into a project by a shortcut; lists hold only the project's", () => {
  const sc = files.makeThingShortcut(garden.id, `thread:${home.id}/${T + 9000}-0`);
  assert.equal(sc.project, garden.id);
  assert.equal(sc.type, "conversation");
  assert.throws(() => files.makeThingShortcut(garden.id, `thread:${home.id}/${T + 9000}-0`), /already/);
  const reading = filelists.createList(garden.id, "Reading");
  const sub = filelists.createList(garden.id, "Pests", reading.id);
  const mine = new Set(files.listFiles({ project: garden.id }).rows.map((r) => r.key));
  const canvas = files.listFiles({ project: garden.id, type: "canvas" }).rows[0]!;
  assert.deepEqual(filelists.addToList(garden.id, sub.id, [sc.key, `t:${T + 5000}-1`], (k) => mine.has(k)), { added: 1, refused: [`t:${T + 5000}-1`] });
  filelists.addToList(garden.id, reading.id, [canvas.key], (k) => mine.has(k));
  assert.deepEqual(files.listFiles({ project: garden.id, list: reading.id }).rows.map((r) => r.key), [canvas.key, sc.key], "its own, then its lists'");
  const tree = filelists.listTree(garden.id);
  assert.equal(tree[0]!.count, 2);
  assert.equal(tree[0]!.children[0]!.name, "Pests");
  assert.throws(() => filelists.moveList(garden.id, reading.id, sub.id), /inside itself/);
});

test("a page renamed keeps its place in lists", () => {
  pages.writePage(garden.id, "Seeds", "What to sow.");
  const key = `p:${garden.id}/Writing/Seeds.md`;
  const l = filelists.createList(garden.id, "Plans");
  filelists.addToList(garden.id, l.id, [key], () => true);
  pages.movePage(garden.id, "Seeds", null, "Seeds to sow");
  assert.deepEqual(filelists.members(garden.id, l.id), [`p:${garden.id}/Writing/Seeds to sow.md`]);
  assert.equal(filelists.deleteList(garden.id, l.id), 1);
});

test("the launcher's context finds threads by their titles", () => {
  const c = context.contextFor("dinner");
  const hit = c.hits.find((h) => h.kind === "conversation");
  assert.equal(hit?.thread, `${T + 5000}-1`);
});

test("Morgan away: the copy is kept, and why it was not asked is said", async () => {
  const r = await threads.syncThreads();
  assert.equal(r.ok, false);
  assert.equal(threads.threads().length, 2);
  assert.match(threads.threadsStatus().error, /could not be asked/);
});
