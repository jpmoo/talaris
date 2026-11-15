// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore
//
// Ink on the canvas: a pen, a highlighter and an eraser, in a color and a
// thickness, with undo.
//
// **A stroke is an item** (document.ts, `InkItem`) — kind "ink", its box, its
// points with their pressure, its color and width — so it is saved with the
// canvas and synced between machines on its own, one record each, as a card
// is: two machines drawing at once keep both. The component never sees it as a
// note (document.ts, `notesOf`); this draws it (components/InkLayer.tsx).
//
// **The pen draws; a finger pans.** With an ink tool chosen, a press of the pen
// or the mouse draws, and one of a finger is the canvas's as ever — panning,
// and two to zoom — so a hand resting on the screen draws nothing (the mini,
// with its pen). The pen's pressure makes the line thicker as it is pressed.
//
// **Undo** is ink's own: each stroke drawn, each sweep of the eraser, Clear —
// undone and done again in order (Ctrl+Z, Ctrl+Shift+Z). Not the canvas's other
// changes, which have none yet.

import { changeInk, inkOf } from "./api.ts";
import type { InkItem } from "./document.ts";

export type InkTool = "pen" | "highlighter" | "eraser";
type Pt = [number, number, number];

/** The colors offered, the first the theme's own text (worked out as it is chosen). */
export const INK_COLORS = ["text", "#e03131", "#f08c00", "#fab005", "#2f9e44", "#1971c2", "#9c36b5"];
/** Each tool's three widths, in canvas units: fine, medium, broad. */
export const INK_SIZES: Record<"pen" | "highlighter", number[]> = { pen: [2, 4, 8], highlighter: [14, 22, 34] };

interface State {
  /** An ink tool is chosen: the pen draws on the canvas. */
  on: boolean;
  tool: InkTool;
  color: string;
  size: number;
  /** The stroke being drawn, in canvas units, and its look. */
  live: { points: Pt[]; color: string; width: number; tool: "pen" | "highlighter" } | null;
  /** Bumped at every change, for the layer to draw again. */
  version: number;
}

const KEPT = "talaris-ink";
function kept(): Partial<State> {
  try { return JSON.parse(localStorage.getItem(KEPT) || "{}"); } catch { return {}; }
}
const first = kept();
const state: State = {
  on: false,
  tool: first.tool === "highlighter" || first.tool === "eraser" ? first.tool : "pen",
  color: typeof first.color === "string" ? first.color : "text",
  size: typeof first.size === "number" ? Math.max(0, Math.min(2, first.size)) : 1,
  live: null,
  version: 0,
};
const listeners = new Set<() => void>();
function changed() {
  state.version++;
  try { localStorage.setItem(KEPT, JSON.stringify({ tool: state.tool, color: state.color, size: state.size })); } catch { /* private */ }
  for (const f of listeners) f();
}
export const inkState = () => state;
export function onInk(f: () => void): () => void {
  listeners.add(f);
  return () => listeners.delete(f);
}

/** An ink tool chosen, or none (Escape, the toolbar's pen again). */
export function setInk(on: boolean) {
  if (state.on === on) return;
  state.on = on;
  state.live = null;
  document.documentElement.dataset.ink = on ? state.tool : "";
  changed();
}
export function chooseTool(tool: InkTool) {
  state.tool = tool;
  state.on = true;
  document.documentElement.dataset.ink = tool;
  changed();
}
export function chooseColor(color: string) {
  state.color = color;
  if (state.tool === "eraser") chooseTool("pen");
  else changed();
}
export function chooseSize(size: number) {
  state.size = size;
  if (state.tool === "eraser") chooseTool("pen");
  else changed();
}

/** A color as drawn: "text" is the theme's text color now. */
export function resolveColor(color: string): string {
  if (color !== "text") return color;
  const v = getComputedStyle(document.documentElement).getPropertyValue("--text").trim()
    || getComputedStyle(document.body).color;
  return v || "#222";
}

