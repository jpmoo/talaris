// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore
//
// Glance's page (glance_panel.py): one project and everything it holds or
// touches, from the core's /projects/:id/glance, as a list grouped by kind or
// as a graph of how it is tied. Nothing is kept here but what is on show and
// this page's own preferences; a thing chosen opens where it lives.
//
// The graph's layout is a small force simulation of its own — repulsion,
// springs along the ties, a pull to the middle — so no library comes in, and
// the project sits pinned at the centre of it.

"use strict";

// One closure: peek.js loads first into the same page.
(() => {
  const $ = (id) => document.getElementById(id);
  function el(tag, attrs = {}, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
      else if (k === "class") e.className = v;
      else if (k === "style") e.setAttribute("style", v);
      else if (k === "value") e.value = v;
      else e.setAttribute(k, v);
    }
    for (const k of kids.flat()) if (k != null && k !== "" && k !== false) e.append(k);
    return e;
  }
  function seg(host, choices, current, pick) {
    (typeof host === "string" ? $(host) : host).replaceChildren(...choices.map(([value, label]) =>
      el("button", { class: value === current ? "on" : "", onclick: (e) => { e.stopPropagation(); pick(value); } }, label)));
  }
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* fine */ } },
  };

  let bridge = null;
  let surface = { up: false };
  // Loaded as a window (overlay.py), not a panel: always out, no dim, no motion.
  const WINDOW = new URLSearchParams(location.search).has("window");
  if (WINDOW) document.documentElement.dataset.window = "1";

  let view = store.get("talaris.glance.view", "list");
  let off = new Set(store.get("talaris.glance.off", []));     // kinds' groups switched off
  let shut = new Set(store.get("talaris.glance.shut", []));   // list groups folded
  let mine = store.get("talaris.glance.mine", false);
  let data = null;        // the glance, as the core answers it
  // Where the walk is: "" for the project itself, or the key of the thing walked to, and
  // the things walked through on the way ({key, title}), the project first.
  let from = "";
  let trail = [];
  let loadedFor = null;   // the project id it was asked for
  let loadSeq = 0;        // answers to an older asking are dropped

  // ---------------------------------------------------------------- the core

  // Two pages may share the bridge — the panel and its window — so each numbers
  // its requests from somewhere of its own, and takes only its own answers.
  const waiting = new Map();
  let reqNext = Math.floor(Math.random() * 1e9);
  function api(method, path, body) {
    return new Promise((ok, fail) => {
      if (!bridge) { fail(new Error("Not connected")); return; }
      const id = String(++reqNext);
      waiting.set(id, (r) => (r.status >= 200 && r.status < 300 ? ok(r.data)
        : fail(new Error((r.data && r.data.error) || `the core answered ${r.status}`))));
      bridge.core(id, method, path, body === undefined ? "" : JSON.stringify(body));
    });
  }
  const enc = encodeURIComponent;

  function say(text, error = false) { $("msg").textContent = text || ""; $("msg").className = error ? "err" : ""; }
  const failed = (e) => say(e.message, true);

  // ---------------------------------------------------------------- kinds

  // The header's order for the chips; the list's own order differs (LIST_ORDER), as asked.
  const GROUPS = [
    ["page", "Pages"], ["canvas", "Canvases"], ["task", "Tasks"], ["file", "Files"], ["contact", "People"],
    ["event", "Events"], ["note", "Notes"], ["project", "Projects"], ["other", "Other"],
  ];
  const LIST_ORDER = ["page", "canvas", "task", "file", "note", "event", "contact", "project", "other"];
  const NAME = Object.fromEntries(GROUPS);
  const KNOWN = new Set(GROUPS.map(([k]) => k));
  const groupOf = (n) => (KNOWN.has(n.kind) ? n.kind : "other");
  // The middle: the project as the glance opens, or the thing walked to.
  const isRoot = (n) => Boolean(data && n.key === data.root);

  // A 16-point grid, a 1.5 line, as icons.js draws.
  const ic = (body) => `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
  const KIND_ICON = {
    page: ic('<path d="M4 2h5l3 3v9H4z"/><path d="M9 2v3h3M6 8.5h4M6 11h4"/>'),
    canvas: ic('<rect x="2" y="2" width="12" height="12" rx="2"/><rect x="4.5" y="5" width="4.5" height="3.5" rx=".6"/>'),
    task: ic('<rect x="2.5" y="2.5" width="11" height="11" rx="2"/><path d="M5.5 8.2 7.3 10l3.4-4"/>'),
    file: ic('<path d="M11 6.5 7 10.5a1.4 1.4 0 0 1-2-2l4.6-4.6a2.6 2.6 0 0 1 3.7 3.7L8.6 12.3a3.9 3.9 0 0 1-5.5-5.5L6.5 3.4"/>'),
    contact: ic('<circle cx="8" cy="5.5" r="2.6"/><path d="M3 13.5c.6-2.6 2.6-4 5-4s4.4 1.4 5 4"/>'),
    event: ic('<rect x="2.5" y="3.5" width="11" height="10" rx="1.5"/><path d="M2.5 6.5h11M5.5 2v3M10.5 2v3"/>'),
    note: ic('<path d="M3 3h10v7l-3 3H3z"/><path d="M13 10h-3v3"/>'),
    project: ic('<path d="M2 4h4l1.5 1.5H14v7.5H2z"/>'),
    other: ic('<circle cx="8" cy="8" r="4.5"/>'),
  };
  const REFRESH = ic('<path d="M13 8a5 5 0 1 1-1.6-3.7"/><path d="M12 1.8v3h-3"/>');

  // ---------------------------------------------------------------- filters

  const query = () => $("q").value.trim().toLowerCase();
  const matches = (n, q) => !q || String(n.title || "").toLowerCase().includes(q);
  // Shown at all: its kind is on, and it is the project's own when only those are wanted.
  // The project itself is always there — the graph hangs from it.
  const shown = (n) => isRoot(n) || (!off.has(groupOf(n)) && (!mine || n.own));
  const things = () => (data ? data.nodes.filter((n) => !isRoot(n)) : []);

  function drawProject() {
    const p = (data && data.project) || surface.project || {};
    $("proj").replaceChildren(p.name || "", p.code ? el("span", { class: "code" }, p.code) : null);
    // The way here, each step a way back; the last is where it is.
    const box = $("trail");
    box.hidden = !from;
    if (!from) { box.replaceChildren(); return; }
    const here = data && data.nodes.find(isRoot);
    const steps = [{ key: "", title: p.name || "Project" }, ...trail];
    box.replaceChildren(...steps.flatMap((t, i) => [
      el("button", { title: i ? `Back to ${t.title}` : "Back to the project", onclick: () => walkBack(i) }, t.title || "Untitled"),
      el("span", { class: "sep" }, "›"),
    ]), el("span", { class: "here" }, (here && here.title) || ""));
  }

  /** The glance walked on: the thing at its middle now, what it is tied to round it. */
  function walkTo(n) {
    if (!n || isRoot(n) || !data) return;
    const here = data.nodes.find(isRoot);
    // The project walked to again is the start again, not a step.
    if (n.key === `project:${data.project.id}`) { reset(); return; }
    trail = [...trail, ...(here && from ? [{ key: from, title: here.title }] : [])];
    from = n.key;
    load();
  }
  // The i-th crumb: 0 is the project; the rest are trail[i - 1].
  function walkBack(i) {
    if (i === 0) { from = ""; trail = []; } else { from = trail[i - 1].key; trail = trail.slice(0, i - 1); }
    load();
  }
  /** Back to the start: the project this desktop is. */
  function reset() {
    if (!from && !trail.length) { Graph.fit(); return; }
    from = ""; trail = [];
    load();
  }

  function drawKinds() {
    const counts = new Map();
    for (const n of things()) if (!mine || n.own) counts.set(groupOf(n), (counts.get(groupOf(n)) || 0) + 1);
    $("kinds").replaceChildren(...GROUPS.map(([k, name]) => {
      const n = counts.get(k) || 0;
      return el("button", { class: "kchip" + (off.has(k) ? "" : " on") + (n ? "" : " none"), title: off.has(k) ? `Show ${name.toLowerCase()}` : `Hide ${name.toLowerCase()}`,
        onclick: () => { if (off.has(k)) off.delete(k); else off.add(k); store.set("talaris.glance.off", [...off]); filtered(); } },
        el("span", { class: "dot", style: `background: var(--k-${k})` }), name, el("span", { class: "n" }, String(n)));
    }));
    $("mine").classList.toggle("on", mine);
  }

  function drawView() {
    seg("view", [["list", "List"], ["graph", "Graph"]], view, (v) => {
      view = v; store.set("talaris.glance.view", v); drawView(); drawBody();
    });
    $("list").hidden = view !== "list";
    $("graph").hidden = view !== "graph";
  }

  // What changing a filter does: the chips, and the view on show, drawn again.
  function filtered() {
    drawKinds();
    if (view === "list") drawList();
    else { Graph.filtered(); }
  }
  function drawBody() {
    if (view === "list") drawList();
    else Graph.show();
  }

  // ---------------------------------------------------------------- opening

  function open(n) {
    if (!n || !bridge) return;
    // A project — this one or another tied to it — is gone to: its desktop.
    if (n.kind === "project") { if (n.projectId) bridge.goProject(n.projectId); return; }
    if (n.place && (n.place.kind === "page" || n.place.kind === "canvas")) { bridge.openPlace(n.place.kind, n.place.project, n.place.where); return; }
    if (n.path && data) { bridge.openProjectFile(n.fileProject || data.project.id, n.path); return; }
    if (n.kind === "task" && n.id) { bridge.openTask(n.id); return; }
    if (n.id) Peek.show(n.id, api, { openPlace: (p) => bridge.openPlace(p.kind, p.project, p.where), openTask: (id) => bridge.openTask(id),
      openEvent: (c, u, s) => bridge.openEvent(c, u, s), openPerson: (id) => bridge.openPerson(id) });
  }

  // ---------------------------------------------------------------- the list

  const FIRST = 20;
  let showing = new Map();   // how many of each group are out, this load

  function drawList() {
    const q = query();
    const rows = things().filter((n) => shown(n) && matches(n, q));
    if (!data) { $("list").replaceChildren(); return; }
    if (!things().length) { $("list").replaceChildren(el("div", { class: "empty" }, "Nothing in this project yet")); return; }
    if (!rows.length) { $("list").replaceChildren(el("div", { class: "empty" }, q ? "Nothing by that name" : "Nothing of those kinds")); return; }
    const by = new Map();
    for (const n of rows) by.set(groupOf(n), [...(by.get(groupOf(n)) || []), n]);
    // Newest first; nothing dated sorts after everything dated.
    for (const list of by.values()) list.sort((a, b) => String(b.updated || "").localeCompare(String(a.updated || "")));
    $("list").replaceChildren(...LIST_ORDER.filter((k) => by.has(k)).map((k) => group(k, by.get(k))));
  }

  function group(k, rows) {
    const folded = shut.has(k);
    const head = el("div", { class: "ghead" + (folded ? " folded" : ""), onclick: () => {
      if (shut.has(k)) shut.delete(k); else shut.add(k);
      store.set("talaris.glance.shut", [...shut]); drawList();
    } }, el("span", { class: "caret" }, "▾"), el("span", {}, NAME[k]), el("span", { class: "n" }, `· ${rows.length}`));
    if (folded) return el("div", {}, head);
    const out = Math.min(rows.length, showing.get(k) || FIRST);
    const left = rows.length - out;
    const more = el("div", { class: "more" }, left > 0 ? [
      el("button", { class: "t-btn", onclick: () => { showing.set(k, out + FIRST); drawList(); } }, `${Math.min(FIRST, left)} more`),
      left > FIRST ? el("button", { class: "t-btn", onclick: () => { showing.set(k, rows.length); drawList(); } }, `All ${rows.length}`) : null,
    ] : []);
    return el("div", {}, head, rows.slice(0, out).map(row), more);
  }

  function row(n) {
    const ki = el("span", { class: "ki" });
    ki.innerHTML = KIND_ICON[groupOf(n)];
    return el("button", { class: "grow-row" + (n.own ? " own" : ""), onclick: () => open(n) },
      ki, el("span", { class: "mine" }), el("span", { class: "t" }, n.title || "Untitled"), n.how ? el("span", { class: "how" }, n.how) : null);
  }

  // ---------------------------------------------------------------- the graph

  const Graph = (() => {
    const cv = $("cv");
    const ctx = cv.getContext("2d");
    let nodes = [], edges = [], byKey = new Map(), adj = new Map();
    let vis = [], visEdges = [];          // what is drawn, after the filters
    let alpha = 0, target = 0, warm = false, laid = false, warmSeq = 0;
    let cam = { s: 1, x: 0, y: 0 };       // screen = world × s + (x, y), CSS pixels
    let W = 0, H = 0, dpr = 1;
    let hover = null, frame = 0, chosen = null;
    let pal = {};

    // The graph's look and pull, as the Display panel sets them (kept), and as they start:
    // close together, a light push, ties drawn heavy, small type.
    const DISPLAY = { size: 1.1, distance: 55, repel: 50, gravity: 9, labels: "hubs", text: 9, line: 2.25 };
    let gs = { ...DISPLAY, ...store.get("talaris.glance.display", {}) };
    const SPRING = 0.08, DAMP = 0.6, CUT2 = 520 * 520;
    const DECAY = 0.015, ALPHA_MIN = 0.002, WARM_TICKS = 300;

    // The canvas cannot read var(), so each color is resolved once per theme on a hidden element.
    function palette() {
      const probe = $("probe");
      const read = (v) => { probe.style.color = ""; probe.style.color = v; return getComputedStyle(probe).color; };
      pal = { line: read("var(--line)"), text: read("var(--text)"), muted: read("var(--muted)"), accent: read("var(--accent)"), surface: read("var(--surface)") };
      for (const [k] of GROUPS) pal[k] = read(`var(--k-${k})`);
      pal.font = getComputedStyle(document.documentElement).getPropertyValue("--font").trim() || "system-ui, sans-serif";
      need();
    }

    const radius = (n) => (isRoot(n) ? 11 : Math.min(14, 3.5 + Math.sqrt(n.deg) * 1.8)) * gs.size;

    /** A new glance: the nodes kept where they were by key, so a refresh does not throw the picture. */
    function load(d) {
      const before = byKey;
      // Walked to something already on show: the world moved so it is the middle, and the
      // camera with it, so nothing jumps — then the view glides it to the centre.
      const was0 = before.get(d.root);
      const ox = was0 ? was0.x : 0, oy = was0 ? was0.y : 0;
      if (was0 && (ox || oy)) { cam.x += ox * cam.s; cam.y += oy * cam.s; }
      byKey = new Map();
      nodes = d.nodes.map((src) => {
        const was = before.get(src.key);
        const n = { ...src, x: 0, y: 0, vx: 0, vy: 0, fx: null, fy: null, deg: 0, fresh: !was };
        if (was) { n.x = was.x - ox; n.y = was.y - oy; } else seed(n);
        if (isRoot(n)) { n.fx = 0; n.fy = 0; n.x = 0; n.y = 0; }
        byKey.set(n.key, n);
        return n;
      });
      adj = new Map(nodes.map((n) => [n.key, new Set()]));
      edges = [];
      for (const e of d.edges || []) {
        const s = byKey.get(e.from), t = byKey.get(e.to);
        if (!s || !t || s === t) continue;
        edges.push({ s, t, how: e.how });
        adj.get(s.key).add(t.key);
        adj.get(t.key).add(s.key);
      }
      for (const n of nodes) n.deg = adj.get(n.key).size;
      // What is new starts beside something it is tied to that was already placed.
      for (const n of nodes) {
        if (!n.fresh || isRoot(n)) continue;
        const by = [...adj.get(n.key)].map((k) => byKey.get(k)).find((m) => m && !m.fresh);
        if (by) { const a = Math.random() * Math.PI * 2; n.x = by.x + Math.cos(a) * gs.distance; n.y = by.y + Math.sin(a) * gs.distance; }
      }
      hover = null;
      chosen = null;
      $("gtip").hidden = true;
      // Mostly kept, it only needs stirring; mostly new, the whole warm-up.
      const kept = nodes.filter((n) => !n.fresh).length;
      const stir = laid && kept >= nodes.length / 2;
      laid = stir;
      pick();
      if (!$("graph").hidden) { show(); if (stir) { heat(0.6); glideHome(); } }
    }

    // Seeded by kind around the middle, its own nearer than what is one step out, so it settles fast.
    function seed(n) {
      const i = Math.max(0, GROUPS.findIndex(([k]) => k === groupOf(n)));
      const a = (i / GROUPS.length) * Math.PI * 2 + (Math.random() - 0.5) * 0.9;
      const r = (n.own ? 90 : 190) + Math.random() * 110;
      n.x = Math.cos(a) * r;
      n.y = Math.sin(a) * r;
    }

    function pick() {
      vis = nodes.filter(shown);
      const on = new Set(vis);
      visEdges = edges.filter((e) => on.has(e.s) && on.has(e.t));
      drawLegend();
      const g = $("gempty");
      g.hidden = vis.length > 1 || !data;
      g.textContent = data && !things().length ? "Nothing in this project yet" : "Nothing of those kinds";
    }

    function tick() {
      const n = vis.length, a = alpha;
      for (let i = 0; i < n; i++) {
        const p = vis[i];
        for (let j = i + 1; j < n; j++) {
          const q = vis[j];
          let dx = q.x - p.x, dy = q.y - p.y, d2 = dx * dx + dy * dy;
          if (d2 > CUT2) continue;
          if (d2 < 1) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; d2 = 1; }
          const f = (gs.repel * a) / d2;
          p.vx -= dx * f; p.vy -= dy * f;
          q.vx += dx * f; q.vy += dy * f;
        }
      }
      for (const e of visEdges) {
        const dx = e.t.x - e.s.x, dy = e.t.y - e.s.y;
        const d = Math.sqrt(dx * dx + dy * dy) || 1;
        // The busier end moves less, so hubs hold still and their leaves come to them.
        const l = ((d - gs.distance) / d) * a * SPRING;
        const ws = e.t.deg / (e.s.deg + e.t.deg || 1);
        e.t.vx -= dx * l * (1 - ws); e.t.vy -= dy * l * (1 - ws);
        e.s.vx += dx * l * ws; e.s.vy += dy * l * ws;
      }
      for (const p of vis) {
        if (p.fx != null) { p.x = p.fx; p.y = p.fy; p.vx = p.vy = 0; continue; }
        // Gravity, set as a whole number for the slider: 12 is a pull of 0.012.
        p.vx -= p.x * gs.gravity * 0.001 * a; p.vy -= p.y * gs.gravity * 0.001 * a;
        p.vx *= DAMP; p.vy *= DAMP;
        p.x += p.vx; p.y += p.vy;
      }
      alpha += (target - alpha) * DECAY;
    }
    const hot = () => alpha > ALPHA_MIN || target > 0;

    /** The warm-up, off-screen and a slice at a time, so the page keeps answering while it runs. */
    function warmUp() {
      const seq = ++warmSeq;
      warm = true;
      alpha = 1;
      let done = 0;
      const slice = () => {
        if (seq !== warmSeq) return;
        const t0 = performance.now();
        while (done < WARM_TICKS && performance.now() - t0 < 10) { tick(); done++; }
        if (done < WARM_TICKS) { setTimeout(slice, 0); return; }
        warm = false;
        laid = true;
        fit();
        need();
      };
      slice();
    }

    function heat(to) { alpha = Math.max(alpha, to); need(); }

    function show() {
      resize();
      // The filters may have changed while the list was on show.
      pick();
      if (!data) return;
      if (!laid && !warm) warmUp();
      else need();
    }
    function filtered() {
      pick();
      if (hover && !vis.includes(hover)) { hover = null; $("gtip").hidden = true; }
      if (laid) heat(0.3);
      else need();
    }

    // ------------------------------------------------------------ the camera

    function resize() {
      const r = $("graph").getBoundingClientRect();
      dpr = window.devicePixelRatio || 1;
      const w = Math.round(r.width), h = Math.round(r.height);
      if (w === W && h === H && cv.width === Math.round(w * dpr)) return;
      const first = !W || !H;
      // Kept centred on the same world point as it grows or shrinks.
      cam.x += (w - W) / 2; cam.y += (h - H) / 2;
      W = w; H = h;
      cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
      if (first) { cam.x = W / 2; cam.y = H / 2; if (laid) fit(); }
      need();
    }
    new ResizeObserver(resize).observe($("graph"));

    // The camera glided so the middle sits at the centre, at the zoom it is at.
    let lastClick = { node: null, at: 0, x: 0, y: 0 }, glide = 0;
    function glideHome() {
      const from = { ...cam }, to = { s: cam.s, x: W / 2, y: H / 2 };
      const t0 = performance.now(), seq = ++glide;
      const step = (t) => {
        if (seq !== glide) return;
        const k = Math.min(1, (t - t0) / 260), e = 1 - Math.pow(1 - k, 3);
        cam = { s: from.s, x: from.x + (to.x - from.x) * e, y: from.y + (to.y - from.y) * e };
        need();
        if (k < 1) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    }

    /** Everything in view, with the middle — the project, or the thing walked to — at the centre. */
    function fit() {
      if (!W || !H) return;
      const list = vis.length ? vis : nodes;
      if (!list.length) { cam = { s: 1, x: W / 2, y: H / 2 }; return; }
      // The middle is the world's origin: what is furthest from it, either way, sets the zoom.
      let rx = 1, ry = 1;
      for (const n of list) { rx = Math.max(rx, Math.abs(n.x)); ry = Math.max(ry, Math.abs(n.y)); }
      const pad = 48;
      const s = Math.max(0.2, Math.min(2, Math.min((W / 2 - pad) / rx, (H / 2 - pad) / ry)));
      cam = { s, x: W / 2, y: H / 2 };
      need();
    }
    const toWorld = (sx, sy) => [(sx - cam.x) / cam.s, (sy - cam.y) / cam.s];

    function hit(sx, sy) {
      let best = null, bestD = Infinity;
      for (const n of vis) {
        const dx = n.x * cam.s + cam.x - sx, dy = n.y * cam.s + cam.y - sy;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d < radius(n) * cam.s + 4 && d < bestD) { best = n; bestD = d; }
      }
      return best;
    }

    // ------------------------------------------------------------ drawing

    // Only while something moves or is hovered: one frame asked for at a time.
    function need() { if (!frame) frame = requestAnimationFrame(step); }
    function step() {
      frame = 0;
      if ($("graph").hidden || warm) return;
      if (hot()) { tick(); if (vis.length < 250) tick(); }
      draw();
      if (hot()) need();
    }

    function draw() {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      if (!vis.length) return;
      const q = query();
      const near = hover ? adj.get(hover.key) : null;
      const lit = (n) => (hover ? n === hover || near.has(n.key) : matches(n, q));
      const dim = Boolean(hover || q);

      ctx.save();
      ctx.translate(cam.x, cam.y);
      ctx.scale(cam.s, cam.s);
      // Ties: the quiet ones in one stroke, the lit ones over them.
      ctx.lineWidth = gs.line / cam.s;
      ctx.strokeStyle = pal.line;
      ctx.globalAlpha = dim ? 0.25 : 1;
      ctx.beginPath();
      const bright = [];
      for (const e of visEdges) {
        const on = hover ? e.s === hover || e.t === hover : q ? matches(e.s, q) && matches(e.t, q) : true;
        if (dim && on) { bright.push(e); continue; }
        ctx.moveTo(e.s.x, e.s.y); ctx.lineTo(e.t.x, e.t.y);
      }
      ctx.stroke();
      if (bright.length) {
        ctx.globalAlpha = 1;
        ctx.strokeStyle = hover ? pal.accent : pal.muted;
        ctx.lineWidth = (hover ? 1.4 : 1) * gs.line / cam.s;
        ctx.beginPath();
        for (const e of bright) { ctx.moveTo(e.s.x, e.s.y); ctx.lineTo(e.t.x, e.t.y); }
        ctx.stroke();
      }
      // Past the edge: a thing whose ties go on beyond what is shown has them as short
      // spikes in their far end's color, out away from the middle, fading to nothing.
      for (const n of vis) if (n.beyond) spikes(n, dim && !lit(n) ? 0.25 : 1);
      // Nodes: its own filled, one step out a ring, so the two read apart.
      for (const n of vis) {
        const r = radius(n), c = pal[groupOf(n)] || pal.muted;
        ctx.globalAlpha = dim && !lit(n) ? 0.25 : 1;
        ctx.beginPath();
        ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
        if (n.own || isRoot(n)) { ctx.fillStyle = c; ctx.fill(); }
        else { ctx.fillStyle = pal.surface; ctx.fill(); ctx.lineWidth = 1.6 / cam.s; ctx.strokeStyle = c; ctx.stroke(); }
        if (isRoot(n)) {
          ctx.beginPath();
          ctx.arc(n.x, n.y, r + 3.5 / cam.s, 0, Math.PI * 2);
          ctx.lineWidth = 2 / cam.s; ctx.strokeStyle = pal.accent; ctx.stroke();
        }
        // The one centred on: ringed in the accent, so where the walk is stays plain.
        if (n === chosen && !isRoot(n)) {
          ctx.beginPath();
          ctx.arc(n.x, n.y, r + 3.5 / cam.s, 0, Math.PI * 2);
          ctx.lineWidth = 2 / cam.s; ctx.strokeStyle = pal.accent; ctx.stroke();
        }
        if (n === hover) {
          ctx.beginPath();
          ctx.arc(n.x, n.y, r + 2.5 / cam.s, 0, Math.PI * 2);
          ctx.lineWidth = 1.5 / cam.s; ctx.strokeStyle = pal.text; ctx.stroke();
        }
      }
      ctx.restore();

      // Labels in screen space, so they stay crisp; their size follows the zoom within bounds.
      const size = gs.text * Math.max(0.85, Math.min(1.5, cam.s));
      ctx.font = `${size}px ${pal.font}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      ctx.fillStyle = pal.text;
      for (const n of vis) {
        // Labels: on every thing, on the busier ones (and all when zoomed in), or only as pointed at.
        const always = gs.labels === "all" || (gs.labels === "hubs" && (isRoot(n) || n.deg >= 3 || cam.s > 1.4)) || (gs.labels === "hover" && isRoot(n));
        const wanted = hover ? lit(n) && (always || n === hover || near.has(n.key)) : q ? matches(n, q) : always;
        if (!wanted) continue;
        const sx = n.x * cam.s + cam.x, sy = n.y * cam.s + cam.y + radius(n) * cam.s + 3;
        if (sx < -100 || sx > W + 100 || sy < -20 || sy > H + 20) continue;
        ctx.globalAlpha = dim && !lit(n) ? 0.25 : 1;
        const t = String(n.title || "Untitled");
        ctx.fillText(t.length > 40 ? `${t.slice(0, 38)}…` : t, sx, sy);
      }
      ctx.globalAlpha = 1;
      if (hover) placeTip();
    }

    const MOST_SPIKES = 7;
    const fade = (c, a) => { const m = String(c).match(/[\d.]+/g) || [0, 0, 0]; return `rgba(${m[0]}, ${m[1]}, ${m[2]}, ${a})`; };
    function spikes(n, alpha) {
      const kinds = Object.entries(n.beyond).map(([k, c]) => [KNOWN.has(k) ? k : "other", c]).filter(([k]) => !off.has(k));
      const total = kinds.reduce((a, [, c]) => a + c, 0);
      if (!total) return;
      // A few, shared out by how many of each kind lie past it; at least one for each kind.
      const lines = [];
      for (const [k, c] of kinds) for (let i = 0, m = Math.max(1, Math.round((c / total) * Math.min(MOST_SPIKES, total))); i < m; i++) lines.push(k);
      const out = isRoot(n) ? 0 : Math.atan2(n.y, n.x);
      const spread = isRoot(n) ? Math.PI * 2 : Math.min(Math.PI * 0.9, 0.35 * lines.length);
      const r = radius(n), len = gs.distance * 0.45;
      ctx.lineWidth = gs.line / cam.s;
      ctx.globalAlpha = alpha;
      lines.forEach((k, i) => {
        const a = out + (lines.length === 1 ? 0 : (isRoot(n) ? (i / lines.length) * spread : -spread / 2 + (i / (lines.length - 1)) * spread));
        const x0 = n.x + Math.cos(a) * r, y0 = n.y + Math.sin(a) * r;
        const x1 = n.x + Math.cos(a) * (r + len), y1 = n.y + Math.sin(a) * (r + len);
        const g = ctx.createLinearGradient(x0, y0, x1, y1);
        const c = pal[k] || pal.muted;
        g.addColorStop(0, fade(c, 0.9));
        g.addColorStop(1, fade(c, 0));
        ctx.strokeStyle = g;
        ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
      });
    }

    // "3 people, 1 task further": what the spikes stand for, in words.
    const ONE = { page: "page", canvas: "canvas", task: "task", file: "file", contact: "person", event: "event", note: "note", project: "project", other: "other" };
    const MANY = { page: "pages", canvas: "canvases", task: "tasks", file: "files", contact: "people", event: "events", note: "notes", project: "projects", other: "others" };
    const further = (b) => Object.entries(b).map(([k, c]) => `${c} ${(c === 1 ? ONE : MANY)[KNOWN.has(k) ? k : "other"]}`).join(", ") + " further";

    function placeTip() {
      const tip = $("gtip");
      const sx = hover.x * cam.s + cam.x, sy = hover.y * cam.s + cam.y;
      tip.hidden = false;
      const w = tip.offsetWidth, h = tip.offsetHeight;
      const off = radius(hover) * cam.s + 8;
      tip.style.left = `${Math.max(4, Math.min(W - w - 4, sx + off))}px`;
      tip.style.top = `${Math.max(4, Math.min(H - h - 4, sy - h - off < 4 ? sy + off : sy - h - off))}px`;
    }
    function setHover(n) {
      if (n === hover) return;
      hover = n;
      const tip = $("gtip");
      if (n) tip.replaceChildren(el("div", {}, n.title || "Untitled"), n.how && !isRoot(n) ? el("div", { class: "how" }, n.how) : null,
        n.beyond ? el("div", { class: "how" }, further(n.beyond)) : null);
      else tip.hidden = true;
      cv.classList.toggle("over", Boolean(n));
      need();
    }

    function drawLegend() {
      const have = new Set(vis.map(groupOf));
      $("legend").replaceChildren(...GROUPS.filter(([k]) => have.has(k)).map(([k, name]) =>
        el("span", {}, el("i", { style: `background: var(--k-${k})` }), name)));
    }

    // ------------------------------------------------------------ the pointer

    let press = null;   // {x, y, node, moved, cam}
    const at = (e) => { const r = cv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
    cv.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      const [x, y] = at(e);
      const node = hit(x, y);
      press = { x, y, node, moved: false, cx: cam.x, cy: cam.y };
      cv.setPointerCapture(e.pointerId);
    });
    cv.addEventListener("pointermove", (e) => {
      const [x, y] = at(e);
      if (!press) { setHover(hit(x, y)); return; }
      if (!press.moved && Math.hypot(x - press.x, y - press.y) > 4) {
        press.moved = true;
        cv.classList.add(press.node ? "dragging" : "panning");
        // Held while dragged; the simulation warmed so the rest follows it.
        if (press.node && !isRoot(press.node)) target = 0.3;
      }
      if (!press.moved) return;
      if (press.node) {
        if (isRoot(press.node)) return;
        const [wx, wy] = toWorld(x, y);
        press.node.fx = wx; press.node.fy = wy;
        heat(0.3);
      } else {
        cam.x = press.cx + (x - press.x); cam.y = press.cy + (y - press.y);
        need();
      }
    });
    const release = (e) => {
      if (!press) return;
      const p = press;
      press = null;
      cv.classList.remove("dragging", "panning");
      if (p.node && !isRoot(p.node) && p.moved) { p.node.fx = null; p.node.fy = null; target = 0; }
      // One click centres it, to walk the graph from it; a second, soon after on the same, opens it.
      // The second click is counted where the pointer is, not what is under it now: the first
      // set the view gliding, and the thing has moved from under the pointer since.
      if (e.type === "pointerup" && !p.moved) {
        const now = performance.now();
        const [x, y] = at(e);
        if (lastClick.node && now - lastClick.at < 380 && Math.hypot(x - lastClick.x, y - lastClick.y) < 8) {
          const n = lastClick.node;
          lastClick = { node: null, at: 0, x: 0, y: 0 };
          open(n);
        } else if (p.node) {
          lastClick = { node: p.node, at: now, x, y };
          // Marked at once; the glance round it follows when the core answers. The middle,
          // clicked, is already there: a second click opens it.
          if (!isRoot(p.node)) { chosen = p.node; need(); walkTo(p.node); }
        }
      }
      if (e.type === "pointerup") { const [x, y] = at(e); setHover(hit(x, y)); }
    };
    cv.addEventListener("pointerup", release);
    cv.addEventListener("pointercancel", release);
    cv.addEventListener("pointerleave", () => { if (!press) setHover(null); });
    cv.addEventListener("wheel", (e) => {
      e.preventDefault();
      const [x, y] = at(e);
      const [wx, wy] = toWorld(x, y);
      const s = Math.max(0.2, Math.min(4, cam.s * Math.exp(-e.deltaY * 0.0015)));
      // About the pointer: the world point under it stays under it.
      cam = { s, x: x - wx * s, y: y - wy * s };
      need();
    }, { passive: false });
    $("fit").addEventListener("click", fit);
    $("reset").addEventListener("click", () => reset());

    // The Display panel: each change drawn at once, the layout stirred where it moves things, and kept.
    const ROWS = [
      ["size", "Node size", 0.5, 2.5, 0.1, (v) => `${Math.round(v * 100)}%`],
      ["distance", "Link distance", 30, 200, 5, (v) => `${v}`],
      ["repel", "Repulsion", 50, 1500, 50, (v) => `${v}`],
      ["gravity", "Gravity", 0, 60, 1, (v) => `${v}`],
      ["text", "Text size", 8, 18, 1, (v) => `${v}px`],
      ["line", "Line thickness", 0.5, 4, 0.25, (v) => `${v}`],
    ];
    const MOVES = new Set(["size", "distance", "repel", "gravity"]);
    function setDisplay(key, value) {
      gs = { ...gs, [key]: value };
      store.set("talaris.glance.display", gs);
      if (MOVES.has(key)) heat(0.35);
      need();
    }
    function drawDisplay() {
      const box = $("display");
      box.replaceChildren(
        ...ROWS.map(([key, label, min, max, step, show]) => {
          const n = el("span", { class: "dv" }, show(gs[key]));
          const r = el("input", { type: "range", min, max, step, value: gs[key] });
          r.addEventListener("input", () => { setDisplay(key, Number(r.value)); n.textContent = show(gs[key]); });
          return el("label", { class: "drow" }, el("span", { class: "dl" }, label), r, n);
        }),
        el("div", { class: "drow" }, el("span", { class: "dl" }, "Labels"),
          el("span", { class: "seg dseg" }, ...[["all", "All"], ["hubs", "Main"], ["hover", "Hover"]].map(([k, l]) =>
            el("button", { class: gs.labels === k ? "on" : "", onclick: () => { setDisplay("labels", k); drawDisplay(); } }, l)))),
        el("div", { class: "drow dacts" },
          el("button", { class: "t-btn", title: "Lay it all out again from the start", onclick: () => { for (const p of nodes) if (!isRoot(p)) { p.x = (Math.random() - 0.5) * 300; p.y = (Math.random() - 0.5) * 300; } heat(1); } }, "Lay out again"),
          el("button", { class: "t-btn", title: "Back to how it came", onclick: () => { gs = { ...DISPLAY }; store.set("talaris.glance.display", gs); heat(0.35); drawDisplay(); need(); } }, "Reset")));
    }
    $("display-btn").addEventListener("click", () => {
      const box = $("display");
      box.hidden = !box.hidden;
      $("display-btn").classList.toggle("on", !box.hidden);
      if (!box.hidden) drawDisplay();
    });

    return { load, show, filtered, palette, need, fit, clear: () => { warmSeq++; warm = false; nodes = []; edges = []; vis = []; visEdges = []; byKey = new Map(); laid = false; pick(); need(); } };
  })();

  // ---------------------------------------------------------------- loading

  async function load() {
    const p = surface.project || {};
    if (!bridge) return;
    const seq = ++loadSeq;
    if (!p.id) { data = null; loadedFor = null; Graph.clear(); drawAll(); say("No project open"); return; }
    // Another project: the walk starts again from it.
    if (loadedFor !== p.id) { data = null; from = ""; trail = []; Graph.clear(); showing = new Map(); drawAll(); }
    loadedFor = p.id;
    say("Reading…");
    try {
      const got = await api("GET", `/projects/${enc(p.id)}/glance?steps=${steps}${from ? `&from=${enc(from)}` : ""}`);
      if (seq !== loadSeq) return;
      data = { project: got.project || p, root: got.root, nodes: got.nodes || [], edges: got.edges || [] };
      showing = new Map();
      say("");
      Graph.load(data);
      drawAll();
    } catch (e) { if (seq === loadSeq) failed(e); }
  }
  function drawAll() { drawProject(); drawKinds(); drawView(); drawBody(); }

  // ---------------------------------------------------------------- keys and buttons

  const typing = (t) => t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
  $("q").addEventListener("input", () => { if (view === "list") drawList(); else Graph.need(); });
  $("q").addEventListener("keydown", (e) => {
    if (e.key === "Escape" && $("q").value) { e.preventDefault(); e.stopPropagation(); $("q").value = ""; if (view === "list") drawList(); else Graph.need(); }
  });
  $("mine").addEventListener("click", () => { mine = !mine; store.set("talaris.glance.mine", mine); filtered(); });

  // How far out from the project's own things: one step is what they touch; each more,
  // what that touches in turn (the core holds each step to a few hundred).
  let steps = Number(store.get("talaris.glance.steps", 1)) || 1;
  function drawSteps() {
    $("steps").replaceChildren(el("span", { class: "steps-l" }, "Steps"), ...[1, 2, 3].map((n) =>
      el("button", { class: n === steps ? "on" : "", title: n === 1 ? (from ? "What it is tied to" : "What the project's own things touch") : `${n} steps out`,
        onclick: () => { if (n === steps) return; steps = n; store.set("talaris.glance.steps", n); drawSteps(); load(); } }, String(n))));
  }
  drawSteps();
  $("refresh").innerHTML = REFRESH;
  $("refresh").addEventListener("click", () => load());

  document.addEventListener("keydown", (e) => {
    // Peek keeps its own Escape, and says so.
    if (e.defaultPrevented) return;
    if (e.key === "Escape") { e.preventDefault(); if (bridge) bridge.file(); return; }
    if (e.key === "/" && !e.ctrlKey && !e.metaKey && !e.altKey && !typing(document.activeElement)) {
      e.preventDefault();
      $("q").focus();
      $("q").select();
    }
  });

  // A panel's one button makes it a window (the expand corners); a window's one
  // button closes it.
  $("grow").addEventListener("click", () => bridge && bridge.grow());
  $("close").addEventListener("click", () => bridge && bridge.closeWindow());
  $("grow").innerHTML = Icons.grow();
  $("grow").title = "Make it a window";
  $("grow").hidden = WINDOW;
  $("close").innerHTML = Icons.close();
  $("close").title = "Close";
  $("close").hidden = !WINDOW;
  // A press on the dim, off the panel, puts it away (and from Qt, which hears every press).
  document.addEventListener("pointerdown", (e) => { if (!WINDOW && e.target === document.documentElement && bridge && surface.up) bridge.file(); });
  window.pressedAt = (x, y) => { if (!WINDOW && bridge && surface.up && document.elementFromPoint(x, y) === document.documentElement) bridge.file(); };
  // In use: the panel's idle timer starts again.
  for (const t of ["pointerdown", "keydown", "wheel"]) addEventListener(t, () => bridge && bridge.activity(), { capture: true, passive: true });

  drawAll();

  // ---------------------------------------------------------------- coming and going

  function how() {
    const m = surface.motion || {};
    return { kind: m.motion, speed: m.speed, edge: "top", flush: false, backdrop: document.documentElement, viewport: surface.viewport,
      shown: () => bridge && bridge.drawn(),
      rules: (rule, rel, P) => { const h = document.querySelector("header").getBoundingClientRect(); rule(rel(P.left, h.bottom), rel(P.right, h.bottom)); } };
  }
  function onState(s) {
    const was = surface;
    surface = s;
    // The theme may have changed under it: the graph's colors read again.
    Graph.palette();
    const pid = (s.project && s.project.id) || null;
    const wasPid = (was.project && was.project.id) || null;
    if (WINDOW) {
      if (bridge && pid !== loadedFor) load();
      drawProject();
      return;
    }
    if (s.up && !was.up) {
      Motion.arrive(document.body, how());
      if (bridge) load();
    } else if (s.up && pid !== wasPid && bridge) load();
  }

  Surface.connect({ onState }).then((b) => {
    bridge = b;
    b.coreReply.connect((text) => { const r = JSON.parse(text); const done = waiting.get(r.id); waiting.delete(r.id); if (done) done(r); });
    b.leave.connect(() => {
      // The panel's leaving; a window is not going anywhere.
      if (WINDOW) return;
      surface = { ...surface, up: false };
      if (window.Peek) Peek.close();
      const going = Motion.leave(document.body, how());
      if (going) going.onfinish = () => bridge.left(); else bridge.left();
    });
    // The state came before the bridge was ours: what it asked for, asked now.
    if (WINDOW || surface.up) load();
  });
})();
