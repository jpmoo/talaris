// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore

import { readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { CanvasNode, PageNode } from "@talaris/model";
import { canvasIsEmpty, canvasTree, projectCanvases } from "./canvases.js";
import { currentId, homeId, threadById, threads } from "./threads.js";
import { allRecords, bySource, connections, getEntity, profilesOf, titleOf, type Entity } from "./entities.js";
import { placeOf, placeSource, type PlaceKind } from "./mentionables.js";
import { mentionsIn } from "./mentions.js";
import { filedUnder, projectEntity } from "./filing.js";
import { pageModified, pageTree, readPage } from "./pages.js";
import { MACHINERY, WRITING } from "./paths.js";
import { archivedProjects, findProject } from "./projects.js";
import { taskProjects } from "./tasks.js";
import { listFiles, type FileRow } from "./files.js";
import { leavesOut, leftOut, shownSettings, tooOld, type Shown } from "./shown.js";

/**
 * Glance (ui/glance.html): a thing and what it is tied to, as things (nodes)
 * and ties (edges) — walked out from a start, a step at a time, as a list
 * grouped by kind or a graph with the start at its middle.
 *
 * **From a project** (the glance as it opens): its own things — its writing
 * pages and canvases, what is filed under it, every file in its folder — and
 * then `steps` more out from those. **From anything else** (a thing chosen
 * in the graph, to walk on from it): what it is tied to, `steps` out. A page
 * is tied to its project, what it mentions and the files it links; a canvas
 * to what is on it and the canvases in and round it; a file to its project
 * and what links it; a person, an event, a task to what their fields and
 * links name, both ways. Each step is held to a few hundred new things.
 *
 * Files are tied to the things they are on, both ways: a file in a folder,
 * and a file on a thing that is in no project's folder (linked from
 * elsewhere, or kept as a copy), known by its row in Files.
 *
 * Keys: `project:<id>`, `page:<project>/<path>`, `canvas:<project>/<id>`,
 * `file:<project>/<path in its folder>`, `att:<Files row key>`, `e:<entity id>`.
 */
export interface GlanceNode {
  key: string;
  /** The entity, where it is one (a page or canvas once linked, a task, a person…). */
  id?: string;
  title: string;
  /** "project", "page", "canvas", "file", or an entity's profile: "task", "contact", "event", "note"… */
  kind: string;
  updated: string;
  /** Whether it belongs to the project this glance is of (its pages, canvases, files, what is filed under it). */
  own: boolean;
  /** How far from the start it was found: 0 is the start. */
  depth: number;
  /** How it came in, in words: "in the project", "mentioned in Budget". */
  how: string;
  place?: { kind: PlaceKind; project: string; where: string };
  /** A file's path in its project's folder, and that project. */
  path?: string;
  fileProject?: string;
  /** A project's own id, for a project: to go to. */
  projectId?: string;
  /** A file on things in no folder: where it is on disk, or the copy kept (its hash). */
  abs?: string;
  sha256?: string;
  /** At the glance's edge: the ties it has on past it, not shown, counted by the kind at their far end. */
  beyond?: Record<string, number>;
}

export interface GlanceEdge {
  from: string;
  to: string;
  /** The tie, from `from`'s side: "in the project", "mentions", "attendees", "on it", "links". */
  how: string;
}

export interface Glance {
  project: { id: string; name: string; code: string };
  /** The key at the middle: the project's, or the thing walked to. */
  root: string;
  nodes: GlanceNode[];
  edges: GlanceEdge[];
  /** How many met on the walk were left out, as Settings says (shown.ts). */
  hidden?: number;
}

/** Files looked at in a project's folder, at most: a glance, not an index. */
const MOST_FILES = 400;
/** New things a step may bring, at most. */
const MOST_OUT = 400;
export const MOST_STEPS = 3;
/** Ties whose words stand alone, without the name of what they were found from. */
const PLAIN = new Set(["in the project", "in the folder", "filed here"]);
const FILE_LINK = () => /\]\(talaris-file:([^)\s]+)\)/g;
const decode = (href: string) => {
  try {
    return decodeURI(href).replace(/%28/g, "(").replace(/%29/g, ")");
  } catch {
    return href;
  }
};
const words = (name: string) => name.replace(/_/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
/** `kind:<project>/<rest>` split: the project, and what follows its first slash. */
const split = (key: string): [string, string] => {
  const body = key.slice(key.indexOf(":") + 1);
  const at = body.indexOf("/");
  return [body.slice(0, at), body.slice(at + 1)];
};

/** A tie found from one thing: the other end, and the words for it from this side. */
interface Tie {
  key: string;
  how: string;
  /** True when the tie runs into this thing (it is what the other names). */
  back?: boolean;
}

class Walk {
  nodes = new Map<string, GlanceNode>();
  edges: GlanceEdge[] = [];
  private seen = new Set<string>();
  private texts = new Map<string, string>();
  private projectEntities = new Map<string, string>();
  /** Archived projects: out of every glance, and so is everything of theirs. */
  private archived = new Set(archivedProjects().map((p) => p.id));

  private rowsCache: FileRow[] | null = null;
  private get rows(): FileRow[] { return (this.rowsCache ??= listFiles().rows.filter((r) => !r.status.includes("page"))); }
  /** A Files row as a glance key: a folder's file by its place, a shortcut by its entity, anything else by its row. */
  private fileKey(r: FileRow): string {
    if (r.status.includes("folder") && r.path) return `file:${r.project}/${r.path}`;
    if (r.status.includes("shortcut") && r.entity) return `e:${r.entity}`;
    return `att:${r.key}`;
  }
  /** The things a file is on, each as its key. */
  private onIt(r: FileRow | undefined, out: Tie[]): void {
    for (const o of r?.on ?? []) {
      try {
        out.push({ key: this.keyOf(getEntity(o.id)), how: "file on it", back: true });
      } catch {
        // On something since deleted.
      }
    }
  }

  /** Left out as Settings says (shown.ts): complete, archived, too old — never the middle. Null: nothing is. */
  private shown: Shown | null;
  hidden = new Set<string>();

  constructor(readonly here: string, shown: Shown | null = null) {
    this.shown = shown && leavesOut(shown) ? shown : null;
    for (const p of taskProjects()) if (p.workspace) this.projectEntities.set(p.id, p.workspace);
  }

  link(from: string, to: string, how: string): void {
    const k = `${from}>${to}>${how}`;
    if (from !== to && !this.seen.has(k)) {
      this.seen.add(k);
      this.edges.push({ from, to, how });
    }
  }

  // ------------------------------------------------------------ what a key is

  /** The key an entity is known by in a glance: its place, its project, or itself. */
  keyOf(o: Entity): string {
    const place = placeOf(o);
    if (place) return `${place.kind}:${place.project}/${place.where}`;
    const workspace = this.projectEntities.get(o.id);
    return workspace ? `project:${workspace}` : `e:${o.id}`;
  }

  /** The node for a key, made the first time it is met. */
  node(key: string, depth: number, how: string): GlanceNode | null {
    const had = this.nodes.get(key);
    if (had) return had;
    if (this.hidden.has(key)) return null;
    let n: GlanceNode | null = null;
    // A project's own things — itself, its pages, canvases and files — are gone from view while it is archived.
    if (!key.startsWith("e:") && this.archived.has(key.startsWith("project:") ? key.slice(8) : split(key)[0])) return null;
    try {
      if (key.startsWith("project:")) {
        const id = key.slice(8);
        const p = findProject(id);
        n = { key, id: projectEntity(id)?.id, title: p.name, kind: "project", updated: "", own: id === this.here, depth, how, projectId: id };
      } else if (key.startsWith("page:")) {
        const [project, path] = split(key);
        n = { key, id: bySource(placeSource("page", project, path))?.id, title: path.split("/").pop() || path, kind: "page", updated: pageModified(project, path),
          own: project === this.here, depth, how, place: { kind: "page", project, where: path } };
      } else if (key.startsWith("canvas:")) {
        const [project, cid] = split(key);
        const docs = projectCanvases(project);
        const doc = docs.find((d) => d.id === cid);
        // An empty canvas is not a thing to show, unless it is the one the glance is of.
        if (!doc || (depth > 0 && canvasIsEmpty(doc, docs))) return null;
        n = { key, id: bySource(placeSource("canvas", project, cid))?.id, title: doc.title, kind: "canvas", updated: "",
          own: project === this.here, depth, how, place: { kind: "canvas", project, where: cid } };
      } else if (key.startsWith("thread:")) {
        const [home, tid] = split(key);
        const t = threadById(tid);
        if (!t) return null;
        n = { key, id: bySource(placeSource("thread", home, t.id))?.id, title: t.title, kind: "conversation", updated: new Date(t.t1).toISOString(),
          own: home === this.here, depth, how, place: { kind: "thread", project: home, where: t.id } };
      } else if (key.startsWith("file:")) {
        const [project, rel] = split(key);
        let updated = "";
        try {
          updated = statSync(join(findProject(project).folder, ...rel.split("/"))).mtime.toISOString();
        } catch {
          // A link to a file that has gone: still shown, by its name.
        }
        n = { key, title: rel.split("/").pop() || rel, kind: "file", updated, own: project === this.here, depth, how, path: rel, fileProject: project };
      } else if (key.startsWith("att:")) {
        const r = this.rows.find((x) => x.key === key.slice(4));
        if (!r) return null;
        n = { key, title: r.name, kind: "file", updated: r.mtime ?? "", own: r.project === this.here, depth, how,
          ...(r.abs ? { abs: r.abs } : {}), ...(r.sha256 ? { sha256: r.sha256 } : {}) };
      } else if (key.startsWith("e:")) {
        const o = getEntity(key.slice(2));
        if (o.stub || o.archived) return null;
        const kinds = profilesOf(o);
        const filedHere = this.filedUnder(o, this.here);
        n = { key, id: o.id, title: titleOf(o), kind: ["task", "event", "contact", "note"].find((k) => kinds.includes(k)) ?? kinds[0] ?? "note",
          updated: o.updated, own: filedHere, depth, how };
      }
    } catch {
      return null;
    }
    if (n && depth > 0 && this.shown && this.leaves(key, n)) { this.hidden.add(key); return null; }
    if (n) this.nodes.set(key, n);
    return n;
  }

  /** Left out: an entity as it is (complete, archived, too old); anything else by when it last changed. */
  private leaves(key: string, n: GlanceNode): boolean {
    if (key.startsWith("e:")) { try { return leftOut(getEntity(key.slice(2)), this.shown!); } catch { return false; } }
    return tooOld(n.updated, this.shown!);
  }

  private filedUnder(o: Entity, project: string): boolean {
    const e = [...this.projectEntities].find(([, ws]) => ws === project)?.[0];
    return Boolean(e && filedUnder(o).includes(e));
  }

  // ------------------------------------------------------------ what a thing is tied to

  private text(kind: "page" | "canvas", project: string, where: string): string {
    const k = `${kind}:${project}/${where}`;
    if (!this.texts.has(k)) {
      let t = "";
      try {
        t = kind === "page" ? readPage(project, where)
          : ((projectCanvases(project).find((d) => d.id === where)?.items ?? []) as { text?: string }[]).map((i) => i.text ?? "").join("\n");
      } catch {
        // Sealed and locked, or gone: nothing to read.
      }
      this.texts.set(k, t);
    }
    return this.texts.get(k)!;
  }

  /** What words tie to: the things they mention, the files they link. */
  private fromWords(text: string, project: string, out: Tie[]): void {
    for (const m of mentionsIn(text)) {
      try {
        out.push({ key: this.keyOf(getEntity(m.id)), how: "mentions" });
      } catch {
        // A mention of something since deleted.
      }
    }
    for (const m of text.matchAll(FILE_LINK())) out.push({ key: `file:${project}/${decode(m[1]!)}`, how: "links" });
  }

  /** What an entity's own fields and links name, and what names it. */
  private ofEntity(id: string, out: Tie[]): void {
    let c;
    try {
      c = connections(id);
    } catch {
      return;
    }
    for (const x of c.out) if (!x.entity.stub) out.push({ key: this.keyOf(getEntity(x.entity.id)), how: words(x.name) });
    for (const x of c.in) if (!x.entity.stub) out.push({ key: this.keyOf(getEntity(x.entity.id)), how: words(x.name), back: true });
  }

  ties(key: string): Tie[] {
    const out: Tie[] = [];
    if (key.startsWith("project:")) {
      const id = key.slice(8);
      const pages = (list: PageNode[]) => { for (const n of list) { out.push({ key: `page:${id}/${n.path}`, how: "in the project" }); pages(n.children); } };
      try {
        pages(pageTree(id));
      } catch {
        // A project that cannot be read has no pages to list.
      }
      try {
        out.push({ key: `canvas:${id}/${canvasTree(id).id}`, how: "in the project" });
      } catch {
        // A project that has lost its top canvas still has the rest.
      }
      const entity = [...this.projectEntities].find(([, ws]) => ws === id)?.[0];
      if (entity) {
        for (const r of allRecords()) {
          const o = r.object;
          if (o.id !== entity && !o.stub && !o.archived && filedUnder(o).includes(entity)) out.push({ key: this.keyOf(o), how: "filed here" });
        }
      }
      for (const rel of this.folder(id)) out.push({ key: `file:${id}/${rel}`, how: "in the folder" });
      // Home: Morgan's threads live there.
      if (id === homeId()) for (const t of threads()) out.push({ key: `thread:${id}/${t.id}`, how: "in the project" });
    } else if (key.startsWith("page:")) {
      const [project, path] = split(key);
      out.push({ key: `project:${project}`, how: "in the project", back: true });
      this.fromWords(this.text("page", project, path), project, out);
      const e = bySource(placeSource("page", project, path));
      if (e) this.ofEntity(e.id, out);
    } else if (key.startsWith("canvas:")) {
      const [project, cid] = split(key);
      const docs = projectCanvases(project);
      const doc = docs.find((d) => d.id === cid);
      if (doc?.parent) out.push({ key: `canvas:${project}/${doc.parent}`, how: "inside", back: true });
      else out.push({ key: `project:${project}`, how: "in the project", back: true });
      for (const d of docs) if (d.parent === cid) out.push({ key: `canvas:${project}/${d.id}`, how: "inside" });
      for (const item of (doc?.items ?? []) as { entity?: string; kind?: string }[]) {
        if (!item.entity || item.kind === "canvas") continue;
        try {
          out.push({ key: this.keyOf(getEntity(item.entity)), how: "on it" });
        } catch {
          // A card of something since deleted.
        }
      }
      this.fromWords(this.text("canvas", project, cid), project, out);
      const e = bySource(placeSource("canvas", project, cid));
      if (e) this.ofEntity(e.id, out);
    } else if (key.startsWith("thread:")) {
      const [home, tid] = split(key);
      out.push({ key: `project:${home}`, how: "in the project", back: true });
      const e = bySource(placeSource("thread", home, currentId(tid)));
      if (e) this.ofEntity(e.id, out);
    } else if (key.startsWith("file:")) {
      const [project, rel] = split(key);
      out.push({ key: `project:${project}`, how: "in the folder", back: true });
      // What links it: the project's pages and canvases whose words name it.
      const named = (t: string) => [...t.matchAll(FILE_LINK())].some((m) => decode(m[1]!) === rel);
      const pages = (list: PageNode[]) => {
        for (const n of list) {
          if (named(this.text("page", project, n.path))) out.push({ key: `page:${project}/${n.path}`, how: "links", back: true });
          pages(n.children);
        }
      };
      try {
        pages(pageTree(project));
        for (const d of projectCanvases(project)) if (named(this.text("canvas", project, d.id))) out.push({ key: `canvas:${project}/${d.id}`, how: "links", back: true });
      } catch {
        // A project that cannot be read: only its folder, then.
      }
      this.onIt(this.rows.find((r) => r.key === `p:${project}/${rel}`), out);
    } else if (key.startsWith("att:")) {
      this.onIt(this.rows.find((r) => r.key === key.slice(4)), out);
    } else if (key.startsWith("e:")) {
      this.ofEntity(key.slice(2), out);
      const id = key.slice(2);
      for (const r of this.rows) if (r.on.some((o) => o.id === id)) out.push({ key: this.fileKey(r), how: "file on it" });
    }
    return out;
  }

  /** Every file in a project's folder, but its machinery and its pages (which are pages). */
  private folder(projectId: string): string[] {
    const root = findProject(projectId).folder;
    const out: string[] = [];
    const walk = (dir: string) => {
      let names: string[] = [];
      try {
        names = readdirSync(dir);
      } catch {
        return;
      }
      for (const name of names.sort()) {
        if (out.length >= MOST_FILES || name.startsWith(".") || name.endsWith(".tmp")) continue;
        const full = join(dir, name);
        const rel = relative(root, full).split(sep).join("/");
        if (rel === MACHINERY || (rel.startsWith(`${WRITING}/`) && name.endsWith(".md"))) continue;
        try {
          if (statSync(full).isDirectory()) walk(full);
          else out.push(rel);
        } catch {
          // Gone between listing and looking.
        }
      }
    };
    walk(root);
    return out;
  }

  /** Out from `start`, `depth` steps, each held to MOST_OUT new things. */
  run(start: string, depth: number): void {
    if (!this.node(start, 0, "the middle")) throw new Error(`nothing is known by ${start}`);
    let frontier = [start];
    for (let d = 1; d <= depth && frontier.length; d++) {
      const next: string[] = [];
      for (const key of frontier) {
        const from = this.nodes.get(key)!;
        for (const t of this.ties(key)) {
          if (next.length >= MOST_OUT && !this.nodes.has(t.key)) continue;
          const isNew = !this.nodes.has(t.key);
          const n = this.node(t.key, d, PLAIN.has(t.how) ? t.how : `${t.how} · ${from.title}`);
          if (!n) continue;
          if (t.back) this.link(t.key, key, t.how);
          else this.link(key, t.key, t.how);
          if (isNew) next.push(t.key);
        }
      }
      frontier = next;
    }
    // The edge: what each thing found last leads on to, counted, so the graph can hint at it.
    for (const key of frontier) {
      const beyond: Record<string, number> = {};
      const counted = new Set<string>();
      for (const t of this.ties(key)) {
        if (this.nodes.has(t.key) || counted.has(t.key)) continue;
        counted.add(t.key);
        const kind = this.kindOf(t.key);
        if (kind) beyond[kind] = (beyond[kind] ?? 0) + 1;
      }
      if (counted.size) this.nodes.get(key)!.beyond = beyond;
    }
  }

  /** What a key is, cheaply, without making its node: for counting past the edge. */
  private kindOf(key: string): string {
    const kind = key.slice(0, key.indexOf(":"));
    if (kind === "att") return "file";
    if (kind !== "e") return kind;
    try {
      const o = getEntity(key.slice(2));
      if (o.stub || o.archived) return "";
      const kinds = profilesOf(o);
      return ["task", "event", "contact", "note"].find((k) => kinds.includes(k)) ?? kinds[0] ?? "note";
    } catch {
      return "";
    }
  }
}

const nearCache = new Map<string, { at: number; ids: Set<string> }>();
/**
 * The entities tied to a project: what is filed under it, on its canvases,
 * mentioned in its pages — and what those are tied to, a step on. What a
 * search in the project puts first (a canvas's Task tool, an @). Kept a few
 * seconds, since a search asks it at every pause in typing.
 */
export function nearProject(projectId: string): Set<string> {
  const had = nearCache.get(projectId);
  if (had && Date.now() - had.at < 15_000) return had.ids;
  const walk = new Walk(projectId);
  const ids = new Set<string>();
  try {
    walk.run(`project:${projectId}`, 2);
    for (const n of walk.nodes.values()) if (n.id && n.kind !== "project") ids.add(n.id);
  } catch {
    // A project that cannot be read: nothing is nearer than anything else.
  }
  nearCache.set(projectId, { at: Date.now(), ids });
  return ids;
}

/**
 * A glance: from a project (`from` empty), its own things and `steps` out from
 * them; from any thing's key, `steps` out from it.
 */
export function glance(projectId: string, steps = 1, from = ""): Glance {
  steps = Math.max(1, Math.min(MOST_STEPS, Math.floor(steps) || 1));
  const p = findProject(projectId);
  const walk = new Walk(projectId, shownSettings());
  const start = from || `project:${projectId}`;
  // From a project, its own things are a step of their own before `steps` more.
  walk.run(start, start.startsWith("project:") ? steps + 1 : steps);
  return { project: { id: projectId, name: p.name, code: p.code }, root: start, nodes: [...walk.nodes.values()], edges: walk.edges,
    ...(walk.hidden.size ? { hidden: walk.hidden.size } : {}) };
}
