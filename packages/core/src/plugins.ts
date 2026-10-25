// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore

import { spawn, execFile, execFileSync, type ChildProcess } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { getEntity, types } from "./entities.js";
import { createObject, liveManifest, patchObject, readEnvelope, type WritePatch } from "./interchange.js";
import { CONFIG_DIR } from "./paths.js";
import { Conflict, NotFound } from "./projects.js";
import { readJson, writeJson } from "./store.js";
import { parseToml } from "./toml.js";
import { forgetSecret, getSecret, setSecret } from "./vault.js";

/**
 * Plugins (DESIGN, *Plugins*). A plugin is **its own process**, any language,
 * any license, started and supervised here and spoken to over **MCP on its
 * standard input and output** — Talaris is the client. Its tools are its
 * verbs, passed through to Morgan by Talaris's own MCP (mcp.ts) without
 * wiring; what MCP has no words for, it asks Talaris with `talaris/…`
 * requests on the same connection (the extension, offered at `initialize` in
 * MCP's own `experimental` capabilities).
 *
 * **A manifest says everything before anything runs** (`plugin.toml`): what
 * it is, the command that starts it, the tools it offers, the settings it
 * keeps, and **what it may ask of Talaris** — which kinds of things it may
 * read and change through the interchange binding, whether it may notify.
 * Talaris shows that before it is enabled and holds it to it after: a request
 * outside it is refused, and a tool it did not declare is not passed on.
 *
 * **A plugin is a program running as you.** What it may ask of Talaris is
 * what Talaris controls; it cannot stop a plugin reading files or using the
 * network, and does not pretend to (`network` and `files` in a manifest are
 * said, and shown, not enforced).
 *
 * Installed is a folder in `~/.local/share/talaris/plugins/<id>/`, copied in
 * or cloned; enabled, settings and supervision are here. Secrets go in the
 * login keyring, never in a file.
 */

const xdgData = () => (process.env.XDG_DATA_HOME && process.env.XDG_DATA_HOME.trim()) || join(homedir(), ".local/share");
export const PLUGINS_DIR = () => process.env.TALARIS_PLUGINS ?? join(xdgData(), "talaris", "plugins");
const STATE = () => join(CONFIG_DIR, "plugins.json");

/** The kinds a plugin may name, as the format's profiles; "person" is a contact. */
const KINDS = ["task", "project", "event", "contact", "note"];
const kindOf = (k: string) => (k === "person" ? "contact" : k);

export interface SettingDef {
  key: string;
  label: string;
  kind: "text" | "secret" | "choice" | "boolean" | "number";
  choices?: string[];
  default?: unknown;
  help?: string;
}
export interface ToolDecl {
  name: string;
  description?: string;
}
export interface Manifest {
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: string;
  license?: string;
  homepage?: string;
  /** The command, run in the plugin's folder: the program and its arguments. */
  command: string[];
  tools: ToolDecl[];
  settings: SettingDef[];
  permissions: {
    read: string[];
    write: string[];
    notify: boolean;
    /** Said and shown, not enforced: Talaris cannot stop a program using the network. */
    network: string[];
    files: string[];
  };
}

