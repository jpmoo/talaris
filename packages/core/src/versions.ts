// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { VersionEntry } from "@talaris/model";
import { readText, writeAtomic } from "./store.js";

/**
 * Versions of canvases and pages, kept as plain copies so they can be seen and
 * restored with nothing but a file manager.
 *
 * **A burst of edits is one version.** A canvas is written on every drag; a
 * version per drag would be thousands an afternoon. So a save within
 * `BURST_MS` of the newest version replaces it, and the newest version is
 * always the latest state — then the next save after a pause starts a new one.
 *
 * **Thinned with age**: everything from the last hour, one an hour for a day,
 * one a day for a month, one a week after that.
 */
export const BURST_MS = 5 * 60_000;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** Where one thing's versions are kept: `<project>/.talaris/versions/<kind>/<key>/`. */
export function versionDir(machinery: string, kind: "canvas" | "page", key: string): string {
  return join(machinery, "versions", kind, encodeURIComponent(key));
}

/** File names are the save time, so sorting them sorts by time. */
function stamp(date: Date): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

function parse(name: string): Date {
  const base = name.replace(/\.[a-z]+$/, "");
  // 2026-10-23T10-15-00-000Z → 2026-10-23T10:15:00.000Z
  const iso = base.replace(/T(\d\d)-(\d\d)-(\d\d)-(\d\d\d)Z$/, "T$1:$2:$3.$4Z");
  return new Date(iso);
}

export function listVersions(dir: string): VersionEntry[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => !n.startsWith("."))
    .sort()
    .reverse()
    .map((name) => ({ name, at: parse(name).toISOString() }));
}

export function readVersion(dir: string, name: string): string {
  if (name.includes("/") || name.startsWith(".")) throw new Error("not a version name");
  return readText(join(dir, name));
}

export function saveVersion(dir: string, content: string, ext: string, now = new Date()): void {
  mkdirSync(dir, { recursive: true });
  const existing = listVersions(dir);
  const newest = existing[0];
  if (newest && readVersion(dir, newest.name) === content) return;
  if (newest && now.getTime() - new Date(newest.at).getTime() < BURST_MS) {
    rmSync(join(dir, newest.name));
  }
  writeAtomic(join(dir, `${stamp(now)}.${ext}`), content);
  thin(dir, now);
}

/**
 * Keep the newest version in each bucket. Buckets widen with age, so a busy
 * afternoon a month ago is one version, not three hundred.
 */
export function thin(dir: string, now = new Date()): void {
  const seen = new Set<string>();
  for (const v of listVersions(dir)) {
    const age = now.getTime() - new Date(v.at).getTime();
    const t = new Date(v.at).getTime();
    const bucket =
      age < HOUR ? `all:${v.name}` :
      age < DAY ? `h:${Math.floor(t / HOUR)}` :
      age < 30 * DAY ? `d:${Math.floor(t / DAY)}` :
      `w:${Math.floor(t / (7 * DAY))}`;
    if (seen.has(bucket)) rmSync(join(dir, v.name));
    else seen.add(bucket);
  }
}
