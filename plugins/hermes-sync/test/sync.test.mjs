// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore
//
// The sync's plan, on two made-up libraries shaped like Talaris's and Hermes
// Notes' — different field names, different statuses, one date span against
// two dates — so every rule is measured without either app running.

import { test } from "node:test";
import assert from "node:assert/strict";
import { plan, agreed } from "../sync.mjs";

const T_TYPES = [
  { id: "t_task", fields: [{ key: "title", kind: "text" }, { key: "schedule", kind: "datespan" },
    { key: "status", kind: "enum", options: ["not_started", "in_progress", "done", "wont_do"] }, { key: "project", kind: "reference", many: true }],
    profiles: { task: { title: "title", start: { field: "schedule", part: "start" }, due: { field: "schedule", part: "end" }, status: "status", completeValues: ["done", "wont_do"], project: "project" } } },
  { id: "t_project", fields: [{ key: "title", kind: "text" }, { key: "description", kind: "richtext" }], profiles: { project: { title: "title", body: "description" } } },
  { id: "t_person", fields: [{ key: "title", kind: "text" }, { key: "emails", kind: "text", many: true }, { key: "notes", kind: "richtext" }],
    profiles: { contact: { title: "title", email: "emails", body: "notes" } } },
  // An event type, as both apps have: events do not sync, so nothing of its may be made or written.
  { id: "t_event", fields: [{ key: "title", kind: "text" }, { key: "start", kind: "datetime" }], profiles: { event: { title: "title", start: "start" } } },
];
const H_TYPES = [
  { id: "h-task", fields: [{ key: "title", kind: "text" }, { key: "status", kind: "enum", options: ["not done", "done"] },
    { key: "proj", kind: "reference", many: true }, { key: "when", kind: "datespan" }],
    profiles: { task: { title: "title", status: "status", completeValues: ["done"], project: "proj", start: { field: "when", part: "start" }, due: { field: "when", part: "end" } } } },
  { id: "h-project", fields: [{ key: "title", kind: "text" }, { key: "about", kind: "richtext" }], profiles: { project: { title: "title", body: "about" } } },
  { id: "h-person", fields: [{ key: "name", kind: "text" }, { key: "mail", kind: "text" }], profiles: { contact: { title: "name", email: "mail" } } },
  { id: "h-event", fields: [{ key: "title", kind: "text" }, { key: "span", kind: "datespan" }], profiles: { event: { title: "title", start: { field: "span", part: "start" }, end: { field: "span", part: "end" } } } },
];
const env = (types, objects) => ({ types, objects, cursor: "x.1" });
const S = { mode: "merge", kinds: {}, people: "known" };
let n = 0;
const newId = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;

test("the first time: certain matches made, unsure ones asked, and nothing written until the plan is started", () => {
  const T = env(T_TYPES, [
    { id: "tp1", type: "t_project", properties: { title: "Retreat" }, version: 1 },
    { id: "tc1", type: "t_person", properties: { title: "Rosa Diaz", emails: ["Rosa@99.example"] }, version: 1 },
    { id: "tc2", type: "t_person", properties: { title: "Amy Santiago", emails: ["amy@99.example"] }, version: 1 },
  ]);
  const H = env(H_TYPES, [
    { id: "hp1", type: "h-project", properties: { title: "retreat" }, version: 3 },
    { id: "hc1", type: "h-person", properties: { name: "R. Diaz", mail: "rosa@99.example" }, version: 1 },
    { id: "hc2", type: "h-person", properties: { name: "Amy Santiago" }, version: 1 },
  ]);
  const p = plan({ started: false, links: [] }, T, H, S, newId);
  assert.equal(p.writes.length, 0, "nothing written the first time");
  assert.deepEqual(p.links.map((l) => [l.t, l.h]).sort(), [["tc1", "hc1"], ["tp1", "hp1"]], "a project by its name, a person by an address, case aside");
  assert.equal(p.ask.length, 1);
  assert.equal(p.ask[0].id, "same:contact:tc2:hc2", "the same name and no address: asked, not assumed");
  // Decided apart: the plan is put to the person, with what it will make.
  const p2 = plan({ started: false, links: p.links, apart: [["tc2", "hc2"]] }, T, H, S, newId);
  assert.equal(p2.ask[0].id, "start");
  assert.match(p2.ask[0].detail, /2 matched\. 0 to make in Hermes Notes, 1 to make in Talaris/, "Talaris's people go to Hermes only when the setting says everyone");
});

