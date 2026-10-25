// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore

import { readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { CanvasNode, PageNode } from "@talaris/model";
import { canvasTree, projectCanvases } from "./canvases.js";
import { allRecords, bySource, connections, getEntity, profilesOf, titleOf, type Entity } from "./entities.js";
import { placeOf, placeSource } from "./mentionables.js";
import { mentionsIn } from "./mentions.js";
import { pageModified, pageTree, readPage } from "./pages.js";
import { MACHINERY, WRITING } from "./paths.js";
import { findProject } from "./projects.js";
import { taskProjects } from "./tasks.js";

/**
 * A project at a glance: everything that belongs to it and what that touches,
 * as things (nodes) and how they are tied (edges) — a list grouped by kind,
 * or a graph with the project at its middle (ui/glance.html).
 *
 * **Its own**: its writing pages and canvases, what is filed under it (a
 * task's project, a note's), and every file in its folder. **One step out**:
 * what those mention, carry on a canvas, or are linked with — the people at a
 * meeting a page mentions, say. One step only: two reaches everyone, since
 * everyone links on to every meeting they were in.
 */
export interface GlanceNode {
  key: string;
  /** The entity, where it is one (a page or canvas once linked, a task, a person…). */
  id?: string;
  title: string;
  /** "project", "page", "canvas", "file", or an entity's profile: "task", "contact", "event", "note"… */
  kind: string;
  updated: string;
  /** Whether it is the project's own (true), or one step out from something that is. */
  own: boolean;
  /** How it comes into the glance, in words: "in the project", "filed here", "mentioned in Budget". */
  how: string;
  place?: { kind: "page" | "canvas"; project: string; where: string };
  /** A file's path in the project's folder. */
  path?: string;
}

export interface GlanceEdge {
  from: string;
  to: string;
  /** The link, from `from`'s side: "in the project", "mentions", "attendees", "on it", "linked". */
  how: string;
}

export interface Glance {
  project: { id: string; name: string; code: string };
  nodes: GlanceNode[];
  edges: GlanceEdge[];
}

/** Files looked at in a project's folder, at most: a glance, not an index. */
const MOST_FILES = 400;
/** Things one step out, at most. */
const MOST_OUT = 400;
const FILE_LINK = () => /\]\(talaris-file:([^)\s]+)\)/g;

const fileKey = (rel: string) => `file:${rel}`;
const decode = (href: string) => {
  try {
    return decodeURI(href).replace(/%28/g, "(").replace(/%29/g, ")");
  } catch {
    return href;
  }
};

