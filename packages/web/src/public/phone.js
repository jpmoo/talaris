// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore

/*
 * The Library on a phone (web.css, the phone): which one pane is out. The list is; Projects brings the projects in
 * from the left, and choosing one puts them away; a row chosen brings its card over everything, Back puts it away.
 * Nothing of the page's own changes: this only watches where you press, and what the card is showing.
 */
(() => {
  const phone = () => matchMedia("(max-width: 760px)").matches;
  const root = document.documentElement;
  const set = (side, detail) => { root.classList.toggle("ph-side", side); root.classList.toggle("ph-detail", detail); };

  function ready() {
    const tools = document.querySelector("header .tools") || document.querySelector("header");
    const side = document.getElementById("side");
    const rows = document.getElementById("middle");
    const detail = document.getElementById("detail");
    if (!tools || !side || !rows || !detail) return;

    const bar = document.createElement("div");
    bar.className = "ph-bar";
    const projects = Object.assign(document.createElement("button"), { textContent: "Projects" });
    const where = Object.assign(document.createElement("span"), { className: "where" });
    bar.append(projects, where);
    tools.prepend(bar);
    projects.addEventListener("click", () => set(!root.classList.contains("ph-side"), false));

    const back = Object.assign(document.createElement("button"), { className: "t-btn ph-back", textContent: "‹ Back" });
    back.addEventListener("click", () => set(false, false));
    const keepBack = () => { if (detail.firstChild !== back) detail.prepend(back); };
    new MutationObserver(keepBack).observe(detail, { childList: true });
    keepBack();

    // A project chosen: the drawer goes, and the bar says which.
    side.addEventListener("click", (e) => {
      if (!phone()) return;
      const pick = e.target.closest("[data-key], .s-row, .row, li, button");
      if (pick && !e.target.closest(".add")) setTimeout(() => set(false, false), 120);
    });
    const sayWhere = () => { const on = side.querySelector(".on, [aria-selected='true']"); where.textContent = on ? on.textContent.replace(/\s*\d+\s*$/, "").trim() : ""; };
    new MutationObserver(sayWhere).observe(side, { subtree: true, attributes: true, attributeFilter: ["class"] });
    sayWhere();

    // A row in the list pressed: its card, over everything.
    rows.addEventListener("click", (e) => {
      if (!phone()) return;
      if (e.target.closest(".row, .gv-row, .r-thing, [data-key]") && !e.target.closest("button, input, .seg, .chip")) setTimeout(() => set(false, true), 60);
    });
    // Outside the drawer, it goes.
    document.addEventListener("click", (e) => {
      if (phone() && root.classList.contains("ph-side") && !side.contains(e.target) && !bar.contains(e.target)) set(false, false);
    }, true);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", ready); else ready();
})();
