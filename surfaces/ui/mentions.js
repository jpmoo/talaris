// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore
//
// `@` everywhere text is written — a writing page, a canvas note, a task's
// title and notes: what the editor's picker (editor.js, `mentions`) asks of
// the core, through whichever page's door to it (`api(method, path, body)`).
//
// What it finds (`/mentionables`): the store's entities, and every project's
// writing pages and canvases — the current project's first. A page or a
// canvas becomes an entity when it is first linked (`/entities/place`).
// People are also found where the invitee picker finds them: the address
// books and everyone met in the calendars (`/people/find`, answered by the
// surfaces process, which holds the calendar). One who is not a person here
// yet is made on being chosen, by address — so never made twice.
//
// A mention clicked opens where it lives — a page or a canvas in its project
// (`openPlace`) — or else its card (peek.js), unless the page has its own way
// to open a thing (the Tasks panel opens a task in its editor).
//
// `opts`: {project: () => id, openPlace: ({kind, project, where}) => …, openPerson: (id) => …}. A
// page sets them once as `window.talarisMentionDefaults`, so a picker made
// without them (a canvas note, inside the drawer) still has them.

"use strict";

window.TalarisMentions = (api, open, opts) => {
  const o = () => opts || window.talarisMentionDefaults || {};
  const project = () => (o().project ? o().project() || "" : "");
  const WORD = { page: "page", canvas: "canvas" };
  return {
    async search(query) {
      let [found, people] = await Promise.all([
        api("GET", `/mentionables?q=${encodeURIComponent(query)}&project=${encodeURIComponent(project())}&limit=10`).catch(() => []),
        query.trim().length >= 2 ? api("GET", `/people/find?q=${encodeURIComponent(query.trim())}`).catch(() => []) : [],
      ]);
      const out = (found || []).map((f) => {
        const detail = WORD[f.kind] ? (f.here ? WORD[f.kind] : `${WORD[f.kind]} · ${f.projectName || "another project"}`) : undefined;
        if (f.id) return { id: f.id, title: f.title, kind: f.kind, detail };
        return {
          id: "", title: f.title, kind: f.kind, detail,
          make: async () => { const made = await api("POST", "/entities/place", { kind: f.kind, project: f.project, where: f.where, title: f.title }); return { id: made.id, title: f.title }; },
        };
      });
      // By name, or the address before its @: "sch" is Schutt, not everyone at a school district.
      const q = query.trim().toLowerCase();
      // An address book's "name" is sometimes just another address: then there is none.
      people = (people || []).map((p) => ({ email: p.email, name: p.name && !p.name.includes("@") ? p.name : "" }))
        .filter((p) => (p.name || "").toLowerCase().includes(q) || p.email.toLowerCase().split("@")[0].includes(q));
      if (!people.length) return out;
      const known = await api("POST", "/entities/people/known", { emails: people.map((p) => p.email) }).catch(() => ({}));
      const have = new Set(out.map((x) => x.id).filter(Boolean));
      // People first after the closest matches: a found person already here
      // joins as itself; one only in an address book, by name and address.
      const extra = [];
      for (const p of people) {
        const k = known[p.email.toLowerCase()];
        if (k) {
          if (!have.has(k.id)) { have.add(k.id); extra.push({ id: k.id, title: k.title, kind: "contact" }); }
          continue;
        }
        extra.push({
          id: "", title: p.name || p.email, kind: "contact", detail: p.name ? p.email : "address book",
          make: async () => { const made = await api("POST", "/entities/person", { email: p.email, name: p.name || undefined }); return { id: made.id, title: p.name || p.email }; },
        });
      }
      return [...out.slice(0, 4), ...extra, ...out.slice(4)].slice(0, 10);
    },
    async create(name, kind) {
      // A task is made as tasks are (its default status); the rest as entities of their role.
      const made = kind === "task"
        ? await api("POST", "/tasks", { title: name })
        : await api("POST", "/entities", { role: kind, properties: { title: name } });
      return { id: made.id, title: name };
    },
    async open(id) {
      if (open) { open(id); return; }
      const openPlace = o().openPlace;
      const place = openPlace ? await api("GET", `/entities/${encodeURIComponent(id)}/place`).catch(() => null) : null;
      if (place) openPlace(place);
      else if (window.Peek) Peek.show(id, api, { openPlace, openPerson: o().openPerson });
    },
  };
};
