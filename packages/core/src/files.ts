// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore

/*
 * Files (DESIGN, *Files*): every file in every project's folder, and what
 * Talaris holds for a project that is not a file there — shortcuts, task
 * attachments linked from elsewhere, snapshots — each row saying which.
 *
 * **Watched.** Each project's folder is read once and then followed, a
 * watcher per folder (inotify, through `fs.watch`), never into what is not
 * listed: Talaris's `.talaris/`, dot-folders, and in a git repository what
 * `.gitignore` ignores — a `node_modules` is not watched, only named. A
 * project with more folders than is sane to watch is read again when asked
 * instead, and says so.
 *
 * **What a row is** comes from two places: the folder (In the folder; a
 * writing page, which Writing opens and owns), and the entities (a shortcut;
 * a link on a task, outside every project; a snapshot, a copy Talaris keeps;
 * missing, a link whose file has gone). A file on several tasks is one row,
 * on all of them.
 *
 * **Nothing here deletes a file outright.** Deleting goes to the trash
 * (`gio trash`); taking a shortcut away takes the record, never the file; a
 * move across drives copies, checks the copy by its hash, and only then lets
 * the original go.
 */

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, statSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { allRecords, bySource, createEntity, deleteEntity, getEntity, getFile, titleOf, trusted, typeFor, types, updateEntity, profilesOf, type Entity } from "./entities.js";
import { LINK, homeHolds, linkFile, real, refreshLinks, toLink } from "./links.js";
import { seal, unseal } from "./seal.js";
import { DATA_DIR, storeKey } from "./vault.js";
import { FILES, MACHINERY, WRITING } from "./paths.js";
import { Conflict, NotFound, findProject, listProjects, UNDATED, notesFolder } from "./projects.js";
import { isSealedFile, readBytes, writeAtomic } from "./store.js";
import { cleanTags } from "./tags.js";
import { canvasTree } from "./canvases.js";
import { homeId, threadById, threads, threadsVersion } from "./threads.js";
import { placeSource } from "./mentionables.js";
import { members, membersMoved } from "./filelists.js";
import type { CanvasNode } from "@talaris/model";

const MISSING = "talaris:missing";
const FROM_HERMES = "hermes-sync:origin";
export const SHORTCUT = "talaris:shortcut";
/** A shortcut to a canvas or a thread rather than a file: what it leads to, by its glance key. */
export const SHORTCUT_TO = "talaris:shortcutTo";
/** More folders than this in one project, and it is read when asked rather than watched. */
const MOST_WATCHED = 4000;
const home = () => resolve(process.env.TALARIS_LINK_HOME ?? homedir());

// ------------------------------------------------------------ the index

interface Seen { size: number; mtime: number }
interface ProjectIndex {
  id: string;
  root: string;
  files: Map<string, Seen>;
  /** Folders and files git ignores, relative, a folder ending in `/`: named, never walked or watched. */
  ignored: string[];
  git: boolean;
  watchers: Map<string, FSWatcher>;
  watched: boolean;
  pending: Set<string>;
  timer: NodeJS.Timeout | null;
}

const indexes = new Map<string, ProjectIndex>();
let version = 0;
/** Goes up whenever anything listed changes: the panel asks it to know when to look again. */
export const filesVersion = () => version + threadsVersion();

const hidden = (rel: string) => rel.split("/").some((p) => p.startsWith(".")) || rel === MACHINERY || rel.startsWith(`${MACHINERY}/`);
const isIgnored = (ix: ProjectIndex, rel: string) => ix.ignored.some((g) => (g.endsWith("/") ? rel.startsWith(g) || `${rel}/` === g : rel === g));

function readIgnored(root: string): string[] {
  try {
    const out = execFileSync("git", ["-C", root, "ls-files", "-z", "-o", "-i", "--exclude-standard", "--directory"], { encoding: "utf8", timeout: 20000, maxBuffer: 64 << 20 });
    return out.split("\0").filter(Boolean);
  } catch {
    return [];
  }
}

function watchDir(ix: ProjectIndex, rel: string): void {
  if (!ix.watched || ix.watchers.has(rel)) return;
  if (ix.watchers.size >= MOST_WATCHED) { stopWatching(ix); ix.watched = false; return; }
  try {
    const w = watch(rel ? join(ix.root, rel) : ix.root, { persistent: false }, (_ev, name) => {
      if (name === null) { ix.pending.add(rel); } else ix.pending.add(rel ? `${rel}/${name}` : String(name));
      if (!ix.timer) ix.timer = setTimeout(() => settle(ix), 250);
    });
    w.on("error", () => { w.close(); ix.watchers.delete(rel); });
    ix.watchers.set(rel, w);
  } catch {
    // A folder gone between reading and watching.
  }
}

function stopWatching(ix: ProjectIndex): void {
  for (const w of ix.watchers.values()) w.close();
  ix.watchers.clear();
}

/** Everything under `rel` (a folder, "" for the whole project) read into the index, and watched. */
function walk(ix: ProjectIndex, rel: string): void {
  watchDir(ix, rel);
  let names: string[] = [];
  try {
    names = readdirSync(rel ? join(ix.root, rel) : ix.root);
  } catch {
    return;
  }
  for (const name of names) {
    const r = rel ? `${rel}/${name}` : name;
    if (name.startsWith(".") || name.endsWith(".tmp") || isIgnored(ix, r)) continue;
    try {
      const st = statSync(join(ix.root, r));
      if (st.isDirectory()) walk(ix, r);
      else if (st.isFile()) ix.files.set(r, { size: st.size, mtime: st.mtimeMs });
    } catch {
      // Gone between listing and looking.
    }
  }
}

function scan(ix: ProjectIndex): void {
  stopWatching(ix);
  ix.files.clear();
  ix.git = existsSync(join(ix.root, ".git"));
  ix.ignored = ix.git ? readIgnored(ix.root) : [];
  ix.watched = true;
  walk(ix, "");
  version++;
}

