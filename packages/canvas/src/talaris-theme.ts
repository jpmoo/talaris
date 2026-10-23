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
  // Only the values: theme.css's element styles would restyle the canvas's own buttons.
  link.href = "../tokens.css";
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
      /* A shape's default outline is drawn in this. Hermes' strong border is a
         hairline on a light page; on Talaris's dark canvas it all but vanished,
         so an ellipse looked like loose text. Muted reads, and stays quiet. */
      --border-strong: var(--muted);
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
    body { color: var(--text); font-family: var(--font); }
    /* Form fields take the theme's ink; left alone they draw black, which is
       how the zoom box's percentage disappeared into its dark field. */
    input, select, textarea, button { color: inherit; }
    .cv-zoom { color: var(--text); background: var(--desk); border-color: var(--line); }

    /* The paper: dots, graph lines, or nothing. Drawn here so it wins over the
       forked sheet's one fixed dot grid, and moves and scales with the view. */
    .cv-wrap.paper-dots, .framed .cv-wrap.paper-dots {
      background: radial-gradient(circle, var(--line) 1px, transparent 1px)
        var(--cv-x, 0px) var(--cv-y, 0px) / calc(24px * var(--cv-z, 1)) calc(24px * var(--cv-z, 1)), var(--desk);
    }
    .cv-wrap.paper-lines, .framed .cv-wrap.paper-lines {
      background:
        linear-gradient(to right, color-mix(in srgb, var(--line) 70%, transparent) 1px, transparent 1px)
          var(--cv-x, 0px) var(--cv-y, 0px) / calc(24px * var(--cv-z, 1)) calc(24px * var(--cv-z, 1)),
        linear-gradient(to bottom, color-mix(in srgb, var(--line) 70%, transparent) 1px, transparent 1px)
          var(--cv-x, 0px) var(--cv-y, 0px) / calc(24px * var(--cv-z, 1)) calc(24px * var(--cv-z, 1)),
        var(--desk);
    }
    .cv-wrap.paper-none, .framed .cv-wrap.paper-none { background: var(--desk); }
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

    .cv-swatch.cv-align { display: inline-flex; align-items: center; justify-content: center; color: var(--muted); background: transparent; border: 1px solid var(--line); }
    .cv-swatch.cv-align:hover { color: var(--accent); border-color: var(--accent); }
    .cv-swatch.cv-align.is-on { color: var(--accent); border-color: var(--accent); background: var(--accent-wash); }
    .tool-menu.shape-row { display: flex; gap: 4px; padding: 6px; }
    .shape-pick { width: 30px; height: 30px; display: inline-flex; align-items: center; justify-content: center;
      border: 1px solid var(--line); border-radius: 7px; background: transparent; color: var(--muted); cursor: pointer; padding: 0; }
    .shape-pick:hover { color: var(--accent); border-color: var(--accent); }
    .shape-pick.on { color: var(--accent); border-color: var(--accent); background: var(--accent-wash); }
    .cv-menu-gap { width: 10px; display: inline-block; }
    .cv-missing { height: 100%; display: flex; flex-direction: column; justify-content: center; gap: 4px;
      padding: 8px 10px; border: 1px dashed var(--line); border-radius: 8px; color: var(--muted); }
    .cv-missing-label { font-size: 10px; letter-spacing: 2px; }
  `;
  document.head.append(style);
}
