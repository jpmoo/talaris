// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore
//
// The calendar's page. The events come from the process (calendard.py, through
// calendar_panel.py) for the range on show, and are read again whenever an
// account says something changed; nothing is kept here but what is on show
// and which calendars are hidden (this page's own preference).

"use strict";

const $ = (id) => document.getElementById(id);
function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (k === "class") e.className = v;
    else if (k === "style") e.setAttribute("style", v);
    else e.setAttribute(k, v);
  }
  for (const k of kids) if (k != null && k !== "") e.append(k);
  return e;
}
function seg(host, choices, current, pick) {
  $(host).replaceChildren(...choices.map(([value, label]) =>
    el("button", { class: value === current ? "on" : "", onclick: () => pick(value) }, label)));
}

let bridge = null;
let surface = { up: false };
let status = { ready: false, error: "Starting", needs: "" };
let calendars = [];
let events = [];
let mode = "month";
let focus = startOfDay(new Date());
// Two pages may share the bridge — the panel and its window — so each numbers
// its requests from somewhere of its own, and takes only its own answers.
let req = Math.floor(Math.random() * 1e9);
let wanted = 0;
// Loaded as a window (overlay.py), not a panel: always out, no dim, no motion.
const WINDOW = new URLSearchParams(location.search).has("window");
if (WINDOW) document.documentElement.dataset.window = "1";
// The calendars not shown: Talaris's setting (Settings, Accounts, or the list here).
let hidden = new Set();
// Set aside here, by a press on its swatch: still in the list, its events not
// on show — unlike one turned off in Settings, which is not here at all.
let muted = new Set();
try { muted = new Set(JSON.parse(localStorage.getItem("talaris.calendar.muted") || "[]")); } catch { /* fine */ }
// Invitations declined: shown faded, or not at all.
let declinedShown = true;
try { declinedShown = localStorage.getItem("talaris.calendar.declined") !== "0"; } catch { /* fine */ }
function showDeclined(on) {
  declinedShown = on;
  try { localStorage.setItem("talaris.calendar.declined", on ? "1" : "0"); } catch { /* fine */ }
  drawSide();
  draw();
}
// Tasks above the day (their days, available to due), and those past due on today: each shown or not, this page's preference.
let tasksShown = true, overdueShown = true;
try { tasksShown = localStorage.getItem("talaris.calendar.tasks") !== "0"; overdueShown = localStorage.getItem("talaris.calendar.overdue") !== "0"; } catch { /* fine */ }
function showTasks(which, on) {
  if (which === "tasks") tasksShown = on; else overdueShown = on;
  try { localStorage.setItem(`talaris.calendar.${which}`, on ? "1" : "0"); } catch { /* fine */ }
  if (!tasksShown && !overdueShown) { tasks = []; draw(); } else fetchTasks();
  drawSide();
}
function mute(id) {
  if (muted.has(id)) muted.delete(id); else muted.add(id);
  try { localStorage.setItem("talaris.calendar.muted", JSON.stringify([...muted])); } catch { /* fine */ }
  drawSide();
  draw();
}
try { mode = localStorage.getItem("talaris.calendar.mode") || "month"; } catch { /* fine */ }

