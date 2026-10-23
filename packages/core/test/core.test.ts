// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import type { Server } from "node:http";

// Every path is decided at import, so the sandbox has to exist first: these
// tests never see the real ~/Projects or ~/.config.
const sandbox = mkdtempSync(join(tmpdir(), "talaris-core-"));
process.env.TALARIS_PROJECTS = join(sandbox, "Projects");
process.env.TALARIS_CONFIG_DIR = join(sandbox, "config");
process.env.TALARIS_STATE_DIR = join(sandbox, "state");
const SOCKET = join(sandbox, "core.sock");

const projects = await import("../src/projects.js");
const canvases = await import("../src/canvases.js");
const pages = await import("../src/pages.js");
const versions = await import("../src/versions.js");
const { listen } = await import("../src/server.js");

let server: Server;
before(async () => { server = await listen(SOCKET); });
after(() => { server.close(); rmSync(sandbox, { recursive: true, force: true }); });

function call(method: string, path: string, body?: unknown): Promise<{ status: number; data: any }> {
  return new Promise((ok, fail) => {
    const req = request({ socketPath: SOCKET, method, path, headers: { "content-type": "application/json" } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let data: any = text;
        try { data = JSON.parse(text); } catch { /* markdown */ }
        ok({ status: res.statusCode ?? 0, data });
      });
    });
    req.on("error", fail);
    if (body !== undefined) req.write(typeof body === "string" ? body : JSON.stringify(body));
    req.end();
  });
}

test("Home is made once, as PRJ-00, with a canvas and a Writing folder", () => {
  const home = projects.ensureHome();
  assert.equal(home.code, "PRJ-00");
  assert.equal(home.name, "Home");
  assert.ok(existsSync(join(home.folder, "Writing")));
  assert.ok(existsSync(join(home.folder, ".talaris", "project.json")));
  assert.equal(projects.ensureHome().id, home.id, "a second start finds the same Home");
});

test("projects count up from PRJ-01 and a folder that is already full is refused", () => {
  const a = projects.createProject("Ogham");
  const b = projects.createProject("Brigid / notes");
  assert.equal(a.code, "PRJ-01");
  assert.equal(b.code, "PRJ-02");
  assert.ok(b.folder.endsWith("Brigid - notes"), "a slash in a name does not become a path");
  mkdirSync(join(process.env.TALARIS_PROJECTS!, "Busy"));
  writeFileSync(join(process.env.TALARIS_PROJECTS!, "Busy", "thing.txt"), "x");
  assert.throws(() => projects.createProject("Busy"), projects.Conflict);
});

test("adopting a git repository keeps .talaris out of it, locally", () => {
  const repo = join(sandbox, "elsewhere", "ogham-code");
  mkdirSync(join(repo, ".git", "info"), { recursive: true });
  const p = projects.adoptFolder(repo, "Ogham code");
  assert.match(readFileSync(join(repo, ".git", "info", "exclude"), "utf8"), /^\/\.talaris\/$/m);
  assert.ok(projects.listProjects().some((x) => x.id === p.id), "found though outside the projects root");
});

test("canvases nest: a child gets a card on its one parent, and the tree shows it", () => {
  const p = projects.createProject("Tree");
  const top = projects.readProject(p.folder).topCanvas;
  const { canvas: stage } = canvases.createChild(p.id, top, "Stage 3", { x: 40, y: 60 });
  const tree = canvases.canvasTree(p.id);
  assert.equal(tree.children[0]?.title, "Stage 3");
  const parent = canvases.readCanvas(p.id, top);
  assert.ok(parent.items.some((i) => i.kind === "canvas" && i.canvas === stage.id));
});

test("a save that drops a child's card is refused unless it says detach", () => {
  const p = projects.createProject("Detach");
  const top = projects.readProject(p.folder).topCanvas;
  canvases.createChild(p.id, top, "Child");
  const doc = canvases.readCanvas(p.id, top);
  assert.throws(() => canvases.writeCanvas(p.id, { ...doc, items: [] }), /take "Child" off/);
  canvases.writeCanvas(p.id, { ...doc, items: [] }, { detach: true });
  assert.equal(canvases.canvasTree(p.id).children.length, 1, "the child still exists, only off the canvas");
});

