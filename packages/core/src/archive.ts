// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore

import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import type { CanvasDocument, CanvasItem, PageNode, Project, ProjectSummary } from "@talaris/model";
import { allRecords, deleteEntity, updateEntity, type Entity } from "./entities.js";
import { filedUnder, projectEntity } from "./filing.js";
import { MACHINERY, WRITING, projectsRoot } from "./paths.js";
import { Conflict, NotFound, archiveRoot, archivedProjects, findProject, folderName, listProjects, projectFile, readProject } from "./projects.js";
import { readJson, readText, writeJson } from "./store.js";
import { pageTree } from "./pages.js";
import { encryptedProjects, setProjectEncrypted } from "./sealed-projects.js";
import { taskProjects } from "./tasks.js";

/**
 * Archiving a project (DESIGN, *Data → A project is a folder*): it leaves
 * every context — the switcher, the bar, the launcher, `@`, Glance, Tasks'
 * lists, Morgan's "what is current" — and stays a folder you can browse, in
 * `<projects>/Archived/<year>/<folder>`. Read, never written, until it is
 * brought back.
 *
 * Its folder moves (one adopted from elsewhere stays where it is, marked);
 * nothing points at a folder — the registry is found by looking, and pages
 * link files by their place in the project — so nothing breaks. What is in
 * the entity store goes quiet with it: the project's entity, the entities
 * standing for its pages, canvases and notes, and the tasks filed only under
 * it are archived, marked as archived *with* it (`talaris:archivedWith`) so
 * that bringing it back brings back exactly those and not a task archived by
 * hand. Every search that leaves archived things out then leaves these out,
 * with nothing more to say to any of them.
 *
 * **Bringing it back** puts the folder where it was. If a project in use has
 * its name (or its folder's), the choice is the person's: **keep both** — it
 * comes back as "Name (2)" — or **merge** it into that one, its pages,
 * canvases, files and tasks moved across, and every file or page that both
 * have decided one by one: keep the one in use, keep the archived one, or
 * keep both (the archived one renamed "… (restored)"). Nothing is thrown
 * away: what a decision sets aside goes to the project's
 * `.talaris/merged-away/<time>/`.
 */

const WITH = "talaris:archivedWith";
const now = () => new Date().toISOString();

const sourcesOf = (o: Entity) => (o["talaris:sources"] as { kind: string; key: string }[] | undefined) ?? [];
/** The entities a project's own things stand for: its pages, canvases and canvas notes. */
const placeOfProject = (o: Entity, id: string) => sourcesOf(o).some((s) => ["page", "canvas", "canvas-note"].includes(s.kind) && s.key.startsWith(`${id}/`));

/** A folder name free in `dir`: the name, then "Name (2)"… */
function free(dir: string, name: string): string {
  if (!existsSync(join(dir, name))) return name;
  for (let n = 2; ; n++) if (!existsSync(join(dir, `${name} (${n})`))) return `${name} (${n})`;
}

const inRoot = (folder: string) => dirname(folder) === projectsRoot();

export function archiveProject(id: string): ProjectSummary {
  const p = findProject(id);
  if (p.home) throw new Conflict("Home is not archived");
  if (p.archived) return p;
  const when = now();
  const project = readProject(p.folder);
  let folder = p.folder;
  // In the projects folder, it moves to the archive; adopted from elsewhere, it stays put, marked.
  if (inRoot(p.folder)) {
    const year = join(archiveRoot(), String(new Date().getFullYear()));
    mkdirSync(year, { recursive: true });
    folder = join(year, free(year, basename(p.folder)));
    renameSync(p.folder, folder);
  }
  writeJson(projectFile(folder), { ...project, archived: when, archivedFrom: basename(p.folder) });
  // The store goes quiet with it.
  const mine = projectEntity(id);
  for (const { object: o } of allRecords()) {
    if (o.archived || o.stub) continue;
    const filedHere = mine && o.id !== mine.id && filedOnlyUnder(o, mine.id);
    if (o.id === mine?.id || placeOfProject(o, id) || filedHere) updateEntity(o.id, { archived: true, [WITH]: id });
  }
  return findProject(id);
}

