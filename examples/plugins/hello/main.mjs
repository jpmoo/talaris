// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore
//
// The Hello plugin: an MCP server on standard input and output, with no
// dependencies, so every part of the protocol is in view. Talaris is the
// client. It asks this for its tools and calls them; this asks Talaris, on the
// same connection, for its settings (`talaris/settings`), for things through
// the interchange binding (`talaris/interchange`), to notify
// (`talaris/notify`) and to show a line about itself (`talaris/status`).

import { createInterface } from "node:readline";

let next = 1;
const waiting = new Map();
const send = (m) => process.stdout.write(JSON.stringify(m) + "\n");
const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
// Asking Talaris: a request from this side, answered on the same line.
const talaris = (method, params) => new Promise((ok, fail) => {
  const id = `h${next++}`;
  waiting.set(id, { ok, fail });
  send({ jsonrpc: "2.0", id, method, params });
});
let settings = {};

const TOOLS = [
  { name: "count_open_tasks", description: "How many tasks are open in Talaris.", inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true, title: "Count open tasks" } },
  { name: "leave_a_note", description: "Leave a note in Talaris, the greeting first and then the words given.",
    inputSchema: { type: "object", properties: { words: { type: "string" } }, required: ["words"] },
    annotations: { readOnlyHint: false, title: "Leave a note" } },
];

async function call(name, args) {
  if (name === "count_open_tasks") {
    const env = await talaris("talaris/interchange", { method: "GET", path: "/interchange?profile=task" });
    const types = new Map((env.types ?? []).map((t) => [t.id, t]));
    const open = (env.objects ?? []).filter((o) => {
      const map = types.get(o.type)?.profiles?.task;
      return map && !(map.completeValues ?? []).includes(o.properties?.[map.status]);
    });
    await talaris("talaris/status", { text: `${open.length} open task(s) when last counted` });
    return `${open.length} open task(s).`;
  }
  if (name === "leave_a_note") {
    const conf = await talaris("talaris/interchange", { method: "GET", path: "/interchange?profile=note" });
    const note = (conf.types ?? []).find((t) => t.profiles?.note);
    if (!note) throw new Error("Talaris has no note type");
    const map = note.profiles.note;
    const id = `hello-${Date.now().toString(36)}`;
    const words = `${settings.greeting ?? "Hello"} — ${String(args.words ?? "")}`;
    const made = await talaris("talaris/interchange", { method: "PUT", path: `/interchange/objects/${id}`,
      body: { type: note.id, properties: { [map.title]: words.slice(0, 80), ...(map.body && map.body !== "content" ? { [map.body]: words } : {}) } } });
    await talaris("talaris/notify", { title: "Hello", body: `Left a note: ${words.slice(0, 60)}` });
    return made.ok ? `Left a note (${id}).` : `Could not: ${made.reports?.join(", ")}`;
  }
  throw new Error(`no tool ${name}`);
}

createInterface({ input: process.stdin }).on("line", async (line) => {
  if (!line.trim()) return;
  const m = JSON.parse(line);
  // An answer to something asked of Talaris.
  if (m.id !== undefined && !m.method) {
    const w = waiting.get(m.id);
    waiting.delete(m.id);
    if (w) (m.error ? w.fail(new Error(m.error.message)) : w.ok(m.result));
    return;
  }
  if (m.method === "notifications/talaris/settings_changed") { settings = m.params?.settings ?? settings; return; }
  if (m.id === undefined) return;
  try {
    if (m.method === "initialize") {
      // Talaris's extension comes in its capabilities: what may be asked, and this plugin's settings.
      settings = m.params?.capabilities?.experimental?.talaris?.settings ?? {};
      reply(m.id, { protocolVersion: m.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "hello", version: "0.1.0" } });
      return;
    }
    if (m.method === "ping") return reply(m.id, {});
    if (m.method === "tools/list") return reply(m.id, { tools: TOOLS });
    if (m.method === "tools/call") {
      try {
        return reply(m.id, { content: [{ type: "text", text: await call(m.params.name, m.params.arguments ?? {}) }] });
      } catch (e) {
        return reply(m.id, { content: [{ type: "text", text: e.message }], isError: true });
      }
    }
    send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: `no method ${m.method}` } });
  } catch (e) {
    send({ jsonrpc: "2.0", id: m.id, error: { code: -32000, message: e.message } });
  }
});
