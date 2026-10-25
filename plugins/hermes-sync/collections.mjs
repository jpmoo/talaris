// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore
//
// Collections, paired by the person: "this collection in Talaris is that one
// in Hermes Notes". Hermes Notes' is the definition — its name, its regions
// and what entering one does, its order, its rule — brought down and kept in
// step; Talaris runs the rule itself, live, once it is put into Talaris's own
// conditions. Where a rule cannot be (a search by meaning, a field no profile
// names), the collection holds what Hermes Notes says matches, kept in step.
// What sits in which region of a matrix goes both ways, by the region's name,
// which is the format's: `members[].region`.
//
// Pure: both sides' collections and types in, writes and questions out. Like
// sides.mjs it knows neither app's field names — a field is found by the
// profile slot that names it, a status by what it means.

/** The most columns a Talaris matrix draws. */
const MOST_COLUMNS = 6;
/** A Hermes Notes type, as a kind Talaris knows: the first profile it declares, in this order. */
const PROFILE_ORDER = ["task", "event", "project", "contact", "journal", "note"];
/** Hermes Notes' daily pages, in its rules: no real type, a marker (packages/shared, DAILY_NOTE_TYPE_ID). */
const DAILY = "da110000-0000-4000-8000-000000000000";
/** Profile entries that are not slots naming a field. */
const NOT_SLOTS = new Set(["completeValues", "states"]);

const json = (v) => JSON.stringify(v ?? null);
const slotKey = (spec) => (typeof spec === "string" ? spec : spec && typeof spec.field === "string" ? (spec.part ? `${spec.field}.${spec.part}` : spec.field) : null);

/** For one side's types: field key (dotted for a part) → the slots that name it, and slot → each type's field key. */
export function slotsOf(types) {
  const byKey = new Map();
  const bySlot = new Map();
  for (const t of types ?? []) {
    for (const [profile, map] of Object.entries(t.profiles ?? {})) {
      for (const [slot, spec] of Object.entries(map ?? {})) {
        if (NOT_SLOTS.has(slot)) continue;
        const key = slotKey(spec);
        if (!key) continue;
        const s = `${profile}.${slot}`;
        byKey.set(key, [...(byKey.get(key) ?? []), s]);
        bySlot.set(s, [...(bySlot.get(s) ?? []), { type: t.id, key }]);
      }
    }
  }
  return { byKey, bySlot };
}

/** A type's task statuses: value → meaning, and which are finished. */
const taskOf = (t) => t?.profiles?.task ?? null;
function statusesOf(types) {
  return (types ?? []).filter((t) => typeof taskOf(t)?.status === "string").map((t) => {
    const p = taskOf(t);
    const field = (t.fields ?? []).find((f) => f.key === p.status);
    return { type: t.id, key: p.status, options: field?.options ?? [], complete: p.completeValues ?? [], states: p.states ?? {} };
  });
}

/**
 * Hermes Notes' rule in Talaris's conditions, or why it cannot be. Every
 * condition is translated or the whole rule is not: a rule half-run would be
 * a different collection under the same name.
 */
