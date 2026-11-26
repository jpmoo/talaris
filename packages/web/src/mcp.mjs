// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore

/**
 * Talaris's MCP over HTTPS (docs/WEB.md, *Claude and Morgan*): the same tools `talaris-core mcp` offers on a desktop
 * (the core's mcp.ts — Talaris's own, and Hermes Notes' by their names, mcp-hermes.ts), at `/talaris/mcp`, for a
 * claude.ai connector and for Morgan. Stateless streamable HTTP: each POST is JSON-RPC (one message or a batch),
 * answered as JSON; no sessions, no server-sent stream.
 *
 * Who asks is its token (auth.mjs): Claude's, from OAuth; Morgan's, made by `talaris-web token`. A read-only token
 * is offered only the tools that change nothing. What only a desktop can do (what is on its screen, its windows) is
 * not offered here: this machine has no screen.
 */

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as auth from "./auth.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CORE = resolve(HERE, "..", "..", "core", "dist", "src");
const PROTOCOL = "2025-06-18";

let mod = null;
async function core() {
  if (mod) return mod;
  const m = await import(join(CORE, "mcp.js"));
  const desk = await import(join(CORE, "mcp-desktop.js"));
  // The desktop's own tools, by name: left out here.
  const screen = new Set(desk.desktopTools(async () => null).map((t) => t.name));
  mod = { m, screen };
  return mod;
}

/** The core's client name for a token: Morgan is "heymorgan" there, and is offered its activity tools too. */
const clientOf = (t) => (t.client === "morgan" ? "heymorgan" : `web:${t.client}`);

async function tools(t) {
  const { m, screen } = await core();
  const listed = m.listTools ? await m.listTools(clientOf(t)) : m.toolsFor(clientOf(t)).map(({ run: _run, ...x }) => x);
  return listed.filter((x) => !screen.has(x.name) && (!t.readOnly || x.annotations?.readOnlyHint === true));
}

async function answer(msg, t) {
  if (msg.id === undefined) return null; // a notification: nothing said back
  const ok = (result) => ({ jsonrpc: "2.0", id: msg.id, result });
  const err = (code, message) => ({ jsonrpc: "2.0", id: msg.id, error: { code, message } });
  switch (msg.method) {
    case "initialize":
      return ok({
        protocolVersion: typeof msg.params?.protocolVersion === "string" ? msg.params.protocolVersion : PROTOCOL,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "talaris", version: "0.1.0" },
        instructions: "Talaris keeps the user's tasks, projects, notes (pages), people, calendar and canvases, all connected. " +
          "The tools named as Hermes Notes' were (task_find, daily_note_get, collection_members…) work as they did there; " +
          "talaris_context, talaris_find and talaris_read reach everything around a name or some words.",
      });
    case "ping":
      return ok({});
    case "tools/list":
      return ok({ tools: await tools(t) });
    case "tools/call": {
      const name = String(msg.params?.name ?? "");
      if (!(await tools(t)).some((x) => x.name === name)) return err(-32602, `no tool ${name}`);
      const { m } = await core();
      const done = await m.callTool(clientOf(t), name, msg.params?.arguments ?? {});
      if (!done) return err(-32602, `no tool ${name}`);
      return ok({ content: [{ type: "text", text: done.text }], ...(done.isError ? { isError: true } : {}) });
    }
    default:
      return err(-32601, `no method ${String(msg.method)}`);
  }
}

/** A POST to the MCP: `{status, body, headers}`, a 401 with the way to sign in when the token is missing or not ours. */
export async function handle(req, body, prefix, resourceMetadataUrl) {
  const bearer = String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "").trim();
  const t = auth.tokenFor(bearer);
  if (!t) {
    return { status: 401, headers: { "www-authenticate": `Bearer resource_metadata="${resourceMetadataUrl}"` },
      body: { error: bearer ? "That key is not Talaris's, or was taken back" : "Sign in: Authorization: Bearer <key>" } };
  }
  if (Array.isArray(body)) {
    const out = (await Promise.all(body.map((m) => answer(m, t)))).filter(Boolean);
    return out.length ? { status: 200, body: out } : { status: 202, body: "" };
  }
  const one = await answer(body, t);
  return one ? { status: 200, body: one } : { status: 202, body: "" };
}