/** A task (or anything) whose only project is this one: filed under it, and under no other project in use. */
function filedOnlyUnder(o: Entity, projectEntityId: string): boolean {
  const filed = filedUnder(o);
  if (!filed.includes(projectEntityId)) return false;
  const others = listProjects().map((p) => projectEntity(p.id)?.id).filter((x): x is string => Boolean(x) && x !== projectEntityId);
  return !others.some((other) => filed.includes(other));
}

export interface Clash {
  /** The project in use with its name or folder. */
  id: string;
  name: string;
}

/** What bringing an archived project back would collide with, if anything. */
export function clashFor(id: string): Clash | null {
  const p = findProject(id);
  const project = readProject(p.folder);
  const back = typeof project.archivedFrom === "string" ? (project.archivedFrom as string) : basename(p.folder);
  const name = p.name.toLowerCase();
  const hit = listProjects().find((x) => x.id !== id && (x.name.toLowerCase() === name || (inRoot(x.folder) && basename(x.folder).toLowerCase() === back.toLowerCase())));
  return hit ? { id: hit.id, name: hit.name } : null;
}

export type Decision = "active" | "restored" | "both";
export interface Restore {
  /** "both" brings it back beside the one in use, renamed; "merge" folds it into it. Only asked when there is a clash. */
  mode?: "both" | "merge";
  /** For a merge: each path both have, decided. */
  decisions?: Record<string, Decision>;
}
export type RestoreAnswer =
  | { done: true; project: ProjectSummary; merged?: { into: string; setAside?: string } }
  | { done: false; clash: Clash; conflicts?: string[] };

