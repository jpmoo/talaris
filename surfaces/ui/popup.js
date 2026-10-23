// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore
//
// The popup's page. Everything it can do goes through the bridge; nothing here
// runs a command itself.

"use strict";

const $ = (id) => document.getElementById(id);
let bridge = null;
let dragging = false;

function disarm() {
  for (const b of document.querySelectorAll(".menu-item.armed")) {
    b.classList.remove("armed");
    b.textContent = b.dataset.label;
  }
}

function onState(s) {
  document.body.dataset.popup = s.popup || "";
  disarm();
}

function onMachine(m) {
  const v = m.volume || {};
  if (!v.present) return;
  // Not while the slider is in the hand: a reading from before the drag would
  // pull it back.
  if (!dragging) $("level").value = v.level;
  $("level").style.setProperty("--fill", `${$("level").value}%`);
  $("vol-n").textContent = `${v.level}%`;
  $("vol-state").textContent = v.muted ? "MUTED" : "";
  $("mute").textContent = v.muted ? "Unmute" : "Mute";
}

/*
 * Lock and suspend lose nothing, so they act at once. Logging out, restarting
 * and shutting down end everything open, so the first press only arms the row
 * and says what the second will do.
 */
for (const b of document.querySelectorAll("#power .menu-item")) {
  b.dataset.label = b.textContent;
  b.addEventListener("click", () => {
    if (!bridge) return;
    if (b.dataset.ask && !b.classList.contains("armed")) {
      disarm();
      b.classList.add("armed");
      b.textContent = b.dataset.ask;
      return;
    }
    disarm();
    bridge.power(b.dataset.verb);
  });
}

$("level").addEventListener("pointerdown", () => { dragging = true; });
addEventListener("pointerup", () => { dragging = false; });
$("level").addEventListener("input", () => {
  $("level").style.setProperty("--fill", `${$("level").value}%`);
  if (bridge) bridge.volume(String($("level").value));
});
$("mute").addEventListener("click", () => bridge && bridge.volume("mute"));

// The ways back that live in the page: Escape, the pointer going elsewhere,
// and telling the process about input so its idle counts from the last of it.
addEventListener("keydown", (e) => { if (e.key === "Escape" && bridge) bridge.file(); });
addEventListener("blur", () => { if (bridge) bridge.file(); });
for (const type of ["pointerdown", "pointermove", "wheel", "keydown"]) {
  addEventListener(type, () => bridge && bridge.activity(), { passive: true, capture: true });
}

Surface.connect({ onState, onMachine }).then((b) => { bridge = b; });
