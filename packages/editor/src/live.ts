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
 *
 * **Colored words** are `<span style="color:#rrggbb">words</span>` — plain HTML,
 * which Markdown carries and other editors (Obsidian among them) show in
 * color. Markdown has no color of its own, and a syntax of Talaris's own would
 * be lost anywhere else. The tags are inline marks like the rest: hidden but
 * while the cursor touches them.
 */

/** A colored span, as `setColor` writes it: the color is a hex `#rrggbb`. */
export const COLOR_SPAN = /<span style="color:\s*(#[0-9a-fA-F]{6})">([^<\n]*)<\/span>/g;

import { syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";

export type Spec =
  | { kind: "hide"; from: number; to: number }
  | { kind: "mark"; from: number; to: number; cls: string; url?: string; color?: string }
  | { kind: "line"; at: number; cls: string }
  | { kind: "bullet"; from: number; to: number }
  | { kind: "check"; from: number; to: number; checked: boolean }
  | { kind: "rule"; from: number; to: number }
  | { kind: "count"; at: number; done: number; total: number };

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

      /*
       * Bullets and task boxes stay drawn while you type on their line — a box
       * that turned back into `[ ]` whenever the cursor came near was a box you
       * could not click. Only a cursor in the marker itself shows its source.
       */
      if (name === "ListMark") {
        lineStarts(node.from, node.from, "cm-listline");
        const mark = state.doc.sliceString(node.from, node.to);
        if (!/^[-*+]$/.test(mark)) return; // a number stays a number
        const after = state.doc.sliceString(node.to, node.to + 1) === " " ? 1 : 0;
        // A task's bullet gives way to its box entirely, as in Obsidian.
        const task = node.node.parent?.getChild("Task")?.getChild("TaskMarker");
        const end = task ? task.to : node.to;
        if (sel.some((r) => r.from >= node.from && r.to <= end && r.from < end)) return;
        if (task) specs.push({ kind: "hide", from: node.from, to: node.to + after });
        else specs.push({ kind: "bullet", from: node.from, to: node.to });
        return;
      }
      /*
       * A task with tasks under it says how many of them are done, at the end
       * of its own line — counting every depth, so "2/5" is the whole branch.
       * It stays visible when the branch is collapsed, which is when it is
       * most useful.
       */
      if (name === "ListItem" && node.node.getChild("Task")) {
        let done = 0;
        let total = 0;
        for (const list of [node.node.getChild("BulletList"), node.node.getChild("OrderedList")]) {
          if (!list) continue;
          const c = list.cursor();
          do {
            if (c.name === "TaskMarker") {
              total++;
              if (/x/i.test(state.doc.sliceString(c.from, c.to))) done++;
            }
          } while (c.next() && c.from < list.to);
        }
        if (total) specs.push({ kind: "count", at: state.doc.lineAt(node.from).to, done, total });
      }
      if (name === "TaskMarker") {
        const checked = /x/i.test(state.doc.sliceString(node.from, node.to));
        // Struck through: the task's own words, not its indentation or its box.
        if (checked) {
          const line = state.doc.lineAt(node.from);
          const start = Math.min(line.to, node.to + 1);
          if (line.to > start) specs.push({ kind: "mark", from: start, to: line.to, cls: "cm-task-done" });
        }
        const mark = node.node.parent?.parent?.getChild("ListMark");
        const start = mark ? mark.from : node.from;
        if (sel.some((r) => r.from >= start && r.to <= node.to && r.from < node.to)) return;
        specs.push({ kind: "check", from: node.from, to: node.to, checked });
        return;
      }
      return;
    },
  });

  // Colored words: found in the text itself, a line at a time.
  for (let n = state.doc.lineAt(from).number; n <= state.doc.lineAt(Math.min(to, state.doc.length)).number; n++) {
    const line = state.doc.line(n);
    if (!line.text.includes("<span")) continue;
    for (const m of line.text.matchAll(COLOR_SPAN)) {
      const start = line.from + (m.index ?? 0);
      const end = start + m[0].length;
      const open = m[0].indexOf(">") + 1;
      const inner = { from: start + open, to: start + open + (m[2] ?? "").length };
      specs.push({ kind: "mark", from: inner.from, to: inner.to, cls: "cm-color", color: m[1] ?? "" });
      if (touched(start, end)) continue;
      specs.push({ kind: "hide", from: start, to: inner.from });
      specs.push({ kind: "hide", from: inner.to, to: end });
    }
  }
  return specs;
}

/**
 * The text between `from` and `to`, colored (or, with no color, plain): any
 * colored spans inside it are undone first, so colors never nest.
 */
export function colored(text: string, color: string | null): string {
  const plain = text.replace(COLOR_SPAN, "$2");
  if (!color || !plain) return plain;
  // A span keeps to one line: each line of a selection is colored by itself.
  return plain.split("\n").map((l) => (l ? `<span style="color:${color}">${l}</span>` : l)).join("\n");
}
