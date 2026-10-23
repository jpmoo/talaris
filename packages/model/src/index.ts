// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore

/**
 * The shapes Talaris keeps, shared by the core that stores them and the pages
 * that draw them.
 *
 * This package exists so there is one definition of a canvas: the likeliest bug
 * in a project like this is the page and the store drifting apart on what a
 * document looks like, and two copies of these types is how that starts.
 *
 * **Every stored shape is open.** Each carries an index signature because what
 * a reader does not understand it must not destroy — a key written by a newer
 * Talaris, or by a plugin, survives a round trip through an older one.
 */

/** Bumped only by a change an older reader could not survive. */
export const FORMAT_VERSION = 1;

export interface Project {
  format: number;
  id: string;
  /** The short human code the theme shows, `PRJ-03`. Never reused. */
  code: string;
  name: string;
  /** ISO time. */
  created: string;
  /** The project's top canvas; every other canvas descends from it. */
  topCanvas: string;
  /** Home is the project that is always there. */
  home?: boolean;
  [key: string]: unknown;
}

/** A project as listed: the stored project plus where it lives. */
export interface ProjectSummary {
  id: string;
  code: string;
  name: string;
  folder: string;
  home: boolean;
}

/**
 * What a placed thing is.
 *
 * - `note` — drawn on this canvas and belonging to it.
 * - `canvas` — a child canvas, sitting on its one parent.
 * - `canvas-link` — a link to a canvas anywhere, this project or another.
 * - `card` — an application on a target, a website, a file.
 * - `plugin` — a plugin's thing; `plugin` names it, `seen` keeps its last-known
 *   picture so it can be drawn honestly when the plugin is missing.
 *
 * Absent means `note`, which keeps Talaria-era canvases readable unchanged.
 */
export type ItemKind = "note" | "canvas" | "canvas-link" | "card" | "plugin";

export interface CanvasItem {
  id: string;
  kind?: ItemKind;
  x: number;
  y: number;
  w: number;
  h: number;
  text?: string;
  /** For `canvas`: the child's id. For `canvas-link`: the target canvas. */
  canvas?: string;
  /** For `canvas-link` across projects: the target's project. */
  project?: string;
  /** For `plugin`: which plugin, and its own reference to the thing. */
  plugin?: string;
  ref?: string;
  /** Last-known picture, so a missing target or plugin is a placeholder, not a hole. */
  seen?: { title?: string; icon?: string; fields?: Record<string, string> };
  [key: string]: unknown;
}

export interface CanvasLink {
  id: string;
  from: string;
  to: string;
  [key: string]: unknown;
}

export interface CanvasRegion {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  title?: string;
  [key: string]: unknown;
}

export interface CanvasDocument {
  format: number;
  id: string;
  project: string;
  /** Exactly one parent; null only for a project's top canvas. */
  parent: string | null;
  title: string;
  items: CanvasItem[];
  links: CanvasLink[];
  regions: CanvasRegion[];
  [key: string]: unknown;
}

/** A canvas as listed in a project's tree. */
export interface CanvasNode {
  id: string;
  title: string;
  parent: string | null;
  children: CanvasNode[];
}

/** A place that links to a canvas: a `canvas-link` item on some canvas. */
export interface Backlink {
  project: string;
  canvas: string;
  title: string;
  item: string;
}

/**
 * A writing page. `path` is relative to the project's `Writing/` folder,
 * without `.md`, using `/` — `Camp rules/Hourly rolls`. A page's children live
 * in a folder of its name beside it, so the path *is* the tree.
 */
export interface PageNode {
  path: string;
  title: string;
  children: PageNode[];
}

export interface VersionEntry {
  /** ISO time the version was saved. */
  at: string;
  /** Opaque name to ask for it back by. */
  name: string;
}

/** What the core answers to `GET /health`. */
export interface Health {
  ok: true;
  name: "talaris-core";
  version: string;
  projectsRoot: string;
}
