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
  // The typefaces come with tokens.css, from the drawer's own fonts/ folder.
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
    html, body { background: transparent; overflow: hidden; }
    body { color: var(--text); font-family: var(--font); }
    /* Everything the fork named a face for takes the theme's instead. */
    .cv-wrap, .cv-node, .cv-region, .tools, .tool-menu, .menu-item, .hint, .modal-card, .cv-zoom { font-family: var(--font) !important; }
    /* Form fields take the theme's ink; left alone they draw black, which is
       how the zoom box's percentage disappeared into its dark field. */
    input, select, textarea, button { color: inherit; }
    .cv-zoom { color: var(--text); background: var(--desk); border-color: var(--line); }
    /* Text fields — a region's title being renamed, an edge's label — on the
       theme's ground, not the engine's white. */
    input:not([type]), input[type="text"], input[type="search"], textarea {
      background: var(--desk); border: 1px solid var(--line); border-radius: 6px; color: var(--text); font: inherit; }
    input:not([type]):focus, input[type="text"]:focus, textarea:focus { outline: none; border-color: var(--accent); }
    .cv-region-title { font-family: var(--font); letter-spacing: 1px; color: var(--muted); }
    .cv-region-add { background: var(--muted) !important; color: var(--surface) !important; }
    .cv-region-add:hover { background: var(--text) !important; }
    .cv-region-add.on { background: var(--accent) !important; }
    .cv-marquee { border-color: var(--accent) !important; background: var(--accent-wash) !important; }

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

    /* Rounded is the shape with no name, and every note's sheet otherwise
       gets a 2px corner — so Rounded drew square. It gets its corner here. */
    .cv-note:not([data-shape]) .cv-paper { border-radius: 12px; }
    /* A note's text field is as tall as its text, and the note places it —
       top, middle or bottom. Stretched to the note's height, the field had
       nowhere to be moved to. Taller text than note still scrolls. */
    .cv-note .cv-body > .longtext { flex: 0 1 auto !important; height: auto !important; min-height: 0; max-height: 100%; overflow: auto; }

    /* The canvas's own confirmation, dressed like the drawer's. */
    .modal-backdrop { background: rgba(0, 0, 0, .45) !important; backdrop-filter: none !important; }
    .modal-card { background: var(--surface) !important; color: var(--text); border: 1px solid var(--frame) !important;
      border-radius: 10px !important; box-shadow: 0 10px 30px rgba(0, 0, 0, .45) !important; font-family: var(--font); }
    .modal-title { font-weight: 500 !important; font-size: 15px !important; letter-spacing: 1px; color: var(--text) !important; }
    .modal-message { color: var(--muted) !important; }
    .modal-actions button { font: inherit; border: 1px solid var(--line); border-radius: 14px; padding: 3px 14px;
      background: transparent !important; color: var(--text); cursor: pointer; }
    .modal-actions button:hover { border-color: var(--accent); color: var(--accent); }
    .modal-actions button.danger { border-color: var(--danger); color: var(--danger); }
    .modal-actions button.danger:hover { background: color-mix(in srgb, var(--danger) 14%, transparent) !important; }
    .modal-actions button:disabled { opacity: .45; cursor: default; }

    .cv-swatch.cv-align { display: inline-flex; align-items: center; justify-content: center; color: var(--muted); background: transparent; border: 1px solid var(--line); }
    .cv-swatch.cv-align:hover { color: var(--accent); border-color: var(--accent); }
    .cv-swatch.cv-align.is-on { color: var(--accent); border-color: var(--accent); background: var(--accent-wash); }
    /* Only as wide as its six icons. */
    /* Opens straight out to the right of the shape button, level with it,
       rather than pushing the rest of the strip down. */
    .tool-menu.shape-row { display: flex; flex-direction: row !important; gap: 4px; padding: 5px; min-width: 0 !important; width: max-content;
      position: absolute; left: 38px; top: -5px; z-index: 2; }
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