// ------------------------------------------------------------ undo

type Step = { add: InkItem[]; remove: InkItem[] };
const undos: Step[] = [];
const redos: Step[] = [];
function apply(step: Step) {
  changeInk(step.add, step.remove.map((s) => s.id));
  changed();
}
function record(step: Step) {
  undos.push(step);
  if (undos.length > 200) undos.shift();
  redos.length = 0;
  apply(step);
}
export const canUndo = () => undos.length > 0;
export const canRedo = () => redos.length > 0;
export function undo() {
  const s = undos.pop();
  if (!s) return;
  redos.push(s);
  apply({ add: s.remove, remove: s.add });
}
export function redo() {
  const s = redos.pop();
  if (!s) return;
  undos.push(s);
  apply(s);
}

/** Every stroke taken off, as one step to undo. */
export function clearInk() {
  const all = inkOf();
  if (all.length) record({ add: [], remove: all });
}

// ------------------------------------------------------------ drawing

const newId = () => `ink-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

/** A press begun with an ink tool, at a point on the canvas: a stroke started, or the eraser's sweep. */
let erased: InkItem[] = [];
export function begin(p: Pt, zoom: number) {
  if (state.tool === "eraser") {
    erased = [];
    erase(p, zoom);
    return;
  }
  const tool = state.tool;
  state.live = { points: [p], color: resolveColor(state.color), width: INK_SIZES[tool][state.size]!, tool };
  changed();
}
/** The pen moved: the stroke goes on (points closer than a screen pixel left out), or the eraser sweeps on. */
export function extend(p: Pt, zoom: number) {
  if (state.tool === "eraser") { erase(p, zoom); return; }
  const live = state.live;
  if (!live) return;
  const last = live.points[live.points.length - 1]!;
  if (Math.hypot(p[0] - last[0], p[1] - last[1]) < 1 / zoom) return;
  live.points.push(p);
  changed();
}
/** The pen lifted: the stroke kept as an item (one dot, too), or the eraser's sweep kept as one step. */
export function end() {
  if (state.tool === "eraser") {
    if (erased.length) {
      undos.push({ add: [], remove: erased });
      redos.length = 0;
    }
    erased = [];
    return;
  }
  const live = state.live;
  state.live = null;
  if (!live) { changed(); return; }
  const pad = live.width;
  const xs = live.points.map((p) => p[0]), ys = live.points.map((p) => p[1]);
  const x = Math.min(...xs) - pad, y = Math.min(...ys) - pad;
  const item: InkItem = {
    id: newId(), kind: "ink", x, y,
    w: Math.max(...xs) - x + pad, h: Math.max(...ys) - y + pad,
    points: live.points.map(([px, py, pr]) => [round(px - x), round(py - y), round(pr, 2)]),
    color: live.color, width: live.width, ...(live.tool === "highlighter" ? { tool: "highlighter" as const } : {}),
  };
  record({ add: [item], remove: [] });
}
export function cancel() {
  state.live = null;
  erased = [];
  changed();
}
const round = (n: number, places = 1) => Math.round(n * 10 ** places) / 10 ** places;

/** The eraser at a point: every stroke it touches, taken off whole. */
function erase(p: Pt, zoom: number) {
  const reach = 10 / zoom;
  const hit = inkOf().filter((s) => touches(s, p[0], p[1], reach));
  if (!hit.length) return;
  erased.push(...hit);
  changeInk([], hit.map((s) => s.id));
  changed();
}

/** Whether a point is within `reach` of a stroke's line (its width counted). */
export function touches(s: InkItem, x: number, y: number, reach: number): boolean {
  const r = reach + s.width / 2;
  if (x < s.x - r || y < s.y - r || x > s.x + s.w + r || y > s.y + s.h + r) return false;
  const pts = s.points;
  if (pts.length === 1) return Math.hypot(pts[0]![0] + s.x - x, pts[0]![1] + s.y - y) <= r;
  for (let i = 1; i < pts.length; i++) {
    const ax = pts[i - 1]![0] + s.x, ay = pts[i - 1]![1] + s.y, bx = pts[i]![0] + s.x, by = pts[i]![1] + s.y;
    const dx = bx - ax, dy = by - ay, len = dx * dx + dy * dy;
    const t = len ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len)) : 0;
    if (Math.hypot(ax + t * dx - x, ay + t * dy - y) <= r) return true;
  }
  return false;
}

// ------------------------------------------------------------ the line's shape

/**
 * A pen's stroke as a filled outline, wider where it was pressed harder: each point offset to either side by half
 * its width, along the line's normal, the two sides joined round at the ends. Smoothed through the midpoints.
 */
export function outline(points: Pt[], width: number): string {
  if (!points.length) return "";
  const rad = (p: Pt) => (width / 2) * (0.35 + 0.65 * Math.max(0.05, Math.min(1, p[2] || 0.5)));
  if (points.length === 1) {
    const [x, y] = points[0]!, r = rad(points[0]!);
    return `M${x - r},${y}a${r},${r} 0 1,0 ${2 * r},0a${r},${r} 0 1,0 ${-2 * r},0Z`;
  }
  const left: [number, number][] = [], right: [number, number][] = [];
  for (let i = 0; i < points.length; i++) {
    const a = points[Math.max(0, i - 1)]!, b = points[Math.min(points.length - 1, i + 1)]!;
    let nx = -(b[1] - a[1]), ny = b[0] - a[0];
    const len = Math.hypot(nx, ny) || 1;
    nx /= len; ny /= len;
    const r = rad(points[i]!), [x, y] = points[i]!;
    left.push([x + nx * r, y + ny * r]);
    right.push([x - nx * r, y - ny * r]);
  }
  const smooth = (pts: [number, number][]) => {
    let d = "";
    for (let i = 1; i < pts.length - 1; i++) {
      const mx = (pts[i]![0] + pts[i + 1]![0]) / 2, my = (pts[i]![1] + pts[i + 1]![1]) / 2;
      d += `Q${pts[i]![0].toFixed(1)},${pts[i]![1].toFixed(1)} ${mx.toFixed(1)},${my.toFixed(1)}`;
    }
    const last = pts[pts.length - 1]!;
    return d + `L${last[0].toFixed(1)},${last[1].toFixed(1)}`;
  };
  const end = points[points.length - 1]!, start = points[0]!;
  const rEnd = rad(end), rStart = rad(start);
  const back = [...right].reverse();
  return `M${left[0]![0].toFixed(1)},${left[0]![1].toFixed(1)}` + smooth(left)
    + `A${rEnd.toFixed(1)},${rEnd.toFixed(1)} 0 0,1 ${back[0]![0].toFixed(1)},${back[0]![1].toFixed(1)}`
    + smooth(back)
    + `A${rStart.toFixed(1)},${rStart.toFixed(1)} 0 0,1 ${left[0]![0].toFixed(1)},${left[0]![1].toFixed(1)}Z`;
}

/** A highlighter's stroke: one even line through the points, smoothed. */
export function centerline(points: Pt[]): string {
  if (!points.length) return "";
  if (points.length === 1) return `M${points[0]![0]},${points[0]![1]}l0.01,0`;
  let d = `M${points[0]![0].toFixed(1)},${points[0]![1].toFixed(1)}`;
  for (let i = 1; i < points.length - 1; i++) {
    const mx = (points[i]![0] + points[i + 1]![0]) / 2, my = (points[i]![1] + points[i + 1]![1]) / 2;
    d += `Q${points[i]![0].toFixed(1)},${points[i]![1].toFixed(1)} ${mx.toFixed(1)},${my.toFixed(1)}`;
  }
  const last = points[points.length - 1]!;
  return d + `L${last[0].toFixed(1)},${last[1].toFixed(1)}`;
}