/** What the watchers saw, a moment later: each path looked at again. */
function settle(ix: ProjectIndex): void {
  ix.timer = null;
  const paths = [...ix.pending];
  ix.pending.clear();
  if (paths.some((p) => p === ".gitignore" || p.endsWith("/.gitignore"))) { scan(ix); return; }
  for (const rel of paths) {
    if (hidden(rel) || isIgnored(ix, rel)) continue;
    let st;
    try { st = statSync(join(ix.root, rel)); } catch { st = null; }
    if (!st) {
      // Gone: it, and everything that was under it.
      ix.files.delete(rel);
      for (const k of [...ix.files.keys()]) if (k.startsWith(`${rel}/`)) ix.files.delete(k);
      for (const [k, w] of [...ix.watchers]) if (k === rel || k.startsWith(`${rel}/`)) { w.close(); ix.watchers.delete(k); }
    } else if (st.isDirectory()) {
      walk(ix, rel);
    } else if (st.isFile()) {
      ix.files.set(rel, { size: st.size, mtime: st.mtimeMs });
    }
  }
  version++;
}

/** Every project in use, indexed and watched; one archived or gone, let go. */
export function watchProjects(): void {
  const now = new Set<string>();
  // The unaffiliated pages' folder too (projects.ts, `notes`): pages of no project, but files on disk all the same.
  const places = [...listProjects().map((p) => ({ id: p.id, folder: p.folder })), ...(existsSync(notesFolder()) ? [{ id: UNDATED, folder: notesFolder() }] : [])];
  for (const p of places) {
    now.add(p.id);
    const had = indexes.get(p.id);
    if (had && had.root === p.folder) continue;
    if (had) stopWatching(had);
    const ix: ProjectIndex = { id: p.id, root: p.folder, files: new Map(), ignored: [], git: false, watchers: new Map(), watched: true, pending: new Set(), timer: null };
    indexes.set(p.id, ix);
    scan(ix);
  }
  for (const [id, ix] of [...indexes]) if (!now.has(id)) { stopWatching(ix); indexes.delete(id); version++; }
}

let started: NodeJS.Timeout | null = null;
/** Watching from now on: the projects looked at again each minute, for one made, archived or moved. */
export function startWatching(): void {
  if (started) return;
  watchProjects();
  started = setInterval(() => {
    try { watchProjects(); } catch { /* a project unreadable for now */ }
    // Files linked from elsewhere, and folders linked whole, are looked at when search reads files (meaning.ts, scanFiles).
  }, 60_000);
  started.unref();
}
export function stopAll(): void {
  if (started) clearInterval(started);
  started = null;
  for (const ix of indexes.values()) stopWatching(ix);
  indexes.clear();
}

function indexOf(projectId: string): ProjectIndex {
  if (!indexes.has(projectId)) watchProjects();
  const ix = indexes.get(projectId);
  if (!ix) throw new NotFound(`no project ${projectId}`);
  // One too big to watch is read again each time it is asked about.
  if (!ix.watched) scan(ix);
  return ix;
}

// ------------------------------------------------------------ what a file is

export type FileType = "document" | "spreadsheet" | "presentation" | "pdf" | "image" | "audio" | "video" | "code" | "archive" | "other" | "canvas" | "conversation";
const BY_EXT: Record<string, FileType> = {};
const put = (t: FileType, exts: string) => { for (const e of exts.split(" ")) BY_EXT[`.${e}`] = t; };
put("document", "odt ott doc docx rtf txt md markdown pages tex epub");
put("spreadsheet", "ods ots xls xlsx csv tsv numbers");
put("presentation", "odp otp ppt pptx key");
put("pdf", "pdf");
put("image", "png jpg jpeg gif webp svg heic tif tiff bmp avif xcf kra psd ico");
put("audio", "mp3 m4a ogg oga opus flac wav aac");
put("video", "mp4 mkv mov webm avi m4v");
put("code", "js mjs cjs ts tsx jsx py rs go java c h cpp hpp cs rb php sh bash zsh fish lua json toml yaml yml xml html css scss sql ini conf swift kt");
put("archive", "zip tar gz tgz bz2 xz 7z rar zst deb");
export const typeOfName = (name: string): FileType => BY_EXT[extname(name).toLowerCase()] ?? "other";

export type Status = "folder" | "page" | "shortcut" | "linked" | "snapshot" | "missing" | "canvas" | "conversation";

export interface On { id: string; title: string; kind: string }
export interface FileRow {
  /** What the row is known by: `p:<project>/<path>`, `s:<entity>`, `l:<project>|<path>`, `c:<project>|<sha256>`. */
  key: string;
  project: string;
  name: string;
  /** In the project's folder, relative to it. */
  path?: string;
  /** Where it is on disk: the folder's file, a shortcut's or a link's target. */
  abs?: string;
  type: FileType;
  size?: number;
  mtime?: string;
  status: Status[];
  on: On[];
  tags: string[];
  /** The entity standing for it: a tagged folder file's, a shortcut's. */
  entity?: string;
  /** A snapshot: which copy, and a thing it is on (to save or open it by). */
  sha256?: string;
  holder?: string;
  fromHermes?: boolean;
  sealed?: boolean;
  /** The other projects it is in, by a shortcut there: one file, in several projects. */
  alsoIn?: string[];
  /** A shortcut to a file in another project's folder: that project, and its place there. */
  livesIn?: { project: string; path: string };
  /** A canvas, one of Morgan's threads, or a shortcut to one: the thing, by its glance key (`canvas:<project>/<id>`, `thread:<home>/<id>`). */
  thing?: string;
  /** A canvas inside another: that one's row key (Files' tree). */
  under?: string;
}