test("after it starts: made on one side, made on the other — its project followed, its status in the other's words", () => {
  const links = [{ kind: "project", t: "tp1", h: "hp1", base: { title: '"Retreat"', body: null } }];
  const T = env(T_TYPES, [
    { id: "tp1", type: "t_project", properties: { title: "Retreat" }, version: 1 },
    { id: "tt1", type: "t_task", properties: { title: "Book the room", status: "done", project: ["tp1"], schedule: { end: "2026-11-01" } }, version: 1 },
  ]);
  const H = env(H_TYPES, [
    { id: "hp1", type: "h-project", properties: { title: "Retreat" }, version: 1 },
    { id: "ht1", type: "h-task", properties: { title: "Order food", status: "not done", proj: ["hp1"] }, version: 2 },
  ]);
  const p = plan({ started: true, links }, T, H, S, newId);
  const toH = p.writes.find((w) => w.side === "hermes" && w.op === "put");
  assert.deepEqual(toH.body, { type: "h-task", properties: { title: "Book the room", status: "done", proj: ["hp1"], when: { end: "2026-11-01" } } });
  const toT = p.writes.find((w) => w.side === "talaris" && w.op === "put");
  assert.equal(toT.id, "ht1", "made in Talaris at Hermes' own id");
  assert.deepEqual(toT.body.properties, { title: "Order food", status: "not_started", project: ["tp1"] });
  const H2 = env(H_TYPES, [{ ...H.objects[1], url: "https://h.example/block/ht1" }]);
  const withLink = plan({ started: true, links }, T, H2, S, newId).writes.find((w) => w.side === "talaris" && w.op === "put");
  assert.deepEqual(withLink.body.properties["hermes-sync:link"], { url: "https://h.example/block/ht1", label: "Hermes Notes" }, "made with its way back");
});

test("merge: a change on one side is carried; on both, it is asked; the person's pick is carried once", () => {
  const T = env(T_TYPES, [{ id: "tt1", type: "t_task", properties: { title: "Book the hall", status: "in_progress", schedule: { start: "2026-10-01", end: "2026-11-01" } }, version: 4 }]);
  const H = env(H_TYPES, [{ id: "ht1", type: "h-task", properties: { title: "Book the room", status: "not done", when: { start: "2026-10-01", end: "2026-11-05" } }, version: 9 }]);
  const base = { title: '"Book the room"', complete: "false", start: '"2026-10-01"', due: '"2026-11-01"', project: null };
  const links = [{ kind: "task", t: "tt1", h: "ht1", base: { ...base } }];
  const p = plan({ started: true, links }, T, H, S, newId);
  const toH = p.writes.find((w) => w.side === "hermes");
  assert.deepEqual(toH.patch, { set: { title: "Book the hall" }, version: 9 }, "Talaris changed the title: carried to Hermes; in progress and not done agree");
  const toT = p.writes.find((w) => w.side === "talaris");
  assert.deepEqual(toT.patch, { set: { schedule: { start: "2026-10-01", end: "2026-11-05" } }, version: 4 }, "Hermes moved the due date: the span's other half kept");
  // Both change the title: asked.
  const T2 = env(T_TYPES, [{ ...T.objects[0], properties: { ...T.objects[0].properties, schedule: { start: "2026-10-01", end: "2026-11-01" } } }]);
  const H2 = env(H_TYPES, [{ ...H.objects[0], properties: { ...H.objects[0].properties, title: "Book a room", when: { start: "2026-10-01", end: "2026-11-01" } } }]);
  const p2 = plan({ started: true, links: [{ kind: "task", t: "tt1", h: "ht1", base: { ...base } }] }, T2, H2, S, newId);
  assert.equal(p2.writes.length, 0);
  assert.equal(p2.ask[0].id, "conflict:tt1:title");
  assert.deepEqual(p2.ask[0].fields[0], { label: "Name", here: "Book the hall", there: "Book a room" });
  const p3 = plan({ started: true, links: [{ kind: "task", t: "tt1", h: "ht1", base: { ...base }, pick: { title: "hermes" } }] }, T2, H2, S, newId);
  assert.deepEqual(p3.writes[0].patch.set, { title: "Book a room" });
  agreed(p3.writes[0].link, p3.writes[0].slots, p3.writes[0].values);
  assert.equal(p3.links[0].base.title, '"Book a room"', "what they now agree on");
});

