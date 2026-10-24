// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore
//
// Tooltips for the bar and the dock. A button's `title` is what it says, but
// the tip itself is drawn by the process (tip.py): Qt's own never shows over a
// layer surface, and these pages are only as tall as their buttons.
//
// After a short rest on a button its tip comes; moving to the next button
// while one shows brings that one's at once; a press, or leaving, puts it
// away. A button whose panel is open (lit) says nothing — what it would say
// is already on screen. Needs the page's `bridge` with a `tip(text, x)` slot.

"use strict";

(() => {
  const REST_MS = 450;
  const LONGEST = 90;
  let over = null;     // the button under the pointer
  let showing = false;
  let timer = 0;
  let pressed = false; // pressed since it was entered: quiet until left

  // `title` is moved aside so the browser's own tip (which would not show,
  // or would show in the wrong place) never competes; pages keep setting
  // `title`, and it is moved again on the next visit.
  function said(b) {
    if (b.hasAttribute("title")) {
      b.dataset.tip = b.getAttribute("title");
      b.removeAttribute("title");
    }
    const text = (b.dataset.tip || "").trim();
    return text.length > LONGEST ? text.slice(0, LONGEST - 1) + "…" : text;
  }

  function show() {
    clearTimeout(timer);
    if (!over || pressed || over.classList.contains("on") || typeof bridge === "undefined" || !bridge || !bridge.tip) return;
    const text = said(over);
    if (!text) { hide(); return; }
    const r = over.getBoundingClientRect();
    bridge.tip(text, r.left + r.width / 2);
    showing = true;
  }

  function hide() {
    clearTimeout(timer);
    if (showing && typeof bridge !== "undefined" && bridge && bridge.tip) bridge.tip("", 0);
    showing = false;
  }

  addEventListener("pointerover", (e) => {
    const b = e.target.closest("button, [data-tip], [title]");
    if (b === over) return;
    over = b;
    pressed = false;
    clearTimeout(timer);
    if (!b) { timer = setTimeout(hide, 80); return; }
    if (b.hasAttribute("title")) said(b);
    // Already showing one: the next comes at once.
    if (showing) show();
    else timer = setTimeout(show, REST_MS);
  });
  addEventListener("pointerdown", () => { pressed = true; hide(); }, true);
  addEventListener("wheel", () => { if (showing) show(); }, { passive: true });
  document.documentElement.addEventListener("pointerleave", () => { over = null; hide(); });
  addEventListener("blur", () => { over = null; hide(); });
})();