const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/** A plugin.toml read and checked: what it is, or why it is not one. */
export function readManifest(dir: string): Manifest {
  const file = join(dir, "plugin.toml");
  if (!existsSync(file)) throw new NotFound(`${dir} has no plugin.toml`);
  const t = parseToml(readFileSync(file, "utf8"));
  const need = (k: string) => {
    if (typeof t[k] !== "string" || !(t[k] as string).trim()) throw new Conflict(`plugin.toml needs ${k}`);
    return (t[k] as string).trim();
  };
  const id = need("id");
  if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(id)) throw new Conflict("a plugin's id is lowercase letters, digits and dashes");
  const command = typeof t.command === "string" ? [t.command] : strs(t.command);
  if (!command.length) throw new Conflict("plugin.toml needs command: the program that starts it, and its arguments");
  const p = (t.permissions ?? {}) as Record<string, unknown>;
  const kinds = (v: unknown) => {
    const out = strs(v).map(kindOf);
    const bad = out.filter((k) => !KINDS.includes(k));
    if (bad.length) throw new Conflict(`permissions name kinds Talaris does not have: ${bad.join(", ")} (it has ${KINDS.join(", ")})`);
    return [...new Set(out)];
  };
  const settings = (Array.isArray(t.settings) ? t.settings : []).map((s, n) => {
    const x = s as Record<string, unknown>;
    if (typeof x.key !== "string" || !/^[A-Za-z0-9_-]+$/.test(x.key)) throw new Conflict(`settings ${n + 1} needs a key of letters, digits and dashes`);
    const kind = (typeof x.kind === "string" ? x.kind : "text") as SettingDef["kind"];
    if (!["text", "secret", "choice", "boolean", "number"].includes(kind)) throw new Conflict(`setting ${x.key}: kind is text, secret, choice, boolean or number`);
    return { key: x.key, label: typeof x.label === "string" ? x.label : x.key, kind, ...(x.choices ? { choices: strs(x.choices) } : {}),
      ...(x.default !== undefined ? { default: x.default } : {}), ...(typeof x.help === "string" ? { help: x.help } : {}) };
  });
  const tools = (Array.isArray(t.tools) ? t.tools : []).map((x) => {
    const d = x as Record<string, unknown>;
    if (typeof d.name !== "string") throw new Conflict("each [[tools]] needs a name");
    return { name: d.name, ...(typeof d.description === "string" ? { description: d.description } : {}) };
  });
  const read = kinds(p.read);
  const write = kinds(p.write);
  return {
    id, name: need("name"), version: need("version"),
    ...(typeof t.description === "string" ? { description: t.description } : {}),
    ...(typeof t.author === "string" ? { author: t.author } : {}),
    ...(typeof t.license === "string" ? { license: t.license } : {}),
    ...(typeof t.homepage === "string" ? { homepage: t.homepage } : {}),
    command, tools, settings,
    // Changing a kind means reading it: a write permission brings the read with it.
    permissions: { read: [...new Set([...read, ...write])], write, notify: p.notify === true, network: strs(p.network), files: strs(p.files) },
  };
}

// ------------------------------------------------------------ what is kept

interface Kept { enabled: Record<string, boolean>; settings: Record<string, Record<string, unknown>> }
const kept = (): Kept => {
  try {
    const k = readJson<Partial<Kept>>(STATE());
    return { enabled: k.enabled ?? {}, settings: k.settings ?? {} };
  } catch {
    return { enabled: {}, settings: {} };
  }
};
const keep = (k: Kept) => writeJson(STATE(), k);
const secretName = (id: string, key: string) => `plugin:${id}:${key}`;

/** A plugin's settings, its secrets out of the keyring: what the plugin itself is handed. */
function settingsFor(m: Manifest): Record<string, unknown> {
  const mine = kept().settings[m.id] ?? {};
  const out: Record<string, unknown> = {};
  for (const s of m.settings) {
    if (s.kind === "secret") { const v = getSecret(secretName(m.id, s.key)); if (v !== null) out[s.key] = v; }
    else if (s.key in mine) out[s.key] = mine[s.key];
    else if (s.default !== undefined) out[s.key] = s.default;
  }
  return out;
}

/** Settings as a person sees them: a secret only as whether it is set. */
function settingsShown(m: Manifest): Record<string, unknown> {
  const mine = kept().settings[m.id] ?? {};
  const out: Record<string, unknown> = {};
  for (const s of m.settings) {
    if (s.kind === "secret") {
      let set = false;
      try { set = getSecret(secretName(m.id, s.key)) !== null; } catch { /* the keyring is not up yet: shown as not set */ }
      out[s.key] = { set };
    } else out[s.key] = s.key in mine ? mine[s.key] : s.default ?? null;
  }
  return out;
}

export function setSettings(id: string, values: Record<string, unknown>): void {
  const m = installed().find((x) => x.manifest.id === id)?.manifest;
  if (!m) throw new NotFound(`no plugin ${id}`);
  const k = kept();
  const mine = { ...(k.settings[id] ?? {}) };
  for (const [key, v] of Object.entries(values)) {
    const s = m.settings.find((x) => x.key === key);
    if (!s) throw new Conflict(`${m.name} has no setting ${key}`);
    if (s.kind === "secret") {
      if (v === null || v === "") forgetSecret(secretName(id, key));
      else setSecret(secretName(id, key), String(v));
      continue;
    }
    if (v === null) { delete mine[key]; continue; }
    if (s.kind === "boolean" && typeof v !== "boolean") throw new Conflict(`${s.label} is on or off`);
    if (s.kind === "number" && typeof v !== "number") throw new Conflict(`${s.label} is a number`);
    if (s.kind === "choice" && !(s.choices ?? []).includes(String(v))) throw new Conflict(`${s.label} is one of ${(s.choices ?? []).join(", ")}`);
    mine[key] = v;
  }
  k.settings[id] = mine;
  keep(k);
  // Told at once, so a sync with a new address does not wait for a restart.
  running.get(id)?.notify("notifications/talaris/settings_changed", { settings: settingsFor(m) });
}

