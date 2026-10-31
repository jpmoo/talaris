// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";

const sandbox = mkdtempSync(join(tmpdir(), "talaris-files-"));
process.env.TALARIS_DATA_DIR = join(sandbox, "data");
process.env.TALARIS_PROJECTS = join(sandbox, "Projects");
process.env.TALARIS_CONFIG_DIR = join(sandbox, "config");
process.env.TALARIS_STATE_DIR = join(sandbox, "state");
process.env.TALARIS_KEY = randomBytes(32).toString("base64");
// Shortcuts and links reach only the home folder: here, the sandbox.
process.env.TALARIS_LINK_HOME = sandbox;

const projects = await import("../src/projects.js");
const entities = await import("../src/entities.js");
const tasks = await import("../src/tasks.js");
const links = await import("../src/links.js");
const files = await import("../src/files.js");
const tags = await import("../src/tags.js");

const home = projects.ensureHome();
const alpha = projects.createProject("Alpha");
const beta = projects.createProject("Beta");
const write = (path: string, text = "words") => { mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, text); };
const rows = (project?: string, extra: Parameters<typeof files.listFiles>[0] = {}) => files.listFiles({ project, ...extra }).rows;
const find = (project: string, name: string) => rows(project).find((r) => r.name === name);
const wait = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

after(() => { files.stopAll(); rmSync(sandbox, { recursive: true, force: true }); });

test("everything in a project's folder is listed, but its machinery, dot-files, and what git ignores; pages are pages", () => {
  write(join(alpha.folder, "Budget.ods"));
  write(join(alpha.folder, "Notes", "plan.md"));
  write(join(alpha.folder, ".hidden"));
  write(join(alpha.folder, "Writing", "Camp rules.md"));
  execFileSync("git", ["init", "-q", alpha.folder]);
  write(join(alpha.folder, ".gitignore"), "node_modules/\n*.log\n");
  write(join(alpha.folder, "node_modules", "x", "index.js"));
  write(join(alpha.folder, "debug.log"));
  files.startWatching();
  const names = rows(alpha.id).filter((r) => r.path).map((r) => r.path).sort();
  assert.deepEqual(names, ["Budget.ods", "Notes/plan.md", "Writing/Camp rules.md"]);
  // Its canvas has nothing on it: not listed (one with something on it is, as a canvas: things.test.ts).
  assert.deepEqual(rows(alpha.id).filter((r) => !r.path).map((r) => r.status), []);
  assert.deepEqual(find(alpha.id, "Budget.ods")!.status, ["folder"]);
  assert.equal(find(alpha.id, "Budget.ods")!.type, "spreadsheet");
  assert.deepEqual(find(alpha.id, "Camp rules.md")!.status, ["page"]);
  assert.ok(files.ignoredIn(alpha.id).includes("node_modules/"), "named, not walked");
});

test("watched: a file made, changed or removed is seen without asking the folder again", async () => {
  const before = files.filesVersion();
  write(join(alpha.folder, "Notes", "later.txt"));
  await wait(700);
  assert.ok(find(alpha.id, "later.txt"), "seen once written");
  assert.ok(files.filesVersion() > before);
  mkdirSync(join(alpha.folder, "New folder"));
  await wait(400);
  write(join(alpha.folder, "New folder", "inside.pdf"));
  await wait(700);
  assert.ok(find(alpha.id, "inside.pdf"), "a folder made is watched too");
  rmSync(join(alpha.folder, "New folder"), { recursive: true });
  await wait(700);
  assert.equal(find(alpha.id, "inside.pdf"), undefined, "and its files gone with it");
});

test("by name, type, date and tag; across projects", async () => {
  write(join(beta.folder, "Budget draft.docx"));
  await wait(700);
  assert.deepEqual(rows(undefined, { q: "budget" }).map((r) => r.name).sort(), ["Budget draft.docx", "Budget.ods"]);
  assert.deepEqual(rows(undefined, { type: "document", q: "budget" }).map((r) => r.name), ["Budget draft.docx"]);
  files.setFileTags(alpha.id, "Budget.ods", ["money", "#2027"]);
  assert.deepEqual(rows(undefined, { tags: ["money"] }).map((r) => r.name), ["Budget.ods"]);
  assert.deepEqual(find(alpha.id, "Budget.ods")!.tags, ["money", "2027"]);
  assert.equal(rows(undefined, { days: 1 }).length, rows().length, "all changed today");
  // Tagged, it joins everything tags reach, with where it is.
  const hit = tags.tagged(["money"]).find((t) => t.title === "Budget.ods");
  assert.equal(hit?.file?.path, "Budget.ods");
});

