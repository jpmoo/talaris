// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore
//
// The voice popup's page. It hears every event Morgan sends, whether it is up
// or not, so the words of a turn are already here when it appears; the process
// decides when it shows.

"use strict";

const $ = (id) => document.getElementById(id);
let bridge = null;
let glyphs = {};
let name = "Morgan";
let now = "idle";
let up = false;

const BARS = 48;
let levels = new Array(BARS).fill(0);

// What each state looks like: its icon (Tabler names, as Morgan's page uses)
// and its title. Speaking is titled with Morgan's name.
const LOOK = {
  listening: { glyph: "microphone", title: "Listening" },
  transcribing: { glyph: "ear", title: "Listening" },
  thinking: { glyph: "brain", title: "Thinking" },
  consulting: { glyph: "eye", title: "Consulting the Oracle" },
  speaking: { glyph: "volume", title: "" },
  idle: { glyph: "microphone", title: "" },
};
// While Morgan works something out there is no voice to draw.
const WORKING = new Set(["thinking", "consulting", "transcribing"]);

const glyph = (n) => (glyphs[n] ? String.fromCodePoint(parseInt(glyphs[n], 16)) : "");

function head() {
  const look = LOOK[now] || LOOK.idle;
  $("glyph").textContent = glyph(look.glyph);
  $("title").textContent = look.title || name;
}

function clearTurn() {
  $("when").textContent = $("asked").textContent = $("answer").textContent = $("caption").textContent = "";
  levels = new Array(BARS).fill(0);
}

function scrollDown() { $("words").scrollTop = $("words").scrollHeight; }

function hear(text) {
  let e;
  try { e = JSON.parse(text); } catch { return; }
  switch (e.type) {
    case "state":
      if (e.name) name = e.name;
      now = e.state;
      // A new turn: the last one's words are not left up while the next is said.
      if (now === "listening") clearTurn();
      head();
      break;
    case "level":
      levels.shift();
      levels.push(e.value || 0);
      break;
    case "user":
      $("caption").textContent = "";
      $("asked").textContent = e.text || "";
      $("when").textContent = e.when || "";
      $("answer").textContent = "";
      scrollDown();
      break;
    case "sentence":
      $("answer").textContent = $("answer").textContent ? `${$("answer").textContent} ${e.text}` : e.text;
      scrollDown();
      break;
    case "look":
      $("caption").textContent = `Looking at the ${e.source}`;
      break;
    case "consult":
      $("caption").textContent = "Asking the Oracle";
      break;
    case "error":
      $("caption").textContent = e.message || "";
      break;
    case "voice":
      // Morgan heard someone but not a voice it was taught, and will not act
      // on it. Said here, or the turn just seems to have been ignored.
      if (!e.name) $("caption").textContent = "Not a voice I know — say it again, or turn off Known voices only";
      break;
    case "dismiss":
      levels = new Array(BARS).fill(0);
      break;
  }
}

// ---------------------------------------------------------------- the wave
//
// Bars of the voice's loudness, newest on the right. While Morgan works
// something out there is no voice, so a light sweeps along the bar instead —
// a moving waveform reads as sound, and there is none. Drawn only while up.

const wave = $("wave");
const ctx = wave.getContext("2d");
let started = performance.now();

function draw(t) {
  if (!up) return;
  const w = wave.clientWidth, h = wave.clientHeight, dpr = devicePixelRatio || 1;
  if (wave.width !== Math.round(w * dpr)) { wave.width = Math.round(w * dpr); wave.height = Math.round(h * dpr); }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim();
  const gap = 3, bar = (w - gap * (BARS + 1)) / BARS;
  if (WORKING.has(now)) {
    const travel = (((t - started) / 1000) * 1.15) % 2;
    const at = (BARS - 1) * (travel < 1 ? travel : 2 - travel);
    for (let i = 0; i < BARS; i++) {
      const near = Math.max(0, 1 - Math.abs(i - at) / 4);
      ctx.globalAlpha = 0.1 + 0.9 * near * near;
      roundRect(gap + i * (bar + gap), h / 2 - 3, bar, 6);
    }
  } else {
    for (let i = 0; i < BARS; i++) {
      const tall = 4 + Math.sqrt(levels[i]) * (h - 12);
      ctx.globalAlpha = 0.9;
      roundRect(gap + i * (bar + gap), (h - tall) / 2, bar, tall);
    }
  }
  ctx.globalAlpha = 1;
  requestAnimationFrame(draw);
}
function roundRect(x, y, w, h) {
  const r = Math.min(w, h) / 2;
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
  ctx.fill();
}

$("open").addEventListener("click", () => bridge && bridge.conversation());

Surface.connect({
  onState: (s) => {
    const was = up;
    up = !!s.up;
    if (up && !was) { scrollDown(); requestAnimationFrame(draw); }
  },
}).then((b) => {
  bridge = b;
  b.look((text) => {
    const look = JSON.parse(text);
    glyphs = look.glyphs || {};
    new FontFace("morgan-icons", `url("${look.font}")`).load().then((f) => { document.fonts.add(f); head(); }, () => {});
    $("kbd").textContent = glyph("message-circle");
    head();
  });
  b.event.connect(hear);
  // Morgan answers later, off the process's own thread (morgan.py, callLater).
  const waiting = new Map();
  let calls = 0;
  b.answered.connect((id, text) => { const then = waiting.get(id); waiting.delete(id); if (then) then(text); });
  b.call = (line, then) => { const id = ++calls; if (then) waiting.set(id, then); b.callLater(id, line); };
  b.call("status", (text) => { try { const s = JSON.parse(text); if (s.name) name = s.name; if (s.state) now = s.state; head(); } catch { /* not up */ } });
});
