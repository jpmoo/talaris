// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { connect } from "node:net";
import { chmodSync, existsSync, mkdirSync, statSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import type { CanvasDocument, Health } from "@talaris/model";
import { projectsRoot } from "./paths.js";
import { findMentionables, placeEntity, placeOf } from "./mentionables.js";
import { Conflict, NotFound, adoptFolder, createProject, findProject, listProjects, attachedFile, putProjectFile, readProject, renameProject, readProjectFile, writeExport } from "./projects.js";
import {
  backlinks,
  canvasTree,
  renameCanvas,
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
  pageLook,
  setPageLook,
} from "./pages.js";

import * as entities from "./entities.js";
import * as tasks from "./tasks.js";
import * as lists from "./lists.js";
import "./mentions.js";
import { exportEnvelope } from "./interchange.js";
import { Locked, recoveryKept, recoveryState, replaceRecovery, unlock } from "./vault.js";
import { SealError } from "./seal.js";
import { backupNow, backupStatus, previewBackup, reviveBackup } from "./backup.js";
import { encryptedProjects, setProjectEncrypted } from "./sealed-projects.js";

/**
 * The core's HTTP, on a Unix socket. No port is opened: a port would make every
 * process on the machine a client of something that holds a person's work.
 * Plain `node:http` rather than a framework, because the routes are few and the
 * dependency would be most of the code.
 */

export const VERSION = "0.0.0";

/** A request body larger than this is refused rather than read. */
const MAX_BODY = 64 * 1024 * 1024;

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
route("PUT", "/projects/:id/name", async (req, [id]) => {
  const b = await json<{ name?: string }>(req);
  const p = renameProject(id!, b.name ?? "");
  tasks.taskProjects(); // its entity takes the new name
  return p;
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
route("PUT", "/projects/:id/canvases/:cid/title", async (req, [id, cid]) => {
  const b = await json<{ title?: string }>(req);
  return renameCanvas(id!, cid!, b.title ?? "");
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
// A project's files (projects.ts, `Files/`): attached to a page or a canvas note, linked by their path.
route("POST", "/projects/:id/files", async (req, [id]) => {
  const b = await json<{ name?: string; data?: string }>(req);
  if (!b.name || !b.data) throw new BadRequest("a file has a name and data (base64)");
  return putProjectFile(id!, b.name, Buffer.from(b.data, "base64"));
});
// Where it is, to be opened as it is — or, sealed, its bytes, to be opened as a copy.
route("GET", "/projects/:id/file", (_r, [id], q) => {
  const at = attachedFile(id!, need(q, "path"));
  return { path: need(q, "path"), abs: at.abs, sealed: at.sealed };
});
route("GET", "/projects/:id/file/data", (_r, [id], q) => ({ data: readProjectFile(id!, need(q, "path")).toString("base64") }));
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
route("GET", "/projects/:id/page/look", (_r, [id], q) => pageLook(id!, need(q, "path")));
route("PUT", "/projects/:id/page/look", async (req, [id], q) =>
  setPageLook(id!, need(q, "path"), await json<{ paper?: string | null }>(req)));
route("GET", "/projects/:id/page/versions", (_r, [id], q) => pageVersions(id!, need(q, "path")));
route("GET", "/projects/:id/page/versions/:name", (_r, [id, name], q) => pageVersion(id!, need(q, "path"), name!));
route("POST", "/projects/:id/page/versions/:name/restore", (_r, [id, name], q) =>
  restorePage(id!, need(q, "path"), name!));

// ------------------------------------------------------------ entities

route("GET", "/entities", (_r, _p, q) =>
  entities.findEntities({ q: q.get("q") ?? "", kind: q.get("kind") ?? undefined, limit: Number(q.get("limit") ?? 50), archived: q.get("archived") === "1", prefer: q.get("prefer") ?? undefined }));
route("POST", "/entities", async (req) => entities.createEntity(await json<entities.NewEntity>(req)));
route("GET", "/entities/by-source", (_r, _p, q) => entities.bySource({ kind: need(q, "kind"), key: need(q, "key") }));
route("POST", "/entities/mirror/events", async (req) => {
  const b = await json<{ events?: entities.MirroredEvent[] }>(req);
  return { ids: (b.events ?? []).map((e) => entities.mirrorEvent(e).id) };
});
route("POST", "/entities/person", async (req) => {
  const b = await json<{ email?: string; name?: string }>(req);
  if (!b.email) throw new BadRequest("a person is found by email");
  if (!entities.isPersonAddress(b.email)) throw new BadRequest("that address is a calendar's, not a person's");
  return entities.personFor(b.email, b.name);
});
// What an @ can link (mentionables.ts): entities, pages and canvases, this project's first.
route("GET", "/mentionables", (_r, _p, q) =>
  findMentionables(q.get("q") ?? "", q.get("project") ?? "", Math.min(Number(q.get("limit") ?? 12), 40)));
// A page or a canvas, as the entity that stands for it (made the first time it is linked).
route("POST", "/entities/place", async (req) => {
  const b = await json<{ kind?: string; project?: string; where?: string; title?: string }>(req);
  if ((b.kind !== "page" && b.kind !== "canvas") || !b.project || !b.where) throw new BadRequest("a place is a page or a canvas, in a project");
  return placeEntity(b.kind, b.project, b.where, b.title ?? "");
});
// Where an entity standing for a page or a canvas points, to open it there; null for any other.
route("GET", "/entities/:id/place", (_r, [id]) => placeOf(entities.getEntity(id!)));
// Which of these addresses are people already: an @ picker's address-book finds, told apart from the new.
route("POST", "/entities/people/known", async (req) => {
  const b = await json<{ emails?: string[] }>(req);
  const out: Record<string, entities.Summary> = {};
  for (const e of b.emails ?? []) { const p = entities.byEmail(e); if (p) out[e.toLowerCase()] = entities.summary(p); }
  return out;
});
route("GET", "/entities/:id", (_r, [id]) => {
  const { entity, out, in: incoming } = entities.connections(id!);
  return { entity, title: entities.titleOf(entity), kinds: entities.profilesOf(entity), out, in: incoming };
});
route("PATCH", "/entities/:id", async (req, [id]) => entities.updateEntity(id!, await json<entities.Patch>(req)));
route("DELETE", "/entities/:id", (_r, [id]) => {
  entities.deleteEntity(id!);
  return { ok: true };
});
route("POST", "/entities/:id/connect", async (req, [id]) => {
  const b = await json<{ to?: string; type?: string; via?: string }>(req);
  if (!b.to) throw new BadRequest("connect to what?");
  return entities.connect(id!, b.to, b);
});
route("DELETE", "/entities/:id/connect/:to", (_r, [id, to]) => {
  entities.disconnect(id!, to!);
  return { ok: true };
});
route("POST", "/entities/:id/files", async (req, [id]) => {
  const b = await json<{ filename?: string; mediaType?: string; data?: string; field?: string }>(req);
  if (!b.filename || !b.data) throw new BadRequest("a file has a name and data (base64)");
  const value = entities.putFile(Buffer.from(b.data, "base64"), b.filename, b.mediaType);
  if (b.field) {
    // A field of many files gains this one (once, by its hash); a field of one is this one.
    const o = entities.getEntity(id!);
    const many = entities.types().find((t) => t.id === o.type)?.fields.find((f) => f.key === b.field)?.many;
    const now = Array.isArray(o.properties[b.field]) ? (o.properties[b.field] as { sha256: string }[]) : [];
    if (!many) entities.updateEntity(id!, { properties: { [b.field]: value } });
    else if (!now.some((a) => a.sha256 === value.sha256)) entities.updateEntity(id!, { properties: { [b.field]: [...now, value] } });
  }
  return value;
});
route("GET", "/entity-types", () => entities.types());
route("GET", "/interchange/export", () => exportEnvelope());

// ------------------------------------------------------------ tasks and lists (DESIGN, Tasks)

route("GET", "/tasks/projects", () => tasks.taskProjects());
route("POST", "/tasks/projects", async (req) => {
  const b = await json<{ title?: string }>(req);
  return tasks.createTaskProject(b.title ?? "");
});
route("GET", "/tasks/projects/:id", (_r, [id]) => lists.showProject(id!));
route("POST", "/tasks", async (req) => {
  const b = await json<tasks.NewTask & { list?: string; region?: string }>(req);
  if (!b.title) throw new BadRequest("a task has a title");
  const t = tasks.createTask(b);
  // Made from inside a list by hand (or a board's column): it lands there.
  if (b.list) {
    const l = lists.getList(b.list);
    if (l.membership.mode === "explicit" || l.kind === "matrix" || l["talaris:bind"]) lists.addMember(b.list, t.id, b.region ? { region: b.region } : {});
  }
  return entities.getEntity(t.id);
});
route("GET", "/tasks/find", (_r, _p, q) => lists.findTasks({
  status: q.get("status") ?? undefined, when: q.get("when") ?? undefined, project: q.get("project") ?? undefined,
  tag: q.get("tag") ?? undefined, text: q.get("text") ?? undefined, list: q.get("list") ?? undefined,
  limit: q.get("limit") ? Number(q.get("limit")) : undefined,
}));
route("PUT", "/tasks/statuses", async (req) => {
  const b = await json<{ statuses?: tasks.StatusDef[]; default?: string; moveTo?: Record<string, string> }>(req);
  if (!b.statuses || !b.default) throw new BadRequest("the statuses, and which a new task starts in");
  return tasks.setStatuses(b.statuses, b.default, b.moveTo ?? {});
});
route("POST", "/tasks/:id/attachments", async (req, [id]) => {
  const b = await json<{ filename?: string; mediaType?: string; data?: string }>(req);
  if (!b.filename || !b.data) throw new BadRequest("a file has a name and data (base64)");
  return tasks.attachFile(id!, Buffer.from(b.data, "base64"), b.filename, b.mediaType);
});
route("DELETE", "/tasks/:id/attachments/:sha", (_r, [id, sha]) => {
  tasks.detachFile(id!, sha!);
  return { ok: true };
});
route("GET", "/files/:sha", (_r, [sha]) => {
  const bytes = entities.getFile(sha!);
  if (!bytes) throw new NotFound(`no file ${sha}`);
  return { sha256: sha, data: bytes.toString("base64") };
});
route("GET", "/tasks/types", () => {
  const t = entities.typeFor("task");
  return { type: t, shape: tasks.taskShape(t) };
});
route("GET", "/tasks/:id/recurrence", (_r, [id]) => tasks.recurrenceOf(id!));
route("PUT", "/tasks/:id/recurrence", async (req, [id]) => {
  const b = await json<{ rule?: unknown }>(req);
  return tasks.setRecurrence(id!, (b.rule ?? null) as never);
});
route("GET", "/lists", (_r, _p, q) => lists.allLists({ archived: q.get("archived") === "1" }));
route("POST", "/lists", async (req) => lists.createList(await json<lists.NewList>(req)));
route("POST", "/lists/preview", async (req) => {
  const b = await json<{ query?: lists.Condition }>(req);
  if (!b.query) throw new BadRequest("a query to preview");
  const found = lists.runQuery(b.query);
  return { count: found.length, rows: found.slice(0, 50).map((o) => ({ id: o.id, title: entities.titleOf(o), kinds: entities.profilesOf(o) })) };
});
route("GET", "/lists/:id", (_r, [id]) => lists.showList(id!));
route("PATCH", "/lists/:id", async (req, [id]) => lists.updateList(id!, await json<lists.ListPatch>(req)));
route("DELETE", "/lists/:id", (_r, [id]) => {
  lists.deleteList(id!);
  return { ok: true };
});
route("POST", "/lists/:id/refresh", (_r, [id]) => lists.refresh(id!));
route("POST", "/lists/:id/members", async (req, [id]) => {
  const b = await json<{ object?: string; region?: string; after?: string | null; before?: string | null }>(req);
  if (!b.object) throw new BadRequest("which object?");
  return lists.addMember(id!, b.object, b);
});
route("DELETE", "/lists/:id/members/:object", (_r, [id, object]) => lists.removeMember(id!, object!));

// ------------------------------------------------------------ the vault, backups, encrypted projects

route("GET", "/vault", () => ({ ...recoveryState(), encryptedProjects: safely(encryptedProjects, []), backups: backupStatus() }));
route("POST", "/vault/recovery-kept", () => {
  recoveryKept();
  return recoveryState();
});
route("POST", "/vault/recovery/replace", () => ({ recoveryKey: replaceRecovery() }));
route("POST", "/vault/unlock", async (req) => {
  const b = await json<{ recoveryKey?: string }>(req);
  if (!b.recoveryKey) throw new BadRequest("the recovery key, please");
  unlock(b.recoveryKey);
  entities.reloadEntities();
  return recoveryState();
});
route("POST", "/backups/now", () => backupNow("asked"));
route("POST", "/backups/preview", async (req) => {
  const b = await json<{ file?: string; recoveryKey?: string }>(req);
  if (!b.file || !b.recoveryKey) throw new BadRequest("a backup file and its recovery key");
  return previewBackup(b.file, b.recoveryKey);
});
route("POST", "/backups/revive", async (req) => {
  const b = await json<{ file?: string; recoveryKey?: string }>(req);
  if (!b.file || !b.recoveryKey) throw new BadRequest("a backup file and its recovery key");
  return reviveBackup(b.file, b.recoveryKey);
});
route("PUT", "/projects/:id/encrypted", async (req, [id]) => {
  const b = await json<{ on?: boolean }>(req);
  return setProjectEncrypted(id!, b.on === true);
});

function safely<T>(f: () => T, fallback: T): T {
  try { return f(); } catch { return fallback; }
}

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
    // Locked is its own answer: the store is there, and needs its key.
    const status = e instanceof NotFound ? 404 : e instanceof Conflict ? 409 : e instanceof BadRequest || e instanceof SealError ? 400
      : e instanceof Locked ? 423 : 500;
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
