// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore
//
// The Settings page. Talaris's own settings save the moment they change; the
// process checks them and moves whatever they move. Morgan's go to Morgan
// together, on Save, because saving some of them restarts it.

"use strict";

const $ = (id) => document.getElementById(id);
let bridge = null;
let cfg = null;
let fonts = [];

// The accents of the approved theme (palette.js); any other by its hex.
const ACCENTS = Palette.ACCENTS;
const EDGE_NAMES = { top: "Top", bottom: "Bottom", left: "Left", right: "Right" };

function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (k === "class") e.className = v;
    else e.setAttribute(k, v);
  }
  e.append(...kids);
  return e;
}

// Said as every page says it (kit.js): one line, sentence case, an error in the danger color.

function say(text, error = false) { Kit.say($("msg"), text, error, 0); }

/** Ask the process to keep a change; it answers why not, or nothing. */
function save(change) {
  bridge.save(JSON.stringify(change), (error) => {
    if (error) { say(error, true); draw(); return; }
    say("Saved");
    bridge.config((text) => { cfg = JSON.parse(text).config; draw(); if ($("data").classList.contains("on")) drawData(); });
  });
}

function seg(host, choices, current, pick, disabled = () => false) {
  $(host).replaceChildren(...choices.map(([value, label]) =>
    el("button", { class: value === current ? "on" : "", onclick: () => value !== current && pick(value),
      ...(disabled(value) ? { disabled: "" } : {}) }, label)));
}

/** The rows holding these controls are dimmed and set aside unless `on`. */
function needs(ids, on) {
  for (const id of ids) {
    const row = $(id) && $(id).closest(".row");
    if (row) row.classList.toggle("needs-off", !on);
  }
}

function slider(id, value, toText, onDone) {
  const input = $(id);
  input.value = value;
  const show = () => { input.style.setProperty("--fill", `${((input.value - input.min) / (input.max - input.min)) * 100}%`); $(`${id}-n`).textContent = toText(input.value); };
  show();
  input.oninput = show;
  input.onchange = () => onDone(Number(input.value));
}

function draw() {
  if (!cfg) return;
  const t = cfg.theme;
  // Appearance.
  seg("mode", [["dark", "Dark"], ["light", "Light"]], t.mode, (mode) => { accentFor = mode; save({ theme: { mode } }); });
  // A text size for each area; one never set follows the single size there was before.
  const sizes = [["small", "Small"], ["medium", "Medium"], ["large", "Large"]];
  for (const area of ["interface", "bar", "launcher", "morgan", "writing", "canvas"]) {
    seg(`text-${area}`, sizes, (cfg.text || {})[area] || t.fontSize || "medium", (size) => save({ text: { ...(cfg.text || {}), [area]: size } }));
  }
  // Which mode's accent is being set: the one in use, unless the other is asked for.
  if (!accentFor) accentFor = t.mode === "light" ? "light" : "dark";
  // Switching which mode's accent: an open picker shows that mode's color.
  seg("accent-for", [["dark", "Dark"], ["light", "Light"]], accentFor, (m) => {
    accentFor = m;
    draw();
    if ($("picker").classList.contains("open")) picker.set(editedAccent());
  });
  const now = editedAccent();
  // The tuner's five, then the picker for any other — wearing the custom
  // accent once one is chosen.
  const custom = !ACCENTS.includes(now);
  const pick = el("button", { class: "cv-swatch any" + (custom ? " custom is-on" : ""), title: "Any color", style: custom ? `--custom:${now}` : "",
    onclick: () => { $("picker").classList.toggle("open"); if ($("picker").classList.contains("open")) picker.set(now); } });
  $("swatches").replaceChildren(...ACCENTS.map((c) => el("button", { class: "cv-swatch" + (c === now ? " is-on" : ""), style: `background:${c}`, title: c,
    onclick: () => { $("picker").classList.remove("open"); saveAccent(c); } })), pick);
  if (document.activeElement !== $("hex")) $("hex").value = now;
  seg("motion", [["slide", "Slide"], ["chaos", "Draw"], ["none", "None"]], t.motion === "draw" ? "chaos" : t.motion || "slide", (motion) => save({ theme: { motion } }));
  const SPEEDS = [["slow", "Slow"], ["normal", "Normal"], ["fast", "Fast"], ["fastest", "Very fast"]];
  seg("speed", SPEEDS, t.motionSpeed || "normal", (motionSpeed) => save({ theme: { motionSpeed } }));
  const ov = cfg.overlays || {};
  // What the bar's items open are drawn with them (drawBarShown); these open another way.
  for (const who of ["glance", "archive", "settings"]) {
    seg(`ov-${who}`, [["windows", "As windows"], ["drawers", "As panels"]], ov[who] || "windows", (v) => save({ overlays: { ...ov, [who]: v } }));
  }
  const p = cfg.panels;
  seg("outline", [["focus", "Accent in use"], ["line", "Line"], ["none", "None"]], p.outline, (outline) => save({ panels: { outline } }));
  $("shadow").classList.toggle("on", !!p.shadow);
  const pct = (v) => `${v}%`;
  slider("panels-op", p.opacity, pct, (v) => save({ panels: { opacity: v } }));
  const sh = cfg.shown || {};
  $("shown-done").classList.toggle("on", !!sh.done);
  $("shown-archived").classList.toggle("on", !!sh.archived);
  seg("shown-older", [[0, "Show all"], [30, "A month"], [90, "3 months"], [180, "6 months"], [365, "A year"], [730, "2 years"]], sh.olderThan || 0,
    (olderThan) => save({ shown: { olderThan } }));
  seg("bar-shape", [["strip", "Strip"], ["floating", "Floating"]], cfg.bar.shape, (shape) => save({ bar: { shape } }));
  const edgeMotion = [["slide", "Slide"], ["none", "None"]];
  const outlines = [["accent", "Accent"], ["line", "Line"], ["none", "None"]];
  for (const [part, c] of [["bar", cfg.bar], ["dock", cfg.dock]]) {
    seg(`${part}-motion`, edgeMotion, c.motion || "slide", (motion) => save({ [part]: { motion } }));
    seg(`${part}-speed`, SPEEDS, c.speed || "normal", (speed) => save({ [part]: { speed } }));
    seg(`${part}-outline`, outlines, c.outline || "line", (outline) => save({ [part]: { outline } }));
    $(`${part}-shadow`).classList.toggle("on", !!c.shadow);
  }
  slider("dock-icon", cfg.dock.iconSize ?? 24, (v) => `${v}px`, (v) => save({ dock: { iconSize: v } }));
  slider("dock-mag", cfg.dock.magnify ?? 100, (v) => (Number(v) <= 100 ? "Off" : `${v}%`), (v) => save({ dock: { magnify: v } }));
  seg("dock-scope", [["desktop", "This project"], ["all", "All"]], cfg.dock.scope || "desktop", (scope) => save({ dock: { scope } }));
  seg("dock-groups", [["one", "One dock"], ["pills", "Pills"]], cfg.dock.groups || "one", (groups) => save({ dock: { groups } }));
  // A click, Shift-click and Ctrl-click: each one of the three, a choice for one swapping with the press that had it.
  const rule = cfg.launcher.singleWindow === "go" ? "go" : "bring";
  const presses = cfg.dock.clicksDefault || { click: rule, shift: "new", ctrl: rule === "go" ? "bring" : "go" };
  for (const p of ["click", "shift", "ctrl"]) {
    seg(`press-${p}`, [["new", "New window here"], ["bring", "Bring it here"], ["go", "Go to it"]], presses[p], (a) => {
      const next = { ...presses };
      const had = ["click", "shift", "ctrl"].find((x) => next[x] === a);
      if (had) next[had] = next[p];
      next[p] = a;
      save({ dock: { clicksDefault: next } });
    });
  }
  $("press-note").textContent = cfg.dock.clicksDefault ? "" : "Not set yet: apps that open new windows, like a browser, open one on a click; the rest bring or go as Keys says.";
  // Four margins, each its own slider; saved as the whole set, as the bar reads them.
  const inset = cfg.bar.inset ?? 8;
  const m = { top: inset, right: inset, bottom: inset, left: inset, ...(cfg.bar.margins || {}) };
  for (const side of ["top", "right", "bottom", "left"]) {
    slider(`bar-m-${side}`, m[side], (v) => `${v}px`, (v) => save({ bar: { margins: { ...m, [side]: v } } }));
    $(`bar-m-${side}`).disabled = cfg.bar.shape !== "floating";
  }
  slider("bar-op", cfg.bar.opacity, pct, (v) => save({ bar: { opacity: v } }));
  slider("dock-op", cfg.dock.opacity, pct, (v) => save({ dock: { opacity: v } }));
  const k = cfg.clock;
  seg("hours", [["12", "12 hour"], ["24", "24 hour"]], k.hours, (hours) => save({ clock: { hours } }));
  $("seconds").classList.toggle("on", !!k.seconds);
  const day = new Date();
  const wd = day.toLocaleDateString("en-US", { weekday: "short" }), mo = day.toLocaleDateString("en-US", { month: "short" }), d = day.getDate();
  seg("datestyle", [["weekday-month-day", `${wd}, ${mo} ${d}`], ["weekday-day-month", `${wd} ${d} ${mo}`], ["month-day", `${mo} ${d}`],
    ["day-month", `${d} ${mo}`], ["iso", `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`], ["off", "None"]],
    k.date, (date) => save({ clock: { date } }));
  $("faces").replaceChildren(...fonts.map((f) => el("button", { class: "face" + (f === t.font ? " on" : ""), style: `font-family:'${f}'`,
    onclick: () => save({ theme: { font: f } }) }, el("b", {}, f), el("small", {}, "CANVAS · WRITING · 0123"))));

  // The bar along the top and the dock along the bottom: not a choice any more.
  $("tray-on").classList.toggle("on", cfg.bar.tray !== false);
  drawBarShown();
  slider("bar-spacing", cfg.bar.spacing ?? 4, (v) => `${v} px`, (spacing) => save({ bar: { spacing } }));
  seg("bar-project", [["name", "Name"], ["code", "Code"], ["both", "Both"]], cfg.bar.project || "both", (project) => save({ bar: { project } }));
  if (bridge && $("accounts").classList.contains("on")) drawCalendars();
  $("tray-fold").classList.toggle("on", !!cfg.bar.trayFold);
  needs(["tray-fold"], cfg.bar.tray !== false);
  if (bridge) trayRows();
  $("bar-hide").classList.toggle("on", !!cfg.bar.autohide);
  $("dock-hide").classList.toggle("on", !!cfg.dock.autohide);
  $("dock-on").classList.toggle("on", cfg.dock.enabled !== false);
  // Power: minutes on the page, seconds in the settings; 0 is never.
  const pw = cfg.power;
  const mins = (v) => (Number(v) === 0 ? "Never" : `${v} min`);
  $("power-on").classList.toggle("on", !!pw.managed);
  // One set of times on show at a time — plugged in or on battery — each saved whole.
  seg("power-profile", [["ac", "Plugged in"], ["battery", "On battery"]], powerProfile, (which) => { powerProfile = which; draw(); });
  const tm = pw[powerProfile] || {};
  const setTime = (key) => (v) => save({ power: { [powerProfile]: { ...tm, [key]: v * 60 } } });
  slider("power-dim", Math.round((tm.dim || 0) / 60), mins, setTime("dim"));
  slider("power-dimto", pw.dimTo, (v) => `${v}%`, (v) => save({ power: { dimTo: v } }));
  slider("power-lock", Math.round((tm.lock || 0) / 60), mins, setTime("lock"));
  slider("power-off", Math.round((tm.screenOff || 0) / 60), mins, setTime("screenOff"));
  slider("power-suspend", Math.round((tm.suspend || 0) / 60), mins, setTime("suspend"));
  const LID = [["suspend", "Suspend"], ["lock", "Lock"], ["screen-off", "Screen off"], ["nothing", "Nothing"]];
  const lid = pw.lid || {};
  for (const which of ["ac", "battery", "docked"]) {
    seg(`lid-${which}`, LID, lid[which] || (which === "docked" ? "nothing" : "suspend"), (v) => save({ power: { lid: { ...lid, [which]: v } } }));
  }
  for (const id of ["power-dim", "power-dimto", "power-lock", "power-off", "power-suspend"]) $(id).disabled = !pw.managed;
  if (bridge && $("power").classList.contains("on")) powerNote();
  drawNotifications();
  drawClipboard();

  // Settings that only matter when another is on, dimmed while it is off.
  needs(["bar-motion", "bar-speed"], !!cfg.bar.autohide);
  needs(["bar-m-top"], cfg.bar.shape === "floating");
  needs(["dock-hide", "dock-icon", "dock-mag", "dock-scope", "dock-groups", "dock-outline", "dock-shadow", "dock-op"], cfg.dock.enabled !== false);
  needs(["dock-motion", "dock-speed"], cfg.dock.enabled !== false && !!cfg.dock.autohide);
  needs(["power-profile", "power-dim", "power-lock", "power-off", "power-suspend", "lid-ac", "lid-battery", "lid-docked"], !!pw.managed);
  needs(["power-dimto"], !!pw.managed && (pw.ac?.dim > 0 || pw.battery?.dim > 0));
  slider("gap", cfg.windows.gap, (v) => `${v}px`, (v) => save({ windows: { gap: v } }));
  slider("between", cfg.windows.between ?? 10, (v) => `${v}px`, (v) => save({ windows: { between: v } }));
  seg("win-outline", [["focus", "Accent in use"], ["accent", "Accent"], ["line", "Line"], ["none", "None"]], cfg.windows.outline || "focus",
    (outline) => save({ windows: { outline } }));
  slider("win-border", cfg.windows.border ?? 2, (v) => `${v}px`, (v) => save({ windows: { border: v } }));
  needs(["win-border"], (cfg.windows.outline || "focus") !== "none");
  seg("win-motion", [["slide", "Slide"], ["pop", "Pop"], ["fade", "Fade"], ["draw", "Draw"], ["none", "None"]], cfg.windows.motion || "pop",
    (motion) => save({ windows: { motion } }));
  seg("win-speed", SPEEDS, cfg.windows.speed || "normal", (speed) => save({ windows: { speed } }));
  needs(["win-speed"], (cfg.windows.motion || "pop") !== "none");
  slider("idle", cfg.idleSeconds, (v) => (v >= 60 ? `${Math.floor(v / 60)}m${v % 60 ? ` ${v % 60}s` : ""}` : `${v}s`), (v) => save({ idleSeconds: v }));

  // Keys.
  seg("single-window", [["bring", "Send it to you"], ["go", "Go to it"]], cfg.launcher.singleWindow || "bring", (singleWindow) => save({ launcher: { singleWindow } }));
  drawStays();
  drawSolid();
}

$("shadow").addEventListener("click", () => save({ panels: { shadow: !cfg.panels.shadow } }));
$("shown-done").addEventListener("click", () => save({ shown: { done: !(cfg.shown || {}).done } }));
$("shown-archived").addEventListener("click", () => save({ shown: { archived: !(cfg.shown || {}).archived } }));
for (const part of ["bar", "dock"]) $(`${part}-shadow`).addEventListener("click", () => save({ [part]: { shadow: !cfg[part].shadow } }));
$("seconds").addEventListener("click", () => save({ clock: { seconds: !cfg.clock.seconds } }));
$("bar-hide").addEventListener("click", () => save({ bar: { autohide: !cfg.bar.autohide } }));
$("dock-on").addEventListener("click", () => save({ dock: { enabled: cfg.dock.enabled === false } }));
$("dock-hide").addEventListener("click", () => save({ dock: { autohide: !cfg.dock.autohide } }));
// The tray: on or off, and each icon there is now shown or put away (kept by
// the application's id, so it stays put away when the application comes back).
$("tray-on").addEventListener("click", () => save({ bar: { tray: cfg.bar.tray === false } }));
$("tray-fold").addEventListener("click", () => save({ bar: { trayFold: !cfg.bar.trayFold } }));
function trayRows() {
  bridge.trayItems((text) => {
    const hidden = new Set(cfg.bar.trayHidden || []);
    const rows = JSON.parse(text).filter((i) => i.appId).map((i) => {
      const sw = el("button", { class: "switch" + (hidden.has(i.appId) ? "" : " on") });
      sw.addEventListener("click", () => {
        const now = new Set(cfg.bar.trayHidden || []);
        if (now.has(i.appId)) now.delete(i.appId); else now.add(i.appId);
        save({ bar: { trayHidden: [...now] } });
      });
      const name = el("span", { class: "name" }, i.title || i.appId);
      return el("div", { class: "row" }, name, el("span", { class: "what" }, sw));
    });
    $("tray-items").replaceChildren(...(rows.length ? rows : [Kit.empty("No tray icons right now")]));
    needs(["tray-items"], cfg.bar.tray !== false);
    $("tray-items").classList.toggle("needs-off", cfg.bar.tray === false);
  });
}

