// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore
//
// One side of a sync, read and written through pkm-interchange profiles only.
// Nothing here knows what either app calls a field or a type: a task is a
// type that declares `task`, its due date is wherever that profile says, and
// what a side does not declare it does not have. That is the format's whole
// promise, and the reason this plugin can work against two apps that have
// never heard of each other.

/** What syncs, by kind: the slots compared and carried, in the format's words. */
export const KINDS = {
  project: ["title", "body", "files", "tags"],
  contact: ["title", "email", "phone", "organization", "role", "body", "files", "tags"],
  task: ["title", "status", "complete", "start", "due", "project", "files", "tags"],
  note: ["title", "body", "files", "tags"],
  // The page for a day: known by its date, which is its identity on both sides; its words are the note's.
  journal: ["date", "body", "files", "tags"],
};
/** The slots that point at other things, and what they point at. */
export const REFS = { task: { project: "project" } };
/** In order: what is pointed at is made before what points at it. */
export const ORDER = ["project", "contact", "task", "journal", "note"];
const DATES = new Set(["start", "end", "due"]);

/**
 * What a status means, in the format's five words (the task profile's
 * `states`), and which of them are finished. A side whose every status has
 * one can carry a task's status as its meaning; until both can, only whether
 * it is done goes across (`complete`), and the statuses wait.
 */
export const STATES = ["not-started", "in-progress", "waiting", "done", "cancelled"];
const FINISHED = new Set(["done", "cancelled"]);
/** A state one side has and the other does not, as the nearest the two share: the same finished-ness always. */
const NEAREST = { "not-started": ["in-progress", "waiting"], "in-progress": ["waiting", "not-started"], waiting: ["in-progress", "not-started"], done: ["cancelled"], cancelled: ["done"] };
/** The states both sides can say, and a state put into them; where they share none of its finished-ness, just that. */
export function collapser(a, b) {
  const shared = new Set([...a].filter((x) => b.has(x)));
  return (state) => {
    if (!state) return null;
    if (shared.has(state)) return state;
    const near = (NEAREST[state] ?? []).find((x) => shared.has(x));
    return near ?? (FINISHED.has(state) ? "finished" : "open");
  };
}

const field = (type, key) => (type.fields ?? []).find((f) => f.key === key);
/**
 * A type's map for a kind. A day's page is a note too, and its type says so
 * in two profiles — `journal` (its date) and `note` (its words): read as one.
 */
const profileOf = (type, kind) => {
  const p = type?.profiles;
  if (!p?.[kind]) return null;
  return kind === "journal" ? { ...(p.note ?? {}), ...p.journal } : p[kind];
};
/** The mark on a copy that came from Hermes Notes into Talaris (Talaris's links.ts reads it). */
export const ORIGIN = "hermes-sync:origin";
/**
 * Where a type keeps its files: the first field of the format's `attachment`
 * kind it declares. Not a profile slot — the format names none — and found by
 * the field's kind, never its name, the way Hermes' own exporter answers it.
 */
const filesField = (type) => (type?.fields ?? []).find((f) => f.kind === "attachment") ?? null;
/** One attachment value, as it travels in a write: which file, and its label — never the bytes, which go by hash. */
const fileValue = (a) => ({ kind: "attachment", filename: a.filename ?? "attachment", ...(a.mediaType ? { mediaType: a.mediaType } : {}), sha256: a.sha256 });
const blank = (v) => (v === "" || v === undefined ? null : v);

/** A date or time as one string to compare: to the minute, in UTC, where it can be read; as written where not. */
function sameTime(v) {
  if (v === null) return null;
  const s = String(v);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? s : d.toISOString().slice(0, 16);
}

export class Side {
  /**
   * @param name what the person calls it ("Talaris", "Hermes Notes")
   * @param env  an envelope read from it
   */
  constructor(name, env) {
    this.name = name;
    this.types = new Map((env.types ?? []).map((t) => [t.id, t]));
    this.objects = new Map((env.objects ?? []).map((o) => [o.id, o]));
    /** States as both sides can say them (`collapser`); set by the plan once it has read both. */
    this.collapse = (x) => x;
  }

