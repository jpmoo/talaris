// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore
/**
 * Mind maps: notes in a tree, laid out from their root.
 *
 * A mind map is ordinary notes and ordinary lines. What makes it one is a
 * `mind` key on each note — Talaris's own, carried through by everything that
 * has never heard of it, as any unknown key is (`itemOverlaid` in api.ts, and
 * the core keeps a canvas whole):
 *
 *   mind: { parent?: <item id>, order?: <number>, flow?: "right" | "left" | "down" | "up" }
 *
 * The root has no parent and holds the flow; the others say whose they are and
 * where among their brothers and sisters they stand. Each parent is joined to
 * each child by a line, the same line any two notes may have.
 *
 * The map is laid out again, from its root, whenever its shape changes — a
 * node added or the flow turned — and left alone otherwise: a node dragged
 * stays where it was put until the next change puts the whole map in order.
 * A node whose parent is gone (deleted) is the root of what hangs from it.
 */

import { document_ } from "./api.ts";
import { putDocument, type CanvasDocument, type CanvasItem } from "./document.ts";

export type Flow = "right" | "left" | "down" | "up";
export interface Mind { parent?: string; order?: number; flow?: Flow }
type MindItem = CanvasItem & { mind?: Mind };

/** Between a node and its children, along the flow; and between brothers and sisters, across it. */
const ALONG = 70;
const ACROSS = 22;
/** A new node's size, when there is nothing to take it from. */
const W = 180, H = 64;

const fresh = () => crypto.randomUUID();
const items = (doc: CanvasDocument) => doc.items as MindItem[];
const byId = (doc: CanvasDocument, id: string) => items(doc).find((i) => i.id === id);

/** Its `mind`, if it is in a map. */
export const mindOf = (item: CanvasItem | undefined | null): Mind | null => (item as MindItem | undefined)?.mind ?? null;

/** Its parent, if it has one that is still there. */
function parentOf(doc: CanvasDocument, item: MindItem): MindItem | null {
  const p = item.mind?.parent;
  return p ? byId(doc, p) ?? null : null;
}

/** The top of its map. */
export function rootOf(doc: CanvasDocument, item: MindItem): MindItem {
  let at = item;
  for (let i = 0; i < 500; i++) {
    const up = parentOf(doc, at);
    if (!up) return at;
    at = up;
  }
  return at;
}

/** Its children, in order. */
function childrenOf(doc: CanvasDocument, id: string): MindItem[] {
  return items(doc).filter((i) => i.mind?.parent === id).sort((a, b) => (a.mind!.order ?? 0) - (b.mind!.order ?? 0));
}

/** The way its map flows. */
export const flowOf = (doc: CanvasDocument, item: MindItem): Flow => rootOf(doc, item).mind?.flow ?? "right";

/**
 * The map in order, from its root, which stays where it is.
 *
 * Each node's subtree takes the room across the flow that its children need,
 * or its own size if more; the children are stacked in that room in order,
 * centred on their parent, one step along the flow from it.
 */
function layout(doc: CanvasDocument, root: MindItem) {
  const flow = root.mind?.flow ?? "right";
  const sideways = flow === "right" || flow === "left";
  const across = (i: MindItem) => (sideways ? i.h : i.w);
  const room = new Map<string, number>();
  const measure = (node: MindItem, depth: number): number => {
    const kids = depth < 200 ? childrenOf(doc, node.id) : [];
    const need = kids.reduce((sum, k) => sum + measure(k, depth + 1), 0) + ACROSS * Math.max(0, kids.length - 1);
    const r = Math.max(across(node), need);
    room.set(node.id, r);
    return r;
  };
  measure(root, 0);
  const place = (node: MindItem, depth: number) => {
    const kids = depth < 200 ? childrenOf(doc, node.id) : [];
    if (!kids.length) return;
    const total = kids.reduce((sum, k) => sum + room.get(k.id)!, 0) + ACROSS * (kids.length - 1);
    // The middle of the parent, across the flow, and where its children begin.
    const middle = sideways ? node.y + node.h / 2 : node.x + node.w / 2;
    let start = middle - total / 2;
    for (const k of kids) {
      const r = room.get(k.id)!;
      const centre = start + r / 2;
      if (sideways) {
        k.y = Math.round(centre - k.h / 2);
        k.x = Math.round(flow === "right" ? node.x + node.w + ALONG : node.x - ALONG - k.w);
      } else {
        k.x = Math.round(centre - k.w / 2);
        k.y = Math.round(flow === "down" ? node.y + node.h + ALONG : node.y - ALONG - k.h);
      }
      start += r + ACROSS;
      place(k, depth + 1);
    }
  };
  place(root, 0);
}

