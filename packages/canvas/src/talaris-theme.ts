// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore

/*
 * The canvas wears Talaris's theme.
 *
 * The forked stylesheet speaks Hermes' palette — `--bg`, `--border`,
 * `--text-muted`, `--postit` and the rest. Rather than edit a 4,000-line fork,
 * the drawer's own `theme.css` is loaded after it, and Hermes' names are
 * pointed at Talaris's. Both are added at run time, after the bundled styles,
 * so they win without a specificity contest. The drawer sets the mode, accent
 * and typeface on this frame as it does on itself.
 */
export function wearTheme(): void {
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = "../theme.css";
  document.head.append(link);
  const style = document.createElement("style");
  style.textContent = `
    :root {
      --bg: var(--desk);
      --surface-2: var(--paper);
      --text-muted: var(--muted);
      --text-faint: var(--muted);
      --text-secondary: var(--muted);
      --border: var(--line);
      --border-strong: var(--frame);
      --accent-ink: var(--text);
      --font-body: var(--font);
      --font-chrome: var(--font);
      --postit: #d9c983;
      --postit-edge: #a8955a;
      --shadow-soft: 2px 3px 8px rgba(0, 0, 0, .45);
      --shadow-lift: 3px 5px 14px rgba(0, 0, 0, .55);
      --shadow-color: rgba(0, 0, 0, .45);
      --radius-control: 8px;
    }
    :root[data-mode="light"] {
      --postit: #fdf3b6;
      --postit-edge: #d9c56a;
      --shadow-soft: 2px 3px 8px rgba(0, 0, 0, .15);
      --shadow-lift: 3px 5px 14px rgba(0, 0, 0, .2);
      --shadow-color: rgba(0, 0, 0, .15);
    }
    html, body { background: transparent; }
    /* Dark ink is for paper. A sticky is paper, so it keeps it; a note with no
       fill sits on the canvas itself and takes the theme's text, as does a
       canvas card. A note given a color of its own sets its ink inline. */
    .cv-note:not([data-shape="postIt"]) .cv-paper,
    .cv-node.cv-canvascard .cv-paper { color: var(--text); }
    body { user-select: none; -webkit-user-select: none; }

    /* A canvas card: a child canvas, or a link to one. Framed in the accent,
       titled like the drawers, and opened with a double-click. */
    .cv-node.cv-canvascard {
      border: 1px solid var(--accent) !important;
      border-radius: 10px !important;
      background: var(--accent-wash) !important;
      box-shadow: none !important;
    }
    .cv-node.cv-canvascard::after {
      content: "CANVAS ↗";
      position: absolute; right: 8px; bottom: 6px;
      font-size: 10px; letter-spacing: 2px; color: var(--accent);
      pointer-events: none;
    }

    .cv-missing { height: 100%; display: flex; flex-direction: column; justify-content: center; gap: 4px;
      padding: 8px 10px; border: 1px dashed var(--line); border-radius: 8px; color: var(--muted); }
    .cv-missing-label { font-size: 10px; letter-spacing: 2px; }
  `;
  document.head.append(style);
}
