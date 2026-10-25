// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore
//
// The sync, as a plan: given both sides as they are, the links between them
// and what each linked pair last agreed on (its `base`), what to write where,
// what to make, and what to ask. Pure — nothing here reads or writes either
// app — so it can be measured on made-up libraries (test/sync.test.mjs) and
// trusted on a real one.
//
// **Merge**: a slot changed on one side since the pair last agreed is carried
// to the other; changed on both, differently, it is put to the person. Made
// on one side, it is made on the other. **Replace**: one side wins — every
// linked pair made to match it, and what it has that the other lacks made
// there; what only the loser has is left alone (the binding has no way to
// delete, and a sync that cannot undo should not try).
//
// **The first time**, nothing is written until the person says so. Things
// are matched where that is certain (a project by its name, a person by an
// address, a task by its name within a matched project); where it is not,
// the person is asked whether two are the same; and the whole plan — how
// many matched, made each way — is put to them before it starts.

import { KINDS, ORDER, REFS, Side, collapser, merge } from "./sides.mjs";

const json = (v) => (v === null || v === undefined ? null : JSON.stringify(v));
const norm = (s) => String(s ?? "").trim().toLowerCase().replace(/\s+/g, " ");
const SLOT_WORDS = { title: "Name", body: "Description", email: "Email", phone: "Phone", organization: "Organization", role: "Role",
  start: "Starts", end: "Ends", due: "Due", location: "Where", attendees: "Who is invited", organizer: "Organizer", complete: "Done", status: "Status", project: "Project",
  files: "Attachments", tags: "Tags" };
const KIND_WORDS = { project: "project", contact: "person", task: "task", note: "note" };
/** The mark Talaris puts on its undated notes (notes.ts): the only notes of Talaris's this sync carries. */
const UNDATED = "talaris:undated";
/**
 * Each linked Talaris thing carries a way back to its Hermes Notes one: the
 * format's `url` for it, under this plugin's own key (unprefixed keys are the
 * format's), which Talaris shows as "Open in Hermes Notes". Not a slot — never
 * compared, never sent the other way.
 */
