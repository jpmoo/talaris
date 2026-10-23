// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore
//
// What every small surface's page does first: reach the process that holds it,
// wear the theme, and hear its state. The drawers grew their own copy of this
// before there was a second surface; the bar and its popup share this one.

"use strict";

const Surface = (() => {
  function applyTheme(theme = {}) {
    const root = document.documentElement;
    root.dataset.mode = theme.mode === "light" ? "light" : "dark";
    root.dataset.motion = theme.motion || "slide";
    if (theme.accent) {
      root.style.setProperty("--accent", theme.accent);
      const n = parseInt(theme.accent.slice(1), 16);
      root.style.setProperty("--accent-wash", `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${theme.mode === "light" ? .16 : .14})`);
    }
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
        const bridge = channel.objects.bridge;
        const state = (text) => {
          const s = JSON.parse(text);
          applyTheme(s.theme);
          if (onState) onState(s);
        };
        bridge.state.connect(state);
        if (onMachine && bridge.machine) {
          bridge.machine.connect((text) => onMachine(JSON.parse(text)));
          bridge.reading((text) => { try { onMachine(JSON.parse(text)); } catch { /* none yet */ } });
        }
        bridge.current(state);
        ok(bridge);
      });
    });
  }

  return { connect, applyTheme };
})();
