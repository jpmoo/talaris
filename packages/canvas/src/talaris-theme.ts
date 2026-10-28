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
  // Every control's look, shared with the drawers — see controls.css.
  const controls = document.createElement("link");
  controls.rel = "stylesheet";
  controls.href = "../controls.css";
  document.head.append(controls);
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
      --postit: #d9c983; /* look: what is drawn on the canvas, not its controls */
      --postit-edge: #a8955a; /* look: what is drawn on the canvas, not its controls */
      /* What a new shape is filled with: a card a step up from the surface. */
      --shape-fill: #2e3337; /* look: what is drawn on the canvas, not its controls */
      --shadow-soft: 2px 3px 8px rgba(0, 0, 0, .45); /* look: what is drawn on the canvas, not its controls */
      --shadow-lift: 3px 5px 14px rgba(0, 0, 0, .55); /* look: what is drawn on the canvas, not its controls */
      --shadow-color: rgba(0, 0, 0, .45); /* look: what is drawn on the canvas, not its controls */
    }
    :root[data-mode="light"] {
      --postit: #fdf3b6; /* look: what is drawn on the canvas, not its controls */
      --postit-edge: #d9c56a; /* look: what is drawn on the canvas, not its controls */
      --shape-fill: #ffffff; /* look: what is drawn on the canvas, not its controls */
      --shadow-soft: 2px 3px 8px rgba(0, 0, 0, .15); /* look: what is drawn on the canvas, not its controls */
      --shadow-lift: 3px 5px 14px rgba(0, 0, 0, .2); /* look: what is drawn on the canvas, not its controls */
      --shadow-color: rgba(0, 0, 0, .15); /* look: what is drawn on the canvas, not its controls */
    }
    html, body { background: transparent; overflow: hidden; }
    body { color: var(--text); font-family: var(--font); }
    /* Everything the fork named a face for takes the theme's instead. */
    .cv-wrap, .cv-node, .cv-region, .tools, .tool-menu, .menu-item, .hint, .modal-card, .cv-zoom { font-family: var(--font) !important; }
    /* Form fields take the theme's ink; left alone they draw black, which is
       how the zoom box's percentage disappeared into its dark field. */
    input, select, textarea, button { color: inherit; }
    .cv-region-title { font-family: var(--font); letter-spacing: 1px; color: var(--muted); }
    .cv-marquee { border-color: var(--accent) !important; background: var(--accent-wash) !important; }

    /* The paper: dots, graph lines, or nothing. Drawn here so it wins over the
       forked sheet's one fixed dot grid, and moves and scales with the view. */
    /* The drawer's opacity reaches the paper too (shared in as --alpha); a canvas
       with a background of its own (--cv-paper, its document's) wears that. */
    .cv-wrap.paper-dots, .framed .cv-wrap.paper-dots {
      background: radial-gradient(circle, var(--line) 1px, transparent 1px)
        var(--cv-x, 0px) var(--cv-y, 0px) / calc(24px * var(--cv-z, 1)) calc(24px * var(--cv-z, 1)), color-mix(in srgb, var(--cv-paper, var(--desk)) var(--alpha, 100%), transparent);
    }
    .cv-wrap.paper-lines, .framed .cv-wrap.paper-lines {
      background:
        linear-gradient(to right, color-mix(in srgb, var(--line) 70%, transparent) 1px, transparent 1px)
          var(--cv-x, 0px) var(--cv-y, 0px) / calc(24px * var(--cv-z, 1)) calc(24px * var(--cv-z, 1)),
        linear-gradient(to bottom, color-mix(in srgb, var(--line) 70%, transparent) 1px, transparent 1px)
          var(--cv-x, 0px) var(--cv-y, 0px) / calc(24px * var(--cv-z, 1)) calc(24px * var(--cv-z, 1)),
        color-mix(in srgb, var(--cv-paper, var(--desk)) var(--alpha, 100%), transparent);
    }
    .cv-wrap.paper-none, .framed .cv-wrap.paper-none { background: color-mix(in srgb, var(--cv-paper, var(--desk)) var(--alpha, 100%), transparent); }
    /* What is typed in notes and shapes, at Settings' canvas size (--type-scale,
       shared in by the drawer). The note's editor takes its size from here. */
    .cv-note .cv-paper, .cv-note .md-editor { font-size: calc(13px * var(--type-scale, 1)) !important; }
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
      border-radius: var(--radius-control) !important;
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
    .cv-note:not([data-shape]) .cv-paper { border-radius: 12px; } /* look: the Rounded note shape */
    /* A note's text field is as tall as its text, and the note places it —
       top, middle or bottom. Stretched to the note's height, the field had
       nowhere to be moved to. Taller text than note still scrolls. */
    .cv-note .cv-body > .longtext { flex: 0 1 auto !important; height: auto !important; min-height: 0; max-height: 100%; overflow: auto; }

    /* The canvas's own confirmation, dressed like the drawer's; its buttons are controls.css's. */
    .modal-backdrop { background: var(--scrim) !important; backdrop-filter: none !important; }
    .modal-card { background: var(--surface) !important; color: var(--text); border: 1px solid var(--frame) !important;
      border-radius: var(--radius-panel) !important; box-shadow: var(--menu-shadow) !important; font-family: var(--font); }
    /* Its title in the one heading style (theme.css .label), which the canvas does not load. */
    .modal-title { font-weight: 400 !important; font-size: 10px !important; letter-spacing: 2px; text-transform: uppercase; color: var(--muted) !important; }
    .modal-message { color: var(--muted) !important; }

    /* Only as wide as its six icons. */
    /* Opens straight out to the right of the shape button, level with it,
       rather than pushing the rest of the strip down. */
    .tool-menu.shape-row { display: flex; flex-direction: row !important; gap: 4px; padding: 5px; min-width: 0 !important; width: max-content;
      position: absolute; left: 38px; top: -5px; z-index: 2; }
    .cv-region-add { border-radius: var(--radius-row) !important; background: transparent !important; border: 1px solid var(--muted) !important; color: var(--muted) !important; }
    .cv-region-add:hover, .cv-region-add.on { border-color: var(--accent) !important; color: var(--accent) !important; }
    .cv-menu-gap { width: 10px; display: inline-block; }
    .cv-missing { height: 100%; display: flex; flex-direction: column; justify-content: center; gap: 4px;
      padding: 8px 10px; border: 1px dashed var(--line); border-radius: var(--radius-control); color: var(--muted); }
    .cv-missing-label { font-size: 10px; letter-spacing: 2px; }
  `;
  document.head.append(style);
}
