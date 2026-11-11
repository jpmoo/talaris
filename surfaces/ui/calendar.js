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
// The calendars plugins bring (the core's pluginCalendars), read only, and what is on them in the span on show.
let realCalendars = [], pluginCalendars = [], pluginEvents = [];
// A feed's occurrences made yours (on Talaris's own calendar): the feed's copy is not shown beside yours.
let taken = new Set();
const feedKey = (e) => `${e.calendar}/${e.uid}/${e.rid || ""}`;
const allCalendars = () => { calendars = [...realCalendars, ...pluginCalendars]; };
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
  // Three days from the one in focus: today and the two after it, when it opens on today.
  if (mode === "three") return [startOfDay(focus), addDays(startOfDay(focus), 3)];
  const first = new Date(focus.getFullYear(), focus.getMonth(), 1);
  const s = startOfWeek(first);
  return [s, addDays(s, 42)];
}
function fetchPlugins() {
  if (!bridge || typeof bridge.core !== "function") return;
  const [a, b] = span();
  core("GET", "/plugins/calendars").then((list) => { pluginCalendars = list || []; allCalendars(); draw(); }).catch(() => {});
  core("GET", "/plugins/calendars/taken").then((keys) => { taken = new Set(keys || []); draw(); }).catch(() => {});
  core("GET", `/plugins/calendars/events?from=${a.getTime()}&to=${b.getTime()}`).then((list) => {
    const [x, y] = span();
    if (x.getTime() !== a.getTime() || y.getTime() !== b.getTime()) return; // moved on meanwhile
    pluginEvents = list || [];
    draw();
  }).catch(() => {});
}
function fetchRange() {
  fetchTasks();
  fetchPlugins();
  if (!bridge || !status.ready) return;
  const [a, b] = span();
  wanted = ++req;
  bridge.ask(JSON.stringify({ do: "range", req: wanted, from: a.getTime(), to: b.getTime() }));
}
function title() {
  if (mode === "day") return focus.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
  if (mode === "week" || mode === "three") {
    const s = mode === "week" ? startOfWeek(focus) : startOfDay(focus), e = addDays(s, mode === "week" ? 6 : 2);
    return `${s.toLocaleDateString("en-US", { month: "short", day: "numeric" })} – ${e.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`;
  }
  return Kit.month(focus);
}
function shown() {
  return [...events, ...pluginEvents].filter((e) => !hidden.has(e.calendar) && !muted.has(e.calendar) && (declinedShown || e.mine !== "declined") && !taken.has(feedKey(e)));
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
// Asked of the core as every page asks it (kit.js): one book of what waits, 2xx the answer, given up on if none comes.
const asked = Kit.core((id, method, path, body) => !!bridge && (bridge.core(id, method, path, body), true));
function core(method, path, body) { return asked.call(method, path, body); }
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
    !waiting && !events.length && !tasksFound.length ? Kit.empty("Nothing matches") : null,
    waiting ? Kit.empty("Looking…") : null);
  view.replaceChildren(box);
}

// Nothing to show, said as every empty list is (Kit.empty), with what can be done about it under.
function note(text, ...more) {
  const n = Kit.empty(text);
  n.classList.add("note");
  n.append(...more.filter(Boolean));
  return n;
}

function draw() {
  if (searching) {
    $("title").textContent = `“${searching}”`;
    drawSide();
    drawFound($("view"));
    return;
  }
  $("title").textContent = title();
  seg("mode", [["day", "Day"], ["three", "3 days"], ["week", "Week"], ["month", "Month"]], mode, (m) => {
    mode = m; try { localStorage.setItem("talaris.calendar.mode", m); } catch { /* fine */ }
    draw(); fetchRange();
  });
  drawSide();
  const view = $("view");
  if (!status.ready) {
    view.replaceChildren(note(status.error || "Starting",
      status.needs ? el("p", {}, "Install them once, then the calendar starts by itself after Talaris restarts: ", el("br"), el("code", {}, `sudo apt install ${status.needs}`)) : ""));
    return;
  }
  if (!calendars.length) {
    view.replaceChildren(note("No calendars yet. Add a Google, Microsoft 365 or Apple account and its calendars appear here",
      el("p", {}, el("button", { class: "t-btn", onclick: () => bridge.accounts() }, "Add an account"))));
    return;
  }
  if (mode === "month") drawMonth(view); else drawDays(view, mode === "week" ? 7 : mode === "three" ? 3 : 1);
}

