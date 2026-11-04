// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore

/*
 * Find in what is written: Ctrl+F, a box above the words, each match marked and
 * how many said; Enter the next and Shift+Enter the one before, round and round;
 * Escape back to the words, with the one reached chosen. Found as everything is
 * found, case and accents aside, but as the words typed together: this is for
 * the place a phrase is, not for what a note is about.
 */

import { type EditorState, EditorSelection, type Extension, Prec, StateEffect, StateField } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, type Panel, keymap, showPanel } from "@codemirror/view";

export interface Match { from: number; to: number }

/** The words with case and accents aside, and where in them each folded letter came from. */
function folded(text: string): { fold: string; at: number[] } {
  let fold = "";
  const at: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const f = text[i]!.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
    for (let k = 0; k < f.length; k++) { fold += f[k]; at.push(i); }
  }
  return { fold, at };
}

/** Every place the words are, in order, none overlapping. */
export function matchesIn(text: string, query: string): Match[] {
  const q = folded(query).fold;
  if (!q) return [];
  const { fold, at } = folded(text);
  const out: Match[] = [];
  for (let i = fold.indexOf(q); i >= 0; i = fold.indexOf(q, i + q.length)) {
    out.push({ from: at[i]!, to: at[i + q.length - 1]! + 1 });
  }
  return out;
}

/** Which match to be on, from a place in the words: the first at or after it, else round to the first. */
export function nearest(matches: Match[], pos: number): number {
  if (!matches.length) return -1;
  const i = matches.findIndex((m) => m.from >= pos);
  return i < 0 ? 0 : i;
}

interface Finding { open: boolean; query: string; matches: Match[]; on: number }
const CLOSED: Finding = { open: false, query: "", matches: [], on: -1 };

const opened = StateEffect.define<{ query: string }>();
const typed = StateEffect.define<{ query: string; pos: number }>();
const moved = StateEffect.define<number>();
const closed = StateEffect.define<null>();

const finding = StateField.define<Finding>({
  create: () => CLOSED,
  update(f, tr) {
    let next = f;
    if (tr.docChanged && f.open) {
      const matches = matchesIn(tr.newDoc.toString(), f.query);
      const was = f.matches[f.on];
      next = { ...f, matches, on: nearest(matches, was ? tr.changes.mapPos(was.from) : 0) };
    }
    for (const e of tr.effects) {
      if (e.is(opened) || e.is(typed)) {
        const matches = matchesIn(tr.newDoc.toString(), e.value.query);
        const pos = e.is(typed) ? e.value.pos : tr.newSelection.main.from;
        next = { open: true, query: e.value.query, matches, on: nearest(matches, pos) };
      } else if (e.is(moved)) next = { ...next, on: e.value };
      else if (e.is(closed)) next = CLOSED;
    }
    return next;
  },
  provide: (f) => [
    showPanel.from(f, (x) => (x.open ? findPanel : null)),
    EditorView.decorations.from(f, marks),
  ],
});

const found = Decoration.mark({ class: "cm-found" });
const foundNow = Decoration.mark({ class: "cm-found cm-found-now" });
function marks(f: Finding): DecorationSet {
  return Decoration.set(f.matches.map((m, i) => (i === f.on ? foundNow : found).range(m.from, m.to)));
}

const box = (v: EditorView) => v.dom.querySelector<HTMLInputElement>(".cm-find input");
const scrollTo = (m: Match | undefined) => (m ? [EditorView.scrollIntoView(m.from, { y: "center" })] : []);

/** The next match, or the one before: round and round. */
function step(v: EditorView, by: number): boolean {
  const f = v.state.field(finding);
  if (!f.open || !f.matches.length) return f.open;
  const on = (f.on + by + f.matches.length) % f.matches.length;
  v.dispatch({ effects: [moved.of(on), ...scrollTo(f.matches[on])] });
  return true;
}

