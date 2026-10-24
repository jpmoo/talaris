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
    bridge.config((text) => { cfg = JSON.parse(text).config; draw(); });
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
  seg("mode", [["dark", "Dark"], ["light", "Light"]], t.mode, (mode) => save({ theme: { mode } }));
  // A text size for each area; one never set follows the single size there was before.
  const sizes = [["small", "Small"], ["medium", "Medium"], ["large", "Large"]];
  for (const area of ["interface", "bar", "launcher", "morgan", "writing", "canvas"]) {
    seg(`text-${area}`, sizes, (cfg.text || {})[area] || t.fontSize || "medium", (size) => save({ text: { ...(cfg.text || {}), [area]: size } }));
  }
  // The tuner's five, then the picker for any other — wearing the custom
  // accent once one is chosen.
  const custom = !ACCENTS.includes(t.accent);
  const pick = el("button", { class: "swatch pick" + (custom ? " custom on" : ""), title: "Any color", style: custom ? `--custom:${t.accent}` : "",
    onclick: () => { $("picker").classList.toggle("open"); if ($("picker").classList.contains("open")) picker.set(t.accent); } });
  $("swatches").replaceChildren(...ACCENTS.map((c) => el("button", { class: "swatch" + (c === t.accent ? " on" : ""), style: `background:${c}`, title: c,
    onclick: () => { $("picker").classList.remove("open"); save({ theme: { accent: c } }); } })), pick);
  if (document.activeElement !== $("hex")) $("hex").value = t.accent;
  seg("motion", [["slide", "Slide"], ["chaos", "Draw"], ["none", "None"]], t.motion === "draw" ? "chaos" : t.motion || "slide", (motion) => save({ theme: { motion } }));
  const SPEEDS = [["slow", "Slow"], ["normal", "Normal"], ["fast", "Fast"], ["fastest", "Very fast"]];
  seg("speed", SPEEDS, t.motionSpeed || "normal", (motionSpeed) => save({ theme: { motionSpeed } }));
  const ov = cfg.overlays || {};
  seg("ov-motion", [["slide", "Slide"], ["chaos", "Draw"], ["none", "None"]], ov.motion || "slide", (motion) => save({ overlays: { motion } }));
  seg("ov-speed", SPEEDS, ov.speed || "normal", (speed) => save({ overlays: { speed } }));
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
  for (const name of ["canvas", "writing"]) {
    const d = cfg.drawers[name];
    const otherName = name === "canvas" ? "writing" : "canvas";
    const other = cfg.drawers[otherName].edge;
    // The other drawer's edge swaps the two; the bar's, or a dock's in use,
    // is not a drawer's to take.
    const dockEdge = cfg.dock.enabled === false ? null : cfg.dock.edge;
    // Drawers come from the sides; the top and bottom are the bar's and the dock's.
    seg(`${name}-edge`, [["left", "Left"], ["right", "Right"]], d.edge,
      (edge) => save({ drawers: edge === other ? { [name]: { edge }, [otherName]: { edge: d.edge } } : { [name]: { edge } } }),
      (edge) => edge === cfg.bar.edge || edge === dockEdge);
  }
  // Both drawers share one size and one touch-to-show; each keeps its own edge.
  const both = (change) => save({ drawers: { canvas: change, writing: change } });
  slider("drawer-size", Math.round(cfg.drawers.canvas.size * 100), (v) => `${v}%`, (v) => both({ size: v / 100 }));
  slider("drawer-height", Math.round((cfg.drawers.canvas.height ?? 1) * 100), (v) => `${v}%`, (v) => both({ height: v / 100 }));
  seg("drawer-align", [["top", "Top"], ["center", "Center"], ["bottom", "Bottom"]], cfg.drawers.canvas.align || "center", (align) => both({ align }));
  $("drawer-auto").classList.toggle("on", !!cfg.drawers.canvas.autoshow);
  $("dismiss-outside").classList.toggle("on", !!cfg.panels.dismissOutside);
  $("panels-dim").classList.toggle("on", cfg.panels.dim !== false);
  $("paper-follows").classList.toggle("on", cfg.panels.paperFollows !== false);
  seg("after-expand", [["open", "Stay open"], ["closed", "Close"]], cfg.panels.afterExpand || "open", (afterExpand) => save({ panels: { afterExpand } }));
  $("bar-hide").classList.toggle("on", !!cfg.bar.autohide);
  $("dock-hide").classList.toggle("on", !!cfg.dock.autohide);
  $("dock-on").classList.toggle("on", cfg.dock.enabled !== false);
  // Power: minutes on the page, seconds in the settings; 0 is never.
  const pw = cfg.power;
  const mins = (v) => (Number(v) === 0 ? "Never" : `${v} min`);
  $("power-on").classList.toggle("on", !!pw.managed);
  slider("power-dim", Math.round(pw.dim / 60), mins, (v) => save({ power: { dim: v * 60 } }));
  slider("power-dimto", pw.dimTo, (v) => `${v}%`, (v) => save({ power: { dimTo: v } }));
  slider("power-lock", Math.round(pw.lock / 60), mins, (v) => save({ power: { lock: v * 60 } }));
  slider("power-off", Math.round(pw.screenOff / 60), mins, (v) => save({ power: { screenOff: v * 60 } }));
  slider("power-suspend", Math.round(pw.suspend / 60), mins, (v) => save({ power: { suspend: v * 60 } }));
  for (const id of ["power-dim", "power-dimto", "power-lock", "power-off", "power-suspend"]) $(id).disabled = !pw.managed;
  if (bridge && $("power").classList.contains("on")) powerNote();

  // Settings that only matter when another is on, dimmed while it is off.
  const hidesSomething = cfg.bar.autohide || (cfg.dock.enabled !== false && cfg.dock.autohide)
    || cfg.drawers.canvas.autoshow || cfg.drawers.writing.autoshow;
  needs(["bar-motion", "bar-speed"], !!cfg.bar.autohide);
  needs(["bar-m-top"], cfg.bar.shape === "floating");
  needs(["dock-hide", "dock-mag", "dock-scope", "dock-outline", "dock-shadow", "dock-op"], cfg.dock.enabled !== false);
  needs(["dock-motion", "dock-speed"], cfg.dock.enabled !== false && !!cfg.dock.autohide);
  needs(["paper-follows"], (cfg.panels.opacity ?? 100) < 100);
  needs(["drawer-align"], (cfg.drawers.canvas.height ?? 1) < 1);
  // Dimmed, a click outside already puts a drawer away.
  needs(["dismiss-outside"], cfg.panels.dim === false);
  needs(["touch-thick", "touch-length"], hidesSomething);
  needs(["power-dim", "power-lock", "power-off", "power-suspend"], !!pw.managed);
  needs(["power-dimto"], !!pw.managed && pw.dim > 0);
  slider("touch-thick", cfg.touch.thick, (v) => `${v}px`, (v) => save({ touch: { thick: v } }));
  slider("touch-length", cfg.touch.length, (v) => (Number(v) >= 100 ? "All" : `${v}%`), (v) => save({ touch: { length: v } }));
  slider("gap", cfg.windows.gap, (v) => `${v}px`, (v) => save({ windows: { gap: v } }));
  slider("between", cfg.windows.between ?? 10, (v) => `${v}px`, (v) => save({ windows: { between: v } }));
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
$("power-on").addEventListener("click", () => save({ power: { managed: !cfg.power.managed } }));
$("paper-follows").addEventListener("click", () => save({ panels: { paperFollows: cfg.panels.paperFollows === false } }));
$("dismiss-outside").addEventListener("click", () => save({ panels: { dismissOutside: !cfg.panels.dismissOutside } }));
$("panels-dim").addEventListener("click", () => save({ panels: { dim: cfg.panels.dim === false } }));
$("drawer-auto").addEventListener("click", () => {
  const on = !cfg.drawers.canvas.autoshow;
  save({ drawers: { canvas: { autoshow: on }, writing: { autoshow: on } } });
});
// ---------------------------------------------------------------- the picker
//
// Hue, saturation and value; the page's accent follows as you drag, and the
// accent is saved when you let go.
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
    Surface.applyTheme({ ...(cfg ? cfg.theme : {}), accent: c });
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
    box.onpointerup = () => { box.onpointermove = box.onpointerup = null; save({ theme: { accent: hex() } }); };
  });
  drag($("sv"), (x, y) => { s = x; v = 1 - y; });
  drag($("hue"), (_x, y) => { h = Math.min(359, y * 360); });
  return { set };
})();

$("hex").addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  const v = $("hex").value.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(v)) save({ theme: { accent: v.toLowerCase() } });
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

// Two idle managers fight; say so, and what to take out.
function powerNote() {
  bridge.power((text) => {
    const st = JSON.parse(text);
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

function show(page) {
  for (const b of document.querySelectorAll("nav button")) b.classList.toggle("on", b.dataset.page === page);
  for (const s of document.querySelectorAll("section")) s.classList.toggle("on", s.id === page);
  say("");
  if (page === "morgan") loadMorgan();
  if (page === "power") powerNote();
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
  bridge.config((text) => { const c = JSON.parse(text); cfg = c.config; fonts = c.fonts; launcherKeys = c.launcherKeys; draw(); show(page); });
}

// Opening, or a page asked for, starts fresh; any other state — the theme
// just changed, say — leaves the page as it is.
let wasUp = false;
Surface.connect({
  onState: (s) => {
    if (bridge && s.up && (!wasUp || s.page)) reload(s.page || "look");
    wasUp = !!s.up;
  },
}).then((b) => {
  bridge = b;
  b.wallpaperChanged.connect((text) => drawWallpaper({ ...JSON.parse(text), changed: true }));
  reload("look");
});