/** A node like `from` — its shape, colors, borders and text alignment — at its place, to be laid out. */
function nodeLike(from: MindItem | null, mind: Mind): MindItem {
  const look: Partial<CanvasItem> = {};
  if (from) {
    for (const k of ["shape", "fill", "stroke", "strokeWidth", "strokeStyle", "hAlign", "vAlign", "textColor"] as const) {
      if (from[k] !== undefined) (look as Record<string, unknown>)[k] = from[k];
    }
  }
  return { id: fresh(), x: from?.x ?? 0, y: from?.y ?? 0, w: from?.w ?? W, h: from?.h ?? H, text: "", ...look, mind };
}

const join = (doc: CanvasDocument, from: string, to: string) => doc.links.push({ id: fresh(), from, to });
const unjoin = (doc: CanvasDocument, from: string, to: string) => {
  doc.links = doc.links.filter((l) => !(l.from === from && l.to === to));
};

/** Its brothers and sisters numbered again, in order, from 0. */
function renumber(doc: CanvasDocument, parent: string) {
  childrenOf(doc, parent).forEach((k, i) => { k.mind = { ...k.mind, order: i }; });
}

/** Written, and laid out first. Says the new node's id, for it to be written in. */
async function done(doc: CanvasDocument, item: MindItem, made: string | null): Promise<string | null> {
  layout(doc, rootOf(doc, item));
  await putDocument(doc);
  return made;
}

// ---------------------------------------------------------------- what the menu does

/** A new map's look: a rectangle in a muted green, with black words. The nodes made from it take it on. */
const LOOK: Partial<CanvasItem> = { shape: "rectangle", fill: "#a9c4a4", textColor: "#111111", strokeWidth: 0, hAlign: "center", vAlign: "middle" };

/** The root of a new map, dropped at a point (in the canvas's own units), flowing down. */
export function newMap(x: number, y: number): CanvasItem {
  return { id: fresh(), x: x - W / 2, y: y - H / 2, w: W, h: H, text: "", ...LOOK, mind: { flow: "down" } } as MindItem;
}

/** Below it in the tree: last among its children. */
export async function addChild(id: string): Promise<string | null> {
  const doc = document_();
  const it = byId(doc, id);
  if (!it?.mind) return null;
  const kid = nodeLike(it, { parent: it.id, order: childrenOf(doc, it.id).length });
  doc.items.push(kid);
  join(doc, it.id, kid.id);
  return done(doc, it, kid.id);
}

/** Beside it, before or after, under the same parent. A root has none, and so no brothers and sisters. */
export async function addSibling(id: string, after: boolean): Promise<string | null> {
  const doc = document_();
  const it = byId(doc, id);
  const up = it && parentOf(doc, it);
  if (!it?.mind || !up) return null;
  const at = (it.mind.order ?? 0) + (after ? 0.5 : -0.5);
  const sib = nodeLike(it, { parent: up.id, order: at });
  doc.items.push(sib);
  join(doc, up.id, sib.id);
  renumber(doc, up.id);
  return done(doc, it, sib.id);
}

/**
 * Above it: a new node between it and its parent, in its place. Above the
 * root, the new node is the root, and takes the map's flow with it.
 */
