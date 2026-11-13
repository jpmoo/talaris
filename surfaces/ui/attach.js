// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore
//
// Attach, the one way everywhere: a note's page, a task's card, and whatever
// else takes files. A file is never copied to attach it — a second copy is one
// that goes stale the first time either is changed.
//
//   1. What is in this thing's project, first: its Library's files, found by
//      typing. One chosen is attached where it is.
//   2. Everywhere else, by the same typing: a file in another project asks
//      Move here (into this project's Files; what links it follows, files.ts)
//      or Shortcut here (it stays where it is, and is in this project too).
//   3. Attach an outside file…: the desktop's chooser, the caller's to open.
//
// The caller says what attaching means for it: a link in a page's words, a
// file linked on a task. `pick` is given the file as it now is:
//   { name, project, path, abs, here }  — `here`: in this project's folder;
//   otherwise `project`/`path` are where it lives (a shortcut's, a file left in
//   another project).

"use strict";

window.Attach = (() => {
  const el = Kit.el;
  const enc = encodeURIComponent;
  const dirOf = (path) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
  let projectNames = new Map();

  /**
   * Opens the picker under `anchor`.
   *   api(method, path, body)  the core
   *   project  the id of the project of the thing attached to (its name and folder are looked up)
   *   pick(file)  one chosen, as it now is (above)
   *   outside()  the desktop's chooser, for a file from outside the Library (omitted: no such button)
   */
  async function open(anchor, { api, project: projectId, pick, outside }) {
    const find = Kit.searchBox(el("input", { type: "search", class: "find", placeholder: `Find a file to attach`, spellcheck: "false" }));
    const body = el("div", { class: "attach-list" }, el("div", { class: "hint" }, "Looking…"));
    const foot = outside ? el("div", { class: "attach-foot" },
      el("button", { class: "t-btn small", onclick: () => { Kit.popAway(); outside(); } }, "Attach an outside file…")) : "";
    Kit.pop(anchor, el("div", { class: "attach-pick" }, find, body, foot));
    setTimeout(() => find.focus(), 0);

    // Asked each time: a project made or renamed since is known by its name now.
    let all = [];
    try { all = (await api("GET", "/projects")) || []; } catch { all = []; }
    projectNames = new Map(all.map((p) => [p.id, p.name]));
    const known = all.find((p) => p.id === projectId) || {};
    const project = { id: projectId, name: known.name || "this project", folder: known.folder || "" };
    let mine = [];
    try {
      const got = await api("GET", `/files?project=${enc(project.id)}&sort=date&limit=600`);
      // Files only: a canvas or a conversation is attached by naming it (@), not as a file.
      mine = ((got && got.rows) || []).filter((r) => !r.thing && (r.path || r.livesIn));
    } catch (err) {
      body.replaceChildren(el("div", { class: "hint err" }, err.message || "The Library could not be read"));
      return;
    }
    let elsewhere = [];
    let asked = 0;

    const asFile = (r) => {
      // A shortcut here to a file in another project's folder: attached where that file lives.
      if (r.livesIn) return { name: r.name, project: r.livesIn.project, path: r.livesIn.path, abs: r.abs, here: false };
      return { name: r.name, project: r.project, path: r.path, abs: r.abs, here: r.project === project.id && Boolean(r.path) };
    };
    const row = (r, where, act) => el("button", { class: "menu-item attach-row", title: r.abs || r.path || r.name, onclick: (e) => { e.stopPropagation(); act(); } },
      el("span", { class: "lbl" }, r.name), where ? el("span", { class: "n" }, where) : "");
    const chosen = (r) => { Kit.popAway(); pick(asFile(r)); };

    // A file in another project: brought here, or a shortcut made, as asked.
    const askHow = (r) => {
      const from = projectNames.get(r.project) || "another project";
      body.replaceChildren(
        el("div", { class: "hint" }, `“${r.name}” is in ${from}.`),
        el("button", { class: "menu-item", onclick: async (e) => {
          e.stopPropagation();
          try {
            const moved = await api("POST", "/files/move", { project: r.project, path: r.path, toProject: project.id, toDir: "Files" });
            Kit.popAway();
            pick({ name: r.name, project: project.id, path: moved.path, abs: project.folder ? `${project.folder.replace(/\/$/, "")}/${moved.path}` : "", here: true });
          } catch (err) { body.prepend(el("div", { class: "hint err" }, err.message)); }
        } }, el("span", { class: "lbl" }, `Move it into ${project.name}’s Files`)),
        el("button", { class: "menu-item", onclick: async (e) => {
          e.stopPropagation();
          try {
            if (r.abs) await api("POST", "/files/shortcut", { project: project.id, path: r.abs });
            chosen(r);
          } catch (err) { body.prepend(el("div", { class: "hint err" }, err.message)); }
        } }, el("span", { class: "lbl" }, `Shortcut: it stays in ${from}, and is in ${project.name} too`)),
        el("button", { class: "menu-item", onclick: (e) => { e.stopPropagation(); draw(); } }, el("span", { class: "lbl" }, "Back")));
    };

    function draw() {
      const q = find.value.trim().toLowerCase();
      const here = mine.filter((r) => !q || Kit.matches(q, r.name, r.path || ""));
      const out = [el("div", { class: "attach-head" }, `In ${project.name}`)];
      out.push(...(here.length ? here.slice(0, 60).map((r) => row(r, r.livesIn ? `in ${projectNames.get(r.livesIn.project) || "another project"}` : dirOf(r.path), () => chosen(r)))
        : [el("div", { class: "hint" }, q ? "Nothing here by that name" : "No files here yet")]));
      if (q) {
        out.push(el("div", { class: "attach-head" }, "Elsewhere"));
        out.push(...(elsewhere.length ? elsewhere.map((r) => row(r, projectNames.get(r.project) || "", () => askHow(r)))
          : [el("div", { class: "hint" }, "Nothing elsewhere by that name")]));
      }
      body.replaceChildren(...out);
    }
    // The rest of the Library, asked once typing pauses.
    const searchElsewhere = Kit.debounce(async () => {
      const q = find.value.trim();
      const mineAsked = ++asked;
      if (!q) { elsewhere = []; draw(); return; }
      try {
        const got = await api("GET", `/files?q=${enc(q)}&limit=40`);
        if (mineAsked !== asked) return;
        elsewhere = ((got && got.rows) || []).filter((r) => r.project !== project.id && r.path && !r.thing).slice(0, 15);
      } catch { elsewhere = []; }
      draw();
    }, Kit.SEARCH_MS);
    find.addEventListener("input", () => { draw(); searchElsewhere(); });
    find.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      const first = body.querySelector(".attach-row");
      if (first) first.click();
    });
    draw();
  }

  /** A page's link to a file, in its words: `@<project>/` before it when the file lives in another project (projects.ts, attachedFile). */
  function pageLink(file, pageProject) {
    const rel = file.project === pageProject ? file.path : `@${file.project}/${file.path}`;
    const link = encodeURI(rel).replace(/\(/g, "%28").replace(/\)/g, "%29");
    return `[${file.name.replace(/[[\]]/g, "")}](talaris-file:${link})`;
  }

  return { open, pageLink };
})();