  /** A kind's status options and what each means: `{ options, states, unmapped }`, or null when it has no status. */
  statuses(kind) {
    const t = this.typeFor(kind);
    const map = profileOf(t, kind);
    if (!map?.status) return null;
    const f = field(t, map.status);
    const options = f?.options ?? [];
    const states = map.states ?? {};
    const labels = f?.["talaris:labels"] ?? {};
    return { options, states, unmapped: options.filter((o) => !STATES.includes(states[o])).map((o) => labels[o] ?? o) };
  }

  /** What a task's status means, by its type's own `states`; null where it says nothing. */
  stateOf(o, kind) {
    const map = profileOf(this.types.get(o.type), kind);
    if (!map?.status) return null;
    const s = map.states?.[o.properties?.[map.status]];
    return STATES.includes(s) ? s : null;
  }

  /** The kind an object is (of those that sync), by its type's profiles. */
  kindOf(o) {
    const profiles = this.types.get(o?.type)?.profiles ?? {};
    // One type may hold notes and days alike (Hermes Notes' text type): a day is one carrying its date.
    const day = profiles.journal?.date;
    if (typeof day === "string") return o?.properties?.[day] ? "journal" : ORDER.filter((k) => k !== "journal").find((k) => k in profiles) ?? null;
    return ORDER.find((k) => k in profiles) ?? null;
  }

  /** The type this side makes a kind as: the first that declares it. */
  typeFor(kind) {
    for (const t of this.types.values()) if (t.profiles && kind in t.profiles) return t;
    return null;
  }

  /** Whether this side can say a slot at all, for a kind. */
  has(kind, slot) {
    const t = this.typeFor(kind);
    if (!t) return false;
    const map = profileOf(t, kind);
    if (slot === "files") return Boolean(filesField(t));
    // Tags are every object's in the format, not a profile slot.
    if (slot === "tags") return true;
    if (slot === "status") { const st = this.statuses(kind); return Boolean(st && st.options.length && !st.unmapped.length); }
    return slot === "complete" ? Boolean(map.status) : map[slot] !== undefined && map[slot] !== null;
  }

  /** One slot's raw value, through the profile. */
  raw(o, kind, slot) {
    const type = this.types.get(o.type);
    const map = profileOf(type, kind);
    if (!map) return null;
    if (slot === "tags") return o.tags?.length ? o.tags : null;
    if (slot === "files") {
      const f = filesField(type);
      if (!f) return null;
      const v = o.properties?.[f.key];
      const list = (Array.isArray(v) ? v : v ? [v] : []).filter((a) => a && a.kind === "attachment" && typeof a.sha256 === "string");
      return list.length ? list : null;
    }
    if (slot === "complete") {
      if (!map.status) return null;
      return (map.completeValues ?? []).includes(o.properties?.[map.status]);
    }
    if (slot === "status") return map.status ? blank(o.properties?.[map.status]) : null;
    const spec = map[slot];
    if (spec === undefined || spec === null) return null;
    // A day's page holding only what it was opened with — Hermes Notes' daily template, kept as its `seed` — has no words yet.
    if (slot === "body" && kind === "journal") {
      const words = spec === "content" ? o.content : typeof spec === "string" ? o.properties?.[spec] : null;
      const seed = o.properties?.seed;
      if (typeof seed === "string" && typeof words === "string" && words.trim() === seed.trim()) return null;
    }
    if (spec === "content") return blank(o.content);
    if (typeof spec === "string") return blank(o.properties?.[spec]);
    if (spec.field) {
      const v = o.properties?.[spec.field];
      return blank(spec.part ? v?.[spec.part] : v);
    }
    return null;
  }

