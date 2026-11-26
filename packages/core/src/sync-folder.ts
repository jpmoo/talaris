// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore

/**
 * The folder transport (docs/SYNC.md, *Transport*): the machines' logs carried
 * by a folder that something else keeps in step — Syncthing, Nextcloud, a
 * network share. Talaris only writes into it and reads from it.
 *
 *   <folder>/<machine>/machine.json   its name
 *   <folder>/<machine>/log/NNNNNN     its log, as it writes it (records.ts), sealed line by line
 *   <folder>/blobs/<sha256>           a Library file's bytes, sealed (sync-files.ts)
 *   <folder>/attachments/<sha256>     an entity's attached file, as the store keeps it (already sealed)
 *
 * No file there is written by two machines, so whatever carries the folder
 * never has a conflict of its own to settle.
 *
 * Every few seconds (`tick`): what came from the others is applied, from where
 * this machine left off with each (`seen.json`); the projects are looked over
 * for files changed by other programs; and what this machine wrote goes out.
 * A file's record that arrives before its bytes waits, and is tried again.
 */

import { viewBlob } from "./calendar-view.js";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR, ENTITIES_DIR, readVault, storeKey } from "./vault.js";
import { unseal } from "./seal.js";
import { compactOwnLog, machine, syncing, type Rec } from "./records.js";
import { apply, known, tellScreens } from "./sync-apply.js";
import { blobsAt, getBlob, scanFiles } from "./sync-files.js";
import { isInstalled, pluginStateBlobs } from "./plugins.js";

const STATE = () => join(DATA_DIR, "sync");
const FOLDER_FILE = () => join(STATE(), "folder");

/** The sync folder, if this machine has one: set in Settings (`setFolder`), or by TALARIS_SYNC_FOLDER. */
export function syncFolder(): string | null {
  if (process.env.TALARIS_SYNC_FOLDER) return process.env.TALARIS_SYNC_FOLDER;
  try { return readFileSync(FOLDER_FILE(), "utf8").trim() || null; } catch { return null; }
}
export function setFolder(path: string | null): void {
  mkdirSync(STATE(), { recursive: true });
  writeFileSync(FOLDER_FILE(), path ?? "");
}

// ------------------------------------------------------------ out

/** Copied whole if its size differs: a log only grows, and is replaced by a rename, so a reader never sees half. */
function copyIfGrown(from: string, to: string): void {
  if (existsSync(to) && statSync(to).size === statSync(from).size) return;
  mkdirSync(join(to, ".."), { recursive: true });
  const tmp = `${to}.part`;
  copyFileSync(from, tmp);
  renameSync(tmp, to);
}

function push(folder: string): void {
  const me = machine();
  const mine = join(folder, me.id);
  mkdirSync(join(mine, "log"), { recursive: true });
  const info = join(mine, "machine.json");
  if (!existsSync(info)) writeFileSync(info, JSON.stringify({ id: me.id, name: me.name }));
  // The store key's public record, for a machine joining (join.ts): its key is sealed to the recovery key, which
  // only the person has — so a joining machine takes the same key by typing that, and nothing here opens it.
  // Written again when it changes: a recovery key replaced (Settings, Data) is the one a machine joining types.
  const v = readVault();
  const shared = join(folder, "vault.json");
  const now = v ? JSON.stringify({ publicKey: v.publicKey, wrapped: v.wrapped, check: v.check }) : "";
  if (v && (!existsSync(shared) || readFileSync(shared, "utf8") !== now)) writeFileSync(shared, now);
  const logs = join(STATE(), "log", me.id);
  if (existsSync(logs)) for (const n of readdirSync(logs)) copyIfGrown(join(logs, n), join(mine, "log", n));
  // How far this machine has read each other's log: for each to know which of its own files all have read (`trim`).
  const seenNow = existsSync(SEEN()) ? readFileSync(SEEN(), "utf8") : "{}";
  const seenOut = join(mine, "seen.json");
  if (!existsSync(seenOut) || readFileSync(seenOut, "utf8") !== seenNow) writeFileSync(seenOut, seenNow);
  // Attached files, as the store keeps them (sealed already): each once.
  const blobs = join(ENTITIES_DIR, "blobs");
  const out = join(folder, "attachments");
  if (existsSync(blobs)) {
    mkdirSync(out, { recursive: true });
    const there = new Set(readdirSync(out));
    for (const n of readdirSync(blobs)) if (!there.has(n)) copyIfGrown(join(blobs, n), join(out, n));
  }
  // Library bytes written here before there was a folder: out now.
  const local = join(STATE(), "blobs");
  if (existsSync(local)) for (const n of readdirSync(local)) copyIfGrown(join(local, n), join(folder, "blobs", n));
}

