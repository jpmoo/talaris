// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore
//
// The bar's page: readings from the process, a clock of its own, and buttons
// that ask the process to act.

"use strict";

const $ = (id) => document.getElementById(id);
let bridge = null;
let state = { popup: "" };

$("ask").innerHTML = Icons.launcher();
$("settings").innerHTML = Icons.settings();
$("morgan-ic").innerHTML = Icons.morgan();
$("power").innerHTML = Icons.power();

function onState(s) {
  const folded = !!(state.look || {}).trayFold;
  state = s;
  const look = s.look || {};
  if (!!look.trayFold !== folded) drawTray(trayNow);
  document.body.dataset.shape = look.shape || "strip";
  const m = look.margins || {};
  for (const side of ["top", "right", "bottom", "left"]) document.body.style.setProperty(`--m-${side}`, `${m[side] ?? 0}px`);
  document.body.style.setProperty("--alpha", `${look.opacity ?? 100}%`);
  document.body.dataset.outline = look.outline || "line";
  if (look.shadow) document.body.dataset.shadow = "1"; else delete document.body.dataset.shadow;
  document.body.style.setProperty("--room", look.shadow ? "14px" : "0px");
  // Out from hiding, in the bar's own motion: slide, or none.
  if (s.arrived && (look.motion || "slide") === "slide" && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
    $("bar").animate([{ transform: s.edge === "bottom" ? "translateY(110%)" : "translateY(-110%)" }, { transform: "none" }],
      { duration: Math.round(260 * ({ slow: 1.6, normal: 1, fast: .6, fastest: .3 }[look.speed] || 1)), easing: "cubic-bezier(.2,.8,.2,1)" });
  }
  if (s.clock && JSON.stringify(s.clock) !== JSON.stringify(clock)) { clock = s.clock; tick(); }
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
  // Morgan's button wears what Morgan is doing: listening, thinking, speaking.
  const now = s.morgan || "absent";
  $("morgan").dataset.state = now;
  $("morgan").classList.toggle("absent", now === "absent");
  $("morgan").classList.toggle("on", !!s.morganOpen);
  $("morgan").title = now === "absent" ? "Morgan is not running"
    : ({ listening: "Morgan is listening", transcribing: "Morgan is listening", thinking: "Morgan is thinking",
         consulting: "Morgan is consulting the Oracle", speaking: "Morgan is speaking" })[now] || "Morgan (Super+Shift+M)";
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
    $("vol-n").textContent = vol.muted ? "" : `${vol.level}%`;
    $("vol").title = vol.muted ? "Muted" : `Volume ${vol.level}% — scroll to change`;
  }

  const bat = m.battery || {};
  $("bat").hidden = !bat.present;
  if (bat.present) {
    const charging = bat.state === "charging" || bat.state === "full";
    $("bat-ic").innerHTML = Icons.battery(bat.level, charging);
    $("bat-n").textContent = `${bat.level}%`;
    $("bat").classList.toggle("low", bat.level <= 15 && !charging);
    $("bat").title = `Battery ${bat.level}% · ${bat.state || "unknown"}`;
  }
}

// The clock keeps its own time; the process has nothing to add to it.
// The clock keeps its own time, in the shape Settings gives it: 12 or 24
// hours, seconds or not, and the date in one of a few orders, or none.
let clock = { hours: "12", seconds: false, date: "weekday-month-day" };
let ticking = null;
function dateText(now, style) {
  const part = (o) => now.toLocaleDateString("en-US", o);
  const wd = part({ weekday: "short" }), mo = part({ month: "short" }), d = now.getDate();
  switch (style) {
    case "weekday-day-month": return `${wd} ${d} ${mo}`;
    case "month-day": return `${mo} ${d}`;
    case "day-month": return `${d} ${mo}`;
    case "iso": return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    case "off": return "";
    default: return `${wd}, ${mo} ${d}`;
  }
}
function tick() {
  clearTimeout(ticking);
  const now = new Date();
  $("day").textContent = dateText(now, clock.date);
  $("time").textContent = now.toLocaleTimeString("en-US", {
    hour: clock.hours === "24" ? "2-digit" : "numeric", minute: "2-digit",
    ...(clock.seconds ? { second: "2-digit" } : {}), hour12: clock.hours !== "24",
  });
  const wait = clock.seconds ? 1000 - now.getMilliseconds() : 60000 - (now.getSeconds() * 1000 + now.getMilliseconds());
  ticking = setTimeout(tick, wait + 20);
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
$("settings").addEventListener("click", () => bridge && bridge.settings());
$("morgan").addEventListener("click", () => bridge && bridge.morgan());
// Wi-Fi and Bluetooth open centered under their buttons.
const under = (id) => { const r = $(id).getBoundingClientRect(); return r.left + r.width / 2; };
$("net").addEventListener("click", () => bridge && bridge.popupAt("network", under("net")));
$("bt").addEventListener("click", () => bridge && bridge.popupAt("bluetooth", under("bt")));

// The tray: running applications' icons. A press opens the application (or,
// for one that is only a menu, its menu); the middle button is its second
// action; the right one, its menu, under it.
// Folded (Settings, Bar), they are one icon that opens a pane of them under it.
let trayNow = [];
function drawTray(items) {
  trayNow = items;
  const shown = items.filter((i) => !i.hidden);
  if ((state.look || {}).trayFold) {
    if (!shown.length) { $("tray").replaceChildren(); return; }
    const b = document.createElement("button");
    b.className = "bar-item tray-item tray-fold" + (shown.some((i) => i.status === "NeedsAttention") ? " attention" : "");
    b.title = shown.map((i) => i.title).join(", ");
    b.innerHTML = Icons.tray();
    b.addEventListener("click", () => { const r = b.getBoundingClientRect(); if (bridge) bridge.trayPane(r.left + r.width / 2); });
    $("tray").replaceChildren(b);
    return;
  }
  $("tray").replaceChildren(...shown.map((i) => {
    const b = document.createElement("button");
    b.className = "bar-item tray-item" + (i.status === "NeedsAttention" ? " attention" : "");
    b.title = i.tooltip ? `${i.title}: ${i.tooltip}` : i.title;
    const img = document.createElement("img");
    img.src = i.icon;
    img.alt = "";
    b.append(img);
    const x = () => { const r = b.getBoundingClientRect(); return r.left + r.width / 2; };
    b.addEventListener("click", () => bridge && bridge.trayDo(i.id, "activate", x()));
    b.addEventListener("auxclick", (e) => { if (e.button === 1 && bridge) bridge.trayDo(i.id, "secondary", x()); });
    b.addEventListener("contextmenu", (e) => { e.preventDefault(); if (bridge) bridge.trayDo(i.id, "menu", x()); });
    return b;
  }));
}

// A press anywhere else on the bar puts an open popup away.
addEventListener("pointerdown", (e) => {
  if (!bridge || !state.popup) return;
  if (e.target.closest("#vol, #power, #net, #bt, #ask, #morgan, #settings, .tray-item")) return;
  bridge.file();
}, true);

Surface.connect({ onState, onMachine }).then((b) => {
  bridge = b;
  b.tray.connect((text) => drawTray(JSON.parse(text)));
  b.trayItems((text) => drawTray(JSON.parse(text)));
});
