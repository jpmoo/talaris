// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore
//
// The Tasks panel's page shell (TASKS-CONTRACT.md): the lists and projects
// down the left, the one chosen on the right with a field to add to it, the
// list view, and the sheet a task opens in. Everything is asked of the core
// through the bridge; nothing is kept here but what is on show and which one
// that was (this page's own preference).
//
// What a task is, is read from its type: the status field, the values that
// count as complete, the datespan and the default status all come from the
// task profile the core hands over (GET /tasks/types), never from a name.

"use strict";

// One closure: listeditor.js and taskviews.js load first into the same page,
// and two top-level `const $` in one page is a syntax error, not a shadow.
(() => {
  const $ = (id) => document.getElementById(id);
  function el(tag, attrs = {}, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
      else if (k === "class") e.className = v;
      else if (k === "style") e.setAttribute("style", v);
      else e.setAttribute(k, v);
    }
    for (const k of kids.flat()) if (k != null && k !== "" && k !== false) e.append(k);
    return e;
  }
  /** The small × that takes a thing off (controls.css .x-btn). */
  function xBtn(title, act) {
    const b = el("button", { type: "button", class: "x-btn", title, onclick: (e) => { e.stopPropagation(); act(); } });
    b.innerHTML = Icons.close();
    return b;
  }
  function seg(host, choices, current, pick) {
    (typeof host === "string" ? $(host) : host).replaceChildren(...choices.map(([value, label]) =>
      el("button", { class: value === current ? "on" : "", onclick: (e) => { e.stopPropagation(); pick(value); } }, label)));
  }
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* fine */ } },
  };

  let bridge = null;
  let surface = { up: false };
  // Loaded as a window (overlay.py), not a panel: always out, no dim, no motion.
  const WINDOW = new URLSearchParams(location.search).has("window");
  if (WINDOW) document.documentElement.dataset.window = "1";

  let type = null;     // the task type
  let shape = null;    // how it is a task: titleKey, statusKey, complete, defaultStatus, spanKey, doneKey
  let projects = [];
  let lists = [];
  let column = []; // the projects as the column shows them: groups and projects in none, in one order (the core's)
  let current = null;  // {kind: "list" | "project", id}
  let shown = null;    // the core's Shown for it
  let editing = null;  // the task open in the sheet
  let entity = null;   // its entity, as the core has it
  let rec = { rule: null, summary: "" };
  let rep = null;      // the rule being written in Repeat's editor
  let renaming = null; // a list whose name is being typed
  let addingProject = false;
  let onWallpaper = null; // the project panel's ear for wallpaperChanged

  // ---------------------------------------------------------------- the core

  // Two pages may share the bridge — the panel and its window — so each numbers
  // its requests from somewhere of its own, and takes only its own answers.
  /** A name that cannot start with a space: one typed first is not taken, and one pasted at the front is taken off. */
  function noLeadingSpace(input) {
    input.addEventListener("keydown", (e) => { if (e.key === " " && input.selectionStart === 0) e.preventDefault(); });
    input.addEventListener("input", () => {
      const trimmed = input.value.replace(/^\s+/, "");
      if (trimmed !== input.value) { input.value = trimmed; input.dispatchEvent(new Event("input")); }
    });
    return input;
  }

  // Asked of the core as every page asks it (kit.js): one book of what waits, 2xx the answer, given up on if none comes.
  const asked = Kit.core((id, method, path, body) => !!bridge && (bridge.core(id, method, path, body), true));
  const api = (method, path, body) => asked.call(method, path, body);
  const enc = encodeURIComponent;

  // Said as every page says it (kit.js): one line, sentence case, an error in the danger color.

  function say(text, error = false) { Kit.say($("msg"), text, error, 0); }
  const failed = (e) => say(e.message, true);

  // ---------------------------------------------------------------- the type's words

  const field = (key) => (type ? type.fields.find((f) => f.key === key) : null) || null;
  const statusField = () => (shape ? field(shape.statusKey) : null);
  const options = () => (statusField() || {}).options || [];
  const completeValues = () => (shape ? shape.complete : []);
  const openValues = () => options().filter((o) => !completeValues().includes(o));
  const doneValue = () => completeValues().find((v) => options().includes(v)) || completeValues()[0];
  const reopenValue = () => (shape && shape.defaultStatus) || openValues()[0];
  // The body and the projects: the type's long text, and its many-reference.
  const notesKey = () => ((type && type.fields.find((f) => f.kind === "richtext")) || { key: "description" }).key;
  const projectKey = () => ((type && type.fields.find((f) => f.kind === "reference" && f.many)) || { key: "project" }).key;
  const humanize = (v) => String(v || "").replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());

  function status(value) {
    const f = statusField() || {};
    return { label: (f["talaris:labels"] || {})[value] || humanize(value), color: (f["talaris:colors"] || {})[value] || "var(--muted)" };
  }

  // ---------------------------------------------------------------- dates
  //
  // A task's dates are wall-clock: "YYYY-MM-DD" or "YYYY-MM-DDTHH:MM", no zone.

  const DAY_MS = 86400000;
  const pad = (n) => String(n).padStart(2, "0");
  function startOfDay(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
  function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
  function sameDay(a, b) { return a && b && a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate(); }
  function startOfWeek(d) { return addDays(startOfDay(d), -startOfDay(d).getDay()); }
  const isoDay = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  function split(v) {
    if (!v) return { day: null, time: null };
    const [d, t] = String(v).split("T");
    const [y, m, dd] = d.split("-").map(Number);
    if (!y || !m || !dd) return { day: null, time: null };
    let time = null;
    if (t) { const [h, mi] = t.split(":").map(Number); if (!isNaN(h)) time = h * 60 + (mi || 0); }
    return { day: new Date(y, m - 1, dd), time };
  }
  const join = (day, time) => (day ? isoDay(day) + (time != null ? `T${pad(Math.floor(time / 60))}:${pad(time % 60)}` : "") : null);
  const timeLabel = (m) => Kit.minutes(m);
  /** Short: Today, Tomorrow, a weekday within the week, else "Oct 27". */
  function shortDate(v) {
    const { day, time } = split(v);
    if (!day) return "";
    const s = Kit.relDay(day);
    return time != null ? `${s} ${timeLabel(time)}` : s;
  }
  /** "9", "9:30", "930", "9:30 pm", "21:30" — minutes after midnight, or null. */
  // What is typed, read as every page reads it (kit.js): a bare "3" is the afternoon.
  const parseTime = (text) => Kit.parseTime(text);
  const timeList = (current, pick) => Kit.timeList(current, pick);
  // Strictly after today: the picker's "Next Mon".

  // ---------------------------------------------------------------- the one pop at a time
  //
  // No browser pickers — a <select>, a date or a time field opens a window of
  // the engine's own, which a layer surface cannot hold — so menus, dates and
  // times are small lists drawn in the page.

  // One pop-up at a time, the kit's (kit.js): placed under what opened it (or above, with more room there),
  // kept on screen, scrolling when long, put away by a press elsewhere or Escape — the same on every page.
  const popPlace = (left, top, content, anchor) => Kit.pop({ x: left, y: top, opener: anchor || null }, content);
  const popUnder = (anchor, content) => Kit.pop(anchor, content);
  const popAway = () => Kit.popAway();
  const menuAt = (x, y, items) => Kit.menu({ x, y }, items);
  const monthPicker = (chosen, pick, opts) => Kit.monthPicker(chosen, pick, opts);

  // ---------------------------------------------------------------- dragging into order

  // Dragged as every list's are (kit.js): by pointer, a copy following it, the one drop line.
  // Dropped above or below a neighbour: the core places it between the two.
  function sortable(item, id, scope, drop) {
    item.dataset.scope = scope;
    Kit.draggable(item, { id, scope });
    Kit.dropZone(item, {
      accepts: (p) => p.scope === scope && p.id !== id,
      drop: (p, where) => {
        const order = [...document.querySelectorAll(`[data-scope="${scope}"]`)].map((x) => x.dataset.id).filter((x) => x !== p.id);
        const i = order.indexOf(id);
        const after = where === "above" ? (order[i - 1] ?? null) : id;
        const before = where === "above" ? id : (order[i + 1] ?? null);
        drop(p.id, after, before);
      },
    });
  }

  /*
   * The column is one list (the core's /tasks/column): groups and projects
   * in no group side by side, each group holding its own. Every drag takes
   * a copy of it, moves one thing, and gives the whole back.
   *
   * A project dropped above or below another goes there, into that one's
   * group or none. On a group's heading: its top edge, above the group; its
   * bottom edge when the group is folded, below it; anywhere else, into it.
   * On the column's end, last, in no group. A group's heading dragged goes
   * above or below a group or a project in none.
   */
  const plain = () => column.map((x) => x.kind === "group" ? { kind: "group", name: x.name, projects: x.projects.map((p) => p.id) } : { kind: "project", id: x.project.id });
  function without(entries, id) {
    return entries.filter((x) => !(x.kind === "project" && x.id === id)).map((x) => x.kind === "group" ? { ...x, projects: x.projects.filter((p) => p !== id) } : x);
  }
  const arrange = (entries) => api("PUT", "/tasks/column", { entries }).then(loadSide).catch(failed);
  const topAt = (entries, key) => entries.findIndex((x) => (x.kind === "group" ? `g:${x.name}` : `p:${x.id}`) === key);
  /** Where a drop lands on this row: above or below by the half, or (a group's heading, for a project) in it. */
  function zone(node, e, isGroup, folded, carried) {
    if (!isGroup || carried.scope === "group") return Kit.halves(e, node);
    const w = Kit.halves(e, node, true);
    // An open group's heading has its projects right under it: below it is in it.
    return w === "below" && !folded ? "in" : w;
  }

  /** One row of the column as a drop target. `at`: what it is — a project (and its group, if any), a group's heading, or the column's end. */
  function dropOn(node, at) {
    Kit.dropZone(node, {
      accepts: (p) => (p.scope === "project" || p.scope === "group") && p.id !== at.id && !(p.scope === "group" && at.kind === "group" && p.id === at.name),
      where: (e, n, p) => (at.kind === "end" ? "above" : zone(n, e, at.kind === "group", at.folded, p)),
      drop: (p, where) => (p.scope === "project" ? moveProject(p.id, at, where) : moveGroup(p.id, at, where)),
    });
  }
  function moveProject(id, at, where) {
    if (id === at.id) return;
    let entries = without(plain(), id);
    if (at.kind === "end") entries.push({ kind: "project", id });
    else if (at.kind === "group") {
      const i = topAt(entries, `g:${at.name}`);
      if (where === "in") entries[i].projects.push(id);
      else entries.splice(i + (where === "below" ? 1 : 0), 0, { kind: "project", id });
    } else if (at.group) {
      const g = entries[topAt(entries, `g:${at.group}`)];
      g.projects.splice(g.projects.indexOf(at.id) + (where === "below" ? 1 : 0), 0, id);
    } else {
      entries.splice(topAt(entries, `p:${at.id}`) + (where === "below" ? 1 : 0), 0, { kind: "project", id });
    }
    arrange(entries);
  }
  function moveGroup(name, at, where) {
    const entries = plain();
    const moving = entries[topAt(entries, `g:${name}`)];
    const rest = entries.filter((x) => x !== moving);
    // A project in a group stands for its group's place.
    const key = at.kind === "end" ? null : at.kind === "group" ? `g:${at.name}` : at.group ? `g:${at.group}` : `p:${at.id}`;
    if (key === `g:${name}`) return;
    const i = key ? topAt(rest, key) : rest.length;
    rest.splice(key ? i + (where === "below" ? 1 : 0) : i, 0, moving);
    arrange(rest);
  }
  function draggable(node, id, scope) { Kit.draggable(node, { id, scope }); }

  // ---------------------------------------------------------------- loading

  /*
   * What plugins ask here rather than in Settings (which of Hermes Notes'
   * collections to sync, where a card moved on both sides goes): a button in
   * the header while any wait, and a chooser under it — grouped, each group
   * under the plugin's own words for it.
   */
  let asks = [];
  async function drawAsks() {
    const b = $("asks");
    if (!b) return;
    asks = (await api("GET", "/plugins/decisions?on=tasks").catch(() => [])) || [];
    const groups = new Set(asks.map((d) => d.group || ""));
    b.hidden = !asks.length;
    b.textContent = groups.size === 1 && asks[0].group ? `${asks.length} ${asks[0].group}` : `${asks.length} to choose`;
    b.onclick = () => chooseAsks(b);
  }
  function chooseAsks(anchor, said) {
    const box = el("div", { class: "asks" });
    const draw = () => {
      if (!asks.length) { box.replaceChildren(el("div", { class: "asks-head" }, said || "Nothing to choose")); return; }
      const groups = [...new Set(asks.map((d) => d.group || ""))];
      box.replaceChildren(...groups.map((g) => {
        const these = asks.filter((d) => (d.group || "") === g);
        const head = g ? `${these.length} ${g}.${these[0].prompt ? ` ${these[0].prompt}` : ""}` : these[0].pluginName;
        return el("div", { class: "asks-group" }, el("div", { class: "asks-head" }, head), ...these.map((d) => el("div", { class: "ask" },
          el("div", { class: "ask-q" }, d.title),
          d.detail ? el("div", { class: "ask-d" }, d.detail) : null,
          el("div", { class: "ask-acts" }, ...d.choices.filter((c) => !c.edit).map((c) => el("button", { class: "t-btn", onclick: async (e) => {
            for (const x of e.currentTarget.parentElement.querySelectorAll("button")) x.disabled = true;
            try { await api("POST", `/plugins/${enc(d.plugin)}/decide?on=tasks`, { item: d.id, choice: c.key }); } catch (err) { failed(err); }
            await drawAsks();
            draw();
            refresh();
          } }, c.label))))));
      }));
    };
    draw();
    popUnder(anchor, box);
  }

  async function loadSide() {
    drawAsks();
    const [l, p, c, oc] = await Promise.all([api("GET", "/lists"), api("GET", "/tasks/projects"), api("GET", "/tasks/column").catch(() => []),
      api("GET", "/tasks/open-counts").catch(() => ({}))]);
    openCounts = oc || {};
    lists = l || [];
    projects = p || [];
    column = c || [];
    drawSide();
    // The project shown on the right, read again with the rest (its name, its count, its description).
    if (current && current.kind === "project" && !editing && !projectShut) openProject(current.id);
  }
  // What was shown last, if it is still there; else the starter Today; else the first list.
  function chooseCurrent() {
    const live = (c) => c && (c.kind === "project" ? projects.some((p) => p.id === c.id && !p.archived) : lists.some((l) => l.id === c.id && !l.archived));
    if (live(current)) return;
    const kept = store.get("talaris.tasks.shown", null);
    if (live(kept)) { current = kept; return; }
    const open = lists.filter((l) => !l.archived);
    const today = open.find((l) => l["talaris:starter"] === "today") || open[0];
    current = today ? { kind: "list", id: today.id } : null;
  }
  let showReq = 0;
  async function loadShown() {
    chooseCurrent();
    drawSide();
    if (!current) { shown = null; drawView(); return; }
    const want = ++showReq;
    const s = await api("GET", current.kind === "project" ? `/tasks/projects/${enc(current.id)}` : `/lists/${enc(current.id)}`);
    if (want !== showReq) return;
    shown = s;
    drawView();
  }
  // The type read again each time: its statuses are edited in Settings → Types.
  async function refresh() {
    try {
      const t = await api("GET", "/tasks/types");
      type = t.type; shape = t.shape;
      await loadSide(); await loadShown();
    } catch (e) { failed(e); }
  }

  async function start() {
    await refresh();
  }
  function showThing(kind, id) {
    // Going somewhere ends a search.
    if (searching) { searching = ""; $("search").value = ""; }
    current = { kind, id };
    store.set("talaris.tasks.shown", current);
    if (kind !== "project") closeProject();
    closeSheet();
    shown = null;
    drawView();
    loadShown().catch(failed);
  }

  // ---------------------------------------------------------------- the left column

  // Groups are Tasks' own arrangement (`talaris:group` on the project): a
  // group is only its name, there while some project has it.
  const byName = (a, b) => a.localeCompare(b, undefined, { sensitivity: "base" });
  const groupNames = () => column.filter((x) => x.kind === "group").map((x) => x.name);
  let shutGroups = new Set(store.get("talaris.tasks.groupsShut", []));
  function toggleGroup(g) {
    if (shutGroups.has(g)) shutGroups.delete(g); else shutGroups.add(g);
    store.set("talaris.tasks.groupsShut", [...shutGroups]);
    drawSide();
  }
  function setGroup(p, group) {
    api("PATCH", `/entities/${enc(p.id)}`, { "talaris:group": group || null }).then(loadSide).catch(failed);
  }

  let openCounts = {};   // project id → how many open tasks it has
  function projectRow(p, inGroup, on) {
    const row = el("div", { class: "item proj" + (inGroup ? " in-group" : "") + (on ? " on" : ""), "data-id": p.id, title: p.title,
      onclick: () => showThing("project", p.id),
      // Its properties are the panel on the right; the menu keeps only what is quicker here.
      oncontextmenu: (e) => { e.preventDefault(); if (p.group) menuAt(e.clientX, e.clientY, [{ label: "Ungroup", act: () => setGroup(p, null) }]); else showThing("project", p.id); } },
      el("span", { class: "name" }, p.title),
      // How many tasks it has open (the core's /tasks/open-counts).
      openCounts[p.id] ? el("span", { class: "n", title: `${openCounts[p.id]} open` }, String(openCounts[p.id])) : null);
    draggable(row, p.id, "project");
    dropOn(row, { kind: "project", id: p.id, group: p.group || null });
    return row;
  }
  // The column in its one order: each group folding, and the projects in
  // none among them. A shut group still shows the one chosen, so what is on
  // the right has a row.
  function projectRows(isOn) {
    const out = [];
    for (const x of column) {
      if (x.kind === "project") { out.push(projectRow(x.project, false, isOn("project", x.project.id))); continue; }
      const g = x.name;
      const shut = shutGroups.has(g);
      const head = el("div", { class: "item grp" + (shut ? " folded" : ""), title: g, onclick: () => toggleGroup(g) },
        Kit.caret(!shut), el("span", { class: "name" }, g), el("span", { class: "n" }, String(x.projects.length)));
      draggable(head, g, "group");
      dropOn(head, { kind: "group", name: g, folded: shut || !x.projects.length });
      out.push(head, ...x.projects.filter((p) => !shut || isOn("project", p.id)).map((p) => projectRow(p, true, isOn("project", p.id))));
    }
    // The column's end: somewhere to drop below the last group.
    const end = el("div", { class: "col-end" });
    dropOn(end, { kind: "end" });
    out.push(end);
    return out;
  }

  function drawSide() {
    const side = $("side");
    const isOn = (kind, id) => current && current.kind === kind && current.id === id;
    const projHead = el("h3", {}, el("span", {}, "Projects"), el("button", { class: "add", title: "New project", onclick: () => { addingProject = true; drawSide(); } }, "+"));
    // Lists of rows flattened in: replaceChildren takes nodes, and would write an array out as text.
    side.replaceChildren(...[
      el("h3", {}, el("span", {}, "Collections"), el("button", { class: "add", title: "New collection", onclick: newList }, "+")),
      lists.filter((l) => !l.archived).map((l) => {
        if (renaming === l.id) return renameRow(l);
        const row = el("div", { class: "item" + (isOn("list", l.id) ? " on" : ""), "data-id": l.id, title: l.name,
          onclick: () => showThing("list", l.id),
          oncontextmenu: (e) => { e.preventDefault(); menuAt(e.clientX, e.clientY, [
            { label: "Rename", act: () => { renaming = l.id; drawSide(); } },
            { label: "Archive", act: () => archiveList(l) },
            { label: "Delete…", act: () => menuAt(e.clientX, e.clientY, [
              { label: `Delete “${l.name}”`, act: () => deleteList(l) }, { label: "Keep it", act: () => {} }]) },
          ]); } }, el("span", { class: "name" }, l.name),
          // Kept in step with another app by a plugin (its definition is that app's), rather than Talaris's own.
          l["talaris:syncedBy"] ? el("span", { class: "synced", title: `Synced by ${l["talaris:syncedBy"]}` }, "⇄") : null);
        sortable(row, l.id, "lists", (id, after, before) =>
          api("PATCH", `/lists/${enc(id)}`, { position: { after, before } }).then(loadSide).catch(failed));
        return row;
      }),
      projHead,
      addingProject ? newProjectRow() : null,
      projectRows(isOn),
    ].flat().filter((x) => x != null));
  }

  function renameRow(l) {
    const input = el("input", { type: "text", value: l.name, spellcheck: "false" });
    let done = false;
    const finish = (save) => {
      if (done) return;
      done = true;
      renaming = null;
      const name = input.value.trim();
      if (save && name && name !== l.name) api("PATCH", `/lists/${enc(l.id)}`, { name }).then(refresh).catch(failed);
      else drawSide();
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); finish(true); }
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); finish(false); }
    });
    input.addEventListener("blur", () => finish(true));
    setTimeout(() => { input.focus(); input.select(); }, 0);
    return el("div", { class: "item" }, input);
  }

  function newProjectRow() {
    const input = noLeadingSpace(el("input", { type: "text", class: "new", placeholder: "Name", spellcheck: "false" }));
    let done = false;
    const finish = async (save) => {
      if (done) return;
      done = true;
      addingProject = false;
      const title = input.value.trim();
      if (!save || !title) { drawSide(); return; }
      try {
        const p = await api("POST", "/tasks/projects", { title });
        await loadSide();
        showThing("project", p.id);
      } catch (e) { failed(e); drawSide(); }
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); finish(true); }
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); finish(false); }
    });
    input.addEventListener("blur", () => finish(false));
    setTimeout(() => input.focus(), 0);
    return el("div", { class: "item" }, input);
  }

  // Gone for good: the list only, never what is in it — nor, for a synced one, the collection on the other side.
  function deleteList(l) {
    api("DELETE", `/lists/${enc(l.id)}`).then(() => {
      if (current && current.kind === "list" && current.id === l.id) current = null;
      return refresh();
    }).catch(failed);
  }

  function archiveList(l) {
    api("PATCH", `/lists/${enc(l.id)}`, { archived: true }).then(() => {
      if (current && current.kind === "list" && current.id === l.id) current = null;
      return refresh();
    }).catch(failed);
  }

  // The list editor is listeditor.js's; it answers with the list saved (or
  // archived, or deleted), or nothing when put away.
  function editList(list) {
    if (!window.ListEditor) return;
    Promise.resolve(ListEditor.open({ list }, ctx())).then((l) => {
      if (l && l.id && !l.deleted && !l.archived) { current = { kind: "list", id: l.id }; store.set("talaris.tasks.shown", current); }
      else if (l && l.id && current && current.id === l.id) current = null;
      return refresh();
    }).catch(failed);
  }
  // Without the editor a new list is a kept one, named where it stands.
  function newList() {
    if (window.ListEditor) { editList(null); return; }
    api("POST", "/lists", { name: "New collection" }).then(async (l) => {
      await loadSide();
      renaming = l.id;
      showThing("list", l.id);
    }).catch(failed);
  }

  // ---------------------------------------------------------------- what is shown

  const ctx = () => ({ api, openTask, refresh, status, update, setStatus, newTask, taskType: type, projects });

  /*
   * Search: every task, open or done, whose words hold all of those typed
   * (title, fields, notes) — in place of what is shown while there are any;
   * the open ones first. Escape, or emptying it, goes back.
   */
  let searching = "";
  let searchAsked = 0;
  async function drawSearch() {
    const q = searching, mine = ++searchAsked;
    const found = await api("GET", `/tasks/find?text=${enc(q)}&limit=200`).catch((e) => { failed(e); return []; });
    if (mine !== searchAsked || q !== searching) return;
    const rows = (found || []).sort((a, b) => Number(Boolean(a.complete)) - Number(Boolean(b.complete)));
    $("title").textContent = `“${q}”`;
    $("count").textContent = String(rows.length);
    $("edit-list").hidden = true;
    const host = $("rows");
    if (!rows.length) { host.replaceChildren(Kit.empty("Nothing matches")); return; }
    let n = 0;
    host.replaceChildren(el("div", { class: "list fmt-checklist" }, ...rows.map((r) => rowEl(r, "checklist", ++n, true))));
  }

  function drawView() {
    if (searching) { drawSearch(); return; }
    const kept = current && current.kind === "list";
    $("title").textContent = shown ? shown.list.name : "";
    $("count").textContent = shown ? String(shown.rows.length) : "";
    // A project is edited in its panel on the right; a collection, in the list editor.
    $("edit-list").hidden = !(shown && kept && window.ListEditor);
    const host = $("rows");
    if (!shown) { host.replaceChildren(current ? "" : Kit.empty("No collections yet")); return; }
    const kind = shown.list.kind || "list";
    if (kind !== "list" && window.TaskViews && typeof TaskViews.render === "function") {
      host.replaceChildren();
      try { TaskViews.render(kind, host, shown, ctx()); return; } catch (e) { failed(e); }
    }
    drawList(host);
  }

  let folded = new Set(store.get("talaris.tasks.folded", []));
  function fold(key) {
    if (folded.has(key)) folded.delete(key); else folded.add(key);
    store.set("talaris.tasks.folded", [...folded]);
    drawView();
  }

  function drawList(host) {
    const list = shown.list;
    const fmt = (list["talaris:view"] || {}).format || "checklist";
    if (!shown.rows.length) { host.replaceChildren(Kit.empty("Nothing here yet")); return; }
    const byId = new Map(shown.rows.map((r) => [r.id, r]));
    const wrap = el("div", { class: `list fmt-${fmt}` });
    let n = 0;
    const add = (r) => { if (r) wrap.append(rowEl(r, fmt, ++n)); };
    if (shown.groups && shown.groups.length) {
      for (const g of shown.groups) {
        const key = `${list.id}:${g.key}`;
        const shut = folded.has(key);
        wrap.append(el("div", { class: "ghead" + (shut ? " folded" : ""), onclick: () => fold(key) },
          Kit.caret(!shut), el("span", {}, g.label || "None"), el("span", { class: "n" }, String(g.rows.length))));
        if (!shut) g.rows.forEach((id) => add(byId.get(id)));
      }
    } else shown.rows.forEach(add);
    const top = host.scrollTop;
    host.replaceChildren(wrap);
    host.scrollTop = top;
  }

  const isTask = (r) => Boolean(shape) && r.status !== undefined;
  // A press on a status: the next in its type's order, after the last the first again (two statuses, a toggle).
  const nextStatus = (v) => { const o = options(); return o[(o.indexOf(v) + 1) % o.length]; };
  function statusItems(r) {
    return options().map((v) => ({ label: status(v).label, color: status(v).color, on: v === r.status, act: () => setStatus(r.id, v).catch(failed) }));
  }

  function checkEl(r) {
    const c = status(r.status).color;
    return el("button", { class: "check" + (r.complete ? " on" : ""), style: `--c:${r.complete ? c : "var(--muted)"}`, title: status(r.status).label,
      onclick: (e) => { e.stopPropagation(); setStatus(r.id, r.complete ? reopenValue() : doneValue()).catch(failed); } }, "✓");
  }
  function chipEl(r) {
    const s = status(r.status);
    return el("button", { class: "tv-status", style: `--c:${s.color}`, title: `Press for ${status(nextStatus(r.status)).label}, right-click to choose`,
      onclick: (e) => { e.stopPropagation(); setStatus(r.id, nextStatus(r.status)).catch(failed); },
      oncontextmenu: (e) => { e.preventDefault(); e.stopPropagation(); menuAt(e.clientX, e.clientY, statusItems(r)); } }, el("span", { class: "tv-dot" }), s.label);
  }
  function metaEl(r) {
    const bits = [];
    if (r.due) bits.push(el("span", { class: r.overdue ? "overdue" : "" }, `Due ${shortDate(r.due)}`));
    // Available shown only while it is still to come.
    if (r.start && r.start.slice(0, 10) > isoDay(new Date())) bits.push(el("span", {}, `From ${shortDate(r.start)}`));
    if (r.recurring) bits.push(el("span", { title: "Repeats" }, "↻"));
    if (r.files && r.files.length) bits.push(el("span", { title: r.files.map((f) => f.filename).join(", ") }, `📎${r.files.length > 1 ? r.files.length : ""}`));
    for (const p of r.projects || []) bits.push(el("span", {}, p.title));
    for (const t of r.tags || []) bits.push(el("span", {}, `#${t}`));
    return bits.length ? el("div", { class: "meta" }, bits) : null;
  }
  // A card's excerpt: the words, not the Markdown marks around them.
  const excerpt = (text) => String(text).replace(/[#>*_`[\]]+/g, "").replace(/\s+/g, " ").trim().slice(0, 180);

  /** A row; `plain` (a search's): not arranged by dragging, and its menu only its status. */
  function rowEl(r, fmt, n, plain = false) {
    const task = isTask(r);
    const control = !task ? el("span", { class: "nostat" }) : fmt === "checklist" ? checkEl(r) : chipEl(r);
    const row = el("div", { class: "row" + (r.complete ? " done" : "") + (editing === r.id ? " on" : ""), "data-id": r.id,
      onclick: () => { if (task) openTask(r.id); },
      oncontextmenu: (e) => { if (!plain) { rowMenu(e, r); return; } e.preventDefault(); if (isTask(r)) menuAt(e.clientX, e.clientY, statusItems(r)); } },
      fmt === "numbered" ? el("span", { class: "num" }, `${n}.`) : null,
      control,
      el("div", { class: "r-main" },
        el("div", { class: "r-title" }, r.title || "Untitled"),
        fmt === "cards" && r.body ? el("div", { class: "r-body" }, excerpt(r.body)) : null,
        metaEl(r)));
    if (plain) return row;
    if (shown.manual && current.kind === "list") {
      const listId = shown.list.id;
      sortable(row, r.id, "rows", (object, after, before) =>
        api("POST", `/lists/${enc(listId)}/members`, { object, after, before }).then(() => loadShown()).catch(failed));
    } else if (current.kind === "project") {
      // A project's tasks are by due date until one is dragged; from then on, in the order they are put in.
      const projectId = current.id;
      sortable(row, r.id, "rows", (object, after) => {
        const ids = shown.rows.map((x) => x.id).filter((x) => x !== object);
        ids.splice(after ? ids.indexOf(after) + 1 : 0, 0, object);
        api("PUT", `/tasks/projects/${enc(projectId)}/order`, { ids }).then(() => loadShown()).catch(failed);
      });
    }
    return row;
  }

  function rowMenu(e, r) {
    e.preventDefault();
    const items = isTask(r) ? statusItems(r) : [];
    if (shown.manual && current.kind === "list") {
      const listId = shown.list.id;
      if (items.length) items.push("sep");
      items.push({ label: "Remove from list", act: () => api("DELETE", `/lists/${enc(listId)}/members/${enc(r.id)}`).then(() => loadShown()).catch(failed) });
    } else if (shown.manual && current.kind === "project") {
      const projectId = current.id;
      if (items.length) items.push("sep");
      items.push({ label: "Back to by due date", act: () => api("PUT", `/tasks/projects/${enc(projectId)}/order`, { ids: null }).then(() => loadShown()).catch(failed) });
    }
    if (items.length) menuAt(e.clientX, e.clientY, items);
  }

  // ---------------------------------------------------------------- quick add
  //
  // "Call the bank !tomorrow #phone": a due date and a tag by a word each.

  function parseQuick(text) {
    const words = [], tags = [];
    let due = null;
    for (const w of text.split(/\s+/)) {
      const bang = w.match(/^!(\S+)$/);
      if (bang) {
        const k = bang[1].toLowerCase();
        // Read as every page reads a day (kit.js): "!fri", "!tomorrow", "!+3", "!oct 30".
        const day = Kit.parseDay(k);
        if (day) { due = isoDay(day); continue; }
      }
      const tag = w.match(/^#([\p{L}\p{N}_/-]+)$/u);
      if (tag) { if (!tags.includes(tag[1])) tags.push(tag[1]); continue; }
      words.push(w);
    }
    return { title: words.join(" ").trim(), due, tags };
  }
  // An editor line, so @ links as it does in a task's title (made with the
  // sheet's editors, below); Enter adds, Escape clears what was typed.
  let quickEd = null;
  $("quick").addEventListener("keydown", (e) => {
    if (e.key === "Escape" && quickEd && quickEd.text && !e.defaultPrevented) { e.preventDefault(); e.stopPropagation(); quickEd.set(""); }
  });
  async function addQuick() {
    if (!quickEd) return;
    const q = parseQuick(quickEd.text.trim());
    if (!q.title) return;
    const t = { title: q.title };
    if (q.due) t.due = q.due;
    if (q.tags.length) t.tags = q.tags;
    // Made where it is asked for: in the project, or in the kept list (the
    // core puts it there only if the list is one that is filled by hand).
    if (current && current.kind === "project") t.projects = [current.id];
    else if (current && current.kind === "list") t.list = current.id;
    try { await newTask(t); quickEd.set(""); say(""); } catch (err) { failed(err); }
  }

  // ---------------------------------------------------------------- Tasks' own calls

  async function newTask(t) {
    const made = await api("POST", "/tasks", t);
    await refresh();
    return made;
  }
  async function update(id, patch) {
    const out = await api("PATCH", `/entities/${enc(id)}`, patch);
    say("");
    await refresh();
    if (editing === id) await loadEditing();
    return out;
  }
  // Completing a recurring task brings its next: the core's doing, not this page's.
  function setStatus(id, value) {
    if (!shape) return Promise.reject(new Error("No task type"));
    return update(id, { properties: { [shape.statusKey]: value } });
  }

  // ---------------------------------------------------------------- the task's sheet

  function filesNote(text, error = false, ...more) {
    const n = $("s-files-note");
    if (n) { n.replaceChildren(text, ...more); n.className = error ? "err" : ""; }
  }

  function openTask(id) {
    // A task opened takes the right side; closed, the project comes back.
    $("psheet").hidden = true;
    editing = id;
    entity = null;
    closeRep();
    $("sheet").hidden = false;
    for (const r of document.querySelectorAll(".row")) r.classList.toggle("on", r.dataset.id === id);
    loadEditing().catch(failed);
  }
  function closeSheet() {
    editing = null; entity = null;
    closeRep();
    popAway();
    $("sheet").hidden = true;
    for (const r of document.querySelectorAll(".row.on")) r.classList.remove("on");
    if (current && current.kind === "project" && !projectShut) openProject(current.id);
  }

  // ---------------------------------------------------------------- a project, on the right
  //
  // A project chosen on the left is shown on the right as itself: its name,
  // its description — Morgan's from its tasks, or yours, written here
  // (project-describe.ts) — its group and wallpaper, what it might be
  // connected to (suggest.ts, by what its description says), Glance, and
  // archiving it. Each kept as it is changed. Closed, it stays closed until a
  // project is chosen again.
  let projectOn = null, projectAbout = "", projectEd = null, projectShut = false, projectSuggFor = null;
  function openProject(id) {
    const p = projects.find((x) => x.id === id);
    if (!p) { closeProject(); return; }
    projectShut = false;
    const fresh = projectOn !== id;
    projectOn = id;
    $("psheet").hidden = false;
    if (!$("p-name").matches(":focus")) $("p-name").value = p.title;
    // One with no Talaris project (no folder of its own) has no name to change here.
    $("p-name").disabled = !p.workspace;
    $("p-open").textContent = openCounts[p.id] ? String(openCounts[p.id]) : "None";
    paintProjectAbout(p, fresh);
    drawProjectGroup(p);
    if (fresh) drawProjectWall(p);
    const key = p.workspace ? `project:${p.workspace}` : `e:${p.id}`;
    $("p-acts").replaceChildren(...(window.Peek ? [Peek.glanceButton(key, bridge && bridge.glanceAt ? (k) => bridge.glanceAt(k) : null),
      Peek.actionButtons("project", p.id, api, "t-btn", () => loadSide())].filter(Boolean) : []));
    if (window.Peek && projectSuggFor !== id) {
      projectSuggFor = id;
      $("p-sugg").replaceChildren(Peek.suggestions(key, api, { open: (eid) => openMention(eid), openPlace: (x) => bridge && bridge.openPlace(x.kind, x.project, x.where),
        changed: (r) => { say(r.said || "Done"); projectSuggFor = null; loadSide().catch(failed); } }));
    }
  }
  // Its group: Tasks' own arrangement of the column, kept as it is chosen.
  function drawProjectGroup(p) {
    const b = el("button", { type: "button", class: "pick" + (p.group ? "" : " empty"), onclick: (e) => groupMenu(p, e.currentTarget) }, el("span", { class: "lbl" }, p.group || "No group"));
    $("p-group").replaceChildren(b);
  }
  function groupMenu(p, anchor) {
    if (Kit.openedBy() === anchor) { popAway(); return; }
    const names = [...new Set([...groupNames(), ...(p.group ? [p.group] : [])])].sort(byName);
    Kit.menu(anchor, [
      ...names.map((g) => ({ label: g, on: g === p.group, act: () => setGroup(p, g) })),
      ...(names.length ? ["sep"] : []),
      { label: "New group…", act: () => newGroup(p) },
      { label: "No group", on: !p.group, act: () => setGroup(p, null) }]);
  }
  // "New group…": the chip become a field; Enter or leaving it keeps the name, Escape does not.
  function newGroup(p) {
    const input = el("input", { type: "text", class: "ps-new", placeholder: "Group", spellcheck: "false" });
    let done = false;
    const finish = (keep) => {
      if (done) return;
      done = true;
      const v = input.value.trim();
      if (keep && v) setGroup(p, v); else drawProjectGroup(p);
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); finish(true); }
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); finish(false); }
    });
    input.addEventListener("blur", () => finish(true));
    $("p-group").replaceChildren(input);
    setTimeout(() => input.focus(), 0);
  }
  // Its wallpaper: the desktop's, changed as it is chosen (the bridge answers on wallpaperChanged).
  function drawProjectWall(p) {
    const ws = p.workspace;
    const can = Boolean(ws && bridge && typeof bridge.wallpaperOf === "function");
    $("p-wall-row").hidden = !can;
    if (!can) { onWallpaper = null; return; }
    const draw = (w) => {
      if (projectOn !== p.id || !w || w.project !== ws) return;
      const own = Boolean(w.own);
      $("p-wall").replaceChildren(
        el("img", { class: "ps-thumb", alt: "", src: `talaris-ui://wallpaper/?project=${enc(ws)}&t=${Date.now()}` }),
        el("span", { class: "ps-wall-side" },
          el("span", { class: "le-muted" }, own ? "Its own" : "The default"),
          el("span", { class: "ps-wall-acts" },
            el("button", { type: "button", class: "t-btn", onclick: () => bridge.chooseWallpaper(ws) }, "Choose…"),
            own ? el("button", { type: "button", class: "t-btn", onclick: () => bridge.defaultWallpaper(ws) }, "Use the default") : null)));
      if (w.error) failed(new Error(w.error));
    };
    onWallpaper = draw;
    bridge.wallpaperOf(ws, (text) => { try { draw(JSON.parse(text)); } catch (e) { failed(e); } });
  }
  // Archived: its folder to the archive, and out of every list — browsed and brought back from the archive. Asked twice.
  function archiveProject() {
    const p = projects.find((x) => x.id === projectOn);
    const b = $("p-archive");
    if (!p || !p.workspace || !bridge || typeof bridge.archiveProject !== "function") return;
    if (!Kit.ask(b, { ask: "Archive it?" })) return;
    bridge.archiveProject(p.workspace, (error) => {
      if (error) { failed(new Error(error)); return; }
      closeProject();
      refresh();
    });
  }

  function closeProject() {
    onWallpaper = null;
    projectOn = null;
    projectSuggFor = null;
    $("psheet").hidden = true;
  }
  async function paintProjectAbout(p, fresh) {
    // Written where its type keeps its description (the core says which, and whose it is); a project with no folder, as before.
    const got = p.workspace ? await api("GET", `/projects/${enc(p.workspace)}/about`).catch(() => null) : null;
    if (projectOn !== p.id) return;
    projectAbout = got ? got.about : (p.description || "");
    $("p-who").textContent = got ? (got.aboutByYou ? "Yours" : got.about ? "Morgan's, from its tasks" : "None yet — Morgan writes one from its tasks") : "";
    if (projectEd && (fresh || !$("p-desc").contains(document.activeElement)) && projectEd.text !== projectAbout) projectEd.set(projectAbout);
  }
  async function saveProjectAbout() {
    const p = projects.find((x) => x.id === projectOn);
    if (!p || !projectEd) return;
    const v = projectEd.text;
    if (v.trim() === (projectAbout || "").trim()) return;
    try {
      if (p.workspace) await api("PUT", `/projects/${enc(p.workspace)}/about`, { about: v });
      else await api("PATCH", `/entities/${enc(p.id)}`, { properties: { description: v.trim() ? v : null } });
      projectAbout = v;
      projectSuggFor = null;
      $("p-who").textContent = v.trim() ? "Yours — saved" : "Cleared — Morgan writes one from its tasks";
      say("Description saved; what it might be connected to is read again with it");
      await loadSide();
    } catch (e) { failed(e); }
  }
  async function saveProjectName() {
    const p = projects.find((x) => x.id === projectOn);
    const name = $("p-name").value.trim();
    if (!p || !p.workspace || !name || name === p.title) { if (p) $("p-name").value = p.title; return; }
    try { await api("PUT", `/projects/${enc(p.workspace)}/name`, { name }); await refresh(); } catch (e) { failed(e); $("p-name").value = p.title; }
  }
  $("p-close").innerHTML = Icons.close();
  $("p-close").addEventListener("click", () => { projectShut = true; closeProject(); });
  $("p-archive").addEventListener("click", archiveProject);
  $("p-name").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); $("p-name").blur(); }
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); const p = projects.find((x) => x.id === projectOn); if (p) $("p-name").value = p.title; $("p-name").blur(); }
  });
  $("p-name").addEventListener("blur", saveProjectName);
  async function loadEditing() {
    const id = editing;
    if (!id) return;
    const [got, r, f] = await Promise.all([api("GET", `/entities/${enc(id)}`),
      api("GET", `/tasks/${enc(id)}/recurrence`).catch(() => ({ rule: null, summary: "" })),
      api("GET", `/entities/${enc(id)}/folder`).catch(() => ({ folder: "" }))]);
    if (editing !== id) return;
    entity = got.entity;
    taskFolder = (f && f.folder) || "";
    rec = r || { rule: null, summary: "" };
    paintSheet();
  }
  // The folder of the project the task is filed under: a file linked from inside it is the project's.
  let taskFolder = "";
  // Set while a task's files are drawn: the note offering to move those linked from another folder into this project's.
  let offerMove = null;
  const props = () => (entity && entity.properties) || {};
  const focused = (id) => document.activeElement === $(id);
  const spanNow = () => (shape && shape.spanKey ? props()[shape.spanKey] : null) || {};

  // What the sheet holds, painted where it is not being typed in.
  function paintSheet() {
    if (!entity || !shape) return;
    const p = props();
    const value = String(p[shape.statusKey] ?? "");
    const complete = completeValues().includes(value);
    if (titleEd && !$("s-title").contains(document.activeElement) && titleEd.text !== (p[shape.titleKey] || "")) titleEd.set(p[shape.titleKey] || "");
    $("s-check").classList.toggle("on", complete);
    $("s-check").style.setProperty("--c", complete ? status(value).color : "var(--muted)");
    $("s-check").title = status(value).label;
    // Two statuses, one open and one done, say no more than the checkbox
    // beside the title does: the row shows only when there is more to choose.
    $("s-status-row").hidden = options().length <= 2;
    $("s-status").replaceChildren(...options().map((v) => el("button", { class: "tv-status" + (v === value ? " on" : ""), style: `--c:${status(v).color}`,
      onclick: () => setStatus(editing, v).catch(failed) }, el("span", { class: "tv-dot" }), status(v).label)));

    const sf = shape.spanKey ? field(shape.spanKey) : null;
    $("s-start-row").hidden = $("s-end-row").hidden = !shape.spanKey;
    $("s-start-l").textContent = (sf && sf.startLabel) || "Available";
    $("s-end-l").textContent = (sf && sf.endLabel) || "Due";
    const span = spanNow();
    for (const [part, id] of [["start", "s-start"], ["end", "s-end"]]) {
      const { day, time } = split(span[part]);
      $(id).replaceChildren(el("span", { class: "lbl" }, day ? shortDate(isoDay(day)) : "None"));
      $(id).classList.toggle("empty", !day);
      $(id).classList.toggle("overdue", part === "end" && !complete && day && (time == null ? isoDay(day) < isoDay(new Date()) : new Date(day.getTime() + time * 60000) < new Date()));
      if (!focused(`${id}-t`)) $(`${id}-t`).value = time != null ? timeLabel(time) : "";
    }

    $("s-rep").textContent = rec.summary || "Never";
    $("s-rep").classList.toggle("none", !rec.summary);

    const pk = projectKey();
    $("s-proj-row").hidden = !field(pk);
    const mine = Array.isArray(p[pk]) ? p[pk] : p[pk] ? [p[pk]] : [];
    const titleOf = (id) => (projects.find((x) => x.id === id) || {}).title || "Unknown";
    $("s-proj").replaceChildren(...mine.map((id) => el("span", { class: "chip" }, el("span", { class: "lbl" }, titleOf(id)),
      xBtn("Remove", () => setProjects(mine.filter((x) => x !== id))))),
    el("button", { class: "add", id: "s-proj-add", title: "Add to a project", onclick: (e) => pickProject(e.currentTarget, mine) }, "+"));

    const tags = entity.tags || [];
    $("s-tags").replaceChildren(...tags.map((t) => el("span", { class: "chip" }, el("span", { class: "lbl" }, `#${t}`),
      xBtn("Remove", () => update(editing, { tags: tags.filter((x) => x !== t) }).catch(failed)))));

    /*
     * Its files: a copy kept with it (attached), or a file linked where it is
     * (↗; links.ts) — opened in its application either way, the link's being
     * the file itself. A right-click turns one into the other: a link made a
     * copy, or a copy saved into the project's Files and linked. × takes it off
     * the task; a linked file stays where it is.
     */
    const fk = (type.fields.find((f) => f.kind === "attachment" && f.many) || {}).key;
    $("s-files-row").hidden = !fk;
    if (fk) {
      const files = Array.isArray(p[fk]) ? p[fk] : [];
      const id = editing;
      const after = () => { loadEditing(); refresh(); };
      /*
       * Where each file is, one of three: stored on this task only (a copy
       * Talaris keeps — removing it deletes it); in this project's folder (a
       * link to the file there); or linked from another folder. A linked
       * file gone from its folder is said so. Right-click moves it between
       * them; removing one stored on the task only asks first.
       */
      const placeOf = (a) => {
        const link = a["talaris:link"];
        if (!link) return "task";
        return taskFolder && link.path.startsWith(taskFolder.replace(/\/$/, "") + "/") ? "project" : "elsewhere";
      };
      const dirOf = (p) => p.replace(/\/[^/]*$/, "").replace(/^\/home\/[^/]+/, "~");
      const projectName = taskFolder.replace(/\/$/, "").split("/").pop() || "this project";
      const attachment = (a, verb) => api("POST", `/entities/${enc(id)}/attachments/${enc(a.sha256)}/${verb}`, {}).then(after).catch(failed);
      // Each asks once more in a menu of its own where it was pressed: what will happen, said, and keeping it as it is.
      const confirmAt = (x, y, label, act) => menuAt(x, y, [{ label, act }, { label: "Keep it as it is", act: () => {} }]);
      const askMove = (x, y, a) => confirmAt(x, y, `Move “${a.filename}” from ${dirOf(a["talaris:link"].path)} into ${projectName}'s folder`, () => attachment(a, "move"));
      const askTrash = (x, y, a) => confirmAt(x, y, `Delete “${a.filename}” from ${dirOf(a["talaris:link"].path)} (to the Trash)`, () => attachment(a, "trash"));
      offerMove = () => {
        const away = files.filter((a) => placeOf(a) === "elsewhere" && !a["talaris:missing"]);
        if (!away.length) return;
        const b = el("button", { class: "t-btn", onclick: (e) => {
          const r = e.currentTarget.getBoundingClientRect();
          confirmAt(r.left, r.bottom + 4, `Move ${away.length === 1 ? `“${away[0].filename}”` : `these ${away.length} files`} into ${projectName}'s folder`,
            () => Promise.all(away.map((a) => api("POST", `/entities/${enc(id)}/attachments/${enc(a.sha256)}/move`, {}))).then(after).catch(failed));
        } }, "Move into this project's folder…");
        filesNote(`Linked from ${dirOf(away[0]["talaris:link"].path)}${away.length > 1 ? " and elsewhere" : ""}. `, false, b);
      };
      const fileMenu = (e, a) => {
        e.preventDefault();
        e.stopPropagation();
        const link = a["talaris:link"];
        const toTask = { label: "Store on this task only", act: () => attachment(a, "snapshot") };
        menuAt(e.clientX, e.clientY, link ? [
          ...(a["talaris:missing"] ? [] : [toTask]),
          ...(placeOf(a) === "elsewhere" && !a["talaris:missing"] ? [{ label: "Move into this project's folder…", act: () => askMove(e.clientX, e.clientY, a) }] : []),
          { label: "Show in its folder", act: () => bridge && bridge.showLinked(link.path) },
        ] : [
          { label: "Save to this project's folder", act: () => api("POST", `/entities/${enc(id)}/attachments/${enc(a.sha256)}/link`, {}).then(after).catch(failed) },
        ]);
      };
      const ICON = { task: Icons.clip, project: Icons.folder, elsewhere: Icons.linked };
      const icon = (svg) => { const s = el("span", { class: "fic" }); s.innerHTML = svg(); return s; };
      $("s-files").replaceChildren(
        ...files.map((a) => {
          const link = a["talaris:link"], missing = a["talaris:missing"], where = placeOf(a);
          const said = missing ? `${a.filename} — missing from ${dirOf(link.path)}. Restore missing files puts it back`
            : where === "task" ? `${a.filename} — stored on this task only. Right-click to save it to this project's folder`
            : where === "project" ? `${a.filename} — in this project's folder (${dirOf(link.path)})`
            : `${a.filename} — linked from ${dirOf(link.path)}`;
          // Removing one stored on the task only deletes it: the × asks once more ("Delete?") before it does.
          // One in a folder: taken off the task, the file staying where it is — or, asked again, deleted to the Trash.
          const x = el("button", { class: "x-btn", title: where === "task" ? "Delete it — it is stored on this task only" : "Take it off the task, or delete the file", onclick: (e) => {
            e.stopPropagation();
            if (where !== "task") {
              const r = e.currentTarget.getBoundingClientRect();
              menuAt(r.left, r.bottom + 4, [
                { label: `Take off the task — it stays in ${where === "project" ? `${projectName}'s folder` : dirOf(link.path)}`,
                  act: () => api("DELETE", `/tasks/${enc(id)}/attachments/${enc(a.sha256)}`).then(after).catch(failed) },
                ...(missing ? [] : [{ label: "Delete the file…", act: () => askTrash(r.left, r.bottom + 4, a) }]),
              ]);
              return;
            }
            if (!Kit.ask(x, { ask: "Delete it?" })) return;
            api("DELETE", `/tasks/${enc(id)}/attachments/${enc(a.sha256)}`).then(after).catch(failed);
          } });
          x.innerHTML = Icons.close();
          return el("span", { class: `chip at-${where}` + (missing ? " missing" : ""), title: said,
            onclick: () => { if (!bridge) return; if (link) { if (!missing) bridge.openLinked(link.path); } else bridge.openFile(a.sha256, a.filename); },
            oncontextmenu: (e) => fileMenu(e, a) },
            missing ? el("span", { class: "warn-mark" }, "⚠") : icon(ICON[where]),
            el("span", { class: "lbl" }, a.filename),
            x);
        }),
        el("button", { class: "add", title: "Attach files (stored on this task)", onclick: () => { filesNote(""); bridge && bridge.attach(editing); } }, "+"),
        el("button", { class: "add link-add", title: "Link files where they are", onclick: () => { filesNote(""); bridge && bridge.link(editing); } }, "↗"),
        el("span", { id: "s-files-note" }));
    }
    if (notesEd && !$("s-notes").contains(document.activeElement) && notesEd.text !== (p[notesKey()] || "")) notesEd.set(p[notesKey()] || "");
    const stamp = split(p[shape.doneKey]);
    $("s-done").textContent = stamp.day ? `Done ${Kit.day(stamp.day, { weekday: false })}${stamp.time != null ? ` · ${timeLabel(stamp.time)}` : ""}` : "";
    $("s-archive").textContent = entity.archived ? "Unarchive" : "Archive";
    // Where else it lives (a sync's way back), beside its own buttons.
    // And what plugins put on a task (Sync now).
    // A plugin's button done (a file restored, say): the task read again, so what changed shows.
    // What it might be tied to and is not (suggest.ts): asked once each time another task is opened, and after a tie.
    if (window.Peek && suggFor !== editing) {
      suggFor = editing;
      $("s-sugg").replaceChildren(Peek.suggestions(`e:${editing}`, api, { open: (id) => openMention(id), openPlace: (p) => bridge && bridge.openPlace(p.kind, p.project, p.where),
        changed: (r) => { say(r.said || "Done"); suggFor = null; loadEditing(); } }));
    }
    $("s-elsewhere").replaceChildren(...(window.Peek ? [...Peek.elsewhereButtons(entity, (u) => bridge && bridge.openUrl(u)), Peek.actionButtons("task", editing, api, "t-btn", () => loadEditing()),
      Peek.glanceButton(`e:${editing}`, bridge && bridge.glanceAt ? (k) => bridge.glanceAt(k) : null)].filter(Boolean) : []));
  }

  // Title and notes are the editor, so @ names anything in them (mentions.js);
  // a mention clicked opens a task here, or peeks at anything else.
  let titleEd = null, notesEd = null;
  let suggFor = null;   // the task whose suggestions are drawn
  const openPlace = (p) => bridge && bridge.openPlace(p.kind, p.project, p.where);
  async function openMention(id) {
    try {
      const got = await api("GET", `/entities/${enc(id)}`);
      if ((got.kinds || []).includes("task")) { openTask(id); return; }
      // A page or a canvas: opened where it lives.
      const place = await api("GET", `/entities/${enc(id)}/place`);
      if (place) { openPlace(place); return; }
    } catch { /* gone: peek says so */ }
    if (window.Peek) Peek.show(id, api, { onTask: openTask, openTask, openPlace, openPerson: (pid) => bridge && bridge.openPerson(pid),
      openEvent: (c, u, s) => bridge && bridge.openEvent(c, u, s), openUrl: (u) => bridge && bridge.openUrl(u) });
  }
  function saveTitle() {
    if (!entity || !shape || !titleEd) return;
    const v = titleEd.text.trim();
    if (v && v !== (props()[shape.titleKey] || "")) update(editing, { properties: { [shape.titleKey]: v } }).catch(failed);
    else if (!v) titleEd.set(props()[shape.titleKey] || "");
  }
  function saveNotes() {
    if (!entity || !notesEd) return;
    const key = notesKey(), v = notesEd.text;
    if (v !== (props()[key] || "")) update(editing, { properties: { [key]: v || null } }).catch(failed);
  }
  import("./editor.js").then((m) => {
    const mentions = TalarisMentions(api, openMention);
    quickEd = m.createEditor($("quick"), "", { live: true, compact: true, singleLine: true, placeholder: "Add a task", mentions, onEnter: () => { addQuick(); } });
    titleEd = m.createEditor($("s-title"), "", { live: true, compact: true, singleLine: true, mentions, onEnter: () => { saveTitle(); $("s-title").querySelector(".cm-content")?.blur(); } });
    notesEd = m.createEditor($("s-notes"), "", { live: true, compact: true, mentions });
    projectEd = m.createEditor($("p-desc"), "", { live: true, compact: true, mentions, placeholder: "What the project is for" });
    $("p-desc").addEventListener("focusout", saveProjectAbout);
    if (projectOn) { const p = projects.find((x) => x.id === projectOn); if (p) paintProjectAbout(p, true); }
    $("s-title").addEventListener("focusout", saveTitle);
    $("s-notes").addEventListener("focusout", saveNotes);
    if (entity) paintSheet();
  }).catch(failed);
  $("s-check").addEventListener("click", () => {
    if (!entity) return;
    const complete = completeValues().includes(String(props()[shape.statusKey] ?? ""));
    setStatus(editing, complete ? reopenValue() : doneValue()).catch(failed);
  });
  $("s-close").innerHTML = Icons.close();
  $("s-close").addEventListener("click", closeSheet);

  // Search (drawSearch): as it is typed, a moment after; Escape empties it; Ctrl+F comes to it.
  let searchTimer = 0;
  // Escape clears it first, as every box that narrows a list does (kit.js).
  Kit.searchBox($("search"));
  $("search").addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { searching = $("search").value.trim(); drawView(); }, Kit.SEARCH_MS);
  });
  $("search").addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || !$("search").value) return;
    e.stopPropagation();
    $("search").value = "";
    searching = "";
    drawView();
  });
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") { e.preventDefault(); $("search").focus(); $("search").select(); }
  });

  $("s-archive").addEventListener("click", () => { if (entity) update(editing, { archived: !entity.archived }).catch(failed); });

  // Dates: the whole datespan sent each time, null when nothing is left of it.
  function setPart(part, value) {
    const next = { ...spanNow() };
    if (value) next[part] = value; else delete next[part];
    return update(editing, { properties: { [shape.spanKey]: next.start || next.end ? next : null } }).catch(failed);
  }
  for (const [part, id] of [["start", "s-start"], ["end", "s-end"]]) {
    $(id).addEventListener("click", (ev) => {
      ev.stopPropagation();
      if (!entity) return;
      if (Kit.openedBy() === $(id)) { popAway(); return; }
      const { day, time } = split(spanNow()[part]);
      // The month, and the quick days every picker has (kit.js), counted from the day set; Clear takes it off.
      popUnder($(id), monthPicker(day, (d) => setPart(part, d ? join(d, time) : null), { chips: Kit.DAY_CHIPS(day), clear: true }));
    });
    // A time is optional: typed, or chosen from the list; emptied, the date stays.
    const tin = $(`${id}-t`);
    const setTime = (m) => {
      const { day } = split(spanNow()[part]);
      setPart(part, join(day || startOfDay(new Date()), m));
    };
    tin.addEventListener("focus", () => {
      if (!entity) return;
      popUnder(tin, timeList(split(spanNow()[part]).time, (m) => { tin.blur(); setTime(m); }));
    });
    tin.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); tin.blur(); } });
    tin.addEventListener("change", () => {
      if (!entity) return;
      const text = tin.value.trim();
      const { day, time } = split(spanNow()[part]);
      if (!text) { if (day && time != null) setPart(part, join(day, null)); return; }
      const m = parseTime(text);
      if (m == null) { tin.value = time != null ? timeLabel(time) : ""; return; }
      setTime(m);
    });
  }

  // Projects: a small search over the ones there are.
  function setProjects(ids) {
    return update(editing, { properties: { [projectKey()]: ids.length ? ids : null } }).catch(failed);
  }
  function pickProject(anchor, mine) {
    if (Kit.openedBy() === anchor) { popAway(); return; }
    const find = Kit.searchBox(el("input", { type: "search", class: "kit-filter", placeholder: "Project", spellcheck: "false" }));
    const list = el("div", { class: "menu-list" });
    const candidates = () => projects.filter((p) => !p.archived && !mine.includes(p.id) && Kit.matches(find.value, p.title));
    const draw = () => list.replaceChildren(...candidates().map((p) => el("button", { class: "menu-item", onclick: (e) => { e.stopPropagation(); popAway(); setProjects([...mine, p.id]); } }, p.title)));
    find.addEventListener("input", draw);
    find.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { const first = candidates()[0]; if (first) { popAway(); setProjects([...mine, first.id]); } }
    });
    draw();
    popUnder(anchor, el("div", {}, find, list));
    setTimeout(() => find.focus(), 0);
  }

  // Tags: typed, Enter or a comma; Backspace in an empty field takes the last.
  $("s-tag-in").addEventListener("keydown", (e) => {
    if (!entity) return;
    const tags = entity.tags || [];
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      const t = $("s-tag-in").value.trim().replace(/^#/, "").replace(/,$/, "");
      $("s-tag-in").value = "";
      if (t && !tags.includes(t)) update(editing, { tags: [...tags, t] }).catch(failed);
    }
    if (e.key === "Backspace" && !$("s-tag-in").value && tags.length) update(editing, { tags: tags.slice(0, -1) }).catch(failed);
  });

  // ---------------------------------------------------------------- Repeat's editor
  //
  // The format's rule: {anchor, freq, interval, byWeekday?, monthEnd?, end}.
  // Begun from the rule there is, so anything this editor does not show (a
  // day of the month) is kept as it was.

  const DAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
  const UNITS = { daily: ["day", "days"], weekly: ["week", "weeks"], monthly: ["month", "months"], yearly: ["year", "years"] };
  const dayOfTask = () => split(spanNow().end || spanNow().start).day || startOfDay(new Date());

  function openRep() {
    rep = rec.rule ? JSON.parse(JSON.stringify(rec.rule)) : { anchor: "schedule", freq: "weekly", interval: 1, end: { type: "never" } };
    if (!rep.end) rep.end = { type: "never" };
    $("r-err").textContent = "";
    $("rep").hidden = false;
    $("r-n").value = String(rep.interval || 1);
    paintRep();
  }
  function closeRep() { rep = null; $("rep").hidden = true; }
  function paintRep() {
    if (!rep) return;
    const n = parseInt($("r-n").value, 10) || 1;
    seg("r-anchor", [["schedule", "Scheduled date"], ["completion", "Completion"]], rep.anchor, (v) => { rep.anchor = v; paintRep(); });
    seg("r-freq", Object.entries(UNITS).map(([f, w]) => [f, w[n === 1 ? 0 : 1]]), rep.freq, (v) => { rep.freq = v; paintRep(); });
    $("r-days-row").hidden = !(rep.freq === "weekly" && rep.anchor === "schedule");
    const on = rep.byWeekday && rep.byWeekday.length ? rep.byWeekday : [DAYS[dayOfTask().getDay()]];
    $("r-days").replaceChildren(...DAYS.map((d, i) => el("button", { class: on.includes(d) ? "on" : "", onclick: (e) => {
      e.stopPropagation();
      const now = new Set(on);
      if (now.has(d) && now.size > 1) now.delete(d); else now.add(d);
      rep.byWeekday = DAYS.filter((x) => now.has(x));
      paintRep();
    } }, "SMTWTFS"[i])));
    $("r-short-row").hidden = !["monthly", "yearly"].includes(rep.freq);
    seg("r-short", [["clamp", "Last day"], ["skip", "Skip"]], rep.monthEnd || "clamp", (v) => { rep.monthEnd = v; paintRep(); });
    seg("r-end", [["never", "Never"], ["after", "After"], ["on", "On"]], rep.end.type, (v) => {
      rep.end = v === "after" ? { type: "after", count: rep.end.count || 10 } : v === "on" ? { type: "on", date: rep.end.date || isoDay(addDays(dayOfTask(), 90)) } : { type: "never" };
      paintRep();
    });
    $("r-count").hidden = rep.end.type !== "after";
    if (!focused("r-count")) $("r-count").value = String(rep.end.count || 10);
    $("r-until").hidden = rep.end.type !== "on";
    $("r-until").replaceChildren(el("span", { class: "lbl" }, rep.end.type === "on" ? shortDate(rep.end.date) : ""));
  }
  $("s-rep-btn").addEventListener("click", () => { if (!entity) return; if (rep) closeRep(); else openRep(); });
  $("r-n").addEventListener("input", () => { if (rep) paintRep(); });
  $("r-count").addEventListener("change", () => { const c = parseInt($("r-count").value, 10); if (rep && c > 0) rep.end = { type: "after", count: c }; paintRep(); });
  $("r-until").addEventListener("click", (ev) => {
    ev.stopPropagation();
    if (!rep) return;
    if (Kit.openedBy() === $("r-until")) { popAway(); return; }
    popUnder($("r-until"), monthPicker(split(rep.end.date).day, (d) => { rep.end = { type: "on", date: isoDay(d) }; paintRep(); }));
  });
  $("r-cancel").addEventListener("click", closeRep);
  // The core says why a rule will not do (a weekday counted from completion,
  // say); that is shown as it is said.
  async function putRule(rule) {
    try {
      await api("PUT", `/tasks/${enc(editing)}/recurrence`, { rule });
      closeRep();
      await refresh();
      await loadEditing();
    } catch (e) { $("r-err").textContent = e.message; }
  }
  $("r-save").addEventListener("click", () => {
    if (!rep) return;
    const rule = { ...rep, interval: Math.max(1, parseInt($("r-n").value, 10) || 1) };
    if (rule.freq === "weekly" && rule.anchor === "schedule") {
      if (!rule.byWeekday || !rule.byWeekday.length) rule.byWeekday = [DAYS[dayOfTask().getDay()]];
    } else delete rule.byWeekday;
    if (["monthly", "yearly"].includes(rule.freq)) rule.monthEnd = rule.monthEnd || "clamp";
    else delete rule.monthEnd;
    if (rule.end.type === "after") rule.end = { type: "after", count: Math.max(1, parseInt($("r-count").value, 10) || rule.end.count || 1) };
    putRule(rule);
  });
  $("r-none").addEventListener("click", () => putRule(null));

  // ---------------------------------------------------------------- keys and buttons

  const typing = (t) => t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
  document.addEventListener("keydown", (e) => {
    // The list editor and the views keep their own Escape, and say so.
    if (e.defaultPrevented) return;
    if (e.key === "Escape") {
      e.preventDefault();
      if (!!Kit.isOpen()) popAway();
      else if (rep) closeRep();
      else if (editing) closeSheet();
      else if (bridge) bridge.file();
      return;
    }
    if (e.key === "n" && !e.ctrlKey && !e.metaKey && !e.altKey && !typing(document.activeElement)) {
      e.preventDefault();
      $("quick").querySelector(".cm-content")?.focus();
    }
  });

  $("edit-list").addEventListener("click", () => {
    if (!shown || !current) return;
    if (current.kind === "list") editList(shown.list);
  });

  // The left column, out or away — this page's own preference, kept.
  $("side-toggle").innerHTML = Icons.sideList();
  function sideShown(on) {
    document.body.classList.toggle("no-side", !on);
    $("side-toggle").classList.toggle("on", on);
    $("side-toggle").title = on ? "Hide the sidebar" : "Show the sidebar";
    store.set("talaris.tasks.side", on);
  }
  let sideOn = store.get("talaris.tasks.side", true) !== false;
  sideShown(sideOn);
  $("side-toggle").addEventListener("click", () => { sideOn = !sideOn; sideShown(sideOn); });

  // A panel's one button makes it a window (the expand corners); a window's one
  // button closes it.
  $("grow").addEventListener("click", () => bridge && bridge.grow());
  $("close").addEventListener("click", () => bridge && bridge.closeWindow());
  $("grow").innerHTML = Icons.grow();
  $("grow").title = "Make it a window";
  $("grow").hidden = WINDOW;
  $("close").innerHTML = Icons.close();
  $("close").title = "Close";
  $("close").hidden = !WINDOW;
  // A press on the dim, off the panel, puts it away (and from Qt, which hears every press).
  document.addEventListener("pointerdown", (e) => { if (!WINDOW && e.target === document.documentElement && bridge && surface.up) bridge.file(); });
  window.pressedAt = (x, y) => { if (!WINDOW && bridge && surface.up && document.elementFromPoint(x, y) === document.documentElement) bridge.file(); };
  // In use: the panel's idle timer starts again.
  for (const t of ["pointerdown", "keydown", "wheel"]) addEventListener(t, () => bridge && bridge.activity(), { capture: true, passive: true });

  // ---------------------------------------------------------------- coming and going

  function how() {
    const m = surface.motion || {};
    return { kind: m.motion, speed: m.speed, edge: "top", flush: false, viewport: surface.viewport,
      shown: () => bridge && bridge.drawn(),
      rules: (rule, rel, P) => { const h = document.querySelector("header").getBoundingClientRect(); rule(rel(P.left, h.bottom), rel(P.right, h.bottom)); } };
  }
  function onState(s) {
    const was = surface;
    surface = s;
    // What plugins put on the whole list (Sync all …), asked again each time it is out: a setting may have changed.
    if ((s.up && !was.up) || (WINDOW && !was.theme)) $("list-actions").replaceChildren(window.Peek ? Peek.actionButtons("tasks", null, api, "t-btn", null, (b, said) => drawAsks().then(() => chooseAsks(b, said))) : "");
    if (WINDOW) return;
    if (s.up && !was.up) {
      Motion.arrive(document.body, how());
      if (bridge) refresh();
    }
  }

  Surface.connect({ onState }).then((b) => {
    bridge = b;
    b.coreReply.connect((text) => asked.reply(JSON.parse(text)));
    // A project's wallpaper chosen or given up: the open sheet shows it.
    if (b.wallpaperChanged) b.wallpaperChanged.connect((text) => { if (onWallpaper) onWallpaper(JSON.parse(text)); });
    // Files chosen and kept (or why not): the open task drawn again with them.
    b.attached.connect((text) => {
      const r = JSON.parse(text);
      if (r.task === editing) loadEditing().then(() => {
        filesNote(r.error || "", Boolean(r.error));
        // Linked from another folder: offered a move into this project's, then and there.
        if (r.linked && !r.error && offerMove) offerMove();
      }).catch(failed);
      refresh();
    });
    b.leave.connect(() => {
      // The panel's leaving; a window is not going anywhere.
      if (WINDOW) return;
      surface = { ...surface, up: false };
      popAway();
      const going = Motion.leave(document.body, how());
      if (going) going.onfinish = () => bridge.left(); else bridge.left();
    });
    start();
  });

  // What the other two parts may call (TASKS-CONTRACT.md). The type and the
  // projects are read as they are now, not as they were when first asked.
  window.Tasks = {
    api, status, openTask, update, setStatus, refresh, newTask,
    get taskType() { return type; },
    get projects() { return projects; },
  };
})();
