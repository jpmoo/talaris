// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore
//
// The Tasks panel's list editor and query builder (TASKS-CONTRACT.md). Two
// globals and nothing else: QueryBuilder, an editable all/any group that counts
// its matches as it is built, and ListEditor, the sheet that makes or changes
// a list. Hermes' QueryBuilder, feature for feature, drawn without a framework.
//
// No browser pickers here — a <select>, a date or a color field opens a window
// of the engine's own, which a layer surface cannot hold — so every choice is a
// small list drawn in the page, one at a time, under what opened it.

"use strict";

(() => {
  function el(tag, attrs = {}, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
      else if (k === "class") e.className = v;
      else if (k === "style") e.setAttribute("style", v);
      else if (k === "value") e.value = v;
      else e.setAttribute(k, v === true ? "" : v);
    }
    for (const k of kids.flat()) if (k != null && k !== "") e.append(k);
    return e;
  }
  const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));
  const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  const pretty = (k) => { const s = String(k).replace(/[_-]+/g, " ").trim(); return s.charAt(0).toUpperCase() + s.slice(1); };

  // One segmented choice: [value, label] pairs, the current one lit.
  function seg(choices, current, pick) {
    return el("span", { class: "seg" }, choices.map(([value, label]) =>
      el("button", { type: "button", class: value === current ? "on" : "", onclick: () => pick(value) }, label)));
  }
  function xBtn(title, onclick) {
    return el("button", { type: "button", class: "icon-btn le-x", title, onclick }, "×");
  }

  // ---------------------------------------------------------------- the one popup
  //
  // Fixed to the window rather than inside the sheet, so a sheet that scrolls
  // cannot clip it; it goes away on a press elsewhere, a scroll, or Escape.

  const pop = el("div", { class: "menu le-pop", hidden: true });
  let popAnchor = null;
  function popUnder(anchor, content) {
    if (!pop.isConnected) document.body.append(pop);
    pop.replaceChildren(content);
    pop.hidden = false;
    popAnchor = anchor;
    const r = anchor.getBoundingClientRect(), p = pop.getBoundingClientRect();
    const below = innerHeight - r.bottom - 8;
    const top = below >= p.height || r.top < p.height + 8 ? r.bottom + 4 : r.top - p.height - 4;
    pop.style.top = `${Math.max(4, Math.min(top, innerHeight - p.height - 4))}px`;
    pop.style.left = `${Math.max(4, Math.min(r.left, innerWidth - p.width - 4))}px`;
    const first = pop.querySelector("input");
    if (first) first.focus();
  }
  function popAway() { pop.hidden = true; popAnchor = null; }
  const popOpen = () => !pop.hidden;
  document.addEventListener("mousedown", (e) => {
    if (popOpen() && !pop.contains(e.target) && !(popAnchor && popAnchor.contains(e.target))) popAway();
  }, true);
  document.addEventListener("scroll", (e) => { if (popOpen() && !pop.contains(e.target)) popAway(); }, true);
  // Registered first, so a list that is out goes before the sheet under it does.
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && popOpen()) { popAway(); e.preventDefault(); e.stopImmediatePropagation(); }
  }, true);

  // A list of choices, each {value, label, color?}; a filter on top once it is long.
  function menu(choices, current, pick) {
    const list = el("div", { class: "le-menu-list" });
    const draw = (q) => {
      const t = q.trim().toLowerCase();
      const shown = choices.filter((c) => !t || String(c.label).toLowerCase().includes(t));
      list.replaceChildren(...shown.map((c) => c.sep ? el("div", { class: "menu-sep" }) :
        el("button", { type: "button", class: "menu-item" + (same(c.value, current) ? " on" : ""),
          onclick: () => { popAway(); pick(c.value); } },
          c.color ? el("span", { class: "le-sw", style: `background:${c.color}` }) : null, c.label)));
      if (!shown.length) list.append(el("div", { class: "hint" }, "None"));
    };
    draw("");
    if (choices.length <= 8) return list;
    const q = el("input", { type: "text", class: "le-filter", spellcheck: "false", oninput: () => draw(q.value) });
    return el("div", {}, q, list);
  }
  // A button that reads like a field and opens its menu.
  function picker(choices, current, pick, empty = "—") {
    const now = choices.find((c) => same(c.value, current));
    const b = el("button", { type: "button", class: "le-pick" },
      now?.color ? el("span", { class: "le-sw", style: `background:${now.color}` }) : null,
      now ? now.label : current != null && current !== "" ? String(current) : empty);
    b.addEventListener("click", () => (popAnchor === b ? popAway() : popUnder(b, menu(choices, current, pick))));
    return b;
  }

  // ---------------------------------------------------------------- dates
  //
  // A date is typed as the core reads it — YYYY-MM-DD, today, today±N, now —
  // or chosen from the few chips and a month drawn under the field.

  const CHIPS = [["today", "Today"], ["today+1", "+1 day"], ["today+7", "+1 week"], ["today-1", "−1 day"], ["today-7", "−1 week"], ["now", "Now"]];
  const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  function parseDay(v) {
    const m = String(v || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
    return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
  }
  function monthPicker(value, pick) {
    const chosen = parseDay(value);
    let shown = chosen ? new Date(chosen.getFullYear(), chosen.getMonth(), 1) : new Date(new Date().getFullYear(), new Date().getMonth(), 1);
    const wrap = el("div", { class: "le-mini" });
    const today = ymd(new Date());
    const draw = () => {
      const first = new Date(shown); first.setDate(1 - shown.getDay());
      const move = (n) => () => { shown = new Date(shown.getFullYear(), shown.getMonth() + n, 1); draw(); };
      wrap.replaceChildren(
        el("div", { class: "le-chips" }, CHIPS.map(([v, label]) =>
          el("button", { type: "button", class: "le-chip" + (v === value ? " on" : ""), onclick: () => { popAway(); pick(v); } }, label))),
        el("div", { class: "le-mini-head" },
          el("button", { type: "button", class: "icon-btn", onclick: move(-1) }, "‹"),
          el("span", {}, shown.toLocaleDateString("en-US", { month: "long", year: "numeric" })),
          el("button", { type: "button", class: "icon-btn", onclick: move(1) }, "›")),
        el("div", { class: "le-mini-grid" },
          ["S", "M", "T", "W", "T", "F", "S"].map((d) => el("span", { class: "dow" }, d)),
          Array.from({ length: 42 }, (_, i) => {
            const d = new Date(first); d.setDate(first.getDate() + i);
            const k = ymd(d);
            return el("button", { type: "button", class: "day" + (d.getMonth() !== shown.getMonth() ? " other" : "") + (chosen && k === ymd(chosen) ? " on" : "") + (k === today ? " today" : ""),
              onclick: () => { popAway(); pick(k); } }, String(d.getDate()));
          })));
    };
    draw();
    return wrap;
  }
  // The typed field, with the chips and month opening under it on focus.
  function dateInput(value, set, redraw) {
    const input = el("input", { type: "text", class: "le-date", spellcheck: "false", placeholder: "today+7", value: value || "" });
    input.addEventListener("input", () => set(input.value.trim()));
    input.addEventListener("focus", () => { if (popAnchor !== input) popUnder(input, monthPicker(input.value.trim(), (v) => { set(v); redraw(); })); });
    // The month must not take the focus from the field it serves.
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") popAway(); });
    return input;
  }

  // ---------------------------------------------------------------- fields
  //
  // What the type says it has, read from the fields' kinds — never their
  // names. A datespan is two dates, its halves under the labels it gives them.

  const PROFILES = [["task", "Task"], ["note", "Note"], ["contact", "Person"], ["event", "Event"], ["project", "Project"]];
  const fieldLabel = (f) => (f.label && String(f.label).trim()) || pretty(f.key);
  function kindOf(f) {
    if (["date", "datetime"].includes(f.kind)) return "date";
    if (["enum", "status", "select"].includes(f.kind)) return "enum";
    if (f.kind === "reference") return "ref";
    if (f.kind === "boolean") return "bool";
    if (f.kind === "number") return "number";
    return "text";
  }
  function fieldChoices(taskType) {
    const out = [{ key: "title", label: "Title", kind: "text" }];
    for (const f of taskType?.fields ?? []) {
      if (f.key === "title") continue;
      if (f.kind === "datespan") {
        out.push({ key: `${f.key}.start`, label: f.startLabel || `${fieldLabel(f)} start`, kind: "date", field: f });
        out.push({ key: `${f.key}.end`, label: f.endLabel || `${fieldLabel(f)} end`, kind: "date", field: f });
      } else out.push({ key: f.key, label: fieldLabel(f), kind: kindOf(f), field: f });
    }
    return out;
  }
  function optionChoices(f) {
    const labels = f?.["talaris:labels"] ?? {}, colors = f?.["talaris:colors"] ?? {};
    return (f?.options ?? []).map((o) => ({ value: o, label: labels[o] ?? pretty(o), color: colors[o] }));
  }
  // The task profile's status field: what a status means, by declaration.
  function statusField(taskType) {
    const key = taskType?.profiles?.task?.status ?? "status";
    return (taskType?.fields ?? []).find((f) => f.key === key) ?? null;
  }

  const OPS = {
    date: [["lt", "before"], ["gt", "after"], ["eq", "is"], ["neq", "is not"], ["empty", "empty"], ["notEmpty", "not empty"]],
    enum: [["eq", "is"], ["neq", "is not"], ["empty", "empty"], ["notEmpty", "not empty"]],
    text: [["contains", "contains"], ["eq", "is"], ["neq", "is not"], ["empty", "empty"], ["notEmpty", "not empty"]],
    ref: [["contains", "includes"], ["empty", "empty"], ["notEmpty", "not empty"]],
    bool: [["eq", "is"], ["empty", "empty"], ["notEmpty", "not empty"]],
    number: [["eq", "is"], ["neq", "is not"], ["lt", "<"], ["gt", ">"], ["empty", "empty"], ["notEmpty", "not empty"]],
  };
  const KINDS = [["profile", "Kind"], ["state", "State"], ["property", "Field"], ["tag", "Tag"], ["text", "Text"],
    ["created", "Created"], ["edited", "Edited"], ["hasAttachment", "Attachment"]];
  const KIND_LABEL = Object.fromEntries([...KINDS, ["type", "Type"], ["group", "Group"]]);

  function fresh(kind) {
    switch (kind) {
      case "profile": return { kind, profile: "task", op: "is" };
      case "state": return { kind, value: "open" };
      case "property": return { kind, key: "title", op: "contains", value: "" };
      case "tag": return { kind, tag: "", op: "include" };
      case "text": return { kind, value: "" };
      case "created": case "edited": return { kind, op: "after", date: "today-7" };
      case "hasAttachment": return { kind, has: true };
      default: return { kind: "group", match: "all", items: [] };
    }
  }
  const asGroup = (q) => (q && q.kind === "group" ? clone(q) : { kind: "group", match: "all", items: q ? [clone(q)] : [] });

  // ---------------------------------------------------------------- QueryBuilder

  function mountQuery(host, query, opts = {}) {
    let root = asGroup(query);
    const tree = el("div", { class: "qb" });
    const count = el("div", { class: "qb-count" });
    host.replaceChildren(tree, count);
    const fields = () => fieldChoices(opts.taskType);
    const projects = () => (opts.projects ?? []).filter((p) => !p.archived);
    const projectTitle = (id) => (opts.projects ?? []).find((p) => p.id === id)?.title;

    // The count, asked of the core a moment after the last change; an answer
    // to an older question is dropped when it arrives late.
    let timer = 0, asked = 0;
    function preview() {
      clearTimeout(timer);
      if (!opts.api) return;
      timer = setTimeout(() => {
        const n = ++asked;
        opts.api("POST", "/lists/preview", { query: root }).then((r) => {
          if (n !== asked) return;
          const titles = (r.rows ?? []).slice(0, 4).map((x) => x.title || "Untitled");
          count.replaceChildren(el("span", { class: "qb-n" }, `${r.count} match`),
            titles.length ? el("span", { class: "qb-some" }, titles.join(" · ") + (r.count > titles.length ? " …" : "")) : null);
        }).catch(() => { if (n === asked) count.replaceChildren(); });
      }, 400);
    }
    // Typing changes the query without drawing it again, so the caret stays.
    function changed() { preview(); if (opts.onChange) opts.onChange(clone(root)); }
    function redraw() { tree.replaceChildren(groupView(root, null)); changed(); }

    function groupView(g, remove) {
      const items = el("div", { class: "qb-items" });
      g.items.forEach((it, i) => {
        const drop = () => { g.items.splice(i, 1); redraw(); };
        items.append(it.kind === "group" ? groupView(it, drop) : conditionView(it, drop));
      });
      const add = el("button", { type: "button", class: "t-btn qb-add" }, "+ Condition");
      add.addEventListener("click", () => (popAnchor === add ? popAway() : popUnder(add, menu(
        [...KINDS.map(([v, label]) => ({ value: v, label })), { sep: true, value: "-", label: "" }, { value: "group", label: "Group" }],
        null, (k) => { g.items.push(fresh(k)); redraw(); }))));
      return el("div", { class: "qb-group" + (remove ? " nested" : "") },
        el("div", { class: "qb-head" },
          seg([["all", "All"], ["any", "Any"]], g.match === "any" ? "any" : "all", (m) => { g.match = m; redraw(); }),
          el("span", { class: "spacer" }),
          remove ? xBtn("Remove", remove) : null),
        items, add);
    }

    function textIn(value, set, placeholder = "") {
      const i = el("input", { type: "text", spellcheck: "false", placeholder, value: value ?? "" });
      i.addEventListener("input", () => { set(i.value); changed(); });
      return i;
    }

    function conditionView(c, remove) {
      const parts = [];
      const ch = (fn) => (v) => { fn(v); redraw(); };
      switch (c.kind) {
        case "profile":
          parts.push(seg([["is", "is"], ["isNot", "is not"]], c.op === "isNot" ? "isNot" : "is", ch((v) => { c.op = v; })),
            picker(PROFILES.map(([value, label]) => ({ value, label })), c.profile, ch((v) => { c.profile = v; })));
          break;
        case "type":
          // Not offered, but a query written elsewhere may hold one; it stays as it is.
          parts.push(seg([["is", "is"], ["isNot", "is not"]], c.op === "isNot" ? "isNot" : "is", ch((v) => { c.op = v; })),
            el("span", { class: "qb-raw" }, String(c.typeId)));
          break;
        case "state":
          parts.push(seg([["open", "Open"], ["complete", "Done"]], c.value === "complete" ? "complete" : "open", ch((v) => { c.value = v; })));
          break;
        case "tag":
          parts.push(seg([["include", "has"], ["exclude", "lacks"]], c.op === "exclude" ? "exclude" : "include", ch((v) => { c.op = v; })),
            textIn(c.tag, (v) => { c.tag = v.replace(/^#/, "").trim(); }, "tag"));
          break;
        case "text":
          parts.push(textIn(c.value, (v) => { c.value = v; }, "words"));
          break;
        case "created": case "edited":
          parts.push(seg([["before", "before"], ["after", "after"]], c.op === "before" ? "before" : "after", ch((v) => { c.op = v; })),
            dateInput(c.date, (v) => { c.date = v; changed(); }, redraw));
          break;
        case "hasAttachment":
          parts.push(seg([[true, "has"], [false, "has none"]], c.has !== false, ch((v) => { c.has = v; })));
          break;
        case "property":
          parts.push(...propertyParts(c, ch));
          break;
        default:
          parts.push(el("span", { class: "qb-raw" }, JSON.stringify(c)));
      }
      return el("div", { class: "qb-cond" }, el("span", { class: "qb-kind" }, KIND_LABEL[c.kind] ?? c.kind), ...parts, el("span", { class: "spacer" }), xBtn("Remove", remove));
    }

    function propertyParts(c, ch) {
      const all = fields();
      // A key the type no longer has stays listed under its own name, so
      // opening a list cannot quietly rewrite its query.
      const choices = all.map((f) => ({ value: f.key, label: f.label }));
      if (!all.some((f) => f.key === c.key)) choices.push({ value: c.key, label: c.key });
      const f = all.find((x) => x.key === c.key) ?? { key: c.key, kind: "text" };
      const ops = OPS[f.kind];
      const parts = [
        picker(choices, c.key, ch((k) => {
          const nf = all.find((x) => x.key === k) ?? { kind: "text" };
          c.key = k; c.op = OPS[nf.kind][0][0];
          c.value = nf.kind === "enum" ? optionChoices(nf.field)[0]?.value ?? "" : nf.kind === "bool" ? "true" : "";
        })),
        picker(ops.map(([value, label]) => ({ value, label })), c.op, ch((op) => {
          c.op = op;
          if (op === "empty" || op === "notEmpty") delete c.value;
          else if (c.value === undefined) c.value = f.kind === "enum" ? optionChoices(f.field)[0]?.value ?? "" : "";
        })),
      ];
      if (c.op === "empty" || c.op === "notEmpty") return parts;
      if (f.kind === "date") parts.push(dateInput(c.value, (v) => { c.value = v; changed(); }, redraw));
      else if (f.kind === "enum") parts.push(picker(optionChoices(f.field), c.value, ch((v) => { c.value = v; })));
      else if (f.kind === "bool") parts.push(seg([["true", "yes"], ["false", "no"]], c.value === "false" ? "false" : "true", ch((v) => { c.value = v; })));
      else if (f.kind === "ref") parts.push(picker(projects().map((p) => ({ value: p.id, label: p.title || "Untitled" })),
        c.value, ch((v) => { c.value = v; }), c.value ? projectTitle(c.value) ?? "Unknown" : "Project"));
      else parts.push(textIn(c.value, (v) => { c.value = v; }, f.kind === "number" ? "0" : "value"));
      return parts;
    }

    tree.replaceChildren(groupView(root, null));
    preview();
    return {
      get: () => clone(root),
      set(q) { root = asGroup(q); tree.replaceChildren(groupView(root, null)); preview(); },
    };
  }

  // ---------------------------------------------------------------- order keys
  //
  // The format's sort keys, {field, part} or {meta}: title, created, edited,
  // kind, and every field the type has (a datespan's two halves apart).

  const keyId = (by) => (!by ? "" : "meta" in by ? `meta:${by.meta}` : `field:${by.field}${by.part ? "." + by.part : ""}`);
  function orderChoices(taskType) {
    const out = [
      { value: "field:title", label: "Title", by: { field: "title" } },
      { value: "meta:created", label: "Created", by: { meta: "created" } },
      { value: "meta:updated", label: "Edited", by: { meta: "updated" } },
      { value: "meta:type", label: "Kind", by: { meta: "type" } },
    ];
    for (const f of taskType?.fields ?? []) {
      if (f.key === "title" || f.kind === "richtext") continue;
      if (f.kind === "datespan") {
        out.push({ value: `field:${f.key}.start`, label: f.startLabel || `${fieldLabel(f)} start`, by: { field: f.key, part: "start" } });
        out.push({ value: `field:${f.key}.end`, label: f.endLabel || `${fieldLabel(f)} end`, by: { field: f.key, part: "end" } });
      } else out.push({ value: `field:${f.key}`, label: fieldLabel(f), by: { field: f.key } });
    }
    return out;
  }
  function keyChoices(choices, by) {
    const id = keyId(by);
    return by && !choices.some((c) => c.value === id) ? [...choices, { value: id, label: id.replace(/^\w+:/, ""), by }] : choices;
  }

  // ---------------------------------------------------------------- matrix regions

  const PALETTE = ["#c98a5b", "#c26b6b", "#b59a5f", "#8aa878", "#5fa4b5", "#5f7fb5", "#8f7fb5", "#868c92"];
  const MAX_REGIONS = 36;
  const DEFAULT_REGIONS = [
    { name: "do", label: "Urgent · important" }, { name: "plan", label: "Important, not urgent" },
    { name: "delegate", label: "Urgent, not important" }, { name: "drop", label: "Neither" },
  ];
  // A region's name is made once from its label, on the save that first keeps
  // it, and never again: the cards placed in it are placed by that name.
  function slug(label, taken) {
    const base = String(label || "").toLowerCase().normalize("NFKD").replace(/[^\w\s-]/g, "").trim().replace(/[\s_-]+/g, "-").slice(0, 40) || "region";
    let s = base, n = 2;
    while (taken.has(s)) s = `${base}-${n++}`;
    taken.add(s);
    return s;
  }

  // ---------------------------------------------------------------- ListEditor

  const VIEWS = [["list", "List"], ["table", "Table"], ["board", "Board"], ["matrix", "Matrix"], ["calendar", "Calendar"]];
  const FORMATS = [["checklist", "Checklist"], ["plain", "Plain"], ["numbered", "Numbered"], ["cards", "Cards"]];

  function open(args = {}, ctx = {}) {
    const T = window.Tasks ?? {};
    const api = ctx.api ?? T.api;
    const taskType = ctx.taskType ?? T.taskType;
    const projects = ctx.projects ?? T.projects ?? [];
    const list = args.list ?? null;
    const projectId = typeof args.project === "string" ? args.project : args.project?.id;
    const status = statusField(taskType);
    const refKey = (taskType?.fields ?? []).find((f) => f.kind === "reference")?.key;

    // What the sheet holds, a draft of the list; saved by difference, so a
    // rename does not refill a snapshot or touch what this sheet does not show.
    const isQuery = list?.membership?.mode === "query";
    const starter = { kind: "group", match: "all", items: [{ kind: "profile", profile: "task", op: "is" }, { kind: "state", value: "open" },
      ...(projectId && refKey ? [{ kind: "property", key: refKey, op: "contains", value: projectId }] : [])] };
    const d = {
      name: list?.name ?? "",
      kind: list?.kind ?? "list",
      mode: isQuery ? "query" : "explicit",
      materialized: isQuery ? Boolean(list.membership.materialized) : false,
      query: isQuery ? asGroup(list.membership.query) : starter,
      sort: clone(list?.order?.sort ?? []),
      groupBy: clone(list?.order?.groupBy ?? null),
      format: list?.["talaris:view"]?.format ?? "checklist",
      bind: list?.["talaris:bind"] ?? status?.key ?? "status",
      columns: list?.kind === "matrix" ? Number(list.placement?.["talaris:columns"] ?? 2) : 2,
      regions: clone(list?.kind === "matrix" && list.placement?.regions?.length
        ? list.placement.regions.map((r) => (typeof r === "string" ? { name: r, label: r } : r))
        : DEFAULT_REGIONS),
    };

    return new Promise((resolve) => {
      const dim = el("div", { class: "le-dim" });
      const sheet = el("div", { class: "le-sheet", role: "dialog" });
      dim.append(sheet);
      let done = false;
      function finish(v) {
        if (done) return;
        done = true;
        popAway();
        document.removeEventListener("keydown", onKey, true);
        dim.remove();
        resolve(v);
      }
      function onKey(e) {
        if (e.key !== "Escape") return;
        e.preventDefault(); e.stopImmediatePropagation();
        finish(null);
      }
      document.addEventListener("keydown", onKey, true);

      const err = el("div", { class: "le-err" });
      const say = (text, bad = true) => { err.textContent = text || ""; err.classList.toggle("ok", !bad); };
      const row = (label, ...kids) => el("div", { class: "le-row" }, el("span", { class: "le-label" }, label), el("div", { class: "le-val" }, ...kids));

      const name = el("input", { type: "text", class: "le-name", spellcheck: "false", placeholder: "Name", value: d.name });
      name.addEventListener("input", () => { d.name = name.value; });
      name.addEventListener("keydown", (e) => { if (e.key === "Enter") save(); });

      // Sections drawn again when what they show changes; the name and the
      // query keep their own elements, so neither loses its caret or its state.
      const viewBox = el("div"), memberBox = el("div"), queryHost = el("div", { class: "le-query" });
      const orderBox = el("div"), kindBox = el("div"), dangerBox = el("span", { class: "le-danger" });
      const qb = mountQuery(queryHost, d.query, { taskType, projects, api, onChange: (q) => { d.query = q; } });

      function paintView() {
        viewBox.replaceChildren(row("View", seg(VIEWS, d.kind, (k) => { d.kind = k; paintView(); paintKind(); })));
      }
      function paintMembers() {
        const kids = [row("Members", seg([["explicit", "By hand"], ["query", "By query"]], d.mode, (m) => { d.mode = m; paintMembers(); }))];
        if (d.mode === "query") {
          const how = [seg([["live", "Live"], ["snapshot", "Snapshot"]], d.materialized ? "snapshot" : "live", (v) => { d.materialized = v === "snapshot"; paintMembers(); })];
          if (d.materialized) {
            const wasSnapshot = isQuery && list.membership.materialized;
            if (wasSnapshot) how.push(el("button", { type: "button", class: "t-btn", onclick: refresh }, "Refresh"));
            else how.push(el("small", { class: "le-note" }, "Fill now"));
          }
          kids.push(row("", ...how));
        }
        memberBox.replaceChildren(...kids);
        queryHost.hidden = d.mode !== "query";
      }
      function paintOrder() {
        const choices = orderChoices(taskType);
        const levels = d.sort.map((s, i) => el("div", { class: "le-line" },
          el("span", { class: "le-then" }, i ? "then" : ""),
          picker(keyChoices(choices, s.by), keyId(s.by), (v) => { s.by = clone(choices.find((c) => c.value === v)?.by ?? s.by); paintOrder(); }),
          seg([["ascending", "Asc"], ["descending", "Desc"]], s.direction === "descending" ? "descending" : "ascending", (v) => { s.direction = v; paintOrder(); }),
          xBtn("Remove", () => { d.sort.splice(i, 1); paintOrder(); })));
        const add = el("button", { type: "button", class: "t-btn", onclick: () => { d.sort.push({ by: { field: "title" }, direction: "ascending" }); paintOrder(); } },
          d.sort.length ? "+ Then by" : "+ Sort");
        const groups = [{ value: "", label: "None" }, ...keyChoices(choices, d.groupBy)];
        orderBox.replaceChildren(
          row("Order", d.sort.length ? null : el("span", { class: "le-muted" }, "Manual"), ...levels, add),
          row("Group", picker(groups, keyId(d.groupBy), (v) => { d.groupBy = v ? clone(groups.find((c) => c.value === v).by) : null; paintOrder(); })));
      }
      function paintKind() {
        if (d.kind === "list") kindBox.replaceChildren(row("Format", seg(FORMATS, d.format, (f) => { d.format = f; paintKind(); })));
        else if (d.kind === "board") {
          const enums = (taskType?.fields ?? []).filter((f) => kindOf(f) === "enum").map((f) => ({ value: f.key, label: fieldLabel(f) }));
          kindBox.replaceChildren(row("Columns", picker(enums, d.bind, (v) => { d.bind = v; paintKind(); })));
        } else if (d.kind === "matrix") kindBox.replaceChildren(...matrixRows());
        else kindBox.replaceChildren();
      }
      function matrixRows() {
        const statusChoices = [{ value: "", label: "None" }, ...optionChoices(status)];
        const regions = d.regions.map((r, i) => {
          const enter = r["talaris:enter"] ?? {};
          const setEnter = (k, v) => {
            const e = { ...(r["talaris:enter"] ?? {}) };
            if (v === "" || v == null || v === false) delete e[k]; else e[k] = v;
            if (!e.tag) delete e.untagOnLeave;
            if (Object.keys(e).length) r["talaris:enter"] = e; else delete r["talaris:enter"];
          };
          const color = el("button", { type: "button", class: "le-swatch", title: "Color", style: `background:${r["talaris:color"] ?? "transparent"}` });
          color.addEventListener("click", () => (popAnchor === color ? popAway() : popUnder(color, el("div", { class: "le-palette" },
            el("button", { type: "button", class: "le-swatch none" + (r["talaris:color"] ? "" : " on"), title: "None", onclick: () => { popAway(); delete r["talaris:color"]; paintKind(); } }),
            PALETTE.map((c) => el("button", { type: "button", class: "le-swatch" + (r["talaris:color"] === c ? " on" : ""), style: `background:${c}`,
              onclick: () => { popAway(); r["talaris:color"] = c; paintKind(); } }))))));
          const label = el("input", { type: "text", spellcheck: "false", placeholder: "Label", value: r.label ?? r.name ?? "" });
          label.addEventListener("input", () => { r.label = label.value; });
          const tag = el("input", { type: "text", class: "le-tag", spellcheck: "false", placeholder: "tag", value: enter.tag ?? "" });
          const untag = el("button", { type: "button", class: "switch" + (enter.untagOnLeave ? " on" : ""), title: "Remove on leave", disabled: !enter.tag,
            onclick: () => { setEnter("untagOnLeave", !r["talaris:enter"]?.untagOnLeave); paintKind(); } });
          // Not drawn again while typing: the switch only follows whether there is a tag.
          tag.addEventListener("input", () => {
            setEnter("tag", tag.value.replace(/^#/, "").trim());
            untag.disabled = !r["talaris:enter"]?.tag;
            untag.classList.toggle("on", Boolean(r["talaris:enter"]?.untagOnLeave));
          });
          return el("div", { class: "le-region" },
            el("div", { class: "le-line" }, color, label, xBtn("Remove", () => { d.regions.splice(i, 1); paintKind(); })),
            el("div", { class: "le-line le-enter" },
              el("span", { class: "le-muted" }, "Enters"), tag, untag, el("span", { class: "le-muted" }, "Untag on leave"),
              status ? picker(statusChoices, enter.status ?? "", (v) => { setEnter("status", v); paintKind(); }, "Status") : null));
        });
        const add = el("button", { type: "button", class: "t-btn", disabled: d.regions.length >= MAX_REGIONS,
          onclick: () => { d.regions.push({ label: `Region ${d.regions.length + 1}` }); paintKind(); } }, "+ Region");
        return [
          row("Columns", seg([1, 2, 3, 4, 5, 6].map((n) => [n, String(n)]), d.columns, (n) => { d.columns = n; paintKind(); })),
          row("Regions", el("div", { class: "le-regions" }, ...regions), add),
        ];
      }
      function paintDanger() {
        if (!list) { dangerBox.replaceChildren(); return; }
        // Deleting cannot be undone, so it asks twice: the button arms, then acts.
        const del = el("button", { type: "button", class: "t-btn danger" }, "Delete");
        let armed = 0;
        del.addEventListener("click", () => {
          if (armed) return remove();
          del.textContent = "Delete?";
          armed = setTimeout(() => { armed = 0; del.textContent = "Delete"; }, 3000);
        });
        dangerBox.replaceChildren(list.archived ? el("button", { type: "button", class: "t-btn", onclick: unarchive }, "Restore")
          : el("button", { type: "button", class: "t-btn danger", onclick: archive }, "Archive"), del);
      }

      // ---- talking to the core: one thing at a time, its words shown as they are.
      let busy = false;
      async function act(fn) {
        if (busy) return;
        busy = true; say("");
        sheet.classList.add("busy");
        try { await fn(); } catch (e) { say(e?.message || String(e)); } finally { busy = false; sheet.classList.remove("busy"); }
      }
      function placement() {
        const taken = new Set(d.regions.map((r) => r.name).filter(Boolean));
        const regions = d.regions.map((r) => {
          const out = { ...r, label: (r.label ?? "").trim() || r.name || "Region" };
          if (!out.name) out.name = slug(out.label, taken);
          return out;
        });
        return { ...(list?.kind === "matrix" ? list.placement : {}), semantic: true, "talaris:columns": d.columns, regions };
      }
      function order(sort = d.sort, groupBy = d.groupBy) {
        const o = {};
        if (sort.length) o.sort = sort.map((s) => ({ by: s.by, direction: s.direction === "descending" ? "descending" : "ascending" }));
        if (groupBy) o.groupBy = groupBy;
        return Object.keys(o).length ? o : null;
      }
      function body() {
        const b = { name: d.name.trim(), kind: d.kind };
        const query = d.mode === "query" ? qb.get() : null;
        const o = order();
        if (!list) {
          if (query) { b.query = query; b.materialized = d.materialized; }
          if (o) b.order = o;
        } else {
          if (b.name === list.name) delete b.name;
          if (b.kind === list.kind) delete b.kind;
          const wasQuery = isQuery ? list.membership.query : null;
          const wasMat = isQuery ? Boolean(list.membership.materialized) : false;
          if (!same(query, wasQuery) || (query && d.materialized !== wasMat)) { b.query = query; if (query) b.materialized = d.materialized; }
          // Compared as this sheet would write it, so an unsaid direction is not a change.
          const before = order(list.order?.sort ?? [], list.order?.groupBy ?? null);
          if (!same(o, before)) b.order = o;
        }
        if (d.kind === "list" && d.format !== list?.["talaris:view"]?.format) b.view = { format: d.format };
        if (d.kind === "board" && d.bind !== list?.["talaris:bind"]) b.bind = d.bind;
        if (d.kind === "matrix") {
          const p = placement();
          if (!list || list.kind !== "matrix" || !same(p, list.placement)) b.placement = p;
        }
        return b;
      }
      function save() {
        if (!d.name.trim()) { say("A name"); name.focus(); return; }
        act(async () => {
          const b = body();
          const saved = list ? (Object.keys(b).length ? await api("PATCH", `/lists/${list.id}`, b) : list) : await api("POST", "/lists", b);
          finish(saved);
        });
      }
      function refresh() {
        act(async () => { await api("POST", `/lists/${list.id}/refresh`); say("Refreshed", false); });
      }
      function archive() { act(async () => finish(await api("PATCH", `/lists/${list.id}`, { archived: true }))); }
      function unarchive() { act(async () => finish(await api("PATCH", `/lists/${list.id}`, { archived: false }))); }
      // A deleted list resolves as itself, marked, so the panel knows to let it go.
      function remove() { act(async () => { await api("DELETE", `/lists/${list.id}`); finish({ ...list, deleted: true }); }); }

      sheet.append(
        el("div", { class: "le-title label" }, list ? "Collection" : "New collection"),
        // A synced one is defined by the app it is synced with: changes here are put back at the next sync.
        ...(list?.["talaris:syncedBy"] ? [el("div", { class: "le-muted" }, `Synced by ${list["talaris:syncedBy"]} — its name, regions, order and rule follow the other app`)] : []),
        row("Name", name), viewBox, memberBox, queryHost, orderBox, kindBox, err,
        el("div", { class: "le-acts" }, dangerBox, el("span", { class: "spacer" }),
          el("button", { type: "button", class: "t-btn", onclick: () => finish(null) }, "Cancel"),
          el("button", { type: "button", class: "t-btn le-save", onclick: save }, "Save")));
      paintView(); paintMembers(); paintOrder(); paintKind(); paintDanger();
      document.body.append(dim);
      name.focus();
    });
  }

  window.QueryBuilder = { mount: mountQuery };
  window.ListEditor = { open };
})();
