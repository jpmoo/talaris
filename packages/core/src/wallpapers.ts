// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore

/**
 * Wallpapers, Talaris's own: a picture chosen as one is copied in — never a
 * link to where it was — into `<data>/wallpapers/`, named by its contents, so
 * the wallpaper is there whatever happens to the original, and it travels.
 *
 * **Between machines** (docs/SYNC.md): its bytes kept by hash in the sync
 * folder (sync-files.ts, `putBlob`) and a record of it (`wallpaper:<name>`);
 * another machine fetches them and writes the same file at the same path — so
 * the settings that name it (surfaces/prefsync.py) mean it there too.
 *
 * A color's picture (surfaces/wallpaper.py, `color-<hex>.png`) is made where it
 * is wanted and is not carried.
 */

import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { DATA_DIR } from "./vault.js";
import { getBlob, putBlob } from "./sync-files.js";
import { write } from "./records.js";
import { writeAtomic } from "./store.js";

export const WALLPAPERS = () => join(DATA_DIR, "wallpapers");
const PICTURE = /\.(jpe?g|png|webp)$/i;

/** A picture copied in (or found already there): its path in Talaris's own wallpapers. */
export function keepWallpaper(path: string): string {
  if (!existsSync(path) || !statSync(path).isFile() || !PICTURE.test(path)) throw new Error("not a picture: a .jpg, .png or .webp");
  const dir = WALLPAPERS();
  if (path.startsWith(dir + "/")) return path;
  const bytes = readFileSync(path);
  const sha = createHash("sha256").update(bytes).digest("hex");
  const name = `${sha.slice(0, 16)}${extname(path).toLowerCase()}`;
  const kept = join(dir, name);
  if (!existsSync(kept)) {
    mkdirSync(dir, { recursive: true });
    copyFileSync(path, kept);
  }
  putBlob(sha, bytes);
  write({ of: `wallpaper:${name}`, set: { sha, size: bytes.length } });
  return kept;
}

/** Another machine's wallpaper (sync-apply.ts): written here at the same name. False if its bytes have not come. */
export function writeWallpaper(name: string, sha: string): boolean {
  if (!/^[0-9a-f]{16}\.(jpe?g|png|webp)$/.test(name)) return false;
  const kept = join(WALLPAPERS(), name);
  if (existsSync(kept)) return true;
  const bytes = getBlob(sha);
  if (!bytes) return false;
  mkdirSync(WALLPAPERS(), { recursive: true });
  writeAtomic(kept, bytes);
  return true;
}
