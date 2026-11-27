// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore

/*
 * A page's list and its detail, one at a time on a phone (UX-AUDIT 4.1, 4.2): the page says which is which
 * (`TALARIS_WEB.panes = {list, detail}`, selectors), and this shows the list; a press on something in it shows the
 * detail whole, with ‹ Back — and the phone's own back gesture, since each detail is a step in the browser's history.
 * Nothing of the page's own changes. People first; the Library, Notes and Canvas to follow onto this one shell.
 */
(() => {
  const WEB = window.TALARIS_WEB || {};
  const cfg = WEB.panes;
  if (!cfg) return;
  const phone = () => matchMedia("(max-width: 760px)").matches;
  const root = document.documentElement;
  const open = (on, fromHistory = false) => {
    if (on === root.classList.contains("pn-open")) return;
    root.classList.toggle("pn-open", on);
    if (!fromHistory) {
      if (on) history.pushState({ pane: "detail" }, "");
      else if (history.state && history.state.pane === "detail") history.back();
    }
  };
  addEventListener("popstate", () => open(false, true));
  function ready() {
    const list = document.querySelector(cfg.list);
    if (!list) return setTimeout(ready, 300);
    const back = Object.assign(document.createElement("button"), { className: "t-btn pn-back", textContent: "‹ Back" });
    back.addEventListener("click", () => open(false));
    document.body.append(back);
    // A press on something in the list (not its own buttons or fields): the detail, whole.
    document.addEventListener("click", (e) => {
      if (!phone() || !e.target.closest(cfg.list) || e.target.closest("button, input, select, textarea, .seg, summary, h3, .group-head")) return;
      setTimeout(() => open(true), 60);
    });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", ready); else ready();
})();
