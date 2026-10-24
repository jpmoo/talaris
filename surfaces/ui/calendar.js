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

// The calendars on show, by account: a key to their colors. Which are on
// show is Settings, Accounts' to say; those turned off are not here at all.
const showing = () => calendars.filter((c) => !hidden.has(c.id));
function drawSide() {
  const byAccount = {};
  for (const c of showing()) (byAccount[c.account] ||= []).push(c);
  const side = $("side");
  side.replaceChildren(...Object.entries(byAccount).flatMap(([account, list]) => [
    el("h3", {}, account),
    ...list.map((c) => el("div", { class: "cal on", style: `--c:${c.color || "var(--accent)"}`, title: c.writable ? "" : "Read only" },
      el("span", { class: "sw" }), el("span", {}, c.name))),
  ]), el("h3", {}, "Accounts"), el("button", { class: "t-btn", onclick: () => bridge.accounts() }, "Accounts…"));
}

function chip(e, timedLook) {
  return el("div", { class: "chip" + (timedLook && !e.allDay ? " timed" : "") + (e.mine === "waiting" || e.mine === "declined" ? ` ${e.mine}` : ""), style: `--c:${colorOf(e.calendar)}`, title: e.title,
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
      col.append(el("div", { class: "ev" + (e.mine === "waiting" || e.mine === "declined" ? ` ${e.mine}` : ""), style: `--c:${colorOf(e.calendar)};top:${top}px;height:${Math.max(18, bottom - top - 2)}px;left:calc(${e._lane * width}% + 2px);right:auto;width:calc(${width}% - 4px)`,
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
const dayLabel = (d) => d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" });
const timeLabel = (m) => new Date(2000, 0, 1, Math.floor(m / 60), m % 60).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
/** "9", "9:30", "930", "9:30 pm", "21:30" — minutes after midnight, or null. */
function parseTime(text) {
  const t = text.trim().toLowerCase().replace(/\s+/g, "");
  const m = t.match(/^(\d{1,2})(?::?(\d{2}))?(a|am|p|pm)?$/);
  if (!m) return null;
  let h = Number(m[1]); const mi = Number(m[2] || 0);
  if (mi > 59) return null;
  if (m[3]) { if (h < 1 || h > 12) return null; h = (h % 12) + (m[3][0] === "p" ? 12 : 0); }
  if (h > 23) return null;
  return h * 60 + mi;
}

// One small list at a time, under what opened it.
function popUnder(anchor, content) {
  const pop = $("pop");
  pop.replaceChildren(content);
  const box = document.querySelector("#editor .box").getBoundingClientRect(), r = anchor.getBoundingClientRect();
  pop.style.left = `${r.left - box.left}px`;
  pop.style.top = `${r.bottom - box.top + 4}px`;
  pop.hidden = false;
  pop.dataset.for = anchor.id;
}
function popAway() { $("pop").hidden = true; delete $("pop").dataset.for; }

function monthPicker(chosen, pick) {
  let shown = new Date(chosen.getFullYear(), chosen.getMonth(), 1);
  const wrap = el("div", { class: "mini" });
  const drawMini = () => {
    const first = startOfWeek(shown);
    wrap.replaceChildren(
      el("div", { class: "mini-head" },
        el("button", { class: "frame", onclick: (e) => { e.stopPropagation(); shown = new Date(shown.getFullYear(), shown.getMonth() - 1, 1); drawMini(); } }, "‹"),
        el("span", {}, shown.toLocaleDateString("en-US", { month: "long", year: "numeric" })),
        el("button", { class: "frame", onclick: (e) => { e.stopPropagation(); shown = new Date(shown.getFullYear(), shown.getMonth() + 1, 1); drawMini(); } }, "›")),
      el("div", { class: "mini-grid" },
        ...["S", "M", "T", "W", "T", "F", "S"].map((d) => el("span", { class: "dow" }, d)),
        ...Array.from({ length: 42 }, (_, i) => {
          const d = addDays(first, i);
          return el("button", { class: "day" + (d.getMonth() !== shown.getMonth() ? " other" : "") + (sameDay(d, chosen) ? " on" : "") + (sameDay(d, new Date()) ? " today" : ""),
            onclick: (e) => { e.stopPropagation(); pick(d); popAway(); } }, String(d.getDate()));
        })));
  };
  drawMini();
  return wrap;
}
function timeList(current, pick) {
  const list = el("div", { class: "times" });
  for (let m = 0; m < 24 * 60; m += 15) {
    list.append(el("button", { class: "time" + (m === current ? " on" : ""), onclick: (e) => { e.stopPropagation(); pick(m); popAway(); } }, timeLabel(m)));
  }
  setTimeout(() => { const on = list.querySelector(".on") || list.children[Math.floor((current ?? 540) / 15)]; if (on) list.scrollTop = on.offsetTop - 60; }, 0);
  return list;
}

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
  if (!editing || $("pop").dataset.for === "e-until") { popAway(); return; }
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
  if (!editing || $("pop").dataset.for === "e-cal") { popAway(); return; }
  popUnder($("e-cal"), el("div", { class: "menu-list" }, ...showing().filter((c) => c.writable).map((c) =>
    el("button", { class: "time" + (c.id === editing.v.calendar ? " on" : ""), onclick: (e) => { e.stopPropagation(); editing.v.calendar = c.id; popAway(); paintEditor(); } },
      el("span", { class: "sw", style: `background:${c.color || "var(--accent)"}` }), `${c.name} · ${c.account}`))));
});
$("e-allday").addEventListener("click", () => { if (!editing) return; editing.v.allDay = !editing.v.allDay; paintEditor(); });
for (const [id, key] of [["e-sd", "sd"], ["e-ed", "ed"]]) {
  $(id).addEventListener("click", (ev) => {
    ev.stopPropagation();
    if (!editing || $("pop").dataset.for === id) { popAway(); return; }
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
  if (!b.dataset.armed) { b.dataset.armed = "1"; b.textContent = "Delete it?"; setTimeout(() => { delete b.dataset.armed; b.textContent = "Delete"; }, 4000); return; }
  send({ do: "delete", calendar: editing.calendar, uid: editing.uid, rid: editing.rid, which: editing.which }, closeEditor);
});
$("e-cancel").addEventListener("click", closeEditor);
$("editor").addEventListener("click", (e) => { if (e.target === $("editor")) closeEditor(); });
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") { if (!$("pop").hidden) popAway(); else if (editing) closeEditor(); else if (bridge) bridge.file(); }
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
  console.warn(`DEBUG calendar state up=${s.up} was=${was.up} expanded=${s.expanded}`);
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
    console.warn("DEBUG calendar leave");
    surface = { ...surface, up: false };
    const going = Motion.leave(document.body, how());
    if (going) going.onfinish = () => bridge.left(); else bridge.left();
  });
});
draw();