$("power-on").addEventListener("click", () => save({ power: { managed: !cfg.power.managed } }));

// ---------------------------------------------------------------- notifications
//
// How they pop up, and from whom. Every application that has sent one is in
// `seen`; those in `muted` are kept and listed under the bell, not popped up.
const nt = () => cfg.notifications || {};
// A desktop id (org.gnome.Calendar) by its last part, the whole id under it.
const appName = (key) => (key.includes(".") ? key.split(".").pop() : key);
function drawNotifications() {
  const n = nt();
  const on = n.enabled !== false;
  $("nt-on").classList.toggle("on", on);
  $("nt-off-note").hidden = on;
  seg("nt-motion", [["slide", "Slide"], ["pop", "Pop"], ["fade", "Fade"], ["draw", "Draw"]], n.animation || "slide", (animation) => save({ notifications: { animation } }));
  $("nt-shadow").classList.toggle("on", n.shadow !== false);
  slider("nt-op", n.opacity ?? 100, (v) => `${v}%`, (opacity) => save({ notifications: { opacity } }));
  seg("nt-outline", [["line", "Line"], ["accent", "Accent"], ["none", "None"]], n.outline || "line", (outline) => save({ notifications: { outline } }));
  slider("nt-secs", n.seconds ?? 6, (v) => `${v} s`, (seconds) => save({ notifications: { seconds } }));
  needs(["nt-motion", "nt-shadow", "nt-op", "nt-outline", "nt-secs"], on);
  const muted = new Set(n.muted || []);
  const apps = [...new Set(n.seen || [])].sort((a, b) => appName(a).localeCompare(appName(b), undefined, { sensitivity: "base" }) || a.localeCompare(b));
  $("nt-apps").replaceChildren(...(apps.length ? apps.map((key) => {
    const sw = el("button", { class: "switch" + (muted.has(key) ? "" : " on"), title: "Shown" });
    sw.addEventListener("click", () => {
      const now = new Set(nt().muted || []);
      if (now.has(key)) now.delete(key); else now.add(key);
      save({ notifications: { muted: [...now] } });
    });
    const name = el("span", { class: "name" }, appName(key), ...(appName(key) !== key ? [el("small", {}, key)] : []));
    return el("div", { class: "row" }, name, el("span", { class: "what" }, el("small", { class: "note", style: "margin:0" }, "Shown"), sw));
  }) : [Kit.empty("None yet: an application appears here once it sends one")]));
}
$("nt-on").addEventListener("click", () => save({ notifications: { enabled: nt().enabled === false } }));
$("nt-shadow").addEventListener("click", () => save({ notifications: { shadow: nt().shadow === false } }));
// The process sends it (notify-send), once the bridge has the slot for it.
$("nt-test").addEventListener("click", () => bridge && bridge.testNotification && bridge.testNotification());
// ---------------------------------------------------------------- clipboard
const cb = () => cfg.clipboard || {};
function drawClipboard() {
  const on = cb().enabled !== false;
  $("cb-on").classList.toggle("on", on);
  $("cb-off-note").hidden = on;
  slider("cb-keep", cb().keep ?? 50, (v) => `${v}`, (keep) => save({ clipboard: { keep } }));
}
$("cb-on").addEventListener("click", () => save({ clipboard: { enabled: cb().enabled === false } }));
// ---------------------------------------------------------------- the picker
//
// The accent of the mode being set (Look, Accent): the one in use is `accent`,
// which the process keeps in step; the other mode's is its own key.
let accentFor = "";
const inUse = () => accentFor === ((cfg && cfg.theme.mode === "light") ? "light" : "dark");
function editedAccent() {
  const t = cfg.theme;
  return (accentFor === "light" ? t.accentLight : t.accentDark) || t.accent;
}
function saveAccent(c) {
  save({ theme: inUse() ? { accent: c } : { [accentFor === "light" ? "accentLight" : "accentDark"]: c } });
}

// Hue, saturation and value; the page's accent follows as you drag (when it is
// the mode in use's), and the accent is saved when you let go.
const picker = (() => {
  let h = 0, s = 1, v = 1;
  const hex = () => {
    const f = (n) => { const k = (n + h / 60) % 6; return v - v * s * Math.max(0, Math.min(k, 4 - k, 1)); };
    return "#" + [f(5), f(3), f(1)].map((x) => Math.round(x * 255).toString(16).padStart(2, "0")).join("");
  };
  const show = () => {
    $("sv").style.setProperty("--hue", h);
    $("sv-knob").style.left = `${s * 100}%`;
    $("sv-knob").style.top = `${(1 - v) * 100}%`;
    $("hue-knob").style.top = `${(h / 360) * 100}%`;
    const c = hex();
    $("picked").style.background = c;
    $("hex").value = c;
    if (inUse()) Surface.applyTheme({ ...(cfg ? cfg.theme : {}), accent: c });
  };
  const set = (color) => {
    const n = parseInt(color.slice(1), 16), r = (n >> 16) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
    const max = Math.max(r, g, b), d = max - Math.min(r, g, b);
    v = max; s = max ? d / max : 0;
    h = !d ? h : max === r ? 60 * (((g - b) / d) % 6) : max === g ? 60 * ((b - r) / d + 2) : 60 * ((r - g) / d + 4);
    if (h < 0) h += 360;
    show();
  };
  const drag = (box, move) => box.addEventListener("pointerdown", (e) => {
    box.setPointerCapture(e.pointerId);
    const at = (ev) => { const r = box.getBoundingClientRect(); move(Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width)), Math.max(0, Math.min(1, (ev.clientY - r.top) / r.height))); show(); };
    at(e);
    box.onpointermove = at;
    box.onpointerup = () => { box.onpointermove = box.onpointerup = null; saveAccent(hex()); };
  });
  drag($("sv"), (x, y) => { s = x; v = 1 - y; });
  drag($("hue"), (_x, y) => { h = Math.min(359, y * 360); });
  return { set };
})();

$("hex").addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  const v = $("hex").value.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(v)) saveAccent(v.toLowerCase());
  else say("An accent is a color like #c98a5b", true); // look: an example, in words
});

// ---------------------------------------------------------------- Morgan
//
// Morgan's own settings, read from Morgan and changed there (heymorgan's admin
// ops). Every question is answered later (morganReply): tidying memory or a
// restart can take minutes, and the page must not wait on them. Nothing here
// opens a popup of the engine's own — no select, date or file inputs — since a
// layer surface cannot hold those windows; choices are chips, segs and menus
// built in the page.

const morganWaiting = new Map();
let morganNext = 0;
/** One admin op; resolves with its reply, ok or not. */
function morgan(op, args = {}) {
  return new Promise((done) => {
    const id = `m${++morganNext}`;
    morganWaiting.set(id, done);
    bridge.morganAsk(id, JSON.stringify({ op, args }));
  });
}
function onMorganReply(text) {
  let r;
  try { r = JSON.parse(text); } catch { return; }
  const done = morganWaiting.get(r.id);
  morganWaiting.delete(r.id);
  if (done) done(r.reply || { ok: false, error: "No answer" });
}

const MG_TABS = [["where", "Where"], ["assistant", "Assistant"], ["models", "Models"], ["voice", "Voice"], ["memory", "Memory"],
  ["reminders", "Reminders"], ["connections", "Connections"], ["log", "Log"]];
let mgTab = "where";
// Which drawing is current: an answer to an older one (another sub-page since) is dropped.
let mgTurn = 0;
let mgLive = () => false;

// Not running is said once, at the top, with a way to ask again — not on every row.
const isDown = (r) => !r.ok && /^Morgan is not running/.test(r.error || "");
function mgDown(why) {
  $("mg-down").hidden = !why;
  $("mg-down-why").textContent = why || "";
  if (why) $("morgan-body").replaceChildren();
}
$("mg-again").addEventListener("click", () => loadMorgan());

async function ask(op, args) {
  const r = await morgan(op, args);
  if (isDown(r)) mgDown(r.error);
  return r;
}

/** A first read that failed: said in the page (or in the banner, when Morgan is down). */
function failed(r) {
  if (r.ok) return false;
  if (!isDown(r)) mgBody(el("p", { class: "note err" }, r.error || "Morgan did not answer"));
  return true;
}
const mgBody = (...kids) => $("morgan-body").replaceChildren(...kids);

/** A change: said when it fails, its reply handed on when not. */
async function change(op, args, said) {
  const r = await ask(op, args);
  if (!r.ok) { if (!isDown(r)) say(r.error || "Morgan did not take it", true); return null; }
  if (said) say(said);
  return r;
}

/** A config.set; a restart is Morgan's to say, and the page is read again after it. */
async function setConfig(values) {
  const r = await change("config.set", { values });
  if (!r) return;
  say(r.restart ? "Saved — Morgan is restarting" : "Saved");
  setTimeout(() => loadMorgan(true), r.restart ? 3000 : 0);
}

function loadMorgan(keep = false) {
  mgDown("");
  seg("mg-tabs", MG_TABS, mgTab, (t) => { mgTab = t; loadMorgan(); });
  const turn = ++mgTurn;
  mgLive = () => turn === mgTurn && $("morgan").classList.contains("on");
  if (!keep) mgBody(el("p", { class: "note" }, "Reading…"));
  MG_PAGES[mgTab]();
}

// The file's seg() fills a host already in the page; these are built before they are.
function segOf(choices, current, pick) {
  return el("span", { class: "seg" }, ...choices.map(([value, label]) =>
    el("button", { class: value === current ? "on" : "", onclick: () => value !== current && pick(value) }, label)));
}
function mgRow(name, hint, ...controls) {
  return el("div", { class: "row" }, el("span", { class: "name" }, name, ...(hint ? [el("small", {}, hint)] : [])), el("span", { class: "what" }, ...controls));
}
function mgInput(value, attrs = {}) {
  const input = el("input", { type: "text", spellcheck: "false", autocomplete: "off", ...attrs });
  input.value = value ?? "";
  return input;
}
/**
 * A number, in the theme: − and + either side of the figure, never the
 * engine's own spinner (which wears the system's look, not Talaris's). Wraps
 * an input so a form reads `.value` from it as from any other.
 */
function stepper(input, { min = -Infinity, max = Infinity, step = 1 } = {}) {
  input.type = "text";
  input.inputMode = "numeric";
  input.classList.add("step-n");
  const nudge = (by) => {
    const n = Number(input.value === "" ? (Number.isFinite(min) ? min : 0) : input.value) + by;
    if (Number.isNaN(n)) return;
    input.value = String(Math.min(max, Math.max(min, n)));
    input.dispatchEvent(new Event("input", { bubbles: true }));
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowUp") { e.preventDefault(); nudge(step); }
    if (e.key === "ArrowDown") { e.preventDefault(); nudge(-step); }
  });
  const b = (label, by, title) => { const x = el("button", { class: "step-b", type: "button", title }, label); x.addEventListener("click", () => nudge(by)); return x; };
  return el("span", { class: "stepper" }, b("−", -step, "Less"), input, b("+", step, "More"));
}

/**
 * One of several, in the theme: a button showing the choice, opening a menu
 * of the rest — never the engine's own dropdown. `pick(value)` on choosing.
 */
function dropdown(choices, current, pick) {
  let now = current;
  const btn = el("button", { class: "t-btn drop-b", type: "button" });
  const label = () => { btn.textContent = `${(choices.find(([v]) => v === now) || [now, now ?? "—"])[1]} ▾`; };
  label();
  // The kit's menu (kit.js): placed, kept on screen, put away by a press elsewhere or Escape; a press on the button again closes it.
  btn.addEventListener("click", () => {
    if (Kit.openedBy() === btn) { Kit.popAway(); return; }
    Kit.menu(btn, choices.map(([v, l]) => ({ label: l, on: v === now, act: () => { now = v; label(); pick(v); } })));
  });
  return btn;
}

/** A choice among a few, as the rest of Settings has them: in a row; many, as a menu. */
function choiceOf(choices, current, pick) {
  const short = choices.length <= 4 && choices.reduce((n, [, l]) => n + String(l).length, 0) <= 60;
  if (!short) return dropdown(choices, current, pick);
  const host = el("span", {});
  let now = current;
  const draw = () => host.replaceChildren(segOf(choices, now, (v) => { now = v; draw(); pick(v); }));
  draw();
  return host;
}

function mgSwitch(on, flip, title = "") {
  const sw = el("button", { class: "switch" + (on ? " on" : ""), title });
  sw.addEventListener("click", () => flip(!sw.classList.contains("on"), sw));
  return sw;
}
const mgWhen = (t) => (t ? when(typeof t === "number" ? t : String(t)) : "");

// ---------------------------------------------------------------- Morgan: where it lives

let mgPlace = null; // client.get, for the Models page's word on whose models they are

async function mgWhere() {
  const c = await ask("client.get");
  if (!mgLive() || failed(c)) return;
  mgPlace = c;
  if (c.role === "server") {
    mgBody(el("p", { class: "note" }, "This computer is the server: other computers reach Morgan through it, and its memories and models are the ones they use."));
    return;
  }
  let pick = c.role === "client" ? "client" : "local";
  const server = mgInput(c.server, { placeholder: "home-server:8790" });
  const key = mgInput("", { type: "password", placeholder: c.hasKey ? "keep the current one" : "hc_… from heymorgan access add" });
  const device = mgInput(c.device, { placeholder: "laptop" });
  const card = (value, title, what) => el("button", { class: "mg-card" + (value === pick ? " on" : "") + (value === (c.role === "client" ? "client" : "local") ? " now" : ""),
    onclick: () => { pick = value; draw(); } }, el("b", {}, title), el("small", {}, what));
  const confirmBox = el("div", { class: "kit-ask-box", hidden: "" });

  const draw = () => {
    const same = pick === (c.role === "client" ? "client" : "local");
    const status = c.role === "client"
      ? el("p", { class: "note" + (c.connected ? "" : " err") }, `Through ${c.server}, as ${c.device}: ${c.connected ? "connected" : "can't reach it"}`)
      : el("p", { class: "note" }, "Wholly on this computer.");
    const go = el("button", { class: "t-btn", onclick: () => ready() }, same ? "Save" : "Switch");
    const parts = [
      el("div", { class: "mg-cards" },
        card("local", "Only this computer", "Morgan's voice, memories, models and Claude sign-in all here"),
        card("client", "One of several, through a server", "This computer is its ears and voice; memories and models live on the server")),
      status,
    ];
    if (pick === "client") {
      parts.push(mgRow("Server", "Its address, host:port", server), mgRow("Access key", c.hasKey ? "One is kept; paste a new one to replace it" : "From heymorgan access add on the server", key),
        mgRow("This device", "Its name to the server", device));
    }
    // Switching to where it is already is nothing to do; changing a client's server is.
    if (!same || pick === "client") parts.push(el("div", { class: "row" }, el("span", { class: "name" }), el("span", { class: "what" }, go)));
    parts.push(confirmBox,
      el("p", { class: "note" }, "On only this computer, the Models and Claude settings are this computer's; through a server, they are the server's, changed there from here."));
    mgBody(...parts);
  };

  const ready = () => {
    const args = pick === "local" ? { server: "" } : { server: server.value.trim(), device: device.value.trim() };
    if (pick === "client") {
      if (!args.server) { say("A server needs its address", true); return; }
      const k = key.value.trim();
      if (k && !k.startsWith("hc_")) { say("That is not a key the server issued (they start hc_)", true); return; }
      if (!k && !c.hasKey) { say("A server needs a key: run heymorgan access add <device> on the server", true); return; }
      if (k) args.key = k;
    }
    // A restart, and for "only this computer" a different set of memories: said first, done on a second press.
    const what = pick === "local"
      ? "Morgan will use the memories this computer had before it used a server; what it has learned on the server since stays there."
      : c.role === "client" ? "Morgan will restart and reach the server with these." : "Morgan will restart as one of the server's computers; it will use the server's memories and models.";
    confirmBox.hidden = false;
    confirmBox.replaceChildren(el("p", { class: "note", style: "margin:0" }, what),
      el("div", { class: "data-buttons" },
        el("button", { class: "t-btn", onclick: () => { confirmBox.hidden = true; } }, "Cancel"),
        el("button", { class: "t-btn", onclick: () => doSwitch(args) }, pick === "local" ? "Use only this computer" : "Use the server")));
  };

  const doSwitch = async (args) => {
    const r = await change("client.set", args);
    if (!r) return;
    say("Morgan is restarting…");
    mgBody(el("p", { class: "note" }, "Morgan is restarting…"));
    setTimeout(() => loadMorgan(), 4000);
  };
  draw();
}

