// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore
//
// The dock's page: draws the listing the process sends, and asks it to focus
// a window when one is pressed.

"use strict";

let bridge = null;

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function appButton(app) {
  const b = el("button", "bar-item app");
  // The focused window is shown by its dot alone, not a box round the icon.
  const titles = app.windows.map((w) => w.title).filter(Boolean);
  b.title = titles.length ? `${app.name} — ${titles.join(" · ")}` : app.name;

  const img = el("img");
  img.alt = "";
  img.draggable = false;
  img.src = `talaris-ui://icon/?n=${encodeURIComponent(app.icon)}`;
  // No icon anywhere: the application's initial, so it is still a thing to press.
  img.addEventListener("error", () => img.replaceWith(el("span", "letter", (app.name[0] || "?").toUpperCase())));
  b.append(img);

  const dots = el("span", "dots");
  app.windows.slice(0, 3).forEach((w) => dots.append(el("i", w.focused ? "on" : "")));
  b.append(dots);

  // A press goes to the window you were last in; pressed again, to its next.
  b.addEventListener("click", () => {
    if (!bridge) return;
    const at = app.windows.findIndex((w) => w.focused);
    const next = at < 0 ? app.windows[0] : app.windows[(at + 1) % app.windows.length];
    bridge.focus(next.address);
  });
  return b;
}

function draw(listing) {
  const dock = document.getElementById("dock");
  dock.replaceChildren(...(listing.groups || []).map((g) => {
    const group = el("div", "group" + (g.active ? " active" : ""));
    // No label: the separators say where one workspace ends. A project's name
    // may come back here once projects have workspaces.
    group.title = g.name;
    for (const app of g.apps) group.append(appButton(app));
    return group;
  }));
}

Surface.connect({
  onState: (s) => { document.body.dataset.edge = s.edge || "bottom"; },
}).then((b) => {
  bridge = b;
  b.windows.connect((text) => draw(JSON.parse(text)));
  b.listing((text) => { try { draw(JSON.parse(text)); } catch { /* none yet */ } });
});