/** Back to the words, with the match reached chosen, so what comes next starts there. */
function finish(v: EditorView): boolean {
  const f = v.state.field(finding);
  if (!f.open) return false;
  const m = f.matches[f.on];
  v.dispatch({ effects: closed.of(null), ...(m ? { selection: EditorSelection.range(m.from, m.to) } : {}) });
  v.focus();
  return true;
}

/** The box out, with what is selected in it if that is words on one line. */
export function openFind(v: EditorView): boolean {
  const f = v.state.field(finding);
  const sel = v.state.selection.main;
  const words = v.state.sliceDoc(sel.from, sel.to);
  const query = words && !words.includes("\n") ? words : f.query;
  if (!f.open || query !== f.query) {
    const start = matchesIn(v.state.doc.toString(), query);
    v.dispatch({ effects: [opened.of({ query }), ...scrollTo(start[nearest(start, sel.from)])] });
  }
  const input = box(v);
  if (input) { input.value = query; input.focus(); input.select(); }
  return true;
}

function findPanel(v: EditorView): Panel {
  const input = document.createElement("input");
  input.type = "search";
  input.className = "field";
  input.placeholder = "Find";
  input.spellcheck = false;
  const count = document.createElement("span");
  count.className = "cm-find-n";
  const button = (cls: string, label: string, title: string, act: () => void) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = cls;
    b.textContent = label;
    b.title = title;
    b.setAttribute("aria-label", title);
    // Pressed, the focus stays in the box.
    b.addEventListener("mousedown", (e) => e.preventDefault());
    b.addEventListener("click", act);
    return b;
  };
  const dom = document.createElement("div");
  dom.className = "cm-find";
  dom.append(input, count,
    button("t-btn small", "↑", "Previous", () => step(v, -1)),
    button("t-btn small", "↓", "Next", () => step(v, 1)),
    button("t-btn small", "×", "Close", () => finish(v)));
  const say = (s: EditorState) => {
    const f = s.field(finding);
    count.textContent = !f.query ? "" : f.matches.length ? `${f.on + 1} of ${f.matches.length}` : "None";
    if (input.value !== f.query && document.activeElement !== input) input.value = f.query;
  };
  input.addEventListener("input", () => {
    const start = matchesIn(v.state.doc.toString(), input.value);
    const pos = v.state.selection.main.from;
    v.dispatch({ effects: [typed.of({ query: input.value, pos }), ...scrollTo(start[nearest(start, pos)])] });
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); step(v, e.shiftKey ? -1 : 1); }
    // Heard here first, so the page does not close round it.
    else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); finish(v); }
  });
  return { dom, top: true, mount: () => { say(v.state); input.focus(); input.select(); }, update: (u) => say(u.state) };
}

const findLook = EditorView.theme({
  ".cm-panels": { backgroundColor: "transparent", color: "inherit" },
  ".cm-panels-top": { borderBottom: "1px solid var(--line)" },
  ".cm-find": { display: "flex", alignItems: "center", gap: "6px", padding: "4px 6px" },
  ".cm-find input": { flex: "1 1 120px", minWidth: "60px", maxWidth: "280px", font: "inherit", fontSize: "12.5px" },
  ".cm-find-n": { flex: "none", minWidth: "48px", color: "var(--muted)", fontSize: "11.5px", fontVariantNumeric: "tabular-nums" },
  ".cm-found": { backgroundColor: "var(--accent-wash)", borderRadius: "var(--radius-row)" },
  ".cm-found-now": { backgroundColor: "var(--accent-hover)", outline: "1px solid var(--accent)" },
});

export function findInText(): Extension {
  return [
    finding,
    findLook,
    Prec.high(keymap.of([
      { key: "Mod-f", run: openFind },
      { key: "Mod-g", run: (v) => step(v, 1), shift: (v) => step(v, -1) },
      { key: "Escape", run: finish },
    ])),
  ];
}
