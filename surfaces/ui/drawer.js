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
  if (theme.accent) {
    root.style.setProperty("--accent", theme.accent);
    const n = parseInt(theme.accent.slice(1), 16);
    root.style.setProperty("--accent-wash", `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${theme.mode === "light" ? .16 : .14})`);
  }
  if (theme.font) root.style.setProperty("--font", `'${theme.font}', system-ui, sans-serif`);
}

// Slide in from the edge the drawer belongs to. The other motions in the theme
// (draw in, connect) come with the canvas; this is the default.
function arrive() {
  const from = { left: "translateX(-102%)", right: "translateX(102%)", top: "translateY(-102%)", bottom: "translateY(102%)" }[state.edge];
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  $("panel").animate([{ transform: from }, { transform: "none" }], { duration: 450, easing: "cubic-bezier(.2,.8,.2,1)" });
}

function update(next) {
  const was = state.mode;
  state = next;
  document.body.dataset.mode = state.mode;
  document.body.dataset.edge = state.edge;
  applyTheme(state.theme || {});
  $("handle").title = NAMES[state.drawer] || state.drawer;
  document.body.dataset.drawer = state.drawer;
  // Canvas: a framed grid with a card on it. Writing: lines of a page.
  $("mark").innerHTML = state.drawer === "writing"
    ? '<path d="M2 3h10M2 6h10M2 9h10M2 12h6"/>'
    : '<rect x="1.5" y="1.5" width="11" height="11" rx="2"/><rect x="4" y="4.5" width="4" height="3" rx=".6"/>';
  $("where").innerHTML = "";
  $("where").append(state.project.name || "Home", el("span", { class: "slash" }, " / "), NAMES[state.drawer] || state.drawer);
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
let chosen = null;   // the canvas picked in the tree; new canvases go inside it

async function loadCanvas() {
  const body = $("body");
  const tree = await core("GET", `/projects/${state.project.id}/canvases`);
  const top = await core("GET", `/projects/${state.project.id}/canvases/${tree.id}`);
  const shut = shutSet(CANVAS_SHUT);
  let count = 0;
  const walk = (node) => {
    count++;
    const kids = el("div", { class: "kids" });
    for (const c of node.children) kids.append(walk(c));
    return el("div", {},
      el("div", { class: "row" + (node.id === (chosen ?? tree.id) ? " on" : ""), onclick: () => { chosen = node.id; loadCanvas(); } },
        el("span", {}, twisty(node.id, node.children.length > 0, kids, shut, CANVAS_SHUT), node.title),
        el("span", { class: "label" }, node.id === tree.id ? "TOP" : "")),
      kids);
  };
  body.replaceChildren(el("div", { class: "tree", style: "flex:1" }, walk(tree)));
  $("count").textContent = `${state.project.code} · ${count} CANVAS${count === 1 ? "" : "ES"} · ${top.items.length} ITEMS`;
  const actions = [el("button", { onclick: newCanvas }, "New canvas inside")];
  if (chosen && chosen !== tree.id) {
    const find = (n) => n.id === chosen ? n : n.children.map(find).find(Boolean);
    const node = find(tree);
    if (node) actions.push(" ", el("button", { class: "danger", onclick: () => deleteCanvas(node) }, "Delete"));
  }
  $("actions").replaceChildren(...actions);
  status("");
}

function deleteCanvas(node) {
  confirmDelete(`Delete “${node.title}”?`, "Its card comes off its parent canvas. It can be brought back from its versions.", async () => {
    await core("DELETE", `/projects/${state.project.id}/canvases/${node.id}`);
    chosen = null;
    loadCanvas();
  });
}

async function newCanvas() {
  const tree = await core("GET", `/projects/${state.project.id}/canvases`);
  const parent = chosen ?? tree.id;
  await core("POST", `/projects/${state.project.id}/canvases/${parent}/children`, { title: "Untitled" });
  // Open the branch it went into, so the new one is in view.
  const shut = shutSet(CANVAS_SHUT);
  shut.delete(parent);
  try { localStorage.setItem(CANVAS_SHUT, JSON.stringify([...shut])); } catch { /* fine */ }
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
const editorModules = () => (modules ??= Promise.all([import("./notefield.js"), import("./markdown.js")])
  .then(([nf, md]) => ({ noteField: nf.noteField, render: md.render })));

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
  const { noteField, render } = await editorModules();
  if (mode === "raw") {
    const area = el("textarea", { spellcheck: "true" });
    area.value = text;
    area.addEventListener("input", () => changed(area.value));
    host.replaceChildren(area);
    area.focus();
  } else if (mode === "preview") {
    const view = el("div", { class: "preview" });
    view.append(text.trim() ? render(text) : el("p", { class: "empty" }, "Nothing written yet"));
    host.replaceChildren(view);
  } else {
    const wrap = el("div", { class: "live" });
    host.replaceChildren(wrap);
    noteField(wrap, text, changed);
  }
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
  const actions = [el("button", { onclick: () => newPage(null) }, "New page")];
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
  // The live editor uses Escape to leave a block, and a confirmation to cancel;
  // only an Escape nothing else wanted puts the drawer away.
  if (e.target.closest && e.target.closest(".note-source, .confirm")) return;
  e.preventDefault();
  if (saveTimer) save();
  bridge.file();
});
// The Super key of a compositor bind arrives as a stray keydown; it means nothing here.
addEventListener("keydown", (e) => { if (e.key === "Meta") e.stopImmediatePropagation(); }, { capture: true });
$("handle").addEventListener("click", () => bridge && bridge.toggle());
$("close").addEventListener("click", () => { if (saveTimer) save(); bridge && bridge.file(); });
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
  bridge.current((json) => update(JSON.parse(json)));
});
