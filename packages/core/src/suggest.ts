// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore

/**
 * Suggested ties (DESIGN, *Suggestions*): for any thing — a person, a task, an
 * event, a note, a page, a file, a project — what it is probably tied to and
 * is not yet, each with why it is thought so and the fitting ways to tie it.
 * Nothing is tied or merged unless one is chosen; a suggestion turned down is
 * not made again, and a thing can be told to stop suggesting.
 *
 * Found three ways, surest first:
 *
 * - **By name in the words.** A person's or a project's name in a thing's
 *   text, not yet a mention of it: "Connect Rich" names Rich Gelson and Rich
 *   Wiener. A note called by a person's name is likely about them.
 * - **The same thing twice.** Two people of one name or one address, two tasks
 *   or notes of one title, two things of one kind nearly the same in meaning:
 *   offered to be merged (merge.ts).
 * - **By meaning** (meaning.ts, nearTo): what is nearest in what it says,
 *   files by their text among them.
 *
 * Ways to tie, as fit the two: **mention** (the name in the words made a
 * mention of it, which is also a tie), **connect** (in the field one declares
 * for the other — a note's people, a task's project — else as a plain link),
 * **attach** (a file put on a thing, where it stays), **merge** (two of one
 * kind made one).
 *
 * Things are known by their glance keys (glance.ts): `e:<id>`,
 * `page:<project>/<path>`, `project:<id>`, `file:<project>/<path>`, and
 * `att:<files row key>` for a file that is on things but in no project's
 * folder.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  allRecords, bodyOf, bySource, connect, connections, getEntity, onChange, profilesOf, titleOf, types, updateEntity, type Entity,
} from "./entities.js";
import { listFiles, type FileRow } from "./files.js";
import { keptText, plainText } from "./filetext.js";
import { linkFile } from "./links.js";
import { mergeEntities, syncedBy } from "./merge.js";
import { indexed, nearTo } from "./meaning.js";
import { mentionsIn } from "./mentions.js";
import { placeEntity, placeOf, placeSource } from "./mentionables.js";
import { canvasName, canvasWords, projectCanvases } from "./canvases.js";
import { threadById, threadEntity, threadWordsForNames } from "./threads.js";
import { pageModified, readPage, writePage } from "./pages.js";
import { leavesOut, leftOut, shownSettings, tooOld, type Shown } from "./shown.js";
import { Conflict, NotFound, findProject } from "./projects.js";
import { seal, unseal } from "./seal.js";
import { writeAtomic } from "./store.js";
import { DATA_DIR, storeKey } from "./vault.js";

export type How = "mention" | "connect" | "attach" | "merge";
export interface Way { how: How; label: string; /** For a mention: the words made one. */ text?: string }
export interface Suggestion {
  /** The other thing's glance key. */
  key: string;
  id?: string;
  title: string;
  kind: string;
  /** Why it is thought tied, in words: "Names Rich", "Close in meaning — “…”". */
  why: string[];
  score: number;
  ways: Way[];
}

// ------------------------------------------------------------ what a thing is

interface Thing {
  key: string;
  kind: string;          // person, task, event, note, page, project, file
  title: string;
  /** The entity standing for it, where there is one. */
  entity?: Entity;
  /** Its words, to look for names in. */
  text: string;
  /** Where its words can be written: an entity's fields, or a page. */
  writes?: { entity: string } | { page: { project: string; path: string } };
  /** Its key in the meaning index. */
  meaning?: string;
  /** For a file: where it is, or the copy kept, and its row. */
  file?: FileRow;
}

const kindOfEntity = (o: Entity): string => {
  const k = profilesOf(o);
  return k.includes("contact") ? "person" : k.includes("task") ? "task" : k.includes("event") ? "event" : k.includes("project") ? "project" : "note";
};
const projectOfEntity = (o: Entity) => ((o["talaris:sources"] as { kind: string; key: string }[] | undefined) ?? []).find((s) => s.kind === "talaris-project")?.key;

/** The key a glance knows an entity by: its place, its project, or itself. */
export function keyOfEntity(o: Entity): string {
  const place = placeOf(o);
  if (place) return `${place.kind}:${place.project}/${place.where}`;
  const ws = projectOfEntity(o);
  return ws ? `project:${ws}` : `e:${o.id}`;
}

