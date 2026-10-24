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