// ---------------------------------------------------------------- Morgan: the assistant

async function mgAssistant() {
  const m = await ask("config.get");
  if (!mgLive() || failed(m)) return;
  const here = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const inputs = {
    name: mgInput(m.name), userName: mgInput(m.userName), wakeWord: mgInput(m.wakeWord), interruptWord: mgInput(m.interruptWord),
    followUpSeconds: el("input", {}), timeZone: mgInput(m.timeZone, { placeholder: here }),
  };
  inputs.followUpSeconds.value = m.followUpSeconds ?? "";
  const known = mgSwitch(!!m.knownVoicesOnly, (on, sw) => sw.classList.toggle("on", on));
  const save = async () => {
    const values = {};
    for (const [k, input] of Object.entries(inputs)) {
      let v = input.value.trim();
      if (String(m[k] ?? "") === v) continue;
      // For these an empty box turns it off (Morgan reads "" so); for the rest, empty is the default.
      if (v === "" && !["wakeWord", "interruptWord", "userName"].includes(k)) v = null;
      else if (k === "followUpSeconds") v = Number(v);
      values[k] = v;
    }
    const kv = known.classList.contains("on");
    if (kv !== !!m.knownVoicesOnly) values.knownVoicesOnly = kv;
    if (!Object.keys(values).length) { say("Nothing changed"); return; }
    setConfig(values);
  };
  mgBody(
    mgRow("Name", "What it answers to", inputs.name),
    mgRow("Your name", "What it calls you; empty, nothing", inputs.userName),
    mgRow("Wake word", "Empty turns it off", inputs.wakeWord),
    mgRow("Interrupt word", "Said while it speaks, stops it; empty turns it off", inputs.interruptWord),
    mgRow("Follow-up", "Seconds it listens after answering", stepper(inputs.followUpSeconds, { min: 0, max: 30 })),
    mgRow("Time zone", `Where you are; empty is this computer's, ${here}`, inputs.timeZone,
      el("button", { class: "t-btn", onclick: () => { inputs.timeZone.value = here; } }, "This computer's")),
    mgRow("Known voices only", "Answer only voices it has been taught", known),
    el("div", { class: "row" }, el("span", { class: "name" }), el("span", { class: "what" },
      el("button", { class: "t-btn", onclick: save }, "Save to Morgan"), el("span", { class: "note", style: "margin:0" }, "Some changes restart Morgan for a moment"))));
}

// ---------------------------------------------------------------- Morgan: models

async function mgModels() {
  const [m, account, place] = await Promise.all([ask("config.get"), ask("oracle.account"), mgPlace ? Promise.resolve(mgPlace) : ask("client.get")]);
  if (!mgLive() || failed(m)) return;
  if (place.ok) mgPlace = place;
  const savedUrl = (m.ollama || {}).url || "";
  const url = mgInput(savedUrl, { placeholder: "http://host:11434" });
  const models = el("div", {});
  let listedFrom = savedUrl;

  // The chat and embedding models the server has, as chips; picking one saves it
  // (with the address it came from, when that is not the one saved).
  const chips = (list, current, key, strip) => el("div", { class: "mg-chips" }, ...list.map((x) => {
    const name = strip ? x.name.replace(/:latest$/, "") : x.name;
    return el("button", { class: "chip" + (name === current ? " on" : ""), onclick: () => name !== current || listedFrom !== savedUrl
      ? setConfig({ [key]: name, ...(listedFrom !== savedUrl ? { "ollama.url": listedFrom } : {}) }) : null },
    name, el("small", {}, `${x.gb} GB`));
  }));
  const look = async () => {
    listedFrom = url.value.trim() || savedUrl;
    models.replaceChildren(el("p", { class: "note" }, "Looking…"));
    const r = await ask("ollama.models", { url: listedFrom });
    if (!mgLive()) return;
    if (!r.ok) { models.replaceChildren(el("p", { class: "note err" }, `Could not reach it: ${r.error}`)); return; }
    const chat = (m.ollama || {}).model, embed = m.embedModel;
    const missing = (list, name, strip) => name && !list.some((x) => (strip ? x.name.replace(/:latest$/, "") : x.name) === name)
      ? [el("p", { class: "note" }, `Set: ${name}, which this server does not have`)] : [];
    // The model that looks (Morgan's visionModel): the chat model unless one of its own is chosen — and a warning when what looks cannot see.
    const vision = m.visionModel || "";
    const chatSees = (r.chat || []).find((x) => x.name === chat);
    const blind = !vision && chatSees && chatSees.sees === false;
    const visionChips = el("div", { class: "mg-chips" },
      el("button", { class: "chip" + (!vision ? " on" : ""), onclick: () => vision ? setConfig({ visionModel: "" }) : null }, "Same as the chat model"),
      ...(r.vision || []).map((x) => el("button", { class: "chip" + (x.name === vision ? " on" : ""), onclick: () => x.name !== vision ? setConfig({ visionModel: x.name }) : null },
        x.name, el("small", {}, `${x.gb} GB`))));
    models.replaceChildren(
      el("h3", {}, "Chat model"), chips(r.chat || [], chat, "ollama.model", false), ...missing(r.chat || [], chat, false),
      el("h3", {}, "Vision model"), el("p", { class: blind ? "note err" : "note", style: "margin:0 0 6px" },
        blind ? `${chat} cannot see: Morgan cannot look at the screen, the camera or pictures, nor describe them for Talaris, until a vision model is chosen.`
          : "What Morgan looks with — the screen, the camera, the clipboard, pictures it reads, and pictures Talaris asks it to describe. Only models that can see are listed."),
      visionChips,
      el("h3", {}, "Embedding model"), el("p", { class: "note", style: "margin:0 0 6px" }, "For finding earlier conversations. Changing it re-reads the whole transcript."),
      chips(r.embedding || [], embed, "embedModel", true), ...missing(r.embedding || [], embed, true));
  };
  url.addEventListener("keydown", (e) => { if (e.key === "Enter") look(); });

  const oracle = m.oracleModel || "";
  const plans = [["haiku", "Haiku"], ["sonnet", "Sonnet"], ["opus", "Opus"]];
  if (oracle && !plans.some(([v]) => v === oracle)) plans.push([oracle, oracle]);

  const accountRow = el("div", {});
  const drawAccount = (a) => {
    const said = !a.ok ? (a.error || "Morgan did not say") : a.loggedIn ? `${a.email || "Signed in"}${a.plan ? ` · ${a.plan}` : ""}` : a.error || "Not signed in";
    const sign = a.ok && a.loggedIn
      ? el("button", { class: "t-btn", onclick: () => { bridge.morganAccount("logout"); say("Sign out in the terminal, then Check again"); } }, "Sign out")
      : el("button", { class: "t-btn", onclick: () => { bridge.morganAccount("login"); say("Sign in in the terminal and your browser, then Check again"); } }, "Sign in");
    accountRow.replaceChildren(mgRow("Claude account", said, sign,
      el("button", { class: "t-btn", onclick: async () => { say("Checking…"); const r = await ask("oracle.account"); if (mgLive()) { drawAccount(r); say(""); } } }, "Check again")));
  };
  drawAccount(account);

  const whose = mgPlace && mgPlace.role === "client"
    ? `These are the server's (${mgPlace.server}), changed there from here.` : "These are this computer's.";
  mgBody(
    el("p", { class: "note", style: "margin:0 0 6px" }, whose),
    el("h3", {}, "Ollama"),
    mgRow("Address", "The Ollama server that does the talking", url,
      el("button", { class: "t-btn", onclick: look }, "Look"),
      el("button", { class: "t-btn", onclick: () => { const u = url.value.trim(); if (u && u !== savedUrl) setConfig({ "ollama.url": u }); else say("Nothing changed"); } }, "Use it")),
    models,
    el("h3", {}, "The Oracle"),
    el("p", { class: "note", style: "margin:0 0 6px" }, "Claude, for what the local model cannot do. Its sign-in is its own, apart from any other Claude login here."),
    mgRow("Model", "", segOf(plans, oracle, (v) => setConfig({ "oracle.model": v }))),
    accountRow);
  look();
}

// ---------------------------------------------------------------- Morgan: voice

async function mgVoice() {
  const [v, heard] = await Promise.all([ask("voice.list"), ask("voices.status")]);
  if (!mgLive() || failed(v)) return;
  let chosen = v.kokoroVoice;
  const grid = el("div", { class: "mg-chips mg-scroll" });
  const drawGrid = () => grid.replaceChildren(...(v.kokoro || []).map((name) =>
    el("button", { class: "chip" + (name === v.kokoroVoice && v.engine === "kokoro" ? " on" : "") + (name === chosen ? " picked" : ""),
      onclick: () => { chosen = name; drawGrid(); chosenName.textContent = name; } }, name)));
  const chosenName = el("span", { class: "n", style: "width:auto" }, chosen || "");
  drawGrid();
  const parts = [el("h3", {}, "Morgan's voice")];
  if (!v.kokoroInstalled) parts.push(el("p", { class: "note err" }, "Kokoro is not installed here."));
  if (v.engine !== "kokoro") parts.push(el("p", { class: "note" }, `Morgan speaks with Piper now (${v.piperVoice || "its voice"}); using a voice here moves it to Kokoro.`));
  parts.push(grid, mgRow("Chosen", "Hear it before using it", chosenName,
    el("button", { class: "t-btn", onclick: async () => { if (chosen) await change("voice.preview", { engine: "kokoro", voice: chosen }, "Playing…"); } }, "Hear it"),
    el("button", { class: "t-btn", onclick: () => {
      if (!chosen) return;
      const values = {};
      if (chosen !== v.kokoroVoice) values.kokoroVoice = chosen;
      if (v.engine !== "kokoro") values.engine = "kokoro";
      if (Object.keys(values).length) setConfig(values); else say("Already its voice");
    } }, "Use it")));

  // Voices it knows, by whom; teaching one is done by speaking, when Morgan asks.
  parts.push(el("h3", {}, "Voices it knows"));
  const known = el("div", {});
  const drawKnown = (s) => {
    if (!s.ok) { known.replaceChildren(el("p", { class: "note err" }, s.error || "Morgan did not say")); return; }
    if (!s.installed) { known.replaceChildren(el("p", { class: "note" }, "Telling voices apart is not installed here.")); return; }
    const who = el("input", { type: "text", spellcheck: "false", placeholder: "Whose voice?" });
    const teach = async () => {
      const name = who.value.trim();
      if (!name) { say("Whose voice is it? Type a name first", true); return; }
      if (await change("voices.enroll", { name })) {
        say("Speak when Morgan asks");
        known.append(el("p", { class: "note" }, `Speak when Morgan asks: ${name}, six short lines, about a minute.`),
          el("div", { class: "data-buttons" }, el("button", { class: "t-btn", onclick: async () => drawKnown(await ask("voices.status")) }, "Look again")));
      }
    };
    who.addEventListener("keydown", (e) => { if (e.key === "Enter") teach(); });
    known.replaceChildren(
      ...(s.enrolled || []).map((name) => mgRow(name, "", twiceBtn("Forget", "Forget it?", async () => {
        const r = await change("voices.forget", { name }, `${name} forgotten`);
        if (r) drawKnown(r);
      }))),
      ...((s.enrolled || []).length ? [] : [Kit.empty("None taught yet")]),
      mgRow("Teach a voice", "Its person speaks six short lines", who, el("button", { class: "t-btn", onclick: teach }, "Enroll")));
  };
  drawKnown(heard);
  parts.push(known);
  mgBody(...parts);
}

// ---------------------------------------------------------------- Morgan: memory

const mgOpen = new Set(); // topics shown open, kept across readings
let mgFilter = "";

async function mgMemory() {
  const [mem, garden] = await Promise.all([ask("memory.list"), ask("memory.garden.report")]);
  if (!mgLive() || failed(mem)) return;
  const topics = mem.topics || [];
  // Notes are addressed by their place in the topic: one changed, the topic is
  // read again before another of its notes may be.
  const busy = new Set();
  const again = () => loadMorgan(true);
  const noteChange = async (topic, op, args, said) => {
    busy.add(topic);
    drawTopics();
    await change(op, { topic, ...args }, said);
    again();
  };

  const filter = Kit.searchBox(el("input", { type: "text", spellcheck: "false", placeholder: "Find topics and notes" }));
  filter.value = mgFilter;
  filter.addEventListener("input", () => { mgFilter = filter.value; drawTopics(); });
  const list = el("div", { class: "mg-scroll mg-topics" });

  const topicBlock = (t, notesShown, open) => {
    const head = el("button", { class: "mg-topic-head" + (open ? " open" : ""), onclick: () => { if (mgOpen.has(t.name)) mgOpen.delete(t.name); else mgOpen.add(t.name); drawTopics(); } },
      Kit.caret(open), el("b", {}, t.name), el("small", {}, `${t.notes.length} · ${t.description || "no description"}`));
    const block = el("div", { class: "mg-topic" }, head);
    if (!open) return block;
    const locked = busy.has(t.name);
    const others = topics.filter((o) => o.name !== t.name);
    const notes = notesShown.map(({ text, index }) => {
      const body = el("div", { class: "mg-note-text", ...(locked ? {} : { contenteditable: "plaintext-only" }), spellcheck: "false" }, text);
      const done = () => {
        const now = body.textContent.replace(/\s+/g, " ").trim();
        if (busy.has(t.name) || now === text) return;
        if (!now) { body.textContent = text; say("An empty note is deleted with ×", true); return; }
        noteChange(t.name, "memory.note.set", { index, text: now }, "Note changed");
      };
      body.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); body.blur(); }
        if (e.key === "Escape") { e.stopImmediatePropagation(); body.textContent = text; body.blur(); }
      });
      body.addEventListener("blur", done);
      // Where it may go, in the kit's menu (kit.js): put away by a press elsewhere or Escape, as every menu is.
      const moveBtn = el("button", { class: "t-btn small", onclick: (e) => {
        if (Kit.openedBy() === e.currentTarget) { Kit.popAway(); return; }
        Kit.menu(e.currentTarget, others.map((o) => ({ label: o.name, act: () => noteChange(t.name, "memory.note.move", { index, to: o.name }, `Moved to ${o.name}`) })));
      } }, "Move to…");
      return el("div", { class: "mg-note" + (locked ? " locked" : "") },
        el("div", { class: "mg-note-row" }, body, ...(others.length && !locked ? [moveBtn] : []),
          ...(locked ? [] : [Kit.twice(xBtn("Delete it"), { ask: "Delete it?", act: () => noteChange(t.name, "memory.note.delete", { index }, "Note deleted") })])));
    });
    if (!t.notes.length) notes.push(Kit.empty("Nothing here yet"));
    else if (!notesShown.length) notes.push(Kit.empty("Nothing matches"));

    const add = el("input", { type: "text", spellcheck: "false", placeholder: "+ Note: type it and press Enter" });
    add.addEventListener("keydown", (e) => { if (e.key === "Enter" && add.value.trim() && !busy.has(t.name)) noteChange(t.name, "memory.note.add", { text: add.value.trim() }, "Note added"); });

    // Its name and description, changed together.
    const tools = el("div", { class: "data-buttons" });
    const drawTools = () => tools.replaceChildren(
      el("button", { class: "t-btn", onclick: renaming }, "Rename"),
      twiceBtn("Delete topic", "Delete it and its notes?", async () => { mgOpen.delete(t.name); await change("memory.topic.delete", { topic: t.name }, "Topic deleted"); again(); }));
    const renaming = () => {
      const name = mgInput(t.name, { placeholder: "Its name" });
      const description = mgInput(t.description, { placeholder: "What belongs here" });
      tools.replaceChildren(name, description,
        el("button", { class: "t-btn", onclick: drawTools }, "Cancel"),
        el("button", { class: "t-btn", onclick: async () => {
          const n = name.value.trim() || t.name;
          if (await change("memory.topic.rename", { topic: t.name, name: n, description: description.value.trim() }, "Topic changed")) {
            if (mgOpen.delete(t.name)) mgOpen.add(n);
            again();
          }
        } }, "Save"));
      name.focus();
    };
    drawTools();
    block.append(el("div", { class: "mg-topic-body" }, ...notes, ...(locked ? [] : [add]), tools));
    return block;
  };

  function drawTopics() {
    const q = mgFilter.trim().toLowerCase();
    const has = (s) => Kit.matches(q, s);
    const blocks = [];
    for (const t of topics) {
      const all = t.notes.map((text, index) => ({ text, index }));
      if (!q) { blocks.push(topicBlock(t, all, mgOpen.has(t.name))); continue; }
      const byName = has(t.name) || has(t.description);
      const matching = all.filter((n) => has(n.text));
      if (!byName && !matching.length) continue;
      // A topic found by its notes opens on them; found by its name, on all of them.
      blocks.push(topicBlock(t, byName ? all : matching, mgOpen.has(t.name) || (!byName && matching.length > 0)));
    }
    list.replaceChildren(...(blocks.length ? blocks : [Kit.empty(q ? "Nothing matches" : "No topics yet")]));
  }
  drawTopics();

  const newName = el("input", { type: "text", spellcheck: "false", placeholder: "Its name" });
  const newWhat = el("input", { type: "text", spellcheck: "false", placeholder: "What belongs here" });
  const addTopic = async () => {
    const name = newName.value.trim();
    if (!name) { say("A topic needs a name", true); return; }
    if (await change("memory.topic.add", { name, description: newWhat.value.trim() }, "Topic added")) { mgOpen.add(name); again(); }
  };
  newWhat.addEventListener("keydown", (e) => { if (e.key === "Enter") addTopic(); });

  // Documents kept in full, and pictures, each opened in a sheet in the page.
  const docs = (mem.documents || []).map((d) => mgRow(d.title, [d.source, mgWhen(d.t), `${Number(d.size).toLocaleString()} characters`].filter(Boolean).join(" · "),
    el("button", { class: "t-btn", onclick: () => mgReadDoc(d.title) }, "Read"),
    twiceBtn("Delete", "Delete it?", async () => { if (await change("memory.document.delete", { title: d.title }, "Deleted from memory; the original is untouched")) again(); })));
  const pics = (mem.pictures || []).map((p) => el("button", { class: "mg-pic", title: p.note || p.label, onclick: () => mgViewPicture(p) },
    el("b", {}, p.label), el("small", {}, p.note || mgWhen(p.t))));

  mgBody(
    el("div", { class: "row" }, el("span", { class: "name" }, "Topics", el("small", {}, `${topics.length}`)), el("span", { class: "what" }, filter)),
    list,
    mgRow("+ Topic", "", newName, newWhat, el("button", { class: "t-btn", onclick: addTopic }, "Add")),
    el("h3", {}, "Documents kept in full"),
    el("div", { class: "mg-scroll" }, ...(docs.length ? docs : [Kit.empty("None")])),
    el("h3", {}, "Pictures"),
    pics.length ? el("div", { class: "mg-pics mg-scroll" }, ...pics) : el("p", { class: "note" }, "None. Say “remember what I look like” or “this is my dog” while the camera can see."),
    mgGarden(garden, again));
}

