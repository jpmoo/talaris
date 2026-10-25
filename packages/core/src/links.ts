// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore

/*
 * Linked files: an attachment that points at a file where it is, rather than
 * keeping a copy of it (a snapshot, `putFile`).
 *
 * A link is an ordinary attachment value — a name, a media type, the hash of
 * its contents — carrying where the file is (`talaris:link`: its path, in the
 * home folder, and the size and time it was last seen at). So to the format,
 * and to Hermes Notes, it is an attachment like any other; only Talaris knows
 * it is a link. Its bytes are never kept: asked for by hash (the live
 * binding's /interchange/files, a sync handing it over), they are read from
 * the file, and checked against the hash first.
 *
 * Looked at again (`refreshLinks`) whenever the binding is read and when a
 * task is opened: a file changed is a new hash — which a sync then carries as
 * a new version — and a file gone is marked missing and keeps its last hash,
 * so the other side keeps its last copy rather than losing it.
 *
 * Nothing here ever deletes a linked file. Taking a link off a task takes the
 * link off; the file stays where it is.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { allRecords, forgetFiles, getEntity, getFile, putFile, trusted, types, updateEntity as storeUpdate, type Entity } from "./entities.js";
/** Every write here makes or keeps links, which only this file and its callers may (entities.ts, `trusted`). */
const updateEntity: typeof storeUpdate = (id, patch) => trusted(() => storeUpdate(id, patch));
import { Conflict, NotFound } from "./projects.js";

export const LINK = "talaris:link";
const MISSING = "talaris:missing";

type Value = { kind: "attachment"; filename: string; mediaType?: string; sha256: string; [LINK]?: { path: string; size: number; mtime: number }; [MISSING]?: boolean; [k: string]: unknown };

const home = () => resolve(process.env.TALARIS_LINK_HOME ?? homedir());

/** Where a path really is: through any symlink, as far as it exists; the rest as written. */
export function real(path: string): string {
  let at = path, rest = "";
  for (;;) {
    try { return join(realpathSync(at), rest); } catch { /* not there yet */ }
    const up = dirname(at);
    if (up === at) return path;
    rest = join(basename(at), rest);
    at = up;
  }
}
/** Whether a path is in the home folder — really, through symlinks: a link reaches no further. */
export function homeHolds(path: string): boolean {
  const h = real(home()), full = real(resolve(path));
  return full === h || full.startsWith(h + "/");
}
/** A path inside the home folder, resolved — or refused. */
function inHome(path: string): string {
  const full = resolve(path.replace(/^~(?=$|\/)/, home()));
  if (!homeHolds(full)) throw new Conflict("a link points at a file in your home folder");
  return full;
}

const TYPES: Record<string, string> = {
  ".pdf": "application/pdf", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
  ".svg": "image/svg+xml", ".txt": "text/plain", ".md": "text/markdown", ".csv": "text/csv", ".html": "text/html",
  ".odt": "application/vnd.oasis.opendocument.text", ".ods": "application/vnd.oasis.opendocument.spreadsheet",
  ".odp": "application/vnd.oasis.opendocument.presentation",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};
const typeOf = (name: string) => TYPES[extname(name).toLowerCase()];
const hashOf = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

/** The field a thing keeps its files in: the first `attachment` field its type declares, found by its kind. */
export function filesField(o: Entity): string {
  const f = types().find((x) => x.id === o.type)?.fields.find((x) => x.kind === "attachment");
  if (!f) throw new Conflict("this kind of thing keeps no files");
  return f.key;
}
const valuesIn = (v: unknown): Value[] => (Array.isArray(v) ? v : v ? [v] : []).filter((x): x is Value => Boolean(x) && typeof x === "object" && (x as Value).kind === "attachment");

/** A file in the home folder, linked on a thing: its hash now, and where it is. */
export function linkFile(entityId: string, path: string): Value {
  const full = inHome(path);
  if (!existsSync(full) || !statSync(full).isFile()) throw new NotFound(`no file at ${full}`);
  const st = statSync(full);
  const bytes = readFileSync(full);
  const filename = basename(full);
  const value: Value = { kind: "attachment", filename, ...(typeOf(filename) ? { mediaType: typeOf(filename) } : {}), sha256: hashOf(bytes),
    [LINK]: { path: full, size: st.size, mtime: st.mtimeMs } };
  const o = getEntity(entityId);
  const key = filesField(o);
  const now = valuesIn(o.properties[key]);
  // The same file linked again, or the same contents already kept: one value.
  if (now.some((a) => a[LINK]?.path === full || a.sha256 === value.sha256)) return now.find((a) => a[LINK]?.path === full || a.sha256 === value.sha256)!;
  updateEntity(entityId, { properties: { [key]: [...now, value] } });
  return value;
}

