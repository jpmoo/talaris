// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";

const sandbox = mkdtempSync(join(tmpdir(), "talaris-meaning-"));
process.env.TALARIS_DATA_DIR = join(sandbox, "data");
process.env.TALARIS_PROJECTS = join(sandbox, "Projects");
process.env.TALARIS_CONFIG_DIR = join(sandbox, "config");
process.env.TALARIS_STATE_DIR = join(sandbox, "state");
process.env.TALARIS_KEY = randomBytes(32).toString("base64");
// Never the Morgan running on this machine: a socket nothing listens on.
process.env.HEYMORGAN_SOCKET = join(sandbox, "no-morgan.sock");

const projects = await import("../src/projects.js");
const pages = await import("../src/pages.js");
const tasks = await import("../src/tasks.js");
const meaning = await import("../src/meaning.js");

after(() => rmSync(sandbox, { recursive: true, force: true }));
const settings = (m: object) => { mkdirSync(process.env.TALARIS_CONFIG_DIR!, { recursive: true }); writeFileSync(join(process.env.TALARIS_CONFIG_DIR!, "config.json"), JSON.stringify({ meaning: m })); };

// A stand-in for a model server: each word to a few of 64 dimensions, so texts sharing words (and their stems) are near.
let calls = 0;
const SAME: Record<string, string> = { money: "budget", spending: "budget", funds: "budget", children: "kids", students: "kids", pupils: "kids" };
meaning.setEmbedder(async (_s, texts) => {
  calls += texts.length;
  return texts.map((t) => {
    const v = new Float32Array(64);
    for (const raw of t.toLowerCase().replace(/^search_(document|query): /, "").match(/[a-z]+/g) ?? []) {
      const w = SAME[raw] ?? raw;
      if (w.length < 4) continue;
      const h = createHash("sha256").update(w).digest();
      v[h[0]! % 64]! += 1; v[h[1]! % 64]! += 0.5;
    }
    let n = 0; for (const x of v) n += x * x; n = Math.sqrt(n) || 1;
    return v.map((x) => x / n);
  });
});

const home = projects.ensureHome();
const school = projects.createProject("School");

test("nothing is embedded, and nothing found, until it is on with a model server", async () => {
  pages.writePage(school.id, "Budget", "The budget for next year: money for the science lab and new books.");
  assert.equal(await meaning.reindex(), 0);
  assert.deepEqual(await meaning.searchMeaning("budget"), []);
  assert.equal(calls, 0, "nothing went to the model server");
});

test("on: pages, Home's pages of no other project and tasks are embedded, and found by what they are about", async () => {
  settings({ on: true, url: "http://model.test", model: "nomic-embed-text" });
  pages.writePage(school.id, "Recess", "Kids need more time outside; students focus better after recess.");
  pages.writePage(home.id, "Pages/Reading list", "Books to read this winter.");
  tasks.createTask({ title: "Ask the board about spending on the lab" });
  const n = await meaning.reindex();
  assert.ok(n >= 4, `embedded ${n}`);
  const hits = await meaning.searchMeaning("funds for the laboratory", { floor: 0.2 });
  assert.equal(hits[0]!.title, "Budget", "money and spending mean budget here");
  assert.ok(hits.some((h) => h.kind === "task"));
  const kids = await meaning.searchMeaning("how pupils learn", { floor: 0.2 });
  assert.equal(kids[0]!.title, "Recess");
  assert.match(kids[0]!.passage, /time outside/);
  assert.equal((await meaning.searchMeaning("budget", { kind: "task", floor: 0.2 }))[0]!.kind, "task");
});

test("only what changed is embedded again; what is gone is forgotten", async () => {
  const before = calls;
  assert.equal(await meaning.reindex(), 0, "nothing changed");
  assert.equal(calls, before);
  await new Promise((ok) => setTimeout(ok, 20));
  pages.writePage(school.id, "Recess", "Recess is cancelled when it rains.");
  assert.equal(await meaning.reindex(), 1);
  pages.deletePage(school.id, "Budget");
  await meaning.reindex();
  assert.ok(!(await meaning.searchMeaning("budget money", { floor: 0.2 })).some((h) => h.title === "Budget"));
});

test("kept sealed: the words are not in the file as they are", () => {
  const raw = readFileSync(join(process.env.TALARIS_DATA_DIR!, "meaning.sealed"));
  assert.ok(!raw.toString("latin1").includes("cancelled when it rains"));
  assert.ok(meaning.meaningStatus().items >= 3);
});

test("a long page is found by the passage that matches", () => {
  const long = Array.from({ length: 6 }, (_, i) => `Paragraph ${i}. ${"filler words here ".repeat(60)}`).join("\n\n");
  const parts = meaning.passages("Long page", long);
  assert.ok(parts.length > 1);
  assert.ok(parts.every((p) => p.startsWith("Long page")));
});

test("files: each not read until a pass reads it, then read — or read and holding no words", async () => {
  settings({ on: true, url: "http://model", model: "fake" });
  const files = await import("../src/files.js");
  const p = projects.createProject("Reading");
  mkdirSync(join(p.folder, "Files"), { recursive: true });
  writeFileSync(join(p.folder, "Files", "minutes.txt"), "The board agreed the budget for the garden.");
  writeFileSync(join(p.folder, "Files", "blank.txt"), "   ");
  writeFileSync(join(p.folder, "Files", "song.mp3"), "not words");
  const rows = () => files.listFiles({ project: p.id }).rows;
  const before = meaning.fileReadStates(rows());
  const of = (r: typeof before, name: string) => r.read[rows().find((x) => x.name === name)!.key];
  assert.equal(of(before, "minutes.txt"), "waiting");
  assert.equal(of(before, "song.mp3"), "unreadable", "of a kind with no words to read: said so");
  assert.ok(before.reading.pending >= 2);
  await meaning.reindex();
  const after_ = meaning.fileReadStates(rows());
  assert.equal(of(after_, "minutes.txt"), "read");
  assert.equal(of(after_, "blank.txt"), "nowords");
  assert.equal(after_.reading.pending, 0);
  // No Morgan to describe it: its tip is its own first words, not word that a description is coming.
  process.env.TALARIS_NO_MORGAN = "1";
  try {
    assert.equal(meaning.fileReadStates(rows()).about[rows().find((x) => x.name === "minutes.txt")!.key], "The board agreed the budget for the garden.");
  } finally { delete process.env.TALARIS_NO_MORGAN; }
  assert.ok((await meaning.searchMeaning("garden budget", { kind: "file", floor: 0.1 })).some((f) => f.title === "minutes.txt"), "found by what it says");
});

test("a file that gave no words: listed, and read again when asked", async () => {
  const rows = (await import("../src/files.js")).listFiles().rows;
  const blank = rows.find((r) => r.name === "blank.txt")!;
  assert.ok(meaning.filesWithNoWords().some((f) => f.key === blank.key));
  writeFileSync(blank.abs!, "Now it says something about compost.");
  // Changed, it would be read again by itself; asked, it is read again even unchanged in size and time.
  assert.equal(meaning.readAgain([blank.key]), 1);
  assert.equal(meaning.fileReadStates((await import("../src/files.js")).listFiles().rows).read[blank.key], "waiting");
  await meaning.reindex();
  assert.ok(!meaning.filesWithNoWords().some((f) => f.key === blank.key));
});