const fileSource = (projectId: string, rel: string) => ({ kind: "file", key: `${projectId}/${rel}` });
const sourcesOf = (o: Entity) => (o["talaris:sources"] as { kind: string; key: string }[] | undefined) ?? [];
type Value = { kind: "attachment"; filename: string; mediaType?: string; sha256: string; [LINK]?: { path: string; size: number; mtime: number }; [k: string]: unknown };
const valuesIn = (v: unknown): Value[] => (Array.isArray(v) ? v : v ? [v] : []).filter((x): x is Value => Boolean(x) && typeof x === "object" && (x as Value).kind === "attachment" && typeof (x as Value).sha256 === "string");

/** The project a file path is in, and where in it; null for anywhere else. */
function placeOf(abs: string): { project: string; rel: string } | null {
  let best: { project: string; rel: string; depth: number } | null = null;
  for (const ix of indexes.values()) {
    if (abs === ix.root || !abs.startsWith(ix.root + sep)) continue;
    // A project inside another (an adopted folder under Home's, say): the deepest wins.
    if (!best || ix.root.length > best.depth) best = { project: ix.id, rel: relative(ix.root, abs).split(sep).join("/"), depth: ix.root.length };
  }
  return best && { project: best.project, rel: best.rel };
}

/** Which project a thing belongs to: the first project it is filed under; else Home. */
function projectsByEntity(): { of: (o: Entity) => string; home: string } {
  const byEntity = new Map<string, string>();
  for (const { object: o } of allRecords()) {
    const src = sourcesOf(o).find((s) => s.kind === "talaris-project");
    if (src) byEntity.set(o.id, src.key);
  }
  const homeId = listProjects().find((p) => p.home)?.id ?? "";
  const refFields = new Map(types().map((t) => [t.id, t.fields.filter((f) => f.kind === "reference").map((f) => f.key)]));
  return {
    home: homeId,
    of: (o) => {
      for (const key of refFields.get(o.type ?? "") ?? []) {
        for (const ref of Array.isArray(o.properties[key]) ? (o.properties[key] as unknown[]) : [o.properties[key]]) {
          if (typeof ref === "string" && byEntity.has(ref)) return byEntity.get(ref)!;
        }
      }
      return homeId;
    },
  };
}

const kindOf = (o: Entity) => ["task", "contact", "event", "note", "project"].find((k) => profilesOf(o).includes(k)) ?? "thing";

/** Every row, before filtering: the folders, then what the entities hold. */
function allRows(only?: string): FileRow[] {
  watchProjects();
  const rows = new Map<string, FileRow>();
  for (const ix of indexes.values()) {
    if (only && ix.id !== only) continue;
    if (!ix.watched) scan(ix);
    for (const [rel, seen] of ix.files) {
      // A page: in a project's Writing; anywhere in the unaffiliated pages' folder.
      const page = rel.endsWith(".md") && (ix.id === UNDATED || rel.startsWith(`${WRITING}/`));
      const abs = join(ix.root, rel);
      rows.set(`p:${ix.id}/${rel}`, { key: `p:${ix.id}/${rel}`, project: ix.id, name: basename(rel), path: rel, abs, type: page ? "document" : typeOfName(rel),
        size: seen.size, mtime: new Date(seen.mtime).toISOString(), status: [page ? "page" : "folder"], on: [], tags: [],
        ...((rel.startsWith(`${WRITING}/`) || rel.startsWith(`${FILES}/`)) && isSealedFile(abs) ? { sealed: true } : {}) });
    }
  }
  thingRows(rows, only);
  const { of } = projectsByEntity();
  // Every shortcut's file, first: a file in one project's folder is also in each project with a shortcut to it.
  const shortcutsTo = new Map<string, string[]>();
  for (const { object: o } of allRecords()) {
    if (typeof o[SHORTCUT] !== "string" || o.archived) continue;
    const p = valuesIn(o.properties.file)[0]?.[LINK]?.path;
    if (p) shortcutsTo.set(p, [...(shortcutsTo.get(p) ?? []), o[SHORTCUT] as string]);
  }
  for (const r of rows.values()) {
    const also = r.abs ? (shortcutsTo.get(r.abs) ?? []).filter((p) => p !== r.project) : [];
    if (also.length) r.alsoIn = [...new Set(also)];
  }
  for (const { object: o } of allRecords()) {
    if (o.archived || o.stub) continue;
    // A folder file's own entity: its tags.
    const fsrc = sourcesOf(o).find((s) => s.kind === "file");
    if (fsrc) {
      const row = rows.get(`p:${fsrc.key}`);
      if (row) { row.tags = o.tags ?? []; row.entity = o.id; }
      continue;
    }
    const shortcutIn = typeof o[SHORTCUT] === "string" ? (o[SHORTCUT] as string) : null;
    if (shortcutIn && typeof o[SHORTCUT_TO] === "string") {
      if (only && shortcutIn !== only) continue;
      const to = thingRow(o[SHORTCUT_TO] as string);
      rows.set(`s:${o.id}`, { ...(to ?? { name: titleOf(o), type: "other" as FileType, status: ["missing"] as Status[], on: [] }), key: `s:${o.id}`, project: shortcutIn,
        status: to ? ["shortcut"] : ["shortcut", "missing"], tags: o.tags ?? [], entity: o.id, thing: o[SHORTCUT_TO] as string,
        ...(to ? { alsoIn: [to.project] } : {}) });
      continue;
    }
    if (shortcutIn) {
      if (only && shortcutIn !== only) continue;
      const v = valuesIn(o.properties.file)[0];
      const link = v?.[LINK];
      const lives = link ? placeOf(link.path) : null;
      const others = link ? (shortcutsTo.get(link.path) ?? []).filter((p) => p !== shortcutIn) : [];
      rows.set(`s:${o.id}`, { key: `s:${o.id}`, project: shortcutIn, name: v?.filename ?? titleOf(o), ...(link ? { abs: link.path } : {}),
        ...(lives ? { livesIn: { project: lives.project, path: lives.rel } } : {}),
        ...(others.length || lives ? { alsoIn: [...new Set([...(lives ? [lives.project] : []), ...others])] } : {}),
        type: typeOfName(v?.filename ?? titleOf(o)), ...(link ? { size: link.size, mtime: new Date(link.mtime).toISOString() } : {}),
        status: v?.[MISSING] ? ["shortcut", "missing"] : ["shortcut"], on: [], tags: o.tags ?? [], entity: o.id });
      continue;
    }
    // Anything else with files: each is on it.
    const project = of(o);
    const on: On = { id: o.id, title: titleOf(o), kind: kindOf(o) };
    for (const v of Object.values(o.properties ?? {})) {
      for (const a of valuesIn(v)) {
        const link = a[LINK];
        if (link) {
          const at = placeOf(link.path);
          const inFolder = at && rows.get(`p:${at.project}/${at.rel}`);
          if (inFolder) { inFolder.on.push(on); continue; }
          if (at && only && at.project !== only) continue;
          if (!at && only && project !== only) continue;
          const key = `l:${project}|${link.path}`;
          const row = rows.get(key) ?? { key, project, name: a.filename, abs: link.path, type: typeOfName(a.filename), size: link.size,
            mtime: new Date(link.mtime).toISOString(), status: a[MISSING] ? ["linked", "missing"] as Status[] : ["linked"] as Status[], on: [], tags: [] };
          row.on.push(on);
          rows.set(key, row);
        } else {
          if (only && project !== only) continue;
          const key = `c:${project}|${a.sha256}`;
          const row = rows.get(key) ?? { key, project, name: a.filename, type: typeOfName(a.filename), mtime: o.updated, status: ["snapshot"] as Status[],
            on: [], tags: [], sha256: a.sha256, holder: o.id, ...(a[FROM_HERMES] ? { fromHermes: true } : {}) };
          row.on.push(on);
          rows.set(key, row);
        }
      }
    }
  }
  return [...rows.values()];
}