export function translateRule(rule, H, T) {
  const why = [];
  const hs = slotsOf(H.types), ts = slotsOf(T.types);
  const hStatus = statusesOf(H.types), tStatus = statusesOf(T.types);
  const hTypes = new Map((H.types ?? []).map((t) => [t.id, t]));

  /** A Talaris condition on one slot's field, for every Talaris type that has it: one, or any of them. */
  const onSlot = (slot, make) => {
    const at = ts.bySlot.get(slot) ?? [];
    const keys = [...new Set(at.map((x) => x.key))];
    if (!keys.length) return null;
    if (keys.length === 1) return make(keys[0]);
    return { kind: "group", match: "any", items: at.map((x) => ({ kind: "group", match: "all", items: [{ kind: "type", typeId: x.type }, make(x.key)] })) };
  };

  /** A status, by its meaning; failing that, by whether it is finished. */
  const status = (c) => {
    if (c.op === "empty" || c.op === "notEmpty") return onSlot("task.status", (key) => ({ kind: "property", key, op: c.op }));
    if (c.op !== "eq" && c.op !== "neq") { why.push(`a status compared by ${c.op}`); return null; }
    const owner = hStatus.find((s) => s.options.includes(c.value)) ?? hStatus[0];
    const meaning = owner?.states?.[c.value];
    const same = meaning ? tStatus.flatMap((s) => Object.entries(s.states).filter(([, m]) => m === meaning).map(([v]) => ({ type: s.type, key: s.key, value: v }))) : [];
    if (same.length) {
      const one = (x) => ({ kind: "property", key: x.key, op: c.op, value: x.value });
      return same.length === 1 ? one(same[0]) : { kind: "group", match: c.op === "eq" ? "any" : "all", items: same.map(one) };
    }
    if (!owner) { why.push(`the status “${c.value}”`); return null; }
    const done = owner.complete.includes(c.value);
    return { kind: "state", value: (c.op === "eq") === done ? "complete" : "open" };
  };

  const one = (c) => {
    switch (c?.kind) {
      case "group": {
        const items = (c.items ?? []).map(one);
        return items.some((x) => x === null) ? null : { kind: "group", match: c.match === "any" ? "any" : "all", items };
      }
      case "blockType": {
        const t = hTypes.get(c.typeId);
        const profile = c.typeId === DAILY ? "journal" : PROFILE_ORDER.find((p) => t?.profiles?.[p]);
        if (!profile) { why.push(t ? `the type “${t.name}”, which says nothing about what it is to other apps` : "a type Hermes Notes no longer has"); return null; }
        return { kind: "profile", profile, ...(c.op === "isNot" ? { op: "isNot" } : {}) };
      }
      case "created": case "edited":
        return { kind: c.kind, op: c.op, date: c.date };
      case "tag":
        return { kind: "tag", tag: c.tag, ...(c.op === "exclude" ? { op: "exclude" } : {}) };
      case "text":
        return { kind: "text", value: c.value };
      case "hasAttachment":
        return { kind: "hasAttachment", has: Boolean(c.has) };
      case "property": {
        const slots = hs.byKey.get(c.key) ?? [];
        if (slots.includes("task.status")) return status(c);
        const slot = slots.find((s) => ts.bySlot.has(s));
        if (!slot) { why.push(`the field “${c.key}”, which no profile both apps share names`); return null; }
        return onSlot(slot, (key) => ({ kind: "property", key, op: c.op, ...(c.value !== undefined ? { value: c.value } : {}) }));
      }
      case "semantic":
        why.push(`a search by meaning (“${c.value}”)`);
        return null;
      default:
        why.push(`a condition Talaris does not know (${c?.kind})`);
        return null;
    }
  };
  const query = rule ? one(rule) : null;
  return query ? { query, why: [] } : { query: null, why: why.length ? why : ["no rule"] };
}

/** A sort key's field, through the profiles; null when the other side has no such field. */
function sortKey(by, hs, ts) {
  if (!by || by.meta) return by ?? null;
  const key = by.part ? `${by.field}.${by.part}` : by.field;
  const slot = (hs.byKey.get(key) ?? []).find((s) => ts.bySlot.has(s));
  if (!slot) return null;
  const k = ts.bySlot.get(slot)[0].key;
  const dot = k.indexOf(".");
  return dot > 0 ? { field: k.slice(0, dot), part: k.slice(dot + 1) } : { field: k };
}
export function translateOrder(order, H, T) {
  if (!order) return null;
  const hs = slotsOf(H.types), ts = slotsOf(T.types);
  const sort = (order.sort ?? []).map((s) => ({ ...s, by: sortKey(s.by, hs, ts) })).filter((s) => s.by);
  const groupBy = order.groupBy ? sortKey(order.groupBy, hs, ts) : null;
  const out = { ...(sort.length ? { sort } : {}), ...(groupBy ? { groupBy } : {}) };
  return Object.keys(out).length ? out : null;
}

/**
 * A matrix's regions as Talaris keeps them: the name and label as they are,
 * Hermes Notes' color, and what entering one does — its tag added (and taken
 * off on leaving, where it says so), its status set, by what that status
 * means. Hermes Notes leaves a region's tag out when it is the region's name
 * again, so a region with tag choices and no tag has its name for one.
 */
