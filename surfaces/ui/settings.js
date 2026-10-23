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
  $("swatches").replaceChildren(...ACCENTS.map((c) => el("button", { class: "swatch" + (c === t.accent ? " on" : ""), style: `background:${c}`, title: c,
    onclick: () => save({ theme: { accent: c } }) })));
  if (document.activeElement !== $("hex")) $("hex").value = t.accent;
  $("faces").replaceChildren(...fonts.map((f) => el("button", { class: "face" + (f === t.font ? " on" : ""), style: `font-family:'${f}'`,
    onclick: () => save({ theme: { font: f } }) }, el("b", {}, f), el("small", {}, "CANVAS · WRITING · 0123"))));

  // Layout. An edge already taken is offered greyed, not hidden: it says why it is not a choice.
  seg("bar", [["top", "Top"], ["bottom", "Bottom"]], cfg.bar.edge,
    (edge) => save({ bar: { edge }, dock: { edge: edge === "top" ? "bottom" : "top" } }));
  for (const name of ["canvas", "writing"]) {
    const d = cfg.drawers[name];
    const other = cfg.drawers[name === "canvas" ? "writing" : "canvas"].edge;
    seg(`${name}-edge`, Object.entries(EDGE_NAMES), d.edge, (edge) => save({ drawers: { [name]: { edge } } }),
      (edge) => edge === other || edge === cfg.bar.edge || edge === cfg.dock.edge);
    slider(`${name}-size`, Math.round(d.size * 100), (v) => `${v}%`, (v) => save({ drawers: { [name]: { size: v / 100 } } }));
  }
  $("canvas-out").classList.toggle("on", !!cfg.drawers.canvas.outWhenEmpty);
  slider("idle", cfg.idleSeconds, (v) => (v >= 60 ? `${Math.floor(v / 60)}m${v % 60 ? ` ${v % 60}s` : ""}` : `${v}s`), (v) => save({ idleSeconds: v }));

  // Keys.
  seg("launcher-keys", launcherKeys.map((k) => [k, k.replace(",", " +").replace("SUPER", "Super").replace("ALT", "Alt").replace("SPACE", "Space")]),
    cfg.launcher.keys, (keys) => save({ launcher: { keys } }));
}

$("canvas-out").addEventListener("click", () => save({ drawers: { canvas: { outWhenEmpty: !cfg.drawers.canvas.outWhenEmpty } } }));
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

function show(page) {
  for (const b of document.querySelectorAll("nav button")) b.classList.toggle("on", b.dataset.page === page);
  for (const s of document.querySelectorAll("section")) s.classList.toggle("on", s.id === page);
  say("");
  if (page === "morgan") loadMorgan();
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
    if (bridge && s.up && (!wasUp || s.page)) reload(s.page || "appearance");
    wasUp = !!s.up;
  },
}).then((b) => {
  bridge = b;
  reload("appearance");
});
