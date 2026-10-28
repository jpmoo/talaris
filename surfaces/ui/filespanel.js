// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore
//
// The Files panel's page (files_panel.py): every file in the projects, and
// what Talaris holds for them, each row saying what it is — in the folder, a
// writing page, a shortcut, linked on a task, a snapshot, missing (the core's
// files.ts). The list is asked of the core again whenever the core says
// something changed (`/files/version`, watched folders), never polled from disk.

"use strict";

(() => {
  const $ = (id) => document.getElementById(id);
  function el(tag, attrs = {}, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
      else if (k === "class") e.className = v;
      else if (k === "style") e.setAttribute("style", v);
      else if (k === "value") e.value = v;
      else e.setAttribute(k, v);
    }
    for (const k of kids.flat()) if (k != null && k !== "" && k !== false) e.append(k);
    return e;
  }
  function seg(host, choices, current, pick) {
    $(host).replaceChildren(...choices.map(([value, label]) =>
      el("button", { class: value === current ? "on" : "", onclick: () => pick(value) }, label)));
  }
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* fine */ } },
  };

  let bridge = null;
  let surface = { up: false };
  const WINDOW = new URLSearchParams(location.search).has("window");
  if (WINDOW) document.documentElement.dataset.window = "1";

  // What is shown: a project ("" is all of them), a view, and the filters.
  let view = store.get("talaris.files.view", "folders");
  let project = null;
  let filters = { q: "", status: "", type: "", days: 0, tags: [], list: "" };
  // The chosen project's lists (the core's filelists.ts), as a tree; and the lists of each project asked for, by id.
  let lists = [];
  const listsOf = new Map();
  let kept = store.get("talaris.files.kept", []);
  let projects = [];
  let rows = [];
  // Read or not: all, read (green), or not (grey waiting, red unreadable or with nothing in it).
  let readFilter = store.get("talaris.files.read", "all");
  // Picked with Shift or Ctrl (or ⌘): several at once, acted on together; the last picked plainly, the anchor for Shift.
  const picked = new Set();
  let anchor = null;
  let order = [];   // the keys as drawn, top to bottom: what Shift picks between
  let watched = [];
  let counts = null;  // how many of each thing the left side lists (/files/counts)   // the folders linked into the project shown, watched for new files
  // How far search has read each file (the core's meaning.ts): `waiting` until it has; and whether it reads at all.
  let readState = {};
  let readAbout = {};   // what each read file is about (its description, or its first words): the book's tip
  let reading = { on: false, pending: 0, indexing: false };
  let total = 0;
  let chosen = null;
  let version = -1;

  // ---------------------------------------------------------------- the core

  const waiting = new Map();
  let reqNext = Math.floor(Math.random() * 1e9);
  function api(method, path, body) {
    return new Promise((ok, fail) => {
      if (!bridge) { fail(new Error("Not connected")); return; }
      const id = String(++reqNext);
      waiting.set(id, (r) => (r.status >= 200 && r.status < 300 ? ok(r.data)
        : fail(new Error((r.data && r.data.error) || `the core answered ${r.status}`))));
      bridge.core(id, method, path, body === undefined ? "" : JSON.stringify(body));
    });
  }
  const enc = encodeURIComponent;
  function say(text, error = false) { $("msg").textContent = text || ""; $("msg").className = error ? "err" : ""; }
  const failed = (e) => say(e.message, true);

  // ---------------------------------------------------------------- words

  const STATUS = { folder: "In the folder", page: "A writing page", canvas: "A canvas", conversation: "A conversation with Morgan", shortcut: "Shortcut", linked: "Linked on a task",
    snapshot: "Stored on a task", missing: "Missing from its folder" };
  // A row says only where its file really is, when that is not simply the project's folder: a shortcut, a link, a copy
  // stored on a task, gone missing. A page is plain from its group (Writing) and Open; what it is on, and whether it is
  // read, are the details' to say, not the list's.
  const MARK = { shortcut: "↗ shortcut", linked: "↗ linked", snapshot: "stored on a task", missing: "missing" };
  const TYPES = [["page", "Pages"], ["canvas", "Canvases"], ["conversation", "Conversations"], ["document", "Documents"], ["spreadsheet", "Spreadsheets"], ["presentation", "Presentations"], ["pdf", "PDFs"], ["image", "Images"],
    ["audio", "Audio"], ["video", "Video"], ["code", "Code"], ["archive", "Archives"], ["other", "Other"]];
  const TYPE_WORD = Object.fromEntries(TYPES);
  const TYPE_ONE = { page: "Page", canvas: "Canvas", conversation: "Conversation", document: "Document", spreadsheet: "Spreadsheet", presentation: "Presentation",
    pdf: "PDF", image: "Image", audio: "Audio", video: "Video", code: "Code", archive: "Archive", other: "Other" };
  // A canvas or a thread is not a file: its row's mark says what it is, as an extension does a file's.
  const MARK_OF = { canvas: "CNV", conversation: "TLK" };
  const TYPE_COLOR = { document: "#7f9fbf", spreadsheet: "#8aa878", presentation: "#c98a5b", pdf: "#c26b6b", image: "#b97f8e", audio: "#5fa4b5",
    video: "#6c7277", code: "#868c92", archive: "#c7a55a", other: "#9a9a9a", canvas: "#8f86c4", conversation: "#5f9e8f" };
  const ON_KIND = { task: "task", contact: "person", event: "event", note: "note", project: "project", thing: "thing" };
  // What is only in Home, in no other project: chosen as a project is, below All projects (files.ts, NO_PROJECT).
  const NONE = "~none";
  const projectName = (id) => (id === NONE ? "No project" : (projects.find((p) => p.id === id) || {}).name || "a project");
  /** One project chosen: not all of them, nor what is in none. */
  const oneProject = () => Boolean(project) && project !== NONE;
  const size = (n) => (n == null ? "" : n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`);
  function when(iso) {
    if (!iso) return "";
    return Kit.ago(iso);
  }
  function dateGroup(iso) {
    if (!iso) return "No date";
    const age = (Date.now() - Date.parse(iso)) / 86_400_000;
    const d = new Date(iso), today = new Date();
    if (d.toDateString() === today.toDateString()) return "Today";
    if (age < 7) return "This week";
    if (age < 31) return "This month";
    return "Earlier";
  }
  /** Where a file is, in words: its folder in the project, or where it lives elsewhere. */
  function whereOf(r) {
    if (r.path) return r.path.includes("/") ? r.path.slice(0, r.path.lastIndexOf("/")) : "";
    if (r.abs) return r.abs.replace(/^\/home\/[^/]+/, "~").replace(/\/[^/]*$/, "");
    return "";
  }

  /** A tree of lists, flat: each with its depth and the names it is inside. */
  function flat(tree, depth = 0, path = []) {
    return tree.flatMap((l) => [{ ...l, depth, path }, ...flat(l.children, depth + 1, [...path, l.name])]);
  }
  /** A project's lists, asked once and kept until the next load. */
  async function listsFor(projectId) {
    if (!listsOf.has(projectId)) listsOf.set(projectId, await api("GET", `/files/lists?project=${enc(projectId)}`).catch(() => []));
    return listsOf.get(projectId);
  }
  const listName = (id) => (flat(lists).find((l) => l.id === id) || {}).name || "the list";

  // ---------------------------------------------------------------- loading

  async function loadProjects() {
    // The pages of no other project are Home's, in its Pages.
    projects = await api("GET", "/projects");
  }

  async function load() {
    const q = new URLSearchParams();
    if (project) q.set("project", project);
    if (filters.q) q.set("q", filters.q);
    if (filters.status) q.set("status", filters.status);
    if (filters.type) q.set("type", filters.type);
    if (filters.days) q.set("days", String(filters.days));
    for (const t of filters.tags) q.append("tag", t);
    const inProject = oneProject();
    if (filters.list && inProject) q.set("list", filters.list);
    q.set("sort", view === "date" ? "date" : "name");
    const got = await api("GET", `/files?${q}`);
    watched = inProject ? await api("GET", `/files/folders?project=${enc(project)}`).catch(() => []) : [];
    counts = await api("GET", `/files/counts${project ? `?project=${enc(project)}` : ""}`).catch(() => counts);
    lists = inProject ? await api("GET", `/files/lists?project=${enc(project)}`).catch(() => []) : [];
    if (inProject) listsOf.set(project, lists);
    if (filters.list && !flat(lists).some((l) => l.id === filters.list)) filters.list = "";
    readState = got.read || {};
    readAbout = got.about || {};
    reading = got.reading || reading;
    // Read or not (the book's colour): green, or grey and red — told here, from what the core says of each.
    const readOk = (r) => readFilter === "all" || (readFilter === "read" ? readState[r.key] === "read" : readState[r.key] && readState[r.key] !== "read");
    rows = got.rows.filter(readOk);
    total = readFilter === "all" ? got.total : rows.length;
    for (const k of [...picked]) if (!rows.some((r) => r.key === k)) picked.delete(k);
    version = got.version;
    if (chosen && !rows.some((r) => r.key === chosen)) chosen = null;
    draw();
    if (got.unwatched.length) say(`Too large to watch, read when asked: ${got.unwatched.map(projectName).join(", ")}`);
  }
  const reload = () => load().catch(failed);

  // Looked at again when the core says something changed, while it is out.
  setInterval(async () => {
    if (!bridge || !(surface.up || WINDOW)) return;
    try {
      const v = await api("GET", "/files/version");
      if (v.version !== version) await load();
      // Files still to be read: looked at again now and then, to see them read.
      else if (reading.pending && ++sinceRead >= 5) { sinceRead = 0; await load(); }
    } catch { /* the core is away for a moment */ }
  }, 2000);
  let sinceRead = 0;

  // ---------------------------------------------------------------- drawing

  function draw() {
    drawSide();
    drawRows();
    drawDetail();
    $("count").textContent = total > rows.length ? `${rows.length} of ${total}` : String(total);
    // Still to be read, across what is listed: said beside the count.
    const waiting = rows.filter((r) => readState[r.key] === "waiting").length;
    if (waiting) $("count").textContent += ` · ${waiting} not read yet`;
  }

  // Sections of the left side folded away, and lists folded on the lists inside them: kept between visits.
  const folded = new Set(store.get("talaris.files.folded", []));
  function fold(key) {
    if (folded.has(key)) folded.delete(key); else folded.add(key);
    store.set("talaris.files.folded", [...folded]);
    drawSide();
  }

  function drawSide() {
    const here = surface.project;
    // Each with how many there are (the core's /files/counts): in each project; and, in the project chosen, of each kind.
    const item = (label, on, onclick, extra, count) => el("button", { class: `s-item${on ? " on" : ""}`, onclick }, el("span", { class: "nm" }, label), extra,
      count !== undefined ? el("span", { class: "n" }, String(count)) : null);
    // A section: its heading folds it; folded, only what is chosen in it still shows, so a filter on is never out of sight.
    const section = (key, title, items, extra = null) => {
      const shut = folded.has(key);
      const head = el("div", { class: `s-head fold${shut ? " shut" : ""}`, title: shut ? "Show" : "Fold away", onclick: () => fold(key) },
        el("span", { class: "tw" }, "›"), el("span", { class: "s-title" }, title), extra);
      return [head, ...(shut ? items.filter((x) => x && x.classList.contains("on")) : items)];
    };
    const c = counts || { all: undefined, projects: {}, status: {}, type: {}, tags: {} };
    const tagsHere = [...new Set(rows.flatMap((r) => r.tags))].sort();
    const shown = [...new Set([...tagsHere, ...filters.tags])];
    // Lists inside a folded list are not shown; the folded one says so with its twist.
    const listRows = [];
    const walkLists = (nodes, depth) => {
      for (const l of nodes) {
        const has = l.children.length > 0;
        const shut = folded.has(`list:${l.id}`);
        const tw = el("span", { class: `tw${has ? "" : " none"}`, onclick: has ? (e) => { e.stopPropagation(); fold(`list:${l.id}`); } : null }, has ? "›" : "");
        if (has && !shut) tw.classList.add("open");
        const b = item(l.name, filters.list === l.id, () => { filters.list = filters.list === l.id ? "" : l.id; chosen = null; picked.clear(); reload(); }, null, l.count);
        b.prepend(tw);
        b.style.paddingLeft = `${8 + depth * 14}px`;
        dropOnList(b, { ...l, depth });
        listRows.push(b);
        if (has && !shut) walkLists(l.children, depth + 1);
      }
    };
    if (oneProject()) walkLists(lists, 0);
    $("side").replaceChildren(...[
      ...section("projects", "Projects", [
        item("All projects", project === "", () => setProject(""), null, c.all),
        item("No project", project === NONE, () => setProject(NONE), null, c.none ?? 0),
        ...projects.map((p) => item(p.name, project === p.id, () => setProject(p.id), p.id === here ? el("span", { class: "here" }, "here") : null, c.projects[p.id] ?? 0))]),
      // The folders linked into this project, watched for new files: each let go of by its ×.
      ...(watched.length ? section("watched", "Watched folders", watched.map((f) => el("div", { class: "s-item s-watch", title: `${f.folder}${f.exists ? "" : " — not there now"}` },
        el("span", { class: "nm" }, f.folder.replace(/^\/home\/[^/]+/, "~")),
        el("button", { class: "s-x", title: "Stop watching it (what is linked stays)", onclick: async () => {
          try { await api("DELETE", `/files/folder?project=${enc(f.project)}&path=${enc(f.folder)}`); say(`${f.folder.split("/").pop()} no longer watched; what was linked stays`); } catch (e) { failed(e); }
          reload();
        } }, "×")))) : []),
      // The project's lists, inside one another: one chosen shows what it holds; its own things, then its lists'.
      ...(oneProject() ? section("lists", "Lists", listRows,
        el("button", { class: "s-add", title: "A new list", onclick: (e) => { e.stopPropagation(); newList(null); } }, "+")) : []),
      ...(shown.length ? section("tags", "Tags", shown.map((t) => item(`#${t}`, filters.tags.includes(t), () => {
        filters.tags = filters.tags.includes(t) ? filters.tags.filter((x) => x !== t) : [...filters.tags, t];
        reload();
      }, null, c.tags[t] ?? 0))) : []),
      ...section("status", "What it is", Object.entries(STATUS).map(([k, label]) => item(label, filters.status === k, () => { filters.status = filters.status === k ? "" : k; reload(); }, null, c.status[k] ?? 0))),
      ...section("type", "Type", TYPES.map(([k, label]) => item(label, filters.type === k, () => { filters.type = filters.type === k ? "" : k; reload(); }, null, c.type[k] ?? 0))),
      ...section("kept", "Kept views", [
        ...kept.map((k, i) => item(k.name, false, () => useKept(k), el("span", { class: "x", title: "Forget it", onclick: (e) => {
          e.stopPropagation(); kept.splice(i, 1); store.set("talaris.files.kept", kept); drawSide();
        } }, "×"))),
        el("button", { class: "t-btn s-keep", onclick: keepView }, "+ Keep this view")])].filter(Boolean));
  }

  function groupsOf(list) {
    const out = new Map();
    const put = (k, r, rank) => { if (!out.has(k)) out.set(k, { rank, rows: [] }); out.get(k).rows.push(r); };
    const DATES = ["Today", "This week", "This month", "Earlier", "No date"];
    const pIndex = (id) => { const i = projects.findIndex((p) => p.id === id); return i < 0 ? projects.length : i; };
    for (const r of list) {
      const pre = project ? "" : `${projectName(r.project)} · `;
      if (view === "type") put(TYPE_WORD[r.type] || "Other", r, [TYPES.findIndex((t) => t[0] === r.type)]);
      else if (view === "date") put(dateGroup(r.mtime), r, [DATES.indexOf(dateGroup(r.mtime))]);
      // By folder, project by project in their order: the top first, the folders by name, then what is not in the folder.
      else if (filters.list) put(listName(filters.list), r, [0]);
      else if (r.status.includes("canvas")) put(`${pre}Canvases`, r, [pIndex(r.project), 3, ""]);
      else if (r.status.includes("conversation")) put(`${pre}Conversations with Morgan`, r, [pIndex(r.project), 4, ""]);
      else if (!r.path) put(`${pre}From elsewhere`, r, [pIndex(r.project), 2, ""]);
      else put(`${pre}${whereOf(r) || "Top"}`, r, [pIndex(r.project), whereOf(r) ? 1 : 0, whereOf(r).toLowerCase()]);
    }
    const cmp = (a, b) => { for (let i = 0; i < a.length; i++) { if (a[i] < b[i]) return -1; if (a[i] > b[i]) return 1; } return 0; };
    return [...out].sort((a, b) => cmp(a[1].rank, b[1].rank)).map(([k, g]) => [k, g.rows]);
  }

  function rowEl(r) {
    const gone = r.status.includes("missing");
    const where = view === "folders" ? "" : (project ? whereOf(r) : `${projectName(r.project)}${whereOf(r) ? ` / ${whereOf(r)}` : ""}`);
    const row = el("div", { class: `row${r.key === chosen || picked.has(r.key) ? " on" : ""}${gone ? " gone" : ""}`, "data-key": r.key, draggable: "true",
      onclick: (e) => pick(r.key, e), ondblclick: () => open(r), ondragstart: (e) => dragStart(e, r) },
      el("span", { class: "ic", style: `background:${TYPE_COLOR[r.type] || TYPE_COLOR.other}` }, MARK_OF[r.type] || (r.name.split(".").pop() || "").slice(0, 3).toUpperCase()),
      el("span", { class: "nm", title: r.abs || r.name }, r.name, where ? el("span", { class: "where" }, where) : null),
      el("span", { class: "marks" },
        ...r.status.filter((s) => MARK[s]).map((s) => el("span", { class: `mk ${s}` }, MARK[s])),
        r.alsoIn && r.alsoIn.length ? el("span", { class: "mk on", title: r.alsoIn.map(projectName).join(", ") }, `also in ${r.alsoIn.length === 1 ? projectName(r.alsoIn[0]) : `${r.alsoIn.length} projects`}`) : null,
        ...r.tags.slice(0, 3).map((t) => el("span", { class: "mk tag" }, `#${t}`))),
      book(r),
      // What kind of file, in the words of the Type list on the left: a page is a page.
      el("span", { class: "type" }, r.status.includes("page") ? "Page" : TYPE_ONE[r.type] || "Other"),
      el("span", { class: "date" }, when(r.mtime)),
      el("span", { class: "size" }, size(r.size)));
    if (filters.list) dropToOrder(row, r);
    return row;
  }

  // Whether search has read it: a small book — grey waiting, green read (its tip what it is about), red read with
  // nothing in it to find it by. None for what is not read (a page is a page; audio, archives…).
  const BOOK = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M2.5 3.2c2-.9 3.8-.9 5.5.3v9.8c-1.7-1.2-3.5-1.2-5.5-.3z"/><path d="M13.5 3.2c-2-.9-3.8-.9-5.5.3v9.8c1.7-1.2 3.5-1.2 5.5-.3z"/></svg>';
  function book(r) {
    const st = readState[r.key];
    const b = el("span", { class: `book ${st || "none"}`, title: st === "read" ? (readAbout[r.key] || "Read") : st === "waiting" ? "Not read yet. Set reading interval/schedule in Settings."
      : st === "nowords" ? "Read, but nothing in it to find it by" : st === "unreadable" ? "Can't be read for search: found by its name only" : "" });
    if (st) b.innerHTML = BOOK;
    return b;
  }

  function drawRows() {
    if (!rows.length) {
      $("rows").replaceChildren(el("div", { class: "empty" }, filters.list && !(filters.q || filters.status || filters.type || filters.days || filters.tags.length)
        ? `Nothing in ${listName(filters.list)} yet. Drag things onto it on the left, or choose one and Add to a list.`
        : filters.q || filters.status || filters.type || filters.days || filters.tags.length
        ? "Nothing like that." : `No files here yet. Add some with Add from elsewhere${WINDOW ? ", or drop them on this window" : ""}.`));
      return;
    }
    // Where each lives, nested — but a list is its own order, so it is shown as one.
    if (view === "tree" && !filters.list) { drawTree(); return; }
    const groups = groupsOf(rows);
    order = groups.flatMap(([, list]) => list.map((r) => r.key));
    $("rows").replaceChildren(...groups.flatMap(([name, list]) => [
      el("div", { class: "g-head" }, name, el("span", { class: "n" }, String(list.length))), ...list.map(rowEl)]));
  }

  // ---------------------------------------------------------------- the tree

  // What is open in the tree, by key: kept between visits.
  const openNodes = new Set(store.get("talaris.files.open", []));
  function toggle(key) {
    if (openNodes.has(key)) openNodes.delete(key); else openNodes.add(key);
    store.set("talaris.files.open", [...openNodes]);
    drawRows();
  }

  /**
   * Where each thing lives, nested: in each project its folders and their files,
   * a page under the page it is in (its children live in a folder of its name),
   * a canvas under its canvas; Morgan's conversations, and what lives elsewhere
   * (shortcuts, links, copies kept on tasks), each apart at the end.
   */
  function treeOf(list) {
    const roots = [];
    const nodes = new Map();
    const node = (key, name, into, extra = {}) => {
      let n = nodes.get(key);
      if (!n) { n = { key, name, kids: [], ...extra }; nodes.set(key, n); into.push(n); }
      return n;
    };
    const byKey = new Map(list.map((r) => [r.key, r]));
    const pIndex = (id) => { const i = projects.findIndex((x) => x.id === id); return i < 0 ? projects.length : i; };
    const mine = new Map();
    for (const r of list) mine.set(r.project, [...(mine.get(r.project) || []), r]);
    for (const p of [...mine.keys()].sort((a, b) => pIndex(a) - pIndex(b))) {
      // One project chosen: its things at the top. All of them: each project a folder of its own.
      const top = project ? roots : node(`d:${p}`, projectName(p), roots, { dir: true }).kids;
      const container = (dir) => {
        if (!dir) return top;
        const page = byKey.get(`p:${p}/${dir}.md`);
        if (page && page.status.includes("page")) return place(page).kids;
        const at = dir.lastIndexOf("/");
        return node(`d:${p}/${dir}`, dir.slice(at + 1), container(at < 0 ? "" : dir.slice(0, at)), { dir: true }).kids;
      };
      const place = (r) => {
        if (nodes.has(r.key)) return nodes.get(r.key);
        let into;
        if (r.path) { const at = r.path.lastIndexOf("/"); into = container(at < 0 ? "" : r.path.slice(0, at)); }
        else if (r.under && byKey.has(r.under)) into = place(byKey.get(r.under)).kids;
        else if (r.status.includes("canvas")) into = top;
        else if (r.status.includes("conversation")) into = node(`d:${p}/~talk`, "Conversations with Morgan", top, { dir: true, last: 2 }).kids;
        else into = node(`d:${p}/~elsewhere`, "From elsewhere", top, { dir: true, last: 1 }).kids;
        return node(r.key, r.name, into, { row: r });
      };
      for (const r of mine.get(p)) place(r);
    }
    // Folders first, then what is in them, by name; the apart ones last. Each folder counts what is under it.
    const tidy = (list) => {
      list.sort((a, b) => (a.last || 0) - (b.last || 0) || Number(Boolean(b.dir)) - Number(Boolean(a.dir))
        || a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true }));
      let n = 0;
      for (const x of list) { x.count = tidy(x.kids); n += x.count + (x.row ? 1 : 0); }
      return n;
    };
    tidy(roots);
    return roots;
  }

  // A folder, drawn as one: the twist before it is what opens it.
  const dirIcon = () => { const i = el("span", { class: "ic dir-ic" }); i.innerHTML = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"><path d="M2 4.5h4l1.5 1.5H14v6.5H2z"/></svg>'; return i; };
  function drawTree() {
    const out = [];
    order = [];
    // Looking for something: everything open, so it is seen where it is.
    const looking = Boolean(filters.q || filters.status || filters.type || filters.days || filters.tags.length || readFilter !== "all");
    const walk = (list, depth) => {
      for (const n of list) {
        const has = n.kids.length > 0;
        const open = looking || openNodes.has(n.key);
        const tw = el("span", { class: `tw${has ? "" : " none"}${open ? " open" : ""}`, onclick: has ? (e) => { e.stopPropagation(); toggle(n.key); } : null }, has ? "›" : "");
        const indent = `padding-left:${8 + depth * 16}px`, pad = `${8 + depth * 16}px`;
        if (n.dir) {
          out.push(el("div", { class: "row tree dir", style: indent, onclick: () => toggle(n.key) }, tw,
            dirIcon(), el("span", { class: "nm" }, n.name), el("span", { class: "n" }, String(n.count))));
        } else {
          const r = rowEl(n.row);
          r.classList.add("tree");
          r.style.paddingLeft = pad;
          r.prepend(tw);
          out.push(r);
          order.push(n.row.key);
        }
        if (has && open) walk(n.kids, depth + 1);
      }
    };
    walk(treeOf(rows), 0);
    $("rows").replaceChildren(...out);
  }

  // ---------------------------------------------------------------- dragging

  // What is dragged from the list: the row, or every row picked if it is one of them.
  const DRAG = "application/x-talaris-rows";
  function dragStart(e, r) {
    const keys = picked.has(r.key) ? [...picked] : [r.key];
    e.dataTransfer.setData(DRAG, JSON.stringify({ project: r.project, keys }));
    e.dataTransfer.effectAllowed = "copyMove";
  }
  const dragged = (e) => { try { return JSON.parse(e.dataTransfer.getData(DRAG) || "null"); } catch { return null; } };
  const isOurs = (e) => [...(e.dataTransfer?.types || [])].includes(DRAG);

  /** Dropped on a list on the left: put in it (a list holds only its project's). */
  function dropOnList(target, l) {
    target.addEventListener("dragover", (e) => { if (!isOurs(e)) return; e.preventDefault(); target.classList.add("drop"); });
    target.addEventListener("dragleave", () => target.classList.remove("drop"));
    target.addEventListener("drop", (e) => {
      target.classList.remove("drop");
      const d = dragged(e);
      if (!d) return;
      e.preventDefault();
      api("POST", `/files/lists/${enc(l.id)}/items`, { project, keys: d.keys }).then((x) => {
        say(`${x.added ? `${x.added} in ${l.name}` : `Already in ${l.name}`}${x.refused.length ? `; ${x.refused.length} not in ${projectName(project)}, so not` : ""}`);
        return load();
      }).catch(failed);
    });
  }

  /** In a list shown, its own things dragged into an order: dropped before the one under the pointer. */
  function dropToOrder(target, r) {
    const l = flat(lists).find((x) => x.id === filters.list);
    if (!l || !l.items.includes(r.key)) return;
    target.addEventListener("dragover", (e) => {
      if (!isOurs(e)) return;
      e.preventDefault();
      const below = e.offsetY > target.offsetHeight / 2;
      target.classList.toggle("drop-after", below);
      target.classList.toggle("drop-before", !below);
    });
    target.addEventListener("dragleave", () => target.classList.remove("drop-before", "drop-after"));
    target.addEventListener("drop", (e) => {
      const after = target.classList.contains("drop-after");
      target.classList.remove("drop-before", "drop-after");
      const d = dragged(e);
      if (!d) return;
      e.preventDefault();
      const moving = d.keys.filter((k) => l.items.includes(k) && k !== r.key);
      if (!moving.length) return;
      const rest = l.items.filter((k) => !moving.includes(k));
      const at = rest.indexOf(r.key) + (after ? 1 : 0);
      rest.splice(at, 0, ...moving);
      api("PUT", `/files/lists/${enc(l.id)}/order`, { project, keys: rest }).then(reload, failed);
    });
  }

  /** A row pressed: alone; with Ctrl (or ⌘) added or taken out; with Shift, everything from the last one picked to it. */
  function pick(key, e) {
    if (e.shiftKey && anchor && order.includes(anchor)) {
      const [a, b] = [order.indexOf(anchor), order.indexOf(key)].sort((x, y) => x - y);
      if (!e.ctrlKey && !e.metaKey) picked.clear();
      for (const k of order.slice(a, b + 1)) picked.add(k);
    } else if (e.ctrlKey || e.metaKey) {
      if (!picked.size && chosen) picked.add(chosen);
      if (picked.has(key)) picked.delete(key); else picked.add(key);
      anchor = key;
    } else {
      picked.clear();
      anchor = key;
    }
    chosen = picked.size === 1 ? [...picked][0] : picked.size ? null : key;
    if (picked.size === 1) picked.clear();
    drawRows();
    drawDetail();
  }

  // ---------------------------------------------------------------- the one chosen

  /**
   * A project chosen and nothing in it: the project itself — what it is about (Morgan's, from its tasks, or yours,
   * edited here), what is in it, and what it might be connected to (suggest.ts, by its description), with Glance a
   * press away.
   */
  function drawProject() {
    const id = project;
    const key = `project:${id}`;
    const p = projects.find((x) => x.id === id) || {};
    const c = counts || { projects: {} };
    const aboutHost = el("div", { class: "d-read" });
    api("GET", `/projects/${enc(id)}/about`).then((t) => {
      if (project !== id || chosen) return;
      if (!t.can) { aboutHost.replaceChildren(el("div", { class: "d-sub" }, p.home ? "Home: what is in no other project" : "")); return; }
      aboutHost.replaceChildren(...aboutEditor("About it", t.about, t.aboutByYou,
        "What the project is for — Morgan writes it from the project's tasks, or write it yourself",
        (about) => api("PUT", `/projects/${enc(id)}/about`, { about })));
    }).catch(() => {});
    const acts = [];
    if (window.Peek && bridge.glanceAt) acts.push(Peek.glanceButton(key, (k) => bridge.glanceAt(k)));
    const sugg = window.Peek ? Peek.suggestions(key, api, {
      open: (eid) => Peek.show(eid, api, { openTask: (t) => bridge.openTask(t), openPerson: (x) => bridge.openPerson(x),
        openPlace: (x) => bridge.openPlace(x.kind, x.project, x.where), openEvent: (cal, u, st) => bridge.openEvent(cal, u, st), openUrl: (u) => bridge.openUrl(u) }),
      openPlace: (x) => bridge.openPlace(x.kind, x.project, x.where),
      changed: (res) => { say(res.said || "Done"); reload(); },
    }) : null;
    $("detail").replaceChildren(...[
      el("h2", {}, p.name || "A project"),
      el("div", { class: "d-status" }, el("span", {}, el("b", {}, "A project"), (c.projects[id] ?? 0) ? ` — ${c.projects[id]} here in the Library; choose one to see it.` : " — nothing of it in the Library yet.")),
      aboutHost,
      acts.length ? el("div", { class: "d-sub" }, "Do") : null,
      acts.length ? el("div", { class: "d-acts" }, ...acts) : null,
      sugg,
    ].filter(Boolean));
  }

  /** The projects a thing is in, each to go to; only Home's, said so. */
  function projectsOf(r) {
    const home = (projects.find((p) => p.home) || {}).id;
    const lives = r.status.includes("shortcut") ? [...(r.alsoIn || []).slice(0, 1), r.project, ...(r.alsoIn || []).slice(1)] : [r.project, ...(r.alsoIn || [])];
    const ids = [...new Set(lives.filter(Boolean))];
    const go = (id) => el("button", { class: "d-proj", title: `Show ${projectName(id)}'s`, onclick: () => { project = id; filters.list = ""; reload(); } }, projectName(id));
    if (ids.length === 1 && ids[0] === home) return el("span", {}, go(home), el("span", { class: "d-dim" }, " only — in no project"));
    return el("span", {}, ...ids.flatMap((id, i) => [i ? ", " : null, go(id)]).filter((x) => x !== null));
  }

  function drawDetail() {
    if (picked.size > 1) { drawMany(rows.filter((x) => picked.has(x.key))); return; }
    const r = rows.find((x) => x.key === chosen);
    if (!r && filters.list) { drawList(); return; }
    if (!r && oneProject()) { drawProject(); return; }
    if (!r) { $("detail").replaceChildren(el("div", { class: "empty" }, "Choose a file to see what it is and what can be done with it.")); return; }
    const s = r.status;
    const said = [];
    if (s.includes("folder")) said.push(el("span", {}, el("b", {}, "In the folder"), ` of ${projectName(r.project)}.`));
    if (s.includes("page")) said.push(el("span", {}, el("b", {}, "A writing page"), " — Writing opens it, and moves and renames it with its children."));
    if (s.includes("canvas")) said.push(el("span", {}, el("b", {}, "A canvas"), ` of ${projectName(r.project)}.`));
    if (s.includes("conversation")) said.push(el("span", {}, el("b", {}, "A conversation with Morgan"), ", as Morgan filed it. It lives in Home."));
    if (s.includes("shortcut") && r.thing) said.push(el("span", {}, el("b", {}, "A shortcut"), ` in ${projectName(r.project)} to a ${r.type === "canvas" ? "canvas" : "conversation with Morgan"} that lives in ${projectName((r.alsoIn || [])[0])}.`));
    else if (s.includes("shortcut")) said.push(el("span", {}, el("b", {}, "A shortcut"), ` in ${projectName(r.project)} to a file that lives ${r.livesIn ? `in ${projectName(r.livesIn.project)}'s folder` : "elsewhere"}. Nothing of it is in this project's folder.`));
    if (r.alsoIn && r.alsoIn.length) said.push(el("span", {}, el("b", {}, "Also in"), ` ${r.alsoIn.map(projectName).join(", ")}${r.status.includes("folder") ? ", by a shortcut there" : ""}.`));
    if (s.includes("linked")) said.push(el("span", {}, el("b", {}, "Linked on a task"), " from where it lives, outside every project."));
    if (s.includes("snapshot")) said.push(el("span", {}, el("b", {}, "Stored on a task"), `${r.fromHermes ? ", from Hermes Notes" : ""} — in no folder until it is saved to the project's.`));
    if (s.includes("missing")) said.push(el("span", { class: "bad" }, el("b", {}, "Missing from its folder:"), " moved or deleted."));
    if (r.sealed) said.push(el("span", {}, "Sealed: it opens as a copy, since only Talaris can read it."));
    // What search knows of what it says.
    const rs = readState[r.key];
    if (rs === "read") said.push(el("span", {}, el("b", {}, "Read"), " — found by what it says, by search and Morgan, and suggested with what it is about."));
    else if (rs === "nowords") said.push(el("span", {}, el("b", {}, "Read, no words in it"), " — found by its name only."));
    else if (rs === "waiting") said.push(el("span", {}, "Not read yet. Set reading interval/schedule in Settings."));
    else if (!reading.on && !s.includes("page") && !s.includes("missing")) said.push(el("span", {}, "Not read: search by meaning is off (Settings, Data)."));
    const lines = [
      r.path ? ["Where", r.path] : r.abs ? ["Where", r.abs.replace(/^\/home\/[^/]+/, "~")] : null,
      ["Type", s.includes("page") ? "Page" : TYPE_ONE[r.type] || "Other"],
      r.size != null ? ["Size", size(r.size)] : null,
      // Every project it is in: where it lives, then each with a shortcut to it; each a press away.
      ["Projects", projectsOf(r)],
      r.mtime ? ["Changed", Kit.stamp(r.mtime)] : null,
    ].filter(Boolean);
    const acts = [];
    const act = (label, fn, cls = "") => acts.push(el("button", { class: `t-btn ${cls}`, onclick: fn }, label));
    if (s.includes("page")) act("Open in Writing", () => bridge.page(r.project, r.path));
    else if (r.thing && !s.includes("missing")) act(r.type === "conversation" ? "Open the conversation" : "Open the canvas", () => open(r));
    else if (!s.includes("missing")) act(s.includes("snapshot") || r.sealed ? "Open a copy" : "Open", () => open(r));
    // A canvas or a conversation, in another project too: a shortcut there; one there already, gone to.
    if (r.thing && !s.includes("shortcut")) act("Also in another project…", () => inline("also-thing", r));
    if (r.thing && s.includes("shortcut") && r.alsoIn && r.alsoIn[0]) act(`Go to it in ${projectName(r.alsoIn[0])}`, () => {
      project = r.alsoIn[0]; chosen = r.type === "conversation" ? `t:${r.thing.split("/").pop()}` : `v:${r.thing.slice(7)}`; filters.list = ""; reload();
    });
    // In this project's lists (a list holds only what is in its project).
    if (!s.includes("missing")) act("Add to a list…", () => inline("list", r));
    if (r.abs && !s.includes("missing")) act("Show in Files", () => bridge.reveal(r.abs));
    if (r.abs && !s.includes("missing") && !s.includes("page")) act("Pin to the dock", () => { bridge.pin(r.abs, r.name); say(`${r.name} pinned to the dock, in this project`); });
    if (s.includes("folder") && !s.includes("page")) {
      act("Rename", () => inline("rename", r));
      act("Move", () => inline("move", r));
    }
    if (s.includes("shortcut") && !s.includes("missing")) act("Move it in…", () => bringIn([r.abs], "move", r.project, null, true));
    if (s.includes("linked") && !s.includes("missing")) act("Make it a shortcut here", () => api("POST", "/files/shortcut", { project: r.project, path: r.abs }).then(reload, failed));
    if (s.includes("snapshot")) act("Save to the project folder", () => api("POST", "/files/snapshot/save", { holder: r.holder, sha256: r.sha256, project: r.project })
      .then((x) => { say(`Saved as ${x.path}`); chosen = `p:${r.project}/${x.path}`; return load(); }).catch(failed));
    if (r.abs && !s.includes("missing") && !s.includes("page")) act("Connect to a task…", () => inline("attach", r));
    if (r.abs && !s.includes("missing") && !s.includes("page")) act("Also in another project…", () => inline("also", r));
    if (r.livesIn) act(`Go to it in ${projectName(r.livesIn.project)}`, () => { project = r.livesIn.project; chosen = `p:${r.livesIn.project}/${r.livesIn.path}`; reload(); });
    if (s.includes("shortcut")) act("Remove the shortcut", (e) => {
      // Asked as everything is asked (kit.js).
      if (!Kit.ask(e.currentTarget, { key: `sc:${r.key}`, ask: "Take the shortcut away?" })) return;
      api("DELETE", `/files/shortcut/${enc(r.entity)}`).then((x) => { say(x && x.fromWatched ? "Shortcut removed, and not linked again from its watched folder; the file is where it was" : "Shortcut removed; the file is where it was"); return load(); }).catch(failed);
    }, "danger");
    if (s.includes("folder") && !s.includes("page")) act("Delete…", (e) => {
      // Asked as everything is asked (kit.js).
      if (!Kit.ask(e.currentTarget, { key: `tr:${r.key}`, ask: "Move it to the trash?" })) return;
      api("POST", "/files/trash", { project: r.project, path: r.path }).then(() => { say(`${r.name} is in the trash`); chosen = null; return load(); }).catch(failed);
    }, "danger");

    // Glance on it, and what it might be connected to (its words read for search: suggest.ts) — by its key there.
    const gkey = glanceKey(r);
    if (gkey && window.Peek && bridge.glanceAt) acts.push(Peek.glanceButton(gkey, (k) => bridge.glanceAt(k)));
    // What takes something away, last: delete, the trash, a shortcut removed.
    acts.sort((a, b) => Number(a.classList.contains("danger")) - Number(b.classList.contains("danger")));
    const sugg = gkey && window.Peek ? Peek.suggestions(gkey, api, {
      open: (id) => Peek.show(id, api, { openTask: (t) => bridge.openTask(t), openPerson: (p) => bridge.openPerson(p),
        openPlace: (p) => bridge.openPlace(p.kind, p.project, p.where), openEvent: (c, u, st) => bridge.openEvent(c, u, st), openUrl: (u) => bridge.openUrl(u) }),
      openPlace: (p) => bridge.openPlace(p.kind, p.project, p.where),
      changed: (res) => { say(res.said || "Done"); reload(); },
    }) : null;

    // What it was read as, once read: what it is about — Morgan's description, or yours, edited here — and, for a
    // document, the start of its words. The description is what it is found by first; saved, it is read again with it.
    // A shortcut is known to Glance by its entity; its file, by its row.
    const textKey = s.includes("shortcut") ? `att:${r.key}` : gkey;
    const readHost = rs === "read" && gkey ? el("div", { class: "d-read" }) : null;
    // A page: its description alone (its words are Writing's to show), as written by Morgan or by you.
    if (readHost && (s.includes("page") || r.thing)) {
      api("GET", `/files/page-about?key=${enc(gkey)}`).then((t) => {
        if (chosen !== r.key || !t || !t.read) return;
        readHost.replaceChildren(...aboutEditor("About it", t.about, t.aboutByYou, `What the ${r.type === "conversation" ? "conversation" : r.type === "canvas" ? "canvas" : "page"} is, and what it is about — being described…`,
          (about) => api("PUT", "/files/page-about", { key: gkey, about })));
      }).catch(() => {});
    } else if (readHost) {
      api("GET", `/files/text?key=${enc(textKey)}`).then((t) => {
        const text = String((t && t.text) || "").trim();
        if (!text || chosen !== r.key) return;
        const picture = text.startsWith("Picture: ");
        const about = String((t && t.about) || "");
        const box = el("textarea", { class: "d-about", rows: "4", spellcheck: "true",
          placeholder: picture ? "What it shows" : "What it is, and what it is about — being described…" });
        box.value = about;
        const saveB = el("button", { class: "t-btn", onclick: async () => {
          try { await api("PUT", "/files/about", { key: textKey, about: box.value }); say("Description saved; read again with it"); saveB.remove(); who.textContent = "Yours"; }
          catch (e) { failed(e); }
        } }, "Save");
        const who = el("span", { class: "d-who" }, t.aboutByYou ? "Yours" : about ? "Morgan's" : "");
        // Save, only once something is changed.
        const acts = el("div", { class: "d-about-acts" });
        box.addEventListener("input", () => { if (box.value.trim() === about.trim()) saveB.remove(); else if (!saveB.isConnected) acts.append(saveB); });
        const words = picture ? "" : text.replace(/^About: [^\n]*\n\n/, "");
        readHost.replaceChildren(...[
          el("div", { class: "d-sub" }, picture ? "What it shows" : "About it", who),
          box, acts,
          words ? el("div", { class: "d-sub" }, "What it says") : null,
          words ? el("div", { class: "d-said" }, words.length > 900 ? `${words.slice(0, 900)}…` : words) : null].filter(Boolean));
      }).catch(() => {});
    }

    const taggable = (s.includes("folder") && !s.includes("page")) || s.includes("shortcut");
    // The lists it is in, each to take it out of.
    const inLists = el("div", { class: "chips d-lists" });
    api("GET", `/files/lists/holding?project=${enc(r.project)}&key=${enc(r.key)}`).then((held) => {
      if (chosen !== r.key || !held.length) return;
      inLists.replaceChildren(el("div", { class: "d-sub" }, "In lists"), ...held.map((l) => el("span", { class: "chip" }, l.name,
        el("button", { title: "Take it out of this list (nothing is deleted)", onclick: () => api("DELETE", `/files/lists/${enc(l.id)}/items`, { project: r.project, keys: [r.key] })
          .then(() => { say(`Out of ${l.name}`); return load(); }).catch(failed) }, "×"))));
    }).catch(() => {});
    $("detail").replaceChildren(...[
      el("h2", {}, r.name),
      el("div", { class: "d-status" }, ...said.flatMap((x, i) => (i ? [" ", x] : [x]))),
      ...lines.map(([k, v]) => el("div", { class: "d-line" }, el("span", { class: "k" }, k), el("span", { class: "v" }, v))),
      r.on.length ? el("div", { class: "d-sub" }, "On") : null,
      ...r.on.map((o) => el("button", { class: "on-item", onclick: () => bridge.thing(o.kind === "contact" ? "person" : o.kind, o.id) }, o.title, el("span", { class: "kind" }, ON_KIND[o.kind] || o.kind))),
      taggable ? el("div", { class: "d-sub" }, "Tags") : null,
      taggable ? tagEditor(r) : null,
      inLists,
      el("div", { class: "d-sub" }, "Do"),
      el("div", { class: "d-acts" }, ...acts),
      el("div", { id: "inline" }),
      readHost,
      sugg].filter(Boolean));
  }

  /** What Glance knows a file by: a folder's by its place, a page as a page, a shortcut by its entity, anything else by its row. */
  function glanceKey(r) {
    if (r.thing && !r.status.includes("missing")) return r.thing;
    if (r.status.includes("page") && r.path) return `page:${r.project}/${r.path.replace(/^Writing\//, "").replace(/\.md$/, "")}`;
    if (r.status.includes("folder") && r.path) return `file:${r.project}/${r.path}`;
    if (r.status.includes("shortcut") && r.entity) return `e:${r.entity}`;
    return r.status.includes("missing") ? "" : `att:${r.key}`;
  }

  /**
   * Several picked: what they are, and what can be done to them together — each action saying how many of them it
   * applies to (a shortcut can be taken away, a folder's file trashed, a readable file read again). What takes
   * something away asks once more, and comes last.
   */
  function drawMany(list) {
    const n = (f) => list.filter(f);
    const readable = n((r) => readState[r.key] && readState[r.key] !== "unreadable" && !r.status.includes("page") && !r.status.includes("missing"));
    const linkable = n((r) => r.abs && !r.status.includes("missing") && !r.status.includes("page"));
    const taggable = n((r) => (r.status.includes("folder") && !r.status.includes("page")) || r.status.includes("shortcut"));
    const shortcuts = n((r) => r.status.includes("shortcut"));
    const trashable = n((r) => r.status.includes("folder") && !r.status.includes("page"));
    const of = (part) => (part.length === list.length ? "" : ` (${part.length} of them)`);
    const acts = [];
    const act = (label, fn, cls = "") => acts.push(el("button", { class: `t-btn ${cls}`, onclick: fn }, label));
    const done = async (word, jobs) => {
      let ok = 0;
      for (const j of jobs) { try { await j(); ok++; } catch (e) { failed(e); } }
      say(`${ok} ${word}`);
      picked.clear();
      return load();
    };
    if (readable.length) act(`Read again${of(readable)}`, async () => {
      try { const r = await api("POST", "/meaning/read-again", { keys: readable.map((x) => x.key) }); say(`${r.again} read again`); } catch (e) { failed(e); }
      reload();
    });
    if (linkable.length) act(`Connect to a task…${of(linkable)}`, () => inlineMany("attach", linkable));
    if (taggable.length) act(`Add a tag…${of(taggable)}`, () => inlineMany("tag", taggable));
    // Into a list: all of one project's, since a list holds only its project's.
    const theirs = [...new Set(list.map((r) => r.project))];
    if (theirs.length === 1) act("Add to a list…", () => { const host = $("inline"); host.className = "inline"; listPicker(host, theirs[0], list); });
    if (filters.list) act(`Take out of ${listName(filters.list)}`, () => done(`out of ${listName(filters.list)}; nothing deleted`,
      [() => api("DELETE", `/files/lists/${enc(filters.list)}/items`, { project, keys: list.map((r) => r.key) })]));
    if (shortcuts.length) act(`Remove the shortcuts${of(shortcuts)}`, (e) => {
      // Asked as everything is asked (kit.js).
      if (!Kit.ask(e.currentTarget, { key: "many-sc", ask: `Take ${shortcuts.length} shortcuts away?` })) return;
      done("shortcuts removed; the files are where they were", shortcuts.map((r) => () => api("DELETE", `/files/shortcut/${enc(r.entity)}`)));
    }, "danger");
    if (trashable.length) act(`Delete…${of(trashable)}`, (e) => {
      // Asked as everything is asked (kit.js).
      if (!Kit.ask(e.currentTarget, { key: "many-tr", ask: `Move ${trashable.length} to the trash?` })) return;
      done("in the trash", trashable.map((r) => () => api("POST", "/files/trash", { project: r.project, path: r.path })));
    }, "danger");
    act("Clear the selection", () => { picked.clear(); chosen = null; drawRows(); drawDetail(); });
    const names = list.slice(0, 8).map((r) => el("div", { class: "d-line" }, el("span", { class: "v" }, r.name)));
    $("detail").replaceChildren(
      el("h2", {}, `${list.length} files`),
      el("div", { class: "d-status" }, "Shift picks a run of them, Ctrl (or ⌘) one more or one less."),
      ...names, list.length > 8 ? el("div", { class: "d-line" }, el("span", { class: "v" }, `and ${list.length - 8} more`)) : null,
      el("div", { class: "d-sub" }, "Do, to all of them"),
      el("div", { class: "d-acts" }, ...acts),
      el("div", { id: "inline" }));
  }

  /** The lists of a project to put things in: each a button, and one more made by name. */
  async function listPicker(host, projectId, list) {
    const all = flat(await listsFor(projectId));
    const put = (id, name) => api("POST", `/files/lists/${enc(id)}/items`, { project: projectId, keys: list.map((r) => r.key) }).then((x) => {
      say(`${x.added ? `${x.added === 1 && list.length === 1 ? list[0].name : `${x.added}`} in ${name}` : `Already in ${name}`}${x.refused.length ? `; ${x.refused.length} not in ${projectName(projectId)}, so not` : ""}`);
      listsOf.delete(projectId);
      return load();
    }).catch(failed);
    const name = el("input", { type: "text", placeholder: "A new list, then Enter", spellcheck: "false" });
    name.addEventListener("keydown", async (e) => {
      if (e.key !== "Enter" || !name.value.trim()) return;
      try { const l = await api("POST", "/files/lists", { project: projectId, name: name.value.trim() }); await put(l.id, l.name); } catch (err) { failed(err); }
    });
    host.replaceChildren(all.length ? el("div", { class: "pick-list" }, ...all.map((l) => el("button", { class: "t-btn", onclick: () => put(l.id, l.name) }, [...l.path, l.name].join(" › ")))) : null, name);
    name.focus();
  }

  /** A new list, at the top or inside another, named where it will be. */
  function newList(parent) {
    const host = $("detail");
    const name = el("input", { type: "text", placeholder: parent ? `A list inside ${listName(parent)}` : `A new list in ${projectName(project)}`, spellcheck: "false" });
    const go = () => name.value.trim() && api("POST", "/files/lists", { project, name: name.value.trim(), parent }).then((l) => { filters.list = l.id; chosen = null; say(`${l.name} made: add to it from any file's details`); return load(); }).catch(failed);
    // Escape gives the naming up, and goes no further (the panel stays).
    name.addEventListener("keydown", (e) => { if (e.key === "Enter") go(); if (e.key === "Escape") { e.preventDefault(); drawDetail(); } });
    host.replaceChildren(el("h2", {}, parent ? `A list inside ${listName(parent)}` : "A new list"),
      el("div", { class: "d-status" }, "A list holds things of this project's without moving them: a file can be in any number of lists."),
      el("div", { class: "inline" }, name, el("button", { class: "t-btn", onclick: go }, "Make it")));
    name.focus();
  }

  /** The list chosen, with nothing in it chosen: what it is, and renaming, a list inside, moving it, deleting it. */
  function drawList() {
    const all = flat(lists);
    const l = all.find((x) => x.id === filters.list);
    if (!l) return;
    const acts = [];
    const act = (label, fn, cls = "") => acts.push(el("button", { class: `t-btn ${cls}`, onclick: fn }, label));
    act("Rename", () => {
      const host = $("inline"); host.className = "inline";
      const name = el("input", { type: "text", value: l.name, spellcheck: "false" });
      const go = () => api("PUT", `/files/lists/${enc(l.id)}`, { project, name: name.value }).then(reload, failed);
      name.addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });
      host.replaceChildren(name, el("button", { class: "t-btn", onclick: go }, "Rename"));
      name.focus(); name.select();
    });
    act("A list inside it…", () => newList(l.id));
    act("Move it…", () => {
      const host = $("inline"); host.className = "inline";
      // Anywhere but inside itself.
      const inside = new Set([l.id, ...flat(l.children).map((x) => x.id)]);
      const to = (parent) => api("PUT", `/files/lists/${enc(l.id)}`, { project, parent }).then(reload, failed);
      host.replaceChildren(el("div", { class: "pick-list" }, l.parent ? el("button", { class: "t-btn", onclick: () => to(null) }, "To the top") : null,
        ...all.filter((x) => !inside.has(x.id) && x.id !== l.parent).map((x) => el("button", { class: "t-btn", onclick: () => to(x.id) }, `Inside ${[...x.path, x.name].join(" › ")}`))));
    });
    act("Delete the list…", (e) => {
      // Asked as everything is asked (kit.js).
      if (!Kit.ask(e.currentTarget, { key: `list:${l.id}`, ask: `Delete ${l.name}${l.children.length ? " and the lists in it" : ""}?` })) return;
      api("DELETE", `/files/lists/${enc(l.id)}?project=${enc(project)}`).then(() => { say(`${l.name} deleted; what it held is where it was`); filters.list = ""; return load(); }).catch(failed);
    }, "danger");
    $("detail").replaceChildren(...[
      el("h2", {}, l.name),
      el("div", { class: "d-status" }, `${l.count} thing${l.count === 1 ? "" : "s"}${l.children.length ? `, with ${l.children.length} list${l.children.length === 1 ? "" : "s"} inside it` : ""}${l.path.length ? `. Inside ${l.path.join(" › ")}.` : "."} A list holds without moving: deleting it, or taking something out, deletes nothing.`),
      el("div", { class: "d-sub" }, "Do"),
      el("div", { class: "d-acts" }, ...acts),
      el("div", { id: "inline" })]);
  }

  /** A description, editable: its label (and whose it is), the box, and Save once it is changed; `put` saves it. */
  function aboutEditor(label, about, byYou, placeholder, put) {
    about = String(about || "");
    const box = el("textarea", { class: "d-about", rows: "4", spellcheck: "true", placeholder });
    box.value = about;
    const who = el("span", { class: "d-who" }, byYou ? "Yours" : about ? "Morgan's" : "");
    const acts = el("div", { class: "d-about-acts" });
    const saveB = el("button", { class: "t-btn", onclick: async () => {
      try { await put(box.value); say("Description saved; read again with it"); saveB.remove(); who.textContent = "Yours"; about = box.value.trim(); }
      catch (e) { failed(e); }
    } }, "Save");
    box.addEventListener("input", () => { if (box.value.trim() === about.trim()) saveB.remove(); else if (!saveB.isConnected) acts.append(saveB); });
    return [el("div", { class: "d-sub" }, label, who), box, acts];
  }

  /** Connect several to one task, or put one tag on several: found or typed once. */
  function inlineMany(what, list) {
    const host = $("inline");
    host.className = "inline";
    if (what === "attach") {
      const q = Kit.searchBox(el("input", { type: "text", placeholder: "Find a task", spellcheck: "false" }));
      const found = el("div", { style: "width:100%" });
      let timer = 0;
      q.addEventListener("input", () => {
        clearTimeout(timer);
        timer = setTimeout(async () => {
          try {
            const got = await api("GET", `/tasks/find?text=${enc(q.value)}&limit=8`);
            const tasks = Array.isArray(got) ? got : got.tasks || got.rows || [];
            found.replaceChildren(...tasks.map((t) => el("button", { class: "on-item", onclick: async () => {
              let ok = 0;
              for (const r of list) { try { await api("POST", `/entities/${enc(t.id)}/links`, { path: r.abs }); ok++; } catch (e) { failed(e); } }
              say(`${ok} connected to ${t.title}`);
              picked.clear();
              load();
            } }, t.title)));
          } catch (e) { failed(e); }
        }, 200);
      });
      host.replaceChildren(q, found);
      q.focus();
    } else if (what === "tag") {
      const q = el("input", { type: "text", placeholder: "A tag, then Enter", spellcheck: "false" });
      q.addEventListener("keydown", async (e) => {
        if (e.key !== "Enter") return;
        const tag = q.value.trim().replace(/^#/, "");
        if (!tag) return;
        let ok = 0;
        for (const r of list) {
          const tags = [...new Set([...(r.tags || []), tag])];
          try { await api("PUT", "/files/tags", r.entity && r.status.includes("shortcut") ? { entity: r.entity, tags } : { project: r.project, path: r.path, tags }); ok++; } catch (err) { failed(err); }
        }
        say(`#${tag} on ${ok}`);
        load();
      });
      host.replaceChildren(q);
      q.focus();
    }
  }

  function tagEditor(r) {
    const put = (tags) => api("PUT", "/files/tags", r.entity && r.status.includes("shortcut") ? { entity: r.entity, tags } : { project: r.project, path: r.path, tags })
      .then(reload, failed);
    const input = el("input", { type: "text", class: "tag-in", placeholder: "+ tag", spellcheck: "false", onkeydown: (e) => {
      if (e.key !== "Enter" || !input.value.trim()) return;
      e.preventDefault();
      put([...r.tags, ...input.value.split(/[\s,]+/).filter(Boolean)]);
    } });
    return el("div", { class: "chips" }, ...r.tags.map((t) => el("span", { class: "chip" }, `#${t}`, el("button", { title: "Take it off", onclick: () => put(r.tags.filter((x) => x !== t)) }, "×"))), input);
  }

  /** Rename, move, or attach: asked for under the buttons. */
  function inline(what, r) {
    const host = $("inline");
    host.className = "inline";
    if (what === "rename") {
      const name = el("input", { type: "text", value: r.name, spellcheck: "false" });
      const go = () => api("POST", "/files/rename", { project: r.project, path: r.path, name: name.value })
        .then(() => { const dir = whereOf(r); chosen = `p:${r.project}/${dir ? `${dir}/` : ""}${name.value.trim()}`; return load(); }).catch(failed);
      name.addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });
      host.replaceChildren(name, el("button", { class: "t-btn", onclick: go }, "Rename"));
      name.focus();
      const dot = r.name.lastIndexOf(".");
      name.setSelectionRange(0, dot > 0 ? dot : r.name.length);
    } else if (what === "move") {
      // No browser pickers on a layer surface: the projects as buttons, the one chosen lit.
      const to = { value: r.project };
      const picks = el("div", { class: "pick-list" });
      const drawPicks = () => picks.replaceChildren(...projects.filter((p) => !p.pagesOnly).map((p) => el("button", { class: `t-btn${p.id === to.value ? " on" : ""}`, onclick: () => { to.value = p.id; drawPicks(); } }, p.name)));
      drawPicks();
      const folders = [...new Set(rows.filter((x) => x.project === r.project && x.path).map(whereOf).filter(Boolean))].sort();
      const list = el("datalist", { id: "folders" }, ...folders.map((f) => el("option", { value: f })));
      const dir = el("input", { type: "text", placeholder: "Folder (empty: the top)", list: "folders", value: whereOf(r), spellcheck: "false" });
      const go = () => api("POST", "/files/move", { project: r.project, path: r.path, toProject: to.value, toDir: dir.value.trim().replace(/^\/+|\/+$/g, "") })
        .then((x) => { chosen = `p:${to.value}/${x.path}`; say(`Moved to ${projectName(to.value)}${x.path.includes("/") ? ` / ${x.path.slice(0, x.path.lastIndexOf("/"))}` : ""}`); return load(); }).catch(failed);
      host.replaceChildren(picks, dir, list, el("button", { class: "t-btn", onclick: go }, "Move"));
    } else if (what === "also") {
      // A shortcut in each project chosen: the file stays where it is, and is in all of them.
      const taken = new Set([r.project, ...(r.alsoIn || []), ...(r.livesIn ? [r.livesIn.project] : [])]);
      const left = projects.filter((p) => !taken.has(p.id) && !p.pagesOnly);
      host.replaceChildren(left.length ? el("div", { class: "pick-list" }, ...left.map((p) => el("button", { class: "t-btn", onclick: () => api("POST", "/files/shortcut", { project: p.id, path: r.abs })
        .then(() => { say(`${r.name} is in ${projectName(p.id)} too`); return load(); }).catch(failed) }, p.name)))
        : el("span", { class: "hint" }, "It is in every project already."));
    } else if (what === "also-thing") {
      // A shortcut in the project chosen: the canvas or conversation stays where it lives, and is in that one too.
      const left = projects.filter((p) => p.id !== r.project && !p.pagesOnly);
      host.replaceChildren(el("div", { class: "pick-list" }, ...left.map((p) => el("button", { class: "t-btn", onclick: () => api("POST", "/files/thing-shortcut", { project: p.id, key: r.thing })
        .then(() => { say(`${r.name} is in ${projectName(p.id)} too`); return load(); }).catch(failed) }, p.name))));
    } else if (what === "list") {
      listPicker(host, r.project, [r]);
    } else if (what === "attach") {
      const q = Kit.searchBox(el("input", { type: "text", placeholder: "Find a task", spellcheck: "false" }));
      const found = el("div", { style: "width:100%" });
      let timer = 0;
      q.addEventListener("input", () => {
        clearTimeout(timer);
        timer = setTimeout(async () => {
          try {
            const got = await api("GET", `/tasks/find?text=${enc(q.value)}&limit=8`);
            const list = Array.isArray(got) ? got : got.tasks || got.rows || [];
            found.replaceChildren(...list.map((t) => el("button", { class: "on-item", onclick: () => api("POST", `/entities/${enc(t.id)}/links`, { path: r.abs })
              .then(() => { say(`Attached to ${t.title}`); return load(); }).catch(failed) }, t.title)));
          } catch (e) { failed(e); }
        }, 200);
      });
      host.replaceChildren(q, found);
      q.focus();
    }
  }

  function open(r) {
    if (r.status.includes("page")) { bridge.page(r.project, r.path); return; }
    if (r.thing && !r.status.includes("missing")) {
      const kind = r.thing.slice(0, r.thing.indexOf(":")), rest = r.thing.slice(kind.length + 1), at = rest.indexOf("/");
      bridge.openPlace(kind, rest.slice(0, at), rest.slice(at + 1));
      return;
    }
    if (r.status.includes("missing")) { say(`${r.name} is missing from its folder`, true); return; }
    if (r.status.includes("snapshot") || r.sealed) {
      api("POST", "/files/open-copy", r.sha256 ? { sha256: r.sha256, name: r.name } : { project: r.project, path: r.path })
        .then((x) => bridge.open(x.path)).catch(failed);
      return;
    }
    if (r.abs) bridge.open(r.abs);
  }

  // ---------------------------------------------------------------- bringing in

  /** Files from elsewhere: shortcuts (nothing moved), or moved in after saying what that would disturb. */
  /**
   * A whole folder: what is in it said, then — asked — every file in it and its
   * folders linked into the project as shortcuts, read for search, and the
   * folder watched from then on for files new in it (the core's files.ts).
   */
  async function linkFolder(path) {
    const to = project || surface.project;
    if (!to) { say("Choose a project on the left first: that is where they go", true); return; }
    let f;
    try { f = await api("GET", `/files/folder?path=${enc(path)}`); } catch (e) { failed(e); return; }
    const name = f.folder.split("/").pop();
    const sheet = $("sheet");
    const close = () => { sheet.hidden = true; sheet.replaceChildren(); };
    sheet.replaceChildren(el("div", { class: "sheet" },
      el("h3", {}, `Link ${name} into ${projectName(to)}`),
      el("p", {}, `${f.count}${f.most ? "+" : ""} file${f.count === 1 ? "" : "s"} in it and its folders${f.most ? ` (the first ${f.count})` : ""}, hidden ones aside, as shortcuts: each stays where it is, shows here, and is read for search. The folder is watched: a file put in it later is linked too, and a file changed is read again.`),
      el("div", { class: "acts" }, el("button", { class: "t-btn", onclick: close }, "Cancel"),
        el("button", { class: "t-btn primary", onclick: async () => {
          close();
          say(`Linking ${name}…`);
          try {
            const r = await api("POST", "/files/folder", { project: to, path: f.folder });
            say(`${r.made} linked from ${name}${r.skipped ? `; ${r.skipped} already here` : ""} — being read for search, and ${name} watched`);
          } catch (e) { failed(e); }
          load();
        } }, "Link and watch it"))));
    sheet.hidden = false;
  }

  // `shortcutAlready`: moving in what is a shortcut here now — so "Shortcuts instead" would only be Cancel.
  async function bringIn(paths, how = "", into = null, folder = null, shortcutAlready = false) {
    const to = into || project || surface.project;
    if (!paths.length) return;
    if (!to) { say("Choose a project on the left first: that is where they go", true); return; }
    if (how === "shortcut") {
      let made = 0, skipped = 0, n = 0;
      for (const p of paths) {
        if (paths.length > 20 && ++n % 25 === 0) say(`Linking… ${n} of ${paths.length}`);
        try { await api("POST", "/files/shortcut", { project: to, path: p }); made++; } catch (e) { if (paths.length === 1) failed(e); else skipped++; }
      }
      // Read for search, in the background, as every file is: within a minute or so.
      if (made || skipped) say(`${made === 1 ? "A shortcut" : `${made} shortcuts`} in ${projectName(to)}${skipped ? `; ${skipped} already here or in its folder` : ""}${made ? " — being read for search" : ""}`);
      return load();
    }
    const sheet = $("sheet");
    const close = () => { sheet.hidden = true; sheet.replaceChildren(); };
    if (how !== "move") {
      // Asked first: a shortcut, which disturbs nothing, or moved in. A whole folder is linked, not moved.
      sheet.replaceChildren(el("div", { class: "sheet" },
        el("h3", {}, folder ? `Link ${paths.length}${folder.most ? "+" : ""} file${paths.length === 1 ? "" : "s"} from ${folder.folder} into ${projectName(to)}`
          : `Bring ${paths.length === 1 ? paths[0].split("/").pop() : `${paths.length} files`} into ${projectName(to)}`),
        el("p", {}, folder ? `Everything in it and its folders${folder.most ? ` (the first ${paths.length})` : ""}, hidden ones aside, as shortcuts: each stays where it is, shows here, and is read for search.`
          : "A shortcut leaves the file where it is and shows it here. Moving it puts the file itself in the project's folder."),
        el("div", { class: "acts" }, el("button", { class: "t-btn", onclick: close }, "Cancel"),
          folder ? null : el("button", { class: "t-btn", onclick: () => bringIn(paths, "move", to) }, "Move in…"),
          el("button", { class: "t-btn primary", onclick: () => { close(); bringIn(paths, "shortcut", to); } }, "Make shortcuts"))));
      sheet.hidden = false;
      return;
    }
    // Moving: each file checked, and every warning said before anything moves.
    const checks = [];
    for (const p of paths) {
      try { checks.push({ path: p, ...(await api("POST", "/files/bring-in/check", { project: to, path: p })) }); }
      catch (e) { checks.push({ path: p, error: e.message }); }
    }
    const ok = checks.filter((c) => !c.error);
    sheet.replaceChildren(el("div", { class: "sheet" },
      el("h3", {}, `Move into ${projectName(to)}?`),
      ...checks.map((c) => el("div", { class: "file" },
        el("div", { class: "fn" }, c.error ? c.path.split("/").pop() : c.name),
        el("div", { class: "from" }, `from ${c.path.replace(/^\/home\/[^/]+/, "~")}`),
        c.error ? el("ul", {}, el("li", {}, c.error))
          : c.warnings.length ? el("ul", {}, ...c.warnings.map((w) => el("li", {}, w.text))) : el("ul", { class: "fine" }, el("li", {}, "Nothing else is disturbed.")))),
      el("div", { class: "acts" }, el("button", { class: "t-btn", onclick: close }, "Cancel"),
        shortcutAlready ? null : el("button", { class: "t-btn", onclick: () => { close(); bringIn(ok.map((c) => c.path), "shortcut", to); } }, "Shortcuts instead"),
        ok.length ? el("button", { class: "t-btn primary", onclick: async () => {
          close();
          let moved = 0;
          for (const c of ok) {
            try { const row = await api("POST", "/files/bring-in", { project: to, path: c.path, confirmed: true }); chosen = row.key; moved++; } catch (e) { failed(e); }
          }
          if (moved) say(`${moved === 1 ? "Moved in" : `${moved} moved in`} to ${projectName(to)}`);
          await load();
        } }, ok.length === 1 ? "Move it in" : `Move ${ok.length} in`) : null)));
    sheet.hidden = false;
  }

  // Dropped on the panel: brought in, asked how.
  addEventListener("dragover", (e) => {
    if (![...(e.dataTransfer?.types || [])].includes("text/uri-list")) return;
    e.preventDefault();
    document.body.classList.add("dropping");
  });
  addEventListener("dragleave", (e) => { if (!e.relatedTarget) document.body.classList.remove("dropping"); });
  addEventListener("drop", (e) => {
    document.body.classList.remove("dropping");
    const uris = (e.dataTransfer?.getData("text/uri-list") || "").split(/\r?\n/).filter((u) => u.startsWith("file://"));
    if (!uris.length) return;
    e.preventDefault();
    bringIn(uris.map((u) => decodeURIComponent(u.slice(7))));
  });

  // ---------------------------------------------------------------- what is shown

  function setProject(id) {
    project = id;
    chosen = null;
    // A list is one project's: another project, no list.
    filters.list = "";
    reload();
  }
  function keepView() {
    const name = [project ? projectName(project) : "All", filters.q && `“${filters.q}”`, filters.type && TYPE_WORD[filters.type], filters.status && STATUS[filters.status],
      filters.days && `${filters.days}d`, ...filters.tags.map((t) => `#${t}`)].filter(Boolean).join(" · ");
    kept.push({ name, project, view, filters: { ...filters, tags: [...filters.tags] } });
    store.set("talaris.files.kept", kept);
    drawSide();
  }
  function useKept(k) {
    project = k.project;
    view = k.view;
    filters = { ...k.filters, tags: [...k.filters.tags] };
    $("q").value = filters.q;
    drawControls();
    reload();
  }

  function drawControls() {
    seg("view", [["folders", "Folders"], ["tree", "Tree"], ["type", "Type"], ["date", "Date"]], view, (v) => { view = v; store.set("talaris.files.view", v); drawControls(); reload(); });
    seg("days", [["0", "Any time"], ["1", "Today"], ["7", "Week"], ["31", "Month"]], String(filters.days), (v) => { filters.days = Number(v); drawControls(); reload(); });
    seg("readf", [["all", "All"], ["read", "Read"], ["unread", "Not read"]], readFilter, (v) => { readFilter = v; store.set("talaris.files.read", v); drawControls(); reload(); });
  }

  let typing = 0;
  // Escape clears it first, as every box that narrows a list does (kit.js).
  Kit.searchBox($("q"));
  $("q").addEventListener("input", () => { clearTimeout(typing); typing = setTimeout(() => { filters.q = $("q").value.trim(); reload(); }, Kit.SEARCH_MS); });
  // Files, or a whole folder (every file in it and its folders): asked which first.
  $("bring").addEventListener("click", () => {
    if (!bridge) return;
    const sheet = $("sheet");
    const close = () => { sheet.hidden = true; sheet.replaceChildren(); };
    sheet.replaceChildren(el("div", { class: "sheet" },
      el("h3", {}, "Add from elsewhere"),
      el("p", {}, "Some files, or a folder: everything in it and in its folders, linked where it is and read for search."),
      el("div", { class: "acts" }, el("button", { class: "t-btn", onclick: close }, "Cancel"),
        el("button", { class: "t-btn", onclick: () => { close(); bridge.chooseFolder(); } }, "A folder…"),
        el("button", { class: "t-btn primary", onclick: () => { close(); bridge.choose(); } }, "Files…"))));
    sheet.hidden = false;
  });
  $("reveal").addEventListener("click", () => {
    const p = projects.find((x) => x.id === (project || surface.project));
    if (p && bridge) bridge.reveal(p.folder);
  });

  // Keys: arrows through the rows, Enter opens, / finds, Escape puts away what is open, then the panel.
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      // What has heard Escape already (the list-name field, a box cleared) keeps it: the innermost first, then the panel.
      if (e.defaultPrevented) return;
      e.preventDefault();
      if (!$("sheet").hidden) { $("sheet").hidden = true; return; }
      if (bridge) bridge.file();
      return;
    }
    const inField = /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement?.tagName || "");
    if (e.key === "/" && !inField) { e.preventDefault(); $("q").focus(); $("q").select(); return; }
    if (inField) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const order = [...document.querySelectorAll("#rows .row[data-key]")].map((x) => x.dataset.key);
      const at = order.indexOf(chosen);
      chosen = order[Math.max(0, Math.min(order.length - 1, at + (e.key === "ArrowDown" ? 1 : -1)))] ?? null;
      drawRows(); drawDetail();
      document.querySelector("#rows .row.on")?.scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter") {
      const r = rows.find((x) => x.key === chosen);
      if (r) open(r);
    }
  });

  $("grow").addEventListener("click", () => bridge && bridge.grow());
  $("close").addEventListener("click", () => bridge && bridge.closeWindow());
  $("grow").innerHTML = Icons.grow();
  $("grow").title = "Make it a window";
  $("grow").hidden = WINDOW;
  $("close").innerHTML = Icons.close();
  $("close").title = "Close";
  $("close").hidden = !WINDOW;
  document.addEventListener("pointerdown", (e) => { if (!WINDOW && e.target === document.documentElement && bridge && surface.up) bridge.file(); });
  window.pressedAt = (x, y) => { if (!WINDOW && bridge && surface.up && document.elementFromPoint(x, y) === document.documentElement) bridge.file(); };
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
    // Opened on the project you are in, each time; All projects is a press away.
    if (project === null) project = s.project || "";
    if (WINDOW) return;
    if (s.up && !was.up) {
      if (s.project) { project = s.project; chosen = null; }
      Motion.arrive(document.body, how());
      if (bridge) loadProjects().then(load).catch(failed);
    }
  }

  drawControls();
  Surface.connect({ onState }).then((b) => {
    bridge = b;
    b.coreReply.connect((text) => { const r = JSON.parse(text); const done = waiting.get(r.id); waiting.delete(r.id); if (done) done(r); });
    // Files chosen are a list; a folder, {folder, paths}: linked where they are, after asking.
    b.chosen.connect((text) => {
      const got = JSON.parse(text);
      if (Array.isArray(got)) { bringIn(got); return; }
      linkFolder(got.folder);
    });
    b.leave.connect(() => {
      if (WINDOW) return;
      surface = { ...surface, up: false };
      $("sheet").hidden = true;
      const going = Motion.leave(document.body, how());
      if (going) going.onfinish = () => bridge.left(); else bridge.left();
    });
    if (project === null) project = surface.project || "";
    loadProjects().then(load).catch(failed);
  });
})();
