// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore
//
// Glance's page (glance_panel.py): the current project, or the thing it was
// opened on, at a glance (glanceview.js), in its panel or its window; a thing
// chosen opens where it lives.

"use strict";

// One closure: peek.js loads first into the same page.
(() => {
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

  let bridge = null;
  let surface = { up: false };
  // Loaded as a window (overlay.py), not a panel: always out, no dim, no motion.
  const WINDOW = new URLSearchParams(location.search).has("window");
  if (WINDOW) document.documentElement.dataset.window = "1";
  let startSeen = 0;      // the last "open on this thing" taken (surface.start.n)

  // Two pages may share the bridge — the panel and its window — so each numbers
  // its requests from somewhere of its own, and takes only its own answers.
  // Asked of the core as every page asks it (kit.js): one book of what waits, 2xx the answer, given up on if none comes.
  const asked = Kit.core((id, method, path, body) => !!bridge && (bridge.core(id, method, path, body), true));
  const api = (method, path, body) => asked.call(method, path, body);

  const view = GlanceView({
    api,
    // Said as every page says it (kit.js): one line, sentence case, an error in the danger color.
    say: (text, error = false) => Kit.say($("msg"), text, error, 0),
    project: () => surface.project,
    still: () => (surface.motion || {}).motion === "none",
    drawnProject: (p) => $("proj").replaceChildren(...[p.name || "", p.code ? el("span", "code", p.code) : null].filter((x) => x !== null)),
    opener: {
      card: (key) => bridge && bridge.libraryAt(key),
      goProject: (id) => bridge && bridge.goProject(id),
      openFile: (abs, sha, name) => bridge && bridge.openFile(abs, sha, name),
      openPlace: (kind, project, where) => bridge && bridge.openPlace(kind, project, where),
      openProjectFile: (project, path) => bridge && bridge.openProjectFile(project, path),
      openTask: (id) => bridge && bridge.openTask(id),
      peek: (id) => bridge && Peek.show(id, api, { openPlace: (p) => bridge.openPlace(p.kind, p.project, p.where), openTask: (t) => bridge.openTask(t),
        openEvent: (c, u, s) => bridge.openEvent(c, u, s), openPerson: (p) => bridge.openPerson(p), openUrl: (u) => bridge.openUrl(u) }),
    },
  });
  $("view-slot").replaceWith(view.view);
  $("q-slot").replaceWith(view.q, view.mine, view.steps);
  $("refresh-slot").replaceWith(view.refresh);
  $("kinds-slot").replaceWith(view.kinds);
  $("trail-slot").replaceWith(view.trail);
  document.querySelector("main").append(view.main);

  // ---------------------------------------------------------------- keys and buttons

  const typing = (t) => t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
  document.addEventListener("keydown", (e) => {
    // Peek keeps its own Escape, and says so.
    if (e.defaultPrevented) return;
    if (e.key === "Escape") { e.preventDefault(); if (bridge) bridge.file(); return; }
    if (e.key === "/" && !e.ctrlKey && !e.metaKey && !e.altKey && !typing(document.activeElement)) {
      e.preventDefault();
      view.focusFind();
    }
  });

  // A panel's one button makes it a window (the expand corners); a window's one
  // button closes it.
  $("grow").addEventListener("click", () => bridge && bridge.grow());
  $("close").addEventListener("click", () => bridge && bridge.closeWindow());
  $("grow").innerHTML = Icons.grow();
  $("grow").title = "Make it a window";
  $("grow").hidden = WINDOW;
  $("close").innerHTML = Icons.close();
  $("close").title = "Close";
  $("close").hidden = !WINDOW;
  // A press on the dim, off the panel, puts it away (and from Qt, which hears every press).
  document.addEventListener("pointerdown", (e) => { if (!WINDOW && e.target === document.documentElement && bridge && surface.up) bridge.file(); });
  window.pressedAt = (x, y) => { if (!WINDOW && bridge && surface.up && document.elementFromPoint(x, y) === document.documentElement) bridge.file(); };
  // In use: the panel's idle timer starts again.
  for (const t of ["pointerdown", "keydown", "wheel"]) addEventListener(t, () => bridge && bridge.activity(), { capture: true, passive: true });


  // ---------------------------------------------------------------- coming and going

  function how() {
    const m = surface.motion || {};
    return { kind: m.motion, speed: m.speed, edge: "top", flush: false, viewport: surface.viewport,
      shown: () => bridge && bridge.drawn(),
      rules: (rule, rel, P) => { const h = document.querySelector("header").getBoundingClientRect(); rule(rel(P.left, h.bottom), rel(P.right, h.bottom)); } };
  }
  function onState(s) {
    const was = surface;
    surface = s;
    // Opened on a thing: its glance, from wherever the walk was.
    if (s.start && s.start.n && s.start.n !== startSeen) {
      startSeen = s.start.n;
      view.startAt(s.start.key);
      if (bridge && (WINDOW || was.up)) view.load();
    }
    view.palette();
    const pid = (s.project && s.project.id) || null;
    const wasPid = (was.project && was.project.id) || null;
    if (WINDOW) {
      if (bridge && pid !== view.loadedFor()) view.load();
      view.drawProject();
      return;
    }
    if (s.up && !was.up) {
      view.fresh();
      Motion.arrive(document.body, how());
      if (bridge) view.load();
    } else if (s.up && pid !== wasPid && bridge) view.load();
  }

  Surface.connect({ onState }).then((b) => {
    bridge = b;
    b.coreReply.connect((text) => asked.reply(JSON.parse(text)));
    b.leave.connect(() => {
      // The panel's leaving; a window is not going anywhere.
      if (WINDOW) return;
      surface = { ...surface, up: false };
      if (window.Peek) Peek.close();
      const going = Motion.leave(document.body, how());
      if (going) going.onfinish = () => bridge.left(); else bridge.left();
    });
    // The state came before the bridge was ours: what it asked for, asked now.
    if (WINDOW || surface.up) view.load();
  });
})();