test("matched the first time, one side empty: the gap is filled, not asked about", () => {
  const T = env(T_TYPES, [{ id: "tc1", type: "t_person", properties: { title: "Rosa Diaz", emails: ["rosa@99.example"] }, version: 1 }]);
  const H = env(H_TYPES, [{ id: "hc1", type: "h-person", properties: { name: "Rosa Diaz", mail: "rosa@99.example" }, version: 1 }]);
  const T2 = env(T_TYPES, [{ ...T.objects[0], properties: { ...T.objects[0].properties, notes: "Prefers mornings" } }]);
  const p = plan({ started: true, links: [{ kind: "contact", t: "tc1", h: "hc1", base: {} }] }, T2, H, S, newId);
  assert.equal(p.ask.length, 0);
  // Hermes' person has no body slot here, so nothing to carry; names and addresses agree.
  assert.equal(p.writes.length, 0);
  const H2 = env(H_TYPES, [{ ...H.objects[0], properties: { name: "Rosa Diaz" } }]);
  const p2 = plan({ started: true, links: [{ kind: "contact", t: "tc1", h: "hc1", base: {} }] }, T, H2, S, newId);
  assert.deepEqual(p2.writes[0].patch.set, { mail: "rosa@99.example" }, "Hermes' empty address filled from Talaris");
});

test("replace: one side wins every difference, and what only the other has is left alone", () => {
  const T = env(T_TYPES, [{ id: "tt1", type: "t_task", properties: { title: "Mine" }, version: 1 }, { id: "tt2", type: "t_task", properties: { title: "Only here" }, version: 1 }]);
  const H = env(H_TYPES, [{ id: "ht1", type: "h-task", properties: { title: "Theirs" }, version: 1 }]);
  const links = () => [{ kind: "task", t: "tt1", h: "ht1", base: { title: '"Mine"' } }];
  const hermesWins = plan({ started: true, links: links() }, T, H, { ...S, mode: "hermes" }, newId);
  assert.deepEqual(hermesWins.writes.map((w) => [w.side, w.op, w.patch?.set]), [["talaris", "patch", { title: "Theirs" }]]);
  assert.equal(hermesWins.summary.left, 1, "Talaris's own task is left, not deleted");
  const talarisWins = plan({ started: true, links: links() }, T, H, { ...S, mode: "talaris" }, newId);
  assert.deepEqual(talarisWins.writes.map((w) => [w.side, w.op]), [["hermes", "patch"], ["hermes", "put"]]);
});

test("events do not sync, either way", () => {
  const T = env(T_TYPES, [{ id: "e1", type: "t_event", properties: { title: "Meeting", start: "2026-10-20T09:00" }, version: 1 }]);
  const H = env(H_TYPES, [{ id: "he1", type: "h-event", properties: { title: "Retreat", span: { start: "2026-11-01" } }, version: 1 }]);
  const p = plan({ started: true, links: [] }, T, H, S, newId);
  assert.equal(p.writes.length, 0);
});