/**
 * Linked files looked at again (every thing's, or only those named): changed
 * since last seen, a new hash; gone, marked missing and its hash kept; back,
 * no longer missing. Answers how many things changed.
 */
export function refreshLinks(ids?: string[]): number {
  let changed = 0;
  const records = ids ? ids.map((id) => { try { return getEntity(id); } catch { return null; } }).filter((x): x is Entity => Boolean(x)) : allRecords().map((r) => r.object);
  for (const o of records) {
    let dirty = false;
    const props: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(o.properties ?? {})) {
      const list = valuesIn(v);
      if (!list.some((a) => a[LINK])) continue;
      const next = list.map((a) => {
        const link = a[LINK];
        if (!link) return a;
        // A path outside the home folder (however it got there) is never read: taken as missing.
        if (!homeHolds(link.path) || !existsSync(link.path)) { if (a[MISSING]) return a; dirty = true; return { ...a, [MISSING]: true }; }
        const st = statSync(link.path);
        if (st.size === link.size && st.mtimeMs === link.mtime && !a[MISSING]) return a;
        dirty = true;
        const { [MISSING]: _gone, ...rest } = a;
        return { ...rest, sha256: hashOf(readFileSync(link.path)), [LINK]: { path: link.path, size: st.size, mtime: st.mtimeMs } } as Value;
      });
      props[key] = Array.isArray(v) ? next : next[0];
    }
    if (dirty) { updateEntity(o.id, { properties: props }); changed++; }
  }
  return changed;
}

/** The bytes of a linked file with this hash, read from where it is — and only if they still are that file. */
export function linkedBytes(sha256: string): Buffer | null {
  for (const { object: o } of allRecords()) {
    for (const v of Object.values(o.properties ?? {})) {
      for (const a of valuesIn(v)) {
        if (a.sha256 !== sha256 || !a[LINK] || !homeHolds(a[LINK].path) || !existsSync(a[LINK].path)) continue;
        const bytes = readFileSync(a[LINK].path);
        if (hashOf(bytes) === sha256) return bytes;
      }
    }
  }
  return null;
}

/**
 * A write naming files by hash, as a sync does (it knows nothing of links):
 * where it names one this thing links, the link is kept — its path, its
 * missing mark — rather than the link becoming a copy nobody holds.
 */
export function keepLinks(before: Record<string, unknown> | undefined, set: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!set) return set;
  const out: Record<string, unknown> = { ...set };
  for (const [key, v] of Object.entries(set)) {
    const had = valuesIn(before?.[key]).filter((a) => a[LINK]);
    if (!had.length) continue;
    const bySha = new Map(had.map((a) => [a.sha256, a]));
    const keep = (x: unknown) => {
      const a = x as Value;
      return a && typeof a === "object" && a.kind === "attachment" && bySha.has(a.sha256) ? { ...a, ...bySha.get(a.sha256)!, filename: a.filename ?? bySha.get(a.sha256)!.filename } : x;
    };
    out[key] = Array.isArray(v) ? v.map(keep) : keep(v);
  }
  return out;
}

/** One of a thing's attachments, by hash, with the field it is in. */
function find(entityId: string, sha256: string): { o: Entity; key: string; list: Value[]; at: number } {
  const o = getEntity(entityId);
  const key = filesField(o);
  const list = valuesIn(o.properties[key]);
  const at = list.findIndex((a) => a.sha256 === sha256);
  if (at < 0) throw new NotFound(`no file ${sha256} on ${entityId}`);
  return { o, key, list, at };
}

/** A link made a copy: its contents kept, as they are now, and the link let go. The file itself is untouched. */
export function toSnapshot(entityId: string, sha256: string): Value {
  const { key, list, at } = find(entityId, sha256);
  const a = list[at]!;
  if (!a[LINK]) return a;
  const bytes = linkedBytes(a.sha256) ?? (existsSync(a[LINK].path) ? readFileSync(a[LINK].path) : null);
  if (!bytes) throw new NotFound(`${a.filename} is not where it was linked, so there is nothing to copy`);
  const kept = putFile(bytes, a.filename, a.mediaType) as Value;
  const next = [...list];
  next[at] = kept;
  updateEntity(entityId, { properties: { [key]: next } });
  return kept;
}

/**
 * A copy made a link: written as a file into `folder` (a free name there), and
 * linked; the copy freed if nothing else keeps it — the file now holds it.
 */
