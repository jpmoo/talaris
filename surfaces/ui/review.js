// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore
//
// The weekly review's page (review.html; the core's review.ts): this week's steps, ticked; steps added for every
// week or for this week only, moved, changed, taken away; a step pointing at a thing (its card) or a collection
// (Tasks); when the review comes and where its task is filed. Everything asked of the core, and drawn from what it says.

"use strict";

(() => {
  const $ = (id) => document.getElementById(id);
  function el(tag, attrs = {}, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
      else if (k === "class") e.className = v;
      else if (k === "checked") e.checked = !!v;
      else if (k === "value") e.value = v;
      else e.setAttribute(k, v);
    }
    for (const k of kids.flat()) if (k != null && k !== "" && k !== false) e.append(k);
    return e;
  }

  let bridge = null;
  let surface = { up: false };
  const WINDOW = new URLSearchParams(location.search).has("window");
  if (WINDOW) document.documentElement.dataset.window = "1";

  const asked = Kit.core((id, method, path, body) => !!bridge && (bridge.core(id, method, path, body), true));
  const api = (method, path, body) => asked.call(method, path, body);
  function say(text, error = false) { Kit.say($("msg"), text, error, 0); }
  const failed = (e) => say(e.message, true);
  const enc = encodeURIComponent;

  const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  let st = null;          // the review, as the core says it
  let projects = [];      // every project, to file the task in
  let adding = null;      // the step being written: {scope, text, link, found}
  let editing = null;     // a step's id being changed
  // A date alone is that day where you are, not midnight in Greenwich (which would say the day before).
  const day = (iso) => (iso ? Kit.day(/^\d{4}-\d\d-\d\d$/.test(iso) ? `${iso}T00:00` : iso, { weekday: true }) : "");

  async function load() {
    try {
      [st, projects] = await Promise.all([api("GET", "/review"), api("GET", "/tasks/projects").catch(() => [])]);
      draw();
    } catch (e) { failed(e); }
  }
  const take = (p) => p.then((s) => { st = s; say(""); draw(); }).catch(failed);

  // ---------------------------------------------------------------- drawing

  function draw() {
    const main = $("main");
    if (!st) return;
    const parts = [];
    if (st.configured) {
      const t = st.task;
      parts.push(el("p", { class: "when" }, !t ? "No review task yet: choose its day below."
        : st.open ? ["Open now", t.due ? [" — due ", el("b", {}, day(t.due))] : ""]
        : ["Opens ", el("b", {}, day(t.available || t.due)), t.due && t.available ? ` · due ${day(t.due)}` : ""]));
      parts.push(el("div", { class: "steps" }, ...st.steps.map(stepRow)));
      if (!st.steps.length) parts.push(el("div", { class: "kit-empty" }, "No steps yet. Add the first below."));
      parts.push(addRow());
      if (st.allDone && t) {
        parts.push(el("div", { class: "finish" },
          el("button", { class: "t-btn primary", onclick: () => api("POST", `/tasks/${enc(t.id)}/done`, { done: true }).then(load).then(() => say("The review is done: next week's is on its way")).catch(failed) }, "Done — mark the review task complete")));
      }
    } else {
      parts.push(el("p", { class: "when" }, "Choose the day it is due, and Talaris keeps a “Do weekly review” task coming each week."));
    }
    parts.push(...settings());
    main.replaceChildren(...parts);
  }

  function stepRow(s) {
    if (editing === s.id) {
      const input = el("input", { type: "text", value: s.description, spellcheck: "true" });
      const save = () => take(api("PATCH", `/review/steps/${enc(s.id)}`, { description: input.value })).then(() => { editing = null; draw(); });
      input.addEventListener("keydown", (e) => { if (e.key === "Enter") save(); if (e.key === "Escape") { editing = null; draw(); } });
      setTimeout(() => input.focus(), 0);
      return el("div", { class: "step" }, input, el("button", { class: "t-btn", onclick: save }, "Save"));
    }
    const link = s.link ? el("span", { class: "link", onclick: (e) => { e.stopPropagation(); open(s.link); } }, s.label || "Open") : null;
    // Its words pressed, changed in place (Enter keeps, Escape leaves them).
    const edit = () => { editing = s.id; draw(); };
    const what = el("span", { class: "what", title: "Change its words", tabindex: "0", role: "button", onclick: edit,
      onkeydown: (e) => { if (e.key === "Enter") { e.preventDefault(); edit(); } } },
      s.description, s.description && link ? " — " : "", link);
    // Taken out with the small × every row has. A step of this week only goes on one press; one of every week's
    // asks first, since it leaves every review to come (UX-AUDIT 2.4).
    const x = el("button", { class: "x-btn danger", title: s.template ? "Take it out of every week's review" : "Take it out" });
    x.innerHTML = Icons.close();
    const remove = () => take(api("DELETE", `/review/steps/${enc(s.id)}`));
    if (s.template) Kit.twice(x, { key: `review-step-${s.id}`, ask: "Remove from every week?", act: remove });
    else x.addEventListener("click", (e) => { e.stopPropagation(); remove(); });
    const row = el("div", { class: "step" + (s.done ? " done" : ""), "data-id": s.id },
      el("input", { type: "checkbox", checked: s.done, "aria-label": s.description || s.label || "Step",
        onchange: (e) => take(api("POST", `/review/steps/${enc(s.id)}/done`, { done: e.target.checked })) }),
      what,
      s.template ? null : el("span", { class: "tag", title: "For this week only" }, "this week"),
      x);
    sortable(row, s.id);
    return row;
  }

  // Put in order by dragging, as every list is (kit.js): the one drop line above or below a neighbor, and the whole
  // order given back to the core.
  function sortable(row, id) {
    Kit.draggable(row, { step: id }, { ignore: "button, input, .link" });
    Kit.dropZone(row, {
      accepts: (p) => !!(p && p.step) && p.step !== id,
      drop: (p, where) => {
        const ids = st.steps.map((x) => x.id).filter((x) => x !== p.step);
        ids.splice(ids.indexOf(id) + (where === "below" ? 1 : 0), 0, p.step);
        take(api("PUT", "/review/steps/order", { ids }));
      },
    });
  }

  function open(link) {
    if (!bridge) return;
    if (link.kind === "list") bridge.openList(link.id);
    else bridge.libraryAt(`e:${link.id}`);
  }

  function addRow() {
    if (!adding) {
      return el("div", { class: "add" },
        el("button", { class: "t-btn", onclick: () => { adding = { scope: "template", text: "", link: null, found: null }; draw(); } }, "+ Step, every week"),
        st.configured && st.open ? el("button", { class: "t-btn", onclick: () => { adding = { scope: "cycle", text: "", link: null, found: null }; draw(); } }, "+ Step, this week only") : null);
    }
    const text = el("input", { type: "text", value: adding.text, placeholder: adding.scope === "cycle" ? "A step for this week only" : "A step for every week", spellcheck: "true" });
    text.addEventListener("input", () => { adding.text = text.value; });
    const find = el("input", { type: "text", placeholder: "Point it at… (a thing or a collection, optional)", spellcheck: "false" });
    let typed = null;
    find.addEventListener("input", () => { clearTimeout(typed); typed = setTimeout(() => search(find.value), Kit.SEARCH_MS); });
    const save = () => {
      if (!adding.text.trim() && !adding.link) return say("Say what the step is, or point it at something", true);
      take(api("POST", "/review/steps", { description: adding.text.trim(), link: adding.link, scope: adding.scope })).then(() => { adding = null; draw(); });
    };
    text.addEventListener("keydown", (e) => { if (e.key === "Enter") save(); if (e.key === "Escape") { adding = null; draw(); } });
    setTimeout(() => text.focus(), 0);
    const unpoint = () => {
      const b = el("button", { class: "x-btn", title: "Point it at nothing", onclick: () => { adding.link = null; draw(); } });
      b.innerHTML = Icons.close();
      return b;
    };
    return el("div", {},
      el("div", { class: "add" }, text),
      el("div", { class: "add" }, adding.link ? el("span", {}, "Points at ", el("b", {}, adding.link.label), " ", unpoint()) : find),
      adding.found ? el("div", { class: "found" }, ...adding.found.map((f) => el("button", { onclick: () => { adding.link = f; adding.found = null; draw(); } }, f.label, el("small", {}, f.what)))) : null,
      el("div", { class: "add" },
        el("button", { class: "t-btn primary", onclick: save }, "Add"),
        el("button", { class: "t-btn", onclick: () => { adding = null; draw(); } }, "Cancel")));
  }

  async function search(q) {
    if (!adding) return;
    if (!q.trim()) { adding.found = null; draw(); return; }
    try {
      const [things, lists] = await Promise.all([
        api("GET", `/mentionables?q=${enc(q)}&limit=8`).catch(() => []),
        api("GET", "/lists").catch(() => []),
      ]);
      const ql = q.toLowerCase();
      adding.found = [
        ...(Array.isArray(lists) ? lists : []).filter((l) => String(l.name || "").toLowerCase().includes(ql)).slice(0, 4)
          .map((l) => ({ kind: "list", id: l.id, label: l.name, what: "collection" })),
        ...(Array.isArray(things) ? things : []).map((t) => ({ kind: "thing", id: t.id, label: t.title, what: t.kind || "" })),
      ];
      draw();
    } catch (e) { failed(e); }
  }

  function settings() {
    const pick = (b) => take(api("PUT", "/review/config", b));
    const chosen = new Set(st.project || []);
    // The projects as Tasks has them: what a task is filed in is the project's thing, by its id.
    const list = Array.isArray(projects) ? projects : [];
    return [
      el("h3", {}, "When it comes"),
      el("div", { class: "row" }, el("span", { class: "name" }, "Due on"),
        el("select", { onchange: (e) => pick({ dueWeekday: e.target.value === "" ? null : Number(e.target.value) }) },
          el("option", { value: "" }, "No weekly review"),
          ...DAYS.map((d, i) => { const o = el("option", { value: String(i) }, d); if (st.dueWeekday === i) o.selected = true; return o; }))),
      el("div", { class: "row" }, el("span", { class: "name" }, "Open it before"),
        el("select", { onchange: (e) => pick({ availableDaysPrior: Number(e.target.value) }) },
          ...[0, 1, 2, 3, 4, 5, 6].map((n) => { const o = el("option", { value: String(n) }, n === 0 ? "On the day" : `${n} day${n > 1 ? "s" : ""} before`); if (st.availableDaysPrior === n) o.selected = true; return o; }))),
      el("div", { class: "row" }, el("span", { class: "name" }, "Its task filed in"),
        el("span", { class: "projects" }, ...list.map((p) => el("button", { class: chosen.has(p.id) ? "on" : "",
          onclick: () => { if (chosen.has(p.id)) chosen.delete(p.id); else chosen.add(p.id); pick({ project: [...chosen] }); } }, p.title)))),
    ];
  }

  // ---------------------------------------------------------------- keys, buttons, coming and going

  document.addEventListener("keydown", (e) => {
    if (e.defaultPrevented) return;
    if (e.key === "Escape" && !adding && editing === null) { e.preventDefault(); if (bridge) bridge.file(); }
  });
  $("grow").addEventListener("click", () => bridge && bridge.grow());
  $("close").addEventListener("click", () => bridge && bridge.closeWindow());
  $("grow").innerHTML = Icons.grow();
  $("grow").title = "Open as a window";
  $("grow").hidden = WINDOW;
  $("close").innerHTML = Icons.close();
  $("close").title = "Close";
  $("close").hidden = !WINDOW;
  document.addEventListener("pointerdown", (e) => { if (!WINDOW && e.target === document.documentElement && bridge && surface.up) bridge.file(); });
  window.pressedAt = (x, y) => { if (!WINDOW && bridge && surface.up && document.elementFromPoint(x, y) === document.documentElement) bridge.file(); };
  for (const t of ["pointerdown", "keydown", "wheel"]) addEventListener(t, () => bridge && bridge.activity(), { capture: true, passive: true });

  function how() {
    const m = surface.motion || {};
    return { kind: m.motion, speed: m.speed, edge: "top", flush: false, viewport: surface.viewport,
      shown: () => bridge && bridge.drawn(),
      rules: (rule, rel, P) => { const h = document.querySelector("header").getBoundingClientRect(); rule(rel(P.left, h.bottom), rel(P.right, h.bottom)); } };
  }
  function onState(s) {
    const was = surface;
    surface = s;
    if (WINDOW) return;
    if (s.up && !was.up) {
      Motion.arrive(document.body, how());
      if (bridge) load();
    }
  }
  Surface.connect({ onState }).then((b) => {
    bridge = b;
    b.coreReply.connect((text) => asked.reply(JSON.parse(text)));
    b.leave.connect(() => {
      if (WINDOW) return;
      surface = { ...surface, up: false };
      adding = null; editing = null;
      const going = Motion.leave(document.body, how());
      if (going) going.onfinish = () => bridge.left(); else bridge.left();
    });
    if (WINDOW || surface.up) load();
  });
})();
