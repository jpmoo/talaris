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
