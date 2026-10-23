// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore
//
// A drawer's page. It reaches the core through `bridge` — a QWebChannel object
// in the process that holds it — never through a URL, so a write is a function
// call with a string, of any size and any characters.

"use strict";

const NAMES = { canvas: "Canvas", writing: "Writing" };
let bridge = null;
let state = { drawer: "", mode: "filed", edge: "left", project: { id: "", code: "", name: "Home" }, theme: {} };
let pending = new Map();
let nextId = 1;

function core(method, path, body) {
  return new Promise((ok, fail) => {
    const id = nextId++;
    pending.set(id, { ok, fail });
    bridge.request(id, method, path, body === undefined ? "" : typeof body === "string" ? body : JSON.stringify(body));
  });
}

function onReply(id, status, text) {
  const p = pending.get(id);
  if (!p) return;
  pending.delete(id);
  let data = text;
  try { data = JSON.parse(text); } catch { /* markdown */ }
  if (status >= 200 && status < 300) p.ok(data);
  else p.fail(new Error((data && data.error) || `status ${status}`));
}

const $ = (id) => document.getElementById(id);
function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (k === "class") e.className = v;
    else e.setAttribute(k, v);
  }
  for (const k of kids) e.append(k);
  return e;
}
function status(text) { $("status").textContent = text; }

function applyTheme(theme) {
  const root = document.documentElement;
  root.dataset.mode = theme.mode === "light" ? "light" : "dark";
  root.dataset.motion = theme.motion || "slide";
  if (theme.accent) {
    root.style.setProperty("--accent", theme.accent);
    const n = parseInt(theme.accent.slice(1), 16);
    root.style.setProperty("--accent-wash", `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${theme.mode === "light" ? .16 : .14})`);
  }
  if (theme.font) root.style.setProperty("--font", `'${theme.font}', system-ui, sans-serif`);
  const frame = document.querySelector(".canvas-frame");
  if (frame) shareTheme(frame);
}

// ---------------------------------------------------------------- motion
//
// The theme's four motions, as design/theme-tuner.html first showed them:
// slide in from the edge; draw (the frame traced, then filled); chaos (marks
// first, then lines between them in random order, direction and timing —
// always mark to mark, never loose — then filled); and none.
const OFF = { left: "translateX(-102%)", right: "translateX(102%)", top: "translateY(-102%)", bottom: "translateY(102%)" };
const motion = () => document.documentElement.dataset.motion || "slide";
const still = () => matchMedia("(prefers-reduced-motion: reduce)").matches || motion() === "none";

// Whatever a last leaving left held (it fills forwards, so the panel stays
// gone until the surface moves) is let go before anything arrives.
function unhold() {
  for (const a of $("panel").getAnimations({ subtree: true })) a.cancel();
  document.querySelectorAll(".fx").forEach((n) => n.remove());
}

function arrive() {
  unhold();
  if (still()) return;
  if (motion() === "draw" || motion() === "chaos") { trace(motion()); return; }
  $("panel").animate([{ transform: OFF[state.edge] }, { transform: "none" }], { duration: 450, easing: "cubic-bezier(.2,.8,.2,1)" });
}

/*
 * Draw and chaos are drawn once, as for a drawer on the left edge — depth
 * across, breadth down, the flush side at x = 0 — on a layer that one
 * transform turns to the edge the drawer is really on.
 */
