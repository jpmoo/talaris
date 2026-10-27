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
import { allRecords, getFile, profilesOf, titleOf, types, type Entity } from "./entities.js";
import { execFileSync } from "node:child_process";
import { filesVersion, listFiles, watchLinked, type FileRow } from "./files.js";
import { Unavailable, aboutIsYours, editAbout, fileText, forgetText, keepOnly, keptAbout, keptText, pageAbout, readable, saveFileText, setAbout, setDescriber, setPageAbout, textOf, textOfBytes } from "./filetext.js";
import { morganDescribe, morganDescribeText } from "./morgan-describe.js";
import { linkedBytes } from "./links.js";
import { CONFIG_DIR, STATE_DIR } from "./paths.js";
import { UNDATED, listProjects } from "./projects.js";
import { pageTree, readPage } from "./pages.js";
import { canvasName, canvasTree, canvasWords, projectCanvases } from "./canvases.js";
import { homeId, threadById, threadText, threads } from "./threads.js";
import type { CanvasNode } from "@talaris/model";
import { seal, unseal } from "./seal.js";
import { readJson, writeAtomic, writeJson } from "./store.js";
import { DATA_DIR, storeKey } from "./vault.js";
import type { PageNode } from "@talaris/model";

export interface MeaningSettings {
  on?: boolean; url?: string; model?: string;
  /** Pictures with no words in them described by Morgan (its `describe`); false: left with none. */
  describe?: boolean;
  /**
   * When files are looked at for anything new or changed to read (Settings,
   * Data, Reading files): `change` — as they change, within a minute or so;
   * `idle` — while the computer is idle (away a few minutes, or locked);
   * `schedule` — once a day, at `at`; `manual` — only when Scan now is
   * pressed. Pages, tasks and people are read as they change whatever this says.
   */
  scan?: "change" | "idle" | "schedule" | "manual";
  at?: string;
}
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
  kind: "page" | "task" | "person" | "project" | "event" | "file" | "canvas" | "thread";
  title: string;
  /** For a page: its project (`notes` for an unaffiliated note) and path; for a canvas, its project and id (as `path`); for a thread, Home and its id. For an entity: its id. */
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
/** How the index stands, and — while a pass runs — what it is reading and how far through the pass it is. */
let status = { indexing: false, last: "", error: "", pending: 0, doing: "", doingKind: "", done: 0, of: 0, morganAway: false };

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

/** Every project's canvases. The "c2": how a canvas is read changed once (its title no longer twice, an empty one empty): each read again. */
function canvasDocs(): Doc[] {
  const out: Doc[] = [];
  for (const p of listProjects()) {
    let top: CanvasNode;
    try { top = canvasTree(p.id); } catch { continue; }
    const walk = (n: CanvasNode) => {
      out.push({ key: `canvas:${p.id}/${n.id}`, kind: "canvas", title: canvasName(p.id, n), project: p.id, path: n.id, stamp: `${n.modified ?? ""}|c2` });
      n.children.forEach(walk);
    };
    walk(top);
  }
  return out;
}

/** Morgan's threads, in Home: what each was about, as Morgan summed it up. */
function threadDocs(): Doc[] {
  const home = homeId();
  return threads().map((t) => ({ key: `thread:${home}/${t.id}`, kind: "thread" as const, title: t.title, project: home, path: t.id, stamp: fingerprint(threadText(t)) }));
}

/** A canvas's words, as it is now, but its title (which leads each passage); "" if it is gone or has nothing on it. */
function canvasText(d: Doc): string {
  const doc = projectCanvases(d.project!).find((c) => c.id === d.path);
  return doc ? canvasWords(doc, false) : "";
}

const KIND: Record<string, Doc["kind"]> = { task: "task", contact: "person", project: "project", event: "event" };
function entityDocs(): Doc[] {
  const out: Doc[] = [];
  for (const { object: o } of allRecords()) {
    if (o.archived || o.stub) continue;
    const kind = profilesOf(o).map((p) => KIND[p]).find(Boolean);
    if (!kind) continue;
    // The "w2": what is embedded of a thing changed once (only its written words): each embedded again, once.
    out.push({ key: `e:${o.id}`, kind, title: titleOf(o), id: o.id, stamp: `${o.version}w2` });
  }
  return out;
}