// The gardener: what it changed, day by day, each change undone on its own.
function mgGarden(g, again) {
  const now = el("button", { class: "t-btn small" }, "Tidy now");
  now.addEventListener("click", async () => {
    now.disabled = true;
    now.textContent = "Tidying…";
    say("Tidying… this can take minutes");
    const r = await change("memory.garden.run", {});
    if (r) say(r.changes ? `Tidied: ${r.changes} change${r.changes === 1 ? "" : "s"}` : "Tidied: nothing to change");
    if (mgLive()) again();
  });
  const days = (g && g.ok ? g.days : null) || [];
  const report = days.flatMap((day) => [
    el("div", { class: "label mg-day" }, day.when || day.day),
    ...(day.changes || []).map((c) => el("div", { class: "row mg-change" + (c.undone ? " undone" : "") },
      el("span", { class: "mg-said" }, c.said || c.kind, ...(c.detail ? [el("small", {}, c.detail)] : [])),
      el("span", { class: "what mg-end" }, c.undone ? el("span", { class: "note", style: "margin:0" }, "Undone")
        : el("button", { class: "t-btn", onclick: async () => { if (await change("memory.garden.undo", { id: c.id }, "Undone")) again(); } }, "Undo")))),
  ]);
  return el("div", {},
    el("h3", { class: "with-btn" }, "Kept tidy", now),
    ...(g && !g.ok ? [el("p", { class: "note err" }, g.error || "")] : []),
    report.length ? el("div", { class: "mg-scroll" }, ...report)
      : el("p", { class: "note" }, "Nothing tidied yet. Once a day, when nothing is going on, Morgan merges notes that say the same thing, folds small topics it made into the others, and splits topics grown too big. Topics you made are never folded away."));
}

// A sheet over the page: a document's text or a picture. Escape puts it away, not Settings.
function mgSheet(title, ...kids) {
  mgCloseSheet();
  const sheet = el("div", { class: "kit-scrim", id: "mg-sheet", onclick: (e) => { if (e.target === sheet) mgCloseSheet(); } },
    el("div", { class: "kit-sheet mg-sheet-box" },
      el("div", { class: "mg-sheet-head" }, el("span", { class: "label" }, title), el("button", { class: "t-btn small", onclick: mgCloseSheet }, "Close")),
      ...kids));
  document.body.append(sheet);
  return sheet;
}
function mgCloseSheet() { const s = $("mg-sheet"); if (s) s.remove(); }
addEventListener("keydown", (e) => {
  if (e.key === "Escape" && $("mg-sheet")) { e.stopImmediatePropagation(); mgCloseSheet(); }
}, { capture: true });

async function mgReadDoc(title) {
  const text = el("div", { class: "mg-sheet-text" }, "Reading…");
  mgSheet(title, text);
  const r = await ask("memory.document.get", { title });
  if (!r.ok) { text.textContent = r.error || "Morgan did not answer"; text.classList.add("err"); return; }
  text.textContent = r.text || "";
  const meta = [r.source, mgWhen(r.t)].filter(Boolean).join(" · ");
  if (meta) text.before(el("p", { class: "note", style: "margin:0 0 8px" }, meta));
  if (r.more) text.after(el("p", { class: "note" }, `…and ${Number(r.more).toLocaleString()} more characters, not shown here.`));
}

async function mgViewPicture(p) {
  const box = el("div", { class: "mg-sheet-pic" }, el("p", { class: "note" }, "Opening…"));
  mgSheet(p.label, box, ...(p.note ? [el("p", { class: "note" }, p.note)] : []),
    el("div", { class: "data-buttons" }, twiceBtn("Delete", "Delete it?", async () => {
      if (await change("memory.picture.delete", { label: p.label }, "Picture deleted")) { mgCloseSheet(); if (mgLive()) loadMorgan(true); }
    })));
  const r = await ask("memory.picture.view", { label: p.label });
  if (!r.ok || !r.data) { box.replaceChildren(el("p", { class: "note err" }, r.error || "Morgan did not send the picture")); return; }
  // Morgan keeps JPEGs mostly; a PNG says so in its first bytes.
  const type = r.data.startsWith("iVBOR") ? "image/png" : "image/jpeg";
  box.replaceChildren(el("img", { alt: p.label, src: `data:${type};base64,${r.data}` }));
}

// ---------------------------------------------------------------- Morgan: reminders

async function mgReminders() {
  const r = await ask("reminders.list");
  if (!mgLive() || failed(r)) return;
  const draw = (list) => mgBody(...(list.length ? list.map((x) => mgRow(x.text || "A timer", x.when || mgWhen(x.at),
    twiceBtn("Cancel", "Cancel it?", async () => { const now = await change("reminders.cancel", { id: x.id }, "Cancelled"); if (now && mgLive()) draw(now.reminders || []); })))
    : [el("p", { class: "note" }, "None. Say “remind me to…” or “set a timer for…”, and Morgan speaks up when it is due.")]));
  draw(r.reminders || []);
}

// ---------------------------------------------------------------- Morgan: connections

const mgToolsOpen = new Set();
const MODES = [["allow", "Allow"], ["ask", "Ask"], ["off", "Off"]];
const MODE_SAID = { allow: "runs when Morgan calls it", ask: "waits for your yes", off: "not given to Morgan" };

/*
 * Morgan's MCP servers, in two lists: those Morgan's brain keeps — here, or on
 * the server when this machine is its client — and **this machine's own**
 * (`client.json`), which run here and reach only what is here: Talaris's,
 * which reads this machine's encrypted store, first among them. Both are
 * changed from here; each tool is Allow (run when Morgan calls it), Ask (put
 * to you for a yes first) or Off (protocol 1.5).
 */
async function mgConnections() {
  const [r, own] = await Promise.all([ask("mcp.list"), ask("client.mcp.list")]);
  if (!mgLive() || failed(r)) return;
  let servers = r.servers || [];
  let mine = own.ok ? own.servers || [] : [];
  const client = own.ok && own.role === "client";
  const draw = () => {
    const redrawServers = (x) => { if (x && mgLive()) { servers = x.servers || []; draw(); } };
    const redrawMine = (x) => { if (x && mgLive()) { mine = x.servers || []; draw(); } };
    // This machine's own, as the server lists them too, are shown once: in their own list.
    const ownNames = new Set(mine.map((m) => m.name));
    const theirs = servers.filter((s) => !(s.allow === "device" && ownNames.has(s.name)));

    const serverBlock = (s, onThisMachine) => {
      const elsewhere = s.allow === "device";
      const op = (o) => (onThisMachine ? `client.${o}` : o);
      const redraw = onThisMachine ? redrawMine : redrawServers;
      const key = `${onThisMachine ? "own" : "brain"}:${s.name}`;
      const state = s.connected ? "Connected" : `Can't reach it${s.error ? `: ${s.error}` : ""}`;
      const meta = [s.target, s.hasKey ? "key saved" : "", elsewhere ? "" : state].filter(Boolean).join(" · ");
      const open = mgToolsOpen.has(key);
      const head = el("div", { class: "row net" + (s.connected || elsewhere ? "" : " mg-bad") }, el("span", { class: "name" }, s.name, el("small", {}, meta)),
        el("span", { class: "what" },
          el("button", { class: "t-btn", onclick: () => { if (open) mgToolsOpen.delete(key); else mgToolsOpen.add(key); draw(); } }, open ? "Hide tools" : `Tools (${(s.tools || []).length})`),
          ...(elsewhere ? [] : [twiceBtn("Remove", "Remove it?", async () => redraw(await change(op("mcp.remove"), { name: s.name }, "Server removed")))])));
      const block = el("div", { class: "mg-server" }, head);
      if (!open) return block;
      const body = el("div", { class: "mg-tools" });
      // Another device's own: changed on that device.
      if (elsewhere) body.append(el("p", { class: "note", style: "margin:0 0 4px" }, `Kept on ${s.device}; changed there.`));
      else {
        body.append(mgRow("Tools that change things", "Until one is set by itself: Ask, or Off", segOf([["all", "Ask"], ["read", "Off"]], s.allow,
          async (allow) => redraw(await change(op("mcp.allow"), { name: s.name, allow }, "Saved")))));
      }
      for (const t of s.tools || []) {
        const mode = t.mode || (t.on ? (t.readOnly ? "allow" : "ask") : "off");
        body.append(mgRow(t.name, `${t.readOnly ? "Reads" : "Changes things"} · ${MODE_SAID[mode]}`, ...(elsewhere ? [] : [segOf(MODES, mode,
          async (m) => redraw(await change(op("mcp.tool"), { name: s.name, tool: t.name, mode: m }, `${t.name}: ${m}`)))])));
      }
      if (!(s.tools || []).length) body.append(el("p", { class: "note", style: "margin:4px 0" }, "No tools read."));
      block.append(body);
      return block;
    };

    const reconnect = el("button", { class: "t-btn small" }, "Reconnect all");
    reconnect.addEventListener("click", async () => { reconnect.disabled = true; say("Connecting…"); redrawServers(await change("mcp.reconnect", {}, "Connected again")); reconnect.disabled = false; });

    const name = el("input", { type: "text", spellcheck: "false", placeholder: "Short name" });
    const target = el("input", { type: "text", spellcheck: "false", placeholder: "https://… or a command to run" });
    const key = el("input", { type: "password", placeholder: "Access key, if it needs one" });
    // A client adds a server to the brain on the server, or to its own list, here.
    let where = "brain";
    const mgRowWhere = () => {
      const row = mgRow("Runs", "On the server, or on this machine (it reaches what is here)",
        segOf([["brain", "On the server"], ["here", "Here"]], where, (w) => { where = w; row.replaceWith(mgRowWhere()); }));
      return row;
    };
    const add = async () => {
      const t = target.value.trim();
      if (!name.value.trim() || !t) { say("A server needs a name, and a URL or a command", true); return; }
      const args = /^https?:\/\//.test(t) ? { name: name.value.trim(), url: t, ...(key.value.trim() ? { key: key.value.trim() } : {}) } : { name: name.value.trim(), command: t };
      say("Connecting…");
      if (where === "here") redrawMine(await change("client.mcp.add", args, "Server added"));
      else redrawServers(await change("mcp.add", args, "Server added"));
    };
    mgBody(
      el("h3", { class: "with-btn" }, client ? "On the server" : "MCP servers", reconnect),
      el("div", { class: "mg-scroll" }, ...(theirs.length ? theirs.map((s) => serverBlock(s, false)) : [Kit.empty("None yet")])),
      ...(mine.length ? [
        el("h3", {}, client ? "On this machine" : "This machine's own"),
        el("p", { class: "note" }, client ? "Run here and offered to the server; what they reach never leaves this machine but as answers."
          : "Kept for this machine (client.json): they stay if Morgan's brain moves to a server."),
        el("div", { class: "mg-scroll" }, ...mine.map((s) => serverBlock(s, true))),
      ] : []),
      el("h3", {}, "Add a server"),
      mgRow("Name", "Letters and digits", name),
      mgRow("Where", "A URL, or a command to run", target),
      mgRow("Access key", "For a URL that needs one", key),
      ...(client ? [mgRowWhere()] : []),
      el("div", { class: "row" }, el("span", { class: "name" }), el("span", { class: "what" }, el("button", { class: "t-btn", onclick: add }, "Add"))),
      el("p", { class: "note" }, "Servers that need a browser sign-in cannot be added here; those are reached through the Oracle."));
  };
  draw();
}

// ---------------------------------------------------------------- Morgan: log

async function mgLog() {
  const r = await ask("log.recent", { count: 200 });
  if (!mgLive() || failed(r)) return;
  const lines = r.lines || [];
  const box = el("div", { class: "mg-log" }, ...(lines.length ? lines.map((l) =>
    el("div", { class: `mg-line ${l.level || "info"}` }, el("span", { class: "mg-at" }, l.at || ""), el("span", {}, l.text || "")))
    : [Kit.empty("Nothing logged since it started")]));
  mgBody(el("h3", { class: "with-btn" }, "The latest 200 lines", el("button", { class: "t-btn small", onclick: () => loadMorgan(true) }, "Refresh")), box);
  box.scrollTop = box.scrollHeight;
}

const MG_PAGES = { where: mgWhere, assistant: mgAssistant, models: mgModels, voice: mgVoice, memory: mgMemory,
  reminders: mgReminders, connections: mgConnections, log: mgLog };

// ---------------------------------------------------------------- pages and ways back

