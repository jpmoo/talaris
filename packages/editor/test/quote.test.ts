// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore

import { test } from "node:test";
import assert from "node:assert/strict";
import { EditorSelection, EditorState, type StateCommand } from "@codemirror/state";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { ensureSyntaxTree } from "@codemirror/language";
import { quoteLevel, toggleCodeBlock } from "../src/quote.ts";

function run(cmd: StateCommand, doc: string, from: number, to = from): { doc: string; handled: boolean } {
  let state = EditorState.create({ doc, selection: EditorSelection.range(from, to), extensions: [markdown({ base: markdownLanguage })] });
  ensureSyntaxTree(state, doc.length, 5000);
  const handled = cmd({ state, dispatch: (tr) => { state = tr.state; } });
  return { doc: state.doc.toString(), handled };
}

test("a quote: a level in for each press, and out", () => {
  assert.equal(run(quoteLevel(1), "one\ntwo\nthree", 0, 7).doc, "> one\n> two\nthree", "each line touched");
  assert.equal(run(quoteLevel(1), "> one", 2).doc, "> > one", "a level deeper");
  assert.equal(run(quoteLevel(-1), "> > one", 4).doc, "> one", "a level out");
  assert.equal(run(quoteLevel(-1), "  > indented", 3).doc, "  indented", "its own spaces kept");
  assert.equal(run(quoteLevel(1), "- item", 3).doc, "> - item", "a list's words are quoted too");
  assert.equal(run(quoteLevel(1), "one\n\ntwo", 0, 8).doc, "> one\n\n> two", "blank lines between left");
  assert.equal(run(quoteLevel(1), "```\ncode\n```", 5).handled, false, "never code");
  assert.equal(run(quoteLevel(-1), "plain", 1).handled, false, "nothing to take");
});

test("a code block: fenced around the lines chosen, and unfenced", () => {
  assert.equal(run(toggleCodeBlock, "a\nb\nc", 2, 3).doc, "a\n```\nb\n```\nc");
  assert.equal(run(toggleCodeBlock, "a\n```\nb\n```\nc", 7).doc, "a\nb\nc", "the cursor in one: its fences gone");
  assert.equal(run(toggleCodeBlock, "```\nb", 5).doc, "b", "an unclosed one: its opening fence gone");
});