/** A meaning-index key as a glance key. */
function glanceKey(meaningKey: string): string | null {
  if (meaningKey.startsWith("page:") || meaningKey.startsWith("canvas:") || meaningKey.startsWith("thread:")) return meaningKey;
  if (meaningKey.startsWith("e:")) {
    try { return keyOfEntity(getEntity(meaningKey.slice(2))); } catch { return null; }
  }
  if (meaningKey.startsWith("file:p:")) return `file:${meaningKey.slice(7)}`;
  if (meaningKey.startsWith("file:s:")) return `e:${meaningKey.slice(7)}`;
  if (meaningKey.startsWith("file:")) return `att:${meaningKey.slice(5)}`;
  return null;
}

const splitKey = (key: string): [string, string] => {
  const body = key.slice(key.indexOf(":") + 1);
  const at = body.indexOf("/");
  return [body.slice(0, at), body.slice(at + 1)];
};

const fileRows = (): Map<string, FileRow> => new Map(listFiles().rows.map((r) => [r.key, r]));

/** Words written in an entity: its title, its other words, its body. */
function entityWords(o: Entity): string {
  const bits = [titleOf(o)];
  for (const [k, v] of Object.entries(o.properties ?? {})) {
    if (k === "title" || typeof v !== "string") continue;
    if (/^\d{4}-\d{2}-\d{2}/.test(v) || /^[a-z]_[a-z0-9]+$/.test(v)) continue;
    bits.push(v);
  }
  const body = bodyOf(o);
  if (body && !bits.includes(body)) bits.push(body);
  return bits.join("\n");
}

export function thing(key: string, rows = fileRows()): Thing {
  if (key.startsWith("e:")) {
    const o = getEntity(key.slice(2));
    const place = placeOf(o);
    if (place) return thing(`${place.kind}:${place.project}/${place.where}`, rows);
    const ws = projectOfEntity(o);
    if (ws) return thing(`project:${ws}`, rows);
    return { key, kind: kindOfEntity(o), title: titleOf(o), entity: o, text: entityWords(o), writes: { entity: o.id }, meaning: `e:${o.id}` };
  }
  if (key.startsWith("page:")) {
    const [project, path] = splitKey(key);
    let text = "";
    try { text = readPage(project, path); } catch { /* sealed and locked, or gone */ }
    const e = bySource({ kind: "page", key: `${project}/${path}` }) ?? undefined;
    return { key, kind: "page", title: path.split("/").pop() || path, ...(e ? { entity: e } : {}), text, writes: { page: { project, path } }, meaning: key };
  }
  if (key.startsWith("canvas:")) {
    const [project, id] = splitKey(key);
    const doc = projectCanvases(project).find((c) => c.id === id);
    if (!doc) throw new NotFound(`no canvas ${key}`);
    const e = bySource(placeSource("canvas", project, id)) ?? undefined;
    return { key, kind: "canvas", title: canvasName(project, doc), ...(e ? { entity: e } : {}), text: canvasWords(doc), meaning: key };
  }
  if (key.startsWith("thread:")) {
    const [home, id] = splitKey(key);
    const t = threadById(id);
    if (!t) throw new NotFound(`no thread ${key}`);
    // Known by where it is now, if Morgan has merged it into another since.
    const now = `thread:${home}/${t.id}`;
    const e = bySource(placeSource("thread", home, t.id)) ?? undefined;
    // Its words without the person's own name (Morgan's summaries say it throughout); its meaning as it is.
    return { key: now, kind: "conversation", title: t.title, ...(e ? { entity: e } : {}), text: threadWordsForNames(t), meaning: now };
  }
  if (key.startsWith("project:")) {
    const id = key.slice(8);
    const p = findProject(id);
    const e = bySource({ kind: "talaris-project", key: id }) ?? undefined;
    return { key, kind: "project", title: p.name, ...(e ? { entity: e } : {}), text: e ? entityWords(e) : p.name, ...(e ? { meaning: `e:${e.id}` } : {}) };
  }
  if (key.startsWith("file:") || key.startsWith("att:")) {
    const row = key.startsWith("file:") ? rows.get(`p:${key.slice(5)}`) : rows.get(key.slice(4));
    if (!row) throw new NotFound(`no file ${key}`);
    const mk = `file:${row.key}`;
    // Its words as read in the background; a plain-text one not read yet, read now.
    const words = keptText(mk) ?? (row.abs ? plainText(row.abs, row.name) : "");
    return { key, kind: "file", title: row.name, text: `${row.name}\n${words}`, meaning: mk, file: row };
  }
  throw new NotFound(`nothing is known by ${key}`);
}