test("a thing deleted on one side: asked about, never made again unasked, never deleted on the other", () => {
  const T = env(T_TYPES, [{ id: "tt1", type: "t_task", properties: { title: "Still here" }, version: 1 }]);
  const p = plan({ started: true, links: [{ kind: "task", t: "tt1", h: "gone", base: {} }] }, T, env(H_TYPES, []), S, newId);
  assert.equal(p.writes.length, 0, "not made again in Hermes without asking");
  assert.equal(p.ask[0].id, "gone:task:tt1");
  assert.match(p.ask[0].title, /Deleted in Hermes Notes/);
  // Kept here only: never carried again.
  const p2 = plan({ started: true, links: [], only: ["tt1"] }, T, env(H_TYPES, []), S, newId);
  assert.equal(p2.writes.length, 0);
});

// ------------------------------------------------------------ notes, and files

const NOTE_T = [{ id: "t_note", fields: [{ key: "title", kind: "text" }, { key: "body", kind: "richtext" }, { key: "files", kind: "attachment", many: true }],
  profiles: { note: { title: "title", body: "body" } } }];
const NOTE_H = [{ id: "h-text", fields: [{ key: "title", kind: "text" }, { key: "today_note", kind: "date" }, { key: "attach", kind: "attachment", many: true }],
  profiles: { note: { title: "title", body: "content" }, journal: { date: "today_note" } } }];
const SHA = (c) => c.repeat(64);
const file = (c, name) => ({ kind: "attachment", filename: name, mediaType: "text/plain", sha256: SHA(c) });

test("notes: only Talaris's undated ones and Hermes Notes' that are not a day's page; words between a field and the body slot", () => {
  const T = env(NOTE_T, [
    { id: "tn1", type: "t_note", "talaris:undated": true, properties: { title: "Ideas", body: "from Talaris" }, version: 1 },
    { id: "tn2", type: "t_note", properties: { title: "A canvas note's mentions" }, version: 1 },
  ]);
  const H = env(NOTE_H, [
    { id: "hn1", type: "h-text", properties: { title: "Reading list" }, content: "from Hermes", version: 1 },
    { id: "hn2", type: "h-text", properties: { title: "Thursday", today_note: "2026-10-08" }, content: "a day's page", version: 1 },
  ]);
  const p = plan({ started: true, links: [] }, T, H, { ...S, kinds: { note: true }, notes: "all" }, newId);
  const toH = p.writes.find((w) => w.side === "hermes");
  const toT = p.writes.find((w) => w.side === "talaris");
  assert.equal(p.writes.length, 2, "the canvas note's entity and the day's page stay where they are");
  assert.equal(toH.body.content, "from Talaris", "Talaris's body field becomes Hermes Notes' body slot");
  assert.equal(toT.id, "hn1");
  assert.equal(toT.body.properties.body, "from Hermes", "and back");
});

test("notes, tagged: on either side, only notes wearing a tag named take part", () => {
  const T = env(NOTE_T, [
    { id: "tn1", type: "t_note", "talaris:undated": true, properties: { title: "Out" }, tags: ["talaris"], version: 1 },
    { id: "tn2", type: "t_note", "talaris:undated": true, properties: { title: "Stays in Talaris" }, version: 1 },
  ]);
  const H = env(NOTE_H, [
    { id: "hn1", type: "h-text", properties: { title: "Tagged" }, tags: ["talaris"], version: 1 },
    { id: "hn2", type: "h-text", properties: { title: "Not tagged" }, tags: ["work"], version: 1 },
  ]);
  const p = plan({ started: true, links: [] }, T, H, { ...S, kinds: { note: true }, notes: "tagged", noteTags: ["talaris", "shared"] }, newId);
  assert.deepEqual(p.writes.filter((w) => w.side === "talaris").map((w) => w.id), ["hn1"]);
  assert.deepEqual(p.writes.find((w) => w.side === "hermes").body.tags, ["talaris"]);
});

