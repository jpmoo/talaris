// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore

/**
 * Reordering a list, as a change to the text.
 *
 * An item moves with everything nested under it — it is the item's lines from
 * its marker to the end of its last child. The spacing between items stays in
 * place, so a loose list stays loose. A numbered list is renumbered
 * from the number it started at; a bulleted or task list keeps its markers
 * exactly. Nothing outside the list is touched.
 */

import { syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";
import type { SyntaxNode } from "@lezer/common";

export interface ListRef {
  /** The sibling items, as line-aligned ranges, in document order. */
  items: Array<{ from: number; to: number }>;
  /** Which of them was asked about. */
  index: number;
  ordered: boolean;
}

/** The list item whose marker is on the line starting at `lineFrom`, with its siblings. */
export function listItemAt(state: EditorState, lineFrom: number): ListRef | null {
  const line = state.doc.lineAt(lineFrom);
  const indent = /^\s*/.exec(line.text)?.[0].length ?? 0;
  let node: SyntaxNode | null = syntaxTree(state).resolveInner(line.from + indent, 1);
  while (node && !(node.name === "ListItem" && state.doc.lineAt(node.from).from === line.from)) node = node.parent;
  if (!node?.parent) return null;
  const list = node.parent;
  const items: Array<{ from: number; to: number }> = [];
  let index = -1;
  for (let c = list.firstChild; c; c = c.nextSibling) {
    if (c.name !== "ListItem") continue;
    if (c.from === node.from) index = items.length;
    items.push({ from: state.doc.lineAt(c.from).from, to: state.doc.lineAt(c.to).to });
  }
  return index < 0 ? null : { items, index, ordered: list.name === "OrderedList" };
}

/**
 * The change that moves item `ref.index` so it ends up at position `to` among
 * its siblings. Returns null when it would not move.
 */
export function moveListItem(state: EditorState, ref: ListRef, to: number): { from: number; to: number; insert: string } | null {
  const n = ref.items.length;
  const target = Math.max(0, Math.min(n - 1, to));
  if (target === ref.index || n < 2) return null;
  const doc = state.doc;
  const from = ref.items[0]!.from;
  const end = ref.items[n - 1]!.to;
  // Items move; the gaps between them stay where they are. So a loose list
  // stays loose wherever an item lands, and nothing is added at the end.
  const texts = ref.items.map((item) => doc.sliceString(item.from, item.to));
  const gaps = ref.items.slice(0, -1).map((item, i) => doc.sliceString(item.to, ref.items[i + 1]!.from));
  const [moved] = texts.splice(ref.index, 1);
  texts.splice(target, 0, moved!);
  let next = texts;
  if (ref.ordered) {
    const first = /^\s*(\d+)/.exec(doc.sliceString(from, ref.items[0]!.to));
    let count = first ? Number(first[1]) : 1;
    next = texts.map((t) => t.replace(/^(\s*)\d+([.)])/, (_m, sp: string, d: string) => `${sp}${count++}${d}`));
  }
  const insert = next.map((t, i) => t + (gaps[i] ?? "")).join("");
  return { from, to: end, insert };
}