const DAY_MS = 86400000;
function startOfDay(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function sameDay(a, b) { return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate(); }
// Weeks start on Sunday, as the bar's clock reads in en-US.
function startOfWeek(d) { return addDays(startOfDay(d), -startOfDay(d).getDay()); }
const clock = (ms) => Kit.clock(ms);
const colorOf = (id) => (calendars.find((c) => c.id === id) || {}).color || "var(--accent)";

// ---------------------------------------------------------------- the range on show

function span() {
  if (mode === "day") return [startOfDay(focus), addDays(startOfDay(focus), 1)];
  if (mode === "week") { const s = startOfWeek(focus); return [s, addDays(s, 7)]; }
  const first = new Date(focus.getFullYear(), focus.getMonth(), 1);
  const s = startOfWeek(first);
  return [s, addDays(s, 42)];
}
function fetchRange() {
  fetchTasks();
  if (!bridge || !status.ready) return;
  const [a, b] = span();
  wanted = ++req;
  bridge.ask(JSON.stringify({ do: "range", req: wanted, from: a.getTime(), to: b.getTime() }));
}
function title() {
  if (mode === "day") return focus.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
  if (mode === "week") {
    const s = startOfWeek(focus), e = addDays(s, 6);
    return `${s.toLocaleDateString("en-US", { month: "short", day: "numeric" })} – ${e.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`;
  }
  return Kit.month(focus);
}
function shown() {
  return events.filter((e) => !hidden.has(e.calendar) && !muted.has(e.calendar) && (declinedShown || e.mine !== "declined"));
}
// The events on a day: those that start before it ends and end after it starts.
function onDay(day) {
  const a = startOfDay(day).getTime(), b = a + DAY_MS;
  return shown().filter((e) => e.start < b && (e.end > a || e.start === e.end && e.start >= a));
}

// ---------------------------------------------------------------- tasks, above the day's events
//
// The tasks on the days on show, from the core (through the bridge's narrow
// line to it, calendar_panel.py): each one bar from the day it is available
// to the day it is due — a day, if it has only one of them. Ticked done here,
// opened in Tasks with a press, dragged to other days, its dates going along.

let tasks = [];
let coreAsked = 0;
const coreWaiting = new Map();
function core(method, path, body) {
  return new Promise((ok, fail) => {
    const id = `t${++coreAsked}`;
    coreWaiting.set(id, { ok, fail });
    bridge.core(id, method, path, body === undefined ? "" : JSON.stringify(body));
  });
}
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
function fetchTasks() {
  if (!bridge || typeof bridge.core !== "function" || mode === "month" || (!tasksShown && !overdueShown)) return;
  const [a, b] = span();
  const asked = `${iso(a)}/${iso(b)}`;
  core("GET", `/tasks/days?from=${iso(a)}&to=${iso(b)}${overdueShown ? "&overdue=1" : ""}`).then((rows) => {
    const [x, y] = span();
    if (asked !== `${iso(x)}/${iso(y)}`) return; // moved on meanwhile
    tasks = rows || [];
    draw();
  }).catch(() => {});
}
const dayWord = (s) => Kit.day(new Date(`${s.slice(0, 10)}T12:00:00`));

/**
 * The tasks' row: bars packed into as few lines as they fit, each spanning its
 * days. Those past due first, on top, on today and stretching back to the day
 * they were due; the rest from available to due — each kind as Show says.
 */
function taskRow(days) {
  const first = iso(days[0]), last = iso(days[days.length - 1]), today = iso(new Date());
  const late = (t) => overdueShown && t.overdue && !t.complete && t.due;
  const spans = tasks.flatMap((t) => {
    if (late(t)) return [{ t, lo: t.due.slice(0, 10), hi: today, late: true }];
    if (!tasksShown) return [];
    const a = (t.start || t.due).slice(0, 10), b = (t.due || t.start).slice(0, 10);
    return [{ t, lo: a <= b ? a : b, hi: a <= b ? b : a, late: false }];
  }).sort((x, y) => Number(y.late) - Number(x.late));
  const lanes = [];
  const bars = [];
  for (const { t, lo, hi } of spans) {
    if (hi < first || lo > last) continue;
    const s = Math.max(0, days.findIndex((d) => iso(d) >= lo));
    let e = days.length - 1;
    while (e > 0 && iso(days[e]) > hi) e--;
    let lane = lanes.findIndex((end) => end < s);
    if (lane < 0) { lane = lanes.length; lanes.push(-1); }
    lanes[lane] = e;
    bars.push(taskBar(t, s, e, lane, lo < first, hi > last, days.length));
  }
  if (!bars.length) return null;
  return el("div", { class: "taskrow", style: `--cols:${days.length};grid-template-rows:repeat(${lanes.length}, 22px)` },
    el("div", { class: "lbl", style: `grid-row:1 / ${lanes.length + 1}` }, "tasks"), ...bars);
}

function taskBar(t, s, e, lane, fromBefore, goesOn, cols) {
  const when = t.start && t.due && t.start.slice(0, 10) !== t.due.slice(0, 10) ? `available ${dayWord(t.start)}, due ${dayWord(t.due)}`
    : t.due ? `due ${dayWord(t.due)}` : `available ${dayWord(t.start)}`;
  const tick = el("button", { class: "tick" + (t.complete ? " on" : ""), title: t.complete ? "Not done" : "Done", onclick: (ev) => {
    ev.stopPropagation();
    core("POST", `/tasks/${encodeURIComponent(t.id)}/done`, { done: !t.complete }).then(fetchTasks).catch((x) => say(x.message, true));
  } }, "✓");
  const bar = el("div", { class: "tbar" + (t.complete ? " done" : "") + (t.overdue ? " late" : "") + (fromBefore ? " from-before" : "") + (goesOn ? " goes-on" : ""),
    style: `grid-column:${s + 2} / ${e + 3};grid-row:${lane + 1}`, title: `${t.title} · ${when}` },
    tick, el("span", { class: "tt" }, t.title || "(untitled)"));
  // A press opens it in Tasks; a drag along the days moves its dates by as many.
  bar.addEventListener("pointerdown", (down) => {
    if (down.button !== 0 || tick.contains(down.target)) return;
    const row = bar.parentElement.getBoundingClientRect();
    const width = (row.width - 52) / cols;
    let dx = 0;
    bar.setPointerCapture(down.pointerId);
    const move = (ev) => { dx = ev.clientX - down.clientX; if (Math.abs(dx) > 4) { bar.classList.add("dragging"); bar.style.transform = `translateX(${dx}px)`; } };
    const up = () => {
      bar.removeEventListener("pointermove", move);
      bar.removeEventListener("pointerup", up);
      bar.removeEventListener("pointercancel", up);
      const n = Math.round(dx / width);
      if (Math.abs(dx) <= 4) { bridge.openTask(t.id); return; }
      bar.classList.remove("dragging");
      bar.style.transform = "";
      if (n) core("POST", `/tasks/${encodeURIComponent(t.id)}/shift`, { days: n }).then(fetchTasks).catch((x) => say(x.message, true));
    };
    bar.addEventListener("pointermove", move);
    bar.addEventListener("pointerup", up);
    bar.addEventListener("pointercancel", up);
  });
  return bar;
}

// ---------------------------------------------------------------- drawing

// ---------------------------------------------------------------- search
//
// Events a year either side of now holding every word typed (the calendar
// process looks), and tasks holding them (the core): in place of the days
// while there are any. A press on an event opens it on its day; on a task, in
// Tasks. Escape, or emptying it, goes back.

let searching = "";
let found = { events: null, tasks: null };
let searchReq = 0;
function search(q) {
  searching = q;
  found = { events: null, tasks: null };
  if (q) {
    if (bridge && status.ready) bridge.ask(JSON.stringify({ do: "search", req: (searchReq = ++req), q }));
    else found.events = [];
    if (bridge && typeof bridge.core === "function") core("GET", `/tasks/find?text=${encodeURIComponent(q)}&limit=100`).then((rows) => { if (searching === q) { found.tasks = rows || []; draw(); } }).catch(() => { found.tasks = []; draw(); });
    else found.tasks = [];
  }
  draw();
}
const whenWords = (e) => {
  const d = new Date(e.start);
  const day = Kit.day(d);
  return e.allDay ? `${day} · all day` : `${day} · ${clock(e.start)}`;
};
function drawFound(view) {
  const now = Date.now();
  const events = (found.events || []).filter((e) => !hidden.has(e.calendar) && !muted.has(e.calendar));
  const hit = (e) => el("div", { class: "hit", style: `--c:${colorOf(e.calendar)}`, title: e.title, onclick: () => {
    const at = new Date(e.start);
    search("");
    $("search").value = "";
    focus = startOfDay(at);
    if (mode === "month") mode = "week";
    draw(); fetchRange();
    edit(e);
  } }, el("span", { class: "sw" }), el("span", { class: "when" }, whenWords(e)), el("span", { class: "what" }, e.title || "(no title)", e.location ? el("small", {}, e.location) : ""));
  const taskHit = (t) => el("div", { class: "hit" + (t.complete ? " done" : ""), style: "--c:var(--accent)", title: t.title, onclick: () => bridge.openTask(t.id) },
    el("span", { class: "sw" }), el("span", { class: "when" }, t.due ? `due ${dayWord(t.due)}` : t.start ? `available ${dayWord(t.start)}` : "no date"),
    el("span", { class: "what" }, t.title || "(untitled)"));
  const coming = events.filter((e) => e.end >= now), past = events.filter((e) => e.end < now);
  const tasksFound = (found.tasks || []).slice().sort((a, b) => Number(Boolean(a.complete)) - Number(Boolean(b.complete)));
  const waiting = found.events === null || found.tasks === null;
  const box = el("div", { class: "found" },
    coming.length ? el("h3", {}, "Coming up") : null, ...coming.map(hit),
    past.length ? el("h3", {}, "Past") : null, ...past.map(hit),
    tasksFound.length ? el("h3", {}, "Tasks") : null, ...tasksFound.map(taskHit),
    !waiting && !events.length && !tasksFound.length ? el("div", { class: "none" }, "Nothing holds those words") : null,
    waiting ? el("div", { class: "none" }, "Looking…") : null);
  view.replaceChildren(box);
}

function draw() {
  if (searching) {
    $("title").textContent = `“${searching}”`;
    drawSide();
    drawFound($("view"));
    return;
  }
  $("title").textContent = title();
  seg("mode", [["day", "Day"], ["week", "Week"], ["month", "Month"]], mode, (m) => {
    mode = m; try { localStorage.setItem("talaris.calendar.mode", m); } catch { /* fine */ }
    draw(); fetchRange();
  });
  drawSide();
  const view = $("view");
  if (!status.ready) {
    view.replaceChildren(el("div", { class: "note" }, status.error || "Starting",
      status.needs ? el("p", {}, "Install them once, then the calendar starts by itself after Talaris restarts: ", el("br"), el("code", {}, `sudo apt install ${status.needs}`)) : ""));
    return;
  }
  if (!calendars.length) {
    view.replaceChildren(el("div", { class: "note" }, "No calendars yet. Add a Google, Microsoft 365 or Apple account and its calendars appear here.",
      el("p", {}, el("button", { class: "t-btn", onclick: () => bridge.accounts() }, "Add an account"))));
    return;
  }
  if (mode === "month") drawMonth(view); else drawDays(view, mode === "week" ? 7 : 1);
}

// The calendars on show, by account: a key to their colors. Which are on
// show is Settings, Accounts' to say; those turned off are not here at all.
const showing = () => calendars.filter((c) => !hidden.has(c.id));
function drawSide() {
  const byAccount = {};
  for (const c of showing()) (byAccount[c.account] ||= []).push(c);
  const side = $("side");
  side.replaceChildren(...Object.entries(byAccount).flatMap(([account, list]) => [
    el("h3", {}, account),
    ...list.map((c) => el("div", { class: "cal" + (muted.has(c.id) ? " muted" : " on"), style: `--c:${c.color || "var(--accent)"}`, title: c.writable ? "" : "Read only" },
      el("button", { class: "sw", title: muted.has(c.id) ? "Show its events" : "Hide its events", onclick: () => mute(c.id) }), el("span", {}, c.name))),
  ]), el("h3", {}, "Show"),
  el("div", { class: "cal" + (declinedShown ? " on" : " muted"), style: "--c:var(--muted)" },
    el("button", { class: "sw", title: declinedShown ? "Hide declined events" : "Show declined events", onclick: () => showDeclined(!declinedShown) }),
    el("span", {}, "Declined events")),
  // Tasks are drawn in Day and Week only, so they are offered there only.
  ...(mode === "month" ? [] : [
    el("div", { class: "cal" + (tasksShown ? " on" : " muted"), style: "--c:var(--accent)" },
      el("button", { class: "sw", title: tasksShown ? "Hide tasks on their days" : "Show tasks on their days", onclick: () => showTasks("tasks", !tasksShown) }),
      el("span", {}, "Available/Due Tasks")),
    el("div", { class: "cal" + (overdueShown ? " on" : " muted"), style: "--c:#d0564b" },
      el("button", { class: "sw", title: overdueShown ? "Hide overdue tasks" : "Show overdue tasks on today", onclick: () => showTasks("overdue", !overdueShown) }),
      el("span", {}, "Overdue Tasks")),
  ]));
}

// Declined, faded; still to come and unanswered, a dashed edge.
function answerClass(e) {
  if (e.mine === "declined") return " declined";
  return e.mine === "waiting" && e.end > Date.now() ? " waiting" : "";
}
function chip(e, timedLook) {
  return el("div", { class: "chip" + (timedLook && !e.allDay ? " timed" : "") + answerClass(e), style: `--c:${colorOf(e.calendar)}`, title: e.title,
    onclick: (ev) => { ev.stopPropagation(); edit(e); } }, (!e.allDay ? `${clock(e.start)} ` : "") + (e.title || "(no title)"));
}

function drawMonth(view) {
  const [start] = span();
  const today = new Date();
  const grid = el("div", { class: "month" });
  for (let i = 0; i < 7; i++) grid.append(el("div", { class: "dow" }, addDays(start, i).toLocaleDateString("en-US", { weekday: "short" })));
  for (let i = 0; i < 42; i++) {
    const day = addDays(start, i);
    const cell = el("div", { class: "cell" + (day.getMonth() !== focus.getMonth() ? " other" : "") + (sameDay(day, today) ? " today" : ""),
      ondblclick: () => create(day, true) });
    cell.append(el("span", { class: "n", title: "This day", onclick: () => { focus = day; mode = "day"; draw(); fetchRange(); } }, String(day.getDate())));
    const list = onDay(day);
    // As many as fit; the rest a count that opens the day.
    const room = 3;
    list.slice(0, room).forEach((e) => cell.append(chip(e, true)));
    if (list.length > room) cell.append(el("span", { class: "more", onclick: () => { focus = day; mode = "day"; draw(); fetchRange(); } }, `${list.length - room} more`));
    grid.append(cell);
  }
  view.replaceChildren(grid);
}

function drawDays(view, cols) {
  const [start] = span();
  const today = new Date();
  const days = Array.from({ length: cols }, (_, i) => addDays(start, i));
  const wrap = el("div", { class: "days", style: `--cols:${cols}` });
  wrap.append(el("div", { class: "dayhead" }, el("div"), ...days.map((d) => el("div", { class: sameDay(d, today) ? "today" : "" },
    d.toLocaleDateString("en-US", { weekday: "short", month: cols === 1 ? "long" : undefined, day: "numeric" })))));
  const taskBars = taskRow(days);
  if (taskBars) wrap.append(taskBars);
  wrap.append(el("div", { class: "allday" }, el("div", {}, "all day"), ...days.map((d) =>
    el("div", { ondblclick: () => create(d, true) }, ...onDay(d).filter((e) => e.allDay).map((e) => chip(e, false))))));
  const grid = el("div", { class: "grid" });
  const hours = el("div", { class: "hours" });
  const label = el("div", {}, ...Array.from({ length: 24 }, (_, h) => el("div", { class: "hour" }, h ? Kit.hour(h) : "")));
  hours.append(label);
  for (const d of days) {
    const col = el("div", { class: "col" });
    for (let h = 0; h < 24; h++) {
      const at = new Date(d); at.setHours(h);
      col.append(el("div", { class: "slot", ondblclick: () => create(at, false) }));
    }
    // Timed events laid side by side where they overlap.
    const timed = onDay(d).filter((e) => !e.allDay).sort((a, b) => a.start - b.start);
    const lanes = [];
    for (const e of timed) {
      let lane = lanes.findIndex((end) => end <= e.start);
      if (lane < 0) { lane = lanes.length; lanes.push(0); }
      lanes[lane] = e.end;
      e._lane = lane;
    }
    const dayStart = startOfDay(d).getTime();
    for (const e of timed) {
      const top = Math.max(0, (e.start - dayStart) / 3600000) * 48;
      const bottom = Math.min(24, (e.end - dayStart) / 3600000) * 48;
      const width = 100 / Math.max(1, lanes.length);
      col.append(el("div", { class: "ev" + answerClass(e), style: `--c:${colorOf(e.calendar)};top:${top}px;height:${Math.max(18, bottom - top - 2)}px;left:calc(${e._lane * width}% + 2px);right:auto;width:calc(${width}% - 4px)`,
        onclick: () => edit(e) }, e.title || "(no title)", el("small", {}, `${clock(e.start)} – ${clock(e.end)}${e.location ? ` · ${e.location}` : ""}`)));
    }
    if (sameDay(d, today)) {
      const now = new Date();
      col.append(el("div", { class: "now", style: `top:${(now.getHours() + now.getMinutes() / 60) * 48}px` }));
    }
    hours.append(col);
  }
  grid.append(hours);
  wrap.append(grid);
  view.replaceChildren(wrap);
  // The working day in view: from an hour before now, or 8 in the morning.
  grid.scrollTop = Math.max(0, (sameDay(focus, today) || cols === 7 ? Math.min(new Date().getHours() - 1, 16) : 8)) * 48;
}

// ---------------------------------------------------------------- making and changing
//
// No browser pickers here — a <select>, a date or a time field opens a window
// of the engine's own, which a layer surface cannot hold — so the calendar,
// the dates and the times are chosen from small lists drawn in the page.

let editing = null;
const MIN = 60000;
const dayLabel = (d) => Kit.day(d);
const timeLabel = (m) => Kit.minutes(m);
/** "9", "9:30", "930", "9:30 pm", "21:30" — minutes after midnight, or null. */
// What is typed, read as every page reads it (kit.js): a bare "3" is the afternoon.
const parseTime = (text) => Kit.parseTime(text);

// One pop-up at a time, the kit's (kit.js): placed under what opened it (or above, with more room there),
// kept on screen, scrolling when long, put away by a press elsewhere or Escape — the same on every page.
const popUnder = (anchor, content) => Kit.pop(anchor, content);
const popAway = () => Kit.popAway();
const monthPicker = (chosen, pick, opts) => Kit.monthPicker(chosen, pick, opts);
const timeList = (current, pick) => Kit.timeList(current, pick);


// ---- repeating: the few rules people make, read from and written to RRULE.
// One this editor cannot say (an interval of 3, the second Tuesday) is kept as
// it is unless changed here.
const DAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
function parseRule(text) {
  const r = { freq: "", days: [], ends: "never", until: null, count: 10, other: "", raw: text };
  if (!text) return r;
  const parts = Object.fromEntries(text.split(";").map((p) => p.split("=")));
  r.freq = (parts.FREQ || "").toLowerCase();
  r.days = (parts.BYDAY || "").split(",").filter((d) => DAYS.includes(d));
  if (parts.COUNT) { r.ends = "after"; r.count = Number(parts.COUNT); }
  if (parts.UNTIL) { r.ends = "on"; const u = parts.UNTIL; r.until = new Date(Number(u.slice(0, 4)), Number(u.slice(4, 6)) - 1, Number(u.slice(6, 8))); }
  r.other = Object.keys(parts).filter((k) => !["FREQ", "BYDAY", "COUNT", "UNTIL", "WKST"].includes(k)).join(",");
  return r;
}
function ruleText(r, start) {
  if (!r.freq) return "";
  if (r.other && r.raw && !r.changed) return r.raw;
  let t = `FREQ=${r.freq.toUpperCase()}`;
  if (r.freq === "weekly") t += `;BYDAY=${(r.days.length ? r.days : [DAYS[start.getDay()]]).join(",")}`;
  if (r.ends === "after") t += `;COUNT=${Math.max(1, Math.min(999, r.count || 1))}`;
  if (r.ends === "on" && r.until) { const u = r.until; t += `;UNTIL=${u.getFullYear()}${pad(u.getMonth() + 1)}${pad(u.getDate())}T235959Z`; }
  return t;
}
const pad = (n) => String(n).padStart(2, "0");
const calOf = (id) => calendars.find((c) => c.id === id) || {};
const ANSWER_WORD = { accepted: "going", declined: "not going", maybe: "maybe", waiting: "no answer yet", delegated: "delegated" };

function paintRepeats() {
  const v = editing.v, r = v.rule;
  const changed = (f) => (x) => { f(x); r.changed = true; paintRepeats(); };
  seg("e-freq", [["", "Never"], ["daily", "Daily"], ["weekly", "Weekly"], ["monthly", "Monthly"], ["yearly", "Yearly"]], r.freq, changed((f) => { r.freq = f; }));
  $("e-days-row").hidden = r.freq !== "weekly";
  const on = r.days.length ? r.days : [DAYS[v.sd.getDay()]];
  $("e-days").replaceChildren(...DAYS.map((d, i) => el("button", { class: on.includes(d) ? "on" : "", onclick: () => {
    const now = new Set(on); if (now.has(d) && now.size > 1) now.delete(d); else now.add(d);
    r.days = DAYS.filter((x) => now.has(x)); r.changed = true; paintRepeats();
  } }, "SMTWTFS"[i])));
  $("e-ends-row").hidden = !r.freq;
  seg("e-ends", [["never", "Never"], ["on", "On"], ["after", "After"]], r.ends, changed((x) => { r.ends = x; if (x === "on" && !r.until) r.until = addDays(v.sd, 30); }));
  $("e-until").hidden = r.ends !== "on";
  $("e-until").textContent = r.until ? dayLabel(r.until) : "";
  $("e-count").hidden = r.ends !== "after";
  if (document.activeElement !== $("e-count")) $("e-count").value = `${r.count} times`;
  // One occurrence of a series is changed on its own: how it repeats is the series'.
  const one = !editing.isNew && editing.recurring && editing.which === "this";
  for (const id of ["e-freq", "e-days", "e-ends", "e-until", "e-count"]) $(id).classList.toggle("off", one);
  $("e-freq").title = one ? "Choose Every one below to change how it repeats" : "";
}

function paintPeople() {
  const v = editing.v, cal = calOf(v.calendar);
  const mineOnly = !editing.isNew && editing.attendees && editing.attendees.length && !editing.organizing;
  // Invited to it by someone else: the list is theirs; my part is my answer.
  $("e-who-row").hidden = !cal.invites || mineOnly;
  $("e-who-note").hidden = cal.invites || mineOnly || editing.readOnly;
  $("e-who-why").textContent = cal.invites ? "" : "This calendar cannot send invitations; choose an account's calendar to invite people.";
  $("e-chips").replaceChildren(...v.people.map((p, i) => el("span", { class: "chip-p", title: p.email }, p.name || p.email,
    p.answer ? el("span", { class: "st" }, `· ${ANSWER_WORD[p.answer] || p.answer}`) : "",
    el("button", { title: "Remove", onclick: (ev) => { ev.stopPropagation(); v.people.splice(i, 1); paintPeople(); } }, "×"))));
  $("e-answer-row").hidden = !mineOnly || !editing.mine;
  if (mineOnly) {
    seg("e-answer", [["accepted", "Yes"], ["maybe", "Maybe"], ["declined", "No"]], editing.mine, (a) => {
      send({ do: "respond", calendar: editing.calendar, uid: editing.uid, rid: editing.rid, which: editing.which, answer: a }, () => { editing && (editing.mine = a); closeEditor(); });
    });
    $("e-org").textContent = editing.organizer ? `from ${editing.organizer}` : "";
  }
}

// Adding someone: typed, with suggestions from the address books as you type.
let peopleReq = 0;
function addPerson(p) {
  const v = editing.v;
  if (!v.people.some((x) => x.email === p.email)) v.people.push({ email: p.email, name: p.name || "" });
  $("e-who").value = ""; popAway(); paintPeople(); $("e-who").focus();
}
$("e-who").addEventListener("input", () => {
  const q = $("e-who").value.trim();
  if (q.length < 2) { popAway(); return; }
  peopleReq = ++req;
  bridge.ask(JSON.stringify({ do: "people", req: peopleReq, q }));
});
$("e-who").addEventListener("keydown", (e) => {
  const q = $("e-who").value.trim().replace(/[,;]$/, "");
  if ((e.key === "Enter" || e.key === "," || e.key === ";") && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(q)) { e.preventDefault(); e.stopPropagation(); addPerson({ email: q.toLowerCase() }); }
  if (e.key === "Backspace" && !$("e-who").value && editing.v.people.length) { editing.v.people.pop(); paintPeople(); }
});
function showPeople(found) {
  if (found.req !== peopleReq || !editing) return;
  if (!found.items.length) { popAway(); return; }
  popUnder($("e-who"), el("div", { class: "menu-list" }, ...found.items.map((p) =>
    el("button", { class: "time", onclick: (ev) => { ev.stopPropagation(); addPerson(p); } }, p.name ? `${p.name} · ${p.email}` : p.email))));
}
$("e-until").addEventListener("click", (ev) => {
  ev.stopPropagation();
  if (!editing || (Kit.openedBy() || {}).id === "e-until") { popAway(); return; }
  popUnder($("e-until"), monthPicker(editing.v.rule.until || editing.v.sd, (d) => { editing.v.rule.until = d; editing.v.rule.changed = true; paintRepeats(); }));
});
$("e-count").addEventListener("change", () => { const n = parseInt($("e-count").value, 10); if (n > 0) { editing.v.rule.count = n; editing.v.rule.changed = true; } paintRepeats(); });

// What the editor holds: the calendar, the days, the minutes after midnight.
function paintEditor() {
  paintRepeats();
  paintPeople();
  const v = editing.v;
  const cal = calendars.find((c) => c.id === v.calendar);
  $("e-cal").replaceChildren(el("span", { class: "sw", style: `background:${(cal && cal.color) || "var(--accent)"}` }), cal ? `${cal.name} · ${cal.account}` : "Choose a calendar");
  $("e-allday").classList.toggle("on", v.allDay);
  $("e-sd").textContent = dayLabel(v.sd);
  $("e-ed").textContent = dayLabel(v.ed);
  if (document.activeElement !== $("e-st")) $("e-st").value = timeLabel(v.st);
  if (document.activeElement !== $("e-et")) $("e-et").value = timeLabel(v.et);
  $("e-st").hidden = $("e-et").hidden = v.allDay;
}

function open(e, isNew) {
  const writable = showing().filter((c) => c.writable);
  const s = new Date(e.start);
  const end = new Date(e.allDay ? e.end - DAY_MS : e.end);
  editing = { ...e, isNew, v: {
    calendar: e.calendar || (writable[0] || {}).id || "", allDay: !!e.allDay,
    sd: startOfDay(s), st: s.getHours() * 60 + s.getMinutes(), ed: startOfDay(end), et: end.getHours() * 60 + end.getMinutes(),
    rule: parseRule(e.rrule || ""), people: (e.attendees || []).filter((a) => a.email !== (calOf(e.calendar).email || "")).map((a) => ({ ...a })),
  } };
  $("e-title").value = e.title || "";
  $("e-where").value = e.location || "";
  $("e-notes").value = e.notes || "";
  $("e-which-row").hidden = isNew || !e.recurring;
  // A repeating event: this one alone, or every one of them.
  const which = (w) => { editing.which = w; seg("e-which", [["this", "This one"], ["all", "Every one"]], w, which); if (editing.v) paintRepeats(); };
  which("this");
  $("e-delete").hidden = isNew;
  editing.readOnly = !isNew && !(calendars.find((c) => c.id === e.calendar) || {}).writable;
  for (const id of ["e-title", "e-cal", "e-allday", "e-sd", "e-st", "e-ed", "e-et", "e-where", "e-notes", "e-save", "e-delete"]) $(id).disabled = editing.readOnly;
  $("e-cal").disabled = editing.readOnly || !isNew;
  popAway();
  paintEditor();
  $("editor").classList.add("open");
  setTimeout(() => $("e-title").focus(), 30);
}
function edit(e) { open(e, false); }
function create(at, allDay) {
  if (!showing().some((c) => c.writable)) { say("No calendar on show can be written to", true); return; }
  const start = allDay ? startOfDay(at) : at;
  open({ start: start.getTime(), end: allDay ? start.getTime() + DAY_MS : start.getTime() + 3600000, allDay }, true);
}
function closeEditor() { popAway(); $("editor").classList.remove("open"); editing = null; }

$("e-cal").addEventListener("click", (ev) => {
  ev.stopPropagation();
  if (!editing || (Kit.openedBy() || {}).id === "e-cal") { popAway(); return; }
  popUnder($("e-cal"), el("div", { class: "menu-list" }, ...showing().filter((c) => c.writable).map((c) =>
    el("button", { class: "time" + (c.id === editing.v.calendar ? " on" : ""), onclick: (e) => { e.stopPropagation(); editing.v.calendar = c.id; popAway(); paintEditor(); } },
      el("span", { class: "sw", style: `background:${c.color || "var(--accent)"}` }), `${c.name} · ${c.account}`))));
});
$("e-allday").addEventListener("click", () => { if (!editing) return; editing.v.allDay = !editing.v.allDay; paintEditor(); });
for (const [id, key] of [["e-sd", "sd"], ["e-ed", "ed"]]) {
  $(id).addEventListener("click", (ev) => {
    ev.stopPropagation();
    if (!editing || (Kit.openedBy() || {}).id === id) { popAway(); return; }
    popUnder($(id), monthPicker(editing.v[key], (d) => {
      // Moving the start moves the end with it, keeping the length.
      if (key === "sd") { const len = editing.v.ed - editing.v.sd; editing.v.sd = d; editing.v.ed = new Date(d.getTime() + Math.max(0, len)); }
      else editing.v.ed = d < editing.v.sd ? editing.v.sd : d;
      paintEditor();
    }));
  });
}
for (const [id, key] of [["e-st", "st"], ["e-et", "et"]]) {
  $(id).addEventListener("focus", () => {
    if (!editing) return;
    popUnder($(id), timeList(editing.v[key], (m) => {
      if (key === "st") { const len = editing.v.et - editing.v.st; editing.v.st = m; if (sameDay(editing.v.sd, editing.v.ed)) editing.v.et = Math.min(24 * 60 - 1, m + Math.max(15, len)); }
      else editing.v.et = m;
      $(id).blur(); paintEditor();
    }));
  });
  $(id).addEventListener("change", () => {
    const m = parseTime($(id).value);
    if (m != null && editing) {
      if (key === "st") { const len = editing.v.et - editing.v.st; editing.v.st = m; if (sameDay(editing.v.sd, editing.v.ed)) editing.v.et = Math.min(24 * 60 - 1, m + Math.max(15, len)); }
      else editing.v.et = m;
    }
    paintEditor();
  });
}
// A press elsewhere in the editor puts a list away.
$("editor").addEventListener("click", (e) => { if (!e.target.closest("#pop") && !["e-st", "e-et"].includes(e.target.id)) popAway(); });

function collected() {
  const v = editing.v;
  let start = new Date(v.sd.getTime() + (v.allDay ? 0 : v.st * MIN));
  let end = v.allDay ? addDays(v.ed, 1) : new Date(v.ed.getTime() + v.et * MIN);
  if (end <= start) end = new Date(start.getTime() + (v.allDay ? DAY_MS : 3600000));
  const event = { title: $("e-title").value.trim(), allDay: v.allDay, start: start.getTime(), end: end.getTime(), location: $("e-where").value, notes: $("e-notes").value,
    rrule: ruleText(v.rule, v.sd), origStart: editing.start };
  // The invitees, if this calendar can invite and the event is mine to invite to.
  if (calOf(v.calendar).invites && (editing.isNew || editing.organizing || !(editing.attendees || []).length)) event.attendees = v.people;
  return event;
}
const pending = new Map();
function send(msg, after) {
  msg.req = ++req;
  pending.set(msg.req, after);
  say("Saving…");
  bridge.ask(JSON.stringify(msg));
}
$("e-save").addEventListener("click", () => {
  if (!editing) return;
  const event = collected();
  if (editing.isNew) send({ do: "create", calendar: editing.v.calendar, event }, closeEditor);
  else send({ do: "update", calendar: editing.calendar, uid: editing.uid, rid: editing.rid, which: editing.which, event }, closeEditor);
});
$("e-delete").addEventListener("click", () => {
  if (!editing) return;
  const b = $("e-delete");
  if (!Kit.ask(b, { ask: "Delete it?" })) return;
  send({ do: "delete", calendar: editing.calendar, uid: editing.uid, rid: editing.rid, which: editing.which }, closeEditor);
});
$("e-cancel").addEventListener("click", closeEditor);
$("editor").addEventListener("click", (e) => { if (e.target === $("editor")) closeEditor(); });
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") { if (!!Kit.isOpen()) popAway(); else if (editing) closeEditor(); else if (bridge) bridge.file(); }
  if (e.key === "Enter" && editing && e.target.tagName !== "TEXTAREA") $("e-save").click();
});