export function glance(projectId: string): Glance {
  const p = findProject(projectId);
  // Its entity, made if it has none yet (Tasks would make it on asking).
  taskProjects();
  const projectEntity = bySource({ kind: "talaris-project", key: projectId });
  const nodes = new Map<string, GlanceNode>();
  const edges: GlanceEdge[] = [];
  const seenEdge = new Set<string>();
  const link = (from: string, to: string, how: string) => {
    const k = `${from}>${to}>${how}`;
    if (from !== to && !seenEdge.has(k)) {
      seenEdge.add(k);
      edges.push({ from, to, how });
    }
  };
  const put = (n: GlanceNode) => {
    const had = nodes.get(n.key);
    // A thing that is the project's own stays so, however else it is reached.
    if (!had || (n.own && !had.own)) nodes.set(n.key, had ? { ...had, ...n, how: n.own ? n.how : had.how } : n);
    return n.key;
  };
  nodes.set("project", { key: "project", id: projectEntity?.id, title: p.name, kind: "project", updated: "", own: true, how: "this project" });

  // What an entity is, in the glance: a page or a canvas where it stands for one, else by its profile.
  const entityNode = (o: Entity, own: boolean, how: string): string => {
    const place = placeOf(o);
    if (place?.kind === "page") return put({ key: `page:${place.project}/${place.where}`, id: o.id, title: titleOf(o), kind: "page", updated: o.updated, own: own && place.project === projectId, how, place });
    if (place?.kind === "canvas") return put({ key: `canvas:${place.project}/${place.where}`, id: o.id, title: titleOf(o), kind: "canvas", updated: o.updated, own: own && place.project === projectId, how, place });
    const kinds = profilesOf(o);
    const kind = ["task", "event", "contact", "note"].find((k) => kinds.includes(k))
      ?? ((o["talaris:sources"] as { kind: string }[] | undefined)?.some((s) => s.kind === "talaris-project") ? "project" : kinds[0] ?? "note");
    return put({ key: `e:${o.id}`, id: o.id, title: titleOf(o), kind, updated: o.updated, own, how });
  };
  const files = (rel: string, own: boolean, how: string): string => {
    let updated = "";
    try {
      updated = statSync(join(p.folder, ...rel.split("/"))).mtime.toISOString();
    } catch {
      // A link to a file that has gone: still shown, by its name.
    }
    return put({ key: fileKey(rel), title: rel.split("/").pop() || rel, kind: "file", updated, own, how, path: rel });
  };
  // Words that link files and mention things: a page's, a canvas note's.
  const fromWords = (from: string, text: string, fromTitle: string, mentioned: Set<string>) => {
    for (const m of text.matchAll(FILE_LINK())) link(from, files(decode(m[1]!), false, `linked from ${fromTitle}`), "links");
    for (const m of mentionsIn(text)) mentioned.add(`${from}\u0000${m.id}`);
  };
  const mentioned = new Set<string>();

  // Its pages.
  const pages = (list: PageNode[]) => {
    for (const n of list) {
      const e = bySource(placeSource("page", projectId, n.path));
      const key = put({ key: `page:${projectId}/${n.path}`, id: e?.id, title: n.title, kind: "page", updated: pageModified(projectId, n.path), own: true,
        how: "in the project", place: { kind: "page", project: projectId, where: n.path } });
      link("project", key, "in the project");
      try {
        fromWords(key, readPage(projectId, n.path), n.title, mentioned);
      } catch {
        // A page that cannot be read (sealed, locked) is still listed.
      }
      pages(n.children);
    }
  };
  pages(pageTree(projectId));

  // Its canvases, and what is on them.
  const docs = new Map(projectCanvases(projectId).map((d) => [d.id, d]));
  const canvases = (n: CanvasNode, parent: string | null) => {
    const e = bySource(placeSource("canvas", projectId, n.id));
    const key = put({ key: `canvas:${projectId}/${n.id}`, id: e?.id, title: n.title, kind: "canvas", updated: "", own: true,
      how: parent ? "inside another canvas" : "in the project", place: { kind: "canvas", project: projectId, where: n.id } });
    link(parent ?? "project", key, parent ? "inside" : "in the project");
    for (const item of (docs.get(n.id)?.items ?? []) as { entity?: string; text?: string; kind?: string }[]) {
      if (item.entity && item.kind !== "canvas") mentioned.add(`${key}\u0000${item.entity}`);
      if (typeof item.text === "string") fromWords(key, item.text, n.title, mentioned);
    }
    for (const child of n.children) canvases(child, key);
  };
  try {
    canvases(canvasTree(projectId), null);
  } catch {
    // A project that has lost its top canvas still has the rest.
  }

  // What is filed under it: any entity whose fields name the project's entity.
  if (projectEntity) {
    for (const r of allRecords()) {
      const o = r.object;
      if (o.id === projectEntity.id || o.stub || o.archived) continue;
      if (JSON.stringify(o.properties).includes(projectEntity.id)) link("project", entityNode(o, true, "filed here"), "filed here");
    }
  }

  // Every file in its folder (not its own machinery, nor the pages, which are listed as pages).
  let counted = 0;
  const walk = (dir: string) => {
    let names: string[] = [];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names.sort()) {
      if (counted >= MOST_FILES || name.startsWith(".") || name.endsWith(".tmp")) continue;
      const full = join(dir, name);
      const rel = relative(p.folder, full).split(sep).join("/");
      if (rel === MACHINERY || (rel.startsWith(`${WRITING}/`) && name.endsWith(".md"))) continue;
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(full);
      else {
        counted++;
        link("project", files(rel, true, "in the folder"), "in the folder");
      }
    }
  };
  walk(p.folder);

  // One step out: what the project's own things mention or carry, and what they are linked with.
  let out = 0;
  for (const pair of mentioned) {
    const [from, id] = pair.split("\u0000") as [string, string];
    try {
      const o = getEntity(id);
      if (o.stub) continue;
      link(from, entityNode(o, false, `in ${nodes.get(from)?.title ?? "the project"}`), "mentions");
      out++;
    } catch {
      // A mention of something since deleted.
    }
  }
  const words = (name: string) => name.replace(/_/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
  for (const n of [...nodes.values()]) {
    if (!n.own || !n.id || n.kind === "project" || out >= MOST_OUT) continue;
    let c;
    try {
      c = connections(n.id);
    } catch {
      continue;
    }
    for (const x of c.out) {
      if (out >= MOST_OUT || x.entity.stub) break;
      link(n.key, entityNode(getEntity(x.entity.id), false, `${words(x.name)} of ${n.title}`), words(x.name));
      out++;
    }
    for (const x of c.in) {
      if (out >= MOST_OUT || x.entity.stub) break;
      const o = getEntity(x.entity.id);
      link(entityNode(o, false, `links to ${n.title}`), n.key, words(x.name));
      out++;
    }
  }
  return { project: { id: projectId, name: p.name, code: p.code }, nodes: [...nodes.values()], edges };
}
