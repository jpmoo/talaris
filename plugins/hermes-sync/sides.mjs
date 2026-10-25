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
  project: ["title", "body", "files"],
  contact: ["title", "email", "phone", "organization", "role", "body", "files"],
  task: ["title", "complete", "start", "due", "project", "files"],
  note: ["title", "body", "files"],
};
/** The slots that point at other things, and what they point at. */
export const REFS = { task: { project: "project" } };
/** In order: what is pointed at is made before what points at it. */
export const ORDER = ["project", "contact", "task", "note"];
const DATES = new Set(["start", "end", "due"]);

const field = (type, key) => (type.fields ?? []).find((f) => f.key === key);
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
  }

  /** The kind an object is (of those that sync), by its type's profiles. */
  kindOf(o) {
    const profiles = this.types.get(o?.type)?.profiles ?? {};
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
    const map = t.profiles[kind];
    if (slot === "files") return Boolean(filesField(t));
    return slot === "complete" ? Boolean(map.status) : map[slot] !== undefined && map[slot] !== null;
  }

  /** One slot's raw value, through the profile. */
  raw(o, kind, slot) {
    const type = this.types.get(o.type);
    const map = type?.profiles?.[kind];
    if (!map) return null;
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
    const spec = map[slot];
    if (spec === undefined || spec === null) return null;
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
    // Files compare as which files, by hash: a file renamed on one side is the same file.
    if (slot === "files") return [...new Set(v.map((a) => a.sha256))].sort();
    if (REFS[kind]?.[slot]) {
      const ids = (Array.isArray(v) ? v : [v]).map(String).map(key).filter(Boolean).sort();
      return ids.length ? ids : null;
    }
    if (DATES.has(slot)) return sameTime(v);
    if (slot === "email" || slot === "phone") {
      const list = (Array.isArray(v) ? v : [v]).map((x) => String(x).trim()).filter(Boolean);
      return list.length ? (slot === "email" ? list.map((x) => x.toLowerCase()) : list) : null;
    }
    // An organization kept as a thing of its own is not words to copy: left alone.
    if (slot === "organization" && field(this.types.get(o.type), this.types.get(o.type)?.profiles?.[kind]?.organization)?.kind === "reference") return null;
    return typeof v === "string" ? v : JSON.stringify(v);
  }

  /** The words a value is shown as, in a question put to the person. */
  shown(o, kind, slot) {
    const v = this.raw(o, kind, slot);
    if (v === null) return "—";
    if (slot === "complete") return v ? "done" : "not done";
    if (slot === "files") return v.map((a) => a.filename ?? a.sha256.slice(0, 8)).join(", ");
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
    const map = type?.profiles?.[kind];
    if (!map) return null;
    if (slot === "files") {
      // The field written whole — a file not named goes from this side too — and each file to be handed over first (`files`).
      const f = filesField(type);
      if (!f) return null;
      const list = (rawFrom ?? []).map(fileValue);
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
  let content, files = [];
  for (const p of patches) {
    if (!p) continue;
    Object.assign(set, p.set ?? {});
    for (const k of p.unset ?? []) unset.push(k);
    if (p.content !== undefined) content = p.content;
    if (p.files) files = files.concat(p.files);
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
    ...(content !== undefined ? { content } : {}), ...(files.length ? { files } : {}) };
}
