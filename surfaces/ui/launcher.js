// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore
//
// The launcher's page. The process hands over everything there is when the
// launcher opens; this ranks it as you type and says what was chosen.
//
// From Talaria's KRunner, kept: an unprefixed query matches titles only (an
// application's keywords count, weakly), and forty are ranked to show ten.

"use strict";

const $ = (id) => document.getElementById(id);
let bridge = null;
let state = { up: false, mode: "" };
let items = [];
let shown = [];
let at = 0;
let armed = null;

const SHOW = 10;
const RANK = 40;
const PICKS = "talaris.launcher.picks";

// What can be done, by name. Logging out, restarting and shutting down ask
// for a second Enter, as the power menu asks for a second press.
const VERBS = [
  { name: "canvas", title: "Canvas", sub: "Pull out the canvas drawer" },
  { name: "writing", title: "Writing", sub: "Pull out the writing drawer" },
  { name: "file-all", title: "Put the drawers away" },
  { name: "settings", title: "Settings", sub: "Appearance, layout, keys, Morgan" },
  { name: "network", title: "Wi-Fi", sub: "Networks in reach" },
  { name: "bluetooth", title: "Bluetooth", sub: "Devices" },
  { name: "lock", title: "Lock" },
  { name: "suspend", title: "Suspend" },
  { name: "logout", title: "Log out", ask: true },
  { name: "restart", title: "Restart", ask: true },
  { name: "shutdown", title: "Shut down", ask: true },
];

// How much each kind is worth before the words are compared. Projects are
// where you go; windows are already open; files are many and come last.
const WEIGHT = { project: 25, window: 15, canvas: 12, page: 12, app: 10, verb: 8, file: 0 };
const KIND = { project: "PROJECT", window: "WINDOW", canvas: "CANVAS", page: "PAGE", app: "APP", verb: "DO", file: "FILE", morgan: "MORGAN" };

$("glass").innerHTML = Icons.search();

function picks() { try { return JSON.parse(localStorage.getItem(PICKS) || "{}"); } catch { return {}; } }
function remember(key) {
  const p = picks();
  p[key] = (p[key] || 0) + 1;
  try { localStorage.setItem(PICKS, JSON.stringify(p)); } catch { /* fine */ }
}

function build(c) {
  const icon = (name) => (name ? `talaris-ui://icon/?n=${encodeURIComponent(name)}` : "");
  items = [
    ...c.projects.map((p) => ({ kind: "project", key: `project:${p.id}`, title: p.title, sub: p.code, act: { kind: "project", id: p.id },
      current: p.id === (c.project || {}).id })),
    ...c.windows.map((w) => ({ kind: "window", key: `window:${w.address}`, title: w.title, sub: `${w.app} · ${w.where}`, img: icon(w.icon),
      recent: w.recent, act: { kind: "window", address: w.address } })),
    ...c.canvases.map((x) => ({ kind: "canvas", key: `canvas:${x.id}`, title: x.title, sub: x.where, act: { kind: "canvas", id: x.id } })),
    ...c.pages.map((x) => ({ kind: "page", key: `page:${x.path}`, title: x.title, sub: x.where, act: { kind: "page", path: x.path } })),
    ...c.apps.map((a) => ({ kind: "app", key: `app:${a.id}`, title: a.name, also: a.also, img: icon(a.icon), act: { kind: "app", id: a.id } })),
    ...VERBS.map((v) => ({ kind: "verb", key: `verb:${v.name}`, title: v.title, sub: v.sub || "", ask: v.ask, act: { kind: "verb", name: v.name } })),
    ...c.files.map((f) => ({ kind: "file", key: `file:${f.path}`, title: f.title, sub: f.where, act: { kind: "file", path: f.path } })),
  ];
}

/** How well `q` names `text`: 0 for not at all. */
function score(q, text) {
  const t = (text || "").toLowerCase();
  if (!t) return 0;
  if (t === q) return 100;
  if (t.startsWith(q)) return 80;
  const i = t.indexOf(q);
  if (i > 0 && /[\s\-_./›]/.test(t[i - 1])) return 60;
  if (i > 0) return 40;
  // The letters in order — "lbo" for LibreOffice — only for a few letters,
  // where typing a word's start is what people actually do.
  if (q.length >= 2 && q.length <= 5) {
    let k = 0;
    for (const ch of t) if (ch === q[k]) k++;
    if (k === q.length) return 15;
  }
  return 0;
}

function rank(query) {
  const q = query.trim().toLowerCase();
  const p = picks();
  if (state.mode === "ask") return [];
  if (!q) {
    // Nothing typed: where you were — open windows, most recent first.
    return items.filter((x) => x.kind === "window").sort((a, b) => a.recent - b.recent).slice(0, SHOW);
  }
  const found = [];
  for (const x of items) {
    let s = score(q, x.title);
    if (!s && x.also) s = Math.min(20, score(q, x.also));
    if (!s) continue;
    found.push([s + WEIGHT[x.kind] + Math.min(20, 5 * (p[x.key] || 0)) + (x.current ? 5 : 0), x, s]);
  }
  // Letters merely in order, or a keyword, are for when nothing names it
  // better; beside a real match they are noise.
  const real = found.some(([, , s]) => s >= 40);
  const kept = real ? found.filter(([, , s]) => s >= 40) : found;
  kept.sort((a, b) => b[0] - a[0]);
  return kept.slice(0, RANK).slice(0, SHOW).map(([, x]) => x);
}

