// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore

/**
 * Lists (DESIGN, *Files: lists*): a project's own groupings of what Files
 * shows of it — files, pages, canvases, Morgan's threads, shortcuts — named,
 * in an order, and inside one another.
 *
 * Where a thing lives is one place: its folder, its parent page, its parent
 * canvas, Home for a thread. A list is not that. It holds references only:
 * a thing can be in any number of lists, putting it in one moves and copies
 * nothing, and taking it out deletes nothing. A list belongs to a project,
 * and holds only what is in that project — something from elsewhere comes in
 * by a shortcut first.
 *
 * Kept in the project's folder (`.talaris/file-lists.json`, sealed with the
 * project if it is), so the lists go where the project goes. Members are
 * known by their Files row keys (files.ts, `FileRow.key`); a file or page
 * moved or renamed keeps its place in every list (`membersMoved`).
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { MACHINERY } from "./paths.js";
import { Conflict, NotFound, findProject, listProjects } from "./projects.js";
import { newId, readJson, writeJson } from "./store.js";

export interface FileList {
  id: string;
  name: string;
  /** The list it is inside; null at the top. */
  parent: string | null;
  /** Its members, in order: Files row keys. */
  items: string[];
}
export interface ListNode { id: string; name: string; parent: string | null; count: number; /** Its own members, in order (not its lists'). */ items: string[]; children: ListNode[] }

const FILE = (projectId: string) => join(findProject(projectId).folder, MACHINERY, "file-lists.json");

function read(projectId: string): FileList[] {
  const path = FILE(projectId);
  if (!existsSync(path)) return [];
  try { return readJson<{ lists?: FileList[] }>(path).lists ?? []; } catch { return []; }
}
function write(projectId: string, lists: FileList[]): void {
  writeJson(FILE(projectId), { lists });
}

function find(lists: FileList[], id: string): FileList {
  const l = lists.find((x) => x.id === id);
  if (!l) throw new NotFound(`no list ${id}`);
  return l;
}

/** A list and every list inside it, at any depth. */
function below(lists: FileList[], id: string): FileList[] {
  const out: FileList[] = [];
  const walk = (p: string) => { for (const l of lists) if (l.parent === p) { out.push(l); walk(l.id); } };
  walk(id);
  return out;
}

/** A project's lists as a tree, each with how many things it holds (its own and its lists'). */
export function listTree(projectId: string): ListNode[] {
  const lists = read(projectId);
  const node = (l: FileList): ListNode => ({ id: l.id, name: l.name, parent: l.parent, count: members(projectId, l.id).length, items: l.items,
    children: lists.filter((c) => c.parent === l.id).map(node) });
  return lists.filter((l) => !l.parent || !lists.some((p) => p.id === l.parent)).map(node);
}

/** What a list holds, in order: its own, then each list inside it's, once each. */
export function members(projectId: string, id: string, lists = read(projectId)): string[] {
  const l = find(lists, id);
  const out = new Set(l.items);
  for (const c of lists.filter((x) => x.parent === id)) for (const k of members(projectId, c.id, lists)) out.add(k);
  return [...out];
}

/** The lists a thing is in, by name, for its details. */
export function listsHolding(projectId: string, key: string): { id: string; name: string }[] {
  return read(projectId).filter((l) => l.items.includes(key)).map((l) => ({ id: l.id, name: l.name }));
}

const clean = (name: string) => {
  const n = name.trim().replace(/\s+/g, " ");
  if (!n) throw new Conflict("a list needs a name");
  return n.slice(0, 120);
};

export function createList(projectId: string, name: string, parent: string | null = null): FileList {
  const lists = read(projectId);
  if (parent) find(lists, parent);
  const l: FileList = { id: newId("lst"), name: clean(name), parent, items: [] };
  lists.push(l);
  write(projectId, lists);
  return l;
}

export function renameList(projectId: string, id: string, name: string): FileList {
  const lists = read(projectId);
  const l = find(lists, id);
  l.name = clean(name);
  write(projectId, lists);
  return l;
}

/** A list put inside another (or at the top, `null`), at a place among its siblings. */
export function moveList(projectId: string, id: string, parent: string | null, index?: number): FileList {
  const lists = read(projectId);
  const l = find(lists, id);
  if (parent) {
    find(lists, parent);
    if (parent === id || below(lists, id).some((x) => x.id === parent)) throw new Conflict("a list cannot go inside itself");
  }
  l.parent = parent;
  if (index !== undefined) {
    const rest = lists.filter((x) => x !== l);
    const siblings = rest.filter((x) => x.parent === parent);
    const at = siblings[Math.max(0, Math.min(index, siblings.length))];
    rest.splice(at ? rest.indexOf(at) : rest.length, 0, l);
    write(projectId, rest);
  } else write(projectId, lists);
  return l;
}

/** A list gone, and the lists inside it. What they held is not touched. */
export function deleteList(projectId: string, id: string): number {
  const lists = read(projectId);
  find(lists, id);
  const gone = new Set([id, ...below(lists, id).map((l) => l.id)]);
  write(projectId, lists.filter((l) => !gone.has(l.id)));
  return gone.size;
}

/**
 * Things put in a list, at its end, those already there left where they are.
 * `inProject` says which keys are the project's: a list holds nothing else.
 */
export function addToList(projectId: string, id: string, keys: string[], inProject: (key: string) => boolean): { added: number; refused: string[] } {
  const lists = read(projectId);
  const l = find(lists, id);
  const refused: string[] = [];
  let added = 0;
  for (const k of keys) {
    if (!inProject(k)) { refused.push(k); continue; }
    if (!l.items.includes(k)) { l.items.push(k); added++; }
  }
  if (added) write(projectId, lists);
  return { added, refused };
}

export function removeFromList(projectId: string, id: string, keys: string[]): number {
  const lists = read(projectId);
  const l = find(lists, id);
  const before = l.items.length;
  l.items = l.items.filter((k) => !keys.includes(k));
  if (l.items.length !== before) write(projectId, lists);
  return before - l.items.length;
}

/** A list's own members in an order given whole (dragged into it); any left out keep their order after. */
export function orderList(projectId: string, id: string, keys: string[]): void {
  const lists = read(projectId);
  const l = find(lists, id);
  const given = keys.filter((k) => l.items.includes(k));
  l.items = [...given, ...l.items.filter((k) => !given.includes(k))];
  write(projectId, lists);
}

/**
 * Things that moved or were renamed, in every project's lists: `to` answers
 * each key's new key, null where it is unchanged, "" where it is gone. One that moved into
 * another project leaves this one's lists, as it left the project.
 */
export function membersMoved(to: (key: string) => string | null): void {
  for (const p of listProjects()) {
    let lists: FileList[];
    try { lists = read(p.id); } catch { continue; }
    let dirty = false;
    for (const l of lists) {
      const next: string[] = [];
      for (const k of l.items) {
        const n = to(k);
        if (n === null) { next.push(k); continue; }
        dirty = true;
        // Gone from every project: out of the list.
        if (n === "") continue;
        // A folder's file or page names its project in its key; a thread is Home's wherever its key says.
        const owner = n.startsWith("p:") ? n.slice(2, n.indexOf("/")) : p.id;
        if (owner === p.id && !next.includes(n)) next.push(n);
      }
      l.items = next;
    }
    if (dirty) write(p.id, lists);
  }
}
