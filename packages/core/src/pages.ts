// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import type { PageNode } from "@talaris/model";
import { MACHINERY, WRITING } from "./paths.js";
import { Conflict, NotFound, findProject } from "./projects.js";
import { readJson, writeAtomic, writeJson } from "./store.js";
import { listVersions, readVersion, saveVersion, versionDir } from "./versions.js";

/**
 * Writing pages are Markdown files in the project's visible `Writing/` folder,
 * and they nest: a page's children live in a folder of its name beside it —
 * `Camp rules.md` and `Camp rules/`. So the tree reads the same in a file
 * manager as in the drawer, and other applications can open any page.
 *
 * The file system keeps no order, so **sibling order is Talaris's**, kept in
 * `.talaris/writing-order.json` by parent path. A page that arrives from
 * outside — written by another app, synced in — is not in that list and is
 * shown at the end, never ignored.
 */

const ORDER = "writing-order.json";

function writingDir(folder: string): string {
  return join(folder, WRITING);
}

/** A page path, checked: no escaping `Writing/`, no hidden names. */
function safe(path: string): string {
  const parts = path.split("/").map((p) => p.trim());
  if (!parts.length || parts.some((p) => !p || p.startsWith(".") || p.includes("\\") || p.includes("\0"))) {
    throw new Conflict(`"${path}" is not a page path`);
  }
  return parts.join("/");
}

function pageFile(folder: string, path: string): string {
  const full = resolve(writingDir(folder), `${safe(path)}.md`);
  if (!full.startsWith(resolve(writingDir(folder)) + "/")) throw new Conflict("outside Writing");
  return full;
}

function childDir(folder: string, path: string): string {
  return join(writingDir(folder), safe(path));
}

type Order = Record<string, string[]>;

function readOrder(folder: string): Order {
  try {
    return readJson<Order>(join(folder, MACHINERY, ORDER));
  } catch {
    return {};
  }
}

function writeOrder(folder: string, order: Order): void {
  writeJson(join(folder, MACHINERY, ORDER), order);
}

/** The titles of the pages directly inside `parent` ("" for the top), in order. */
function siblings(folder: string, parent: string, order: Order): string[] {
  const here = parent ? childDir(folder, parent) : writingDir(folder);
  if (!existsSync(here)) return [];
  const names = new Set<string>();
  for (const entry of readdirSync(here)) {
    if (entry.startsWith(".")) continue;
    const full = join(here, entry);
    if (entry.endsWith(".md") && statSync(full).isFile()) names.add(entry.slice(0, -3));
    // A folder with no page of its own name still holds pages, so it is shown
    // as a page — empty until something is written in it.
    else if (statSync(full).isDirectory()) names.add(entry);
  }
  const known = (order[parent] ?? []).filter((n) => names.has(n));
  const arrived = [...names].filter((n) => !known.includes(n)).sort((a, b) => a.localeCompare(b));
  return [...known, ...arrived];
}

export function pageTree(projectId: string): PageNode[] {
  const { folder } = findProject(projectId);
  const order = readOrder(folder);
  const build = (parent: string): PageNode[] =>
    siblings(folder, parent, order).map((title) => {
      const path = parent ? `${parent}/${title}` : title;
      return { path, title, children: build(path) };
    });
  return build("");
}

export function readPage(projectId: string, path: string): string {
  const { folder } = findProject(projectId);
  const file = pageFile(folder, path);
  if (existsSync(file)) return readFileSync(file, "utf8");
  if (existsSync(childDir(folder, path))) return "";
  throw new NotFound(`no page ${path}`);
}

export function writePage(projectId: string, path: string, text: string): void {
  const { folder } = findProject(projectId);
  const file = pageFile(folder, path);
  writeAtomic(file, text);
  saveVersion(versionDir(join(folder, MACHINERY), "page", safe(path)), text, "md");
}

