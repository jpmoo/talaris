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
let req = 0;
let wanted = 0;
// The calendars not shown: Talaris's setting (Settings, Accounts, or the list here).
let hidden = new Set();
try { mode = localStorage.getItem("talaris.calendar.mode") || "month"; } catch { /* fine */ }

const DAY_MS = 86400000;
function startOfDay(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function sameDay(a, b) { return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate(); }
// Weeks start on Sunday, as the bar's clock reads in en-US.
function startOfWeek(d) { return addDays(startOfDay(d), -startOfDay(d).getDay()); }
const clock = (ms) => new Date(ms).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
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
  return focus.toLocaleDateString("en-US", { month: "long", year: "numeric" });
}
function shown() { return events.filter((e) => !hidden.has(e.calendar)); }
// The events on a day: those that start before it ends and end after it starts.
function onDay(day) {
  const a = startOfDay(day).getTime(), b = a + DAY_MS;
  return shown().filter((e) => e.start < b && (e.end > a || e.start === e.end && e.start >= a));
}

// ---------------------------------------------------------------- drawing

function draw() {
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

function drawSide() {
  const byAccount = {};
  for (const c of calendars) (byAccount[c.account] ||= []).push(c);
  const side = $("side");
  side.replaceChildren(...Object.entries(byAccount).flatMap(([account, list]) => [
    el("h3", {}, account),
    ...list.map((c) => el("div", { class: "cal" + (hidden.has(c.id) ? "" : " on"), style: `--c:${c.color || "var(--accent)"}`, title: c.writable ? "" : "Read only",
      onclick: () => {
        if (hidden.has(c.id)) hidden.delete(c.id); else hidden.add(c.id);
        draw();
        bridge.setHidden(JSON.stringify([...hidden]));
      } }, el("span", { class: "sw" }), el("span", {}, c.name))),
  ]), el("h3", {}, "Accounts"), el("button", { class: "t-btn", onclick: () => bridge.accounts() }, "Accounts…"));
}

function chip(e, timedLook) {
  return el("div", { class: "chip" + (timedLook && !e.allDay ? " timed" : ""), style: `--c:${colorOf(e.calendar)}`, title: e.title,
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
  wrap.append(el("div", { class: "allday" }, el("div", {}, "all day"), ...days.map((d) =>
    el("div", { ondblclick: () => create(d, true) }, ...onDay(d).filter((e) => e.allDay).map((e) => chip(e, false))))));
  const grid = el("div", { class: "grid" });
  const hours = el("div", { class: "hours" });
  const label = el("div", {}, ...Array.from({ length: 24 }, (_, h) => el("div", { class: "hour" }, h ? new Date(2000, 0, 1, h).toLocaleTimeString("en-US", { hour: "numeric" }) : "")));
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
      col.append(el("div", { class: "ev", style: `--c:${colorOf(e.calendar)};top:${top}px;height:${Math.max(18, bottom - top - 2)}px;left:calc(${e._lane * width}% + 2px);right:auto;width:calc(${width}% - 4px)`,
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

let editing = null;
const pad = (n) => String(n).padStart(2, "0");
const dateIn = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const timeIn = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
function fromInputs(date, time) { const [y, m, d] = date.split("-").map(Number); const [h, mi] = (time || "00:00").split(":").map(Number); return new Date(y, m - 1, d, h, mi); }

function open(e, isNew) {
  editing = { ...e, isNew };
  const writable = calendars.filter((c) => c.writable);
  $("e-cal").replaceChildren(...writable.map((c) => el("option", { value: c.id }, `${c.name} · ${c.account}`)));
  $("e-cal").value = e.calendar || (writable[0] || {}).id || "";
  $("e-cal").disabled = !isNew;
  $("e-title").value = e.title || "";
  $("e-allday").checked = !!e.allDay;
  const s = new Date(e.start);
  const end = new Date(e.allDay ? e.end - DAY_MS : e.end);
  $("e-sd").value = dateIn(s); $("e-st").value = timeIn(s);
  $("e-ed").value = dateIn(end); $("e-et").value = timeIn(end);
  $("e-where").value = e.location || "";
  $("e-notes").value = e.notes || "";
  allDayInputs();
  $("e-which-row").hidden = isNew || !e.recurring;
  // A repeating event: this one alone, or every one of them.
  const which = (w) => { editing.which = w; seg("e-which", [["this", "This one"], ["all", "Every one"]], w, which); };
  which("this");
  $("e-delete").hidden = isNew;
  const ro = !isNew && !(calendars.find((c) => c.id === e.calendar) || {}).writable;
  for (const id of ["e-title", "e-allday", "e-sd", "e-st", "e-ed", "e-et", "e-where", "e-notes", "e-save", "e-delete"]) $(id).disabled = ro;
  $("editor").classList.add("open");
  setTimeout(() => $("e-title").focus(), 30);
}
function allDayInputs() { $("e-st").hidden = $("e-et").hidden = $("e-allday").checked; }
function edit(e) { open(e, false); }
function create(at, allDay) {
  if (!calendars.some((c) => c.writable)) { say("No calendar here can be written to", true); return; }
  const start = allDay ? startOfDay(at) : at;
  open({ start: start.getTime(), end: allDay ? start.getTime() + DAY_MS : start.getTime() + 3600000, allDay }, true);
}
function closeEditor() { $("editor").classList.remove("open"); editing = null; }

function collected() {
  const allDay = $("e-allday").checked;
  let start = fromInputs($("e-sd").value, allDay ? "00:00" : $("e-st").value);
  let end = fromInputs($("e-ed").value, allDay ? "00:00" : $("e-et").value);
  if (allDay) end = addDays(end, 1);
  if (end <= start) end = new Date(start.getTime() + (allDay ? DAY_MS : 3600000));
  return { title: $("e-title").value.trim(), allDay, start: start.getTime(), end: end.getTime(), location: $("e-where").value, notes: $("e-notes").value };
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
  if (editing.isNew) send({ do: "create", calendar: $("e-cal").value, event }, closeEditor);
  else send({ do: "update", calendar: editing.calendar, uid: editing.uid, rid: editing.rid, which: editing.which, event }, closeEditor);
});
$("e-delete").addEventListener("click", () => {
  if (!editing) return;
  const b = $("e-delete");
  if (!b.dataset.armed) { b.dataset.armed = "1"; b.textContent = "Delete it?"; setTimeout(() => { delete b.dataset.armed; b.textContent = "Delete"; }, 4000); return; }
  send({ do: "delete", calendar: editing.calendar, uid: editing.uid, rid: editing.rid, which: editing.which }, closeEditor);
});
$("e-cancel").addEventListener("click", closeEditor);
$("e-allday").addEventListener("change", allDayInputs);
$("editor").addEventListener("click", (e) => { if (e.target === $("editor")) closeEditor(); });
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") { if (editing) closeEditor(); else if (bridge) bridge.file(); }
  if (e.key === "Enter" && editing && e.target.tagName !== "TEXTAREA") $("e-save").click();
});

function say(text, error = false) { $("msg").textContent = text; $("msg").className = error ? "err" : ""; }

// ---------------------------------------------------------------- moving about

$("today").addEventListener("click", () => { focus = startOfDay(new Date()); draw(); fetchRange(); });
function step(n) {
  if (mode === "day") focus = addDays(focus, n);
  else if (mode === "week") focus = addDays(focus, 7 * n);
  else focus = new Date(focus.getFullYear(), focus.getMonth() + n, 1);
  draw(); fetchRange();
}
$("prev").addEventListener("click", () => step(-1));
$("next").addEventListener("click", () => step(1));
$("new").addEventListener("click", () => { const at = new Date(); at.setMinutes(0, 0, 0); at.setHours(at.getHours() + 1); create(mode === "month" && !sameDay(focus, new Date()) ? (() => { const d = new Date(focus); d.setHours(9); return d; })() : at, false); });
$("grow").addEventListener("click", () => bridge && bridge.grow());
$("close").addEventListener("click", () => bridge && bridge.file());
// A press on the dim, off the panel, puts it away (and from Qt, which hears every press).
document.addEventListener("pointerdown", (e) => { if (e.target === document.documentElement && bridge && surface.up && !surface.expanded) bridge.file(); });
window.pressedAt = (x, y) => { if (bridge && surface.up && !surface.expanded && document.elementFromPoint(x, y) === document.documentElement) bridge.file(); };

// ---------------------------------------------------------------- coming and going

function how() {
  const m = surface.motion || {};
  return { kind: m.motion, speed: m.speed, edge: "top", flush: false, backdrop: document.documentElement,
    rules: (rule, rel, P) => { const h = document.querySelector("header").getBoundingClientRect(); rule(rel(P.left, h.bottom), rel(P.right, h.bottom)); } };
}
function onState(s) {
  const was = surface;
  surface = s;
  if (s.hidden) { hidden = new Set(s.hidden); if (s.up) draw(); }
  if (s.expanded) document.documentElement.dataset.expanded = "1"; else delete document.documentElement.dataset.expanded;
  $("grow").innerHTML = s.expanded ? (s.closes ? Icons.close() : Icons.shrink()) : Icons.grow();
  $("grow").title = s.expanded ? (s.closes ? "Close" : "Back to a panel") : "Full screen";
  $("close").innerHTML = Icons.close();
  // Floating, a press off it closes it; full screen, a button does.
  $("close").hidden = !s.expanded || s.closes;
  if (s.up && !was.up && !s.expanded) {
    Motion.arrive(document.body, how());
    focus = startOfDay(new Date());
    draw(); fetchRange();
  } else if (s.up && !!s.expanded !== !!was.expanded) Motion.reset(document.body, how());
}

Surface.connect({ onState }).then((b) => {
  bridge = b;
  const hello = (text) => { const h = JSON.parse(text); status = h.status; calendars = h.calendars; draw(); fetchRange(); };
  b.hello(hello);
  b.status.connect((text) => { status = JSON.parse(text); draw(); fetchRange(); });
  b.calendars.connect((text) => { calendars = JSON.parse(text); draw(); });
  b.events.connect((text) => { const got = JSON.parse(text); if (got.req !== wanted) return; events = got.items; draw(); });
  b.changed.connect(() => { if (surface.up) fetchRange(); });
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
    surface = { ...surface, up: false };
    const going = Motion.leave(document.body, how());
    if (going) going.onfinish = () => bridge.left(); else bridge.left();
  });
});
draw();