function say(text, error = false) { $("msg").textContent = text; $("msg").className = error ? "err" : ""; }

// ---------------------------------------------------------------- moving about

$("today").addEventListener("click", () => { focus = startOfDay(new Date()); draw(); fetchRange(); });
// The list of calendars, out or away — this page's own preference, kept.
$("side-toggle").innerHTML = Icons.sideList();
function sideShown(on) {
  document.body.classList.toggle("no-side", !on);
  $("side-toggle").classList.toggle("on", on);
  $("side-toggle").title = on ? "Hide the list of calendars" : "Show the list of calendars";
  try { localStorage.setItem("talaris.calendar.side", on ? "1" : "0"); } catch { /* fine */ }
}
let sideOn = true;
try { sideOn = localStorage.getItem("talaris.calendar.side") !== "0"; } catch { /* fine */ }
sideShown(sideOn);
$("side-toggle").addEventListener("click", () => { sideOn = !sideOn; sideShown(sideOn); });
function step(n) {
  if (mode === "day") focus = addDays(focus, n);
  else if (mode === "week") focus = addDays(focus, 7 * n);
  else focus = new Date(focus.getFullYear(), focus.getMonth() + n, 1);
  draw(); fetchRange();
}
$("prev").addEventListener("click", () => step(-1));
$("next").addEventListener("click", () => step(1));
$("new").addEventListener("click", () => { const at = new Date(); at.setMinutes(0, 0, 0); at.setHours(at.getHours() + 1); create(mode === "month" && !sameDay(focus, new Date()) ? (() => { const d = new Date(focus); d.setHours(9); return d; })() : at, false); });
// A panel's one button makes it a window (the expand corners); a window's one
// button closes it.
$("grow").addEventListener("click", () => bridge && bridge.grow());
$("close").addEventListener("click", () => bridge && bridge.closeWindow());
// Search (drawFound): as it is typed, a moment after; Escape empties it; Ctrl+F comes to it.
let searchTimer = 0;
$("search").addEventListener("input", () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => search($("search").value.trim()), 300); });
$("search").addEventListener("keydown", (e) => { if (e.key === "Escape" && $("search").value) { e.stopPropagation(); $("search").value = ""; search(""); } });
document.addEventListener("keydown", (e) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") { e.preventDefault(); $("search").focus(); $("search").select(); } });
$("grow").innerHTML = Icons.grow();
$("grow").title = "Make it a window";
$("grow").hidden = WINDOW;
$("close").innerHTML = Icons.close();
$("close").title = "Close";
$("close").hidden = !WINDOW;
// A press on the dim, off the panel, puts it away (and from Qt, which hears every press).
document.addEventListener("pointerdown", (e) => { if (!WINDOW && e.target === document.documentElement && bridge && surface.up) bridge.file(); });
window.pressedAt = (x, y) => { if (!WINDOW && bridge && surface.up && document.elementFromPoint(x, y) === document.documentElement) bridge.file(); };

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
  if (s.hidden) { hidden = new Set(s.hidden); if (s.up || WINDOW) draw(); }
  if (WINDOW) return;
  if (s.up && !was.up) {
    Motion.arrive(document.body, how());
    // Out to show one event: on its day; otherwise on today.
    focus = startOfDay(sought ? sought.at : new Date());
    draw(); fetchRange();
  }
}

