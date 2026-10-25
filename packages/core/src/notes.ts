// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore

/*
 * Undated notes, for the live binding (interchange.ts) and so for a sync.
 *
 * A note's words live in its file in ~/Projects/Notes (pages.ts, as the
 * project `notes`), and the file is the truth. What the binding hands out is
 * an entity standing for it — the same one that holds its mentions (a page's
 * source, `notes/<path>`) — carrying its title, its words where the note
 * profile puts a body (Talaris's own Note type: its `body` field; `content`
 * for a type that says so) and a mark, `talaris:undated`, so that a sync can tell an
 * undated note from every other note-shaped thing in the store (a page's or
 * a canvas note's mentions). Renamed or moved, it is the same entity
 * (`movedText`); nested, it is too: where it sits is Talaris's alone, and
 * only its own title travels.
 *
 * Kept in step by looking (`reconcileNotes`), before every read and write
 * through the binding: so a note edited in another editor, one moved into a
 * project (it loses its mark: no longer undated), and one deleted (its entity
 * goes, which the feed says) are all seen, without every page call having to
 * remember to say so.
 *
 * A write through the binding goes to the file: a new title renames the
 * note where it is, new words are written to it; a note made through the
 * binding is made at the top of the undated notes, at the id asked for.
 */

import { allRecords, bySource, createEntity, deleteEntity, getEntity, typeFor, types, updateEntity, type Entity } from "./entities.js";
import { UNDATED } from "./projects.js";
import { createPage, movePage, pageTree, readPage, writePage } from "./pages.js";
import type { PageNode } from "@talaris/model";

export const MARK = "talaris:undated";
const PREFIX = `${UNDATED}/`;
const sourceOf = (path: string) => ({ kind: "page", key: `${PREFIX}${path}` });
const titleOf = (path: string) => path.split("/").pop() ?? path;
const pageSource = (e: Entity) => ((e["talaris:sources"] as { kind: string; key: string }[] | undefined) ?? []).find((s) => s.kind === "page");

/** The property a note's title is kept in, as the note profile says (Talaris's own note type: `title`). */
function titleKey(typeId: string | undefined): string {
  const t = types().find((x) => x.id === typeId)?.profiles?.note?.title;
  return typeof t === "string" ? t : "title";
}
/** Where a note's words are kept, as the note profile says: a field (Talaris's own: `body`), or `content`. */
export function bodyKey(typeId: string | undefined): string {
  const b = types().find((x) => x.id === typeId)?.profiles?.note?.body;
  return typeof b === "string" ? b : "content";
}
/** A note entity's words, wherever its type keeps them. */
const wordsOf = (e: Entity) => { const k = bodyKey(e.type); return String((k === "content" ? e.content : e.properties[k]) ?? ""); };
/** The patch that puts words where a type keeps them. */
const wordsAt = (typeId: string | undefined, text: string) => { const k = bodyKey(typeId); return k === "content" ? { content: text } : { properties: { [k]: text } }; };

function allPaths(): string[] {
  const out: string[] = [];
  const walk = (nodes: PageNode[]) => { for (const n of nodes) { out.push(n.path); walk(n.children); } };
  walk(pageTree(UNDATED));
  return out;
}

/** An undated note's entity brought up to date with its file — made, if it has none; `id` only when it is made. */
function mirror(path: string, id?: string): Entity {
  const title = titleOf(path);
  let text = "";
  try { text = readPage(UNDATED, path); } catch { /* a folder with no page of its own: a note with no words */ }
  const e = bySource(sourceOf(path));
  if (!e) {
    const type = typeFor("note");
    const words = wordsAt(type.id, text);
    return createEntity({ ...(id ? { id } : {}), type: type.id, properties: { [titleKey(type.id)]: title, ...(words.properties ?? {}) },
      ...(words.content !== undefined ? { content: words.content } : {}), sources: [sourceOf(path)], "talaris:textElsewhere": true, [MARK]: true });
  }
  const key = titleKey(e.type);
  if (e.properties[key] === title && wordsOf(e) === text && e[MARK] === true) return e;
  const words = wordsAt(e.type, text);
  return updateEntity(e.id, { properties: { [key]: title, ...(words.properties ?? {}) }, ...(words.content !== undefined ? { content: words.content } : {}), [MARK]: true });
}

/** Every undated note's entity as its file is; any that stood for one gone or moved into a project, said so. */
export function reconcileNotes(): void {
  const paths = new Set(allPaths());
  for (const p of paths) mirror(p);
  for (const r of allRecords()) {
    const e = r.object;
    if (e[MARK] !== true) continue;
    const src = pageSource(e);
    const path = src?.key.startsWith(PREFIX) ? src.key.slice(PREFIX.length) : null;
    if (path && paths.has(path)) continue;
    if (!src || src.key.startsWith(PREFIX)) {
      // Its note deleted: gone, as the feed will say.
      deleteEntity(e.id);
    } else {
      // Moved into a project: still the page its mentions know, no longer an undated note — its words stay in the file alone.
      const k = bodyKey(e.type);
      updateEntity(e.id, { ...(k === "content" ? { content: null } : { properties: { [k]: null } }), [MARK]: null });
    }
  }
}

/** Whether an entity is an undated note — written through to its file rather than kept in the store. */
export function isUndated(id: string): boolean {
  try { return getEntity(id)[MARK] === true; } catch { return false; }
}

/**
 * A write through the binding to an undated note: a title renames it where it
 * is; words — in the body field its type names, or `content` — are written to
 * its file. `content` is the patch's body, for a type that keeps words there.
 */
export function writeNote(id: string, set: Record<string, unknown>, content: string | undefined): Entity {
  const e = getEntity(id);
  const src = pageSource(e);
  if (!src?.key.startsWith(PREFIX)) throw new Error(`${id} is not an undated note`);
  let path = src.key.slice(PREFIX.length);
  const key = titleKey(e.type);
  const title = typeof set[key] === "string" ? (set[key] as string).trim() : "";
  if (title && title !== titleOf(path)) {
    const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : null;
    path = movePage(UNDATED, path, parent, title).path;
  }
  const k = bodyKey(e.type);
  const words = k === "content" ? content : typeof set[k] === "string" ? (set[k] as string) : k in set && set[k] === null ? "" : undefined;
  if (words !== undefined) writePage(UNDATED, path, words);
  return mirror(path);
}

/** A note made through the binding: at the top of the undated notes, at the id asked for. */
export function createNote(id: string, title: string, content: string): Entity {
  const page = createPage(UNDATED, null, title);
  if (content) writePage(UNDATED, page.path, content);
  // Made by the page calls above with an id of their own, if it mentions anything: given the one asked for instead.
  const made = bySource(sourceOf(page.path));
  if (made && made.id !== id) deleteEntity(made.id);
  return mirror(page.path, id);
}