// ------------------------------------------------------------ installed

interface Installed { dir: string; manifest: Manifest; error?: undefined }
interface Broken { dir: string; manifest?: undefined; error: string }

export function installed(): Installed[] {
  return scan().filter((x): x is Installed => !x.error);
}
function scan(): (Installed | Broken)[] {
  const root = PLUGINS_DIR();
  if (!existsSync(root)) return [];
  return readdirSync(root).filter((n) => !n.startsWith(".") && statSync(join(root, n)).isDirectory()).map((n) => {
    const dir = join(root, n);
    try {
      const manifest = readManifest(dir);
      if (manifest.id !== n) return { dir, error: `its folder is ${n} but its id is ${manifest.id}` };
      return { dir, manifest };
    } catch (e) {
      return { dir, error: (e as Error).message };
    }
  });
}

/** From a folder, or a git address: copied (or cloned) in, never enabled by being installed. */
export function install(from: string, options: { replace?: boolean } = {}): Manifest {
  let source = from.trim();
  let temp: string | null = null;
  if (/^(https?:\/\/|git@|ssh:\/\/)/.test(source) || source.endsWith(".git")) {
    temp = mkdtempSync(join(tmpdir(), "talaris-plugin-"));
    try {
      execFileSync("git", ["clone", "--depth", "1", source, join(temp, "src")], { stdio: "pipe", timeout: 120_000 });
    } catch (e) {
      rmSync(temp, { recursive: true, force: true });
      throw new Conflict(`could not clone it: ${String((e as { stderr?: Buffer }).stderr ?? (e as Error).message).trim().split("\n").pop()}`);
    }
    source = join(temp, "src");
  }
  try {
    source = resolve(source.replace(/^~(?=\/)/, homedir()));
    const m = readManifest(source);
    const dest = join(PLUGINS_DIR(), m.id);
    if (resolve(dest) === source) return m;
    if (existsSync(dest)) {
      if (!options.replace) throw new Conflict(`${m.name} is already installed`);
      stop(m.id);
      rmSync(dest, { recursive: true, force: true });
    }
    cpSync(source, dest, { recursive: true, filter: (p) => !p.split("/").includes(".git") });
    if (kept().enabled[m.id]) start(m.id);
    return m;
  } finally {
    if (temp) rmSync(temp, { recursive: true, force: true });
  }
}

/** Gone: stopped, its folder removed, its settings and secrets forgotten. */
export function uninstall(id: string): void {
  const p = installed().find((x) => x.manifest.id === id);
  if (!p) throw new NotFound(`no plugin ${id}`);
  stop(id);
  rmSync(p.dir, { recursive: true, force: true });
  for (const s of p.manifest.settings) if (s.kind === "secret") forgetSecret(secretName(id, s.key));
  const k = kept();
  delete k.enabled[id];
  delete k.settings[id];
  keep(k);
}

export function enable(id: string, on: boolean): void {
  if (!installed().some((x) => x.manifest.id === id)) throw new NotFound(`no plugin ${id}`);
  const k = kept();
  k.enabled[id] = on;
  keep(k);
  if (on) start(id); else stop(id);
}

// ------------------------------------------------------------ running

const PROTOCOL = "2025-06-18";
const LOG_LINES = 300;
type State = "stopped" | "starting" | "running" | "crashed";

interface McpTool { name: string; description?: string; inputSchema?: Record<string, unknown>; annotations?: Record<string, unknown> }