export async function addParent(id: string): Promise<string | null> {
  const doc = document_();
  const it = byId(doc, id);
  if (!it?.mind) return null;
  const up = parentOf(doc, it);
  const mid = nodeLike(it, up ? { parent: up.id, order: it.mind.order ?? 0 } : { flow: it.mind.flow ?? "right" });
  if (up) unjoin(doc, up.id, it.id);
  it.mind = { parent: mid.id, order: 0 };
  doc.items.push(mid);
  if (up) join(doc, up.id, mid.id);
  join(doc, mid.id, it.id);
  // A new root stands where the old one stood, so the map does not jump off along the flow.
  return done(doc, mid, mid.id);
}

/** The whole map, flowing another way. */
export async function setFlow(id: string, flow: Flow): Promise<void> {
  const doc = document_();
  const it = byId(doc, id);
  if (!it?.mind) return;
  const root = rootOf(doc, it);
  root.mind = { ...root.mind, flow };
  await done(doc, root, null);
}

// ---------------------------------------------------------------- how its lines are drawn

/** For a parent with no color of its own: each branch off the root in one of these, in order, round again past the last. */
const BRANCHES = ["#d9a93a", "#e0763e", "#3fae9e", "#7d6bd6", "#4f93d1", "#c45c8a", "#7fa046"];

/**
 * The line from a parent to its child, as a mind map draws it: which way the
 * map flows, so it leaves and arrives square-on in that direction, and the
 * parent's color. Null for any other line, drawn as lines are. Worked out
 * from the notes each time, so the lines themselves carry nothing of it.
 */
export function mindLine(fromId: string, toId: string): { flow: Flow; color: string } | null {
  const doc = document_();
  const to = byId(doc, toId);
  if (!to?.mind || to.mind.parent !== fromId) return null;
  // The branch is the root's child this one hangs from.
  let at: MindItem = to;
  for (let i = 0; i < 500; i++) {
    const up = parentOf(doc, at);
    if (!up || !parentOf(doc, up)) break;
    at = up;
  }
  const top = parentOf(doc, at);
  const index = top ? childrenOf(doc, top.id).indexOf(at) : 0;
  // The parent's own color, when it has one that can be drawn; its branch's, when not.
  const from = byId(doc, fromId);
  const own = typeof from?.fill === "string" && /^#|^rgb/i.test(from.fill) ? from.fill : null;
  return { flow: flowOf(doc, to), color: own ?? BRANCHES[Math.max(0, index) % BRANCHES.length] };
}

/** Everything below it in the map. */
function descendantsOf(doc: CanvasDocument, id: string): MindItem[] {
  const out: MindItem[] = [];
  const walk = (at: string, depth: number) => {
    if (depth > 200) return;
    for (const k of childrenOf(doc, at)) { out.push(k); walk(k.id, depth + 1); }
  };
  walk(id, 0);
  return out;
}

/** Every node of the map it is in, by item id, root first; just itself when it is in none. */
export function mapOf(id: string): string[] {
  const doc = document_();
  const it = byId(doc, id);
  if (!it?.mind) return [id];
  const root = rootOf(doc, it);
  return [root.id, ...descendantsOf(doc, root.id).map((d) => d.id)];
}

/** Everything below it in its map, by item id: what goes with it when it is deleted. */
export function descendantIds(id: string): string[] {
  return descendantsOf(document_(), id).map((d) => d.id);
}

/** Whether anything hangs from it. */
export function hasChildren(id: string): boolean {
  return childrenOf(document_(), id).length > 0;
}

/**
 * Everything below it painted as it is — its fill and the color of its
 * words, once. Nothing holds them to it after: each can be changed again.
 */
export async function colorDescendants(id: string): Promise<void> {
  const doc = document_();
  const it = byId(doc, id);
  if (!it) return;
  for (const d of descendantsOf(doc, id)) {
    if (it.fill === undefined) delete d.fill; else d.fill = it.fill;
    if (it.textColor === undefined) delete d.textColor; else d.textColor = it.textColor;
  }
  await putDocument(doc);
}

/** Whether it may have brothers and sisters: only under a parent. */
export function hasParent(id: string): boolean {
  const doc = document_();
  const it = byId(doc, id);
  return Boolean(it && parentOf(doc, it));
}
