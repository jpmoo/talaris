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
const KIND = { sum: "=", project: "PROJECT", window: "WINDOW", canvas: "CANVAS", page: "PAGE", app: "APP", verb: "DO", file: "FILE", morgan: "MORGAN", conversation: "SAID" };
// Past conversations with Morgan for what is typed, asked for once typing
// pauses: the query is embedded by Morgan, where it runs, never here. Shown
// after what the launcher found itself, before the question to Morgan.
const TALKED = 3;
let talked = { query: "", results: [] };
let talkSoon = null;

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
  sum: () => '<svg class="ic" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M3.5 6h9M3.5 10h9"/></svg>',
  project: () => '<svg class="ic" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M2 4.5h4l1.5 1.5H14v6.5H2z"/></svg>',
  canvas: () => '<svg class="ic" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="2" width="12" height="12" rx="2"/><rect x="5" y="5.5" width="4.5" height="3.5" rx=".6"/></svg>',
  page: () => '<svg class="ic" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M3 4h10M3 7h10M3 10h10M3 13h6"/></svg>',
  file: () => '<svg class="ic" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M4 1.5h5.5L12.5 4.5v10h-8.5z"/><path d="M9.5 1.5v3h3"/></svg>',
  verb: () => '<svg class="ic" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8h9M9 4.5 12.5 8 9 11.5"/></svg>',
  morgan: () => Icons.morgan(),
  conversation: () => '<svg class="ic" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z"/></svg>',
  app: () => GLYPH.verb(), window: () => GLYPH.verb(),
};

/*
 * Arithmetic, worked out as it is typed: + - * / ^ and parentheses, × ÷ and
 * "x" between numbers, a trailing % ("15% of 80", "80 + 15%"), and a few
 * functions (sqrt, abs, round, floor, ceil, sin, cos, tan, log, ln, pi).
 * Its own small parser — never `eval` — so text is only ever numbers.
 */
const FUNCS = { sqrt: Math.sqrt, abs: Math.abs, round: Math.round, floor: Math.floor, ceil: Math.ceil,
  sin: Math.sin, cos: Math.cos, tan: Math.tan, log: Math.log10, ln: Math.log };

function sum(text) {
  let s = text.toLowerCase().replace(/[×x]/g, (c, i, all) => (/[\d)\s]/.test(all[i - 1] ?? "") ? "*" : c)).replace(/÷/g, "/").replace(/,/g, "").trim();
  s = s.replace(/^=\s*/, "");
  // "15% of 80" is 15/100*80.
  s = s.replace(/(\d+(?:\.\d+)?)\s*%\s*of\s*/g, "($1/100)*");
  if (!/[\d)]/.test(s) || !/[-+*/^%(]|sqrt|abs|round|floor|ceil|sin|cos|tan|log|ln|pi/.test(s)) return null;
  const tokens = s.match(/\d*\.?\d+(?:e[-+]?\d+)?|[a-z]+|[-+*/^%()]/g);
  if (!tokens || tokens.join("") !== s.replace(/\s+/g, "")) return null;
  let i = 0;
  const peek = () => tokens[i];
  const next = () => tokens[i++];
  // Lowest first: + and -; then * and /; then ^ (right to left); then a number, a function, or a bracket.
  function expr() {
    let v = term();
    while (peek() === "+" || peek() === "-") {
      const op = next();
      // "80 + 15%" is 80 plus fifteen percent of 80.
      let r = term(true);
      if (r.pct) r = { v: v.v * r.v / 100 };
      v = { v: op === "+" ? v.v + r.v : v.v - r.v };
    }
    return v;
  }
  function term(afterSign = false) {
    let v = power(afterSign);
    while (peek() === "*" || peek() === "/") {
      const op = next();
      const r = power();
      v = { v: op === "*" ? v.v * r.v : v.v / r.v };
    }
    return v;
  }
  function power(afterSign = false) {
    const b = unary(afterSign);
    if (peek() === "^") { next(); const e = power(); return { v: Math.pow(b.v, e.v) }; }
    return b;
  }
  function unary(afterSign) {
    if (peek() === "-") { next(); return { v: -unary(afterSign).v }; }
    if (peek() === "+") { next(); return unary(afterSign); }
    let v = atom();
    if (peek() === "%") { next(); v = afterSign ? { v: v.v, pct: true } : { v: v.v / 100 }; }
    return v;
  }
  function atom() {
    const t = next();
    if (t === undefined) throw new Error("short");
    if (t === "(") { const v = expr(); if (next() !== ")") throw new Error("bracket"); return v; }
    if (t === "pi") return { v: Math.PI };
    if (t === "e") return { v: Math.E };
    if (FUNCS[t]) { if (next() !== "(") throw new Error("call"); const v = expr(); if (next() !== ")") throw new Error("bracket"); return { v: FUNCS[t](v.v) }; }
    if (/^\d*\.?\d+(e[-+]?\d+)?$/.test(t)) return { v: parseFloat(t) };
    throw new Error("word");
  }
  try {
    const v = expr();
    if (i !== tokens.length || !Number.isFinite(v.v)) return null;
    return v.v;
  } catch {
    return null;
  }
}

