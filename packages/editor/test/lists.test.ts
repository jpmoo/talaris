// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore

import { test } from "node:test";
import assert from "node:assert/strict";
import { EditorState } from "@codemirror/state";
import { ensureSyntaxTree } from "@codemirror/language";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { listItemAt, moveListItem } from "../src/lists.ts";

function move(doc: string, line: number, to: number): string {
  const state = EditorState.create({ doc, extensions: [markdown({ base: markdownLanguage })] });
  ensureSyntaxTree(state, doc.length, 5000);
  const ref = listItemAt(state, state.doc.line(line).from);
  assert.ok(ref, `line ${line} is a list item`);
  const change = moveListItem(state, ref, to);
  return change ? state.update({ changes: change }).state.doc.toString() : doc;
}

test("a bulleted item moves; everything around the list is untouched", () => {
  assert.equal(move("Before\n\n- a\n- b\n- c\n\nAfter", 3, 2), "Before\n\n- b\n- c\n- a\n\nAfter");
  assert.equal(move("- a\n- b\n- c", 5 - 2, 0), "- c\n- a\n- b");
});

test("an item takes its nested children with it", () => {
  assert.equal(move("- a\n  - a1\n  - a2\n- b", 1, 1), "- b\n- a\n  - a1\n  - a2");
});

test("a nested item moves among its own siblings only", () => {
  assert.equal(move("- a\n  - a1\n  - a2\n- b", 3, 0), "- a\n  - a2\n  - a1\n- b");
});

test("tasks keep their boxes exactly", () => {
  assert.equal(move("- [ ] one\n- [x] two", 2, 0), "- [x] two\n- [ ] one");
});

test("a numbered list renumbers from where it started", () => {
  assert.equal(move("3. c\n4. d\n5. e", 3, 0), "3. e\n4. c\n5. d");
  assert.equal(move("1) a\n2) b", 1, 1), "1) b\n2) a");
});

test("a loose list stays loose", () => {
  assert.equal(move("- a\n\n- b\n\n- c", 1, 2), "- b\n\n- c\n\n- a");
});

test("moving to where it already is changes nothing", () => {
  assert.equal(move("- a\n- b", 1, 0), "- a\n- b");
});
