// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore

/**
 * Talaris's Markdown editor: CodeMirror 6, with live preview.
 *
 * One continuous editor, as in Obsidian: formatting renders in place as you
 * type, and only the Markdown right around the cursor shows (see `live.ts` for
 * the rules). Raw is the same editor with the preview turned off, so switching
 * between them never moves the cursor or loses an undo.
 *
 * Built by esbuild into `surfaces/ui/editor.js`, which the drawer imports.
 */

import { Compartment, EditorSelection, EditorState, type Extension } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
  drawSelection,
  keymap,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { syntaxTree } from "@codemirror/language";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { liveSpecs, type Spec } from "./live.ts";

class Bullet extends WidgetType {
  toDOM(): HTMLElement {
    const s = document.createElement("span");
    s.className = "cm-bullet";
    s.textContent = "•";
    return s;
  }
}

/** A task box that writes back to the Markdown: `[ ]` ↔ `[x]`, nothing else. */
class Check extends WidgetType {
  constructor(readonly checked: boolean, readonly at: number) { super(); }
  eq(other: Check): boolean { return other.checked === this.checked && other.at === this.at; }
  toDOM(view: EditorView): HTMLElement {
    const box = document.createElement("input");
    box.type = "checkbox";
    box.className = "cm-check";
    box.checked = this.checked;
    box.addEventListener("mousedown", (e) => {
      e.preventDefault();
      view.dispatch({ changes: { from: this.at + 1, to: this.at + 2, insert: this.checked ? " " : "x" } });
    });
    return box;
  }
  ignoreEvent(): boolean { return false; }
}

function decorations(view: EditorView): DecorationSet {
  const ranges = [];
  for (const { from, to } of view.visibleRanges) {
    for (const s of liveSpecs(view.state, from, to) as Spec[]) {
      switch (s.kind) {
        case "hide":
          if (s.to > s.from) ranges.push(Decoration.replace({}).range(s.from, s.to));
          break;
        case "mark":
          ranges.push(Decoration.mark({
            class: s.cls,
            attributes: s.url ? { "data-url": s.url, "data-from": String(s.from), "data-to": String(s.to) } : undefined,
          }).range(s.from, s.to));
          break;
        case "line":
          ranges.push(Decoration.line({ class: s.cls }).range(s.at));
          break;
        case "bullet":
          ranges.push(Decoration.replace({ widget: new Bullet() }).range(s.from, s.to));
          break;
        case "rule":
          // The whole line becomes the rule, drawn by the line itself so it
          // spans the width; the `---` is hidden on it.
          ranges.push(Decoration.line({ class: "cm-hr" }).range(view.state.doc.lineAt(s.from).from));
          ranges.push(Decoration.replace({}).range(s.from, s.to));
          break;
        case "check":
          ranges.push(Decoration.replace({ widget: new Check(s.checked, s.from) }).range(s.from, s.to));
          break;
      }
    }
  }
  return Decoration.set(ranges, true);
}

