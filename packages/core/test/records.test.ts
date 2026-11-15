// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore
//
// Sync's records (records.ts, docs/SYNC.md): what changed, field by field, in this machine's sealed log — only
// while this machine syncs; never what another machine's record changed; batched by action.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const sandbox = mkdtempSync(join(tmpdir(), "talaris-records-"));
process.env.TALARIS_DATA_DIR = join(sandbox, "data");
process.env.TALARIS_PROJECTS = join(sandbox, "Projects");
process.env.TALARIS_CONFIG_DIR = join(sandbox, "config");
process.env.TALARIS_STATE_DIR = join(sandbox, "state");
process.env.TALARIS_KEY = randomBytes(32).toString("base64");

const records = await import("../src/records.js");
const entities = await import("../src/entities.js");
after(() => rmSync(sandbox, { recursive: true, force: true }));
const turn = () => new Promise((r) => setImmediate(r));
const of = (id: string) => records.ownLog().filter((r) => r.of === `e:${id}`);

test("off until this machine syncs: nothing written", () => {
  entities.createEntity({ type: entities.typeFor("task").id, properties: { title: "Before" } });
  assert.equal(records.ownLog().length, 0);
});

test("a thing made: one record, every field it has", async () => {
  records.setSyncing(true);
  const e = entities.createEntity({ type: entities.typeFor("task").id, properties: { title: "Call Ann" }, tags: ["phone"] });
  const [r] = of(e.id);
  assert.equal(r!.set!["p.title"], "Call Ann");
  assert.deepEqual(r!.add!.tags, ["phone"]);
  assert.ok(!("version" in r!.set!) && !("updated" in r!.set!), "a machine's own bookkeeping does not travel");
  assert.equal(r!.at.m, records.machine().id);
  await turn();
});

test("a field changed: only that field travels", async () => {
  const e = entities.createEntity({ type: entities.typeFor("task").id, properties: { title: "Draft" } });
  await turn();
  entities.updateEntity(e.id, { properties: { title: "Draft budget" } });
  const last = of(e.id).pop()!;
  assert.deepEqual(Object.keys(last.set!), ["p.title"]);
  assert.equal(last.set!["p.title"], "Draft budget");
});

test("a set-like field: members added and removed, not the whole list", async () => {
  const proj = entities.typeFor("project").id;
  const a = entities.createEntity({ type: proj, properties: { title: "A" } });
  const b = entities.createEntity({ type: proj, properties: { title: "B" } });
  const t = entities.types().find((x) => x.id === entities.typeFor("task").id)!;
  const pk = t.fields.find((f) => f.kind === "reference" && f.many)!.key;
  const e = entities.createEntity({ type: t.id, properties: { title: "Two projects", [pk]: [a.id] } });
  entities.updateEntity(e.id, { properties: { [pk]: [b.id] } });
  const last = of(e.id).pop()!;
  assert.deepEqual(last.add![`p.${pk}`], [b.id]);
  assert.deepEqual(last.remove![`p.${pk}`], [a.id]);
  await turn();
});

