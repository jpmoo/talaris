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
  { name: "glance", title: "Glance", sub: "This project, all of it: a list, or a graph of how it is connected" },
  { name: "archive", title: "Archive", sub: "Archived projects: browse them, search them, bring one back" },
  { name: "settings", title: "Talaris Settings", sub: "Appearance, layout, keys, Morgan" },
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
const KIND = { sum: "=", project: "PROJECT", window: "WINDOW", canvas: "CANVAS", page: "PAGE", app: "APP", verb: "DO", file: "FILE", morgan: "MORGAN", conversation: "SAID",
  task: "TASK", person: "PERSON", note: "PAGE", event: "EVENT" };
// Past conversations with Morgan for what is typed, asked for once typing
// pauses: the query is embedded by Morgan, where it runs, never here. Shown
// after what the launcher found itself, before the question to Morgan.
const TALKED = 3;
let talked = { query: "", results: [] };
// What is nearest the query in meaning (the core's meaning.ts), for the query it answered.
let meant = { query: "", results: [] };
// Tasks, people, notes and events holding the query's words (launcher.py, _ThingSearch), for the query it answered.
let named = { query: "", results: [], about: [] };
// `#tag`: what carries it, asked of the core as it is typed (launcher.py, tagged).
let tagCache = new Map();
let talkSoon = null;

$("glass").innerHTML = Icons.search();

function picks() { try { return JSON.parse(localStorage.getItem(PICKS) || "{}"); } catch { return {}; } }
function remember(key) {
  const p = picks();
  p[key] = (p[key] || 0) + 1;
  try { localStorage.setItem(PICKS, JSON.stringify(p)); } catch { /* fine */ }
}

function build(c) {
  here = (c.project || {}).id || "";
  const icon = (name) => (name ? `talaris-ui://icon/?n=${encodeURIComponent(name)}` : "");
  items = [
    ...c.projects.map((p) => ({ kind: "project", key: `project:${p.id}`, title: p.title, sub: p.code, act: { kind: "project", id: p.id },
      current: p.id === (c.project || {}).id })),
    ...c.windows.map((w) => ({ kind: "window", key: `window:${w.address}`, title: w.title, sub: `${w.app} · ${w.where}`, img: icon(w.icon),
      recent: w.recent, act: { kind: "window", address: w.address } })),
    ...c.canvases.map((x) => ({ kind: "canvas", key: `canvas:${x.id}`, title: x.title, sub: x.where, act: { kind: "canvas", id: x.id } })),
    ...c.pages.map((x) => ({ kind: "page", key: `page:${x.path}`, title: x.title, sub: x.where, act: { kind: "page", path: x.path } })),
    ...c.apps.map((a) => ({ kind: "app", key: `app:${a.id}`, title: a.name, also: a.also, img: icon(a.icon), act: { kind: "app", id: a.id },
      sub: a.away ? `Open in ${a.away}` : "", presses: a.away ? a.presses : null })),
    ...VERBS.map((v) => ({ kind: "verb", key: `verb:${v.name}`, title: v.title, sub: v.sub || "", ask: v.ask, act: { kind: "verb", name: v.name } })),
    ...c.files.map((f) => ({ kind: "file", key: `file:${f.path}`, title: f.title, sub: f.where, act: { kind: "file", path: f.path } })),
  ];
}