  /**
   * One slot as a value to compare and carry: words as words, a list of
   * addresses as a list, a time to the minute, a completion as yes or no,
   * and a reference as the *other* thing's key in the sync (`key(id)`), so two
   * sides pointing at linked things compare equal.
   */
  value(o, kind, slot, key) {
    const v = this.raw(o, kind, slot);
    if (v === null) return null;
    if (slot === "complete") return v;
    // A status as what it means, put into the states both sides can say.
    if (slot === "status") return this.collapse(this.stateOf(o, kind));
    // Files compare as which files, by hash: a file renamed on one side is the same file.
    if (slot === "files") return [...new Set(v.map((a) => a.sha256))].sort();
    // Tags as a set: the order a side keeps them in is not a difference.
    if (slot === "tags") return [...new Set(v)].sort();
    if (REFS[kind]?.[slot]) {
      const ids = (Array.isArray(v) ? v : [v]).map(String).map(key).filter(Boolean).sort();
      return ids.length ? ids : null;
    }
    if (DATES.has(slot) || slot === "date") return sameTime(v);
    if (slot === "email" || slot === "phone") {
      const list = (Array.isArray(v) ? v : [v]).map((x) => String(x).trim()).filter(Boolean);
      return list.length ? (slot === "email" ? list.map((x) => x.toLowerCase()) : list) : null;
    }
    // An organization kept as a thing of its own is not words to copy: left alone.
    if (slot === "organization" && field(this.types.get(o.type), profileOf(this.types.get(o.type), kind)?.organization)?.kind === "reference") return null;
    return typeof v === "string" ? v : JSON.stringify(v);
  }

  /** The words a value is shown as, in a question put to the person. */
  shown(o, kind, slot) {
    const v = this.raw(o, kind, slot);
    if (v === null) return "—";
    if (slot === "complete") return v ? "done" : "not done";
    if (slot === "status") {
      const map = profileOf(this.types.get(o.type), kind);
      const label = field(this.types.get(o.type), map?.status)?.["talaris:labels"]?.[v] ?? v;
      const st = this.stateOf(o, kind);
      return st && st !== label ? `${label} (${st.replace("-", " ")})` : String(label);
    }
    if (slot === "files") return v.map((a) => a.filename ?? a.sha256.slice(0, 8)).join(", ");
    if (slot === "tags") return v.map((t) => `#${t}`).join(" ");
    if (Array.isArray(v)) return v.join(", ");
    return typeof v === "string" ? v : JSON.stringify(v);
  }