export function toLink(entityId: string, sha256: string, folder: string): Value {
  const { key, list, at } = find(entityId, sha256);
  const a = list[at]!;
  if (a[LINK]) return a;
  const bytes = getFile(a.sha256);
  if (!bytes) throw new NotFound(`${a.filename} is not held, so there is nothing to save`);
  const dir = inHome(folder);
  mkdirSync(dir, { recursive: true });
  const ext = extname(a.filename), stem = a.filename.slice(0, a.filename.length - ext.length) || "attachment";
  let path = join(dir, a.filename);
  for (let n = 2; existsSync(path); n++) path = join(dir, `${stem} ${n}${ext}`);
  writeFileSync(path, bytes);
  const st = statSync(path);
  const linked: Value = { kind: "attachment", filename: basename(path), ...(a.mediaType ? { mediaType: a.mediaType } : {}), sha256: a.sha256,
    [LINK]: { path, size: st.size, mtime: st.mtimeMs } };
  const next = [...list];
  next[at] = linked;
  updateEntity(entityId, { properties: { [key]: next } });
  forgetFiles([a.sha256]);
  return linked;
}

/** Where to put back a file whose folder is gone: set by the server (a thing's project's Files, or Home's). */
let fallbackFolder: (entityId: string) => string = () => join(home(), "Documents");
export function setFallbackFolder(f: (entityId: string) => string): void { fallbackFolder = f; }

/**
 * Missing linked files put back from copies the store holds — a sync hands
 * them over first (Restore missing files, the Hermes Notes plugin). Each goes
 * to where it was; its folder gone, to the thing's project's Files; something
 * else at that path now, beside it as "… (restored)", never over it. The
 * copy is freed once the file holds it. Answers how many came back.
 */
export function restoreLinks(entityId: string): { restored: number; still: string[] } {
  const o = getEntity(entityId);
  let restored = 0;
  const still: string[] = [];
  const props: Record<string, unknown> = {};
  const freed: string[] = [];
  for (const [key, v] of Object.entries(o.properties ?? {})) {
    const list = valuesIn(v);
    if (!list.some((a) => a[LINK] && a[MISSING])) continue;
    props[key] = (Array.isArray(v) ? list : list.slice(0, 1)).map((a) => {
      const link = a[LINK];
      if (!link || !a[MISSING]) return a;
      const bytes = getFile(a.sha256);
      if (!bytes) { still.push(a.filename); return a; }
      let path = link.path;
      // Put back only inside the home folder, checked before any folder is made for it.
      if (!homeHolds(path)) { still.push(a.filename); return a; }
      if (!existsSync(join(path, ".."))) path = join(fallbackFolder(entityId), basename(path));
      if (!homeHolds(path)) { still.push(a.filename); return a; }
      if (existsSync(path)) {
        const ext = extname(path), stem = path.slice(0, path.length - ext.length);
        path = `${stem} (restored)${ext}`;
        for (let n = 2; existsSync(path); n++) path = `${stem} (restored ${n})${ext}`;
      }
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(inHome(path), bytes);
      const st = statSync(path);
      restored++;
      freed.push(a.sha256);
      const { [MISSING]: _gone, ...rest } = a;
      return { ...rest, filename: basename(path), [LINK]: { path, size: st.size, mtime: st.mtimeMs } } as Value;
    });
    if (!Array.isArray(v)) props[key] = (props[key] as Value[])[0];
  }
  if (restored) { updateEntity(entityId, { properties: props }); forgetFiles(freed); }
  return { restored, still };
}

/** The plugin's mark on a copy that came from Hermes Notes, stored only in Talaris, in no folder. */
export const FROM_HERMES = "hermes-sync:origin";

/**
 * Files in no folder: links whose file is gone, and
 * copies that came in from elsewhere (a sync's mark) and were never saved as
 * a file. For Tasks' header and its warnings.
 */
export function unbacked(): { id: string; title: string; missing: string[]; onlyHere: string[] }[] {
  const out: { id: string; title: string; missing: string[]; onlyHere: string[] }[] = [];
  for (const { object: o } of allRecords()) {
    if (o.archived) continue;
    const missing: string[] = [], onlyHere: string[] = [];
    for (const v of Object.values(o.properties ?? {})) {
      for (const a of valuesIn(v)) {
        if (a[LINK] && a[MISSING]) missing.push(a.filename);
        else if (!a[LINK] && a[FROM_HERMES]) onlyHere.push(a.filename);
      }
    }
    if (missing.length || onlyHere.length) out.push({ id: o.id, title: String(o.properties?.title ?? "Untitled"), missing, onlyHere });
  }
  return out;
}
