// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore

import { request } from "node:http";
import { createInterface } from "node:readline";
import { SOCKET } from "./paths.js";

/**
 * `talaris-core mcp`: the entity graph for any MCP client on this machine —
 * Morgan, Claude Code, Claude Desktop, the Oracle's `claude`.
 *
 * Standard input and output only (DESIGN, *Entities → Morgan*): the store is
 * sealed on disk and this hands out what is in it, opened, so it is reached
 * only by something started as the user, here. It asks the running core over
 * its socket and holds nothing itself.
 *
 * The reading tools say they are read-only (`readOnlyHint`), so a client can
 * be given those and not the rest.
 */

const PROTOCOL = "2025-06-18";

function core<T>(method: string, path: string, body?: unknown): Promise<T> {
  return new Promise((ok, fail) => {
    const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const req = request({ socketPath: SOCKET, method, path, headers: data ? { "content-type": "application/json" } : {} }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let parsed: unknown = text;
        try { parsed = JSON.parse(text); } catch { /* kept as text */ }
        if ((res.statusCode ?? 500) >= 400) {
          const why = (parsed as { error?: string })?.error ?? text;
          fail(new Error(res.statusCode === 423 ? `Talaris's store is locked: ${why}` : why));
        } else ok(parsed as T);
      });
    });
    req.on("error", () => fail(new Error("Talaris is not running (no core on its socket)")));
    if (data) req.write(data);
    req.end();
  });
}

interface Summary { id: string; title: string; kinds: string[]; stub?: boolean }
interface Connection { by: string; name: string; via?: string; entity: Summary }
interface Read { entity: Record<string, unknown> & { properties: Record<string, unknown> }; title: string; kinds: string[]; out: Connection[]; in: Connection[] }

const KINDS = ["contact", "event", "note", "task", "project"];
const ROLE: Record<string, string> = { contact: "person", person: "person", event: "event", note: "note", task: "task", project: "project" };
const kindWord = (kinds: string[]) => (kinds.includes("contact") ? "person" : kinds.find((k) => KINDS.includes(k)) ?? "thing");
const line = (s: Summary) => `- ${s.title} (${kindWord(s.kinds)}${s.stub ? ", only a name so far" : ""}) [${s.id}]`;

/** An entity as a person would want it read: what it is, what it says, and everything it touches. */
function describe(r: Read): string {
  const out: string[] = [`${r.title} — ${kindWord(r.kinds)} [${r.entity.id}]`];
  const skip = new Set(["title"]);
  const refs = new Set([...r.out.filter((c) => c.by === "field").map((c) => c.name)]);
  for (const [k, v] of Object.entries(r.entity.properties)) {
    if (skip.has(k) || refs.has(k) || v === null || v === undefined) continue;
    const text = typeof v === "string" ? v : Array.isArray(v) && v.every((x) => typeof x === "string") ? v.join(", ") : JSON.stringify(v);
    out.push(`${k}: ${text.length > 2000 ? text.slice(0, 2000) + "…" : text}`);
  }
  if (Array.isArray(r.entity.tags) && r.entity.tags.length) out.push(`tags: ${(r.entity.tags as string[]).join(", ")}`);
  const group = (cs: Connection[], heading: (n: string) => string) => {
    const by = new Map<string, Connection[]>();
    for (const c of cs) by.set(c.name, [...(by.get(c.name) ?? []), c]);
    for (const [name, list] of by) {
      // The count said outright: a long list is cut short on its way to a model,
      // which then counted what it could see (98 of an event's 146 invitees).
      out.push("", `${heading(name).replace(/:$/, "")} (${list.length}):`);
      for (const c of list) out.push(line(c.entity));
    }
  };
  group(r.out, (n) => `${n}:`);
  group(r.in, (n) => `connected to this as ${n}:`);
  if (!r.out.length && !r.in.length) out.push("", "Nothing is connected to it yet.");
  return out.join("\n");
}

interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: { readOnlyHint: boolean; title: string };
  run: (args: Record<string, unknown>) => Promise<string>;
}

const str = (v: unknown) => (typeof v === "string" ? v : "");

