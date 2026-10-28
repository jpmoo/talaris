// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore

/**
 * Clipboard history (DESIGN, *Clipboard history*), after Notchnik's: what was
 * copied — words, a picture, a file, several files — kept, newest first, the
 * pinned before the rest, found again and put back on the clipboard.
 *
 * **Sealed**, as entities are (seal.ts): passwords and keys get copied, so the
 * history is no plain file. The list is one sealed JSON; a picture is its own
 * sealed file beside it, read only when asked for.
 *
 * The surfaces watch the clipboard and hand each copy here (`addClip`); what a
 * password manager marks as secret never reaches this (surfaces/clipboard.py).
 * Each copy is a new clip, as Notchnik keeps them — only the same thing copied
 * again straight away is not a second one. Unpinned clips past `keep` go,
 * oldest first; pinned ones stay. Morgan does not read it.
 */

import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { seal, unseal } from "./seal.js";
import { writeAtomic } from "./store.js";
import { DATA_DIR, storeKey } from "./vault.js";

export type ClipKind = "text" | "image" | "file" | "files";

export interface Clip {
  id: string;
  kind: ClipKind;
  /** When it was copied, in milliseconds. */
  at: number;
  pinned?: boolean;
  /** The words (text), or none. */
  text?: string;
  /** The file or files (file, files): absolute paths. */
  paths?: string[];
  /** A picture's type, as the clipboard gave it (image). */
  mime?: string;
  /** What it is, for telling the same copy again: words, paths or bytes, hashed. */
  hash: string;
}

/** How many unpinned clips are kept, unless Settings says (`keep`): Notchnik's own. */
export const KEEP = 50;
/** The least and most Settings may keep. */
export const KEEP_RANGE: [number, number] = [10, 500];

const DIR = () => join(DATA_DIR, "clipboard");
const INDEX = () => join(DIR(), "history.sealed");
const PICTURE = (id: string) => join(DIR(), `${id}.sealed`);

let clips: Clip[] | null = null;

function load(): Clip[] {
  if (clips) return clips;
  clips = [];
  if (existsSync(INDEX())) {
    try { clips = JSON.parse(unseal(storeKey(), readFileSync(INDEX())).toString("utf8")) as Clip[]; } catch { clips = []; }
  }
  return clips;
}

function save(): void {
  mkdirSync(DIR(), { recursive: true, mode: 0o700 });
  writeAtomic(INDEX(), seal(storeKey(), JSON.stringify(load())));
}

/** The pinned first (newest copied first), then the rest, newest first: as Notchnik shows them. */
export function listClips(): Clip[] {
  // Of two copied in one millisecond, the one kept after is the newer.
  const all = load().map((c, i) => ({ c, i }));
  const newest = (a: { c: Clip; i: number }, b: { c: Clip; i: number }) => b.c.at - a.c.at || b.i - a.i;
  return [...all.filter((x) => x.c.pinned).sort(newest), ...all.filter((x) => !x.c.pinned).sort(newest)].map((x) => x.c);
}

const sha = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");

export interface NewClip { kind: ClipKind; text?: string; paths?: string[]; image?: string; mime?: string }

/**
 * A copy, kept: words, a picture (base64), a file or several. The same as the
 * newest clip already is no new one (it answers that one, `added` false).
 */
export function addClip(c: NewClip, keep = KEEP): { clip: Clip; added: boolean } {
  const all = load();
  const bytes = c.kind === "image" ? Buffer.from(c.image ?? "", "base64") : null;
  if (c.kind === "image" && !bytes?.length) throw new Error("a picture with nothing in it");
  if (c.kind === "text" && !c.text) throw new Error("no words");
  if ((c.kind === "file" || c.kind === "files") && !c.paths?.length) throw new Error("no files");
  const hash = sha(bytes ?? (c.kind === "text" ? `t:${c.text}` : `f:${(c.paths ?? []).join("\n")}`));
  // The last copied: the latest time, and of two in one millisecond the one kept after.
  const newest = all.reduce<Clip | undefined>((n, c) => (!n || c.at >= n.at ? c : n), undefined);
  if (newest && newest.hash === hash) return { clip: newest, added: false };
  const clip: Clip = {
    id: randomUUID(), kind: c.kind, at: Date.now(), hash,
    ...(c.kind === "text" ? { text: c.text } : {}),
    ...(c.kind === "file" || c.kind === "files" ? { paths: c.paths } : {}),
    ...(c.kind === "image" ? { mime: c.mime || "image/png" } : {}),
  };
  if (bytes) {
    mkdirSync(DIR(), { recursive: true, mode: 0o700 });
    writeAtomic(PICTURE(clip.id), seal(storeKey(), bytes));
  }
  all.push(clip);
  trim(keep);
  save();
  return { clip, added: true };
}

/** Unpinned clips past `keep`, oldest first, gone — and their pictures with them. */
function trim(keep: number): void {
  const all = load();
  const n = Math.max(KEEP_RANGE[0], Math.min(KEEP_RANGE[1], Math.round(keep) || KEEP));
  const unpinned = all.filter((c) => !c.pinned).sort((a, b) => b.at - a.at);
  for (const c of unpinned.slice(n)) forget(c);
}

function forget(c: Clip): void {
  const all = load();
  const i = all.findIndex((x) => x.id === c.id);
  if (i >= 0) all.splice(i, 1);
  if (c.kind === "image") rmSync(PICTURE(c.id), { force: true });
}

/** A picture's bytes, unsealed; null for a clip that is no picture, or one gone. */
export function clipPicture(id: string): { bytes: Buffer; mime: string } | null {
  const c = load().find((x) => x.id === id);
  if (!c || c.kind !== "image" || !existsSync(PICTURE(id))) return null;
  return { bytes: unseal(storeKey(), readFileSync(PICTURE(id))), mime: c.mime || "image/png" };
}

export function clipById(id: string): Clip | null {
  return load().find((x) => x.id === id) ?? null;
}

/** Pinned (kept, and shown first), or not. */
export function pinClip(id: string, on: boolean): Clip | null {
  const c = load().find((x) => x.id === id);
  if (!c) return null;
  if (on) c.pinned = true; else delete c.pinned;
  save();
  return c;
}

/** One clip gone. */
export function removeClip(id: string): boolean {
  const c = load().find((x) => x.id === id);
  if (!c) return false;
  forget(c);
  save();
  return true;
}

/** Every clip gone, the pinned too — as Notchnik's Clear all. */
export function clearClips(): void {
  for (const c of [...load()]) forget(c);
  save();
}

/** Kept to a new number now (Settings changed it). */
export function keepClips(keep: number): void {
  trim(keep);
  save();
}

/** For a test: forgotten in memory, read again from disk. */
export function forgetLoadedClips(): void { clips = null; }
