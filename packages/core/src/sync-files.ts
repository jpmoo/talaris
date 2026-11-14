// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore

/**
 * The Library's files between machines (docs/SYNC.md; step 2b): every file in
 * a project's folder that is not Talaris's own (`.talaris/`) or a page
 * (`Writing/`, which travel as page records) — `Files/`, `Exports/`, anything
 * put there by hand.
 *
 * **Found by looking**: a file changed by any program — saved from LibreOffice,
 * dropped in by the file manager — is noticed when the projects are looked
 * over (`scanFiles`, each sync), by its size and time, and then its contents'
 * hash. A changed one is a record (`file:<project>/<path>`: its hash and
 * size), and its bytes are kept, sealed, under their hash (`blobs/`), once
 * whatever their name or wherever they are.
 *
 * **Applied** (sync-apply.ts): its bytes fetched by hash and written in place;
 * this machine's list of what it has (`files.json`) kept in step, so what was
 * applied is not taken for a change of its own.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { DATA_DIR, storeKey } from "./vault.js";
import { seal, unseal } from "./seal.js";
import { readBytes, writeAtomic } from "./store.js";
import { allProjects as listProjects, findProject } from "./projects.js";
import { MACHINERY, WRITING } from "./paths.js";
import { syncing, write } from "./records.js";

interface Known { size: number; mtime: number; sha: string }
const STATE = () => join(DATA_DIR, "sync", "files.json");
let known: Record<string, Known> | null = null;
function knownFiles(): Record<string, Known> {
  if (known) return known;
  try { known = JSON.parse(readFileSync(STATE(), "utf8")) as Record<string, Known>; } catch { known = {}; }
  return known;
}
function saveKnown(): void {
  mkdirSync(dirname(STATE()), { recursive: true });
  writeFileSync(STATE(), JSON.stringify(knownFiles()));
}

/** Where sealed bytes wait to travel: the sync folder's, when there is one (sync-folder.ts sets it), else here. */
let blobPlace = () => join(DATA_DIR, "sync", "blobs");
export function blobsAt(place: () => string): void { blobPlace = place; }
const LOCAL_BLOBS = () => join(DATA_DIR, "sync", "blobs");

export function putBlob(sha: string, bytes: Buffer): void {
  const dir = blobPlace();
  const path = join(dir, sha);
  if (existsSync(path)) return;
  mkdirSync(dir, { recursive: true });
  writeAtomic(path, seal(storeKey(), bytes));
}
export function getBlob(sha: string): Buffer | null {
  for (const dir of [blobPlace(), LOCAL_BLOBS()]) {
    const path = join(dir, sha);
    if (existsSync(path)) { try { return unseal(storeKey(), readFileSync(path)); } catch { /* torn; the other */ } }
  }
  return null;
}

/** Every Library file of every project: `<project id>/<path>` → its full path. */
function libraryFiles(): Map<string, string> {
  const out = new Map<string, string>();
  for (const p of listProjects()) {
    const walk = (dir: string) => {
      let names: string[] = [];
      try { names = readdirSync(dir); } catch { return; }
      for (const n of names) {
        if (n.startsWith(".") || n.endsWith(".tmp")) continue;
        const full = join(dir, n);
        const rel = relative(p.folder, full).split(sep).join("/");
        if (rel === MACHINERY || rel === WRITING || rel === "Archived") continue;
        let st;
        try { st = statSync(full); } catch { continue; }
        if (st.isDirectory()) walk(full);
        else if (st.isFile()) out.set(`${p.id}/${rel}`, full);
      }
    };
    walk(p.folder);
  }
  return out;
}

/** The projects looked over: each file changed since last seen, a record, its bytes kept by hash. Says how many. */
export function scanFiles(): number {
  if (!syncing()) return 0;
  const k = knownFiles();
  const now = libraryFiles();
  let n = 0;
  for (const [key, path] of now) {
    let st;
    try { st = statSync(path); } catch { continue; }
    const had = k[key];
    if (had && had.size === st.size && had.mtime === st.mtimeMs) continue;
    let bytes: Buffer;
    try { bytes = readBytes(path); } catch { continue; }
    const sha = createHash("sha256").update(bytes).digest("hex");
    k[key] = { size: st.size, mtime: st.mtimeMs, sha };
    if (had?.sha === sha) continue;
    putBlob(sha, bytes);
    write({ of: `file:${key}`, set: { sha, size: bytes.length } });
    n++;
  }
  for (const key of Object.keys(k)) {
    if (now.has(key)) continue;
    delete k[key];
    write({ of: `file:${key}`, gone: true });
    n++;
  }
  saveKnown();
  return n;
}

/** Seeding (sync-seed.ts): every file, as if never seen. */
export function seedFiles(): number {
  known = {};
  return scanFiles();
}

/** Where a `file:` record's file is here, or null if its project is not. */
function placeOfFile(of: string): { path: string; key: string } | null {
  const key = of.slice("file:".length);
  const cut = key.indexOf("/");
  try { return { path: join(findProject(key.slice(0, cut)).folder, ...key.slice(cut + 1).split("/")), key }; } catch { return null; }
}

/** The file a record names, as it says: its bytes, by hash. False if they have not come yet. */
export function writeLibraryFile(of: string, sha: string): boolean {
  const at = placeOfFile(of);
  if (!at) return false;
  const k = knownFiles();
  if (k[at.key]?.sha === sha && existsSync(at.path)) return true;
  const bytes = getBlob(sha);
  if (!bytes) return false;
  mkdirSync(dirname(at.path), { recursive: true });
  writeAtomic(at.path, bytes);
  const st = statSync(at.path);
  k[at.key] = { size: st.size, mtime: st.mtimeMs, sha };
  saveKnown();
  return true;
}
export function removeLibraryFile(of: string): boolean {
  const at = placeOfFile(of);
  if (!at || !existsSync(at.path)) return false;
  rmSync(at.path, { force: true });
  delete knownFiles()[at.key];
  saveKnown();
  return true;
}
/** What this machine has for a file now: its hash, if it is here. */
export function libraryFileSha(of: string): string | null {
  const at = placeOfFile(of);
  return at && existsSync(at.path) ? knownFiles()[at.key]?.sha ?? null : null;
}