// ---------------------------------------------------------------- wallpaper
//
// Whose wallpaper is on show: the default ("") — every project without its
// own — or one project's. The strip above says which: the default first,
// then each project, its own picture or the default's, faded. Choosing a
// picture for a project that has none gives it its own; "Use the default"
// gives it up. A new picture comes through the desktop's chooser.
let wallScope = null;
function drawWallpaper(w) {
  if (wallScope === null) wallScope = w.scope || "";
  const stamp = Date.now();
  const tile = (scope, name, sub, own) => {
    const b = el("button", { class: "wall" + (scope === wallScope ? " on" : "") + (scope && !own ? " inherits" : ""), title: scope ? (own ? `${name}: its own` : `${name}: the default`) : "Every project without its own" });
    b.append(el("img", { alt: "", src: `talaris-ui://wallpaper/?${scope ? `project=${encodeURIComponent(scope)}&` : ""}t=${stamp}` }),
      el("span", { class: "wn" }, name), el("span", { class: "ws" }, sub));
    b.addEventListener("click", () => { wallScope = scope; bridge.wallpaper(scope, (text) => drawWallpaper(JSON.parse(text))); });
    return b;
  };
  const projects = (w.projects || []).slice().sort((a, b) => (b.id === w.here) - (a.id === w.here) || (b.home - a.home) || a.name.localeCompare(b.name));
  $("walls").replaceChildren(tile("", "Default", "every project", true),
    ...projects.map((p) => tile(p.id, p.name, [p.id === w.here ? "here" : "", p.own ? "own" : "default"].filter(Boolean).join(" · "), p.own)));
  const scoped = wallScope !== "";
  $("wall-name").textContent = scoped && !w.own ? "The default" : w.path ? w.path.replace(/^\/home\/[^/]+/, "~") : "None set";
  $("wall-preview").src = w.path ? `talaris-ui://wallpaper/?${scoped ? `project=${encodeURIComponent(wallScope)}&` : ""}t=${stamp}` : "";
  // A button style wins over `hidden`: shown or not by its display.
  $("wall-default").style.display = scoped && w.own ? "" : "none";
  seg("wall-fit", [["cover", "Cover"], ["contain", "Contain"], ["tile", "Tile"], ["fill", "Fill"]], w.fit || "cover",
    (fit) => bridge.fitWallpaper(wallScope, fit));
  if (w.error) say(w.error, true);
  else if (w.changed) say("Wallpaper set");
}
$("wall-choose").addEventListener("click", () => bridge && bridge.chooseWallpaper(wallScope || ""));
$("wall-default").addEventListener("click", () => bridge && bridge.defaultWallpaper(wallScope || ""));

// Which set of idle times is on show; the page opens on the one in use.
let powerProfile = "ac";

// Charging is the battery's own, not hypridle's: it works whether or not
// Talaris manages power, once the udev rule lets it write.
function chargingRows() {
  bridge.charging((text) => {
    const ch = JSON.parse(text);
    const rows = ["charge-mode", "charge-start", "charge-stop"];
    if (!ch.present) { $("charge-note").textContent = "No battery."; needs(rows, false); return; }
    $("charge-level").textContent = `Now ${ch.level}%`;
    $("charge-note").textContent = ch.writable ? "" :
      "To change these, install the rule once: sudo cp systemd/90-talaris-battery.rules /etc/udev/rules.d/ && sudo udevadm control --reload && sudo udevadm trigger --subsystem-match=power_supply";
    const setCh = (change) => bridge.setCharging(JSON.stringify({ mode: ch.mode, start: ch.start, stop: ch.stop, ...change }), (error) => {
      if (error) say(error, true); else say("Saved");
      chargingRows();
    });
    seg("charge-mode", ch.modes.map((m) => [m, m]), ch.mode, (mode) => setCh({ mode }));
    slider("charge-start", ch.start ?? 75, (v) => `${v}%`, (start) => setCh({ start }));
    slider("charge-stop", ch.stop ?? 90, (v) => `${v}%`, (stop) => setCh({ stop }));
    needs(["charge-mode"], ch.writable);
    needs(["charge-start", "charge-stop"], ch.writable && ch.mode === "Custom");
    for (const id of ["charge-start", "charge-stop"]) $(id).disabled = !(ch.writable && ch.mode === "Custom");
  });
}

// Two idle managers fight; say so, and what to take out.
function powerNote() {
  chargingRows();
  bridge.power((text) => {
    const st = JSON.parse(text);
    $("power-now").textContent = st.plugged ? "Plugged in now" : "On battery now";
    const n = $("power-note");
    if (st.managed && st.others.length) {
      n.textContent = `Another hypridle is running too (${st.others.length}), and screens would lock and turn off twice. Remove "exec-once = hypridle" from hyprland.conf and turn off the hypridle service: systemctl --user disable --now hypridle`;
    } else if (st.managed) {
      n.textContent = "Talaris's hypridle is running with these settings.";
    } else {
      n.textContent = st.others.length ? "Your own hypridle setup is running; Talaris is leaving it alone." : "";
    }
  });
}

// ---------------------------------------------------------------- accounts
//
// GNOME Online Accounts' (accounts.py): listed here, each one's calendar and
// contacts on or off, removed; added in its own window, beside Settings.
function drawAccounts() {
  bridge.accounts((text) => {
    const a = JSON.parse(text);
    const msg = (t, err) => { $("acct-msg").textContent = t || ""; $("acct-msg").className = err ? "note err" : "note"; };
    $("acct-add").disabled = !a.canAdd;
    if (!a.canAdd) $("acct-add-note").textContent = "Needs gnome-online-accounts-gtk: sudo apt install gnome-online-accounts-gtk";
    const done = (err) => { msg(err, !!err); drawAccounts(); };
    $("acct-list").replaceChildren(...(a.accounts.length ? a.accounts.map((acc) => {
      const switches = Object.entries(acc.uses).map(([what, on]) => {
        const sw = el("button", { class: "switch" + (on ? " on" : ""), title: what === "calendar" ? "Calendar" : "Contacts" });
        sw.addEventListener("click", () => bridge.accountSwitch(acc.path, what, !on, done));
        return [el("small", { class: "note", style: "margin:0" }, what === "calendar" ? "Calendar" : "Contacts"), sw];
      }).flat();
      const again = acc.attention ? el("button", { class: "t-btn", onclick: () => { msg("Signing in…"); bridge.accountSignIn(acc.path, done); } }, "Sign in again") : "";
      return netRow(acc.who || acc.provider, acc.attention ? `${acc.provider} · needs signing in again` : acc.provider, "", ...switches, again,
        twiceBtn("Remove", "Remove it?", () => bridge.accountRemove(acc.path, done)));
    }) : [el("p", { class: "note" }, a.present ? "No accounts yet." : `Online Accounts is not running here${a.error ? ` (${a.error})` : ""}.`)]));
  });
}
$("acct-add").addEventListener("click", () => bridge && bridge.accountAdd());

// The colors a calendar may wear, as Google's and Outlook's own run, and the accents.
const CAL_COLORS = Palette.COLORS;
function setColor(id, color) {
  bridge.calendarColor(id, color);
  // Evolution writes it and says so; read the list again a moment after.
  setTimeout(drawCalendars, 500);
}

