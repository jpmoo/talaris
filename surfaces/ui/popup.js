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

// The menus that are sized by their content say how tall it is: the panel
// let go of the surface's bottom for a moment and measured, with the room
// round it (4 above, 26 below for its shadow).
function fit() {
  // Each panel's id is the popup's name.
  const panel = document.getElementById(document.body.dataset.popup);
  if (!panel || !bridge) return;
  const was = panel.style.bottom;
  panel.style.bottom = "auto";
  // A few pixels to spare: a fraction lost to rounding cuts a row off.
  const height = Math.ceil(panel.getBoundingClientRect().height + 30 + 4);
  panel.style.bottom = was;
  bridge.fit(height);
}
// Measured once the typeface is in — the fallback is shorter, and a menu sized
// to it was cut off — and again whenever what is in a panel changes size.
const refit = () => document.fonts.ready.then(() => requestAnimationFrame(fit));
if (window.ResizeObserver) {
  const watch = new ResizeObserver(() => refit());
  for (const id of ["power", "volume"]) { const el = document.getElementById(id); if (el) for (const child of el.children) watch.observe(child); }
}

// The projects, from the bar's project name: the current one marked, another gone to.
function drawProjects() {
  bridge.projects((text) => {
    const list = JSON.parse(text);
    $("project-list").replaceChildren(...(list.length ? list.map((p) => {
      const b = Object.assign(document.createElement("button"), { className: "menu-item" + (p.current ? " current" : "") });
      b.append(Object.assign(document.createElement("span"), { textContent: p.name }), Object.assign(document.createElement("span"), { className: "code", textContent: p.code }));
      b.addEventListener("click", () => { if (!p.current) bridge.goProject(p.id); else bridge.file(); });
      return b;
    }) : [note("No projects")]));
    refit();
  });
}

function onState(s) {
  const opening = s.popup && s.popup !== document.body.dataset.popup;
  if (opening && s.popup === "projects" && bridge) drawProjects();
  document.body.dataset.popup = s.popup || "";
  if (s.popup) refit();
  disarm();
  if (opening && (s.popup === "network" || s.popup === "bluetooth")) {
    open = { key: "", busy: "", armed: "", scanning: false };
    $(s.popup === "network" ? "nets" : "devs").replaceChildren(note("Reading…"));
    $("net-err").textContent = $("bt-err").textContent = "";
  }
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

// ---------------------------------------------------------------- Wi-Fi and Bluetooth
//
// Each panel draws the state the process last read. A press asks the process
// to act; the row says it is working until the process answers with the state
// after, and the tool's own complaint if it failed.

let open = { key: "", busy: "", armed: "", scanning: false };
let wifi = null;
let blue = null;

const LOCK = '<svg class="ic" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="4" y="7.5" width="8" height="6" rx="1"/><path d="M5.8 7.5V5.5a2.2 2.2 0 0 1 4.4 0v2"/></svg>';

function note(text, cls = "none") { return Object.assign(document.createElement("div"), { className: cls, textContent: text }); }
function button(text, onclick, cls = "t-btn") {
  const b = Object.assign(document.createElement("button"), { className: cls, textContent: text });
  b.addEventListener("click", (e) => { e.stopPropagation(); onclick(b); });
  return b;
}
function row(icon, name, meta, { current = false, busy = false, onclick } = {}) {
  const r = document.createElement("div");
  r.className = "menu-item" + (current ? " current" : "") + (busy ? " busy" : "");
  r.innerHTML = icon;
  r.append(Object.assign(document.createElement("span"), { className: "nm", textContent: name }));
  if (meta) r.append(Object.assign(document.createElement("span"), { className: "meta", innerHTML: meta }));
  if (onclick && !busy) r.addEventListener("click", onclick);
  return r;
}
/** Asked twice, like the power menu: the first press only says what the second will do. */
function twice(text, key, act) {
  return button(open.armed === key ? `${text}?` : text, (b) => {
    if (open.armed !== key) { open.armed = key; b.textContent = `${text}?`; b.classList.add("armed"); return; }
    open.armed = "";
    act();
  }, "t-btn" + (open.armed === key ? " armed" : ""));
}
function toggleOpen(key, redraw) { open.key = open.key === key ? "" : key; open.armed = ""; redraw(); }

function sendNet(request, busyKey) {
  open.busy = busyKey;
  $("net-err").textContent = "";
  bridge.network(JSON.stringify(request));
  drawWifi();
}
function sendBt(request, busyKey) {
  open.busy = busyKey;
  $("bt-err").textContent = "";
  bridge.bluetooth(JSON.stringify(request));
  drawBlue();
}

function drawWifi() {
  if (!wifi) return;
  $("wifi-on").classList.toggle("on", wifi.on);
  const list = $("nets");
  if (!wifi.on) { list.replaceChildren(note("Wi-Fi is off")); return; }
  const rows = [];
  for (const n of wifi.networks) {
    const key = `net:${n.ssid}`;
    const busy = open.busy === key;
    const meta = busy ? "WORKING" : n.connected ? "CONNECTED" : n.known ? "SAVED" : n.secure ? LOCK : "OPEN";
    rows.push(row(Icons.wifi(n.signal), n.ssid, meta, {
      current: n.connected, busy,
      onclick: () => {
        // A network you can simply join is joined; anything else opens its row.
        if (!n.connected && (n.known || !n.secure)) sendNet({ verb: "join", ssid: n.ssid, known: n.known }, key);
        else toggleOpen(key, drawWifi);
      },
    }));
    if (open.key !== key || busy) continue;
    const d = Object.assign(document.createElement("div"), { className: "detail" });
    if (n.connected) {
      d.append(button("Disconnect", () => sendNet({ verb: "leave", ssid: wifi.active || n.ssid }, key)));
    } else if (n.enterprise) {
      d.append(note("Needs a sign-in this panel cannot ask for", "none"),
        button("More settings", () => bridge.openTool("network")));
    } else {
      const pw = Object.assign(document.createElement("input"), { type: "password", placeholder: "Password" });
      const join = () => { if (pw.value) sendNet({ verb: "join", ssid: n.ssid, password: pw.value }, key); };
      pw.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.stopPropagation(); join(); } });
      d.append(pw, button("Join", join));
      setTimeout(() => pw.focus(), 0);
    }
    if (n.known) d.append(twice("Forget", `forget:${key}`, () => sendNet({ verb: "forget", ssid: n.ssid }, key)));
    rows.push(d);
  }
  list.replaceChildren(...(rows.length ? rows : [note("No networks in reach")]));
}

