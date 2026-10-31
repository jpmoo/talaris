// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const sandbox = mkdtempSync(join(tmpdir(), "talaris-activity-"));
process.env.TALARIS_DATA_DIR = join(sandbox, "data");
process.env.TALARIS_CONFIG_DIR = join(sandbox, "config");
process.env.TALARIS_STATE_DIR = join(sandbox, "state");
process.env.TALARIS_KEY = randomBytes(32).toString("base64");

const act = await import("../src/activity.js");
const { localDate, addDays } = await import("../src/localtime.js");
const mcp = await import("../src/mcp.js");
after(() => rmSync(sandbox, { recursive: true, force: true }));
const dir = join(sandbox, "data", "activity");

/** Noon, `n` days ago, local. */
const daysAgo = (n: number, h = 12, m = 0) => {
  const d = new Date();
  d.setHours(h, m, 0, 0);
  d.setDate(d.getDate() - n);
  return d.getTime();
};

test("kept sealed, a file per local day, and read back oldest first", () => {
  act.appendAct({ verb: "window.open", app: "firefox", project: "secretproj", title: "  Bank of Nowhere  " }, daysAgo(1));
  act.appendAct({ verb: "launcher.pick", target: "app:zed" }, daysAgo(0, 9));
  act.appendAct({ verb: "window.focus", app: "zed", project: "", seconds: 120 }, daysAgo(0, 10));
  const files = readdirSync(dir).sort();
  assert.deepEqual(files, [`${localDate(new Date(daysAgo(1)))}.sealed`, `${localDate()}.sealed`].sort());
  for (const f of files) {
    const raw = readFileSync(join(dir, f));
    assert.ok(!raw.includes("firefox") && !raw.includes("Bank of") && !raw.includes("launcher") && !raw.includes("zed"), `${f} is plain`);
  }
  act.forgetLoadedActivity();
  const all = act.listActs(7);
  assert.deepEqual(all.map((a) => a.verb), ["window.open", "launcher.pick", "window.focus"]);
  assert.equal(all[0]!.title, "Bank of Nowhere");
  assert.equal(all[2]!.project, "");
  assert.deepEqual(act.listActs(1).map((a) => a.verb), ["launcher.pick", "window.focus"]);
  assert.deepEqual(act.listActs(7, 1).map((a) => a.verb), ["window.focus"]);
  act.clearActs();
  assert.equal(act.listActs(7).length, 0);
});

test("a bad verb, a bad field or bad seconds is refused; a long title cut short", () => {
  for (const verb of ["", "Window.open", "1open", "a".repeat(41), "has space"]) assert.throws(() => act.appendAct({ verb }));
  assert.throws(() => act.appendAct({ verb: "x", seconds: 1.5 }));
  assert.throws(() => act.appendAct({ verb: "x", seconds: 86401 }));
  assert.throws(() => act.appendAct({ verb: "x", seconds: -1 }));
  assert.throws(() => act.appendAct({ verb: "x", app: 3 }));
  const a = act.appendAct({ verb: "some.new-verb", title: "t".repeat(500), app: "   " });
  assert.equal(a.title!.length, 300);
  assert.equal(a.app, undefined);
  assert.ok(Math.abs(a.at - Date.now()) < 5000);
  act.clearActs();
});

test("days older than keep go, at once when keep changes", () => {
  act.setActivitySettings({ keep: 90, share: "summary" });
  act.appendAct({ verb: "old" }, daysAgo(100));
  act.appendAct({ verb: "edge" }, daysAgo(90));
  act.appendAct({ verb: "recent" }, daysAgo(10));
  assert.equal(readdirSync(dir).filter((f) => /^\d{4}/.test(f)).length, 3);
  act.setActivitySettings({ keep: 90 });
  const left = readdirSync(dir).filter((f) => /^\d{4}/.test(f)).sort();
  assert.deepEqual(left, [`${addDays(localDate(), -90)}.sealed`, `${localDate(new Date(daysAgo(10)))}.sealed`]);
  act.setActivitySettings({ keep: 30 });
  assert.deepEqual(readdirSync(dir).filter((f) => /^\d{4}/.test(f)), [`${localDate(new Date(daysAgo(10)))}.sealed`]);
  assert.throws(() => act.setActivitySettings({ share: "everyone" }));
  assert.throws(() => act.setActivitySettings({ keep: 0 }));
  act.forgetLoadedActivity();
  assert.deepEqual(act.activitySettings(), { keep: 30, share: "summary" });
  act.clearActs();
  assert.ok(existsSync(join(dir, "settings.sealed")));
});