test("keys a canvas does not know survive a save", () => {
  const p = projects.createProject("Unknown keys");
  const top = projects.readProject(p.folder).topCanvas;
  const doc = canvases.readCanvas(p.id, top);
  const withExtras = { ...doc, "plugin:hermes": { synced: 3 }, items: [{ id: "it_1", x: 1, y: 2, w: 3, h: 4, futureThing: true }] };
  canvases.writeCanvas(p.id, withExtras as any);
  const back = canvases.readCanvas(p.id, top) as any;
  assert.deepEqual(back["plugin:hermes"], { synced: 3 });
  assert.equal(back.items[0].futureThing, true);
});

test("a canvas can have many links, from any project, and lists them", () => {
  const x = projects.createProject("X Project");
  const home = projects.ensureHome();
  const xTop = projects.readProject(x.folder).topCanvas;
  const { canvas: stage } = canvases.createChild(x.id, xTop, "Stage 3");
  const homeTop = canvases.readCanvas(home.id, projects.readProject(home.folder).topCanvas);
  canvases.writeCanvas(home.id, {
    ...homeTop,
    items: [...homeTop.items, { id: "it_link", kind: "canvas-link", canvas: stage.id, project: x.id, x: 0, y: 0, w: 1, h: 1 }],
  });
  const links = canvases.backlinks(x.id, stage.id);
  assert.equal(links.length, 1);
  assert.equal(links[0]?.project, home.id);
});

test("the top canvas cannot be deleted, nor one with children", () => {
  const p = projects.createProject("Deletes");
  const top = projects.readProject(p.folder).topCanvas;
  const { canvas: a } = canvases.createChild(p.id, top, "A");
  canvases.createChild(p.id, a.id, "A1");
  assert.throws(() => canvases.deleteCanvas(p.id, top), /top canvas/);
  assert.throws(() => canvases.deleteCanvas(p.id, a.id), /below it/);
});

test("pages nest on disk as a file and a folder of its name, in Talaris's order", () => {
  const p = projects.createProject("Pages");
  pages.createPage(p.id, null, "Zebra");
  const camp = pages.createPage(p.id, null, "Camp rules");
  pages.createPage(p.id, camp.path, "Hourly rolls");
  assert.ok(existsSync(join(p.folder, "Writing", "Camp rules.md")));
  assert.ok(existsSync(join(p.folder, "Writing", "Camp rules", "Hourly rolls.md")));
  const tree = pages.pageTree(p.id);
  assert.deepEqual(tree.map((n) => n.title), ["Zebra", "Camp rules"], "made order, not alphabetical");
  assert.equal(tree[1]?.children[0]?.path, "Camp rules/Hourly rolls");
});

test("a page that arrives from outside is listed at the end, not ignored", () => {
  const p = projects.createProject("Outside");
  pages.createPage(p.id, null, "Mine");
  writeFileSync(join(p.folder, "Writing", "Synced in.md"), "hello");
  assert.deepEqual(pages.pageTree(p.id).map((n) => n.title), ["Mine", "Synced in"]);
});

test("moving a page takes its children, versions and order with it", () => {
  const p = projects.createProject("Moves");
  const a = pages.createPage(p.id, null, "A");
  pages.createPage(p.id, a.path, "A child");
  pages.writePage(p.id, "A", "text of A");
  const b = pages.createPage(p.id, null, "B");
  const moved = pages.movePage(p.id, "A", b.path, "Renamed");
  assert.equal(moved.path, "B/Renamed");
  assert.equal(pages.readPage(p.id, "B/Renamed"), "text of A");
  assert.ok(existsSync(join(p.folder, "Writing", "B", "Renamed", "A child.md")));
  assert.equal(pages.pageVersions(p.id, "B/Renamed").length, 1, "its versions came along");
  assert.throws(() => pages.movePage(p.id, "B", "B/Renamed"), /inside itself/);
});

test("daily notes are pages in Writing/Daily, on in Home, counted by month", () => {
  const home = projects.ensureHome();
  assert.equal(pages.dailyEnabled(home.id), true, "Home keeps daily notes by default");
  assert.equal(pages.dailyEnabled(projects.createProject("No dailies").id), false);
  pages.writePage(home.id, "Daily/2026-10-23", "Three words here");
  pages.writePage(home.id, "Daily/2026-10-24", "");
  pages.writePage(home.id, "Daily/2026-11-01", "Next month");
  assert.ok(existsSync(join(home.folder, "Writing", "Daily", "2026-10-23.md")));
  assert.deepEqual(pages.dailyMonth(home.id, "2026-10"), [{ date: "2026-10-23", words: 3 }], "an emptied day is not a note");
  assert.throws(() => pages.dailyMonth(home.id, "October"), projects.Conflict);
});

