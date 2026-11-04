// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore

import { test } from "node:test";
import assert from "node:assert/strict";
import { matchesIn, nearest } from "../src/find.ts";

const words = (text: string, query: string) => matchesIn(text, query).map((m) => text.slice(m.from, m.to));

test("found with case and accents aside, and as the words typed together", () => {
  assert.deepEqual(words("Café and CAFE and cafés", "cafe"), ["Café", "CAFE", "café"]);
  assert.deepEqual(words("the reserve fund, fund reserve", "reserve fund"), ["reserve fund"]);
  assert.deepEqual(matchesIn("anything", ""), []);
});

test("a place is a place in the words as written, even where a letter is written in two", () => {
  const text = "x café y";
  const [m] = matchesIn(text, "cafe");
  assert.equal(text.slice(m!.from, m!.to), "cafe");
  assert.deepEqual(words("aaaa", "aa"), ["aa", "aa"], "none overlapping");
});

test("the one to be on: the first at or after the cursor, else round to the first", () => {
  const m = [{ from: 2, to: 3 }, { from: 8, to: 9 }];
  assert.equal(nearest(m, 0), 0);
  assert.equal(nearest(m, 5), 1);
  assert.equal(nearest(m, 9), 0);
  assert.equal(nearest([], 3), -1);
});
