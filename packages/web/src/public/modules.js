// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore

/*
 * The modules, on every page (docs/WEB.md, What it shows): Library, Tasks, Notes, People, Canvas — a bar along the
 * bottom, the one you are in lit. On the desktop the bar and the dock do this; on the web, this does. Calendar joins
 * it once the web has calendars to show.
 */
(() => {
  const WEB = window.TALARIS_WEB || {};
  // The pages' own icons (icons.js, a `const` of the page's, so not on `window`).
  const icon = (name) => (typeof Icons !== "undefined" && typeof Icons[name] === "function" ? Icons[name]() : "");
  const ICONS = { library: "library", tasks: "tasks", notes: "writing", people: "people", canvas: "canvas", calendar: "event" };
  const nav = document.createElement("nav");
  nav.className = "web-modules";
  for (const m of WEB.modules || []) {
    const a = document.createElement("a");
    a.href = `${WEB.prefix}/${m.id}`;
    a.className = m.id === WEB.page ? "on" : "";
    a.innerHTML = `${icon(ICONS[m.id])}<span>${m.title}</span>`;
    nav.append(a);
  }
  document.body.append(nav);
  document.documentElement.classList.add("has-modules");
})();
