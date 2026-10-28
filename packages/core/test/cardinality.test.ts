// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const sandbox = mkdtempSync(join(tmpdir(), "talaris-card-"));
process.env.TALARIS_DATA_DIR = join(sandbox, "data");
process.env.TALARIS_PROJECTS = join(sandbox, "Projects");
process.env.TALARIS_CONFIG_DIR = join(sandbox, "config");
process.env.TALARIS_STATE_DIR = join(sandbox, "state");
process.env.TALARIS_KEY = randomBytes(32).toString("base64");
const HOME = join(sandbox, "home");
process.env.TALARIS_LINK_HOME = HOME;
mkdirSync(HOME, { recursive: true });

const entities = await import("../src/entities.js");
const links = await import("../src/links.js");
const tasks = await import("../src/tasks.js");
after(() => rmSync(sandbox, { recursive: true, force: true }));

const fileType = () => entities.typeFor("file").id;

test("a File's one attachment is kept as one, a task's files as a list", () => {
  const path = join(HOME, "plan.txt");
  writeFileSync(path, "the plan");
  const f = entities.createEntity({ type: fileType(), properties: { title: "plan.txt" } });
  links.linkFile(f.id, path);
  const v = entities.getEntity(f.id).properties.file;
  assert.ok(v && !Array.isArray(v), "one value, as the File type says");
  const t = tasks.createTask({ title: "With files" });
  links.linkFile(t.id, path);
  const list = entities.getEntity(t.id).properties.attachments;
  assert.ok(Array.isArray(list) && list.length === 1, "a list, as many says");
});

test("a File kept as a list, the old way, is put right on loading — not as an edit", () => {
  const path = join(HOME, "old.txt");
  writeFileSync(path, "old");
  const f = entities.createEntity({ type: fileType(), properties: { title: "old.txt" } });
  const one = links.linkFile(f.id, path);
  entities.updateEntity(f.id, { properties: { file: [one] } });
  assert.ok(Array.isArray(entities.getEntity(f.id).properties.file));
  const updated = entities.getEntity(f.id).updated;
  entities.reloadEntities();
  const after_ = entities.getEntity(f.id);
  assert.ok(after_.properties.file && !Array.isArray(after_.properties.file));
  assert.equal(after_.updated, updated, "not counted as a change");
});