function mark(title, query) {
  const q = query.trim();
  const span = document.createElement("span");
  span.className = "title";
  const i = q ? title.toLowerCase().indexOf(q.toLowerCase()) : -1;
  if (i < 0) { span.textContent = title; return span; }
  const b = document.createElement("b");
  b.textContent = title.slice(i, i + q.length);
  span.append(title.slice(0, i), b, title.slice(i + q.length));
  return span;
}

const GLYPH = {
  project: () => '<svg class="ic" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M2 4.5h4l1.5 1.5H14v6.5H2z"/></svg>',
  canvas: () => '<svg class="ic" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="2" width="12" height="12" rx="2"/><rect x="5" y="5.5" width="4.5" height="3.5" rx=".6"/></svg>',
  page: () => '<svg class="ic" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M3 4h10M3 7h10M3 10h10M3 13h6"/></svg>',
  file: () => '<svg class="ic" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M4 1.5h5.5L12.5 4.5v10h-8.5z"/><path d="M9.5 1.5v3h3"/></svg>',
  verb: () => '<svg class="ic" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8h9M9 4.5 12.5 8 9 11.5"/></svg>',
  morgan: () => Icons.morgan(),
  app: () => GLYPH.verb(), window: () => GLYPH.verb(),
};

function draw() {
  const query = $("q").value;
  shown = rank(query);
  if (query.trim()) {
    shown.push({ kind: "morgan", title: query.trim(), sub: "Ask Morgan", act: { kind: "morgan", text: query.trim() } });
  }
  // Nothing found: the question is the only thing, so it is the one chosen.
  at = Math.min(at, Math.max(0, shown.length - 1));
  if (shown.length === 1) at = 0;
  const list = $("list");
  list.replaceChildren(...shown.map((x, i) => {
    const row = document.createElement("div");
    row.className = "item" + (i === at ? " on" : "") + (armed === x.key ? " armed" : "");
    const icon = document.createElement("span");
    icon.className = "icon";
    if (x.img) {
      const img = document.createElement("img");
      img.src = x.img;
      img.alt = "";
      img.addEventListener("error", () => { icon.innerHTML = GLYPH[x.kind](); });
      icon.append(img);
    } else icon.innerHTML = GLYPH[x.kind]();
    const text = document.createElement("span");
    text.className = "text";
    text.append(x.kind === "morgan" ? Object.assign(document.createElement("span"), { className: "title", textContent: x.title })
      : mark(armed === x.key ? `${x.title} — Enter again` : x.title, query));
    if (x.sub) text.append(Object.assign(document.createElement("span"), { className: "sub", textContent: x.sub }));
    const kind = Object.assign(document.createElement("span"), { className: "kind", textContent: KIND[x.kind] });
    row.append(icon, text, kind);
    row.addEventListener("mousemove", () => { if (at !== i) { at = i; draw(); } });
    row.addEventListener("click", () => choose(i));
    return row;
  }));
  const on = list.children[at];
  if (on) on.scrollIntoView({ block: "nearest" });
}

function say(text, error = false) {
  $("msg").replaceChildren(text ? Object.assign(document.createElement("span"), { className: error ? "err" : "", textContent: text }) : "");
}

function choose(i) {
  const x = shown[i];
  if (!x || !bridge) return;
  if (x.ask && armed !== x.key) { armed = x.key; draw(); return; }
  armed = null;
  if (x.key) remember(x.key);
  if (x.kind === "morgan") say("Asking Morgan…");
  bridge.act(JSON.stringify(x.act), (error) => { if (error) say(error, true); });
}

$("q").addEventListener("input", () => { at = 0; armed = null; say(""); draw(); });
addEventListener("keydown", (e) => {
  if (!bridge) return;
  bridge.activity();
  const n = shown.length;
  if (e.key === "Escape") { e.preventDefault(); bridge.file(); }
  else if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "n")) { e.preventDefault(); if (n) { at = (at + 1) % n; armed = null; draw(); } }
  else if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p")) { e.preventDefault(); if (n) { at = (at - 1 + n) % n; armed = null; draw(); } }
  else if (e.key === "Enter") { e.preventDefault(); choose(at); }
});
// A press outside the box puts it away.
addEventListener("pointerdown", (e) => { if (bridge && !e.target.closest("#box")) bridge.file(); });

function onState(s) {
  state = s;
  if (!s.up) return;
  // Each opening starts clean, with a fresh look at what there is.
  $("q").value = "";
  at = 0;
  armed = null;
  say("");
  $("q").placeholder = s.mode === "ask" ? "Ask Morgan" : "Find anything, or ask";
  $("scope").textContent = s.mode === "ask" ? "MORGAN" : (s.project && s.project.name) || "";
  items = [];
  draw();
  if (bridge) bridge.catalog((text) => { build(JSON.parse(text)); draw(); });
  // After the surface has the keyboard, which it gets as it appears.
  setTimeout(() => $("q").focus(), 30);
}

Surface.connect({ onState: (s) => onState(s) }).then((b) => {
  bridge = b;
  if (state.up) b.catalog((text) => { build(JSON.parse(text)); draw(); });
});
