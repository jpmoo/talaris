// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore

/*
 * The web's own frame around a desktop page (docs/WEB.md, *What it shows*; UX-AUDIT 4.2): the same on every module.
 *
 * - The modules: a bar along the bottom, the one you are in lit. On the desktop the bar and the dock do this.
 * - On a phone, one pane at a time, and one way back: a bar along the top with Back on the left and the module's name
 *   in the middle; the page is its list, or its detail, or a sheet it opened, or its side column over the list. Each
 *   step away from the list is a step in the browser's history, so the phone's own back gesture and the browser's Back
 *   do what the bar's Back does.
 *
 * What is the list, the detail, the side and the rest, each page says (server.mjs, `PAGES[…].panes`, as
 * `TALARIS_WEB.panes`): nothing here guesses at a page's markup, and nothing of the page's own is changed — the panes
 * are shown and hidden by classes on <html> and a stylesheet made from what the page declared.
 */
(() => {
  const WEB = window.TALARIS_WEB || {};
  const P = WEB.panes || {};
  const root = document.documentElement;
  // The pages' own icons (icons.js, a `const` of the page's, so not on `window`).
  const icon = (name) => (typeof Icons !== "undefined" && typeof Icons[name] === "function" ? Icons[name]() : "");
  const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html) e.innerHTML = html; return e; };
  if (WEB.title) document.title = `${WEB.title} · Talaris`;

  // ---------------------------------------------------------------- the modules, along the bottom
  const ICONS = { library: "library", tasks: "tasks", notes: "writing", people: "people", canvas: "canvas", calendar: "event", morgan: "morgan" };
  const nav = el("nav", "web-modules");
  nav.setAttribute("aria-label", "Modules");
  for (const m of WEB.modules || []) {
    const a = el("a", m.id === WEB.page ? "on" : "", `${icon(ICONS[m.id])}<span>${m.title}</span>`);
    a.href = `${WEB.prefix}/${m.id}`;
    if (m.id === WEB.page) a.setAttribute("aria-current", "page");
    nav.append(a);
  }
  document.body.append(nav);
  root.classList.add("has-modules");

  // ---------------------------------------------------------------- the phone's shell
  const PHONE = matchMedia("(max-width: 760px)");
  const phone = () => PHONE.matches;
  const any = (sel) => (sel ? [...document.querySelectorAll(sel)] : []);
  const within = (node, sel) => !!(sel && node && node.closest && node.closest(sel));
  const sheets = (P.sheets || []).map((s) => ({ ...s, node: document.querySelector(s.el) })).filter((s) => s.node);

  // The panes, as the page declared them: one stylesheet, so a pane the page draws anew is still the pane.
  const is = (sel) => `:is(${sel})`;
  const css = [];
  if (P.hide) css.push(`html.sh-phone ${is(P.hide)} { display: none !important; }`);
  if (P.listOnly) css.push(`html.sh-phone:is(.sh-detail, .sh-sheet) ${is(P.listOnly)} { display: none !important; }`);
  if (P.list && P.detail) {
    css.push(`html.sh-phone ${is(`${P.list}, ${P.detail}`)} { flex: 1 1 auto !important; width: auto !important; max-width: none !important; min-width: 0 !important; border-left: 0 !important; border-right: 0 !important; }`,
      `html.sh-phone:not(.sh-detail) ${is(P.detail)} { display: none !important; }`,
      `html.sh-phone.sh-detail ${is(P.list)} { display: none !important; }`);
  }
  if (P.side) {
    css.push(`html.sh-phone :has(> ${is(P.side)}) { position: relative; }`,
      `html.sh-phone ${is(P.side)} { display: block !important; position: absolute !important; top: 0; bottom: 0; left: 0; width: min(85%, 320px) !important; max-width: none !important;
        z-index: var(--z-sheet); background: var(--surface); box-shadow: var(--edge-shadow); overflow: auto;
        transform: translateX(-105%); visibility: hidden; transition: transform var(--dur) var(--ease), visibility 0s linear var(--dur); }`,
      `html.sh-phone.sh-side ${is(P.side)} { transform: none; visibility: visible; transition: transform var(--dur) var(--ease); }`);
  }
  for (const s of sheets) css.push(`html.sh-phone ${is(s.el)} { position: absolute !important; inset: 0 !important; width: auto !important; max-width: none !important; z-index: var(--z-sheet); }`);
  const style = el("style");
  style.textContent = css.join("\n");
  document.head.append(style);

  // The bar along the top: Back (or the side column's button) on the left, the module's name in the middle.
  const bar = el("div", "sh-bar");
  bar.setAttribute("role", "banner");
  const left = el("button", "sh-left");
  left.type = "button";
  const title = el("div", "sh-title");
  const name = el("span", "sh-name");
  name.textContent = WEB.title || "Talaris";
  const where = el("span", "sh-where");
  title.append(name, where);
  const right = el("span", "sh-right");
  bar.append(left, title, right);
  const scrim = el("div", "sh-scrim");
  document.body.append(bar, scrim);

  // Where it is: "list", "detail", "side" or "sheet". Every state but the list is one step on in the history.
  let state = "list";
  const openSheet = () => sheets.find((s) => s.node.isConnected && getComputedStyle(s.node).display !== "none");
  function draw() {
    root.classList.toggle("sh-detail", state === "detail");
    root.classList.toggle("sh-side", state === "side");
    root.classList.toggle("sh-sheet", state === "sheet");
    const back = state === "detail" || state === "sheet";
    left.hidden = !back && !P.side;
    left.innerHTML = back ? `${icon("prev")}<span>Back</span>` : icon("sideList");
    left.classList.toggle("back", back);
    left.classList.toggle("on", state === "side");
    left.setAttribute("aria-label", back ? "Back" : state === "side" ? "Hide the side column" : "Show the side column");
    left.setAttribute("aria-expanded", String(state === "side"));
    sayWhere();
  }
  function sayWhere() {
    const on = P.where && document.querySelector(P.where);
    where.textContent = on ? on.textContent.trim() : "";
    where.hidden = !where.textContent;
  }
  /** To a state, as a step: on from the list is pushed, along from one step to another replaces, back is the history's. */
  function go(next) {
    if (next === state) return;
    if (next === "list") {
      if (history.state && history.state.sh) { history.back(); return; }
      settle("list");
      return;
    }
    if (state === "list") history.pushState({ sh: next }, "");
    else history.replaceState({ sh: next }, "");
    settle(next);
  }
  /** Arrived (by go, or by the history): a sheet left open behind is closed as the page closes it. */
  function settle(next) {
    const was = state;
    state = next;
    if (was === "sheet" && next !== "sheet") closeSheet();
    draw();
  }
  function closeSheet() {
    const s = openSheet();
    if (!s) return;
    if (s.close === "Escape") document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    else document.querySelector(s.close)?.click();
  }
  addEventListener("popstate", () => settle(history.state && history.state.sh ? history.state.sh : "list"));
  left.addEventListener("click", () => {
    if (state === "detail" || state === "sheet") go("list");
    else go(state === "side" ? "list" : "side");
  });
  scrim.addEventListener("click", () => go("list"));

  // Something chosen in the list: the detail, once the page has drawn it. A press on a row says it is coming; the
  // detail's being drawn says it is here. For a row already chosen nothing is drawn again, so a moment is enough.
  let pending = null;
  const ignore = "button, input, select, textarea, a, label, summary, [contenteditable], .seg";
  function expect(ms) {
    clearTimeout(pending?.timer);
    pending = { timer: ms ? setTimeout(arrive, ms) : setTimeout(() => { pending = null; }, 20_000) };
  }
  function arrive() {
    if (!pending) return;
    clearTimeout(pending.timer);
    pending = null;
    if (phone() && state !== "detail") go("detail");
  }
  document.addEventListener("click", (e) => {
    if (!phone()) return;
    const t = e.target;
    // A choice in the side column: it goes, to show what was chosen.
    if (state === "side" && within(t, P.side)) {
      const row = P.sideRows && t.closest(P.sideRows);
      const no = t.closest(ignore);
      if (row && !(no && no !== row && row.contains(no))) setTimeout(() => { if (state === "side") go("list"); }, 0);
      return;
    }
    if (P.detail && P.rows && state === "list" && within(t, P.list)) {
      const row = t.closest(P.rows);
      const no = t.closest(ignore);
      // A row's own controls (its star, its twist, its ×) are the row's, not a choice of it.
      if (row && within(row, P.list) && !(no && no !== row && row.contains(no))) expect(600);
    }
    if (P.detail && P.opens && within(t, P.opens)) expect(0);
  }, true);
  if (P.detail) {
    new MutationObserver((records) => {
      if (!pending) return;
      for (const r of records) {
        if (within(r.target, P.detail) || [...r.addedNodes].some((n) => n.nodeType === 1 && (n.matches(P.detail) || n.querySelector(P.detail)))) { arrive(); return; }
      }
    }).observe(document.body, { childList: true, subtree: true });
  }
  // Opened on one thing (`?card=…`, from another module: bridge.js `libraryAt`): its detail, once the page draws it.
  if (P.detail && new URLSearchParams(location.search).has("card")) expect(0);
  // A sheet the page opens (a task's card) or closes itself: followed, so Back closes it and its closing is a step back.
  for (const s of sheets) {
    new MutationObserver(() => {
      if (!phone()) return;
      const open = !!openSheet();
      if (open && state !== "sheet") go("sheet");
      else if (!open && state === "sheet") go("list");
    }).observe(s.node, { attributes: true, attributeFilter: ["hidden", "class", "style"] });
  }
  // What the bar says under the title, kept as the side column changes.
  if (P.where) {
    let queued = false;
    new MutationObserver(() => { if (!queued) { queued = true; requestAnimationFrame(() => { queued = false; sayWhere(); }); } })
      .observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["class"] });
  }

  // A phone, or not: the shell is the phone's, and a window widened past a phone's width is the desktop's page again.
  function fit() {
    root.classList.toggle("sh-phone", phone());
    if (!phone() && state !== "list") { state = "list"; history.replaceState(null, ""); }
    draw();
  }
  PHONE.addEventListener("change", fit);
  // A reload in a step on (the history kept it): the list again, which is what the page shows first.
  if (history.state && history.state.sh) history.replaceState(null, "");
  fit();
  if (phone() && openSheet()) go("sheet");
})();
