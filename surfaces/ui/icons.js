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

  const bluetooth = (on) => svg('<path d="M4.5 5 11 10.5 8 13V3l3 2.5L4.5 11"/>', on ? "" : 'opacity=".45"');

  function volume(level, muted) {
    const body = '<path d="M2.5 6h2.5l3.5-3v10L5 10H2.5z"/>';
    if (muted) return svg(body + '<path d="M11 6l3.5 4M14.5 6 11 10"/>');
    const waves = (level > 0 ? '<path d="M10.8 6.2a2.6 2.6 0 0 1 0 3.6"/>' : "") +
      (level > 50 ? '<path d="M12.6 4.4a5.2 5.2 0 0 1 0 7.2"/>' : "");
    return svg(body + waves);
  }

  /** A cell filled to its level; a bolt when it is charging. */
  function battery(level, charging) {
    const w = Math.max(0, Math.min(1, level / 100)) * 9;
    return svg(
      '<rect x="1.5" y="4.5" width="12" height="7" rx="1.5"/><path d="M14.5 7v2"/>' +
      `<rect x="3" y="6" width="${w.toFixed(1)}" height="4" rx=".5" fill="currentColor" stroke="none" opacity="${charging ? .35 : .8}"/>` +
      (charging ? '<path d="M8.3 5.3 6.5 8.2h2.6L7.4 10.8" stroke-width="1.3"/>' : ""));
  }

  function mic(muted) {
    return svg('<rect x="6" y="1.8" width="4" height="7.6" rx="2"/><path d="M3.5 7.8a4.5 4.5 0 0 0 9 0M8 12.3V14.5"/>' +
      (muted ? '<path d="M2.5 2.5 13.5 13.5"/>' : ""));
  }

  const sun = () => svg('<circle cx="8" cy="8" r="2.8"/><path d="M8 1.5v1.6M8 12.9v1.6M1.5 8h1.6M12.9 8h1.6M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M3.4 12.6l1.1-1.1M11.5 4.5l1.1-1.1"/>');

  const power = () => svg('<path d="M8 2v5.5"/><path d="M4.6 4.3a5 5 0 1 0 6.8 0"/>');

  return { search, morgan, wifi, ethernet, offline, bluetooth, volume, battery, mic, sun, power };
})();
