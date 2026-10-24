// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore
//
// `@` everywhere text is written — a writing page, a canvas note, a task's
// title and notes: what the editor's picker (editor.js, `mentions`) asks of
// the core, through whichever page's door to it (`api(method, path, body)`).
// A mention clicked opens the peek (peek.js), unless the page has its own way
// to open a thing (the Tasks panel opens a task in its editor).
//
// People are found where the invitee picker finds them too: the address books
// and everyone met in the calendars (`/people/find`, answered by the surfaces
// process, which holds the calendar). One who is not a person here yet is
// made on being chosen, by address — so the same person is never made twice.

"use strict";

window.TalarisMentions = (api, open) => ({
  async search(query) {
    let [found, people] = await Promise.all([
      api("GET", `/entities?q=${encodeURIComponent(query)}&limit=8&prefer=contact`).catch(() => []),
      query.trim().length >= 2 ? api("GET", `/people/find?q=${encodeURIComponent(query.trim())}`).catch(() => []) : [],
    ]);
    const out = (found || []).filter((f) => !f.stub).map((f) => ({ id: f.id, title: f.title, kind: f.kinds && f.kinds[0] }));
    // By name, or the address before its @: "sch" is Schutt, not everyone at a school district.
    const q = query.trim().toLowerCase();
    // An address book's "name" is sometimes just another address: then there is none.
    people = (people || []).map((p) => ({ email: p.email, name: p.name && !p.name.includes("@") ? p.name : "" })).filter((p) => (p.name || "").toLowerCase().includes(q) || p.email.toLowerCase().split("@")[0].includes(q));
    if (!people.length) return out;
    const known = await api("POST", "/entities/people/known", { emails: people.map((p) => p.email) }).catch(() => ({}));
    const have = new Set(out.map((o) => o.id));
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
  open(id) {
    if (open) open(id);
    else if (window.Peek) Peek.show(id, api);
  },
});
