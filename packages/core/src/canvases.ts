// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore

import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  FORMAT_VERSION,
  type Backlink,
  type CanvasDocument,
  type CanvasItem,
  type CanvasNode,
} from "@talaris/model";
import { MACHINERY } from "./paths.js";
import { Conflict, NotFound, findProject, listProjects, readProject } from "./projects.js";
import { newId, readJson, writeJson } from "./store.js";
import { listVersions, readVersion, saveVersion, versionDir } from "./versions.js";
import { syncText } from "./mentions.js";

/**
 * A project's canvases are a tree: one top canvas, and below it children, each
 * with exactly one parent — so "where does this live" always has an answer.
 * Anywhere else a canvas is wanted, it is a `canvas-link` item, as many as you
 * like, in any project.
 *
 * Each canvas is its own file, naming its parent inside it, versioned on its
 * own. The tree is read from those files rather than kept separately, so it
 * cannot disagree with them.
 */

function dir(folder: string): string {
  return join(folder, MACHINERY, "canvases");
}

function file(folder: string, id: string): string {
  if (!/^[a-z]+_[a-z0-9]+$/.test(id)) throw new NotFound(`no canvas ${id}`);
  return join(dir(folder), `${id}.json`);
}

function machinery(folder: string): string {
  return join(folder, MACHINERY);
}

export function readCanvas(projectId: string, id: string): CanvasDocument {
  const { folder } = findProject(projectId);
  const path = file(folder, id);
  if (!existsSync(path)) throw new NotFound(`no canvas ${id}`);
  return readJson<CanvasDocument>(path);
}

function allCanvases(folder: string): CanvasDocument[] {
  if (!existsSync(dir(folder))) return [];
  return readdirSync(dir(folder))
    .filter((n) => n.endsWith(".json") && !n.startsWith("."))
    .map((n) => readJson<CanvasDocument>(join(dir(folder), n)));
}

export function canvasTree(projectId: string): CanvasNode {
  const { folder } = findProject(projectId);
  const top = readProject(folder).topCanvas;
  const docs = allCanvases(folder);
  const node = (d: CanvasDocument): CanvasNode => ({
    id: d.id,
    title: d.title,
    parent: d.parent,
    children: docs.filter((c) => c.parent === d.id).sort((a, b) => a.title.localeCompare(b.title)).map(node),
  });
  const root = docs.find((d) => d.id === top);
  if (!root) throw new NotFound(`project ${projectId} has lost its top canvas`);
  return node(root);
}

function persist(folder: string, doc: CanvasDocument): void {
  const content = JSON.stringify(doc, null, 2) + "\n";
  writeJson(file(folder, doc.id), doc);
  saveVersion(versionDir(machinery(folder), "canvas", doc.id), content, "json");
}

/**
 * Save a canvas as the page sent it. **The document is kept whole**: whatever
 * keys it carries — a newer Talaris's, a plugin's — are written back as they
 * came. Only what makes the tree what it is gets checked.
 *
 * A write that drops a child canvas's card is refused unless the caller says it
 * meant it (`detach`): the child would still exist, reachable only from the
 * tree, and that is a decision, not an accident of a stale page.
 */
export function writeCanvas(projectId: string, doc: CanvasDocument, options: { detach?: boolean } = {}): CanvasDocument {
  const { folder } = findProject(projectId);
  const current = readCanvas(projectId, doc.id);
  if (doc.project !== current.project || doc.parent !== current.parent) {
    throw new Conflict("a canvas's project and parent are changed by moving it, not by saving it");
  }
  if (!Array.isArray(doc.items) || !Array.isArray(doc.links) || !Array.isArray(doc.regions)) {
    throw new Conflict("a canvas has items, links and regions");
  }
  if (!options.detach) {
    const kept = new Set(doc.items.filter((i) => i.kind === "canvas").map((i) => i.canvas));
    const children = allCanvases(folder).filter((c) => c.parent === doc.id);
    const dropped = children.filter((c) => !kept.has(c.id));
    if (dropped.length) {
      throw new Conflict(`this would take ${dropped.map((c) => `"${c.title}"`).join(", ")} off the canvas`);
    }
  }
  // A canvas's title is changed by renaming it: a page that held the canvas
  // from before a rename must not put the old one back by saving.
  const kept = { ...doc, title: current.title, format: doc.format ?? FORMAT_VERSION };
  // A note that mentions something is an entity, holding those mentions as
  // its edges (mentions.ts); its card keeps the entity's id.
  for (const item of kept.items) {
    // A card shows an entity (a task, a person); it has no words of its own to hold mentions.
    if ((item as { kind?: string }).kind === "card") continue;
    const text = typeof (item as { text?: unknown }).text === "string" ? (item as { text: string }).text : "";
    if (!text.includes("](talaris:") && !(item as { entity?: string }).entity) continue;
    const id = syncText({ kind: "canvas-note", key: `${projectId}/${doc.id}/${item.id}` }, text.split("\n").find((l) => l.trim())?.trim() ?? "Note", text);
    if (id && !(item as { entity?: string }).entity) (item as { entity?: string }).entity = id;
  }
  persist(folder, kept);
  return kept;
}

