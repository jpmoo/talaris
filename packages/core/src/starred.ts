// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore

import { join } from "node:path";
import { MACHINERY } from "./paths.js";
import { findProject } from "./projects.js";
import { readJson, writeJson } from "./store.js";

/**
 * The order of a project's starred pages and canvases, gathered at the top of
 * the drawer's lists however deep they are: always by hand, whatever order
 * the rest of the list is in. Kept in `.talaris/starred-order.json` — pages by
 * path, canvases by id. What is starred but not in it (newly starred, or
 * renamed from outside) comes after, in the tree's own order.
 */
const FILE = "starred-order.json";
export interface StarredOrder {
  pages: string[];
  canvases: string[];
}

export function starredOrder(projectId: string): StarredOrder {
  const { folder } = findProject(projectId);
  try {
    const o = readJson<Partial<StarredOrder>>(join(folder, MACHINERY, FILE));
    return { pages: o.pages ?? [], canvases: o.canvases ?? [] };
  } catch {
    return { pages: [], canvases: [] };
  }
}

export function setStarredOrder(projectId: string, kind: "pages" | "canvases", keys: string[]): StarredOrder {
  const { folder } = findProject(projectId);
  const next = { ...starredOrder(projectId), [kind]: [...new Set(keys.filter((k) => typeof k === "string"))] };
  writeJson(join(folder, MACHINERY, FILE), next);
  return next;
}

/** A page renamed or moved: its place among the starred goes with it, and its children's. */
export function starredPageMoved(projectId: string, from: string, to: string): void {
  const o = starredOrder(projectId);
  if (!o.pages.some((p) => p === from || p.startsWith(`${from}/`))) return;
  setStarredOrder(projectId, "pages", o.pages.map((p) => (p === from || p.startsWith(`${from}/`) ? to + p.slice(from.length) : p)));
}
