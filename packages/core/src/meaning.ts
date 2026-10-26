// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore

/*
 * Search by meaning (DESIGN, *Search by meaning*): what is written, found by
 * what it is about rather than by the words typed.
 *
 * **What is embedded**: every writing page — each project's, the unaffiliated
 * notes, Home's daily notes — in passages of a few paragraphs; and tasks,
 * people, projects and events, each as one passage of what it says; and
 * files — a project folder's, and those on things — by their text, read by
 * filetext.ts (PDFs, documents, spreadsheets, slides, pictures of words), in
 * passages like a page's.
 *
 * **By a model server**, the one Morgan's memory uses unless Settings says
 * otherwise (Ollama's `/api/embed`, or the OpenAI-style `/v1/embeddings`).
 * Nothing is embedded anywhere else, and with no model server set, nothing is
 * embedded at all.
 *
 * **Kept sealed**, with the store's own key, beside the entities: a vector
 * says something about what it was made from, so it is kept as the words are.
 *
 * **Kept current by looking**, a few minutes apart: a page by when it was last
 * written, a thing by its version; only what changed is embedded again, a
 * batch at a time, never on the request that asks. A change of model starts
 * the index again.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { allRecords, getFile, profilesOf, titleOf, type Entity } from "./entities.js";
import { listFiles } from "./files.js";
import { fileText, keepOnly, readable, saveFileText, textOf, textOfBytes } from "./filetext.js";
import { linkedBytes } from "./links.js";
import { CONFIG_DIR } from "./paths.js";
import { UNDATED, listProjects } from "./projects.js";
import { pageTree, readPage } from "./pages.js";
import { seal, unseal } from "./seal.js";
import { readJson, writeAtomic } from "./store.js";
import { DATA_DIR, storeKey } from "./vault.js";
import type { PageNode } from "@talaris/model";

export interface MeaningSettings { on?: boolean; url?: string; model?: string }
export function meaningSettings(): MeaningSettings {
  try {
    return readJson<{ meaning?: MeaningSettings }>(join(CONFIG_DIR, "config.json")).meaning ?? {};
  } catch {
    return {};
  }
}

/** One thing that can be found: a page or an entity, and how it opens. */
export interface Doc {
  key: string;
  kind: "page" | "task" | "person" | "project" | "event" | "file";
  title: string;
  /** For a page: its project (`notes` for an unaffiliated note) and path. For an entity: its id. */
  project?: string;
  path?: string;
  id?: string;
  /** For a file: where it is on disk, or the copy kept (its hash, and a thing it is on); the things it is on. */
  abs?: string;
  sha256?: string;
  holder?: string;
  on?: string[];
  /** What says whether it changed: a page's modified time, an entity's version. */
  stamp: string;
}
interface Chunk { text: string; vec: Float32Array }
interface Entry { doc: Doc; chunks: Chunk[] }
interface Index { model: string; entries: Map<string, Entry> }

const FILE = () => join(DATA_DIR, "meaning.sealed");
let index: Index | null = null;
let status = { indexing: false, last: "", error: "", pending: 0 };

// ------------------------------------------------------------ kept

function load(model: string): Index {
  if (index && index.model === model) return index;
  index = { model, entries: new Map() };
  if (!existsSync(FILE())) return index;
  try {
    const raw = JSON.parse(unseal(storeKey(), readFileSync(FILE())).toString("utf8")) as { model: string; entries: { doc: Doc; chunks: { text: string; vec: string }[] }[] };
    // Another model's vectors mean nothing to this one: started again.
    if (raw.model !== model) return index;
    for (const e of raw.entries) {
      index.entries.set(e.doc.key, { doc: e.doc, chunks: e.chunks.map((c) => ({ text: c.text, vec: new Float32Array(Buffer.from(c.vec, "base64").buffer.slice(0)) })) });
    }
  } catch {
    // Unreadable (a key changed, a file cut short): made again.
  }
  return index;
}

function save(ix: Index): void {
  const raw = { model: ix.model, entries: [...ix.entries.values()].map((e) => ({ doc: e.doc, chunks: e.chunks.map((c) => ({ text: c.text, vec: Buffer.from(c.vec.buffer, c.vec.byteOffset, c.vec.byteLength).toString("base64") })) })) };
  writeAtomic(FILE(), seal(storeKey(), JSON.stringify(raw)));
}

