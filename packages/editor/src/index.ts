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

import { Compartment, EditorSelection, EditorState, Prec, type Extension } from "@codemirror/state";
import { autocompletion, type Completion, type CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
  drawSelection,
  keymap,
  placeholder,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentLess, indentMore } from "@codemirror/commands";
import { codeFolding, foldGutter, foldKeymap, foldService, syntaxTree } from "@codemirror/language";
import type { StateCommand } from "@codemirror/state";
import { listItemAt, moveListItem } from "./lists.ts";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { COLOR_SPAN, colored, liveSpecs, type Spec } from "./live.ts";

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
  /*
   * Drawn, not the engine's own checkbox: the same rounded square in every
   * theme, the accent when ticked. A click writes `[ ]` ↔ `[x]` and nothing
   * else, and does not move the cursor, so the box stays a box.
   */
  toDOM(view: EditorView): HTMLElement {
    const box = document.createElement("span");
    box.className = "cm-check" + (this.checked ? " is-checked" : "");
    box.setAttribute("role", "checkbox");
    box.setAttribute("aria-checked", String(this.checked));
    box.innerHTML = '<svg viewBox="0 0 12 12"><path d="M2.5 6.2 5 8.5 9.5 3.5"/></svg>';
    box.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      view.dispatch({ changes: { from: this.at + 1, to: this.at + 2, insert: this.checked ? " " : "x" } });
    });
    return box;
  }
  ignoreEvent(): boolean { return true; }
}

/** How much of a branch is done: `2/5`, in the accent once it is all done. */
class Count extends WidgetType {
  constructor(readonly done: number, readonly total: number) { super(); }
  eq(o: Count): boolean { return o.done === this.done && o.total === this.total; }
  toDOM(): HTMLElement {
    const s = document.createElement("span");
    s.className = "cm-count" + (this.done === this.total ? " is-done" : "");
    s.textContent = `${this.done}/${this.total}`;
    s.title = `${this.done} of ${this.total} done`;
    return s;
  }
}

/*
 * Tab and Shift+Tab. On a list item they nest and un-nest it by the width of
 * its own marker — two spaces under `-`, three under `1.` — because that is
 * what Markdown needs for the nesting to count. Elsewhere they indent the line.
 */
function listShift(dir: 1 | -1): StateCommand {
  return ({ state, dispatch }) => {
    const changes: Array<{ from: number; to?: number; insert?: string }> = [];
    let listy = false;
    const seen = new Set<number>();
    for (const r of state.selection.ranges) {
      for (let n = state.doc.lineAt(r.from).number; n <= state.doc.lineAt(r.to).number; n++) {
        if (seen.has(n)) continue;
        seen.add(n);
        const line = state.doc.line(n);
        const m = /^(\s*)([-*+]|\d+[.)])(\s)/.exec(line.text);
        if (!m) continue;
        listy = true;
        const width = m[2]!.length + 1;
        if (dir > 0) changes.push({ from: line.from, insert: " ".repeat(width) });
        else {
          const take = Math.min(m[1]!.length, width);
          if (take) changes.push({ from: line.from, to: line.from + take });
        }
      }
    }
    if (!listy) return false;
    if (changes.length) dispatch(state.update({ changes, scrollIntoView: true, userEvent: dir > 0 ? "indent" : "dedent" }));
    return true;
  };
}

/** A list item with items nested under it folds from the end of its first line to the end of its last child. */
const listFolding = foldService.of((state, lineStart, lineEnd) => {
  const ref = listItemAt(state, lineStart);
  if (!ref) return null;
  const item = ref.items[ref.index]!;
  return item.to > lineEnd ? { from: lineEnd, to: item.to } : null;
});

/*
 * Dragging a list item by its grip, the margin just left of its marker. The
 * item moves with everything nested under it, among its own siblings, and a
 * numbered list renumbers — see lists.ts, which does the moving.
 */
