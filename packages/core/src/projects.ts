// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { FORMAT_VERSION, type CanvasDocument, type Project, type ProjectSummary } from "@talaris/model";
import { CONFIG_DIR, FILES, MACHINERY, WRITING, projectsRoot } from "./paths.js";
import { isSealedFile, newId, readBytes, readJson, writeAtomic, writeJson } from "./store.js";

/**
 * A project is a folder: whatever the user and their applications put there,
 * plus `.talaris/` with Talaris's own files. The folder is the project — moving
 * it moves everything — so Talaris finds projects by looking, not by keeping a
 * list that could disagree with the disk. The one list it keeps is of folders
 * adopted from *outside* the projects root, which looking cannot find.
 */

export class NotFound extends Error {}
export class Conflict extends Error {}

const ADOPTED = () => join(CONFIG_DIR, "adopted.json");

function adoptedFolders(): string[] {
  try {
    return readJson<string[]>(ADOPTED());
  } catch {
    return [];
  }
}

export function projectFile(folder: string): string {
  return join(folder, MACHINERY, "project.json");
}

function summary(folder: string): ProjectSummary | null {
  try {
    const p = readJson<Project>(projectFile(folder));
    return { id: p.id, code: p.code, name: p.name, folder, home: p.home === true };
  } catch {
    return null;
  }
}

export function listProjects(): ProjectSummary[] {
  const root = projectsRoot();
  const folders = new Set<string>();
  if (existsSync(root)) {
    for (const name of readdirSync(root)) {
      const folder = join(root, name);
      if (!name.startsWith(".") && statSync(folder).isDirectory()) folders.add(folder);
    }
  }
  for (const folder of adoptedFolders()) folders.add(folder);
  const found = [...folders].map(summary).filter((p): p is ProjectSummary => p !== null);
  // Home first, then by code — the order projects were made in.
  return found.sort((a, b) => Number(b.home) - Number(a.home) || a.code.localeCompare(b.code));
}

export function findProject(id: string): ProjectSummary {
  const p = listProjects().find((x) => x.id === id);
  if (!p) throw new NotFound(`no project ${id}`);
  return p;
}

export function readProject(folder: string): Project {
  return readJson<Project>(projectFile(folder));
}

/** `PRJ-00` is Home; the rest count up and are never reused. */
function nextCode(): string {
  const used = listProjects().map((p) => Number(p.code.replace(/\D/g, "")) || 0);
  const next = used.length ? Math.max(...used) + 1 : 1;
  return `PRJ-${String(next).padStart(2, "0")}`;
}

/** A folder name from a project name: anything a file system would refuse, or read as a path, goes. */
export function folderName(name: string): string {
  const cleaned = name.replace(/[/\\\0]/g, "-").replace(/^\.+/, "").trim();
  if (!cleaned) throw new Conflict("a project needs a name");
  return cleaned;
}

function topCanvas(projectId: string, title: string): CanvasDocument {
  return {
    format: FORMAT_VERSION,
    id: newId("cv"),
    project: projectId,
    parent: null,
    title,
    items: [],
    links: [],
    regions: [],
  };
}

/**
 * Make a project in `folder`, which may already exist with the user's files in
 * it — that is adopting. A folder that already has `.talaris/` is already a
 * project and is refused rather than overwritten.
 */
function initialize(folder: string, name: string, options: { home?: boolean } = {}): ProjectSummary {
  if (existsSync(projectFile(folder))) throw new Conflict(`${folder} is already a project`);
  mkdirSync(join(folder, MACHINERY, "canvases"), { recursive: true });
  mkdirSync(join(folder, WRITING), { recursive: true });
  const id = newId("prj");
  const canvas = topCanvas(id, "Canvas");
  const project: Project = {
    format: FORMAT_VERSION,
    id,
    code: options.home ? "PRJ-00" : nextCode(),
    name,
    created: new Date().toISOString(),
    topCanvas: canvas.id,
    ...(options.home ? { home: true } : {}),
  };
  writeJson(join(folder, MACHINERY, "canvases", `${canvas.id}.json`), canvas);
  // project.json last: until it exists the folder is not a project, so a crash
  // partway leaves a folder that can simply be made a project again.
  writeJson(projectFile(folder), project);
  excludeFromGit(folder);
  return { id, code: project.code, name, folder, home: options.home === true };
}

/**
 * In a git repository, keep `.talaris/` out of it — through the repository's
 * own `info/exclude`, which is local and never committed, so nobody else's
 * checkout ever hears of Talaris.
 */
function excludeFromGit(folder: string): void {
  const exclude = join(folder, ".git", "info", "exclude");
  if (!existsSync(join(folder, ".git"))) return;
  try {
    const current = existsSync(exclude) ? readFileSync(exclude, "utf8") : "";
    if (current.split("\n").some((line) => line.trim() === `/${MACHINERY}/`)) return;
    mkdirSync(join(folder, ".git", "info"), { recursive: true });
    appendFileSync(exclude, `${current && !current.endsWith("\n") ? "\n" : ""}/${MACHINERY}/\n`);
  } catch {
    // A worktree's .git is a file, not a folder; leaving it alone is right.
  }
}

