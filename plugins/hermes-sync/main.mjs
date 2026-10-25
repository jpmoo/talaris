// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore
//
// The Hermes Notes sync plugin's program: an MCP server to Talaris (its
// tools: sync now, and how it stands), and a client of two pkm-interchange
// live bindings — Talaris's, asked through `talaris/interchange`, and Hermes
// Notes', over HTTPS with an access key. The sync itself is `sync.mjs`; this
// reads both sides, runs the plan, writes it, keeps what the pairs agreed on,
// and puts to the person what only they can decide (`talaris/decide`).

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { agreed, plan } from "./sync.mjs";

const log = (...a) => process.stderr.write(`${a.join(" ")}\n`);

// ------------------------------------------------------------ talking to Talaris (MCP, both ways)

let next = 1;
const waiting = new Map();
const send = (m) => process.stdout.write(JSON.stringify(m) + "\n");
const talaris = (method, params) => new Promise((ok, fail) => {
  const id = `s${next++}`;
  waiting.set(id, { ok, fail });
  send({ jsonrpc: "2.0", id, method, params });
});
const tal = async (method, path, body) => talaris("talaris/interchange", { method, path, ...(body !== undefined ? { body } : {}) });

// ------------------------------------------------------------ Hermes Notes

let settings = {};
function hermesBase() {
  const s = String(settings.server ?? "").trim().replace(/\/+$/, "");
  if (!s) return "";
  return /\/api$/.test(s) ? s : `${s}/api`;
}
async function hermes(method, path, body) {
  const res = await fetch(`${hermesBase()}${path}`, {
    method,
    headers: { authorization: `Bearer ${settings.key}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { error: text.slice(0, 200) }; }
  if (res.status === 401 || res.status === 403) throw new Error("Hermes Notes refused the access key");
  if (res.status === 410) { const e = new Error("gone"); e.gone = true; throw e; }
  // A write refused (a stale version, an unknown type) answers in the format's own shape; anything else is a failure.
  if (!res.ok && !(data && "ok" in data)) throw new Error(`Hermes Notes answered ${res.status}: ${data?.error ?? ""}`.trim());
  return data;
}

/**
 * A file by its hash, at either side's /interchange/files (*Files*): raw bytes
 * to and from Hermes Notes, base64 through Talaris's plugin host. `held`
 * answers whether a side has it; `fetch` its bytes, or null; `give` hands it
 * over, checked against its hash by the side that keeps it.
 */
const files = {
  async held(side, sha) {
    if (side === "talaris") return (await tal("HEAD", `/interchange/files/${sha}`)).ok === true;
    const res = await fetch(`${hermesBase()}/interchange/files/${sha}`, { method: "HEAD", headers: { authorization: `Bearer ${settings.key}` }, signal: AbortSignal.timeout(60_000) });
    return res.ok;
  },
  async fetch(side, sha) {
    if (side === "talaris") { const got = await tal("GET", `/interchange/files/${sha}`); return got.ok ? Buffer.from(got.bytes, "base64") : null; }
    const res = await fetch(`${hermesBase()}/interchange/files/${sha}`, { headers: { authorization: `Bearer ${settings.key}` }, signal: AbortSignal.timeout(300_000) });
    return res.ok ? Buffer.from(await res.arrayBuffer()) : null;
  },
  async give(side, sha, bytes) {
    if (side === "talaris") { const got = await tal("PUT", `/interchange/files/${sha}`, { bytes: bytes.toString("base64") }); if (!got.ok) throw new Error((got.reports ?? []).join(", ")); return; }
    const res = await fetch(`${hermesBase()}/interchange/files/${sha}`, { method: "PUT", headers: { authorization: `Bearer ${settings.key}`, "content-type": "application/octet-stream" }, body: bytes, signal: AbortSignal.timeout(300_000) });
    if (!res.ok) throw new Error(`Hermes Notes refused a file: ${res.status}`);
  },
};
/**
 * Linked files gone from disk on one Talaris thing, put back: each fetched by
 * its hash from Hermes Notes (which kept the last synced version), handed to
 * Talaris's store, and Talaris asked to write them back where they were
 * (`talaris/restoreLinks`).
 */
async function restoreFiles(entity) {
  if (!entity) return { text: "Which thing?", error: true };
  const env = await tal("GET", "/interchange");
  const o = (env.objects ?? []).find((x) => x.id === entity);
  if (!o) return { text: "That is not something this sync can see.", error: true };
  const missing = Object.values(o.properties ?? {}).flatMap((v) => (Array.isArray(v) ? v : [v]))
    .filter((a) => a && a.kind === "attachment" && a["talaris:link"] && a["talaris:missing"]);
  if (!missing.length) return { text: "No linked file of this one is missing." };
  const gone = [];
  for (const a of missing) {
    const bytes = await files.fetch("hermes", a.sha256).catch(() => null);
    if (!bytes) { gone.push(a.filename); continue; }
    await files.give("talaris", a.sha256, bytes);
  }
  const r = await talaris("talaris/restoreLinks", { entity });
  const back = r?.restored ?? 0;
  const left = [...new Set([...gone, ...(r?.still ?? [])])];
  return { text: `${back} restored${left.length ? `; Hermes Notes has no copy of ${left.join(", ")}` : ""}.`, error: back === 0 && left.length > 0 };
}

/** Before a write naming files the side it goes to lacks: each one fetched from the other side and handed over. */
async function handOver(w) {
  const from = w.side === "talaris" ? "hermes" : "talaris";
  for (const f of w.files ?? []) {
    if (await files.held(w.side, f.sha256)) continue;
    const bytes = await files.fetch(from, f.sha256);
    // Not on either side: the write names it anyway, and the side it goes to says it is known-missing.
    if (bytes) await files.give(w.side, f.sha256, bytes);
    else log(`${f.filename}: neither side holds ${f.sha256}`);
  }
}

// ------------------------------------------------------------ what it keeps

const STATE_DIR = join((process.env.XDG_STATE_HOME || "").trim() || join(homedir(), ".local/state"), "talaris", "plugins", "hermes-sync");
const STATE = join(STATE_DIR, "state.json");
const fresh = () => ({ started: false, links: [], apart: [], only: [], mode: null, cursors: null, last: null });
let state = (() => { try { return { ...fresh(), ...JSON.parse(readFileSync(STATE, "utf8")) }; } catch { return fresh(); } })();
function save() {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(`${STATE}.tmp`, JSON.stringify(state));
  renameSync(`${STATE}.tmp`, STATE);
}

// ------------------------------------------------------------ the settings, in the plan's words

const MODES = { "Merge, and ask me": "merge", "Hermes Notes wins": "hermes", "Talaris wins": "talaris" };
function words() {
  const asked = MODES[settings.mode] ?? "merge";
  return {
    // A side winning that was declined goes on merging, until the setting is changed.
    mode: asked === state.notMode ? "merge" : asked,
    kinds: { task: settings.tasks !== false, project: settings.projects !== false, contact: settings.people !== "Off", note: (settings.notes ?? "Off") !== "Off" },
    people: settings.people === "Everyone" ? "everyone" : "known",
    // Undated notes: all of Hermes Notes' (daily pages aside), or only those wearing one of the tags named.
    notes: settings.notes === "Only those with these tags" ? "tagged" : "all",
    noteTags: String(settings.noteTags ?? "").split(",").map((x) => x.trim().replace(/^#/, "")).filter(Boolean),
    now: Date.now(),
  };
}

// ------------------------------------------------------------ one sync

let asked = [];
let running = null;
let last = { at: null, summary: null, error: null };

async function decideAgain(items) {
  const before = new Set(asked.map((d) => d.id));
  asked = items;
  await talaris("talaris/decide", { items }).catch(() => undefined);
  const fresh = items.filter((d) => !before.has(d.id));
  if (fresh.length) {
    await talaris("talaris/notify", { title: "Hermes Notes sync", body: fresh.length === 1 ? `${fresh[0].title} — in Settings, Plugins` : `${fresh.length} things to decide — in Settings, Plugins` }).catch(() => undefined);
  }
}

async function status(text) {
  await talaris("talaris/status", { text }).catch(() => undefined);
}

function sync(force = false) {
  running ??= once(force).catch(async (e) => {
    last = { ...last, error: e.message };
    log(`sync failed: ${e.stack ?? e.message}`);
    await status(`Not synced: ${e.message}`);
  }).finally(() => { running = null; });
  return running;
}

async function once(force) {
  if (!hermesBase() || !settings.key) { await status("Needs the Hermes Notes address and access key"); return; }
  const s = words();

  // Nothing new on either side since last time, and nothing asked: nothing to do.
  if (!force && state.started && state.cursors && !asked.length) {
    try {
      const [dt, dh] = await Promise.all([tal("GET", `/interchange?since=${encodeURIComponent(state.cursors.t)}`), hermes("GET", `/interchange?since=${encodeURIComponent(state.cursors.h)}`)]);
      if (!(dt.changes ?? []).length && !(dh.changes ?? []).length) { last = { ...last, at: new Date().toISOString() }; await say(); return; }
    } catch (e) { if (!e.gone && !/cursor/.test(e.message)) throw e; }
  }

  const [T, H, cT, cH] = await Promise.all([tal("GET", "/interchange"), hermes("GET", "/interchange"),
    tal("GET", "/conformance").catch(() => ({})), hermes("GET", "/conformance").catch(() => ({}))]);
  // Attachments travel only between two sides that both hand files over by their hash.
  s.files = [cT, cH].every((c) => (c.features ?? []).includes("attachment-files"));
  // A side that has changed how it decides since it started: asked before anything is written that way.
  if (state.started && state.mode && state.mode !== s.mode && s.mode !== "merge") {
    await decideAgain([{ id: `mode:${s.mode}`, title: s.mode === "hermes" ? "Hermes Notes wins, from now on?" : "Talaris wins, from now on?",
      detail: `Every pair that differs is made to match ${s.mode === "hermes" ? "Hermes Notes" : "Talaris"}, overwriting the other side. Nothing is deleted.`,
      choices: [{ key: "go", label: "Yes" }, { key: "merge", label: "Keep merging" }] }]);
    await status("Waiting: how it should decide");
    return;
  }
  // A kind wanted that one side has no type for: said, so the person knows where to mark one.
  const declares = (env, kind) => (env.types ?? []).some((t) => t.profiles && kind in t.profiles);
  const unmarked = Object.entries(s.kinds).filter(([k, on]) => on && !declares(H, k)).map(([k]) => ({ contact: "person", project: "project", task: "task", note: "note" })[k]);
  const p = plan(state, T, H, s, randomUUID);
  last.unmarked = unmarked;
  state.links = p.links;
  if (!state.started) {
    save();
    await decideAgain(p.ask);
    await status([p.ask.some((d) => d.id === "start") ? "Ready for its first sync: start it in Settings, Plugins" : `${p.ask.length} to decide before the first sync`,
      ...(unmarked.length ? [`Hermes Notes has no type marked as ${unmarked.join(", ")}`] : [])].join(" · "));
    return;
  }

  // The writes, in order: what is pointed at before what points at it.
  let done = 0, failed = 0;
  for (const w of p.writes) {
    try {
      // Files first: a write naming one the side lacks would only keep a known-missing file.
      await handOver(w);
      const answer = w.side === "talaris"
        ? await tal(w.op === "put" ? "PUT" : "PATCH", `/interchange/objects/${encodeURIComponent(w.id)}`, w.op === "put" ? w.body : w.patch)
        : await hermes(w.op === "put" ? "PUT" : "PATCH", `/interchange/objects/${encodeURIComponent(w.id)}`, w.op === "put" ? w.body : w.patch);
      if (answer && answer.ok === false) throw new Error(answer.conflict ? "changed meanwhile" : (answer.reports ?? []).join(", ") || "refused");
      agreed(w.link, w.slots ?? Object.keys(w.values), w.values);
      done++;
    } catch (e) {
      failed++;
      log(`${w.side} ${w.op} ${w.id}: ${e.message}`);
      // A thing that could not be made is not linked: tried again next time.
      if (w.op === "put") state.links = state.links.filter((l) => l !== w.link);
    }
  }
  state.mode = s.mode;
  state.cursors = { t: T.cursor, h: H.cursor };
  save();
  last = { at: new Date().toISOString(), summary: { ...p.summary, written: done, failed }, error: failed ? `${failed} could not be written (its log says which)` : null, held: heldSaid(p.held) };
  await decideAgain(p.ask);
  await say();
}

/** Statuses held: which still need a meaning, and where — Talaris's in Settings, Types; Hermes Notes' in its type editor. */
function heldSaid(held) {
  if (!held || (!held.talaris.length && !held.hermes.length)) return null;
  const side = (name, list) => (list.length ? `${name}: ${list.join(", ")}` : null);
  return `Statuses go across as done or not until each has a meaning (${[side("Talaris", held.talaris), side("Hermes Notes", held.hermes)].filter(Boolean).join("; ")})`;
}

async function say() {
  const sm = last.summary;
  const when = last.at ? new Date(last.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "";
  const bits = [`Synced ${when}`];
  if (sm?.written) bits.push(`${sm.written} written`);
  if (asked.length) bits.push(`${asked.length} to decide`);
  if (last.error) bits.push(last.error);
  if (last.held) bits.push(last.held);
  if (last.unmarked?.length) bits.push(`Hermes Notes has no type marked as ${last.unmarked.join(", ")} — mark one in its type editor`);
  await status(bits.join(" · "));
}

/** An answer from the person (Settings, Plugins): applied, then the sync runs again to act on it. */
async function decided(item, choice) {
  const [what, a, b, c] = item.split(":");
  if (what === "start") {
    if (choice === "start") { state.started = true; state.mode = words().mode; }
  } else if (what === "same") {
    // same:<kind>:<talaris id>:<hermes id>
    if (choice === "same") {
      state.links = state.links.filter((l) => l.t !== b && l.h !== c);
      state.links.push({ kind: a, t: b, h: c, base: {} });
    } else state.apart.push([b, c]);
  } else if (what === "conflict") {
    // Keep one side's: the other side's value becomes what they last agreed on, so the plan carries the kept one over.
    const l = state.links.find((x) => x.t === a);
    if (l) l.pick = { ...(l.pick ?? {}), [b]: choice };
  } else if (what === "gone") {
    // gone:<kind>:<the id still there>. Again: unlinked, so it is made anew. Here: unlinked and never carried.
    state.links = state.links.filter((l) => l.t !== b && l.h !== b);
    if (choice === "here") state.only = [...new Set([...(state.only ?? []), b])];
  } else if (what === "mode") {
    // Yes: it decides that way from now on. No: it keeps merging while the setting says otherwise.
    if (choice === "go") { state.mode = a; delete state.notMode; } else state.notMode = a;
  }
  save();
  asked = asked.filter((x) => x.id !== item);
  await sync(true);
  return { ok: true };
}

// ------------------------------------------------------------ the MCP server

const TOOLS = [
  { name: "sync_now", description: "Sync Talaris with Hermes Notes now.", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: false, title: "Sync with Hermes Notes now" } },
  { name: "restore_files", description: "Linked files deleted from disk on a Talaris task, person or project, put back from the last copy Hermes Notes holds.", inputSchema: { type: "object", properties: { entity: { type: "string" } }, required: ["entity"] }, annotations: { readOnlyHint: false, title: "Restore missing files from Hermes Notes" } },
  { name: "sync_status", description: "How the sync with Hermes Notes stands: when it last ran, what it wrote, what waits to be decided.", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true, title: "Sync status" } },
];

function statusText() {
  const sm = last.summary;
  return [
    state.started ? `Last synced ${last.at ?? "not yet since it started"}.` : "Not started: the first sync waits to be confirmed in Settings, Plugins.",
    sm ? `${sm.written} written; ${sm.toHermes} made in Hermes Notes, ${sm.toTalaris} in Talaris; ${sm.conflicts} differing.` : "",
    asked.length ? `To decide: ${asked.map((d) => d.title).join("; ")}.` : "Nothing to decide.",
    last.error ? `Problem: ${last.error}` : "",
    last.held ? `${last.held}.` : "",
    `${state.links.length} things linked.`,
  ].filter(Boolean).join(" ");
}

let timer = null;
function schedule() {
  clearInterval(timer);
  const minutes = Math.max(1, Number(settings.minutes) || 5);
  timer = setInterval(() => void sync(), minutes * 60_000);
}

createInterface({ input: process.stdin }).on("line", async (line) => {
  if (!line.trim()) return;
  let m;
  try { m = JSON.parse(line); } catch { return; }
  if (m.id !== undefined && !m.method) {
    const w = waiting.get(m.id);
    waiting.delete(m.id);
    if (w) (m.error ? w.fail(new Error(m.error.message)) : w.ok(m.result));
    return;
  }
  if (m.method === "notifications/initialized") { schedule(); setTimeout(() => void sync(), 2000); return; }
  if (m.method === "notifications/talaris/settings_changed") { settings = m.params?.settings ?? settings; schedule(); void sync(true); return; }
  if (m.id === undefined) return;
  const reply = (result) => send({ jsonrpc: "2.0", id: m.id, result });
  try {
    if (m.method === "initialize") {
      settings = m.params?.capabilities?.experimental?.talaris?.settings ?? {};
      return reply({ protocolVersion: m.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "hermes-sync", version: "0.1.0" } });
    }
    if (m.method === "ping") return reply({});
    if (m.method === "tools/list") return reply({ tools: TOOLS });
    if (m.method === "tools/call") {
      // Pressed from a sheet too (a Sync now button: {entity, kind}), and it is the same sync: everything that changed.
      if (m.params?.name === "sync_now") { await sync(true); return reply({ content: [{ type: "text", text: statusText() }], ...(last.error ? { isError: true } : {}) }); }
      if (m.params?.name === "restore_files") { const r = await restoreFiles(String(m.params?.arguments?.entity ?? "")); return reply({ content: [{ type: "text", text: r.text }], ...(r.error ? { isError: true } : {}) }); }
      if (m.params?.name === "sync_status") return reply({ content: [{ type: "text", text: statusText() }] });
      return reply({ content: [{ type: "text", text: `no tool ${m.params?.name}` }], isError: true });
    }
    if (m.method === "talaris/decided") return reply(await decided(String(m.params?.item ?? ""), String(m.params?.choice ?? "")));
    send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: `no method ${m.method}` } });
  } catch (e) {
    send({ jsonrpc: "2.0", id: m.id, error: { code: -32000, message: e.message } });
  }
});