function fxLayer() {
  const panel = $("panel");
  const Wp = panel.offsetWidth, Hp = panel.offsetHeight;
  const across = state.edge === "left" || state.edge === "right";
  const W = across ? Wp : Hp, H = across ? Hp : Wp;
  const turn = { left: "none", right: `matrix(-1,0,0,1,${Wp},0)`, top: "matrix(0,1,1,0,0,0)", bottom: `matrix(0,-1,1,0,0,${Hp})` }[state.edge];
  document.querySelectorAll(".fx").forEach((n) => n.remove());
  const fx = el("div", { class: "fx", style: `left:${panel.offsetLeft}px;top:${panel.offsetTop}px;width:${W}px;height:${H}px;transform:${turn}` });
  document.body.append(fx);
  return { fx, W, H, across };
}
function segment(fx, p, q, far) {
  const flat = p[1] === q[1];
  const s = el("div", { class: "fx-seg" });
  Object.assign(s.style, flat
    ? { left: `${Math.min(p[0], q[0])}px`, top: `${p[1] - 1}px`, width: `${Math.abs(q[0] - p[0])}px`, height: "2px", transformOrigin: far ? "right" : "left" }
    : { left: `${p[0] - 1}px`, top: `${Math.min(p[1], q[1])}px`, width: "2px", height: `${Math.abs(q[1] - p[1])}px`, transformOrigin: far ? "bottom" : "top" });
  fx.append(s);
  return [s, flat ? "scaleX" : "scaleY"];
}
function grow([s, axis], delay, duration) {
  s.animate([
    { transform: `${axis}(0)`, opacity: 1 },
    { transform: `${axis}(1)`, opacity: 1, offset: .45 },
    { transform: `${axis}(1)`, opacity: 1, offset: .8 },
    { transform: `${axis}(1)`, opacity: 0 },
  ], { duration, delay, easing: "ease-out", fill: "both" }).onfinish = () => s.remove();
}
// The panel stays empty — no fill, no frame, no contents — until the lines have done.
function fillAfter(at) {
  const panel = $("panel");
  panel.animate([{ background: "transparent", borderColor: "transparent" }, { background: "transparent", borderColor: "transparent", offset: at }, {}], { duration: 1100, easing: "ease-out" });
  for (const child of panel.children) {
    if (!child.classList.contains("xh")) child.animate([{ opacity: 0 }, { opacity: 0, offset: at }, { opacity: 1 }], { duration: 1100, easing: "ease-out" });
  }
}
/** Screen points, relative to the panel, as the left-edge frame the lines are drawn in. */
function toLocal(edge, Wp, Hp) {
  return {
    left: ([x, y]) => [x, y], right: ([x, y]) => [Wp - x, y],
    top: ([x, y]) => [y, x], bottom: ([x, y]) => [Hp - y, x],
  }[edge];
}

/*
 * The lines of this drawer, as the left-edge frame sees them: the frame (but
 * not its flush side, which has no border), split every so often so a tall
 * drawer has as many marks as the tuner's small one, and the rules inside it
 * — under the header, over the footer, beside the side column.
 */
function lines(W, H) {
  const panel = $("panel");
  const P = panel.getBoundingClientRect();
  const local = toLocal(state.edge, panel.offsetWidth, panel.offsetHeight);
  const rel = (x, y) => local([x - P.left, y - P.top]);
  const split = (p, q) => {
    const length = Math.hypot(q[0] - p[0], q[1] - p[1]);
    const n = Math.max(1, Math.round(length / 180));
    const pts = [];
    for (let i = 0; i <= n; i++) pts.push([Math.round(p[0] + (q[0] - p[0]) * i / n), Math.round(p[1] + (q[1] - p[1]) * i / n)]);
    return pts;
  };
  const paths = [split([0, 0], [W, 0]), split([0, H], [W, H]), split([W, 0], [W, H])];
  const rule = (a, b) => { if (a && b) paths.push(split(a, b)); };
  const header = document.querySelector("header"), footer = document.querySelector("footer"), side = document.querySelector(".tree");
  if (header) { const r = header.getBoundingClientRect(); rule(rel(P.left, r.bottom + 4), rel(P.right, r.bottom + 4)); }
  if (footer) { const r = footer.getBoundingClientRect(); rule(rel(P.left, r.top - 4), rel(P.right, r.top - 4)); }
  if (side && side.offsetParent) {
    const r = side.getBoundingClientRect(), b = $("body").getBoundingClientRect();
    rule(rel(r.right + 6, b.top), rel(r.right + 6, b.bottom));
  }
  // Only lines that run along one axis, as everything here is square.
  return paths.filter((pts) => pts.length > 1 && (pts[0][0] === pts.at(-1)[0] || pts[0][1] === pts.at(-1)[1]));
}

/** Draw and chaos, leaving: the reverse of arriving. Returns the animation that says when it is done. */
function untrace(kind) {
  const panel = $("panel");
  const { fx, W, H } = fxLayer();
  const paths = lines(W, H);
  const length = kind === "draw" ? 760 : 820;
  // Emptied first: contents, fill and frame, leaving only the lines.
  for (const child of panel.children) {
    if (!child.classList.contains("xh")) child.animate([{ opacity: 1 }, { opacity: 0, offset: .25 }, { opacity: 0 }], { duration: length, fill: "forwards" });
  }
  const done = panel.animate([{}, { background: "transparent", borderColor: "transparent", boxShadow: "none", offset: .25 },
    { background: "transparent", borderColor: "transparent", boxShadow: "none" }], { duration: length, fill: "forwards" });
  const shrink = ([s, axis], delay, duration) => s.animate([
    { transform: `${axis}(1)`, opacity: 0 }, { transform: `${axis}(1)`, opacity: 1, offset: .2 }, { transform: `${axis}(0)`, opacity: 1 },
  ], { duration, delay, easing: "ease-in", fill: "both" });
  if (kind === "draw") {
    // The rules inside go first, then the frame, back to the screen edge.
    paths.slice().reverse().forEach((pts, i) => shrink(segment(fx, pts[0], pts.at(-1), true), Math.min(i, paths.length - 3) * 70, 420));
  } else {
    const marks = new Map();
    const pieces = [];
    for (const pts of paths) {
      pts.forEach((p) => marks.set(p.join(","), p));
      for (let i = 1; i < pts.length; i++) pieces.push([pts[i - 1], pts[i]]);
    }
    pieces.forEach(([p, q]) => shrink(segment(fx, p, q, Math.random() < .5), Math.random() * 260, 300 + Math.random() * 220));
    for (const [x, y] of marks.values()) {
      const m = el("span", { class: "fx-mark", style: `left:${x}px;top:${y}px` });
      fx.append(m);
      m.animate([{ opacity: 0 }, { opacity: 1, offset: .3 }, { opacity: 1, offset: .75 }, { opacity: 0, transform: "scale(0)" }],
        { duration: length, fill: "both" });
    }
  }
  done.addEventListener("finish", () => fx.remove());
  return done;
}