// The calendars on show, by account: a key to their colors. Which are on
// show is Settings, Accounts' to say; those turned off are not here at all.
const showing = () => calendars.filter((c) => !hidden.has(c.id));
// Sections of the list put away by their heading: this page's own preference, kept.
let shut = new Set();
try { shut = new Set(JSON.parse(localStorage.getItem("talaris.calendar.shut") || "[]")); } catch { /* fine */ }
function toggleShut(name) {
  if (shut.has(name)) shut.delete(name); else shut.add(name);
  try { localStorage.setItem("talaris.calendar.shut", JSON.stringify([...shut])); } catch { /* fine */ }
  drawSide();
}
/** A heading that puts its section away, and what is under it unless it is away. */
const section = (name, ...kids) => [
  el("h3", { class: "fold", title: shut.has(name) ? "Show this section" : "Put this section away", onclick: () => toggleShut(name) }, Kit.caret(!shut.has(name)), name),
  ...(shut.has(name) ? [] : kids),
];
function drawSide() {
  const byAccount = {};
  for (const c of showing()) (byAccount[c.account] ||= []).push(c);
  const side = $("side");
  // Feeds are known by being feeds, not by their heading's name; the button that brings one in sits with them, or makes their heading.
  const addFeedBtn = el("button", { class: "t-btn add-feed", onclick: (ev) => addFeed(ev.currentTarget) }, "+ Feed");
  const feedsHeading = Object.entries(byAccount).find(([, list]) => list.every((c) => c.feed));
  const calRow = (c) => el("div", { class: "cal" + (muted.has(c.id) ? " muted" : " on"), style: `--c:${c.color || "var(--accent)"}`, title: c.feed ? "A feed: right-click for its color, or to remove it" : c.writable ? "" : "Read only",
    ...(c.feed ? { oncontextmenu: (ev) => { ev.preventDefault(); feedMenu(ev, c); } } : {}) },
    el("button", { class: "sw", title: muted.has(c.id) ? "Show its events" : "Hide its events", onclick: () => mute(c.id) }), el("span", {}, c.name));
  side.replaceChildren(...Object.entries(byAccount).flatMap(([account, list]) =>
    section(account, ...list.map(calRow), ...(feedsHeading && feedsHeading[0] === account ? [addFeedBtn] : []))),
  ...(feedsHeading ? [] : section("Feeds", addFeedBtn)),
  ...section("Show",
  el("div", { class: "cal" + (declinedShown ? " on" : " muted"), style: "--c:var(--muted)" },
    el("button", { class: "sw", title: declinedShown ? "Hide declined events" : "Show declined events", onclick: () => showDeclined(!declinedShown) }),
    el("span", {}, "Declined events")),
  // The forecast on the days and hours (location.py): ten days ahead, where you are.
  el("div", { class: "cal" + (weatherShown ? " on" : " muted"), style: "--c:var(--muted)" },
    el("button", { class: "sw", title: weatherShown ? "Hide the weather" : "Show the weather on its days and hours", onclick: () => showWeather(!weatherShown) }),
    el("span", {}, "Weather")),
  // Tasks are drawn in Day and Week only, so they are offered there only.
  ...(mode === "month" ? [] : [
    el("div", { class: "cal" + (tasksShown ? " on" : " muted"), style: "--c:var(--accent)" },
      el("button", { class: "sw", title: tasksShown ? "Hide tasks on their days" : "Show tasks on their days", onclick: () => showTasks("tasks", !tasksShown) }),
      el("span", {}, "Available/Due Tasks")),
    el("div", { class: "cal" + (overdueShown ? " on" : " muted"), style: "--c:var(--danger)" },
      el("button", { class: "sw", title: overdueShown ? "Hide overdue tasks" : "Show overdue tasks on today", onclick: () => showTasks("overdue", !overdueShown) }),
      el("span", {}, "Overdue Tasks")),
  ])));
}

