// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore

/*
 * Tags, across everything that carries them: tasks and people (on their
 * entities, as always), and now writing pages — a project's own and the
 * undated notes.
 *
 * A page's tags are kept on the entity that stands for it: the one that holds
 * its mentions, known by where the page is (a `page` source, `<project>/<path>`,
 * or `notes/<path>` for an undated note). Renaming or moving a page already
 * carries that entity with it (`movedText`), so its tags go along; an undated
 * note's entity is the one the live binding hands out (notes.ts), so its tags
 * travel to Hermes Notes like any object's. A page gets an entity the first
 * time it is tagged, and loses it when it is deleted.
 *
 * What answers "everything tagged so" is what the canvas, the launcher and
 * Morgan ask: each thing as a summary, a page with where it is so it opens there.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { allRecords, bySource, createEntity, deleteEntity, getEntity, summary, titleOf, typeFor, updateEntity, type Entity, type Summary } from "./entities.js";
import { findProject } from "./projects.js";
import { pageLocation } from "./pages.js";
import { fileOf } from "./files.js";

const pageSource = (projectId: string, path: string) => ({ kind: "page", key: `${projectId}/${path}` });

/** Where a page entity's page is, or null for any other entity. */
export function pageOf(e: Entity): { project: string; path: string } | null {
  const src = ((e["talaris:sources"] as { kind: string; key: string }[] | undefined) ?? []).find((s) => s.kind === "page");
  if (!src) return null;
  const at = src.key.indexOf("/");
  return at < 0 ? null : { project: src.key.slice(0, at), path: src.key.slice(at + 1) };
}

/** Tags as people write them: trimmed, a leading # dropped, empties and repeats gone. */
export function cleanTags(tags: unknown): string[] {
  if (!Array.isArray(tags)) return [];
  return [...new Set(tags.map((t) => String(t ?? "").trim().replace(/^#+/, "").trim()).filter(Boolean))];
}

/** A page's tags. */
export function pageTags(projectId: string, path: string): string[] {
  return bySource(pageSource(projectId, path))?.tags ?? [];
}

/** A page's tags, set whole: its entity made the first time, as the one its mentions would have. */
export function setPageTags(projectId: string, path: string, tags: string[]): string[] {
  const next = cleanTags(tags);
  const e = bySource(pageSource(projectId, path));
  if (e) return updateEntity(e.id, { tags: next }).tags ?? [];
  if (!next.length) return [];
  const title = path.split("/").pop() ?? path;
  const made = createEntity({ type: typeFor("note").id, properties: { title: title.slice(0, 120) }, tags: next,
    sources: [pageSource(projectId, path)], "talaris:textElsewhere": true });
  return made.tags ?? [];
}

/** A deleted page's entity, and those of every page beneath it: gone, tags and all. */
export function forgetPages(projectId: string, paths: string[]): void {
  for (const p of paths) {
    const e = bySource(pageSource(projectId, p));
    if (e) deleteEntity(e.id);
  }
}

/** Every tag in use, with how many things carry it, the most used first. */
export function allTags(): { tag: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const { object: o } of allRecords()) {
    if (o.archived || o.stub) continue;
    for (const t of o.tags ?? []) counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  return [...counts].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

export interface Tagged extends Summary {
  tags: string[];
  /** For a page: where it is, so it opens there. `project` is `notes` for an undated note. */
  page?: { project: string; path: string };
  /** For a file (Files): its project, its place there, and where it is on disk. */
  file?: { project: string; path?: string; abs?: string };
}

/** Everything carrying a tag (any of several, or all of them), pages with where they are; pages gone are left out. */
export function tagged(tags: string[], options: { all?: boolean; kind?: string } = {}): Tagged[] {
  const want = cleanTags(tags);
  if (!want.length) return [];
  const out: Tagged[] = [];
  for (const { object: o } of allRecords()) {
    if (o.archived || o.stub) continue;
    const has = o.tags ?? [];
    const hit = options.all ? want.every((t) => has.includes(t)) : want.some((t) => has.includes(t));
    if (!hit) continue;
    const page = pageOf(o);
    if (page && !pageExists(page)) continue;
    const file = page ? null : fileOf(o);
    if (file && !(file.abs && existsSync(file.abs))) continue;
    if (options.kind === "page" && !page) continue;
    if (options.kind === "file" && !file) continue;
    if (options.kind && options.kind !== "page" && options.kind !== "file" && !summary(o).kinds.includes(options.kind)) continue;
    out.push({ ...summary(o), title: page ? page.path.split("/").pop()! : titleOf(o), tags: has, ...(page ? { page } : {}), ...(file ? { file } : {}) });
  }
  return out.sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: "base" }));
}

/** Whether a page is still where its entity says. */
export function pageExists(p: { project: string; path: string }): boolean {
  try {
    const rel = pageLocation(p.project, p.path);
    const base = findProject(p.project).folder;
    return existsSync(join(base, rel)) || existsSync(join(base, rel.replace(/\.md$/, "")));
  } catch {
    return false;
  }
}

/** An entity's tags, by id — for what holds tags on its entity already. */
export const tagsOf = (id: string) => getEntity(id).tags ?? [];
