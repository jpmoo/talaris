// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore

/**
 * Live preview, as rules: given the document and where the cursor is, what to
 * hide, what to style, what to draw instead.
 *
 * Kept apart from CodeMirror's view so it can be tested without a screen. The
 * editor turns these into decorations; nothing here touches the text, which is
 * the point of the design — **the document is the file at every moment**, and
 * live preview only changes how it looks. Nothing is converted, so nothing can
 * be lost in conversion.
 *
 * **What reveals the Markdown, and how much.** Block marks — `#`, `>`, list
 * bullets, task boxes, rules — show on the line the cursor is on, the way
 * Obsidian does it. Inline marks — `**`, `_`, backticks, a link's address —
 * show only while the cursor is inside or touching that one span, so typing in
 * one bold word does not unwrap every other on the line.
 */

import { syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";

export type Spec =
  | { kind: "hide"; from: number; to: number }
  | { kind: "mark"; from: number; to: number; cls: string; url?: string }
  | { kind: "line"; at: number; cls: string }
  | { kind: "bullet"; from: number; to: number }
  | { kind: "check"; from: number; to: number; checked: boolean }
  | { kind: "rule"; from: number; to: number };

const HEADINGS: Record<string, number> = {
  ATXHeading1: 1, ATXHeading2: 2, ATXHeading3: 3, ATXHeading4: 4, ATXHeading5: 5, ATXHeading6: 6,
  SetextHeading1: 1, SetextHeading2: 2,
};

const INLINE: Record<string, string> = {
  Emphasis: "cm-em",
  StrongEmphasis: "cm-strong",
  InlineCode: "cm-inline-code",
  Strikethrough: "cm-strike",
};

const INLINE_MARKS = new Set(["EmphasisMark", "CodeMark", "StrikethroughMark"]);

export function liveSpecs(state: EditorState, from = 0, to = state.doc.length): Spec[] {
  const specs: Spec[] = [];
  const sel = state.selection.ranges;
  const activeLines = new Set<number>();
  for (const r of sel) {
    for (let n = state.doc.lineAt(r.from).number; n <= state.doc.lineAt(r.to).number; n++) activeLines.add(n);
  }
  const lineActive = (pos: number) => activeLines.has(state.doc.lineAt(pos).number);
  // Touching counts: the cursor just after `**bold**` still shows its marks,
  // or it would be impossible to keep typing inside them.
  const touched = (a: number, b: number) => sel.some((r) => r.from <= b && r.to >= a);
  const lineStarts = (a: number, b: number, cls: string) => {
    for (let n = state.doc.lineAt(a).number; n <= state.doc.lineAt(b).number; n++) {
      specs.push({ kind: "line", at: state.doc.line(n).from, cls });
    }
  };

  syntaxTree(state).iterate({
    from,
    to,
    enter: (node) => {
      const name = node.name;

      const level = HEADINGS[name];
      if (level) {
        lineStarts(node.from, node.to, `cm-h${level}`);
        return;
      }
      if (name === "HeaderMark") {
        if (lineActive(node.from)) return;
        // The space after `#` goes with it, so the heading starts flush.
        const after = state.doc.sliceString(node.to, node.to + 1) === " " ? 1 : 0;
        // A setext underline (`===`) sits on its own line; hiding it leaves
        // the heading's line looking like a heading, which is what it is.
        specs.push({ kind: "hide", from: node.from, to: node.to + after });
        return;
      }

      const cls = INLINE[name];
      if (cls) {
        specs.push({ kind: "mark", from: node.from, to: node.to, cls });
        if (touched(node.from, node.to)) return false;
        const cursor = node.node.cursor();
        if (cursor.firstChild()) {
          do {
            if (INLINE_MARKS.has(cursor.name)) specs.push({ kind: "hide", from: cursor.from, to: cursor.to });
          } while (cursor.nextSibling());
        }
        return;
      }

      if (name === "Link") {
        const open = touched(node.from, node.to);
        const c = node.node.cursor();
        const marks: Array<{ from: number; to: number }> = [];
        let url = "";
        if (c.firstChild()) {
          do {
            if (c.name === "LinkMark") marks.push({ from: c.from, to: c.to });
            if (c.name === "URL") url = state.doc.sliceString(c.from, c.to);
          } while (c.nextSibling());
        }
        // `[text](url)`: the text is between the first two marks.
        const textFrom = marks[0]?.to ?? node.from;
        const textTo = marks[1]?.from ?? node.to;
        specs.push({ kind: "mark", from: textFrom, to: textTo, cls: "cm-link", url });
        if (open || marks.length < 2) return false;
        specs.push({ kind: "hide", from: node.from, to: textFrom });
        specs.push({ kind: "hide", from: textTo, to: node.to });
        return false;
      }

      if (name === "Blockquote") {
        lineStarts(node.from, node.to, "cm-quote");
        return;
      }
      if (name === "QuoteMark") {
        if (lineActive(node.from)) return;
        const after = state.doc.sliceString(node.to, node.to + 1) === " " ? 1 : 0;
        specs.push({ kind: "hide", from: node.from, to: node.to + after });
        return;
      }

      if (name === "FencedCode" || name === "CodeBlock") {
        lineStarts(node.from, node.to, "cm-codeblock");
        return false;
      }

      if (name === "HorizontalRule") {
        if (!lineActive(node.from)) specs.push({ kind: "rule", from: node.from, to: node.to });
        return;
      }

      if (name === "ListMark") {
        if (lineActive(node.from)) return;
        const mark = state.doc.sliceString(node.from, node.to);
        if (!/^[-*+]$/.test(mark)) return; // a number stays a number
        // A task's bullet gives way to its box entirely, as in Obsidian.
        const task = node.node.parent?.getChild("Task");
        const after = state.doc.sliceString(node.to, node.to + 1) === " " ? 1 : 0;
        if (task) specs.push({ kind: "hide", from: node.from, to: node.to + after });
        else specs.push({ kind: "bullet", from: node.from, to: node.to });
        return;
      }
      if (name === "TaskMarker") {
        const checked = /x/i.test(state.doc.sliceString(node.from, node.to));
        if (checked) lineStarts(node.from, node.from, "cm-task-done");
        if (!lineActive(node.from)) specs.push({ kind: "check", from: node.from, to: node.to, checked });
        return;
      }
      return;
    },
  });
  return specs;
}
