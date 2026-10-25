// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { connect } from "node:net";
import { chmodSync, existsSync, mkdirSync, statSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import type { CanvasDocument, Health } from "@talaris/model";
import { projectsRoot } from "./paths.js";
import { glance, nearProject } from "./glance.js";
import { archiveProject, archivedContents, listArchive, restoreProject, searchArchive, type Restore } from "./archive.js";
import { setStarredOrder, starredOrder } from "./starred.js";
import { findMentionables, placeEntity, placeOf } from "./mentionables.js";
import { Conflict, NotFound, adoptFolder, createProject, findProject, listProjects, attachedFile, putProjectFile, readProject, renameProject, readProjectFile, writeExport } from "./projects.js";
import {
  backlinks,
  canvasTree,
  renameCanvas,
  orderCanvases,
  starCanvas,
  canvasVersion,
  canvasVersions,
  createChild,
  deleteCanvas,
  canvasesBelow,
  readCanvas,
  restoreCanvas,
  writeCanvas,
} from "./canvases.js";
import {
  createPage,
  dailyEnabled,
  dailyMonth,
  deletePage,
  pagesBelow,
  transferPage,
  movePage,
  pageTree,
  pageVersion,
  pageVersions,
  readPage,
  reorderPage,
  orderPages,
  starPage,
  restorePage,
  writePage,
  pageLook,
  setPageLook,
} from "./pages.js";

import * as entities from "./entities.js";
import * as tasks from "./tasks.js";
import * as lists from "./lists.js";
import "./mentions.js";
import { liveManifest, createObject, exportEnvelope, getInterchangeFile, patchObject, putInterchangeFile, readEnvelope, type WritePatch } from "./interchange.js";
import { Gone } from "./feed.js";
import * as plugins from "./plugins.js";
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

/** A request's body as bytes, as they came: a file handed over (*Files*). */
function bodyBytes(req: IncomingMessage): Promise<Buffer> {
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
    req.on("end", () => ok(Buffer.concat(chunks)));
    req.on("error", fail);
  });
}

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
/** An answer with its own status: a create that made something is 201, a refused write 409. */
class Answer {
  constructor(readonly status: number, readonly body: unknown) {}
}
/** Bytes answered as they are — a file — rather than as JSON; for HEAD, the status alone. */
class Bytes {
  constructor(readonly data: Buffer, readonly type = "application/octet-stream") {}
}

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
// The archive: a project out of every context, browsed and brought back here (archive.ts).
route("GET", "/archive", () => listArchive());
route("GET", "/archive/search", (_r, _p, q) => searchArchive(q.get("q") ?? "", Number(q.get("limit") ?? 40)));
route("GET", "/archive/:id", (_r, [id]) => archivedContents(id!));
route("POST", "/projects/:id/archive", (_r, [id]) => archiveProject(id!));
route("POST", "/projects/:id/restore", async (req, [id]) => restoreProject(id!, await json<Restore>(req).catch(() => ({}))));
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
route("DELETE", "/projects/:id/canvases/:cid", (_r, [id, cid], q) => {
  deleteCanvas(id!, cid!, { withChildren: q.get("all") === "1" });
  return { ok: true };
});
// How many are inside: the drawer's second question before deleting them all.
route("GET", "/projects/:id/canvases/:cid/below", (_r, [id, cid]) => ({ count: canvasesBelow(id!, cid!) }));
route("POST", "/projects/:id/canvases/:cid/children", async (req, [id, cid]) => {
  const b = await json<{ title?: string; x?: number; y?: number }>(req);
  return createChild(id!, cid!, b.title ?? "", { x: b.x ?? 0, y: b.y ?? 0 });
});
route("PUT", "/projects/:id/canvases/:cid/star", async (req, [id, cid]) => {
  starCanvas(id!, cid!, Boolean((await json<{ starred?: boolean }>(req)).starred));
  return { ok: true };
});
route("PUT", "/projects/:id/canvases/:cid/order", async (req, [id, cid]) => {
  orderCanvases(id!, cid!, (await json<{ children?: string[] }>(req)).children ?? []);
  return { ok: true };
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
// A project at a glance (glance.ts): its own things, one step out, and how they are tied.
route("GET", "/projects/:id/glance", (_r, [id], q) => glance(id!, Number(q.get("steps") ?? 1), q.get("from") ?? ""));
route("GET", "/projects/:id/pages", (_r, [id]) => pageTree(id!));
route("GET", "/projects/:id/daily", (_r, [id], q) => ({ enabled: dailyEnabled(id!), days: dailyMonth(id!, need(q, "month")) }));
route("POST", "/projects/:id/pages", async (req, [id]) => {
  const b = await json<{ parent?: string | null; title?: string }>(req);
  return createPage(id!, b.parent ?? null, b.title ?? "");
});
route("PUT", "/projects/:id/page/star", async (req, [id], q) => {
  starPage(id!, need(q, "path"), Boolean((await json<{ starred?: boolean }>(req)).starred));
  return { ok: true };
});
route("GET", "/projects/:id/starred-order", (_r, [id]) => starredOrder(id!));
route("PUT", "/projects/:id/starred-order", async (req, [id]) => {
  const b = await json<{ kind?: string; keys?: string[] }>(req);
  if (b.kind !== "pages" && b.kind !== "canvases") throw new BadRequest("kind is pages or canvases");
  return setStarredOrder(id!, b.kind, b.keys ?? []);
});
route("PUT", "/projects/:id/pages/order", async (req, [id]) => {
  const b = await json<{ parent?: string | null; names?: string[] }>(req);
  orderPages(id!, b.parent ?? "", b.names ?? []);
  return { ok: true };
});
route("GET", "/projects/:id/page", (_r, [id], q) => readPage(id!, need(q, "path")));
route("PUT", "/projects/:id/page", async (req, [id], q) => {
  writePage(id!, need(q, "path"), await body(req));
  return { ok: true };
});
route("DELETE", "/projects/:id/page", (_r, [id], q) => {
  deletePage(id!, need(q, "path"), { withChildren: q.get("all") === "1" });
  return { ok: true };
});
route("GET", "/projects/:id/page/below", (_r, [id], q) => ({ pages: pagesBelow(id!, need(q, "path")) }));
// Moved or copied between a project and the undated notes (`notes`), either way.
route("POST", "/projects/:id/page/transfer", async (req, [id]) => {
  const b = await json<{ path?: string; to?: string; parent?: string | null; copy?: boolean }>(req);
  if (!b.path || !b.to) throw new BadRequest("which page, and to where?");
  return transferPage(id!, b.path, b.to, b.parent ?? null, b.copy === true);
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

route("GET", "/entities", (_r, _p, q) => {
  // `near`: a project, whose own things and what they touch come first, and say so.
  const near = q.get("near") ? nearProject(q.get("near")!) : undefined;
  const found = entities.findEntities({ q: q.get("q") ?? "", kind: q.get("kind") ?? undefined, limit: Number(q.get("limit") ?? 50), archived: q.get("archived") === "1", prefer: q.get("prefer") ?? undefined, near });
  return near ? found.map((s) => ({ ...s, near: near.has(s.id) })) : found;
});
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
  findMentionables(q.get("q") ?? "", q.get("project") ?? "", Math.min(Number(q.get("limit") ?? 12), 40), q.get("project") ? nearProject(q.get("project")!) : undefined));
// A page or a canvas, as the entity that stands for it (made the first time it is linked).
route("POST", "/entities/place", async (req) => {
  const b = await json<{ kind?: string; project?: string; where?: string; title?: string }>(req);
  if ((b.kind !== "page" && b.kind !== "canvas") || !b.project || !b.where) throw new BadRequest("a place is a page or a canvas, in a project");
  return placeEntity(b.kind, b.project, b.where, b.title ?? "");
});
// Where an entity standing for a page or a canvas points, to open it there; null for any other.
// Not a page's or a canvas's entity: a 404, not an empty answer — a null here
// was answered {ok: true}, which every page took for a place.
route("GET", "/entities/:id/place", (_r, [id]) => {
  const place = placeOf(entities.getEntity(id!));
  if (!place) throw new NotFound(`${id} is not a page or a canvas`);
  return place;
});
// People (DESIGN, People): each as a row, and their ties to contact cards.
route("GET", "/people", () => entities.listPeople());
// The organizations marked as one's own, for People's "My organizations".
route("GET", "/people/my-organizations", () => entities.myOrganizations());
route("PUT", "/people/my-organizations", async (req) => entities.setMyOrganizations((await json<{ names?: string[] }>(req)).names ?? []));
// Address-book cards as people (People: everyone in your address books).
route("POST", "/people/from-cards", async (req) => {
  const b = await json<{ cards?: entities.Card[] }>(req);
  let made = 0, tied = 0;
  for (const card of b.cards ?? []) {
    const before = entities.bySource({ kind: "eds-contact", key: card.key });
    const p = entities.personFromCard(card);
    // Made from the card just now, or someone already here tied to it.
    if (p && !before) {
      if (p.version === 1) made++;
      else tied++;
    }
  }
  return { made, tied };
});
route("POST", "/people/:id/ties", async (req, [id]) => {
  const b = await json<{ key?: string }>(req);
  return entities.tieContact(id!, b.key ?? "", true);
});
route("DELETE", "/people/:id/ties", (_r, [id], q) => entities.tieContact(id!, need(q, "key"), false));
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
route("PATCH", "/entities/:id", async (req, [id]) => {
  const patch = await json<entities.Patch>(req);
  // A project's entity archived (Tasks' Archive): the project itself is, folder and all.
  const project = entities.getEntity(id!)["talaris:sources"] as { kind: string; key: string }[] | undefined;
  const ws = project?.find((s) => s.kind === "talaris-project")?.key;
  if (ws && patch.archived !== undefined) {
    if (patch.archived) archiveProject(ws);
    else {
      const back = restoreProject(ws);
      if (!back.done) throw new Conflict(`a project called ${back.clash.name} is in use: bring this one back from the archive, to keep both or merge them`);
    }
    const { archived: _a, ...rest } = patch;
    return Object.keys(rest).length ? entities.updateEntity(id!, rest) : entities.getEntity(id!);
  }
  return entities.updateEntity(id!, patch);
});
route("DELETE", "/entities/:id", (_r, [id]) => {
  // A person who came from a contact card is not made again from it.
  entities.forgetCardsOf(id!);
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
// Plugins (plugins.ts): installed, enabled, set, supervised; their tools, for Talaris's MCP.
route("GET", "/plugins", () => plugins.listPlugins());
route("GET", "/plugins/tools", () => plugins.pluginTools());
route("GET", "/plugins/apps", () => plugins.pluginApps());
// Buttons plugins put on a sheet (`[[actions]]`), and one pressed.
route("GET", "/plugins/actions", (_r, _p, q) => plugins.pluginActions(q.get("kind") ?? ""));
route("POST", "/plugins/:id/actions/:action", async (req, [id, action]) => {
  const b = await json<{ entity?: string; kind?: string }>(req);
  if (!b.kind) throw new BadRequest("pressed on what?");
  return plugins.runAction(id!, action!, b.entity, b.kind);
});
route("POST", "/plugins/install", async (req) => {
  const b = await json<{ from?: string; replace?: boolean }>(req);
  if (!b.from) throw new BadRequest("install from a folder or a git address");
  return plugins.install(b.from, { replace: b.replace === true });
});
route("POST", "/plugins/:id/enable", async (req, [id]) => {
  plugins.enable(id!, (await json<{ on?: boolean }>(req)).on === true);
  return { ok: true };
});
route("POST", "/plugins/:id/restart", (_r, [id]) => { plugins.restart(id!); return { ok: true }; });
route("PUT", "/plugins/:id/settings", async (req, [id]) => {
  plugins.setSettings(id!, (await json<{ values?: Record<string, unknown> }>(req)).values ?? {});
  return { ok: true };
});
route("GET", "/plugins/:id/log", (_r, [id]) => plugins.pluginLog(id!));
route("POST", "/plugins/:id/decide", async (req, [id]) => {
  const b = await json<{ item?: string; choice?: string }>(req);
  if (!b.item || !b.choice) throw new BadRequest("which, and what was chosen");
  return plugins.decide(id!, b.item, b.choice);
});
route("POST", "/plugins/:id/call", async (req, [id]) => {
  const b = await json<{ tool?: string; arguments?: Record<string, unknown> }>(req);
  if (!b.tool) throw new BadRequest("call which tool?");
  return plugins.callPluginTool(id!, b.tool, b.arguments ?? {});
});
route("DELETE", "/plugins/:id", (_r, [id]) => { plugins.uninstall(id!); return { ok: true }; });
// The live binding (pkm-interchange): what this answers, the store as an envelope to follow, and the two writes.
route("GET", "/conformance", () => ({ format: "pkm-interchange/0", ...liveManifest() }));
route("GET", "/interchange", (_r, _p, q) =>
  readEnvelope({ since: q.get("since") ?? undefined, profile: q.get("profile") ?? undefined, q: q.get("q") ?? undefined }));
route("PUT", "/interchange/objects/:id", async (req, [id]) => {
  const answer = createObject(id!, await json<{ id?: string; type?: string; properties?: Record<string, unknown> }>(req));
  return new Answer(!answer.ok ? (answer.reports.includes("create.unknown-type") ? 422 : 400) : answer.created ? 201 : 200, answer);
});
route("PATCH", "/interchange/objects/:id", async (req, [id]) => {
  const answer = patchObject(id!, await json<WritePatch>(req));
  return new Answer(answer.ok ? 200 : answer.conflict ? 409 : 400, answer);
});
// Files by their hash (*Files*): raw bytes in and out; no DELETE — a file goes when nothing names it.
route("PUT", "/interchange/files/:sha", async (req, [sha]) => {
  const answer = putInterchangeFile(sha!, await bodyBytes(req));
  return new Answer(!answer.ok ? 422 : answer.created ? 201 : 200, answer);
});
for (const verb of ["GET", "HEAD"]) {
  route(verb, "/interchange/files/:sha", (_r, [sha]) => {
    const got = getInterchangeFile(sha!);
    return got.ok ? new Bytes(got.bytes!) : new Answer(404, got);
  });
}

// ------------------------------------------------------------ tasks and lists (DESIGN, Tasks)

route("GET", "/tasks/projects", () => tasks.taskProjects());
// Tasks' column, in the order dragged into: the projects (with their groups), and the groups.
route("PUT", "/tasks/projects/order", async (req) => {
  tasks.orderProjects((await json<{ order?: { id: string; group?: string | null }[] }>(req)).order ?? []);
  return { ok: true };
});
// The column as one list — groups and ungrouped projects in one order — read and arranged whole.
route("GET", "/tasks/column", () => tasks.projectColumn());
route("PUT", "/tasks/column", async (req) => tasks.arrangeColumn((await json<{ entries?: Parameters<typeof tasks.arrangeColumn>[0] }>(req)).entries ?? []));
route("GET", "/tasks/groups/order", () => tasks.groupOrder());
route("PUT", "/tasks/groups/order", async (req) => tasks.setGroupOrder((await json<{ names?: string[] }>(req)).names ?? []));
route("POST", "/tasks/projects", async (req) => {
  const b = await json<{ title?: string }>(req);
  return tasks.createTaskProject(b.title ?? "");
});
route("GET", "/tasks/projects/:id", (_r, [id]) => lists.showProject(id!));
// A project's tasks in the order dragged into; none (or an empty one) goes back to by due date.
route("PUT", "/tasks/projects/:id/order", async (req, [id]) => {
  lists.setProjectTaskOrder(id!, (await json<{ ids?: string[] | null }>(req)).ids ?? null);
  return { ok: true };
});
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
      if (out instanceof Bytes) {
        res.writeHead(200, { "content-type": out.type, "content-length": String(out.data.length) });
        res.end(req.method === "HEAD" ? undefined : out.data);
      } else if (out instanceof Answer) send(res, out.status, out.body);
      else send(res, 200, out ?? { ok: true });
      return;
    }
    send(res, 404, { error: `no route ${req.method} ${path}` });
  } catch (e) {
    // Locked is its own answer: the store is there, and needs its key.
    const status = e instanceof NotFound ? 404 : e instanceof Conflict ? 409 : e instanceof Gone ? 410 : e instanceof BadRequest || e instanceof SealError ? 400
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
