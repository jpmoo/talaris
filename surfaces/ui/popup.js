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
    Kit.unask(b);
  }
}

// The menus that are sized by their content say how tall it is: the panel
// let go of the surface's bottom for a moment and measured, with the room
// round it (4 above, 30 below and 22 beside for its shadow).
function fit() {
  // Each panel's id is the popup's name.
  const panel = document.getElementById(document.body.dataset.popup);
  if (!panel || !bridge) return;
  const was = panel.style.bottom;
  panel.style.bottom = "auto";
  // A few pixels to spare: a fraction lost to rounding cuts a row off.
  const height = Math.ceil(panel.getBoundingClientRect().height + 34 + 4);
  panel.style.bottom = was;
  bridge.fit(height);
  // The folded tray's pane is as wide as its icons, a row of up to eight, and
  // no narrower than its heading (with the 18 either side for its shadow).
  if (panel.id === "trayicons" && bridge.fitWidth) {
    // Measured, not assumed: the buttons, the gaps, and everything round them
    // (an assumed padding left the fourth icon wrapping out of the pane).
    const icons = $("tray-icons"), first = icons.firstElementChild;
    const n = Math.max(1, icons.children.length), row = Math.min(n, TRAY_ROW);
    const px = (el, ...keys) => keys.reduce((sum, k) => sum + (parseFloat(getComputedStyle(el)[k]) || 0), 0);
    const button = first ? first.getBoundingClientRect().width : 34;
    const gap = parseFloat(getComputedStyle(icons).columnGap) || 4;
    const around = px(icons, "paddingLeft", "paddingRight") + px(panel, "paddingLeft", "paddingRight", "borderLeftWidth", "borderRightWidth");
    bridge.fitWidth(Math.ceil(Math.max(120, row * button + (row - 1) * gap + around) + 44 + 2));
  }
}
const TRAY_ROW = 8;
// Measured once the typeface is in — the fallback is shorter, and a menu sized
// to it was cut off — and again whenever what is in a panel changes size.
const refit = () => document.fonts.ready.then(() => requestAnimationFrame(fit));
if (window.ResizeObserver) {
  const watch = new ResizeObserver(() => refit());
  for (const id of ["power", "volume"]) { const el = document.getElementById(id); if (el) for (const child of el.children) watch.observe(child); }
}

// The current project at a glance (Super+Shift+G): everything in it, as a list or a graph.
document.getElementById("glance-here").addEventListener("click", () => bridge && bridge.glance());
// The archive's browser: archived projects, out of every list but this one.
document.getElementById("archive-open").addEventListener("click", () => bridge && bridge.archive());

// The projects, from the bar's project name: the current one marked, another gone to.
let projectsShown = null;
function drawProjects() {
  // Many projects scroll inside the menu rather than run off the screen: most of its height, at most.
  $("project-list").style.maxHeight = `${Math.round(screen.availHeight * 0.7)}px`;
  bridge.projects((text) => {
    const list = JSON.parse(text);
    $("project-list").replaceChildren(...(list.length ? list.flatMap((p, i) => {
      // A group's name over its projects, as Tasks groups them, a line above it (an empty one: the line alone, over the projects Tasks does not show).
      if ("group" in p) {
        const sep = Object.assign(document.createElement("div"), { className: "menu-sep" });
        if (!p.group) return [sep];
        const name = Object.assign(document.createElement("div"), { className: "hint", textContent: p.group });
        return i ? [sep, name] : [name];
      }
      const b = Object.assign(document.createElement("button"), { className: "menu-item" + (p.current ? " on" : "") + (p.inGroup ? " in-group" : "") });
      // Its desktop as last seen (thumbs.py), or its wallpaper: a project known by its look too.
      const thumb = Object.assign(document.createElement("img"), { className: "thumb", alt: "", src: `talaris-ui://thumb/?project=${encodeURIComponent(p.id)}&t=${Date.now()}` });
      b.append(thumb, Object.assign(document.createElement("span"), { className: "pname", textContent: p.name }), Object.assign(document.createElement("span"), { className: "code", textContent: p.code }));
      // Always asked of the process, the current one too: it knows which is current now, and
      // going to the current project brings its desktop back if the screen is elsewhere.
      b.addEventListener("click", () => bridge.goProject(p.id));
      return [b];
    }) : [note("No projects")]));
    refit();
  });
}

