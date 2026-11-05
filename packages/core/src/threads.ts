// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore

/**
 * Morgan's threads as things (DESIGN, *Morgan's threads*). When a conversation
 * with Morgan ends, Morgan cuts it into threads — the exchanges that were about
 * one thing, with a title and a summary (heymorgan, `fileThreads`). Here each
 * is a thing that lives in Home: listed in Files, read (its summary is its
 * description, already written), embedded, suggested as a connection and
 * connectable, brought into another project by a shortcut and put in lists.
 * It opens as Morgan's conversation.
 *
 * Talaris keeps a copy of the list (`threads.sealed`), asked of Morgan
 * (protocol 1.8, `threads`) every few minutes and when Files is opened; the
 * exchanges themselves stay Morgan's. An entity stands for a thread only once
 * something is tied to it (as for a page: mentionables.ts, `placeEntity`),
 * known by a `thread` source, `<home>/<id>`.
 *
 * **A thread can move.** Morgan merges two threads that turn out to be one
 * subject, and the one dropped loses its id. Its id is its first exchange's
 * time and a number, and the thread kept holds that exchange: so it is found
 * again, `moved` remembers where it went, and its entity is merged into the
 * kept one's (merge.ts) — what was tied to it is tied to that.
 *
 * **A conversation not yet cut into threads** is listed too (protocol 1.13,
 * `unfiled`), so that Files shows every conversation, the one in hand included.
 * It has no summary, only its first words, so it is kept apart from `threads()`:
 * not embedded, suggested or offered to @ until it is a thread. Its id leads to
 * the thread holding its first exchange once there is one (`take`).
 *
 * **A thread can be deleted** (protocol 1.13). Morgan names what is gone for good
 * in `deleted`, and only that is let go of here: its entity, with what was tied
 * to it, and its place in lists. A list that merely came back shorter proves
 * nothing, and connections are not thrown away on a guess.
 *
 * In demo nothing is asked of Morgan: the person's conversations are not
 * shown to whoever is watching. The demo's threads are made up (demo-seed.ts).
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { allRecords, bySource, deleteEntity, type Entity } from "./entities.js";
import { inDemo } from "./demo.js";
import { membersMoved } from "./filelists.js";
import { mergeEntities } from "./merge.js";
import { placeEntity, placeSource } from "./mentionables.js";
import { morganCommand } from "./morgan-describe.js";
import { ensureHome } from "./projects.js";
import { seal, unseal } from "./seal.js";
import { writeAtomic } from "./store.js";
import { DATA_DIR, storeKey } from "./vault.js";

export interface Thread {
  id: string;
  t0: number;
  t1: number;
  title: string;
  summary: string;
  exchanges: number;
  ts: number[];
}

interface Kept { threads: Thread[]; unfiled?: Thread[]; moved: Record<string, string>; at: string; error?: string; /** What Morgan calls the person (its `userName`): in every summary, and no one else. */ user?: string }
const FILE = () => join(DATA_DIR, "threads.sealed");
/** files.ts's SHORTCUT_TO: that file imports this one. */
const SHORTCUT_TO = "talaris:shortcutTo";
let kept: Kept | null = null;
let version = 0;
/** Goes up whenever the threads change: Files and the index look again. */
export const threadsVersion = () => version;

function state(): Kept {
  if (kept) return kept;
  kept = { threads: [], moved: {}, at: "" };
  if (existsSync(FILE())) {
    try { kept = { ...kept, ...JSON.parse(unseal(storeKey(), readFileSync(FILE())).toString("utf8")) as Partial<Kept> }; } catch { /* asked again */ }
  }
  return kept;
}
const save = () => writeAtomic(FILE(), seal(storeKey(), JSON.stringify(state())));

/** Home's id: where every thread lives (ensureHome: always there, made if it is not). */
export const homeId = (): string => ensureHome().id;

/** Every thread, newest first. */
export function threads(): Thread[] {
  return [...state().threads].sort((a, b) => b.t1 - a.t1);
}

/** Where an id leads now: itself, or the thread it was merged into. */
export function currentId(id: string): string {
  const moved = state().moved;
  let at = id;
  for (let i = 0; moved[at] && i < 20; i++) at = moved[at]!;
  return at;
}

export function threadById(id: string): Thread | null {
  const now = currentId(id);
  return state().threads.find((t) => t.id === now) ?? unfiledThreads().find((t) => t.id === now) ?? null;
}

/** Conversations Morgan has not yet cut into threads, newest first. */
export function unfiledThreads(): Thread[] {
  return [...(state().unfiled ?? [])].sort((a, b) => b.t1 - a.t1);
}

/** What Morgan calls the person, as last asked: "" if it was not said. */
export const morganUser = (): string => state().user ?? "";

/** A thread's words with the person's own name taken out: a summary names them throughout, which ties it to no one. */
export function threadWordsForNames(t: Thread): string {
  const user = morganUser().trim();
  let text = threadText(t);
  if (!user) return text;
  const esc = (w: string) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  for (const w of [user, user.split(/\s+/)[0]!]) text = text.replace(new RegExp(`(^|[^\\p{L}])${esc(w)}(?=$|[^\\p{L}])`, "gu"), "$1 ");
  return text;
}

