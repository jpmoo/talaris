// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const sandbox = mkdtempSync(join(tmpdir(), "talaris-sug-"));
process.env.TALARIS_DATA_DIR = join(sandbox, "data");
process.env.TALARIS_PROJECTS = join(sandbox, "Projects");
process.env.TALARIS_CONFIG_DIR = join(sandbox, "config");
process.env.TALARIS_STATE_DIR = join(sandbox, "state");
process.env.TALARIS_KEY = randomBytes(32).toString("base64");

const entities = await import("../src/entities.js");
const tasks = await import("../src/tasks.js");
const suggest = await import("../src/suggest.js");
const merge = await import("../src/merge.js");
const filetext = await import("../src/filetext.js");

after(() => rmSync(sandbox, { recursive: true, force: true }));

const person = (title: string, extra: Record<string, unknown> = {}) => entities.createEntity({ role: "person", properties: { title, ...extra } });

test("a name in the words: each person it may be, a mention offered, and taken", () => {
  const gelson = person("Rich Gelson");
  const wiener = person("Rich Wiener");
  const t = tasks.createTask({ title: "Connect Rich about the retreat" });
  const s = suggest.suggestionsFor(`e:${t.id}`).suggestions;
  const of = (id: string) => s.find((x) => x.id === id);
  assert.ok(of(gelson.id) && of(wiener.id), "both Riches");
  assert.match(of(gelson.id)!.why[0]!, /one of 2/);
  const way = of(gelson.id)!.ways.find((w) => w.how === "mention")!;
  assert.equal(way.label, "Make “Rich” a mention");
  suggest.accept(`e:${t.id}`, `e:${gelson.id}`, way);
  assert.equal(entities.getEntity(t.id).properties.title, `Connect [@Rich](talaris:${gelson.id}) about the retreat`);
  assert.ok(entities.connections(t.id).out.some((c) => c.entity.id === gelson.id), "a mention is a tie");
  assert.ok(!suggest.suggestionsFor(`e:${t.id}`).suggestions.some((x) => x.id === gelson.id), "tied, not suggested again");
});

test("a note called by a person's name: about them, connected in its people field", () => {
  const ann = person("Annabel Price");
  const note = entities.createEntity({ role: "note", properties: { title: "Annabel Price" } });
  const s = suggest.suggestionsFor(`e:${note.id}`).suggestions.find((x) => x.id === ann.id)!;
  assert.deepEqual(s.why, ["Named Annabel Price"]);
  const way = s.ways.find((w) => w.how === "connect")!;
  assert.equal(way.label, "About Annabel Price");
  suggest.accept(`e:${note.id}`, `e:${ann.id}`, way);
  assert.ok(entities.connections(ann.id).in.some((c) => c.entity.id === note.id && c.by === "field"));
});

test("turned down, it is not made again; a thing told to be quiet suggests nothing", () => {
  const p = person("Dorothea Banks");
  const t = tasks.createTask({ title: "Lunch with Dorothea Banks" });
  assert.ok(suggest.suggestionsFor(`e:${t.id}`).suggestions.some((x) => x.id === p.id));
  suggest.dismiss(`e:${t.id}`, `e:${p.id}`);
  assert.ok(!suggest.suggestionsFor(`e:${t.id}`).suggestions.some((x) => x.id === p.id));
  suggest.setQuiet(`e:${t.id}`, true);
  assert.deepEqual(suggest.suggestionsFor(`e:${t.id}`), { quiet: true, suggestions: [] });
});

test("one person twice: merge offered; what pointed at the one gone points at the one kept, and its id leads there", () => {
  const a = person("Theo Marsh", { notes: "Likes trains" });
  const b = person("Theo Marsh");
  const t = tasks.createTask({ title: "Call him" });
  entities.connect(t.id, a.id, { type: "about" });
  const note = entities.createEntity({ role: "note", properties: { title: "Chat", body: `Saw [@Theo](talaris:${a.id}) today` } });
  const s = suggest.suggestionsFor(`e:${b.id}`).suggestions.find((x) => x.id === a.id)!;
  assert.ok(s.ways[0]!.how === "merge", "merge first");
  merge.mergeEntities(a.id, b.id);
  assert.equal(entities.getEntity(b.id).properties.notes, "Likes trains", "what it lacked, taken");
  assert.ok(entities.connections(b.id).in.some((c) => c.entity.id === t.id), "the link moved");
  assert.match(String(entities.getEntity(note.id).properties.body), new RegExp(`talaris:${b.id}`), "the mention moved");
  assert.throws(() => entities.getEntity(a.id));
  assert.equal(merge.mergedInto(a.id), b.id);
});

test("one another app keeps in step is the one kept; two such are not merged here", () => {
  const synced = person("Wren Hale", { "hermes-sync:link": { h: "x" } });
  const plain = person("Wren Hale");
  suggest.accept(`e:${synced.id}`, `e:${plain.id}`, { how: "merge", label: "" });
  assert.ok(entities.getEntity(synced.id));
  assert.throws(() => entities.getEntity(plain.id));
  const other = person("Wren Hale", { "other:link": 1 });
  assert.throws(() => merge.mergeEntities(other.id, synced.id), /both are kept in step/);
});

test("a file's text: read as it is, kept until it changes", async () => {
  const f = join(sandbox, "minutes.md");
  writeFileSync(f, "# Minutes\n\nThe board agreed the budget.");
  assert.match(await filetext.textOf(f), /board agreed/);
  let reads = 0;
  const read = async () => { reads++; return "once"; };
  assert.equal(await filetext.fileText("k", "1", read), "once");
  assert.equal(await filetext.fileText("k", "1", read), "once");
  await filetext.fileText("k", "2", read);
  assert.equal(reads, 2);
  assert.equal(await filetext.textOf(join(sandbox, "x.mp3")), "");
});
