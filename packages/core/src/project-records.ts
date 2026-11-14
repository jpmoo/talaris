// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore

/**
 * Sync's records of a project's files (docs/SYNC.md, *Records*; records.ts):
 * every file Talaris writes inside a project — its pages, its canvases, its
 * settings in `.talaris/` — as what changed in it, never the whole file.
 *
 * Heard where every such file is written (store.ts, `writeAtomic`), before it
 * is sealed for an encrypted project, so what is recorded is what was meant.
 * What moves or goes is told from where that happens (pages.ts, canvases.ts):
 * `moved`, `removed`.
 *
 * - **A page** (`Writing/…md`): `page:<project>/<path>` — its text, and the hash
 *   of the text it replaced (`was`), the base a three-way merge needs (step 3).
 *   Its note's id, when it has one, rides along (`note`): a page is known by its
 *   note on the other machine, whatever its path there.
 * - **A canvas** (`.talaris/canvases/<id>.json`): its own fields as
 *   `canvas:<id>`, and every item, link and region as a record of its own
 *   (`item:<canvas>/<id>`, …), so two machines moving two different cards both
 *   keep their move. Its revision counter is the machine's own.
 * - **The project** (`.talaris/project.json`): `project:<id>`, field by field.
 * - **Any other `.talaris` file** (page look and order, the canvas list,
 *   starred, file lists): `pfile:<project>/<file>`, entry by entry — each key
 *   of the file its own field, so a look set for one page here and another
 *   there are both kept.
 * - Not recorded: version history (each machine keeps its own, written as the
 *   records are applied), and files of the Library itself (step 2b, with their
 *   bytes).
 */

import { createHash } from "node:crypto";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { diff, syncing, write, type Change } from "./records.js";
import { DATA_DIR } from "./vault.js";
import { watchWrites, readText } from "./store.js";
import { MACHINERY, WRITING } from "./paths.js";
import { allProjects as listProjects } from "./projects.js";
import { bySource } from "./entities.js";

interface Place { project: string; rel: string }

/** Which project a path is in, and where in it; null for anything outside a project. */
export function placeOf(path: string): Place | null {
  let best: { id: string; folder: string } | null = null;
  for (const p of listProjects()) {
    if ((path === p.folder || path.startsWith(p.folder + sep)) && (!best || p.folder.length > best.folder.length)) best = p;
  }
  return best ? { project: best.id, rel: relative(best.folder, path).split(sep).join("/") } : null;
}

const hash = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16);
const parse = (text: string | null): Record<string, unknown> | null => {
  if (text == null) return null;
  try { const v = JSON.parse(text); return v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null; } catch { return null; }
};
const byId = (list: unknown): Map<string, Record<string, unknown>> =>
  new Map((Array.isArray(list) ? list : []).filter((x) => x && typeof x === "object" && typeof (x as { id?: unknown }).id === "string")
    .map((x) => [(x as { id: string }).id, x as Record<string, unknown>]));

/** The records a write of `text` over `before` makes, for the file at `at`. */
export function recordsOf(at: Place, before: string | null, text: string): Change[] {
  const { project, rel } = at;
  // A page.
  if (rel.startsWith(`${WRITING}/`) && rel.endsWith(".md")) {
    if (before === text) return [];
    const path = rel.slice(WRITING.length + 1, -3);
    const note = bySource({ kind: "page", key: `${project}/${path}` });
    return [{ of: `page:${project}/${path}`, set: { text, was: before == null ? null : hash(before), ...(note ? { note: note.id } : {}) } }];
  }
  if (!rel.startsWith(`${MACHINERY}/`)) return [];
  const name = rel.slice(MACHINERY.length + 1);
  if (name.startsWith("versions/") || name.startsWith("merged-away/")) return [];
  const after = parse(text);
  if (!after) return [];
  const was = parse(before);
  // The project itself.
  if (name === "project.json") return [diff(`project:${String(after.id ?? project)}`, was, after)];
  // A canvas: its fields, and each of what is on it.
  const canvas = name.match(/^canvases\/([^/]+)\.json$/);
  if (canvas) {
    const id = canvas[1]!;
    const out: Change[] = [];
    const { items: _i, links: _l, regions: _r, ...fields } = after;
    const { items: _bi, links: _bl, regions: _br, ...wasFields } = was ?? {};
    out.push(diff(`canvas:${id}`, was ? wasFields : null, fields, new Set(), new Set(["talaris:rev"])));
    for (const [list, kind] of [["items", "item"], ["links", "clink"], ["regions", "region"]] as const) {
      const now = byId(after[list]), then = byId(was?.[list]);
      for (const [k, v] of now) out.push(diff(`${kind}:${id}/${k}`, then.get(k) ?? null, v));
      for (const k of then.keys()) if (!now.has(k)) out.push({ of: `${kind}:${id}/${k}`, gone: true });
    }
    return out;
  }
  // Any other of the project's own files: each key an entry of its own.
  return [diff(`pfile:${project}/${name}`, was, after)];
}

