// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore
//
// The bar's icons, drawn here: a 16-point grid, a 1.5 stroke in the current
// color, square ends rounded. Talaris's own, so nothing about their license
// needs looking up — the canvas's come from Lucide (ISC), and these are drawn
// to sit beside them.

"use strict";

const Icons = (() => {
  const svg = (body, extra = "") =>
    `<svg class="ic" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" ${extra}>${body}</svg>`;

  // The system's icons (Wi-Fi, Bluetooth, volume) were drawn inside about ten
  // of the sixteen units, and stood smaller beside the rest; drawn larger about
  // the middle, the line kept its weight.
  const larger = (body) => `<g transform="translate(8 8) scale(1.2) translate(-8 -8)" stroke-width="1.25">${body}</g>`;

  const search = () => svg('<circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5 14 14"/>');

  // Morgan: a ring with a center — someone there, listening.
  const morgan = () => svg('<circle cx="8" cy="8" r="5.5"/><circle cx="8" cy="8" r="1.6" fill="currentColor" stroke="none"/>');

  /** Wi-Fi in four steps; the arcs past the signal are drawn faint. */
  function wifi(signal) {
    const bars = signal == null ? 3 : signal > 70 ? 3 : signal > 45 ? 2 : signal > 20 ? 1 : 0;
    const arc = (d, on) => `<path d="${d}" opacity="${on ? 1 : .3}"/>`;
    return svg(
      arc("M1.5 6.2a9.5 9.5 0 0 1 13 0", bars >= 3) +
      arc("M3.8 8.7a6.2 6.2 0 0 1 8.4 0", bars >= 2) +
      arc("M6 11.1a3 3 0 0 1 4 0", bars >= 1) +
      '<circle cx="8" cy="13.4" r=".9" fill="currentColor" stroke="none"/>');
  }
  const ethernet = () => svg('<rect x="2.5" y="5" width="11" height="7" rx="1"/><path d="M5 12v-2M8 12v-2M11 12v-2M6 5V3.5h4V5"/>');
  const offline = () => svg('<path d="M1.5 6.2a9.5 9.5 0 0 1 13 0" opacity=".3"/><path d="M3.8 8.7a6.2 6.2 0 0 1 8.4 0" opacity=".3"/><path d="M3 3l10 10"/>');

  const bluetooth = (on) => svg(larger('<path d="M4.5 5 11 10.5 8 13V3l3 2.5L4.5 11"/>'), on ? "" : 'opacity=".45"');

  function volume(level, muted) {
    const body = '<path d="M2.5 6h2.5l3.5-3v10L5 10H2.5z"/>';
    if (muted) return svg(larger(body + '<path d="M11 6l3.5 4M14.5 6 11 10"/>'));
    const waves = (level > 0 ? '<path d="M10.8 6.2a2.6 2.6 0 0 1 0 3.6"/>' : "") +
      (level > 50 ? '<path d="M12.6 4.4a5.2 5.2 0 0 1 0 7.2"/>' : "");
    return svg(larger(body + waves));
  }

  /** A cell filled to its level; a bolt when it is charging. */
  /** The battery: its level, a bolt while charging, a plug while plugged in and held (at a charge limit). */
  /*
   * The battery. Every edge sits where the other icons' edges do on the
   * screen's pixels: here a unit of the drawing is 1⅓ of the screen's pixels,
   * so an edge lands whole every ¾ of a unit (the canvas's, at 2 and 14, both
   * do). Drawn off that grid, its bottom edge fell between two rows and
   * looked fainter than its top.
   */
  function battery(level, charging, plugged = false) {
    const w = Math.round(Math.max(0, Math.min(1, level / 100)) * 12) * 0.75; // in steps of ¾, up to 9
    const mark = charging ? '<path d="M8.3 5.3 6.5 8.2h2.6L7.4 10.8" stroke-width="1.3"/>'
      : plugged ? '<path d="M6.6 6v1.3M8.4 6v1.3M6 7.3h3v1.2a1.5 1.5 0 0 1-3 0zM7.5 10v1" stroke-width="1.1"/>' : "";
    return svg(
      '<rect x="1.25" y="3.5" width="12" height="9" rx="2"/><path d="M14.75 6.5v3"/>' +
      (w > 0 ? `<rect x="2.75" y="5" width="${w}" height="6" rx=".75" fill="currentColor" stroke="none" opacity="${charging || plugged ? .35 : .8}"/>` : "") +
      mark);
  }

  function mic(muted) {
    return svg('<rect x="6" y="1.8" width="4" height="7.6" rx="2"/><path d="M3.5 7.8a4.5 4.5 0 0 0 9 0M8 12.3V14.5"/>' +
      (muted ? '<path d="M2.5 2.5 13.5 13.5"/>' : ""));
  }

  // Dark mode: a crescent.
  const moon = () => svg('<path d="M13 9.6A5.5 5.5 0 1 1 6.4 3a4.4 4.4 0 0 0 6.6 6.6z"/>');
  const sun = () => svg('<circle cx="8" cy="8" r="2.8"/><path d="M8 1.5v1.6M8 12.9v1.6M1.5 8h1.6M12.9 8h1.6M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M3.4 12.6l1.1-1.1M11.5 4.5l1.1-1.1"/>');
  // The sky, for the weather by the clock: one shape each, day or night where it differs.
  const CLOUD = "M4.6 12.5h7a2.6 2.6 0 0 0 .2-5.2 3.8 3.8 0 0 0-7.3-.4A2.8 2.8 0 0 0 4.6 12.5z";
  const sky = (kind, day = true) => {
    const cloudAt = (d) => `<path d="${CLOUD}" transform="${d}"/>`;
    switch (kind) {
      case "clear": return day ? sun() : moon();
      case "partly": return svg((day ? '<circle cx="5.5" cy="5.5" r="2"/><path d="M5.5 1.6v.9M1.6 5.5h.9M2.7 2.7l.6.6M8.3 2.7l-.6.6"/>'
        : '<path d="M7.6 5.6A3 3 0 1 1 4 2a2.4 2.4 0 0 0 3.6 3.6z"/>') + cloudAt("translate(1.4 1.6) scale(.85)"));
      case "fog": return svg('<path d="M2.5 6h11M3.5 9h9M2.5 12h11"/>');
      case "rain": return svg(cloudAt("translate(0 -2)") + '<path d="M5.5 12.5l-.7 1.8M8.3 12.5l-.7 1.8M11.1 12.5l-.7 1.8"/>');
      case "snow": return svg(cloudAt("translate(0 -2)") + '<path d="M5.5 13.2h.01M8.2 14.2h.01M10.9 13.2h.01" stroke-width="2"/>');
      case "storm": return svg(cloudAt("translate(0 -2)") + '<path d="M8.6 10.6l-1.6 2.3h2.2l-1.4 2.3"/>');
      default: return svg(`<path d="${CLOUD}"/>`);
    }
  };
  // Something looking for where you are: a map pin.
  const pin_place = () => svg('<path d="M8 14.5s-4.5-4.4-4.5-7.8a4.5 4.5 0 0 1 9 0c0 3.4-4.5 7.8-4.5 7.8z"/><circle cx="8" cy="6.7" r="1.6"/>');

  // The launcher: four tiles, the way to anything.
  const launcher = () => svg('<rect x="2" y="2" width="5" height="5" rx="1.2"/><rect x="9" y="2" width="5" height="5" rx="1.2"/><rect x="2" y="9" width="5" height="5" rx="1.2"/><rect x="9" y="9" width="5" height="5" rx="1.2"/>');

  // Settings: a gear of six teeth round a ring.
  const settings = () => svg('<circle cx="8" cy="8" r="2.2"/><path d="M8 1.6v2M8 12.4v2M14.4 8h-2M3.6 8h-2M12.5 3.5l-1.4 1.4M4.9 11.1l-1.4 1.4M12.5 12.5l-1.4-1.4M4.9 4.9 3.5 3.5"/><circle cx="8" cy="8" r="4.4"/>');

  const power = () => svg('<path d="M8 2v5.5"/><path d="M4.6 4.3a5 5 0 1 0 6.8 0"/>');

  // The expand button, the same on every pane that has one (the drawers,
  // Morgan): four corners out to fill the screen, in to come back, and a
  // cross where coming back closes it.
  const frame = (d) => `<svg viewBox="0 0 14 14" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="${d}"/></svg>`;
  const grow = () => frame("M2 5V2h3M9 2h3v3M12 9v3H9M5 12H2V9");
  const shrink = () => frame("M5 2v3H2M12 5H9V2M9 12V9h3M2 9h3v3");
  const close = () => frame("M3 3l8 8M11 3l-8 8");

  // People: a head and shoulders.
  const folder = () => svg('<path d="M2.5 4.5h4l1.5 1.5h5.5v6.5h-11z"/>');
  // The Library: a card catalog's two drawers. It holds no work of its own; it says where each thing is.
  const library = () => svg('<rect x="2.5" y="2.5" width="11" height="11" rx="1.5"/><path d="M2.5 8h11M6.5 5.2h3M6.5 10.8h3"/>');
  // A file kept on a task itself: a paperclip. One linked from a folder elsewhere: out of a box.
  const clip = () => svg('<path d="M10.5 5v5.5a2.5 2.5 0 0 1-5 0V4.5a1.6 1.6 0 0 1 3.2 0v5.8a.7.7 0 0 1-1.4 0V5.5"/>');
  const linked = () => svg('<path d="M9.5 2.5h4v4M13.5 2.5 8 8"/><path d="M11.5 9.5v4h-9v-9h4"/>');
  const people = () => svg('<circle cx="8" cy="5.5" r="2.6"/><path d="M3 13.5c.6-2.6 2.6-4 5-4s4.4 1.4 5 4"/>');

  // The canvas: a framed grid with a card on it. Writing: the lines of a page.
  const canvas = () => svg('<rect x="2" y="2" width="12" height="12" rx="2"/><rect x="4.5" y="5" width="4.5" height="3.5" rx=".6"/>');
  const writing = () => svg('<path d="M3 4h10M3 7h10M3 10h10M3 13h6"/>');

  // A side list shown or hidden: a frame with its column (the calendar, the canvas, the writing).
  const sideList = () => frame("M2 2.5h10v9H2zM5.5 2.5v9");

  // The tray, folded: a tray with things in it.
  const tray = () => svg('<path d="M2 9.5h3.2l1 1.8h3.6l1-1.8H14"/><path d="M2 9.5 3.6 4h8.8L14 9.5V13H2z"/>');

  // Tasks: a checked box and two lines.
  // Tasks: a list, each line ticked off.
  const tasks = () => svg('<path d="M2 4.6 3.5 6 6 3.2M8.5 4.8h5.5M2 10.6 3.5 12 6 9.2M8.5 10.8h5.5"/>');
  // New: a plus, for making something (new.html).
  const plus = () => svg('<path d="M8 2.6v10.8M2.6 8h10.8"/>');
  // Notifications: a bell. With some unread the bar sets a dot at its shoulder
  // (bar.html's #bell .dot), a thing of its own so it keeps its color and place.
  const bell = () => svg('<path d="M4 11V7.4a4 4 0 0 1 8 0V11l1.2 1.5H2.8z"/><path d="M6.6 14.2a1.5 1.5 0 0 0 2.8 0"/>');
  // Open windows: two windows, one before the other.
  const windows = () => svg('<rect x="2" y="4.5" width="9" height="8" rx="1.2"/><path d="M5 4.5V3.2A1.2 1.2 0 0 1 6.2 2H13a1 1 0 0 1 1 1v6.8a1.2 1.2 0 0 1-1.2 1.2H11M2 7h9"/>');
  // A book (Library's books, read or waiting).
  const book = () => svg('<path d="M2.5 3.2c2-.9 3.8-.9 5.5.3v9.8c-1.7-1.2-3.5-1.2-5.5-.3z"/><path d="M13.5 3.2c-2-.9-3.8-.9-5.5.3v9.8c1.7-1.2 3.5-1.2 5.5-.3z"/>');
  // Before and after (a month, a week): chevrons. A lock (a network with a password).
  const prev = () => svg('<path d="M10 3.5 5.5 8l4.5 4.5"/>');
  const next = () => svg('<path d="M6 3.5 10.5 8 6 12.5"/>');
  const lock = () => svg('<rect x="4" y="7.5" width="8" height="6" rx="1"/><path d="M5.8 7.5V5.5a2.2 2.2 0 0 1 4.4 0v2"/>');
  // The launcher's kinds: a sum (=), something to do (an arrow), something said, an event.
  const sum = () => svg('<path d="M3.5 6h9M3.5 10h9"/>');
  const go = () => svg('<path d="M3 8h9M9 4.5 12.5 8 9 11.5"/>');
  const said = () => svg('<path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z"/>');
  const event = () => svg('<rect x="2" y="3" width="12" height="11" rx="1.5"/><path d="M2 6.5h12M5.5 1.5v3M10.5 1.5v3"/>');
  // Clipboard history: a board with its clip, and a line written on it. Its
  // tiles: a pin, an eye (looked at, not copied), a bin, a page (a file), a warning.
  const clipboard = () => svg('<path d="M5.5 3H4a1 1 0 0 0-1 1v9.5a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V4a1 1 0 0 0-1-1h-1.5"/><rect x="5.5" y="1.8" width="5" height="2.4" rx=".8"/><path d="M5.5 8h5M5.5 10.8h3.4"/>');
  const pin = () => svg('<path d="M6 2.5h4M7 2.5v4L4.5 9h7L9 6.5v-4M8 9v4.5"/>');
  const eye = () => svg('<path d="M1.8 8S4 3.8 8 3.8 14.2 8 14.2 8 12 12.2 8 12.2 1.8 8 1.8 8z"/><circle cx="8" cy="8" r="2"/>');
  const trash = () => svg('<path d="M2.8 4.3h10.4M6.3 4.3V2.8h3.4v1.5M4.2 4.3l.7 9h6.2l.7-9"/>');
  const file = () => svg('<path d="M4 1.8h5l3 3v9.4H4z"/><path d="M9 1.8v3h3"/>');
  const warn = () => svg('<path d="M8 2.2 14.2 13H1.8z"/><path d="M8 6.5v3M8 11.3v.1"/>');
  // A timer: a stopwatch. A reminder: a clock face.
  const timer = () => svg('<circle cx="8" cy="9" r="5"/><path d="M8 9V6.5M6.5 2.5h3M8 2.5V4"/>');
  const clock = () => svg('<circle cx="8" cy="8" r="5.5"/><path d="M8 5v3l2 1.5"/>');
  return { sky, pin_place, windows, book, prev, next, lock, sum, go, said, event, clipboard, pin, eye, trash, file, warn, timer, clock, sideList, folder, library, clip, linked, people, tasks, plus, bell, canvas, writing, grow, shrink, close, tray, search, morgan, wifi, ethernet, offline, bluetooth, volume, battery, mic, sun, moon, launcher, settings, power };
})();
