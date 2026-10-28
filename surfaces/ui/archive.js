// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore
//
// The archive's page (archive_panel.py): archived projects, out of every
// other list (core, archive.ts), by the year and month they went. One chosen
// is read here — its pages rendered, its canvases' words, its files opened in
// their applications — and never written: bringing it back is one button.
// When a project in use has its name, the choice is asked: keep both, or
// merge it in, every page or file both have decided one by one.

"use strict";

(() => {
  const $ = (id) => document.getElementById(id);
  function el(tag, attrs = {}, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
      else if (k === "class") e.className = v;
      else e.setAttribute(k, v);
    }
    for (const k of kids.flat()) if (k != null && k !== "" && k !== false) e.append(k);
    return e;
  }
  function seg(choices, current, pick) {
    return el("span", { class: "seg" }, ...choices.map(([value, label]) =>
      el("button", { class: value === current ? "on" : "", onclick: () => pick(value) }, label)));
  }

  let bridge = null;
  let surface = { up: false };
  const WINDOW = new URLSearchParams(location.search).has("window");
  if (WINDOW) document.documentElement.dataset.window = "1";

  let rows = [];          // the archive, newest archived first
  let chosen = null;      // the project on show: its contents
  let hits = null;        // what a search found, or null when not searching
  const enc = encodeURIComponent;

  // ---------------------------------------------------------------- the core

  const waiting = new Map();
  let reqNext = Math.floor(Math.random() * 1e9);
  function api(method, path, body) {
    return new Promise((ok, fail) => {
      if (!bridge) { fail(new Error("Not connected")); return; }
      const id = String(++reqNext);
      waiting.set(id, (r) => (r.status >= 200 && r.status < 300 ? ok(r.data) : fail(new Error((r.data && r.data.error) || `the core answered ${r.status}`))));
      bridge.core(id, method, path, body === undefined ? "" : JSON.stringify(body));
    });
  }
  function say(text, error = false) { $("msg").textContent = text || ""; $("msg").className = error ? "err" : ""; }
  const failed = (e) => say(e.message, true);

  const day = (iso) => (iso ? Kit.day(iso, { weekday: false }) : "");
  const MONTHS = (iso) => new Date(iso).toLocaleDateString("en-US", { month: "long" });

  // ---------------------------------------------------------------- the list

  function drawSide() {
    const side = $("side");
    if (hits) {
      if (!hits.length) { side.replaceChildren(el("div", { class: "empty" }, "Nothing in the archive says that")); return; }
      const by = new Map();
      for (const h of hits) by.set(h.project, [...(by.get(h.project) || []), h]);
      side.replaceChildren(...[...by].flatMap(([pid, list]) => [
        el("div", { class: "month" }, list[0].projectName),
        ...list.map((h) => el("button", { class: "proj hit", onclick: () => choose(pid, h) },
          el("span", {}, h.title), el("small", {}, h.snippet ? `…${h.snippet}…` : h.kind === "file" ? h.where : h.kind))),
      ]));
      return;
    }
    if (!rows.length) { side.replaceChildren(el("div", { class: "empty" }, "Nothing archived yet. A project is archived from its properties in Tasks.")); return; }
    const out = [];
    let year = "", month = "";
    for (const r of rows) {
      const y = r.archived.slice(0, 4), m = MONTHS(r.archived);
      if (y !== year) { out.push(el("div", { class: "year" }, y)); year = y; month = ""; }
      if (m !== month) { out.push(el("div", { class: "month" }, m)); month = m; }
      out.push(el("button", { class: "proj" + (chosen && chosen.project.id === r.id ? " on" : ""), onclick: () => choose(r.id) },
        el("span", {}, r.name), el("small", {}, `${r.code} · ${r.pages} page${r.pages === 1 ? "" : "s"} · ${r.files} file${r.files === 1 ? "" : "s"}`)));
    }
    side.replaceChildren(...out);
  }

  async function load() {
    try {
      rows = (await api("GET", "/archive")) || [];
      say("");
    } catch (e) { failed(e); rows = []; }
    drawSide();
    if (chosen && !rows.some((r) => r.id === chosen.project.id)) { chosen = null; drawDetail(); }
  }

  let searchSeq = 0;
  async function search(q) {
    const seq = ++searchSeq;
    if (!q.trim()) { hits = null; drawSide(); return; }
    try {
      const found = await api("GET", `/archive/search?q=${enc(q.trim())}`);
      if (seq === searchSeq) { hits = found || []; drawSide(); }
    } catch (e) { failed(e); }
  }

  // ---------------------------------------------------------------- one project

  async function choose(id, open) {
    try {
      chosen = await api("GET", `/archive/${enc(id)}`);
    } catch (e) { failed(e); return; }
    drawSide();
    drawDetail();
    if (open && open.kind === "page") readPage(open.where);
    else if (open && open.kind === "canvas") readCanvas(open.where);
    else if (open && open.kind === "file") bridge.openProjectFile(chosen.project.id, open.where);
  }

  let reader = null;    // where a page or canvas is read, under the lists
  let decide = null;    // the sheet asking how to bring it back, when one is asked

  function drawDetail() {
    const d = $("detail");
    if (!chosen) { d.replaceChildren(el("div", { class: "empty" }, "Choose an archived project to read it, or search them all.")); return; }
    const p = chosen.project;
    const pageTree = (nodes) => el("div", {}, ...nodes.map((n) => el("div", {},
      el("button", { class: "item", onclick: () => readPage(n.path) }, el("span", {}, n.title)),
      n.children && n.children.length ? el("div", { class: "kids" }, pageTree(n.children)) : null)));
    reader = el("div", { class: "reader", hidden: "" });
    decide = el("div", {});
    d.replaceChildren(
      el("h2", {}, p.name),
      el("div", { class: "meta" }, `${p.code} · made ${day(p.created)} · archived ${day(p.archived)} · ${p.folder}`),
      decide,
      el("div", { class: "acts" }, el("button", { class: "t-btn", onclick: () => restore({}) }, "Bring it back")),
      el("div", { class: "sec" }, `Pages · ${countPages(chosen.pages)}`),
      chosen.pages.length ? pageTree(chosen.pages) : el("div", { class: "meta" }, "None"),
      el("div", { class: "sec" }, `Canvases · ${chosen.canvases.length}`),
      ...chosen.canvases.map((c) => el("button", { class: "item", onclick: () => readCanvas(c.id) }, el("span", {}, c.title), el("small", {}, `${c.items} thing${c.items === 1 ? "" : "s"} on it`))),
      el("div", { class: "sec" }, `Files · ${chosen.files.length}`),
      ...(chosen.files.length ? chosen.files.map((f) => el("button", { class: "item", title: "Open it", onclick: () => bridge.openProjectFile(p.id, f) }, el("span", {}, f.split("/").pop()), el("small", {}, f))) : [el("div", { class: "meta" }, "None")]),
      reader);
  }
  const countPages = (nodes) => nodes.reduce((n, x) => n + 1 + countPages(x.children || []), 0);

  function showReader(title, body) {
    reader.hidden = false;
    reader.replaceChildren(el("div", { class: "rhead" }, el("span", { class: "t" }, title), el("span", { class: "ro" }, "Archived · read only"),
      el("button", { class: "t-btn", onclick: () => { reader.hidden = true; } }, "Close")), body);
    reader.scrollIntoView({ behavior: "smooth", block: "start" });
  }
  let render = null;
  async function readPage(path) {
    try {
      const text = await api("GET", `/projects/${enc(chosen.project.id)}/page?path=${enc(path)}`);
      render ??= (await import("./markdown.js")).render;
      showReader(path.split("/").join(" / "), el("div", { class: "body" }, String(text || "").trim() ? render(String(text)) : el("p", { class: "meta" }, "Nothing written")));
    } catch (e) { failed(e); }
  }
  async function readCanvas(id) {
    try {
      const doc = await api("GET", `/projects/${enc(chosen.project.id)}/canvases/${enc(id)}`);
      const words = (doc.items || []).map((i) => String(i.text || (i.seen && i.seen.title) || "").trim()).filter(Boolean);
      showReader(doc.parent ? doc.title : "Canvas", el("div", {}, ...(words.length ? words.map((w) => el("div", { class: "note" }, w)) : [el("p", { class: "meta" }, "Nothing written on it")])));
    } catch (e) { failed(e); }
  }

  // ---------------------------------------------------------------- bringing it back

  async function restore(how) {
    const p = chosen.project;
    say("Bringing it back…");
    let r;
    try { r = await api("POST", `/projects/${enc(p.id)}/restore`, how); } catch (e) { failed(e); return; }
    if (r.done) {
      say("");
      const into = r.merged ? r.project : null;
      decide.replaceChildren(el("div", { class: "sheet" },
        el("p", {}, into ? `Merged into ${into.name}.${r.merged.setAside ? " What was set aside is in its .talaris/merged-away folder." : ""}` : `${r.project.name} is back.`),
        el("button", { class: "t-btn", onclick: () => bridge.goProject(r.project.id) }, "Go to it")));
      rows = rows.filter((x) => x.id !== p.id);
      drawSide();
      return;
    }
    say("");
    // A project in use has its name: keep both, or merge — and for a merge, each clash decided.
    if (!r.conflicts) {
      decide.replaceChildren(el("div", { class: "sheet" },
        el("p", {}, `A project called ${r.clash.name} is in use.`),
        el("div", { class: "acts" },
          el("button", { class: "t-btn", onclick: () => restore({ mode: "both" }) }, "Keep both"),
          el("button", { class: "t-btn", onclick: () => restore({ mode: "merge" }) }, `Merge into ${r.clash.name}`),
          el("button", { class: "t-btn", onclick: () => decide.replaceChildren() }, "Cancel"))));
      return;
    }
    const decisions = Object.fromEntries(r.conflicts.map((c) => [c, "both"]));
    const line = (c) => {
      const host = el("span", {});
      const draw = () => host.replaceChildren(seg([["active", "Keep the one in use"], ["restored", "Keep the archived one"], ["both", "Keep both"]], decisions[c], (v) => { decisions[c] = v; draw(); }));
      draw();
      // A page is named as a page; anything else by its place in the folder.
      const page = /^Writing\/(.+)\.md$/.exec(c);
      return el("div", { class: "conf" }, el("span", { class: "path" }, page ? `Page · ${page[1].split("/").join(" / ")}` : c), host);
    };
    decide.replaceChildren(el("div", { class: "sheet" },
      el("p", {}, `Both have ${r.conflicts.length === 1 ? "this" : `these ${r.conflicts.length}`}. Whatever is not kept is set aside in ${r.clash.name}'s .talaris/merged-away folder, not deleted.`),
      ...r.conflicts.map(line),
      el("div", { class: "acts", style: "margin-top:10px" },
        el("button", { class: "t-btn", onclick: () => restore({ mode: "merge", decisions }) }, "Merge"),
        el("button", { class: "t-btn", onclick: () => decide.replaceChildren() }, "Cancel"))));
  }

  // ---------------------------------------------------------------- keys and buttons

  let typed = null;
  $("q").addEventListener("input", () => { clearTimeout(typed); typed = setTimeout(() => search($("q").value), Kit.SEARCH_MS); });
  // Escape clears it first, as every box that narrows a list does (kit.js); the search follows the box.
  Kit.searchBox($("q"), () => search(""));
  document.addEventListener("keydown", (e) => {
    if (e.defaultPrevented) return;
    if (e.key === "Escape") { e.preventDefault(); if (bridge) bridge.file(); }
  });
  $("grow").addEventListener("click", () => bridge && bridge.grow());
  $("close").addEventListener("click", () => bridge && bridge.closeWindow());
  $("grow").innerHTML = Icons.grow();
  $("grow").title = "Make it a window";
  $("grow").hidden = WINDOW;
  $("close").innerHTML = Icons.close();
  $("close").title = "Close";
  $("close").hidden = !WINDOW;
  document.addEventListener("pointerdown", (e) => { if (!WINDOW && e.target === document.documentElement && bridge && surface.up) bridge.file(); });
  window.pressedAt = (x, y) => { if (!WINDOW && bridge && surface.up && document.elementFromPoint(x, y) === document.documentElement) bridge.file(); };
  for (const t of ["pointerdown", "keydown", "wheel"]) addEventListener(t, () => bridge && bridge.activity(), { capture: true, passive: true });

  /** From the launcher's "archive <words>": the archive, searched. */
  window.ArchivePage = {
    search(q) {
      $("q").value = q || "";
      search($("q").value);
      setTimeout(() => $("q").focus(), 50);
    },
  };

  // ---------------------------------------------------------------- coming and going

  function how() {
    const m = surface.motion || {};
    return { kind: m.motion, speed: m.speed, edge: "top", flush: false, viewport: surface.viewport,
      shown: () => bridge && bridge.drawn(),
      rules: (rule, rel, P) => { const h = document.querySelector("header").getBoundingClientRect(); rule(rel(P.left, h.bottom), rel(P.right, h.bottom)); } };
  }
  function onState(s) {
    const was = surface;
    surface = s;
    if (WINDOW) return;
    if (s.up && !was.up) {
      Motion.arrive(document.body, how());
      if (bridge) load();
    }
  }

  Surface.connect({ onState }).then((b) => {
    bridge = b;
    b.coreReply.connect((text) => { const r = JSON.parse(text); const done = waiting.get(r.id); waiting.delete(r.id); if (done) done(r); });
    b.leave.connect(() => {
      if (WINDOW) return;
      surface = { ...surface, up: false };
      const going = Motion.leave(document.body, how());
      if (going) going.onfinish = () => bridge.left(); else bridge.left();
    });
    if (WINDOW || surface.up) load();
  });
})();