/** The keys a thing is tied to already, either way. */
function tiedTo(t: Thing): Set<string> {
  const out = new Set<string>();
  const add = (o: { id: string }) => { try { out.add(keyOfEntity(getEntity(o.id))); } catch { /* gone */ } };
  if (t.entity) {
    try {
      const c = connections(t.entity.id);
      for (const x of [...c.out, ...c.in]) add(x.entity);
    } catch { /* gone */ }
  }
  for (const m of mentionsIn(t.text)) add(m);
  if (t.file) for (const o of t.file.on) add(o);
  if (t.kind === "project" && t.entity) {
    // What is filed under it: anything naming its entity.
    for (const { object: o } of allRecords()) if (o.id !== t.entity.id && JSON.stringify(o.properties).includes(t.entity.id)) out.add(keyOfEntity(o));
  }
  // A file and the things it is on, the other way: a thing's own files.
  if (t.entity) {
    for (const r of listFiles().rows) if (r.on.some((o) => o.id === t.entity!.id)) out.add(r.path && r.status.includes("folder") ? `file:${r.project}/${r.path}` : `att:${r.key}`);
  }
  out.add(t.key);
  return out;
}

// ------------------------------------------------------------ names

interface Name { key: string; id: string; title: string; kind: "person" | "project"; full: string; first?: string }

let names: { at: number; list: Name[] } | null = null;
// A person or project made, renamed or gone: the names read again (deletions run no hook, so they age out too).
onChange((_b, after) => { if (names && profilesOf(after).some((k) => k === "contact" || k === "project")) names = null; });
/**
 * A person's name as it is said: "Groninger, Margaret" — as an address book
 * files it — is Margaret Groninger. Only a name of two parts with one comma
 * is turned round; anything else is as written.
 */
export function spokenName(title: string): string {
  const m = /^([^,]+),\s*([^,]+)$/.exec(title.trim());
  return m ? `${m[2]!.trim()} ${m[1]!.trim()}` : title.trim();
}

function nameList(): Name[] {
  if (names && Date.now() - names.at < 20_000) return names.list;
  const list: Name[] = [];
  for (const { object: o } of allRecords()) {
    if (o.archived || o.stub) continue;
    const k = profilesOf(o);
    const kind = k.includes("contact") ? "person" : k.includes("project") ? "project" : null;
    if (!kind) continue;
    const title = titleOf(o).trim();
    if (title.length < 3 || title.includes("@")) continue;
    // Looked for as it is said: "Groninger, Margaret" is found as Margaret Groninger, and her first name is Margaret.
    const full = kind === "person" ? spokenName(title) : title;
    const parts = full.split(/\s+/);
    list.push({ key: keyOfEntity(o), id: o.id, title, kind, full,
      ...(kind === "person" && parts.length >= 2 && parts[0]!.length >= 3 && /^\p{Lu}/u.test(parts[0]!) ? { first: parts[0] } : {}) });
  }
  names = { at: Date.now(), list };
  return list;
}

const esc = (w: string) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const wordIn = (text: string, w: string, caseSensitive: boolean) =>
  new RegExp(`(^|[^\\p{L}\\p{N}_])${esc(w).replace(/\s+/g, "\\s+")}($|[^\\p{L}\\p{N}_])`, caseSensitive ? "u" : "iu").exec(text);
/** Words with their mentions and links taken out: a name already a mention is tied already. */
const bare = (text: string) => text.replace(/\[[^\]\n]*\]\([^)\s]*\)/g, " ").replace(/https?:\/\/\S+/g, " ");