/*
 * One event, asked for from elsewhere (a card on a canvas, a mention): the
 * calendar on its day, and its editor open once that range has arrived. A
 * repeating event is the occurrence nearest the time it was asked for at.
 */
let sought = null; // { calendar, uid, at }
function seek() {
  if (!sought) return;
  const mine = events.filter((e) => e.uid === sought.uid && (!sought.calendar || e.calendar === sought.calendar));
  if (!mine.length) return;
  const at = sought.at.getTime();
  const best = mine.reduce((a, b) => (Math.abs(b.start - at) < Math.abs(a.start - at) ? b : a));
  sought = null;
  edit(best);
}
window.Calendar = {
  show({ calendar, uid, start }) {
    const at = start ? new Date(start) : new Date();
    sought = { calendar, uid, at: Number.isNaN(at.getTime()) ? new Date() : at };
    focus = startOfDay(sought.at);
    draw(); fetchRange();
    // Not found in a while (gone, or on a calendar not shown): left, so the next opening is not hijacked.
    setTimeout(() => { if (sought && sought.uid === uid) { sought = null; say("That event is not on a calendar on show", true); } }, 8000);
  },
};

Surface.connect({ onState }).then((b) => {
  bridge = b;
  const hello = (text) => { const h = JSON.parse(text); status = h.status; calendars = h.calendars; draw(); fetchRange(); };
  b.hello(hello);
  b.status.connect((text) => { status = JSON.parse(text); draw(); fetchRange(); });
  b.calendars.connect((text) => { calendars = JSON.parse(text); draw(); });
  b.events.connect((text) => {
    const got = JSON.parse(text);
    if (got.req === searchReq && searching) { found.events = got.items; draw(); return; }
    if (got.req !== wanted) return;
    events = got.items; draw(); seek();
  });
  b.changed.connect(() => { if (surface.up || WINDOW) fetchRange(); });
  if (b.coreReply) b.coreReply.connect((text) => {
    const r = JSON.parse(text);
    const w = coreWaiting.get(r.id);
    if (!w) return;
    coreWaiting.delete(r.id);
    if (r.status >= 400) w.fail(new Error((r.data && r.data.error) || `the core answered ${r.status}`)); else w.ok(r.data);
  });
  // Tasks change elsewhere (Tasks, a sync): read again now and then while on show.
  setInterval(() => { if ((surface.up || WINDOW) && !document.hidden) fetchTasks(); }, 60000);
  b.people.connect((text) => showPeople(JSON.parse(text)));
  b.done.connect((text) => {
    const d = JSON.parse(text);
    const after = pending.get(d.req);
    pending.delete(d.req);
    if (d.error) { say(d.error, true); return; }
    say("");
    if (after) after();
    fetchRange();
  });
  b.leave.connect(() => {
    // The panel's leaving; a window is not going anywhere.
    if (WINDOW) return;
    surface = { ...surface, up: false };
    const going = Motion.leave(document.body, how());
    if (going) going.onfinish = () => bridge.left(); else bridge.left();
  });
});
draw();
