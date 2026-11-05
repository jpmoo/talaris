// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore

/**
 * What a project is about, as Talaris comes to know it (DESIGN, *A project's
 * profile*): read from what is in it, and read again as that changes. Its
 * distinctive words, the middle of what it says in meaning, and what its things
 * are tied to. Nothing is written for this; it is worked out from the meaning
 * index (meaning.ts), which already holds every thing's words and vectors, sealed.
 * It is what suggests what might belong in a project, and which project a thing
 * in none might belong in (suggest.ts). Home holds what is in no project, so has none.
 *
 * With no model server there is no index, and so no profile: suggestions by name
 * go on as they do.
 */

import { allRecords, connections, type Entity } from "./entities.js";
import { filedUnder, projectEntity } from "./filing.js";
import { listFiles } from "./files.js";
import { meaningIndex, type IndexEntry } from "./meaning.js";
import { listProjects } from "./projects.js";

export interface Profile {
  id: string;
  name: string;
  entity?: Entity;
  /** What is in it, by meaning-index key. */
  members: Set<string>;
  /** Its most distinctive words, the most telling first. */
  keywords: string[];
  /** The middle of what it says; null with too little to go on. */
  centre: Float32Array | null;
}

// Words of no use in telling one project from another, past what rarity already does.
const STOP = new Set(`about above after again against also among another because been before being below between both came cannot could
during each even every first from have having here into just like made make many more most much must need next only other over same
should since some such than that their them then there these they this those through under until very were what when where which while
will with within without would your you're they're it's that's don't will i'll we're we've i've have also still really thing things
would could want using used use new one two three today tomorrow yesterday please thanks thank`.split(/\s+/));