/** A canvas's row, or a thread's, by its glance key; null if it is gone. */
function thingRow(key: string): FileRow | null {
  const at = key.indexOf("/");
  const kind = key.slice(0, key.indexOf(":")), project = key.slice(key.indexOf(":") + 1, at), where = key.slice(at + 1);
  if (kind === "thread") {
    const t = threadById(where);
    return t ? threadRow(t) : null;
  }
  if (kind === "canvas") {
    try {
      let found: CanvasNode | null = null;
      const walk = (n: CanvasNode) => { if (n.id === where) found = n; n.children.forEach(walk); };
      walk(canvasTree(project));
      return found ? canvasRow(project, found) : null;
    } catch { return null; }
  }
  return null;
}

const canvasRow = (project: string, n: CanvasNode): FileRow => {
  const e = bySource(placeSource("canvas", project, n.id));
  return { key: `v:${project}/${n.id}`, project, name: n.title, type: "canvas", ...(n.modified ? { mtime: n.modified } : {}), status: ["canvas"], on: [],
    tags: e?.tags ?? [], ...(e ? { entity: e.id } : {}), thing: `canvas:${project}/${n.id}`, ...(n.parent ? { under: `v:${project}/${n.parent}` } : {}) };
};
const threadRow = (t: { id: string; title: string; t1: number }): FileRow => {
  const home = homeId();
  const e = bySource(placeSource("thread", home, t.id));
  return { key: `t:${t.id}`, project: home, name: t.title, type: "conversation", mtime: new Date(t.t1).toISOString(), status: ["conversation"], on: [],
    tags: e?.tags ?? [], ...(e ? { entity: e.id } : {}), thing: `thread:${home}/${t.id}` };
};

/** Each project's canvases, and Morgan's threads in Home: things Files lists that are not files. */
function thingRows(rows: Map<string, FileRow>, only?: string): void {
  for (const p of listProjects()) {
    if (only && p.id !== only) continue;
    let top: CanvasNode;
    try { top = canvasTree(p.id); } catch { continue; }
    // An empty canvas (nothing on it, nor inside it) is not listed: there is nothing of it to find.
    const walk = (n: CanvasNode) => { if (n.empty) return; const r = canvasRow(p.id, n); rows.set(r.key, r); n.children.forEach(walk); };
    walk(top);
  }
  if (only && only !== homeId()) return;
  for (const t of threads()) { const r = threadRow(t); rows.set(r.key, r); }
}

/** A canvas or a thread brought into another project: a shortcut to it there. */
export function makeThingShortcut(projectId: string, key: string): FileRow {
  findProject(projectId);
  const to = thingRow(key);
  if (!to) throw new NotFound(`nothing is known by ${key}`);
  if (to.project === projectId) throw new Conflict("it is already in this project");
  for (const { object: o } of allRecords()) {
    if (o[SHORTCUT] === projectId && o[SHORTCUT_TO] === key) throw new Conflict("this project already has a shortcut to it");
  }
  const e = createEntity({ type: typeFor("file").id, properties: { title: to.name }, [SHORTCUT]: projectId, [SHORTCUT_TO]: key });
  version++;
  return listFiles({ project: projectId }).rows.find((r) => r.entity === e.id)!;
}

export interface Query {
  project?: string;
  q?: string;
  type?: string;
  status?: string;
  tags?: string[];
  /** Changed within this many days. */
  days?: number;
  sort?: "name" | "date";
  limit?: number;
  /** In one of the project's lists (filelists.ts), by its id: what it holds, in its order. */
  list?: string;
}