// ---------------------------------------------------------------- feeds
//
// A feed (an .ics address) is brought in as a calendar of its own, kept by
// the calendar's process as the accounts' are (calendard.py, "On the web"),
// read only. One of its events is made yours from its card (eventcard.js).

function addFeed(button) {
  const url = el("input", { type: "text", placeholder: "https://… or webcal://…", spellcheck: "false" });
  const name = el("input", { type: "text", placeholder: "Name (optional)" });
  const go = el("button", { class: "t-btn" }, "Add");
  const note = el("div", { class: "feed-note" });
  const bring = () => {
    if (!url.value.trim()) { url.focus(); return; }
    go.disabled = true;
    note.textContent = "Adding…";
    send({ do: "subscribe", url: url.value.trim(), name: name.value.trim() }).then(() => {
      popAway();
      say("Feed added; its events arrive in a moment");
    }, (x) => { go.disabled = false; note.textContent = x.message || "It was not added"; });
  };
  go.addEventListener("click", bring);
  for (const i of [url, name]) i.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); bring(); } });
  Kit.pop(button, el("div", { class: "feed-form" }, el("label", {}, "Feed address"), url, name, el("div", { class: "row" }, go), note));
  setTimeout(() => url.focus(), 30);
}
function feedMenu(ev, c) {
  // Its color, as Settings offers every calendar's (Palette, as Google's and Outlook's own run).
  const colors = el("div", { class: "feed-colors" }, ...Palette.COLORS.map((col) => el("button", {
    class: "sw" + (col === c.color ? " is-on" : ""), style: `background:${col}`, title: col,
    onclick: () => { popAway(); send({ do: "color", calendar: c.id, color: col }).catch((x) => say(x.message || "The color was not changed", true)); } })));
  const off = el("button", { class: "t-btn danger" }, "Remove feed");
  Kit.twice(off, { key: `unfeed:${c.id}`, ask: "Remove it?", act: () => {
    popAway();
    send({ do: "unsubscribe", calendar: c.id }).then(() => say(`${c.name} removed`), (x) => say(x.message || "It was not removed", true));
  } });
  Kit.pop({ x: ev.clientX, y: ev.clientY }, el("div", { class: "feed-form" }, el("label", {}, c.name), colors, el("div", { class: "row" }, off)));
}

// Declined, faded; still to come and unanswered, a dashed edge.
function answerClass(e) {
  if (e.mine === "declined") return " declined";
  return e.mine === "waiting" && e.end > Date.now() ? " waiting" : "";
}
function chip(e, timedLook) {
  return el("div", { class: "ev-chip" + (timedLook && !e.allDay ? " timed" : "") + answerClass(e), style: `--c:${colorOf(e.calendar)}`, title: e.title,
    onclick: (ev) => { ev.stopPropagation(); edit(e); } }, (!e.allDay ? `${clock(e.start)} ` : "") + (e.title || "(no title)"));
}

