// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore

import { test } from "node:test";
import assert from "node:assert/strict";
import { EditorState, EditorSelection } from "@codemirror/state";
import { ensureSyntaxTree } from "@codemirror/language";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { liveSpecs, type Spec } from "../src/live.ts";

/** The document, with the cursor where `|` is. */
function at(text: string): EditorState {
  const pos = text.indexOf("|");
  const doc = text.replace("|", "");
  const state = EditorState.create({
    doc,
    selection: EditorSelection.cursor(pos < 0 ? 0 : pos),
    extensions: [markdown({ base: markdownLanguage })],
  });
  ensureSyntaxTree(state, doc.length, 5000);
  return state;
}

const hidden = (state: EditorState, specs: Spec[]) =>
  specs.filter((s) => s.kind === "hide").map((s) => state.doc.sliceString(s.from, s.to));

test("a heading's # hides off its line and shows on it", () => {
  const away = at("# Title\n\n|body");
  assert.deepEqual(hidden(away, liveSpecs(away)), ["# "]);
  assert.ok(liveSpecs(away).some((s) => s.kind === "line" && s.cls === "cm-h1"));
  const on = at("# Ti|tle\n\nbody");
  assert.deepEqual(hidden(on, liveSpecs(on)), []);
  assert.ok(liveSpecs(on).some((s) => s.kind === "line" && s.cls === "cm-h1"), "still a heading while you type it");
});

test("bold marks hide unless the cursor is in that span, not merely on that line", () => {
  const away = at("some **bold** and **more**\n|");
  assert.deepEqual(hidden(away, liveSpecs(away)), ["**", "**", "**", "**"]);
  const inFirst = at("some **bo|ld** and **more**");
  assert.deepEqual(hidden(inFirst, liveSpecs(inFirst)), ["**", "**"], "the other bold word stays rendered");
  assert.ok(liveSpecs(inFirst).some((s) => s.kind === "mark" && s.cls === "cm-strong"));
});

test("a link shows its text and hides its address until the cursor is in it", () => {
  const away = at("see [the wiki](https://wiki.example) now\n|");
  const specs = liveSpecs(away);
  assert.deepEqual(hidden(away, specs), ["[", "](https://wiki.example)"]);
  const link = specs.find((s) => s.kind === "mark" && s.cls === "cm-link");
  assert.equal(link && "url" in link ? link.url : "", "https://wiki.example");
  const inside = at("see [the w|iki](https://wiki.example) now");
  assert.deepEqual(hidden(inside, liveSpecs(inside)), []);
});

test("a task's bullet goes and its box is drawn, off its line", () => {
  const away = at("- [ ] buy rope\n- [x] pack\n|");
  const specs = liveSpecs(away);
  assert.deepEqual(specs.filter((s) => s.kind === "check").map((s) => (s as any).checked), [false, true]);
  assert.deepEqual(hidden(away, specs), ["- ", "- "]);
  assert.ok(specs.some((s) => s.kind === "line" && s.cls === "cm-task-done"));
});

test("a plain bullet becomes a dot; a number stays a number", () => {
  const away = at("- one\n1. first\n|");
  const specs = liveSpecs(away);
  assert.equal(specs.filter((s) => s.kind === "bullet").length, 1);
  assert.deepEqual(hidden(away, specs), []);
});

test("code spans and blocks are styled, and their fences hide only for spans", () => {
  const away = at("use `pnpm` here\n\n```js\nlet x = 1;\n```\n|");
  const specs = liveSpecs(away);
  assert.deepEqual(hidden(away, specs), ["`", "`"]);
  assert.equal(specs.filter((s) => s.kind === "line" && s.cls === "cm-codeblock").length, 3);
});

test("nothing is ever written: specs describe, the document is untouched", () => {
  const state = at("# A\n\n**b** [c](d)\n- [ ] e\n|");
  const before = state.doc.toString();
  liveSpecs(state);
  assert.equal(state.doc.toString(), before);
});
