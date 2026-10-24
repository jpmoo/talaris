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
let launcherKeys = [];

// The accents of the approved theme (design/theme-tuner.html); any other by its hex.
const ACCENTS = ["#c98a5b", "#8aa878", "#7f9fbf", "#c7a55a", "#b97f8e"];
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

function say(text, error = false) { $("msg").textContent = text; $("msg").className = error ? "err" : ""; }

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
  const pick = el("button", { class: "swatch pick" + (custom ? " custom on" : ""), title: "Any color", style: custom ? `--custom:${now}` : "",
    onclick: () => { $("picker").classList.toggle("open"); if ($("picker").classList.contains("open")) picker.set(now); } });
  $("swatches").replaceChildren(...ACCENTS.map((c) => el("button", { class: "swatch" + (c === now ? " on" : ""), style: `background:${c}`, title: c,
    onclick: () => { $("picker").classList.remove("open"); saveAccent(c); } })), pick);
  if (document.activeElement !== $("hex")) $("hex").value = now;
  seg("motion", [["slide", "Slide"], ["chaos", "Draw"], ["none", "None"]], t.motion === "draw" ? "chaos" : t.motion || "slide", (motion) => save({ theme: { motion } }));
  const SPEEDS = [["slow", "Slow"], ["normal", "Normal"], ["fast", "Fast"], ["fastest", "Very fast"]];
  seg("speed", SPEEDS, t.motionSpeed || "normal", (motionSpeed) => save({ theme: { motionSpeed } }));
  const ov = cfg.overlays || {};
  for (const who of ["launcher", "new", "jump", "morgan", "settings", "calendar", "tasks", "canvas", "writing"]) {
    seg(`ov-${who}`, [["windows", "As windows"], ["drawers", "As panels"]], ov[who] || "windows", (v) => save({ overlays: { ...ov, [who]: v } }));
  }
  const p = cfg.panels;
  seg("outline", [["focus", "Accent in use"], ["line", "Line"], ["none", "None"]], p.outline, (outline) => save({ panels: { outline } }));
  $("shadow").classList.toggle("on", !!p.shadow);
  const pct = (v) => `${v}%`;
  slider("panels-op", p.opacity, pct, (v) => save({ panels: { opacity: v } }));
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

  // Layout. An edge already taken is offered greyed, not hidden: it says why it is not a choice.
  seg("bar", [["top", "Top"], ["bottom", "Bottom"]], cfg.bar.edge,
    (edge) => save({ bar: { edge }, dock: { edge: edge === "top" ? "bottom" : "top" } }));
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

  // Settings that only matter when another is on, dimmed while it is off.
  const hidesSomething = cfg.bar.autohide || (cfg.dock.enabled !== false && cfg.dock.autohide);
  needs(["bar-motion", "bar-speed"], !!cfg.bar.autohide);
  needs(["bar-m-top"], cfg.bar.shape === "floating");
  needs(["dock-hide", "dock-icon", "dock-mag", "dock-scope", "dock-outline", "dock-shadow", "dock-op"], cfg.dock.enabled !== false);
  needs(["dock-motion", "dock-speed"], cfg.dock.enabled !== false && !!cfg.dock.autohide);
  needs(["touch-thick", "touch-length"], hidesSomething);
  needs(["power-profile", "power-dim", "power-lock", "power-off", "power-suspend", "lid-ac", "lid-battery", "lid-docked"], !!pw.managed);
  needs(["power-dimto"], !!pw.managed && (pw.ac?.dim > 0 || pw.battery?.dim > 0));
  slider("touch-thick", cfg.touch.thick, (v) => `${v}px`, (v) => save({ touch: { thick: v } }));
  slider("touch-length", cfg.touch.length, (v) => (Number(v) >= 100 ? "All" : `${v}%`), (v) => save({ touch: { length: v } }));
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
  seg("launcher-keys", launcherKeys.map((k) => [k, k.replace(",", " +").replace("SUPER", "Super").replace("ALT", "Alt").replace("SPACE", "Space")]),
    cfg.launcher.keys, (keys) => save({ launcher: { keys } }));
}