// The bell's list, newest first. Opening it reads them all, so which were
// unread is what the first fetch said; kept for as long as it stays open, so
// a redraw from `notices` does not take the rule off what was just seen.
let noticesShown = null;
let unreadSeen = new Set();
function drawNotices() {
  bridge.notifications((text) => {
    const list = JSON.parse(text);
    unreadSeen = new Set(list.filter((n) => !n.read).map((n) => n.id));
    showNotices(list);
  });
}
/** When it came, as the kit says when anything happened. */
const noticeWhen = (at) => Kit.ago(at);
/** A body's markup (the spec allows a little: <b>, <i>, <a>) as plain text; parsed inert, never run. */
function plainText(markup) {
  if (!markup) return "";
  return (new DOMParser().parseFromString(String(markup), "text/html").body.textContent || "").trim();
}
function showNotices(list) {
  for (const n of list) if (!n.read) unreadSeen.add(n.id);
  $("notice-clear").hidden = !list.length;
  $("notice-list").replaceChildren(...(list.length ? list.map((n) => {
    const d = Object.assign(document.createElement("div"), { className: "notice" + (unreadSeen.has(n.id) ? " unread" : "") });
    const top = Object.assign(document.createElement("div"), { className: "top" });
    if (n.icon) top.append(Object.assign(document.createElement("img"), { src: n.icon, alt: "" }));
    else top.insertAdjacentHTML("beforeend", Icons.bell());
    const x = button("", () => bridge.dismissNotice(n.id), "x-btn");
    x.title = "Dismiss";
    x.innerHTML = Icons.close();
    top.append(Object.assign(document.createElement("span"), { className: "app", textContent: n.app || "" }),
      Object.assign(document.createElement("span"), { className: "when", textContent: n.at ? noticeWhen(n.at) : "" }), x);
    d.append(top);
    if (n.summary) d.append(Object.assign(document.createElement("div"), { className: "sum", textContent: n.summary }));
    const body = plainText(n.body);
    if (body) d.append(Object.assign(document.createElement("div"), { className: "body", textContent: body }));
    const acts = Object.assign(document.createElement("div"), { className: "acts" });
    for (const [key, label] of n.actions || []) if (key !== "default") acts.append(button(label || key, () => bridge.actNotice(n.id, key)));
    if (n.canOpen) acts.append(button("Open", () => bridge.openNotice(n.id)));
    d.append(acts);
    return d;
  }) : [note("No notifications")]));
}
$("notice-clear").addEventListener("click", () => bridge && bridge.clearNotices());

// Morgan's timers and reminders still to come, above the notifications: what
// each is, how long is left (counted down each second while the list is out),
// and a Cancel asked twice. Asked for when the list opens and again whenever
// Morgan says one was set, changed or went off (bar.py).
let timers = [];
let timerTick = null;
function drawTimers(answer) {
  timers = answer && answer.ok ? (answer.reminders || []) : [];
  $("timers").hidden = !timers.length;
  showTimers();
  clearInterval(timerTick);
  timerTick = timers.length ? setInterval(() => {
    if (document.body.dataset.popup !== "notifications") { clearInterval(timerTick); return; }
    showTimers();
  }, 1000) : null;
}
/** Within the hour, the time left ("4:32"); further off, when — as the kit says anything to come, Morgan's panel too. */
const timeLeft = (at) => Kit.future(at);
/** How much of a timer is left, 1 to 0, within the hour; none further off. */
function share(t) {
  const now = Date.now(), made = t.made || now;
  return t.at - now < 3600000 && t.at > made ? Math.min(1, Math.max(0, (t.at - now) / (t.at - made))) : 0;
}
function showTimers() {
  $("timer-list").replaceChildren(...timers.map((t) => {
    const d = Object.assign(document.createElement("div"), { className: "timer" });
    d.insertAdjacentHTML("beforeend", t.text ? Icons.clock() : Icons.timer());
    const what = Object.assign(document.createElement("div"), { className: "what", textContent: t.text || "Timer" });
    what.append(Object.assign(document.createElement("small"), {
      textContent: Kit.clock(t.at) }));
    d.append(what, Object.assign(document.createElement("span"), { className: "left", textContent: timeLeft(t.at) }),
      twice("Cancel", `timer-${t.id}`, () => bridge.cancelReminder(t.id)));
    const bar = Object.assign(document.createElement("span"), { className: "bar track" });
    bar.append(document.createElement("i"));
    bar.style.setProperty("--left", share(t));
    bar.hidden = t.at - Date.now() >= 3600000;
    d.append(bar);
    return d;
  }));
}

