// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore
//
// What every small surface's page does first: reach the process that holds it,
// wear the theme, and hear its state. The drawers grew their own copy of this
// before there was a second surface; the bar and its popup share this one.

"use strict";

// Changes from another machine (the core's sync, surfaces.py `synced`): heard by any page as `talaris:synced`, to read
// what it shows again. A page out of sight reads again too: cheap, and right when it comes back.
window.talarisSynced = () => dispatchEvent(new CustomEvent("talaris:synced"));

const Surface = (() => {
  // A press on the keyboard's button is no press off the panel. Each page puts itself away on a press outside its
  // box (Settings' window, the launcher's box, a drawer's panel), and the button — drawn over the page, in no box —
  // was one: a tap on it closed the panel it was for. Heard first, on the window as it goes down, and kept from the
  // page; and kept from `pressedAt`, the same press as Qt saw it (sensor.py, Presses), whenever the page sets it.
  const onKeyboardButton = (el) => Boolean(el && el.closest && el.closest(".kb-btn"));
  for (const type of ["pointerdown", "mousedown", "touchstart"]) {
    addEventListener(type, (e) => {
      if (!onKeyboardButton(e.target)) return;
      e.stopImmediatePropagation();
      // The field keeps its focus. Not a touch's start: kept from its default, a tap makes no click.
      if (type !== "touchstart" && e.cancelable) e.preventDefault();
    }, { capture: true, passive: false });
  }
  let pagePressedAt = window.pressedAt;
  Object.defineProperty(window, "pressedAt", {
    configurable: true,
    get: () => (pagePressedAt ? (x, y) => { if (!onKeyboardButton(document.elementFromPoint(x, y))) pagePressedAt(x, y); } : undefined),
    set: (f) => { pagePressedAt = f; },
  });

  /**
   * The accent as words (`--accent-text`): the accent, mixed toward the text until it reads at 4.5:1 on the panel
   * (WCAG) — a pale accent in light mode would otherwise be words nobody can read (UX-AUDIT 3.3). Fills and lines keep
   * --accent itself.
   */
  function accentText(root) {
    const css = getComputedStyle(root);
    const hex = (v) => { const m = String(v).trim().match(/^#([0-9a-f]{6})$/i); return m ? [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16)) : null; };
    const accent = hex(css.getPropertyValue("--accent")), text = hex(css.getPropertyValue("--text")), ground = hex(css.getPropertyValue("--surface"));
    if (!accent || !text || !ground) return;
    const lum = (c) => { const f = (x) => { x /= 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
    const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
    let mixed = accent;
    for (let t = 0; t <= 1.0001 && ratio(mixed, ground) < 4.5; t += 0.05) mixed = accent.map((c, i) => Math.round(c + (text[i] - c) * t));
    root.style.setProperty("--accent-text", `rgb(${mixed.join(",")})`);
  }

  /*
   * Light or dark. On the web, the browser's — the phone's own setting — as the sign-in page already follows it
   * (UX-AUDIT 4.6): the desktop's Mode is the laptop's choice for its screen, and a phone in light mode signed in on a
   * light page and landed in a dark one. Followed as it changes (a phone that turns dark at sunset).
   */
  const SYSTEM_LIGHT = matchMedia("(prefers-color-scheme: light)");
  let lastTheme = null;
  const modeOf = (theme) => (window.TALARIS_WEB || theme.mode === "system" ? (SYSTEM_LIGHT.matches ? "light" : "dark") : theme.mode === "light" ? "light" : "dark");
  SYSTEM_LIGHT.addEventListener("change", () => { if (lastTheme && (window.TALARIS_WEB || lastTheme.mode === "system")) applyTheme(lastTheme); });

  function applyTheme(theme = {}) {
    const root = document.documentElement;
    lastTheme = theme;
    const mode = modeOf(theme);
    root.dataset.mode = mode;
    root.dataset.motion = theme.motion || "slide";
    if (theme.accent) {
      root.style.setProperty("--accent", theme.accent);
      const n = parseInt(theme.accent.slice(1), 16);
      root.style.setProperty("--accent-wash", `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${mode === "light" ? .16 : .14})`);
    }
    accentText(root);
    // How see-through the panel is (Settings, Panels); paper and bubbles stay solid.
    root.style.setProperty("--alpha", `${theme.panelOpacity ?? 100}%`);
    if (theme.font) root.style.setProperty("--font", `'${theme.font}', system-ui, sans-serif`);
  }

  /**
   * Connect, then call `onState` with the surface's state now and on every
   * change, and `onMachine` with each reading of the machine. Resolves to the
   * bridge.
   */
  function connect({ onState, onMachine } = {}) {
    return new Promise((ok) => {
      new QWebChannel(qt.webChannelTransport, (channel) => {
        // Connected: the process may count on this page to hear presses and keys (sensor.py, Presses).
        window.talarisAlive = true;
        const bridge = channel.objects.bridge;
        const state = (text) => {
          const s = JSON.parse(text);
          applyTheme(s.theme);
          // The clock as Settings has it, for the kit's times (kit.js).
          if (window.Kit && s.clock) Kit.setClock(s.clock);
          if (onState) onState(s);
        };
        bridge.state.connect(state);
        if (onMachine && bridge.machine) {
          bridge.machine.connect((text) => onMachine(JSON.parse(text)));
          bridge.reading((text) => { try { onMachine(JSON.parse(text)); } catch { /* none yet */ } });
        }
        bridge.current(state);
        if (bridge.keyboard) keyboardButton(bridge);
        if (window.Peek && bridge.glanceAt) Peek.glanceThrough((key) => bridge.glanceAt(key));
        if (window.Peek && bridge.libraryAt) Peek.cardThrough((key) => bridge.libraryAt(key));
        ok(bridge);
      });
    });
  }

  /**
   * The on-screen keyboard, only when asked (keyboard.py): on a touchscreen, the text field with focus wears a small
   * keyboard button at its corner; a press brings the keyboard up (again: puts it away), and leaving the field
   * puts it away. Every page's, since every page connects here.
   */
  function keyboardButton(bridge) {
    if (!(navigator.maxTouchPoints > 0)) return;
    const css = document.createElement("style");
    css.textContent = `.kb-btn { position: fixed; z-index: 2147483000; width: 30px; height: 26px; display: none; align-items: center; /* look: also on pages without the tokens */
      justify-content: center; border-radius: var(--radius-control, 8px); border: 1px solid var(--line, #444); /* look: also on pages without the tokens */
      background: var(--surface, #222); color: var(--muted, #aaa); cursor: pointer; padding: 0; touch-action: none; } /* look: also on pages without the tokens */
      .kb-btn.on { color: var(--accent, #c98a5b); border-color: var(--accent, #c98a5b); } /* look: also on pages without the tokens */
      .kb-btn svg { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 1.4; }`;
    document.head.appendChild(css);
    const btn = document.createElement("button");
    btn.className = "kb-btn";
    btn.title = "Keyboard";
    btn.innerHTML = '<svg viewBox="0 0 24 24"><rect x="2.5" y="6" width="19" height="12" rx="2"/><path d="M6 10h1M9.5 10h1M13 10h1M16.5 10h1M6 13.5h1M17 13.5h1M9 13.5h6"/></svg>';
    document.body.appendChild(btn);
    let up = false, field = null;
    const editable = (el) => el && (el.isContentEditable || el.tagName === "TEXTAREA"
      || (el.tagName === "INPUT" && /^(text|search|email|url|tel|password|number|)$/.test(el.type || "")));
    const place = () => {
      if (!field || !document.contains(field)) { btn.style.display = "none"; return; }
      const r = field.getBoundingClientRect();
      btn.style.display = "flex";
      btn.style.left = `${Math.max(4, Math.min(innerWidth - 34, r.right - 34))}px`;
      btn.style.top = `${Math.max(4, Math.min(innerHeight - 30, r.bottom - (r.height > 60 ? 30 : r.height / 2 + 13)))}px`;
    };
    const set = (on) => { up = on; btn.classList.toggle("on", on); bridge.keyboard(on); };
    // The field keeps its focus, and the panel stays: a press on the button is kept from the page (above).
    btn.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); set(!up); });
    // In a tablet the keyboard comes with a field by itself (keyboard.py, `field`) — one tapped, not one given the
    // keys by a page as it opened: a press just before says which.
    // A tap on a field asks for it, focused already or not: the launcher's search, say, has the keys as it opens, so
    // a tap on it gives it nothing new and was never heard (2026-11-15).
    const taken = (on) => { if (bridge.field) bridge.field(on); };
    addEventListener("pointerdown", (e) => {
      const f = e.target && e.target.closest ? e.target.closest("input, textarea, [contenteditable=''], [contenteditable=true]") : null;
      if (f && editable(f)) taken(true);
    }, true);
    // And a field given the keys as its panel opens (the launcher's search): in a tablet, the keyboard with it.
    addEventListener("focusin", (e) => {
      if (!editable(e.target)) return;
      field = e.target; place();
      taken(true);
    }, true);
    addEventListener("focusout", () => setTimeout(() => {
      // The window losing the keys, not the field: the keyboard coming up took them a moment (the project menu's
      // search lost its keyboard as it came), which is no leaving of the field.
      if (!document.hasFocus()) return;
      if (editable(document.activeElement)) { field = document.activeElement; place(); return; }
      field = null; btn.style.display = "none";
      if (up) set(false);
      taken(false);
    }, 150), true);
    addEventListener("scroll", () => field && place(), true);
    addEventListener("resize", () => field && place());
  }

  // `keyboard(bridge)`: the button, for a page that connects by itself (Morgan's) rather than through `connect`.
  return { connect, applyTheme, keyboard: (bridge) => { if (bridge && bridge.keyboard) keyboardButton(bridge); } };
})();