class Running {
  state: State = "starting";
  error = "";
  child: ChildProcess | null = null;
  tools: McpTool[] = [];
  /** A line the plugin sets about itself ("synced 2 minutes ago"), shown in Settings. */
  status = "";
  log: string[] = [];
  startedAt = 0;
  private next = 1;
  private waiting = new Map<number, { ok: (v: unknown) => void; fail: (e: Error) => void }>();
  private restarts = 0;
  private timer: NodeJS.Timeout | null = null;
  private stopping = false;

  constructor(readonly dir: string, readonly manifest: Manifest) {}

  say(line: string): void {
    for (const l of line.split("\n")) if (l.trim()) this.log.push(`${new Date().toISOString().slice(11, 19)} ${l}`);
    if (this.log.length > LOG_LINES) this.log.splice(0, this.log.length - LOG_LINES);
  }

  start(): void {
    this.stopping = false;
    this.state = "starting";
    this.error = "";
    const [cmd, ...args] = this.manifest.command;
    const child = spawn(cmd!, args, {
      cwd: this.dir,
      env: { ...process.env, TALARIS_PLUGIN: this.manifest.id, TALARIS_PLUGIN_DIR: this.dir },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    this.startedAt = Date.now();
    child.on("error", (e) => { this.error = e.message; this.say(`could not start: ${e.message}`); });
    createInterface({ input: child.stderr! }).on("line", (l) => this.say(l));
    createInterface({ input: child.stdout! }).on("line", (l) => this.receive(l));
    child.on("exit", (code, signal) => {
      for (const w of this.waiting.values()) w.fail(new Error(`${this.manifest.name} stopped`));
      this.waiting.clear();
      this.child = null;
      this.tools = [];
      if (this.stopping) { this.state = "stopped"; return; }
      this.state = "crashed";
      this.error ||= `stopped by itself (${signal ?? `exit ${code}`})`;
      this.say(this.error);
      // Again, later each time: a second, then two, four… at most five minutes; a while up, and it starts counting again.
      if (Date.now() - this.startedAt > 10 * 60_000) this.restarts = 0;
      const wait = Math.min(1000 * 2 ** this.restarts++, 5 * 60_000);
      this.timer = setTimeout(() => { this.timer = null; if (!this.stopping) this.start(); }, wait);
    });
    void this.handshake();
  }

  private async handshake(): Promise<void> {
    try {
      const init = (await this.request("initialize", {
        protocolVersion: PROTOCOL,
        // Talaris's extension (DESIGN, *The protocol*): what a plugin may ask, said once, up front.
        // Its settings come with the greeting, so the first call has them; changes follow as notifications.
        capabilities: { experimental: { talaris: { version: 1, requests: ["talaris/settings", "talaris/interchange", "talaris/notify", "talaris/status"],
          settings: settingsFor(this.manifest) } } },
        clientInfo: { name: "talaris", version: "0.1.0" },
      }, 20_000)) as { serverInfo?: { name?: string } };
      this.notify("notifications/initialized", {});
      await this.refreshTools();
      this.state = "running";
      this.say(`running${init?.serverInfo?.name ? ` (${init.serverInfo.name})` : ""}`);
    } catch (e) {
      this.error = `did not answer as an MCP server: ${(e as Error).message}`;
      this.say(this.error);
      this.child?.kill("SIGTERM");
    }
  }

  async refreshTools(): Promise<void> {
    const got = (await this.request("tools/list", {}, 20_000)) as { tools?: McpTool[] };
    const declared = new Set(this.manifest.tools.map((t) => t.name));
    const offered = got?.tools ?? [];
    // Only what the manifest said it would offer: what is shown before enabling is what is given.
    const undeclared = offered.filter((t) => !declared.has(t.name)).map((t) => t.name);
    if (undeclared.length) this.say(`offers tools its manifest does not name, not passed on: ${undeclared.join(", ")}`);
    this.tools = offered.filter((t) => declared.has(t.name));
  }

  stop(): void {
    this.stopping = true;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    const c = this.child;
    if (!c) { this.state = "stopped"; return; }
    c.stdin?.end();
    c.kill("SIGTERM");
    setTimeout(() => { if (c.exitCode === null && c.signalCode === null) c.kill("SIGKILL"); }, 3000).unref();
  }

  private send(m: unknown): void {
    this.child?.stdin?.write(JSON.stringify(m) + "\n");
  }
  notify(method: string, params: unknown): void {
    this.send({ jsonrpc: "2.0", method, params });
  }
  request(method: string, params: unknown, timeout = 120_000): Promise<unknown> {
    return new Promise((ok, fail) => {
      if (!this.child) { fail(new Error(`${this.manifest.name} is not running`)); return; }
      const id = this.next++;
      const timer = setTimeout(() => { this.waiting.delete(id); fail(new Error(`${this.manifest.name} took too long to answer`)); }, timeout);
      this.waiting.set(id, { ok: (v) => { clearTimeout(timer); ok(v); }, fail: (e) => { clearTimeout(timer); fail(e); } });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  private receive(line: string): void {
    if (!line.trim()) return;
    let m: { id?: number | string; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { message?: string } };
    try { m = JSON.parse(line); } catch { this.say(`not JSON on its output: ${line.slice(0, 200)}`); return; }
    if (m.method) {
      if (m.id === undefined) {
        // A notification: its tools changed, or a line for its log.
        if (m.method === "notifications/tools/list_changed") void this.refreshTools().catch(() => undefined);
        else if (m.method === "notifications/message") this.say(String((m.params as { data?: unknown })?.data ?? ""));
        return;
      }
      void this.answer(m.id, m.method, m.params ?? {});
      return;
    }
    const w = typeof m.id === "number" ? this.waiting.get(m.id) : undefined;
    if (!w) return;
    this.waiting.delete(m.id as number);
    if (m.error) w.fail(new Error(m.error.message ?? "it answered with an error"));
    else w.ok(m.result);
  }

  /** What a plugin asks of Talaris, within what its manifest says. */
  private async answer(id: number | string, method: string, params: Record<string, unknown>): Promise<void> {
    const reply = (result: unknown) => this.send({ jsonrpc: "2.0", id, result });
    const refuse = (code: number, message: string) => { this.say(`refused ${method}: ${message}`); this.send({ jsonrpc: "2.0", id, error: { code, message } }); };
    try {
      if (method === "ping") return reply({});
      if (method === "talaris/settings") return reply({ settings: settingsFor(this.manifest) });
      if (method === "talaris/status") { this.status = String(params.text ?? "").slice(0, 200); return reply({}); }
      if (method === "talaris/notify") {
        if (!this.manifest.permissions.notify) return refuse(-32001, "its manifest does not ask to notify");
        notifyDesktop(this.manifest.name, String(params.title ?? this.manifest.name), String(params.body ?? ""));
        return reply({});
      }
      if (method === "talaris/interchange") return reply(interchangeFor(this.manifest, params));
      return refuse(-32601, `Talaris has no ${method}`);
    } catch (e) {
      return refuse(-32000, (e as Error).message);
    }
  }
}

const running = new Map<string, Running>();

function start(id: string): void {
  const p = installed().find((x) => x.manifest.id === id);
  if (!p) throw new NotFound(`no plugin ${id}`);
  stop(id);
  const r = new Running(p.dir, p.manifest);
  running.set(id, r);
  r.start();
}

function stop(id: string): void {
  const r = running.get(id);
  if (!r) return;
  r.stop();
  running.delete(id);
}

export function restart(id: string): void {
  if (!kept().enabled[id]) throw new Conflict("it is not enabled");
  start(id);
}

/** At the core's start: every enabled plugin, started. */
export function startPlugins(): void {
  const k = kept();
  for (const p of installed()) {
    if (!k.enabled[p.manifest.id]) continue;
    try { start(p.manifest.id); } catch (e) { console.error(`talaris-core: plugin ${p.manifest.id}: ${(e as Error).message}`); }
  }
}

export function stopPlugins(): void {
  for (const id of [...running.keys()]) stop(id);
}

// ------------------------------------------------------------ what a plugin may ask

/** The kinds (profiles) a type is, of those a plugin may name. */
const kindsOfType = (typeId: string | undefined) =>
  Object.keys(types().find((t) => t.id === typeId)?.profiles ?? {}).filter((k) => KINDS.includes(k));

/**
 * The interchange binding, for a plugin: reads narrowed to the kinds it may
 * read, writes to the kinds it may change — the same rules and the same
 * store as the binding on the socket, held to the manifest.
 */
function interchangeFor(m: Manifest, p: Record<string, unknown>): unknown {
  const verb = String(p.method ?? "GET").toUpperCase();
  const path = String(p.path ?? "");
  const url = new URL(path, "http://talaris");
  const may = (kinds: string[], typeId: string | undefined) => kindsOfType(typeId).some((k) => kinds.includes(k));
  if (verb === "GET" && url.pathname === "/conformance") return { format: "pkm-interchange/0", ...liveManifest() };
  if (verb === "GET" && url.pathname === "/interchange") {
    if (!m.permissions.read.length) throw new Error("its manifest does not ask to read anything");
    const env = readEnvelope({ since: url.searchParams.get("since") ?? undefined, profile: url.searchParams.get("profile") ?? undefined, q: url.searchParams.get("q") ?? undefined });
    const objects = (env.objects ?? []).filter((o) => may(m.permissions.read, o.type));
    const ids = new Set(objects.map((o) => o.id));
    // Deletions are said by id alone: a follower must hear of them, and an id says nothing else.
    return { ...env, objects, relations: (env.relations ?? []).filter((r) => ids.has(r.from)) };
  }
  const object = /^\/interchange\/objects\/([^/]+)$/.exec(url.pathname);
  if (object) {
    const id = decodeURIComponent(object[1]!);
    if (verb === "PUT") {
      const body = (p.body ?? {}) as { type?: string; properties?: Record<string, unknown> };
      if (!may(m.permissions.write, body.type)) throw new Error(`its manifest does not ask to make ${kindsOfType(body.type).join(" or ") || "that kind of thing"}`);
      return createObject(id, body);
    }
    if (verb === "PATCH") {
      let typeId: string | undefined;
      try { typeId = getEntity(id).type; } catch { throw new Error(`no object ${id}`); }
      if (!may(m.permissions.write, typeId)) throw new Error(`its manifest does not ask to change ${kindsOfType(typeId).join(" or ") || "that kind of thing"}`);
      return patchObject(id, (p.body ?? {}) as WritePatch);
    }
  }
  throw new Error(`not a route of the binding: ${verb} ${path}`);
}

/** A desktop notification, as the plugin: through the notification server Talaris runs (notifyd.py). */
function notifyDesktop(app: string, title: string, body: string): void {
  execFile("gdbus", ["call", "--session", "--dest", "org.freedesktop.Notifications", "--object-path", "/org/freedesktop/Notifications",
    "--method", "org.freedesktop.Notifications.Notify", app, "0", "", title, body, "[]", "{}", "-1"], { timeout: 5000 }, () => undefined);
}

// ------------------------------------------------------------ for the routes and Morgan

export interface PluginRow {
  id: string;
  dir: string;
  manifest?: Manifest;
  error?: string;
  enabled: boolean;
  state: State | "disabled";
  status: string;
  problem: string;
  tools: McpTool[];
  settings: Record<string, unknown>;
}

export function listPlugins(): PluginRow[] {
  const k = kept();
  return scan().map((x) => {
    const id = x.manifest?.id ?? x.dir.split("/").pop()!;
    const r = running.get(id);
    return {
      id, dir: x.dir,
      ...(x.manifest ? { manifest: x.manifest } : { error: x.error }),
      enabled: Boolean(k.enabled[id]),
      state: r ? r.state : k.enabled[id] ? "stopped" : "disabled",
      status: r?.status ?? "",
      problem: r?.error ?? "",
      tools: r?.tools ?? [],
      settings: x.manifest ? settingsShown(x.manifest) : {},
    };
  });
}

export function pluginLog(id: string): string[] {
  return running.get(id)?.log ?? [];
}

/** Every running plugin's tools, for Talaris's MCP to pass to Morgan. */
export function pluginTools(): { plugin: string; pluginName: string; tool: McpTool }[] {
  return [...running.values()].filter((r) => r.state === "running").flatMap((r) => r.tools.map((tool) => ({ plugin: r.manifest.id, pluginName: r.manifest.name, tool })));
}

export async function callPluginTool(id: string, tool: string, args: Record<string, unknown>): Promise<unknown> {
  const r = running.get(id);
  if (!r || r.state !== "running") throw new Conflict(`${id} is not running`);
  if (!r.tools.some((t) => t.name === tool)) throw new NotFound(`${r.manifest.name} offers no ${tool}`);
  return r.request("tools/call", { name: tool, arguments: args ?? {} });
}
