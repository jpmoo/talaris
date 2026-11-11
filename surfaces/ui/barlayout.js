// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore
//
// The bar's three regions and what is in each, in the order they come when
// nothing says otherwise — for the bar (bar.js), which lays itself out by it,
// and Settings, Bar (settings.js), where it is reordered. An item is moved
// within its region, never out of it: the weather may come before the clock,
// and neither leaves the middle.
//
// Kept in the bar's settings as `order`: {start: [ids], middle: [ids], end: [ids]}.
// An id it does not name (one new since it was saved) comes where it would by
// default, after the one it follows there.

const BarLayout = (() => {
  const REGIONS = {
    start: ["where", "ask", "morgan", "new", "tasks", "people", "files", "canvas", "writing"],
    middle: ["clock", "weather"],
    end: ["loc", "tray", "shot", "clipboard", "theme", "net", "bt", "vol", "bright", "bat", "settings", "bell", "power"],
  };

  /**
   * What is off until it is asked for: shown only when the bar's `shown` names it, whatever `hidden` says — so
   * one new since the settings were saved does not turn up uninvited. Everything else is shown unless `hidden`
   * names it.
   */
  const OPT_IN = ["bright", "net-n"];
  const isShown = (id, look) => (OPT_IN.includes(id) ? (look.shown || []).includes(id) : !(look.hidden || []).includes(id));
  /** The bar's settings with `id` shown or not: the change to save. */
  function showing(id, on, look) {
    if (OPT_IN.includes(id)) {
      const shown = new Set(look.shown || []);
      if (on) shown.add(id); else shown.delete(id);
      return { shown: [...shown] };
    }
    const hidden = new Set(look.hidden || []);
    if (on) hidden.delete(id); else hidden.add(id);
    return { hidden: [...hidden] };
  }

  /** A region's ids in the order kept, with any it does not name put where they come by default. */
  function ordered(region, order) {
    const all = REGIONS[region] || [];
    const kept = ((order || {})[region] || []).filter((id) => all.includes(id));
    const out = [...kept];
    all.forEach((id, i) => {
      if (out.includes(id)) return;
      // After the nearest one before it by default that is placed already; first if none is.
      let at = 0;
      for (let j = i - 1; j >= 0; j--) { const k = out.indexOf(all[j]); if (k >= 0) { at = k + 1; break; } }
      out.splice(at, 0, id);
    });
    return out;
  }

  /** The region an id belongs to. */
  const regionOf = (id) => Object.keys(REGIONS).find((r) => REGIONS[r].includes(id)) || null;

  return { REGIONS, ordered, regionOf, OPT_IN, isShown, showing };
})();
