// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const sandbox = mkdtempSync(join(tmpdir(), "talaris-feeds-"));
process.env.TALARIS_DATA_DIR = join(sandbox, "data");
process.env.TALARIS_PROJECTS = join(sandbox, "Projects");
process.env.TALARIS_CONFIG_DIR = join(sandbox, "config");
process.env.TALARIS_STATE_DIR = join(sandbox, "state");
process.env.TALARIS_KEY = randomBytes(32).toString("base64");

const feeds = await import("../src/calendar-feeds.js");
const view = await import("../src/calendar-view.js");
after(() => rmSync(sandbox, { recursive: true, force: true }));

test("a feed told, recolored and put away keeps its address", () => {
  assert.deepEqual(feeds.tell("bad id!", { url: "https://x/a.ics" }), { error: "No feed id" });
  assert.deepEqual(feeds.tell("f1", { url: "ftp://x" }), { error: "Not a feed's address" });
  const f = feeds.tell("f1", { url: "https://x/a.ics", name: "School", color: "#AABBCC" }) as { url: string; name: string; color?: string };
  assert.equal(f.color, "#aabbcc");
  feeds.tell("f1", { color: "#112233" });
  const gone = feeds.tell("f1", { gone: true }) as { url: string; name: string; color?: string };
  assert.equal(gone.url, "https://x/a.ics");
  assert.equal(gone.color, "#112233");
  assert.equal(gone.name, "School");
  assert.equal(feeds.feeds().f1!.gone, true);
});

test("another machine's word is kept only when newer", () => {
  feeds.applyFeed({ of: "feed:f2", set: { url: "https://y/b.ics", name: "B", at: "2026-01-02T00:00:00Z" } } as never);
  feeds.applyFeed({ of: "feed:f2", set: { url: "https://y/b.ics", name: "Older", at: "2026-01-01T00:00:00Z" } } as never);
  assert.equal(feeds.feeds().f2!.name, "B");
});

test("the shared view shows a meeting a feed and an account both have once, the account's", () => {
  view.publish({ from: 0, to: 10_000, calendars: [{ id: "acct", name: "Work" }, { id: "feed:f1", name: "Work feed", feed: true }],
    items: [
      { calendar: "acct", uid: "U1", title: "Observation", start: 100, end: 200, attendees: [{ email: "a@b.c" }] },
      { calendar: "feed:f1", uid: "U1", title: "Observation", start: 100, end: 200 },
      { calendar: "feed:f1", uid: "U2", title: "Only the feed", start: 300, end: 400 },
    ] });
  const items = view.viewRange(0, 10_000).items;
  assert.deepEqual(items.map((e) => `${e.calendar}/${e.uid}`), ["acct/U1", "feed:f1/U2"]);
});