test("renamed or moved, its tags and the links to it follow; a writing page is Writing's to move", () => {
  const t = tasks.createTask({ title: "Do the budget" });
  links.linkFile(t.id, join(alpha.folder, "Budget.ods"));
  assert.deepEqual(find(alpha.id, "Budget.ods")!.on.map((o) => o.title), ["Do the budget"], "a link inside the folder is that file, on the task");
  files.renameFile(alpha.id, "Budget.ods", "Budget 2027.ods");
  const row = find(alpha.id, "Budget 2027.ods")!;
  assert.deepEqual(row.tags, ["money", "2027"]);
  assert.deepEqual(row.on.map((o) => o.title), ["Do the budget"]);
  files.moveWithin(alpha.id, "Budget 2027.ods", beta.id, "Money");
  const there = find(beta.id, "Budget 2027.ods")!;
  assert.equal(there.path, "Money/Budget 2027.ods");
  assert.deepEqual(there.tags, ["money", "2027"]);
  const v = (entities.getEntity(t.id).properties.attachments as { "talaris:link": { path: string } }[])[0]!;
  assert.equal(v["talaris:link"].path, join(beta.folder, "Money", "Budget 2027.ods"));
  write(join(alpha.folder, "Money", "Budget 2027.ods"));
  files.watchProjects();
  assert.throws(() => files.moveWithin(beta.id, "Money/Budget 2027.ods", alpha.id, "Money"), /already there — Budget 2027 2\.ods is free/);
  assert.throws(() => files.renameFile(alpha.id, "Writing/Camp rules.md", "x.md"), /Writing/);
});

test("from elsewhere: a shortcut is a record, never a file; a link outside every project shows on its task's project; a snapshot too", async () => {
  const outside = join(sandbox, "Downloads", "Receipt.pdf");
  write(outside, "receipt");
  const s = await files.makeShortcut(alpha.id, outside);
  assert.deepEqual(s.status, ["shortcut"]);
  assert.equal(s.abs, outside);
  assert.ok(!existsSync(join(alpha.folder, "Receipt.pdf")), "nothing made on disk");
  await assert.rejects(() => files.makeShortcut(alpha.id, outside), /already has a shortcut/);
  // A task in Beta linking a file outside, and one keeping a copy.
  const betaEntity = entities.bySource({ kind: "talaris-project", key: beta.id }) ?? (tasks.taskProjects(), entities.bySource({ kind: "talaris-project", key: beta.id }))!;
  const t = tasks.createTask({ title: "File the receipt" });
  entities.updateEntity(t.id, { properties: { project: [betaEntity.id] } });
  links.linkFile(t.id, outside);
  const kept = entities.putFile(Buffer.from("a photo"), "photo.jpg", "image/jpeg");
  entities.updateEntity(t.id, { properties: { attachments: [...(entities.getEntity(t.id).properties.attachments as unknown[]), { ...kept, "hermes-sync:origin": "hermes" }] } });
  const linked = rows(beta.id).find((r) => r.name === "Receipt.pdf")!;
  assert.deepEqual(linked.status, ["linked"]);
  assert.deepEqual(linked.on.map((o) => o.title), ["File the receipt"]);
  const snap = rows(beta.id).find((r) => r.name === "photo.jpg")!;
  assert.deepEqual(snap.status, ["snapshot"]);
  assert.equal(snap.fromHermes, true);
  // Gone: missing, wherever it was shown.
  rmSync(outside);
  links.refreshLinks();
  assert.deepEqual(find(alpha.id, "Receipt.pdf")!.status, ["shortcut", "missing"]);
  assert.deepEqual(rows(beta.id).find((r) => r.name === "Receipt.pdf")!.status, ["linked", "missing"]);
  // A shortcut taken away is the record only.
  files.removeShortcut(s.entity!);
  assert.equal(find(alpha.id, "Receipt.pdf"), undefined);
  // A snapshot saved into the project is a file there, linked on its task.
  const saved = files.saveSnapshot(snap.holder!, snap.sha256!, beta.id);
  assert.equal(saved.path, "Files/photo.jpg");
  const now = find(beta.id, "photo.jpg")!;
  assert.deepEqual(now.status, ["folder"]);
  assert.deepEqual(now.on.map((o) => o.title), ["File the receipt"]);
  // A task in no project: its files are Home's.
  const loose = tasks.createTask({ title: "Loose ends" });
  entities.updateEntity(loose.id, { properties: { attachments: [entities.putFile(Buffer.from("loose"), "loose.txt")] } });
  assert.ok(rows(home.id).some((r) => r.name === "loose.txt"));
});

