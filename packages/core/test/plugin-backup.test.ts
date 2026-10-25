// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const sandbox = mkdtempSync(join(tmpdir(), "talaris-plugbak-"));
process.env.TALARIS_DATA_DIR = join(sandbox, "data");
process.env.TALARIS_PROJECTS = join(sandbox, "Projects");
process.env.TALARIS_CONFIG_DIR = join(sandbox, "config");
process.env.TALARIS_STATE_DIR = join(sandbox, "state");
process.env.TALARIS_PLUGINS = join(sandbox, "plugins");
process.env.TALARIS_KEY = randomBytes(32).toString("base64");

const plugins = await import("../src/plugins.js");

after(() => rmSync(sandbox, { recursive: true, force: true }));

function plugin(id: string, extra = ""): void {
  const dir = join(sandbox, "src", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "plugin.toml"), `id = "${id}"\nname = "${id}"\nversion = "1.0.0"\ncommand = ["true"]\n${extra}`);
  plugins.install(dir);
}

test("a backup carries a plugin's settings and the state it names — never a secret — and reviving puts them back", () => {
  plugin("syncer", `
[[settings]]
key = "server"
label = "Server"
kind = "text"

[[settings]]
key = "key"
label = "Access key"
kind = "secret"

[backup]
state = ["state.json", "cache"]
`);
  plugins.setSettings("syncer", { server: "https://example.org" });
  const dir = plugins.pluginStateDir("syncer");
  mkdirSync(join(dir, "cache"), { recursive: true });
  writeFileSync(join(dir, "state.json"), '{"links":3}');
  writeFileSync(join(dir, "cache", "a.txt"), "kept too");
  writeFileSync(join(dir, "scratch.tmp"), "not named, not carried");

  const [b] = plugins.backupPlugins();
  assert.equal(b!.id, "syncer");
  assert.deepEqual(b!.settings, { server: "https://example.org" }, "the secret is not among them");
  assert.deepEqual(Object.keys(b!.state).sort(), ["cache/a.txt", "state.json"]);

  // Lost, then revived.
  rmSync(dir, { recursive: true });
  plugins.setSettings("syncer", { server: "https://elsewhere.example" });
  const r = plugins.restorePlugins([b!]);
  assert.deepEqual(r.restored, ["syncer"]);
  assert.equal(readFileSync(join(dir, "state.json"), "utf8"), '{"links":3}');
  assert.equal(readFileSync(join(dir, "cache", "a.txt"), "utf8"), "kept too");
  assert.ok(!existsSync(join(dir, "scratch.tmp")));
  assert.equal(plugins.listPlugins().find((p) => p.id === "syncer")!.settings.server, "https://example.org");
});

test("a plugin not installed when reviving finds its part waiting when it is", () => {
  const r = plugins.restorePlugins([{ id: "later", name: "Later", version: "1.0.0", enabled: false, settings: { mode: "fast" }, state: { "state.json": Buffer.from("{}").toString("base64") } }]);
  assert.deepEqual(r.waiting, ["Later"]);
  assert.ok(existsSync(join(plugins.pluginStateDir("later"), "state.json")));
  plugin("later", `
[[settings]]
key = "mode"
label = "Mode"
kind = "text"
`);
  assert.equal(plugins.listPlugins().find((p) => p.id === "later")!.settings.mode, "fast");
});

test("a manifest's backup paths stay inside its state folder", () => {
  assert.throws(() => plugin("bad", `\n[backup]\nstate = ["../../config/plugins.json"]\n`), /inside its state folder/);
});
