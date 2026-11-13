// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore
//
// A task's card (thingcard.js): its status, dates, repeat, projects, tags, files
// and notes, edited where it is shown, in Tasks and in the Library alike. Every
// change is the core's to carry out: completing a task stamps its time and brings
// the next of a series there, not here. Its fields are found by what they are,
// through the task profile (`shape`), never by a name.

"use strict";

window.TaskCard = (() => {
  const enc = encodeURIComponent;
  function el(tag, attrs = {}, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
      else if (k === "class") e.className = v;
      else if (k === "value") e.value = v;
      else e.setAttribute(k, v);
    }
    for (const k of kids.flat()) if (k != null && k !== "" && k !== false) e.append(k);
    return e;
  }
  function seg(host, choices, current, pick) {
    host.replaceChildren(...choices.map(([value, label]) =>
      el("button", { class: value === current ? "on" : "", onclick: (e) => { e.stopPropagation(); pick(value); } }, label)));
  }
  function xBtn(title, act) {
    const b = el("button", { class: "x-btn", title, onclick: (e) => { e.stopPropagation(); act(e); } });
    b.innerHTML = Icons.close();
    return b;
  }
  const humanize = (v) => String(v || "").replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());

  // ---------------------------------------------------------------- dates

  // A task's dates are wall-clock: "YYYY-MM-DD" or "YYYY-MM-DDTHH:MM", no zone.
  const pad = (n) => String(n).padStart(2, "0");
  function startOfDay(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
  function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
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

  // ---------------------------------------------------------------- what the card needs beyond the task

  /** Asked when it is drawn: how a task is one, whether it repeats, its project's folder, and the projects there are. */
  async function ask(id, api) {
    const [t, rec, f, projects] = await Promise.all([api("GET", "/tasks/types"),
      api("GET", `/tasks/${enc(id)}/recurrence`).catch(() => ({ rule: null, summary: "" })),
      api("GET", `/entities/${enc(id)}/folder`).catch(() => ({ folder: "" })),
      api("GET", "/tasks/projects").catch(() => [])]);
    return { type: t.type, shape: t.shape, rec: rec || { rule: null, summary: "" }, folder: (f && f.folder) || "", project: (f && f.project) || "", projects: projects || [] };
  }

  // What was said of files just chosen, for the card drawn next: under its files, and a move offered then and there.
  let note = null;
  const filesSaid = (text, error, offer) => { note = { text, error, offer }; };

  // ---------------------------------------------------------------- the card

  function parts(got, info, ctx, connected) {
    const { api, say, failed, bridge } = ctx;
    const { type, shape, rec, folder: taskFolder, project: taskProject, projects } = info;
    const id = got.entity.id;
    const entity = () => got.entity;
    const props = () => got.entity.properties || {};
    const field = (key) => (type ? type.fields.find((f) => f.key === key) : null) || null;
    const statusField = () => (shape ? field(shape.statusKey) : null);
    const options = () => (statusField() || {}).options || [];
    const completeValues = () => (shape ? shape.complete : []);
    const openValues = () => options().filter((o) => !completeValues().includes(o));
    const doneValue = () => completeValues().find((v) => options().includes(v)) || completeValues()[0];
    const reopenValue = () => (shape && shape.defaultStatus) || openValues()[0];
    const notesKey = () => ((type && type.fields.find((f) => f.kind === "richtext")) || { key: "description" }).key;
    const projectKey = () => ((type && type.fields.find((f) => f.kind === "reference" && f.many)) || { key: "project" }).key;
    const status = (value) => {
      const f = statusField() || {};
      return { label: (f["talaris:labels"] || {})[value] || humanize(value), color: (f["talaris:colors"] || {})[value] || "var(--muted)" };
    };
    const spanNow = () => (shape && shape.spanKey ? props()[shape.spanKey] : null) || {};
    const popAway = () => Kit.popAway();
    const menuAt = (x, y, items) => Kit.menu({ x, y }, items);
    // A row of chips wraps onto more lines: its label stays at the top, by the first.
    const row = (label, kids, top = false) => el("div", { class: "s-row" + (top || (kids && kids.classList && kids.classList.contains("chips")) ? " top" : "") }, el("span", { class: "lab" }, label), kids);

    /** A change, kept. `quiet`: what is being typed in stays as it is; anything else, the card drawn again with it. */
    async function update(patch, quiet = false) {
      try {
        const out = await api("PATCH", `/entities/${enc(id)}`, patch);
        say("");
        if (out && out.id) got.entity = out;
        if (ctx.changed) await ctx.changed(out);
        if (!quiet) ctx.redraw();
      } catch (e) { failed(e); }
    }
    const after = () => { if (ctx.changed) ctx.changed(); ctx.redraw(); };
    const setStatus = (value) => update({ properties: { [shape.statusKey]: value } });

    // ---- its title and status

    const value = String(props()[shape.statusKey] ?? "");
    const complete = completeValues().includes(value);
    const check = el("button", { class: "check" + (complete ? " on" : ""), style: `--c:${complete ? status(value).color : "var(--muted)"}`, title: status(value).label,
      onclick: () => setStatus(complete ? reopenValue() : doneValue()) }, "✓");
    const titleHost = el("div", { class: "t-title ed-field" });
    const notesHost = el("div", { class: "t-notes ed-field", "data-placeholder": "Notes" });
    const open = (x) => (ctx.openMention ? ctx.openMention(x) : ctx.open(`e:${x}`));
    const mentionOpts = { project: () => "", openPlace: (p) => ctx.open(`${p.kind}:${p.project}/${p.where}`) };
    ThingCard.withEditor(titleHost, (m) => {
      const mentions = TalarisMentions(api, open, mentionOpts);
      const onOpenUrl = (u) => bridge && bridge.openUrl(u);
      const save = () => {
        const v = ed.text.trim();
        if (v && v !== (props()[shape.titleKey] || "")) update({ properties: { [shape.titleKey]: v } }, true);
        else if (!v) ed.set(props()[shape.titleKey] || "");
      };
      const ed = m.createEditor(titleHost, props()[shape.titleKey] || "", { live: true, compact: true, singleLine: true, mentions, onOpenUrl, onEnter: () => { save(); titleHost.querySelector(".cm-content")?.blur(); } });
      titleHost.addEventListener("focusout", save);
      ThingCard.keepEditor(ed);
      const notes = m.createEditor(notesHost, props()[notesKey()] || "", { live: true, compact: true, mentions, onOpenUrl });
      notesHost.addEventListener("focusout", () => {
        const v = notes.text;
        if (v !== (props()[notesKey()] || "")) update({ properties: { [notesKey()]: v || null } }, true);
      });
      ThingCard.keepEditor(notes);
    });
    const head = el("div", { class: "t-head" }, check, titleHost, ctx.close ? (() => {
      const b = el("button", { class: "icon-btn", title: "Close", onclick: ctx.close });
      b.innerHTML = Icons.close();
      return b;
    })() : null);

    // Two statuses, one open and one done, say no more than the checkbox
    // beside the title does: the row shows only when there is more to choose.
    const statusRow = options().length > 2 ? row("Status", el("div", { class: "chips" }, options().map((v) => el("button", { class: "tv-status" + (v === value ? " on" : ""), style: `--c:${status(v).color}`,
      onclick: () => setStatus(v) }, el("span", { class: "tv-dot" }), status(v).label))), true) : null;

    // ---- its dates: the whole datespan sent each time, null when nothing is left of it

    const setPart = (part, v) => {
      const next = { ...spanNow() };
      if (v) next[part] = v; else delete next[part];
      return update({ properties: { [shape.spanKey]: next.start || next.end ? next : null } });
    };
    function dateRow(part, label) {
      const { day, time } = split(spanNow()[part]);
      const pick = el("button", { class: "pick" + (day ? "" : " empty") + (part === "end" && !complete && day && (time == null ? isoDay(day) < isoDay(new Date()) : new Date(day.getTime() + time * 60000) < new Date()) ? " overdue" : ""),
        onclick: (ev) => {
          ev.stopPropagation();
          if (Kit.openedBy() === pick) { popAway(); return; }
          // The month, and the quick days every picker has (kit.js), counted from the day set; Clear takes it off.
          Kit.pop(pick, Kit.monthPicker(day, (d) => setPart(part, d ? join(d, time) : null), { chips: Kit.DAY_CHIPS(day), clear: true }));
        } }, el("span", { class: "lbl" }, day ? shortDate(isoDay(day)) : "None"));
      // A time is optional: typed, or chosen from the list; emptied, the date stays.
      const tin = el("input", { type: "text", class: "time-in", placeholder: "Time", spellcheck: "false", value: time != null ? timeLabel(time) : "" });
      const setTime = (m) => setPart(part, join(day || startOfDay(new Date()), m));
      tin.addEventListener("focus", () => Kit.pop(tin, Kit.timeList(time, (m) => { tin.blur(); setTime(m); })));
      tin.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); tin.blur(); } });
      tin.addEventListener("change", () => {
        const text = tin.value.trim();
        if (!text) { if (day && time != null) setPart(part, join(day, null)); return; }
        const m = Kit.parseTime(text);
        if (m == null) { tin.value = time != null ? timeLabel(time) : ""; return; }
        setTime(m);
      });
      return row(label, [pick, tin]);
    }
    const sf = shape.spanKey ? field(shape.spanKey) : null;
    const dates = shape.spanKey ? [dateRow("start", (sf && sf.startLabel) || "Available"), dateRow("end", (sf && sf.endLabel) || "Due")] : [];

    // ---- Repeat: the format's rule, {anchor, freq, interval, byWeekday?, monthEnd?, end}. Begun from the rule
    // there is, so anything this does not show (a day of the month) is kept as it was.

    const DAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
    const UNITS = { daily: ["day", "days"], weekly: ["week", "weeks"], monthly: ["month", "months"], yearly: ["year", "years"] };
    const dayOfTask = () => split(spanNow().end || spanNow().start).day || startOfDay(new Date());
    let rep = null;
    const repHost = el("div", { class: "t-rep", hidden: "" });
    const closeRep = () => { rep = null; repHost.hidden = true; repHost.replaceChildren(); };
    function openRep() {
      rep = rec.rule ? JSON.parse(JSON.stringify(rec.rule)) : { anchor: "schedule", freq: "weekly", interval: 1, end: { type: "never" } };
      if (!rep.end) rep.end = { type: "never" };
      const anchor = el("span", { class: "seg" }), freq = el("span", { class: "seg" }), days = el("span", { class: "seg" }), short = el("span", { class: "seg" }), end = el("span", { class: "seg" });
      const n = el("input", { type: "text", class: "r-n", spellcheck: "false", value: String(rep.interval || 1), oninput: () => paint() });
      const count = el("input", { type: "text", class: "r-n", spellcheck: "false", onchange: () => { const c = parseInt(count.value, 10); if (rep && c > 0) rep.end = { type: "after", count: c }; paint(); } });
      const until = el("button", { class: "pick", onclick: (ev) => {
        ev.stopPropagation();
        if (Kit.openedBy() === until) { popAway(); return; }
        Kit.pop(until, Kit.monthPicker(split(rep.end.date).day, (d) => { rep.end = { type: "on", date: isoDay(d) }; paint(); }));
      } });
      const daysRow = row("On", days), shortRow = row("Short month", short);
      const err = el("div", { class: "r-err" });
      // The core says why a rule will not do (a weekday counted from completion, say); that is shown as it is said.
      const putRule = async (rule) => {
        try {
          await api("PUT", `/tasks/${enc(id)}/recurrence`, { rule });
          closeRep();
          after();
        } catch (e) { err.textContent = e.message; }
      };
      const paint = () => {
        if (!rep) return;
        const k = parseInt(n.value, 10) || 1;
        seg(anchor, [["schedule", "Scheduled date"], ["completion", "Completion"]], rep.anchor, (v) => { rep.anchor = v; paint(); });
        seg(freq, Object.entries(UNITS).map(([f, w]) => [f, w[k === 1 ? 0 : 1]]), rep.freq, (v) => { rep.freq = v; paint(); });
        daysRow.hidden = !(rep.freq === "weekly" && rep.anchor === "schedule");
        const on = rep.byWeekday && rep.byWeekday.length ? rep.byWeekday : [DAYS[dayOfTask().getDay()]];
        days.replaceChildren(...DAYS.map((d, i) => el("button", { class: on.includes(d) ? "on" : "", onclick: (e) => {
          e.stopPropagation();
          const now = new Set(on);
          if (now.has(d) && now.size > 1) now.delete(d); else now.add(d);
          rep.byWeekday = DAYS.filter((x) => now.has(x));
          paint();
        } }, "SMTWTFS"[i])));
        shortRow.hidden = !["monthly", "yearly"].includes(rep.freq);
        seg(short, [["clamp", "Last day"], ["skip", "Skip"]], rep.monthEnd || "clamp", (v) => { rep.monthEnd = v; paint(); });
        seg(end, [["never", "Never"], ["after", "After"], ["on", "On"]], rep.end.type, (v) => {
          rep.end = v === "after" ? { type: "after", count: rep.end.count || 10 } : v === "on" ? { type: "on", date: rep.end.date || isoDay(addDays(dayOfTask(), 90)) } : { type: "never" };
          paint();
        });
        count.hidden = rep.end.type !== "after";
        if (document.activeElement !== count) count.value = String(rep.end.count || 10);
        until.hidden = rep.end.type !== "on";
        until.replaceChildren(el("span", { class: "lbl" }, rep.end.type === "on" ? shortDate(rep.end.date) : ""));
      };
      repHost.hidden = false;
      repHost.replaceChildren(row("From", anchor), row("Every", [n, freq]), daysRow, shortRow, row("Ends", [end, count, until]), err,
        el("div", { class: "acts" }, el("button", { class: "t-btn", onclick: () => putRule(null) }, "Don't repeat"), el("span", { class: "spacer" }),
          el("button", { class: "t-btn r-cancel", onclick: closeRep }, "Cancel"),
          el("button", { class: "t-btn primary", onclick: () => {
            if (!rep) return;
            const rule = { ...rep, interval: Math.max(1, parseInt(n.value, 10) || 1) };
            if (rule.freq === "weekly" && rule.anchor === "schedule") {
              if (!rule.byWeekday || !rule.byWeekday.length) rule.byWeekday = [DAYS[dayOfTask().getDay()]];
            } else delete rule.byWeekday;
            if (["monthly", "yearly"].includes(rule.freq)) rule.monthEnd = rule.monthEnd || "clamp";
            else delete rule.monthEnd;
            if (rule.end.type === "after") rule.end = { type: "after", count: Math.max(1, parseInt(count.value, 10) || rule.end.count || 1) };
            putRule(rule);
          } }, "Save")));
      paint();
    }
    const repRow = row("Repeat", [el("span", { class: "sum" + (rec.summary ? "" : " none") }, rec.summary || "Never"),
      el("button", { class: "t-btn", onclick: () => { if (rep) closeRep(); else openRep(); } }, "Repeat…")]);

    // ---- its projects: a small search over the ones there are

    const pk = projectKey();
    const p0 = props()[pk];
    const mine = Array.isArray(p0) ? p0 : p0 ? [p0] : [];
    const setProjects = (ids) => update({ properties: { [pk]: ids.length ? ids : null } });
    function pickProject(anchor) {
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
      Kit.pop(anchor, el("div", {}, find, list));
      setTimeout(() => find.focus(), 0);
    }
    const titleOfProject = (x) => (projects.find((p) => p.id === x) || {}).title || "Unknown";
    const projRow = field(pk) ? row("Projects", el("div", { class: "chips" },
      mine.map((x) => el("span", { class: "chip" }, el("span", { class: "lbl to-card", title: "Open its card", onclick: (e) => { e.stopPropagation(); ctx.open(`e:${x}`); } }, titleOfProject(x)),
        xBtn("Remove", () => setProjects(mine.filter((y) => y !== x))))),
      el("button", { class: "add", title: "Add to a project", onclick: (e) => pickProject(e.currentTarget) }, "+")), true) : null;

    // ---- its tags: typed, Enter or a comma; Backspace in an empty field takes the last

    const tags = entity().tags || [];
    const tagIn = el("input", { type: "text", class: "t-tag-in", placeholder: "Add", spellcheck: "false", onkeydown: (e) => {
      if (e.key === "Enter" || e.key === ",") {
        e.preventDefault();
        const t = tagIn.value.trim().replace(/^#/, "").replace(/,$/, "");
        tagIn.value = "";
        if (t && !tags.includes(t)) update({ tags: [...tags, t] });
      }
      if (e.key === "Backspace" && !tagIn.value && tags.length) update({ tags: tags.slice(0, -1) });
    } });
    const tagRow = row("Tags", el("div", { class: "chips" }, tags.map((t) => el("span", { class: "chip" }, el("span", { class: "lbl" }, `#${t}`),
      xBtn("Remove", () => update({ tags: tags.filter((x) => x !== t) })))), tagIn), true);

    /*
     * Its files: a copy kept with it (attached), or a file linked where it is
     * (↗; links.ts) — opened in its application either way, the link's being
     * the file itself. A right-click turns one into the other: a link made a
     * copy, or a copy saved into the project's Files and linked. × takes it off
     * the task; a linked file stays where it is.
     */
    const fk = (type.fields.find((f) => f.kind === "attachment" && f.many) || {}).key;
    let filesRow = null;
    if (fk) {
      const files = Array.isArray(props()[fk]) ? props()[fk] : [];
      const noteEl = el("span", { class: "t-files-note" });
      const filesNote = (text, error = false, ...more) => { noteEl.replaceChildren(text, ...more); noteEl.classList.toggle("err", Boolean(error)); };
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
      const offerMove = () => {
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
      filesRow = row("Files", el("div", { class: "chips t-files" },
        files.map((a) => {
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
        // Attach (attach.js): a file of this project's, linked where it is; one from another project moved here or a
        // shortcut made; one from outside linked where it is, with a move into this project's folder offered then.
        el("button", { class: "add", title: "Attach a file", onclick: (e) => {
          filesNote("");
          if (!window.Attach || !taskProject) { ctx.linkTask(id); return; }
          Attach.open(e.currentTarget, {
            api,
            project: taskProject,
            pick: (file) => (file.abs
              ? api("POST", `/entities/${enc(id)}/links`, { path: file.abs }).then(after).catch(failed)
              : failed(new Error(`${file.name} has no place on disk to link`))),
            outside: () => ctx.linkTask(id),
          });
        } }, "+"),
        noteEl), true);
      // What was said of the files just chosen; linked from another folder, a move into this project's offered then and there.
      if (note) {
        filesNote(note.text || "", note.error);
        if (note.offer && !note.error) offerMove();
        note = null;
      }
    }

    // ---- its foot

    const stamp = split(props()[shape.doneKey]);
    const glance = ctx.glance || (bridge && bridge.glanceAt ? (k) => bridge.glanceAt(k) : null);
    // Where else it lives (a sync's way back), beside its own buttons; what plugins put on a task (Sync now), the task
    // read again when one is done, so what changed shows.
    const foot = el("div", { class: "s-foot" },
      el("span", { class: "t-done" }, stamp.day ? `Done ${Kit.day(stamp.day, { weekday: false })}${stamp.time != null ? ` · ${timeLabel(stamp.time)}` : ""}` : ""),
      el("span", { class: "spacer" }),
      window.Peek ? [...Peek.elsewhereButtons(entity(), (u) => bridge && bridge.openUrl(u)), Peek.actionButtons("task", id, api, "t-btn", () => ctx.redraw()), Peek.glanceButton(`e:${id}`, glance)].filter(Boolean) : [],
      el("button", { class: "t-btn", onclick: () => update({ archived: !entity().archived }) }, entity().archived ? "Unarchive" : "Archive"));

    // Its own buttons with what they act on; what it is connected to, and might be, after them.
    return [el("div", { class: "t-card" }, head, statusRow, dates, repRow, repHost, projRow, tagRow, filesRow, notesHost, foot, connected(got, ctx, new Set(mine)))];
  }

  return { ask, parts, filesSaid };
})();