/** How well `q` names `text`: 0 for not at all. */
function score(q, text) {
  // Accents aside, as everything is found (kit.js): "kaufer" is Käufer.
  const t = Kit.fold(text);
  q = Kit.fold(q);
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
  // What the words found (_ThingSearch): without these the whole list failed to draw.
  task: () => Icons.tasks(), person: () => Icons.people(), note: () => GLYPH.page(),
  event: () => '<svg class="ic" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><rect x="2" y="3" width="12" height="11" rx="1.5"/><path d="M2 6.5h12M5.5 1.5v3M10.5 1.5v3"/></svg>',
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
  // "#tag": everything carrying it — pages (opened where they are), tasks, people; "#" alone, the tags in use.
  const tagAsked = /^#(\S*)$/.exec(query.trim());
  if (tagAsked && bridge) {
    const t = tagAsked[1];
    if (!t) {
      if (!tagCache.has("")) bridge.tags((text) => { tagCache.set("", JSON.parse(text || "[]")); draw(); });
      shown = (tagCache.get("") || []).slice(0, 30).map((x) => ({ kind: "verb", key: `tag:${x.tag}`, title: `#${x.tag}`, sub: `${x.count} tagged`,
        act: { kind: "fill", text: `#${x.tag}` } }));
    } else {
      if (!tagCache.has(t)) bridge.tagged(t, (text) => { tagCache.set(t, JSON.parse(text || "[]")); draw(); });
      const AS = { task: "task", contact: "person", event: "event" };
      shown = (tagCache.get(t) || []).map((x) => x.page
        ? { kind: "page", key: `tagged:${x.id}`, title: x.title, sub: `#${t} · ${x.page.path.startsWith("Pages/") ? "Page in Home" : x.page.path.includes("/") ? x.page.path.slice(0, x.page.path.lastIndexOf("/")) : "Page"}`,
          act: { kind: "page", project: x.page.project, path: x.page.path } }
        : { kind: "page", key: `tagged:${x.id}`, title: x.title, sub: `#${t} · ${(x.kinds || [])[0] || "thing"}`,
          act: { kind: "entity", id: x.id, as: AS[(x.kinds || []).find((k) => AS[k])] || "" } });
    }
  }
  // "archive <words>": the archive searched on purpose — it is in no other result.
  const inArchive = /^archive\s+(\S.*)$/i.exec(query.trim());
  if (inArchive) shown.unshift({ kind: "verb", key: "archive-search", title: `Search the archive for “${inArchive[1]}”`, sub: "Archived projects' pages, canvases and files",
    act: { kind: "verb", name: "archive", query: inArchive[1] } });
  const worked = sum(query);
  if (worked !== null) {
    const plain = String(Math.round(worked * 1e10) / 1e10);
    shown.unshift({ kind: "sum", title: figure(worked), sub: "Enter copies it", act: { kind: "copy", text: plain } });
  }
  // By their words: tasks, people, notes and events — after what the launcher has of its own, before what is near in meaning.
  // Under each thing the words name whole, what is connected to it, whether or not it says them (the core's context).
  if (query.trim() && !tagAsked && named.query === query.trim().replace(/\s+/g, " ")) {
    const have = new Set(shown.map((x) => `${x.kind}:${x.title}`.toLowerCase()));
    const ids = new Set();
    const dayOf = (s) => Kit.day(new Date(s.length > 10 ? s : `${s}T12:00:00`));
    const detail = (r) => r.kind === "task" ? (r.done ? "Done" : r.due ? `Due ${dayOf(r.due)}` : "Task")
      : r.kind === "person" ? "Person"
      : r.kind === "conversation" ? `Conversation with Morgan${r.updated ? ` · ${dayOf(r.updated)}` : ""}`
      : r.kind === "note" ? (r.path.startsWith("Pages/") ? "Page in Home" : r.path.startsWith("Daily/") ? "Daily page" : "Page")
      : `${dayOf(r.start)}${r.allDay ? "" : ` · ${Kit.clock(r.start)}`}${r.location ? ` · ${r.location}` : ""}`;
    const row = (r, sub = detail(r)) => {
      ids.add(r.id || `${r.calendar}:${r.uid}`);
      const key = r.kind === "event" ? `event:${r.calendar}:${r.uid}` : r.kind === "conversation" ? `conversation:${r.thread}` : `${r.kind}:${r.id}`;
      const act = r.kind === "task" || r.kind === "person" ? { kind: "entity", id: r.id, as: r.kind }
        : r.kind === "conversation" ? { kind: "conversation", id: r.thread }
        : r.kind === "note" ? { kind: "page", project: r.project, path: r.path }
        : { kind: "event", calendar: r.calendar, uid: r.uid, start: r.start };
      return { kind: r.kind, key, title: r.kind === "event" ? r.title || "(no title)" : r.title, sub, act };
    };
    for (const r of named.results) {
      if (r.kind === "note" && have.has(`page:${r.title}`.toLowerCase())) continue;
      shown.push(row(r));
    }
    // How a thing touches the one named, said from the thing's side: "Mentions Rich Gelson", "With Rich Gelson".
    const how = (r, focus) => {
      const h = r.how.toLowerCase();
      if (!r.incoming) return h === "attendees" ? `${focus}'s guest` : h === "organizer" ? `Organized ${focus}` : `${focus}'s ${h}`;
      return h === "mentions" ? `Mentions ${focus}` : h === "attendees" ? `With ${focus}` : h === "organizer" ? `Organized by ${focus}`
        : h === "project" ? `In ${focus}` : h === "people" || h === "about" ? `About ${focus}` : `${focus} · ${h}`;
    };
    for (const a of named.about || []) {
      const rows = a.related.filter((r) => !ids.has(r.id || `${r.calendar}:${r.uid}`))
        .map((r) => ({ ...row(r, `${how(r, a.title)} · ${detail(r)}`), related: true }));
      if (!rows.length) continue;
      const at = shown.findIndex((x) => x.key && x.key.endsWith(`:${a.focus}`));
      shown.splice(at < 0 ? shown.length : at + 1, 0, ...rows);
    }
  }
  // By meaning: pages, notes, tasks and people about what was typed, below what matched its words — each once.
  if (query.trim() && !tagAsked && meant.query === query.trim().replace(/\s+/g, " ")) {
    const have = new Set(shown.map((x) => `${x.kind}:${x.title}`.toLowerCase()));
    for (const x of shown) if (["task", "person", "note"].includes(x.kind)) { have.add(`page:${x.title}`.toLowerCase()); have.add(`entity:${x.title}`.toLowerCase()); }
    const AS = { task: "task", person: "person" };
    for (const r of meant.results) {
      if (r.kind === "project") continue;
      if (have.has(`page:${r.title}`.toLowerCase()) || have.has(`entity:${r.title}`.toLowerCase())) continue;
      // A file by what it says: one in a folder opened from there; one only on things, in Glance with them. An event, in Glance too.
      if (r.kind === "file" && !(r.key.startsWith("file:p:") && r.path)) continue;
      const where = r.kind === "page" ? (r.path.startsWith("Pages/") ? "Page in Home" : r.path.startsWith("Daily/") ? "Daily page" : "Page")
        : { task: "Task", person: "Person", file: "File", event: "Event", canvas: "Canvas", thread: "Conversation with Morgan" }[r.kind] || "Thing";
      // A canvas opened in its project; one of Morgan's threads, as its conversation — once, whichever way it was found.
      if (r.kind === "thread" && shown.some((x) => x.key === `conversation:${r.path}`)) continue;
      if (r.kind === "canvas" || r.kind === "thread") {
        shown.push({ kind: r.kind === "canvas" ? "canvas" : "conversation", key: r.kind === "thread" ? `conversation:${r.path}` : `meaning:${r.key}`, title: r.title,
          sub: `By meaning · ${where}${r.passage ? ` · “${r.passage.slice(0, 70)}”` : ""}`,
          act: r.kind === "canvas" ? { kind: "canvas", project: r.project, id: r.path } : { kind: "conversation", id: r.path } });
        continue;
      }
      shown.push({ kind: r.kind === "file" ? "file" : "page", key: `meaning:${r.key}`, title: r.title, sub: `By meaning · ${where}${r.passage ? ` · “${r.passage.slice(0, 70)}”` : ""}`,
        act: r.kind === "page" ? { kind: "page", project: r.project, path: r.path } : r.kind === "file" ? { kind: "file", project: r.project, path: r.path }
          : r.kind === "event" ? { kind: "glance", key: `e:${r.id}` } : { kind: "entity", id: r.id, as: AS[r.kind] || "" } });
    }
  }
  // A tag search is a question about tags: past conversations that happen to hold the word are not an answer to it.
  if (query.trim() && !tagAsked && talked.query === query.trim().replace(/\s+/g, " ")) {
    for (const r of talked.results.slice(0, TALKED)) {
      if (shown.some((x) => x.key === `conversation:${r.id}`)) continue;
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
    row.className = "item" + (i === at ? " on" : "") + (armed === x.key ? " armed" : "") + (x.related ? " related" : "");
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
      : mark(armed === x.key ? `${x.title}?` : x.title, query));
    if (x.sub) text.append(Object.assign(document.createElement("span"), { className: "sub", textContent: x.sub }));
    const kind = Object.assign(document.createElement("span"), { className: "kind", textContent: KIND[x.kind] });
    row.append(icon, text);
    // An application open only in another project: the dock's three, in its order, each with its key — the one chosen shows them.
    if (x.presses && i === at) row.append(pressChoices(x));
    else row.append(kind);
    row.addEventListener("mousemove", () => { if (at !== i) { at = i; draw(); } });
    row.addEventListener("click", (e) => choose(i, e.shiftKey));
    if (glanceKey(x)) row.title = "Shift+Enter: in Glance";
    return row;
  }));
  const on = list.children[at];
  if (on) on.scrollIntoView({ block: "nearest" });
}

