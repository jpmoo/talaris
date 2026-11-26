// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore

/*
 * Notes and Canvas on a phone (web.css): the list of pages (or canvases) and the one open are side by side on the
 * desktop; on a phone, one at a time. Choosing one in the list shows it whole; ‹ Back shows the list again. Nothing of
 * the drawer's own changes: this only watches where you press.
 */
(() => {
  const phone = () => matchMedia("(max-width: 760px)").matches;
  const root = document.documentElement;
  function ready() {
    const body = document.getElementById("body");
    const tree = body?.querySelector(":scope > .tree");
    if (!tree) return setTimeout(ready, 300);
    // Back floats at the top corner while a page is open: the drawer redraws its own panes, so nothing in them keeps it.
    const back = Object.assign(document.createElement("button"), { className: "t-btn dr-back", textContent: "‹ Back" });
    back.addEventListener("click", () => root.classList.remove("dr-open"));
    document.body.append(back);
    // The drawer's own list button (the side column's): on a phone it goes between the two panes — to the list from a
    // page, and back to the page last opened from the list — and never hides the list, which would leave nothing.
    let opened = false;
    document.addEventListener("click", (e) => {
      if (!phone() || !e.target.closest(".side-toggle")) return;
      e.preventDefault(); e.stopImmediatePropagation();
      if (root.classList.contains("dr-open")) root.classList.remove("dr-open");
      else if (opened) root.classList.add("dr-open");
    }, true);
    // Hidden here before (the desktop's button hid it): shown again, or a phone would have no list to choose from.
    try { for (const k of Object.keys(localStorage)) if (["talaris.canvas.tree", "talaris.writing.list"].includes(k) && localStorage.getItem(k) === "off" && phone()) localStorage.setItem(k, "on"); } catch { /* fine */ }
    // Heard on the document: the drawer may draw its list anew.
    document.addEventListener("click", (e) => {
      if (!phone() || !e.target.closest("#body > .tree") || e.target.closest("button, input, .seg, .tag, [contenteditable]")) return;
      // A page's or a canvas's row (its name), not the tree's own controls: shown whole.
      if (e.target.closest(".node, .row, li, .item, .name, [data-path], [data-id]")) setTimeout(() => { opened = true; root.classList.add("dr-open"); }, 80);
    });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", ready); else ready();
})();
