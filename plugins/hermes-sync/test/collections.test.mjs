// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore
//
// Collections: Hermes Notes' rule put into Talaris's conditions, its regions'
// rules brought along, and cards kept in their regions both ways — on two
// made-up libraries with different field names and different statuses.

import { test } from "node:test";
import assert from "node:assert/strict";
import { planCollections, translateRegions, translateRule, translateOrder, bringDown } from "../collections.mjs";

const T = { types: [
  { id: "t_task", fields: [{ key: "title" }, { key: "when", kind: "datespan" }, { key: "status", kind: "enum", options: ["todo", "doing", "blocked", "finished"] }],
    profiles: { task: { title: "title", start: { field: "when", part: "start" }, due: { field: "when", part: "end" }, status: "status", completeValues: ["finished"],
      states: { todo: "not-started", doing: "in-progress", blocked: "waiting", finished: "done" } } } },
] };
const H = { types: [
  { id: "h-task", name: "Task", fields: [{ key: "title" }, { key: "schedule", kind: "datespan" }, { key: "status", kind: "enum", options: ["not done", "waiting", "done"] }, { key: "duration" }],
    profiles: { task: { title: "title", start: { field: "schedule", part: "start" }, due: { field: "schedule", part: "end" }, status: "status", completeValues: ["done"],
      states: { "not done": "not-started", waiting: "waiting", done: "done" } } } },
  { id: "h-org", name: "Organization", fields: [{ key: "title" }], profiles: {} },
] };

test("a rule goes over in Talaris's words: types by what they are, fields through the profiles, statuses by meaning", () => {
  const rule = { kind: "group", match: "all", items: [
    { kind: "blockType", typeId: "h-task" },
    { kind: "property", key: "status", op: "neq", value: "done" },
    { kind: "group", match: "any", items: [{ kind: "property", key: "schedule.end", op: "lt", value: "today+1" }, { kind: "tag", tag: "urgent" }] },
  ] };
  assert.deepEqual(translateRule(rule, H, T).query, { kind: "group", match: "all", items: [
    { kind: "profile", profile: "task" },
    { kind: "property", key: "status", op: "neq", value: "finished" },
    { kind: "group", match: "any", items: [{ kind: "property", key: "when.end", op: "lt", value: "today+1" }, { kind: "tag", tag: "urgent" }] },
  ] });
});

test("a rule Talaris cannot run is said why, whole", () => {
  const meaning = translateRule({ kind: "group", match: "all", items: [{ kind: "blockType", typeId: "h-task" }, { kind: "semantic", value: "travel", floor: 0.6 }] }, H, T);
  assert.equal(meaning.query, null);
  assert.match(meaning.why.join(), /meaning/);
  assert.match(translateRule({ kind: "property", key: "duration", op: "gt", value: "30" }, H, T).why.join(), /duration/);
  assert.match(translateRule({ kind: "blockType", typeId: "h-org" }, H, T).why.join(), /Organization/);
});

test("a status with no meaning on the other side goes as finished or not", () => {
  const noMeanings = { types: [{ ...T.types[0], profiles: { task: { ...T.types[0].profiles.task, states: {} } } }] };
  assert.deepEqual(translateRule({ kind: "property", key: "status", op: "eq", value: "done" }, H, noMeanings).query, { kind: "state", value: "complete" });
  assert.deepEqual(translateRule({ kind: "property", key: "status", op: "neq", value: "done" }, H, noMeanings).query, { kind: "state", value: "open" });
});

test("a region's rules come along: its tag, taken off on leaving, its status by meaning, its color", () => {
  const got = translateRegions([
    { name: "do", label: "Do", "hermes:color": "#d33", "hermes:tagOnEnter": true, "hermes:tagOffLeave": true },
    { name: "wait", label: "Wait", "hermes:tag": "#waiting-for", "hermes:enterStatus": "waiting" },
    { name: "done", label: "Done", "hermes:enterStatus": "done" },
    "later",
  ], H, T);
  assert.deepEqual(got, [
    { name: "do", label: "Do", "talaris:color": "#d33", "talaris:enter": { tag: "do", untagOnLeave: true } },
    { name: "wait", label: "Wait", "talaris:enter": { tag: "waiting-for", status: "blocked" } },
    { name: "done", label: "Done", "talaris:enter": { status: "finished" } },
    { name: "later", label: "later" },
  ]);
});