// ------------------------------------------------------------ what there is

/** A page's words in passages: paragraphs gathered to about 1,200 characters; a page's title leads each, for what it is about. */
export function passages(title: string, text: string): string[] {
  const paras = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const out: string[] = [];
  let cur = "";
  for (const p of paras) {
    if (cur && cur.length + p.length > 1200) { out.push(cur); cur = ""; }
    cur = cur ? `${cur}\n\n${p}` : p;
    while (cur.length > 2400) { out.push(cur.slice(0, 2400)); cur = cur.slice(2400); }
  }
  if (cur) out.push(cur);
  if (!out.length) out.push("");
  return out.slice(0, 24).map((p) => (title ? `${title}\n\n${p}` : p).trim());
}

function pageDocs(): Doc[] {
  const out: Doc[] = [];
  const places = [...listProjects().map((p) => p.id), UNDATED];
  for (const project of places) {
    let tree: PageNode[] = [];
    try { tree = pageTree(project); } catch { continue; }
    const walk = (nodes: PageNode[]) => {
      for (const n of nodes) {
        out.push({ key: `page:${project}/${n.path}`, kind: "page", title: n.title, project, path: n.path, stamp: String((n as { modified?: string }).modified ?? "") });
        walk(n.children);
      }
    };
    walk(tree);
  }
  return out;
}

const KIND: Record<string, Doc["kind"]> = { task: "task", contact: "person", project: "project", event: "event" };
function entityDocs(): Doc[] {
  const out: Doc[] = [];
  for (const { object: o } of allRecords()) {
    if (o.archived || o.stub) continue;
    const kind = profilesOf(o).map((p) => KIND[p]).find(Boolean);
    if (!kind) continue;
    out.push({ key: `e:${o.id}`, kind, title: titleOf(o), id: o.id, stamp: String(o.version) });
  }
  return out;
}

/** Every file with words in it: the folders' (not their pages, which are pages), and those on things. */
function fileDocs(): Doc[] {
  const out: Doc[] = [];
  for (const r of listFiles().rows) {
    if (r.status.includes("page") || r.status.includes("missing") || !readable(r.name)) continue;
    out.push({ key: `file:${r.key}`, kind: "file", title: r.name, project: r.project, ...(r.path ? { path: r.path } : {}), ...(r.abs ? { abs: r.abs } : {}),
      ...(r.sha256 ? { sha256: r.sha256, holder: r.holder } : {}), on: r.on.map((o) => o.id),
      stamp: r.sha256 ?? `${r.size ?? ""}|${r.mtime ?? ""}` });
  }
  return out;
}

/** A file's text: read from where it is, or from the copy kept. */
export async function docText(d: Doc): Promise<string> {
  return fileText(d.key, d.stamp, async () => {
    if (d.abs) return textOf(d.abs, d.title);
    const bytes = d.sha256 ? getFile(d.sha256) ?? linkedBytes(d.sha256) : null;
    return bytes ? textOfBytes(bytes, d.title) : "";
  });
}

/** What an entity says, as words: its title, and every text it holds. */
function entityText(o: Entity): string {
  const bits = [titleOf(o)];
  for (const [k, v] of Object.entries(o.properties ?? {})) {
    if (k === "title") continue;
    if (typeof v === "string" && v.trim() && !/^\d{4}-\d{2}-\d{2}/.test(v) && !/^[a-z]_[a-z0-9]+$/.test(v)) bits.push(v.trim());
    else if (Array.isArray(v)) for (const x of v) if (typeof x === "string" && x.includes(" ")) bits.push(x);
  }
  if (typeof o.content === "string" && o.content.trim()) bits.push(o.content.trim());
  if (o.tags?.length) bits.push(o.tags.map((t) => `#${t}`).join(" "));
  return bits.join("\n").slice(0, 4000);
}

// ------------------------------------------------------------ the model server

/** Some models want to be told which side of a search a text is on (nomic's prefixes). */
function framed(model: string, texts: string[], as: "document" | "query"): string[] {
  if (/nomic/i.test(model)) return texts.map((t) => `search_${as}: ${t}`);
  if (/mxbai|bge/i.test(model) && as === "query") return texts.map((t) => `Represent this sentence for searching relevant passages: ${t}`);
  return texts;
}

