// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore
//
// A one-at-a-time plugin (docs/SYNC.md, *Who runs a one-at-a-time plugin*): run on one machine only, moved from
// Settings, and what it knows going with it.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const sandbox = mkdtempSync(join(tmpdir(), "talaris-plugone-"));
process.env.TALARIS_DATA_DIR = join(sandbox, "data");
process.env.TALARIS_PROJECTS = join(sandbox, "Projects");
process.env.TALARIS_CONFIG_DIR = join(sandbox, "config");
process.env.TALARIS_STATE_DIR = join(sandbox, "state");
process.env.TALARIS_PLUGINS = join(sandbox, "plugins");
process.env.TALARIS_KEY = randomBytes(32).toString("base64");

const plugins = await import("../src/plugins.js");
const records = await import("../src/records.js");

after(() => { plugins.stopPlugins(); rmSync(sandbox, { recursive: true, force: true }); });

const written: { of: string; set?: Record<string, unknown> }[] = [];
records.onWritten((r) => written.push(r as never));

test("it runs on the machine named, the others keep it idle, and moving it sends what it knows", () => {
  const dir = join(sandbox, "src", "outside");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "plugin.toml"), `id = "outside"\nname = "Outside"\nversion = "1.0.0"\ncommand = ["sleep", "30"]\n[sync]\none = true\n[backup]\nstate = ["state.json"]\n`);
  plugins.install(dir);
  assert.equal(plugins.readManifest(dir).sync?.one, true);
  records.setSyncing(true);
  plugins.enable("outside", true);
  const row = () => plugins.listPlugins().find((p) => p.id === "outside")!;
  assert.equal(row().state, "elsewhere", "syncing, not the first machine, none named: it waits to be named");
  assert.equal(row().one?.on, null);

  plugins.runHere("outside");
  const me = records.machine();
  assert.deepEqual(plugins.runnerOf("outside"), { machine: me.id, name: me.name });
  assert.ok(written.some((r) => r.of === "runner:outside" && r.set?.machine === me.id), "named, for the others");
  assert.notEqual(row().state, "elsewhere");
  assert.equal(row().one?.here, true);

  // Another machine takes it: stopped here, and what it knows sent to it.
  mkdirSync(plugins.pluginStateDir("outside"), { recursive: true });
  writeFileSync(join(plugins.pluginStateDir("outside"), "state.json"), JSON.stringify({ links: [1, 2, 3] }));
  plugins.applyRunner({ of: "runner:outside", set: { machine: "m_other", name: "Mini" }, at: { t: 1, c: 0, m: "m_other" } } as never);
  assert.equal(row().state, "elsewhere");
  assert.equal(row().one?.on, "Mini");
  const sent = written.find((r) => r.of === "pstate:outside");
  assert.equal(sent?.set?.for, "m_other");
  const sha = (sent?.set?.files as Record<string, string>)["state.json"]!;
  assert.match(sha, /^[0-9a-f]{64}$/);

  // Taken back, waiting for the other's state; it comes, is written, and it runs here again.
  plugins.runHere("outside");
  assert.equal(row().one?.waiting, true);
  assert.equal(row().state, "elsewhere", "not started before what it knows has come");
  writeFileSync(join(plugins.pluginStateDir("outside"), "state.json"), "stale");
  plugins.applyPluginState({ of: "pstate:outside", set: { for: me.id, files: { "state.json": sha } }, at: { t: 2, c: 0, m: "m_other" } } as never);
  assert.equal(readFileSync(join(plugins.pluginStateDir("outside"), "state.json"), "utf8"), JSON.stringify({ links: [1, 2, 3] }));
  assert.equal(row().one?.waiting, false);
  assert.notEqual(row().state, "elsewhere");
});

test("on another machine, it says where it runs; Start now begins from the runner's latest standby copy", () => {
  // The other machine runs it, and has left a standby copy of what it knows.
  const me = records.machine();
  plugins.applyRunner({ of: "runner:outside", set: { machine: "m_other", name: "Mini" }, at: { t: 3, c: 0, m: "m_other" } } as never);
  assert.match(plugins.notRunning("outside"), /runs on Mini, not on this machine/);
  writeFileSync(join(plugins.pluginStateDir("outside"), "state.json"), JSON.stringify({ links: ["fresh"] }));
  // Its bytes as the other machine left them (here, by this machine's own putBlob, as the folder would bring them).
  const sync = await_import();
  const bytes = Buffer.from(JSON.stringify({ links: ["standby"] }));
  const sha = sync.sha(bytes);
  sync.put(sha, bytes);
  assert.equal(plugins.applyPluginState({ of: "pstate:outside", set: { standby: true, from: "m_other", files: { "state.json": sha } }, at: { t: 4, c: 0, m: "m_other" } } as never), true);
  assert.deepEqual(plugins.pluginStateBlobs({ of: "pstate:outside", set: { standby: true, files: { "state.json": sha } } } as never), [], "a standby copy is never waited on");
  plugins.runHere("outside", true);
  assert.equal(readFileSync(join(plugins.pluginStateDir("outside"), "state.json"), "utf8"), JSON.stringify({ links: ["standby"] }));
  assert.equal(plugins.runnerOf("outside")?.machine, me.id);
});

import { createHash } from "node:crypto";
const filesMod = await import("../src/sync-files.js");
function await_import() {
  return { sha: (b: Buffer) => createHash("sha256").update(b).digest("hex"), put: (s: string, b: Buffer) => filesMod.putBlob(s, b) };
}