// Every calendar Evolution has — the accounts', this computer's, the
// birthdays from contacts — by account, each shown in the calendar or not.
function drawCalendars() {
  bridge.calendars((text) => {
    const cals = JSON.parse(text);
    const hidden = new Set((cfg.calendar || {}).hidden || []);
    const byAccount = {};
    for (const c of cals) (byAccount[c.account] ||= []).push(c);
    const rows = Object.entries(byAccount).flatMap(([account, list]) => [
      el("h3", { class: "account" }, account),
      ...list.map((c) => {
        const sw = el("button", { class: "switch" + (hidden.has(c.id) ? "" : " on"), title: "Shown in the calendar" });
        sw.addEventListener("click", () => {
          const now = new Set((cfg.calendar || {}).hidden || []);
          if (now.has(c.id)) now.delete(c.id); else now.add(c.id);
          save({ calendar: { hidden: [...now] } });
        });
        // Its color, chosen from a palette or typed: kept in Evolution, so
        // the calendar and anything else reading these calendars agree.
        const swatch = el("button", { class: "cv-swatch", title: "Its color", style: `background:${c.color || "var(--accent)"}` });
        const palette = el("div", { class: "cal-palette", hidden: "" },
          ...CAL_COLORS.map((col) => el("button", { class: "cv-swatch" + (col === c.color ? " is-on" : ""), style: `background:${col}`, title: col,
            onclick: () => setColor(c.id, col) })),
          (() => {
            const hex = el("input", { type: "text", class: "hex", value: c.color || "", placeholder: "#rrggbb", spellcheck: "false" });
            hex.addEventListener("keydown", (e) => { if (e.key === "Enter" && /^#[0-9a-f]{6}$/i.test(hex.value.trim())) setColor(c.id, hex.value.trim().toLowerCase()); });
            return hex;
          })());
        swatch.addEventListener("click", () => { palette.hidden = !palette.hidden; });
        return el("div", {}, el("div", { class: "row" }, el("span", { class: "name" }, el("span", { style: "display:inline-flex;align-items:center;gap:8px" }, swatch, c.name)), el("span", { class: "what" }, sw)), palette);
      }),
    ]);
    $("acct-cals").replaceChildren(...(rows.length ? rows : [Kit.empty("No calendars yet")]));
  });
}

// ---------------------------------------------------------------- Wi-Fi and Bluetooth
//
// The same readings and changes as the bar's panels (machine.py), at more
// length: every saved network, in range or not, with whether it is joined by
// itself; every device of yours, with whether it may reconnect by itself.
const bars = (s) => (s == null ? "" : s > 70 ? "Strong" : s > 45 ? "Good" : s > 20 ? "Weak" : "Faint");
let wifiNow = null, btNow = null;
// A first press asks; a second, within a few seconds, does it — as everything is asked (kit.js).
// The small × that takes one thing off (controls.css .x-btn).
function xBtn(title) {
  const b = el("button", { class: "x-btn", title });
  b.innerHTML = Icons.close();
  return b;
}
function twiceBtn(label, ask, act) {
  return Kit.twice(el("button", { class: "t-btn danger" }, label), { ask, act });
}
function working(id, text) { $(id).textContent = text; $(id).className = "note"; }
function netRow(name, meta, cls, ...controls) {
  return el("div", { class: `row net ${cls || ""}` }, el("span", { class: "name" }, name, el("small", {}, meta)), el("span", { class: "what" }, ...controls));
}
function wifiSend(request, msg) { working("wifi-msg", msg); bridge.network(JSON.stringify(request)); }
function btSend(request, msg) { working("bt-msg", msg); bridge.bluetooth(JSON.stringify(request)); }

function drawWifi(w) {
  wifiNow = w;
  $("wifi-on").classList.toggle("on", !!w.on);
  needs(["wifi-rescan"], !!w.on);
  if (!w.on) {
    $("wifi-saved").replaceChildren(el("p", { class: "note" }, "Wi-Fi is off."));
    $("wifi-near").replaceChildren();
    return;
  }
  $("wifi-saved").replaceChildren(...(w.saved || []).map((s) => {
    const auto = el("button", { class: "switch" + (s.autoconnect ? " on" : ""), title: "Join by itself when in range" });
    auto.addEventListener("click", () => wifiSend({ verb: "auto", uuid: s.uuid, on: !s.autoconnect }, s.autoconnect ? `${s.name} will wait to be joined` : `${s.name} will be joined by itself`));
    const meta = s.active ? "Connected" : s.inRange ? `In range · ${bars(s.signal)}` : "Not in range";
    const act = s.active
      ? el("button", { class: "t-btn", onclick: () => wifiSend({ verb: "leave", ssid: s.name }, `Leaving ${s.name}…`) }, "Disconnect")
      : s.inRange ? el("button", { class: "t-btn", onclick: () => wifiSend({ verb: "join", ssid: s.name, known: true }, `Joining ${s.name}…`) }, "Connect") : "";
    return netRow(s.name, meta, s.active ? "current" : s.inRange ? "" : "dim-row", el("small", { class: "note", style: "margin:0" }, "Auto"), auto, act,
      twiceBtn("Forget", "Forget it?", () => wifiSend({ verb: "forget", uuid: s.uuid, ssid: s.name }, `Forgetting ${s.name}…`)));
  }));
  if (!(w.saved || []).length) $("wifi-saved").replaceChildren(Kit.empty("None saved"));
  const fresh = (w.networks || []).filter((n) => !n.known);
  $("wifi-near").replaceChildren(...fresh.map((n) => {
    const meta = `${bars(n.signal)}${n.secure ? " · Secured" : " · Open"}`;
    if (n.enterprise) return netRow(n.ssid, meta + " · needs a sign-in", "", el("button", { class: "t-btn", onclick: () => bridge.openTool && bridge.openTool("network") }, "Open the network tool"));
    if (!n.secure) return netRow(n.ssid, meta, "", el("button", { class: "t-btn", onclick: () => wifiSend({ verb: "join", ssid: n.ssid }, `Joining ${n.ssid}…`) }, "Join"));
    const pw = el("input", { type: "password", placeholder: "Password", class: "field" });
    const join = () => pw.value && wifiSend({ verb: "join", ssid: n.ssid, password: pw.value }, `Joining ${n.ssid}…`);
    pw.addEventListener("keydown", (e) => { if (e.key === "Enter") join(); });
    return netRow(n.ssid, meta, "", pw, el("button", { class: "t-btn", onclick: join }, "Join"));
  }));
  if (!fresh.length) $("wifi-near").replaceChildren(Kit.empty("Nothing new in range"));
}

function drawBt(b) {
  btNow = b;
  if (!b.present) { $("bt-mine").replaceChildren(el("p", { class: "note" }, "No Bluetooth here.")); return; }
  $("bt-on").classList.toggle("on", !!b.on);
  $("bt-visible").classList.toggle("on", !!b.visible);
  $("bt-alias").textContent = b.alias ? `As ${b.alias}, for a few minutes` : "For a few minutes";
  needs(["bt-visible", "bt-scan"], !!b.on);
  if (!b.on) { $("bt-mine").replaceChildren(el("p", { class: "note" }, "Bluetooth is off.")); $("bt-near").replaceChildren(); return; }
  $("bt-mine").replaceChildren(...(b.paired || []).map((d) => {
    const trust = el("button", { class: "switch" + (d.trusted ? " on" : ""), title: "Reconnect by itself" });
    trust.addEventListener("click", () => btSend({ verb: d.trusted ? "untrust" : "trust", mac: d.mac }, d.trusted ? `${d.name} will wait to be connected` : `${d.name} will reconnect by itself`));
    const meta = (d.connected ? "Connected" : "Not connected") + (d.battery != null ? ` · ${d.battery}%` : "");
    const act = d.connected
      ? el("button", { class: "t-btn", onclick: () => btSend({ verb: "disconnect", mac: d.mac }, `Disconnecting ${d.name}…`) }, "Disconnect")
      : el("button", { class: "t-btn", onclick: () => btSend({ verb: "connect", mac: d.mac }, `Connecting ${d.name}…`) }, "Connect");
    return netRow(d.name, meta, d.connected ? "current" : "", el("small", { class: "note", style: "margin:0" }, "Auto"), trust, act,
      twiceBtn("Forget", "Forget it?", () => btSend({ verb: "forget", mac: d.mac }, `Forgetting ${d.name}…`)));
  }));
  if (!(b.paired || []).length) $("bt-mine").replaceChildren(Kit.empty("None paired"));
  $("bt-near").replaceChildren(...(b.nearby || []).map((d) =>
    netRow(d.name, d.mac, "", el("button", { class: "t-btn", onclick: () => btSend({ verb: "pair", mac: d.mac }, `Pairing with ${d.name}…`) }, "Pair"))));
  if (!(b.nearby || []).length) $("bt-near").replaceChildren(el("p", { class: "note" }, "Nothing found yet. Put the device in pairing mode, then look."));
}

function onRadio(p) {
  const id = p.kind === "network" ? "wifi-msg" : "bt-msg";
  $(id).textContent = p.error || "";
  $(id).className = p.error ? "note err" : "note";
  if (p.kind === "network") drawWifi(p.state); else drawBt(p.state);
}
$("wifi-on").addEventListener("click", () => wifiSend({ verb: "power", on: !(wifiNow && wifiNow.on) }, "…"));
$("wifi-rescan").addEventListener("click", () => { working("wifi-msg", "Looking…"); bridge.panelRead("network", true); });
$("bt-on").addEventListener("click", () => btSend({ verb: "power", on: !(btNow && btNow.on) }, "…"));
$("bt-visible").addEventListener("click", () => btSend({ verb: "visible", on: !(btNow && btNow.visible) }, ""));
$("bt-scan").addEventListener("click", () => { working("bt-msg", "Looking for devices…"); bridge.panelRead("bluetooth", true); });

// ---------------------------------------------------------------- data

/*
 * The entity store: its recovery key, its backups, and which projects are
 * sealed. Everything here is asked of the core (through the bridge, answered
 * later, so a backup does not freeze the page).
 */
// Asked of the core as every page asks it (kit.js): one book of what waits, 2xx the answer, given up on if none comes.
const asked = Kit.core((id, method, path, body) => !!bridge && (bridge.core(id, method, path, body), true));
function core(method, path, body) { return asked.call(method, path, body); }

let vaultNow = null;
let reviving = null; // the backup chosen to revive

const when = (iso) => {
  const d = new Date(iso);
  return isNaN(d) ? "" : Kit.stamp(d);
};
const size = (n) => (n > 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

async function loadData() {
  working("data-where", "Reading…");
  try {
    vaultNow = await core("GET", "/vault");
    drawData();
  } catch (e) {
    $("data-where").textContent = e.message;
    $("data-where").className = "note err";
  }
}

// Data → Search by meaning: on or off, the model server and its embedding model (Morgan's, unless chosen), and how the index stands.
async function drawMeaning() {
  const host = $("meaning");
  if (!host) return;
  const m = cfg.meaning || { on: false, url: "", model: "" };
  let st = null;
  try { st = await core("GET", "/meaning/status"); } catch { /* the core is away for a moment */ }
  const url = pel("input", { type: "text", spellcheck: "false", autocomplete: "off", placeholder: "http://host:11434", value: m.url || "" });
  const models = pel("span", { class: "what" });
  const listModels = async () => {
    const at = url.value.trim();
    if (!at) { models.replaceChildren(pel("small", {}, "Set the address first")); return; }
    models.replaceChildren(pel("small", {}, "Looking…"));
    try {
      const list = await core("GET", `/meaning/models?url=${encodeURIComponent(at)}`);
      models.replaceChildren(...(list.length ? list.map((name) => pel("button", { class: "t-btn" + (name === m.model ? " on" : ""), onclick: () => save({ meaning: { ...m, url: at, model: name } }) }, name))
        : [pel("small", {}, "It has no embedding model")]));
    } catch (e) { models.replaceChildren(pel("small", { class: "err" }, e.message)); }
  };
  const useMorgans = pel("button", { class: "t-btn", onclick: async () => {
    const r = await ask("config.get");
    if (!r || !r.ok || !(r.ollama || {}).url) { say("Morgan did not say its model server", true); return; }
    save({ meaning: { ...m, url: r.ollama.url, model: r.embedModel || m.model } });
  } }, "Use Morgan's");
  url.addEventListener("keydown", (e) => { if (e.key === "Enter") save({ meaning: { ...m, url: url.value.trim() } }); });
  const said = !st ? "" : st.error ? `Stopped: ${st.error}`
    : st.indexing ? `Indexing… ${st.items} found so far, ${st.pending} to go`
    : `${st.items} things, ${st.passages} passages${st.pending ? `, ${st.pending} waiting` : ""}${st.last ? ` · looked ${when(st.last)}` : ""}`;
  host.replaceChildren(
    pel("div", { class: "row" }, pel("span", { class: "name" }, "On"), pel("span", { class: "what" }, mgSwitch(Boolean(m.on), (on) => save({ meaning: { ...m, on } })))),
    pel("div", { class: "row" }, pel("span", { class: "name" }, "Model server", pel("small", {}, "Ollama, or anything with the OpenAI-style API")), pel("span", { class: "what" }, url, useMorgans)),
    pel("div", { class: "row" }, pel("span", { class: "name" }, "Embedding model", pel("small", {}, m.model ? `Now: ${m.model}. Changing it makes the index again` : "Not chosen")), models),
    pel("div", { class: "row" }, pel("span", { class: "name" }, "Index", pel("small", { class: st && st.error ? "err" : "" }, said)),
      pel("span", { class: "what" }, pel("button", { class: "t-btn", disabled: !m.on || !m.model ? "" : null, onclick: async (e) => {
        e.target.disabled = true; say("Indexing…");
        try { const r = await core("POST", "/meaning/reindex"); say(`${r.embedded} embedded`); } catch (x) { say(x.message, true); }
        drawMeaning();
      } }, "Index now"))));
  if (m.url) listModels();
  drawReading();
}

// Data → Reading files: when files are looked at for anything new or changed (meaning.ts, `scan`), Scan now,
// and how far it is — drawn again every second or so while it reads, so the bar moves.
const SCAN = [["change", "As they change"], ["idle", "While idle"], ["schedule", "Once a day"], ["manual", "Only when asked"]];
const KIND_READ = { file: "file", page: "page", task: "task", person: "person", project: "project", event: "event" };
let readingTimer = null;
let noWordsOpen = false;   // the list of files that gave no words, shown
async function drawReading() {
  const host = $("reading");
  if (!host) return;
  clearTimeout(readingTimer);
  const m = cfg.meaning || {};
  let st = null;
  try { st = await core("GET", "/meaning/status"); } catch { /* the core is away for a moment */ }
  if (!st) { host.replaceChildren(pel("p", { class: "note" }, "The core is not answering just now.")); return; }
  const scan = m.scan || "change";
  const pick = pel("span", { class: "seg" }, ...SCAN.map(([k, label]) => pel("button", { class: k === scan ? "on" : "", onclick: () => k !== scan && save({ meaning: { ...m, scan: k } }) }, label)));
  const at = pel("input", { type: "time", value: m.at || "03:00", style: "width:auto" });
  at.addEventListener("change", () => save({ meaning: { ...m, scan: "schedule", at: at.value || "03:00" } }));
  const managed = Boolean((cfg.power || {}).managed);
  const hint = scan === "change" ? "Each minute or so, and as soon as a file changes in a project's folder"
    : scan === "idle" ? (managed ? "After two minutes away, or with the screen locked; again every ten minutes while you are away" : "With the screen locked (Talaris is not managing power, so it does not know when you are away)")
    : scan === "schedule" ? "Once a day, at the time below — or as soon after it as the computer is on"
    : "Only when Scan now is pressed";
  const busy = st.indexing || st.scanning;
  const f = st.files || { read: 0, nowords: 0, waiting: 0 };
  const counts = `${f.read} read · ${f.nowords} with no words · ${f.waiting} waiting${st.lastScan ? ` · last looked ${when(st.lastScan)}` : ""}`;
  const progress = busy && st.of
    ? pel("span", { class: "what", style: "flex-direction:column;align-items:stretch;min-width:260px" },
        pel("span", { class: "rd-doing" }, st.doing ? `Reading ${KIND_READ[st.doingKind] || "thing"}: ${st.doing}` : "Reading…", ` — ${st.done} of ${st.of}`),
        pel("span", { class: "track rd-bar" }, pel("i", { style: `width:${Math.round((100 * st.done) / Math.max(1, st.of))}%` })))
    : pel("span", { class: "what" }, pel("button", { class: "t-btn", disabled: !m.on || !m.model ? "" : null, onclick: async (e) => {
        e.target.disabled = true; say("Looking for new and changed files…");
        setTimeout(drawReading, 600);
        try { const r = await core("POST", "/meaning/scan"); say(`${r.read} read${r.changed ? `, ${r.changed} linked or changed` : ""}`); } catch (x) { say(x.message, true); }
        drawReading();
      } }, "Scan now"));
  // The files that gave no words: listed on asking, each (or all) read again.
  const again = async (keys, label) => {
    say(`Reading ${label} again…`);
    setTimeout(drawReading, 600);
    try { const r = await core("POST", "/meaning/read-again", keys ? { keys } : {}); say(`${r.again} read again`); } catch (x) { say(x.message, true); }
    drawReading();
  };
  let noWords = null;
  if (noWordsOpen && f.nowords) { try { noWords = await core("GET", "/meaning/nowords"); } catch { noWords = []; } }
  const noWordsRow = f.nowords && m.on ? pel("div", { class: "row" },
    pel("span", { class: "name" }, "Files that gave no words", pel("small", {}, "Pictures with no writing, drawings, or files that could not be read — found by their names only")),
    pel("span", { class: "what" },
      pel("button", { class: "t-btn", onclick: () => { noWordsOpen = !noWordsOpen; drawReading(); } }, noWordsOpen ? "Hide" : `Show ${f.nowords}`),
      pel("button", { class: "t-btn", disabled: busy ? "" : null, onclick: () => again(null, `all ${f.nowords}`) }, "Read all again"))) : null;
  const where = (x) => [x.path ? `${x.projectName} / ${x.path}` : x.abs ? x.abs.replace(/^\/home\/[^/]+/, "~") : `Stored in ${x.projectName}`,
    x.on.length ? `on ${x.on.join(", ")}` : ""].filter(Boolean).join(" · ");
  const noWordsList = noWords ? noWords.map((x) => pel("div", { class: "row rd-file" },
    pel("span", { class: "name" }, x.name, pel("small", {}, where(x))),
    pel("span", { class: "what" }, pel("button", { class: "t-btn", disabled: busy ? "" : null, onclick: () => again([x.key], x.name) }, "Read again")))) : [];
  // Pictures with no words in them, described by Morgan's vision model (heymorgan's `describe`).
  const describeRow = pel("div", { class: "row" },
    pel("span", { class: "name" }, "Describe pictures through Morgan", pel("small", { class: st.morganAway ? "err" : "" },
      st.morganAway ? "Morgan is not answering (or is too old to describe): those pictures wait, and are tried again"
        : "A picture, or a scanned page, with no words OCR can read: described by Morgan's vision model (Morgan, Models), and found by what it shows")),
    pel("span", { class: "what" }, mgSwitch(m.describe !== false, (on) => save({ meaning: { ...m, describe: on } }))));
  host.replaceChildren(...[
    pel("div", { class: "row" }, pel("span", { class: "name" }, "Look for new and changed files", pel("small", {}, hint)), pel("span", { class: "what" }, pick)),
    describeRow,
    scan === "schedule" ? pel("div", { class: "row" }, pel("span", { class: "name" }, "At"), pel("span", { class: "what" }, at)) : null,
    pel("div", { class: "row" }, pel("span", { class: "name" }, "Files", pel("small", { class: st.error ? "err" : "" }, st.error ? `Stopped: ${st.error}` : !m.on ? "Search by meaning is off, above" : counts)), progress),
    noWordsRow,
    ...noWordsList,
  ].filter(Boolean));
  // Drawn again while it reads, or files wait, and Data is on show.
  if ((busy || f.waiting) && $("data").classList.contains("on")) readingTimer = setTimeout(drawReading, busy ? 1000 : 5000);
}

/*
 * Demo mode (demo.py, the core's demo.ts): a made-up world — projects,
 * tasks, people, notes, events — to show Talaris off, kept apart from yours.
 * Each button starts Talaris again, so each asks once more first.
 */
function drawDemo() {
  bridge.demo((text) => {
    const d = JSON.parse(text || "{}");
    $("demo-note").textContent = d.on
      ? "This is the demo: everything here is made up, and none of it is yours. Yours is as you left it."
      : "A made-up world of projects, tasks, people, pages, files and events, to show Talaris off — fresh each time it is entered. Yours is not touched, and no plugin runs there.";
    $("demo-what").textContent = d.on ? "On — Talaris restarts to leave" : "Off — Talaris restarts to enter";
    const ask = (label, sure, verb) => {
      const b = el("button", { class: "t-btn" }, label);
      b.addEventListener("click", () => {
        if (!Kit.ask(b, { ask: sure })) return;
        b.disabled = true;
        b.textContent = "Restarting…";
        bridge.demoMode(verb);
      });
      return b;
    };
    $("demo-buttons").replaceChildren(...(d.on
      ? [ask("Leave demo", "Leave and restart?", "leave"), ask("Reset demo", "Make it afresh?", "reset")]
      : [ask("Enter demo", "Restart into the demo?", "enter")]));
  });
}

function drawData() {
  drawDemo();
  const v = vaultNow;
  if (!v) return;
  drawMeaning();
  $("data-where").className = "note";
  $("data-where").textContent = "People, events, notes, tasks and projects, kept encrypted in ~/.local/share/talaris.";
  bridge.demo((text) => { if (JSON.parse(text || "{}").on) $("data-where").textContent = "The demo's people, events, notes, tasks and projects, made up, in ~/.local/share/talaris-demo."; });
  $("data-locked").hidden = !v.locked;
  $("data-open").hidden = !!v.locked;
  if (v.locked) { $("data-locked-why").textContent = v.locked; return; }

  // The recovery key: shown until it is said to be kept, then never again.
  if (v.pending) {
    $("recovery").replaceChildren(
      el("p", { class: "note" }, "Write this down or put it in your password manager. It is the only way to open a backup, or this store if the keyring loses its key. It is shown until you say it is kept, and never again."),
      el("div", { class: "recovery-key" }, v.pending),
      el("div", { class: "data-buttons" },
        el("button", { class: "t-btn", onclick: () => { bridge.copyText(v.pending); say("Copied"); } }, "Copy"),
        el("button", { class: "t-btn", onclick: () => core("POST", "/vault/recovery-kept").then(() => { say("Kept"); loadData(); }, (e) => say(e.message, true)) }, "I have kept it")));
  } else {
    $("recovery").replaceChildren(el("div", { class: "row" },
      el("span", { class: "name" }, "Kept", el("small", {}, "Shown once; Talaris does not have it")),
      el("span", { class: "what" }, el("button", { class: "t-btn", onclick: replaceRecovery }, "Replace…"))));
  }

  const b = v.backups;
  const d = (cfg && cfg.data) || {};
  $("backup-folder").textContent = d.backupFolder || "~/.local/share/talaris/backups";
  seg("backup-schedule", [["off", "Never"], ["daily", "Daily"], ["weekly", "Weekly"]], d.schedule || "off", (schedule) => save({ data: { schedule } }));
  slider("backup-keep", d.keep || 7, (n) => `${n}`, (keep) => save({ data: { keep } }));
  const last = b.last;
  $("backup-last").textContent = b.error ? `Failed: ${b.error}`
    : last ? `${when(last.at)} · ${last.objects} things · ${size(last.bytes)} · format check ${last.check}` : "None yet";
  $("backup-last").className = b.error || (last && last.check === "failed") ? "err" : "";
  drawRevive();
  drawSealed();
}

function replaceRecovery() {
  $("recovery").replaceChildren(
    el("p", { class: "note" }, "A new recovery key. Backups made from now on need it; backups already made still need the old one."),
    el("div", { class: "data-buttons" },
      el("button", { class: "t-btn", onclick: drawData }, "Cancel"),
      el("button", { class: "t-btn", onclick: () => core("POST", "/vault/recovery/replace").then(loadData, (e) => say(e.message, true)) }, "Make a new one")));
}

async function drawSealed() {
  let projects = [];
  try { projects = await core("GET", "/projects"); } catch { /* said elsewhere */ }
  const sealed = new Set(vaultNow.encryptedProjects || []);
  $("sealed-projects").replaceChildren(...projects.map((p) => {
    const sw = el("button", { class: "switch" + (sealed.has(p.id) ? " on" : ""), title: "Encrypted" });
    sw.addEventListener("click", async () => {
      const on = !sealed.has(p.id);
      sw.disabled = true;
      say(on ? `Encrypting ${p.name}…` : `Decrypting ${p.name}…`);
      try {
        const r = await core("PUT", `/projects/${encodeURIComponent(p.id)}/encrypted`, { on });
        say(`${p.name}: ${r.files} files ${on ? "sealed" : "opened"}`);
        loadData();
      } catch (e) { say(e.message, true); sw.disabled = false; }
    });
    return el("div", { class: "row" }, el("span", { class: "name" }, p.name, el("small", {}, p.code || "")), el("span", { class: "what" }, sw));
  }));
}

function drawRevive() {
  if (!reviving) { $("revive").replaceChildren(); return; }
  const key = el("input", { spellcheck: "false", autocomplete: "off", placeholder: "Its recovery key" });
  const out = el("div", { class: "preview note" });
  const look = el("button", { class: "t-btn" }, "Look inside");
  const go = el("button", { class: "t-btn", hidden: "" }, "Revive it");
  look.addEventListener("click", async () => {
    out.textContent = "Opening…";
    try {
      const p = await core("POST", "/backups/preview", { file: reviving, recoveryKey: key.value });
      const kinds = Object.entries(p.kinds).map(([k, n]) => `${n} ${k}`).join(", ");
      const plugs = (p.plugins || []).length ? ` Plugins' settings and state: ${p.plugins.join(", ")}.` : "";
      out.textContent = `Made ${when(p.made)}: ${p.objects} things (${kinds || "nothing"}), ${p.relations} links.${plugs} Reviving replaces what is here now, which is backed up first.`;
      go.hidden = false;
    } catch (e) { out.textContent = e.message; out.className = "preview note err"; }
  });
  go.addEventListener("click", async () => {
    go.disabled = true;
    out.className = "preview note";
    out.textContent = "Reviving…";
    try {
      const r = await core("POST", "/backups/revive", { file: reviving, recoveryKey: key.value });
      const lost = r.findings.filter((f) => f.severity !== "info");
      const pl = r.plugins || { restored: [], waiting: [], secrets: [] };
      out.textContent = `Revived: ${r.counts.objects} things, ${r.counts.files} files.` + (lost.length ? ` ${lost.length} things could not come back whole: ${lost.map((f) => f.message).join("; ")}` : "")
        + (pl.restored.length ? ` Plugins put back: ${pl.restored.join(", ")}.` : "")
        + (pl.waiting.length ? ` Waiting until they are installed: ${pl.waiting.join(", ")}.` : "")
        // Secrets are never in a backup: said, so they are typed again.
        + (pl.secrets.length ? ` Enter again in Plugins (never kept in a backup): ${pl.secrets.join("; ")}.` : "");
      reviving = null;
      setTimeout(loadData, 2500);
    } catch (e) { out.textContent = e.message; out.className = "preview note err"; go.disabled = false; }
  });
  $("revive").replaceChildren(el("div", { class: "row" },
    el("span", { class: "name" }, reviving.split("/").pop()),
    el("span", { class: "what" }, key, look, go)), out);
}

function onPicked(p) {
  if (p.kind === "plugin") { installPlugin(p.path); return; }
  if (p.kind === "folder") save({ data: { backupFolder: p.path } });
  else { reviving = p.path; drawRevive(); }
}

$("backup-choose").addEventListener("click", () => bridge.choose("folder"));
$("revive-choose").addEventListener("click", () => bridge.choose("backup"));
$("backup-now").addEventListener("click", async () => {
  $("backup-now").disabled = true;
  say("Backing up…");
  try {
    const r = await core("POST", "/backups/now");
    say(`Backed up · format check ${r.check}`);
  } catch (e) { say(e.message, true); }
  $("backup-now").disabled = false;
  loadData();
});
$("unlock-go").addEventListener("click", async () => {
  try {
    await core("POST", "/vault/unlock", { recoveryKey: $("unlock-key").value });
    $("unlock-key").value = "";
    say("Opened");
    loadData();
  } catch (e) { say(e.message, true); }
});

// What the bar shows, item by item. Settings is not among them: it is the way back.
const BAR_SHOWN = [["where", "Project"], ["ask", "Launcher"], ["morgan", "Morgan"], ["new", "New"], ["tasks", "Tasks"], ["people", "People"], ["files", "Library"], ["canvas", "Canvas"],
  ["writing", "Writing"], ["day", "Date"], ["time", "Time"], ["theme", "Light/dark"], ["net", "Wi-Fi"], ["bt", "Bluetooth"],
  ["vol", "Volume"], ["bat", "Battery"], ["bat-n", "Battery percent"], ["clipboard", "Clipboard"], ["bell", "Notifications"], ["power", "Power"]];
// What a bar item opens, and so whose coming and going sits beside its switch. The clock opens the calendar
// from either half: its motion is on Time's row, and greyed only when neither half is shown.
const BAR_OPENS = { where: ["jump", "The projects"], ask: ["launcher"], morgan: ["morgan"], new: ["new"], tasks: ["tasks"], people: ["people"],
  files: ["files"], canvas: ["canvas"], writing: ["writing"], time: ["calendar", "Opens the calendar"] };
function drawBarShown() {
  const hidden = new Set(cfg.bar.hidden || []);
  const ov = cfg.overlays || {};
  const off = (id) => (id === "time" ? hidden.has("day") && hidden.has("time") : hidden.has(id));
  $("bar-shown").replaceChildren(...BAR_SHOWN.map(([id, label]) => {
    const sw = el("button", { class: "switch" + (hidden.has(id) ? "" : " on"), title: "Shown" });
    sw.addEventListener("click", () => {
      const next = new Set(cfg.bar.hidden || []);
      if (next.has(id)) next.delete(id); else next.add(id);
      save({ bar: { hidden: [...next] } });
    });
    const opens = BAR_OPENS[id];
    const name = el("span", { class: "name" }, label, opens && opens[1] ? el("small", {}, opens[1]) : "");
    if (!opens) return el("div", { class: "row" }, name, el("span", { class: "what" }, sw));
    // Shown first, then how it comes and goes — greyed, and not to be changed, while it is off the bar.
    const who = opens[0], gone = off(id);
    const how = el("span", { class: "seg" + (gone ? " off" : ""), title: gone ? "Not on the bar" : "How it comes and goes" },
      ...[["windows", "As windows"], ["drawers", "As panels"]].map(([value, text]) =>
        el("button", { class: value === (ov[who] || "windows") ? "on" : "", ...(gone ? { disabled: "" } : {}),
          onclick: () => !gone && value !== (ov[who] || "windows") && save({ overlays: { ...(cfg.overlays || {}), [who]: value } }) }, text)));
    return el("div", { class: "row" }, name, el("span", { class: "what" }, sw, how));
  }));
}

function show(page) {
  for (const b of document.querySelectorAll("nav button")) b.classList.toggle("on", b.dataset.page === page);
  for (const s of document.querySelectorAll("section")) s.classList.toggle("on", s.id === page);
  say("");
  if (page === "morgan") loadMorgan();
  if (page === "accounts") { drawAccounts(); drawCalendars(); }
  if (page === "wifi") { working("wifi-msg", "Reading…"); bridge.panelRead("network", false); }
  if (page === "bluetooth") { working("bt-msg", "Reading…"); bridge.panelRead("bluetooth", false); }
  if (page === "power") {
    bridge.power((text) => { powerProfile = JSON.parse(text).plugged ? "ac" : "battery"; draw(); });
    powerNote();
  }
  if (page === "data") loadData();
  if (page === "plugins") loadPlugins();
  if (page === "types") loadTypes();
  if (page === "look") bridge.wallpaper(wallScope || "", (text) => drawWallpaper(JSON.parse(text)));
  if (page === "keys") bridge.keys((text) => $("keylist").replaceChildren(...JSON.parse(text).map((k) => el("tr", {}, el("td", {}, k.keys), el("td", {}, k.does)))));
}

for (const b of document.querySelectorAll("nav button")) b.addEventListener("click", () => show(b.dataset.page));
$("done").addEventListener("click", () => bridge && bridge.file());
addEventListener("keydown", (e) => {
  if (e.key === "Escape" && bridge && !(e.target.closest && e.target.closest("select"))) bridge.file();
});
for (const type of ["pointerdown", "keydown", "wheel"]) addEventListener(type, () => bridge && bridge.activity(), { capture: true, passive: true });

function reload(page) {
  accentFor = "";
  bridge.config((text) => { const c = JSON.parse(text); cfg = c.config; fonts = c.fonts; draw(); show(page); });
}

// Opening, or a page asked for, starts fresh; any other state — the theme
// just changed, say — leaves the page as it is.
let wasUp = false;
// How it comes and goes (motion.js): as windows do, from the top, the line
// beside the sections drawn too.
let motionNow = {};
function how() {
  return {
    kind: motionNow.motion, speed: motionNow.speed, edge: "top", flush: false, viewport: motionNow.viewport,
    // Drawn and arriving: the screen behind is dimmed with it (settings.py, pointer_back).
    shown: () => bridge && bridge.drawn(),
    rules: (rule, rel, P) => { const n = document.querySelector("nav").getBoundingClientRect(); rule(rel(n.right, P.top), rel(n.right, P.bottom)); },
  };
}
Surface.connect({
  onState: (s) => {
    if (s.motion) motionNow = { ...s.motion, viewport: s.viewport };
    if (s.up && !wasUp) Motion.arrive($("win"), how());
    if (bridge && s.up && (!wasUp || s.page)) reload(s.page || "look");
    wasUp = !!s.up;
  },
}).then((b) => {
  bridge = b;
  // Going: played, then the process is told, and takes the surface away.
  b.leave.connect(() => {
    wasUp = false;
    const going = Motion.leave($("win"), how());
    if (going) going.onfinish = () => bridge.left(); else bridge.left();
  });
  // Only the wallpaper on show is redrawn by a change to it; another scope's answer is for its own showing.
  b.wallpaperChanged.connect((text) => { const w = JSON.parse(text); if ((w.scope || "") === (wallScope || "")) drawWallpaper({ ...w, changed: !w.error }); });
  b.panel.connect((text) => onRadio(JSON.parse(text)));
  b.accountsChanged.connect(() => { if ($("accounts").classList.contains("on")) drawAccounts(); });
  b.morganReply.connect(onMorganReply);
  b.coreReply.connect((text) => asked.reply(JSON.parse(text)));
  b.picked.connect((text) => onPicked(JSON.parse(text)));
  reload("look");
});

// ---------------------------------------------------------------- plugins
//
// Each installed plugin (core, plugins.ts): whether it runs, and opened, what
// it adds (its tools), what it may ask of Talaris — said before enabling, and
// asked again when it is — its settings (a secret only as set or not), the
// line it keeps about itself, and its log.

/** As `el`, leaving out what is absent: a null attribute is no attribute, a null child no child. */
function pel(tag, attrs = {}, ...kids) {
  return el(tag, Object.fromEntries(Object.entries(attrs).filter(([, v]) => v !== null && v !== undefined && v !== false)),
    ...kids.flat().filter((k) => k !== null && k !== undefined && k !== false && k !== ""));
}
const plOpen = new Set();
const plLogShown = new Set();
const KIND_WORD = { task: "tasks", project: "projects", event: "events", contact: "people", note: "notes" };
const kindsSaid = (ks) => ks.map((k) => KIND_WORD[k] || k).join(", ");

function plAsks(m) {
  const p = m.permissions;
  const items = [];
  if (p.read.length) items.push(`Read your ${kindsSaid(p.read)}`);
  if (p.write.length) items.push(`Make and change ${kindsSaid(p.write)}`);
  if (p.notify) items.push("Show notifications");
  if (!items.length) items.push("Nothing of Talaris");
  const said = [...(p.network.length ? [`Reaches ${p.network.join(", ")}`] : []), ...(p.files.length ? [`Uses ${p.files.join(", ")}`] : [])];
  return pel("div", {}, pel("ul", {}, ...items.map((x) => pel("li", {}, x))),
    said.length ? pel("p", { class: "note", style: "margin:0 0 6px" }, `It says it ${said.join("; ").replace(/^R/, "r").replace(/^U/, "u")} — said, not something Talaris can hold it to.`) : null);
}

// Settings → Types: each type's fields and profiles, and a task's statuses with what each means.
const tyOpen = new Set(["task"]);
const FIELD_KIND = { text: "text", richtext: "text, formatted", enum: "one of a list", date: "date", datetime: "date and time", datespan: "dates, from–to",
  boolean: "yes / no", number: "number", reference: "link", attachment: "files", url: "address" };
const MEANS = { "not-started": "not started", "in-progress": "in progress", waiting: "waiting", done: "done", cancelled: "cancelled" };
async function loadTypes() {
  let types;
  try { types = await core("GET", "/entity-types"); } catch (e) { $("type-list").replaceChildren(pel("p", { class: "note err" }, e.message)); return; }
  types = (Array.isArray(types) ? types : types.types || []).filter((t) => !t.archived);
  const byId = Object.fromEntries(types.map((t) => [t.id, t]));
  const label = (f) => f["talaris:label"] || f.key.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
  $("type-list").replaceChildren(...types.map((t) => {
    const role = t["talaris:role"] || t.id;
    const open = tyOpen.has(role);
    const profiles = Object.keys(t.profiles || {});
    const head = pel("div", { class: "row net" },
      pel("span", { class: "name" }, `${t.name} `, pel("small", {}, [`${t.fields.length} fields`, profiles.length ? `read as ${kindsSaid(profiles)}` : ""].filter(Boolean).join(" · "))),
      pel("span", { class: "what" }, pel("button", { class: "t-btn", onclick: () => { if (open) tyOpen.delete(role); else tyOpen.add(role); loadTypes(); } }, open ? "Less" : "More")));
    const block = pel("div", { class: "mg-server" }, head);
    if (!open) return block;
    const body = pel("div", { class: "pl-body" });
    const task = (t.profiles || {}).task;
    if (task && task.status) {
      const field = t.fields.find((f) => f.key === task.status) || {};
      const labels = field["talaris:labels"] || {}, colors = field["talaris:colors"] || {};
      const done = new Set(task.completeValues || []), states = task.states || {};
      const unset = (field.options || []).filter((v) => !states[v]);
      body.append(pel("h3", {}, "Statuses"),
        ...(field.options || []).map((v) => pel("div", { class: "ty-st" },
          pel("span", { class: "dot", style: `background:${colors[v] || "var(--muted)"}` }), labels[v] || v,
          done.has(v) ? pel("span", { class: "fin" }, "finished") : null,
          pel("span", { class: "means" + (states[v] ? "" : " unset") }, states[v] ? `means ${MEANS[states[v]] || states[v]}` : "no meaning yet"),
          v === t["talaris:defaultStatus"] ? pel("span", { class: "fin" }, "new tasks start here") : null)),
        unset.length ? pel("p", { class: "note", style: "margin:4px 0" }, `A sync carries statuses once each has a meaning — ${unset.length === 1 ? "one still needs" : `${unset.length} still need`} one.`) : null,
        pel("div", { style: "margin:6px 0 10px" }, pel("button", { class: "t-btn", onclick: async () => {
          if (await StatusEditor.open({ taskType: t, api: core })) { say("Statuses saved"); loadTypes(); }
        } }, "Edit statuses")));
    }
    body.append(pel("h3", {}, "Fields"), pel("table", { class: "ty-fields" }, ...t.fields.map((f) =>
      pel("tr", {}, pel("td", {}, label(f)),
        pel("td", { class: "ty-kind" }, [FIELD_KIND[f.kind] || f.kind, f.kind === "reference" && byId[f.targetType] ? `to ${byId[f.targetType].name.toLowerCase()}` : "",
          f.many ? "several" : "", f.required ? "required" : "", f["talaris:auto"] ? "kept by Talaris" : ""].filter(Boolean).join(", "))))));
    for (const [kind, p] of Object.entries(t.profiles || {})) {
      // A slot is a field, or half of one (a span's start or end).
      const where = (v) => {
        const f = t.fields.find((x) => x.key === (typeof v === "string" ? v : v && v.field));
        return f ? (typeof v === "string" ? label(f) : `${label(f)}, ${f[`${v.part}Label`] ? f[`${v.part}Label`].toLowerCase() : v.part}`) : null;
      };
      const slots = Object.entries(p).map(([slot, v]) => [slot, where(v)]).filter(([, w]) => w);
      body.append(pel("h3", {}, `Read as ${KIND_WORD[kind] ? KIND_WORD[kind].replace(/s$/, "").replace(/^people$/, "person") : kind}`),
        pel("table", { class: "ty-fields" }, ...slots.map(([slot, w]) => pel("tr", {}, pel("td", {}, slot), pel("td", { class: "ty-kind" }, w)))));
    }
    block.append(body);
    return block;
  }));
}

// Windows → Always solid: apps whose windows are never see-through, by window class.
function drawSolid() {
  bridge.openWindows((text) => {
    const open = JSON.parse(text);
    const solid = (cfg.windows.solid || []);
    const nameOf = (cls) => (open.find((o) => o.class === cls) || {}).name || cls;
    const put = (next) => save({ windows: { ...cfg.windows, solid: next } });
    const rows = solid.map((cls) => pel("div", { class: "row" }, pel("span", { class: "name" }, nameOf(cls), nameOf(cls) !== cls ? pel("small", {}, cls) : null),
      pel("span", { class: "what" }, pel("button", { class: "t-btn", onclick: () => put(solid.filter((c) => c !== cls)) }, "Remove"))));
    const addable = open.filter((o) => !solid.includes(o.class));
    $("solid").replaceChildren(...rows,
      pel("div", { class: "row" }, pel("span", { class: "name" }, "Add", pel("small", {}, "From the apps with a window open now")),
        pel("span", { class: "what solid-add" }, ...(addable.length ? addable.map((o) => pel("button", { class: "t-btn", title: o.class, onclick: () => put([...solid, o.class]) }, o.name))
          : [pel("small", {}, "Every open app is already here")]))));
  });
}

// Dock → Your choices: what each app's dock menu was told — what a click does when it is open in
// another project, and the project it is kept in — each put back to the default from here.
let stayApps = null, stayProjects = null;
const CHOICE = { new: "Opens a new window here", bring: "Sends it to where you are", go: "Goes to it" };
async function drawStays() {
  if (!stayApps) stayApps = await new Promise((ok) => bridge.applications((t) => ok(JSON.parse(t))));
  if (!stayProjects) { try { stayProjects = (await core("GET", "/projects")).filter((p) => !p.archived); } catch { stayProjects = []; } }
  const stays = cfg.dock.stays || {};
  const chosen = cfg.dock.elsewhere || {};
  const docs = cfg.dock.docs || [];
  const appName = (key) => key.startsWith("doc:") ? (docs.find((d) => `doc:${d.id}` === key) || {}).name || "a document unpinned"
    : (stayApps.find((a) => a.id === key) || {}).name || key;
  const projName = (id) => (stayProjects.find((p) => p.id === id) || {}).name || "a project gone";
  $("stays-head").textContent = "Your choices";
  $("stays-note").textContent = "Set from an app's menu on the dock (right-click): what a click does when it is open in another project, and the project it is kept in. Everything else follows the defaults: apps that open new windows (browsers, terminals) open one here; the rest as Keys, Single-window apps says, or go to the project they are kept in.";
  const keys = [...new Set([...Object.keys(chosen), ...Object.keys(stays)])].sort((a, b) => appName(a).localeCompare(appName(b)));
  const rows = keys.map((key) => pel("div", { class: "row" }, pel("span", { class: "name" }, appName(key)),
    pel("span", { class: "what" },
      [chosen[key] ? CHOICE[chosen[key]] : "", stays[key] ? `kept in ${projName(stays[key])}` : ""].filter(Boolean).join(" · "),
      chosen[key] ? pel("button", { class: "t-btn", title: "Back to the default", onclick: () => { const n = { ...chosen }; delete n[key]; save({ dock: { elsewhere: n } }); } }, "Reset") : null,
      stays[key] ? pel("button", { class: "t-btn", title: "Kept in no project", onclick: () => { const n = { ...stays }; delete n[key]; save({ dock: { stays: n } }); } }, "Stop keeping") : null)));
  $("stays").replaceChildren(...(rows.length ? rows : [Kit.empty("None yet")]));
}

async function loadPlugins() {
  let rows;
  try { rows = await core("GET", "/plugins"); } catch (e) { $("plugin-list").replaceChildren(pel("p", { class: "note err" }, e.message)); return; }
  const redraw = () => loadPlugins();
  $("plugin-list").replaceChildren(...(rows.length ? rows.map((r) => {
    if (!r.manifest) {
      return pel("div", { class: "row mg-bad" }, pel("span", { class: "name" }, r.id, pel("small", {}, `Not a plugin Talaris can read: ${r.error}`)), pel("span", { class: "what" }));
    }
    const m = r.manifest;
    const open = plOpen.has(r.id);
    const asking = pel("div", {});
    const sw = mgSwitch(r.enabled, async (on, s) => {
      // Enabling is asked: what it may ask of Talaris, said once more where the switch is.
      if (on && !s.dataset.armed) {
        s.dataset.armed = "1";
        plOpen.add(r.id);
        asking.replaceChildren(pel("div", { class: "kit-ask-box" }, pel("div", {}, `Enable ${m.name}? It may:`), plAsks(m),
          pel("div", { class: "acts" }, pel("button", { class: "t-btn", onclick: () => s.click() }, "Enable it"),
            pel("button", { class: "t-btn", onclick: () => { delete s.dataset.armed; asking.replaceChildren(); } }, "Not now"))));
        return;
      }
      delete s.dataset.armed;
      s.disabled = true;
      try { await core("POST", `/plugins/${encodeURIComponent(r.id)}/enable`, { on }); say(on ? `${m.name} enabled` : `${m.name} stopped`); } catch (e) { say(e.message, true); }
      setTimeout(redraw, on ? 1200 : 300);
    }, r.enabled ? "Stop it" : "Enable it");
    const state = r.state === "disabled" ? "off" : r.state;
    const head = pel("div", { class: "row net" + (r.state === "crashed" ? " mg-bad" : "") },
      pel("span", { class: "name" }, `${m.name} `, pel("small", {}, [`${m.version}`, m.description, r.status, r.problem && r.state !== "running" ? r.problem : ""].filter(Boolean).join(" · "))),
      pel("span", { class: "what" }, pel("span", { class: `pl-state ${r.state}` }, state),
        // What it puts here itself (its actions `on` settings: a Sync now), while it runs.
        ...(r.state === "running" ? (m.actions || []).filter((a) => (a.on || []).includes("settings")).map((a) => pel("button", { class: "t-btn", onclick: async (e) => {
          const b = e.currentTarget;
          b.disabled = true;
          try { const res = await core("POST", `/plugins/${encodeURIComponent(r.id)}/actions/${encodeURIComponent(a.id)}`, { kind: "settings" }); say(res.text || `${a.label}: done`, res.error); }
          catch (err) { say(err.message, true); }
          b.disabled = false;
          redraw();
        } }, a.label)) : []),
        pel("button", { class: "t-btn", onclick: () => { if (open) plOpen.delete(r.id); else plOpen.add(r.id); redraw(); } }, open ? "Less" : "More"), sw));
    const block = pel("div", { class: "mg-server" }, head, asking, plDecisions(r, redraw));
    if (!open) return block;
    const body = pel("div", { class: "pl-body" });
    body.append(pel("h3", {}, "It adds"),
      m.tools.length ? pel("ul", {}, ...m.tools.map((t) => pel("li", {}, `${t.name}${t.description ? ` — ${t.description}` : ""}`))) : pel("p", { class: "note" }, "No tools"),
      // Its windows: a web app each, in the launcher and the dock, on its key while it is enabled.
      (m.apps || []).length ? pel("ul", {}, ...m.apps.map((a) => pel("li", {}, `A window: ${a.name}${a.key ? `, on ${a.key.replace(/\s*,\s*/, "+").replace(/\s+/g, "+").toLowerCase().replace(/(^|\+)(\w)/g, (_m, p, c) => p + c.toUpperCase())}` : ""} — and in the launcher`))) : null,
      pel("p", { class: "note", style: "margin:0 0 6px" }, "Its tools reach Morgan, under Talaris's connection, with Allow, Ask or Off like any other."),
      pel("h3", {}, "It may ask of Talaris"), plAsks(m));
    if (m.settings.length) {
      body.append(pel("h3", {}, "Its settings"));
      const fields = {};
      // A switch or a choice is kept the moment it is set, as everywhere else in Settings; words wait for Save, or Enter.
      const keep = async (key, value) => {
        try { await core("PUT", `/plugins/${encodeURIComponent(r.id)}/settings`, { values: { [key]: value } }); say("Saved"); r.settings[key] = value; }
        catch (e) { say(e.message, true); redraw(); }
      };
      for (const def of m.settings) {
        const now = r.settings[def.key];
        let input;
        if (def.kind === "boolean") input = mgSwitch(Boolean(now), (on, s) => { s.classList.toggle("on", on); keep(def.key, on); });
        else if (def.kind === "choice") input = choiceOf((def.choices || []).map((c) => [c, c]), now, (v) => keep(def.key, v));
        else if (def.kind === "secret") input = pel("input", { type: "password", autocomplete: "off", placeholder: now && now.set ? "Set — type to replace" : "Not set" });
        else if (def.kind === "number") {
          const n = pel("input", { spellcheck: "false", autocomplete: "off", value: now ?? "" });
          input = stepper(n, { min: 0 });
          fields[def.key] = () => (n.value === "" ? null : Number(n.value));
        } else input = pel("input", { type: "text", spellcheck: "false", autocomplete: "off", value: now ?? "" });
        if (def.kind === "text" || def.kind === "secret") fields[def.key] = () => (def.kind === "secret" ? (input.value ? input.value : undefined) : input.value);
        // Enter in a field saves, as it would anywhere: a key typed and left unsaved is a key lost.
        const typed = def.kind === "number" ? input.querySelector("input") : input;
        if (typed && typed.tagName === "INPUT") typed.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); saveBtn.click(); } });
        body.append(mgRow(def.label, def.help || "", input));
      }
      const saveBtn = pel("button", { class: "t-btn", onclick: async () => {
        const values = {};
        for (const [k, get] of Object.entries(fields)) { const v = get(); if (v !== undefined) values[k] = v; }
        try { await core("PUT", `/plugins/${encodeURIComponent(r.id)}/settings`, { values }); say("Saved"); redraw(); } catch (e) { say(e.message, true); }
      } }, "Save");
      body.append(pel("div", { class: "row" }, pel("span", { class: "name" }), pel("span", { class: "what" }, saveBtn)));
    }
    const logBox = pel("div", { class: "pl-log", hidden: plLogShown.has(r.id) ? null : "" });
    if (plLogShown.has(r.id)) core("GET", `/plugins/${encodeURIComponent(r.id)}/log`).then((lines) => { logBox.textContent = lines.slice(-60).join("\n") || "Nothing logged yet."; logBox.scrollTop = logBox.scrollHeight; }, () => undefined);
    body.append(pel("div", { class: "acts", style: "margin-top:8px" },
      pel("button", { class: "t-btn", onclick: () => { if (plLogShown.has(r.id)) plLogShown.delete(r.id); else plLogShown.add(r.id); redraw(); } }, plLogShown.has(r.id) ? "Hide its log" : "Its log"),
      r.enabled ? pel("button", { class: "t-btn", onclick: async () => { try { await core("POST", `/plugins/${encodeURIComponent(r.id)}/restart`); say(`${m.name} restarted`); } catch (e) { say(e.message, true); } setTimeout(redraw, 1200); } }, "Restart") : null,
      twiceBtn("Uninstall", "Uninstall it?", async () => { try { await core("DELETE", `/plugins/${encodeURIComponent(r.id)}`); say(`${m.name} uninstalled`); } catch (e) { say(e.message, true); } redraw(); })),
      logBox, pel("p", { class: "note" }, `${[m.author, m.license].filter(Boolean).join(" · ")}${m.homepage ? ` · ${m.homepage}` : ""} · ${r.dir}`));
    block.append(body);
    return block;
  }) : [Kit.empty("None installed yet")]));
}

