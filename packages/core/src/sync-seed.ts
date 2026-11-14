// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore

/**
 * Seeding (docs/SYNC.md, *Joining*): this machine's whole Talaris written into
 * its log once, as records of everything as it is — so a machine joining is
 * filled from it, record by record, by the same code that applies any change.
 *
 * Done on the machine others join, when sync is first set up there. Its
 * records are stamped now, so on a machine joining afresh they win over
 * anything there; what that machine had is moved aside before it joins
 * (join.ts), not merged in.
 *
 * In order — projects, then their canvases and their own files, then
 * entities, pages, the small stores, the Library's files — so nothing applied
 * finds what it belongs to missing.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { write, diff, syncing } from "./records.js";
import { listProjects } from "./projects.js";
import { MACHINERY, WRITING } from "./paths.js";
import { readText } from "./store.js";
import { placeOf, recordsOf } from "./project-records.js";
import { sealedEntries, seedEntities } from "./entities.js";
import { aliasMap } from "./merge.js";
import { keptState } from "./suggest.js";
import { seedFiles } from "./sync-files.js";

/** The small sealed stores that are yours (the rest of the data folder is each machine's own). */
export const SEALED_STORES = ["lists", "series", "tasks-prefs", "people-prefs", "forgotten-cards"];

function writeFileRecords(path: string): void {
  const at = placeOf(path);
  if (!at) return;
  let text = "";
  try { text = readText(path); } catch { return; }
  for (const change of recordsOf(at, null, text)) write(change);
}

function pagesIn(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const n of readdirSync(dir)) {
    const full = join(dir, n);
    if (statSync(full).isDirectory()) out.push(...pagesIn(full));
    else if (n.endsWith(".md")) out.push(full);
  }
  return out;
}

/** Everything, written as records. Says how many things were seeded. */
export function seed(): number {
  if (!syncing()) throw new Error("sync is not set up on this machine");
  let n = 0;
  const projects = listProjects();
  // The projects themselves, Home first.
  for (const p of [...projects].sort((a, b) => Number(b.home) - Number(a.home))) {
    writeFileRecords(join(p.folder, MACHINERY, "project.json"));
    n++;
  }
  // Each project's canvases, then its other own files.
  for (const p of projects) {
    const canvases = join(p.folder, MACHINERY, "canvases");
    if (existsSync(canvases)) for (const f of readdirSync(canvases).filter((x) => x.endsWith(".json"))) { writeFileRecords(join(canvases, f)); n++; }
    const own = join(p.folder, MACHINERY);
    if (existsSync(own)) for (const f of readdirSync(own).filter((x) => x.endsWith(".json") && x !== "project.json")) writeFileRecords(join(own, f));
  }
  // Every entity.
  n += seedEntities();
  // Every page.
  for (const p of projects) for (const page of pagesIn(join(p.folder, WRITING))) { writeFileRecords(page); n++; }
  // The small stores, what was done once, merges, dismissals.
  for (const folder of SEALED_STORES) {
    const { records, once } = sealedEntries(folder);
    for (const [id, value] of records) {
      const fields = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : { value };
      write(diff(`sealed:${folder}/${id}`, null, fields, new Set(["members"])));
      n++;
    }
    for (const what of once) write({ of: `once:${folder}/${what}`, set: { done: true } });
  }
  const merged = aliasMap();
  if (Object.keys(merged).length) write({ of: "merged", set: { ...merged } });
  const kept = keptState();
  if (kept.no.length || kept.quiet.length) write({ of: "suggest", add: { no: [...kept.no], quiet: [...kept.quiet] } });
  // The Library's files, with their bytes.
  n += seedFiles();
  return n;
}
