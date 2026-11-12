// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const sandbox = mkdtempSync(join(tmpdir(), "talaris-cal-"));
process.env.TALARIS_DATA_DIR = join(sandbox, "data");
process.env.TALARIS_PROJECTS = join(sandbox, "Projects");
process.env.TALARIS_CONFIG_DIR = join(sandbox, "config");
process.env.TALARIS_STATE_DIR = join(sandbox, "state");
process.env.TALARIS_KEY = randomBytes(32).toString("base64");

const tasks = await import("../src/tasks.js");
const lists = await import("../src/lists.js");
const entities = await import("../src/entities.js");

after(() => rmSync(sandbox, { recursive: true, force: true }));

test("the calendar's tasks: each whose span from available to due touches the days on show", () => {
  const long = tasks.createTask({ title: "Write the report", start: "2026-11-02", due: "2026-11-05" });
  const dueOnly = tasks.createTask({ title: "Call the bank", due: "2026-11-04T15:00" });
  tasks.createTask({ title: "Later", start: "2026-11-09", due: "2026-11-10" });
  tasks.createTask({ title: "Undated" });
  const week = lists.tasksOnDays("2026-11-03", "2026-11-04").map((r) => r.title);
  assert.deepEqual(week, ["Write the report"], "a day inside a span");
  assert.deepEqual(lists.tasksOnDays("2026-11-01", "2026-11-08").map((r) => r.title), ["Write the report", "Call the bank"]);
  tasks.setDone(long.id, true);
  assert.equal(lists.tasksOnDays("2026-11-01", "2026-11-08").find((r) => r.id === long.id)!.complete, true, "done ones stay, ticked");
  assert.ok(dueOnly);
});

test("ticked done and opened again by what the type says; moved by whole days, times kept", () => {
  const t = tasks.createTask({ title: "Plan the retreat", start: "2026-11-02", due: "2026-11-03T09:30" });
  const shape = tasks.shapeOf(entities.getEntity(t.id))!;
  tasks.setDone(t.id, true);
  assert.ok(shape.complete.includes(String(entities.getEntity(t.id).properties[shape.statusKey])));
  tasks.setDone(t.id, false);
  assert.ok(!shape.complete.includes(String(entities.getEntity(t.id).properties[shape.statusKey])));
  tasks.shiftTask(t.id, 30);
  assert.deepEqual(tasks.spanOf(entities.getEntity(t.id)), { start: "2026-12-02", due: "2026-12-03T09:30" });
  tasks.shiftTask(t.id, -1);
  assert.deepEqual(tasks.spanOf(entities.getEntity(t.id)), { start: "2026-12-01", due: "2026-12-02T09:30" });
});

test("asked for, an open task past its due comes too, wherever its dates fall; a done one does not", () => {
  const late = tasks.createTask({ title: "Long overdue", start: "2020-01-01", due: "2020-01-03" });
  const doneLate = tasks.createTask({ title: "Done long ago", due: "2020-01-02" });
  tasks.setDone(doneLate.id, true);
  const far = "2099-01-01", farther = "2099-01-08";
  assert.equal(lists.tasksOnDays(far, farther).some((r) => r.id === late.id), false, "not unless asked");
  const got = lists.tasksOnDays(far, farther, true);
  assert.equal(got.find((r) => r.id === late.id)?.overdue, true);
  assert.equal(got.some((r) => r.id === doneLate.id), false);
});

test("Talaris's own calendar: its events drawn on it, a feed's made yours remembered, and none on a plugin's", async () => {
  const own = await import("../src/own-calendar.js");
  const plugins = await import("../src/plugins.js");
  const mine = entities.createEntity({ role: "event", "talaris:calendar": "talaris", "talaris:fromFeed": "feed1/uid9/",
    properties: { title: "Game night", start: "2026-11-20T19:00:00", end: "2026-11-20T21:00:00", "hermes-sync:link": { url: "https://h.example/block/x" } } });
  entities.createEntity({ role: "event", "talaris:calendar": "talaris", properties: { title: "Field trip", start: "2026-11-21", end: "2026-11-21" } });
  entities.createEntity({ role: "event", sources: [{ kind: "eds-event", key: "work/se1" }], properties: { title: "Someone else's", start: "2026-11-20T10:00:00" } });
  const from = new Date(2026, 10, 19).getTime(), to = new Date(2026, 10, 23).getTime();
  const drawn = own.ownEvents(from, to);
  assert.deepEqual(drawn.map((e) => e.title).sort(), ["Field trip", "Game night"], "only its own");
  const night = drawn.find((e) => e.title === "Game night")!;
  assert.equal(night.calendar, "talaris");
  assert.equal(night.entity, mine.id);
  assert.equal(night.start, new Date(2026, 10, 20, 19, 0).getTime(), "a time where you are");
  const trip = drawn.find((e) => e.title === "Field trip")!;
  assert.equal(trip.allDay, true);
  assert.equal((trip.end as number) - (trip.start as number), 24 * 60 * 60 * 1000, "a day's end is the start of the next");
  assert.deepEqual(own.takenElsewhere(), ["feed1/uid9/"]);
  assert.equal(own.ownCalendar().writable, true);
  // Linked by a sync or not, it is never drawn again on a plugin's calendar.
  assert.ok(!plugins.pluginCalendarEvents(from, to).some((e) => e.entity === mine.id));
  entities.updateEntity(mine.id, { archived: true });
  assert.deepEqual(own.takenElsewhere(), [], "archived: the feed's own shows again");
});

