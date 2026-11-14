// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore
//
// Two machines, two processes, one folder between them (sync-folder.ts): the first seeds; the second, fresh,
// joins and is filled — the same Home, the project at its own id, the page, the task, the card, the Library
// file; then the same page changed on both in different places ends the same, merged, on both.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, copyFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, "fixtures", "sync-machine.mjs");
// The fixture is plain JavaScript beside the compiled tests: copied there from the source.
mkdirSync(join(here, "fixtures"), { recursive: true });
try { copyFileSync(join(here, "..", "..", "test", "fixtures", "sync-machine.mjs"), script); } catch { /* run from source */ }
const sandbox = mkdtempSync(join(tmpdir(), "talaris-two-"));
after(() => rmSync(sandbox, { recursive: true, force: true }));
const key = randomBytes(32).toString("base64");
const shared = join(sandbox, "Shared folder");
const env = (m: string) => ({ ...process.env, TALARIS_DATA_DIR: join(sandbox, m, "data"), TALARIS_PROJECTS: join(sandbox, m, "Projects"),
  TALARIS_CONFIG_DIR: join(sandbox, m, "config"), TALARIS_STATE_DIR: join(sandbox, m, "state"), TALARIS_KEY: key, TALARIS_SYNC_FOLDER: shared });
const run = (m: string, step: string, arg: object = {}) =>
  JSON.parse(execFileSync(process.execPath, [script, step, JSON.stringify(arg)], { env: env(m), encoding: "utf8" }).trim().split("\n").pop()!);

let first: { home: string; plan: string; task: string; canvas: string };

test("a fresh machine joining is filled from the first", () => {
  first = run("xps", "first");
  const b = run("mini", "join", { task: first.task, canvas: first.canvas });
  assert.equal(b.home, first.home, "the same Home");
  assert.equal(b.plan, first.plan, "the project at its own id");
  assert.equal(b.page, "alpha\nbeta\ngamma\ndelta");
  assert.equal(b.task, "Call Ann");
  assert.equal(b.card, "On the canvas");
  assert.equal(b.file, "the budget, in bytes");
});

test("one page changed on both, in different places: merged, the same on both", () => {
  run("xps", "edit", { text: "ALPHA from the laptop\nbeta\ngamma\ndelta" });
  run("mini", "edit", { text: "alpha\nbeta\ngamma\nDELTA from the mini" });
  run("xps", "sync");
  run("mini", "sync");
  const a = run("xps", "sync");
  const b = run("mini", "sync");
  assert.equal(a.page, "ALPHA from the laptop\nbeta\ngamma\nDELTA from the mini");
  assert.equal(b.page, a.page);
});
