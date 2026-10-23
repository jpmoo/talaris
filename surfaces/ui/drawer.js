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
  $("where").innerHTML = "";
  $("where").append(state.project.name || "Home", el("span", { class: "slash" }, " / "), NAMES[state.drawer] || state.drawer);
  if (state.mode !== "filed" && was === "filed") arrive();
  if (state.mode !== "filed") load();
}

// ---------------------------------------------------------------- canvas

async function loadCanvas() {
  const body = $("body");
  const tree = await core("GET", `/projects/${state.project.id}/canvases`);
  const top = await core("GET", `/projects/${state.project.id}/canvases/${tree.id}`);
  let count = 0;
  const walk = (node, depth) => {
    count++;
    const kids = el("div", { class: "kids" });
    for (const c of node.children) kids.append(walk(c, depth + 1));
    return el("div", {},
      el("div", { class: "row" },
        el("span", {}, el("span", { class: "tw" }, node.children.length ? "▾" : "·"), node.title),
        el("span", { class: "label" }, node.id === tree.id ? "TOP" : "")),
      kids);
  };
  body.replaceChildren(el("div", { class: "tree", style: "flex:1" }, walk(tree, 0)));
  $("count").textContent = `${state.project.code} · ${count} CANVAS${count === 1 ? "" : "ES"} · ${top.items.length} ITEMS`;
  $("actions").replaceChildren(el("button", { onclick: newCanvas }, "New canvas"));
  status("");
}

async function newCanvas() {
  const tree = await core("GET", `/projects/${state.project.id}/canvases`);
  await core("POST", `/projects/${state.project.id}/canvases/${tree.id}/children`, { title: "Untitled" });
  loadCanvas();
}

// ---------------------------------------------------------------- writing

let open = null;      // path of the page in the editor
let saveTimer = null;
const shut = new Set(JSON.parse(localStorage.getItem("talaris.writing.shut") || "[]"));

async function loadWriting() {
  const pages = await core("GET", `/projects/${state.project.id}/pages`);
  let count = 0;
  const branch = (nodes) => {
    const wrap = el("div");
    for (const n of nodes) {
      count++;
      const kids = branch(n.children);
      kids.className = "kids" + (shut.has(n.path) ? " shut" : "");
      const twist = el("span", { class: "tw", onclick: (e) => {
        e.stopPropagation();
        if (!n.children.length) return;
        kids.classList.toggle("shut");
        if (kids.classList.contains("shut")) shut.add(n.path); else shut.delete(n.path);
        // Which branches are open is the viewer's, not the project's.
        try { localStorage.setItem("talaris.writing.shut", JSON.stringify([...shut])); } catch { /* fine */ }
        twist.textContent = kids.classList.contains("shut") ? "▸" : "▾";
      } }, n.children.length ? (shut.has(n.path) ? "▸" : "▾") : "·");
      wrap.append(el("div", {},
        el("div", { class: "row" + (n.path === open ? " on" : ""), onclick: () => edit(n.path) }, el("span", {}, twist, n.title)),
        kids));
    }
    return wrap;
  };
  const tree = el("div", { class: "tree" }, pages.length ? branch(pages) : el("div", { class: "empty" }, "No pages yet"));
  const editor = el("textarea", { id: "editor", placeholder: open ? "" : "Pick a page, or make one", spellcheck: "true" });
  if (!open) editor.disabled = true;
  editor.addEventListener("input", () => {
    clearTimeout(saveTimer);
    status("EDITING");
    saveTimer = setTimeout(save, 600);
  });
  $("body").replaceChildren(tree, editor);
  $("count").textContent = `${state.project.code} · ${count} PAGE${count === 1 ? "" : "S"}`;
  $("actions").replaceChildren(
    el("button", { onclick: () => newPage(null) }, "New page"),
    " ",
    el("button", { onclick: () => open && newPage(open) }, "New page inside"));
  if (open) {
    editor.value = await core("GET", `/projects/${state.project.id}/page?path=${encodeURIComponent(open)}`);
    editor.focus();
  }
}

async function edit(path) {
  if (saveTimer) { clearTimeout(saveTimer); await save(); }
  open = path;
  loadWriting();
}

async function save() {
  saveTimer = null;
  const editor = $("editor");
  if (!open || !editor) return;
  try {
    await core("PUT", `/projects/${state.project.id}/page?path=${encodeURIComponent(open)}`, editor.value);
    status("SAVED");
  } catch (e) {
    status("NOT SAVED");
    console.error(e);
  }
}

async function newPage(parent) {
  const made = await core("POST", `/projects/${state.project.id}/pages`, { parent, title: "Untitled" });
  if (parent) shut.delete(parent);
  edit(made.path);
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
  if (e.key === "Escape" && state.mode === "pulled") { e.preventDefault(); if (saveTimer) save(); bridge.file(); }
});
// The Super key of a compositor bind arrives as a stray keydown; it means nothing here.
addEventListener("keydown", (e) => { if (e.key === "Meta") e.stopImmediatePropagation(); }, { capture: true });
$("handle").addEventListener("click", () => bridge && bridge.toggle());

new QWebChannel(qt.webChannelTransport, (channel) => {
  bridge = channel.objects.bridge;
  bridge.replied.connect(onReply);
  bridge.state.connect((json) => update(JSON.parse(json)));
  bridge.current((json) => update(JSON.parse(json)));
});