test("an export lands in the project's Exports folder, named and never overwriting", () => {
  const p = projects.createProject("Exporting");
  const one = projects.writeExport(p.id, "Camp / plan", "png", Buffer.from("x"));
  const two = projects.writeExport(p.id, "Camp / plan", "png", Buffer.from("y"));
  assert.equal(one, "Exports/Camp - plan.png");
  assert.equal(two, "Exports/Camp - plan 2.png");
  assert.equal(readFileSync(join(p.folder, "Exports", "Camp - plan.png"), "utf8"), "x");
  assert.throws(() => projects.writeExport(p.id, "x", "exe", Buffer.from("")), projects.Conflict);
});

test("page paths cannot leave Writing", () => {
  const p = projects.createProject("Escapes");
  assert.throws(() => pages.writePage(p.id, "../../etc/x", "no"), projects.Conflict);
  assert.throws(() => pages.writePage(p.id, ".hidden", "no"), projects.Conflict);
});

test("a burst of saves is one version; a pause starts the next; age thins them", () => {
  const dir = join(sandbox, "v");
  const t0 = new Date("2026-01-01T10:00:00Z");
  versions.saveVersion(dir, "one", "md", t0);
  versions.saveVersion(dir, "two", "md", new Date(t0.getTime() + 60_000));
  assert.equal(versions.listVersions(dir).length, 1, "within the burst, replaced");
  assert.equal(versions.readVersion(dir, versions.listVersions(dir)[0]!.name), "two");
  versions.saveVersion(dir, "three", "md", new Date(t0.getTime() + 10 * 60_000));
  assert.equal(versions.listVersions(dir).length, 2);
  versions.saveVersion(dir, "three", "md", new Date(t0.getTime() + 20 * 60_000));
  assert.equal(versions.listVersions(dir).length, 2, "unchanged content is not a version");
  // Two days later, both of those fell in the same hour: thinning keeps one.
  versions.thin(dir, new Date(t0.getTime() + 2 * 24 * 3_600_000));
  assert.equal(versions.listVersions(dir).length, 1);
});

test("restoring a canvas version is itself a save", () => {
  const p = projects.createProject("Restore");
  const top = projects.readProject(p.folder).topCanvas;
  const doc = canvases.readCanvas(p.id, top);
  canvases.writeCanvas(p.id, { ...doc, title: "First" });
  const first = canvases.canvasVersions(p.id, top)[0]!.name;
  // Force a new version rather than a burst replacement by moving its stamp back.
  const dir = versions.versionDir(join(p.folder, ".talaris"), "canvas", top);
  const old = join(dir, first);
  const renamed = join(dir, "2020-01-01T00-00-00-000Z.json");
  writeFileSync(renamed, readFileSync(old)); rmSync(old);
  canvases.writeCanvas(p.id, { ...doc, title: "Second" });
  canvases.restoreCanvas(p.id, top, "2020-01-01T00-00-00-000Z.json");
  assert.equal(canvases.readCanvas(p.id, top).title, "First");
});

test("the socket answers, with errors that say what was wrong", async () => {
  const health = await call("GET", "/health");
  assert.equal(health.status, 200);
  assert.equal(health.data.name, "talaris-core");
  const made = await call("POST", "/projects", { name: "Over the wire" });
  assert.equal(made.status, 200);
  const tree = await call("GET", `/projects/${made.data.id}/canvases`);
  assert.equal(tree.status, 200);
  const page = await call("POST", `/projects/${made.data.id}/pages`, { title: "Notes" });
  assert.equal(page.status, 200);
  const put = await call("PUT", `/projects/${made.data.id}/page?path=${encodeURIComponent("Notes")}`, "# Hi\n");
  assert.equal(put.status, 200);
  const got = await call("GET", `/projects/${made.data.id}/page?path=Notes`);
  assert.equal(got.data, "# Hi\n");
  assert.equal((await call("GET", "/projects/prj_nothing")).status, 404);
  assert.equal((await call("POST", "/projects", {})).status, 400);
  assert.equal((await call("DELETE", `/projects/${made.data.id}/canvases/${tree.data.id}`)).status, 409);
  assert.ok(readdirSync(join(process.env.TALARIS_PROJECTS!, "Over the wire", "Writing")).includes("Notes.md"));
});

test("a second core refuses to take a live socket", async () => {
  await assert.rejects(listen(SOCKET), /another talaris-core/);
});