function byName(t: Thing, add: (key: string, why: string, score: number, ways: Way[]) => void): void {
  // A person's or a project's own name is not a mention of anyone: "Rich Gelson" does not name Rich Wiener.
  const own0 = t.title.trim();
  const text = bare(t.kind === "person" || t.kind === "project" ? t.text.replace(own0, " ") : t.text);
  // A person: the notes called by their name are likely about them (the other way round from a note's own).
  if (t.kind === "person" && t.entity) {
    const first = spokenName(own0).split(/\s+/)[0] ?? "";
    for (const { object: o } of allRecords()) {
      if (o.archived || o.stub || !profilesOf(o).includes("note") || profilesOf(o).includes("contact")) continue;
      const title = titleOf(o).trim();
      if (title.toLowerCase() === own0.toLowerCase() || title.toLowerCase() === spokenName(own0).toLowerCase()) add(keyOfEntity(o), `Called ${title}`, 0.85, []);
      else if (first.length >= 3 && own0.includes(" ") && title === first) add(keyOfEntity(o), `Called ${title}`, 0.6, []);
    }
  }
  const list = nameList();
  const firsts = new Map<string, Name[]>();
  for (const n of list) if (n.first) firsts.set(n.first, [...(firsts.get(n.first) ?? []), n]);
  const own = t.title.trim();
  for (const n of list) {
    if (n.key === t.key || (t.entity && n.id === t.entity.id)) continue;
    // A note called by someone's name: likely about them.
    if (t.kind === "note" || t.kind === "page") {
      if (own.toLowerCase() === n.full.toLowerCase()) { add(n.key, `Named ${n.title}`, 0.85, []); continue; }
      if (n.first && own === n.first) { add(n.key, `Named ${n.first}`, (firsts.get(n.first)?.length ?? 0) > 1 ? 0.6 : 0.75, []); continue; }
    }
    const full = (n.kind === "project" ? n.full.length >= 4 : n.full.includes(" ")) ? wordIn(text, n.full, false) : null;
    if (full) { add(n.key, `Names ${n.title}`, n.kind === "project" ? 0.8 : 0.85, mention(t, full[0]!.trim())); continue; }
    if (n.first) {
      const m = wordIn(text, n.first, true);
      if (m && own !== n.first) {
        const many = (firsts.get(n.first)?.length ?? 0) > 1;
        add(n.key, many ? `Says “${n.first}” — one of ${firsts.get(n.first)!.length} called that` : `Says “${n.first}”`, many ? 0.5 : 0.6, mention(t, n.first));
      }
    }
  }
}

/** Where words first stand on their own in a text — not inside a link or a mention — as written, else in any case; -1 if nowhere. */
function bareAt(text: string, words: string): number {
  const links = [...text.matchAll(/\[[^\]\n]*\]\([^)\s]*\)/g)].map((m) => [m.index!, m.index! + m[0].length]);
  for (const flags of ["gu", "giu"]) {
    const re = new RegExp(`(^|[^\\p{L}\\p{N}_])(${esc(words)})(?=$|[^\\p{L}\\p{N}_])`, flags);
    for (const m of text.matchAll(re)) {
      const at = m.index! + m[1]!.length;
      if (!links.some(([a, b]) => at >= a! && at < b!)) return at;
    }
  }
  return -1;
}

/** The mention way, where a thing's words can be written. */
function mention(t: Thing, text: string): Way[] {
  return t.writes ? [{ how: "mention", label: `Connect “${text}” as a mention`, text }] : [];
}

// ------------------------------------------------------------ the same thing twice

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const MERGEABLE = new Set(["person", "task", "note"]);

function twice(t: Thing, add: (key: string, why: string, score: number, ways: Way[]) => void): void {
  if (!t.entity || !MERGEABLE.has(t.kind) && t.kind !== "page") return;
  // A person by their name as it is said: "Groninger, Margaret" and "Margaret Groninger" are one name.
  const said = (title: string) => norm(t.kind === "person" ? spokenName(title) : title);
  const mine = said(t.title);
  if (!mine) return;
  const emails = new Set(emailsOf(t.entity));
  for (const { object: o } of allRecords()) {
    if (o.id === t.entity.id || o.archived || o.stub || o.type !== t.entity.type) continue;
    const same = said(titleOf(o)) === mine;
    const shared = emailsOf(o).some((e) => emails.has(e));
    if (same || shared) add(keyOfEntity(o), shared ? "The same address" : "The same name", shared ? 0.95 : 0.8, []);
  }
}

