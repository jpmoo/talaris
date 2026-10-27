// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore

import { canvasTree } from "./canvases.js";
import { homeId, threads } from "./threads.js";
import { bySource, createEntity, findEntities, getEntity, typeFor, updateEntity, type Entity } from "./entities.js";
import { pageTree } from "./pages.js";
import { listProjects } from "./projects.js";
import type { CanvasNode, PageNode } from "@talaris/model";

/**
 * What an @ can link: the store's entities, and every project's writing pages
 * and canvases, which live as files and are entities only once something
 * points at them. The current project's come first — its pages and canvases,
 * and the entities filed under it — then everything else, each by how well
 * its title matches.
 */
export interface Mentionable {
  /** The entity, where there is one already; a page or canvas without one is made one when chosen (`placeEntity`). */
  id: string;
  title: string;
  /** "page", "canvas", or the entity's first profile ("contact", "task", "event", "note"…). */
  kind: string;
  project?: string;
  projectName?: string;
  /** A page's path, or a canvas's id. */
  where?: string;
  here: boolean;
}

/** A page, a canvas, or one of Morgan's threads (threads.ts, in Home): what an entity can stand for, by where it is. */
export type PlaceKind = "page" | "canvas" | "thread";
/** Where a page or a canvas is, as an entity standing for it is known. */
export const placeSource = (kind: PlaceKind, project: string, where: string) => ({ kind, key: `${project}/${where}` });

/**
 * The entity standing for a page or a canvas, made if there is none yet: a
 * note whose words stay where they are (`talaris:textElsewhere`), titled as
 * the place is. Pages with mentions already have one (mentions.ts, syncText).
 */
export function placeEntity(kind: PlaceKind, project: string, where: string, title: string): Entity {
  const source = placeSource(kind, project, where);
  const known = bySource(source);
  if (known) return known.properties.title === title || !title ? known : updateEntity(known.id, { properties: { title: title.slice(0, 120) } });
  return createEntity({ type: typeFor("note").id, properties: { title: title.slice(0, 120) }, sources: [source], "talaris:textElsewhere": true });
}

/** Where a page or canvas entity points, if it stands for one. */
export function placeOf(o: Entity): { kind: PlaceKind; project: string; where: string } | null {
  for (const s of (o["talaris:sources"] as { kind: string; key: string }[] | undefined) ?? []) {
    if (s.kind !== "page" && s.kind !== "canvas" && s.kind !== "thread") continue;
    const at = s.key.indexOf("/");
    if (at > 0) return { kind: s.kind, project: s.key.slice(0, at), where: s.key.slice(at + 1) };
  }
  return null;
}

function score(title: string, words: string[]): number {
  const t = title.toLowerCase();
  if (!words.length) return 1;
  if (!words.every((w) => t.includes(w))) return 0;
  const wordStart = (w: string) => new RegExp(`(^|[^\\p{L}\\p{N}])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "u").test(t);
  return t.startsWith(words[0]!) ? 4 : words.every(wordStart) ? 3 : 2;
}

/** `near`: the entities tied to the project (glance.ts, nearProject), put ahead of the rest. */
export function findMentionables(q: string, here: string, limit = 12, near?: Set<string>): Mentionable[] {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const found: { m: Mentionable; s: number }[] = [];
  const projects = listProjects();
  // Anything filed under this project (a task's project, a note's) points at its entity.
  const hereEntity = here ? bySource({ kind: "talaris-project", key: here })?.id : undefined;
  for (const s of findEntities({ q, limit: 60, prefer: "contact", near })) {
    if (s.stub) continue;
    const o = getEntity(s.id);
    // A page's or a canvas's entity is listed as the page or canvas, below.
    if (placeOf(o)) continue;
    const mine = Boolean(hereEntity && JSON.stringify(o.properties).includes(hereEntity)) || Boolean(near?.has(o.id));
    const sc = Math.max(score(s.title, words), 1) * 2 + (s.kinds.includes("contact") ? 1 : 0) + (mine ? 3 : 0);
    found.push({ m: { id: s.id, title: s.title, kind: s.kinds[0] ?? "thing", here: mine }, s: sc });
  }
  for (const p of projects) {
    const mine = p.id === here;
    const add = (kind: "page" | "canvas", where: string, title: string) => {
      const sc = score(title, words);
      if (!sc) return;
      const e = bySource(placeSource(kind, p.id, where));
      found.push({ m: { id: e?.id ?? "", title, kind, project: p.id, projectName: p.name, where, here: mine }, s: sc * 2 + (mine ? 3 : 0) });
    };
    try {
      const walk = (nodes: PageNode[]) => { for (const n of nodes) { add("page", n.path, n.title); walk(n.children); } };
      walk(pageTree(p.id));
      const cwalk = (n: CanvasNode) => { add("canvas", n.id, n.title); n.children.forEach(cwalk); };
      cwalk(canvasTree(p.id));
    } catch {
      // A project that cannot be read (locked, gone) offers nothing.
    }
  }
  // Morgan's threads (threads.ts), once something is typed: a conversation is mentioned by what it was about.
  if (words.length) {
    const home = homeId();
    for (const t of threads()) {
      const sc = score(t.title, words);
      if (!sc) continue;
      const e = bySource(placeSource("thread", home, t.id));
      found.push({ m: { id: e?.id ?? "", title: t.title, kind: "thread", project: home, projectName: "Morgan", where: t.id, here: false }, s: sc * 2 });
    }
  }
  found.sort((a, b) => b.s - a.s || a.m.title.localeCompare(b.m.title));
  return found.slice(0, limit).map((f) => f.m);
}