// The dock's three for an application open elsewhere, as words and the key each is on (Enter, Shift+Enter, Ctrl+Enter).
const HOW = { go: "Go to it", bring: "Bring here", new: "New here" };
const KEYS = { click: "↵", shift: "⇧↵", ctrl: "Ctrl ↵" };
function pressChoices(x) {
  const box = Object.assign(document.createElement("span"), { className: "presses" });
  for (const [press, how] of Object.entries(x.presses)) {
    if (!how) continue;
    const b = Object.assign(document.createElement("button"), { className: "press", title: `${HOW[how]} (${KEYS[press]})` });
    b.append(HOW[how], Object.assign(document.createElement("kbd"), { textContent: KEYS[press] }));
    b.addEventListener("click", (e) => { e.stopPropagation(); chooseHow(x, how); });
    box.append(b);
  }
  return box;
}
function chooseHow(x, how) {
  if (x.key) remember(x.key);
  bridge.act(JSON.stringify({ ...x.act, how }), (error) => { if (error) say(error, true); });
}

// Said as every page says it (kit.js): one line, sentence case, an error in the danger color.
function say(text, error = false) { Kit.say($("msg"), text, error, 0); }

// The project the catalog is of: where a page or file with no project of its own is.
let here = "";
// What Glance knows a row's thing by (glance.ts keys); "" for what it has no glance of.
function glanceKey(x) {
  const a = x.act || {};
  if (a.kind === "entity" && a.id) return `e:${a.id}`;
  if (a.kind === "page" && a.path) return `page:${a.project || here}/${a.path}`;
  if (a.kind === "file" && a.path) return `file:${a.project || here}/${a.path}`;
  if (a.kind === "project" && a.id) return `project:${a.id}`;
  if (a.kind === "glance") return a.key;
  return "";
}