// A result as people write it: no float noise, grouped digits for big ones.
function figure(v) {
  const r = Math.round(v * 1e10) / 1e10;
  return Math.abs(r) >= 1e15 || (r !== 0 && Math.abs(r) < 1e-6) ? r.toExponential(6) : r.toLocaleString(undefined, { maximumFractionDigits: 10 });
}

function draw() {
  const query = $("q").value;
  shown = rank(query);
  const worked = sum(query);
  if (worked !== null) {
    const plain = String(Math.round(worked * 1e10) / 1e10);
    shown.unshift({ kind: "sum", title: figure(worked), sub: "Enter copies it", act: { kind: "copy", text: plain } });
  }
  if (query.trim() && talked.query === query.trim().replace(/\s+/g, " ")) {
    for (const r of talked.results.slice(0, TALKED)) {
      shown.push({ kind: "conversation", key: `conversation:${r.id}`, title: r.title, sub: `${r.when}${r.said ? ` · “${r.said.slice(0, 80)}”` : ""}`,
        act: { kind: "conversation", id: r.id } });
    }
  }
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
    text.append(x.kind === "morgan" || x.kind === "sum" ? Object.assign(document.createElement("span"), { className: "title", textContent: x.title })
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

// `there`: Shift+Enter — an application already open in another project is gone to, not brought here.
function choose(i, there = false) {
  const x = shown[i];
  if (!x || !bridge) return;
  if (x.ask && armed !== x.key) { armed = x.key; draw(); return; }
  armed = null;
  if (x.key) remember(x.key);
  if (x.kind === "morgan") say("Asking Morgan…");
  bridge.act(JSON.stringify(there && x.act.kind === "app" ? { ...x.act, there: true } : x.act), (error) => { if (error) say(error, true); });
}

$("q").addEventListener("input", () => {
  at = 0; armed = null; say(""); draw();
  clearTimeout(talkSoon);
  const q = $("q").value.trim().replace(/\s+/g, " ");
  if (q.length >= 3 && state.mode !== "ask") talkSoon = setTimeout(() => bridge && bridge.morganSearch(q), 350);
});
addEventListener("keydown", (e) => {
  if (!bridge) return;
  bridge.activity();
  const n = shown.length;
  if (e.key === "Escape") { e.preventDefault(); bridge.file(); }
  else if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "n")) { e.preventDefault(); if (n) { at = (at + 1) % n; armed = null; draw(); } }
  else if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p")) { e.preventDefault(); if (n) { at = (at - 1 + n) % n; armed = null; draw(); } }
  else if (e.key === "Enter") { e.preventDefault(); choose(at, e.shiftKey); }
});
// A press outside the box puts it away — heard here, and from Qt (sensor.Presses).
addEventListener("pointerdown", (e) => { if (bridge && state.up && !e.target.closest("#box")) bridge.file(); });
window.pressedAt = (x, y) => { const at = document.elementFromPoint(x, y); if (bridge && state.up && !(at && at.closest("#box"))) bridge.file(); };

// How it comes and goes (motion.js): from the top, over the dimmed screen,
// with the lines under the field and over the foot drawn too.
function how() {
  const m = state.motion || {};
  return {
    kind: m.motion, speed: m.speed, edge: "top", flush: false, backdrop: document.body, viewport: state.viewport,
    shown: () => { $("q").focus(); if (bridge) bridge.drawn(); },
    rules: (rule, rel, P) => {
      const top = $("top").getBoundingClientRect(), foot = $("foot").getBoundingClientRect();
      rule(rel(P.left, top.bottom), rel(P.right, top.bottom));
      rule(rel(P.left, foot.top), rel(P.right, foot.top));
    },
  };
}

function onState(s) {
  const was = state.up;
  state = s;
  if (!s.up) return;
  if (!was) Motion.arrive($("box"), how());
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
  focusSoon();
}

/*
 * Typing goes to the box at once. The box cannot take focus while the panel
 * is still hidden for its arrival, so this tries until it holds — and anything
 * typed before then is put in the box rather than lost (below).
 */
function focusSoon() {
  let tries = 0;
  const go = () => {
    if (!state.up) return;
    $("q").focus();
    if (document.activeElement !== $("q") && ++tries < 25) setTimeout(go, 40);
  };
  setTimeout(go, 0);
}
addEventListener("focus", () => { if (state.up) $("q").focus(); });
addEventListener("keydown", (e) => {
  if (!state.up || document.activeElement === $("q") || e.ctrlKey || e.metaKey || e.altKey || e.key.length !== 1) return;
  e.preventDefault();
  $("q").focus();
  $("q").value += e.key;
  $("q").dispatchEvent(new Event("input"));
}, true);

Surface.connect({ onState: (s) => onState(s) }).then((b) => {
  bridge = b;
  // An answer for what is still typed is drawn; one for an older query is dropped.
  b.morganFound.connect((text) => {
    const found = JSON.parse(text);
    if (found.query !== $("q").value.trim().replace(/\s+/g, " ")) return;
    talked = found;
    draw();
  });
  // Going: played, then the process is told, and takes the surface away.
  b.leave.connect(() => {
    // Gone as far as an opening is concerned: one during the leaving arrives afresh.
    state = { ...state, up: false };
    const going = Motion.leave($("box"), how());
    if (going) going.onfinish = () => bridge.left(); else bridge.left();
  });
  if (state.up) b.catalog((text) => { build(JSON.parse(text)); draw(); });
});
