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
  let filters = { q: "", status: "", type: "", days: 0, tags: [] };
  let kept = store.get("talaris.files.kept", []);
  let projects = [];
  let rows = [];
  // How far search has read each file (the core's meaning.ts): `waiting` until it has; and whether it reads at all.
  let readState = {};
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

  const STATUS = { folder: "In the folder", page: "A writing page", shortcut: "Shortcut", linked: "Linked on a task", snapshot: "Stored on a task", missing: "Missing from its folder",
    unread: "Not read yet" };
  const MARK = { page: "page", shortcut: "↗ shortcut", linked: "↗ linked", snapshot: "on a task", missing: "missing" };
  const TYPES = [["document", "Documents"], ["spreadsheet", "Spreadsheets"], ["presentation", "Presentations"], ["pdf", "PDFs"], ["image", "Images"],
    ["audio", "Audio"], ["video", "Video"], ["code", "Code"], ["archive", "Archives"], ["other", "Other"]];
  const TYPE_WORD = Object.fromEntries(TYPES);
  const TYPE_COLOR = { document: "#7f9fbf", spreadsheet: "#8aa878", presentation: "#c98a5b", pdf: "#c26b6b", image: "#b97f8e", audio: "#5fa4b5",
    video: "#6c7277", code: "#868c92", archive: "#c7a55a", other: "#9a9a9a" };
  const ON_KIND = { task: "task", contact: "person", event: "event", note: "note", project: "project", thing: "thing" };
  const projectName = (id) => (projects.find((p) => p.id === id) || {}).name || "a project";
  const size = (n) => (n == null ? "" : n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`);
  function when(iso) {
    if (!iso) return "";
    const d = new Date(iso), now = new Date();
    if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    return d.toLocaleDateString([], { month: "short", day: "numeric", ...(d.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}) });
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

  // ---------------------------------------------------------------- loading

  async function loadProjects() {
    projects = await api("GET", "/projects");
  }

  async function load() {
    const q = new URLSearchParams();
    if (project) q.set("project", project);
    if (filters.q) q.set("q", filters.q);
    // "Not read yet" is told here, from what the core says of each; the rest it filters itself.
    if (filters.status && filters.status !== "unread") q.set("status", filters.status);
    if (filters.type) q.set("type", filters.type);
    if (filters.days) q.set("days", String(filters.days));
    for (const t of filters.tags) q.append("tag", t);
    q.set("sort", view === "date" ? "date" : "name");
    const got = await api("GET", `/files?${q}`);
    readState = got.read || {};
    reading = got.reading || reading;
    rows = filters.status === "unread" ? got.rows.filter((r) => readState[r.key] === "waiting") : got.rows;
    total = filters.status === "unread" ? rows.length : got.total;
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

  function drawSide() {
    const here = surface.project;
    const item = (label, on, onclick, extra) => el("button", { class: `s-item${on ? " on" : ""}`, onclick }, el("span", { class: "nm" }, label), extra);
    const tagsHere = [...new Set(rows.flatMap((r) => r.tags))].sort();
    const shown = [...new Set([...tagsHere, ...filters.tags])];
    $("side").replaceChildren(...[
      el("div", { class: "s-head" }, "Projects"),
      item("All projects", project === "", () => setProject("")),
      ...projects.map((p) => item(p.name, project === p.id, () => setProject(p.id), p.id === here ? el("span", { class: "here" }, "here") : null)),
      shown.length ? el("div", { class: "s-head" }, "Tags") : null,
      ...shown.map((t) => item(`#${t}`, filters.tags.includes(t), () => {
        filters.tags = filters.tags.includes(t) ? filters.tags.filter((x) => x !== t) : [...filters.tags, t];
        reload();
      })),
      el("div", { class: "s-head" }, "What it is"),
      ...Object.entries(STATUS).map(([k, label]) => item(label, filters.status === k, () => { filters.status = filters.status === k ? "" : k; reload(); })),
      el("div", { class: "s-head" }, "Type"),
      ...TYPES.map(([k, label]) => item(label, filters.type === k, () => { filters.type = filters.type === k ? "" : k; reload(); })),
      el("div", { class: "s-head" }, "Kept views"),
      ...kept.map((k, i) => item(k.name, false, () => useKept(k), el("span", { class: "x", title: "Forget it", onclick: (e) => {
        e.stopPropagation(); kept.splice(i, 1); store.set("talaris.files.kept", kept); drawSide();
      } }, "×"))),
      el("button", { class: "t-btn s-keep", onclick: keepView }, "+ Keep this view")].filter(Boolean));
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
      else if (!r.path) put(`${pre}From elsewhere`, r, [pIndex(r.project), 2, ""]);
      else put(`${pre}${whereOf(r) || "Top"}`, r, [pIndex(r.project), whereOf(r) ? 1 : 0, whereOf(r).toLowerCase()]);
    }
    const cmp = (a, b) => { for (let i = 0; i < a.length; i++) { if (a[i] < b[i]) return -1; if (a[i] > b[i]) return 1; } return 0; };
    return [...out].sort((a, b) => cmp(a[1].rank, b[1].rank)).map(([k, g]) => [k, g.rows]);
  }

  function rowEl(r) {
    const gone = r.status.includes("missing");
    const where = view === "folders" ? "" : (project ? whereOf(r) : `${projectName(r.project)}${whereOf(r) ? ` / ${whereOf(r)}` : ""}`);
    return el("div", { class: `row${r.key === chosen ? " on" : ""}${gone ? " gone" : ""}`, "data-key": r.key,
      onclick: () => { chosen = r.key; drawRows(); drawDetail(); }, ondblclick: () => open(r) },
      el("span", { class: "ic", style: `background:${TYPE_COLOR[r.type] || TYPE_COLOR.other}` }, (r.name.split(".").pop() || "").slice(0, 3).toUpperCase()),
      el("span", { class: "nm", title: r.abs || r.name }, r.name, where ? el("span", { class: "where" }, where) : null),
      el("span", { class: "marks" },
        ...r.status.filter((s) => MARK[s]).map((s) => el("span", { class: `mk ${s}` }, MARK[s])),
        readState[r.key] === "waiting" ? el("span", { class: "mk unread", title: "Search has not read what it says yet: it will, in the background" }, "not read yet") : null,
        r.alsoIn && r.alsoIn.length ? el("span", { class: "mk on", title: r.alsoIn.map(projectName).join(", ") }, `also in ${r.alsoIn.length === 1 ? projectName(r.alsoIn[0]) : `${r.alsoIn.length} projects`}`) : null,
        r.on.length ? el("span", { class: "mk on", title: r.on.map((o) => o.title).join(", ") }, `on ${r.on.length === 1 ? r.on[0].title : `${r.on.length} things`}`) : null,
        ...r.tags.slice(0, 3).map((t) => el("span", { class: "mk tag" }, `#${t}`))),
      el("span", { class: "date" }, when(r.mtime)),
      el("span", { class: "size" }, size(r.size)));
  }

  function drawRows() {
    if (!rows.length) {
      $("rows").replaceChildren(el("div", { class: "empty" }, filters.q || filters.status || filters.type || filters.days || filters.tags.length
        ? "Nothing like that." : `No files here yet. Add some with Add from elsewhere${WINDOW ? ", or drop them on this window" : ""}.`));
      return;
    }
    $("rows").replaceChildren(...groupsOf(rows).flatMap(([name, list]) => [
      el("div", { class: "g-head" }, name, el("span", { class: "n" }, String(list.length))), ...list.map(rowEl)]));
  }

  // ---------------------------------------------------------------- the one chosen

  let armed = "";
  function drawDetail() {
    const r = rows.find((x) => x.key === chosen);
    if (!r) { $("detail").replaceChildren(el("div", { class: "empty" }, "Choose a file to see what it is and what can be done with it.")); return; }
    const s = r.status;
    const said = [];
    if (s.includes("folder")) said.push(el("span", {}, el("b", {}, "In the folder"), ` of ${projectName(r.project)}.`));
    if (s.includes("page")) said.push(el("span", {}, el("b", {}, "A writing page"), " — Writing opens it, and moves and renames it with its children."));
    if (s.includes("shortcut")) said.push(el("span", {}, el("b", {}, "A shortcut"), ` in ${projectName(r.project)} to a file that lives ${r.livesIn ? `in ${projectName(r.livesIn.project)}'s folder` : "elsewhere"}. Nothing of it is in this project's folder.`));
    if (r.alsoIn && r.alsoIn.length) said.push(el("span", {}, el("b", {}, "Also in"), ` ${r.alsoIn.map(projectName).join(", ")}${r.status.includes("folder") ? ", by a shortcut there" : ""}.`));
    if (s.includes("linked")) said.push(el("span", {}, el("b", {}, "Linked on a task"), " from where it lives, outside every project."));
    if (s.includes("snapshot")) said.push(el("span", {}, el("b", {}, "Stored on a task"), `${r.fromHermes ? ", from Hermes Notes" : ""} — in no folder until it is saved to the project's.`));
    if (s.includes("missing")) said.push(el("span", { class: "bad" }, el("b", {}, "Missing from its folder:"), " moved or deleted."));
    if (r.sealed) said.push(el("span", {}, "Sealed: it opens as a copy, since only Talaris can read it."));
    // What search knows of what it says.
    const rs = readState[r.key];
    if (rs === "read") said.push(el("span", {}, el("b", {}, "Read"), " — found by what it says, by search and Morgan, and suggested with what it is about."));
    else if (rs === "nowords") said.push(el("span", {}, el("b", {}, "Read, no words in it"), " — found by its name only."));
    else if (rs === "waiting") said.push(el("span", {}, el("b", {}, "Not read yet"), reading.indexing ? " — being read now." : " — it will be, in the background, in a few minutes."));
    else if (!reading.on && !s.includes("page") && !s.includes("missing")) said.push(el("span", {}, "Not read: search by meaning is off (Settings, Data)."));
    const lines = [
      r.path ? ["Where", r.path] : r.abs ? ["Where", r.abs.replace(/^\/home\/[^/]+/, "~")] : null,
      ["Type", TYPE_WORD[r.type] || "Other"],
      r.size != null ? ["Size", size(r.size)] : null,
      r.mtime ? ["Changed", new Date(r.mtime).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })] : null,
    ].filter(Boolean);
    const acts = [];
    const act = (label, fn, cls = "") => acts.push(el("button", { class: `t-btn ${cls}`, onclick: fn }, label));
    if (s.includes("page")) act("Open in Writing", () => bridge.page(r.project, r.path));
    else if (!s.includes("missing")) act(s.includes("snapshot") || r.sealed ? "Open a copy" : "Open", () => open(r));
    if (r.abs && !s.includes("missing")) act("Show in Files", () => bridge.reveal(r.abs));
    if (r.abs && !s.includes("missing") && !s.includes("page")) act("Pin to the dock", () => { bridge.pin(r.abs, r.name); say(`${r.name} pinned to the dock, in this project`); });
    if (s.includes("folder") && !s.includes("page")) {
      act("Rename", () => inline("rename", r));
      act("Move", () => inline("move", r));
    }
    if (s.includes("shortcut") && !s.includes("missing")) act("Move it in…", () => bringIn([r.abs], "move", r.project));
    if (s.includes("linked") && !s.includes("missing")) act("Make it a shortcut here", () => api("POST", "/files/shortcut", { project: r.project, path: r.abs }).then(reload, failed));
    if (s.includes("snapshot")) act("Save to the project folder", () => api("POST", "/files/snapshot/save", { holder: r.holder, sha256: r.sha256, project: r.project })
      .then((x) => { say(`Saved as ${x.path}`); chosen = `p:${r.project}/${x.path}`; return load(); }).catch(failed));
    if (r.abs && !s.includes("missing") && !s.includes("page")) act("Attach to a task…", () => inline("attach", r));
    if (r.abs && !s.includes("missing") && !s.includes("page")) act("Also in another project…", () => inline("also", r));
    if (r.livesIn) act(`Go to it in ${projectName(r.livesIn.project)}`, () => { project = r.livesIn.project; chosen = `p:${r.livesIn.project}/${r.livesIn.path}`; reload(); });
    if (s.includes("shortcut")) act(armed === r.key ? "Yes, take the shortcut away" : "Remove the shortcut", () => {
      if (armed !== r.key) { armed = r.key; drawDetail(); return; }
      armed = "";
      api("DELETE", `/files/shortcut/${enc(r.entity)}`).then(() => { say("Shortcut removed; the file is where it was"); return load(); }).catch(failed);
    }, `danger${armed === r.key ? " armed" : ""}`);
    if (s.includes("folder") && !s.includes("page")) act(armed === r.key ? "Yes, to the trash" : "Delete…", () => {
      if (armed !== r.key) { armed = r.key; drawDetail(); return; }
      armed = "";
      api("POST", "/files/trash", { project: r.project, path: r.path }).then(() => { say(`${r.name} is in the trash`); chosen = null; return load(); }).catch(failed);
    }, `danger${armed === r.key ? " armed" : ""}`);

    const taggable = (s.includes("folder") && !s.includes("page")) || s.includes("shortcut");
    $("detail").replaceChildren(...[
      el("h2", {}, r.name),
      el("div", { class: "d-status" }, ...said.flatMap((x, i) => (i ? [" ", x] : [x]))),
      ...lines.map(([k, v]) => el("div", { class: "d-line" }, el("span", { class: "k" }, k), el("span", { class: "v" }, v))),
      r.on.length ? el("div", { class: "d-sub" }, "On") : null,
      ...r.on.map((o) => el("button", { class: "on-item", onclick: () => bridge.thing(o.kind === "contact" ? "person" : o.kind, o.id) }, o.title, el("span", { class: "kind" }, ON_KIND[o.kind] || o.kind))),
      taggable ? el("div", { class: "d-sub" }, "Tags") : null,
      taggable ? tagEditor(r) : null,
      el("div", { class: "d-sub" }, "Do"),
      el("div", { class: "d-acts" }, ...acts),
      el("div", { id: "inline" })].filter(Boolean));
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
      const drawPicks = () => picks.replaceChildren(...projects.map((p) => el("button", { class: `t-btn${p.id === to.value ? " on" : ""}`, onclick: () => { to.value = p.id; drawPicks(); } }, p.name)));
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
      const left = projects.filter((p) => !taken.has(p.id));
      host.replaceChildren(left.length ? el("div", { class: "pick-list" }, ...left.map((p) => el("button", { class: "t-btn", onclick: () => api("POST", "/files/shortcut", { project: p.id, path: r.abs })
        .then(() => { say(`${r.name} is in ${projectName(p.id)} too`); return load(); }).catch(failed) }, p.name)))
        : el("span", { class: "hint" }, "It is in every project already."));
    } else if (what === "attach") {
      const q = el("input", { type: "text", placeholder: "Find a task", spellcheck: "false" });
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
  async function bringIn(paths, how = "", into = null) {
    const to = into || project || surface.project;
    if (!paths.length) return;
    if (!to) { say("Choose a project on the left first: that is where they go", true); return; }
    if (how === "shortcut") {
      let made = 0;
      for (const p of paths) {
        try { await api("POST", "/files/shortcut", { project: to, path: p }); made++; } catch (e) { failed(e); }
      }
      if (made) say(`${made === 1 ? "A shortcut" : `${made} shortcuts`} in ${projectName(to)}`);
      return load();
    }
    const sheet = $("sheet");
    const close = () => { sheet.hidden = true; sheet.replaceChildren(); };
    if (how !== "move") {
      // Asked first: a shortcut, which disturbs nothing, or moved in.
      sheet.replaceChildren(el("div", { class: "sheet" },
        el("h3", {}, `Bring ${paths.length === 1 ? paths[0].split("/").pop() : `${paths.length} files`} into ${projectName(to)}`),
        el("p", {}, "A shortcut leaves the file where it is and shows it here. Moving it puts the file itself in the project's folder."),
        el("div", { class: "acts" }, el("button", { class: "t-btn", onclick: close }, "Cancel"),
          el("button", { class: "t-btn", onclick: () => bringIn(paths, "move", to) }, "Move in…"),
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
        el("button", { class: "t-btn", onclick: () => { close(); bringIn(ok.map((c) => c.path), "shortcut", to); } }, "Shortcuts instead"),
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
    seg("view", [["folders", "Folders"], ["type", "Type"], ["date", "Date"]], view, (v) => { view = v; store.set("talaris.files.view", v); drawControls(); reload(); });
    seg("days", [["0", "Any time"], ["1", "Today"], ["7", "Week"], ["31", "Month"]], String(filters.days), (v) => { filters.days = Number(v); drawControls(); reload(); });
  }

  let typing = 0;
  $("q").addEventListener("input", () => { clearTimeout(typing); typing = setTimeout(() => { filters.q = $("q").value.trim(); reload(); }, 180); });
  $("bring").addEventListener("click", () => bridge && bridge.choose());
  $("reveal").addEventListener("click", () => {
    const p = projects.find((x) => x.id === (project || surface.project));
    if (p && bridge) bridge.reveal(p.folder);
  });

  // Keys: arrows through the rows, Enter opens, / finds, Escape puts away what is open, then the panel.
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      if (!$("sheet").hidden) { $("sheet").hidden = true; return; }
      if (armed) { armed = ""; drawDetail(); return; }
      if (bridge) bridge.file();
      return;
    }
    const inField = /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement?.tagName || "");
    if (e.key === "/" && !inField) { e.preventDefault(); $("q").focus(); $("q").select(); return; }
    if (inField) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const order = [...document.querySelectorAll("#rows .row")].map((x) => x.dataset.key);
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
    return { kind: m.motion, speed: m.speed, edge: "top", flush: false, backdrop: document.documentElement, viewport: surface.viewport,
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
    b.chosen.connect((text) => bringIn(JSON.parse(text)));
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