/** The rows asked for: in a project or all, matching a name, of a type, a status, carrying tags, changed lately. */
export function listFiles(query: Query = {}): { rows: FileRow[]; total: number; version: number; unwatched: string[] } {
  const words = (query.q ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const tags = cleanTags(query.tags ?? []);
  const since = query.days ? Date.now() - query.days * 86_400_000 : 0;
  let rows = allRows(query.project || undefined).filter((r) =>
    (!words.length || words.every((w) => `${r.name} ${r.path ?? ""} ${r.abs ?? ""}`.toLowerCase().includes(w)))
    // A page is its own type, as Files lists it: "page" is the pages, and "document" the documents that are not pages.
    && (!query.type || (query.type === "page" ? r.status.includes("page") : r.type === query.type && !r.status.includes("page")))
    && (!query.status || r.status.includes(query.status as Status) || (query.status === "folder" && r.status.includes("page")))
    && (!tags.length || tags.every((t) => r.tags.includes(t)))
    && (!since || (r.mtime ? Date.parse(r.mtime) >= since : false)));
  if (query.list && query.project) {
    const order = new Map(members(query.project, query.list).map((k, i) => [k, i]));
    rows = rows.filter((r) => order.has(r.key));
    if (query.sort !== "date") rows.sort((a, b) => order.get(a.key)! - order.get(b.key)!);
    else rows.sort((a, b) => (b.mtime ?? "").localeCompare(a.mtime ?? ""));
  } else rows = query.sort === "date"
    ? rows.sort((a, b) => (b.mtime ?? "").localeCompare(a.mtime ?? ""))
    : rows.sort((a, b) => (a.path ?? a.name).localeCompare(b.path ?? b.name, undefined, { sensitivity: "base", numeric: true }));
  const total = rows.length;
  return { rows: rows.slice(0, query.limit ?? 2000), total, version, unwatched: [...indexes.values()].filter((ix) => !ix.watched).map((ix) => ix.id) };
}

/**
 * How many there are of each thing Files' left side lists: in each project
 * (and all), and — in the project chosen, or all — of each status, type and
 * tag. A page is counted as a page, and as in the folder, as Files filters.
 */
export function fileCounts(projectId?: string): { all: number; projects: Record<string, number>; status: Record<string, number>; type: Record<string, number>; tags: Record<string, number> } {
  const rows = allRows();
  const projects: Record<string, number> = {};
  for (const r of rows) projects[r.project] = (projects[r.project] ?? 0) + 1;
  const status: Record<string, number> = {}, type: Record<string, number> = {}, tags: Record<string, number> = {};
  const add = (m: Record<string, number>, k: string) => { m[k] = (m[k] ?? 0) + 1; };
  for (const r of rows) {
    if (projectId && r.project !== projectId) continue;
    for (const s of new Set(r.status.map((x) => (x === "page" ? "folder" : x)))) add(status, s);
    add(type, r.status.includes("page") ? "page" : r.type);
    for (const t of r.tags) add(tags, t);
  }
  return { all: rows.length, projects, status, type, tags };
}

/** What git ignores in a project, named: the folders and files Files does not list. */
export function ignoredIn(projectId: string): string[] {
  return indexOf(projectId).ignored;
}

// ------------------------------------------------------------ changing them

function inProject(projectId: string, rel: string): string {
  const { folder } = findProject(projectId);
  const parts = rel.split("/");
  if (parts.some((p) => !p || p === "." || p === ".." || p.includes("\0")) || parts[0] === MACHINERY) throw new Conflict("not a file of this project's");
  const abs = join(folder, ...parts);
  // A symlink in the folder that leads out of it is not the project's to rename, move or delete.
  const root = real(folder), at = real(abs);
  if (at !== root && !at.startsWith(root + "/")) throw new Conflict("not a file of this project's: it leads outside its folder");
  return abs;
}

function cleanName(name: string): string {
  const n = name.trim();
  if (!n || n.includes("/") || n.includes("\0") || n === "." || n === ".." || n.startsWith(".")) throw new Conflict("a name, without a slash, not starting with a dot");
  return n;
}

/** A name free in a folder: the one asked, or "name 2", "name 3"… */
export function freeName(dir: string, name: string): string {
  if (!existsSync(join(dir, name))) return name;
  const ext = extname(name), stem = name.slice(0, name.length - ext.length);
  for (let n = 2; ; n++) if (!existsSync(join(dir, `${stem} ${n}${ext}`))) return `${stem} ${n}${ext}`;
}

/** Talaris's own references to a file, kept in step when it moves: links on things, shortcuts, the file's own entity. */
function moved(fromAbs: string, toAbs: string): void {
  for (const { object: o } of allRecords()) {
    let dirty = false;
    const props: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(o.properties ?? {})) {
      const list = valuesIn(v);
      if (!list.some((a) => a[LINK]?.path === fromAbs)) continue;
      const next = list.map((a) => (a[LINK]?.path === fromAbs ? { ...a, filename: basename(toAbs), [LINK]: { ...a[LINK]!, path: toAbs } } : a));
      props[key] = Array.isArray(v) ? next : next[0];
      dirty = true;
    }
    // A link moved with its file: Talaris's own doing (entities.ts, `trusted`).
    if (dirty) trusted(() => updateEntity(o.id, { properties: props }));
  }
  const from = placeOf(fromAbs), to = placeOf(toAbs);
  if (!from) return;
  // Its place in lists, kept.
  const fromKey = `p:${from.project}/${from.rel}`, toKey = to ? `p:${to.project}/${to.rel}` : "";
  membersMoved((k) => (k === fromKey ? toKey : null));
  const e = bySource(fileSource(from.project, from.rel));
  if (!e) return;
  // Sources are only ever added, so the entity is made again under its new name, tags and all.
  if (to) createEntity({ type: typeFor("file").id, properties: { title: basename(toAbs) }, tags: e.tags ?? [], sources: [fileSource(to.project, to.rel)] });
  deleteEntity(e.id);
}

function sameBytes(a: string, b: string): boolean {
  const h = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");
  return h(a) === h(b);
}

/** A file moved: renamed where it can be; across drives copied, the copy checked, and only then the original let go. */
function moveFile(from: string, to: string): void {
  mkdirSync(dirname(to), { recursive: true });
  try {
    renameSync(from, to);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EXDEV") throw e;
    copyFileSync(from, to);
    if (!sameBytes(from, to)) { rmSync(to, { force: true }); throw new Conflict("the copy did not match the original, so nothing was moved"); }
    rmSync(from);
  }
  moved(from, to);
  // Seen at once, without waiting for the watchers.
  for (const p of [from, to]) {
    const at = placeOf(p);
    const ix = at && indexes.get(at.project);
    if (ix) { ix.pending.add(at.rel); settle(ix); }
  }
}