export const LINK = "hermes-sync:link";
const linkOf = (b) => (typeof b?.url === "string" && /^https?:\/\//.test(b.url) ? { url: b.url, label: "Hermes Notes" } : null);

/**
 * @param state    { started, links: [{ kind, t, h, base }], apart: [[t, h]], only: [id], mode }
 * @param T, H     envelopes read from Talaris and from Hermes
 * @param s        settings: { mode: "merge" | "hermes" | "talaris", kinds: { task, project, contact, note },
 *                   people: "known" | "everyone", notes: "all" | "tagged", noteTags: [tag] }
 * @param newId    a fresh id for something made in Hermes
 * @returns { writes: [{ side, op, id, type?, patch?, body?, link? }], ask: [decision], links, summary }
 */
export function plan(state, T, H, s, newId) {
  const t = new Side("Talaris", T), h = new Side("Hermes Notes", H);
  const links = state.links.map((l) => ({ ...l, base: { ...(l.base ?? {}) } }));
  const byT = new Map(links.map((l) => [l.t, l])), byH = new Map(links.map((l) => [l.h, l]));
  const apart = new Set((state.apart ?? []).map(([a, b]) => `${a}|${b}`));
  // Kept on one side only, by the person's choice: never carried again.
  const only = new Set(state.only ?? []);
  const writes = [], ask = [];
  const summary = { matched: 0, toHermes: 0, toTalaris: 0, carried: 0, conflicts: 0, gone: 0, left: 0 };
  const wanted = (k) => s.kinds?.[k] !== false && t.typeFor(k) && h.typeFor(k);

  // A reference compared as the Talaris id of what it points at; a Talaris id written as Hermes' and back.
  const keyT = (id) => (byT.has(id) ? id : null), keyH = (id) => byH.get(id)?.t ?? null;
  const idT = (key) => (byT.has(key) ? key : null), idH = (key) => byT.get(key)?.h ?? null;

  /** Whether a Talaris thing is one this sync carries at all: a note, only an undated one. */
  const carriesT = (o, kind) => {
    if (kind === "note" && o[UNDATED] !== true) return false;
    // Tagged mode is the same on both sides: a note takes part by wearing one of the tags.
    if (kind === "note" && s.notes === "tagged" && !(o.tags ?? []).some((tag) => (s.noteTags ?? []).includes(tag))) return false;
    return !(o.archived || o.stub || only.has(o.id));
  };
  /**
   * Whether a Hermes Notes thing is: a note, never the page for a day (its type
   * declares `journal` and it carries that day — the format's word for a daily
   * note), and in tagged mode only one wearing a tag named in the settings.
   */
  const carriesH = (o, kind) => {
    if (o.archived || o.stub || only.has(o.id)) return false;
    if (kind !== "note") return true;
    const day = h.types.get(o.type)?.profiles?.journal?.date;
    if (typeof day === "string" && o.properties?.[day]) return false;
    if (s.notes === "tagged") return (o.tags ?? []).some((tag) => (s.noteTags ?? []).includes(tag));
    return true;
  };

  /*
   * Statuses go by what they mean once every status on both sides has a
   * meaning — and until then are held, while whether a task is done still
   * goes across (`complete`). A meaning one side has and the other lacks is
   * put to the nearest both share, so the two compare equal rather than
   * trading it back and forth.
   */
  const byState = t.has("task", "status") && h.has("task", "status");
  if (byState) {
    const st = t.statuses("task"), sh = h.statuses("task");
    t.collapse = h.collapse = collapser(new Set(Object.values(st.states)), new Set(Object.values(sh.states)));
  }
  const held = byState ? null : { talaris: t.statuses("task")?.unmapped ?? [], hermes: h.statuses("task")?.unmapped ?? [] };

  // Files only when both sides offer them by hash (`attachment-files` in each one's manifest): otherwise they cannot be handed over.
  const slotsOf = (kind) => KINDS[kind].filter((slot) => (slot !== "files" || s.files) && (slot === "status" ? byState : slot === "complete" ? !byState : true)
    && (slot === "status" || (t.has(kind, slot) && h.has(kind, slot))));
  const valuesT = (o, kind) => Object.fromEntries(slotsOf(kind).map((slot) => [slot, json(t.value(o, kind, slot, keyT))]));
  const valuesH = (o, kind) => Object.fromEntries(slotsOf(kind).map((slot) => [slot, json(h.value(o, kind, slot, keyH))]));

  /** A write making `to` hold the given slots from `fromSide`'s object. */
  const carry = (toSide, toObj, kind, fromSide, fromObj, slots) => merge(slots.map((slot) => {
    const key = fromSide === t ? keyT : keyH;
    const value = fromSide.value(fromObj, kind, slot, key);
    const raw = fromSide.raw(fromObj, kind, slot);
    return toSide.write(toObj, kind, slot, value, raw, toSide === t ? idT : idH);
  }));

  /** Making on the other side a thing it lacks: its type, and every slot carried. */
  const make = (toSide, kind, fromSide, fromObj, id) => {
    const type = toSide.typeFor(kind);
    const p = carry(toSide, null, kind, fromSide, fromObj, slotsOf(kind));
    // A note made in Hermes Notes, in tagged mode, wears the first tag named — or it would not come back next time.
    const tags = [...new Set([...(p.tags ?? []), ...(kind === "note" && toSide === h && s.notes === "tagged" && s.noteTags?.length ? [s.noteTags[0]] : [])])];
    return { side: toSide === t ? "talaris" : "hermes", op: "put", id,
      body: { type: type.id, properties: p.set ?? {}, ...(p.content !== undefined ? { content: p.content } : {}), ...(tags.length ? { tags } : {}) },
      ...(p.files ? { files: p.files } : {}) };
  };

  // ------------------------------------------------------------ the first time: matching

  if (!state.started) {
    for (const kind of ORDER) {
      if (!wanted(kind)) continue;
      const ts = [...t.objects.values()].filter((o) => t.kindOf(o) === kind && carriesT(o, kind) && !byT.has(o.id));
      const hs = [...h.objects.values()].filter((o) => h.kindOf(o) === kind && carriesH(o, kind) && !byH.has(o.id));
      const taken = new Set();
      for (const a of ts) {
        // Certain: the same address, or the same name where names are how the thing is known.
        const sure = hs.filter((b) => !taken.has(b.id) && !apart.has(`${a.id}|${b.id}`) && same(kind, a, b));
        const maybe = hs.filter((b) => !taken.has(b.id) && !apart.has(`${a.id}|${b.id}`) && !sure.includes(b) && kind !== "project" && norm(t.raw(a, kind, "title")) === norm(h.raw(b, kind, "title")));
        if (sure.length === 1) {
          taken.add(sure[0].id);
          const l = { kind, t: a.id, h: sure[0].id, base: {} };
          links.push(l); byT.set(l.t, l); byH.set(l.h, l);
          summary.matched++;
        } else if (sure.length + maybe.length >= 1) {
          for (const b of [...sure, ...maybe].slice(0, 3)) {
            ask.push({
              id: `same:${kind}:${a.id}:${b.id}`,
              title: `The same ${KIND_WORDS[kind]}? ${t.raw(a, kind, "title") ?? "Untitled"}`,
              sides: ["Talaris", "Hermes Notes"],
              fields: slotsOf(kind).map((slot) => ({ label: SLOT_WORDS[slot], here: t.shown(a, kind, slot), there: h.shown(b, kind, slot) })),
              choices: [{ key: "same", label: "The same" }, { key: "apart", label: "Not the same" }],
            });
          }
        }
      }
    }
    // The plan, put to the person, once what is unsure has been decided.
    if (!ask.length) {
      summary.matched = links.filter((l) => wanted(l.kind)).length;
      for (const kind of ORDER) {
        if (!wanted(kind)) continue;
        for (const o of t.objects.values()) if (t.kindOf(o) === kind && carriesT(o, kind) && !byT.has(o.id) && toHermesAllowed(kind, s)) summary.toHermes++;
        for (const o of h.objects.values()) if (h.kindOf(o) === kind && carriesH(o, kind) && !byH.has(o.id) && s.mode !== "talaris") summary.toTalaris++;
      }
      const mode = s.mode === "hermes" ? "Hermes Notes replaces what Talaris has, for the pairs matched"
        : s.mode === "talaris" ? "Talaris replaces what Hermes Notes has, for the pairs matched" : "Merged: a difference between matched pairs is put to you";
      ask.push({
        id: "start",
        title: "The first sync with Hermes Notes",
        detail: `${summary.matched} matched. ${summary.toHermes} to make in Hermes Notes, ${summary.toTalaris} to make in Talaris. ${mode}. Nothing is deleted on either side.`,
        choices: [{ key: "start", label: "Start" }, { key: "later", label: "Not yet" }],
      });
    }
    return { writes: [], ask, links, summary, held };
  }

  // ------------------------------------------------------------ every time after

  const winner = s.mode === "hermes" ? "hermes" : s.mode === "talaris" ? "talaris" : null;
  for (const kind of ORDER) {
    if (!wanted(kind)) continue;
    const slots = slotsOf(kind);

    // Linked pairs.
    for (const l of links.filter((x) => x.kind === kind)) {
      const a = t.objects.get(l.t), b = h.objects.get(l.h);
      if (!a || !b) {
        // Gone from one side, deleted there: never made again without asking, and never deleted here.
        if (!a && !b) { l.gone = true; continue; }
        summary.gone++;
        const left = a ? t : h, there = a ? "Hermes Notes" : "Talaris", here = a ? "Talaris" : "Hermes Notes", o = a ?? b;
        ask.push({
          id: `gone:${kind}:${a ? l.t : l.h}`,
          title: `Deleted in ${there}: ${KIND_WORDS[kind]} “${left.raw(o, kind, "title") ?? "Untitled"}”`,
          detail: `It is still in ${here}. The sync cannot delete it there — delete it yourself if it should go.`,
          choices: [{ key: "here", label: `Keep it in ${here} only` }, { key: "again", label: `Make it again in ${there}` }],
        });
        continue;
      }
      if (a.archived || b.archived || a.stub) continue;
      const tv = valuesT(a, kind), hv = valuesH(b, kind);
      const toH = [], toT = [];
      for (const slot of slots) {
        const x = tv[slot], y = hv[slot], base = l.base[slot];
        if (x === y) {
          l.base[slot] = x;
          // Done-ness kept agreed too while statuses go by meaning, should they ever be held again.
          if (slot === "status" && x !== null) l.base.complete = json(["done", "cancelled", "finished"].includes(JSON.parse(x)));
          if (l.pick) delete l.pick[slot];
          continue;
        }
        // The person chose, for this one: that side's value is carried, once.
        const picked = l.pick?.[slot];
        if (picked) { (picked === "talaris" ? toH : toT).push(slot); delete l.pick[slot]; continue; }
        const side = winner;
        if (side === "talaris") { toH.push(slot); continue; }
        if (side === "hermes") { toT.push(slot); continue; }
        if (slot === "status" && base === undefined && statusSettled(l, x, y, toH, toT)) continue;
        if (base !== undefined && x === base) toT.push(slot);
        else if (base !== undefined && y === base) toH.push(slot);
        // Never agreed yet (matched on the first sync), and one side simply empty: filled, not asked.
        else if (base === undefined && x === null) toT.push(slot);
        else if (base === undefined && y === null) toH.push(slot);
        else {
          summary.conflicts++;
          ask.push({
            id: `conflict:${l.t}:${slot}`,
            title: `${KIND_WORDS[kind][0].toUpperCase()}${KIND_WORDS[kind].slice(1)} “${t.raw(a, kind, "title") ?? h.raw(b, kind, "title") ?? "Untitled"}” — ${SLOT_WORDS[slot]}`,
            detail: base === undefined ? "Matched on the first sync, and different on each side." : "Changed on both sides since they last agreed.",
            sides: ["Talaris", "Hermes Notes"],
            fields: [{ label: SLOT_WORDS[slot], here: t.shown(a, kind, slot), there: h.shown(b, kind, slot) }],
            choices: [{ key: "talaris", label: "Keep Talaris's" }, { key: "hermes", label: "Keep Hermes Notes'" }],
          });
        }
      }
      if (toH.length) {
        const { files, ...patch } = carry(h, b, kind, t, a, toH);
        if (patch.set || patch.unset || patch.content !== undefined || patch.addTags || patch.removeTags) writes.push({ side: "hermes", op: "patch", id: b.id, patch: { ...patch, version: b.version }, ...(files ? { files } : {}), link: l, slots: toH, values: tv });
        summary.carried += toH.length;
      }
      // Its way back to Hermes Notes, written with whatever else goes to it, or alone.
      const back = linkOf(b);
      const backChanged = back && json(a.properties?.[LINK]) !== json(back);
      if (toT.length || backChanged) {
        const { files, ...patch } = carry(t, a, kind, h, b, toT);
        if (backChanged) patch.set = { ...(patch.set ?? {}), [LINK]: back };
        if (patch.set || patch.unset || patch.content !== undefined || patch.addTags || patch.removeTags) writes.push({ side: "talaris", op: "patch", id: a.id, patch: { ...patch, version: a.version }, ...(files ? { files } : {}), link: l, slots: toT, values: hv });
        summary.carried += toT.length;
      }
    }

    // Made on one side only: made on the other (in Replace, only the winner's).
    if (winner !== "hermes") {
      for (const a of t.objects.values()) {
        if (t.kindOf(a) !== kind || !carriesT(a, kind) || byT.has(a.id) || !toHermesAllowed(kind, s)) continue;
        const id = newId();
        const l = { kind, t: a.id, h: id, base: {}, made: "hermes" };
        links.push(l); byT.set(l.t, l); byH.set(l.h, l);
        writes.push({ ...make(h, kind, t, a, id), link: l, values: valuesT(a, kind) });
        summary.toHermes++;
      }
    } else for (const a of t.objects.values()) if (t.kindOf(a) === kind && carriesT(a, kind) && !byT.has(a.id)) summary.left++;
    if (winner !== "talaris") {
      for (const b of h.objects.values()) {
        if (h.kindOf(b) !== kind || !carriesH(b, kind) || byH.has(b.id)) continue;
        // Made in Talaris at Hermes' own id: the same id on both sides, for anyone reading either.
        const l = { kind, t: b.id, h: b.id, base: {}, made: "talaris" };
        links.push(l); byT.set(l.t, l); byH.set(l.h, l);
        const w = { ...make(t, kind, h, b, b.id), link: l, values: valuesH(b, kind) };
        if (linkOf(b)) w.body.properties[LINK] = linkOf(b);
        writes.push(w);
        summary.toTalaris++;
      }
    } else for (const b of h.objects.values()) if (h.kindOf(b) === kind && carriesH(b, kind) && !byH.has(b.id)) summary.left++;
  }
  return { writes, ask, links: links.filter((l) => !l.gone), summary, held };

  /**
   * The first time a pair's statuses are compared by meaning, after only
   * done-or-not went across: the side whose done-ness changed since they
   * agreed on it is the one that moved; where neither did, the plainer
   * meaning (not started, done) gave way to the more particular one, which
   * is what the other side could not say before. Otherwise asked.
   */
  function statusSettled(l, x, y, toH, toT) {
    const was = l.base.complete;
    const fin = (v) => { const st = JSON.parse(v ?? "null"); return st === null ? null : st === "finished" || st === "done" || st === "cancelled"; };
    const fx = fin(x), fy = fin(y);
    if (fx === null || fy === null) return false;
    if (was !== undefined && fx !== fy) {
      const before = JSON.parse(was);
      if (fx === before) { toT.push("status"); return true; }
      if (fy === before) { toH.push("status"); return true; }
      return false;
    }
    if (fx !== fy) return false;
    const plain = (v) => ["not-started", "done", "open", "finished"].includes(JSON.parse(v));
    if (plain(x) && !plain(y)) { toT.push("status"); return true; }
    if (plain(y) && !plain(x)) { toH.push("status"); return true; }
    return false;
  }

  /** Certain enough to match without asking. */
  function same(kind, a, b) {
    if (kind === "contact") {
      const ea = t.value(a, kind, "email", keyT) ?? [], eb = h.value(b, kind, "email", keyH) ?? [];
      return ea.some((x) => eb.includes(x));
    }
    const ta = norm(t.raw(a, kind, "title")), tb = norm(h.raw(b, kind, "title"));
    if (!ta || ta !== tb) return false;
    if (kind === "project") return true;
    // A task: the same name within the same project (or both in none).
    if (kind === "task") return json(t.value(a, kind, "project", keyT)) === json(h.value(b, kind, "project", keyH));
    return false;
  }
}

/** People go to Hermes only when the setting says everyone: Talaris keeps whole address books. */
function toHermesAllowed(kind, s) {
  return kind !== "contact" || s.people === "everyone";
}

/** What a pair agrees on once a write has landed: the values carried, as the base. */
export function agreed(link, slots, values) {
  for (const slot of slots) link.base[slot] = values[slot];
}

export { REFS };