test("an order's fields go through the profiles; one with no counterpart is dropped", () => {
  assert.deepEqual(translateOrder({ sort: [{ by: { field: "schedule", part: "end" }, direction: "ascending" }, { by: { field: "duration" } }, { by: { meta: "created" } }] }, H, T),
    { sort: [{ by: { field: "when", part: "end" }, direction: "ascending" }, { by: { meta: "created" } }] });
});

const matrix = (members, extra = {}) => ({ id: "hm", name: "Eisenhower", kind: "matrix", membership: { mode: "query", query: { kind: "blockType", typeId: "h-task" } },
  placement: { semantic: true, regions: [{ name: "do", label: "Do" }, { name: "later", label: "Later" }] }, members, ...extra });
const links = [{ kind: "task", t: "t1", h: "h1" }, { kind: "task", t: "t2", h: "h2" }, { kind: "task", t: "t3", h: "h3" }];

test("asked about once; brought down, it is made with its rule runnable in Talaris", () => {
  const cs = { pairs: [], declined: [] };
  const Hw = { ...H, whole: true, collections: [matrix([]), { id: "hc", name: "Canvas", kind: "canvas" }] };
  const Tw = { ...T, collections: [{ id: "c_mine", name: "Mine", kind: "matrix", members: [] }, { id: "c_list", name: "A list", kind: "list", members: [] }] };
  const { ask } = planCollections(cs, Tw, Hw, links);
  assert.equal(ask.length, 1, "only kinds both keep");
  assert.deepEqual(ask[0].choices.map((c) => c.key), ["bring", "t=c_mine", "no"], "matched only to one of its kind");
  const b = bringDown(matrix([]), H, T);
  assert.deepEqual(b.body.membership, { mode: "query", query: { kind: "profile", profile: "task" } });
  assert.equal(b.body["hermes-sync:source"], "hm");
  assert.equal(planCollections({ pairs: [], declined: ["hm"] }, Tw, Hw, links).ask.length, 0, "declined: not asked again");
});

test("cards keep their regions both ways; moved on both sides, it asks", () => {
  const cs = { pairs: [{ h: "hm", t: "c_e", base: { regions: { h1: "do", h2: "do", h3: "later" } } }], declined: [] };
  const Hn = { ...H, whole: true, collections: [matrix([{ object: "h1", region: "later" }, { object: "h2", region: "do" }, { object: "h3", region: "do" }])] };
  const def = bringDown(matrix([]), H, T).body;
  const Tn = { ...T, collections: [{ ...def, id: "c_e", "talaris:syncedPlugin": "hermes-sync", members: [{ object: "t1", region: "do" }, { object: "t2", region: "later" }, { object: "t3", region: "do" }] }] };
  const out = planCollections(cs, Tn, Hn, links, true, new Map([["h3", "Call the bank"]]));
  const places = out.writes.filter((w) => w.op === "place").map((w) => [w.side, w.obj, w.region]);
  assert.deepEqual(places, [["talaris", "t1", "later"], ["hermes", "h2", "later"]], "each carried from the side that moved it");
  assert.equal(out.writes.some((w) => w.op === "define"), false, "the definition already agrees");
  // h3: Talaris moved it later→do, Hermes Notes later→do as well? No: Hermes Notes has do, Talaris do — agreed. Make them differ:
  const Hc = { ...Hn, collections: [matrix([{ object: "h3", region: "later" }])] };
  const Tc = { ...Tn, collections: [{ ...Tn.collections[0], members: [{ object: "t3", region: "do" }] }] };
  const cs2 = { pairs: [{ h: "hm", t: "c_e", base: { regions: { h3: "" } } }], declined: [] };
  const asked = planCollections(cs2, Tc, Hc, links, true, new Map([["h3", "Call the bank"]])).ask;
  assert.equal(asked[0].id, "place:hm:h3");
  assert.equal(asked[0].on, "tasks");
  assert.match(asked[0].title, /Call the bank/);
  cs2.pairs[0].pick = { h3: "talaris" };
  assert.deepEqual(planCollections(cs2, Tc, Hc, links).writes.filter((w) => w.op === "place").map((w) => [w.side, w.region]), [["hermes", "do"]]);
});