const livePreview = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) { this.decorations = decorations(view); }
    update(u: ViewUpdate): void {
      // The parse finishing is a change too: a long note renders as it parses.
      if (u.docChanged || u.selectionSet || u.viewportChanged || syntaxTree(u.startState) !== syntaxTree(u.state)) {
        this.decorations = decorations(u.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);

/*
 * The look, from the theme's own variables — so the editor follows the
 * accent, the typeface and light or dark without being told.
 */
const look = EditorView.theme({
  "&": { height: "100%", color: "var(--text)", backgroundColor: "transparent", fontSize: "14px" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "var(--font)", lineHeight: "1.6" },
  ".cm-content": { padding: "10px 12px", caretColor: "var(--accent)" },
  ".cm-cursor, .cm-dropCursor": { borderLeft: "2px solid var(--accent)" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": { backgroundColor: "var(--accent-wash) !important" },
  ".cm-line": { padding: "0 2px" },
  ".cm-h1": { fontSize: "1.6em", fontWeight: "500", letterSpacing: "0.5px" },
  ".cm-h2": { fontSize: "1.35em", fontWeight: "500" },
  ".cm-h3": { fontSize: "1.15em", fontWeight: "500" },
  ".cm-h4, .cm-h5, .cm-h6": { fontWeight: "500", color: "var(--muted)" },
  ".cm-strong": { fontWeight: "600" },
  ".cm-em": { fontStyle: "italic" },
  ".cm-strike": { textDecoration: "line-through", color: "var(--muted)" },
  ".cm-inline-code": { fontFamily: "ui-monospace, monospace", fontSize: "0.9em", background: "var(--accent-wash)", borderRadius: "4px", padding: "0 3px" },
  ".cm-codeblock": { fontFamily: "ui-monospace, monospace", fontSize: "0.9em", background: "var(--desk)" },
  ".cm-link": { color: "var(--accent)", textDecoration: "underline", textUnderlineOffset: "2px", cursor: "pointer" },
  ".cm-quote": { borderLeft: "2px solid var(--line)", paddingLeft: "10px", color: "var(--muted)" },
  ".cm-bullet": { color: "var(--accent)", padding: "0 2px" },
  ".cm-check": { accentColor: "var(--accent)", margin: "0 4px 0 0", verticalAlign: "-1px", cursor: "pointer" },
  ".cm-task-done": { color: "var(--muted)", textDecoration: "line-through" },
  ".cm-hr": { background: "linear-gradient(var(--line), var(--line)) center / 100% 1px no-repeat" },
  "&.raw .cm-scroller": { fontFamily: "ui-monospace, monospace", fontSize: "13px" },
});

export interface EditorOptions {
  live?: boolean;
  onChange?: (text: string) => void;
  /** A rendered link was clicked: open it somewhere else. */
  onOpenUrl?: (url: string) => void;
}

export interface Editor {
  readonly text: string;
  set(text: string): void;
  setLive(live: boolean): void;
  focus(): void;
  destroy(): void;
}

export function createEditor(host: HTMLElement, text: string, options: EditorOptions = {}): Editor {
  const preview = new Compartment();
  const liveOn = (on: boolean): Extension => (on ? livePreview : []);
  let live = options.live !== false;

  const view = new EditorView({
    parent: host,
    state: EditorState.create({
      doc: text,
      extensions: [
        history(),
        drawSelection(),
        EditorView.lineWrapping,
        markdown({ base: markdownLanguage }),
        keymap.of([indentWithTab, ...defaultKeymap, ...historyKeymap]),
        preview.of(liveOn(live)),
        look,
        EditorView.contentAttributes.of({ spellcheck: "true" }),
        EditorView.updateListener.of((u) => { if (u.docChanged) options.onChange?.(u.state.doc.toString()); }),
        EditorView.domEventHandlers({
          mousedown: (event, v) => {
            // A rendered link opens on a click, as in Obsidian. Once the cursor
            // is inside it (its address showing), a click edits it instead.
            if (!live) return false;
            const link = (event.target as HTMLElement).closest?.("[data-url]") as HTMLElement | null;
            if (!link) return false;
            const from = Number(link.dataset.from);
            const to = Number(link.dataset.to);
            const inside = v.state.selection.ranges.some((r) => r.from <= to && r.to >= from);
            if (inside || !link.dataset.url) return false;
            event.preventDefault();
            options.onOpenUrl?.(link.dataset.url);
            return true;
          },
        }),
      ],
    }),
  });
  view.dom.classList.toggle("raw", !live);

  return {
    get text() { return view.state.doc.toString(); },
    set(next: string) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: next }, selection: EditorSelection.cursor(0) });
    },
    setLive(on: boolean) {
      live = on;
      view.dom.classList.toggle("raw", !on);
      view.dispatch({ effects: preview.reconfigure(liveOn(on)) });
    },
    focus() { view.focus(); },
    destroy() { view.destroy(); },
  };
}
