// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore
//
// The sync end to end, away from everything real: a Talaris core of its own
// (its own socket, folders and key, no notifications), the fake Hermes Notes,
// and this plugin between them, run by the real plugin host. Needs the core
// built (`pnpm --filter @talaris/core build`).

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";
const here = dirname(fileURLToPath(import.meta.url));
const plugin = join(here, "..");
const coreJs = join(here, "../../../packages/core/dist/src/index.js");
const sb = mkdtempSync(join(tmpdir(), "hermes-sync-e2e-"));
const sock = `${process.env.XDG_RUNTIME_DIR}/talaris-e2e.sock`; rmSync(sock, { force: true });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const fake = spawn("node", [join(here, "fake-hermes.mjs")], { stdio: ["ignore", "inherit", "inherit"] });
const core = spawn("node", [coreJs], {
  env: { ...process.env, TALARIS_SOCKET: sock, TALARIS_DATA_DIR: `${sb}/data`, TALARIS_PROJECTS: `${sb}/Projects`, TALARIS_CONFIG_DIR: `${sb}/config`,
    TALARIS_STATE_DIR: `${sb}/state`, TALARIS_KEY: Buffer.alloc(32, 9).toString("base64"), TALARIS_PLUGINS: `${sb}/plugins`, XDG_STATE_HOME: `${sb}/xdgstate`,
    // No real notifications from a test.
    DBUS_SESSION_BUS_ADDRESS: "unix:path=/nonexistent" },
  stdio: ["ignore", "inherit", "inherit"] });
const call = (method, path, body) => new Promise((ok, fail) => {
  const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  const r = http.request({ socketPath: sock, method, path, headers: data ? { "content-type": "application/json" } : {} }, (res) => {
    let s = ""; res.on("data", (c) => (s += c)); res.on("end", () => { try { ok(JSON.parse(s)); } catch { ok(s); } });
  });
  r.on("error", fail); if (data) r.write(data); r.end();
});
const hermes = (method, path, body) => fetch(`http://127.0.0.1:18800${path}`, { method, headers: { authorization: "Bearer test-key", "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) }).then((r) => r.json());
const check = (ok, what) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) process.exitCode = 1; };
const until = async (f, what, ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await f(); if (v) return v; await wait(300); } check(false, `waited for ${what}`); return null; };
try {
  await until(() => existsSync(sock), "the core");
  await wait(500);
  // Talaris: the same project, a task in it, and Rosa by her address.
  await call("POST", "/projects", { name: "Retreat" });
  const projects = await call("GET", "/tasks/projects");
  const proj = projects.find((p) => p.title === "Retreat");
  await call("POST", "/tasks", { title: "Book the room", projects: [proj.id], due: "2026-11-01" });
  await call("POST", "/entities/person", { email: "rosa@99.example", name: "Rosa Diaz" });
  // The plugin, installed, set and enabled.
  await call("POST", "/plugins/install", { from: plugin });
  await call("PUT", "/plugins/hermes-sync/settings", { values: { server: "http://127.0.0.1:18800/hermes", key: "test-key" } });
  await call("POST", "/plugins/hermes-sync/enable", { on: true });
  const start = await until(async () => (await call("GET", "/plugins"))[0]?.decisions?.find((d) => d.id === "start"), "the first-sync plan");
  console.log("     plan:", start?.detail);
  if (!start) { const r = (await call("GET", "/plugins"))[0]; console.log("     row:", r.state, r.status, r.problem, JSON.stringify(r.decisions).slice(0, 300)); console.log((await call("GET", "/plugins/hermes-sync/log")).join(" | ")); throw new Error("stop"); }
  check(/2 matched/.test(start?.detail ?? ""), "the project matched by name, Rosa by her address");
  check(!(await call("GET", "/plugins"))[0].decisions.some((d) => d.id.startsWith("conflict:")), "nothing asked before it starts");
  await call("POST", "/plugins/hermes-sync/decide", { item: "start", choice: "start" });
  const hTask = await until(async () => (await hermes("GET", "/test/all")).find((o) => o.properties.title === "Book the room"), "Talaris's task in Hermes");
  check(hTask?.properties.project?.[0] === "11111111-1111-4111-8111-111111111111", "made in Hermes inside Hermes' Retreat");
  check(hTask?.properties.status === "not done" && hTask?.properties.schedule?.end === "2026-11-01", "in Hermes' words: its status, its due date");
  const env = await call("GET", "/interchange?profile=task");
  const tTask = env.objects.find((o) => o.properties.title === "Order food");
  check(tTask?.id === "22222222-2222-4222-8222-222222222222" && tTask?.properties.project?.[0] === proj.id, "Hermes' task in Talaris, at its own id, in Talaris's Retreat");
  check(tTask?.properties.status === "not_started", "its status in Talaris's words");
  check(tTask?.properties["hermes-sync:link"]?.url === "https://hermes.example/block/22222222-2222-4222-8222-222222222222", "it carries its way back to Hermes");
  const rosa = (await call("GET", "/interchange?profile=contact")).objects.find((o) => o.properties.title === "Rosa Diaz");
  check(rosa?.properties["hermes-sync:link"]?.label === "Hermes Notes", "and so does a thing matched on the first sync");
  // Changed in Hermes: carried to Talaris.
  await hermes("POST", "/test/set", { id: "22222222-2222-4222-8222-222222222222", set: { title: "Order lunch", status: "done" } });
  await call("POST", "/plugins/hermes-sync/call", { tool: "sync_now", arguments: {} });
  const t2 = (await call("GET", "/interchange?profile=task")).objects.find((o) => o.id === "22222222-2222-4222-8222-222222222222");
  check(t2?.properties.title === "Order lunch" && t2?.properties.status === "done" && t2?.properties.done_at, "a change in Hermes carried, and finishing it here stamped its time (Talaris's own doing)");
  // Changed on both sides: asked; Hermes' kept.
  await call("POST", "/interchange/objects/22222222-2222-4222-8222-222222222222".replace("/interchange", "/interchange"), undefined).catch(() => undefined);
  const tv = t2.version;
  await call("PATCH", `/interchange/objects/22222222-2222-4222-8222-222222222222`, { set: { title: "Lunch, here" }, version: tv });
  await hermes("POST", "/test/set", { id: "22222222-2222-4222-8222-222222222222", set: { title: "Lunch, there" } });
  await call("POST", "/plugins/hermes-sync/call", { tool: "sync_now", arguments: {} });
  const conflict = await until(async () => (await call("GET", "/plugins"))[0]?.decisions?.find((d) => d.id.startsWith("conflict:22222222")), "the conflict to be asked");
  console.log("     asked:", conflict?.title, JSON.stringify(conflict?.fields));
  await call("POST", "/plugins/hermes-sync/decide", { item: conflict.id, choice: "hermes" });
  const t3 = (await call("GET", "/interchange?profile=task")).objects.find((o) => o.id === "22222222-2222-4222-8222-222222222222");
  check(t3?.properties.title === "Lunch, there", "the person kept Hermes', and Talaris has it");
  const h3 = (await hermes("GET", "/test/all")).find((o) => o.id === "22222222-2222-4222-8222-222222222222");
  check(h3?.properties.title === "Lunch, there", "and Hermes still has it");
  const row = (await call("GET", "/plugins"))[0];
  console.log("     status:", row.status, "| decisions left:", row.decisions.length);
} finally {
  core.kill("SIGTERM"); fake.kill();
  await wait(800);
  rmSync(sb, { recursive: true, force: true });
}
