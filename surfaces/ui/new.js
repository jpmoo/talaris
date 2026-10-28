// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore
//
// New (new.html): a task, an event, a person, a note or a project, made from
// one sheet. Each kind is a few rows; the first is focused, Enter makes it,
// Shift+Enter makes it and opens it where it lives (a task in Tasks, an event
// in the calendar). The kind last made is the one the sheet opens on.
//
// No browser pickers — a <select>, a date or a time field opens a window of
// the engine's own, which a layer surface cannot hold — so dates and times are
// typed ("fri", "tomorrow", "10/30", "2:30pm") or chosen from lists drawn here.

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
    for (const k of kids.flat()) if (k != null && k !== false) e.append(k);
    return e;
  }
  /** The small × that takes a thing off (controls.css .x-btn). */
  function xBtn(title, act) {
    const b = el("button", { type: "button", class: "x-btn", title, onclick: (e) => { e.stopPropagation(); act(); } });
    b.innerHTML = Icons.close();
    return b;
  }
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* fine */ } },
  };

  const KINDS = [["task", "Task"], ["event", "Event"], ["contact", "Person"], ["note", "Page"], ["project", "Project"]];
  let bridge = null;
  let surface = { up: false };
  let kind = store.get("talaris.new.kind", "task");
  if (!KINDS.some(([k]) => k === kind)) kind = "task";
  let v = {};            // what has been entered, for the kind on show
  let editors = [];      // the editor fields made for it, to be put away
  let editorMod = null;  // editor.js, once loaded
  let busy = false;

  // ---------------------------------------------------------------- the core

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

  // ---------------------------------------------------------------- days and times

  const pad = (n) => String(n).padStart(2, "0");
  const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
  const sameDay = (a, b) => a && b && a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  const startOfWeek = (d) => addDays(new Date(d.getFullYear(), d.getMonth(), 1), -new Date(d.getFullYear(), d.getMonth(), 1).getDay());
  const isoDay = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const dayLabel = (d) => Kit.day(d);
  const timeLabel = (m) => Kit.minutes(m);
  const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
  const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

  // What is typed, read as every page reads it (kit.js): "3" is the afternoon; "fri" on a Friday is today.
  const parseDay = (text) => Kit.parseDay(text);
  const parseTime = (text) => Kit.parseTime(text);

  // ---------------------------------------------------------------- the one small list

  // One pop-up at a time, the kit's (kit.js): placed under what opened it (or above, with more room there),
  // kept on screen, scrolling when long, put away by a press elsewhere or Escape — the same on every page.
  const popUnder = (anchor, content) => Kit.pop(anchor, content);
  const popAway = () => Kit.popAway();
  const monthPicker = (chosen, pick, opts) => Kit.monthPicker(chosen, pick, opts);
  const timeList = (current, pick) => Kit.timeList(current, pick);

  function menu(anchor, items) {
    popUnder(anchor, el("div", { class: "menu-list" }, items.map((it) =>
      el("button", { class: "menu-item" + (it.on ? " on" : ""), onclick: (e) => { e.stopPropagation(); popAway(); it.act(); } },
        it.color ? el("span", { class: "sw", style: `background:${it.color}` }) : null, it.label))));
  }

  // ---------------------------------------------------------------- fields

  const row = (label, ...kids) => el("div", { class: "row" }, el("label", {}, label), ...kids);

  /** A plain line of text, kept in v[key]. */
  function line(key, placeholder, attrs = {}) {
    return el("input", { type: "text", class: "field grow" + (attrs.big ? " big" : ""), placeholder, value: v[key] || "", spellcheck: attrs.spell ? "true" : "false",
      oninput: (e) => { v[key] = e.target.value; attrs.oninput && attrs.oninput(e.target.value); } });
  }

  // A page or a canvas a mention points at opens where it lives (the sheet goes).
  const mentionOpts = { project: () => "", openPlace: (p) => bridge && bridge.openPlace(p.kind, p.project, p.where), openPerson: (id) => bridge && bridge.openPerson(id) };

  /** An editor line, or box, that takes @ — kept in v[key]. */
  function writing(key, placeholder, { body = false, big = false, files = null } = {}) {
    const host = el("div", { class: "ed grow" + (body ? " ed-body" : "") + (big ? " ed-big" : ""), "data-placeholder": placeholder });
    const make = (m) => {
      const ed = m.createEditor(host, v[key] || "", {
        live: true, compact: true, singleLine: !body, placeholder,
        mentions: TalarisMentions(api, null, mentionOpts),
        onOpenUrl: (u) => bridge && bridge.openUrl(u),
        ...(files ? { files } : {}),
        ...(body ? {} : { onEnter: () => make_(false) }),
        });
      editors.push({ ed, key });
    };
    if (editorMod) make(editorMod);
    else import("./editor.js").then((m) => { editorMod = m; make(m); if (host.dataset.focus) focusFirst(); }).catch((e) => say(e.message, true));
    return host;
  }
  // The editors' words, read at the moment of making (onChange may not be an option everywhere).
  function readEditors() { for (const { ed, key } of editors) v[key] = ed.text; }

  /** A day: typed or picked, its reading shown beside it. */
  function dayField(key, placeholder) {
    const hint = el("span", { class: "hint" });
    const show = () => {
      const t = v[key + "Text"] || "";
      const d = parseDay(t);
      v[key] = d;
      hint.textContent = t.trim() ? (d ? dayLabel(d) : "?") : "";
      hint.className = "hint" + (t.trim() && !d ? " err" : "");
    };
    const input = el("input", { type: "text", class: "field", placeholder, value: v[key + "Text"] || "", spellcheck: "false", style: "width: 150px",
      oninput: (e) => { v[key + "Text"] = e.target.value; show(); } });
    const pick = el("button", { class: "icon-btn", title: "Choose a day", "data-pops": "1",
      onclick: () => popUnder(pick, monthPicker(v[key], (d) => { input.value = dayLabel(d); v[key + "Text"] = input.value; show(); input.focus(); })) }, "▾");
    show();
    return [input, pick, hint];
  }

  /** A time: typed or picked. */
  function timeField(key, onSet) {
    const input = el("input", { type: "text", id: `time-${key}`, class: "field", value: v[key] != null ? timeLabel(v[key]) : "", spellcheck: "false", style: "width: 96px",
      oninput: (e) => { const m = parseTime(e.target.value); input.classList.toggle("bad", e.target.value.trim() !== "" && m == null); if (m != null) { v[key] = m; onSet && onSet(m); } },
      onfocus: () => popUnder(input, timeList(v[key], (m) => { v[key] = m; input.value = timeLabel(m); onSet && onSet(m); })),
      onblur: () => { if (v[key] != null) input.value = timeLabel(v[key]); },
      "data-pops": "1" });
    return input;
  }

  /**
   * People found as typed — the address books and the calendars' (the same
   * finding as the @ picker's) — under a field: a click, or Enter for the first.
   */
  function finder(listEl, query, choose) {
    const q = query.trim();
    if (q.length < 2) { listEl.replaceChildren(); return; }
    const asked = q;
    api("GET", `/people/find?q=${enc(q)}`).then((people) => {
      if (listEl.dataset.q !== asked) return;
      const low = q.toLowerCase();
      const found = (people || []).map((p) => ({ email: p.email, name: p.name && !p.name.includes("@") ? p.name : "" }))
        .filter((p) => Kit.matches(low, p.name, p.email.split("@")[0])).slice(0, 6);
      listEl.found = found;
      listEl.replaceChildren(...found.map((p, i) => el("button", { class: "menu-item" + (i === 0 ? " first" : ""), onclick: () => choose(p) },
        el("span", {}, p.name || p.email), p.name ? el("span", { class: "addr" }, p.email) : null)));
    }).catch(() => listEl.replaceChildren());
    listEl.dataset.q = asked;
  }

  // ---------------------------------------------------------------- the kinds
  //
  // A task, a person, a note and a project are drawn from their types: every
  // field the type has, each by its kind — so a field somebody adds to a type
  // turns up here too. Which field is the title, the status, the dates or the
  // address is read from the type's profiles, never from a name. Only a field
  // the core fills itself (`talaris:auto`) is left out. An event is the
  // calendar's, and has the calendar's form.

  let types = [];
  let calendars = [];
  const ROLE = { task: "task", contact: "person", note: "note", project: "project" };
  const typeFor = (k) => types.find((t) => t["talaris:role"] === ROLE[k]);
  const labelOf = (f) => f["talaris:label"] || f.label || words(f.key);
  const words = (key) => key.replace(/_/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (c) => c.toUpperCase());

  /** What a type's profiles say about its fields. */
  function readType(t) {
    const p = t.profiles || {};
    const any = p.task || p.note || p.contact || p.event || {};
    const task = p.task || null;
    const span = task && ((task.due && task.due.field) || (task.start && task.start.field)) || null;
    return {
      titleKey: typeof any.title === "string" ? any.title : "title",
      task, span,
      status: task && typeof task.status === "string" ? task.status : null,
      email: p.contact && typeof p.contact.email === "string" ? p.contact.email : null,
      // @ goes where words are written: a body, and the title of a thing that says something (a task, a note).
      titleTakesAt: Boolean(p.task || p.note),
    };
  }

  // ---- repeating, for a task (a series, by the format's rule) and an event (an RRULE)
  const WD = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
  const REPEATS = [
    ["", "Doesn't repeat"], ["daily", "Every day"], ["weekdays", "Every weekday"], ["weekly", "Every week"],
    ["biweekly", "Every two weeks"], ["monthly", "Every month"], ["yearly", "Every year"],
  ];
  function repeatRow(forTask, dayOf) {
    const label = (REPEATS.find(([k]) => k === (v.repeat || "")) || REPEATS[0])[1];
    const btn = el("button", { class: "pick", "data-pops": "1", onclick: () => menu(btn, REPEATS.map(([k, l]) => ({
      label: l + (k === "weekly" || k === "biweekly" ? ` on ${(dayOf() || new Date()).toLocaleDateString("en-US", { weekday: "long" })}` : ""),
      on: (v.repeat || "") === k, act: () => { v.repeat = k; paint(); } }))) }, el("span", { class: "lbl" }, label));
    // A task can count from when it is done instead ("a week after I last did it").
    const after = forTask && v.repeat && v.repeat !== "weekdays"
      ? el("button", { class: "t-btn tog" + (v.fromDone ? " on" : ""), title: "Count from when it is done, not from its date",
        onclick: () => { v.fromDone = !v.fromDone; paint(); } }, "After done") : null;
    return row("Repeat", btn, after);
  }
  /** The format's rule for a task (recurrence.ts), from the choice. */
  function taskRule(day) {
    const r = v.repeat;
    if (!r) return null;
    const anchor = v.fromDone && r !== "weekdays" ? "completion" : "schedule";
    const base = { anchor, interval: 1, end: { type: "never" } };
    if (r === "daily") return { ...base, freq: "daily" };
    if (r === "weekdays") return { ...base, anchor: "schedule", freq: "weekly", byWeekday: ["MO", "TU", "WE", "TH", "FR"] };
    if (r === "weekly" || r === "biweekly") return { ...base, freq: "weekly", interval: r === "biweekly" ? 2 : 1, ...(anchor === "schedule" ? { byWeekday: [WD[day.getDay()]] } : {}) };
    return { ...base, freq: r };
  }
  /** An RRULE for a calendar. */
  function eventRule(day) {
    const r = v.repeat;
    if (!r) return "";
    if (r === "weekdays") return "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR";
    if (r === "weekly") return `FREQ=WEEKLY;BYDAY=${WD[day.getDay()]}`;
    if (r === "biweekly") return `FREQ=WEEKLY;INTERVAL=2;BYDAY=${WD[day.getDay()]}`;
    return `FREQ=${r.toUpperCase()}`;
  }

  // ---- a field, by its kind

  /** Things of a type, chosen as chips: searched as typed, Enter or a click for one. */
  function refField(f) {
    const target = types.find((t) => t.id === f.targetType);
    const people = Boolean(target && (target.profiles || {}).contact);
    const chosen = v[f.key] = v[f.key] || [];
    const found = el("div", { class: "found" });
    const take = (x) => {
      if (!chosen.some((c) => c.id === x.id && x.id)) { if (f.many) chosen.push(x); else chosen.splice(0, chosen.length, x); }
      v[f.key + "Q"] = "";
      paint();
      focusId(`ref-${f.key}`);
    };
    const search = async (q) => {
      found.dataset.q = q;
      let got = [];
      if (people) {
        // People as @ finds them: here already, or in an address book (made when chosen).
        got = q.trim().length >= 1 ? (await TalarisMentions(api).search(q)).filter((x) => x.kind === "contact") : [];
      } else {
        got = ((await api("GET", `/entities?q=${enc(q)}&limit=40`)) || []).filter((x) => x.type === f.targetType && !x.stub).map((x) => ({ id: x.id, title: x.title }));
      }
      if (found.dataset.q !== q) return;
      got = got.filter((x) => !chosen.some((c) => c.id && c.id === x.id)).slice(0, 7);
      found.found = got;
      found.replaceChildren(...got.map((x, i) => el("button", { class: "menu-item" + (i === 0 ? " first" : ""), onclick: () => take(x) },
        el("span", {}, x.title), x.detail ? el("span", { class: "addr" }, x.detail) : null)));
    };
    const input = el("input", { type: "text", id: `ref-${f.key}`, class: "field grow", placeholder: target ? `Find ${target.name.toLowerCase()}…` : "Find…",
      value: v[f.key + "Q"] || "", spellcheck: "false",
      oninput: (e) => { v[f.key + "Q"] = e.target.value; search(e.target.value).catch(() => {}); },
      onfocus: (e) => { if (!people) search(e.target.value).catch(() => {}); },
      onkeydown: (e) => {
        if (e.key !== "Enter" || e.shiftKey || e.ctrlKey || !input.value.trim()) return;
        e.preventDefault(); e.stopPropagation();
        if (found.found && found.found.length) take(found.found[0]);
      } });
    const chips = chosen.length ? el("div", { class: "chips" }, chosen.map((c, i) => el("span", { class: "chip" }, el("span", { class: "lbl" }, c.title),
      xBtn("Remove", () => { chosen.splice(i, 1); paint(); })))) : null;
    return [row(labelOf(f), el("div", { class: "grow col" }, chips, f.many || !chosen.length ? input : null)), found];
  }

  /**
   * Several values — addresses, phones, websites — one to a line, since one
   * of them may hold commas (a postal address does). A new line appears as
   * the last is filled.
   */
  function manyField(f, label, oninput, known) {
    const vals = v[f.key] = Array.isArray(v[f.key]) ? v[f.key] : [];
    const box = el("div", { class: "grow col" });
    const draw = () => {
      const lines = [...vals.filter((x) => x !== undefined), ""].slice(0, Math.max(1, vals.filter((x) => String(x).trim()).length + 1));
      box.replaceChildren(...lines.map((val, i) => el("input", { type: "text", class: "field", value: val, spellcheck: "false", placeholder: i ? "Another" : "Optional",
        oninput: (e) => {
          const wasLast = i === lines.length - 1;
          vals[i] = e.target.value;
          if (i === 0 && oninput) oninput(e.target.value);
          // Typing in the last line opens one more under it.
          if (wasLast && e.target.value.trim()) { draw(); box.children[i].focus(); }
        } })));
    };
    draw();
    return row(label, box, known ? el("span", { class: "hint", id: "known" }) : null);
  }

  function fileField(f) {
    const files = v[f.key] = v[f.key] || [];
    const kb = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
    return row(labelOf(f), el("div", { class: "grow col" },
      files.length ? el("div", { class: "chips" }, files.map((x, i) => el("span", { class: "chip", title: x.path }, el("span", { class: "lbl" }, `${x.name} · ${kb(x.size)}`),
        xBtn("Remove", () => { files.splice(i, 1); paint(); })))) : null,
      el("div", {}, el("button", { class: "t-btn", onclick: () => bridge && bridge.chooseFiles(f.key) }, f.many || !files.length ? "Add files…" : "Change…"))));
  }

  function enumField(f, def) {
    if (v[f.key] === undefined) v[f.key] = def ?? null;
    const labels = f["talaris:labels"] || {}, colors = f["talaris:colors"] || {};
    return row(labelOf(f), el("div", { class: "grow chips" }, (f.options || []).map((o) =>
      el("button", { class: "t-btn tog" + (v[f.key] === o ? " on" : ""), onclick: () => { v[f.key] = v[f.key] === o && !def ? null : o; paint(); } },
        colors[o] ? el("span", { class: "sw", style: `background:${colors[o]}; margin-right: 6px` }) : null, labels[o] || words(o)))));
  }

  function fieldRow(f, info, t) {
    const label = labelOf(f);
    // Drawn first, as the kind's own line — the status as the circle before it.
    if (f.key === info.titleKey || f.key === info.status) return null;
    switch (f.kind) {
      case "richtext": return row(label, writing(f.key, "@ to link a person, event or task", { body: true }));
      case "text":
        if (f.many) return manyField(f, label, f.key === info.email ? checkEmail : null, f.key === info.email);
        return row(label, line(f.key, "Optional", { spell: true }));
      case "number": return row(label, el("input", { type: "text", class: "field", style: "width: 120px", value: v[f.key] ?? "", oninput: (e) => { v[f.key] = e.target.value; } }));
      case "boolean": return row(label, el("button", { class: "switch" + (v[f.key] ? " on" : ""), title: v[f.key] ? "Yes" : "No", onclick: () => { v[f.key] = !v[f.key]; paint(); } }));
      case "date": return row(label, ...dayField(f.key, "fri, 10/30…"));
      case "datetime": return row(label, ...dayField(f.key, "fri, 10/30…"), timeField(f.key + "At"));
      case "datespan": return [
        row(f.startLabel || "From", ...dayField(f.key + "Start", "Optional")),
        row(f.endLabel || "To", ...dayField(f.key + "End", "fri, 10/30…")),
        info.task && info.span === f.key ? repeatRow(true, () => v[f.key + "End"] || v[f.key + "Start"]) : null,
      ];
      case "enum": return enumField(f, f.key === info.status ? t["talaris:defaultStatus"] || (f.options || [])[0] : null);
      case "reference": return refField(f);
      case "attachment": return fileField(f);
      default: return null;
    }
  }

  function typeForm() {
    const t = typeFor(kind);
    if (!t) return [row("", el("span", { class: "hint" }, types.length ? "There is no type for this" : "Reading the types…"))];
    const info = readType(t);
    const name = KINDS.find(([k]) => k === kind)[1];
    const titleField = t.fields.find((f) => f.key === info.titleKey);
    const placeholder = { task: "What needs doing", contact: "Their name", note: "Its title", project: "Its name" }[kind] || "";
    let title;
    const circle = statusCircle(t, info);
    if (titleField && info.titleTakesAt) title = row(name, circle, writing(info.titleKey, placeholder, { big: true }));
    else {
      const input = line(info.titleKey, placeholder, { big: true, spell: !info.email });
      if (kind === "project") noLeadingSpace(input);
      title = [row(name, input)];
      if (info.email) {
        // A person: the address books' people as their name is typed — a click, or Enter, fills them in.
        const found = el("div", { class: "found" });
        const fill = (p) => { v[info.titleKey] = p.name || v[info.titleKey] || ""; v[info.email] = [p.email]; paint(); checkEmail(p.email); };
        input.addEventListener("input", () => finder(found, input.value, fill));
        input.addEventListener("keydown", (e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.ctrlKey && found.found && found.found.length && !firstEmail(info)) { e.preventDefault(); e.stopPropagation(); fill(found.found[0]); }
        });
        title.push(found);
        setTimeout(() => checkEmail(firstEmail(info)), 0);
      }
    }
    return [title, t.fields.filter((f) => !f["talaris:auto"]).map((f) => fieldRow(f, info, t)),
      // A project's files are its folder's (Files/): kept there once it is made.
      t["talaris:role"] === "project" ? fileField({ key: "projectFiles", kind: "attachment", many: true, "talaris:label": "Files" }) : null];
  }

  /**
   * A task's status, as the Tasks panel shows it: a circle before the title,
   * in the status's color, filled when it counts as done. A press offers the
   * statuses, the person's own (Tasks → Statuses).
   */
  function statusCircle(t, info) {
    if (!info.status) return null;
    const f = t.fields.find((x) => x.key === info.status);
    if (!f) return null;
    if (v[f.key] === undefined) v[f.key] = t["talaris:defaultStatus"] || (f.options || [])[0] || null;
    const labels = f["talaris:labels"] || {}, colors = f["talaris:colors"] || {};
    const done = new Set((info.task && info.task.completeValues) || []);
    const now = v[f.key];
    const b = el("button", { class: "circle" + (done.has(now) ? " done" : ""), "data-pops": "1", title: `Status: ${labels[now] || words(now || "")}`,
      style: `--c:${colors[now] || "var(--muted)"}`,
      onclick: () => menu(b, (f.options || []).map((o) => ({ label: labels[o] || words(o), color: colors[o] || "var(--muted)", on: o === now, act: () => { v[f.key] = o; paint(); } }))) });
    return b;
  }

  /** A person's first address, as entered: who they are found by. */
  const firstEmail = (info) => {
    const e = v[info.email];
    return String((Array.isArray(e) ? e.find((x) => String(x).trim()) : e) || "").trim().toLowerCase();
  };

  // Whether this address is somebody already: said beside it, and making adds to them.
  function checkEmail(email) {
    const known = $("known");
    if (!known) return;
    known.textContent = "";
    const e = String(email || "").split(/[,;]/)[0].trim().toLowerCase();
    if (!e.includes("@")) return;
    api("POST", "/entities/people/known", { emails: [e] }).then((k) => { if ($("known")) $("known").textContent = k[e] ? `Already here: ${k[e].title}` : ""; }).catch(() => {});
  }

  /**
   * A note is a writing page: in a project (this one, unless another is
   * chosen), listed with its pages and opened there. Its words take @ and
   * files, kept in that project.
   */
  let projectList = [];
  function noteForm() {
    if (!v.project) v.project = surface.project || (projectList.find((p) => p.home) || {}).id || "";
    const p = projectList.find((x) => x.id === v.project);
    const pick = el("button", { class: "pick" + (p ? "" : " empty"), "data-pops": "1", onclick: () => menu(pick, projectList.map((x) => ({
      label: `${x.name}${x.id === surface.project ? " · here" : ""}`, on: x.id === v.project, act: () => { v.project = x.id; paint(); } }))) },
      el("span", { class: "lbl" }, p ? p.name : "Choose a project"));
    return [
      row("Page", line("title", "Its title", { big: true, spell: true })),
      row("Project", pick),
      row("", writing("body", "Write — @ to link, or drop a file in", { body: true, files: TalarisFiles(api, () => v.project, () => bridge) })),
      // Kept in the project's Files/ when the note is made, and linked at its end.
      fileField({ key: "noteFiles", kind: "attachment", many: true, "talaris:label": "Files" }),
    ];
  }

  function eventForm() {
    if (v.day === undefined) {
      const now = new Date();
      const next = Math.ceil((now.getHours() * 60 + now.getMinutes() + 1) / 30) * 30;
      v.dayText = next >= 24 * 60 ? "tomorrow" : "today";
      v.from = next % (24 * 60);
      v.to = Math.min(v.from + 60, 24 * 60 - 15);
    }
    const cal = calendars.find((c) => c.id === v.calendar) || calendars.find((c) => c.id === store.get("talaris.new.calendar", "")) || calendars[0];
    if (cal) v.calendar = cal.id;
    const calBtn = el("button", { class: "pick" + (cal ? "" : " empty"), "data-pops": "1", onclick: () => menu(calBtn, calendars.map((c) => ({ label: c.name, color: c.color, on: c.id === v.calendar, act: () => { v.calendar = c.id; paint(); } }))) },
      cal ? el("span", { class: "sw", style: `background:${cal.color || "var(--accent)"}` }) : null, el("span", { class: "lbl" }, cal ? cal.name : "No calendar to write to"));
    const allDay = [el("span", { class: "hint" }, "All day"), el("button", { class: "switch" + (v.allDay ? " on" : ""), title: "All day", onclick: () => { v.allDay = !v.allDay; paint(); } })];
    v.people = v.people || [];
    const chips = el("div", { class: "chips" }, v.people.map((p, i) => el("span", { class: "chip", title: p.email }, el("span", { class: "lbl" }, p.name || p.email),
      xBtn("Remove", () => { v.people.splice(i, 1); paint(); }))));
    const found = el("div", { class: "found" });
    const add = (p) => { if (!v.people.some((x) => x.email === p.email)) v.people.push(p); v.invite = ""; paint(); focusId("invite"); };
    const invite = el("input", { type: "text", id: "invite", class: "field grow", placeholder: cal && !cal.invites ? "This calendar cannot invite" : "Name or address",
      value: v.invite || "", spellcheck: "false", disabled: cal && !cal.invites ? "" : null,
      oninput: (e) => { v.invite = e.target.value; finder(found, e.target.value, add); },
      onkeydown: (e) => {
        if (e.key !== "Enter" || e.shiftKey || e.ctrlKey || !invite.value.trim()) return;
        // Enter with words typed takes the first found, or an address as written; empty, it makes the event.
        e.preventDefault(); e.stopPropagation();
        const typed = invite.value.trim();
        if (found.found && found.found.length) add(found.found[0]);
        else if (/^[^@\s<>"]+@[^@\s<>"]+\.[^@\s<>"]+$/.test(typed)) add({ email: typed.toLowerCase(), name: "" });
        else say("No one found by that", true);
      } });
    return [
      row("Event", line("title", "What it is", { big: true, spell: true })),
      row("Day", ...dayField("day", "today, fri, 10/30…"), el("span", { class: "spacer" }), ...allDay),
      v.allDay ? null : row("Time",
        timeField("from", (m) => { if (v.to <= m) { v.to = Math.min(m + 60, 24 * 60 - 15); $("time-to").value = timeLabel(v.to); } }),
        el("span", { class: "hint" }, "to"),
        timeField("to")),
      repeatRow(false, () => v.day),
      row("Calendar", calBtn),
      row("Invite", el("div", { class: "grow col" }, v.people.length ? chips : null, invite)),
      found,
      row("Where", line("location", "Optional", { spell: true })),
      row("Notes", writing("notes", "Optional: @ to link a person, event or task", { body: true })),
      // Kept with the event's entity, made as soon as the calendar has it.
      fileField({ key: "files", kind: "attachment", many: true, "talaris:label": "Files" }),
    ];
  }

  // ---------------------------------------------------------------- drawing

  function paintKinds() {
    $("kinds").replaceChildren(...KINDS.map(([k, label], i) => el("button", { class: "t-btn small" + (k === kind ? " on" : ""), title: `${label} — Ctrl+${i + 1}`,
      onclick: () => choose(k) }, label)));
  }
  function paint() {
    // Whatever is being typed is kept across a redraw, the editors' words with the rest.
    readEditors();
    const active = document.activeElement;
    const at = active && active.closest && active.closest("#rows") ? [...$("rows").querySelectorAll("input, .cm-content")].indexOf(active) : -1;
    for (const { ed } of editors) ed.destroy();
    editors = [];
    popAway();
    $("rows").replaceChildren(...[kind === "event" ? eventForm() : kind === "note" ? noteForm() : typeForm()].flat(3).filter(Boolean));
    if (at >= 0) { const again = [...$("rows").querySelectorAll("input, .cm-content")][at]; if (again) again.focus(); }
  }
  function focusId(id) { setTimeout(() => $(id) && $(id).focus(), 0); }
  function focusFirst() {
    const first = $("rows").querySelector("input.field, .ed");
    if (!first) return;
    if (first.classList.contains("ed")) {
      const cm = first.querySelector(".cm-content");
      if (cm) cm.focus(); else first.dataset.focus = "1";
    } else first.focus();
  }
  /*
   * The cursor in the first field as soon as it can be: the panel cannot take
   * focus while it is still hidden for its arrival, so this tries until it
   * holds (as the launcher's box does) — Super+Shift+N, then type.
   */
  function focusSoon() {
    let tries = 0;
    const go = () => {
      if (!surface.up) return;
      focusFirst();
      const first = $("rows").querySelector("input.field, .ed");
      const held = first && (first === document.activeElement || first.contains(document.activeElement));
      if (!held && ++tries < 40) setTimeout(go, 40);
    };
    setTimeout(go, 0);
  }
  const titleKeyOf = (k) => (k === "event" ? "title" : typeFor(k) ? readType(typeFor(k)).titleKey : "title");
  function choose(k) {
    if (k === kind) return;
    readEditors();
    // The words carry over — a task that turns out to be an event keeps its title,
    // without its links where the title cannot hold them.
    const was = v[titleKeyOf(kind)];
    const takesAt = k !== "event" && typeFor(k) && readType(typeFor(k)).titleTakesAt;
    kind = k;
    store.set("talaris.new.kind", k);
    v = { [titleKeyOf(k)]: takesAt ? was : plain(was) };
    paintKinds();
    paint();
    say("");
    setTimeout(focusFirst, 0);
  }
  function reset() {
    v = {};
    busy = false;
    say("");
    paintKinds();
    paint();
    focusSoon();
    // What the forms are made from, fresh each time it opens: the types (and
    // the projects, mirrored as entities when asked for), the calendars.
    Promise.all([api("GET", "/entity-types"), api("GET", "/tasks/projects").catch(() => [])])
      .then(([t]) => { types = t || []; if (kind !== "event") { paint(); focusSoon(); } }).catch((e) => say(e.message, true));
    api("GET", "/projects").then((ps) => { projectList = ps || []; if (kind === "note") paint(); }).catch(() => {});
    if (bridge) bridge.calendars((text) => { try { calendars = JSON.parse(text) || []; } catch { calendars = []; } if (kind === "event") paint(); });
  }

  // ---------------------------------------------------------------- making

  // A mention's words, for a title that must be plain (an event's, which a calendar shows as it is).
  const plain = (s) => (s || "").replace(/\[([^\]\n]*)\]\(talaris:[A-Za-z0-9_-]+\)/g, "$1").replace(/^@/, "").trim();
  const localAt = (d, m) => `${isoDay(d)}T${pad(Math.floor(m / 60))}:${pad(m % 60)}`;

  /** The type's fields as properties, from what was entered; what cannot be read says so. */
  function properties(t, info) {
    const out = {};
    for (const f of t.fields) {
      if (f["talaris:auto"] || f.kind === "attachment") continue;
      const k = f.key;
      switch (f.kind) {
        case "text": {
          if (f.many) {
            const list = (Array.isArray(v[k]) ? v[k] : []).map((x) => String(x).trim()).filter(Boolean);
            if (list.length) out[k] = list;
            break;
          }
          const s = String(v[k] || "").trim();
          if (!s) break;
          out[k] = s;
          break;
        }
        case "richtext": if (String(v[k] || "").trim()) out[k] = v[k]; break;
        case "number": if (String(v[k] ?? "").trim()) { const n = Number(v[k]); if (Number.isNaN(n)) throw new Error(`${words(k)} isn't a number`); out[k] = n; } break;
        case "boolean": if (v[k]) out[k] = true; break;
        case "enum": if (v[k]) out[k] = v[k]; break;
        case "date": case "datetime": {
          if (!String(v[k + "Text"] || "").trim()) break;
          if (!v[k]) throw new Error(`${labelOf(f)}: that isn't a day I can read`);
          out[k] = f.kind === "date" || v[k + "At"] == null ? isoDay(v[k]) : localAt(v[k], v[k + "At"]);
          break;
        }
        case "datespan": {
          const span = {};
          for (const [part, key] of [["start", k + "Start"], ["end", k + "End"]]) {
            if (!String(v[key + "Text"] || "").trim()) continue;
            if (!v[key]) throw new Error(`${(part === "start" ? f.startLabel : f.endLabel) || part}: that isn't a day I can read`);
            span[part] = isoDay(v[key]);
          }
          if (Object.keys(span).length) out[k] = span;
          break;
        }
        case "reference": {
          const ids = (v[k] || []).map((x) => x.id).filter(Boolean);
          if (ids.length) out[k] = f.many ? ids : ids[0];
          break;
        }
        default: break;
      }
    }
    // A title is a title's words, with any link kept where the type takes them.
    const title = String(v[info.titleKey] || "").trim();
    if (title) out[info.titleKey] = info.titleTakesAt ? title : plain(title);
    return out;
  }

  /** People chosen from an address book are made now, so a reference can point at them. */
  async function madeReferences() {
    for (const [k, list] of Object.entries(v)) {
      if (!Array.isArray(list)) continue;
      for (const x of list) if (x && !x.id && x.make) Object.assign(x, await x.make());
    }
  }

  async function makeTyped(t, andOpen) {
    const info = readType(t);
    const required = t.fields.filter((f) => f.required && f.key === info.titleKey);
    const email = firstEmail(info);
    if (required.length && !plain(v[info.titleKey]) && !email) throw new Error(`${KINDS.find(([k]) => k === kind)[1]} needs a ${kind === "contact" ? "name" : kind === "project" ? "name" : "title"}`);
    await madeReferences();
    const props = properties(t, info);
    if (info.task && v.repeat && info.span) {
      // Repeating needs a date to repeat from: today, if none was given.
      const span = props[info.span] || {};
      if (!span.end && !span.start) props[info.span] = { ...span, end: isoDay(new Date()) };
    }
    let made;
    if (t["talaris:role"] === "project") {
      // A project is a folder first (a Talaris project); its entity follows, and takes the rest.
      const p = await api("POST", "/projects", { name: plain(v[info.titleKey]) });
      const listed = await api("GET", "/tasks/projects");
      made = (listed || []).find((x) => x.workspace === p.id);
      const rest = { ...props };
      delete rest[info.titleKey];
      if (made && Object.keys(rest).length) await api("PATCH", `/entities/${enc(made.id)}`, { properties: rest });
      const kept = await keepInProject(p.id, "projectFiles");
      if (kept.error) { busy = false; say(`Project made, but: ${kept.error}`, true); return; }
    } else if (email) {
      // Somebody by address: the one already here, added to, or made.
      const known = (await api("POST", "/entities/people/known", { emails: [email] }))[email];
      if (known) {
        const rest = { ...props };
        if (!plain(v[info.titleKey])) delete rest[info.titleKey];
        made = await api("PATCH", `/entities/${enc(known.id)}`, { properties: rest });
      } else made = await api("POST", "/entities", { type: t.id, properties: props });
    } else {
      made = await api("POST", "/entities", { type: t.id, properties: props });
    }
    if (made && info.task && v.repeat) {
      const span = props[info.span] || {};
      const day = parseDay(span.end || span.start) || new Date();
      await api("PUT", `/tasks/${enc(made.id)}/recurrence`, { rule: taskRule(day) });
    }
    // Files last: they are the thing's once it is.
    if (made) {
      const errors = [];
      for (const f of t.fields.filter((x) => x.kind === "attachment")) {
        const files = v[f.key] || [];
        if (!files.length) continue;
        say("Keeping the files…");
        const r = await new Promise((ok) => { sentWait = ok; bridge.sendFiles(made.id, f.key, JSON.stringify(files.map((x) => x.path))); });
        if (r.error) errors.push(r.error);
      }
      if (errors.length) { busy = false; say(`Made, but: ${errors.join("; ")}`, true); return; }
    }
    const word = KINDS.find(([k]) => k === kind)[1];
    done(`${word} made`, andOpen && info.task && made ? () => bridge.openThing("task", made.id) : null);
  }

  async function make_(andOpen) {
    if (busy) return;
    readEditors();
    try {
      busy = true;
      say("Making…");
      if (kind === "event") {
        const title = plain(v.title);
        if (!title) throw new Error("An event needs a title");
        if (!v.day) throw new Error("That day isn't one I can read");
        if (!v.calendar) throw new Error("There is no calendar to write to");
        const cal = calendars.find((c) => c.id === v.calendar);
        const start = new Date(v.day.getTime() + (v.allDay ? 0 : v.from * 60000));
        let end = v.allDay ? addDays(v.day, 1) : new Date(v.day.getTime() + v.to * 60000);
        if (end <= start) end = new Date(start.getTime() + 3600000);
        const invites = Boolean(cal && cal.invites && v.people.length);
        const event = { title, allDay: Boolean(v.allDay), start: start.getTime(), end: end.getTime(), location: v.location || "", notes: v.notes || "",
          ...(v.repeat ? { rrule: eventRule(v.day) } : {}), ...(invites ? { attendees: v.people } : {}) };
        store.set("talaris.new.calendar", v.calendar);
        const r = await new Promise((ok, fail) => { eventWait = { ok, fail }; bridge.createEvent(v.calendar, JSON.stringify(event)); });
        if ((v.files || []).length && r.uid) {
          // Its entity now, as the calendar's mirror would make it later (calendar_panel.py), so the files have it to go with.
          const local = (d) => `${isoDay(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
          const m = await api("POST", "/entities/mirror/events", { events: [{
            source: { kind: "eds-event", key: `${v.calendar}/${r.uid}` }, also: [{ kind: "ical-uid", key: r.uid }],
            title, start: local(start), end: local(end), allDay: Boolean(v.allDay), location: v.location || "",
            ...(invites ? { attendees: v.people } : {}),
          }] });
          const id = (m.ids || [])[0];
          if (id) {
            say("Keeping the files…");
            const sent = await new Promise((ok) => { sentWait = ok; bridge.sendFiles(id, "files", JSON.stringify(v.files.map((x) => x.path))); });
            if (sent.error) { busy = false; say(`Event made, but: ${sent.error}`, true); return; }
          }
        }
        done(invites ? "Event made, invitations sent" : "Event made", andOpen ? () => bridge.openThing("event", "") : null);
        return;
      }
      if (kind === "note") {
        const title = plain(v.title) || plain((v.body || "").split("\n")[0]).slice(0, 80);
        // Nameless, the core names it for when it was made.
        if (!v.project) throw new Error("Choose a project for it");
        const kept = await keepInProject(v.project, "noteFiles");
        const body = [String(v.body || "").trimEnd(), kept.files.map(linkOf).join(" ")].filter(Boolean).join("\n\n");
        const page = await api("POST", `/projects/${enc(v.project)}/pages`, { parent: null, title });
        if (body.trim()) await api("PUT", `/projects/${enc(v.project)}/page?path=${enc(page.path)}`, body);
        if (kept.error) { busy = false; say(`Page made, but: ${kept.error}`, true); return; }
        const where = (projectList.find((x) => x.id === v.project) || {}).name;
        done(`Page made${where && v.project !== surface.project ? ` in ${where}` : ""}`, andOpen ? () => bridge.openThing("page", `${v.project}/${page.path}`) : null);
        return;
      }
      const t = typeFor(kind);
      if (!t) throw new Error("There is no type for this");
      await makeTyped(t, andOpen);
    } catch (e) {
      busy = false;
      say(e.message, true);
    }
  }
  /** Chosen files kept in a project: their links, or why not. */
  async function keepInProject(project, key) {
    const files = v[key] || [];
    if (!files.length) return { files: [], error: "" };
    say("Keeping the files…");
    return new Promise((ok) => { sentWait = ok; bridge.sendProjectFiles(project, JSON.stringify(files.map((x) => x.path))); });
  }
  const linkOf = (f) => `[${f.name.replace(/[\[\]]/g, "")}](talaris-file:${encodeURI(f.path).replace(/\(/g, "%28").replace(/\)/g, "%29")})`;
  let eventWait = null;
  let sentWait = null;
  function done(text, then) {
    say(text);
    // A moment to read that it was made, then away — or to where it lives.
    setTimeout(() => {
      busy = false;
      if (then) then();
      else if (bridge) bridge.file();
    }, then ? 150 : 650);
  }
  $("make").addEventListener("click", () => make_(false));

  // ---------------------------------------------------------------- keys

  document.addEventListener("keydown", (e) => {
    if (e.ctrlKey && !e.shiftKey && !e.altKey && /^[1-5]$/.test(e.key)) {
      e.preventDefault(); e.stopPropagation();
      choose(KINDS[Number(e.key) - 1][0]);
      return;
    }
    if (e.key === "Enter" && (e.shiftKey || e.ctrlKey)) {
      // Shift+Enter makes and opens; Ctrl+Enter makes, from anywhere — the note's body included.
      if (document.querySelector(".cm-tooltip-autocomplete")) return;
      e.preventDefault(); e.stopPropagation();
      make_(e.shiftKey);
      return;
    }
  }, true);
  document.addEventListener("keydown", (e) => {
    if (e.defaultPrevented) return;
    if (e.key === "Escape") {
      e.preventDefault();
      if (!!Kit.isOpen()) popAway();
      else if (bridge) bridge.file();
      return;
    }
    if (e.key === "Enter" && e.target.tagName === "INPUT") {
      e.preventDefault();
      popAway();
      make_(false);
    }
  });
  document.addEventListener("pointerdown", (e) => { if (e.target === document.documentElement && bridge && surface.up) bridge.file(); });
  window.pressedAt = (x, y) => { if (bridge && surface.up && document.elementFromPoint(x, y) === document.documentElement) bridge.file(); };
  for (const t of ["pointerdown", "keydown"]) addEventListener(t, () => bridge && bridge.activity(), { capture: true, passive: true });

  // ---------------------------------------------------------------- coming and going

  function how() {
    const m = surface.motion || {};
    return { kind: m.motion, speed: m.speed, edge: "top", flush: false, viewport: surface.viewport,
      shown: () => { if (bridge) bridge.drawn(); focusSoon(); } };
  }
  function onState(s) {
    const was = surface;
    surface = s;
    if (s.up && !was.up) {
      Motion.arrive(document.body, how());
      if (bridge) reset();
    }
  }

  Surface.connect({ onState }).then((b) => {
    bridge = b;
    b.coreReply.connect((text) => asked.reply(JSON.parse(text)));
    b.eventMade.connect((text) => {
      const r = JSON.parse(text);
      const w = eventWait;
      eventWait = null;
      if (!w) return;
      if (r.error) w.fail(new Error(r.error)); else w.ok(r);
    });
    // Files chosen for a field: kept on the page until the thing is made.
    b.chosen.connect((text) => {
      const r = JSON.parse(text);
      if (!r.files.length) return;
      const list = v[r.field] = v[r.field] || [];
      for (const f of r.files) if (!list.some((x) => x.path === f.path)) list.push(f);
      paint();
    });
    b.sent.connect((text) => { const w = sentWait; sentWait = null; if (w) w(JSON.parse(text)); });
    b.leave.connect(() => {
      surface = { ...surface, up: false };
      popAway();
      Peek.close();
      const going = Motion.leave(document.body, how());
      if (going) going.onfinish = () => bridge.left(); else bridge.left();
    });
    if (surface.up) reset();
  });
})();
