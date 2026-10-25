// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

// Paths and the key are decided at import: the sandbox and a test key first.
// Under TALARIS_KEY nothing touches the real keyring.
const sandbox = mkdtempSync(join(tmpdir(), "talaris-entities-"));
process.env.TALARIS_DATA_DIR = join(sandbox, "data");
process.env.TALARIS_PROJECTS = join(sandbox, "Projects");
process.env.TALARIS_CONFIG_DIR = join(sandbox, "config");
process.env.TALARIS_STATE_DIR = join(sandbox, "state");
process.env.TALARIS_KEY = randomBytes(32).toString("base64");

const seal = await import("../src/seal.js");
const vault = await import("../src/vault.js");
const entities = await import("../src/entities.js");
const ix = await import("../src/interchange.js");

after(() => rmSync(sandbox, { recursive: true, force: true }));

test("sealing round-trips, and the wrong key is refused rather than read", () => {
  const k = randomBytes(32);
  const sealed = seal.seal(k, "the roofer is Tuesday");
  assert.ok(seal.isSealed(sealed));
  assert.equal(seal.unseal(k, sealed).toString(), "the roofer is Tuesday");
  assert.throws(() => seal.unseal(randomBytes(32), sealed), /different key/);
});

test("a recovery key opens what was sealed to its public half, and nothing else does", () => {
  const { recoveryKey, publicKey } = seal.newRecovery();
  assert.match(recoveryKey, /^([A-Z2-7]{4}-){12}[A-Z2-7]{4}$/);
  assert.equal(seal.recoveryPublic(recoveryKey), publicKey);
  const sealed = seal.sealTo(publicKey, "backup");
  assert.equal(seal.unsealWith(recoveryKey.toLowerCase().replace(/-/g, " "), sealed).toString(), "backup", "forgiving of how it is typed");
  assert.throws(() => seal.unsealWith(seal.newRecovery().recoveryKey, sealed), /does not open/);
});

test("nothing in the store is readable on disk", () => {
  const p = entities.personFor("ada@example.com", "Ada Lovelace");
  const raw = readFileSync(join(process.env.TALARIS_DATA_DIR!, "entities", "objects", p.id));
  assert.ok(seal.isSealed(raw));
  assert.ok(!raw.toString("latin1").includes("Lovelace"));
});