test("deleted in Talaris: no longer synced, never asked again, Hermes Notes' left alone", () => {
  const cs = { pairs: [{ h: "hm", t: "c_gone", base: {} }], declined: [] };
  const out = planCollections(cs, { ...T, collections: [] }, { ...H, whole: true, collections: [matrix([])] }, links);
  assert.equal(cs.pairs.length, 0);
  assert.deepEqual(cs.declined, ["hm"]);
  assert.equal(out.writes.length, 0, "nothing written to Hermes Notes");
  assert.equal(out.ask.length, 0);
});

test("a rule Talaris cannot run: the collection holds Hermes Notes' answer, kept in step", () => {
  const smart = { id: "hs", name: "Travel", kind: "list", membership: { mode: "query", query: { kind: "semantic", value: "travel", floor: 0.5 } }, members: [{ object: "h1" }, { object: "h2" }] };
  const cs = { pairs: [{ h: "hs", t: "c_s", base: {} }], declined: [] };
  const Tn = { ...T, collections: [{ id: "c_s", name: "Travel", kind: "list", membership: { mode: "explicit" }, "talaris:syncedPlugin": "hermes-sync", members: [{ object: "t2" }, { object: "t3" }] }] };
  const out = planCollections(cs, Tn, { ...H, whole: true, collections: [smart] }, links);
  assert.deepEqual(out.writes.map((w) => [w.side, w.verb, w.obj]), [["talaris", "PUT", "t1"], ["talaris", "DELETE", "t3"]]);
  assert.match(out.said.join(), /meaning/);
});

test("a Hermes Notes matrix is a matrix, a board, or nothing: its own grid, laid out by a field, or by days", async () => {
  const { kindFor, definitionOf } = await import("../collections.mjs");
  const smart = { mode: "query", query: { kind: "blockType", typeId: "h-task" } };
  const grid = { id: "g", name: "Kanban", kind: "matrix", membership: smart, properties: { "hermes:matrix_cols": 4, "hermes:matrix_rows": 1 },
    placement: { semantic: true, regions: ["backlog", "doing", "review", "done"] } };
  assert.equal(kindFor(grid, H, T), "matrix");
  assert.equal(definitionOf(grid, H, T).body.placement["talaris:columns"], 4, "one row of four");
  const byStatus = { ...grid, properties: { "hermes:matrix_bind_property": "status" } };
  assert.equal(kindFor(byStatus, H, T), "board");
  const d = definitionOf(byStatus, H, T);
  assert.equal(d.body.bind, "status");
  assert.equal(d.body.placement, undefined, "its columns are the field's options");
  assert.equal(kindFor({ ...grid, properties: { "hermes:matrix_bind_property": "@days_after" } }, H, T), null, "days as columns: nothing like it");
  assert.equal(kindFor({ ...grid, properties: { "hermes:matrix_bind_property": "duration" } }, H, T), null, "a field no profile shares");
  assert.equal(kindFor({ id: "r", kind: "rollup" }, H, T), null);
  // Asked about as what it will be.
  const asked = planCollections({ pairs: [], declined: [] }, { ...T, collections: [{ id: "c_b", name: "Mine", kind: "board", members: [] }] }, { ...H, whole: true, collections: [byStatus] }, []).ask;
  assert.equal(asked[0].title, "Kanban · board");
  assert.deepEqual(asked[0].choices.map((c) => c.key), ["bring", "t=c_b", "no"]);
});