$("shadow").addEventListener("click", () => save({ panels: { shadow: !cfg.panels.shadow } }));
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
    $("tray-items").replaceChildren(...(rows.length ? rows : [el("p", { class: "note" }, "No tray icons right now.")]));
    needs(["tray-items"], cfg.bar.tray !== false);
    $("tray-items").classList.toggle("needs-off", cfg.bar.tray === false);
  });
}

$("power-on").addEventListener("click", () => save({ power: { managed: !cfg.power.managed } }));
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
  else say("An accent is a color like #c98a5b", true);
});

// ---------------------------------------------------------------- Morgan
//
// Read from Morgan when the page is shown, saved to Morgan together. Which of
// them restart Morgan is Morgan's to say; the reply says so.

let morgan = null;
let voices = null;

function morganCall(op, args, done) {
  bridge.morgan(JSON.stringify({ op, args }), (text) => { let r; try { r = JSON.parse(text); } catch { r = { ok: false, error: "No answer" }; } done(r); });
}

function loadMorgan() {
  $("morgan-body").replaceChildren(el("p", { class: "note" }, "Reading…"));
  morganCall("config.get", {}, (c) => {
    if (!c.ok) { $("morgan-body").replaceChildren(el("p", { class: "note" }, c.error || "Morgan is not running")); return; }
    morgan = c;
    morganCall("voice.list", {}, (v) => { voices = v.ok ? v : null; drawMorgan(); });
  });
}

function field(label, key, value, hint = "", type = "text") {
  const input = el("input", { type, "data-key": key, spellcheck: "false" });
  input.value = value ?? "";
  return el("div", { class: "row" }, el("span", { class: "name" }, label, ...(hint ? [el("small", {}, hint)] : [])), el("span", { class: "what" }, input));
}

function drawMorgan() {
  const m = morgan;
  const body = [
    field("Name", "name", m.name, "What it answers to"),
    field("Your name", "userName", m.userName),
    field("Wake word", "wakeWord", m.wakeWord, "Empty turns it off"),
    field("Interrupt word", "interruptWord", m.interruptWord, "Said while it speaks, stops it"),
    field("Follow-up", "followUpSeconds", m.followUpSeconds, "Seconds it listens after answering", "number"),
    field("Time zone", "timeZone", m.timeZone, `Where you are, like ${Intl.DateTimeFormat().resolvedOptions().timeZone}`),
  ];
  const known = el("button", { class: "switch" + (m.knownVoicesOnly ? " on" : ""), "data-key": "knownVoicesOnly" });
  known.addEventListener("click", () => known.classList.toggle("on"));
  body.push(el("div", { class: "row" }, el("span", { class: "name" }, "Known voices only", el("small", {}, "Answer only voices it has been taught")), el("span", { class: "what" }, known)));
  if (voices) {
    const choose = el("select", { "data-key": "kokoroVoice" }, ...voices.kokoro.map((v) => {
      const o = el("option", { value: v }, v);
      if (v === voices.kokoroVoice) o.selected = true;
      return o;
    }));
    const hear = el("button", { class: "t-btn", onclick: () => morganCall("voice.preview", { engine: "kokoro", voice: choose.value }, (r) => !r.ok && say(r.error, true)) }, "Hear it");
    body.push(el("div", { class: "row" }, el("span", { class: "name" }, "Voice", el("small", {}, "Kokoro")), el("span", { class: "what" }, choose, hear)));
  }
  body.push(el("h3", {}, "Models"));
  body.push(field("Chat model", "ollama.model", (m.ollama || {}).model, "On the Ollama server"));
  body.push(field("Ollama server", "ollama.url", (m.ollama || {}).url));
  body.push(field("Oracle", "oracleModel", m.oracleModel, "Claude, when the chat model is not enough"));
  // Which Claude account it asks as: read where the Oracle runs. An older Morgan does not say.
  if (m.oracleAccount) {
    body.push(el("div", { class: "row" }, el("span", { class: "name" }, "Oracle account", el("small", {}, "Its own Claude login, where Morgan runs")),
      el("span", { class: "what" }, el("span", { class: "n", style: "width:auto" }, m.oracleAccount))));
  }
  body.push(el("div", { class: "row" }, el("span", { class: "name" }), el("span", { class: "what" },
    el("button", { class: "t-btn", onclick: saveMorgan }, "Save to Morgan"), el("span", { class: "note", style: "margin:0" }, "Some changes restart Morgan for a moment"))));
  $("morgan-body").replaceChildren(...body);
}