/** What says a file changed: its hash, or its size and time; and how files are read (a change there reads each again). */
const fileStamp = (r: FileRow) => `${r.sha256 ?? `${r.size ?? ""}|${r.mtime ?? ""}`}|r3`;

export type ReadState = "read" | "nowords" | "waiting" | "unreadable";
/** What a read file is about, for its tip in Files: its description, else the start of its words. */
function aboutOf(key: string, about = keptAbout(key)): string {
  // A description, or word that one is coming: never the file's own first words, which say little of what it is.
  return about ? about : about === "" ? "Read — Morgan had nothing to say of it" : "Read — being described";
}
/**
 * For the Files panel: each file's words, as far as search knows them — read
 * (and how much), read and holding none, or not read yet. A file of a kind
 * with no words to read, a page, or one missing, has no state. With search by
 * meaning off, nothing is read at all.
 */
export function fileReadStates(rows: FileRow[]): { reading: { on: boolean; pending: number; indexing: boolean }; read: Record<string, ReadState>; about: Record<string, string> } {
  const s = meaningSettings();
  const read: Record<string, ReadState> = {};
  const about: Record<string, string> = {};
  if (!ready(s)) return { reading: { on: false, pending: 0, indexing: false }, read, about };
  const ix = load(s.model);
  let pending = 0;
  for (const r of rows) {
    if (r.status.includes("page") || r.status.includes("missing")) continue;
    // Of a kind Talaris cannot read (audio, video, archives…): said so, in red.
    if (!readable(r.name)) { read[r.key] = "unreadable"; continue; }
    const key = `file:${r.key}`;
    const e = ix.entries.get(key);
    if (!e || e.doc.stamp !== fileStamp(r)) { read[r.key] = "waiting"; pending++; continue; }
    read[r.key] = (keptText(key) ?? "").trim() ? "read" : "nowords";
    if (read[r.key] === "read") about[r.key] = aboutOf(key);
  }
  // Pages are read as pages (pageDocs), by their path: read once in the index, their first words their tip.
  for (const r of rows) {
    if (!r.status.includes("page") || !r.path) continue;
    const path = r.path.replace(/^Writing\//, "").replace(/\.md$/, "");
    const e = ix.entries.get(`page:${r.project}/${path}`);
    if (!e) { read[r.key] = "waiting"; continue; }
    const said = e.chunks.some((c) => c.text.trim().length > e.doc.title.length + 2);
    read[r.key] = said ? "read" : "nowords";
    if (said) about[r.key] = aboutOf(e.doc.key, pageAbout(e.doc.key, e.doc.stamp));
  }
  // Canvases and threads, by the thing they are: read when in the index; a thread's description is Morgan's summary.
  for (const r of rows) {
    if (!r.thing || r.status.includes("missing")) continue;
    const e = ix.entries.get(r.thing);
    if (!e) { read[r.key] = "waiting"; continue; }
    const said = e.chunks.some((c) => c.text.trim().length > e.doc.title.length + 2);
    read[r.key] = said ? "read" : "nowords";
    if (!said) continue;
    if (e.doc.kind === "thread") about[r.key] = thingDescription(r.thing).about || "Read";
    else about[r.key] = aboutOf(e.doc.key, pageAbout(e.doc.key, e.doc.stamp));
  }
  return { reading: { on: true, pending, indexing: status.indexing }, read, about };
}

/** A canvas's or a thread's description, as Files shows and edits it: a thread's is Morgan's summary until the person writes one. */
export function thingDescription(key: string): { about: string; aboutByYou: boolean; read: boolean } {
  if (key.startsWith("thread:")) {
    const t = threadById(key.slice(key.indexOf("/") + 1));
    const mine = aboutIsYours(key) ? pageAbout(key, t ? fingerprint(threadText(t)) : "") : undefined;
    return { about: mine ?? t?.summary ?? "", aboutByYou: mine !== undefined, read: Boolean(t) };
  }
  return pageDescription(key);
}

/** The files read that gave no words: which, and where — for Settings, to see and to have read again. */
export function filesWithNoWords(): { key: string; name: string; project: string; projectName: string; path?: string; abs?: string; on: string[]; type: string }[] {
  const rows = listFiles().rows;
  const states = fileReadStates(rows).read;
  const names = new Map<string, string>([[UNDATED, "Unaffiliated pages"], ...listProjects().map((p) => [p.id, p.name] as [string, string])]);
  return rows.filter((r) => states[r.key] === "nowords")
    .map((r) => ({ key: r.key, name: r.name, project: r.project, projectName: names.get(r.project) ?? r.project, ...(r.path ? { path: r.path } : {}), ...(r.abs ? { abs: r.abs } : {}),
      on: r.on.map((o) => o.title), type: r.type }));
}

/**
 * A thing let go of in the index, to be read again: and if a pass is reading
 * now, it does not put back what it read before this (an older description),
 * and another pass follows it.
 */
const letGo = new Set<string>();
let again = false;
function forget(ix: Index, key: string): boolean {
  if (status.indexing) { letGo.add(key); again = true; }
  return ix.entries.delete(key);
}

/** A file's description written by the person (Files): kept, and the file read again with it, now. */
export function editDescription(meaningKey: string, about: string): boolean {
  if (!editAbout(meaningKey, about)) return false;
  saveFileText();
  const s = meaningSettings();
  if (ready(s)) { const ix = load(s.model); if (forget(ix, meaningKey)) save(ix); }
  void reindex(400, { files: true });
  return true;
}

/** A page's description, as Files shows it: what it is about, and whether it is the person's own. */
export function pageDescription(key: string): { about: string; aboutByYou: boolean; read: boolean } {
  const s = meaningSettings();
  const e = ready(s) ? load(s.model).entries.get(key) : undefined;
  const about = e ? pageAbout(key, e.doc.stamp) : undefined;
  return { about: about ?? "", aboutByYou: aboutIsYours(key), read: Boolean(e) };
}
/** A page's description written by the person (Files): it stands, and the page is read again with it. */
export function editPageDescription(key: string, about: string): boolean {
  // A thread's: written over Morgan's summary (the summary stays Morgan's); cleared, the summary again.
  if (key.startsWith("thread:")) {
    const t = threadById(key.slice(key.indexOf("/") + 1));
    if (!t) return false;
    setPageAbout(key, fingerprint(threadText(t)), about.trim(), about.trim() !== "");
    saveFileText();
    const s = meaningSettings();
    if (ready(s)) { const ix = load(s.model); if (forget(ix, key)) save(ix); }
    void reindex(400, { files: false });
    return true;
  }
  const s = meaningSettings();
  if (!ready(s)) return false;
  const ix = load(s.model);
  const e = ix.entries.get(key);
  if (!e) return false;
  setPageAbout(key, e.doc.stamp, about.trim(), true);
  saveFileText();
  forget(ix, key);
  save(ix);
  void reindex(400, { files: false });
  return true;
}

/** Files read again: what each said forgotten, and its entry, so the next pass reads it afresh (Settings: Read again). */
export function readAgain(keys: string[]): number {
  const s = meaningSettings();
  if (!ready(s)) return 0;
  const ix = load(s.model);
  let n = 0;
  for (const k of keys) {
    forgetText(`file:${k}`);
    if (forget(ix, `file:${k}`)) n++;
  }
  if (n) save(ix);
  saveFileText();
  return n;
}

/** The files search knows of: read with words, read with none, waiting. */
function fileCounts(): { read: number; nowords: number; waiting: number } {
  const out = { read: 0, nowords: 0, waiting: 0 };
  try {
    for (const v of Object.values(fileReadStates(listFiles().rows).read)) if (v !== "unreadable") out[v === "read" ? "read" : v === "nowords" ? "nowords" : "waiting"]++;
  } catch { /* the store locked for now */ }
  return out;
}

/** Every file with words in it: the folders' (not their pages, which are pages), and those on things. */
function fileDocs(): Doc[] {
  const out: Doc[] = [];
  for (const r of listFiles().rows) {
    if (r.status.includes("page") || r.status.includes("missing") || !readable(r.name)) continue;
    out.push({ key: `file:${r.key}`, kind: "file", title: r.name, project: r.project, ...(r.path ? { path: r.path } : {}), ...(r.abs ? { abs: r.abs } : {}),
      ...(r.sha256 ? { sha256: r.sha256, holder: r.holder } : {}), on: r.on.map((o) => o.id),
      stamp: fileStamp(r) });
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
  // Only what is written: a status, a choice, a date says nothing of what a thing is about, and makes all of a kind alike.
  const kinds = new Map((types().find((t) => t.id === o.type)?.fields ?? []).map((f) => [f.key, f.kind]));
  for (const [k, v] of Object.entries(o.properties ?? {})) {
    if (k === "title") continue;
    const kind = kinds.get(k);
    if (kind && kind !== "text" && kind !== "richtext") continue;
    if (k.includes(":")) continue;
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
export async function reindex(most = 400, options: { files?: boolean } = {}): Promise<number> {
  const s = meaningSettings();
  if (!ready(s) || status.indexing) return 0;
  status.indexing = true;
  setDescriber(s.describe === false ? null : morganDescribe);
  status.morganAway = false;
  try {
    const ix = load(s.model);
    const docs = [...pageDocs(), ...canvasDocs(), ...threadDocs(), ...entityDocs(), ...fileDocs()];
    keepOnly(new Set(docs.filter((d) => d.kind === "file").map((d) => d.key)));
    const live = new Set(docs.map((d) => d.key));
    let dirty = false;
    for (const k of [...ix.entries.keys()]) if (!live.has(k)) { ix.entries.delete(k); dirty = true; }
    // Files only when it is their time (`scan`): kept as they are meanwhile, neither read again nor forgotten.
    const stale = docs.filter((d) => ix.entries.get(d.key)?.doc.stamp !== d.stamp && (options.files !== false || d.kind !== "file"));
    status.pending = stale.length;
    status.done = 0;
    status.of = Math.min(stale.length, most);
    const byId = new Map(allRecords().map((r) => [r.object.id, r.object]));
    let done = 0;
    for (const d of stale.slice(0, most)) {
      status.doing = d.title;
      status.doingKind = d.kind;
      let texts: string[];
      if (d.kind === "page") {
        let words = "";
        try { words = readPage(d.project!, d.path!); } catch { continue; }
        // Its description, once there is one, leads: what it is found by first.
        const about = pageAbout(d.key, d.stamp);
        texts = passages(d.title, about ? `About: ${about}\n\n${words}` : words);
      } else if (d.kind === "canvas") {
        const about = pageAbout(d.key, d.stamp);
        const words = canvasText(d);
        // Nothing on it: kept with no passages, so it is known as read and empty, and is near nothing.
        texts = words.trim() ? passages(d.title, about ? `About: ${about}\n\n${words}` : words) : [];
      } else if (d.kind === "thread") {
        // Morgan's summary is its description; one written by the person stands in its place.
        const t = threadById(d.path!);
        if (!t) continue;
        const mine = aboutIsYours(d.key) ? pageAbout(d.key, d.stamp) : undefined;
        texts = passages(d.title, mine ? `About: ${mine}\n\n${t.summary}` : t.summary);
      } else if (d.kind === "file") {
        // A picture to be described, and Morgan not answering: left waiting, to be tried again.
        // What it is about, once described, leads its words: what it is found by first.
        try { const words = await docText(d); const about = keptAbout(d.key); texts = passages(d.title, about && !words.startsWith("Picture: ") ? `About: ${about}\n\n${words}` : words); } catch (e) {
          if (!(e instanceof Unavailable)) throw e;
          status.morganAway = true; status.pending--; status.done++;
          continue;
        }
      } else {
        const o = byId.get(d.id!);
        if (!o) continue;
        texts = [entityText(o)];
      }
      // A thing whose words are the same as when last embedded (a version moved for a tag): kept as it was.
      // Let go of while this was reading it: what was read is older than that; the pass after reads it again.
      if (letGo.has(d.key)) continue;
      const sameWords = ix.entries.get(d.key)?.chunks.map((c) => c.text).join("\u0000") === texts.join("\u0000");
      if (!sameWords) {
        const vecs: Float32Array[] = [];
        for (let i = 0; i < texts.length; i += 16) vecs.push(...await embedder(s, framed(s.model, texts.slice(i, i + 16), "document")));
        ix.entries.set(d.key, { doc: d, chunks: texts.map((text, i) => ({ text, vec: vecs[i]! })) });
        done++;
      } else ix.entries.set(d.key, { ...ix.entries.get(d.key)!, doc: d });
      dirty = true;
      status.pending--;
      status.done++;
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
    status.doing = "";
    status.doingKind = "";
    letGo.clear();
    if (again) { again = false; setTimeout(() => void reindex(most, options), 0).unref(); }
  }
}

let timer: NodeJS.Timeout | null = null;

// ------------------------------------------------------------ when files are read

/** Told by Talaris's hypridle (power.py): away a few minutes, or back. */
let idleSince = 0;
export function setIdle(idle: boolean): void { idleSince = idle ? Date.now() : 0; }
/** Idle: as hypridle says, or the screen locked (hyprlock running) whoever locked it. */
function idleNow(): boolean {
  if (idleSince) return true;
  try { execFileSync("pidof", ["hyprlock"], { stdio: "ignore", timeout: 2000 }); return true; } catch { return false; }
}

const SCANNED = () => join(STATE_DIR, "meaning-scan.json");
const HTML_AGAIN = () => join(STATE_DIR, "meaning-html-read-again.json");
const lastScan = (): { at: string; day: string } => { try { return readJson<{ at: string; day: string }>(SCANNED()); } catch { return { at: "", day: "" }; } };
let scanning = false;
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };

/**
 * The files read whose words are not yet described, described by Morgan — a
 * few at a time, each scan — and their entries let go, so they are read again
 * with it. A picture is its own description. Answers how many were described;
 * stops at the first Morgan cannot answer.
 */
async function describeFiles(most = 150, minutes = 10): Promise<number> {
  const s = meaningSettings();
  if (!ready(s)) return 0;
  const ix = load(s.model);
  const until = Date.now() + minutes * 60_000;
  let n = 0;
  for (const e of [...ix.entries.values()]) {
    if (n >= most || Date.now() > until) break;
    // Pages too, by what they say now: described again when they change.
    let text = "";
    if (e.doc.kind === "file") {
      if (keptAbout(e.doc.key) !== undefined) continue;
      text = keptText(e.doc.key) ?? "";
      if (text.startsWith("Picture: ")) continue;
    } else if (e.doc.kind === "page") {
      if (pageAbout(e.doc.key, e.doc.stamp) !== undefined) continue;
      try { text = readPage(e.doc.project!, e.doc.path!); } catch { continue; }
    } else if (e.doc.kind === "canvas") {
      if (pageAbout(e.doc.key, e.doc.stamp) !== undefined) continue;
      try { text = canvasText(e.doc); } catch { continue; }
      // A canvas with nothing on it has nothing to describe.
      if (!text.trim()) continue;
    } else continue;
    if (!text.trim()) continue;
    status.doing = e.doc.title;
    status.doingKind = e.doc.kind;
    const about = await morganDescribeText(text, e.doc.title);
    if (about === null) { status.morganAway = true; break; }
    if (e.doc.kind === "page" || e.doc.kind === "canvas") setPageAbout(e.doc.key, e.doc.stamp, about);
    else setAbout(e.doc.key, about);
    ix.entries.delete(e.doc.key);
    n++;
  }
  status.doing = "";
  if (n) { save(ix); saveFileText(); }
  return n;
}

/**
 * Files looked at for anything new or changed (Scan now, or as `scan` says):
 * linked files and linked folders looked at again (files.ts), then every
 * file not read since it changed read, pass after pass until none waits.
 * Answers how many were read.
 */
export async function scanFiles(): Promise<{ read: number; changed: number }> {
  if (scanning) return { read: 0, changed: 0 };
  scanning = true;
  try {
    const changed = watchLinked();
    let read = 0;
    for (let i = 0; i < 50; i++) {
      const now = await reindex(400, { files: true });
      read += now;
      // Done, stopped, or nothing more to be had for now (pictures waiting on Morgan).
      if (!status.pending || status.error || !now) break;
    }
    // Each file read, described (what it is about), and read again with it: so it is found by that too.
    // HTML read as raw markup before it was read as what a reader sees: read again, once.
    if (!existsSync(HTML_AGAIN())) {
      const html = listFiles().rows.filter((r) => /\.html?$/i.test(r.name)).map((r) => r.key);
      if (html.length) readAgain(html);
      writeJson(HTML_AGAIN(), { at: new Date().toISOString(), files: html.length });
      read += await reindex(400, { files: true });
    }
    if (meaningSettings().describe !== false && await describeFiles()) read += await reindex(400, { files: true });
    writeJson(SCANNED(), { at: new Date().toISOString(), day: today() });
    return { read, changed };
  } finally {
    scanning = false;
  }
}

/**
 * From now on. Pages, tasks and people: a pass a minute after start, then
 * every few minutes, and soon after a pass that left some waiting. Files: as
 * `scan` says — as they change (looked at each minute, and when Files says one
 * changed), while idle, once a day, or only when asked.
 */
export function startMeaning(): void {
  if (timer) return;
  const things = () => { void reindex(400, { files: false }).then(() => { if (status.pending > 0 && !status.error && !scanning) setTimeout(things, 5_000).unref(); }); };
  setTimeout(things, 60_000).unref();
  timer = setInterval(things, 4 * 60_000);
  timer.unref();
  let seen = -1, lastIdleScan = 0, lastChangeScan = 0;
  setInterval(() => {
    const s = meaningSettings();
    if (!ready(s)) return;
    const when = s.scan ?? "change";
    const v = filesVersion();
    const changed = seen !== -1 && v !== seen;
    seen = v;
    // As they change: when Files says one did, and each minute or two besides (a linked file, a linked folder).
    if (when === "change") { if (changed || Date.now() - lastChangeScan > 90_000) { lastChangeScan = Date.now(); void scanFiles(); } return; }
    if (when === "idle") {
      // Idle: a scan, and again every ten minutes while it lasts.
      if (idleNow() && Date.now() - lastIdleScan > 10 * 60_000) { lastIdleScan = Date.now(); void scanFiles(); }
      return;
    }
    if (when === "schedule") {
      const [h, m] = (s.at ?? "03:00").split(":").map(Number);
      const now = new Date();
      const due = now.getHours() * 60 + now.getMinutes() >= (h ?? 3) * 60 + (m ?? 0);
      if (due && lastScan().day !== today()) void scanFiles();
    }
  }, 30_000).unref();
}
export function meaningStatus(): { on: boolean; model: string; url: string; items: number; passages: number; pending: number; indexing: boolean; last: string; error: string;
  doing: string; doingKind: string; done: number; of: number; morganAway: boolean; scan: string; at: string; lastScan: string; idle: boolean; scanning: boolean; files: { read: number; nowords: number; waiting: number } } {
  const s = meaningSettings();
  const ix = s.model ? load(s.model) : null;
  return { on: Boolean(s.on), model: s.model ?? "", url: s.url ?? "", items: ix?.entries.size ?? 0,
    passages: ix ? [...ix.entries.values()].reduce((n, e) => n + e.chunks.length, 0) : 0, ...status,
    scan: s.scan ?? "change", at: s.at ?? "03:00", lastScan: lastScan().at, idle: idleNow(), scanning, files: fileCounts() };
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
