// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const sandbox = mkdtempSync(join(tmpdir(), "talaris-coll-"));
process.env.TALARIS_DATA_DIR = join(sandbox, "data");
process.env.TALARIS_PROJECTS = join(sandbox, "Projects");
process.env.TALARIS_CONFIG_DIR = join(sandbox, "config");
process.env.TALARIS_STATE_DIR = join(sandbox, "state");
process.env.TALARIS_KEY = randomBytes(32).toString("base64");

const tasks = await import("../src/tasks.js");
const lists = await import("../src/lists.js");
const interchange = await import("../src/interchange.js");
const entities = await import("../src/entities.js");

after(() => rmSync(sandbox, { recursive: true, force: true }));

test("collections travel over the live binding only when asked for, with their members as they are now", () => {
  const t = tasks.createTask({ title: "Call the bank" });
  const m = lists.createList({ name: "Priorities", kind: "matrix", query: { kind: "profile", profile: "task" } });
  lists.addMember(m.id, t.id, { region: "do" });
  assert.equal((interchange.readEnvelope() as { collections?: unknown[] }).collections, undefined, "not unless asked");
  const env = interchange.readEnvelope({ collections: true }) as unknown as { collections: { id: string; members: { object: string; region?: string }[] }[] };
  const got = env.collections.find((c) => c.id === m.id)!;
  assert.deepEqual(got.members.map((x) => [x.object, x.region]), [[t.id, "do"]]);
});

test("a member is put, moved between regions, and taken out, as the format says", () => {
  const t = tasks.createTask({ title: "Plan the retreat" });
  const m = lists.createList({ name: "Quadrants", kind: "matrix" });
  assert.equal(interchange.writeMember("PUT", m.id, t.id, { region: "plan" }).ok, true);
  assert.equal(interchange.writeMember("PUT", m.id, t.id, { region: "drop" }).ok, true, "a repeat is a success…");
  assert.equal(lists.getList(m.id).members.find((x) => x.object === t.id)!.region, "plan", "…that changes nothing");
  assert.equal(interchange.writeMember("PATCH", m.id, t.id, { region: "delegate" }).ok, true);
  assert.equal(lists.getList(m.id).members.find((x) => x.object === t.id)!.region, "delegate");
  const bad = interchange.writeMember("PATCH", m.id, t.id, { region: "somewhere" });
  assert.equal(bad.ok, false);
  assert.match(bad.reports[0]!, /unknown-region/);
  assert.equal(interchange.writeMember("PATCH", m.id, t.id, { region: null }).ok, true);
  assert.equal(lists.getList(m.id).members.find((x) => x.object === t.id)!.region, undefined, "still a member, nowhere in particular");
  assert.equal(interchange.writeMember("DELETE", m.id, t.id, {}).ok, true);
  assert.equal(interchange.writeMember("DELETE", m.id, t.id, {}).ok, true, "taking out what is not there is a success");
  assert.ok(entities.getEntity(t.id), "the task itself is untouched");
});

test("a smart list's membership is its rule's: not written", () => {
  const t = tasks.createTask({ title: "Anything" });
  const smart = lists.createList({ name: "Open", kind: "list", query: { kind: "state", value: "open" } });
  assert.equal(interchange.writeMember("PUT", smart.id, t.id, {}).ok, true, "already in it by its rule: so");
  const other = lists.createList({ name: "Done", kind: "list", query: { kind: "state", value: "complete" } });
  const refused = interchange.writeMember("PUT", other.id, t.id, {});
  assert.equal(refused.ok, false);
  assert.match(refused.reports[0]!, /membership-is-a-rule/);
});

test("a collection is made at the id asked for; asked again, it answers as it stands", () => {
  const made = interchange.makeCollection("c_from_hermes", { id: "c_from_hermes", name: "Eisenhower", kind: "matrix",
    placement: { semantic: true, regions: [{ name: "do", label: "Do" }, { name: "decide", label: "Decide" }] }, "hermes-sync:source": "190f" });
  assert.equal(made.ok, true);
  assert.equal(made.created, true);
  assert.equal(lists.getList("c_from_hermes")["hermes-sync:source"], "190f", "its prefixed keys kept");
  const again = interchange.makeCollection("c_from_hermes", { name: "Renamed", kind: "list" });
  assert.equal(again.created, false);
  assert.equal(lists.getList("c_from_hermes").name, "Eisenhower");
  assert.equal(interchange.makeCollection("c_canvas", { kind: "canvas" }).ok, false, "a kind Talaris does not keep");
});

test("a synced collection's definition is kept in step, and marked as synced, by what", () => {
  const by = { id: "hermes-sync", name: "Hermes Notes sync" };
  const made = interchange.makeCollection("c_synced", { name: "Eisenhower", kind: "matrix",
    membership: { mode: "query", query: { kind: "profile", profile: "task" } },
    placement: { semantic: true, regions: [{ name: "do", label: "Do" }] } }, by);
  assert.equal(made.ok, true);
  assert.equal(lists.getList("c_synced")["talaris:syncedBy"], "Hermes Notes sync");
  assert.equal(lists.getList("c_synced").membership.mode, "query");
  const regions = [{ name: "do", label: "Do now", "talaris:enter": { tag: "urgent", untagOnLeave: true } }, { name: "later", label: "Later" }];
  assert.equal(interchange.defineCollection("c_synced", { name: "Priorities", placement: { semantic: true, regions },
    membership: { mode: "query", query: { kind: "state", value: "open" } } }, by).ok, true);
  const l = lists.getList("c_synced");
  assert.equal(l.name, "Priorities");
  assert.deepEqual(l.placement?.regions, regions);
  assert.deepEqual(l.membership.mode === "query" && l.membership.query, { kind: "state", value: "open" });
  // A rule in another app's words is refused, never stored.
  const foreign = interchange.defineCollection("c_synced", { membership: { mode: "query", query: { kind: "semantic", value: "x", floor: 0.5 } } }, by);
  assert.equal(foreign.ok, false);
  assert.match(foreign.reports[0]!, /rule-not-runnable/);
  // No rule: its members kept by hand, by whoever keeps it in step.
  interchange.defineCollection("c_synced", { membership: { mode: "explicit" } }, by);
  assert.equal(lists.getList("c_synced").membership.mode, "explicit");
  assert.equal(interchange.defineCollection("c_nowhere", { name: "x" }, by).ok, false);
});

test("a list is deleted without archiving it first; its members stay", () => {
  const t = tasks.createTask({ title: "Stays" });
  const l = lists.createList({ name: "Brief" });
  lists.addMember(l.id, t.id, {});
  lists.deleteList(l.id);
  assert.throws(() => lists.getList(l.id));
  assert.ok(entities.getEntity(t.id));
});

test("a board is made bound to its field, its columns that field's options", () => {
  const made = interchange.makeCollection("c_board", { name: "By status", kind: "board", bind: "status",
    membership: { mode: "query", query: { kind: "profile", profile: "task" } }, placement: { semantic: true, regions: ["ignored"] } }, { id: "p", name: "P" });
  assert.equal(made.ok, true);
  const l = lists.getList("c_board");
  assert.equal(l["talaris:bind"], "status");
  assert.notDeepEqual(l.placement?.regions, ["ignored"], "not regions of its own");
});

test("a mention of a thing whose id has dashes (one from another app) is a mention: its title reads plain", () => {
  const text = "Ask [@Emily Lucas](talaris:c1e7fcda-0acc-4f11-93bf-fe975dbbf796) today";
  assert.equal(entities.titleOf({ id: "x", type: "", properties: { title: text } } as never), "Ask @Emily Lucas today");
});