// ------------------------------------------------------------ in

interface Seen { [machine: string]: { file: string; line: number } }
const SEEN = () => join(STATE(), "seen.json");
const WAITING = () => join(STATE(), "waiting.json");
function readState<T>(path: string, fallback: T): T {
  try { return JSON.parse(readFileSync(path, "utf8")) as T; } catch { return fallback; }
}

/** What the others wrote since this machine last looked, in their order. */
function incoming(folder: string, seen: Seen): Rec[] {
  const me = machine().id;
  const out: Rec[] = [];
  for (const other of readdirSync(folder)) {
    if (other === me || !other.startsWith("m_")) continue;
    const dir = join(folder, other, "log");
    if (!existsSync(dir)) continue;
    const at = seen[other] ?? { file: "", line: 0 };
    for (const name of readdirSync(dir).filter((n) => /^\d{6}$/.test(n)).sort()) {
      if (name < at.file) continue;
      const lines = readFileSync(join(dir, name), "utf8").split("\n");
      let i = name === at.file ? at.line : 0;
      for (; i < lines.length; i++) {
        if (!lines[i]) continue;
        let rec: Rec;
        // A line not yet whole (still arriving): stop here, and look again next time.
        try { rec = JSON.parse(unseal(storeKey(), Buffer.from(lines[i]!, "base64")).toString("utf8")) as Rec; } catch { break; }
        out.push(rec);
        seen[other] = { file: name, line: i + 1 };
      }
    }
  }
  return out;
}

function pull(folder: string): number {
  // Attachments the others have and this machine has not: into the store, as they are.
  const att = join(folder, "attachments");
  const blobs = join(ENTITIES_DIR, "blobs");
  if (existsSync(att)) {
    mkdirSync(blobs, { recursive: true });
    const here = new Set(readdirSync(blobs));
    for (const n of readdirSync(att)) if (!here.has(n) && /^[0-9a-f]{64}$/.test(n)) copyIfGrown(join(att, n), join(blobs, n));
  }
  const seen = readState<Seen>(SEEN(), {});
  // A file whose bytes had not come: tried again first.
  const waiting = readState<Rec[]>(WAITING(), []);
  const recs = [...waiting, ...incoming(folder, seen)];
  const still: Rec[] = [];
  let n = 0;
  for (const r of recs) {
    if ((r.of.startsWith("file:") || r.of.startsWith("wallpaper:")) && !r.gone && typeof r.set?.sha === "string" && !getBlob(r.set.sha)) { still.push(r); continue; }
    // A plugin's state handed over (plugins.ts): once all its files' bytes have come.
    if (r.of.startsWith("pstate:") && pluginStateBlobs(r).some((sha) => !getBlob(sha))) { still.push(r); continue; }
    // The calendars' view (calendar-view.ts): once its bytes have come.
    if (r.of === "calview:" && viewBlob(r) && !getBlob(viewBlob(r)!)) { still.push(r); continue; }
    // About a plugin not installed here yet: kept until it is.
    if ((r.of.startsWith("runner:") || r.of.startsWith("pstate:")) && !isInstalled(r.of.slice(r.of.indexOf(":") + 1))) { still.push(r); continue; }
    // About something this Talaris does not know yet — written by a newer one: kept, and applied once this is updated.
    if (!known(r)) { still.push(r); continue; }
    // A plugin's settings, for a plugin not installed here yet: kept, and given to it once it is.
    if (r.of.startsWith("plugin:") && !isInstalled(r.of.slice("plugin:".length))) { still.push(r); continue; }
    try { if (apply(r)) n++; } catch (e) { console.log(`talaris-core: sync: ${r.of} not applied: ${(e as Error).message}`); }
  }
  writeFileSync(SEEN(), JSON.stringify(seen));
  writeFileSync(WAITING(), JSON.stringify(still));
  return n;
}

// ------------------------------------------------------------ trimming

/**
 * This machine's own log files that every other machine has read past (each says how far, in its seen.json),
 * compacted into one (records.ts, `compactOwnLog`): what applying them comes to, nothing lost. A machine joining
 * later reads that, and the rest as before. Only when every other machine has said where it is; never the file
 * being written to.
 */