function trace(kind) {
  const { fx, W, H } = fxLayer();
  const paths = lines(W, H);
  if (kind === "draw") {
    // Traced in order: the frame first, each side from the screen edge out,
    // then the rules inside, one after another.
    fillAfter(.66);
    paths.forEach((pts, i) => grow(segment(fx, pts[0], pts.at(-1), false), i < 2 ? 0 : 220 + (i - 2) * 120, 560));
    setTimeout(() => fx.remove(), 1400);
    return;
  }
  // Chaos: every mark first, then a line between each pair of neighbors, in
  // random order, direction and timing — always mark to mark, never loose.
  fillAfter(.72);
  const marks = new Map();
  const pieces = [];
  for (const pts of paths) {
    pts.forEach((p) => marks.set(p.join(","), p));
    for (let i = 1; i < pts.length; i++) pieces.push([pts[i - 1], pts[i]]);
  }
  const shown = [...marks.values()].map(([x, y]) => {
    const m = el("span", { class: "fx-mark", style: `left:${x}px;top:${y}px` });
    fx.append(m);
    m.animate([{ transform: "scale(0)", opacity: 0 }, { transform: "scale(1.5)", opacity: 1, offset: .6 }, { transform: "scale(1)", opacity: 1 }],
      { duration: 240, delay: Math.random() * 260, fill: "both" });
    return m;
  });
  pieces.sort(() => Math.random() - .5).forEach(([p, q]) => grow(segment(fx, p, q, Math.random() < .5), 220 + Math.random() * 520, 380 + Math.random() * 300));
  // The marks go once the lines are down, and leave nothing behind.
  setTimeout(() => {
    shown.forEach((m) => m.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 260, fill: "forwards" }));
    setTimeout(() => fx.remove(), 320);
  }, 1150);
}

/*
 * Leaving is the arrival backwards: back into the edge it came from, a little
 * quicker and accelerating, the way something is pushed away rather than
 * drawn out. Then the process is told, and moves the surface to its handle.
 */
function leave() {
  if (saveTimer) save();
  if (still() || state.mode === "filed") { bridge.left(); return; }
  // Held at the edge until the new mode arrives, so the panel never springs
  // back into view between the slide ending and the surface moving. Drawn
  // in, it goes the quiet way: it fades.
  // Drawn in, it goes the same way backwards: emptied, its lines shown, the
  // lines drawn back to their marks.
  leaving = motion() === "slide"
    ? $("panel").animate([{ transform: "none" }, { transform: OFF[state.edge] }], { duration: 300, easing: "cubic-bezier(.5,0,.9,.4)", fill: "forwards" })
    : untrace(motion());
  leaving.onfinish = () => bridge.left();
}
let leaving = null;

function update(next) {
  const was = state.mode;
  // Another project: what was open belonged to the last one.
  if (state.project && next.project && state.project.id && next.project.id !== state.project.id) {
    viewing = null;
    open = null;
    canvasTreeCache = null;
  }
  state = next;
  document.body.dataset.mode = state.mode;
  if (leaving) { leaving.cancel(); leaving = null; }
  document.body.dataset.edge = state.edge;
  const look = state.look || {};
  document.body.dataset.outline = look.outline || "focus";
  if (look.shadow === false) delete document.body.dataset.shadow; else document.body.dataset.shadow = "1";
  document.body.style.setProperty("--alpha", `${look.opacity ?? 100}%`);
  applyTheme(state.theme || {});
  $("handle").title = NAMES[state.drawer] || state.drawer;
  document.body.dataset.drawer = state.drawer;
  // Canvas: a framed grid with a card on it. Writing: lines of a page.
  $("mark").innerHTML = state.drawer === "writing"
    ? '<path d="M2 3h10M2 6h10M2 9h10M2 12h6"/>'
    : '<rect x="1.5" y="1.5" width="11" height="11" rx="2"/><rect x="4" y="4.5" width="4" height="3" rx=".6"/>';
  if (state.drawer !== "canvas") {
    $("where").innerHTML = "";
    $("where").append(state.project.name || "Home", el("span", { class: "slash" }, " / "), NAMES[state.drawer] || state.drawer);
  }
  if (state.mode !== "filed" && was === "filed") arrive();
  if (state.mode !== "filed") load();
}

