// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore
//
// The bar's page: readings from the process, a clock of its own, and buttons
// that ask the process to act.

"use strict";

const $ = (id) => document.getElementById(id);
let bridge = null;
// Ctrl-click anywhere on the bar: tucked away for now, back when the pointer touches its edge (surfaces.py, tuck).
// Before anything under it hears the press.
document.addEventListener("click", (e) => {
  if (!e.ctrlKey || !bridge || !bridge.tuck) return;
  e.preventDefault();
  e.stopPropagation();
  bridge.tuck();
}, true);
let barLeaving = null; // the slide back into hiding, held until the bar is taken away
let state = { popup: "" };

// What a button shows, written only when it changes: the bar's state and the machine's readings come often, and a
// button's insides replaced between a press and its release lose that click.
function drawn(el, html) {
  if (el.dataset.drawn !== html) { el.innerHTML = html; el.dataset.drawn = html; }
}
$("ask").innerHTML = Icons.launcher();
$("settings").innerHTML = Icons.settings();
$("morgan-ic").innerHTML = Icons.morgan();
$("power").innerHTML = Icons.power();
$("bell-ic").innerHTML = Icons.bell();
$("clipboard").innerHTML = Icons.clipboard();
$("shot").innerHTML = Icons.camera();

/** What can be left off the bar (Settings, Bar). Settings itself cannot: it is the way back. */
const BAR_ITEMS = ["where", "ask", "morgan", "new", "tasks", "people", "files", "canvas", "writing", "day", "time", "weather", "loc", "theme", "net", "bt", "vol", "bat", "bat-n", "shot", "clipboard", "bell", "power", "net-n", "vol-n", "bright", "bright-n"];