/** A thread's words, as it is read: its title and Morgan's summary of it. */
export const threadText = (t: Thread) => `${t.title}\n\n${t.summary}`.trim();

/** The entity standing for a thread, made if there is none: what it is connected by. */
export function threadEntity(id: string): Entity {
  const t = threadById(id);
  if (!t) throw new Error(`no thread ${id}`);
  return placeEntity("thread", homeId(), t.id, t.title);
}

/** How the list stands: when last asked, and why not, if it could not be. */
export const threadsStatus = () => ({ count: state().threads.length, at: state().at, error: state().error ?? "" });

/** For tests and the demo: the list as given, as though Morgan had said it. */
export function setThreads(list: Thread[], user?: string, deleted: string[] = [], unfiled: Thread[] = []): { moved: number } {
  if (user !== undefined) state().user = user;
  const out = take(list, unfiled);
  letGo(deleted);
  return out;
}

/** Threads Morgan says it has deleted: nothing of them is kept here. */
function letGo(deleted: string[]): void {
  const home = homeId();
  const k = state();
  let changed = false;
  for (const id of deleted) {
    const was = bySource(placeSource("thread", home, id));
    if (was) { try { deleteEntity(was.id); } catch { /* already gone */ } }
    // A shortcut to it, in another project, holds its title.
    const shortcuts = allRecords().filter(({ object: o }) => o[SHORTCUT_TO] === `thread:${home}/${id}`);
    for (const { object: o } of shortcuts) { try { deleteEntity(o.id); } catch { /* already gone */ } }
    if (!was && !shortcuts.length && !(id in k.moved)) continue;
    membersMoved((key) => (key === `t:${id}` ? "" : null));
    delete k.moved[id];
    changed = true;
  }
  if (changed) { version++; save(); }
}

/** Morgan asked for its threads, and the copy brought into step. */
export async function syncThreads(): Promise<{ ok: boolean; count: number; moved: number; error?: string }> {
  if (inDemo) return { ok: true, count: state().threads.length, moved: 0 };
  const r = await morganCommand("threads", 45_000);
  const fail = (error: string) => { state().error = error; return { ok: false, count: state().threads.length, moved: 0, error }; };
  if (!r) return fail("Morgan could not be asked");
  if (!r.ok) return fail(String(r.error ?? "Morgan did not say"));
  const list = (r.threads as Partial<Thread>[] | undefined) ?? [];
  // Before protocol 1.8 a thread came without its id: nothing to hold it by.
  if (list.length && !list[0]!.id) return fail("Morgan is too old to say which thread is which: it needs updating");
  const given = (t: Partial<Thread>): Thread => ({ id: String(t.id), t0: Number(t.t0), t1: Number(t.t1 ?? t.t0), title: String(t.title ?? ""),
    summary: String(t.summary ?? ""), exchanges: Number(t.exchanges ?? (t.ts ?? []).length), ts: (t.ts ?? []).map(Number) });
  const { moved } = take(list.map(given), ((r.unfiled as Partial<Thread>[] | undefined) ?? []).map(given));
  delete state().error;
  letGo(((r as { deleted?: unknown[] }).deleted ?? []).map(String));
  // What Morgan calls the person, for leaving their name out of what a summary is taken to name.
  const cfg = await morganCommand(`admin ${JSON.stringify({ op: "config.get", args: {} })}`, 20_000);
  const user = cfg?.ok ? String((cfg as { userName?: unknown }).userName ?? (cfg as { config?: { userName?: unknown } }).config?.userName ?? "") : null;
  if (user !== null && user !== (state().user ?? "")) { state().user = user; save(); }
  return { ok: true, count: state().threads.length, moved };
}

function take(list: Thread[], unfiled: Thread[] = []): { moved: number } {
  const k = state();
  const now = new Set([...list, ...unfiled].map((t) => t.id));
  const home = homeId();
  let moved = 0;
  for (const old of [...k.threads, ...(k.unfiled ?? [])]) {
    if (now.has(old.id)) continue;
    // Gone: merged into the thread now holding its first exchange, or gone for good (struck out, say).
    const first = Number(old.id.replace(/^u/, "").split("-")[0]);
    const into = list.find((t) => t.ts.includes(first));
    if (!into) continue;
    k.moved[old.id] = into.id;
    moved++;
    membersMoved((key) => (key === `t:${old.id}` ? `t:${into.id}` : null));
    const was = bySource(placeSource("thread", home, old.id));
    if (was) {
      const to = placeEntity("thread", home, into.id, into.title);
      try { mergeEntities(was.id, to.id); } catch { /* one kept in step elsewhere: left as it is */ }
    }
  }
  const changed = JSON.stringify([k.threads, k.unfiled ?? []]) !== JSON.stringify([list, unfiled]);
  k.threads = list;
  k.unfiled = unfiled;
  k.at = new Date().toISOString();
  if (changed) version++;
  save();
  return { moved };
}

let timer: NodeJS.Timeout | null = null;
/** Asked a minute after start, then every five minutes. */
export function startThreads(): void {
  if (timer) return;
  setTimeout(() => void syncThreads(), 60_000).unref();
  timer = setInterval(() => void syncThreads(), 5 * 60_000);
  timer.unref();
}
