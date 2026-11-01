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
  assert.equal(way.label, "Connect “Rich” as a mention");
  assert.match(suggest.accept(`e:${t.id}`, `e:${gelson.id}`, way).said, /mention/);
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
  assert.equal(way.label, "Connect to Annabel Price");
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
  assert.deepEqual(suggest.suggestionsFor(`e:${t.id}`), { quiet: true, suggestions: [], dismissed: 1 });
  suggest.setQuiet(`e:${t.id}`, false);
  assert.equal(suggest.undismiss(`e:${t.id}`), 1, "turned down, made again");
  assert.ok(suggest.suggestionsFor(`e:${t.id}`).suggestions.some((x) => x.id === p.id));
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

test("what OCR reads is kept only if it is words", () => {
  assert.equal(filetext.wordsOnly("lth hy\n40 Nyda T\nWhy"), "");
  assert.match(filetext.wordsOnly("Minutes of the meeting: the board agreed the budget for next year."), /board/);
});

test("a picture with no words in it: described, and kept as what it shows; the describer away, it waits", async () => {
  const png = Buffer.from("not really a picture");
  filetext.setDescriber(async () => "A green raised bed with seedlings.");
  assert.equal(await filetext.textOfBytes(png, "bed.png"), "Picture: A green raised bed with seedlings.");
  filetext.setDescriber(async () => null);
  await assert.rejects(filetext.textOfBytes(png, "bed.png"), filetext.Unavailable);
  filetext.setDescriber(null);
  assert.equal(await filetext.textOfBytes(png, "bed.png"), "");
});

test("a description: a picture's is its own; one written by the person stands, for a picture in place of Morgan's", async () => {
  await filetext.fileText("k-pic", "1", async () => "Picture: A raised bed.");
  assert.equal(filetext.keptAbout("k-pic"), "A raised bed.");
  assert.equal(filetext.aboutIsYours("k-pic"), false);
  filetext.editAbout("k-pic", "The new cedar bed in the community garden");
  assert.equal(filetext.keptAbout("k-pic"), "The new cedar bed in the community garden");
  assert.equal(filetext.keptText("k-pic"), "Picture: The new cedar bed in the community garden", "what it is found by, too");
  await filetext.fileText("k-doc", "1", async () => "Minutes of the board.");
  assert.equal(filetext.keptAbout("k-doc"), undefined, "not described yet");
  filetext.setAbout("k-doc", "Board minutes from March.");
  assert.equal(filetext.keptAbout("k-doc"), "Board minutes from March.");
});

test("a web page read as what a reader sees: no scripts, styles or tags", () => {
  const t = filetext.visibleText("<html><head><style>p{color:red}</style><script>var x=1;</script></head><body><h1>Garden</h1><p>Beds &amp; paths</p></body></html>");
  assert.ok(!/color|var x|</.test(t));
  assert.match(t, /Garden/);
  assert.match(t, /Beds & paths/);
});

test("everyone reviewed: one person twice found by card, address or name, once each; turned down, not again", () => {
  const a = person("Whitlock, Imogen");
  const b = person("Imogen Whitlock");
  const c = person("Ivo Marsh", { emails: ["ivo@marsh.example"] });
  const d = person("I. Marsh", { emails: ["IVO@marsh.example "] });
  const e = person("Pell Ostrander");
  const f = person("P Ostrander");
  entities.tieContact(e.id, "book1/card-9", true);
  entities.tieContact(f.id, "book1/card-9", true);
  const pairs = () => suggest.peopleReview().pairs.map((p) => ({ ids: [p.a.id, p.b.id].sort().join(), why: p.why }));
  const of = (x: string, y: string) => pairs().find((p) => p.ids === [x, y].sort().join());
  assert.deepEqual(of(a.id, b.id)?.why, ["The same name"], "a name as it is said");
  assert.deepEqual(of(c.id, d.id)?.why, ["The same address"]);
  assert.deepEqual(of(e.id, f.id)?.why, ["The same contact card"]);
  const thrice = person("Cathryn Q", { emails: ["cq@ex.example", "cq@ex.example", "CQ@ex.example"] });
  assert.ok(!suggest.peopleReview().pairs.some((p) => p.a.id === thrice.id && p.b.id === thrice.id), "never paired with herself");
  assert.equal(pairs()[0]!.why[0], "The same contact card", "surest first");
  suggest.dismiss(`e:${a.id}`, `e:${b.id}`);
  assert.equal(of(a.id, b.id), undefined, "not the same: not asked again");
  suggest.dismiss(`e:${c.id}`, "card:book2/card-1");
  assert.deepEqual(suggest.peopleReview().notCards[c.id], ["book2/card-1"]);
});

test("the same person: a card tied, anyone else on it made one; or two made one", () => {
  const kept = person("Rosalind Achebe");
  const twin = person("R. Achebe");
  entities.tieContact(twin.id, "book1/card-77", true);
  const r = suggest.samePerson(kept.id, { card: "book1/card-77" });
  assert.match(r.said, /^Made one/);
  const all = entities.listPeople().filter((p) => p.title.includes("Achebe"));
  assert.equal(all.length, 1, "one left");
  assert.deepEqual(all[0]!.ties, ["book1/card-77"], "tied to the card");
  const solo = person("Tamsin Gale");
  assert.match(suggest.samePerson(solo.id, { card: "book1/card-80" }).said, /^Connected/);
  const other = person("Tamsin Gale");
  const m = suggest.samePerson(other.id, { person: solo.id });
  assert.match(m.said, /^Made one/);
  assert.equal(entities.listPeople().filter((p) => p.title === "Tamsin Gale").length, 1);
  // Three of one name are three pairs: after the first is made one, the others still go to whoever they became.
  const [x, y, z] = [person("Odile Fenn"), person("Odile Fenn"), person("Odile Fenn")];
  suggest.samePerson(x.id, { person: y.id });
  assert.match(suggest.samePerson(x.id, { person: z.id }).said, /^Made one/);
  assert.match(suggest.samePerson(y.id, { person: z.id }).said, /^Already one/);
  assert.equal(entities.listPeople().filter((p) => p.title === "Odile Fenn").length, 1);
  // Two with no name are not one name; folded into a third chosen, that one is kept, and keeps its name.
  const n1 = entities.createEntity({ role: "person", properties: { emails: ["one@me.example"] } });
  const n2 = entities.createEntity({ role: "person", properties: { emails: ["two@me.example"] } });
  assert.ok(!suggest.peopleReview().pairs.some((p) => [p.a.id, p.b.id].includes(n1.id)), "nameless: no name to share");
  const me = person("Jeffrey Moore");
  suggest.samePerson(me.id, { person: n1.id });
  const r2 = suggest.samePerson(me.id, { person: n2.id });
  assert.equal(r2.kept, me.id, "the one chosen is kept");
  const got = entities.getEntity(me.id).properties;
  assert.equal(got.title, "Jeffrey Moore");
  assert.deepEqual([...(got.emails as string[])].sort(), ["one@me.example", "two@me.example"]);
  // And a nameless one kept takes the other's name.
  const blank = entities.createEntity({ role: "person", properties: { emails: ["x@y.example"] } });
  const namedOne = person("Wren Abara");
  suggest.samePerson(blank.id, { person: namedOne.id });
  assert.equal(entities.getEntity(blank.id).properties.title, "Wren Abara");
});