/** Vectors for texts, from the model server: Ollama's `/api/embed`, else the OpenAI-style `/v1/embeddings`. Each made unit length. */
export let embedder = async (s: Required<Pick<MeaningSettings, "url" | "model">>, texts: string[]): Promise<Float32Array[]> => {
  const base = s.url.replace(/\/+$/, "");
  let res = await fetch(`${base}/api/embed`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: s.model, input: texts }), signal: AbortSignal.timeout(120_000) });
  let vecs: number[][] | undefined;
  if (res.ok) vecs = ((await res.json()) as { embeddings?: number[][] }).embeddings;
  else {
    res = await fetch(`${base}/v1/embeddings`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: s.model, input: texts }), signal: AbortSignal.timeout(120_000) });
    if (!res.ok) throw new Error(`the model server answered ${res.status}`);
    vecs = ((await res.json()) as { data?: { embedding: number[] }[] }).data?.map((d) => d.embedding);
  }
  if (!vecs || vecs.length !== texts.length) throw new Error("the model server gave back no vectors");
  return vecs.map(unit);
};
/** For tests: vectors from somewhere else. */
export function setEmbedder(f: typeof embedder): void { embedder = f; }

function unit(v: number[] | Float32Array): Float32Array {
  const out = Float32Array.from(v);
  let n = 0;
  for (const x of out) n += x * x;
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < out.length; i++) out[i] = out[i]! / n;
  return out;
}

// ------------------------------------------------------------ keeping it current

const ready = (s: MeaningSettings): s is Required<Pick<MeaningSettings, "url" | "model">> & MeaningSettings => Boolean(s.on && s.url && s.model);

/** One pass: what changed, embedded again; what is gone, forgotten. Answers how many were embedded. */
export async function reindex(most = 400): Promise<number> {
  const s = meaningSettings();
  if (!ready(s) || status.indexing) return 0;
  status.indexing = true;
  try {
    const ix = load(s.model);
    const docs = [...pageDocs(), ...entityDocs(), ...fileDocs()];
    keepOnly(new Set(docs.filter((d) => d.kind === "file").map((d) => d.key)));
    const live = new Set(docs.map((d) => d.key));
    let dirty = false;
    for (const k of [...ix.entries.keys()]) if (!live.has(k)) { ix.entries.delete(k); dirty = true; }
    const stale = docs.filter((d) => ix.entries.get(d.key)?.doc.stamp !== d.stamp);
    status.pending = stale.length;
    const byId = new Map(allRecords().map((r) => [r.object.id, r.object]));
    let done = 0;
    for (const d of stale.slice(0, most)) {
      let texts: string[];
      if (d.kind === "page") {
        let words = "";
        try { words = readPage(d.project!, d.path!); } catch { continue; }
        texts = passages(d.title, words);
      } else if (d.kind === "file") {
        texts = passages(d.title, await docText(d));
      } else {
        const o = byId.get(d.id!);
        if (!o) continue;
        texts = [entityText(o)];
      }
      // A thing whose words are the same as when last embedded (a version moved for a tag): kept as it was.
      const sameWords = ix.entries.get(d.key)?.chunks.map((c) => c.text).join("\u0000") === texts.join("\u0000");
      if (!sameWords) {
        const vecs: Float32Array[] = [];
        for (let i = 0; i < texts.length; i += 16) vecs.push(...await embedder(s, framed(s.model, texts.slice(i, i + 16), "document")));
        ix.entries.set(d.key, { doc: d, chunks: texts.map((text, i) => ({ text, vec: vecs[i]! })) });
        done++;
      } else ix.entries.set(d.key, { ...ix.entries.get(d.key)!, doc: d });
      dirty = true;
      status.pending--;
      // Kept as it goes, a while apart, so a long first pass is not lost to a restart.
      if (done && done % 50 === 0) save(ix);
    }
    if (dirty) save(ix);
    saveFileText();
    status.last = new Date().toISOString();
    status.error = "";
    return done;
  } catch (e) {
    status.error = (e as Error).message;
    return 0;
  } finally {
    status.indexing = false;
  }
}

