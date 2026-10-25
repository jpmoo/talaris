// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore
//
// A peek at one thing — a mention clicked — and everything it touches, both
// ways: the people at an event, the notes and tasks a person turns up in.
// Each one there peeks in turn. A card over the page, gone on Escape or a
// press outside it. `onTask`, where the page has it, opens a task in place.
//
// Where the page can open a thing where it lives, it is not peeked at but
// opened: a person in People (`openPerson`), a task in Tasks (`openTask`), a
// calendar's event in the calendar (`openEvent`).

"use strict";

window.Peek = (() => {
  const KIND = { contact: "Person", event: "Event", task: "Task", note: "Note", project: "Project" };
  // A link read from the far end, in words: a person is invited to the event that lists them.
  const BACK = { mentions: "mentioned in", attendees: "invited to", organizer: "organizer of", invitees: "invited to", assignee: "assigned", project: "filed here" };
  // A link read from this end: an event's attendees are invited; what a page mentions is mentioned.
  const OUT = { mentions: "mentioned", attendees: "invited", organizer: "organizer", invitees: "invited", project: "project" };
  let card = null;

  function el(tag, attrs = {}, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
      else if (k === "class") e.className = v;
      else e.setAttribute(k, v);
    }
    for (const k of kids.flat()) if (k != null && k !== false) e.append(k);
    return e;
  }

  function close() {
    if (card) { card.remove(); card = null; }
    removeEventListener("keydown", esc, true);
    removeEventListener("pointerdown", outside, true);
  }
  function esc(e) { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); } }
  function outside(e) { if (card && !card.contains(e.target)) close(); }

  const kindOf = (kinds) => KIND[(kinds || []).find((k) => KIND[k])] || "Thing";
  // What a card's links are grouped by: what the other thing is.
  const GROUP = { contact: "People", event: "Events", task: "Tasks", note: "Notes", project: "Projects" };
  const words = (key) => String(key).replace(/_/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
  const FIRST = 20;

  /** One kind's rows: the newest twenty, then twenty more at a time, or all. */
  function group(name, rows, api, opts) {
    let shown = FIRST;
    const list = el("div", {});
    const more = el("div", { class: "peek-more" });
    const draw = () => {
      list.replaceChildren(...rows.slice(0, shown).map(({ e, how }) => el("button", { class: "peek-item", onclick: () => show(e.id, api, opts) },
        el("span", { class: "peek-t" }, e.title), el("span", { class: "peek-how" }, how.join(", ")))));
      const left = rows.length - shown;
      more.replaceChildren(...(left > 0 ? [
        el("button", { class: "t-btn", onclick: () => { shown += FIRST; draw(); } }, `${Math.min(FIRST, left)} more`),
        left > FIRST ? el("button", { class: "t-btn", onclick: () => { shown = rows.length; draw(); } }, `All ${rows.length}`) : null,
      ] : []).filter(Boolean));
    };
    draw();
    return el("div", { class: "peek-group" }, el("div", { class: "peek-label" }, `${name} · ${rows.length}`), list, more);
  }

  async function show(id, api, opts = {}) {
    let got;
    try { got = await api("GET", `/entities/${encodeURIComponent(id)}`); } catch { return; }
    if (!card) {
      card = el("div", { class: "peek", role: "dialog" });
      document.body.append(card);
      addEventListener("keydown", esc, true);
      setTimeout(() => addEventListener("pointerdown", outside, true), 0);
    }
    // A person is not a card here but their entry in People, where the page can open it.
    if (opts.openPerson && (got.kinds || []).includes("contact")) {
      close();
      opts.openPerson(id);
      return;
    }
    // Nor a task, in Tasks.
    if (opts.openTask && (got.kinds || []).includes("task")) {
      close();
      opts.openTask(id);
      return;
    }
    // Nor an event that is on a calendar, in the calendar on its day. One made
    // only here is on none, and is a card.
    const onCalendar = (got.entity["talaris:sources"] || []).find((s) => s.kind === "eds-event");
    if (opts.openEvent && onCalendar && (got.kinds || []).includes("event")) {
      const at = onCalendar.key.indexOf("/");
      close();
      opts.openEvent(onCalendar.key.slice(0, at), onCalendar.key.slice(at + 1), String((got.entity.properties || {}).start || ""));
      return;
    }
    const isTask = (got.kinds || []).includes("task");
    // A page's or a canvas's entity: opened where it is, when the page can say where.
    const place = opts.openPlace ? await api("GET", `/entities/${encodeURIComponent(id)}/place`).catch(() => null) : null;
    // Everything it touches, either way, once each — grouped by what it is
    // (people, events, notes…), newest first, each saying how it is linked.
    const byId = new Map();
    const touch = (e, how) => {
      const had = byId.get(e.id);
      if (had) { if (!had.how.includes(how)) had.how.push(how); return; }
      byId.set(e.id, { e, how: [how] });
    };
    for (const c of got.out || []) touch(c.entity, OUT[c.name] || words(c.name));
    for (const c of got.in || []) touch(c.entity, BACK[c.name] || `${words(c.name)} of`);
    const groups = new Map();
    for (const row of byId.values()) {
      const g = GROUP[(row.e.kinds || []).find((k) => GROUP[k])] || "Other";
      groups.set(g, [...(groups.get(g) || []), row]);
    }
    for (const rows of groups.values()) rows.sort((a, b) => String(b.e.updated || "").localeCompare(String(a.e.updated || "")));
    const order = [...new Set(Object.values(GROUP)), "Other"].filter((g) => groups.has(g));
    const props = got.entity.properties || {};
    const note = typeof props.notes === "string" ? props.notes : typeof props.description === "string" ? props.description : "";
    // Flattened: replaceChildren takes nodes, and would write an array of groups out as text.
    card.replaceChildren(...[
      el("div", { class: "peek-head" },
        el("span", { class: "peek-kind" }, kindOf(got.kinds)),
        el("span", { class: "peek-title" }, got.title),
        el("button", { class: "icon-btn", title: "Close", onclick: close }, "×")),
      Array.isArray(props.emails) && props.emails.length ? el("div", { class: "peek-line" }, props.emails.join(", ")) : null,
      note ? el("div", { class: "peek-note" }, note.replace(/\[([^\]\n]*)\]\(talaris:[A-Za-z0-9_]+\)/g, "$1").slice(0, 300)) : null,
      isTask && opts.onTask ? el("button", { class: "t-btn", onclick: () => { close(); opts.onTask(id); } }, "Open task") : null,
      place ? el("button", { class: "t-btn", onclick: () => { close(); opts.openPlace(place); } }, place.kind === "page" ? "Open page" : "Open canvas") : null,
      order.map((name) => group(name, groups.get(name), api, opts)),
      groups.size ? null : el("div", { class: "peek-line" }, "Nothing connected yet"),
    ].flat().filter((x) => x != null));
  }

  const style = document.createElement("style");
  style.textContent = `
    .peek { position: fixed; z-index: 80; top: 12%; left: 50%; transform: translateX(-50%); width: min(420px, calc(100% - 32px)); max-height: 72%; overflow: auto;
      background: var(--surface); border: 1px solid var(--frame); border-radius: 12px; box-shadow: var(--menu-shadow); padding: 12px 14px; font-size: 12.5px; color: var(--text); }
    .peek-head { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
    .peek-kind, .peek-k { font-size: 10px; letter-spacing: 1px; text-transform: uppercase; color: var(--muted); }
    .peek-title { flex: 1; font-size: 14px; }
    .peek-line { color: var(--muted); margin: 4px 0; }
    .peek-note { margin: 6px 0; white-space: pre-wrap; }
    .peek-group { margin-top: 10px; }
    .peek-label { font-size: 10px; letter-spacing: 1px; text-transform: uppercase; color: var(--muted); margin-bottom: 4px; }
    .peek-item { display: flex; gap: 8px; align-items: baseline; width: 100%; text-align: left; background: none; border: 0; border-radius: 6px; padding: 3px 6px; color: var(--text); cursor: pointer; font: inherit; }
    .peek-item:hover { background: var(--accent-wash); color: var(--accent); }
    .peek-t { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .peek-how { color: var(--muted); font-size: 11px; white-space: nowrap; }
    .peek-item:hover .peek-how { color: inherit; }
    .peek-more { display: flex; gap: 6px; margin-top: 4px; }
    .peek-more:empty { display: none; }
    .peek-more .t-btn { font-size: 11.5px; padding: 1px 9px; }
  `;
  document.head.append(style);

  return { show, close };
})();
