// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore
//
// An event's card (thingcard.js): as Calendar shows it and as the Library does.
// An event is the calendar's, or the plugin's that brought it, so nothing here is
// saved as it is changed, as a person's or a task's field is: Save sends it all at
// once, by whichever road it came (invitations and repeats go with it). What Talaris
// alone holds of it, its projects, is kept as they are chosen.
//
// No browser pickers here — a <select>, a date or a time field opens a window
// of the engine's own, which a layer surface cannot hold — so the calendar,
// the dates and the times are chosen from small lists drawn in the page.
//
// Asked of the page, beside what the card asks of any:
//   calendars()          every calendar there is
//   send(msg)            to the calendar's process; answered with what it did, or refused with why
//   saved()              it changed: for what the page shows beside it
//   gone()               it is gone: for what was showing it

"use strict";

window.EventCard = (() => {
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
  const DAY_MS = 86400000, MIN = 60000;
  const pad = (n) => String(n).padStart(2, "0");
  function startOfDay(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
  function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
  function sameDay(a, b) { return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate(); }
  const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  /** Talaris's own calendar (the core's own-calendar.ts), where an event is an entity rather than an account's. */
  const OWN_CALENDAR = "talaris";
  const dayLabel = (d) => Kit.day(d);
  const timeLabel = (m) => Kit.minutes(m);

  // ---- repeating: the few rules people make, read from and written to RRULE.
  // One this editor cannot say (an interval of 3, the second Tuesday) is kept as
  // it is unless changed here.
  const DAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
  function parseRule(text) {
    const r = { freq: "", days: [], ends: "never", until: null, count: 10, other: "", raw: text };
    if (!text) return r;
    const parts = Object.fromEntries(text.split(";").map((p) => p.split("=")));
    r.freq = (parts.FREQ || "").toLowerCase();
    r.days = (parts.BYDAY || "").split(",").filter((d) => DAYS.includes(d));
    if (parts.COUNT) { r.ends = "after"; r.count = Number(parts.COUNT); }
    if (parts.UNTIL) { r.ends = "on"; const u = parts.UNTIL; r.until = new Date(Number(u.slice(0, 4)), Number(u.slice(4, 6)) - 1, Number(u.slice(6, 8))); }
    r.other = Object.keys(parts).filter((k) => !["FREQ", "BYDAY", "COUNT", "UNTIL", "WKST"].includes(k)).join(",");
    return r;
  }
  function ruleText(r, start) {
    if (!r.freq) return "";
    if (r.other && r.raw && !r.changed) return r.raw;
    let t = `FREQ=${r.freq.toUpperCase()}`;
    if (r.freq === "weekly") t += `;BYDAY=${(r.days.length ? r.days : [DAYS[start.getDay()]]).join(",")}`;
    if (r.ends === "after") t += `;COUNT=${Math.max(1, Math.min(999, r.count || 1))}`;
    if (r.ends === "on" && r.until) { const u = r.until; t += `;UNTIL=${u.getFullYear()}${pad(u.getMonth() + 1)}${pad(u.getDate())}T235959Z`; }
    return t;
  }
  const ANSWER_WORD = { accepted: "going", declined: "not going", maybe: "maybe", waiting: "no answer yet", delegated: "delegated" };

  /** HTML (an invitation's) as Markdown: links, breaks, paragraphs, lists, bold and italic; parsed inert, never run. */
  function htmlToMarkdown(html) {
    const doc = new DOMParser().parseFromString(String(html), "text/html");
    const walk = (n) => {
      if (n.nodeType === 3) return n.textContent.replace(/\s+/g, " ");
      if (n.nodeType !== 1) return "";
      const tag = n.tagName.toLowerCase(), inner = [...n.childNodes].map(walk).join("");
      if (tag === "br") return "\n";
      if (tag === "a") { const href = n.getAttribute("href") || ""; const t = inner.trim(); return /^https?:/i.test(href) ? (t && t !== href ? `[${t}](${href})` : href) : t; }
      if (tag === "b" || tag === "strong") return inner.trim() ? `**${inner.trim()}**` : "";
      if (tag === "i" || tag === "em") return inner.trim() ? `_${inner.trim()}_` : "";
      if (tag === "li") return `\n- ${inner.trim()}`;
      if (["p", "div", "ul", "ol", "h1", "h2", "h3", "h4", "tr", "table"].includes(tag)) return `\n${inner}\n`;
      return inner;
    };
    return walk(doc.body).replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  }

  // ---------------------------------------------------------------- finding it from its entity

  /** The event as its calendar has it, for an entity: the occurrence nearest the one it holds; null if it cannot be had. */
  async function ask(got, ctx) {
    const o = got.entity, p = o.properties || {};
    const zone = p["talaris:timezone"];
    const at = Date.parse(Kit.fromClock(String(p.start || ""), zone));
    if (Number.isNaN(at)) return null;
    const from = at - 2 * DAY_MS, to = at + 2 * DAY_MS;
    const near = (list) => list.length ? list.reduce((a, b) => (Math.abs(b.start - at) < Math.abs(a.start - at) ? b : a)) : null;
    const on = (o["talaris:sources"] || []).find((s) => s.kind === "eds-event");
    try {
      if (!on) return near(((await ctx.api("GET", `/plugins/calendars/events?from=${from}&to=${to}`)) || []).filter((e) => e.entity === o.id));
      const cut = on.key.indexOf("/");
      const calendar = on.key.slice(0, cut), uid = on.key.slice(cut + 1);
      const got2 = await ctx.send({ do: "range", from, to });
      return near((got2.items || []).filter((e) => e.uid === uid && e.calendar === calendar));
    } catch { return null; }
  }

  // ---------------------------------------------------------------- the card

  /**
   * The card's elements, for an event as a calendar has it. Its `save()` (Enter, in a page that wants that) is on the
   * first of them. `got`: its entity, as /entities/:id?shown=1 answers, if it is known; `connected`: thingcard.js's.
   */
  function parts(e, isNew, ctx, connected, got = null) {
    const { api, say, failed, bridge } = ctx;
    const calendars = () => ctx.calendars();
    const calOf = (id) => calendars().find((c) => c.id === id) || {};
    const writable = calendars().filter((c) => c.writable && !c.hidden);
    const s = new Date(e.start);
    const end0 = new Date(e.allDay ? e.end - DAY_MS : e.end);
    const editing = { ...e, isNew, which: "this", projects: [] };
    const v = { calendar: e.calendar || (writable[0] || {}).id || "", allDay: !!e.allDay,
      sd: startOfDay(s), st: s.getHours() * 60 + s.getMinutes(), ed: startOfDay(end0), et: end0.getHours() * 60 + end0.getMinutes(),
      rule: parseRule(e.rrule || ""), people: (e.attendees || []).filter((a) => a.email !== (calOf(e.calendar).email || "")).map((a) => ({ ...a })) };
    editing.readOnly = !isNew && !e.entity && !calOf(e.calendar).writable;
    const popAway = () => Kit.popAway();
    const row = (label, ...kids) => el("div", { class: "row" }, el("span", {}, label), ...kids);
    const seg = (host, choices, current, pick) => host.replaceChildren(...choices.map(([value, label]) =>
      el("button", { class: value === current ? "on" : "", onclick: () => pick(value) }, label)));
    const dis = (x) => { if (editing.readOnly) x.setAttribute("disabled", ""); return x; };

    // ---- what it holds: the calendar, the days, the minutes after midnight

    const title = dis(el("input", { type: "text", class: "field ev-title", value: e.title || "", placeholder: "Title" }));
    const where = dis(el("input", { type: "text", class: "field", value: e.location || "" }));
    const calBtn = dis(el("button", { class: "pick", onclick: (ev) => {
      ev.stopPropagation();
      if (Kit.openedBy() === calBtn) { popAway(); return; }
      Kit.menu(calBtn, writable.map((c) => ({ label: `${c.name} · ${c.account}`, color: c.color || "var(--accent)", on: c.id === v.calendar, act: () => { v.calendar = c.id; paint(); } })));
    } }));
    if (!isNew) calBtn.setAttribute("disabled", "");
    const allDay = dis(el("button", { class: "switch", onclick: () => { v.allDay = !v.allDay; paint(); } }));
    const dayBtn = (key) => {
      const b = dis(el("button", { class: "pick", onclick: (ev) => {
        ev.stopPropagation();
        if (Kit.openedBy() === b) { popAway(); return; }
        Kit.pop(b, Kit.monthPicker(v[key], (d) => {
          // Moving the start moves the end with it, keeping the length.
          if (key === "sd") { const len = v.ed - v.sd; v.sd = d; v.ed = new Date(d.getTime() + Math.max(0, len)); }
          else v.ed = d < v.sd ? v.sd : d;
          paint();
        }));
      } }));
      return b;
    };
    const setTime = (key, m) => {
      if (key === "st") { const len = v.et - v.st; v.st = m; if (sameDay(v.sd, v.ed)) v.et = Math.min(24 * 60 - 1, m + Math.max(15, len)); }
      else v.et = m;
    };
    const timeIn = (key) => {
      const i = dis(el("input", { type: "text", class: "time-in", spellcheck: "false" }));
      i.addEventListener("focus", () => Kit.pop(i, Kit.timeList(v[key], (m) => { setTime(key, m); i.blur(); paint(); })));
      i.addEventListener("change", () => { const m = Kit.parseTime(i.value); if (m != null) setTime(key, m); paint(); });
      return i;
    };
    const sd = dayBtn("sd"), ed = dayBtn("ed"), st = timeIn("st"), et = timeIn("et");

    // ---- repeating

    const freq = el("span", { class: "seg" }), days = el("span", { class: "seg" }), ends = el("span", { class: "seg" });
    const until = el("button", { class: "pick", onclick: (ev) => {
      ev.stopPropagation();
      if (Kit.openedBy() === until) { popAway(); return; }
      Kit.pop(until, Kit.monthPicker(v.rule.until || v.sd, (d) => { v.rule.until = d; v.rule.changed = true; paintRepeats(); }));
    } });
    const count = el("input", { type: "text", class: "time-in", spellcheck: "false", onchange: () => { const n = parseInt(count.value, 10); if (n > 0) { v.rule.count = n; v.rule.changed = true; } paintRepeats(); } });
    const freqRow = row("Repeats", freq), daysRow = row("", days), endsRow = row("Ends", ends, until, count);
    function paintRepeats() {
      const r = v.rule;
      const changed = (f) => (x) => { f(x); r.changed = true; paintRepeats(); };
      seg(freq, [["", "Never"], ["daily", "Daily"], ["weekly", "Weekly"], ["monthly", "Monthly"], ["yearly", "Yearly"]], r.freq, changed((f) => { r.freq = f; }));
      daysRow.hidden = r.freq !== "weekly";
      const on = r.days.length ? r.days : [DAYS[v.sd.getDay()]];
      days.replaceChildren(...DAYS.map((d, i) => el("button", { class: on.includes(d) ? "on" : "", onclick: () => {
        const now = new Set(on); if (now.has(d) && now.size > 1) now.delete(d); else now.add(d);
        r.days = DAYS.filter((x) => now.has(x)); r.changed = true; paintRepeats();
      } }, "SMTWTFS"[i])));
      endsRow.hidden = !r.freq;
      seg(ends, [["never", "Never"], ["on", "On"], ["after", "After"]], r.ends, changed((x) => { r.ends = x; if (x === "on" && !r.until) r.until = addDays(v.sd, 30); }));
      until.hidden = r.ends !== "on";
      until.replaceChildren(el("span", { class: "lbl" }, r.until ? dayLabel(r.until) : ""));
      count.hidden = r.ends !== "after";
      if (document.activeElement !== count) count.value = `${r.count} times`;
      // One occurrence of a series is changed on its own: how it repeats is the series'.
      const one = !isNew && editing.recurring && editing.which === "this";
      for (const x of [freq, days, ends, until, count]) x.classList.toggle("off", one);
      freq.title = one ? "Choose Every one below to change how it repeats" : "";
    }
    if (e.entity) freqRow.hidden = true;

    // ---- who is invited: typed, with suggestions from the address books as you type

    const chips = el("span", { class: "ev-chips" });
    const who = el("input", { type: "text", placeholder: "Name or address", spellcheck: "false" });
    let peopleSeq = 0;
    const addPerson = (p) => {
      if (!v.people.some((x) => x.email === p.email)) v.people.push({ email: p.email, name: p.name || "" });
      who.value = ""; popAway(); paintPeople(); who.focus();
    };
    who.addEventListener("input", async () => {
      const q = who.value.trim();
      if (q.length < 2) { popAway(); return; }
      const seq = ++peopleSeq;
      const found = await api("GET", `/people/find?q=${enc(q)}`).catch(() => []);
      if (seq !== peopleSeq) return;
      const items = (found || []).filter((p) => p.email);
      if (!items.length) { popAway(); return; }
      Kit.pop(who, el("div", { class: "menu-list" }, ...items.map((p) =>
        el("button", { class: "menu-item", onclick: (ev) => { ev.stopPropagation(); addPerson(p); } }, p.name ? `${p.name} · ${p.email}` : p.email))));
    });
    who.addEventListener("keydown", (ev) => {
      const q = who.value.trim().replace(/[,;]$/, "");
      if ((ev.key === "Enter" || ev.key === "," || ev.key === ";") && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(q)) { ev.preventDefault(); ev.stopPropagation(); addPerson({ email: q.toLowerCase() }); }
      if (ev.key === "Backspace" && !who.value && v.people.length) { v.people.pop(); paintPeople(); }
    });
    const whoRow = row("Invite", el("div", { class: "who" }, chips, who));
    const whoWhy = el("small", {});
    const whoNote = el("div", { class: "row note-row" }, el("span", {}), whoWhy);
    const answer = el("span", { class: "seg" }), org = el("small", { class: "ev-org" });
    const answerRow = row("Going?", answer, org);
    const finish = () => { if (ctx.close) ctx.close(); else ctx.redraw(); };
    function paintPeople() {
      const cal = calOf(v.calendar);
      const mineOnly = !isNew && editing.attendees && editing.attendees.length && !editing.organizing;
      // Invited to it by someone else: the list is theirs; my part is my answer.
      whoRow.hidden = !cal.invites || mineOnly;
      whoNote.hidden = cal.invites || mineOnly || editing.readOnly || !!editing.entity;
      whoWhy.textContent = cal.invites ? "" : "This calendar cannot send invitations; choose an account's calendar to invite people.";
      chips.replaceChildren(...v.people.map((p, i) => {
        const x = el("button", { class: "x-btn", title: "Remove", onclick: (ev) => { ev.stopPropagation(); v.people.splice(i, 1); paintPeople(); } });
        x.innerHTML = Icons.close();
        return el("span", { class: "chip", title: p.email }, el("span", { class: "lbl" }, p.name || p.email),
          p.answer ? el("span", { class: "st" }, `· ${ANSWER_WORD[p.answer] || p.answer}`) : "", x);
      }));
      answerRow.hidden = !mineOnly || !editing.mine;
      if (mineOnly) {
        seg(answer, [["accepted", "Yes"], ["maybe", "Maybe"], ["declined", "No"]], editing.mine, (a) => {
          say("Saving…");
          ctx.send({ do: "respond", calendar: editing.calendar, uid: editing.uid, rid: editing.rid, which: editing.which, answer: a })
            .then(() => { say(""); editing.mine = a; if (ctx.saved) ctx.saved(); finish(); }, failed);
        });
        org.textContent = editing.organizer ? `from ${editing.organizer}` : "";
      }
    }

    // ---- this one, or every one

    const whichSeg = el("span", { class: "seg" });
    const which = (w) => { editing.which = w; seg(whichSeg, [["this", "This one"], ["all", "Every one"]], w, which); paintRepeats(); };
    const whichRow = row("Change", whichSeg);
    whichRow.hidden = isNew || !e.recurring;

    // ---- its projects: kept on the event's entity, never on its calendar, so a read-only calendar's event can have them
    // and an account never hears of them. A new event has no entity yet: held until the calendar has it.

    let projectChoices = [];
    const projects = el("span", { class: "ev-chips" });
    const paintProjects = () => {
      const names = new Map(projectChoices.map((p) => [p.id, p.title]));
      projects.replaceChildren(...editing.projects.map((id) => {
        const x = el("button", { class: "x-btn", title: "Remove", onclick: (ev) => { ev.stopPropagation(); setProjects(editing.projects.filter((p) => p !== id)); } });
        x.innerHTML = Icons.close();
        return el("span", { class: "chip" }, el("span", { class: "lbl to-card", title: "Open its card", onclick: (ev) => { ev.stopPropagation(); ctx.open(`e:${id}`); } }, names.get(id) || "Project"), x);
      }));
    };
    const local = (ms) => { const d = new Date(ms); return `${iso(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };
    /** The event's entity: the one it has, or made now, as the calendar's mirror would make it later (calendar_panel.py). */
    async function eventEntity(x) {
      if (x.entity) return x.entity;
      if (x.entityId) return x.entityId;
      const m = await api("POST", "/entities/mirror/events", { events: [{ source: { kind: "eds-event", key: `${x.calendar}/${x.uid}` }, also: [{ kind: "ical-uid", key: x.uid }], title: x.title || "", start: local(x.start), end: local(x.end), allDay: !!x.allDay, location: x.location || "" }] });
      return (x.entityId = ((m && m.ids) || [])[0] || "");
    }
    function setProjects(next) {
      editing.projects = next;
      paintProjects();
      if (isNew) return;
      eventEntity(editing).then((id) => api("PUT", `/entities/${enc(id)}/projects`, { projects: next }))
        .then(() => { if (ctx.changed) ctx.changed(); })
        .catch((x) => say(x.message || "The project was not saved", true));
    }
    const projectAdd = el("button", { class: "pick", "data-pops": "1", onclick: (ev) => {
      ev.stopPropagation();
      if (Kit.openedBy() === projectAdd) { popAway(); return; }
      Kit.menu(projectAdd, projectChoices.filter((p) => !editing.projects.includes(p.id)).map((p) => ({ label: p.title, act: () => setProjects([...editing.projects, p.id]) })));
    } }, el("span", { class: "lbl" }, "Add"));
    api("GET", "/tasks/projects").then((all) => { projectChoices = (all || []).filter((p) => !p.archived); paintProjects(); }).catch(() => {});

    // ---- what it is connected to, by its entity: found when there is one

    const connectedHost = el("div", {});
    const showConnected = (g) => { connectedHost.replaceChildren(connected(g, { ...ctx, redraw: () => loadEntity() }, new Set(editing.projects))); };
    const loadEntity = async () => {
      if (isNew) return;
      try {
        const id = e.entity || (got && got.entity.id) || (await api("GET", `/entities/by-source?kind=eds-event&key=${enc(`${e.calendar}/${e.uid}`)}`).then((o) => (o && o.id) || ""));
        if (!id) return;
        editing.entityId = id;
        const [g, r] = await Promise.all([api("GET", `/entities/${enc(id)}?shown=1`), api("GET", `/entities/${enc(id)}/projects`)]);
        editing.projects = r.projects || [];
        paintProjects();
        showConnected(g);
      } catch { /* not there yet: the mirror will reach it */ }
    };
    loadEntity();

    // ---- notes: the editor every description is (editor.js). Notes that came as HTML (Google writes its invitations
    // so) are shown as Markdown, and sent back as they came unless they were changed here.

    const notesHost = el("div", { class: "ed-field ev-notes", "data-placeholder": "@ to link a person, event or task" });
    const raw = e.notes || "";
    const notesShown = /<\/?[a-z][^>]*>/i.test(raw) ? htmlToMarkdown(raw) : raw;
    let notesEd = null;
    ThingCard.withEditor(notesHost, (m) => {
      notesEd = m.createEditor(notesHost, notesShown, { live: true, compact: true, placeholder: notesHost.dataset.placeholder, onOpenUrl: (u) => bridge && bridge.openUrl(u),
        mentions: TalarisMentions(api, ctx.openMention || ((x) => ctx.open(`e:${x}`)), ctx.mentionOpts || { project: () => "", openPlace: (p) => ctx.open(`${p.kind}:${p.project}/${p.where}`) }) });
      ThingCard.keepEditor(notesEd);
    });
    /** What is sent: the notes as written here, or as they came if nothing was changed. */
    const notesNow = () => {
      const text = notesEd ? notesEd.text : notesShown;
      return text === notesShown && !isNew ? raw : text;
    };

    // ---- saving, each by the road it came

    function collected() {
      let start = new Date(v.sd.getTime() + (v.allDay ? 0 : v.st * MIN));
      let end = v.allDay ? addDays(v.ed, 1) : new Date(v.ed.getTime() + v.et * MIN);
      if (end <= start) end = new Date(start.getTime() + (v.allDay ? DAY_MS : 3600000));
      const event = { title: title.value.trim(), allDay: v.allDay, start: start.getTime(), end: end.getTime(), location: where.value, notes: notesNow(), rrule: ruleText(v.rule, v.sd), origStart: editing.start };
      // The invitees, if this calendar can invite and the event is mine to invite to.
      if (calOf(v.calendar).invites && (isNew || editing.organizing || !(editing.attendees || []).length)) event.attendees = v.people;
      return event;
    }
    /** A plugin's event saved as it holds its times: a day alone, or the time on its clock; a day's end is that day. */
    function saveEntity() {
      const event = collected();
      // On the clock it says it is on, where it says (the times it came with are kept as that clock reads them).
      const stamp = (ms) => {
        const on = editing.timezone ? Kit.onClock(ms, editing.timezone) : null;
        return on ? `${on}:00` : `${local(ms)}:00`;
      };
      const properties = { title: event.title, location: event.location || null, notes: event.notes || null,
        start: event.allDay ? iso(new Date(event.start)) : stamp(event.start),
        end: event.allDay ? iso(new Date(event.end - DAY_MS)) : stamp(event.end) };
      say("Saving…");
      api("PATCH", `/entities/${enc(editing.entity)}`, { properties })
        .then(() => { say(""); if (ctx.saved) ctx.saved(); finish(); }, (x) => say(x.message || "It was not saved", true));
    }
    /**
     * An event as Talaris's own calendar keeps it (the core's own-calendar.ts): an Event entity marked as that
     * calendar's, its times as a plugin's are (a day alone, or the time where you are). `extra`: what else it carries.
     */
    function makeOwn(extra = {}) {
      const event = collected();
      const properties = { title: event.title || "Untitled", location: event.location || null, notes: event.notes || null,
        allDay: event.allDay, start: event.allDay ? iso(new Date(event.start)) : `${local(event.start)}:00`,
        end: event.allDay ? iso(new Date(event.end - DAY_MS)) : `${local(event.end)}:00` };
      say("Saving…");
      return api("POST", "/entities", { role: "event", properties, "talaris:calendar": OWN_CALENDAR, ...extra }).then((made) => {
        say("");
        const id = made && made.id;
        if (id && editing.projects.length) api("PUT", `/entities/${enc(id)}/projects`, { projects: editing.projects }).catch((x) => say(x.message || "The project was not saved", true));
        if (ctx.saved) ctx.saved();
        finish();
      }, (x) => say(x.message || "It was not saved", true));
    }
    function save() {
      if (editing.readOnly) return;
      if (editing.entity) { saveEntity(); return; }
      if (isNew && calOf(v.calendar).own) { makeOwn(); return; }
      const event = collected();
      say("Saving…");
      if (isNew) {
        ctx.send({ do: "create", calendar: v.calendar, event }).then((d) => {
          say("");
          // The projects chosen while it had no entity: it has somewhere to keep them now.
          if (editing.projects.length && d && d.uid) eventEntity({ ...event, calendar: v.calendar, uid: d.uid })
            .then((id) => api("PUT", `/entities/${enc(id)}/projects`, { projects: editing.projects }))
            .catch((x) => say(x.message || "The project was not saved", true));
          if (ctx.saved) ctx.saved();
          finish();
        }, failed);
      } else ctx.send({ do: "update", calendar: editing.calendar, uid: editing.uid, rid: editing.rid, which: editing.which, event }).then(() => { say(""); if (ctx.saved) ctx.saved(); finish(); }, failed);
    }

    // ---- its foot

    const acts = el("div", { class: "acts" });
    if (!isNew && !e.entity && !editing.readOnly) {
      const del = el("button", { class: "t-btn danger", onclick: () => {
        if (!Kit.ask(del, { ask: "Delete it?" })) return;
        say("Saving…");
        ctx.send({ do: "delete", calendar: editing.calendar, uid: editing.uid, rid: editing.rid, which: editing.which })
          .then(() => { say(""); if (ctx.saved) ctx.saved(); if (ctx.gone) ctx.gone(); else finish(); }, failed);
      } }, "Delete");
      acts.append(del);
    }
    // One a plugin brought is edited as a thing (the core's entities), which its sync carries back; archived, not deleted.
    if (e.entity) {
      const arch = el("button", { class: "t-btn", onclick: () => {
        if (!Kit.ask(arch, { ask: "Archive it?" })) return;
        api("PATCH", `/entities/${enc(e.entity)}`, { archived: true })
          .then(() => { if (ctx.saved) ctx.saved(); if (ctx.gone) ctx.gone(); else finish(); }, (x) => say(x.message || "It was not archived", true));
      } }, "Archive");
      acts.append(arch);
    }
    // A feed's event made yours: a copy on Talaris's own calendar, which a sync may carry on; the feed's own is not shown beside it.
    if (!isNew && calOf(e.calendar).feed) {
      acts.append(el("button", { class: "t-btn", title: "Copy it to your Talaris calendar, where it is yours to change", onclick: () => {
        makeOwn({ "talaris:fromFeed": `${e.calendar}/${e.uid}/${e.rid || ""}` });
      } }, "Make it mine"));
    }
    // Glance on it, by its entity: made now if the mirror has not reached it.
    if (!isNew) {
      const glance = ctx.glance || (bridge && bridge.glanceAt ? (k) => bridge.glanceAt(k) : null);
      if (glance) acts.append(el("button", { class: "t-btn", title: "Its connections, and possible ones", onclick: () => eventEntity(editing).then((id) => { if (id) glance(`e:${id}`); }).catch((x) => say(x.message || "It could not be opened", true)) }, "Glance"));
      if (ctx.hub !== "calendar" && bridge.openEvent && !e.entity) acts.append(el("button", { class: "t-btn", onclick: () => bridge.openEvent(e.calendar, e.uid, new Date(e.start).toISOString()) }, "Open in Calendar"));
    }
    acts.append(el("span", { class: "spacer" }));
    if (ctx.close) acts.append(el("button", { class: "t-btn", onclick: ctx.close }, "Cancel"));
    if (!editing.readOnly) acts.append(el("button", { class: "t-btn primary", onclick: save }, "Save"));

    function paint() {
      paintRepeats();
      // Talaris's own calendar keeps one event at a time: no repeats, no invitations.
      if (calOf(v.calendar).own) freqRow.hidden = daysRow.hidden = endsRow.hidden = true;
      paintPeople();
      const cal = calendars().find((c) => c.id === v.calendar);
      calBtn.replaceChildren(el("span", { class: "sw", style: `background:${(cal && cal.color) || "var(--accent)"}` }), el("span", { class: "lbl" }, cal ? `${cal.name} · ${cal.account}` : "Choose a calendar"));
      allDay.classList.toggle("on", v.allDay);
      sd.replaceChildren(el("span", { class: "lbl" }, dayLabel(v.sd)));
      ed.replaceChildren(el("span", { class: "lbl" }, dayLabel(v.ed)));
      if (document.activeElement !== st) st.value = timeLabel(v.st);
      if (document.activeElement !== et) et.value = timeLabel(v.et);
      st.hidden = et.hidden = v.allDay;
    }
    which("this");
    paint();

    const card = el("div", { class: "ev-card" },
      row("Title", title), row("Calendar", calBtn), row("All day", allDay), row("Starts", sd, st), row("Ends", ed, et), row("Where", where),
      row("Projects", el("div", { class: "who" }, projects, projectAdd)), row("Notes", notesHost),
      freqRow, daysRow, endsRow, whoRow, whoNote, answerRow, whichRow, acts, connectedHost);
    card.save = save;
    card.focusTitle = () => title.focus();
    return [card];
  }

  return { ask, parts };
})();