const notPage = (rel: string) => {
  if (rel.startsWith(`${WRITING}/`) && rel.endsWith(".md")) throw new Conflict("a writing page is renamed and moved in Writing, which keeps its children with it");
};

export function renameFile(projectId: string, rel: string, name: string): FileRow | null {
  notPage(rel);
  const from = inProject(projectId, rel);
  if (!existsSync(from)) throw new NotFound(`no file ${rel}`);
  const to = join(dirname(from), cleanName(name));
  if (to === from) return null;
  if (existsSync(to)) throw new Conflict(`${name} is already there`);
  moveFile(from, to);
  return null;
}

/** Into another folder of this project or another's; a name taken there is refused, with one that is free. */
export function moveWithin(projectId: string, rel: string, toProject: string, toDir: string): { path: string } {
  notPage(rel);
  const from = inProject(projectId, rel);
  if (!existsSync(from)) throw new NotFound(`no file ${rel}`);
  const dir = toDir ? inProject(toProject, toDir) : findProject(toProject).folder;
  const to = join(dir, basename(from));
  if (to === from) return { path: rel };
  if (existsSync(to)) throw new Conflict(`a file called ${basename(from)} is already there — ${freeName(dir, basename(from))} is free`);
  moveFile(from, to);
  return { path: relative(findProject(toProject).folder, to).split(sep).join("/") };
}

/** To the trash, never gone outright; its tags with it. */
export function trashFile(projectId: string, rel: string): void {
  notPage(rel);
  const abs = inProject(projectId, rel);
  if (!existsSync(abs)) throw new NotFound(`no file ${rel}`);
  try {
    execFileSync("gio", ["trash", abs], { timeout: 15000 });
  } catch (e) {
    throw new Conflict(`could not put it in the trash: ${String((e as { stderr?: Buffer }).stderr ?? (e as Error).message).trim()}`);
  }
  const e = bySource(fileSource(projectId, rel));
  if (e) deleteEntity(e.id);
  const ix = indexes.get(projectId);
  if (ix) { ix.pending.add(rel); settle(ix); }
}

/** A folder file's tags, set whole: its entity made the first time it is tagged. */
export function setFileTags(projectId: string, rel: string, tags: string[]): string[] {
  const next = cleanTags(tags);
  if (!existsSync(inProject(projectId, rel))) throw new NotFound(`no file ${rel}`);
  const e = bySource(fileSource(projectId, rel));
  if (e) { version++; return updateEntity(e.id, { tags: next }).tags ?? []; }
  if (!next.length) return [];
  version++;
  return createEntity({ type: typeFor("file").id, properties: { title: basename(rel) }, tags: next, sources: [fileSource(projectId, rel)] }).tags ?? [];
}

// ------------------------------------------------------------ from elsewhere

const inHome = (path: string) => {
  const full = resolve(path.replace(/^~(?=$|\/)/, home()));
  if (!homeHolds(full)) throw new Conflict("a file in your home folder");
  return full;
};

/** A shortcut: a record of a file elsewhere, shown in the project. Nothing is made on disk. */
export function makeShortcut(projectId: string, path: string): FileRow {
  findProject(projectId);
  const abs = inHome(path);
  if (!existsSync(abs) || !statSync(abs).isFile()) throw new NotFound(`no file at ${abs}`);
  const there = placeOf(abs);
  if (there?.project === projectId) throw new Conflict("it is already in this project's folder");
  for (const { object: o } of allRecords()) {
    if (o[SHORTCUT] === projectId && valuesIn(o.properties.file)[0]?.[LINK]?.path === abs) throw new Conflict("this project already has a shortcut to it");
  }
  const e = createEntity({ type: typeFor("file").id, properties: { title: basename(abs) }, [SHORTCUT]: projectId });
  linkFile(e.id, abs);
  version++;
  return listFiles({ project: projectId }).rows.find((r) => r.entity === e.id)!;
}

// ------------------------------------------------------------ linked folders

/*
 * A folder linked into a project (Files, Add from elsewhere, A folder): every
 * file in it and its folders a shortcut there — hidden ones and programs'
 * machinery aside — and the folder remembered and looked at again now and
 * then, so a file put in it later is linked too. Kept sealed, beside the
 * entities: which folders, and for which projects, is the person's own.
 */
const LINKED_FOLDERS = () => join(DATA_DIR, "linked-folders.sealed");
const SKIP_DIRS = new Set(["node_modules", "__pycache__", ".git", "venv", ".venv", "dist", "build", "target"]);
export const MOST_FROM_A_FOLDER = 2000;

/** Files taken out of a watched folder's shortcuts by hand, per project: not linked again by the watch. */
const SKIPPED = () => join(DATA_DIR, "linked-folders-skipped.sealed");
function skipped(): Record<string, string[]> {
  if (!existsSync(SKIPPED())) return {};
  try { return JSON.parse(unseal(storeKey(), readFileSync(SKIPPED())).toString("utf8")) as Record<string, string[]>; } catch { return {}; }
}
function saveSkipped(l: Record<string, string[]>): void {
  writeAtomic(SKIPPED(), seal(storeKey(), JSON.stringify(l)));
}

function linkedFolders(): Record<string, string[]> {
  if (!existsSync(LINKED_FOLDERS())) return {};
  try { return JSON.parse(unseal(storeKey(), readFileSync(LINKED_FOLDERS())).toString("utf8")) as Record<string, string[]>; } catch { return {}; }
}
function saveLinkedFolders(l: Record<string, string[]>): void {
  writeAtomic(LINKED_FOLDERS(), seal(storeKey(), JSON.stringify(l)));
}