function onState(s) {
  const folded = !!(state.look || {}).trayFold;
  state = s;
  // A button whose popup is out shows it, as a pressed button would.
  const out = { network: "net", bluetooth: "bt", volume: "vol", power: "power", battery: "bat", projects: "where", notifications: "bell", clipboard: "clipboard", weather: "weather" };
  for (const [kind, id] of Object.entries(out)) $(id).classList.toggle("on", s.popup === kind);
  $("clock").classList.toggle("on", !!s.calendarOpen);
  $("ask").classList.toggle("on", !!s.launcherOpen);
  $("settings").classList.toggle("on", !!s.settingsOpen);
  for (const name of ["canvas", "writing", "tasks", "new", "people", "files", "shot"]) $(name).classList.toggle("on", !!(s.panelsOpen || {})[name]);
  markTray();
  const look = s.look || {};
  if (!!look.trayFold !== folded) drawTray(trayNow);
  document.body.dataset.shape = look.shape || "strip";
  const m = look.margins || {};
  for (const side of ["top", "right", "bottom", "left"]) document.body.style.setProperty(`--m-${side}`, `${m[side] ?? 0}px`);
  document.body.style.setProperty("--alpha", `${look.opacity ?? 100}%`);
  document.body.dataset.outline = look.outline || "line";
  if (look.shadow) document.body.dataset.shadow = "1"; else delete document.body.dataset.shadow;
  document.body.style.setProperty("--room", `${s.room ?? (look.shadow ? 14 : 0)}px`);
  // Out from hiding, in the bar's own motion: slide, or none.
  // And back into hiding the same way (`leaving`: bar.py, _slide_out), held at the edge until it is taken away.
  {
    const slides = (look.motion || "slide") === "slide" && !matchMedia("(prefers-reduced-motion: reduce)").matches;
    const away = s.edge === "bottom" ? "translateY(110%)" : "translateY(-110%)";
    const timing = { duration: Math.round(260 * ({ slow: 1.6, normal: 1, fast: .6, fastest: .3 }[look.speed] || 1)), easing: getComputedStyle(document.documentElement).getPropertyValue("--ease").trim() || "ease" };
    if (barLeaving) { barLeaving.cancel(); barLeaving = null; }
    if (s.leaving && slides) barLeaving = $("bar").animate([{ transform: "none" }, { transform: away }], { ...timing, fill: "forwards" });
    else if (s.arrived && slides) $("bar").animate([{ transform: away }, { transform: "none" }], timing);
  }
  if (s.clock && JSON.stringify(s.clock) !== JSON.stringify(clock)) { clock = s.clock; tick(); }
  // Turned on its side (rotation.py): a short date and time, and no numbers beside the icons.
  if (!!s.portrait !== portrait) { portrait = !!s.portrait; document.body.classList.toggle("portrait", portrait); tick(); }
  document.body.dataset.edge = s.edge || "top";
  // The project: its name, its code, or both, as Settings, Bar says.
  const p = s.project || {};
  const shows = ((s.look || {}).project) || "both";
  // Light or dark: the button wears the mode in use, and a press changes it.
  const dark = ((s.theme || {}).mode || "dark") !== "light";
  drawn($("theme"), dark ? Icons.moon() : Icons.sun());
  $("theme").title = dark ? "Dark — switch to light" : "Light — switch to dark";
  // What Settings, Bar has left out, and the space between what is left.
  const hidden = new Set(BAR_ITEMS.filter((id) => !BarLayout.isShown(id, s.look || {})));
  // Morgan's button only where Morgan is installed (morgan.py, installed): it is a companion of its own.
  if (s.morganHere === false) hidden.add("morgan");
  for (const id of BAR_ITEMS) $(id).classList.toggle("bar-hidden", hidden.has(id));
  // Where you are (location.py): the weather after the clock, and a pin while anything else looks.
  const where = s.location || {};
  const w = where.weather;
  // The sky, the temperature, or both, as its right-click menu or Settings, Bar has it (bar.weatherShows).
  const weatherShows = (s.look || {}).weatherShows || "both";
  drawn($("weather"), w ? (weatherShows !== "temp" ? Icons.sky(w.icon, w.day) : "") + (weatherShows !== "sky" ? `<span>${w.temp}°</span>` : "") : "");
  $("weather").title = w ? `${w.sky}, ${w.temp}${w.unit}` : "";
  $("loc").hidden = !where.looking;
  if (where.looking) { drawn($("loc"), Icons.pin_place()); $("loc").title = "Something is using your location"; }
  $("clock").classList.toggle("bar-hidden", hidden.has("day") && hidden.has("time"));
  // Turning with the device (rotation.py): held where it started, or following it — a press changes which.
  const rot = s.rotation || {};
  $("rotate").hidden = !rot.on;
  if (rot.on) {
    drawn($("rotate"), rot.locked ? Icons.lock() : Icons.refresh());
    $("rotate").classList.toggle("on", !!rot.locked);
    $("rotate").title = rot.locked ? "Held in its usual position — follow the device" : "Following the device — hold in the usual position";
  }
  document.body.style.setProperty("--bar-gap", `${(s.look || {}).spacing ?? 4}px`);
  arrange((s.look || {}).order);
  requestAnimationFrame(fit);
  drawWhere(s, p, shows);
  // Morgan's button wears what Morgan is doing: listening, thinking, speaking.
  const now = s.morgan || "absent";
  $("morgan").dataset.state = now;
  $("morgan").classList.toggle("absent", now === "absent");
  $("morgan").classList.toggle("on", !!s.morganOpen);
  $("morgan").title = now === "absent" ? "Morgan is not running"
    : ({ listening: "Morgan is listening", transcribing: "Morgan is listening", thinking: "Morgan is thinking",
         consulting: "Morgan is consulting the Oracle", speaking: "Morgan is speaking" })[now] || "Morgan (Super+Shift+M)";
  for (const [id, kind] of [["vol", "volume"], ["power", "power"], ["net", "network"], ["bt", "bluetooth"], ["bell", "notifications"]]) {
    $(id).classList.toggle("on", s.popup === kind);
  }
  // The bell wears a dot while anything is unread; its tip says how many.
  const unread = s.unread || 0;
  $("bell").classList.toggle("unread", unread > 0);
  $("bell").dataset.badge = (s.look || {}).badge || "dot";
  $("bell").querySelector(".dot").textContent = (s.look || {}).badge === "count" && unread ? (unread > 9 ? "+" : String(unread)) : "";
  bellUnread = unread;
  timers = s.timers || [];
  tickBell();
}

