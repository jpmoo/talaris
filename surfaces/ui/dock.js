// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore
//
// The dock's page: draws the items the process sends — pinned, a rule, then
// open — and says what was pressed, dragged or asked for. It decides nothing.

"use strict";

let bridge = null;
let listing = { pinned: [], open: [] };

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function item(app, pinned) {
  const b = el("button", "bar-item app");
  b.dataset.key = app.key;
  b.dataset.pinned = pinned ? "1" : "";
  // A window elsewhere, where: "Mail (Home)" — only when some are here, else the project leads the tip.
  const titles = app.windows.filter((w) => w.title).map((w) => (w.project && !app.away ? `${w.title.length > 26 ? `${w.title.slice(0, 25)}…` : w.title} (${w.project})` : w.title));
  // A document says what it is and what it opens in; an application, its windows.
  if (app.doc) b.title = `${app.name} — ${app.appName || "opens by default"}${app.doc.missing ? " (not found)" : ""}`;
  else {
    // Its project first (another's), then its windows' titles, each cut short, three at most: long titles hid the project.
    const cut = (t) => (t.length > 32 ? `${t.slice(0, 31)}…` : t);
    const shown = titles.slice(0, 3).map(cut).join(" · ") + (titles.length > 3 ? ` · and ${titles.length - 3} more` : "");
    b.title = [app.name, app.away && app.awayIn && app.awayIn.length ? `in ${app.awayIn.join(", ")}` : "", shown].filter(Boolean).join(" — ");
  }
  // Another project's, said by name: where it is kept, or the desktops its windows are on.
  if (app.doc && app.away && app.awayIn && app.awayIn.length) b.title += ` — in ${app.awayIn.join(", ")}`;
  else if (app.keptIn && !app.keptHere && !app.away) b.title += " — kept in another project";
  b.classList.toggle("doc", !!app.doc);
  b.classList.toggle("missing", !!(app.doc && app.doc.missing));
  // Every window hidden: the item stays, dimmed, until shown again.
  b.classList.toggle("hidden", app.windows.length > 0 && app.windows.every((w) => w.hidden));
  // Another project's (kept there, or open only on other desktops): dimmer still, so what is here stands out.
  b.classList.toggle("away", !!app.away);

  const img = el("img");
  img.alt = "";
  img.draggable = false;
  img.src = `talaris-ui://icon/?n=${encodeURIComponent(app.icon)}`;
  // No icon anywhere: the application's initial, so it is still a thing to press.
  img.addEventListener("error", () => img.replaceWith(el("span", "letter", (app.name[0] || "?").toUpperCase())));
  b.append(img);
  // A document wears its application's icon, with its page's own at the corner — or a sheet of paper.
  if (app.doc) {
    const badge = el("span", "badge");
    if (app.doc.badge) {
      const fav = el("img");
      fav.alt = "";
      fav.draggable = false;
      fav.src = `talaris-ui://docicon/?n=${encodeURIComponent(app.doc.badge)}`;
      fav.addEventListener("error", () => { fav.remove(); badge.classList.add("sheet"); });
      badge.append(fav);
    } else badge.classList.add(app.doc.kind === "url" ? "link" : "sheet");
    b.append(badge);
  }

  // A dot per window, three at most; the focused one a longer bar. The focused
  // window is shown by its bar alone, not a box round the icon.
  const dots = el("span", "dots");
  app.windows.slice(0, 3).forEach((w) => dots.append(el("i", w.focused ? "on" : "")));
  b.append(dots);

  // Shift and Ctrl each do one of the three a press can (its menu's "When pressed…").
  b.addEventListener("click", (e) => {
    if (dragged || !bridge) return;
    const mod = e.shiftKey ? "shift" : e.ctrlKey ? "ctrl" : "";
    if (mod && bridge.pressWith) bridge.pressWith(app.key, mod);
    else bridge.press(app.key);
  });
  b.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    const r = b.getBoundingClientRect();
    if (bridge) bridge.menu(app.key, Math.round(r.left + r.width / 2));
  });
  b.addEventListener("pointerdown", (e) => startDrag(e, b));
  return b;
}

let pills = false;
function draw(next) {
  listing = next;
  // Pinned in every project, pinned in this one only, then what is open: as one dock
  // with rules between (dotted, then solid), or as a pill each (Settings, Dock, Groups).
  const everywhere = listing.pinned.filter((a) => a.pinnedWhere !== "here");
  const here = listing.pinned.filter((a) => a.pinnedWhere === "here");
  const groups = [everywhere.map((a) => item(a, true)), here.map((a) => item(a, true)), listing.open.map((a) => item(a, false))];
  if (pills) {
    const made = groups.filter((g) => g.length).map((g) => { const p = el("div", "pill"); p.append(...g); return p; });
    document.getElementById("dock").replaceChildren(...made);
    return;
  }
  const parts = [...groups[0]];
  if (groups[0].length && groups[1].length) parts.push(el("span", "rule here"));
  parts.push(...groups[1]);
  if (listing.pinned.length && listing.open.length) parts.push(el("span", "rule"));
  parts.push(...groups[2]);
  document.getElementById("dock").replaceChildren(...parts);
}