// ---------------------------------------------------------------- trees

/**
 * The twisty for one node: ▾ open, ▸ shut, · no children. Which branches are
 * shut is the viewer's, not the project's, so it lives in this page's storage
 * under `store`, and survives a restart.
 */
function shutSet(store) {
  try { return new Set(JSON.parse(localStorage.getItem(store) || "[]")); } catch { return new Set(); }
}
function twisty(key, hasKids, kids, shut, store) {
  if (shut.has(key)) kids.classList.add("shut");
  const t = el("span", { class: "tw" }, hasKids ? (shut.has(key) ? "▸" : "▾") : "·");
  if (!hasKids) return t;
  t.addEventListener("click", (e) => {
    e.stopPropagation();
    kids.classList.toggle("shut");
    if (kids.classList.contains("shut")) shut.add(key); else shut.delete(key);
    try { localStorage.setItem(store, JSON.stringify([...shut])); } catch { /* fine */ }
    t.textContent = kids.classList.contains("shut") ? "▸" : "▾";
  });
  return t;
}

// ---------------------------------------------------------------- canvas

const CANVAS_SHUT = "talaris.canvas.shut";
const TREE_KEY = "talaris.canvas.tree";
const LIST_KEY = "talaris.writing.list";
let viewing = null;  // the canvas on show; new canvases go inside it
let canvasTreeCache = null;

// What the canvas frame asks for, it asks through these: only this frame can
// reach the process, so the canvas borrows its door.
window.talarisCore = (method, path, body) => core(method, path, body);
window.talarisStatus = (text) => status(text.toUpperCase().slice(0, 80));

function pathTo(tree, id, trail = []) {
  if (tree.id === id) return [...trail, tree];
  for (const c of tree.children) {
    const found = pathTo(c, id, [...trail, tree]);
    if (found) return found;
  }
  return null;
}

async function loadCanvas() {
  const tree = await core("GET", `/projects/${state.project.id}/canvases`);
  canvasTreeCache = tree;
  if (!viewing || !pathTo(tree, viewing)) viewing = tree.id;
  const trail = pathTo(tree, viewing);
  const shut = shutSet(CANVAS_SHUT);
  let count = 0;
  const walk = (node) => {
    count++;
    const kids = el("div", { class: "kids" });
    for (const c of node.children) kids.append(walk(c));
    return el("div", {},
      el("div", { class: "row" + (node.id === viewing ? " on" : ""), onclick: () => view(node.id) },
        el("span", {}, twisty(node.id, node.children.length > 0, kids, shut, CANVAS_SHUT), node.title)),
      kids);
  };

  // The trail is the header: each step goes back up to that canvas.
  const where = $("where");
  where.replaceChildren(state.project.name || "Home");
  for (const step of trail) {
    where.append(el("span", { class: "slash" }, " / "),
      el("span", { class: "crumb", onclick: () => view(step.id) }, step.id === tree.id ? "Canvas" : step.title));
  }

  const frame = el("iframe", {
    class: "canvas-frame",
    src: `canvas/index.html?project=${encodeURIComponent(state.project.id)}&canvas=${encodeURIComponent(viewing)}`,
    title: "Canvas",
  });
  frame.addEventListener("load", () => shareTheme(frame));
  const treePane = el("div", { class: "tree canvas-tree" }, walk(tree));
  $("body").replaceChildren(treePane, el("div", { class: "canvas-pane" }, frame));
  $("count").textContent = `${state.project.code} · ${count} CANVAS${count === 1 ? "" : "ES"}`;
  const actions = [
    sideToggle(treePane, TREE_KEY, "tree"),
    " ", el("button", { onclick: newCanvas }, "New canvas inside"),
  ];
  if (viewing !== tree.id) {
    const node = trail[trail.length - 1];
    actions.push(" ", el("button", { class: "danger", onclick: () => deleteCanvas(node, trail[trail.length - 2]) }, "Delete"));
  }
  $("actions").replaceChildren(...actions);
  status("");
}

/*
 * Hide or show a drawer's side column — the canvas tree, the writing list —
 * remembered per drawer. The button says what it will do next.
 */
