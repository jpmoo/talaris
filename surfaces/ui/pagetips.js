// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore
//
// Tooltips inside a panel's own page — Morgan's, Tasks', People, Settings —
// drawn by the page in Talaris's font and colors, where the engine's own
// would come in the system's default face. (The bar and the dock, which are
// only as tall as their buttons, have theirs drawn by the process: tips.js.)
//
// Anything with a `title`: after a short rest its tip comes, below it (above,
// near the bottom); moving to another while one shows brings that one's at
// once; a press, a key, scrolling or leaving puts it away. The `title` is
// moved aside while the pointer is over it, so the engine's tip never comes
// too, and put back after: pages keep reading and setting `title`.

"use strict";

(() => {
  const REST_MS = 500;
  let over = null, timer = 0, showing = false;
  const tip = document.createElement("div");
  tip.className = "page-tip kit-tip";
  tip.hidden = true;
  const style = document.createElement("style");
  style.textContent = `
    /* The kit's tooltip (.kit-tip), restated for the pages that load only tokens.css (the canvas, notify). */
    .page-tip { position: fixed; z-index: var(--z-tip); max-width: 320px; padding: 4px 8px; border-radius: var(--radius-row); pointer-events: none;
      background: var(--surface); color: var(--text); border: 1px solid var(--frame); box-shadow: var(--menu-shadow);
      font: 12.5px/1.3 var(--font); white-space: pre-line; }
    .page-tip[hidden] { display: none; }`;
  const ready = () => { document.head.append(style); document.body.append(tip); };
  if (document.body) ready(); else addEventListener("DOMContentLoaded", ready);

  function hide() {
    clearTimeout(timer);
    tip.hidden = true;
    showing = false;
  }
  function release(el) {
    if (el && el.dataset.pageTip !== undefined) {
      if (!el.hasAttribute("title")) el.setAttribute("title", el.dataset.pageTip);
      delete el.dataset.pageTip;
    }
  }
  function show(el) {
    const text = el.dataset.pageTip;
    if (!text || !el.isConnected) return;
    tip.textContent = text;
    tip.hidden = false;
    const r = el.getBoundingClientRect(), w = tip.offsetWidth, h = tip.offsetHeight;
    const below = r.bottom + 6 + h < innerHeight;
    tip.style.left = `${Math.max(4, Math.min(r.left + r.width / 2 - w / 2, innerWidth - w - 4))}px`;
    tip.style.top = `${below ? r.bottom + 6 : Math.max(4, r.top - h - 6)}px`;
    showing = true;
  }

  document.addEventListener("pointerover", (e) => {
    const el = e.target.closest && e.target.closest("[title], [data-page-tip]");
    if (el === over) return;
    release(over);
    over = el;
    if (!el) { hide(); return; }
    // Moved aside while it is pointed at, so the engine's own tip does not come as well.
    if (el.hasAttribute("title")) { el.dataset.pageTip = el.getAttribute("title"); el.removeAttribute("title"); }
    clearTimeout(timer);
    if (showing) show(el);
    else timer = setTimeout(() => show(el), REST_MS);
  }, true);
  document.addEventListener("pointerleave", () => { release(over); over = null; hide(); });
  for (const t of ["pointerdown", "keydown", "wheel"]) addEventListener(t, hide, { capture: true, passive: true });
})();