test("a connection: a relation added, as a member", async () => {
  const person = entities.typeFor("person").id;
  const x = entities.createEntity({ type: person, properties: { title: "Ann" } });
  const y = entities.createEntity({ type: person, properties: { title: "Bob" } });
  entities.link({ from: x.id, to: y.id, type: "about" });
  const last = of(x.id).pop()!;
  assert.equal(last.add!.relations!.length, 1);
  assert.match(String(last.add!.relations![0]), /"to":"/);
  await turn();
});

test("deleted: a record saying so", () => {
  const e = entities.createEntity({ type: entities.typeFor("task").id, properties: { title: "Gone soon" } });
  entities.deleteEntity(e.id);
  assert.equal(of(e.id).pop()!.gone, true);
});

test("one action, one batch; the next turn, another", async () => {
  await turn();
  const a = entities.createEntity({ type: entities.typeFor("task").id, properties: { title: "One" } });
  const b = entities.createEntity({ type: entities.typeFor("task").id, properties: { title: "Two" } });
  await turn();
  const c = entities.createEntity({ type: entities.typeFor("task").id, properties: { title: "Three" } });
  assert.equal(of(a.id)[0]!.batch, of(b.id)[0]!.batch);
  assert.notEqual(of(a.id)[0]!.batch, of(c.id)[0]!.batch);
});

test("what another machine's record changed is not written out again", () => {
  const n = records.ownLog().length;
  records.whileApplying(() => entities.createEntity({ type: entities.typeFor("task").id, properties: { title: "From the mini" } }));
  assert.equal(records.ownLog().length, n);
});

test("the clock: later always compares later, even in one instant", () => {
  const a = records.tick(), b = records.tick();
  assert.ok(records.compare(a, b) < 0);
  records.observe({ t: Date.now() + 60_000, c: 3, m: "m_other" });
  const c = records.tick();
  assert.ok(c.t >= Date.now() + 59_000, "a machine ahead carries this clock forward");
});

test("the log is sealed: no field of a record readable in the file", () => {
  const dir = join(sandbox, "data", "sync", "log", records.machine().id);
  const text = readdirSync(dir).map((n) => readFileSync(join(dir, n), "utf8")).join("");
  assert.ok(!text.includes("Call Ann"));
});

test("a small sealed store: what changed in a record; a list's members as members", () => {
  entities.sealedPut("lists", "c_test", { id: "c_test", name: "Reading", members: ["e_a"] });
  entities.sealedPut("lists", "c_test", { id: "c_test", name: "Reading", members: ["e_a", "e_b"] });
  const r = records.ownLog().filter((x) => x.of === "sealed:lists/c_test").pop()!;
  assert.deepEqual(r.add!.members, ["e_b"]);
  assert.ok(!r.set || !("name" in r.set));
  entities.sealedDrop("lists", "c_test");
  assert.equal(records.ownLog().filter((x) => x.of === "sealed:lists/c_test").pop()!.gone, true);
});

test("done once here: said, so a machine joining does not do it again", () => {
  entities.sealedOnce("lists", "starters-test");
  assert.equal(records.ownLog().filter((x) => x.of === "once:lists/starters-test").pop()!.set!.done, true);
});

test("a merge remembered: one entry", async () => {
  const merge = await import("../src/merge.js");
  merge.rememberMerge("e_dropped", "e_kept");
  assert.deepEqual(records.ownLog().filter((x) => x.of === "merged").pop()!.set, { e_dropped: "e_kept" });
});

test("a suggestion said no to: one member added", async () => {
  const suggest = await import("../src/suggest.js");
  suggest.dismiss("e_one", "e_two");
  const r = records.ownLog().filter((x) => x.of === "suggest").pop()!;
  assert.equal(r.add!.no!.length, 1);
});

test("compacting records (trimming) comes to what applying them all did, and later ones still win or lose as before", () => {
  type R = import("../src/records.js").Rec;
  // A model of applying: per field the latest moment's value; per member the latest add or remove; a thing gone gone.
  const run = (recs: R[]) => {
    const f = new Map<string, { at: R["at"]; v: unknown }>(), m = new Map<string, { at: R["at"]; in: boolean }>(), gone = new Map<string, R["at"]>();
    const newer = (a: R["at"], b?: R["at"]) => !b || records.compare(a, b) >= 0;
    for (const r of [...recs].sort((a, b) => records.compare(a.at, b.at))) {
      for (const [k, v] of Object.entries(r.set ?? {})) if (newer(r.at, f.get(`${r.of}/${k}`)?.at)) f.set(`${r.of}/${k}`, { at: r.at, v });
      for (const k of r.unset ?? []) if (newer(r.at, f.get(`${r.of}/${k}`)?.at)) f.set(`${r.of}/${k}`, { at: r.at, v: undefined });
      for (const [k, ms] of Object.entries(r.add ?? {})) for (const x of ms) if (newer(r.at, m.get(`${r.of}/${k}/${x}`)?.at)) m.set(`${r.of}/${k}/${x}`, { at: r.at, in: true });
      for (const [k, ms] of Object.entries(r.remove ?? {})) for (const x of ms) if (newer(r.at, m.get(`${r.of}/${k}/${x}`)?.at)) m.set(`${r.of}/${k}/${x}`, { at: r.at, in: false });
      if (r.gone && newer(r.at, gone.get(r.of))) gone.set(r.of, r.at);
    }
    const out: Record<string, unknown> = {};
    for (const [k, x] of f) out[`f:${k}`] = x.v;
    for (const [k, x] of m) out[`m:${k}`] = x.in;
    for (const [k] of gone) out[`g:${k}`] = true;
    return JSON.stringify(Object.fromEntries(Object.entries(out).sort()));
  };
  let seed = 7;
  const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  const recs: R[] = [];
  for (let i = 0; i < 3000; i++) {
    const of = `e:${rnd(20)}`, at = { t: 1000 + rnd(500), c: rnd(3), m: ["m_a", "m_b"][rnd(2)]! };
    const kind = rnd(6);
    recs.push({ of, at, batch: `b${i}`, ...(kind === 0 ? { unset: [`f${rnd(4)}`] } : kind === 1 ? { add: { tags: [`t${rnd(5)}`] } }
      : kind === 2 ? { remove: { tags: [`t${rnd(5)}`] } } : kind === 3 && rnd(10) === 0 ? { gone: true as const } : { set: { [`f${rnd(4)}`]: rnd(100) } }) });
  }
  const small = records.compact(recs);
  assert.ok(small.length < recs.length / 3, `compacted: ${small.length} of ${recs.length}`);
  assert.equal(run(small), run(recs), "the same, applied");
  // Later records, from another machine, against either: the same again.
  const later: R[] = [{ of: "e:3", at: { t: 1200, c: 9, m: "m_b" }, batch: "x", set: { f1: "late" } }, { of: "e:4", at: { t: 2000, c: 0, m: "m_b" }, batch: "y", remove: { tags: ["t1"] } }];
  assert.equal(run([...small, ...later]), run([...recs, ...later]));
});