test("an event no account keeps is on Talaris's own calendar; a synced one an account also keeps is joined to it", async () => {
  const own = await import("../src/own-calendar.js");
  const type = entities.typeFor("event")!;
  // From another app, through its sync: no account keeps it.
  const fromSync = entities.createEntity({ type: type.id, properties: { title: "Admin Council", start: "2026-11-19T15:30:00", "hermes-sync:link": { url: "https://h.example/b/1", label: "Hermes Notes" } } });
  const alone = entities.createEntity({ type: type.id, properties: { title: "Dentist", start: "2026-11-20T10:00:00", "hermes-sync:link": { url: "https://h.example/b/2", label: "Hermes Notes" } } });
  assert.ok(own.isOwnEvent(fromSync) && own.isOwnEvent(alone), "on Talaris's own calendar, unmarked");
  // The same meeting, as the account's calendar has it: mirrored, a minute's precision.
  const fromAccount = entities.mirrorEvent({ source: { kind: "eds-event", key: "work/ac1" }, title: "Admin Council", start: "2026-11-19T15:30", end: "2026-11-19T16:30" });
  assert.ok(!own.isOwnEvent(fromAccount), "an account's is the account's");
  assert.equal(own.joinAccountTwins(), 1, "the twin joined; the one alone left alone");
  const kept = entities.getEntity(fromSync.id);
  assert.ok(own.isOwnEvent(kept), "Talaris's still, on its own calendar");
  assert.ok(own.takenElsewhere().includes("work/ac1/"), "the account's copy not shown beside it");
  // Mirrored with its UID too, the same meeting is not shown from another calendar or a feed publishing one.
  entities.mirrorEvent({ source: { kind: "eds-event", key: "work/ac1" }, also: [{ kind: "ical-uid", key: "uid-ac1" }], title: "Admin Council", start: "2026-11-19T16:00" });
  assert.ok(own.takenElsewhere().includes("*/uid-ac1/"));
  assert.ok(kept.properties["hermes-sync:link"], "still kept in step by the sync");
  // The account moves it: the mirror finds the kept one by its source, and it follows.
  const moved = entities.mirrorEvent({ source: { kind: "eds-event", key: "work/ac1" }, title: "Admin Council", start: "2026-11-19T16:00", end: "2026-11-19T17:00" });
  assert.equal(moved.id, fromSync.id);
  assert.equal(entities.getEntity(fromSync.id).properties.start, "2026-11-19T16:00");
  assert.equal(own.joinAccountTwins(), 0, "nothing left to join");
  // Marked as Talaris's (copied in from a feed, say) and then joined: the account's all the same.
  const marked = entities.createEntity({ type: type.id, "talaris:calendar": "talaris", properties: { title: "Advisory", start: "2026-11-24T13:30:00", "hermes-sync:link": { url: "https://h.example/b/3" } } });
  entities.mirrorEvent({ source: { kind: "eds-event", key: "work/adv" }, title: "Advisory", start: "2026-11-24T13:30" });
  assert.equal(own.joinAccountTwins(), 1);
  assert.ok(own.isOwnEvent(entities.getEntity(marked.id)));
  assert.ok(own.takenElsewhere().includes("work/adv/"), "drawn once: the account's copy is not");
  // A series is never joined to one meeting: its entity's start moves on to the next.
  entities.createEntity({ type: type.id, properties: { title: "Weekly", start: "2026-11-23T09:00:00", "hermes-sync:link": { url: "https://h.example/b/4" } } });
  entities.mirrorEvent({ source: { kind: "eds-event", key: "work/wk" }, title: "Weekly", start: "2026-11-23T09:00", recurring: true });
  assert.equal(own.joinAccountTwins(), 0);
  // One joined that its account later shows to be a series: its own meeting's times stay.
  const joined = entities.mirrorEvent({ source: { kind: "eds-event", key: "work/ac1" }, title: "Admin Council", start: "2026-11-26T16:00", recurring: true });
  assert.equal(joined.id, fromSync.id);
  assert.equal(entities.getEntity(fromSync.id).properties.start, "2026-11-19T16:00");
  assert.ok(own.isOwnEvent(entities.getEntity(alone.id)));
});
