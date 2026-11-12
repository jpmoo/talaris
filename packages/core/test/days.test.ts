// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";

const sandbox = mkdtempSync(join(tmpdir(), "talaris-days-"));
process.env.TALARIS_DATA_DIR = join(sandbox, "data");
process.env.TALARIS_PROJECTS = join(sandbox, "Projects");
process.env.TALARIS_CONFIG_DIR = join(sandbox, "config");
process.env.TALARIS_STATE_DIR = join(sandbox, "state");
process.env.TALARIS_KEY = randomBytes(32).toString("base64");
// Linked files reach only as far as this folder (links.ts): the sandbox stands in for the home folder.
process.env.TALARIS_LINK_HOME = sandbox;

const projects = await import("../src/projects.js");
const pages = await import("../src/pages.js");
const interchange = await import("../src/interchange.js");

after(() => rmSync(sandbox, { recursive: true, force: true }));
const home = projects.ensureHome();
const dayFile = (d: string) => join(home.folder, "Writing", "Daily", `${d}.md`);
const days = () => (interchange.readEnvelope().objects ?? []).filter((o) => o.type === "t_daily");

test("a daily note goes out through the binding as the page for its day, a note with its words", () => {
  pages.writePage(home.id, "Daily/2026-10-24", "Met with the board.");
  const [d] = days();
  assert.equal(d!.properties!.date, "2026-10-24");
  assert.equal(d!.properties!.body, "Met with the board.");
  const env = interchange.readEnvelope();
  const t = env.types!.find((x) => x.id === "t_daily")!;
  assert.deepEqual(t.profiles!.journal, { date: "date" });
});

test("written through the binding, the words go to the day's page; the date stays its identity", () => {
  const [d] = days();
  const r = interchange.patchObject(d!.id, { set: { body: "Met with the board. Budget next.", date: "1999-01-01" } });
  assert.equal(r.ok, true);
  assert.equal(readFileSync(dayFile("2026-10-24"), "utf8"), "Met with the board. Budget next.");
  assert.equal(days()[0]!.properties!.date, "2026-10-24");
});

test("a day made through the binding is that day's page; a second one for a day is refused", () => {
  const made = interchange.createObject("00000000-0000-4000-8000-0000000000d1", { type: "t_daily", properties: { date: "2026-10-23", body: "Called the bank." } });
  assert.equal(made.ok, true);
  assert.equal(made.object!.id, "00000000-0000-4000-8000-0000000000d1");
  assert.equal(readFileSync(dayFile("2026-10-23"), "utf8"), "Called the bank.");
  const again = interchange.createObject("00000000-0000-4000-8000-0000000000d2", { type: "t_daily", properties: { date: "2026-10-23", body: "Twice." } });
  assert.equal(again.ok, false);
  assert.match(again.reports.join(" "), /journal\.duplicate/);
  assert.equal(readFileSync(dayFile("2026-10-23"), "utf8"), "Called the bank.", "never written over");
});

test("a day whose page is deleted is gone from the binding", () => {
  rmSync(dayFile("2026-10-23"));
  assert.ok(!existsSync(dayFile("2026-10-23")));
  assert.deepEqual(days().map((d) => d.properties!.date), ["2026-10-24"]);
});

test("an empty day keeps its version from one reading to the next, and takes a write made against it", () => {
  pages.writePage(home.id, "Daily/2026-11-09", "");
  const notes = days().filter((o) => o.properties!.date === "2026-11-09");
  assert.equal(notes.length, 1);
  const first = notes[0]!;
  const again = days().find((o) => o.properties!.date === "2026-11-09")!;
  assert.equal(String(again.version), String(first.version), "read twice, unchanged: not written again");
  // A sync writing Hermes Notes' words into the empty day, against the version it read.
  const r = interchange.patchObject(first.id, { set: { body: "Packing list" }, version: first.version });
  assert.equal(r.ok, true, "not refused as changed meanwhile");
  assert.equal(readFileSync(dayFile("2026-11-09"), "utf8"), "Packing list");
});

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const filesOf = (date: string) => ((days().find((o) => o.properties!.date === date)?.properties?.files ?? []) as { filename: string; sha256: string }[]);

test("a day's files are the ones its page links, carried by hash", () => {
  mkdirSync(join(home.folder, "Files"), { recursive: true });
  const bytes = Buffer.from("minutes, as a pdf would be");
  writeFileSync(join(home.folder, "Files", "minutes.pdf"), bytes);
  pages.writePage(home.id, "Daily/2026-11-10", "Board.\n\n[minutes.pdf](talaris-file:Files/minutes.pdf)\n");
  assert.deepEqual(filesOf("2026-11-10").map((f) => [f.filename, f.sha256]), [["minutes.pdf", sha(bytes)]]);
  // And the bytes are there to be asked for by hash, as a sync does.
  assert.equal(interchange.getInterchangeFile(sha(bytes)).ok, true);
  // Its link taken out of the page: no longer one of its files (the file stays).
  pages.writePage(home.id, "Daily/2026-11-10", "Board.\n");
  assert.deepEqual(filesOf("2026-11-10"), []);
  assert.ok(existsSync(join(home.folder, "Files", "minutes.pdf")));
});

test("a file brought to a day through the binding is filed in Home's Files and linked at the end of its page", () => {
  const photo = Buffer.from("a photo's bytes");
  const d = days().find((o) => o.properties!.date === "2026-11-10")!;
  const r = interchange.patchObject(d.id, { set: { files: [{ kind: "attachment", filename: "IMG_0001.jpg", mediaType: "image/jpeg", bytes: photo.toString("base64") }] } });
  assert.equal(r.ok, true, r.reports.join(", "));
  assert.deepEqual(readFileSync(join(home.folder, "Files", "IMG_0001.jpg")), photo);
  assert.equal(readFileSync(dayFile("2026-11-10"), "utf8"), "Board.\n\n[IMG_0001.jpg](talaris-file:Files/IMG_0001.jpg)\n");
  assert.deepEqual(filesOf("2026-11-10").map((f) => f.sha256), [sha(photo)]);
  // Written again with the same file: not filed twice.
  const again = days().find((o) => o.properties!.date === "2026-11-10")!;
  interchange.patchObject(again.id, { set: { files: [{ kind: "attachment", filename: "IMG_0001.jpg", sha256: sha(photo) }] } });
  assert.ok(!existsSync(join(home.folder, "Files", "IMG_0001 2.jpg")));
  // Written without it: its link goes from the page, and the file stays.
  const third = days().find((o) => o.properties!.date === "2026-11-10")!;
  interchange.patchObject(third.id, { set: { files: [] } });
  assert.equal(readFileSync(dayFile("2026-11-10"), "utf8"), "Board.\n");
  assert.ok(existsSync(join(home.folder, "Files", "IMG_0001.jpg")));
});

test("a day made through the binding with a file has it filed and linked", () => {
  const photo = Buffer.from("another photo");
  const made = interchange.createObject("00000000-0000-4000-8000-0000000000d3", { type: "t_daily",
    properties: { date: "2026-11-11", body: "Rain.", files: [{ kind: "attachment", filename: "rain.jpg", bytes: photo.toString("base64") }] } });
  assert.equal(made.ok, true, made.reports.join(", "));
  assert.equal(readFileSync(dayFile("2026-11-11"), "utf8"), "Rain.\n\n[rain.jpg](talaris-file:Files/rain.jpg)\n");
  assert.deepEqual(filesOf("2026-11-11").map((f) => f.sha256), [sha(photo)]);
});