// ---------------------------------------------------------------- dragging
//
// An item held and moved along the dock trades places with the neighbor it
// passes the middle of; let go, the order is sent to be kept. Pinned items
// stay among the pinned and open ones among the open — moving one across is
// what Pin and Unpin are for.

let dragged = false;
function startDrag(e, button) {
  if (e.button !== 0) return;
  let lastX = e.clientX;
  let moving = false;
  dragged = false;
  const move = (ev) => {
    if (!moving && Math.abs(ev.clientX - e.clientX) < 6) return;
    moving = dragged = true;
    button.classList.add("dragging");
    const kin = [...document.querySelectorAll("#dock .app")].filter((b) => b.dataset.pinned === button.dataset.pinned);
    for (const other of kin) {
      if (other === button) continue;
      const r = other.getBoundingClientRect();
      const mid = r.left + r.width / 2;
      const going = ev.clientX - lastX;
      if (going > 0 && ev.clientX > mid && button.compareDocumentPosition(other) & Node.DOCUMENT_POSITION_FOLLOWING) {
        other.after(button);
      } else if (going < 0 && ev.clientX < mid && button.compareDocumentPosition(other) & Node.DOCUMENT_POSITION_PRECEDING) {
        other.before(button);
      }
    }
    lastX = ev.clientX;
  };
  const up = () => {
    removeEventListener("pointermove", move);
    removeEventListener("pointerup", up);
    button.classList.remove("dragging");
    if (moving && bridge) {
      bridge.order(JSON.stringify([...document.querySelectorAll("#dock .app")].map((b) => b.dataset.key)));
    }
    // The click that ends a drag is not a press.
    setTimeout(() => { dragged = false; }, 0);
  };
  addEventListener("pointermove", move);
  addEventListener("pointerup", up);
}

// ---------------------------------------------------------------- dropping
//
// A file or a link let go on the dock: pinned, to this project, as a document.
addEventListener("dragover", (e) => {
  const types = [...(e.dataTransfer?.types || [])];
  if (!types.includes("text/uri-list") && !types.includes("Files")) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = "link";
  document.body.classList.add("dropping");
});
addEventListener("dragleave", (e) => { if (!e.relatedTarget) document.body.classList.remove("dropping"); });
addEventListener("drop", (e) => {
  document.body.classList.remove("dropping");
  const uris = e.dataTransfer?.getData("text/uri-list") || "";
  if (!uris.trim()) return;
  e.preventDefault();
  if (bridge) bridge.dropped(uris);
});

// ---------------------------------------------------------------- magnifying
//
// Each item swells by how near the pointer is to its middle, falling off over
// about three items' width, up to the size Settings gives (100 is off). The
// items grow in place, so their neighbors make room.
let magnify = 100;
const dockEl = document.getElementById("dock");
dockEl.addEventListener("pointermove", (e) => {
  if (magnify <= 100) return;
  for (const b of dockEl.querySelectorAll(".app")) {
    const r = b.getBoundingClientRect();
    const near = Math.max(0, 1 - Math.abs(e.clientX - (r.left + r.width / 2)) / 110);
    b.style.setProperty("--s", (1 + (magnify / 100 - 1) * near * near).toFixed(3));
  }
});
dockEl.addEventListener("pointerleave", () => {
  for (const b of dockEl.querySelectorAll(".app")) b.style.removeProperty("--s");
});

Surface.connect({
  onState: (s) => {
    document.body.dataset.edge = s.edge || "bottom";
    const look = s.look || {};
    magnify = Number(look.magnify ?? 100);
    // The icons at rest, as Settings sizes them; the dock is as tall as they need.
    document.body.style.setProperty("--icon", `${Number(look.iconSize ?? 24)}px`);
    document.body.style.setProperty("--alpha", `${look.opacity ?? 100}%`);
    document.body.dataset.outline = look.outline || "line";
    const wasPills = pills;
    pills = look.groups === "pills";
    document.body.dataset.groups = pills ? "pills" : "one";
    if (pills !== wasPills && listing) draw(listing);
    if (look.shadow) document.body.dataset.shadow = "1"; else delete document.body.dataset.shadow;
    // Out from hiding, in the dock's own motion: slide, or none.
    const motion = look.motion || "slide";
    if (s.arrived && motion === "slide" && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
      const from = (s.edge || "bottom") === "bottom" ? "translateY(110%)" : "translateY(-110%)";
      const pace = { slow: 1.6, normal: 1, fast: .6, fastest: .3 }[look.speed] || 1;
      document.getElementById("dock").animate([{ transform: from }, { transform: "none" }], { duration: Math.round(260 * pace), easing: getComputedStyle(document.documentElement).getPropertyValue("--ease").trim() || "ease" });
    }
  },
}).then((b) => {
  bridge = b;
  b.windows.connect((text) => draw(JSON.parse(text)));
  b.listing((text) => { try { draw(JSON.parse(text)); } catch { /* none yet */ } });
});
