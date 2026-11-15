// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore
//
// The canvas's ink, drawn (ink.ts): an SVG the size of the edges' (CanvasView,
// `.cv-svg`), inside the panned and zoomed layer, above the cards — ink is
// written over things. It takes no pointer itself; while an ink tool is chosen
// it hears the canvas's presses first (capture), takes the pen's and the
// mouse's, and leaves a finger's to the canvas, which pans and zooms with it.

import { useEffect, useReducer, useRef } from "react";
import { inkOf } from "../api.ts";
import { begin, cancel, centerline, end, erasingByEnd, extend, inkState, onInk, outline, redo, setInk, undo } from "../ink.ts";

/** Where a point on the screen is on the canvas, and the zoom: from the layer's own transform (as CanvasTools does). */
function toCanvas(wrap: HTMLElement, clientX: number, clientY: number): { x: number; y: number; z: number } {
  const layer = wrap.querySelector(".cv-layer") as HTMLElement | null;
  const m = new DOMMatrix(layer ? getComputedStyle(layer).transform : "none");
  const box = wrap.getBoundingClientRect();
  const z = m.a || 1;
  return { x: (clientX - box.left - m.e) / z, y: (clientY - box.top - m.f) / z, z };
}

export function InkLayer({ span }: { span: number }) {
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  const svg = useRef<SVGSVGElement | null>(null);
  useEffect(() => onInk(redraw), []);

  // The pen's presses, while an ink tool is chosen: heard before the canvas's own handlers (capture), and kept from
  // them, so drawing neither pans nor sweeps a selection. A finger's go on to the canvas.
  useEffect(() => {
    const wrap = svg.current?.closest(".cv-wrap") as HTMLElement | null;
    if (!wrap) return;
    let drawing: number | null = null;
    // The pen near (hovering or drawing — as the pointer, since Talaris takes the pen as one; and a mouse alike):
    // while it is, and a moment after, a finger on the canvas is ignored outright — a hand resting on the screen
    // neither pans, taps nor pinches. With the pen away, fingers pan and zoom as ever.
    let penNear = 0;
    const PEN_NEAR_MS = 900;
    const near = () => inkState().on && performance.now() - penNear < PEN_NEAR_MS;
    const hovered = (e: PointerEvent) => { if (e.pointerType !== "touch") penNear = performance.now(); };
    const palm = (e: Event) => {
      const touch = e instanceof PointerEvent ? e.pointerType === "touch" : true;
      if (touch && near()) { e.preventDefault(); e.stopPropagation(); }
    };
    const point = (e: PointerEvent) => {
      const c = toCanvas(wrap, e.clientX, e.clientY);
      // A mouse says no pressure (0, or 0.5 while pressed): drawn at the middle.
      const pr = e.pointerType === "pen" ? (e.pressure || 0.5) : 0.5;
      return { p: [c.x, c.y, pr] as [number, number, number], z: c.z };
    };
    const down = (e: PointerEvent) => {
      if (e.pointerType === "touch") { palm(e); return; }
      penNear = performance.now();
      // With the pen's eraser end, ink is erased whether or not a pen tool is chosen.
      if ((!inkState().on && !erasingByEnd()) || e.button !== 0) return;
      // Over the canvas's own controls (a card's menu, a field): theirs.
      const t = e.target as HTMLElement;
      if (t.closest("input, textarea, [contenteditable=true], .menu, .ctx-menu, button")) return;
      e.preventDefault();
      e.stopPropagation();
      drawing = e.pointerId;
      try { wrap.setPointerCapture(e.pointerId); } catch { /* gone already */ }
      const { p, z } = point(e);
      begin(p, z);
    };
    const move = (e: PointerEvent) => {
      hovered(e);
      if (e.pointerType === "touch") { palm(e); return; }
      if (drawing !== e.pointerId) return;
      e.preventDefault();
      e.stopPropagation();
      // Every sample the pen gave since the last frame, not only the last: a quick stroke stays smooth.
      const samples = typeof e.getCoalescedEvents === "function" ? e.getCoalescedEvents() : [];
      for (const s of samples.length ? samples : [e]) {
        const { p, z } = point(s);
        extend(p, z);
      }
    };
    const up = (e: PointerEvent) => {
      if (drawing !== e.pointerId) return;
      e.preventDefault();
      e.stopPropagation();
      drawing = null;
      end();
    };
    const lost = (e: PointerEvent) => {
      if (drawing !== e.pointerId) return;
      drawing = null;
      end();
    };
    wrap.addEventListener("pointerdown", down, true);
    // The canvas pinches and pans with touch events of its own (CanvasView): kept from them too while the pen is near.
    wrap.addEventListener("touchstart", palm, { capture: true, passive: false });
    wrap.addEventListener("touchmove", palm, { capture: true, passive: false });
    wrap.addEventListener("pointermove", move, true);
    wrap.addEventListener("pointerup", up, true);
    wrap.addEventListener("pointercancel", lost, true);
    return () => {
      wrap.removeEventListener("pointerdown", down, true);
      wrap.removeEventListener("touchstart", palm, true);
      wrap.removeEventListener("touchmove", palm, true);
      wrap.removeEventListener("pointermove", move, true);
      wrap.removeEventListener("pointerup", up, true);
      wrap.removeEventListener("pointercancel", lost, true);
    };
  }, []);

  // Keys: Ctrl+Z and Ctrl+Shift+Z (or Ctrl+Y) undo and do again ink's own steps; Escape puts the pen down.
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest?.("input, textarea, [contenteditable=true]")) return;
      const ctl = e.ctrlKey || e.metaKey;
      if (ctl && e.key.toLowerCase() === "z" && inkState().on) {
        e.preventDefault();
        if (e.shiftKey) redo(); else undo();
      } else if (ctl && e.key.toLowerCase() === "y" && inkState().on) {
        e.preventDefault();
        redo();
      } else if (e.key === "Escape" && inkState().on) {
        cancel();
        setInk(false);
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);

  const strokes = inkOf();
  const live = inkState().live;
  // Highlighters first, the pen's over them.
  const order = [...strokes].sort((a, b) => Number(b.tool === "highlighter") - Number(a.tool === "highlighter"));
  return (
    <svg
      ref={svg}
      className="cv-ink"
      width={span}
      height={span}
      viewBox={`${-span / 2} ${-span / 2} ${span} ${span}`}
      style={{ left: -span / 2, top: -span / 2 }}
    >
      {order.map((s) =>
        s.tool === "highlighter" ? (
          <path key={s.id} transform={`translate(${s.x} ${s.y})`} d={centerline(s.points)} fill="none" stroke={s.color}
            strokeWidth={s.width} strokeLinecap="round" strokeLinejoin="round" opacity={0.35} />
        ) : (
          <path key={s.id} transform={`translate(${s.x} ${s.y})`} d={outline(s.points, s.width)} fill={s.color} />
        ),
      )}
      {live && (live.tool === "highlighter" ? (
        <path d={centerline(live.points)} fill="none" stroke={live.color} strokeWidth={live.width}
          strokeLinecap="round" strokeLinejoin="round" opacity={0.35} />
      ) : (
        <path d={outline(live.points, live.width)} fill={live.color} />
      ))}
    </svg>
  );
}