/** Heard from store.ts as each file is written. */
function wrote(path: string, data: string | Buffer): void {
  // Cheap ways out first: every entity's save comes through here too, and nothing is recorded while sync is off.
  if (!syncing() || path.startsWith(DATA_DIR + sep)) return;
  const at = placeOf(path);
  if (!at) return;
  if (Buffer.isBuffer(data)) return; // bytes, not text: a Library file's (step 2b)
  let before: string | null = null;
  try { if (existsSync(path)) before = readText(path); } catch { before = null; }
  for (const change of recordsOf(at, before, data)) write(change);
}

/** A page or a canvas gone (pages.ts, canvases.ts). */
export function removed(path: string): void {
  if (!syncing()) return;
  const at = placeOf(path);
  if (!at) return;
  if (at.rel.startsWith(`${WRITING}/`) && at.rel.endsWith(".md")) write({ of: `page:${at.project}/${at.rel.slice(WRITING.length + 1, -3)}`, gone: true });
  const canvas = at.rel.match(/^\.talaris\/canvases\/([^/]+)\.json$/);
  if (canvas) write({ of: `canvas:${canvas[1]}`, gone: true });
}

/** A page moved, here or to another project (pages.ts): said on its old place, with where it went. */
export function moved(from: string, to: string): void {
  if (!syncing()) return;
  const a = placeOf(from), b = placeOf(to);
  if (!a || !b || !a.rel.startsWith(`${WRITING}/`)) return;
  const page = (p: Place) => `${p.project}/${p.rel.slice(WRITING.length + 1).replace(/\.md$/, "")}`;
  write({ of: `page:${page(a)}`, set: { movedTo: page(b) } });
}

/** From startup (index.ts): the project's files recorded as they are written. */
export function startRecordingProjects(): void {
  watchWrites(wrote);
}

/** Every page file under a path (itself, if it is one): relative paths, `.md` and all. */
function pagesUnder(path: string): string[] {
  if (!existsSync(path)) return [];
  if (!statSync(path).isDirectory()) return path.endsWith(".md") ? [""] : [];
  const out: string[] = [];
  const walk = (dir: string, rel: string) => {
    for (const n of readdirSync(dir)) {
      const full = join(dir, n);
      if (statSync(full).isDirectory()) walk(full, rel ? `${rel}/${n}` : n);
      else if (n.endsWith(".md")) out.push(rel ? `${rel}/${n}` : n);
    }
  };
  walk(path, "");
  return out;
}
const under = (base: string, rel: string) => (rel ? join(base, rel) : base);

/** A page, or a page's folder of pages, moved (pages.ts): each page in it, said moved. Asked after the move. */
export function movedTree(from: string, to: string): void {
  if (!syncing()) return;
  for (const rel of pagesUnder(to)) moved(under(from, rel), under(to, rel));
}
/** Copied (a page sent to another project, kept here too): each copy a new page, its words and all. */
export function copiedTree(to: string): void {
  if (!syncing()) return;
  for (const rel of pagesUnder(to)) {
    const path = under(to, rel);
    const at = placeOf(path);
    if (!at) continue;
    let text = "";
    try { text = readText(path); } catch { continue; }
    for (const change of recordsOf(at, null, text)) write(change);
  }
}
/** About to be removed (pages.ts): each page in it, said gone. Asked before the removal. */
export function removedTree(path: string): void {
  if (!syncing()) return;
  for (const rel of pagesUnder(path)) removed(under(path, rel));
}