// ---------------------------------------------------------------- how the machine is doing
//
// Read each second while the power menu is open (bar.py, system → sysmon.py), and the last minute drawn.
const SYS_N = 60;
const sysSeen = { cpu: [], mem: [] };
let sysTimer = 0, sysAt = 0;
const gb = (b) => `${(b / 2 ** 30).toFixed(1)} GB`;
const mb = (b) => (b >= 2 ** 30 ? gb(b) : `${Math.round(b / 2 ** 20)} MB`);
function spark(id, values) {
  const svg = $(id);
  const pts = values.map((v, i) => `${(i + SYS_N - values.length).toFixed(1)},${(20 - (v / 100) * 19.5).toFixed(2)}`);
  svg.querySelector("polyline").setAttribute("points", pts.join(" "));
  svg.querySelector("polygon").setAttribute("points", pts.length ? `${SYS_N - values.length},20 ${pts.join(" ")} ${SYS_N - 1},20` : "");
}
function drawSys(r) {
  if (!r || r.error) { $("sys-cpu-v").textContent = r && r.error ? "Can't read" : ""; return; }
  const memPct = r.mem.total ? (100 * r.mem.used) / r.mem.total : 0;
  // Closed a while: its minute starts again, rather than joining the old one across the gap.
  if (Date.now() - sysAt > 3000) { sysSeen.cpu = []; sysSeen.mem = []; }
  sysAt = Date.now();
  for (const [k, v] of [["cpu", r.cpu], ["mem", memPct]]) { sysSeen[k].push(v); if (sysSeen[k].length > SYS_N) sysSeen[k].shift(); }
  $("sys-cpu-v").textContent = `${Math.round(r.cpu)}% busy`;
  // What is in use, of all there is; how much is free, in its tip.
  $("sys-mem-v").textContent = `${gb(r.mem.used)} used of ${gb(r.mem.total)}`;
  $("sys-mem-v").title = `${gb(r.mem.total - r.mem.used)} free`;
  $("sys-swap-v").textContent = r.swap.total ? `${mb(r.swap.used)} used of ${gb(r.swap.total)}` : "None";
  // The load beside the cores it is shared among: above that, things wait.
  $("sys-load-v").textContent = `${r.load[0].toFixed(2)} · ${r.cores} cores`;
  $("sys-load-v").title = `Over 1, 5 and 15 minutes: ${r.load.join(", ")}`;
  spark("sys-cpu", sysSeen.cpu);
  spark("sys-mem", sysSeen.mem);
  const cell = (cls, text) => { const d = document.createElement("span"); d.className = cls; d.textContent = text; return d; };
  $("sys-top").replaceChildren(cell("n head", "Busiest"), cell("c head", "CPU"), cell("m head", "Memory"),
    ...r.top.flatMap((p) => [cell("n", p.name), cell("c", `${p.cpu < 10 ? p.cpu.toFixed(1) : Math.round(p.cpu)}%`), cell("m", mb(p.mem))]));
}
function sysTick() {
  if (!bridge || !bridge.system) return;
  bridge.system((text) => { try { drawSys(JSON.parse(text)); } catch { /* the next one */ } });
}
function watchSys(on) {
  if (on && !sysTimer) { sysTick(); sysTimer = setInterval(sysTick, 1000); }
  if (!on && sysTimer) { clearInterval(sysTimer); sysTimer = 0; }
}