const listDrag = EditorView.domEventHandlers({
  mousedown(event, view) {
    if (event.button !== 0) return false;
    const lineEl = (document.elementsFromPoint(event.clientX + 24, event.clientY)
      .find((e) => e.classList?.contains("cm-line"))) as HTMLElement | undefined;
    if (!lineEl?.classList.contains("cm-listline")) return false;
    if (event.clientX >= lineEl.getBoundingClientRect().left) return false;
    const ref = listItemAt(view.state, view.posAtDOM(lineEl, 0));
    if (!ref) return false;
    event.preventDefault();
    const marker = document.createElement("div");
    marker.className = "cm-drop";
    view.scrollDOM.appendChild(marker);
    lineEl.classList.add("cm-dragging");
    let target = ref.index;
    const place = (y: number) => {
      const tops = ref.items.map((it) => view.coordsAtPos(it.from)?.top ?? 0);
      const last = view.coordsAtPos(ref.items[ref.items.length - 1]!.to)?.bottom ?? 0;
      // The boundary nearest the pointer, among the gaps before each item and after the last.
      const bounds = [...tops, last];
      let best = 0;
      for (let i = 1; i < bounds.length; i++) if (Math.abs(bounds[i]! - y) < Math.abs(bounds[best]! - y)) best = i;
      target = best;
      const box = view.scrollDOM.getBoundingClientRect();
      marker.style.top = `${bounds[best]! - box.top + view.scrollDOM.scrollTop - 1}px`;
      marker.style.left = `${lineEl.getBoundingClientRect().left - box.left - 4}px`;
    };
    place(event.clientY);
    const move = (e: MouseEvent) => place(e.clientY);
    const up = () => {
      removeEventListener("mousemove", move);
      removeEventListener("mouseup", up);
      marker.remove();
      lineEl.classList.remove("cm-dragging");
      // A boundary after the item's own position is one place less once it is lifted out.
      const to = target > ref.index ? target - 1 : target;
      const change = moveListItem(view.state, ref, to);
      if (change) view.dispatch({ changes: change, userEvent: "move.list" });
    };
    addEventListener("mousemove", move);
    addEventListener("mouseup", up);
    return true;
  },
});

function chevron(open: boolean): HTMLElement {
  const s = document.createElement("span");
  s.className = "cm-fold" + (open ? "" : " is-shut");
  s.innerHTML = '<svg viewBox="0 0 10 10"><path d="M3 2 7 5 3 8"/></svg>';
  s.title = open ? "Collapse" : "Expand";
  return s;
}