export function trim(folder: string): { kept: string; dropped: string[]; lines: number } | null {
  const me = machine().id;
  const others = readdirSync(folder).filter((n) => n.startsWith("m_") && n !== me);
  if (!others.length) return null;
  let before: string | null = null;
  for (const o of others) {
    const seen = readState<Seen>(join(folder, o, "seen.json"), {});
    const at = seen[me]?.file;
    if (!at) return null; // one that has not said (or not read any): nothing yet
    if (before === null || at < before) before = at;
  }
  const done = compactOwnLog(before!);
  if (!done) return null;
  const mine = join(folder, me, "log");
  copyIfGrown(join(STATE(), "log", me, done.kept), join(mine, done.kept));
  for (const n of done.dropped) rmSync(join(mine, n), { force: true });
  console.log(`talaris-core: sync: own log trimmed — ${done.dropped.length + 1} files into ${done.kept}, ${done.lines} records`);
  return done;
}

// ------------------------------------------------------------ the beat

let timer: NodeJS.Timeout | null = null;
let busy = false;

/** One round: in, the projects looked over, out. Says how many changes came in. */
const TRIM_EVERY_MS = 60 * 60 * 1000;
let lastTrim = 0;

/** The last round, for Settings, Sync: when, how many changes came in it and the last that did, and what went wrong. */
const last = { at: null as string | null, came: null as string | null, error: null as string | null };

export function tick(): number {
  const folder = syncFolder();
  if (!folder || !syncing() || busy) return 0;
  busy = true;
  try {
    mkdirSync(folder, { recursive: true });
    const n = pull(folder);
    scanFiles();
    push(folder);
    // Now and then: this machine's own old log files, which every other machine has read, compacted.
    if (Date.now() - lastTrim > TRIM_EVERY_MS) { lastTrim = Date.now(); try { trim(folder); } catch (e) { console.log(`talaris-core: sync: trimming: ${(e as Error).message}`); } }
    last.at = new Date().toISOString();
    if (n) last.came = last.at;
    last.error = null;
    return n;
  } catch (e) {
    last.error = (e as Error).message;
    throw e;
  } finally {
    busy = false;
  }
}

/** From startup (index.ts): a round every few seconds, while this machine syncs to a folder. */
export function startSync(): void {
  blobsAt(() => { const f = syncFolder(); return f ? join(f, "blobs") : join(STATE(), "blobs"); });
  if (timer) return;
  timer = setInterval(() => {
    try {
      const n = tick();
      if (n) {
        console.log(`talaris-core: sync: ${n} change(s) from elsewhere`);
        // The screens told, for whatever they have out to read again (surfaces.py, `synced`).
        tellScreens("synced");
      }
    } catch (e) { console.log(`talaris-core: sync: ${(e as Error).message}`); }
  }, 5000);
  timer.unref();
}

/** What Settings, Sync shows: the folder, this machine, the others seen there, what waits. */
type Other = { id: string; name: string; records: number; wrote: string | null };
export function syncStatus(): { on: boolean; folder: string | null; machine: { id: string; name: string }; others: Other[]; waiting: number;
  last: string | null; came: string | null; error: string | null } {
  const folder = syncFolder();
  const me = machine();
  const others: Other[] = [];
  if (folder && existsSync(folder)) {
    const seen = readState<Seen>(SEEN(), {});
    for (const id of readdirSync(folder).filter((n) => n.startsWith("m_") && n !== me.id)) {
      let name = id;
      try { name = (JSON.parse(readFileSync(join(folder, id, "machine.json"), "utf8")) as { name: string }).name; } catch { /* named by id */ }
      // When it last wrote anything to the folder (its newest log file): the last that could have come from it.
      let wrote: number | null = null;
      try {
        for (const f of readdirSync(join(folder, id, "log"))) wrote = Math.max(wrote ?? 0, statSync(join(folder, id, "log", f)).mtimeMs);
      } catch { /* nothing yet */ }
      others.push({ id, name, records: seen[id]?.line ?? 0, wrote: wrote ? new Date(wrote).toISOString() : null });
    }
  }
  return { on: syncing(), folder, machine: me, others, waiting: readState<Rec[]>(WAITING(), []).length, last: last.at, came: last.came, error: last.error };
}