// ---------------------------------------------------------------- the weather on its days and hours
//
// Shown or not (the header's Weather; remembered): the forecast where you are (location.py), ten days of it,
// asked for when shown and when the calendar comes out. Days beyond it, and days gone, have none.
let weatherShown = false;
try { weatherShown = localStorage.getItem("talaris.calendar.weather") === "1"; } catch { /* fine */ }
let weather = { days: new Map(), hours: new Map(), unit: "" };
const ymdOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
function readWeather() { if (weatherShown && bridge && bridge.weatherRead) bridge.weatherRead(); }
function gotWeather(text) {
  const got = JSON.parse(text);
  const s = got.state;
  weather = s ? { days: new Map(s.days.map((d) => [d.at, d])), hours: new Map(s.hours.map((h) => [h.at.slice(0, 13), h])), unit: s.unit } : { days: new Map(), hours: new Map(), unit: "" };
  if (!s && weatherShown) say(got.error || "No forecast just now");
  draw();
}
function wxDay(d) {
  const w = weatherShown && weather.days.get(ymdOf(d));
  if (!w) return null;
  const span = el("span", { class: "wx-day", title: `${w.sky}, ${w.hi}° / ${w.lo}°${w.rain >= 20 ? `, ${w.rain}% rain` : ""}` });
  span.innerHTML = `${Icons.sky(w.icon, true)}<span>${w.hi}°</span><span class="lo">${w.lo}°</span>`;
  return span;
}
function wxHour(d, h) {
  const w = weatherShown && weather.hours.get(`${ymdOf(d)}T${String(h).padStart(2, "0")}`);
  if (!w) return null;
  const span = el("span", { class: "wx-hour", title: `${w.sky}, ${w.temp}°${w.rain >= 20 ? `, ${w.rain}% rain` : ""}` });
  span.innerHTML = `${Icons.sky(w.icon, w.day)}<span>${w.temp}°</span>`;
  return span;
}
function showWeather(on) {
  weatherShown = on;
  try { localStorage.setItem("talaris.calendar.weather", on ? "1" : "0"); } catch { /* fine */ }
  if (on) readWeather();
  draw();
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
    cell.append(el("div", { class: "top" },
      el("span", { class: "n", title: "This day", onclick: () => { focus = day; mode = "day"; draw(); fetchRange(); } }, String(day.getDate())),
      wxDay(day)));
    const list = onDay(day);
    // As many as fit; the rest a count that opens the day.
    const room = 3;
    list.slice(0, room).forEach((e) => cell.append(chip(e, true)));
    if (list.length > room) cell.append(el("span", { class: "more", onclick: () => { focus = day; mode = "day"; draw(); fetchRange(); } }, `${list.length - room} more`));
    grid.append(cell);
  }
  view.replaceChildren(grid);
}

/**
 * A day's timed events, each told where it stands across the day: `_lane`, of
 * `_lanes`, spanning `_span` of them. Lanes are shared only among events that
 * overlap — one at a time, or through others that do — so an event at 9 is as
 * wide as the day though three meet at 2; and an event takes the lanes beside
 * it that nothing beside it is using. Drawn shorter than 18px, an event takes
 * that much room, so it is laid out as that tall.
 */
function sideBySide(events) {
  const least = 18 / 48 * 3600000;
  const endOf = (e) => Math.max(e.end, e.start + least);
  const sorted = events.slice().sort((a, b) => a.start - b.start || endOf(b) - endOf(a));
  const groups = [];
  let group = [], reach = -Infinity;
  for (const e of sorted) {
    if (group.length && e.start >= reach) { groups.push(group); group = []; reach = -Infinity; }
    group.push(e);
    reach = Math.max(reach, endOf(e));
  }
  if (group.length) groups.push(group);
  for (const g of groups) {
    const lanes = [];
    for (const e of g) {
      let lane = lanes.findIndex((list) => list.every((x) => endOf(x) <= e.start || x.start >= endOf(e)));
      if (lane < 0) { lane = lanes.length; lanes.push([]); }
      lanes[lane].push(e);
      e._lane = lane;
    }
    for (const e of g) {
      e._lanes = lanes.length;
      // Wider, into the lanes to its right while nothing in them meets it.
      let span = 1;
      while (e._lane + span < lanes.length && lanes[e._lane + span].every((x) => endOf(x) <= e.start || x.start >= endOf(e))) span++;
      e._span = span;
    }
  }
  return sorted;
}