function onMachine(m) {
  const net = m.network || {};
  drawn($("net-ic"), net.kind === "wifi" ? Icons.wifi(net.signal) : net.kind === "ethernet" ? Icons.ethernet() : Icons.offline());
  $("net-n").textContent = net.kind === "wifi" && net.signal != null ? `${net.signal}%` : "";
  $("net").title = net.kind === "none" ? "Offline" : `${net.name}${net.signal != null ? ` · ${net.signal}%` : ""}`;

  const bt = m.bluetooth || {};
  $("bt").hidden = !bt.present;
  if (bt.present) {
    drawn($("bt"), Icons.bluetooth(bt.powered));
    $("bt").title = !bt.powered ? "Bluetooth off" : bt.connected.length ? `Bluetooth: ${bt.connected.join(", ")}` : "Bluetooth on, nothing connected";
  }

  const vol = m.volume || {};
  $("vol").hidden = !vol.present;
  if (vol.present) {
    drawn($("vol-ic"), Icons.volume(vol.level, vol.muted));
    $("vol-n").textContent = vol.muted ? "" : `${vol.level}%`;
    $("vol").title = vol.muted ? "Muted" : `Volume ${vol.level}% — scroll to change`;
  }

  // The screen's brightness (machine.py): scrolled on to change it, as the volume is.
  const br = m.brightness || {};
  $("bright").hidden = !br.present;
  if (br.present) {
    drawn($("bright-ic"), Icons.brightness(br.level));
    $("bright-n").textContent = `${br.level}%`;
    $("bright").title = `Brightness ${br.level}% — scroll to change`;
  }

  const bat = m.battery || {};
  $("bat").hidden = !bat.present;
  if (bat.present) {
    const charging = bat.state === "charging";
    const plugged = !!bat.plugged || charging || bat.state === "full";
    drawn($("bat-ic"), Icons.battery(bat.level, charging, plugged));
    $("bat-n").textContent = `${bat.level}%`;
    $("bat").classList.toggle("low", bat.level <= 15 && !plugged);
    $("bat").title = `Battery ${bat.level}% · ${charging ? "charging" : plugged ? "plugged in" : "on battery"}`;
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
let portrait = false;
function tick() {
  clearTimeout(ticking);
  const now = new Date();
  // Short in portrait: 11/14 and 1:22, whatever the date's style or the seconds.
  $("day").textContent = portrait && clock.date !== "off" ? `${now.getMonth() + 1}/${now.getDate()}` : dateText(now, clock.date);
  $("time").textContent = portrait
    ? (clock.hours === "24" ? `${now.getHours()}`.padStart(2, "0") : `${now.getHours() % 12 || 12}`) + `:${String(now.getMinutes()).padStart(2, "0")}`
    : now.toLocaleTimeString("en-US", {
      hour: clock.hours === "24" ? "2-digit" : "numeric", minute: "2-digit",
      ...(clock.seconds ? { second: "2-digit" } : {}), hour12: clock.hours !== "24",
    });
  $("clock").title = now.toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" }) + " — calendar";
  const wait = clock.seconds && !portrait ? 1000 - now.getMilliseconds() : 60000 - (now.getSeconds() * 1000 + now.getMilliseconds());
  ticking = setTimeout(tick, wait + 20);
}
tick();

$("vol").addEventListener("click", () => bridge && bridge.popup("volume"));
$("vol").addEventListener("wheel", (e) => {
  if (!bridge) return;
  e.preventDefault();
  bridge.volume(e.deltaY < 0 ? "+5" : "-5");
}, { passive: false });
$("bright").addEventListener("wheel", (e) => {
  if (!bridge) return;
  e.preventDefault();
  bridge.brightness(e.deltaY < 0 ? "+5" : "-5");
}, { passive: false });
$("power").addEventListener("click", () => bridge && bridge.popup("power"));
$("bat").addEventListener("click", () => bridge && bridge.popupAt("battery", under("bat")));
// The project's pill, drawn again only when what it shows changes: the bar's state comes often (Morgan, the
// machine, a popup), and a pill emptied and refilled between a press and its release loses that click.
let whereDrawn = "";
function drawWhere(s, p, shows) {
  const key = JSON.stringify([shows, p.name, p.code, !!s.demo, s.theme, (s.look || {}).font]);
  if (key === whereDrawn) return;
  whereDrawn = key;
  $("where").innerHTML = "";
  if (shows !== "code" || !p.code) {
    // No longer than "Board of Education" in the bar's own type, measured as it is drawn, so a change of
    // typeface or size moves the limit with it; a longer name ends in an ellipsis (its tip says it whole).
    const nm = Object.assign(document.createElement("span"), { className: "nm", textContent: "Board of Education" });
    $("where").append(nm);
    nm.style.maxWidth = `${Math.ceil(nm.getBoundingClientRect().width) + 1}px`;
    nm.textContent = p.name || "Home";
  }
  if (p.code && shows !== "name") {
    const code = document.createElement("span");
    code.className = "code" + (shows === "code" ? " alone" : "");
    code.textContent = p.code;
    $("where").append(code);
  }
  // Its tip says it in full, whichever the bar shows.
  $("where").title = `${p.name || "Home"}${p.code ? ` · ${p.code}` : ""} — projects`;
  if (s.demo) {
    const badge = document.createElement("span");
    badge.className = "demo-badge";
    badge.textContent = "DEMO";
    badge.title = "The demo: made up, none of it yours (Settings, Data to leave)";
    $("where").append(badge);
  }
}
// The project's name: the projects, to switch between.
$("where").addEventListener("click", () => bridge && bridge.popupAt("projects", under("where")));
// A project gone to (bar.py, went): its name flashes, again from the start if it already was.
function flashWhere() {
  const w = $("where");
  w.classList.remove("flash");
  void w.offsetWidth;
  w.classList.add("flash");
}
$("where").addEventListener("animationend", () => $("where").classList.remove("flash"));
$("ask").addEventListener("click", () => bridge && bridge.launcher(""));
$("settings").addEventListener("click", () => bridge && bridge.settings());
$("theme").addEventListener("click", () => bridge && bridge.themeMode());
$("morgan").addEventListener("click", () => bridge && bridge.morgan());
// The canvas, the writing surface, People, Tasks and New: panels from the bar like the rest.
$("people").innerHTML = Icons.people();
$("files").innerHTML = Icons.library();
$("tasks").innerHTML = Icons.tasks();
$("new").innerHTML = Icons.plus();
$("new").addEventListener("click", () => bridge && bridge.openPanel("new"));
$("people").addEventListener("click", () => bridge && bridge.openPanel("people"));
$("files").addEventListener("click", () => bridge && bridge.openPanel("files"));
$("canvas").innerHTML = Icons.canvas();
$("writing").innerHTML = Icons.writing();
$("canvas").addEventListener("click", () => bridge && bridge.openPanel("canvas"));
$("tasks").addEventListener("click", () => bridge && bridge.openPanel("tasks"));
$("writing").addEventListener("click", () => bridge && bridge.openPanel("writing"));
// The date and time open the calendar, and it lights them while it is out.
$("clock").addEventListener("click", () => bridge && bridge.calendar());
// The weather, in the clock: its own popup (the hours, and the days), not the calendar.
$("weather").addEventListener("click", (e) => { e.stopPropagation(); if (bridge) bridge.popupAt("weather", under("weather")); });
// Wi-Fi and Bluetooth open centered under their buttons.
const under = (id) => { const r = $(id).getBoundingClientRect(); return r.left + r.width / 2; };
$("net").addEventListener("click", () => bridge && bridge.popupAt("network", under("net")));
$("bt").addEventListener("click", () => bridge && bridge.popupAt("bluetooth", under("bt")));
// Morgan's timers and reminders: while any is set, a dot pulses at the
// bell's shoulder; the tip says how many and which is next. The countdowns
// themselves are in the bell's list and Morgan's panel, where there is room
// for more than one.
let timers = [], bellUnread = 0;
function tickBell() {
  const now = Date.now();
  const live = timers.filter((t) => t.at > now).sort((a, b) => a.at - b.at);
  $("bell").classList.toggle("timing", live.length > 0);
  const next = live[0];
  const due = next ? `${live.length > 1 ? `${live.length} set, next: ` : ""}${next.text || "Timer"} at ${Kit.future(next.at)}` : "";
  $("bell").title = ["Notifications", bellUnread ? `${bellUnread} unread` : "", due].filter(Boolean).join(" · ");
}
// Every half minute is enough to put the dot out after the last one is due (Morgan's word on it comes sooner).
setInterval(() => { if (timers.length) tickBell(); }, 30000);

$("bell").addEventListener("click", () => bridge && bridge.popupAt("notifications", under("bell")));
$("clipboard").addEventListener("click", () => bridge && bridge.popupAt("clipboard", under("clipboard")));
// The screenshot panel, as Print opens it (screenshot.py).
$("shot").addEventListener("click", () => bridge && bridge.screenshot());

// The tray: running applications' icons. A press opens the application (or,
// for one that is only a menu, its menu); the middle button is its second
// action; the right one, its menu, under it.
// Folded (Settings, Bar), they are one icon that opens a pane of them under it.
let trayNow = [];
// The tray's button lit while its pane, or a menu from it, is out; an icon
// lit while its own menu is.
function markTray() {
  // A bar item's own menu (bar.py, item_menu) is shown in the tray's dropdown, as "bar:<item>": that item lit, not the tray.
  const barMenu = state.popup === "tray" && String(state.trayItem || "").startsWith("bar:");
  const own = barMenu ? state.trayItem.slice(4) : "";
  for (const b of document.querySelectorAll(".tray-item")) {
    const out = b.classList.contains("tray-fold") ? state.popup === "trayicons" || (state.popup === "tray" && !barMenu) : state.popup === "tray" && b.dataset.id === state.trayItem;
    b.classList.toggle("on", out);
  }
  for (const id of BAR_ITEMS) {
    const node = $(id);
    if (node) node.classList.toggle("menu-on", id === own);
  }
}
function drawTray(items) {
  trayNow = items;
  const shown = items.filter((i) => !i.hidden);
  if ((state.look || {}).trayFold) {
    if (!shown.length) { $("tray").replaceChildren(); return; }
    const b = document.createElement("button");
    b.className = "bar-item tray-item tray-fold" + (shown.some((i) => i.status === "NeedsAttention") ? " attention" : "");
    b.dataset.id = "";
    b.title = shown.map((i) => i.title).join(", ");
    b.innerHTML = Icons.tray();
    b.addEventListener("click", () => { const r = b.getBoundingClientRect(); if (bridge) bridge.trayPane(r.left + r.width / 2); });
    $("tray").replaceChildren(b);
    markTray();
    return;
  }
  $("tray").replaceChildren(...shown.map((i) => {
    const b = document.createElement("button");
    b.className = "bar-item tray-item" + (i.status === "NeedsAttention" ? " attention" : "");
    b.dataset.id = i.id;
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
  markTray();
}

// ---------------------------------------------------------------- the order of things on it
//
// Each region (barlayout.js) laid out as Settings keeps it, and reordered by
// dragging an item along the bar — within its region only. A press that does
// not move is the item's own (a click); one held with Ctrl is the bar's (tuck).

/** The bar's regions, laid out in the order kept: what is already in place is left alone. */
function arrange(order) {
  for (const host of document.querySelectorAll("[data-region]")) {
    if (dragging && dragging.host === host) continue;
    const want = BarLayout.ordered(host.dataset.region, order).map((id) => $(id)).filter(Boolean);
    const now = [...host.children].filter((c) => want.includes(c));
    if (now.length === want.length && now.every((c, i) => c === want[i])) continue;
    for (const node of want) host.append(node);
  }
}

let dragging = null;  // { node, host, x, moved }
addEventListener("pointerdown", (e) => {
  if (e.button !== 0 || e.ctrlKey || !bridge) return;
  const host = e.target.closest("[data-region]");
  if (!host) return;
  const node = [...host.children].find((c) => c.contains(e.target));
  if (!node || !node.id) return;
  dragging = { node, host, x: e.clientX, moved: false, pointer: e.pointerId };
});
addEventListener("pointermove", (e) => {
  const d = dragging;
  if (!d) return;
  if (!d.moved) {
    if (Math.abs(e.clientX - d.x) < 6) return;
    d.moved = true;
    d.node.classList.add("bar-dragging");
    document.body.classList.add("bar-drag-on");
    try { d.node.setPointerCapture(d.pointer); } catch { /* fine */ }
    if (state.popup) bridge.file();
  }
  // Before the first neighbour whose middle is past the pointer: the item moves there at once, as it is carried.
  const others = [...d.host.children].filter((c) => c !== d.node && c.id && !c.hidden && getComputedStyle(c).display !== "none");
  const before = others.find((c) => { const r = c.getBoundingClientRect(); return e.clientX < r.left + r.width / 2; });
  if (before) { if (d.node.nextElementSibling !== before) d.host.insertBefore(d.node, before); }
  else if (d.host.lastElementChild !== d.node) d.host.append(d.node);
});
const dropped = () => {
  const d = dragging;
  dragging = null;
  if (!d || !d.moved) return;
  d.node.classList.remove("bar-dragging");
  document.body.classList.remove("bar-drag-on");
  // The press was a drag, not the item's click.
  const swallow = (c) => { c.stopPropagation(); c.preventDefault(); };
  addEventListener("click", swallow, true);
  setTimeout(() => removeEventListener("click", swallow, true), 0);
  const ids = [...d.host.children].map((c) => c.id).filter((id) => BarLayout.regionOf(id) === d.host.dataset.region);
  bridge.barOrder(d.host.dataset.region, JSON.stringify(ids));
};
addEventListener("pointerup", dropped);
addEventListener("pointercancel", dropped);

// A right-click on something the bar may leave off: its menu, to hide it (bar.py, item_menu). The tray's icons
// have their own menus; Settings may not go.
addEventListener("contextmenu", (e) => {
  if (!bridge || e.target.closest(".tray-item, #tray, #settings")) return;
  const hit = e.target.closest("[id]");
  // A percentage is its item's: the menu is the item's, with the percentage in it.
  const part = { "net-n": "net", "vol-n": "vol", "bat-n": "bat", "bright-n": "bright" };
  const item = hit && [hit.id, hit.parentElement && hit.parentElement.id].map((id) => part[id] || id).find((id) => BAR_ITEMS.includes(id));
  // Nowhere in particular (between the items): the bar's own menu — hide it for now, autohide, its settings.
  if (!item) {
    if (e.target.closest("button, .bar-item, #where, #clock, #weather")) return;
    e.preventDefault();
    bridge.itemMenu("", e.clientX);
    return;
  }
  e.preventDefault();
  const r = $(item).getBoundingClientRect();
  bridge.itemMenu(item, r.left + r.width / 2);
});

// A press anywhere else on the bar puts an open popup away.
addEventListener("pointerdown", (e) => {
  if (!bridge || !state.popup) return;
  if (e.target.closest("#where, #vol, #power, #bell, #clipboard, #shot, #bat, #net, #bt, #ask, #new, #morgan, #people, #files, #tasks, #theme, #canvas, #writing, #settings, .tray-item")) return;
  bridge.file();
}, true);

Surface.connect({ onState, onMachine }).then((b) => {
  bridge = b;
  if (b.flash) b.flash.connect(flashWhere);
  b.tray.connect((text) => drawTray(JSON.parse(text)));
  b.trayItems((text) => drawTray(JSON.parse(text)));
});

// ---------------------------------------------------------------- too narrow
//
// A screen narrower than the bar's items (a small screen turned on its side, or
// at a large text size): the least needed go, one at a time, until the rest fit
// — the numbers beside icons first, the hubs last. Each is still a key or a
// search away in the launcher. Measured afresh whenever the bar changes or its
// surface does.
const SHED = ["bat-n", "vol-n", "bright-n", "net-n", "day", "weather", "shot", "theme", "clipboard", "bt",
  "canvas", "writing", "files", "people", "tasks", "new"];
function fit() {
  for (const id of SHED) $(id).classList.remove("bar-shed");
  const bar = $("bar");
  const over = () => bar.scrollWidth > bar.clientWidth + 1
    || [...bar.querySelectorAll(".side")].some((x) => x.scrollWidth > x.clientWidth + 1);
  for (const id of SHED) {
    if (!over()) break;
    $(id).classList.add("bar-shed");
  }
}
addEventListener("resize", () => requestAnimationFrame(fit));
$("rotate").addEventListener("click", () => bridge && bridge.rotate());