test("moving a file in says what it would disturb, and keeps a shortcut's tags", async () => {
  const outside = join(sandbox, "Desktop", "Plan.odt");
  write(outside, "plan");
  write(join(beta.folder, "Plan.odt"), "another");
  const s = await files.makeShortcut(beta.id, outside);
  entities.updateEntity(s.entity!, { tags: ["planning"] });
  const checked = files.checkBringIn(outside, beta.id);
  assert.equal(checked.name, "Plan 2.odt");
  assert.deepEqual(checked.warnings.map((w) => w.code).sort(), ["name", "referred"]);
  const row = files.bringIn(outside, beta.id);
  assert.equal(row.path, "Plan 2.odt");
  assert.deepEqual(row.status, ["folder"]);
  assert.deepEqual(row.tags, ["planning"], "the shortcut is now the file, its tags kept");
  assert.ok(!existsSync(outside));
  assert.equal(rows(beta.id).filter((r) => r.status.includes("shortcut")).length, 0);
});

test("a snapshot opens as a read-only copy", () => {
  const kept = entities.putFile(Buffer.from("snap"), "snap.txt");
  const path = files.openableCopy({ sha256: kept.sha256, name: "snap.txt" });
  assert.match(path, /snap\.txt$/);
  assert.throws(() => writeFileSync(path, "changed"));
});

