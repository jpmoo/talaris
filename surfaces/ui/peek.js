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
  const KIND = { contact: "Person", event: "Event", task: "Task", note: "Page", project: "Project" };
  // A page, a canvas or one of Morgan's threads by its glance key (`page:<project>/<path>`…), for one with no entity yet.
  const placeOfKey = (key) => {
    const m = /^(page|canvas|thread):([^/]+)\/(.+)$/.exec(String(key));
    return m ? { kind: m[1], project: m[2], where: m[3] } : null;
  };
  // What an entity standing for a place is: a canvas, or one of Morgan's threads (a page is a Page already).
  const PLACE = { canvas: "Canvas", thread: "Conversation" };
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

  /**
   * Where else a thing lives: a plugin that keeps it in step with another app
   * leaves a way back on it, as `<plugin>:link` = { url, label } (the Hermes
   * Notes sync does). Any such link is shown as "Open in <label>" — on this
   * card, in Tasks' editor, in a person's entry — opening in the browser.
   */
  function elsewhere(entity) {
    const out = [];
    for (const [k, v] of Object.entries((entity && entity.properties) || {})) {
      if (!/^[a-z0-9-]+:link$/.test(k) || !v || typeof v.url !== "string" || !/^https?:\/\//.test(v.url)) continue;
      out.push({ url: v.url, label: typeof v.label === "string" && v.label.trim() ? v.label.trim() : new URL(v.url).host });
    }
    return out;
  }
  /*
   * What plugins put on a sheet (`[[actions]]` in a plugin.toml, the core's
   * /plugins/actions): a button each — Sync now, from the Hermes Notes sync —
   * run with what it is on. Drawn into a holder at once and filled when the
   * core answers; a press under way is remembered by what it is on, so a
   * sheet drawn again meanwhile still says so.
   */
  const pressing = new Map(); // plugin/action/entity → what its button says while it runs, and a moment after
  // Or on a whole list (People's, Tasks'): with no thing, only the list's name for `kind`.
  const LISTS = ["people", "tasks", "notes", "daily"];
  /** `onChoose(button, said)`: the page's chooser, for what a press leaves to decide right there (a decision `on` this place). */
  function actionButtons(kind, entityId, api, cls = "t-btn", onDone = null, onChoose = null) {
    const holder = el("span", { class: "plugin-actions" });
    if ((!entityId && !LISTS.includes(kind)) || !api) return holder;
    api("GET", `/plugins/actions?kind=${encodeURIComponent(kind)}${entityId ? `&entity=${encodeURIComponent(entityId)}` : ""}`).then((actions) => {
      holder.replaceChildren(...(actions || []).map((a) => {
        const key = `${a.plugin}/${a.id}/${entityId || kind}`;
        const b = el("button", { class: cls, title: `${a.label} (${a.pluginName})` }, pressing.get(key) || a.label);
        const say = (text, title, ms) => {
          pressing.set(key, text);
          b.textContent = text;
          if (title) b.title = title;
          if (ms) setTimeout(() => { if (pressing.get(key) === text) pressing.delete(key); if (b.textContent === text) b.textContent = a.label; }, ms);
        };
        if (pressing.has(key)) b.disabled = pressing.get(key).endsWith("…");
        b.addEventListener("click", () => {
          if (b.disabled) return;
          b.disabled = true;
          say(a.label.startsWith("Sync") ? "Syncing…" : `${a.label}…`);
          api("POST", `/plugins/${encodeURIComponent(a.plugin)}/actions/${encodeURIComponent(a.id)}`, { ...(entityId ? { entity: entityId } : {}), kind })
            .then((r) => {
              b.disabled = false;
              // What came of it, in a word; the whole of what the plugin said on hover.
              if (r.error) say("Didn't work", r.text, 8000);
              // Asked right here: the page's chooser, under the button, in the plugin's words.
              else if (r.here && onChoose) { say(a.label, r.text, 1); onChoose(b, r.text); }
              else if (r.decisions) say(`${r.decisions} to decide`, `${r.text} Decide in Settings, Plugins.`, 8000);
              else say("Done", r.text, 2500);
              if (!r.error && onDone) onDone(r);
            })
            .catch((e) => { b.disabled = false; say("Didn't work", e.message, 8000); });
        });
        return b;
      }));
    }).catch(() => {});
    return holder;
  }
  /** "Open in …" buttons for those links; `open(url)` is the page's way to the browser. */
  function elsewhereButtons(entity, open, cls = "t-btn") {
    return elsewhere(entity).map((l) => el("button", { class: cls, title: l.url, onclick: () => open(l.url) }, `Open in ${l.label}`));
  }
  // Glance on a thing (glance_panel.py, open_on): what it is tied to, and what it might be. `go` is the page's bridge's glanceAt.
  function glanceButton(key, go, cls = "t-btn") {
    return go ? el("button", { class: cls, title: "Its connections, and possible ones", onclick: (e) => { e.stopPropagation(); go(key); } }, "Glance") : null;
  }
  // What a card's links are grouped by: what the other thing is.
  const GROUP = { contact: "People", event: "Events", task: "Tasks", note: "Pages", project: "Projects" };
  const words = (key) => String(key).replace(/_/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
  const FIRST = 20;
  const ARCHIVED = "In archived projects";

  /** One kind's rows: the newest twenty, then twenty more at a time, or all. */
  function group(name, rows, api, opts) {
    // The archived group starts folded: a press on its label opens it.
    let shown = name === ARCHIVED ? 0 : FIRST;
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
    const label = el("div", { class: "peek-label" + (name === ARCHIVED ? " peek-fold" : "") }, `${name} · ${rows.length}`);
    if (name === ARCHIVED) label.addEventListener("click", () => { shown = shown ? 0 : FIRST; draw(); });
    return el("div", { class: "peek-group" }, label, list, more);
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
    // What lives in an archived project is kept apart, folded: still true, not current.
    for (const row of byId.values()) {
      const g = row.e.archived ? ARCHIVED : GROUP[(row.e.kinds || []).find((k) => GROUP[k])] || "Other";
      groups.set(g, [...(groups.get(g) || []), row]);
    }
    for (const rows of groups.values()) rows.sort((a, b) => String(b.e.updated || "").localeCompare(String(a.e.updated || "")));
    const order = [...new Set(Object.values(GROUP)), "Other", ARCHIVED].filter((g) => groups.has(g));
    const props = got.entity.properties || {};
    const note = typeof props.notes === "string" ? props.notes : typeof props.description === "string" ? props.description : "";
    // Flattened: replaceChildren takes nodes, and would write an array of groups out as text.
    card.replaceChildren(...[
      el("div", { class: "peek-head" },
        el("span", { class: "peek-kind" }, place && place.kind !== "page" ? PLACE[place.kind] || kindOf(got.kinds) : kindOf(got.kinds)),
        el("span", { class: "peek-title" }, got.title),
        el("button", { class: "icon-btn", title: "Close", onclick: close }, "×")),
      Array.isArray(props.emails) && props.emails.length ? el("div", { class: "peek-line" }, props.emails.join(", ")) : null,
      note ? el("div", { class: "peek-note" }, note.replace(/\[([^\]\n]*)\]\(talaris:[A-Za-z0-9_-]+\)/g, "$1").slice(0, 300)) : null,
      isTask && opts.onTask ? el("button", { class: "t-btn", onclick: () => { close(); opts.onTask(id); } }, "Open task") : null,
      place ? el("button", { class: "t-btn", onclick: () => { close(); opts.openPlace(place); } }, { page: "Open page", canvas: "Open canvas", thread: "Open the conversation" }[place.kind] || "Open") : null,
      opts.openUrl ? elsewhereButtons(got.entity, (u) => { close(); opts.openUrl(u); }) : null,
      order.map((name) => group(name, groups.get(name), api, opts)),
    ].flat().filter((x) => x != null));
  }

  /**
   * What a thing might be tied to and is not (the core's suggest.ts), for a
   * person's or a task's own view: each with why, and the ways that fit —
   * taken, or turned down (×). `key` is its glance key (`e:<id>`); `opts.open`
   * opens one chosen (its id), `opts.changed` redraws after a tie is made.
   * Nothing at all is drawn when there is nothing to suggest.
   */
  function suggestions(key, api, opts = {}) {
    const host = el("div", { class: "peek-sugg" });
    let armed = "";
    let dismissed = 0;
    // Those turned down for it, offered again: beside the heading, or alone when nothing else is suggested.
    const reset = () => (dismissed ? el("button", { class: "t-btn peek-reset", title: `Suggest the ${dismissed} turned down for this again`,
      onclick: () => api("POST", "/suggestions/reset", { key }).then(load) }, `Reset dismissed (${dismissed})`) : null);
    const draw = (list) => {
      if (!list.length) { host.replaceChildren(...(dismissed ? [el("div", { class: "peek-label peek-shead" }, "Possible connections", reset())] : [])); return; }
      host.replaceChildren(el("div", { class: "peek-label peek-shead" }, `Possible connections · ${list.length}`, reset()), ...list.map((s) => el("div", { class: "peek-srow" },
        el("div", { class: "peek-stop" },
          el("button", { class: "peek-item", title: "Open it", onclick: () => (s.id ? opts.open && opts.open(s.id, s) : placeOfKey(s.key) && opts.openPlace && opts.openPlace(placeOfKey(s.key))) },
            el("span", { class: "peek-t" }, s.title)),
          el("button", { class: "icon-btn peek-no", title: "Not connected — don't suggest it again", onclick: () => api("POST", "/suggestions/dismiss", { key, other: s.key }).then(load) }, "×")),
        el("div", { class: "peek-why" }, s.why.join(" · ")),
        el("div", { class: "peek-ways" }, s.ways.map((w) => {
          const id = `${s.key}|${w.how}|${w.text || ""}`;
          const asking = w.how === "merge" && armed === id;
          return el("button", { class: "t-btn" + (asking ? " armed" : ""), onclick: () => {
            if (w.how === "merge" && !asking) { armed = id; draw(list); return; }
            armed = "";
            api("POST", "/suggestions/accept", { key, other: s.key, way: w }).then((r) => { if (opts.changed) opts.changed(r); else load(); });
          } }, asking ? "Merge? Again to do it" : w.label);
        })))));
    };
    const load = () => api("GET", `/suggestions?key=${encodeURIComponent(key)}&limit=8`).then((r) => { dismissed = (r && r.dismissed) || 0; draw((r && r.suggestions) || []); }).catch(() => draw([]));
    load();
    return host;
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
    .peek-fold { cursor: pointer; }
    .peek-fold:hover { color: var(--accent); }
    .peek-more:empty { display: none; }
    .peek-more .t-btn { font-size: 11.5px; padding: 1px 9px; }
    .peek-sugg:not(:empty) { margin-top: 12px; }
    .peek-shead { display: flex; align-items: center; gap: 8px; }
    .peek-reset { margin-left: auto; font-size: 10.5px; padding: 0 7px; letter-spacing: 0; text-transform: none; }
    .peek-srow { padding: 4px 0 6px; border-top: 1px solid color-mix(in srgb, var(--line) 60%, transparent); }
    .peek-stop { display: flex; align-items: center; gap: 4px; }
    .peek-no.icon-btn { flex: none; width: auto; height: auto; min-width: 0; font-size: 14px; line-height: 1; padding: 0 4px !important; border: 0 !important; background: none !important; color: var(--muted); }
    .peek-no.icon-btn:hover { color: var(--danger); }
    .peek-why { color: var(--muted); font-size: 11px; margin: 0 6px 4px; }
    .peek-ways { display: flex; flex-wrap: wrap; gap: 4px; margin: 0 6px; }
    .peek-ways .t-btn { font-size: 11px; padding: 0 8px; }
    .peek-ways .t-btn.armed { border-color: var(--danger); color: var(--danger); }
  `;
  document.head.append(style);

  return { show, close, elsewhere, elsewhereButtons, actionButtons, glanceButton, suggestions };
})();