/** A passage's words: its links as their words, addresses and what is not a word gone. */
function wordsOf(text: string): string[] {
  return (text.replace(/\]\([^)]*\)/g, "]").replace(/https?:\/\/\S+/g, " ").replace(/\S+@\S+/g, " ").replace(/<[^>]+>/g, " ").toLowerCase().match(/\p{L}[\p{L}'’-]{3,}/gu) ?? []).filter((w) => !STOP.has(w));
}

function unit(v: Float32Array): Float32Array | null {
  let n = 0;
  for (const x of v) n += x * x;
  if (!n) return null;
  n = Math.sqrt(n);
  return v.map((x) => x / n);
}

const dot = (a: Float32Array, b: Float32Array) => {
  let d = 0;
  for (let i = 0; i < a.length; i++) d += a[i]! * b[i]!;
  return d;
};

interface Known {
  gen: number; at: number; profiles: Map<string, Profile>; words: Map<string, Set<string>>; entries: IndexEntry[];
  /** How near each thing is to each project's middle, as `key project`; the one it is nearest; and how those run for each project. */
  near: Map<string, number>; nearest: Map<string, string>; spread: Map<string, { mean: number; sd: number }>;
}
let known: Known | null = null;
// Read again when the index moves, or now and then: what is filed under what can change without it.
const FRESH_MS = 2 * 60 * 1000;
const PASSAGES = 6, MOST_KEYWORDS = 12;
/** With fewer things than this in it, a project's middle is only those things: not yet what it is about. */
const MOST_THIN = 3;
/** A word in more of everything than this says nothing of any one project: "said", in anyone's writing. */
const COMMON_SHARE = 0.06;
/** Close in meaning, for a project: this near at least, and this far past how near things run for it, or all of a small project's are "close". */
const CLOSE_FLOOR = 0.72, CLOSE_PAST_SDS = 2;

function knownNow(): Known | null {
  const ix = meaningIndex();
  if (!ix) return null;
  if (known && known.gen === ix.gen && Date.now() - known.at < FRESH_MS) return known;
  const entries = [...ix.entries];
  // How rare each word is, across everything.
  const words = new Map<string, Set<string>>();
  const counts = new Map<string, Map<string, number>>();
  const often = new Map<string, number>();
  for (const e of entries) {
    const tf = new Map<string, number>();
    for (const c of e.chunks.slice(0, PASSAGES)) for (const w of wordsOf(c.text)) tf.set(w, (tf.get(w) ?? 0) + 1);
    counts.set(e.doc.key, tf);
    words.set(e.doc.key, new Set(tf.keys()));
    for (const w of tf.keys()) often.set(w, (often.get(w) ?? 0) + 1);
  }
  const rarity = (w: string) => Math.log((entries.length + 1) / (often.get(w) ?? 1));
  // What is in each: what lives there, what has a shortcut there, what is filed under it.
  const inProject = new Map<string, Set<string>>();
  const put = (p: string, key: string) => { if (!inProject.has(p)) inProject.set(p, new Set()); inProject.get(p)!.add(key); };
  for (const e of entries) if (e.doc.project && e.doc.kind !== "thread") put(e.doc.project, e.doc.key);
  for (const r of listFiles().rows) for (const p of r.alsoIn ?? []) put(p, r.thing ?? `file:${r.key}`);
  const byEntity = new Map<string, string>();
  const profiles = new Map<string, Profile>();
  const list = listProjects().filter((p) => !p.home);
  for (const p of list) { const e = projectEntity(p.id); if (e) byEntity.set(e.id, p.id); }
  for (const { object: o } of allRecords()) {
    if (o.archived || o.stub) continue;
    for (const under of filedUnder(o)) { const p = byEntity.get(under); if (p) put(p, `e:${o.id}`); }
  }
  const byKey = new Map(entries.map((e) => [e.doc.key, e]));
  for (const p of list) {
    const e = projectEntity(p.id) ?? undefined;
    const members = inProject.get(p.id) ?? new Set<string>();
    const score = new Map<string, number>(), docs = new Map<string, number>();
    let sum: Float32Array | null = null;
    for (const key of members) {
      for (const [w, n] of counts.get(key) ?? []) { score.set(w, (score.get(w) ?? 0) + Math.min(n, 3)); docs.set(w, (docs.get(w) ?? 0) + 1); }
      for (const c of byKey.get(key)?.chunks.slice(0, 3) ?? []) {
        if (!sum) sum = new Float32Array(c.vec.length);
        if (c.vec.length === sum.length) for (let i = 0; i < sum.length; i++) sum[i]! += c.vec[i]!;
      }
    }
    // A word it says in only one thing is that thing's, not the project's.
    const keywords = [...score].filter(([w]) => (docs.get(w) ?? 0) >= 2 && (entries.length < 100 || (often.get(w) ?? 0) / entries.length <= COMMON_SHARE)).map(([w, n]) => [w, n * rarity(w)] as const).sort((a, b) => b[1] - a[1]).slice(0, MOST_KEYWORDS).map(([w]) => w);
    profiles.set(p.id, { id: p.id, name: p.name, ...(e ? { entity: e } : {}), members, keywords, centre: members.size >= MOST_THIN && sum ? unit(sum) : null });
  }
  // How near everything is to each project, once here: a thing is close to the one it is nearest, and only if that stands out.
  const near = new Map<string, number>(), nearest = new Map<string, string>(), spread = new Map<string, { mean: number; sd: number }>();
  const running = new Map<string, { n: number; sum: number; sq: number }>();
  for (const e of entries) {
    let top = -1, whose = "";
    for (const p of profiles.values()) {
      if (!p.centre) continue;
      let at = -1;
      for (const c of e.chunks.slice(0, 3)) if (c.vec.length === p.centre.length) at = Math.max(at, dot(c.vec, p.centre));
      if (at < 0) continue;
      near.set(`${e.doc.key} ${p.id}`, at);
      const r = running.get(p.id) ?? { n: 0, sum: 0, sq: 0 };
      r.n++; r.sum += at; r.sq += at * at;
      running.set(p.id, r);
      if (at > top) { top = at; whose = p.id; }
    }
    if (whose) nearest.set(e.doc.key, whose);
  }
  for (const [id, r] of running) { const mean = r.sum / r.n; spread.set(id, { mean, sd: Math.sqrt(Math.max(0, r.sq / r.n - mean * mean)) }); }
  known = { gen: ix.gen, at: Date.now(), profiles, words, entries, near, nearest, spread };
  return known;
}

/** One project's profile, as it stands. */
export function profileOf(projectId: string): Profile | null {
  return knownNow()?.profiles.get(projectId) ?? null;
}

/** How near a thing is to a project, if that counts as close: no other is nearer, and it stands out from how near things run for this one; else -1. */
function closeTo(k: Known, key: string, project: string): number {
  const at = k.near.get(`${key} ${project}`), s = k.spread.get(project);
  return at !== undefined && s && at >= CLOSE_FLOOR && at >= s.mean + CLOSE_PAST_SDS * s.sd && k.nearest.get(key) === project ? at : -1;
}

export interface NearProject { key: string; score: number; shared: string[]; ties: number }

/** What is not in a project and might belong there, by meaning-index key: near its middle, using its words, or tied to its things. */
export function nearProject(projectId: string, options: { limit?: number } = {}): NearProject[] {
  const k = knownNow();
  const profile = k?.profiles.get(projectId);
  if (!k || !profile) return [];
  // What its things are tied to, and how many of them are: more than one is the project's as much as theirs.
  const ties = new Map<string, number>();
  for (const key of profile.members) {
    if (!key.startsWith("e:")) continue;
    try {
      const c = connections(key.slice(2));
      for (const x of new Set([...c.out, ...c.in].map((y) => y.entity.id))) ties.set(`e:${x}`, (ties.get(`e:${x}`) ?? 0) + 1);
    } catch { /* gone */ }
  }
  const out: NearProject[] = [];
  for (const e of k.entries) {
    const key = e.doc.key;
    if (profile.members.has(key) || key === (profile.entity ? `e:${profile.entity.id}` : "")) continue;
    // Other projects are not things to put in it; a shortcut's own entry is its file, elsewhere.
    if (e.doc.kind === "project" || key.startsWith("file:s:")) continue;
    const score = closeTo(k, key, projectId);
    const words = k.words.get(key);
    const shared = profile.keywords.filter((w) => words?.has(w));
    const tied = ties.get(key) ?? 0;
    if (score > 0 || shared.length >= 3 || tied >= 2) out.push({ key, score: Math.round(score * 1000) / 1000, shared, ties: tied });
  }
  return out.sort((a, b) => b.ties - a.ties || b.shared.length - a.shared.length || b.score - a.score).slice(0, options.limit ?? 12);
}

export interface NearThing { project: string; name: string; score: number; shared: string[] }

/** The projects a thing might belong in, by its meaning-index key. */
export function projectsNear(key: string, options: { limit?: number } = {}): NearThing[] {
  const k = knownNow();
  const entry = k?.entries.find((e) => e.doc.key === key);
  if (!k || !entry) return [];
  const out: NearThing[] = [];
  const words = k.words.get(key);
  for (const profile of k.profiles.values()) {
    if (profile.members.has(key)) continue;
    const score = closeTo(k, key, profile.id);
    const shared = profile.keywords.filter((w) => words?.has(w));
    if (score > 0 || shared.length >= 3) out.push({ project: profile.id, name: profile.name, score: Math.round(score * 1000) / 1000, shared });
  }
  return out.sort((a, b) => b.shared.length - a.shared.length || b.score - a.score).slice(0, options.limit ?? 3);
}