const TOOLS: Tool[] = [
  {
    name: "talaris_find",
    description: "Find people, events, notes, tasks and projects kept in Talaris by words in their title or text. Returns each with its id, for talaris_read.",
    inputSchema: { type: "object", properties: {
      query: { type: "string", description: "Words to look for; empty lists the most likely." },
      kind: { type: "string", enum: ["person", "event", "note", "task", "project"], description: "Only this kind." },
      limit: { type: "number", description: "At most this many (default 20)." },
    } },
    annotations: { readOnlyHint: true, title: "Find in Talaris" },
    run: async (a) => {
      const kind = a.kind ? (a.kind === "person" ? "contact" : str(a.kind)) : "";
      const q = new URLSearchParams({ q: str(a.query), limit: String(Number(a.limit) || 20), ...(kind ? { kind } : {}) });
      const found = await core<Summary[]>("GET", `/entities?${q}`);
      return found.length ? found.map(line).join("\n") : "Nothing in Talaris matches that.";
    },
  },
  {
    name: "talaris_read",
    description: "Read one Talaris entity and everything connected to it, both ways: an event's attendees and organizer, the events and notes a person turns up in, what a project holds, the notes linked to anything.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    annotations: { readOnlyHint: true, title: "Read from Talaris" },
    run: async (a) => describe(await core<Read>("GET", `/entities/${encodeURIComponent(str(a.id))}`)),
  },
  {
    name: "talaris_create",
    description: "Make a new person, event, note, task or project in Talaris. Returns its id. To find or make a person by email, give kind person and email.",
    inputSchema: { type: "object", properties: {
      kind: { type: "string", enum: ["person", "event", "note", "task", "project"] },
      title: { type: "string" },
      body: { type: "string", description: "A note's text." },
      email: { type: "string", description: "A person's email." },
    }, required: ["kind", "title"] },
    annotations: { readOnlyHint: false, title: "Create in Talaris" },
    run: async (a) => {
      if (a.kind === "person" && a.email) {
        const p = await core<{ id: string }>("POST", "/entities/person", { email: str(a.email), name: str(a.title) });
        return `${str(a.title)} [${p.id}]`;
      }
      const role = ROLE[str(a.kind)];
      if (!role) throw new Error("kind is person, event, note, task or project");
      const properties: Record<string, unknown> = { title: str(a.title) };
      if (a.body) properties.body = str(a.body);
      const made = await core<{ id: string }>("POST", "/entities", { role, properties });
      return `Made ${str(a.title)} [${made.id}]`;
    },
  },
  {
    name: "talaris_connect",
    description: "Connect one Talaris entity to another — a note to the person or event it is about, a task to its project. Talaris files it where that kind of thing declares such a link.",
    inputSchema: { type: "object", properties: { from: { type: "string" }, to: { type: "string" } }, required: ["from", "to"] },
    annotations: { readOnlyHint: false, title: "Connect in Talaris" },
    run: async (a) => {
      const c = await core<Connection>("POST", `/entities/${encodeURIComponent(str(a.from))}/connect`, { to: str(a.to) });
      return `Connected, as ${c.name}, to ${c.entity.title}.`;
    },
  },
  {
    name: "talaris_update",
    description: "Change fields of a Talaris entity: a title, a note's body, a person's notes, a task's status (todo, doing, done). Only the fields given change; a field set to an empty string is removed.",
    inputSchema: { type: "object", properties: {
      id: { type: "string" },
      fields: { type: "object", description: "Field names and their new values, e.g. {\"notes\": \"Prefers mornings\"}." },
    }, required: ["id", "fields"] },
    annotations: { readOnlyHint: false, title: "Update in Talaris" },
    run: async (a) => {
      const e = await core<{ version: number }>("PATCH", `/entities/${encodeURIComponent(str(a.id))}`, { properties: a.fields ?? {} });
      return `Updated (version ${e.version}).`;
    },
  },
];

type Message = { jsonrpc: "2.0"; id?: number | string; method?: string; params?: Record<string, unknown> };

function reply(id: Message["id"], result: unknown): void {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}
function error(id: Message["id"], code: number, message: string): void {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n");
}

async function answer(m: Message): Promise<void> {
  if (m.id === undefined) return; // a notification: nothing to say back
  switch (m.method) {
    case "initialize":
      return reply(m.id, {
        protocolVersion: typeof m.params?.protocolVersion === "string" ? m.params.protocolVersion : PROTOCOL,
        capabilities: { tools: {} },
        serverInfo: { name: "talaris", version: "0.1.0" },
        instructions: "Talaris keeps the user's people, events (mirrored from their calendars, with invitees as people), notes, tasks and projects, all connected. Find with talaris_find, then talaris_read for everything connected to one.",
      });
    case "ping":
      return reply(m.id, {});
    case "tools/list":
      return reply(m.id, { tools: TOOLS.map(({ run: _run, ...t }) => t) });
    case "tools/call": {
      const tool = TOOLS.find((t) => t.name === m.params?.name);
      if (!tool) return error(m.id, -32602, `no tool ${String(m.params?.name)}`);
      try {
        const text = await tool.run((m.params?.arguments as Record<string, unknown>) ?? {});
        return reply(m.id, { content: [{ type: "text", text }] });
      } catch (e) {
        return reply(m.id, { content: [{ type: "text", text: (e as Error).message }], isError: true });
      }
    }
    default:
      return error(m.id, -32601, `no method ${String(m.method)}`);
  }
}

const inFlight = new Set<Promise<void>>();

export function serveMcp(): void {
  const lines = createInterface({ input: process.stdin });
  lines.on("line", (text) => {
    if (!text.trim()) return;
    let m: Message;
    try {
      m = JSON.parse(text) as Message;
    } catch {
      error(null as unknown as undefined, -32700, "not JSON");
      return;
    }
    const pending = answer(m);
    inFlight.add(pending);
    void pending.finally(() => inFlight.delete(pending));
  });
  // Input closed: finish what was asked, then go.
  lines.on("close", () => void Promise.allSettled([...inFlight]).then(() => process.exit(0)));
}