function drawDays(view, cols) {
  const [start] = span();
  const today = new Date();
  const days = Array.from({ length: cols }, (_, i) => addDays(start, i));
  const wrap = el("div", { class: "days", style: `--cols:${cols}` });
  wrap.append(el("div", { class: "dayhead" }, el("div"), ...days.map((d) => el("div", { class: sameDay(d, today) ? "today" : "" },
    d.toLocaleDateString("en-US", { weekday: "short", month: cols === 1 ? "long" : undefined, day: "numeric" }), wxDay(d)))));
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
      col.append(el("div", { class: "slot", ondblclick: () => create(at, false) }, wxHour(d, h)));
    }
    // Timed events laid side by side where they overlap (sideBySide).
    const timed = sideBySide(onDay(d).filter((e) => !e.allDay));
    const dayStart = startOfDay(d).getTime();
    for (const e of timed) {
      const top = Math.max(0, (e.start - dayStart) / 3600000) * 48;
      const bottom = Math.min(24, (e.end - dayStart) / 3600000) * 48;
      const width = 100 / e._lanes;
      col.append(el("div", { class: "ev" + answerClass(e), style: `--c:${colorOf(e.calendar)};top:${top}px;height:${Math.max(18, bottom - top - 2)}px;left:calc(${e._lane * width}% + 2px);right:auto;width:calc(${width * e._span}% - 4px)`,
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
  grid.scrollTop = Math.max(0, (days.some((d) => sameDay(d, today)) ? Math.min(new Date().getHours() - 1, 16) : 8)) * 48;
}

// ---------------------------------------------------------------- making and changing

let editing = null;
// One pop-up at a time, the kit's (kit.js): placed under what opened it (or above, with more room there),
// kept on screen, scrolling when long, put away by a press elsewhere or Escape — the same on every page.
const popAway = () => Kit.popAway();


// The one card (thingcard.js, eventcard.js), as the Library shows it, over the calendar.
const pending = new Map();
function send(msg) {
  return new Promise((ok, no) => {
    msg.req = ++req;
    pending.set(msg.req, { ok, no });
    bridge.ask(JSON.stringify(msg));
  });
}
const cardCtx = () => ({ api: core, say, failed: (x) => say(x.message || "It did not work", true), bridge, hub: "calendar",
  calendars: () => calendars.map((c) => ({ ...c, hidden: hidden.has(c.id) })), send,
  // Anything named on it is its card, in the Library; a task or a person, where it lives.
  open: (key) => { if (window.Peek) Peek.openCard(key); },
  openMention: null,
  redraw: () => {}, close: closeEditor, saved: () => { fetchPlugins(); fetchRange(); } });
function open(e, isNew) {
  popAway();
  ThingCard.putAway();
  const [card] = EventCard.parts(e, isNew, cardCtx(), ThingCard.connected);
  editing = card;
  $("editor-box").replaceChildren(card);
  $("editor").classList.add("open");
  setTimeout(() => { if (editing === card) card.focusTitle(); }, 30);
}
function edit(e) { open(e, false); }
function create(at, allDay) {
  if (!showing().some((c) => c.writable)) { say("No calendar on show can be written to", true); return; }
  const start = allDay ? startOfDay(at) : at;
  open({ start: start.getTime(), end: allDay ? start.getTime() + DAY_MS : start.getTime() + 3600000, allDay }, true);
}
function closeEditor() { popAway(); ThingCard.putAway(); $("editor").classList.remove("open"); $("editor-box").replaceChildren(); editing = null; }

$("editor").addEventListener("click", (e) => { if (e.target === $("editor")) closeEditor(); });
// A press elsewhere in it puts a list away.
$("editor").addEventListener("click", (e) => { if (!e.target.closest(".kit-pop") && !e.target.classList.contains("time-in")) popAway(); });
document.addEventListener("keydown", (e) => {
  // What has heard Escape already (a field of its own, a box cleared) keeps it: the innermost first, then the panel.
  if (e.key === "Escape" && e.defaultPrevented) return;
  if (e.key === "Escape") { if (Kit.isOpen()) popAway(); else if (editing) closeEditor(); else if (bridge) bridge.file(); }
  // Enter saves, but in what is written in (the description is the editor): there it is the next line. On a button it presses that.
  if (e.key === "Enter" && editing && !e.defaultPrevented && e.target.tagName !== "TEXTAREA" && e.target.tagName !== "BUTTON" && !e.target.isContentEditable) editing.save();
});

// Said as every page says it (kit.js): one line, sentence case, an error in the danger color.

function say(text, error = false) { Kit.say($("msg"), text, error, 0); }

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
  else if (mode === "three") focus = addDays(focus, 3 * n);
  else focus = new Date(focus.getFullYear(), focus.getMonth() + n, 1);
  draw(); fetchRange();
}
$("prev").innerHTML = Icons.prev();
$("next").innerHTML = Icons.next();
$("prev").addEventListener("click", () => step(-1));
$("next").addEventListener("click", () => step(1));
// A touchpad's two-finger swipe, left or right, over the calendar: a day, a week or a month on or back,
// as the arrows do — left is on, as a page is turned. One swipe is one step: its deltas add up to
// SWIPE_PX, then nothing more is taken until the swipe (and its glide) has stopped for a moment.
const SWIPE_PX = 90, SWIPE_REST_MS = 260;
let swiped = 0, swipeDone = false, swipeQuiet = null;
document.querySelector("main").addEventListener("wheel", (e) => {
  if (editing || Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;
  e.preventDefault();
  clearTimeout(swipeQuiet);
  swipeQuiet = setTimeout(() => { swiped = 0; swipeDone = false; }, SWIPE_REST_MS);
  if (swipeDone) return;
  swiped += e.deltaX;
  if (Math.abs(swiped) >= SWIPE_PX) { step(swiped > 0 ? 1 : -1); swipeDone = true; }
}, { passive: false });
$("new").addEventListener("click", () => { const at = new Date(); at.setMinutes(0, 0, 0); at.setHours(at.getHours() + 1); create(mode === "month" && !sameDay(focus, new Date()) ? (() => { const d = new Date(focus); d.setHours(9); return d; })() : at, false); });
// A panel's one button makes it a window (the expand corners); a window's one
// button closes it.
$("grow").addEventListener("click", () => bridge && bridge.grow());
$("close").addEventListener("click", () => bridge && bridge.closeWindow());
// Search (drawFound): as it is typed, a moment after; Escape empties it; Ctrl+F comes to it.
let searchTimer = 0;
// Escape clears it first, as every box that narrows a list does (kit.js).
Kit.searchBox($("search"));
$("search").addEventListener("input", () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => search($("search").value.trim()), Kit.SEARCH_MS); });
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
    draw(); fetchRange(); readWeather();
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
  const hello = (text) => { const h = JSON.parse(text); status = h.status; realCalendars = h.calendars; allCalendars(); draw(); fetchRange(); };
  b.hello(hello);
  b.status.connect((text) => { status = JSON.parse(text); draw(); fetchRange(); });
  b.calendars.connect((text) => { realCalendars = JSON.parse(text); allCalendars(); draw(); });
  b.events.connect((text) => {
    const got = JSON.parse(text);
    if (got.req === searchReq && searching) { found.events = got.items; draw(); return; }
    if (got.req !== wanted) return;
    events = got.items; draw(); seek();
  });
  b.changed.connect(() => { if (surface.up || WINDOW) fetchRange(); });
  if (b.coreReply) b.coreReply.connect((text) => asked.reply(JSON.parse(text)));
  // Tasks change elsewhere (Tasks, a sync): read again now and then while on show.
  setInterval(() => { if ((surface.up || WINDOW) && !document.hidden) { fetchTasks(); fetchPlugins(); } }, 60000);
  if (b.weather) { b.weather.connect(gotWeather); readWeather(); }
  b.done.connect((text) => {
    const d = JSON.parse(text);
    const wait = pending.get(d.req);
    pending.delete(d.req);
    if (wait) { if (d.error) wait.no(new Error(d.error)); else wait.ok(d); }
    else if (d.error) say(d.error, true);
    if (!d.error) fetchRange();
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
