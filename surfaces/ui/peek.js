// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore
//
// A peek at one thing — a mention clicked — and everything it touches, both
// ways: the people at an event, the notes and tasks a person turns up in.
// Each one there peeks in turn. A card over the page, gone on Escape or a
// press outside it. `onTask`, where the page has it, opens a task in place.

"use strict";

window.Peek = (() => {
  const KIND = { contact: "Person", event: "Event", task: "Task", note: "Note", project: "Project" };
  // A link read from the far end, in words: a person is invited to the event that lists them.
  const BACK = { mentions: "Mentioned in", attendees: "Invited to", organizer: "Organizer of", invitees: "Invited to", assignee: "Assigned", project: "In it" };
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

  async function show(id, api, opts = {}) {
    let got;
    try { got = await api("GET", `/entities/${encodeURIComponent(id)}`); } catch { return; }
    if (!card) {
      card = el("div", { class: "peek", role: "dialog" });
      document.body.append(card);
      addEventListener("keydown", esc, true);
      setTimeout(() => addEventListener("pointerdown", outside, true), 0);
    }
    const isTask = (got.kinds || []).includes("task");
    const groups = new Map();
    for (const c of got.out || []) { const k = c.name; groups.set(k, [...(groups.get(k) || []), c.entity]); }
    for (const c of got.in || []) { const k = BACK[c.name] || `${c.name} of`; groups.set(k, [...(groups.get(k) || []), c.entity]); }
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
      [...groups].map(([name, list]) => el("div", { class: "peek-group" },
        el("div", { class: "peek-label" }, `${name} · ${list.length}`),
        list.slice(0, 30).map((e) => el("button", { class: "peek-item", onclick: () => show(e.id, api, opts) },
          el("span", { class: "peek-k" }, kindOf(e.kinds)), e.title)))),
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
    .peek-k { min-width: 52px; }
  `;
  document.head.append(style);

  return { show, close };
})();