export function createProject(name: string): ProjectSummary {
  const folder = join(projectsRoot(), folderName(name));
  if (existsSync(folder) && readdirSync(folder).length) {
    throw new Conflict(`${folder} already exists — adopt it instead`);
  }
  return initialize(folder, name.trim());
}

export function adoptFolder(path: string, name?: string): ProjectSummary {
  const folder = resolve(path);
  if (!existsSync(folder) || !statSync(folder).isDirectory()) throw new NotFound(`${folder} is not a folder`);
  const made = initialize(folder, (name ?? folder.split("/").pop() ?? "Project").trim());
  const inRoot = resolve(folder, "..") === resolve(projectsRoot());
  if (!inRoot) writeJson(ADOPTED(), [...new Set([...adoptedFolders(), folder])]);
  return made;
}

/** Home is the project that is always there; made on first start. */
export function ensureHome(): ProjectSummary {
  const home = listProjects().find((p) => p.home);
  if (home) return home;
  return initialize(join(projectsRoot(), "Home"), "Home", { home: true });
}

/**
 * Files Talaris makes for you — a canvas exported as a picture — go in the
 * project's visible `Exports/` folder, beside `Writing/`: the project is a
 * folder, and what comes out of it belongs in it. No save dialog: the name is
 * the canvas's and the date, made unique if the day already has one.
 */
export const EXPORTS = "Exports";

export function writeExport(projectId: string, base: string, ext: string, data: Buffer): string {
  if (!/^(png|pdf)$/.test(ext)) throw new Conflict("an export is a png or a pdf");
  const { folder } = findProject(projectId);
  const dir = join(folder, EXPORTS);
  mkdirSync(dir, { recursive: true });
  const stem = (base.replace(/[/\\\0]/g, "-").replace(/^\.+/, "").trim() || "Canvas").slice(0, 120);
  let name = `${stem}.${ext}`;
  for (let n = 2; existsSync(join(dir, name)); n++) name = `${stem} ${n}.${ext}`;
  writeAtomic(join(dir, name), data);
  return join(EXPORTS, name);
}

/**
 * A file attached to a page or a canvas note: kept in the project's visible
 * `Files/` folder — a project's files live in it, by what they are for, not
 * in a store of their own — under its own name, made unique beside another
 * of the same name. Sealed there when the project is encrypted
 * (sealed-projects.ts). Answers its path within the project, which is what
 * a page or a note links it by.
 */
export function putProjectFile(projectId: string, filename: string, data: Buffer): { path: string; name: string } {
  const { folder } = findProject(projectId);
  const dir = join(folder, FILES);
  mkdirSync(dir, { recursive: true });
  const clean = (filename.replace(/[/\\\0]/g, "-").replace(/^\.+/, "").trim() || "file").slice(0, 160);
  const dot = clean.lastIndexOf(".");
  const [stem, ext] = dot > 0 ? [clean.slice(0, dot), clean.slice(dot)] : [clean, ""];
  let name = clean;
  for (let n = 2; existsSync(join(dir, name)); n++) name = `${stem} ${n}${ext}`;
  writeAtomic(join(dir, name), data);
  return { path: `${FILES}/${name}`, name };
}

/**
 * Where a file in a project's folder is on disk: an attachment in `Files/`,
 * an export, anything saved there — what Glance lists and opens. Never above
 * the folder, and never Talaris's own machinery (`.talaris/`).
 */
export function attachedFile(projectId: string, rel: string): { abs: string; sealed: boolean } {
  const { folder } = findProject(projectId);
  const parts = rel.split("/");
  if (parts[0] === MACHINERY || parts.some((p) => !p || p === "." || p === ".." || p.includes("\\") || p.includes("\0"))) {
    throw new Conflict("not a file of this project's");
  }
  const abs = join(folder, ...parts);
  if (!existsSync(abs)) throw new NotFound(`no file ${rel}`);
  return { abs, sealed: isSealedFile(abs) };
}

export function readProjectFile(projectId: string, rel: string): Buffer {
  return readBytes(attachedFile(projectId, rel).abs);
}

/**
 * A project's name changed: what the bar, the dock and Tasks call it. Its
 * folder keeps the name it was made with — other applications, and Nextcloud,
 * know it by that.
 */
export function renameProject(projectId: string, name: string): ProjectSummary {
  const clean = name.trim().slice(0, 120);
  if (!clean) throw new Conflict("a project needs a name");
  const { folder } = findProject(projectId);
  writeJson(projectFile(folder), { ...readProject(folder), name: clean });
  return findProject(projectId);
}