/** Every file in a folder and its folders, but hidden ones and programs' machinery: at most MOST_FROM_A_FOLDER. */
export function folderFiles(path: string): { folder: string; paths: string[]; most: boolean } {
  const dir = inHome(path);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new NotFound(`no folder at ${dir}`);
  const out: string[] = [];
  const walkDir = (d: string) => {
    let names: string[] = [];
    try { names = readdirSync(d).sort(); } catch { return; }
    for (const name of names) {
      if (out.length >= MOST_FROM_A_FOLDER || name.startsWith(".") || name.endsWith(".tmp") || name.endsWith("~")) continue;
      const full = join(d, name);
      try {
        const st = statSync(full);
        if (st.isDirectory()) { if (!SKIP_DIRS.has(name)) walkDir(full); }
        else if (st.isFile()) out.push(full);
      } catch { /* gone between listing and looking */ }
    }
  };
  walkDir(dir);
  return { folder: dir, paths: out, most: out.length >= MOST_FROM_A_FOLDER };
}

/** Shortcuts in a project to each of these files not already there or in its folder: how many made, how many not. */
export function linkPaths(projectId: string, paths: string[]): { made: number; skipped: number } {
  findProject(projectId);
  const have = new Set<string>();
  for (const { object: o } of allRecords()) {
    const p = o[SHORTCUT] === projectId ? valuesIn(o.properties.file)[0]?.[LINK]?.path : undefined;
    if (p) have.add(p);
  }
  let made = 0, skipped = 0;
  for (const path of paths) {
    try {
      const abs = inHome(path);
      if (have.has(abs) || placeOf(abs)?.project === projectId || !existsSync(abs) || !statSync(abs).isFile()) { skipped++; continue; }
      const e = createEntity({ type: typeFor("file").id, properties: { title: basename(abs) }, [SHORTCUT]: projectId });
      linkFile(e.id, abs);
      have.add(abs);
      made++;
    } catch { skipped++; }
  }
  if (made) version++;
  return { made, skipped };
}

/** A folder linked into a project: what is in it linked now, and it watched from now on. */
export function linkFolder(projectId: string, path: string): { folder: string; made: number; skipped: number; most: boolean } {
  findProject(projectId);
  const { folder, paths: all, most } = folderFiles(path);
  // Linked again on purpose: what was taken out of it by hand is linked again too.
  const sk = skipped();
  if (sk[projectId]) { sk[projectId] = sk[projectId].filter((p) => !p.startsWith(folder + "/")); saveSkipped(sk); }
  const paths = all;
  const l = linkedFolders();
  l[projectId] = [...new Set([...(l[projectId] ?? []), folder])];
  saveLinkedFolders(l);
  return { folder, most, ...linkPaths(projectId, paths) };
}

/** A folder no longer watched for a project. Its shortcuts stay; nothing new is linked from it. */
export function unlinkFolder(projectId: string, path: string): void {
  const l = linkedFolders();
  l[projectId] = (l[projectId] ?? []).filter((f) => f !== path);
  if (!l[projectId].length) delete l[projectId];
  saveLinkedFolders(l);
  version++;
}

/** The folders watched for a project (or every project's). */
export function foldersLinked(projectId?: string): { project: string; folder: string; exists: boolean }[] {
  return Object.entries(linkedFolders()).filter(([p]) => !projectId || p === projectId)
    .flatMap(([project, folders]) => folders.map((folder) => ({ project, folder, exists: existsSync(folder) })));
}

/**
 * Looked at again: every linked file (changed: its new contents' hash, which
 * search reads again; gone: missing), and every linked folder (a file new in
 * it: linked). Answers how many things changed.
 */
export function watchLinked(): number {
  let changed = refreshLinks();
  for (const { project, folder, exists } of foldersLinked()) {
    if (!exists) continue;
    try {
      if (!listProjects().some((p) => p.id === project)) continue;
      // What was taken out of it by hand stays out.
      const out = new Set(skipped()[project] ?? []);
      changed += linkPaths(project, folderFiles(folder).paths.filter((p) => !out.has(p))).made;
    } catch { /* unreadable for now */ }
  }
  if (changed) version++;
  return changed;
}

/** A shortcut taken away: the record, never the file. */
export function removeShortcut(entityId: string): { fromWatched: boolean } {
  const o = getEntity(entityId);
  if (typeof o[SHORTCUT] !== "string") throw new Conflict("not a shortcut");
  // From a folder the project watches: remembered, so the watch does not link it again.
  const project = o[SHORTCUT] as string;
  const path = valuesIn(o.properties.file)[0]?.[LINK]?.path;
  const fromWatched = Boolean(path && foldersLinked(project).some((f) => path.startsWith(f.folder + "/")));
  if (fromWatched) {
    const sk = skipped();
    sk[project] = [...new Set([...(sk[project] ?? []), path!])];
    saveSkipped(sk);
  }
  deleteEntity(entityId);
  version++;
  return { fromWatched };
}

export interface Warning { code: "open" | "synced" | "repository" | "drive" | "name" | "referred"; text: string }

/** Which processes have a file open now, by their command name. */
function openBy(abs: string): string[] {
  const who = new Set<string>();
  let pids: string[] = [];
  try { pids = readdirSync("/proc").filter((p) => /^\d+$/.test(p)); } catch { return []; }
  for (const pid of pids) {
    let fds: string[] = [];
    try { fds = readdirSync(`/proc/${pid}/fd`); } catch { continue; }
    for (const fd of fds) {
      try {
        if (readlinkSync(`/proc/${pid}/fd/${fd}`) === abs) { who.add(readFileSync(`/proc/${pid}/comm`, "utf8").trim()); break; }
      } catch { /* gone */ }
    }
  }
  return [...who];
}