function emailsOf(o: Entity): string[] {
  const field = types().find((x) => x.id === o.type)?.profiles?.contact?.email;
  if (typeof field !== "string") return [];
  const v = o.properties[field];
  return (Array.isArray(v) ? v : v ? [v] : []).filter((x): x is string => typeof x === "string").map((x) => x.trim().toLowerCase());
}

// ------------------------------------------------------------ the ways two things tie

const ATTACHES = (o: Entity) => types().find((x) => x.id === o.type)?.fields.some((f) => f.kind === "attachment") ?? false;

function waysBetween(a: Thing, b: Thing): Way[] {
  const out: Way[] = [];
  if (a.entity && b.entity && a.entity.type === b.entity.type && (MERGEABLE.has(a.kind) || a.kind === "page") && b.kind !== "project") {
    out.push({ how: "merge", label: `Merge with ${b.title}` });
  }
  if (a.kind === "file" || b.kind === "file") {
    const [file, other] = a.kind === "file" ? [a, b] : [b, a];
    if (other.kind === "file") return out;
    const canHold = other.entity ? ATTACHES(other.entity) : false;
    if (canHold && (file.file?.abs || file.file?.sha256)) out.push({ how: "attach", label: `Connect to ${b.title}` });
    return out;
  }
  // One word for it everywhere: connect. (Where it goes — a note's people, a task's project — is the core's to choose.)
  out.push({ how: "connect", label: `Connect to ${b.title}` });
  return out;
}

// ------------------------------------------------------------ what was said no to

interface Kept { no: string[]; quiet: string[] }
const KEPT = () => join(DATA_DIR, "suggest.sealed");
let kept: Kept | null = null;
function keptState(): Kept {
  if (kept) return kept;
  kept = { no: [], quiet: [] };
  if (existsSync(KEPT())) {
    try { kept = { no: [], quiet: [], ...JSON.parse(unseal(storeKey(), readFileSync(KEPT())).toString("utf8")) as Partial<Kept> }; } catch { /* started again */ }
  }
  return kept;
}
const saveKept = () => writeAtomic(KEPT(), seal(storeKey(), JSON.stringify(keptState())));
const pair = (a: string, b: string) => [a, b].sort().join("\u0000");

/** No to a suggestion: not made again, either way round. */
export function dismiss(a: string, b: string): void {
  const k = keptState();
  if (!k.no.includes(pair(a, b))) { k.no.push(pair(a, b)); saveKept(); }
}
/** How many suggestions for a thing were turned down. */
const dismissedFor = (key: string) => keptState().no.filter((p) => p.split("\u0000").includes(key)).length;
/** Every suggestion turned down for a thing, either way round, made again. Answers how many. */
export function undismiss(key: string): number {
  const k = keptState();
  const before = k.no.length;
  k.no = k.no.filter((p) => !p.split("\u0000").includes(key));
  if (k.no.length !== before) saveKept();
  return before - k.no.length;
}
/** What was said no to, and things told to be quiet, moved to new keys (a page moved whole): kept as they were. */
export function renameSuggestKeys(to: (key: string) => string | null): void {
  const k = keptState();
  const swap = (x: string) => to(x) ?? x;
  k.no = k.no.map((p) => { const [a, b] = p.split("\u0000"); return pair(swap(a!), swap(b!)); });
  k.quiet = k.quiet.map(swap);
  saveKept();
}

/** A thing told to stop suggesting (or to start again). */
export function setQuiet(key: string, quiet: boolean): boolean {
  const k = keptState();
  k.quiet = k.quiet.filter((x) => x !== key);
  if (quiet) k.quiet.push(key);
  saveKept();
  return quiet;
}
export const isQuiet = (key: string) => keptState().quiet.includes(key);

// ------------------------------------------------------------ suggesting