function sideToggle(pane, key, noun) {
  const shown = () => { try { return localStorage.getItem(key) !== "off"; } catch { return true; } };
  pane.classList.toggle("hidden", !shown());
  const button = el("button", {}, "");
  const label = () => { button.textContent = `${shown() ? "Hide" : "Show"} ${noun}`; };
  button.addEventListener("click", () => {
    try { localStorage.setItem(key, shown() ? "off" : "on"); } catch { /* fine */ }
    pane.classList.toggle("hidden", !shown());
    label();
  });
  label();
  return button;
}

function view(id) {
  viewing = id;
  loadCanvas();
}

// The canvas's own theme follows the drawer's: mode, accent and typeface.
function shareTheme(frame) {
  try {
    const mine = document.documentElement;
    const theirs = frame.contentDocument.documentElement;
    theirs.dataset.mode = mine.dataset.mode || "dark";
    for (const v of ["--accent", "--accent-wash", "--font"]) {
      const value = mine.style.getPropertyValue(v);
      if (value) theirs.style.setProperty(v, value);
    }
  } catch { /* not loaded yet */ }
}

// A canvas card double-clicked inside the frame.
addEventListener("message", (e) => {
  const m = e.data;
  if (m && m.talaris === "open-url" && /^https?:/.test(m.url || "")) { bridge && bridge.openUrl(m.url); return; }
  if (m && m.talaris === "status") { status(String(m.text || "").toUpperCase().slice(0, 90)); return; }
  if (m && m.talaris === "exported") {
    // Where it went, said once, and a click away from opening.
    const full = `${m.folder}/${m.path}`;
    const said = $("status");
    said.replaceChildren(el("span", { class: "exported", title: "Open it", onclick: () => bridge && bridge.openPath(full) },
      `SAVED TO ${m.path.toUpperCase()} — OPEN ↗`));
    return;
  }
  if (!m || m.talaris !== "open-canvas") return;
  if (m.project && m.project !== state.project.id) {
    status("OTHER PROJECTS ARRIVE WITH PROJECTS");
    return;
  }
  view(m.canvas);
});

function deleteCanvas(node, parent) {
  confirmDelete(`Delete “${node.title}”?`, "Its card comes off its parent canvas. It can be brought back from its versions.", async () => {
    await core("DELETE", `/projects/${state.project.id}/canvases/${node.id}`);
    viewing = parent ? parent.id : null;
    loadCanvas();
  });
}

async function newCanvas() {
  const tree = canvasTreeCache ?? await core("GET", `/projects/${state.project.id}/canvases`);
  const parent = viewing ?? tree.id;
  await core("POST", `/projects/${state.project.id}/canvases/${parent}/children`, { title: "Untitled" });
  const shut = shutSet(CANVAS_SHUT);
  shut.delete(parent);
  try { localStorage.setItem(CANVAS_SHUT, JSON.stringify([...shut])); } catch { /* fine */ }
  // The new card lands on the canvas on show, so reload it.
  loadCanvas();
}

// ---------------------------------------------------------------- writing

/*
 * Three ways to look at a page, remembered per viewer:
 *
 * - **Live** — every block rendered except the one the caret is in, which shows
 *   its own Markdown. Talaria's editor, Obsidian's idea. The default.
 * - **Raw** — the whole file as text.
 * - **Preview** — rendered, to read.
 *
 * The text is the same in all three, and the file round-trips byte for byte:
 * the live editor rejoins its blocks exactly as they were cut.
 */
let open = null;      // path of the page being edited
let text = "";        // its Markdown, as the page holds it now
let saveTimer = null;
const WRITING_SHUT = "talaris.writing.shut";
const MODE_KEY = "talaris.writing.mode";
let mode = (() => { try { return localStorage.getItem(MODE_KEY) || "live"; } catch { return "live"; } })();
let modules = null;
// The editor is CodeMirror 6 with live preview, built from packages/editor.
const editorModules = () => (modules ??= Promise.all([import("./editor.js"), import("./markdown.js")])
  .then(([ed, md]) => ({ createEditor: ed.createEditor, render: md.render })));
let editor = null;   // the one editor, kept across Live and Raw

function changed(next) {
  text = next;
  clearTimeout(saveTimer);
  status("EDITING");
  saveTimer = setTimeout(save, 600);
}