// `there`: Shift+Enter (or Shift and a click) — an application already open in another project is gone to, not brought here;
// a thing — a person, a task, a note, a page, a file, a project — opened in Glance, with what it is and might be tied to.
function choose(i, there = false) {
  const x = shown[i];
  if (!x || !bridge) return;
  // Asked as everything is asked (kit.js): the row says what Enter again will do, for as long as anything asks.
  if (x.ask && armed !== x.key) { armed = x.key; setTimeout(() => { if (armed === x.key) { armed = null; draw(); } }, Kit.ASK_MS); draw(); return; }
  armed = null;
  // A tag chosen from "#": typed in, so what carries it shows.
  if (x.act.kind === "fill") { $("q").value = x.act.text; $("q").dispatchEvent(new Event("input")); return; }
  if (x.key) remember(x.key);
  if (x.kind === "morgan") say("Asking Morgan…");
  if (there && x.act.kind !== "app" && glanceKey(x)) { bridge.act(JSON.stringify({ kind: "glance", key: glanceKey(x) }), (error) => { if (error) say(error, true); }); return; }
  bridge.act(JSON.stringify(there && x.act.kind === "app" ? { ...x.act, there: true } : x.act), (error) => { if (error) say(error, true); });
}

// Escape clears it first, as every box that narrows a list does (kit.js).
Kit.searchBox($("q"));
$("q").addEventListener("input", () => {
  at = 0; armed = null; say(""); draw();
  clearTimeout(talkSoon);
  const q = $("q").value.trim().replace(/\s+/g, " ");
  if (q.length >= 2 && state.mode !== "ask" && !q.startsWith("#")) setTimeout(() => { if (bridge && bridge.thingSearch && $("q").value.trim().replace(/\s+/g, " ") === q) bridge.thingSearch(q); }, 200);
  if (q.length >= 3 && state.mode !== "ask") talkSoon = setTimeout(() => { if (!bridge) return; bridge.morganSearch(q); if (bridge.meaningSearch && !q.startsWith("#")) bridge.meaningSearch(q); }, 350);
});
addEventListener("keydown", (e) => {
  if (!bridge) return;
  bridge.activity();
  const n = shown.length;
  if (e.key === "Escape") { e.preventDefault(); bridge.file(); }
  else if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "n")) { e.preventDefault(); if (n) { at = (at + 1) % n; armed = null; draw(); } }
  else if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p")) { e.preventDefault(); if (n) { at = (at - 1 + n) % n; armed = null; draw(); } }
  else if (e.key === "Enter") {
    e.preventDefault();
    // An application open elsewhere: Enter, Shift+Enter and Ctrl+Enter are the dock's press, Shift-press and Ctrl-press.
    const x = shown[at];
    const how = x && x.presses && x.presses[e.ctrlKey ? "ctrl" : e.shiftKey ? "shift" : "click"];
    if (how) chooseHow(x, how);
    else choose(at, e.shiftKey);
  }
});
// A press outside the box puts it away — heard here, and from Qt (sensor.Presses).
addEventListener("pointerdown", (e) => { if (bridge && state.up && !e.target.closest("#box")) bridge.file(); });
window.pressedAt = (x, y) => { const at = document.elementFromPoint(x, y); if (bridge && state.up && !(at && at.closest("#box"))) bridge.file(); };

// How it comes and goes (motion.js): from the top, over the dimmed screen,
// with the lines under the field and over the foot drawn too.
function how() {
  const m = state.motion || {};
  return {
    kind: m.motion, speed: m.speed, edge: "top", flush: false, viewport: state.viewport,
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
  // Each opening starts clean, with a fresh look at what there is — the tags too.
  $("q").value = "";
  tagCache = new Map();
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
  if (b.thingsFound) b.thingsFound.connect((text) => {
    const found = JSON.parse(text);
    if (found.query !== $("q").value.trim().replace(/\s+/g, " ")) return;
    named = found;
    draw();
  });
  b.meaningFound.connect((text) => {
    const found = JSON.parse(text);
    if (found.query !== $("q").value.trim().replace(/\s+/g, " ")) return;
    meant = found;
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
