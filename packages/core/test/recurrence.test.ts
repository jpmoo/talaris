// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { nextSpan, ruleErrors, type Rule } from "../src/recurrence.js";

// The format's own cases, read as they are: these are what "recurrence works"
// means, not this file's idea of it.
const FIXTURES = process.env.PKM_FIXTURES ?? join(homedir(), "Documents/Scripts/hermesnotes/pkm-interchange/fixtures");
const file = join(FIXTURES, "recurrence.json");
const cases: any[] = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")).cases : [];

for (const c of cases) {
  test(`fixture ${c.id}`, () => {
    if (c.op === "validate") {
      const rule: Rule = c.given.rule ?? c.given.export.series[0].rule;
      const codes = ruleErrors(rule, c.given.horizon ?? 1).map((e) => e.code);
      assert.equal(codes.length === 0, c.expect.valid, `errors: ${codes.join(", ")}`);
      for (const e of c.expect.errors ?? []) assert.ok(codes.includes(e.code), `expected ${e.code}, got ${codes.join(", ")}`);
      return;
    }
    const rule: Rule = c.given.rule;
    const instance = c.given.instance ?? {};
    const origin = instance.due;
    let span = nextSpan(rule, instance, c.when.completed, origin, c.given.instances?.length ?? 1);
    if (c.when.thenCompleted && span) span = nextSpan(rule, span, c.when.thenCompleted, origin, 2);
    if ("next" in c.expect) assert.equal(span, c.expect.next);
    if (c.expect.due) assert.equal(span?.due, c.expect.due);
    if (c.expect.start) assert.equal(span?.start, c.expect.start);
  });
}

test("the fixtures were found", { skip: cases.length ? false : "no pkm-interchange fixtures here" }, () => {
  assert.ok(cases.length >= 10);
});

test("a time on the due date is kept on the next one", () => {
  const s = nextSpan({ anchor: "schedule", freq: "daily", interval: 1 }, { due: "2026-10-24T09:30" }, "2026-10-24");
  assert.equal(s?.due, "2026-10-25T09:30");
});
