// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore

import { mkdirSync, openSync, writeSync, fsyncSync, closeSync, renameSync, readFileSync } from "node:fs";
import { dirname, basename, join } from "node:path";
import { randomBytes } from "node:crypto";

/**
 * Write a file so that a crash leaves either the old one or the new one, never
 * half of either: write beside it, flush to disk, then rename over it. A rename
 * within one directory is atomic, which is the whole trick.
 */
export function writeAtomic(path: string, data: string | Buffer): void {
  mkdirSync(dirname(path), { recursive: true });
  // A file inside an encrypted project is sealed on its way to disk.
  const key = sealer?.keyFor(path);
  if (key) data = sealer!.seal(key, data);
  const tmp = join(dirname(path), `.${basename(path)}.${randomBytes(4).toString("hex")}.tmp`);
  const fd = openSync(tmp, "w", 0o644);
  try {
    writeSync(fd, typeof data === "string" ? Buffer.from(data, "utf8") : data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

export function writeJson(path: string, value: unknown): void {
  writeAtomic(path, JSON.stringify(value, null, 2) + "\n");
}

export function readJson<T>(path: string): T {
  return JSON.parse(readText(path)) as T;
}

/**
 * A file's text, opened first if it is sealed. Every file a project's pages,
 * canvases and versions are read from comes through here, so an encrypted
 * project reads like any other, and one half-way through being encrypted —
 * some files sealed, some not yet — reads too.
 */
export function readText(path: string): string {
  const data = readFileSync(path);
  return (sealer && sealer.isSealed(data) ? sealer.open(data) : data).toString("utf8");
}

/** A file's bytes, opened first if sealed: an attachment, which is not text. */
export function readBytes(path: string): Buffer {
  const data = readFileSync(path);
  return sealer && sealer.isSealed(data) ? sealer.open(data) : data;
}

/** Whether a file on disk is sealed: it cannot be handed to another program as it is. */
export function isSealedFile(path: string): boolean {
  return Boolean(sealer && sealer.isSealed(readFileSync(path)));
}

/**
 * How files are sealed, set by `sealed-projects.ts` — which knows the projects
 * and the key — so that this, the bottom of everything, depends on neither.
 */
export interface Sealer {
  keyFor(path: string): Buffer | null;
  seal(key: Buffer, data: string | Buffer): Buffer;
  isSealed(data: Buffer): boolean;
  open(data: Buffer): Buffer;
}
let sealer: Sealer | null = null;
export function setSealer(s: Sealer | null): void {
  sealer = s;
}

/** Short ids, prefixed by what they are, so a stray one in a log says what it was. */
export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(6).toString("base64url").replace(/[-_]/g, "x").toLowerCase()}`;
}
