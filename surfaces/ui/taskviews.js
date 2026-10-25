// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore
//
// The Tasks panel's other views of a list: table, board, matrix and calendar
// (TASKS-CONTRACT.md). Each is drawn whole from the core's `Shown` on every
// render and keeps nothing of its own but what a person would expect to stay
// put across a refresh — the calendar's month, a folded group, the drawer's
// search, where the view was scrolled.
//
// What a task is comes from its type's task profile — the status field, the
// values that count as complete, the datespan that is available and due —
// never from a type's or a field's name. Changing a task goes through the
// panel (ctx.update, ctx.setStatus, ctx.newTask); placing one goes to the
// list's members, and the core does what a region means.

"use strict";

const TaskViews = (() => {
  function el(tag, attrs = {}, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
      else if (k === "class") e.className = v;
      else if (k === "style") e.setAttribute("style", v);
      else e.setAttribute(k, v === true ? "" : v);
    }
    for (const k of kids.flat()) if (k != null && k !== "" && k !== false) e.append(k);
    return e;
  }
  const svg = (body, size = 12) => {
    const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    s.setAttribute("viewBox", "0 0 14 14"); s.setAttribute("width", size); s.setAttribute("height", size);
    s.setAttribute("fill", "none"); s.setAttribute("stroke", "currentColor"); s.setAttribute("stroke-width", "1.6");
    s.setAttribute("stroke-linecap", "round"); s.setAttribute("stroke-linejoin", "round");
    s.innerHTML = body;
    return s;
  };
  const ICON = {
    plus: () => svg('<path d="M7 2.5v9M2.5 7h9"/>'),
    prev: () => svg('<path d="M9 2.5 4.5 7 9 11.5"/>', 13),
    next: () => svg('<path d="M5 2.5 9.5 7 5 11.5"/>', 13),
    fold: (open) => svg(open ? '<path d="M3 5.5 7 9.5l4-4"/>' : '<path d="M5.5 3 9.5 7l-4 4"/>', 11),
    pen: () => svg('<path d="M9.5 2.5 11.5 4.5 5 11H3V9z"/>', 11),
    // A region that does something on entering: an arrow going in.
    enter: () => svg('<path d="M2 7h7M6.5 4.5 9 7 6.5 9.5M11.5 2.5v9"/>', 10),
  };
  const enc = encodeURIComponent;

  // ---------------------------------------------------------------- dates
  //
  // A task's dates are wall-clock strings, "YYYY-MM-DD" or "YYYY-MM-DDTHH:MM",
  // with no zone; they are read and written as such and only made Dates to
  // count days.

  const DAY_MS = 86400000;
  const pad = (n) => String(n).padStart(2, "0");
  const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const parseDay = (s) => { const [y, m, d] = s.slice(0, 10).split("-").map(Number); return new Date(y, m - 1, d); };
  function startOfDay(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
  function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
  // Weeks start on Sunday, as the calendar panel's do.
  function startOfWeek(d) { return addDays(startOfDay(d), -startOfDay(d).getDay()); }
  const daysBetween = (a, b) => Math.round((parseDay(b) - parseDay(a)) / DAY_MS);
  // Moving a date keeps its time, if it has one.
  const shiftValue = (s, n) => ymd(addDays(parseDay(s), n)) + s.slice(10);
  const clock = (hm) => { const [h, m] = hm.split(":").map(Number); return new Date(2000, 0, 1, h, m).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }); };

  /** "Today", "Tomorrow", a weekday within the week, else "Oct 27". */
  function shortDate(s) {
    if (!s || !/^\d{4}-\d\d-\d\d/.test(s)) return s || "";
    const d = parseDay(s), today = startOfDay(new Date());
    const diff = Math.round((d - today) / DAY_MS);
    let out;
    if (diff === 0) out = "Today";
    else if (diff === 1) out = "Tomorrow";
    else if (diff === -1) out = "Yesterday";
    else if (diff > 1 && diff < 7) out = d.toLocaleDateString("en-US", { weekday: "short" });
    else out = d.toLocaleDateString("en-US", { month: "short", day: "numeric", ...(d.getFullYear() !== today.getFullYear() ? { year: "numeric" } : {}) });
    return s.length > 10 ? `${out} ${clock(s.slice(11, 16))}` : out;
  }

  // ---------------------------------------------------------------- the task type, read

  const human = (key) => { const t = String(key).replace(/[_-]+/g, " ").trim(); return t.charAt(0).toUpperCase() + t.slice(1); };

  function shapeOf(ctx) {
    const type = ctx.taskType || { fields: [], profiles: {} };
    const fields = type.fields || [];
    const p = (type.profiles && type.profiles.task) || {};
    const fieldOf = (k) => fields.find((f) => f.key === k);
    const half = (x) => (x && typeof x === "object" ? x.field : typeof x === "string" ? x : null);
    const spanKey = half(p.due) || half(p.start) || (fields.find((f) => f.kind === "datespan") || {}).key || null;
    const statusKey = typeof p.status === "string" ? p.status : null;
    const statusField = statusKey ? fieldOf(statusKey) : null;
    const options = (statusField && statusField.options) || [];
    return {
      fields, fieldOf, spanKey, statusKey, options,
      titleKey: typeof p.title === "string" ? p.title : "title",
      complete: Array.isArray(p.completeValues) ? p.completeValues : [],
      defaultStatus: type["talaris:defaultStatus"] || options[0] || "",
    };
  }
  const labelOf = (f) => (f && (f.label || f.name)) || (f ? human(f.key) : "");

  // A table column is a key: a field's, a datespan's half ("schedule.end"), or "tags".
  function column(key, sh) {
    if (key === "tags") return { key, kind: "tags", label: "Tags" };
    const [fk, part] = String(key).split(".");
    const f = sh.fieldOf(fk);
    if (!f) return { key, kind: "text", label: human(key), fk, missing: true };
    const base = { key, fk, field: f, label: labelOf(f) };
    if (f.kind === "datespan") {
      const p = part === "start" ? "start" : "end";
      return { ...base, kind: "date", part: p, label: p === "start" ? f.startLabel || "Start" : f.endLabel || "End" };
    }
    if (fk === sh.titleKey) return { ...base, kind: "title" };
    if (fk === sh.statusKey) return { ...base, kind: "status" };
    const kind = { date: "date", datetime: "date", enum: "enum", reference: "ref", boolean: "bool", number: "number", integer: "number" }[f.kind] || "text";
    return { ...base, kind };
  }
  const sortKeyOf = (c) => (c.kind === "tags" || c.missing ? null : c.part ? { field: c.fk, part: c.part } : { field: c.fk });
  const sameKey = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  function defaultColumns(sh) {
    const out = [sh.titleKey];
    if (sh.statusKey) out.push(sh.statusKey);
    if (sh.spanKey) out.push(`${sh.spanKey}.start`, `${sh.spanKey}.end`);
    if (sh.fieldOf("project")) out.push("project");
    out.push("tags");
    return out;
  }

  function regionsOf(list) {
    return ((list.placement && list.placement.regions) || []).map((r) => (typeof r === "string"
      ? { name: r, label: r }
      : { name: r.name, label: r.label || r.name, color: r["talaris:color"], enter: r["talaris:enter"] }));
  }

  // New tasks made in a view belong where they were made: a project's view
  // names the project, a list by hand takes them as members.
  function homeOf(list) {
    const id = String(list.id);
    if (id.startsWith("project:")) return { projects: [id.slice(8)] };
    return list.membership && list.membership.mode === "explicit" ? { list: id } : {};
  }
  // A project's tasks are a list nobody keeps: nothing about it can be saved.
  const kept = (list) => !String(list.id).startsWith("project:");

  // ---------------------------------------------------------------- talking to the core

  function fail(err) {
    console.error(err);
    const t = el("div", { class: "tv-toast" }, (err && err.message) || String(err));
    document.body.append(t);
    setTimeout(() => t.remove(), 4000);
  }
  const act = (p) => Promise.resolve(p).catch(fail);
  const patchList = (ctx, list, body) => act(ctx.api("PATCH", `/lists/${enc(list.id)}`, body).then(() => ctx.refresh()));
  const place = (ctx, list, body) => act(ctx.api("POST", `/lists/${enc(list.id)}/members`, body).then(() => ctx.refresh()));
  const unplace = (ctx, list, id) => act(ctx.api("DELETE", `/lists/${enc(list.id)}/members/${enc(id)}`).then(() => ctx.refresh()));
  const setStatus = (ctx, id, v) => act(Promise.resolve(ctx.setStatus(id, v)).then(() => ctx.refresh()));

  // ---------------------------------------------------------------- one small menu at a time
  //
  // No browser pickers — a <select> or a date field opens a window of the
  // engine's own, which a layer surface cannot hold — so menus and the date
  // picker are drawn in the page, one at a time, and go away on a press
  // elsewhere or Escape.

  let pop = null;
  let closed = { anchor: null, at: 0 };
  function closePop() { if (pop) { pop.remove(); pop = null; } }
  function openPop(at, ...content) {
    if (at instanceof Element && closed.anchor === at && performance.now() - closed.at < 400) return null; // a press on its own button: closed, not reopened
    closePop();
    pop = el("div", { class: "menu tv-pop" }, ...content);
    pop.anchor = at instanceof Element ? at : null;
    document.body.append(pop);
    // Placed in the screen's terms whatever the page's own frame is: at 0,0
    // first, to learn where its containing block puts 0,0.
    pop.style.left = "0px"; pop.style.top = "0px";
    const o = pop.getBoundingClientRect();
    let x, y;
    if (at instanceof Element) {
      const r = at.getBoundingClientRect();
      x = r.left; y = r.bottom + 4;
      if (y + o.height > innerHeight - 4) y = Math.max(4, r.top - o.height - 4);
    } else {
      x = at.x; y = at.y;
      if (y + o.height > innerHeight - 4) y = Math.max(4, innerHeight - o.height - 4);
    }
    x = Math.max(4, Math.min(x, innerWidth - o.width - 4));
    pop.style.left = `${x - o.left}px`; pop.style.top = `${y - o.top}px`;
    return pop;
  }
  document.addEventListener("pointerdown", (e) => {
    if (pop && !pop.contains(e.target)) { closed = { anchor: pop.anchor, at: performance.now() }; closePop(); }
  }, true);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && pop) { e.stopPropagation(); e.preventDefault(); closePop(); }
  }, true);
  window.addEventListener("resize", closePop);

  const hint = (text) => el("div", { class: "hint" }, text);
  const item = (label, onclick, cls = "") => el("button", { class: `menu-item ${cls}`, onclick: (e) => { e.stopPropagation(); closePop(); onclick(); } }, label);
  const dot = (color) => el("span", { class: "tv-dot", style: `--c:${color || "var(--muted)"}` });

  function statusItems(ctx, sh, row) {
    return sh.options.map((v) => {
      const s = ctx.status(v) || {};
      return item([dot(s.color), s.label || v], () => setStatus(ctx, row.id, v), v === row.status ? "on" : "");
    });
  }
  // A task's status, changed in place: a dot in its color that opens the menu.
  function statusDot(ctx, sh, row) {
    if (row.status == null || !sh.options.length) return "";
    const s = ctx.status(row.status) || {};
    const b = el("button", { class: "tv-sdot tv-nodrag", style: `--c:${s.color || "var(--muted)"}`, title: s.label || row.status });
    b.addEventListener("click", (e) => { e.stopPropagation(); openPop(b, ...statusItems(ctx, sh, row)); });
    return b;
  }

  /** A month to pick from, with the quick shifts above it. `pick(null)` clears. */
  function datePicker(value, pick) {
    const today = startOfDay(new Date());
    const chosen = value ? parseDay(value) : null;
    const time = value ? value.slice(10) : "";
    let shown = new Date((chosen || today).getFullYear(), (chosen || today).getMonth(), 1);
    const wrap = el("div", { class: "tv-mini" });
    const choose = (v) => { closePop(); pick(v); };
    const from = value || ymd(today);
    const quick = el("div", { class: "tv-quick" },
      el("button", { class: "t-btn", onclick: () => choose(ymd(today) + time) }, "Today"),
      el("button", { class: "t-btn", onclick: () => choose(shiftValue(from, 1)) }, "+1 day"),
      el("button", { class: "t-btn", onclick: () => choose(shiftValue(from, 7)) }, "+1 week"),
      value ? el("button", { class: "t-btn", onclick: () => choose(null) }, "Clear") : "");
    const drawMini = () => {
      const first = startOfWeek(shown);
      const step = (n) => (e) => { e.stopPropagation(); shown = new Date(shown.getFullYear(), shown.getMonth() + n, 1); drawMini(); };
      wrap.replaceChildren(quick,
        el("div", { class: "tv-mini-head" },
          el("button", { class: "icon-btn", onclick: step(-1) }, ICON.prev()),
          el("span", {}, shown.toLocaleDateString("en-US", { month: "long", year: "numeric" })),
          el("button", { class: "icon-btn", onclick: step(1) }, ICON.next())),
        el("div", { class: "tv-mini-grid" },
          ...["S", "M", "T", "W", "T", "F", "S"].map((d) => el("span", { class: "dow" }, d)),
          ...Array.from({ length: 42 }, (_, i) => {
            const d = addDays(first, i);
            const cls = "day" + (d.getMonth() !== shown.getMonth() ? " other" : "") + (chosen && +d === +chosen ? " on" : "") + (+d === +today ? " today" : "");
            return el("button", { class: cls, onclick: () => choose(ymd(d) + time) }, String(d.getDate()));
          })));
    };
    drawMini();
    return wrap;
  }

  // ---------------------------------------------------------------- dragging
  //
  // By pointer, not the browser's drag and drop: that goes through the
  // compositor's drag protocol, which a layer surface does not take part in.
  // A copy follows the pointer; what is under it says where it lands — any
  // element with a drop handler (`zone`).

  function zone(node, onDrop) { node.dataset.drop = "1"; node.tvDrop = onDrop; return node; }

  function draggable(node, payload) {
    node.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || e.target.closest("button, input, .tv-nodrag")) return;
      const sx = e.clientX, sy = e.clientY;
      let ghost = null, over = null;
      const move = (ev) => {
        if (!ghost) {
          if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 5) return;
          closePop();
          const r = node.getBoundingClientRect();
          ghost = node.cloneNode(true);
          ghost.classList.add("tv-ghost");
          Object.assign(ghost.style, { width: `${r.width}px`, left: "0px", top: "0px" });
          document.body.append(ghost);
          const o = ghost.getBoundingClientRect();
          ghost.style.left = `${r.left - o.left}px`; ghost.style.top = `${r.top - o.top}px`;
          node.classList.add("tv-dragging");
          document.body.classList.add("tv-drag-on");
        }
        ghost.style.transform = `translate(${ev.clientX - sx}px, ${ev.clientY - sy}px)`;
        const hit = document.elementFromPoint(ev.clientX, ev.clientY);
        const z = hit && hit.closest("[data-drop]");
        if (z !== over) { if (over) over.classList.remove("tv-over"); over = z; if (over) over.classList.add("tv-over"); }
        // Near the edge of what scrolls, it scrolls.
        const sc = hit && hit.closest(".tv-scroll");
        if (sc) {
          const b = sc.getBoundingClientRect(), edge = 36;
          if (ev.clientX > b.right - edge) sc.scrollLeft += 14; else if (ev.clientX < b.left + edge) sc.scrollLeft -= 14;
          if (ev.clientY > b.bottom - edge) sc.scrollTop += 14; else if (ev.clientY < b.top + edge) sc.scrollTop -= 14;
        }
      };
      const up = (ev) => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", up);
        if (!ghost) return;
        ghost.remove();
        node.classList.remove("tv-dragging");
        document.body.classList.remove("tv-drag-on");
        if (over) over.classList.remove("tv-over");
        // The click that ends a drag is not a press on what was dragged.
        const swallow = (c) => { c.stopPropagation(); c.preventDefault(); };
        window.addEventListener("click", swallow, true);
        setTimeout(() => window.removeEventListener("click", swallow, true), 0);
        if (ev.type === "pointerup" && over && over.tvDrop) over.tvDrop(payload, ev, node);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      window.addEventListener("pointercancel", up);
    });
    return node;
  }

  /** Between which two cards in `box` the pointer is — the dragged one left out. */
  function neighbors(box, y, id) {
    const cards = [...box.querySelectorAll(":scope > [data-card]")].filter((c) => c.dataset.card !== id);
    let after = null, before = null;
    for (const c of cards) {
      const r = c.getBoundingClientRect();
      if (y < r.top + r.height / 2) { before = c.dataset.card; break; }
      after = c.dataset.card;
    }
    return { after, before };
  }
  // Put the card where it was dropped at once, so it does not jump back while the core answers.
  function landNow(box, node, before) {
    const ref = before ? box.querySelector(`:scope > [data-card="${CSS.escape(before)}"]`) : null;
    if (ref) box.insertBefore(node, ref); else box.append(node);
  }

  // ---------------------------------------------------------------- a card (board and matrix)

  function card(ctx, sh, row, opts = {}) {
    const meta = [];
    if (row.due) meta.push(el("span", { class: "tv-due" + (row.overdue ? " late" : "") }, shortDate(row.due)));
    if (row.projects && row.projects.length) meta.push(el("span", { class: "tv-proj" }, row.projects.map((p) => p.title).join(", ")));
    // In a matrix's region, a card wears a wash of the region's color.
    const node = el("div", { class: "tv-card" + (row.complete ? " done" : "") + (opts.color ? " tinted" : ""), "data-card": row.id,
      ...(opts.color ? { style: `--rc:${opts.color}` } : {}) },
      statusDot(ctx, sh, row),
      el("div", { class: "tv-card-body" },
        el("span", { class: "tv-title" }, row.title || "Untitled"),
        meta.length ? el("div", { class: "tv-meta" }, ...meta) : ""),
      opts.remove ? el("button", { class: "tv-x", title: "To drawer", onclick: (e) => { e.stopPropagation(); opts.remove(); } }, "×") : "");
    if (opts.menu) node.addEventListener("contextmenu", (e) => { e.preventDefault(); openPop({ x: e.clientX, y: e.clientY }, ...opts.menu()); });
    // A press anywhere on the card opens the task — not on its buttons or its status dot, which do their own thing
    // (and the click that ends a drag never arrives: draggable swallows it).
    node.addEventListener("click", (e) => { if (!e.target.closest("button, input, .tv-sdot, .tv-nodrag")) ctx.openTask(row.id); });
    return draggable(node, { id: row.id, row, from: opts.from, region: row.region });
  }

  /** A field that makes a task where it is typed; Enter makes it, Escape or leaving puts it away. */
  function adder(box, make, where = "prepend") {
    if (box.querySelector(":scope > .tv-add")) { box.querySelector(":scope > .tv-add input").focus(); return; }
    const input = el("input", { type: "text", placeholder: "Title", spellcheck: "false" });
    const wrap = el("div", { class: "tv-add" }, input);
    let done = false;
    const finish = (keep) => {
      if (done) return;
      done = true;
      const title = input.value.trim();
      wrap.remove();
      if (keep && title) act(Promise.resolve(make(title)));
    };
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") finish(true);
      if (e.key === "Escape") finish(false);
    });
    input.addEventListener("blur", () => finish(true));
    if (where === "prepend") box.prepend(wrap); else box.append(wrap);
    input.focus();
  }

  // ---------------------------------------------------------------- table

  const folded = new Set();

  function drawTable(root, shown, ctx, sh) {
    const list = shown.list;
    const view = list["talaris:view"] || {};
    const keys = Array.isArray(view.columns) && view.columns.length ? view.columns.slice() : defaultColumns(sh);
    const cols = keys.map((k) => column(k, sh));
    const widths = { ...(view.widths || {}) };
    const widthOf = (c) => widths[c.key] || (c.kind === "title" ? 280 : c.kind === "tags" ? 160 : 124);
    const order = list.order || {};
    const sorts = order.sort || [];
    const canSave = kept(list);
    const numbered = Boolean(view.rowNumbers);
    const byId = new Map(shown.rows.map((r) => [r.id, r]));

    const table = el("table", { class: "tv-table" });
    const colEls = new Map();
    const colgroup = el("colgroup");
    if (numbered) colgroup.append(el("col", { style: "width:40px" }));
    for (const c of cols) { const ce = el("col", { style: `width:${widthOf(c)}px` }); colEls.set(c.key, ce); colgroup.append(ce); }
    colgroup.append(el("col", { style: "width:40px" }));
    const tableWidth = () => cols.reduce((s, c) => s + widthOf(c), 0) + 40 + (numbered ? 40 : 0);
    table.style.width = `${tableWidth()}px`;

    // The header: a menu per column, a grip to widen it, a "+" for another.
    const head = el("tr");
    if (numbered) head.append(el("th", { class: "tv-num" }, "#"));
    for (const c of cols) {
      const by = sortKeyOf(c);
      const level = by ? sorts.findIndex((s) => sameKey(s.by, by)) : -1;
      const mark = level >= 0 ? el("span", { class: "tv-sortmark" }, (sorts[level].direction === "descending" ? "↓" : "↑") + (sorts.length > 1 ? String(level + 1) : "")) : "";
      const btn = el("button", { class: "tv-th" }, el("span", { class: "tv-th-label" }, c.label), mark);
      btn.addEventListener("click", () => {
        if (!canSave) return;
        const sortBy = (direction) => {
          const has = sorts.some((s) => sameKey(s.by, by));
          const sort = has ? sorts.map((s) => (sameKey(s.by, by) ? { by, direction } : s)) : [...sorts, { by, direction }];
          patchList(ctx, list, { order: { ...order, sort } });
        };
        openPop(btn,
          by ? item("Sort ascending", () => sortBy("ascending")) : "",
          by ? item("Sort descending", () => sortBy("descending")) : "",
          // Clearing the sort keeps the grouping: they are separate choices.
          sorts.length ? item("Clear sort", () => patchList(ctx, list, { order: order.groupBy ? { groupBy: order.groupBy } : null })) : "",
          (by || sorts.length) && cols.length > 1 ? el("div", { class: "menu-sep" }) : "",
          cols.length > 1 ? item("Hide column", () => patchList(ctx, list, { view: { columns: keys.filter((k) => k !== c.key) } })) : "");
      });
      const grip = el("span", { class: "tv-grip" });
      grip.addEventListener("pointerdown", (e) => {
        if (!canSave) return;
        e.preventDefault(); e.stopPropagation();
        const sx = e.clientX, w0 = widthOf(c);
        const move = (ev) => {
          widths[c.key] = Math.max(56, Math.round(w0 + ev.clientX - sx));
          colEls.get(c.key).style.width = `${widths[c.key]}px`;
          table.style.width = `${tableWidth()}px`;
        };
        const up = () => {
          window.removeEventListener("pointermove", move);
          window.removeEventListener("pointerup", up);
          if (widths[c.key] === w0) return;
          // Kept on the list as well as sent, so a refresh before the answer draws it this wide.
          list["talaris:view"] = { ...view, widths };
          act(ctx.api("PATCH", `/lists/${enc(list.id)}`, { view: { widths } }));
        };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
      });
      head.append(el("th", {}, btn, grip));
    }
    const plus = el("button", { class: "icon-btn tv-addcol", title: "Add column" }, ICON.plus());
    plus.addEventListener("click", () => {
      const more = [];
      for (const f of sh.fields) {
        if (f.kind === "datespan") more.push(`${f.key}.start`, `${f.key}.end`);
        else more.push(f.key);
      }
      more.push("tags");
      const free = more.filter((k) => !keys.includes(k));
      openPop(plus, ...(free.length
        ? free.map((k) => item(column(k, sh).label, () => patchList(ctx, list, { view: { columns: [...keys, k] } })))
        : [el("div", { class: "hint" }, "All shown")]));
    });
    head.append(el("th", { class: "tv-plus" }, canSave ? plus : ""));
    table.append(colgroup, el("thead", {}, head));

    const body = el("tbody");
    const span = cols.length + 1 + (numbered ? 1 : 0);
    let n = 0;
    const addRow = (row) => {
      n += 1;
      const tr = el("tr", { class: "tv-row" + (row.complete ? " done" : "") });
      if (numbered) tr.append(el("td", { class: "tv-num" }, String(n)));
      for (const c of cols) tr.append(cell(ctx, sh, c, row));
      tr.append(el("td"));
      body.append(tr);
    };
    if (shown.groups && shown.groups.length) {
      for (const g of shown.groups) {
        const fk = `${list.id}\u0000${g.key}`;
        const open = !folded.has(fk);
        const rows = g.rows.map((id) => byId.get(id)).filter(Boolean);
        body.append(el("tr", { class: "tv-group", onclick: () => { if (open) folded.add(fk); else folded.delete(fk); drawAgain(); } },
          el("td", { colspan: span }, ICON.fold(open), el("span", {}, g.label), el("span", { class: "tv-count" }, String(rows.length)))));
        if (open) rows.forEach(addRow);
      }
    } else shown.rows.forEach(addRow);
    table.append(body);

    const wrap = el("div", { class: "tv-scroll tv-table-wrap" }, table);
    if (!shown.rows.length) wrap.append(el("div", { class: "tv-empty" }, "Nothing here"));
    root.replaceChildren(wrap);
    function drawAgain() { const t = wrap.scrollTop, l = wrap.scrollLeft; drawTable(root, shown, ctx, sh); const w = root.querySelector(".tv-scroll"); w.scrollTop = t; w.scrollLeft = l; }
  }

  // A text field in place of the cell's words; Enter or leaving keeps it, Escape does not.
  function editInPlace(td, initial, save) {
    if (td.querySelector(".tv-in")) return; // already being edited: a press in the field lands here too
    const was = [...td.childNodes];
    const input = el("input", { type: "text", class: "tv-in", spellcheck: "false" });
    input.value = initial;
    td.replaceChildren(input);
    input.focus(); input.select();
    let done = false;
    const finish = (keep) => {
      if (done) return;
      done = true;
      if (keep && input.value !== initial) { td.replaceChildren(input.value); save(input.value); }
      else td.replaceChildren(...was);
    };
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") finish(true);
      if (e.key === "Escape") finish(false);
    });
    input.addEventListener("blur", () => finish(true));
  }

  function cell(ctx, sh, c, row) {
    const td = el("td", { class: `tv-c-${c.kind}` });
    const props = (fk, v) => act(ctx.update(row.id, { properties: { [fk]: v } }));
    const raw = c.fk ? (row.fields || {})[c.fk] : undefined;
    // A row that is not a task has no status or schedule to change.
    switch (c.kind) {
      case "title": {
        const pen = el("button", { class: "tv-pen", title: "Rename" }, ICON.pen());
        const edit = () => editInPlace(td, row.title || "", (v) => v.trim() && props(c.fk, v.trim()));
        pen.addEventListener("click", (e) => { e.stopPropagation(); edit(); });
        td.append(el("span", { class: "tv-title", onclick: (e) => { e.stopPropagation(); ctx.openTask(row.id); } }, row.title || "Untitled"), pen);
        td.addEventListener("click", (e) => { if (e.target === td) edit(); });
        break;
      }
      case "status": {
        if (row.status == null) break;
        const s = ctx.status(row.status) || {};
        const chip = el("button", { class: "tv-status", style: `--c:${s.color || "var(--muted)"}` }, dot(s.color), s.label || row.status);
        chip.addEventListener("click", (e) => { e.stopPropagation(); openPop(chip, ...statusItems(ctx, sh, row)); });
        td.append(chip);
        break;
      }
      case "date": {
        const value = c.part ? (raw && typeof raw === "object" ? raw[c.part] : null) : typeof raw === "string" ? raw : null;
        // Overdue is the due date's alone, and only the core says when.
        const late = row.overdue && c.fk === sh.spanKey && c.part === "end";
        const b = el("button", { class: "tv-date" + (late ? " late" : "") }, value ? shortDate(value) : "");
        b.addEventListener("click", (e) => {
          e.stopPropagation();
          openPop(b, datePicker(value, (v) => {
            if (!c.part) return props(c.fk, v);
            const next = { ...(raw && typeof raw === "object" ? raw : {}) };
            if (v) next[c.part] = v; else delete next[c.part];
            return props(c.fk, Object.keys(next).length ? next : null);
          }));
        });
        td.append(b);
        break;
      }
      case "tags": {
        const tags = row.tags || [];
        td.append(...tags.map((t) => el("span", { class: "tv-tag" }, `#${t}`)));
        td.addEventListener("click", () => editInPlace(td, tags.join(", "), (v) => {
          const next = [...new Set(v.split(/[,\s]+/).map((t) => t.replace(/^#/, "").trim()).filter(Boolean))];
          act(ctx.update(row.id, { tags: next }));
        }));
        break;
      }
      case "enum": {
        const f = c.field, labels = f["talaris:labels"] || {}, colors = f["talaris:colors"] || {};
        const b = el("button", { class: "tv-status", style: `--c:${colors[raw] || "var(--muted)"}` }, raw ? [dot(colors[raw]), labels[raw] || raw] : "");
        b.addEventListener("click", (e) => {
          e.stopPropagation();
          openPop(b, ...(f.options || []).map((o) => item([dot(colors[o]), labels[o] || o], () => props(c.fk, o), o === raw ? "on" : "")),
            raw ? el("div", { class: "menu-sep" }) : "", raw ? item("Clear", () => props(c.fk, null)) : "");
        });
        td.append(b);
        break;
      }
      case "bool": {
        const b = el("button", { class: "switch" + (raw ? " on" : "") });
        b.addEventListener("click", (e) => { e.stopPropagation(); props(c.fk, !raw); });
        td.append(b);
        break;
      }
      case "ref": {
        // The panel offers projects to pick from; a reference to anything else shows its titles.
        const ids = Array.isArray(raw) ? raw : raw ? [raw] : [];
        const names = new Map([...(ctx.projects || []).map((p) => [p.id, p.title]), ...(row.projects || []).map((p) => [p.id, p.title])]);
        td.append(ids.map((id) => names.get(id) || id).join(", "));
        td.addEventListener("click", () => {
          const choices = (ctx.projects || []).filter((p) => !p.archived || ids.includes(p.id));
          if (!choices.length) return;
          const toggle = (id) => {
            const next = ids.includes(id) ? ids.filter((x) => x !== id) : c.field.many ? [...ids, id] : [id];
            props(c.fk, c.field.many ? next : next[0] || null);
          };
          openPop(td, el("div", { class: "tv-menu-list" }, ...choices.map((p) => item(p.title, () => toggle(p.id), ids.includes(p.id) ? "on" : ""))));
        });
        break;
      }
      default: {
        const text = raw == null ? "" : typeof raw === "object" ? JSON.stringify(raw) : String(raw);
        td.append(text);
        if (c.missing || (raw != null && typeof raw === "object")) break;
        td.addEventListener("click", () => editInPlace(td, text, (v) => {
          if (c.kind === "number") { const n = v.trim() === "" ? null : Number(v); if (n === null || Number.isFinite(n)) props(c.fk, n); }
          else props(c.fk, v === "" ? null : v);
        }));
      }
    }
    return td;
  }

  // ---------------------------------------------------------------- board

  function drawBoard(root, shown, ctx, sh) {
    const list = shown.list;
    const regions = regionsOf(list);
    const known = new Set(regions.map((r) => r.name));
    // A task whose value is none of the columns' still shows, in a column of its own.
    const loose = shown.rows.filter((r) => !known.has(r.region || ""));
    const columns = loose.length ? [...regions, { name: "", label: "None", loose: true }] : regions;
    const board = el("div", { class: "tv-scroll tv-board" });
    for (const col of columns) {
      const rows = col.loose ? loose : shown.rows.filter((r) => r.region === col.name);
      const box = el("div", { class: "tv-col-list" });
      const menu = (row) => () => [hint("Move to"), ...regions.map((r) => item([dot(r.color), r.label],
        () => place(ctx, list, { object: row.id, region: r.name }), r.name === row.region ? "on" : ""))];
      for (const row of rows) box.append(card(ctx, sh, row, { from: "board", menu: menu(row) }));
      const plus = col.loose ? "" : el("button", { class: "icon-btn tv-small", title: "New task" }, ICON.plus());
      if (plus) plus.addEventListener("click", () => adder(box, (title) =>
        Promise.resolve(ctx.newTask({ title, ...homeOf(list), list: list.id, region: col.name })).then(() => ctx.refresh())));
      const node = el("section", { class: "tv-col", style: `--c:${col.color || "var(--line)"}` },
        el("header", {}, dot(col.color), el("span", { class: "tv-col-label" }, col.label), el("span", { class: "tv-count" }, String(rows.length)), el("span", { class: "tv-spacer" }), plus),
        box);
      if (!col.loose) {
        zone(node, (p, ev, dragged) => {
          const same = p.region === col.name;
          if (same && !shown.manual) return;
          const body = { object: p.id, region: col.name };
          // Order within a column is the user's only when the list's order is.
          if (shown.manual) {
            const { after, before } = neighbors(box, ev.clientY, p.id);
            if (after || before) Object.assign(body, { after, before });
            landNow(box, dragged, before);
          } else box.append(dragged);
          place(ctx, list, body);
        });
      }
      board.append(node);
    }
    if (!columns.length) board.append(el("div", { class: "tv-empty" }, "No columns"));
    root.replaceChildren(board);
  }

  // ---------------------------------------------------------------- matrix

  const searches = new Map(); // a list by hand: the drawer's search, kept across refreshes

  function enterWords(ctx, enter) {
    if (!enter) return "";
    const said = [];
    if (enter.tag) said.push(`Adds #${enter.tag}`);
    if (enter.status) said.push(`Sets ${(ctx.status(enter.status) || {}).label || enter.status}`);
    return said.join(" · ");
  }

  function drawMatrix(root, shown, ctx, sh) {
    const list = shown.list;
    const regions = regionsOf(list);
    const known = new Set(regions.map((r) => r.name));
    const n = Math.max(1, Math.min(6, Number((list.placement || {})["talaris:columns"]) || 2));
    // Placed by hand, always — unless a sort says otherwise.
    const ordered = !(list.order && list.order.sort && list.order.sort.length);
    const byHand = !list.membership || list.membership.mode === "explicit";
    const placedIds = new Set(shown.rows.map((r) => r.id));

    const toDrawer = (id) => unplace(ctx, list, id);
    const menu = (row) => () => [
      hint("Move to"),
      ...regions.map((r) => item([dot(r.color), r.label], () => place(ctx, list, { object: row.id, region: r.name }), r.name === row.region ? "on" : "")),
      placedIds.has(row.id) ? item("Drawer", () => toDrawer(row.id)) : "",
      ...(row.status != null && sh.options.length ? [el("div", { class: "menu-sep" }), hint("Status"), ...statusItems(ctx, sh, row)] : []),
    ];

    const grid = el("div", { class: "tv-scroll tv-matrix-grid", style: `grid-template-columns:repeat(${n}, minmax(0, 1fr))` });
    for (const r of regions) {
      const rows = shown.rows.filter((x) => x.region === r.name);
      const box = el("div", { class: "tv-region-list" });
      for (const row of rows) box.append(card(ctx, sh, row, { from: "region", menu: menu(row), remove: () => toDrawer(row.id), color: r.color }));
      const words = enterWords(ctx, r.enter);
      const node = el("section", { class: "tv-region", style: `--c:${r.color || "var(--line)"}` },
        el("header", {}, el("span", { class: "tv-col-label" }, r.label),
          words ? el("span", { class: "tv-enter", title: words }, ICON.enter()) : "",
          el("span", { class: "tv-count" }, String(rows.length))),
        box);
      zone(node, (p, ev, dragged) => {
        if (p.from === "region" && p.region === r.name && !ordered) return;
        const body = { object: p.id, region: r.name };
        if (ordered) {
          const { after, before } = neighbors(box, ev.clientY, p.id);
          if (after || before) Object.assign(body, { after, before });
          landNow(box, dragged, before);
        }
        place(ctx, list, body);
      });
      grid.append(node);
    }

    // The drawer: what the query matches and is not placed, and anything
    // placed in a region the matrix no longer has; for a list by hand, a search.
    const strays = shown.rows.filter((r) => !known.has(r.region || ""));
    const waiting = [...strays, ...(shown.drawer || [])];
    const dbox = el("div", { class: "tv-drawer-list" });
    const fill = (rows) => dbox.replaceChildren(...(rows.length
      ? rows.map((row) => card(ctx, sh, row, { from: "drawer", menu: menu(row) }))
      : [el("div", { class: "tv-empty" }, "Empty")]));
    const count = el("span", { class: "tv-count" }, String(waiting.length));
    const drawer = el("aside", { class: "tv-drawer" }, el("header", {}, el("span", { class: "tv-col-label" }, "Drawer"), count));
    if (byHand) {
      const q = el("input", { type: "search", placeholder: "Find tasks", spellcheck: "false" });
      q.value = searches.get(list.id) || "";
      let timer = 0, asked = 0;
      const run = () => {
        const text = q.value.trim();
        searches.set(list.id, q.value);
        const mine = ++asked;
        ctx.api("GET", `/entities?q=${enc(text)}&kind=task`).then((found) => {
          if (mine !== asked) return;
          const rows = [...strays, ...(found || []).filter((f) => !placedIds.has(f.id)).map((f) => ({ ...f, fields: {} }))];
          count.textContent = String(rows.length);
          fill(rows);
        }).catch(fail);
      };
      q.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(run, 200); });
      q.addEventListener("keydown", (e) => { if (e.key === "Escape" && q.value) { e.stopPropagation(); q.value = ""; run(); } });
      drawer.append(el("div", { class: "tv-drawer-search" }, q));
      fill(strays);
      run();
    } else fill(waiting);
    drawer.append(dbox);
    zone(drawer, (p) => { if (p.from === "region") toDrawer(p.id); });

    root.replaceChildren(el("div", { class: "tv-matrix" }, grid, drawer));
  }

  // ---------------------------------------------------------------- calendar

  const KEEP = "talaris.tasks.calendar";
  let calMode = "month";
  try { calMode = localStorage.getItem(KEEP) === "week" ? "week" : "month"; } catch { /* fine */ }
  let calFocus = startOfDay(new Date());

  function drawCalendar(root, shown, ctx, sh) {
    const list = shown.list;
    const today = startOfDay(new Date());
    // A task sits on its due date, or on its available date if it has no due.
    const dayOf = (r) => (r.due || r.start || "").slice(0, 10);
    const byDay = new Map();
    let undated = 0;
    for (const r of shown.rows) {
      const d = dayOf(r);
      if (!/^\d{4}-\d\d-\d\d$/.test(d)) { undated += 1; continue; }
      if (!byDay.has(d)) byDay.set(d, []);
      byDay.get(d).push(r);
    }
    const redraw = () => drawCalendar(root, shown, ctx, sh);
    const go = (f) => { calFocus = f; redraw(); };
    const step = (n) => go(calMode === "week" ? addDays(calFocus, 7 * n) : new Date(calFocus.getFullYear(), calFocus.getMonth() + n, 1));
    const setMode = (m) => { calMode = m; try { localStorage.setItem(KEEP, m); } catch { /* fine */ } redraw(); };

    let title;
    if (calMode === "week") {
      const s = startOfWeek(calFocus), e = addDays(s, 6);
      title = `${s.toLocaleDateString("en-US", { month: "short", day: "numeric" })} – ${e.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`;
    } else title = calFocus.toLocaleDateString("en-US", { month: "long", year: "numeric" });
    const modes = el("span", { class: "seg" }, ...[["month", "Month"], ["week", "Week"]].map(([m, label]) =>
      el("button", { class: m === calMode ? "on" : "", onclick: () => setMode(m) }, label)));
    const bar = el("div", { class: "tv-calbar" },
      el("button", { class: "t-btn", onclick: () => go(today) }, "Today"),
      el("button", { class: "icon-btn", title: "Before", onclick: () => step(-1) }, ICON.prev()),
      el("button", { class: "icon-btn", title: "After", onclick: () => step(1) }, ICON.next()),
      el("span", { class: "tv-caltitle" }, title),
      el("span", { class: "tv-spacer" }),
      undated ? el("span", { class: "tv-undated" }, `${undated} undated`) : "",
      modes);

    const week = calMode === "week";
    const start = week ? startOfWeek(calFocus) : startOfWeek(new Date(calFocus.getFullYear(), calFocus.getMonth(), 1));
    const count = week ? 7 : 42;
    const grid = el("div", { class: "tv-calgrid" + (week ? " week" : "") });
    for (let i = 0; i < 7; i++) {
      const d = addDays(start, i);
      grid.append(el("div", { class: "dow" + (week && +d === +today ? " today" : "") },
        week ? d.toLocaleDateString("en-US", { weekday: "short", day: "numeric" }) : d.toLocaleDateString("en-US", { weekday: "short" })));
    }
    const room = 4;
    for (let i = 0; i < count; i++) {
      const d = addDays(start, i);
      const key = ymd(d);
      const rows = byDay.get(key) || [];
      const box = el("div", { class: "tv-daylist" });
      const shownRows = week ? rows : rows.slice(0, room);
      for (const r of shownRows) box.append(chip(ctx, sh, r, key));
      if (rows.length > shownRows.length) {
        box.append(el("span", { class: "tv-more", onclick: () => { calFocus = d; setMode("week"); } }, `${rows.length - shownRows.length} more`));
      }
      const plus = el("button", { class: "tv-dayplus", title: "New task" }, ICON.plus());
      plus.addEventListener("click", (e) => {
        e.stopPropagation();
        adder(box, (title) => Promise.resolve(ctx.newTask({ title, due: key, ...homeOf(list) })).then(() => ctx.refresh()), "append");
      });
      const cell = el("div", { class: "tv-day" + (!week && d.getMonth() !== calFocus.getMonth() ? " other" : "") + (+d === +today ? " today" : "") },
        el("div", { class: "tv-dayhead" }, week ? "" : el("span", { class: "n" }, String(d.getDate())), el("span", { class: "tv-spacer" }), plus),
        box);
      zone(cell, (p, ev, dragged) => {
        const from = p.day;
        if (!from || from === key || !sh.spanKey) return;
        const delta = daysBetween(from, key);
        // The whole span moves: available and due by the same number of days.
        const was = (p.row.fields || {})[sh.spanKey];
        const next = { ...(was && typeof was === "object" ? was : {}) };
        if (next.end) next.end = shiftValue(next.end, delta);
        if (next.start) next.start = shiftValue(next.start, delta);
        if (!next.end && !next.start) next.end = key;
        box.append(dragged);
        act(ctx.update(p.row.id, { properties: { [sh.spanKey]: next } }));
      });
      grid.append(cell);
    }
    root.replaceChildren(el("div", { class: "tv-cal" }, bar, el("div", { class: "tv-scroll tv-calwrap" }, grid)));
  }

  function chip(ctx, sh, row, day) {
    const s = row.status != null ? ctx.status(row.status) || {} : null;
    const node = el("div", { class: "tv-chip" + (row.overdue ? " late" : "") + (row.complete ? " done" : ""), "data-card": row.id, title: row.title || "" },
      statusDot(ctx, sh, row),
      el("span", { class: "tv-title", onclick: () => ctx.openTask(row.id) }, row.title || "Untitled"));
    if (s && sh.options.length) node.addEventListener("contextmenu", (e) => { e.preventDefault(); openPop({ x: e.clientX, y: e.clientY }, hint("Status"), ...statusItems(ctx, sh, row)); });
    return draggable(node, { id: row.id, row, day, from: "calendar" });
  }

  // ---------------------------------------------------------------- the one entry

  const DRAW = { table: drawTable, board: drawBoard, matrix: drawMatrix, calendar: drawCalendar };
  // Where the view was scrolled, kept across a refresh of the same list and view.
  let scrolled = null;

  /** Replaces `host`'s contents with the list drawn as `kind`. */
  function render(kind, host, shown, ctx) {
    closePop();
    const draw = DRAW[kind] || drawTable;
    const key = `${kind}\u0000${shown.list.id}`;
    const old = host.querySelector(":scope > .tv-root");
    if (old && old.dataset.key === key) {
      scrolled = [...old.querySelectorAll(".tv-scroll, .tv-col-list, .tv-region-list, .tv-drawer-list")].map((n) => [n.scrollTop, n.scrollLeft]);
    } else scrolled = null;
    const root = el("div", { class: `tv-root tv-${kind}`, "data-key": key });
    host.replaceChildren(root);
    try { draw(root, shown, ctx, shapeOf(ctx)); } catch (err) { fail(err); }
    if (scrolled) {
      const now = [...root.querySelectorAll(".tv-scroll, .tv-col-list, .tv-region-list, .tv-drawer-list")];
      now.forEach((n, i) => { if (scrolled[i]) { n.scrollTop = scrolled[i][0]; n.scrollLeft = scrolled[i][1]; } });
    }
  }

  return { render };
})();

// On window, as the panel looks for it there (a top-level const is not).
window.TaskViews = TaskViews;