/**
 * Rename a canvas — the top one too. Every card showing it, here or in another
 * project, shows the new name: its `seen` title, and its text where that was
 * still the old name (a card whose words someone wrote keeps them).
 */
export function renameCanvas(projectId: string, id: string, title: string): CanvasDocument {
  const name = title.trim();
  if (!name) throw new Conflict("a canvas needs a name");
  const { folder } = findProject(projectId);
  const doc = readCanvas(projectId, id);
  const old = doc.title;
  const renamed = { ...doc, title: name };
  persist(folder, renamed);
  for (const p of listProjects()) {
    for (const other of allCanvases(p.folder)) {
      let changed = false;
      const items = other.items.map((item) => {
        if (!(item.kind === "canvas" || item.kind === "canvas-link") || item.canvas !== id) return item;
        if ((item.project ?? p.id) !== projectId) return item;
        changed = true;
        const next = { ...item, seen: { ...(item.seen ?? {}), title: name } } as CanvasItem & { text?: string };
        if (next.text === old) next.text = name;
        return next;
      });
      if (changed) persist(p.folder, { ...(other.id === id ? renamed : other), items });
    }
  }
  return renamed;
}

export function createChild(
  projectId: string,
  parentId: string,
  title: string,
  at: { x: number; y: number } = { x: 0, y: 0 },
): { canvas: CanvasDocument; parent: CanvasDocument } {
  const { folder } = findProject(projectId);
  const parent = readCanvas(projectId, parentId);
  const child: CanvasDocument = {
    format: FORMAT_VERSION,
    id: newId("cv"),
    project: projectId,
    parent: parentId,
    title: title.trim() || "Untitled",
    items: [],
    links: [],
    regions: [],
  };
  const card: CanvasItem = {
    id: newId("it"),
    kind: "canvas",
    canvas: child.id,
    x: at.x,
    y: at.y,
    w: 200,
    h: 120,
    seen: { title: child.title },
  };
  // The child first: a crash between the two leaves a canvas in the tree with
  // no card yet, which is recoverable, rather than a card pointing at nothing.
  persist(folder, child);
  const updated = { ...parent, items: [...parent.items, card] };
  persist(folder, updated);
  return { canvas: child, parent: updated };
}

/**
 * Delete a canvas. Its own act, never a side effect of removing a card. The
 * top canvas cannot go, and nor can one with children — move or delete them
 * first, so nothing is lost by accident. It stays in its versions.
 */
export function deleteCanvas(projectId: string, id: string): void {
  const { folder } = findProject(projectId);
  const doc = readCanvas(projectId, id);
  if (doc.parent === null) throw new Conflict("a project's top canvas cannot be deleted");
  const children = allCanvases(folder).filter((c) => c.parent === id);
  if (children.length) throw new Conflict(`"${doc.title}" still has ${children.length} canvas(es) below it`);
  saveVersion(versionDir(machinery(folder), "canvas", id), JSON.stringify(doc, null, 2) + "\n", "json");
  const parent = readCanvas(projectId, doc.parent);
  persist(folder, { ...parent, items: parent.items.filter((i) => !(i.kind === "canvas" && i.canvas === id)) });
  rmSync(file(folder, id));
}

/**
 * Every `canvas-link` that points here, from any project. Read by looking,
 * like everything else; at the size a person's projects reach, that is
 * quicker than keeping an index honest.
 */
export function backlinks(projectId: string, id: string): Backlink[] {
  const found: Backlink[] = [];
  for (const p of listProjects()) {
    for (const doc of allCanvases(p.folder)) {
      for (const item of doc.items) {
        if (item.kind !== "canvas-link" || item.canvas !== id) continue;
        if ((item.project ?? p.id) !== projectId) continue;
        found.push({ project: p.id, canvas: doc.id, title: doc.title, item: item.id });
      }
    }
  }
  return found;
}

export function canvasVersions(projectId: string, id: string) {
  const { folder } = findProject(projectId);
  return listVersions(versionDir(machinery(folder), "canvas", id));
}

export function canvasVersion(projectId: string, id: string, name: string): CanvasDocument {
  const { folder } = findProject(projectId);
  return JSON.parse(readVersion(versionDir(machinery(folder), "canvas", id), name)) as CanvasDocument;
}

/** Restoring is a save of the old state — so it is itself a version, and can be undone the same way. */
export function restoreCanvas(projectId: string, id: string, name: string): CanvasDocument {
  const { folder } = findProject(projectId);
  const old = canvasVersion(projectId, id, name);
  const current = readCanvas(projectId, id);
  const restored = { ...old, parent: current.parent, project: current.project };
  persist(folder, restored);
  return restored;
}

/** A project's canvases, whole: what is on them, for a glance. */
export function projectCanvases(projectId: string): CanvasDocument[] {
  return allCanvases(findProject(projectId).folder);
}