  /**
   * What to write so a slot holds a value — `{ set, unset }` in this side's
   * own field names. A time goes as the other side wrote it; a reference as
   * this side's ids for the things linked (`id(key)`), dropping what is not
   * linked yet; a completion as this side's own first finished value, or its
   * first unfinished one — unless it is already finished or not, when it is
   * left as it is ("in progress" is not undone by being "not done").
   */
  write(o, kind, slot, value, rawFrom, id) {
    const type = o ? this.types.get(o.type) : this.typeFor(kind);
    const map = profileOf(type, kind);
    if (!map) return null;
    if (slot === "tags") {
      // Named moves, as the format writes tags: a tag this side holds and the other never said is not removed by a whole list.
      const want = [...new Set(rawFrom ?? [])];
      if (!o) return want.length ? { tags: want } : null;
      const have = o.tags ?? [];
      const add = want.filter((t) => !have.includes(t)), remove = have.filter((t) => !want.includes(t));
      return add.length || remove.length ? { ...(add.length ? { addTags: add } : {}), ...(remove.length ? { removeTags: remove } : {}) } : null;
    }
    if (slot === "files") {
      // The field written whole — a file not named goes from this side too — and each file to be handed over first (`files`).
      const f = filesField(type);
      if (!f) return null;
      /*
       * Into Talaris, a file it did not have is marked as having come from
       * Hermes Notes (`hermes-sync:origin`): a copy with no file of anyone's
       * behind it, which Talaris warns about. A file it already had keeps the
       * mark it had — never given one it did not.
       */
      const had = new Map((Array.isArray(o?.properties?.[f.key]) ? o.properties[f.key] : o?.properties?.[f.key] ? [o.properties[f.key]] : [])
        .filter((a) => a && a.sha256).map((a) => [a.sha256, a]));
      const list = (rawFrom ?? []).map(fileValue).map((a) => {
        if (this.name !== "Talaris") return a;
        const before = had.get(a.sha256);
        return before ? (before[ORIGIN] ? { ...a, [ORIGIN]: before[ORIGIN] } : a) : { ...a, [ORIGIN]: "hermes" };
      });
      if (!list.length) return { unset: [f.key] };
      return { set: { [f.key]: f.many ? list : list[0] }, files: list };
    }
    if (slot === "complete") {
      if (!map.status || value === null) return null;
      const now = o ? (map.completeValues ?? []).includes(o.properties?.[map.status]) : null;
      if (now === value) return null;
      const options = field(type, map.status)?.options ?? [];
      const next = value ? (map.completeValues ?? [])[0] : options.find((x) => !(map.completeValues ?? []).includes(x));
      return next === undefined ? null : { set: { [map.status]: next } };
    }
    if (slot === "status") {
      // This side's own status meaning the same — the one it has, if it already does; else the first that does.
      if (!map.status || value === null) return null;
      const options = field(type, map.status)?.options ?? [];
      const means = (x) => this.collapse(STATES.includes(map.states?.[x]) ? map.states[x] : null);
      if (o && means(o.properties?.[map.status]) === value) return null;
      const next = options.find((x) => means(x) === value);
      return next === undefined ? null : { set: { [map.status]: next } };
    }
    const spec = map[slot];
    if (spec === undefined || spec === null) return null;
    // The body slot, as the format now lets a patch write it: beside `set`, removed by unset.
    if (spec === "content") return rawFrom === null || rawFrom === undefined ? { unset: ["content"] } : { content: String(rawFrom) };
    const key = typeof spec === "string" ? spec : spec.field;
    const def = field(type, key);
    let out = rawFrom;
    if (REFS[kind]?.[slot]) {
      const ids = (value ?? []).map(id).filter(Boolean);
      out = def?.many ? ids : ids[0] ?? null;
      if (Array.isArray(out) && !out.length) out = null;
    } else if ((slot === "email" || slot === "phone") && out !== null) {
      const list = Array.isArray(out) ? out : [out];
      out = def?.many ? list : list[0] ?? null;
    } else if (slot === "organization" && def?.kind === "reference") {
      return null;
    }
    if (typeof spec === "object" && spec.part) {
      // Half of a span: only this half's change, put together with the other half in `merge`.
      return { parts: { [key]: { base: o?.properties?.[key] ?? {}, changes: { [spec.part]: out } } } };
    }
    return out === null ? { unset: [key] } : { set: { [key]: out } };
  }
}

/** Patches for one object, merged: several slots into one write. */
export function merge(patches) {
  const set = {}, unset = [];
  const spans = {};
  let content, files = [], tags, addTags = [], removeTags = [];
  for (const p of patches) {
    if (!p) continue;
    Object.assign(set, p.set ?? {});
    for (const k of p.unset ?? []) unset.push(k);
    if (p.content !== undefined) content = p.content;
    if (p.files) files = files.concat(p.files);
    if (p.tags) tags = p.tags;
    if (p.addTags) addTags = addTags.concat(p.addTags);
    if (p.removeTags) removeTags = removeTags.concat(p.removeTags);
    // Halves of a span: each onto the span as it stands, together.
    for (const [k, { base, changes }] of Object.entries(p.parts ?? {})) {
      spans[k] ??= { ...(base ?? {}) };
      for (const [part, v] of Object.entries(changes)) {
        if (v === null) delete spans[k][part];
        else spans[k][part] = v;
      }
    }
  }
  for (const [k, whole] of Object.entries(spans)) {
    if (Object.keys(whole).length) set[k] = whole;
    else unset.push(k);
  }
  const gone = [...new Set(unset)].filter((k) => !(k in set) && !(k === "content" && content !== undefined));
  return { ...(Object.keys(set).length ? { set } : {}), ...(gone.length ? { unset: gone } : {}),
    ...(content !== undefined ? { content } : {}), ...(files.length ? { files } : {}),
    ...(tags ? { tags } : {}), ...(addTags.length ? { addTags } : {}), ...(removeTags.length ? { removeTags } : {}) };
}