function drawBlue() {
  if (!blue) return;
  $("bt-on").classList.toggle("on", !!blue.on);
  $("bt-on").disabled = !blue.present;
  $("scan").disabled = !blue.on || open.scanning;
  $("scan").textContent = open.scanning ? "Looking…" : "Find devices";
  const list = $("devs");
  if (!blue.present) { list.replaceChildren(note("No Bluetooth here")); return; }
  if (!blue.on) { list.replaceChildren(note("Bluetooth is off")); return; }
  const rows = [note("My devices", "label")];
  if (!blue.paired.length) rows.push(note("None yet — Find devices to pair one"));
  for (const d of blue.paired) {
    const key = `bt:${d.mac}`;
    const busy = open.busy === key;
    const meta = busy ? "WORKING" : (d.connected ? "CONNECTED" : "") + (d.battery != null ? ` ${d.battery}%` : "");
    rows.push(row(Icons.bluetooth(d.connected), d.name, meta.trim(), {
      current: d.connected, busy, onclick: () => toggleOpen(key, drawBlue),
    }));
    if (open.key !== key || busy) continue;
    const det = Object.assign(document.createElement("div"), { className: "detail" });
    det.append(d.connected
      ? button("Disconnect", () => sendBt({ verb: "disconnect", mac: d.mac }, key))
      : button("Connect", () => sendBt({ verb: "connect", mac: d.mac }, key)),
    twice("Forget", `forget:${key}`, () => sendBt({ verb: "forget", mac: d.mac }, key)));
    rows.push(det);
  }
  if (blue.nearby.length) {
    rows.push(note("Nearby", "label"));
    for (const d of blue.nearby) {
      const key = `bt:${d.mac}`;
      rows.push(row(Icons.bluetooth(false), d.name, open.busy === key ? "PAIRING" : "PAIR", {
        busy: open.busy === key, onclick: () => sendBt({ verb: "pair", mac: d.mac }, key),
      }));
    }
  }
  list.replaceChildren(...rows);
}

function onPanel(p) {
  if (p.kind === "network") {
    wifi = p.state;
    open.busy = "";
    $("net-err").textContent = p.error || "";
    if (!p.error) open.key = "";
    drawWifi();
  } else if (p.kind === "battery") {
    drawBattery(p.state, p.error);
  } else if (p.kind === "bluetooth") {
    blue = p.state;
    open.busy = "";
    open.scanning = false;
    $("bt-err").textContent = p.error || "";
    if (!p.error) open.key = "";
    drawBlue();
  }
}