async function drawEditor() {
  const host = $("editorHost");
  if (!host) return;
  host.dataset.mode = mode;
  for (const b of document.querySelectorAll("#modes button")) b.classList.toggle("on", b.dataset.mode === mode);
  if (!open) { host.replaceChildren(el("div", { class: "empty" }, "Pick a page, or make one")); return; }
  const { createEditor, render } = await editorModules();
  if (mode === "preview") {
    if (editor) { editor.destroy(); editor = null; }
    const view = el("div", { class: "preview" });
    view.append(text.trim() ? render(text) : el("p", { class: "empty" }, "Nothing written yet"));
    // Ticking a box in Preview writes `[ ]` ↔ `[x]` on its line and nothing else.
    for (const box of view.querySelectorAll('input[type="checkbox"]')) {
      box.disabled = false;
      box.addEventListener("change", () => {
        const lines = text.split("\n");
        const at = Number(box.dataset.line);
        lines[at] = lines[at].replace(/\[([ xX])\]/, box.checked ? "[x]" : "[ ]");
        changed(lines.join("\n"));
        drawEditor();
      });
    }
    host.replaceChildren(view);
    return;
  }
  // Live and Raw are the same editor with the preview on or off, so switching
  // between them keeps the cursor and the undo history.
  if (editor && host.contains(document.querySelector(".cm-editor"))) {
    editor.setLive(mode === "live");
  } else {
    if (editor) editor.destroy();
    host.replaceChildren();
    editor = createEditor(host, text, {
      live: mode === "live",
      onChange: changed,
      onOpenUrl: (url) => bridge && bridge.openUrl(url),
    });
  }
  editor.focus();
}

function setMode(next) {
  mode = next;
  try { localStorage.setItem(MODE_KEY, mode); } catch { /* fine */ }
  drawEditor();
}

// ---------------------------------------------------------------- daily

/*
 * Daily notes: pages at `Daily/<date>`, opened from a month calendar. A day is
 * a note once something is written in it, so opening a day makes no file.
 * Each day with a note shows how many words it holds — a number, not a dot,
 * because a number says something.
 */
const DAILY = "Daily";
const pad = (n) => String(n).padStart(2, "0");
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const today = () => iso(new Date());
let shownMonth = today().slice(0, 7);
let dailyOn = false;
const isDaily = (path) => path && path.startsWith(`${DAILY}/`);

function step(date, days) {
  const [y, m, d] = date.split("-").map(Number);
  return iso(new Date(y, m - 1, d + days));
}