let timer: NodeJS.Timeout | null = null;
/** From now on: a pass a minute after start, then every few minutes. */
export function startMeaning(): void {
  if (timer) return;
  const tick = () => { void reindex(); };
  setTimeout(tick, 60_000).unref();
  timer = setInterval(tick, 4 * 60_000);
  timer.unref();
}

export function meaningStatus(): { on: boolean; model: string; url: string; items: number; passages: number; pending: number; indexing: boolean; last: string; error: string } {
  const s = meaningSettings();
  const ix = s.model ? load(s.model) : null;
  return { on: Boolean(s.on), model: s.model ?? "", url: s.url ?? "", items: ix?.entries.size ?? 0,
    passages: ix ? [...ix.entries.values()].reduce((n, e) => n + e.chunks.length, 0) : 0, ...status };
}

// ------------------------------------------------------------ finding

export interface Found extends Doc { score: number; passage: string }

/**
 * What is nearest in meaning to the words asked: each thing once, by its best
 * passage, nearest first, above a floor so that nothing is offered for
 * nothing. Asked with no model server set, it answers nothing.
 */
export async function searchMeaning(q: string, options: { limit?: number; kind?: string; project?: string; floor?: number } = {}): Promise<Found[]> {
  const s = meaningSettings();
  if (!ready(s) || !q.trim()) return [];
  const ix = load(s.model);
  if (!ix.entries.size) return [];
  const [qv] = await embedder(s, framed(s.model, [q.trim()], "query"));
  const floor = options.floor ?? 0.5;
  const best = new Map<string, Found>();
  for (const e of ix.entries.values()) {
    if (options.kind && e.doc.kind !== options.kind) continue;
    if (options.project && e.doc.project !== options.project) continue;
    for (const c of e.chunks) {
      if (c.vec.length !== qv!.length) continue;
      let dot = 0;
      for (let i = 0; i < c.vec.length; i++) dot += c.vec[i]! * qv![i]!;
      if (dot < floor) continue;
      const had = best.get(e.doc.key);
      if (!had || dot > had.score) best.set(e.doc.key, { ...e.doc, score: Math.round(dot * 1000) / 1000, passage: snippet(c.text, e.doc.title) });
    }
  }
  return [...best.values()].sort((a, b) => b.score - a.score).slice(0, options.limit ?? 20);
}

/** A passage as a line to show: its title taken off, its first words. */
function snippet(text: string, title: string): string {
  const t = text.startsWith(title) ? text.slice(title.length) : text;
  return t.replace(/\s+/g, " ").trim().slice(0, 220);
}

/** For tests and the status line: the words a page was last embedded from changed? */
export const fingerprint = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16);

/**
 * What is nearest in meaning to one thing already in the index (`key`): each
 * other thing once, by its closest pair of passages, nearest first, above the
 * floor. What suggests a thing's likely ties (suggest.ts).
 */
export function nearTo(key: string, options: { limit?: number; floor?: number } = {}): Found[] {
  const s = meaningSettings();
  if (!ready(s)) return [];
  const ix = load(s.model);
  const me = ix.entries.get(key);
  if (!me) return [];
  const floor = options.floor ?? 0.62;
  const mine = me.chunks.slice(0, 8);
  const best: Found[] = [];
  for (const e of ix.entries.values()) {
    if (e.doc.key === key) continue;
    let top = -1, at: Chunk | null = null;
    for (const c of e.chunks.slice(0, 12)) {
      for (const m of mine) {
        if (c.vec.length !== m.vec.length) continue;
        let dot = 0;
        for (let i = 0; i < c.vec.length; i++) dot += c.vec[i]! * m.vec[i]!;
        if (dot > top) { top = dot; at = c; }
      }
    }
    if (top >= floor && at) best.push({ ...e.doc, score: Math.round(top * 1000) / 1000, passage: snippet(at.text, e.doc.title) });
  }
  return best.sort((a, b) => b.score - a.score).slice(0, options.limit ?? 10);
}

/** A thing's entry in the index, by key: for a file, what it was read as. */
export function indexed(key: string): Doc | null {
  const s = meaningSettings();
  return s.model ? load(s.model).entries.get(key)?.doc ?? null : null;
}