function saveMorgan() {
  const values = {};
  for (const input of $("morgan-body").querySelectorAll("[data-key]")) {
    const key = input.dataset.key;
    let value = input.classList.contains("switch") ? input.classList.contains("on") : input.value;
    if (key === "followUpSeconds") value = Number(value);
    const was = key.includes(".") ? key.split(".").reduce((o, k) => (o || {})[k], morgan) : key === "kokoroVoice" ? voices?.kokoroVoice : morgan[key];
    if (value !== was && !(value === "" && was == null)) values[key] = value;
  }
  if (!Object.keys(values).length) { say("Nothing changed"); return; }
  morganCall("config.set", { values }, (r) => {
    if (!r.ok) { say(r.error || "Morgan did not take it", true); return; }
    say(r.restart ? "Saved — Morgan is restarting" : "Saved");
    setTimeout(loadMorgan, r.restart ? 2500 : 0);
  });
}

// ---------------------------------------------------------------- pages and ways back

// ---------------------------------------------------------------- wallpaper
//
// What hyprpaper is set to, read from its file; a new picture comes through
// the desktop's chooser, and either change restarts hyprpaper.
function drawWallpaper(w) {
  $("wall-name").textContent = w.path ? w.path.replace(/^\/home\/[^/]+/, "~") : "None set";
  $("wall-preview").src = w.path ? `talaris-ui://wallpaper/?t=${Date.now()}` : "";
  seg("wall-fit", [["cover", "Cover"], ["contain", "Contain"], ["tile", "Tile"], ["fill", "Fill"]], w.fit || "cover",
    (fit) => bridge.fitWallpaper(fit));
  if (w.error) say(w.error, true);
  else if (w.changed) say("Wallpaper set");
}
$("wall-choose").addEventListener("click", () => bridge && bridge.chooseWallpaper());

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
const CAL_COLORS = ["#d50000", "#e67c73", "#f4511e", "#f6bf26", "#33b679", "#0b8043", "#039be5", "#3f51b5", "#7986cb", "#8e24aa", "#616161",
  "#c98a5b", "#8aa878", "#7f9fbf", "#c7a55a", "#b97f8e"];
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
      el("div", { class: "note", style: "margin:10px 0 2px;text-transform:uppercase;letter-spacing:2px;font-size:10px" }, account),
      ...list.map((c) => {
        const sw = el("button", { class: "switch" + (hidden.has(c.id) ? "" : " on"), title: "Shown in the calendar" });
        sw.addEventListener("click", () => {
          const now = new Set((cfg.calendar || {}).hidden || []);
          if (now.has(c.id)) now.delete(c.id); else now.add(c.id);
          save({ calendar: { hidden: [...now] } });
        });
        // Its color, chosen from a palette or typed: kept in Evolution, so
        // the calendar and anything else reading these calendars agree.
        const swatch = el("button", { class: "cal-swatch", title: "Its color", style: `background:${c.color || "var(--accent)"}` });
        const palette = el("div", { class: "cal-palette", hidden: "" },
          ...CAL_COLORS.map((col) => el("button", { class: "cal-swatch" + (col === c.color ? " on" : ""), style: `background:${col}`, title: col,
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
    $("acct-cals").replaceChildren(...(rows.length ? rows : [el("p", { class: "note" }, "No calendars yet.")]));
  });
}

// ---------------------------------------------------------------- Wi-Fi and Bluetooth
//
// The same readings and changes as the bar's panels (machine.py), at more
// length: every saved network, in range or not, with whether it is joined by
// itself; every device of yours, with whether it may reconnect by itself.
const bars = (s) => (s == null ? "" : s > 70 ? "Strong" : s > 45 ? "Good" : s > 20 ? "Weak" : "Faint");
let wifiNow = null, btNow = null;
// A first press on Forget asks; a second, within a few seconds, does it.
function twiceBtn(label, ask, act) {
  const b = el("button", { class: "t-btn danger" }, label);
  b.addEventListener("click", () => {
    if (b.dataset.armed) { act(); return; }
    b.dataset.armed = "1"; b.textContent = ask;
    setTimeout(() => { delete b.dataset.armed; b.textContent = label; }, 4000);
  });
  return b;
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
  if (!(w.saved || []).length) $("wifi-saved").replaceChildren(el("p", { class: "note" }, "None saved."));
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
  if (!fresh.length) $("wifi-near").replaceChildren(el("p", { class: "note" }, "Nothing new in range."));
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
  if (!(b.paired || []).length) $("bt-mine").replaceChildren(el("p", { class: "note" }, "None paired."));
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
const coreWaiting = new Map();
let coreNext = 0;
function core(method, path, body) {
  return new Promise((ok, fail) => {
    const id = String(++coreNext);
    coreWaiting.set(id, (r) => (r.status === 200 ? ok(r.data) : fail(new Error((r.data && r.data.error) || `the core answered ${r.status}`))));
    bridge.core(id, method, path, body === undefined ? "" : JSON.stringify(body));
  });
}

let vaultNow = null;
let reviving = null; // the backup chosen to revive

const when = (iso) => {
  const d = new Date(iso);
  return isNaN(d) ? "" : d.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
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

function drawData() {
  const v = vaultNow;
  if (!v) return;
  $("data-where").className = "note";
  $("data-where").textContent = "People, events, notes, tasks and projects, kept encrypted in ~/.local/share/talaris.";
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
      out.textContent = `Made ${when(p.made)}: ${p.objects} things (${kinds || "nothing"}), ${p.relations} links. Reviving replaces what is here now, which is backed up first.`;
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
      out.textContent = `Revived: ${r.counts.objects} things, ${r.counts.files} files.` + (lost.length ? ` ${lost.length} things could not come back whole: ${lost.map((f) => f.message).join("; ")}` : "");
      reviving = null;
      setTimeout(loadData, 2500);
    } catch (e) { out.textContent = e.message; out.className = "preview note err"; go.disabled = false; }
  });
  $("revive").replaceChildren(el("div", { class: "row" },
    el("span", { class: "name" }, reviving.split("/").pop()),
    el("span", { class: "what" }, key, look, go)), out);
}

function onPicked(p) {
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
const BAR_SHOWN = [["ask", "Launcher"], ["new", "New"], ["morgan", "Morgan"], ["people", "People"], ["tasks", "Tasks"], ["canvas", "Canvas"],
  ["writing", "Writing"], ["where", "Project"], ["day", "Date"], ["time", "Time"], ["theme", "Light/dark"], ["net", "Wi-Fi"], ["bt", "Bluetooth"],
  ["vol", "Volume"], ["bat", "Battery"], ["bat-n", "Battery percent"], ["power", "Power"]];
function drawBarShown() {
  const hidden = new Set(cfg.bar.hidden || []);
  $("bar-shown").replaceChildren(...BAR_SHOWN.map(([id, label]) => {
    const sw = el("button", { class: "switch" + (hidden.has(id) ? "" : " on"), title: "Shown" });
    sw.addEventListener("click", () => {
      const next = new Set(cfg.bar.hidden || []);
      if (next.has(id)) next.delete(id); else next.add(id);
      save({ bar: { hidden: [...next] } });
    });
    return el("div", { class: "row" }, el("span", { class: "name" }, label), el("span", { class: "what" }, sw));
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
  if (page === "look") bridge.wallpaper((text) => drawWallpaper(JSON.parse(text)));
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
  bridge.config((text) => { const c = JSON.parse(text); cfg = c.config; fonts = c.fonts; launcherKeys = c.launcherKeys; draw(); show(page); });
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
  b.wallpaperChanged.connect((text) => drawWallpaper({ ...JSON.parse(text), changed: true }));
  b.panel.connect((text) => onRadio(JSON.parse(text)));
  b.accountsChanged.connect(() => { if ($("accounts").classList.contains("on")) drawAccounts(); });
  b.coreReply.connect((text) => { const r = JSON.parse(text); const done = coreWaiting.get(r.id); coreWaiting.delete(r.id); if (done) done(r); });
  b.picked.connect((text) => onPicked(JSON.parse(text)));
  reload("look");
});