async function drawCalendar() {
  const host = $("calendar");
  if (!host) return;
  const { enabled, days } = await core("GET", `/projects/${state.project.id}/daily?month=${shownMonth}`);
  dailyOn = enabled;
  const words = new Map(days.map((d) => [d.date, d.words]));
  const [y, m] = shownMonth.split("-").map(Number);
  const first = new Date(y, m - 1, 1);
  const count = new Date(y, m, 0).getDate();
  const name = first.toLocaleDateString(undefined, { month: "long", year: "numeric" });
  const openDate = isDaily(open) ? open.slice(DAILY.length + 1) : null;
  const month = (delta) => () => {
    const d = new Date(y, m - 1 + delta, 1);
    shownMonth = `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
    drawCalendar();
  };
  const grid = el("div", { class: "cal-grid" });
  for (const w of ["S", "M", "T", "W", "T", "F", "S"]) grid.append(el("span", { class: "cal-head" }, w));
  for (let i = 0; i < first.getDay(); i++) grid.append(el("span"));
  for (let day = 1; day <= count; day++) {
    const date = `${shownMonth}-${pad(day)}`;
    const n = words.get(date);
    const cls = ["cal-day", n ? "has" : "", date === today() ? "today" : "", date === openDate ? "on" : ""].filter(Boolean).join(" ");
    grid.append(el("button", { class: cls, title: n ? `${n} words` : "", onclick: () => edit(`${DAILY}/${date}`) },
      el("span", {}, String(day)), el("small", {}, n ? String(n) : "")));
  }
  host.replaceChildren(
    el("div", { class: "cal-bar" },
      el("span", { class: "label" }, "DAILY"),
      el("span", { class: "cal-nav" },
        el("button", { title: "Previous day", onclick: () => edit(`${DAILY}/${step(openDate ?? today(), -1)}`) }, "◂"),
        el("button", { onclick: () => { shownMonth = today().slice(0, 7); edit(`${DAILY}/${today()}`); } }, "TODAY"),
        el("button", { title: "Next day", onclick: () => edit(`${DAILY}/${step(openDate ?? today(), 1)}`) }, "▸"))),
    el("div", { class: "cal-month" },
      el("button", { class: "flat", onclick: month(-1) }, "‹"), el("span", { class: "label" }, name.toUpperCase()),
      el("button", { class: "flat", onclick: month(1) }, "›")),
    grid);
}

function pageHeading() {
  if (!open) return "";
  if (isDaily(open)) {
    const [y, m, d] = open.slice(DAILY.length + 1).split("-").map(Number);
    return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", year: "numeric" }).toUpperCase();
  }
  return open.split("/").join(" / ").toUpperCase();
}

async function loadWriting() {
  const daily = await core("GET", `/projects/${state.project.id}/daily?month=${shownMonth}`);
  dailyOn = daily.enabled;
  // Home opens on today.
  if (!open && dailyOn) open = `${DAILY}/${today()}`;
  if (isDaily(open)) shownMonth = open.slice(DAILY.length + 1, DAILY.length + 8);
  const pages = (await core("GET", `/projects/${state.project.id}/pages`)).filter((n) => !(dailyOn && n.path === DAILY));
  const shut = shutSet(WRITING_SHUT);
  let count = 0;
  const branch = (nodes) => {
    const wrap = el("div");
    for (const n of nodes) {
      count++;
      const kids = branch(n.children);
      kids.className = "kids";
      const twist = twisty(n.path, n.children.length > 0, kids, shut, WRITING_SHUT);
      wrap.append(el("div", {},
        el("div", { class: "row" + (n.path === open ? " on" : ""), onclick: () => edit(n.path) }, el("span", {}, twist, n.title)),
        kids));
    }
    return wrap;
  };
  const tree = el("div", { class: "tree" },
    dailyOn ? el("div", { class: "calendar", id: "calendar" }) : "",
    dailyOn ? el("div", { class: "label section" }, "PAGES") : "",
    pages.length ? branch(pages) : el("div", { class: "empty" }, "No pages yet"));
  const modes = el("div", { class: "modes", id: "modes" },
    ...["live", "raw", "preview"].map((m) => el("button", { "data-mode": m, onclick: () => setMode(m) }, m.toUpperCase())));
  const pane = el("div", { class: "pane" },
    el("div", { class: "pane-bar" }, el("span", { class: "label", id: "heading" }, pageHeading()), modes),
    el("div", { class: "editor", id: "editorHost" }));
  $("body").replaceChildren(tree, pane);
  $("count").textContent = `${state.project.code} · ${count} PAGE${count === 1 ? "" : "S"}`;
  const actions = [sideToggle(tree, LIST_KEY, "list"), " ", el("button", { onclick: () => newPage(null) }, "New page")];
  if (open && !isDaily(open)) {
    actions.push(" ", el("button", { onclick: () => newPage(open) }, "New page inside"),
      " ", el("button", { class: "danger", onclick: deletePage }, "Delete"));
  }
  $("actions").replaceChildren(...actions);
  // A day with no note yet reads as empty; the file appears when you write.
  if (open) text = await core("GET", `/projects/${state.project.id}/page?path=${encodeURIComponent(open)}`).catch(() => "");
  drawEditor();
  drawCalendar();
}

async function edit(path) {
  if (saveTimer) { clearTimeout(saveTimer); await save(); }
  if (editor) { editor.destroy(); editor = null; }
  open = path;
  loadWriting();
}

async function save() {
  saveTimer = null;
  if (!open) return;
  try {
    await core("PUT", `/projects/${state.project.id}/page?path=${encodeURIComponent(open)}`, text);
    status("SAVED");
    if (isDaily(open)) drawCalendar();
  } catch (e) {
    status("NOT SAVED");
    console.error(e);
  }
}

async function newPage(parent) {
  const made = await core("POST", `/projects/${state.project.id}/pages`, { parent, title: "Untitled" });
  if (parent) {
    const shut = shutSet(WRITING_SHUT);
    shut.delete(parent);
    try { localStorage.setItem(WRITING_SHUT, JSON.stringify([...shut])); } catch { /* fine */ }
  }
  edit(made.path);
}

function deletePage() {
  if (!open) return;
  const title = open.split("/").pop();
  confirmDelete(`Delete “${title}”?`, "It can be brought back from its versions.", async () => {
    if (saveTimer) { clearTimeout(saveTimer); await save(); }
    await core("DELETE", `/projects/${state.project.id}/page?path=${encodeURIComponent(open)}`);
    if (editor) { editor.destroy(); editor = null; }
    open = null;
    text = "";
    loadWriting();
  });
}

// ---------------------------------------------------------------- confirming

/*
 * A confirmation inside the drawer, in the theme — never the browser's own
 * dialog. The core has the last word: what it refuses (a canvas with others
 * below it, a page with pages inside) is said here in its words, and nothing
 * is deleted.
 */
function confirmDelete(title, detail, act) {
  const said = el("p", { class: "said" });
  const close = () => sheet.remove();
  const yes = el("button", { class: "danger" }, "Delete");
  const sheet = el("div", { class: "confirm", role: "dialog" },
    el("div", { class: "box" },
      el("div", { class: "title" }, title),
      el("p", {}, detail),
      said,
      el("div", { class: "buttons" }, el("button", { onclick: close }, "Cancel"), " ", yes)));
  yes.addEventListener("click", async () => {
    try {
      await act();
      close();
    } catch (e) {
      said.textContent = e.message;
      yes.remove();
    }
  });
  sheet.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.stopPropagation(); close(); } });
  $("panel").append(sheet);
  sheet.querySelector("button").focus();
}

// ---------------------------------------------------------------- the rest

async function load() {
  if (!state.project.id) { status("CORE NOT ANSWERING"); return; }
  try {
    if (state.drawer === "canvas") await loadCanvas();
    else if (state.drawer === "writing") await loadWriting();
  } catch (e) {
    status("CORE NOT ANSWERING");
    console.error(e);
  }
}

// The ways back that live in the page: Escape, and telling the process about
// input so its idle timeout counts from the last of it.
let lastTouch = 0;
function touched() {
  const now = Date.now();
  if (now - lastTouch < 2000 || !bridge) return;
  lastTouch = now;
  bridge.activity();
}
for (const type of ["pointerdown", "keydown", "wheel", "pointermove"]) addEventListener(type, touched, { passive: true, capture: true });
addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || state.mode !== "pulled") return;
  // A confirmation takes Escape to cancel; only an Escape nothing else wanted
  // puts the drawer away.
  if (e.target.closest && e.target.closest(".confirm")) return;
  e.preventDefault();
  if (saveTimer) save();
  bridge.file();
});
// The Super key of a compositor bind arrives as a stray keydown; it means nothing here.
addEventListener("keydown", (e) => { if (e.key === "Meta") e.stopImmediatePropagation(); }, { capture: true });
$("handle").addEventListener("click", () => bridge && bridge.toggle());
$("tuck").addEventListener("click", () => { if (saveTimer) save(); bridge && bridge.file(); });
/*
 * Right-click in the writing editor: the drawer's own small menu, never the
 * engine's. Everywhere else in the drawer a right-click does nothing; the
 * canvas, in its own frame, has its own menu.
 */
let menu = null;
function closeMenu() { if (menu) { menu.remove(); menu = null; } }
addEventListener("contextmenu", (e) => {
  e.preventDefault();
  closeMenu();
  if (!e.target.closest || !e.target.closest(".editor .cm-editor")) return;
  const picked = (document.getSelection()?.toString() ?? "").length > 0;
  const item = (label, command, on = true) =>
    el("button", { class: "menu-item" + (on ? "" : " off"), onclick: () => {
      closeMenu();
      if (!on) return;
      editor && editor.focus();
      document.execCommand(command);
    } }, label);
  menu = el("div", { class: "context" },
    item("Cut", "cut", picked), item("Copy", "copy", picked), item("Paste", "paste"),
    el("div", { class: "menu-sep" }), item("Select all", "selectAll"));
  menu.style.left = `${e.clientX}px`;
  menu.style.top = `${e.clientY}px`;
  document.body.append(menu);
  // Keep it on screen.
  const r = menu.getBoundingClientRect();
  if (r.right > innerWidth) menu.style.left = `${innerWidth - r.width - 4}px`;
  if (r.bottom > innerHeight) menu.style.top = `${innerHeight - r.height - 4}px`;
});
addEventListener("pointerdown", (e) => { if (menu && !menu.contains(e.target)) closeMenu(); }, true);
addEventListener("keydown", (e) => { if (e.key === "Escape" && menu) { e.stopImmediatePropagation(); closeMenu(); } }, true);

// A link opens in the browser, not in the drawer.
addEventListener("click", (e) => {
  const a = e.target.closest && e.target.closest("a[href]");
  if (!a || !/^https?:/.test(a.href)) return;
  e.preventDefault();
  bridge && bridge.openUrl(a.href);
}, true);
// The drawer you are in shows it — two pulled out at once must not look alike.
addEventListener("focus", () => { document.body.dataset.focus = "1"; });
addEventListener("blur", () => { delete document.body.dataset.focus; });
if (document.hasFocus()) document.body.dataset.focus = "1";

new QWebChannel(qt.webChannelTransport, (channel) => {
  bridge = channel.objects.bridge;
  bridge.replied.connect(onReply);
  bridge.state.connect((json) => update(JSON.parse(json)));
  bridge.leave.connect(leave);
  // The launcher found a canvas or a page: open on it. If the drawer is on its
  // way out, arriving will load it; if it is already out, load it now.
  bridge.show.connect((json) => {
    const target = JSON.parse(json);
    if (state.drawer === "canvas" && target.canvas) {
      viewing = target.canvas;
      if (state.mode !== "filed") loadCanvas();
    } else if (state.drawer === "writing" && target.page) {
      if (state.mode !== "filed") edit(target.page);
      else open = target.page;
    }
  });
  bridge.current((json) => update(JSON.parse(json)));
});
