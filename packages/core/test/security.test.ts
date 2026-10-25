// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const sandbox = mkdtempSync(join(tmpdir(), "talaris-sec-"));
process.env.TALARIS_DATA_DIR = join(sandbox, "data");
process.env.TALARIS_PROJECTS = join(sandbox, "home", "Projects");
process.env.TALARIS_CONFIG_DIR = join(sandbox, "config");
process.env.TALARIS_STATE_DIR = join(sandbox, "state");
process.env.TALARIS_KEY = randomBytes(32).toString("base64");
// The home folder, for links: inside the sandbox; "outside" is the sandbox's own top.
const HOME = join(sandbox, "home");
process.env.TALARIS_LINK_HOME = HOME;

const entities = await import("../src/entities.js");
const tasks = await import("../src/tasks.js");
const links = await import("../src/links.js");
const projects = await import("../src/projects.js");
const files = await import("../src/files.js");

after(() => { files.stopAll(); rmSync(sandbox, { recursive: true, force: true }); });
mkdirSync(HOME, { recursive: true });
const secret = join(sandbox, "secret.key");
writeFileSync(secret, "PRIVATE");
const planted = (path: string) => ({ kind: "attachment", filename: "x", sha256: "0".repeat(64), "talaris:link": { path, size: 0, mtime: 0 } });
const attachments = (id: string) => entities.getEntity(id).properties.attachments as Record<string, unknown>[];

test("a write cannot plant a link: the mark is taken off, the file never read", () => {
  const t = tasks.createTask({ title: "Innocent" });
  entities.updateEntity(t.id, { properties: { attachments: [planted(secret)] } });
  assert.equal(attachments(t.id)[0]!["talaris:link"], undefined);
  const made = entities.createEntity({ role: "task", properties: { title: "Also", attachments: [planted(secret)] } });
  assert.equal(attachments(made.id)[0]!["talaris:link"], undefined);
  links.refreshLinks();
  assert.equal(links.linkedBytes("0".repeat(64)), null);
});

test("Talaris's own link stays, and a write carrying it unchanged keeps it", () => {
  const file = join(HOME, "plan.txt");
  writeFileSync(file, "the plan");
  const t = tasks.createTask({ title: "Linked" });
  const v = links.linkFile(t.id, file);
  assert.equal((v["talaris:link"] as { path: string }).path, file);
  // As a sync writes it back: the same file, the same link.
  entities.updateEntity(t.id, { properties: { attachments: attachments(t.id) } });
  assert.equal((attachments(t.id)[0]!["talaris:link"] as { path: string }).path, file);
  // But pointed somewhere else by a write: not taken.
  entities.updateEntity(t.id, { properties: { attachments: [{ ...attachments(t.id)[0]!, "talaris:link": { path: secret, size: 0, mtime: 0 } }] } });
  assert.equal(attachments(t.id)[0]!["talaris:link"], undefined);
});

test("a link reaching out of the home folder — by its path or by a symlink — is never read or linked", () => {
  const t = tasks.createTask({ title: "Sneaky" });
  // Even one that got in (an old store, a backup), outside home: taken as missing, not read.
  entities.trusted(() => entities.updateEntity(t.id, { properties: { attachments: [planted(secret)] } }));
  links.refreshLinks([t.id]);
  assert.equal(attachments(t.id)[0]!["talaris:missing"], true);
  assert.equal(links.linkedBytes("0".repeat(64)), null);
  // A symlink in home that leads out.
  symlinkSync(secret, join(HOME, "innocent.txt"));
  assert.throws(() => links.linkFile(t.id, join(HOME, "innocent.txt")), /home folder/);
});

test("a symlink in a project's folder that leads out is not the project's to rename or delete", () => {
  projects.ensureHome();
  const p = projects.createProject("Leaky");
  symlinkSync(sandbox, join(p.folder, "out"));
  assert.throws(() => files.renameFile(p.id, "out/secret.key", "taken.key"), /outside its folder/);
  assert.throws(() => files.trashFile(p.id, "out/secret.key"), /outside its folder/);
});
