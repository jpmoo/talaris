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

// Slide in from the edge the drawer belongs to. The other motions in the theme
// (draw in, connect) come with the canvas; this is the default.
const OFF = { left: "translateX(-102%)", right: "translateX(102%)", top: "translateY(-102%)", bottom: "translateY(102%)" };
const still = () => matchMedia("(prefers-reduced-motion: reduce)").matches || document.documentElement.dataset.motion === "none";

function arrive() {
  if (still()) return;
  $("panel").animate([{ transform: OFF[state.edge] }, { transform: "none" }], { duration: 450, easing: "cubic-bezier(.2,.8,.2,1)" });
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
  // back into view between the slide ending and the surface moving.
  leaving = $("panel").animate([{ transform: "none" }, { transform: OFF[state.edge] }],
    { duration: 300, easing: "cubic-bezier(.5,0,.9,.4)", fill: "forwards" });
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
