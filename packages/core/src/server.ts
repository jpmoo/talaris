// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { connect } from "node:net";
import { chmodSync, existsSync, mkdirSync, statSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import type { CanvasDocument, Health } from "@talaris/model";
import { projectsRoot } from "./paths.js";
import { Conflict, NotFound, adoptFolder, createProject, findProject, listProjects, readProject, writeExport } from "./projects.js";
import {
  backlinks,
  canvasTree,
  canvasVersion,
  canvasVersions,
  createChild,
  deleteCanvas,
  readCanvas,
  restoreCanvas,
  writeCanvas,
} from "./canvases.js";
import {
  createPage,
  dailyEnabled,
  dailyMonth,
  deletePage,
  movePage,
  pageTree,
  pageVersion,
  pageVersions,
  readPage,
  reorderPage,
  restorePage,
  writePage,
} from "./pages.js";

/**
 * The core's HTTP, on a Unix socket. No port is opened: a port would make every
 * process on the machine a client of something that holds a person's work.
 * Plain `node:http` rather than a framework, because the routes are few and the
 * dependency would be most of the code.
 */

export const VERSION = "0.0.0";

/** A request body larger than this is refused rather than read. */
const MAX_BODY = 16 * 1024 * 1024;

class BadRequest extends Error {}

function body(req: IncomingMessage): Promise<string> {
  return new Promise((ok, fail) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        fail(new BadRequest("request too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => ok(Buffer.concat(chunks).toString("utf8")));
    req.on("error", fail);
  });
}

async function json<T>(req: IncomingMessage): Promise<T> {
  const text = await body(req);
  try {
    return (text ? JSON.parse(text) : {}) as T;
  } catch {
    throw new BadRequest("body is not JSON");
  }
}

function send(res: ServerResponse, status: number, value: unknown): void {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  res.writeHead(status, {
    "content-type": typeof value === "string" ? "text/markdown; charset=utf-8" : "application/json",
  });
  res.end(text);
}

type Handler = (req: IncomingMessage, params: string[], query: URLSearchParams) => Promise<unknown> | unknown;
const routes: Array<[string, RegExp, Handler]> = [];
function route(method: string, pattern: string, handler: Handler): void {
  const re = new RegExp("^" + pattern.replace(/:[a-z]+/g, "([^/]+)") + "$");
  routes.push([method, re, handler]);
}

function need(query: URLSearchParams, key: string): string {
  const v = query.get(key);
  if (!v) throw new BadRequest(`?${key}= is required`);
  return v;
}

route("GET", "/health", (): Health => ({ ok: true, name: "talaris-core", version: VERSION, projectsRoot: projectsRoot() }));

route("GET", "/projects", () => listProjects());
route("POST", "/projects", async (req) => {
  const b = await json<{ name?: string; adopt?: string }>(req);
  if (b.adopt) return adoptFolder(b.adopt, b.name);
  if (!b.name) throw new BadRequest("a project needs a name");
  return createProject(b.name);
});
route("GET", "/projects/:id", (_r, [id]) => {
  const p = findProject(id!);
  return { ...p, project: readProject(p.folder) };
});

route("GET", "/projects/:id/canvases", (_r, [id]) => canvasTree(id!));
route("GET", "/projects/:id/canvases/:cid", (_r, [id, cid]) => readCanvas(id!, cid!));
route("PUT", "/projects/:id/canvases/:cid", async (req, [id, cid], q) => {
  const doc = await json<CanvasDocument>(req);
  if (doc.id !== cid) throw new BadRequest("the body is a different canvas");
  return writeCanvas(id!, doc, { detach: q.get("detach") === "1" });
});
route("DELETE", "/projects/:id/canvases/:cid", (_r, [id, cid]) => {
  deleteCanvas(id!, cid!);
  return { ok: true };
});
route("POST", "/projects/:id/canvases/:cid/children", async (req, [id, cid]) => {
  const b = await json<{ title?: string; x?: number; y?: number }>(req);
  return createChild(id!, cid!, b.title ?? "Untitled", { x: b.x ?? 0, y: b.y ?? 0 });
});
route("GET", "/projects/:id/canvases/:cid/backlinks", (_r, [id, cid]) => backlinks(id!, cid!));
route("GET", "/projects/:id/canvases/:cid/versions", (_r, [id, cid]) => canvasVersions(id!, cid!));
route("GET", "/projects/:id/canvases/:cid/versions/:name", (_r, [id, cid, name]) => canvasVersion(id!, cid!, name!));
route("POST", "/projects/:id/canvases/:cid/versions/:name/restore", (_r, [id, cid, name]) =>
  restoreCanvas(id!, cid!, name!));

route("POST", "/projects/:id/exports", async (req, [id]) => {
  const b = await json<{ name?: string; kind?: string; data?: string }>(req);
  if (!b.data || !b.kind) throw new BadRequest("an export needs its kind and its data, base64");
  const path = writeExport(id!, b.name ?? "Canvas", b.kind, Buffer.from(b.data, "base64"));
  return { path, folder: findProject(id!).folder };
});
route("GET", "/projects/:id/pages", (_r, [id]) => pageTree(id!));
route("GET", "/projects/:id/daily", (_r, [id], q) => ({ enabled: dailyEnabled(id!), days: dailyMonth(id!, need(q, "month")) }));
route("POST", "/projects/:id/pages", async (req, [id]) => {
  const b = await json<{ parent?: string | null; title?: string }>(req);
  return createPage(id!, b.parent ?? null, b.title ?? "Untitled");
});
route("GET", "/projects/:id/page", (_r, [id], q) => readPage(id!, need(q, "path")));
route("PUT", "/projects/:id/page", async (req, [id], q) => {
  writePage(id!, need(q, "path"), await body(req));
  return { ok: true };
});
route("DELETE", "/projects/:id/page", (_r, [id], q) => {
  deletePage(id!, need(q, "path"));
  return { ok: true };
});
route("POST", "/projects/:id/page/move", async (req, [id]) => {
  const b = await json<{ path?: string; parent?: string | null; title?: string; index?: number }>(req);
  if (!b.path) throw new BadRequest("path is required");
  const moved = movePage(id!, b.path, b.parent ?? null, b.title);
  if (typeof b.index === "number") reorderPage(id!, moved.path, b.index);
  return moved;
});
route("GET", "/projects/:id/page/versions", (_r, [id], q) => pageVersions(id!, need(q, "path")));
route("GET", "/projects/:id/page/versions/:name", (_r, [id, name], q) => pageVersion(id!, need(q, "path"), name!));
route("POST", "/projects/:id/page/versions/:name/restore", (_r, [id, name], q) =>
  restorePage(id!, need(q, "path"), name!));

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://talaris");
  const path = url.pathname.split("/").map(decodeURIComponent).join("/");
  try {
    for (const [method, re, handler] of routes) {
      const m = re.exec(url.pathname);
      if (!m || method !== req.method) continue;
      const params = m.slice(1).map(decodeURIComponent);
      const out = await handler(req, params, url.searchParams);
      send(res, 200, out ?? { ok: true });
      return;
    }
    send(res, 404, { error: `no route ${req.method} ${path}` });
  } catch (e) {
    const status = e instanceof NotFound ? 404 : e instanceof Conflict ? 409 : e instanceof BadRequest ? 400 : 500;
    if (status === 500) console.error("talaris-core:", e);
    send(res, status, { error: e instanceof Error ? e.message : String(e) });
  }
}

/** Is something already answering on this socket? */
function alive(path: string): Promise<boolean> {
  return new Promise((ok) => {
    const s = connect(path);
    s.once("connect", () => { s.destroy(); ok(true); });
    s.once("error", () => ok(false));
  });
}

/**
 * Listen, carefully. A socket file left by a crash is removed — but only when
 * nothing answers on it, so a second copy never steals the first one's socket.
 * And on the way out, the socket is unlinked only if it is still *ours*: two
 * cores overlap on every restart, and Talaria's daemon once deleted the socket
 * its successor had just bound, leaving a process listening on a name nobody
 * could find.
 */
export async function listen(socket: string): Promise<Server> {
  mkdirSync(dirname(socket), { recursive: true });
  if (existsSync(socket)) {
    if (await alive(socket)) throw new Error(`another talaris-core is answering on ${socket}`);
    unlinkSync(socket);
  }
  const server = createServer((req, res) => void handle(req, res));
  await new Promise<void>((ok, fail) => {
    server.once("error", fail);
    server.listen(socket, () => ok());
  });
  chmodSync(socket, 0o600);
  const inode = statSync(socket).ino;
  server.on("close", () => {
    try {
      if (statSync(socket).ino === inode) unlinkSync(socket);
    } catch {
      // Already gone.
    }
  });
  return server;
}
