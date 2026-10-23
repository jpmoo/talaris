// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore
//
// The bar's page: readings from the process, a clock of its own, and buttons
// that ask the process to act.

"use strict";

const $ = (id) => document.getElementById(id);
let bridge = null;
let state = { popup: "" };

$("ask-ic").innerHTML = Icons.search();
$("morgan-ic").innerHTML = Icons.morgan();
$("power").innerHTML = Icons.power();

function onState(s) {
  state = s;
  document.body.dataset.edge = s.edge || "top";
  const p = s.project || {};
  $("where").innerHTML = "";
  $("where").append(p.name || "Home");
  if (p.code) {
    const code = document.createElement("span");
    code.className = "code";
    code.textContent = p.code;
    $("where").append(code);
  }
  $("morgan").classList.toggle("absent", !s.morgan);
  $("morgan").title = s.morgan ? "Ask Morgan" : "Morgan is not running";
  for (const [id, kind] of [["vol", "volume"], ["power", "power"], ["net", "network"], ["bt", "bluetooth"]]) {
    $(id).classList.toggle("on", s.popup === kind);
  }
}

function onMachine(m) {
  const net = m.network || {};
  $("net").innerHTML = net.kind === "wifi" ? Icons.wifi(net.signal) : net.kind === "ethernet" ? Icons.ethernet() : Icons.offline();
  $("net").title = net.kind === "none" ? "Offline" : `${net.name}${net.signal != null ? ` · ${net.signal}%` : ""}`;

  const bt = m.bluetooth || {};
  $("bt").hidden = !bt.present;
  if (bt.present) {
    $("bt").innerHTML = Icons.bluetooth(bt.powered);
    $("bt").title = !bt.powered ? "Bluetooth off" : bt.connected.length ? `Bluetooth: ${bt.connected.join(", ")}` : "Bluetooth on, nothing connected";
  }

  const vol = m.volume || {};
  $("vol").hidden = !vol.present;
  if (vol.present) {
    $("vol-ic").innerHTML = Icons.volume(vol.level, vol.muted);
    $("vol-n").textContent = vol.muted ? "" : vol.level;
    $("vol").title = vol.muted ? "Muted" : `Volume ${vol.level}% — scroll to change`;
  }

  const bat = m.battery || {};
  $("bat").hidden = !bat.present;
  if (bat.present) {
    const charging = bat.state === "charging" || bat.state === "full";
    $("bat-ic").innerHTML = Icons.battery(bat.level, charging);
    $("bat-n").textContent = bat.level;
    $("bat").classList.toggle("low", bat.level <= 15 && !charging);
    $("bat").title = `Battery ${bat.level}% · ${bat.state || "unknown"}`;
  }
}

// The clock keeps its own time; the process has nothing to add to it.
function tick() {
  const now = new Date();
  $("day").textContent = now.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
  $("time").textContent = now.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  setTimeout(tick, 60000 - (now.getSeconds() * 1000 + now.getMilliseconds()) + 50);
}
tick();

$("vol").addEventListener("click", () => bridge && bridge.popup("volume"));
$("vol").addEventListener("wheel", (e) => {
  if (!bridge) return;
  e.preventDefault();
  bridge.volume(e.deltaY < 0 ? "+5" : "-5");
}, { passive: false });
$("power").addEventListener("click", () => bridge && bridge.popup("power"));
$("ask").addEventListener("click", () => bridge && bridge.launcher(""));
$("morgan").addEventListener("click", () => bridge && bridge.launcher("ask"));
$("net").addEventListener("click", () => bridge && bridge.popup("network"));
$("bt").addEventListener("click", () => bridge && bridge.popup("bluetooth"));

// A press anywhere else on the bar puts an open popup away.
addEventListener("pointerdown", (e) => {
  if (!bridge || !state.popup) return;
  if (e.target.closest("#vol, #power, #net, #bt, #ask, #morgan")) return;
  bridge.file();
}, true);

Surface.connect({ onState, onMachine }).then((b) => { bridge = b; });