test("the summary counts opens, sends, together, focus, projects and the launcher", () => {
  const t = (m: number) => daysAgo(2, 9, m);
  const acts: Record<string, unknown>[] = [
    // Twice: firefox then zed, a minute apart, in proj — together twice.
    { verb: "app.open", app: "firefox", project: "proj", at: t(0) },
    { verb: "window.open", app: "zed", project: "proj", at: t(1) },
    { verb: "window.open", app: "firefox", project: "proj", at: t(30) },
    { verb: "window.open", app: "zed", project: "proj", at: t(32) },
    // Within three minutes but in another project: not together with those.
    { verb: "window.open", app: "slack", project: "other", at: t(31) },
    // Same app twice: no pair.
    { verb: "window.open", app: "zed", project: "proj", at: t(33) },
    { verb: "window.send", app: "slack", project: "proj", to: "comms", at: t(40) },
    { verb: "window.send", app: "slack", project: "proj", to: "comms", at: t(41) },
    { verb: "window.focus", app: "zed", project: "proj", seconds: 600, at: t(50) },
    { verb: "window.focus", app: "zed", project: "proj", seconds: 300, at: t(51) },
    { verb: "window.focus", app: "slack", project: "comms", seconds: 60, at: t(52) },
    { verb: "project.go", to: "comms", at: t(53) },
    { verb: "project.go", to: "comms", at: t(54) },
    { verb: "launcher.pick", target: "app:zed", at: t(55) },
  ];
  for (const { at, ...a } of acts) act.appendAct(a, at as number);
  const s = act.activitySummary(7);
  assert.equal(s.days, 7);
  assert.equal(s.total, acts.length);
  assert.equal(s.verbs["window.open"], 5);
  assert.equal(s.byHour[9], acts.length);
  assert.equal(s.byWeekday[new Date(t(0)).getDay()], acts.length);
  assert.deepEqual(s.opens[0], { app: "zed", project: "proj", count: 3 });
  assert.deepEqual(s.opens.find((o) => o.app === "firefox"), { app: "firefox", project: "proj", count: 2 });
  assert.deepEqual(s.sends, [{ app: "slack", from: "proj", to: "comms", count: 2 }]);
  // zed at :33 also falls within three minutes of firefox at :30: a third.
  assert.deepEqual(s.together, [{ a: "firefox", b: "zed", count: 3 }]);
  assert.deepEqual(s.focus, [{ app: "zed", project: "proj", seconds: 900 }, { app: "slack", project: "comms", seconds: 60 }]);
  assert.deepEqual(s.projects, [{ project: "proj", goes: 0, seconds: 900 }, { project: "comms", goes: 2, seconds: 60 }]);
  assert.deepEqual(s.launcher, [{ target: "app:zed", count: 1 }]);
  assert.equal(act.activitySummary(1).total, 0);
  act.clearActs();
});

test("a pair opened together only once is not shown", () => {
  const s = act.summarize([
    { at: 0, verb: "window.open", app: "b", project: "p" },
    { at: 1000, verb: "window.open", app: "a", project: "p" },
  ], 1, 0, 1);
  assert.deepEqual(s.together, []);
});

test("dismissed suggestions are kept, once each, and outlast clearing the log", () => {
  act.dismissSuggestion("pin:zed:proj");
  act.dismissSuggestion(" pin:zed:proj ");
  act.dismissSuggestion("keep:slack:comms");
  assert.throws(() => act.dismissSuggestion(""));
  act.clearActs();
  act.forgetLoadedActivity();
  assert.deepEqual(act.dismissedSuggestions(), ["pin:zed:proj", "keep:slack:comms"]);
  assert.ok(!readFileSync(join(dir, "dismissed.sealed")).includes("zed"));
});

test("what Morgan is told follows share", () => {
  const s = act.summarize([{ at: Date.now(), verb: "window.open", app: "zed", project: "p" }], 30, 0, Date.now());
  const entries = [{ at: Date.now(), verb: "window.open", app: "zed", project: "p" }];
  assert.equal(act.patternsSaid("local", s), act.KEPT_LOCAL);
  assert.match(act.patternsSaid("summary", s), /zed in p: 1/);
  assert.match(act.patternsSaid("raw", s), /As JSON/);
  assert.equal(act.logSaid("local", entries), act.LOG_NOT_SHARED);
  assert.equal(act.logSaid("summary", entries), act.LOG_NOT_SHARED);
  assert.match(act.logSaid("raw", entries), /window\.open zed in p/);
  assert.equal(act.mayRead("local", "summary"), false);
  assert.equal(act.mayRead("summary", "raw"), false);
  assert.equal(act.mayRead("raw", "raw"), true);
});

test("the activity tools are Morgan's alone: no other client sees or calls them", async () => {
  const names = (c: string) => mcp.toolsFor(c).map((t) => t.name);
  assert.ok(names("heymorgan").includes("work_patterns") && names("heymorgan").includes("work_log"));
  for (const t of mcp.toolsFor("heymorgan").filter((t) => t.name.startsWith("work_"))) {
    assert.equal(t.annotations.readOnlyHint, true);
    assert.match(t.description, /never be passed to the Oracle/);
  }
  for (const other of ["", "claude-code", "claude-ai", "oracle", "HeyMorgan", "heymorgan "]) {
    assert.ok(!names(other).some((n) => n.startsWith("work_")), `${other || "(none)"} sees them`);
    assert.equal(await mcp.callTool(other, "work_patterns", {}), null);
    assert.equal(await mcp.callTool(other, "work_log", { days: 7 }), null);
  }
  // Where the person is: Morgan's alone too, and said to stay with it.
  const where = mcp.toolsFor("heymorgan").find((t) => t.name === "where");
  assert.ok(where && where.annotations.readOnlyHint && /never be passed to the Oracle/.test(where.description));
  for (const other of ["", "claude-code", "oracle", "heymorgan "]) {
    assert.ok(!names(other).includes("where"), `${other || "(none)"} sees where`);
    assert.equal(await mcp.callTool(other, "where", {}), null);
  }
  // The rest are anyone's.
  assert.ok(names("claude-code").includes("talaris_find"));
});
