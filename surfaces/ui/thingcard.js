// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore
//
// A thing's card: a person, an organization, a task, an event, as it is shown
// everywhere — what it says, what it is tied to, what can be done with it, and
// what it might be tied to. One card, so the Library and a thing's own hub show
// the same. The page says how a thing named on it opens.

"use strict";

window.ThingCard = (() => {
  const enc = encodeURIComponent;
  function el(tag, attrs = {}, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
      else if (k === "class") e.className = v;
      else e.setAttribute(k, v);
    }
    for (const k of kids.flat()) if (k != null && k !== "" && k !== false) e.append(k);
    return e;
  }

  const CARD_GROUP = { contact: "People", organization: "Organizations", event: "Events", task: "Tasks", note: "Pages", project: "Projects" };
  const CARD_KIND = { contact: "A person", organization: "An organization", event: "An event", task: "A task", note: "A note", project: "A project" };
  const CARD_BACK = { organization: "member", parent: "includes", mentions: "mentioned in", attendees: "invited to", organizer: "organizer of", project: "filed here" };
  const CARD_OUT = { organization: "at", parent: "part of", mentions: "mentioned", attendees: "invited", organizer: "organizer", project: "project" };
  const fieldWords = (key) => String(key).replace(/_/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (c) => c.toUpperCase());
  const bareWords = (t) => String(t).replace(/\[@?([^\]]*)\]\(talaris:[^)]*\)/g, "$1");

  async function draw(id, { api, failed, say, open, bridge, types, kept, redraw }) {
    let got, entityTypes;
    try {
      [got, entityTypes] = await Promise.all([api("GET", `/entities/${enc(id)}?shown=1`), types() || api("GET", "/entity-types")]);
    } catch (e) { failed(e); return null; }
    kept(entityTypes);
    const o = got.entity, p = o.properties || {};
    const type = entityTypes.find((t) => t.id === o.type) || { fields: [], profiles: {} };
    const kinds = got.kinds || [];
    const titleKeys = new Set(Object.values(type.profiles || {}).map((m) => m && m.title));
    const nameOf = new Map([...(got.out || []), ...(got.in || [])].map((c) => [c.entity.id, c.entity.title]));
    const shownRefs = new Set();
    const toCard = (eid, title) => el("button", { class: "d-proj", title: "Open its card", onclick: () => open(`e:${eid}`) }, title || "Untitled");
    const lines = [];
    let words = "";
    const files = [];
    for (const f of type.fields) {
      const v = p[f.key];
      if (v === undefined || v === null || v === "" || titleKeys.has(f.key)) continue;
      const label = f["talaris:label"] || f.label || fieldWords(f.key);
      const list = Array.isArray(v) ? v : [v];
      if (f.kind === "reference") {
        const ids = list.filter((x) => typeof x === "string");
        ids.forEach((x) => shownRefs.add(x));
        lines.push([label, el("span", {}, ...ids.flatMap((x, i) => [i ? ", " : null, toCard(x, nameOf.get(x))]).filter(Boolean))]);
      } else if (f.kind === "richtext") words = words || String(v);
      else if (f.kind === "attachment") { if (f.many) files.push(...list.map((a) => a && a.filename).filter(Boolean)); }
      else if (f.kind === "datespan") lines.push([label, [v.start, v.end].filter(Boolean).join(" to ")]);
      else if (f.kind === "datetime") lines.push([label, Kit.stamp(String(v))]);
      else if (f.kind === "boolean") { if (v === true) lines.push([label, "Yes"]); }
      else if (f.kind === "enum") lines.push([label, (f["talaris:labels"] || {})[v] || String(v)]);
      else if (typeof v !== "object" || Array.isArray(v)) lines.push([label, list.join(", ")]);
    }
    // What it is tied to and not already named above, by what the other thing is.
    const hide = new Set(got.hidden || []);
    const tied = new Map();
    const touch = (e, how) => { if (e.id === id || hide.has(e.id) || shownRefs.has(e.id)) return; const had = tied.get(e.id); if (had) { if (!had.how.includes(how)) had.how.push(how); } else tied.set(e.id, { e, how: [how] }); };
    for (const c of got.out || []) touch(c.entity, CARD_OUT[c.name] || fieldWords(c.name).toLowerCase());
    for (const c of got.in || []) touch(c.entity, CARD_BACK[c.name] || `${fieldWords(c.name).toLowerCase()} of`);
    const groups = new Map();
    for (const r of tied.values()) { const g = CARD_GROUP[(r.e.kinds || []).find((k) => CARD_GROUP[k])] || "Other"; groups.set(g, [...(groups.get(g) || []), r]); }
    const acts = [];
    const act = (label, fn) => acts.push(el("button", { class: "t-btn small", onclick: fn }, label));
    if (kinds.includes("contact") || kinds.includes("organization")) act("Open in People", () => bridge.thing("person", id));
    else if (kinds.includes("task")) act("Open in Tasks", () => bridge.thing("task", id));
    else if (kinds.includes("event")) {
      const on = (o["talaris:sources"] || []).find((s) => s.kind === "eds-event");
      if (on) { const cut = on.key.indexOf("/"); act("Open in Calendar", () => bridge.openEvent(on.key.slice(0, cut), on.key.slice(cut + 1), String(p.start || ""))); }
    }
    if (window.Peek && bridge.glanceAt) acts.push(Peek.glanceButton(`e:${id}`, (k) => bridge.glanceAt(k), "t-btn small"));
    const sugg = window.Peek ? Peek.suggestions(`e:${id}`, api, {
      open: (eid) => open(`e:${eid}`),
      openPlace: (x) => open(`${x.kind}:${x.project}/${x.where}`),
      changed: (res) => { say(res.said || "Done"); if (redraw) redraw(); else open(`e:${id}`); },
    }) : null;
    return [
      el("h2", {}, got.title || "Untitled"),
      el("div", { class: "d-status" }, el("b", {}, CARD_KIND[kinds.find((k) => CARD_KIND[k])] || "A thing")),
      ...lines.map(([k, v]) => el("div", { class: "d-line" }, el("span", { class: "k" }, k), el("span", { class: "v" }, v))),
      words ? el("div", { class: "d-sub" }, "About it") : null,
      words ? el("div", { class: "d-said" }, bareWords(words)) : null,
      files.length ? el("div", { class: "d-sub" }, "Files") : null,
      files.length ? el("div", { class: "d-said" }, files.join(", ")) : null,
      ...[...groups.entries()].flatMap(([g, rs]) => [el("div", { class: "d-sub" }, g),
        ...rs.map((r) => el("button", { class: "on-item", onclick: () => open(`e:${r.e.id}`) }, r.e.title || "Untitled", el("span", { class: "kind" }, r.how.join(", "))))]),
      acts.length ? el("div", { class: "d-sub" }, "Do") : null,
      acts.length ? el("div", { class: "d-acts" }, ...acts) : null,
      sugg].filter(Boolean);
  }


  return { draw };
})();