/**
 * What a plugin has put to the person (plugins.ts, `talaris/decide`): shown
 * whether or not the plugin is opened, each with what it is about side by
 * side and its answers as buttons; an answer goes back to the plugin.
 */
// ---------------------------------------------------------------- comparing writing

/** Two texts line by line (the longest run they share): each line kept, only here, or only there. */
function diffLines(a, b) {
  const x = a.split("\n"), y = b.split("\n");
  // Too long to compare in the page: each whole, one after the other.
  if (x.length * y.length > 4_000_000) return [...x.map((line) => ({ t: "here", line })), ...y.map((line) => ({ t: "there", line }))];
  const n = x.length, m = y.length;
  const L = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = x[i] === y[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) { out.push({ t: "same", line: x[i] }); i++; j++; }
    else if (L[i + 1][j] >= L[i][j + 1]) out.push({ t: "here", line: x[i++] });
    else out.push({ t: "there", line: y[j++] });
  }
  while (i < n) out.push({ t: "here", line: x[i++] });
  while (j < m) out.push({ t: "there", line: y[j++] });
  return out;
}

/** The two as one, to start a merge from: what they share once, and where they differ, this side's lines then the other's. */
function mergeDraft(ops) {
  const out = [];
  let here = [], there = [];
  const flush = () => { out.push(...here, ...there); here = []; there = []; };
  for (const o of ops) {
    if (o.t === "same") { flush(); out.push(o.line); } else (o.t === "here" ? here : there).push(o.line);
  }
  flush();
  return out.join("\n");
}

