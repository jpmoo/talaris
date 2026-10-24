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
  const titles = app.windows.map((w) => w.title).filter(Boolean);
  b.title = titles.length ? `${app.name} — ${titles.join(" · ")}` : app.name;
  // Every window hidden: the item stays, dimmed, until shown again.
  b.classList.toggle("hidden", app.windows.length > 0 && app.windows.every((w) => w.hidden));

  const img = el("img");
  img.alt = "";
  img.draggable = false;
  img.src = `talaris-ui://icon/?n=${encodeURIComponent(app.icon)}`;
  // No icon anywhere: the application's initial, so it is still a thing to press.
  img.addEventListener("error", () => img.replaceWith(el("span", "letter", (app.name[0] || "?").toUpperCase())));
  b.append(img);

  // A dot per window, three at most; the focused one a longer bar. The focused
  // window is shown by its bar alone, not a box round the icon.
  const dots = el("span", "dots");
  app.windows.slice(0, 3).forEach((w) => dots.append(el("i", w.focused ? "on" : "")));
  b.append(dots);

  b.addEventListener("click", () => { if (!dragged && bridge) bridge.press(app.key); });
  b.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    const r = b.getBoundingClientRect();
    if (bridge) bridge.menu(app.key, Math.round(r.left + r.width / 2));
  });
  b.addEventListener("pointerdown", (e) => startDrag(e, b));
  return b;
}

function draw(next) {
  listing = next;
  const parts = listing.pinned.map((a) => item(a, true));
  if (listing.pinned.length && listing.open.length) parts.push(el("span", "rule"));
  parts.push(...listing.open.map((a) => item(a, false)));
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
    if (look.shadow) document.body.dataset.shadow = "1"; else delete document.body.dataset.shadow;
    // Out from hiding, in the dock's own motion: slide, or none.
    const motion = look.motion || "slide";
    if (s.arrived && motion === "slide" && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
      const from = (s.edge || "bottom") === "bottom" ? "translateY(110%)" : "translateY(-110%)";
      const pace = { slow: 1.6, normal: 1, fast: .6, fastest: .3 }[look.speed] || 1;
      document.getElementById("dock").animate([{ transform: from }, { transform: "none" }], { duration: Math.round(260 * pace), easing: "cubic-bezier(.2,.8,.2,1)" });
    }
  },
}).then((b) => {
  bridge = b;
  b.windows.connect((text) => draw(JSON.parse(text)));
  b.listing((text) => { try { draw(JSON.parse(text)); } catch { /* none yet */ } });
});