/** A title that is free among its siblings: "Untitled", then "Untitled 2"… */
function freeTitle(folder: string, parent: string, title: string): string {
  const taken = new Set(siblings(folder, parent, readOrder(folder)));
  const base = title.trim().replace(/[/\\\0]/g, "-").replace(/^\.+/, "") || "Untitled";
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base} ${n}`)) return `${base} ${n}`;
}

export function createPage(projectId: string, parent: string | null, title: string): PageNode {
  const { folder } = findProject(projectId);
  const under = parent ? safe(parent) : "";
  if (under && !existsSync(pageFile(folder, under)) && !existsSync(childDir(folder, under))) {
    throw new NotFound(`no page ${under}`);
  }
  const name = freeTitle(folder, under, title);
  const path = under ? `${under}/${name}` : name;
  writeAtomic(pageFile(folder, path), "");
  const order = readOrder(folder);
  order[under] = [...siblings(folder, under, order).filter((n) => n !== name), name];
  writeOrder(folder, order);
  return { path, title: name, children: [] };
}

/**
 * Rename or move a page, taking its children with it — the file and the
 * folder of the same name move together — along with its versions and the
 * order of everything beneath it.
 */
export function movePage(projectId: string, path: string, newParent: string | null, newTitle?: string): PageNode {
  const { folder } = findProject(projectId);
  const from = safe(path);
  const fromParent = from.includes("/") ? from.slice(0, from.lastIndexOf("/")) : "";
  const oldTitle = from.slice(fromParent ? fromParent.length + 1 : 0);
  const toParent = newParent ? safe(newParent) : "";
  if (toParent === from || toParent.startsWith(`${from}/`)) throw new Conflict("a page cannot go inside itself");
  const title = toParent === fromParent && (newTitle ?? oldTitle).trim() === oldTitle
    ? oldTitle
    : freeTitle(folder, toParent, newTitle ?? oldTitle);
  const to = toParent ? `${toParent}/${title}` : title;
  if (to === from) return { path: from, title, children: [] };

  const order = readOrder(folder);
  const moves: Array<[string, string]> = [];
  if (existsSync(pageFile(folder, from))) moves.push([pageFile(folder, from), pageFile(folder, to)]);
  if (existsSync(childDir(folder, from))) moves.push([childDir(folder, from), childDir(folder, to)]);
  if (!moves.length) throw new NotFound(`no page ${from}`);
  for (const [a, b] of moves) {
    mkdirSync(dirname(b), { recursive: true });
    renameSync(a, b);
  }

  // Versions and order are keyed by path, so they follow the page.
  const machinery = join(folder, MACHINERY);
  const versionsRoot = join(machinery, "versions", "page");
  if (existsSync(versionsRoot)) {
    for (const key of readdirSync(versionsRoot)) {
      const p = decodeURIComponent(key);
      if (p === from || p.startsWith(`${from}/`)) {
        const moved = to + p.slice(from.length);
        const target = versionDir(machinery, "page", moved);
        if (!existsSync(target)) renameSync(join(versionsRoot, key), target);
      }
    }
  }
  const next: Order = {};
  for (const [key, names] of Object.entries(order)) {
    const k = key === from || key.startsWith(`${from}/`) ? to + key.slice(from.length) : key;
    next[k] = names;
  }
  next[fromParent] = (next[fromParent] ?? []).filter((n) => n !== oldTitle);
  next[toParent] = [...(next[toParent] ?? []).filter((n) => n !== title), title];
  writeOrder(folder, next);
  return { path: to, title, children: [] };
}

/** Put a page at a position among its siblings. */
export function reorderPage(projectId: string, path: string, index: number): void {
  const { folder } = findProject(projectId);
  const p = safe(path);
  const parent = p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "";
  const title = p.slice(parent ? parent.length + 1 : 0);
  const order = readOrder(folder);
  const list = siblings(folder, parent, order).filter((n) => n !== title);
  list.splice(Math.max(0, Math.min(index, list.length)), 0, title);
  order[parent] = list;
  writeOrder(folder, order);
}

/**
 * Delete a page. Refused while it has pages beneath it — they would go with
 * it, which is too much for one keystroke. Its text stays in its versions.
 */
export function deletePage(projectId: string, path: string): void {
  const { folder } = findProject(projectId);
  const p = safe(path);
  const dir = childDir(folder, p);
  if (existsSync(dir) && readdirSync(dir).some((n) => !n.startsWith("."))) {
    throw new Conflict(`"${p}" still has pages beneath it`);
  }
  const file = pageFile(folder, p);
  if (existsSync(file)) {
    saveVersion(versionDir(join(folder, MACHINERY), "page", p), readFileSync(file, "utf8"), "md");
    rmSync(file);
  }
  if (existsSync(dir)) rmSync(dir, { recursive: true });
}

export function pageVersions(projectId: string, path: string) {
  const { folder } = findProject(projectId);
  return listVersions(versionDir(join(folder, MACHINERY), "page", safe(path)));
}

export function pageVersion(projectId: string, path: string, name: string): string {
  const { folder } = findProject(projectId);
  return readVersion(versionDir(join(folder, MACHINERY), "page", safe(path)), name);
}

export function restorePage(projectId: string, path: string, name: string): string {
  const text = pageVersion(projectId, path, name);
  writePage(projectId, path, text);
  return text;
}

/** Where a page lives on disk, for opening it in another application. */
export function pageLocation(projectId: string, path: string): string {
  const { folder } = findProject(projectId);
  return relative(folder, pageFile(folder, path));
}

/**
 * Daily notes: pages at `Writing/Daily/<YYYY-MM-DD>.md`. Ordinary pages in
 * every other way — same editor, same versions — so a day's note is never a
 * second kind of document. A day has a note only once something is written:
 * opening an empty day makes no file.
 *
 * A project keeps daily notes when its `daily` is true; Home does unless told
 * otherwise.
 */
export const DAILY = "Daily";

export function dailyEnabled(projectId: string): boolean {
  const { folder, home } = findProject(projectId);
  const project = readJson<Record<string, unknown>>(join(folder, MACHINERY, "project.json"));
  return typeof project.daily === "boolean" ? project.daily : home;
}

/** The days of `month` (`YYYY-MM`) that have a note, and how many words each holds. */
export function dailyMonth(projectId: string, month: string): Array<{ date: string; words: number }> {
  if (!/^\d{4}-\d{2}$/.test(month)) throw new Conflict("a month is YYYY-MM");
  const { folder } = findProject(projectId);
  const dir = join(writingDir(folder), DAILY);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => n.startsWith(`${month}-`) && /^\d{4}-\d{2}-\d{2}\.md$/.test(n))
    .sort()
    .map((n) => {
      const text = readFileSync(join(dir, n), "utf8");
      return { date: n.slice(0, 10), words: text.split(/\s+/).filter(Boolean).length };
    })
    .filter((d) => d.words > 0);
}