// ---------------------------------------------------------------- the battery
// What is worth knowing at a glance: the level, plugged in or not and what it
// is doing, how long, what it draws, how worn it is, how it is set to charge.
function drawBattery(b, error) {
  if (!b || !b.present) { $("bat-rows").replaceChildren(note("No battery")); refit(); return; }
  const ch = b.charging || {};
  const charging = b.state === "charging";
  const held = b.plugged && !charging;
  $("bat-state").textContent = charging ? "CHARGING" : b.plugged ? "PLUGGED IN" : "ON BATTERY";
  $("bat-level").textContent = `${b.level}%`;
  $("bat-when").textContent = charging && b.untilFull ? `full in ${b.untilFull}`
    : held ? (ch.mode === "Custom" && ch.stop && b.level >= ch.stop - 1 ? `held at the ${ch.stop}% limit` : "not charging")
    : !b.plugged && b.untilEmpty ? `${b.untilEmpty} left` : "";
  const rows = [];
  const add = (k, v) => { if (v != null && v !== "") { const d = document.createElement("div"); d.className = "kv"; d.append(Object.assign(document.createElement("span"), { textContent: k }), Object.assign(document.createElement("span"), { textContent: v })); rows.push(d); } };
  if (!b.plugged || charging) add(charging ? "Charging at" : "Drawing", b.rate ? `${b.rate} W` : "");
  add("Charging", ch.mode ? (ch.mode === "Custom" && ch.start != null ? `Custom, ${ch.start}–${ch.stop}%` : ch.mode) : "");
  add("Health", b.health != null ? `${Math.min(100, b.health)}% of new` : "");
  add("Cycles", b.cycles != null ? String(b.cycles) : "");
  if (error) add("", error);
  $("bat-rows").replaceChildren(...rows);
  // Balanced, performance, power saver — where the machine has a power mode to set.
  $("bat-profiles").replaceChildren(...(b.profiles || []).map((p) => {
    const btn = button(p.name.replace("power-saver", "Saver").replace(/^./, (c) => c.toUpperCase()), () => bridge.powerProfile(p.name));
    if (p.on) btn.classList.add("on");
    return btn;
  }));
  refit();
}
$("bat-settings").addEventListener("click", () => bridge.powerSettings());

$("wifi-on").addEventListener("click", () => wifi && sendNet({ verb: "power", on: !wifi.on }, ""));
$("bt-on").addEventListener("click", () => blue && sendBt({ verb: "power", on: !blue.on }, ""));
// ---------------------------------------------------------------- the tray
function trayEntries(items, into) {
  for (const e of items) {
    if (e.type === "separator") { into.append(Object.assign(document.createElement("div"), { className: "menu-sep" })); continue; }
    if (e.children && e.children.length) {
      into.append(Object.assign(document.createElement("div"), { className: "head", textContent: e.label }));
      const sub = Object.assign(document.createElement("div"), { className: "sub" });
      trayEntries(e.children, sub);
      into.append(sub);
      continue;
    }
    const b = Object.assign(document.createElement("button"), { className: "menu-item" });
    const mark = Object.assign(document.createElement("span"), { className: "mark" });
    if (e.toggle === "checkmark" && e.state === 1) mark.textContent = "✓";
    if (e.toggle === "radio" && e.state === 1) mark.textContent = "●";
    b.append(mark, Object.assign(document.createElement("span"), { textContent: e.label }));
    b.disabled = e.enabled === false;
    b.addEventListener("click", () => bridge.trayClick(e.id));
    into.append(b);
  }
}
// The folded tray's pane: a press here does what it does on the bar; the
// process places a menu where the pane is.
function drawTrayIcons(items) {
  $("tray-icons").replaceChildren(...items.filter((i) => !i.hidden).map((i) => {
    const b = Object.assign(document.createElement("button"), { title: i.tooltip ? `${i.title}: ${i.tooltip}` : i.title });
    if (i.status === "NeedsAttention") b.className = "attention";
    b.append(Object.assign(document.createElement("img"), { src: i.icon, alt: "" }));
    b.addEventListener("click", () => bridge.trayDo(i.id, "activate", -1));
    b.addEventListener("auxclick", (e) => { if (e.button === 1) bridge.trayDo(i.id, "secondary", -1); });
    b.addEventListener("contextmenu", (e) => { e.preventDefault(); bridge.trayDo(i.id, "menu", -1); });
    return b;
  }));
  if (document.body.dataset.popup === "trayicons") refit();
}

function drawTrayMenu(menu) {
  $("tray-title").textContent = (menu.title || "").toUpperCase();
  const list = $("tray-menu");
  list.replaceChildren();
  if (menu.error || !menu.items.length) list.append(note(menu.error ? "No menu" : "Nothing in its menu"));
  else trayEntries(menu.items, list);
  refit();
}

$("rescan").addEventListener("click", () => { $("nets").replaceChildren(note("Looking…")); bridge.panelRead("network", true); });
$("scan").addEventListener("click", () => { open.scanning = true; drawBlue(); bridge.panelRead("bluetooth", true); });
$("net-more").addEventListener("click", () => bridge.openTool("network"));
$("bt-more").addEventListener("click", () => bridge.openTool("bluetooth"));

Surface.connect({ onState, onMachine }).then((b) => {
  bridge = b;
  b.panel.connect((text) => onPanel(JSON.parse(text)));
  b.trayMenu.connect((text) => drawTrayMenu(JSON.parse(text)));
  b.tray.connect((text) => drawTrayIcons(JSON.parse(text)));
});