function decorations(view: EditorView): DecorationSet {
  const ranges = [];
  // A fold splits the visible text in two, and a node spanning both halves —
  // a list item with its children folded — is met once in each. Once is enough.
  const seen = new Set<string>();
  for (const { from, to } of view.visibleRanges) {
    for (const s of liveSpecs(view.state, from, to) as Spec[]) {
      const key = JSON.stringify(s);
      if (seen.has(key)) continue;
      seen.add(key);
      switch (s.kind) {
        case "hide":
          if (s.to > s.from) ranges.push(Decoration.replace({}).range(s.from, s.to));
          break;
        case "mark":
          ranges.push(Decoration.mark({
            class: s.cls,
            attributes: s.url ? { "data-url": s.url, "data-from": String(s.from), "data-to": String(s.to) }
              : s.color ? { style: `color: ${s.color}` } : undefined,
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
        case "count":
          ranges.push(Decoration.widget({ widget: new Count(s.done, s.total), side: 1 }).range(s.at));
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
  // --type-scale is Settings' writing size, set by the drawer; the page's own
  // controls take the interface's.
  "&": { height: "100%", color: "var(--text)", backgroundColor: "transparent", fontSize: "calc(14px * var(--type-scale, 1))" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "var(--font)", lineHeight: "1.6" },
  ".cm-cursor, .cm-dropCursor": { borderLeft: "2px solid var(--accent)" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": { backgroundColor: "var(--accent-wash) !important" },
  ".cm-line": { padding: "0 2px" },
  ".cm-h1": { fontSize: "1.6em", fontWeight: "500", letterSpacing: "0.5px" },
  ".cm-h2": { fontSize: "1.35em", fontWeight: "500" },
  ".cm-h3": { fontSize: "1.15em", fontWeight: "500" },
  ".cm-h4, .cm-h5, .cm-h6": { fontWeight: "500", color: "var(--muted)" },
  ".cm-strong": { fontWeight: "500" },
  ".cm-em": { fontStyle: "italic" },
  ".cm-strike": { textDecoration: "line-through", color: "var(--muted)" },
  ".cm-inline-code": { fontFamily: "ui-monospace, monospace", fontSize: "0.9em", background: "var(--accent-wash)", borderRadius: "var(--radius-row)", padding: "0 3px" },
  ".cm-codeblock": { fontFamily: "ui-monospace, monospace", fontSize: "0.9em", background: "var(--desk)" },
  ".cm-link": { color: "var(--accent)", textDecoration: "underline", textUnderlineOffset: "2px", cursor: "pointer" },
  ".cm-link.cm-mention": { textDecoration: "none", background: "var(--accent-wash)", borderRadius: "var(--radius-row)", padding: "0 3px" },
  // A kept file: a chip with a paperclip, drawn in the text's own color.
  ".cm-link.cm-file": { textDecoration: "none", background: "var(--accent-wash)", borderRadius: "var(--radius-row)", padding: "0 4px 0 2px" },
  ".cm-link.cm-file::before": {
    content: '""', display: "inline-block", width: "0.85em", height: "0.85em", marginRight: "3px", verticalAlign: "-0.1em", backgroundColor: "currentColor",
    mask: "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='none' stroke='black' stroke-width='1.6' stroke-linecap='round'%3E%3Cpath d='M10.5 4.5 5.6 9.4a1.4 1.4 0 0 0 2 2l5.2-5.2a2.8 2.8 0 0 0-4-4L3.6 7.4a4.2 4.2 0 0 0 6 6l4-4'/%3E%3C/svg%3E\") center / contain no-repeat",
  },
  ".cm-tooltip.cm-tooltip-autocomplete": { background: "var(--surface)", border: "1px solid var(--frame)", borderRadius: "var(--radius-control)", boxShadow: "var(--menu-shadow)", padding: "4px" },
  ".cm-tooltip.cm-tooltip-autocomplete > ul": { fontFamily: "inherit", maxHeight: "16em" },
  ".cm-tooltip.cm-tooltip-autocomplete > ul > li": { padding: "5px 10px", borderRadius: "var(--radius-row)", color: "var(--text)", fontSize: "13px" },
  ".cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]": { background: "var(--accent-wash)", color: "var(--accent)" },
  ".cm-completionDetail": { marginLeft: "8px", color: "var(--muted)", fontStyle: "normal", fontSize: "0.85em" },
  ".cm-completionIcon": { display: "none" },
  ".cm-quote": { borderLeft: "2px solid var(--line)", paddingLeft: "10px", color: "var(--muted)" },
  ".cm-bullet": { color: "var(--accent)", padding: "0 2px" },
  ".cm-check": { display: "inline-flex", width: "14px", height: "14px", margin: "0 6px 0 0", verticalAlign: "-2px", border: "1.5px solid var(--muted)", borderRadius: "var(--radius-row)", alignItems: "center", justifyContent: "center", cursor: "pointer", transition: "background var(--dur), border-color var(--dur)" },
  ".cm-check svg": { width: "10px", height: "10px", fill: "none", stroke: "var(--surface)", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round", opacity: "0" },
  ".cm-check:hover": { borderColor: "var(--accent)" },
  ".cm-count": { marginLeft: "8px", fontSize: "11px", letterSpacing: "1px", color: "var(--muted)", border: "1px solid var(--line)", borderRadius: "var(--radius-row)", padding: "0 6px", verticalAlign: "1px" },
  ".cm-count.is-done": { color: "var(--accent)", borderColor: "var(--accent)" },
  ".cm-check.is-checked": { background: "var(--accent)", borderColor: "var(--accent)" },
  ".cm-check.is-checked svg": { opacity: "1" },
  // The grip: dots in the margin left of a list item, shown on hover.
  // Room on the left for the grip and no more: 26 read as a wide margin.
  ".cm-content": { padding: "10px 12px 10px 14px", caretColor: "var(--accent)" },
  ".cm-listline": { position: "relative" },
  ".cm-listline::before": { content: "'⋮⋮'", position: "absolute", left: "-12px", top: "0", width: "11px", letterSpacing: "-3px", color: "var(--muted)", opacity: "0", cursor: "grab", transition: "opacity var(--dur)" },
  ".cm-listline:hover::before": { opacity: "0.8" },
  ".cm-dragging": { opacity: "0.45" },
  ".cm-drop": { position: "absolute", right: "8px", height: "2px", background: "var(--accent)", borderRadius: "1px", pointerEvents: "none", zIndex: "5" },
  ".cm-gutters": { background: "transparent", border: "none", color: "var(--muted)" },
  ".cm-foldGutter .cm-gutterElement": { cursor: "pointer", padding: "0 0 0 4px" },
  ".cm-fold": { display: "inline-flex", opacity: "0", transition: "opacity var(--dur), transform var(--dur)", transform: "rotate(90deg)" },
  ".cm-fold.is-shut": { opacity: "0.9", transform: "none", color: "var(--accent)" },
  ".cm-fold svg": { width: "9px", height: "9px", fill: "none", stroke: "currentColor", strokeWidth: "1.6", strokeLinecap: "round", strokeLinejoin: "round" },
  ".cm-gutterElement:hover .cm-fold, .cm-editor:hover .cm-fold": { opacity: "0.7" },
  ".cm-foldPlaceholder": { background: "var(--accent-wash)", border: "none", color: "var(--accent)", borderRadius: "var(--radius-row)", padding: "0 5px", margin: "0 4px" },
  ".cm-task-done": { color: "var(--muted)", textDecoration: "line-through" },
  ".cm-hr": { background: "linear-gradient(var(--line), var(--line)) center / 100% 1px no-repeat" },
  "&.raw .cm-scroller": { fontFamily: "ui-monospace, monospace", fontSize: "calc(13px * var(--type-scale, 1))" },
});

const compactLook = EditorView.theme({
  // Inside a note the ink is the note's — dark on a sticky, whatever it was set to.
  // Only as tall as its words, so the note can set them top, middle or
  // bottom; a full-height editor left nothing for vertical alignment to move.
  "&": { color: "inherit", fontSize: "inherit", height: "auto" },
  ".cm-scroller": { lineHeight: "1.45" },
  ".cm-content": { padding: "2px 4px" },
  ".cm-listline::before": { display: "none" },
});

export interface EditorOptions {
  live?: boolean;
  /**
   * A small editor inside something else — a note on a canvas. No fold
   * margin and no drag grips, which need room a note does not have.
   */
  compact?: boolean;
  onChange?: (text: string) => void;
  /** A rendered link was clicked: open it somewhere else. */
  onOpenUrl?: (url: string) => void;
  /**
   * `@` names something: the picker searches with `search`, makes something
   * new with `create`, and a mention clicked opens with `open`. Without it,
   * `@` is only a character.
   */
  mentions?: Mentions;
  /** One line: Enter does not break it (a title). `onEnter` hears it instead. */
  singleLine?: boolean;
  onEnter?: () => void;
  /** Shown faintly while there are no words. */
  placeholder?: string;
  /**
   * Files: dropped or pasted in, each is kept (`attach`, by the page — in its
   * project's `Files/`) and linked where it landed, `[name](talaris-file:path)`,
   * drawn as a chip; a chip clicked is opened (`open`). Without it, a file
   * dropped is the browser's to deal with.
   */
  files?: Files;
}

export interface Files {
  attach(file: File): Promise<{ name: string; path: string }>;
  open(path: string): void;
}

/** A kept file's link, its path made safe for a Markdown address. */
export function fileLink(name: string, path: string): string {
  const href = encodeURI(path).replace(/\(/g, "%28").replace(/\)/g, "%29");
  return `[${name.replace(/[\[\]]/g, "")}](talaris-file:${href})`;
}

export interface Mentions {
  /**
   * What matches. One with `make` is not a thing yet (someone in an address
   * book): chosen, it is made, and the mention points at what was made.
   */
  search(query: string): Promise<Array<MentionFound>>;
  /** Make something new by this name: a person, unless another kind is chosen. */
  create?(name: string, kind: string): Promise<{ id: string; title: string }>;
  open?(id: string): void;
}

export interface MentionFound {
  id: string;
  title: string;
  kind?: string;
  /** Shown beside it: an address, say, to tell two of a name apart. */
  detail?: string;
  make?(): Promise<{ id: string; title: string }>;
}

export interface Editor {
  readonly text: string;
  set(text: string): void;
  setLive(live: boolean): void;
  /**
   * The selected words in a color, or plain with `null`. With nothing
   * selected, the colored span the cursor is in takes the color (or loses it).
   * Answers whether anything changed.
   */
  setColor(color: string | null): boolean;
  /** Whether any text is selected: what a color would apply to. */
  readonly selecting: boolean;
  focus(): void;
  /** Words put in at the cursor, replacing what is selected (files chosen elsewhere, linked). */
  insert(text: string): void;
  destroy(): void;
}

export function createEditor(host: HTMLElement, text: string, options: EditorOptions = {}): Editor {
  // Each file kept, then all of them linked where they landed, in the order given.
  const keepFiles = async (v: EditorView, files: File[], at: number) => {
    const links: string[] = [];
    for (const f of files) {
      try {
        const kept = await options.files!.attach(f);
        links.push(fileLink(kept.name, kept.path));
      } catch {
        // The page says what went wrong; the rest are still kept.
      }
    }
    if (!links.length) return;
    const text = links.join(" ") + " ";
    const pos = Math.min(at, v.state.doc.length);
    v.dispatch({ changes: { from: pos, insert: text }, selection: EditorSelection.cursor(pos + text.length) });
    v.focus();
  };
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
        keymap.of([
          { key: "Tab", run: listShift(1), shift: listShift(-1) },
          { key: "Tab", run: indentMore, shift: indentLess },
          ...foldKeymap,
          ...defaultKeymap,
          ...historyKeymap,
        ]),
        options.mentions ? mentionPicker(options.mentions) : [],
        options.placeholder ? placeholder(options.placeholder) : [],
        options.singleLine ? Prec.highest(keymap.of([{ key: "Enter", run: () => { options.onEnter?.(); return true; } }])) : [],
        listFolding,
        codeFolding({ placeholderText: "…" }),
        options.compact ? [] : [foldGutter({ markerDOM: chevron }), listDrag],
        options.compact ? compactLook : [],
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
            const url = link.dataset.url;
            if (url.startsWith("talaris:")) options.mentions?.open?.(url.slice("talaris:".length));
            else if (url.startsWith("talaris-file:")) options.files?.open(decodeURI(url.slice("talaris-file:".length)).replace(/%28/g, "(").replace(/%29/g, ")"));
            else options.onOpenUrl?.(url);
            return true;
          },
          drop: (event, v) => {
            const files = Array.from(event.dataTransfer?.files ?? []);
            if (!options.files || !files.length) return false;
            event.preventDefault();
            const at = v.posAtCoords({ x: event.clientX, y: event.clientY }) ?? v.state.selection.main.head;
            void keepFiles(v, files, at);
            return true;
          },
          paste: (event, v) => {
            const files = Array.from(event.clipboardData?.files ?? []);
            if (!options.files || !files.length) return false;
            event.preventDefault();
            void keepFiles(v, files, v.state.selection.main.head);
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
    get selecting() { return view.state.selection.ranges.some((r) => !r.empty); },
    setColor(color: string | null) {
      if (color && !/^#[0-9a-fA-F]{6}$/.test(color)) return false;
      const state = view.state;
      const changes: Array<{ from: number; to: number; insert: string }> = [];
      for (const r of state.selection.ranges) {
        if (!r.empty) {
          changes.push({ from: r.from, to: r.to, insert: colored(state.doc.sliceString(r.from, r.to), color) });
          continue;
        }
        // No selection: the colored span around the cursor, if there is one.
        const line = state.doc.lineAt(r.head);
        for (const m of line.text.matchAll(COLOR_SPAN)) {
          const start = line.from + (m.index ?? 0);
          const end = start + m[0].length;
          if (r.head >= start && r.head <= end) changes.push({ from: start, to: end, insert: colored(m[2] ?? "", color) });
        }
      }
      if (!changes.length) return false;
      view.dispatch({ changes, userEvent: "input.color" });
      view.focus();
      return true;
    },
    setLive(on: boolean) {
      live = on;
      view.dom.classList.toggle("raw", !on);
      view.dispatch({ effects: preview.reconfigure(liveOn(on)) });
    },
    focus() { view.focus(); },
    insert(text: string) {
      const r = view.state.selection.main;
      view.dispatch({ changes: { from: r.from, to: r.to, insert: text }, selection: EditorSelection.cursor(r.from + text.length) });
      view.focus();
    },
    destroy() { view.destroy(); },
  };
}

// ---------------------------------------------------------------- @ mentions

/**
 * The `@` picker: typed after a space (or at the start), `@Ch…` searches as it
 * is typed; Enter takes the first, a click any, and the last choices make it
 * new — a person, unless another kind is chosen. What goes in is a Markdown
 * link, `[@Name](talaris:id)`, which the live view draws as a chip.
 */
const KIND_WORD: Record<string, string> = { contact: "person", event: "event", task: "task", note: "note", project: "project", page: "page", canvas: "canvas" };

function mentionPicker(m: Mentions) {
  const insert = (view: EditorView, from: number, to: number, id: string, title: string) => {
    const text = `[@${title.replace(/[\[\]]/g, "")}](talaris:${id}) `;
    view.dispatch({ changes: { from, to, insert: text }, selection: EditorSelection.cursor(from + text.length) });
  };
  const source = async (context: CompletionContext): Promise<CompletionResult | null> => {
    const typed = context.matchBefore(/(?:^|[\s(])@[^\s@\[\]()]*(?: [^\s@\[\]()]+){0,2}$/);
    if (!typed) return null;
    const at = typed.from + typed.text.indexOf("@");
    const query = context.state.sliceDoc(at + 1, context.pos);
    let found: MentionFound[] = [];
    try { found = await m.search(query); } catch { found = []; }
    if (context.aborted) return null;
    const options: Completion[] = found.slice(0, 10).map((f) => ({
      label: f.title, detail: f.detail ?? KIND_WORD[f.kind ?? ""] ?? f.kind ?? "",
      apply: (view, _c, _from, to) => {
        if (f.make) void f.make().then((made) => insert(view, at, to, made.id, made.title));
        else insert(view, at, to, f.id, f.title);
      },
    }));
    const name = query.trim();
    if (name && m.create) {
      for (const kind of ["person", "task", "note", "project"]) {
        options.push({
          label: kind === "person" ? `New: ${name}` : `New ${kind}: ${name}`, detail: kind === "person" ? "person" : "", boost: -99,
          apply: (view, _c, _from, to) => { void m.create!(name, kind).then((made) => insert(view, at, to, made.id, made.title)); },
        });
      }
    }
    return { from: at + 1, options, filter: false };
  };
  return autocompletion({ override: [source], activateOnTyping: true, icons: false, closeOnBlur: true });
}
