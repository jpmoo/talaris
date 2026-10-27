// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore

// The pages of no project moved from their own folder into Home's Pages, once, each the same note it was.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const sandbox = mkdtempSync(join(tmpdir(), "talaris-pageshome-"));
process.env.TALARIS_DATA_DIR = join(sandbox, "data");
process.env.TALARIS_PROJECTS = join(sandbox, "Projects");
process.env.TALARIS_CONFIG_DIR = join(sandbox, "config");
process.env.TALARIS_STATE_DIR = join(sandbox, "state");
process.env.TALARIS_KEY = randomBytes(32).toString("base64");

const projects = await import("../src/projects.js");
const entities = await import("../src/entities.js");
const notes = await import("../src/notes.js");
const pages = await import("../src/pages.js");
const filetext = await import("../src/filetext.js");
const suggest = await import("../src/suggest.js");
const { movePagesIntoHome } = await import("../src/pages-home.js");

after(() => rmSync(sandbox, { recursive: true, force: true }));

const home = projects.ensureHome();
const old = projects.notesFolder();
const put = (rel: string, text: string) => { mkdirSync(join(old, rel, ".."), { recursive: true }); writeFileSync(join(old, rel), text); };
// The old place, as it was: pages straight in it, nested by folder, with its order, look and versions.
put("Alpha.md", "first");
put("Beta.md", "second");
put("Beta/Gamma.md", "under beta");
put(".talaris/writing-order.json", JSON.stringify({ "": ["Beta", "Alpha"], Beta: ["Gamma"] }));
put(".talaris/writing-look.json", JSON.stringify({ Alpha: { starred: true, paper: "#fdf3d8" } }));
put(`.talaris/versions/page/${encodeURIComponent("Beta/Gamma")}/2026-10-01.md`, "older words");
// Each one's entity as Hermes Notes knows it: marked undated, at its old address.
const note = (id: string, path: string) => entities.createEntity({ id, type: entities.typeFor("note").id, properties: { title: path.split("/").pop()!, body: "" },
  sources: [{ kind: "page", key: `notes/${path}` }], "talaris:textElsewhere": true, [notes.MARK]: true });
note("e_alpha", "Alpha");
note("e_beta", "Beta");
note("e_gamma", "Beta/Gamma");
filetext.setPageAbout("page:notes/Alpha", "stamp", "About alpha", true);
filetext.saveFileText();
suggest.dismiss("page:notes/Beta", "e:someone");

test("before the move, the notes are not tidied: one at its old address is not taken for gone", () => {
  notes.reconcileNotes();
  for (const id of ["e_alpha", "e_beta", "e_gamma"]) assert.equal(entities.getEntity(id)[notes.MARK], true);
});

test("moved into Home's Pages: the files, their order, look and versions; each the same entity, still undated", () => {
  const said = movePagesIntoHome();
  assert.equal(said.moved, 3, "Alpha.md, Beta.md and Beta/");
  assert.equal(said.entities, 3);
  assert.ok(said.backup && existsSync(join(said.backup, "Notes", "Alpha.md")) && existsSync(join(said.backup, "data")), "a copy of before");
  assert.ok(!existsSync(old), "the old folder gone");
  assert.equal(pages.readPage(home.id, "Pages/Beta/Gamma"), "under beta");
  // In Home's tree, in their order, under Pages.
  const tree = pages.pageTree(home.id).find((n) => n.path === "Pages")!;
  assert.deepEqual(tree.children.map((n) => n.title), ["Beta", "Alpha"]);
  assert.equal(pages.pageLook(home.id, "Pages/Alpha").paper, "#fdf3d8");
  assert.ok(pages.pageVersions(home.id, "Pages/Beta/Gamma").length >= 1, "its versions with it");
  for (const [id, path] of [["e_alpha", "Alpha"], ["e_beta", "Beta"], ["e_gamma", "Beta/Gamma"]] as const) {
    const e = entities.getEntity(id);
    assert.equal(e[notes.MARK], true, `${id} still undated`);
    assert.deepEqual(e["talaris:sources"], [{ kind: "page", key: `${home.id}/Pages/${path}` }]);
  }
  // Tidied now, nothing is lost: every note is where its entity says.
  notes.reconcileNotes();
  for (const id of ["e_alpha", "e_beta", "e_gamma"]) assert.equal(entities.getEntity(id)[notes.MARK], true);
  // Its description, and a suggestion said no to, at the new key.
  assert.equal(filetext.pageAbout(`page:${home.id}/Pages/Alpha`, "stamp"), "About alpha");
  suggest.undismiss("e:someone");
  assert.equal(suggest.undismiss(`page:${home.id}/Pages/Beta`), 0, "already let go with e:someone — it was the same pair");
});

test("done once: asked again, nothing happens", () => {
  assert.deepEqual(movePagesIntoHome(), { moved: 0, entities: 0 });
  assert.ok(readdirSync(join(home.folder, "Writing", "Pages")).includes("Alpha.md"));
});

test("a note made now is made in Home's Pages", () => {
  const made = notes.createNote("e_new", "Fresh", "new words");
  assert.equal(made[notes.MARK], true);
  assert.equal(pages.readPage(home.id, "Pages/Fresh"), "new words");
});