function syncedFolder(abs: string): string | null {
  for (let d = dirname(abs); d.startsWith(home()) && d !== home(); d = dirname(d)) {
    try {
      if (readdirSync(d).some((n) => n.startsWith(".sync_") && n.endsWith(".db") || n === ".nextcloudsync.log" || n === ".owncloudsync.log" || n === ".stfolder" || n === ".dropbox")) return d;
    } catch { /* unreadable */ }
  }
  return null;
}

function repositoryOf(abs: string): string | null {
  try {
    return execFileSync("git", ["-C", dirname(abs), "rev-parse", "--show-toplevel"], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch {
    return null;
  }
}

/** Before moving a file in: what moving it would disturb, said plainly, and the name it would take. */
export function checkBringIn(path: string, projectId: string, toDir = ""): { warnings: Warning[]; name: string; to: string } {
  const abs = inHome(path);
  if (!existsSync(abs) || !statSync(abs).isFile()) throw new NotFound(`no file at ${abs}`);
  const dir = toDir ? inProject(projectId, toDir) : findProject(projectId).folder;
  if (placeOf(abs)?.project === projectId) throw new Conflict("it is already in this project's folder");
  const warnings: Warning[] = [];
  const using = openBy(abs);
  if (using.length) warnings.push({ code: "open", text: `Open in ${using.join(", ")} now. Close it first, or it may be saved back where it was.` });
  const synced = syncedFolder(abs);
  if (synced) warnings.push({ code: "synced", text: `In ${synced.replace(home(), "~")}, which is synced: moving it out looks like a delete there, on every machine.` });
  const repo = repositoryOf(abs);
  if (repo) warnings.push({ code: "repository", text: `In the repository ${repo.replace(home(), "~")}: moving it out removes it from there.` });
  try {
    mkdirSync(dir, { recursive: true });
    if (statSync(abs).dev !== statSync(dir).dev) warnings.push({ code: "drive", text: "On another drive: it is copied, the copy checked, and only then the original removed." });
  } catch { /* the folder is made when it is moved */ }
  const name = freeName(dir, basename(abs));
  if (name !== basename(abs)) warnings.push({ code: "name", text: `A file called ${basename(abs)} is already there: this one would be ${name}.` });
  let refs = 0;
  for (const { object: o } of allRecords()) for (const v of Object.values(o.properties ?? {})) for (const a of valuesIn(v)) if (a[LINK]?.path === abs) refs++;
  if (refs) warnings.push({ code: "referred", text: `${refs === 1 ? "One link or shortcut" : `${refs} links and shortcuts`} in Talaris point${refs === 1 ? "s" : ""} at it, and will follow. Other applications' recent files will not.` });
  return { warnings, name, to: join(dir, name) };
}

/** Moved in, as checked: a shortcut to it in this project is now the file itself, and its tags stay. */
export function bringIn(path: string, projectId: string, toDir = "", name?: string): FileRow {
  const checked = checkBringIn(path, projectId, toDir);
  const abs = inHome(path);
  const to = name ? join(dirname(checked.to), freeName(dirname(checked.to), cleanName(name))) : checked.to;
  const shortcuts = allRecords().map((r) => r.object).filter((o) => o[SHORTCUT] === projectId && valuesIn(o.properties.file)[0]?.[LINK]?.path === abs);
  moveFile(abs, to);
  const rel = relative(findProject(projectId).folder, to).split(sep).join("/");
  const tags = [...new Set(shortcuts.flatMap((o) => o.tags ?? []))];
  for (const o of shortcuts) deleteEntity(o.id);
  if (tags.length) setFileTags(projectId, rel, tags);
  return listFiles({ project: projectId }).rows.find((r) => r.path === rel)!;
}

// ------------------------------------------------------------ snapshots

/** A snapshot written into the project as a file (its Files folder unless said), and linked where it was. */
export function saveSnapshot(holder: string, sha256: string, projectId: string, toDir = FILES): { path: string } {
  const dir = inProject(projectId, toDir);
  const v = toLink(holder, sha256, dir);
  const at = placeOf(v[LINK]!.path);
  if (at) { const ix = indexes.get(at.project); if (ix) { ix.pending.add(at.rel); settle(ix); } }
  return { path: at?.rel ?? v[LINK]!.path };
}

/**
 * Something to open that is not a plain file on disk: a snapshot, or a sealed
 * file of a project's — written out, read-only, where only this session can
 * see it, and gone when the session ends.
 */
export function openableCopy(input: { sha256?: string; project?: string; path?: string; name?: string }): string {
  let bytes: Buffer | null = null, name = input.name ?? "file";
  if (input.sha256) {
    bytes = getFile(input.sha256);
    if (!input.name) for (const { object: o } of allRecords()) for (const v of Object.values(o.properties ?? {})) for (const a of valuesIn(v)) if (a.sha256 === input.sha256) name = a.filename;
  } else if (input.project && input.path) {
    bytes = readBytes(inProject(input.project, input.path));
    name = basename(input.path);
  }
  if (!bytes) throw new NotFound("nothing is held for it");
  const dir = join(process.env.XDG_RUNTIME_DIR ?? tmpdir(), "talaris-open");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const out = join(dir, `${createHash("sha256").update(bytes).digest("hex").slice(0, 8)}-${basename(name)}`);
  if (existsSync(out)) chmodSync(out, 0o600);
  writeFileSync(out, bytes, { mode: 0o400 });
  chmodSync(out, 0o400);
  return out;
}

/** For tags.ts: where a file entity's file is, for opening it from a tag. */
export function fileOf(o: Entity): { project: string; path?: string; abs?: string } | null {
  const src = sourcesOf(o).find((s) => s.kind === "file");
  if (src) {
    const at = src.key.indexOf("/");
    const project = src.key.slice(0, at), path = src.key.slice(at + 1);
    try { return { project, path, abs: join(findProject(project).folder, path) }; } catch { return null; }
  }
  if (typeof o[SHORTCUT] === "string") return { project: o[SHORTCUT] as string, abs: valuesIn(o.properties.file)[0]?.[LINK]?.path };
  return null;
}
