// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const sandbox = mkdtempSync(join(tmpdir(), "talaris-days-"));
process.env.TALARIS_DATA_DIR = join(sandbox, "data");
process.env.TALARIS_PROJECTS = join(sandbox, "Projects");
process.env.TALARIS_CONFIG_DIR = join(sandbox, "config");
process.env.TALARIS_STATE_DIR = join(sandbox, "state");
process.env.TALARIS_KEY = randomBytes(32).toString("base64");

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