test("the recovery key is shown until kept, then nowhere; it can open the store's key", () => {
  const state = vault.recoveryState();
  assert.equal(state.locked, null);
  assert.ok(state.pending, "pending until it is said to be kept");
  const recoveryKey = state.pending!;
  vault.recoveryKept();
  assert.equal(vault.recoveryState().pending, null);
  vault.forgetKeyForTests();
  vault.unlock(recoveryKey);
  assert.ok(entities.findEntities({ q: "ada" }).length >= 1, "the store opens with the key the recovery key unsealed");
  assert.throws(() => vault.unlock(seal.newRecovery().recoveryKey), /not this store's recovery key/);
});

test("kinds are read from types, never from names", () => {
  const person = entities.typeFor("person");
  entities.putType({ ...person, name: "Contact" });
  entities.reloadEntities();
  assert.equal(entities.typeFor("person").name, "Contact");
  assert.ok(entities.profilesOf(entities.personFor("ada@example.com")).includes("contact"));
  entities.putType({ ...person, name: "Person" });
});

test("an event's invitees are people it references, made or found by email", () => {
  const source = { kind: "eds-event", key: "cal-1/uid-1" };
  const e = entities.mirrorEvent({
    source, title: "Board meeting", start: "2026-10-27T09:00", end: "2026-10-27T10:00",
    organizer: { email: "ADA@example.com" },
    attendees: [{ email: "ada@example.com", status: "accepted" }, { email: "grace@example.com", name: "Grace Hopper" }],
  });
  const ada = entities.byEmail("ada@example.com")!;
  assert.equal(entities.titleOf(ada), "Ada Lovelace", "an existing person is found, not made again");
  const people = entities.connections(e.id).out.filter((c) => c.name === "attendees").map((c) => c.entity.title).sort();
  assert.deepEqual(people, ["Ada Lovelace", "Grace Hopper"]);
  const adaIn = entities.connections(ada.id).in.map((c) => `${c.name}:${c.entity.title}`).sort();
  assert.deepEqual(adaIn, ["attendees:Board meeting", "organizer:Board meeting"]);
  // Mirrored again, unchanged: not written. Changed: only what the calendar owns.
  entities.updateEntity(e.id, { tags: ["governance"] });
  const before = entities.getEntity(e.id).version;
  entities.mirrorEvent({ source, title: "Board meeting", start: "2026-10-27T09:00", end: "2026-10-27T10:00",
    organizer: { email: "ada@example.com" }, attendees: [{ email: "ada@example.com", status: "accepted" }, { email: "grace@example.com" }] });
  assert.equal(entities.getEntity(e.id).version, before, "unchanged is not a write");
  entities.mirrorEvent({ source, title: "Board meeting (moved)", start: "2026-10-28T09:00", attendees: [{ email: "grace@example.com" }] });
  const after = entities.getEntity(e.id);
  assert.equal(after.properties.title, "Board meeting (moved)");
  assert.deepEqual(after.tags, ["governance"], "what Talaris added stays");
  assert.equal(after.properties.organizer, undefined);
});

test("one meeting seen through two accounts is one entity, known by both", () => {
  const a = entities.mirrorEvent({ source: { kind: "eds-event", key: "google/u-77" }, also: [{ kind: "ical-uid", key: "u-77" }], title: "Shared" });
  const b = entities.mirrorEvent({ source: { kind: "eds-event", key: "m365/u-77" }, also: [{ kind: "ical-uid", key: "u-77" }], title: "Shared" });
  assert.equal(a.id, b.id);
  assert.equal(entities.bySource({ kind: "eds-event", key: "m365/u-77" })?.id, a.id);
});

test("connecting a note to a person uses the note's declared field; with none, an edge", () => {
  const note = entities.createEntity({ role: "note", properties: { body: "Asked about the engine" } });
  const grace = entities.byEmail("grace@example.com")!;
  const c = entities.connect(note.id, grace.id);
  assert.deepEqual([c.by, c.name], ["field", "people"]);
  assert.deepEqual(entities.getEntity(note.id).properties.people, [grace.id]);
  entities.connect(note.id, grace.id);
  assert.deepEqual(entities.getEntity(note.id).properties.people, [grace.id], "twice is once");
  const task = entities.createEntity({ role: "task", properties: { title: "Write back" } });
  const edge = entities.connect(task.id, note.id);
  assert.deepEqual([edge.by, edge.name, edge.via], ["relation", "links", "edge"]);
  assert.ok(entities.connections(grace.id).in.some((x) => x.entity.id === note.id && x.name === "people"));
  entities.disconnect(note.id, grace.id);
  assert.equal(entities.getEntity(note.id).properties.people, undefined);
});

test("a stub keeps its id when it becomes real", () => {
  const stub = entities.createEntity({ stub: true, suggests: "contact", properties: { title: "the roofer" } });
  const note = entities.createEntity({ role: "note", properties: { body: "Call the roofer" } });
  entities.link({ from: note.id, to: stub.id, type: "mentions", via: "inline", field: "body" });
  entities.updateEntity(stub.id, { stub: false, type: entities.typeFor("person").id });
  assert.ok(entities.connections(stub.id).in.some((x) => x.entity.id === note.id), "the link was already right");
});

test("files are kept once by their hash, sealed, and checked on the way out", () => {
  const a = entities.putFile(Buffer.from('{"app":"firefox"}'), "launch.json", "application/vnd.talaris.launch+json");
  const b = entities.putFile(Buffer.from('{"app":"firefox"}'), "other-name.json");
  assert.equal(a.sha256, b.sha256);
  assert.equal(entities.fileHashes().filter((h) => h === a.sha256).length, 1);
  assert.equal(entities.getFile(a.sha256)!.toString(), '{"app":"firefox"}');
  const card = entities.createEntity({ role: "note", properties: { title: "Browser", "talaris:launch": a } });
  assert.ok(card.id);
});

test("unknown keys survive, in the store and through the format", () => {
  const o = entities.createEntity({ role: "note", properties: { title: "Odd", "plugin:x": { deep: [1, 2] } }, "hermes:id": "blk_9" });
  entities.updateEntity(o.id, { properties: { title: "Odd one" } });
  const back = entities.getEntity(o.id);
  assert.deepEqual(back.properties["plugin:x"], { deep: [1, 2] });
  assert.equal(back["hermes:id"], "blk_9");
});

test("an export comes back whole, files and all", () => {
  const before = ix.exportEnvelope({ bytes: true });
  assert.equal(before.producer.stableIds, true);
  const text = JSON.stringify(before);
  const { findings, counts } = ix.importEnvelope(JSON.parse(text));
  assert.deepEqual(findings, []);
  assert.equal(counts.objects, before.objects!.length);
  assert.ok(counts.files >= 1);
  const again = ix.exportEnvelope({ bytes: true });
  const norm = (e: typeof before) => JSON.stringify({ ...e, objects: [...e.objects!].sort((a, b) => a.id.localeCompare(b.id)),
    relations: [...e.relations!].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    types: [...e.types!].sort((a, b) => a.id.localeCompare(b.id)) });
  assert.equal(norm(again), norm(before), "byte-identical, in the format's sense");
});

test("a file that does not match its hash fails the import, and nothing is touched", () => {
  const env = ix.exportEnvelope({ bytes: true });
  const count = ix.onDisk();
  const o = env.objects!.find((x) => JSON.stringify(x).includes('"bytes"'))!;
  const a = Object.values(o.properties).find((v: any) => v && v.kind === "attachment") as any;
  a.bytes = Buffer.from("tampered").toString("base64");
  assert.throws(() => ix.importEnvelope(env), /does not match its hash/);
  assert.equal(ix.onDisk(), count);
});

// The format's own checker, where this machine has it: the export is scored by
// the same tool that scores Hermes'.
const CHECKER = process.env.PKM_CHECK ?? join(homedir(), "Documents/Scripts/hermesnotes/pkm-interchange/check/src/cli.js");
test("the checker finds nothing wrong with an export", { skip: !existsSync(CHECKER) && "no pkm-interchange checker here" }, () => {
  const file = join(sandbox, "export.json");
  writeFileSync(file, JSON.stringify(ix.exportEnvelope()));
  let out = "";
  try {
    out = execFileSync("node", [CHECKER, file], { encoding: "utf8" });
  } catch (e) {
    out = String((e as { stdout?: string }).stdout ?? "") + String((e as { stderr?: string }).stderr ?? "");
    assert.fail(`the checker refused the export:\n${out}`);
  }
  assert.doesNotMatch(out, /\bFAIL\b/, out);
  assert.match(out, /produce: level 1/, "what the manifest claims, and no more");
});

test("an encrypted project reads as before, and is sealed on disk; turned off, plain again", async () => {
  const projects = await import("../src/projects.js");
  const pages = await import("../src/pages.js");
  const sealed = await import("../src/sealed-projects.js");
  sealed.startSealing();
  const p = projects.createProject("Secret plans");
  const page = pages.createPage(p.id, null, "Diary");
  pages.writePage(p.id, page.path, "Dear diary, the roofer came.");
  const file = join(p.folder, "Writing", "Diary.md");
  sealed.setProjectEncrypted(p.id, true);
  assert.ok(seal.isSealed(readFileSync(file)), "the page is sealed on disk");
  assert.equal(pages.readPage(p.id, page.path), "Dear diary, the roofer came.");
  pages.writePage(p.id, page.path, "Dear diary, again.");
  assert.ok(seal.isSealed(readFileSync(file)), "and stays sealed when written");
  assert.ok(!readFileSync(join(p.folder, ".talaris", "project.json"), "utf8").includes("TLS1"), "project.json stays readable");
  sealed.setProjectEncrypted(p.id, false);
  assert.equal(readFileSync(file, "utf8"), "Dear diary, again.");
});

test("a project's files: kept in Files/ by name, made unique, sealed in an encrypted project, never read above it", async () => {
  const projects = await import("../src/projects.js");
  const sealed = await import("../src/sealed-projects.js");
  sealed.startSealing();
  const p = projects.createProject("Letters");
  const a = projects.putProjectFile(p.id, "to Chuck.pdf", Buffer.from("%PDF one"));
  const b = projects.putProjectFile(p.id, "to Chuck.pdf", Buffer.from("%PDF two"));
  assert.deepEqual([a.path, b.path], ["Files/to Chuck.pdf", "Files/to Chuck 2.pdf"]);
  assert.equal(readFileSync(join(p.folder, "Files", "to Chuck.pdf"), "utf8"), "%PDF one", "plain where the project is");
  assert.equal(projects.attachedFile(p.id, a.path).sealed, false);
  assert.throws(() => projects.attachedFile(p.id, "Files/../.talaris/project.json"), /not a file/);
  assert.throws(() => projects.attachedFile(p.id, ".talaris/project.json"), /not a file/, "never Talaris's own");
  assert.throws(() => projects.attachedFile(p.id, "Files/../../elsewhere.txt"), /not a file/, "never above the folder");
  const exported = projects.writeExport(p.id, "Board", "png", Buffer.from("png"));
  assert.equal(projects.attachedFile(p.id, exported).sealed, false, "an export opens too");
  sealed.setProjectEncrypted(p.id, true);
  assert.ok(seal.isSealed(readFileSync(join(p.folder, "Files", "to Chuck.pdf"))), "sealed once the project is encrypted");
  assert.equal(projects.attachedFile(p.id, a.path).sealed, true);
  assert.equal(projects.readProjectFile(p.id, a.path).toString(), "%PDF one");
  const c = projects.putProjectFile(p.id, "new.txt", Buffer.from("hello"));
  assert.ok(seal.isSealed(readFileSync(join(p.folder, "Files", "new.txt"))), "and a new one is sealed as it is written");
  assert.equal(projects.readProjectFile(p.id, c.path).toString(), "hello");
  sealed.setProjectEncrypted(p.id, false);
});

test("@ finds pages and canvases with entities, this project's first; a place is one entity, found again", async () => {
  const projects = await import("../src/projects.js");
  const pages = await import("../src/pages.js");
  const m = await import("../src/mentionables.js");
  const here = projects.createProject("Garden");
  const there = projects.createProject("Roof");
  pages.createPage(there.id, null, "Planting list (roof)");
  pages.createPage(here.id, null, "Planting list");
  entities.createEntity({ role: "note", properties: { title: "Planting ideas" } });
  const found = m.findMentionables("planting", here.id);
  assert.equal(found[0]!.title, "Planting list", "this project's page first");
  assert.equal(found[0]!.kind, "page");
  assert.equal(found[0]!.id, "", "no entity until it is linked");
  assert.ok(found.some((f) => f.kind === "page" && f.project === there.id), "another project's too, after");
  assert.ok(found.some((f) => f.title === "Planting ideas"));
  const a = m.placeEntity("page", here.id, "Planting list", "Planting list");
  const b = m.placeEntity("page", here.id, "Planting list", "Planting list");
  assert.equal(a.id, b.id, "one entity for one page");
  assert.deepEqual(m.placeOf(a), { kind: "page", project: here.id, where: "Planting list" });
  assert.equal(m.findMentionables("planting", here.id)[0]!.id, a.id, "and the page is listed with it now");
  assert.ok(m.findMentionables("canvas", here.id, 40).some((f) => f.kind === "canvas" && f.project === here.id && f.here), "a project's canvases, by their titles");
});

test("a calendar's own address is nobody; a person known by address takes their name when it comes", () => {
  const ev = entities.mirrorEvent({
    source: { kind: "eds-event", key: "cal/u-room" }, title: "Board meeting",
    attendees: [{ email: "c_abc123@group.calendar.google.com" }, { email: "pat@example.org" }],
  });
  assert.equal((ev.properties.attendees as string[]).length, 1, "the calendar is not an invitee");
  const pat = entities.byEmail("pat@example.org")!;
  assert.equal(entities.titleOf(pat), "pat@example.org", "an address until a name is known");
  assert.equal(entities.titleOf(entities.personFor("pat@example.org", "Pat Doyle")), "Pat Doyle");
  assert.equal(entities.titleOf(entities.personFor("pat@example.org", "Someone Else")), "Pat Doyle", "a name is not replaced");
  // One made before this was known: taken out of what lists it, then gone.
  const stray = entities.createEntity({ role: "person", properties: { title: "c_x@group.calendar.google.com", emails: ["c_x@group.calendar.google.com"] } });
  const e2 = entities.createEntity({ role: "event", properties: { title: "Old one", attendees: [stray.id, pat.id] } });
  assert.equal(entities.forgetNonPeople(), 1);
  assert.deepEqual(entities.getEntity(e2.id).properties.attendees, [pat.id]);
  assert.throws(() => entities.getEntity(stray.id));
});

test("people listed with their organization; tied to a card and untied, nothing else touched", () => {
  const p = entities.createEntity({ role: "person", properties: { title: "Rosa Diaz", emails: ["rosa@nine-nine.example"], organization: "Nine-Nine", role: "Detective" } });
  const row = entities.listPeople().find((r) => r.id === p.id)!;
  assert.deepEqual([row.organization, row.role, row.email, row.ties], ["Nine-Nine", "Detective", "rosa@nine-nine.example", []]);
  entities.tieContact(p.id, "book-1/card-9", true);
  assert.deepEqual(entities.listPeople().find((r) => r.id === p.id)!.ties, ["book-1/card-9"]);
  assert.equal(entities.bySource({ kind: "eds-contact", key: "book-1/card-9" })?.id, p.id, "found by the card");
  entities.tieContact(p.id, "book-1/card-9", false);
  assert.deepEqual(entities.listPeople().find((r) => r.id === p.id)!.ties, []);
  assert.equal(entities.getEntity(p.id).properties.organization, "Nine-Nine");
  assert.throws(() => entities.tieContact(p.id, "nobook", true), /book and its id/);
});

test("a contact card becomes a person, or ties the one with its address; filled only where empty; a deleted one stays gone", () => {
  const made = entities.personFromCard({ key: "book/u1", name: "Gina Linetti", emails: ["gina@nine-nine.example"], phones: ["555-0199"], org: "Nine-Nine", role: "Administrator" })!;
  assert.equal(entities.titleOf(made), "Gina Linetti");
  assert.deepEqual([made.properties.phones, made.properties.organization, made.properties.role], [["555-0199"], "Nine-Nine", "Administrator"]);
  assert.equal(entities.personFromCard({ key: "book/u1", name: "Gina L." })!.id, made.id, "the same card, the same person, unchanged");
  assert.equal(entities.titleOf(entities.getEntity(made.id)), "Gina Linetti");
  // Someone already here by address: tied, their own words kept, the card's only where empty.
  const terry = entities.createEntity({ role: "person", properties: { title: "terry@nine-nine.example", emails: ["terry@nine-nine.example"], role: "Sergeant" } });
  const tied = entities.personFromCard({ key: "book/u2", name: "Terry Jeffords", emails: ["Terry@nine-nine.example"], role: "Lieutenant", org: "Nine-Nine" })!;
  assert.equal(tied.id, terry.id);
  assert.deepEqual([entities.titleOf(tied), tied.properties.role, tied.properties.organization], ["Terry Jeffords", "Sergeant", "Nine-Nine"]);
  // One who wants no contact is left alone; one deleted is not made again.
  const hitch = entities.createEntity({ role: "person", properties: { title: "Hitchcock", emails: ["hitch@nine-nine.example"] }, "talaris:noContact": true });
  assert.equal(entities.personFromCard({ key: "book/u3", emails: ["hitch@nine-nine.example"] }), null);
  assert.equal(entities.getEntity(hitch.id)["talaris:sources"], undefined);
  entities.forgetCardsOf(made.id);
  entities.deleteEntity(made.id);
  assert.equal(entities.personFromCard({ key: "book/u1", name: "Gina Linetti", emails: ["gina@nine-nine.example"] }), null);
});

test("a project at a glance: its pages, canvases, filed things and files, and one step out", async () => {
  const projects = await import("../src/projects.js");
  const pages = await import("../src/pages.js");
  const { glance } = await import("../src/glance.js");
  const tasks = await import("../src/tasks.js");
  const p = projects.createProject("Theater");
  const amy = entities.createEntity({ role: "person", properties: { title: "Amy Santiago" } });
  const show = entities.createEntity({ role: "event", properties: { title: "Opening night", attendees: [amy.id] } });
  const page = pages.createPage(p.id, null, "Program");
  const file = projects.putProjectFile(p.id, "poster.png", Buffer.from("png"));
  pages.writePage(p.id, page.path, `For [@Opening night](talaris:${show.id}), see [poster.png](talaris-file:${encodeURI(file.path)}).`);
  const projectEntity = tasks.taskProjects().find((x) => x.workspace === p.id)!;
  const task = tasks.createTask({ title: "Print programs", projects: [projectEntity.id] });
  const g = glance(p.id);
  const by = (k: string) => g.nodes.find((n) => n.key === k);
  assert.equal(by(`page:${p.id}/Program`)?.own, true);
  assert.ok(g.nodes.some((n) => n.kind === "canvas" && n.own), "its top canvas");
  assert.equal(by(`e:${task.id}`)?.how, "filed here");
  assert.equal(by(`file:${p.id}/${file.path}`)?.own, true, "the file, in its folder");
  assert.ok(g.edges.some((e) => e.from === `page:${p.id}/Program` && e.to === `file:${p.id}/${file.path}` && e.how === "links"), "the page links the file");
  assert.equal(by(`e:${show.id}`)?.own, false, "the event the page mentions, one step out");
  assert.ok(g.edges.some((e) => e.from === `page:${p.id}/Program` && e.to === `e:${show.id}`));
  assert.equal(by(`e:${amy.id}`), undefined, "and not two steps: the event's people stay out");
  const two = glance(p.id, 2);
  assert.ok(two.nodes.some((n) => n.key === `e:${amy.id}`), "two steps out: the people at the meeting the page mentions");
  assert.ok(two.edges.some((e) => e.from === `e:${show.id}` && e.to === `e:${amy.id}`));
  assert.equal(by(`e:${show.id}`)?.beyond?.contact, 1, "at one step, the event says it has a person past the edge");
  // From the event: its people and the page that mentions it, and that page's project two out.
  const fromShow = glance(p.id, 1, `e:${show.id}`);
  assert.equal(fromShow.root, `e:${show.id}`);
  const near = (k: string) => fromShow.nodes.find((n) => n.key === k);
  assert.equal(near(`e:${show.id}`)?.depth, 0);
  assert.equal(near(`e:${amy.id}`)?.depth, 1);
  assert.equal(near(`page:${p.id}/Program`)?.depth, 1, "the page that mentions it, found from the event's side");
  assert.equal(near(`project:${p.id}`), undefined, "the project is two steps away");
  assert.ok(near(`page:${p.id}/Program`)?.beyond?.project, "and the page says so");
  // From the file: its project, and the page that links it.
  const fromFile = glance(p.id, 1, `file:${p.id}/${file.path}`);
  assert.ok(fromFile.edges.some((e) => e.from === `page:${p.id}/Program` && e.to === `file:${p.id}/${file.path}`));
  assert.ok(fromFile.nodes.some((n) => n.key === `project:${p.id}`));
  // A search in the project puts what is tied to it first: the task filed here
  // before another of the same name, and the person at the meeting the page mentions.
  const { nearProject } = await import("../src/glance.js");
  const elsewhere = tasks.createTask({ title: "Print programs again" });
  const tied = nearProject(p.id);
  assert.ok(tied.has(task.id) && tied.has(show.id) && !tied.has(elsewhere.id));
  const found = entities.findEntities({ q: "print", kind: "task", near: tied });
  assert.equal(found[0]?.id, task.id);
});

test("pages and canvases: named for when they were made, starred, and in an order dragged", async () => {
  const projects = await import("../src/projects.js");
  const pages = await import("../src/pages.js");
  const canvases = await import("../src/canvases.js");
  const p = projects.createProject("Lists");
  const a = pages.createPage(p.id, null, "");
  assert.match(a.title, /^\d{4}-\d\d-\d\d \d\d:\d\d$/, "a nameless page is called when it was made");
  pages.createPage(p.id, null, "Beta");
  pages.createPage(p.id, null, "Alpha");
  pages.starPage(p.id, "Alpha", true);
  pages.orderPages(p.id, "", ["Alpha", "Beta"]);
  const tree = pages.pageTree(p.id);
  assert.deepEqual(tree.map((n) => n.title), ["Alpha", "Beta", a.title]);
  assert.equal(tree[0]?.starred, true);
  const starred = await import("../src/starred.js");
  pages.createPage(p.id, "Beta", "Inner");
  starred.setStarredOrder(p.id, "pages", ["Beta/Inner", "Alpha"]);
  pages.movePage(p.id, "Beta", null, "Gamma");
  assert.deepEqual(starred.starredOrder(p.id).pages, ["Gamma/Inner", "Alpha"], "the starred order follows a rename");
  pages.movePage(p.id, "Gamma", null, "Beta");
  assert.ok(tree.every((n) => n.created && n.modified));
  const top = canvases.canvasTree(p.id);
  const one = canvases.createChild(p.id, top.id, "One").canvas;
  const two = canvases.createChild(p.id, top.id, "").canvas;
  assert.match(two.title, /^\d{4}-/);
  const before = canvases.readCanvas(p.id, one.id);
  canvases.starCanvas(p.id, one.id, true);
  canvases.orderCanvases(p.id, top.id, [two.id, one.id]);
  assert.deepEqual(canvases.readCanvas(p.id, one.id), before, "a star is not an edit of the canvas");
  const kids = canvases.canvasTree(p.id).children;
  assert.deepEqual(kids.map((c) => c.id), [two.id, one.id]);
  assert.equal(kids[1]?.starred, true);
  assert.ok(kids[0]?.created);
});

test("an archived project leaves every list, is read and not written, and comes back — beside one of its name, or merged into it", async () => {
  const projects = await import("../src/projects.js");
  const pages = await import("../src/pages.js");
  const tasks = await import("../src/tasks.js");
  const archive = await import("../src/archive.js");
  const p = projects.createProject("Retreat");
  pages.createPage(p.id, null, "Agenda");
  pages.writePage(p.id, "Agenda", "Day one");
  projects.putProjectFile(p.id, "map.pdf", Buffer.from("pdf"));
  const pe = tasks.taskProjects().find((x) => x.workspace === p.id)!;
  const task = tasks.createTask({ title: "Book the room", projects: [pe.id] });
  const page = entities.bySource({ kind: "page", key: `${p.id}/Agenda` });

  const gone = archive.archiveProject(p.id);
  assert.match(gone.folder, new RegExp(`Archived/${new Date().getFullYear()}/Retreat$`));
  assert.ok(!projects.listProjects().some((x) => x.id === p.id), "out of the lists");
  assert.equal(projects.findProject(p.id).archived, gone.archived, "still found by its id");
  assert.equal(pages.readPage(p.id, "Agenda"), "Day one", "read");
  assert.throws(() => pages.writePage(p.id, "Agenda", "changed"), /archived/, "not written");
  assert.ok(entities.getEntity(task.id).archived, "its task goes quiet with it");
  if (page) assert.ok(entities.getEntity(page.id).archived);
  assert.ok(!entities.findEntities({ q: "Book the room" }).length, "and is out of searches");
  assert.equal(archive.listArchive()[0]?.name, "Retreat");
  assert.equal(archive.searchArchive("day one")[0]?.where, "Agenda", "searched on purpose");

  // Back, with nothing in its way.
  const back = archive.restoreProject(p.id);
  assert.ok(back.done && back.project.folder.endsWith("/Projects/Retreat"));
  assert.ok(!entities.getEntity(task.id).archived);

  // Archived again, and a new Retreat made meanwhile: the choice is asked for.
  archive.archiveProject(p.id);
  const other = projects.createProject("Retreat");
  pages.createPage(other.id, null, "Agenda");
  pages.writePage(other.id, "Agenda", "Day two");
  const asked = archive.restoreProject(p.id);
  assert.ok(!asked.done && asked.clash.id === other.id);
  // Merging: the page both have is asked about; the file only it has just comes.
  const merging = archive.restoreProject(p.id, { mode: "merge" });
  assert.ok(!merging.done && merging.conflicts?.includes("Writing/Agenda.md"));
  const merged = archive.restoreProject(p.id, { mode: "merge", decisions: { "Writing/Agenda.md": "both" } });
  assert.ok(merged.done);
  assert.equal(pages.readPage(other.id, "Agenda"), "Day two", "the one in use kept its page");
  assert.equal(pages.readPage(other.id, "Agenda (restored)"), "Day one", "and the archived one sits beside it");
  assert.ok(existsSync(join(other.folder, "Files", "map.pdf")), "its files came");
  const otherEntity = tasks.taskProjects().find((x) => x.workspace === other.id)!;
  assert.ok(JSON.stringify(entities.getEntity(task.id).properties).includes(otherEntity.id), "its task is filed under the one in use");
  assert.ok(!entities.getEntity(task.id).archived);
  assert.throws(() => projects.findProject(p.id), /no project/, "and the archived one is gone, folded in");
});

test("the live binding: a cursor to follow, deletions in the feed, creates that never edit, and writes that do what a write does", async () => {
  const live = await import("../src/interchange.js");
  const feed = await import("../src/feed.js");
  const tasks = await import("../src/tasks.js");
  const start = live.readEnvelope();
  assert.match(start.cursor, /^[0-9a-f]+\.\d+$/);
  // A create at the client's id, twice: one object, and the second does not edit it.
  const made = live.createObject("e_client_1", { type: "t_note", properties: { title: "Chosen id", "acme:x": 1 } });
  assert.ok(made.ok && made.created && made.object?.properties?.["acme:x"] === 1);
  const again = live.createObject("e_client_1", { type: "t_note", properties: { title: "Changed?" } });
  assert.ok(again.ok && !again.created && again.object?.properties?.title === "Chosen id");
  assert.equal(live.createObject("e_client_2", { id: "e_other", type: "t_note" }).ok, false, "two ids is a refusal");
  assert.deepEqual(live.createObject("e_client_3", { type: "t_nope" }).reports, ["create.unknown-type"]);
  // A partial write: what it names, and nothing else; tags one by one; a stale version refused.
  const v = entities.getEntity("e_client_1").version;
  const patched = live.patchObject("e_client_1", { set: { title: "Renamed" }, addTags: ["urgent"], version: v });
  assert.ok(patched.ok && patched.object?.properties?.["acme:x"] === 1 && patched.object?.tags?.includes("urgent"));
  const stale = live.patchObject("e_client_1", { set: { title: "Late" }, version: v });
  assert.ok(!stale.ok && stale.conflict);
  // What changed since the start: these, and a deletion as a deletion.
  entities.deleteEntity("e_client_1");
  const delta = live.readEnvelope({ since: start.cursor });
  assert.ok(delta.changes?.some((c) => c.object === "e_client_1" && c.op === "delete"));
  assert.ok(!delta.objects?.some((o) => o.id === "e_client_1"), "a deleted object is not sent");
  assert.throws(() => live.readEnvelope({ since: "nope.1" }), feed.Gone, "a cursor this feed cannot answer is Gone");
  // A task finished through the binding is finished as anywhere else: the store stamps its time.
  const t = tasks.createTask({ title: "Through the binding" });
  const done = live.patchObject(t.id, { set: { status: "done" } });
  assert.ok(done.ok && done.object?.properties?.done_at, "completing stamped its time, the store's doing");
  // Narrowed reads are whole envelopes: one profile, or what matches words, most relevant first.
  const onlyTasks = live.readEnvelope({ profile: "task" });
  assert.ok(onlyTasks.objects!.length > 0 && onlyTasks.objects!.every((o) => o.type === "t_task"));
  assert.equal(live.readEnvelope({ q: "Through the binding" }).objects?.[0]?.id, t.id);
});

test("a backup opens only with the recovery key, and revives the store as it was", async () => {
  const backup = await import("../src/backup.js");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(process.env.TALARIS_CONFIG_DIR!, { recursive: true });
  writeFileSync(join(process.env.TALARIS_CONFIG_DIR!, "config.json"), JSON.stringify({ data: { backupFolder: join(sandbox, "backups"), keep: 2 } }));
  const recoveryKey = vault.replaceRecovery();
  vault.recoveryKept();
  const before = entities.findEntities({ limit: 1000 }).length;
  const made = backup.backupNow();
  if (existsSync(CHECKER)) assert.equal(made.check, "passed", made.detail);
  assert.ok(made.file.startsWith(join(sandbox, "backups")));
  assert.ok(!readFileSync(made.file).toString("latin1").includes("Lovelace"), "sealed");
  assert.throws(() => backup.previewBackup(made.file, seal.newRecovery().recoveryKey), /does not open/);
  assert.equal(backup.previewBackup(made.file, recoveryKey).objects, made.objects);
  entities.createEntity({ role: "note", properties: { title: "made after the backup" } });
  const r = backup.reviveBackup(made.file, recoveryKey);
  assert.ok(r.safety, "the store as it was is backed up first");
  assert.equal(entities.findEntities({ limit: 1000 }).length, before);
  assert.equal(entities.findEntities({ q: "made after the backup" }).length, 0);
  assert.ok(backup.listBackups().length <= 2, "only as many kept as asked");
});

test("readdir sanity: no stray temporary files left behind", () => {
  const dir = join(process.env.TALARIS_DATA_DIR!, "entities", "objects");
  assert.deepEqual(readdirSync(dir).filter((n) => n.endsWith(".tmp")), []);
});

test("search finds the start of a word before the middle of one, and the kind preferred first", () => {
  entities.createEntity({ role: "person", properties: { title: "dschumacher@example.org" } });
  entities.createEntity({ role: "person", properties: { title: "Chuck Berry" } });
  entities.createEntity({ role: "event", properties: { title: "Lunch with Chuck" } });
  const titles = entities.findEntities({ q: "chu", prefer: "contact" }).map((s) => s.title);
  assert.ok(titles.indexOf("Chuck Berry") < titles.indexOf("Lunch with Chuck"), titles.join(" | "));
  assert.ok(titles.indexOf("Lunch with Chuck") < titles.indexOf("dschumacher@example.org"), titles.join(" | "));
});
