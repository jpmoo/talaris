// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { MACHINERY, WRITING } from "./paths.js";
import { findProject, listProjects, readProject } from "./projects.js";
import { isSealed, seal, unseal } from "./seal.js";
import { setSealer, writeAtomic, writeJson } from "./store.js";
import { storeKey } from "./vault.js";

/**
 * Encrypted projects: a choice per project (Settings → Data), never the
 * default, because a project is a folder other applications save into.
 *
 * **What is sealed** is what Talaris writes there: the pages in `Writing/`,
 * and everything in `.talaris/` but `project.json` — canvases, versions, the
 * order and look of pages. **What is not:** the names of pages (they are file
 * names), `project.json` (its name and code, so the project can be listed
 * before it is opened), exported pictures, and anything another application
 * saved into the folder. Those are the person's files, and theirs to protect;
 * the disk's own encryption is what covers them.
 *
 * Sealing happens where the core writes (`store.writeAtomic`) and opening where
 * it reads (`store.readText`), so the rest of the core does not know.
 */

let folders = new Set<string>();
// While a project is being converted, writes go out as they are given.
let bypass = false;

function refresh(): void {
  const next = new Set<string>();
  for (const p of listProjects()) {
    try {
      if (readProject(p.folder).encrypted === true) next.add(p.folder);
    } catch {
      // A project that cannot be read is listed elsewhere as such.
    }
  }
  folders = next;
}

/** Is this file one an encrypted project keeps sealed? */
function sealable(folder: string, path: string): boolean {
  const rel = relative(folder, path);
  if (rel.startsWith("..")) return false;
  const parts = rel.split(sep);
  if (parts[0] === WRITING) return rel.endsWith(".md");
  if (parts[0] === MACHINERY) return rel !== join(MACHINERY, "project.json");
  return false;
}

function folderOf(path: string): string | null {
  for (const f of folders) if (path.startsWith(f + sep)) return f;
  return null;
}

/** Start sealing: called once the core is up. */
export function startSealing(): void {
  refresh();
  setSealer({
    keyFor: (path) => {
      if (bypass) return null;
      const f = folderOf(path);
      return f && sealable(f, path) ? storeKey() : null;
    },
    seal: (key, data) => seal(key, data),
    isSealed,
    open: (data) => unseal(storeKey(), data),
  });
}

/** Every file of a project that Talaris seals when it is encrypted. */
function files(folder: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const n of readdirSync(dir)) {
      if (n.endsWith(".tmp")) continue;
      const p = join(dir, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (sealable(folder, p)) out.push(p);
    }
  };
  walk(join(folder, WRITING));
  walk(join(folder, MACHINERY));
  return out;
}

/** Read with one key (or none), write with another (or none). */
function rewrite(path: string, from: Buffer | null, to: Buffer | null): void {
  const data = readFileSync(path);
  const plain = isSealed(data) ? (from ? unseal(from, data) : null) : data;
  if (plain === null) throw new Error(`${path} is sealed and there is no key to open it`);
  // Written past writeAtomic's own sealing, which follows the registry, not this.
  const out = to ? seal(to, plain) : plain;
  bypass = true;
  try {
    writeAtomic(path, out);
  } finally {
    bypass = false;
  }
}

/**
 * Encrypt a project, or stop. Every file Talaris keeps there is rewritten,
 * then the project says so. Half-way through, a project still reads: reading
 * opens whatever is sealed, whichever way it is going.
 */
export function setProjectEncrypted(projectId: string, on: boolean): { files: number } {
  const { folder } = findProject(projectId);
  const key = storeKey();
  const list = files(folder);
  for (const f of list) rewrite(f, key, on ? key : null);
  const project = readProject(folder);
  writeJson(join(folder, MACHINERY, "project.json"), { ...project, encrypted: on || undefined });
  refresh();
  return { files: list.length };
}

/** After a revival brings another key: every encrypted project sealed again with it. */
export function resealProjects(before: Buffer, after: Buffer): number {
  let n = 0;
  for (const folder of folders) {
    for (const f of files(folder)) {
      rewrite(f, before, after);
      n++;
    }
  }
  return n;
}

export function encryptedProjects(): string[] {
  return listProjects().filter((p) => folders.has(p.folder)).map((p) => p.id);
}