export function translateRegions(regions, H, T) {
  const hStatus = statusesOf(H.types), tStatus = statusesOf(T.types);
  const tTask = tStatus[0];
  const statusFor = (v) => {
    const owner = hStatus.find((s) => s.options.includes(v));
    if (!owner || !tTask) return null;
    const meaning = owner.states?.[v];
    const same = meaning && Object.entries(tTask.states).find(([, m]) => m === meaning);
    if (same) return same[0];
    // No meaning to go by: as finished, or not.
    return owner.complete.includes(v) ? tTask.complete[0] ?? null : tTask.options.find((o) => !tTask.complete.includes(o)) ?? null;
  };
  return (regions ?? []).map((r) => {
    if (typeof r === "string") return { name: r, label: r };
    const out = { name: r.name, label: r.label ?? r.name };
    if (typeof r["hermes:color"] === "string" && r["hermes:color"]) out["talaris:color"] = r["hermes:color"];
    const chose = "hermes:tagOnEnter" in r || "hermes:tagOffLeave" in r;
    const tag = String(r["hermes:tag"] ?? (chose ? r.name : "")).replace(/^#/, "").trim();
    const enter = {};
    if (tag && r["hermes:tagOnEnter"] !== false) {
      enter.tag = tag;
      if (r["hermes:tagOffLeave"]) enter.untagOnLeave = true;
    }
    const status = r["hermes:enterStatus"] ? statusFor(r["hermes:enterStatus"]) : null;
    if (status) enter.status = status;
    if (Object.keys(enter).length) out["talaris:enter"] = enter;
    return out;
  });
}

/**
 * What a Hermes Notes collection is in Talaris, or null where Talaris keeps
 * nothing like it. A Hermes Notes matrix is one of three things: a grid of
 * its own regions (a one-row one is a board in all but name) — a Talaris
 * matrix, as many columns to a row; one whose rule's cards are laid out by a
 * field, a column to each of its options — a Talaris board, bound to the
 * same field through the profiles; or one laid out by days, which Talaris
 * has nothing like.
 */
export function kindFor(hc, H, T) {
  if (["list", "table", "calendar"].includes(hc.kind)) return hc.kind;
  if (hc.kind !== "matrix") return null;
  const bind = hc.properties?.["hermes:matrix_bind_property"];
  if (!bind || hc.membership?.mode !== "query") return "matrix";
  if (String(bind).startsWith("@")) return null;
  return boardField(bind, H, T) ? "board" : null;
}
/** The Talaris field a Hermes Notes field is, through the profile slot naming both; null when none does. */
function boardField(key, H, T) {
  const hs = slotsOf(H.types), ts = slotsOf(T.types);
  const slot = (hs.byKey.get(key) ?? []).find((s) => ts.bySlot.has(s));
  return slot ? ts.bySlot.get(slot)[0].key : null;
}

/** What Talaris should hold for a Hermes Notes collection, and how its members are kept. */
export function definitionOf(hc, H, T) {
  const kind = kindFor(hc, H, T);
  const rule = hc.membership?.mode === "query" ? translateRule(hc.membership.query, H, T) : null;
  const how = hc.membership?.mode !== "query" ? "explicit" : rule.query ? "rule" : "members";
  const order = translateOrder(hc.order, H, T);
  const columns = Math.min(MOST_COLUMNS, Math.max(1, Number(hc.properties?.["hermes:matrix_cols"]) || 2));
  return {
    how,
    kind,
    why: rule?.why ?? [],
    body: {
      name: hc.name,
      ...(kind === "matrix" ? { placement: { semantic: true, regions: translateRegions(hc.placement?.regions, H, T), "talaris:columns": columns } } : {}),
      // A board's columns are its field's options: no regions of its own to keep.
      ...(kind === "board" ? { bind: boardField(hc.properties["hermes:matrix_bind_property"], H, T) } : {}),
      order,
      membership: how === "rule" ? { mode: "query", query: rule.query } : { mode: "explicit" },
    },
  };
}

/** Whether Talaris's collection already says what the definition says. */
function sameDefinition(tc, body) {
  const regions = (p) => json((p?.regions ?? []).map((r) => (typeof r === "string" ? { name: r, label: r } : r)));
  return tc.name === body.name
    && (body.placement === undefined || (regions(tc.placement) === regions(body.placement) && tc.placement?.["talaris:columns"] === body.placement["talaris:columns"]))
    && (body.bind === undefined || tc["talaris:bind"] === body.bind)
    && json(tc.order ?? null) === json(body.order ?? null)
    && (tc.membership?.mode ?? "explicit") === body.membership.mode
    && (body.membership.mode !== "query" || json(tc.membership?.query) === json(body.membership.query));
}

/** A Talaris collection's id for one brought down from Hermes Notes: the same one every time. */
export const talarisIdFor = (h) => `c_h${String(h).replace(/[^a-z0-9]/gi, "").slice(0, 16)}`;

/**
 * One pass over the paired collections.
 *
 * `state.collections`: { pairs: [{h, t, base: {members?: [hermes id], regions: {hermes id: region}}, pick?}], declined: [hermes id] }.
 * `links`: the object pairs (state.links), by which a member on one side is one on the other.
 * Answers the writes (definitions first, then members, then placements), the
 * questions, and what was said (a pair's other side gone, a rule kept by Hermes Notes).
 */
export function planCollections(cs, T, H, links, on = true, titles = new Map()) {
  const writes = [], ask = [], said = [];
  const tCols = new Map((T.collections ?? []).map((c) => [c.id, c]));
  const hCols = new Map((H.collections ?? []).filter((c) => !c.archived).map((c) => [c.id, c]));
  const h2t = new Map(links.map((l) => [l.h, l.t]));
  const t2h = new Map(links.map((l) => [l.t, l.h]));
  const pairs = [];

  for (const p of cs.pairs ?? []) {
    const tc = tCols.get(p.t), hc = hCols.get(p.h);
    // Deleted in Talaris: no longer synced, and not asked about again (Hermes Notes keeps its own).
    if (!tc) { cs.declined = [...new Set([...(cs.declined ?? []), p.h])]; said.push(`“${hc?.name ?? p.name ?? "A collection"}” was deleted in Talaris: no longer synced (Hermes Notes keeps its own)`); continue; }
    // Gone from Hermes Notes, or only read in part this time: a pair is let go only when the whole of Hermes Notes was read.
    if (!hc) {
      if (H.whole) { writes.push({ side: "talaris", op: "define", id: p.t, body: { synced: false } }); said.push(`“${tc.name}” is no longer in Hermes Notes: kept in Talaris, no longer synced`); continue; }
      pairs.push(p); continue;
    }
    pairs.push(p);
    if (!on) continue;
    const d = definitionOf(hc, H, T);
    p.name = hc.name;
    p.how = d.how;
    if (!sameDefinition(tc, d.body) || tc["talaris:syncedPlugin"] !== "hermes-sync") writes.push({ side: "talaris", op: "define", id: p.t, body: d.body });
    if (d.how === "members") said.push(`“${hc.name}”'s rule has ${d.why.join(", ")}, which Talaris cannot run: it holds what Hermes Notes says matches`);

    const tMembers = new Map((tc.members ?? []).map((m) => [m.object, m]));
    const hMembers = new Map((hc.members ?? []).map((m) => [m.object, m]));

    // Members, where they are kept by hand: Hermes Notes' answer brought down; or, both ways, each side's additions and removals.
    if (d.how === "members" || d.how === "explicit") {
      const hHave = new Set([...hMembers.keys()].filter((h) => h2t.has(h)));
      const tHave = new Set([...tMembers.keys()].filter((t) => t2h.has(t)).map((t) => t2h.get(t)));
      const base = new Set(p.base?.members ?? []);
      const want = new Set();
      for (const h of new Set([...hHave, ...tHave, ...base])) {
        const inH = hHave.has(h), inT = tHave.has(h), was = base.has(h);
        // Kept by Hermes Notes' rule: its answer is the membership.
        const keep = d.how === "members" ? inH : inH === inT ? inH : inH !== was ? inH : inT;
        if (keep) want.add(h);
        if (keep && !inT) writes.push({ side: "talaris", op: "member", verb: "PUT", coll: p.t, obj: h2t.get(h), body: {} });
        if (!keep && inT) writes.push({ side: "talaris", op: "member", verb: "DELETE", coll: p.t, obj: h2t.get(h), body: {} });
        if (keep && !inH && d.how === "explicit") writes.push({ side: "hermes", op: "member", verb: "PUT", coll: p.h, obj: h, body: {} });
        if (!keep && inH && d.how === "explicit") writes.push({ side: "hermes", op: "member", verb: "DELETE", coll: p.h, obj: h, body: {} });
      }
      p.base = { ...(p.base ?? {}), members: [...want] };
    }

    // Where each card sits on a matrix: both ways, against what the two last agreed on; both moved differently, asked.
    // (On a board, a card's column is its field's value, which goes across with the thing itself.)
    if (d.kind === "matrix") {
      const regions = { ...(p.base?.regions ?? {}) };
      const names = new Set((d.body.placement?.regions ?? []).map((r) => r.name));
      const objects = new Set([
        ...[...hMembers.keys()].filter((h) => h2t.has(h)),
        ...[...tMembers.keys()].filter((t) => t2h.has(t)).map((t) => t2h.get(t)),
        ...Object.keys(regions),
      ]);
      for (const h of objects) {
        const t = h2t.get(h);
        if (!t) { delete regions[h]; continue; }
        const hr = hMembers.get(h)?.region ?? "", tr = tMembers.get(t)?.region ?? "";
        const b = regions[h] ?? "";
        if (hr === tr) { if (hr) regions[h] = hr; else delete regions[h]; continue; }
        const picked = p.pick?.[h];
        let to;
        if (picked) to = picked === "hermes" ? hr : tr;
        else if (tr === b) to = hr;
        else if (hr === b) to = tr;
        else {
          const title = titles.get(h);
          const label = (r) => (d.body.placement?.regions ?? []).find((x) => x.name === r)?.label ?? (r || "no region");
          ask.push({ id: `place:${p.h}:${h}`, on: "tasks", group: "cards moved on both sides", prompt: "Choose where each goes.",
            title: `${title ? `“${title}”` : "A card"} in ${hc.name}`,
            choices: [{ key: "hermes", label: `${label(hr)} (Hermes Notes)` }, { key: "talaris", label: `${label(tr)} (Talaris)` }] });
          continue;
        }
        if (to && !names.has(to)) continue;
        // Taken out of every region: a rule's matrix lets the card go back to its drawer; a kept one keeps it, nowhere in particular.
        if (to !== tr) writes.push({ side: "talaris", op: "place", coll: p.t, obj: t, region: to || null, ruled: d.how === "rule" });
        if (to !== hr) writes.push({ side: "hermes", op: "place", coll: p.h, obj: h, region: to || null, ruled: hc.membership?.mode === "query" });
        if (to) regions[h] = to; else delete regions[h];
        if (p.pick) delete p.pick[h];
      }
      p.base = { ...(p.base ?? {}), regions };
    }
  }
  cs.pairs = pairs;

  // Hermes Notes' collections not yet paired or declined: asked about, one by one.
  if (on && H.whole) {
    const paired = new Set(pairs.map((p) => p.h));
    const taken = new Set(pairs.map((p) => p.t));
    for (const hc of hCols.values()) {
      const kind = kindFor(hc, H, T);
      if (!kind || paired.has(hc.id) || (cs.declined ?? []).includes(hc.id)) continue;
      const mates = [...tCols.values()].filter((c) => c.kind === kind && !taken.has(c.id) && !c.archived && !c["talaris:syncedPlugin"]).slice(0, 9);
      ask.push({ id: `coll:${hc.id}`, on: "tasks", group: "eligible collections", prompt: "Choose which to sync.",
        title: `${hc.name} · ${kind}`,
        choices: [{ key: "bring", label: "Bring it down" }, ...mates.map((c) => ({ key: `t=${c.id}`, label: `Match “${c.name}”` })), { key: "no", label: "Don't sync" }] });
    }
  }
  return { writes, ask, said };
}

/** A collection brought down: made at its own id in Talaris, with the definition; then paired. */
export function bringDown(hc, H, T) {
  const d = definitionOf(hc, H, T);
  return { id: talarisIdFor(hc.id), body: { id: talarisIdFor(hc.id), kind: d.kind, ...d.body, "hermes-sync:source": hc.id } };
}