/** The lines, marked by where they are: in both, only on this side, only on the other. */
function diffView(ops, sides) {
  return pel("div", { class: "pl-diff" }, ...ops.map((o) => pel("div", { class: `dl ${o.t}`, title: o.t === "same" ? "In both" : `Only in ${o.t === "here" ? sides[0] : sides[1]}` },
    pel("span", { class: "dm" }, o.t === "same" ? "" : o.t === "here" ? "◀" : "▶"), pel("span", { class: "dt" }, o.line || " "))));
}

/** The merge, written: the differences above, the draft to change below; saved, it is what both sides hold. */
function mergeSheet(plugin, d, field, done) {
  const sides = d.sides || ["This side", "The other"];
  const ops = diffLines(field.here || "", field.there || "");
  const box = pel("textarea", { class: "pl-merge-text", spellcheck: "true" });
  box.value = mergeDraft(ops);
  const err = pel("p", { class: "note err" });
  const sheet = pel("div", { class: "kit-scrim" });
  const close = () => sheet.remove();
  sheet.append(pel("div", { class: "kit-sheet mg-sheet-box pl-merge" },
    pel("span", { class: "label" }, `Merge · ${d.title}`),
    pel("div", { class: "pl-legend" }, pel("span", { class: "dl here" }, `◀ only in ${sides[0]}`), pel("span", { class: "dl there" }, `▶ only in ${sides[1]}`)),
    diffView(ops, sides),
    pel("p", { class: "note", style: "margin:4px 0 2px" }, "The merged words, starting from both — what you save here is what both sides will hold."),
    box, err,
    pel("div", { class: "kit-foot" }, pel("button", { class: "t-btn", onclick: close }, "Cancel"), pel("button", { class: "t-btn primary", onclick: async (e) => {
      e.target.disabled = true;
      try { await core("POST", `/plugins/${encodeURIComponent(plugin)}/decide`, { item: d.id, choice: "merge", value: box.value }); say("Merged"); close(); done(); }
      catch (x) { err.textContent = x.message; e.target.disabled = false; }
    } }, "Save to both"))));
  document.body.append(sheet);
  box.focus();
}

function plDecisions(r, redraw) {
  // Those a plugin asks in a place of their own (Tasks…) are asked there, not here.
  const items = (r.decisions || []).filter((d) => !d.on);
  if (!items.length) return null;
  return pel("div", { class: "kit-ask-box pl-decide" },
    pel("h3", {}, `To decide · ${items.length}`),
    ...items.slice(0, 50).map((d) => {
      const [here, there] = d.sides || ["", ""];
      // Writing is shown as its lines, marked by where each is; anything else as each side's value.
      const plain = (d.fields || []).filter((f) => !f.text), texts = (d.fields || []).filter((f) => f.text);
      const table = plain.length ? pel("table", { class: "pl-fields" },
        here || there ? pel("tr", {}, pel("th", {}), pel("th", {}, here), pel("th", {}, there)) : null,
        ...plain.map((f) => pel("tr", {}, pel("td", { class: "pl-label" }, f.label), pel("td", {}, f.here ?? "—"), pel("td", {}, f.there ?? "—")))) : null;
      const diffs = texts.map((f) => pel("div", {}, pel("div", { class: "pl-legend" }, pel("span", { class: "pl-label" }, f.label),
        pel("span", { class: "dl here" }, `◀ only in ${here}`), pel("span", { class: "dl there" }, `▶ only in ${there}`)), diffView(diffLines(f.here || "", f.there || ""), [here, there])));
      const buttons = d.choices.map((c) => c.edit ? pel("button", { class: "t-btn", onclick: () => mergeSheet(r.id, d, texts[0] || { here: "", there: "" }, () => setTimeout(redraw, 600)) }, c.label) : pel("button", { class: "t-btn", onclick: async (e) => {
        for (const b of e.target.parentElement.querySelectorAll("button")) b.disabled = true;
        try { await core("POST", `/plugins/${encodeURIComponent(r.id)}/decide`, { item: d.id, choice: c.key }); say("Done"); } catch (err) { say(err.message, true); }
        setTimeout(redraw, 600);
      } }, c.label));
      return pel("div", { class: "pl-item" }, pel("div", { class: "pl-q" }, d.title), d.detail ? pel("p", { class: "note", style: "margin:2px 0 6px" }, d.detail) : null, table, ...diffs,
        pel("div", { class: "acts" }, ...buttons));
    }),
    items.length > 50 ? pel("p", { class: "note" }, `And ${items.length - 50} more, after these.`) : null);
}

async function installPlugin(from, replace = false) {
  $("plugin-msg").textContent = "Installing…";
  $("plugin-msg").className = "note";
  try {
    const m = await core("POST", "/plugins/install", { from, replace });
    $("plugin-msg").textContent = `${m.name} is installed. It is not running until you enable it.`;
    plOpen.add(m.id);
    loadPlugins();
  } catch (e) {
    // Installed already: offered as an update, in so many words.
    if (/already installed/.test(e.message) && !replace) {
      $("plugin-msg").replaceChildren(`${e.message}. `, pel("button", { class: "t-btn", onclick: () => installPlugin(from, true) }, "Replace it with this one"));
      return;
    }
    $("plugin-msg").textContent = e.message;
    $("plugin-msg").className = "note err";
  }
}
$("plugin-folder").addEventListener("click", () => bridge.choose("plugin"));
$("plugin-clone").addEventListener("click", () => { const v = $("plugin-git").value.trim(); if (v) installPlugin(v); });