test("one file in several projects: a shortcut in each other one, and each row says where else it is", async () => {
  write(join(alpha.folder, "Shared plan.odt"));
  await wait(700);
  await files.makeShortcut(beta.id, join(alpha.folder, "Shared plan.odt"));
  await files.makeShortcut(home.id, join(alpha.folder, "Shared plan.odt"));
  assert.deepEqual(find(alpha.id, "Shared plan.odt")!.alsoIn!.sort(), [beta.id, home.id].sort());
  const there = find(beta.id, "Shared plan.odt")!;
  assert.deepEqual(there.status, ["shortcut"]);
  assert.deepEqual(there.livesIn, { project: alpha.id, path: "Shared plan.odt" });
  assert.deepEqual(there.alsoIn!.sort(), [alpha.id, home.id].sort());
  await assert.rejects(() => files.makeShortcut(alpha.id, join(alpha.folder, "Shared plan.odt")), /already in this project's folder/);
});

test("a folder linked: every file in it a shortcut, hidden ones aside; watched for new files; a file changed, read anew", async () => {
  const p = projects.createProject("Receipts project");
  const dir = join(sandbox, "Receipts");
  mkdirSync(join(dir, "2026", "march"), { recursive: true });
  mkdirSync(join(dir, ".cache"), { recursive: true });
  mkdirSync(join(dir, "node_modules"), { recursive: true });
  writeFileSync(join(dir, "a.txt"), "first");
  writeFileSync(join(dir, "2026", "march", "b.pdf"), "pdf");
  writeFileSync(join(dir, ".cache", "no.txt"), "no");
  writeFileSync(join(dir, "node_modules", "no.js"), "no");
  assert.equal(files.folderFiles(dir).paths.length, 2, "two files, hidden and machinery aside");
  const got = await files.linkFolder(p.id, dir);
  assert.deepEqual([got.made, got.skipped], [2, 0]);
  assert.deepEqual(files.foldersLinked(p.id).map((f) => f.folder), [dir]);
  const shortcuts = () => files.listFiles({ project: p.id }).rows.filter((r) => r.status.includes("shortcut"));
  assert.equal(shortcuts().length, 2);
  // A file added later: linked at the next look.
  writeFileSync(join(dir, "2026", "c.csv"), "a,b");
  const before = files.filesVersion();
  assert.ok(await files.watchLinked() >= 1);
  assert.equal(shortcuts().length, 3);
  assert.ok(files.filesVersion() > before, "a change says so, so search reads it");
  // A file changed: its new contents' hash taken, so search reads it again.
  const sha = () => shortcuts().find((r) => r.name === "a.txt")!;
  const was = JSON.stringify(sha());
  writeFileSync(join(dir, "a.txt"), "second, and longer");
  await files.watchLinked();
  await links.rehashed();
  assert.notEqual(JSON.stringify(sha()), was);
  // One taken out by hand: not linked again by the watch.
  const out = shortcuts().find((r) => r.name === "c.csv")!;
  assert.equal(files.removeShortcut(out.entity!).fromWatched, true);
  await files.watchLinked();
  assert.ok(!shortcuts().some((r) => r.name === "c.csv"), "stays out");
  // Linked again on purpose: what was taken out comes back with it; nothing twice.
  assert.equal((await files.linkFolder(p.id, dir)).made, 1);
  assert.equal(files.unlinkFolder(p.id, dir), 3, "its three files out of the project");
  assert.deepEqual(files.foldersLinked(p.id), []);
  assert.equal(shortcuts().length, 0, "unlinked: its files no longer in the project");
  assert.ok(existsSync(join(dir, "a.txt")), "and the files themselves where they were");
});

test("a linked folder watched: a file put in it linked, one deleted or moved out let go — with no look asked for", async () => {
  const p = projects.createProject("Watched project");
  const dir = join(sandbox, "Watched");
  mkdirSync(join(dir, "inner"), { recursive: true });
  writeFileSync(join(dir, "keep.txt"), "keep");
  writeFileSync(join(dir, "inner", "gone.txt"), "gone");
  writeFileSync(join(sandbox, "alone.md"), "a file linked on its own");
  await files.linkFolder(p.id, dir);
  await files.makeShortcut(p.id, join(sandbox, "alone.md"));
  const names = () => files.listFiles({ project: p.id }).rows.filter((r) => r.status.includes("shortcut")).map((r) => r.name).sort();
  assert.deepEqual(names(), ["alone.md", "gone.txt", "keep.txt"]);
  // For the project pane: the folder with its count; the file linked on its own apart.
  const linked = files.linkedInto(p.id);
  assert.deepEqual(linked.folders.map((f) => [f.folder, f.files]), [[dir, 2]]);
  assert.deepEqual(linked.files.map((f) => f.name), ["alone.md"]);
  // Changed on disk, nobody asking: the watch sees it.
  writeFileSync(join(dir, "inner", "new.txt"), "new");
  rmSync(join(dir, "inner", "gone.txt"));
  const until = async (ok: () => boolean) => { for (let i = 0; i < 60 && !ok(); i++) await new Promise((r) => setTimeout(r, 100)); };
  await until(() => names().includes("new.txt") && !names().includes("gone.txt"));
  assert.deepEqual(names(), ["alone.md", "keep.txt", "new.txt"], "new linked, gone let go — not kept as missing");
  // Refreshed by hand: the same, at once.
  writeFileSync(join(dir, "now.txt"), "now");
  assert.ok(await files.syncFolder(p.id, dir) >= 1);
  assert.ok(names().includes("now.txt"));
  // Unlinked: the folder's files leave; the one linked on its own stays.
  files.unlinkFolder(p.id, dir);
  assert.deepEqual(names(), ["alone.md"]);
  writeFileSync(join(dir, "after.txt"), "after");
  await new Promise((r) => setTimeout(r, 2500));
  assert.deepEqual(names(), ["alone.md"], "no longer watched: nothing new linked from it");
});
