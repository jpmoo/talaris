// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore

import { test } from "node:test";
import assert from "node:assert/strict";
import { EditorState, EditorSelection } from "@codemirror/state";
import { ensureSyntaxTree } from "@codemirror/language";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { colored, liveSpecs, type Spec } from "../src/live.ts";

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
  const done = specs.find((s) => s.kind === "mark" && s.cls === "cm-task-done");
  assert.equal(done && away.doc.sliceString((done as any).from, (done as any).to), "pack", "only the words are struck");
});

test("bullets and boxes stay drawn while you type on their line", () => {
  const typing = at("- [ ] buy ro|pe\n- milk");
  const specs = liveSpecs(typing);
  assert.equal(specs.filter((s) => s.kind === "check").length, 1, "the box survives the cursor on its line");
  assert.equal(specs.filter((s) => s.kind === "bullet").length, 1);
  const inMarker = at("- [|x] done");
  assert.equal(liveSpecs(inMarker).filter((s) => s.kind === "check").length, 0, "inside the brackets, the source shows");
});

test("a task with tasks under it counts the whole branch", () => {
  const state = at("- [ ] trip\n  - [x] tent\n  - [ ] food\n    - [x] stove\n- [ ] alone\n|");
  const counts = liveSpecs(state).filter((s) => s.kind === "count") as Array<{ done: number; total: number; at: number }>;
  assert.equal(counts.length, 2, "trip, and food under it; a task with nothing under it has no count");
  assert.deepEqual(counts.map((c) => [c.done, c.total]), [[2, 3], [1, 1]]);
  assert.equal(counts[0]!.at, state.doc.line(1).to, "at the end of the parent's own line");
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

test("colored words show in their color, the tags hidden unless the cursor touches them", () => {
  const away = at('some <span style="color:#d50000">red</span> words\n|');
  const specs = liveSpecs(away);
  assert.deepEqual(hidden(away, specs), ['<span style="color:#d50000">', "</span>"]);
  const mark = specs.find((s) => s.kind === "mark" && s.cls === "cm-color");
  assert.ok(mark && mark.kind === "mark" && mark.color === "#d50000");
  assert.equal(away.doc.sliceString(mark.from, mark.to), "red");
  const inside = at('some <span style="color:#d50000">r|ed</span> words');
  assert.deepEqual(hidden(inside, liveSpecs(inside)), [], "touched, its source shows");
});

test("coloring undoes colors inside first, so colors never nest, and keeps to a line", () => {
  assert.equal(colored('a <span style="color:#d50000">b</span> c', "#039be5"), '<span style="color:#039be5">a b c</span>');
  assert.equal(colored('a <span style="color:#d50000">b</span> c', null), "a b c");
  assert.equal(colored("one\ntwo", "#33b679"), '<span style="color:#33b679">one</span>\n<span style="color:#33b679">two</span>');
});

test("an address written as it is, bare or in <>, is a link with its url", () => {
  const bare = at("|Join https://zoom.us/j/123?pwd=x here");
  const link = liveSpecs(bare).find((s) => s.kind === "mark" && s.cls === "cm-link");
  assert.equal(link && link.kind === "mark" ? link.url : "", "https://zoom.us/j/123?pwd=x");
  const angled = at("|See <https://example.org/a> now");
  const l2 = liveSpecs(angled).find((s) => s.kind === "mark" && s.cls === "cm-link");
  assert.equal(l2 && l2.kind === "mark" ? l2.url : "", "https://example.org/a");
  // Inside [text](url), the address is the link's, drawn once.
  const named = at("|A [call](https://zoom.us/j/9) now");
  assert.equal(liveSpecs(named).filter((s) => s.kind === "mark" && s.cls === "cm-link").length, 1);
});