test("files: added on one side, the field written whole on the other and the file handed over; taken off, taken off there too", () => {
  const links = [{ kind: "note", t: "tn1", h: "hn1", base: { title: '"Plan"', body: '"words"', files: null } }];
  const base = (files, hfiles) => [
    env(NOTE_T, [{ id: "tn1", type: "t_note", "talaris:undated": true, properties: { title: "Plan", body: "words", ...(files ? { files } : {}) }, version: 2 }]),
    env(NOTE_H, [{ id: "hn1", type: "h-text", properties: { title: "Plan", ...(hfiles ? { attach: hfiles } : {}) }, content: "words", version: 4 }]),
  ];
  // Added in Talaris: Hermes Notes' attachment field set, the file listed to hand over first.
  let [T, H] = base([file("a", "brief.pdf")], null);
  // Neither side offering files by hash: nothing about them is carried.
  assert.equal(plan({ started: true, links: structuredClone(links) }, T, H, { ...S, kinds: { note: true }, notes: "all" }, newId).writes.length, 0);
  let p = plan({ started: true, links: structuredClone(links) }, T, H, { ...S, kinds: { note: true }, notes: "all", files: true }, newId);
  const w = p.writes.find((x) => x.side === "hermes");
  assert.deepEqual(w.patch.set.attach.map((a) => a.sha256), [SHA("a")]);
  assert.equal(w.patch.set.attach[0].bytes, undefined, "never the bytes in a write: they go by hash");
  assert.deepEqual(w.files.map((f) => f.sha256), [SHA("a")]);
  agreed(p.links[0], w.slots, w.values);
  // Renamed on the other side, it is the same file: nothing to carry.
  [T, H] = base([file("a", "brief.pdf")], [file("a", "Brief (final).pdf")]);
  p = plan({ started: true, links: p.links }, T, H, { ...S, kinds: { note: true }, notes: "all", files: true }, newId);
  assert.equal(p.writes.length, 0);
  // Taken off in Hermes Notes: taken off in Talaris.
  [T, H] = base([file("a", "brief.pdf")], null);
  p = plan({ started: true, links: p.links }, T, H, { ...S, kinds: { note: true }, notes: "all", files: true }, newId);
  const off = p.writes.find((x) => x.side === "talaris");
  assert.deepEqual(off.patch.unset, ["files"]);
});

test("a body changed in Talaris goes to Hermes Notes in the patch's body, not as a property", () => {
  const links = [{ kind: "note", t: "tn1", h: "hn1", base: { title: '"Plan"', body: '"old"', files: null } }];
  const T = env(NOTE_T, [{ id: "tn1", type: "t_note", "talaris:undated": true, properties: { title: "Plan", body: "new" }, version: 2 }]);
  const H = env(NOTE_H, [{ id: "hn1", type: "h-text", properties: { title: "Plan" }, content: "old", version: 4 }]);
  const p = plan({ started: true, links }, T, H, { ...S, kinds: { note: true }, notes: "all" }, newId);
  const w = p.writes.find((x) => x.side === "hermes");
  assert.equal(w.patch.content, "new");
  assert.equal(w.patch.set, undefined);
});

test("tags travel as moves: added and taken off on one side, the same on the other, and a tag the other never said is left", () => {
  const links = [{ kind: "note", t: "tn1", h: "hn1", base: { title: '"Plan"', body: null, files: null, tags: '["budget"]' } }];
  const T = env(NOTE_T, [{ id: "tn1", type: "t_note", "talaris:undated": true, properties: { title: "Plan" }, tags: ["board"], version: 2 }]);
  const H = env(NOTE_H, [{ id: "hn1", type: "h-text", properties: { title: "Plan" }, tags: ["budget"], version: 4 }]);
  const p = plan({ started: true, links }, T, H, { ...S, kinds: { note: true }, notes: "all" }, newId);
  const w = p.writes.find((x) => x.side === "hermes");
  assert.deepEqual(w.patch.addTags, ["board"]);
  assert.deepEqual(w.patch.removeTags, ["budget"]);
  assert.equal(w.patch.set, undefined, "tags are not properties");
});