// Short notes are alike in meaning whatever they are about: below this, closeness says little.
const FLOOR = 0.72;
/** A passage as a line: its mentions as their words, its Markdown marks gone. */
const said = (p: string) => p.replace(/\[@?([^\]\n]*)\]\([^)\s]*\)/g, "$1").replace(/[#*_>`]+/g, "").replace(/\s+/g, " ").trim();

/** What a thing is probably tied to and is not, surest first. */
export function suggestionsFor(key: string, options: { limit?: number } = {}): { quiet: boolean; suggestions: Suggestion[]; dismissed: number } {
  if (isQuiet(key)) return { quiet: true, suggestions: [], dismissed: dismissedFor(key) };
  const rows = fileRows();
  const t = thing(key, rows);
  const tied = tiedTo(t);
  const no = new Set(keptState().no);
  const found = new Map<string, { why: string[]; score: number; ways: Way[] }>();
  const add = (k: string, why: string, score: number, ways: Way[]) => {
    if (tied.has(k) || no.has(pair(key, k))) return;
    const had = found.get(k) ?? { why: [], score: 0, ways: [] };
    if (!had.why.includes(why)) had.why.push(why);
    // Two reasons are surer than either.
    had.score = had.score ? Math.min(0.99, Math.max(had.score, score) + 0.08) : score;
    for (const w of ways) if (!had.ways.some((x) => x.how === w.how && x.text === w.text)) had.ways.push(w);
    found.set(k, had);
  };
  byName(t, add);
  twice(t, add);
  if (t.meaning && indexed(t.meaning)) {
    // A thing of few words is near many things by chance: it needs to be nearer.
    const floor = t.text.length < 240 ? FLOOR + 0.07 : FLOOR;
    for (const f of nearTo(t.meaning, { limit: 8, floor })) {
      const k = glanceKey(f.key);
      if (!k) continue;
      const line = said(f.passage);
      add(k, line ? `Close in meaning — “${line.slice(0, 90)}${line.length > 90 ? "…" : ""}”` : "Close in meaning", 0.3 + ((f.score - floor) / (1 - floor)) * 0.5, []);
      // Of one kind and nearly the same: perhaps one thing twice.
      if (f.score >= 0.93) add(k, "Nearly the same", 0.7, []);
    }
  }
  const out: Suggestion[] = [];
  const shown = shownSettings();
  for (const [k, f] of found) {
    let other: Thing;
    try { other = thing(k, rows); } catch { continue; }
    if (leavesOut(shown) && hidden(other, shown)) continue;
    const ways = [...f.ways.filter((w) => w.how === "mention"), ...waysBetween(t, other)];
    // Merge is offered only where the two look like one thing.
    const looksSame = f.why.some((w) => w.startsWith("The same") || w === "Nearly the same");
    const fitting = ways.filter((w) => w.how !== "merge" || looksSame);
    if (!fitting.length) continue;
    out.push({ key: k, ...(other.entity ? { id: other.entity.id } : {}), title: other.title, kind: other.kind, why: f.why, score: Math.round(f.score * 100) / 100,
      ways: fitting.sort((a, b) => (a.how === "merge" ? -1 : 0) - (b.how === "merge" ? -1 : 0)) });
  }
  // Surest first; of two as sure, the one with more reasons, then by name — so the order never shuffles.
  return { quiet: false, dismissed: dismissedFor(key), suggestions: out.sort((a, b) => b.score - a.score || b.why.length - a.why.length || a.title.localeCompare(b.title)).slice(0, options.limit ?? 12) };
}

/** Left out as Settings says (shown.ts): an entity as it is; a page, a file or a conversation by when it last changed. */
function hidden(t: Thing, s: Shown): boolean {
  if (t.key.startsWith("e:") && t.entity) return leftOut(t.entity, s);
  if (t.file) return tooOld(t.file.mtime, s);
  const at = t.key.indexOf("/");
  try {
    if (t.key.startsWith("page:")) return tooOld(pageModified(t.key.slice(5, at), t.key.slice(at + 1)), s);
    if (t.key.startsWith("thread:")) { const th = threadById(t.key.slice(at + 1)); return Boolean(th && tooOld(new Date(th.t1).toISOString(), s)); }
  } catch { /* gone: not suggested anyway */ }
  return false;
}

// ------------------------------------------------------------ tying

/** The entity a thing is, made for a page that has none yet. */
function entityFor(t: Thing): Entity {
  if (t.entity) return t.entity;
  if (t.kind === "page" && "page" in (t.writes ?? {})) {
    const { project, path } = (t.writes as { page: { project: string; path: string } }).page;
    return placeEntity("page", project, path, t.title);
  }
  if (t.kind === "canvas") { const [project, id] = splitKey(t.key); return placeEntity("canvas", project, id, t.title); }
  if (t.kind === "conversation") return threadEntity(splitKey(t.key)[1]);
  throw new Conflict(`${t.title} cannot be connected that way`);
}

/** Whether `from`'s type declares a field for things of `to`'s type. */
const declares = (from: Entity, to: Entity) =>
  types().find((x) => x.id === from.type)?.fields.some((f) => f.kind === "reference" && f.targetType === to.type) ?? false;
// Which end a plain link starts from: the thing that is about the other.
const RANK = ["conversation", "page", "canvas", "note", "task", "file", "event", "person", "project"];

/** A suggestion taken: the two tied the way chosen. Answers what was done, in words, and after a merge the key of the one kept. */
export function accept(key: string, other: string, way: Way): { said: string; kept?: string } {
  const r = tie(key, other, way);
  return typeof r === "string" ? { said: r } : r;
}

function tie(key: string, other: string, way: Way): string | { said: string; kept: string } {
  const rows = fileRows();
  const a = thing(key, rows), b = thing(other, rows);
  if (way.how === "merge") {
    const ea = entityFor(a), eb = entityFor(b);
    // The one kept is the one another app keeps in step, where one is.
    const [drop, keep] = syncedBy(ea) && !syncedBy(eb) ? [eb, ea] : [ea, eb];
    const kept = mergeEntities(drop.id, keep.id);
    return { said: `Merged into ${titleOf(kept)}.`, kept: keyOfEntity(kept) };
  }
  if (way.how === "mention") {
    const target = entityFor(b);
    const words = way.text ?? b.title;
    if (!a.writes) throw new Conflict(`${a.title} has no words to write a mention into`);
    const swap = (s: string): string | null => {
      const at = bareAt(s, words);
      if (at < 0) return null;
      const said = s.slice(at, at + words.length);
      return `${s.slice(0, at)}[@${said}](talaris:${target.id})${s.slice(at + words.length)}`;
    };
    if ("page" in a.writes) {
      const { project, path } = a.writes.page;
      const next = swap(readPage(project, path));
      if (next === null) throw new Conflict(`“${words}” is not in ${a.title} now`);
      writePage(project, path, next);
    } else {
      const o = getEntity(a.writes.entity);
      const props: Record<string, unknown> = {};
      const keys = ["title", ...Object.keys(o.properties).filter((k) => k !== "title" && typeof o.properties[k] === "string")];
      for (const k of keys) {
        const next = swap(String(o.properties[k] ?? ""));
        if (next !== null) { props[k] = next; break; }
      }
      if (Object.keys(props).length) updateEntity(o.id, { properties: props });
      else if (typeof o.content === "string" && swap(o.content) !== null) updateEntity(o.id, { content: swap(o.content)! });
      else throw new Conflict(`“${words}” is not in ${a.title} now`);
    }
    return `“${words}” is a mention of ${b.title} now.`;
  }
  if (way.how === "attach") {
    const [file, holder] = a.kind === "file" ? [a, b] : [b, a];
    const o = entityFor(holder);
    const row = file.file!;
    if (row.abs) linkFile(o.id, row.abs);
    else if (row.sha256) {
      const f = types().find((x) => x.id === o.type)?.fields.find((x) => x.kind === "attachment");
      if (!f) throw new Conflict(`${holder.title} keeps no files`);
      const now = Array.isArray(o.properties[f.key]) ? (o.properties[f.key] as unknown[]) : [];
      if (!now.some((v) => (v as { sha256?: string })?.sha256 === row.sha256)) {
        updateEntity(o.id, { properties: { [f.key]: [...now, { kind: "attachment", filename: row.name, sha256: row.sha256 }] } });
      }
    } else throw new Conflict(`${row.name} cannot be found to attach`);
    return `${file.title} is on ${holder.title} now.`;
  }
  const ea = entityFor(a), eb = entityFor(b);
  if (declares(ea, eb)) connect(ea.id, eb.id);
  else if (declares(eb, ea)) connect(eb.id, ea.id);
  else if (RANK.indexOf(a.kind) <= RANK.indexOf(b.kind)) connect(ea.id, eb.id, { type: "about" });
  else connect(eb.id, ea.id, { type: "about" });
  return `${a.title} and ${b.title} are connected now.`;
}