let clipsShown = null;
function onState(s) {
  const opening = s.popup && s.popup !== document.body.dataset.popup;
  watchSys(s.popup === "power");
  // Drawn afresh each time it is shown: opened again on its own kind, it is not "opening" by kind,
  // and a list kept from before marks the project that was current then.
  if (s.popup === "projects" && bridge && s.shown !== projectsShown) { projectsShown = s.shown; drawProjects(); }
  if (s.popup === "clipboard" && bridge && s.shown !== clipsShown) { clipsShown = s.shown; document.body.dataset.popup = s.popup; Clips.open(); }
  if (s.popup === "notifications" && bridge && s.shown !== noticesShown) { noticesShown = s.shown; drawNotices(); bridge.remindersRead(); }
  document.body.dataset.popup = s.popup || "";
  if (s.popup) refit();
  // Two frames on, said: a page that is not being drawn never gets there, and the process mends it (bar.py, _check_drawn).
  if (s.popup && bridge && bridge.shownDrawn) { const shown = s.shown; requestAnimationFrame(() => requestAnimationFrame(() => bridge.shownDrawn(shown))); }
  disarm();
  if (opening && s.popup === "weather") { forecast = null; wxMode = "hours"; drawWeather(); }
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
  b.addEventListener("click", () => {
    if (!bridge) return;
    // Asked as everything is asked (kit.js): the row says what a second press will do.
    if (b.dataset.ask && !Kit.ask(b, { ask: b.dataset.ask })) return;
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

/** An empty list, said as the kit says it; with a class, a line of words in that look (a heading). */
function note(text, cls) { return cls ? Object.assign(document.createElement("div"), { className: cls, textContent: text }) : Kit.empty(text); }
function button(text, onclick, cls = "t-btn small") {
  const b = Object.assign(document.createElement("button"), { className: cls, textContent: text });
  b.addEventListener("click", (e) => { e.stopPropagation(); onclick(b); });
  return b;
}
function row(icon, name, meta, { current = false, busy = false, onclick } = {}) {
  const r = document.createElement("div");
  r.className = "menu-item" + (current ? " on" : "") + (busy ? " busy" : "");
  r.innerHTML = icon;
  r.append(Object.assign(document.createElement("span"), { className: "nm", textContent: name }));
  if (meta) r.append(Object.assign(document.createElement("span"), { className: "meta", innerHTML: meta }));
  if (onclick && !busy) r.addEventListener("click", onclick);
  return r;
}
/** Asked twice, like the power menu: the first press only says what the second will do. */
function twice(text, key, act) {
  // Asked as everything is asked (kit.js), kept by key across the list being drawn again.
  return Kit.twice(button(text, () => {}), { key, ask: `${text} it?`, act });
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
    const meta = busy ? "WORKING" : n.connected ? "CONNECTED" : n.known ? "SAVED" : n.secure ? Icons.lock() : "OPEN";
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
      d.append(note("Needs a sign-in this panel cannot ask for"),
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
  const rows = [note("My devices", "hint")];
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
    rows.push(note("Nearby", "hint"));
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
  } else if (p.kind === "weather") {
    forecast = p.state;
    drawWeather(p.error);
  } else if (p.kind === "bluetooth") {
    blue = p.state;
    open.busy = "";
    open.scanning = false;
    $("bt-err").textContent = p.error || "";
    if (!p.error) open.key = "";
    drawBlue();
  }
}

// ---------------------------------------------------------------- the weather
// Now, large; then the next 24 hours, or (the switch) the next 10 days — fetched each time it opens (location.py).
let forecast = null;
let wxMode = "hours";
function drawWeather(error) {
  const f = forecast;
  const seg = $("wx-mode");
  seg.replaceChildren(...[["hours", "Hours"], ["days", "10 days"]].map(([v, label]) => {
    const b = document.createElement("button");
    b.textContent = label;
    b.className = v === wxMode ? "on" : "";
    b.onclick = () => { wxMode = v; drawWeather(); };
    return b;
  }));
  if (!f) { $("wx-now").replaceChildren(); $("wx-rows").replaceChildren(note(error || "Reading…")); refit(); return; }
  const now = f.now;
  // Where it is for: the place chosen, or the fix's town — "near", and roughly, when the fix is only a guess.
  const place = f.place ? (f.rough ? `Near ${f.place.split(",")[0]}, roughly` : f.place.split(",").slice(0, 2).join(",")) : "";
  $("wx-place").textContent = place ? `Weather · ${place}` : "Weather";
  $("wx-place").title = f.place || "";
  $("wx-now").innerHTML = `${Icons.sky(now.icon, now.day)}<span class="t">${now.temp}${f.unit}</span>`
    + `<span class="s"><b>${now.sky}</b><span>Feels like ${now.feels}°</span></span>`;
  const row = (when, icon, sky, temp, rain) => {
    const r = document.createElement("div");
    r.className = "wx-row";
    r.innerHTML = `<span class="when">${when}</span>${icon}<span class="sky">${sky}</span><span class="temp">${temp}${rain >= 20 ? `<span class="rain">${rain}%</span>` : ""}</span>`;
    return r;
  };
  const rows = wxMode === "hours"
    ? f.hours.map((h, i) => row(i === 0 ? "Now" : Kit.minutes(Number(h.at.slice(11, 13)) * 60), Icons.sky(h.icon, h.day), h.sky, `${h.temp}°`, h.rain))
    : f.days.map((d, i) => {
      const day = new Date(`${d.at}T12:00`);
      const name = i === 0 ? "Today" : i === 1 ? "Tomorrow" : day.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
      return row(name, Icons.sky(d.icon, true), d.sky, `${d.hi}°<span class="lo">${d.lo}°</span>`, d.rain);
    });
  $("wx-rows").replaceChildren(...rows);
  refit();
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
    const btn = button(p.name.replace("power-saver", "Saver").replace(/^./, (c) => c.toUpperCase()), () => bridge.powerProfile(p.name), "");
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
      into.append(Object.assign(document.createElement("div"), { className: "hint sub", textContent: e.label }));
      const sub = Object.assign(document.createElement("div"), { className: "sub" });
      trayEntries(e.children, sub);
      into.append(sub);
      continue;
    }
    const b = Object.assign(document.createElement("button"), { className: "menu-item" });
    const mark = Object.assign(document.createElement("span"), { className: "tick" });
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
  b.notices.connect((text) => { if (document.body.dataset.popup === "notifications") showNotices(JSON.parse(text)); });
  b.clips.connect(() => { if (document.body.dataset.popup === "clipboard") Clips.read(); });
  b.reminders.connect((text) => { try { drawTimers(JSON.parse(text)); } catch { drawTimers(null); } });
});
