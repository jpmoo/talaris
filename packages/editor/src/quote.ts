// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore

/*
 * A page's lines given a shape Markdown has a word for: a quote (`>`, a level
 * per press — Markdown's way to set words in, since its indents are a list's
 * nesting and code's four spaces), or a code block (fenced, ```), around the
 * lines chosen or taken away from around the one the cursor is in.
 */

import { syntaxTree } from "@codemirror/language";
import type { EditorState, StateCommand } from "@codemirror/state";

/** The lines the selection touches, each once, in order. */
function chosenLines(state: EditorState): Array<{ from: number; to: number; text: string; number: number }> {
  const out: Array<{ from: number; to: number; text: string; number: number }> = [];
  const seen = new Set<number>();
  for (const r of state.selection.ranges) {
    for (let n = state.doc.lineAt(r.from).number; n <= state.doc.lineAt(r.to).number; n++) {
      if (seen.has(n)) continue;
      seen.add(n);
      const l = state.doc.line(n);
      out.push({ from: l.from, to: l.to, text: l.text, number: n });
    }
  }
  return out.sort((a, b) => a.number - b.number);
}

/** The fenced code block a position is in, if it is in one. */
/** The code a position is in, looked for on either side of it (at a line's end, or the page's, it is just before). */
function codeAt(state: EditorState, pos: number, names: string[]): { from: number; to: number } | null {
  for (const side of [1, -1] as const) {
    for (let at: ReturnType<typeof syntaxTree>["topNode"] | null = syntaxTree(state).resolveInner(pos, side); at; at = at.parent) {
      if (names.includes(at.name)) return { from: at.from, to: at.to };
    }
  }
  return null;
}
const fenceAt = (state: EditorState, pos: number) => codeAt(state, pos, ["FencedCode"]);
/** Whether a position is in code, fenced or indented: where a quote never goes, and Tab indents as code does. */
export const inCode = (state: EditorState, pos: number): boolean => codeAt(state, pos, ["FencedCode", "CodeBlock"]) !== null;

/**
 * A quote level more (`dir` 1) or one fewer (-1) on the lines chosen — any
 * words, a list's too ("> - item"), never code. Blank lines in a selection are
 * left as they are; the quote runs across them.
 */
export function quoteLevel(dir: 1 | -1): StateCommand {
  return ({ state, dispatch }) => {
    const lines = chosenLines(state);
    if (lines.some((l) => inCode(state, l.from))) return false;
    const several = lines.length > 1;
    const changes: Array<{ from: number; to?: number; insert?: string }> = [];
    for (const l of lines) {
      if (several && !l.text.trim()) continue;
      if (dir > 0) changes.push({ from: l.from, insert: "> " });
      else {
        const m = /^(\s*)>\s?/.exec(l.text);
        if (m) changes.push({ from: l.from + m[1]!.length, to: l.from + m[0].length });
      }
    }
    if (!changes.length) return false;
    dispatch(state.update({ changes, scrollIntoView: true, userEvent: dir > 0 ? "input.quote" : "delete.quote" }));
    return true;
  };
}

/** Whether the cursor's line is quoted: what Unquote would take a level from. */
export const quoted = (state: EditorState): boolean => /^\s*>/.test(state.doc.lineAt(state.selection.main.head).text);

/**
 * A code block: the lines chosen fenced (```), or — the cursor in one already —
 * its fences taken away, its lines left as they are.
 */
export const toggleCodeBlock: StateCommand = ({ state, dispatch }) => {
  const head = state.selection.main.head;
  const fence = fenceAt(state, head);
  if (fence) {
    const first = state.doc.lineAt(fence.from), last = state.doc.lineAt(fence.to);
    const changes: Array<{ from: number; to: number }> = [];
    // The closing fence (if it is there: an unclosed block runs to the end), then the opening one, each with its break.
    if (last.number > first.number && /^\s*(```|~~~)/.test(last.text)) changes.push({ from: last.from - 1, to: last.to });
    changes.push({ from: first.from, to: Math.min(first.to + 1, state.doc.length) });
    dispatch(state.update({ changes, scrollIntoView: true, userEvent: "delete.code" }));
    return true;
  }
  const lines = chosenLines(state);
  const from = lines[0]!.from, to = lines[lines.length - 1]!.to;
  dispatch(state.update({
    changes: [{ from, insert: "```\n" }, { from: to, insert: "\n```" }],
    selection: { anchor: from + 4 + (head - from) },
    scrollIntoView: true, userEvent: "input.code",
  }));
  return true;
};