export function restoreProject(id: string, how: Restore = {}): RestoreAnswer {
  const p = findProject(id);
  if (!p.archived) return { done: true, project: p };
  const clash = clashFor(id);
  if (clash && !how.mode) return { done: false, clash };
  if (clash && how.mode === "merge") {
    const conflicts = conflictsBetween(p, findProject(clash.id));
    const undecided = conflicts.filter((c) => !how.decisions?.[c]);
    if (undecided.length) return { done: false, clash, conflicts };
    return merge(p, findProject(clash.id), how.decisions ?? {});
  }
  const project = readProject(p.folder);
  let name = p.name;
  if (clash) {
    // Keep both: the one coming back is the one that is renamed.
    const taken = new Set(listProjects().map((x) => x.name.toLowerCase()));
    for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${p.name} (${n})`;
  }
  let folder = p.folder;
  if (p.folder.startsWith(archiveRoot() + sep)) {
    const want = clash ? folderName(name) : typeof project.archivedFrom === "string" ? (project.archivedFrom as string) : basename(p.folder);
    folder = join(projectsRoot(), free(projectsRoot(), want));
    renameSync(p.folder, folder);
    pruneEmpty(dirname(p.folder));
  }
  const { archived: _a, archivedFrom: _f, ...rest } = project;
  writeJson(projectFile(folder), { ...rest, name });
  wake(id);
  return { done: true, project: findProject(id) };
}

/** What was archived with a project is in use again. */
function wake(id: string): void {
  for (const { object: o } of allRecords()) {
    if (o[WITH] === id) updateEntity(o.id, { archived: false, [WITH]: null });
  }
}

const pruneEmpty = (dir: string) => {
  try {
    if (dir.startsWith(archiveRoot()) && dir !== archiveRoot() && !readdirSync(dir).length) rmSync(dir, { recursive: true });
  } catch {
    // Left as it is.
  }
};

// ------------------------------------------------------------ merging

/** Every file of a project's own, by its place in the folder, but Talaris's machinery. */
function filesOf(folder: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      const rel = relative(folder, full).split(sep).join("/");
      if (rel === MACHINERY) continue;
      if (statSync(full).isDirectory()) walk(full);
      else out.push(rel);
    }
  };
  walk(folder);
  return out;
}

/** The files and pages both projects have at the same place: what a merge must ask about. */
export function conflictsBetween(restored: ProjectSummary, active: ProjectSummary): string[] {
  return filesOf(restored.folder).filter((rel) => existsSync(join(active.folder, ...rel.split("/"))));
}

/** "Notes.md" kept beside the one in use as "Notes (restored).md", or "(restored 2)"… */
function besideName(folder: string, rel: string): string {
  const dir = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/") + 1) : "";
  const file = rel.slice(dir.length);
  const dot = file.lastIndexOf(".");
  const [stem, ext] = dot > 0 ? [file.slice(0, dot), file.slice(dot)] : [file, ""];
  for (let n = 1; ; n++) {
    const next = `${dir}${stem} (restored${n > 1 ? ` ${n}` : ""})${ext}`;
    if (!existsSync(join(folder, ...next.split("/")))) return next;
  }
}

function move(from: string, to: string): void {
  mkdirSync(dirname(to), { recursive: true });
  renameSync(from, to);
}

function merge(restored: ProjectSummary, active: ProjectSummary, decisions: Record<string, Decision>): RestoreAnswer {
  const r = readProject(restored.folder);
  const a = readProject(active.folder);
  const away = join(active.folder, MACHINERY, "merged-away", now().replace(/[:.]/g, "-"));
  const aside = (rel: string, from: string) => move(from, join(away, ...rel.split("/")));
  const renamed = new Map<string, string>(); // a page or file of the restored one, and where it went

  // The files, pages among them (a page is a file in Writing/).
  for (const rel of filesOf(restored.folder)) {
    const from = join(restored.folder, ...rel.split("/"));
    const to = join(active.folder, ...rel.split("/"));
    if (!existsSync(to)) { move(from, to); continue; }
    const d = decisions[rel] ?? "both";
    if (d === "active") aside(rel, from);
    else if (d === "restored") { aside(`replaced/${rel}`, to); move(from, to); }
    else {
      const next = besideName(active.folder, rel);
      move(from, join(active.folder, ...next.split("/")));
      renamed.set(rel, next);
    }
  }

  // Talaris's own records of those pages: their order, look, stars — carried across where the one in use has none.
  const pageOf = (rel: string) => (rel.startsWith(`${WRITING}/`) && rel.endsWith(".md") ? rel.slice(WRITING.length + 1, -3) : null);
  const pageRenamed = new Map<string, string>();
  for (const [from, to] of renamed) { const f = pageOf(from), t = pageOf(to); if (f && t) pageRenamed.set(f, t); }
  const rename = (path: string) => pageRenamed.get(path) ?? path;
  const machinery = (folder: string, file: string) => join(folder, MACHINERY, file);
  const read = <T>(folder: string, file: string, empty: T): T => { try { return readJson<T>(machinery(folder, file)); } catch { return empty; } };
  {
    const order = read<Record<string, string[]>>(active.folder, "writing-order.json", {});
    for (const [parent, names] of Object.entries(read<Record<string, string[]>>(restored.folder, "writing-order.json", {}))) {
      const into = parent ? rename(parent) : "";
      const mine = order[into] ?? [];
      for (const n of names) {
        const full = rename(parent ? `${parent}/${n}` : n);
        const name = full.slice(full.lastIndexOf("/") + 1);
        if (!mine.includes(name)) mine.push(name);
      }
      order[into] = mine;
    }
    writeJson(machinery(active.folder, "writing-order.json"), order);
    const look = read<Record<string, unknown>>(active.folder, "writing-look.json", {});
    for (const [path, l] of Object.entries(read<Record<string, unknown>>(restored.folder, "writing-look.json", {}))) {
      const to = rename(path);
      if (!(to in look)) look[to] = l;
    }
    writeJson(machinery(active.folder, "writing-look.json"), look);
    const starred = read<{ pages?: string[]; canvases?: string[] }>(active.folder, "starred-order.json", {});
    const theirs = read<{ pages?: string[]; canvases?: string[] }>(restored.folder, "starred-order.json", {});
    writeJson(machinery(active.folder, "starred-order.json"), {
      pages: [...new Set([...(starred.pages ?? []), ...(theirs.pages ?? []).map(rename)])],
      canvases: [...new Set([...(starred.canvases ?? []), ...(theirs.canvases ?? [])])],
    });
  }

  // The canvases: every one comes across (their ids are their own), the archived one's top canvas
  // becoming a canvas inside the one in use's, as a card on it.
  const cdir = (folder: string) => join(folder, MACHINERY, "canvases");
  const topCard: CanvasItem = { id: `it_m${Date.now().toString(36)}`, kind: "canvas", canvas: r.topCanvas, x: 0, y: 0, w: 200, h: 120, seen: { title: restored.name } };
  for (const name of existsSync(cdir(restored.folder)) ? readdirSync(cdir(restored.folder)) : []) {
    if (!name.endsWith(".json")) continue;
    const doc = readJson<CanvasDocument>(join(cdir(restored.folder), name));
    doc.project = active.id;
    if (doc.id === r.topCanvas) { doc.parent = a.topCanvas; doc.title = restored.name; }
    for (const item of doc.items) if (item.project === restored.id) item.project = active.id;
    writeJson(join(cdir(active.folder), name), doc);
    rmSync(join(cdir(restored.folder), name));
  }
  {
    const top = readJson<CanvasDocument>(join(cdir(active.folder), `${a.topCanvas}.json`));
    const right = top.items.length ? Math.max(...top.items.map((i) => i.x + i.w)) + 40 : 0;
    top.items.push({ ...topCard, x: right });
    writeJson(join(cdir(active.folder), `${a.topCanvas}.json`), top);
    const list = read<Record<string, unknown>>(active.folder, "canvas-list.json", {});
    writeJson(machinery(active.folder, "canvas-list.json"), { ...read<Record<string, unknown>>(restored.folder, "canvas-list.json", {}), ...list });
  }
  // A link to one of its canvases from another project's canvas points at its new project.
  for (const other of listProjects()) {
    if (other.id === active.id) continue;
    for (const name of existsSync(cdir(other.folder)) ? readdirSync(cdir(other.folder)) : []) {
      if (!name.endsWith(".json")) continue;
      const path = join(cdir(other.folder), name);
      const doc = readJson<CanvasDocument>(path);
      if (!doc.items.some((i) => i.project === restored.id)) continue;
      for (const item of doc.items) if (item.project === restored.id) item.project = active.id;
      writeJson(path, doc);
    }
  }

  // Versions, by kind and key: carried across where the one in use has none of that key.
  for (const kind of ["page", "canvas"]) {
    const from = join(restored.folder, MACHINERY, "versions", kind);
    const to = join(active.folder, MACHINERY, "versions", kind);
    for (const key of existsSync(from) ? readdirSync(from) : []) {
      const k = kind === "page" ? encodeURIComponent(rename(decodeURIComponent(key))) : key;
      if (!existsSync(join(to, k))) move(join(from, key), join(to, k));
    }
  }

  // The store: what stood for its pages and canvases now stands for them where they are,
  // what was filed under it is filed under the one in use, and its own entity goes.
  taskProjects(); // every project in use has its entity, the one merged into among them
  const theirs = projectEntity(restored.id);
  const ours = projectEntity(active.id);
  for (const { object: o } of allRecords()) {
    const sources = sourcesOf(o);
    const moved = sources.map((s) => {
      if (!["page", "canvas", "canvas-note"].includes(s.kind) || !s.key.startsWith(`${restored.id}/`)) return s;
      const rest = s.key.slice(restored.id.length + 1);
      return { kind: s.kind, key: `${active.id}/${s.kind === "page" ? rename(rest) : rest}` };
    });
    const patch: Record<string, unknown> = {};
    if (moved.some((s, i) => s !== sources[i])) patch["talaris:sources"] = moved;
    if (o[WITH] === restored.id) { patch.archived = false; patch[WITH] = null; }
    // Every reference to the one going is moved, not only filing: a mention of it in words too, or it would point at nothing.
    if (theirs && ours && o.id !== theirs.id && JSON.stringify(o.properties).includes(theirs.id)) {
      patch.properties = JSON.parse(JSON.stringify(o.properties).split(theirs.id).join(ours.id)) as Record<string, unknown>;
    }
    if (Object.keys(patch).length) updateEntity(o.id, patch);
  }
  if (theirs) deleteEntity(theirs.id);

  // What is left of it (its machinery) is set aside with the rest, and the folder goes.
  if (existsSync(restored.folder)) {
    move(restored.folder, join(away, `${restored.code} ${restored.name}`));
    pruneEmpty(dirname(restored.folder));
  }
  // Sealed as the one in use is, or not.
  if (encryptedProjects().includes(active.id)) setProjectEncrypted(active.id, true);
  return { done: true, project: findProject(active.id), merged: { into: active.id, ...(existsSync(away) ? { setAside: away } : {}) } };
}

// ------------------------------------------------------------ the browser

export interface ArchivedRow { id: string; code: string; name: string; created: string; archived: string; folder: string; pages: number; files: number }

export function listArchive(): ArchivedRow[] {
  return archivedProjects().map((p) => {
    const project = readProject(p.folder) as Project;
    let pages = 0;
    const count = (nodes: PageNode[]) => { for (const n of nodes) { pages++; count(n.children); } };
    try { count(pageTree(p.id)); } catch { /* unreadable: none counted */ }
    const files = filesOf(p.folder).filter((rel) => !rel.startsWith(`${WRITING}/`)).length;
    return { id: p.id, code: p.code, name: p.name, created: project.created, archived: p.archived!, folder: p.folder, pages, files };
  }).sort((x, y) => y.archived.localeCompare(x.archived));
}

/** One archived project, to browse: its pages, canvases (with how many things each holds) and files. */
export function archivedContents(id: string) {
  const p = findProject(id);
  if (!p.archived) throw new NotFound(`${p.name} is not archived`);
  const project = readProject(p.folder);
  const cdir = join(p.folder, MACHINERY, "canvases");
  const canvases = (existsSync(cdir) ? readdirSync(cdir) : []).filter((n) => n.endsWith(".json")).map((n) => {
    try {
      const d = readJson<CanvasDocument>(join(cdir, n));
      return { id: d.id, title: d.id === project.topCanvas ? "Canvas" : d.title, parent: d.parent, items: d.items.length };
    } catch {
      return null;
    }
  }).filter(Boolean);
  let pages: PageNode[] = [];
  try { pages = pageTree(id); } catch { /* unreadable */ }
  return {
    project: { id: p.id, code: p.code, name: p.name, created: project.created, archived: p.archived, folder: p.folder },
    pages, canvases,
    files: filesOf(p.folder).filter((rel) => !rel.startsWith(`${WRITING}/`)),
  };
}

/** Words in the archive: page titles and text, file names, canvas titles — for when the archive is searched on purpose. */
export function searchArchive(q: string, limit = 40): { project: string; projectName: string; kind: "page" | "file" | "canvas"; where: string; title: string; snippet?: string }[] {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const has = (t: string) => { const l = t.toLowerCase(); return words.every((w) => l.includes(w)); };
  const out: ReturnType<typeof searchArchive> = [];
  for (const p of archivedProjects()) {
    for (const rel of filesOf(p.folder)) {
      if (out.length >= limit) return out;
      const page = rel.startsWith(`${WRITING}/`) && rel.endsWith(".md") ? rel.slice(WRITING.length + 1, -3) : null;
      if (page) {
        let text = "";
        try { text = readText(join(p.folder, ...rel.split("/"))); } catch { /* sealed and locked */ }
        if (!has(`${page} ${text}`)) continue;
        const at = text.toLowerCase().indexOf(words[0]!);
        out.push({ project: p.id, projectName: p.name, kind: "page", where: page, title: page.split("/").pop()!, ...(at >= 0 ? { snippet: text.slice(Math.max(0, at - 60), at + 100).replace(/\s+/g, " ") } : {}) });
      } else if (has(rel)) out.push({ project: p.id, projectName: p.name, kind: "file", where: rel, title: rel.split("/").pop()! });
    }
    const cdir = join(p.folder, MACHINERY, "canvases");
    for (const name of existsSync(cdir) ? readdirSync(cdir) : []) {
      if (!name.endsWith(".json") || out.length >= limit) continue;
      try {
        const doc = readJson<CanvasDocument>(join(cdir, name));
        const words2 = `${doc.title} ${doc.items.map((i) => String(i.text ?? i.seen?.title ?? "")).join(" ")}`;
        if (has(words2)) out.push({ project: p.id, projectName: p.name, kind: "canvas", where: doc.id, title: doc.title });
      } catch { /* unreadable */ }
    }
  }
  return out;
}

export { NotFound };
