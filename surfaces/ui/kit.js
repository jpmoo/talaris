// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore
//
// The one copy of what every page does the same way (Kit). Each page grew its
// own: twelve ways of asking twice, nine menus, six month pickers, five
// wordings for "when was this", two answers to what "3" means as a time — and
// they drifted (the audit of 2026-10-27). Here once, and the pages use it.
//
//   Kit.clock, day, relDay, ago, stamp, future, left, month — dates and times, worded one way
//   Kit.parseDay, parseTime — what is typed, read one way
//   Kit.pop, popAway, menu — the one pop-up at a time, and a menu in it
//   Kit.monthPicker, timeList — choosing a day, a time
//   Kit.twice — asking before doing
//   Kit.fold, matches, rank, searchBox, debounce — finding by typing
//   Kit.say, empty — what is said back
//
// It needs nothing but the page; Surface (surface.js) tells it the clock setting.

"use strict";
const Kit = (() => {
  const el = (tag, attrs = {}, ...kids) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
      else if (k === "class") e.className = v;
      else e.setAttribute(k, v === true ? "" : v);
    }
    e.append(...kids.flat().filter((x) => x !== null && x !== undefined && x !== false));
    return e;
  };

  // ------------------------------------------------------------ dates and times

  // The clock as Settings has it (Clock: 12 or 24 hour), told by Surface from each page's state.
  let hours = "12";
  function setClock(clock) { if (clock && (clock.hours === "12" || clock.hours === "24")) hours = clock.hours; }

  const pad = (n) => String(n).padStart(2, "0");
  const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
  const sameDay = (a, b) => !!(a && b) && a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  const isoDay = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const days = (a, b) => Math.round((startOfDay(a) - startOfDay(b)) / 86400000);
  const asDate = (x) => (x instanceof Date ? x : new Date(x));
  // The year, only when it is not this one.
  const yearIf = (d) => (d.getFullYear() !== new Date().getFullYear() ? { year: "numeric" } : {});

  /** "2:14 PM", or "14:14" with a 24-hour clock. */
  function clock(x, { seconds = false } = {}) {
    return asDate(x).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", ...(seconds ? { second: "2-digit" } : {}), hour12: hours !== "24" });
  }
  /** An hour on its own, for a day's gutter: "2 PM", or "14:00" with a 24-hour clock. */
  const hour = (h) => (hours === "24" ? `${pad(h)}:00` : new Date(2000, 0, 1, h).toLocaleTimeString("en-US", { hour: "numeric" }));
  /** A time of day given in minutes after midnight, as `clock` says it. */
  const minutes = (m) => clock(new Date(2000, 0, 1, Math.floor(m / 60), m % 60));
  /** "Fri, Oct 30" — the year only when it is not this one; `weekday: false` for "Oct 30". */
  function day(x, { weekday = true } = {}) {
    return asDate(x).toLocaleDateString("en-US", { ...(weekday ? { weekday: "short" } : {}), month: "short", day: "numeric", ...yearIf(asDate(x)) });
  }
  /** A day as near as it is: "Today", "Tomorrow", "Yesterday", "Thu" in the coming week, else "Oct 30". */
  function relDay(x) {
    const d = asDate(x), n = days(d, new Date());
    if (n === 0) return "Today";
    if (n === 1) return "Tomorrow";
    if (n === -1) return "Yesterday";
    if (n > 1 && n < 7) return d.toLocaleDateString("en-US", { weekday: "short" });
    return day(d, { weekday: false });
  }
  /** When something happened: "now", "5 min ago", "2:14 PM" today, "Yesterday", "Mon" this week, else "Oct 3". */
  function ago(x) {
    const d = asDate(x), mins = Math.floor((Date.now() - d) / 60000), n = days(d, new Date());
    if (mins < 1) return "now";
    if (mins < 60) return `${mins} min ago`;
    if (n === 0) return clock(d);
    if (n === -1) return "Yesterday";
    if (n > -7) return d.toLocaleDateString("en-US", { weekday: "short" });
    return day(d, { weekday: false });
  }
  /** A moment, day and time: "2:14 PM" today, "Yesterday 2:14 PM", else "Oct 30 · 2:14 PM". */
  function stamp(x) {
    const d = asDate(x), n = days(d, new Date());
    if (n === 0) return clock(d);
    if (n === -1 || n === 1) return `${n < 0 ? "Yesterday" : "Tomorrow"} ${clock(d)}`;
    return `${day(d, { weekday: false })} · ${clock(d)}`;
  }
  /** "4:32", or "1:04:32" past the hour: a count down. */
  function left(ms) {
    const s = Math.max(0, Math.round(ms / 1000)), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
    return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
  }
  /** Something to come: counted down within the hour, the time today, "Tomorrow 2:15 PM", "Thu 2:15 PM", else the day and time. */
  function future(x) {
    const d = asDate(x), ms = d - Date.now(), n = days(d, new Date());
    if (ms <= 0) return "now";
    if (ms < 3600000) return left(ms);
    if (n === 0) return clock(d);
    if (n === 1) return `Tomorrow ${clock(d)}`;
    if (n < 7) return `${d.toLocaleDateString("en-US", { weekday: "short" })} ${clock(d)}`;
    return `${day(d, { weekday: false })} · ${clock(d)}`;
  }
  /** "October 2026". */
  const month = (x) => asDate(x).toLocaleDateString("en-US", { month: "long", year: "numeric" });

  // ------------------------------------------------------------ reading what is typed

  const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
  const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  /**
   * "today", "tom", "fri", "next fri", "+3", "in 2w", "10/30", "10/30/27",
   * "oct 30", "30 oct", "2026-10-30" — a day, or null. A weekday is the coming
   * one, today counting ("fri" on a Friday is today; "next fri" a week on). A
   * month and day with no year is the next one to come — or, with `past` (a
   * birthday, a day met), this year's, and a two-year "80" is 1980.
   */
  function parseDay(text, { past = false } = {}) {
    let t = String(text || "").trim().toLowerCase().replace(/\s+/g, " ").replace(/^[a-z]{3,}, (?=[a-z]{3,}\.? \d)/, "");
    const next = /^next /.test(t);
    t = t.replace(/^(next|this|on) /, "");
    const today = startOfDay(new Date());
    if (!t) return null;
    if (/^(today|tod|now)$/.test(t)) return today;
    if (/^(tomorrow|tom|tmr|tmrw)$/.test(t)) return addDays(today, 1);
    if (/^yesterday$/.test(t)) return addDays(today, -1);
    let m = t.match(/^(?:\+|in )(\d+) ?(d|day|days|w|wk|week|weeks|m|mo|month|months)?$/);
    if (m) {
      const n = Number(m[1]), u = (m[2] || "d")[0];
      return u === "w" ? addDays(today, 7 * n) : u === "m" ? new Date(today.getFullYear(), today.getMonth() + n, today.getDate()) : addDays(today, n);
    }
    const wd = WEEKDAYS.findIndex((w) => t.length >= 2 && (w.startsWith(t) || t.startsWith(w)));
    if (wd >= 0 && /^[a-z]+$/.test(t)) {
      const ahead = (wd - today.getDay() + 7) % 7;
      return addDays(today, next && ahead === 0 ? 7 : ahead);
    }
    m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (m) return valid(Number(m[1]), Number(m[2]), Number(m[3]));
    m = t.match(/^(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{2,4}))?$/);
    if (m) return ahead(Number(m[1]), Number(m[2]), m[3]);
    m = t.match(/^([a-z]{3,})\.? (\d{1,2})(?:,? (\d{4}))?$/) || t.match(/^(\d{1,2}) ([a-z]{3,})\.?(?: (\d{4}))?$/);
    if (m) {
      const [word, d] = /^\d/.test(m[1]) ? [m[2], m[1]] : [m[1], m[2]];
      const mo = MONTHS.findIndex((x) => word.startsWith(x));
      if (mo >= 0) return ahead(mo + 1, Number(d), m[3]);
    }
    return null;
    function valid(y, mo, d) { const x = new Date(y, mo - 1, d); return x.getMonth() === mo - 1 && x.getDate() === d ? x : null; }
    function ahead(mo, d, y) {
      if (y && y.length === 2 && past) return valid((Number(y) > today.getFullYear() % 100 ? 1900 : 2000) + Number(y), mo, d);
      if (y) return valid(y.length === 2 ? 2000 + Number(y) : Number(y), mo, d);
      if (past) return valid(today.getFullYear(), mo, d);
      const x = valid(today.getFullYear(), mo, d);
      return x && x < today ? valid(today.getFullYear() + 1, mo, d) : x;
    }
  }
  /** "9", "9:30", "930", "9:30 pm", "21:30", "noon", "midnight" — minutes after midnight, or null. A bare 1–6 is the afternoon. */
  function parseTime(text) {
    const t = String(text || "").trim().toLowerCase().replace(/\s+/g, "").replace(/\.m\.?$/, "m").replace(/\./g, "");
    if (t === "noon") return 12 * 60;
    if (t === "midnight") return 0;
    const m = t.match(/^(\d{1,2})(?::?(\d{2}))?(a|am|p|pm)?$/);
    if (!m) return null;
    let h = Number(m[1]); const mi = Number(m[2] || 0);
    if (mi > 59) return null;
    if (m[3]) { if (h < 1 || h > 12) return null; h = (h % 12) + (m[3][0] === "p" ? 12 : 0); }
    // Nobody meets at 3 in the morning.
    else if (!m[2] && h >= 1 && h <= 6) h += 12;
    if (h > 23) return null;
    return h * 60 + mi;
  }

  // ------------------------------------------------------------ the one pop-up at a time

  /*
   * No browser pickers — a <select>, a date or a time field opens a window of
   * the engine's own, which a layer surface cannot hold — so menus, days and
   * times are drawn in the page, one at a time, in one holder. Under what
   * opened it, or above when there is more room there; kept on screen; as tall
   * as there is room for, then scrolling. A press elsewhere, Escape, or the
   * page's size changing puts it away; a press on what opened it is that one's
   * to decide (it toggles).
   */
  let holder = null, opener = null, closed = null;
  function popAway() {
    if (!holder || holder.hidden) return;
    holder.hidden = true;
    holder.replaceChildren();
    opener = null;
    const was = closed; closed = null;
    if (was) was();
  }
  const isOpen = () => !!holder && !holder.hidden;
  /** What opened the pop-up out now (a press on it again puts it away: the page's to decide). */
  const openedBy = () => (isOpen() ? opener : null);
  function pop(at, content, { onClose = null } = {}) {
    if (!holder) {
      holder = el("div", { class: "kit-pop", hidden: true });
      document.body.append(holder);
      document.addEventListener("pointerdown", (e) => {
        if (!isOpen() || holder.contains(e.target) || (opener && opener.contains && opener.contains(e.target))) return;
        popAway();
      }, true);
      addEventListener("resize", popAway);
      // The page scrolled under it: what opened it has moved away.
      document.addEventListener("scroll", (e) => { if (isOpen() && !holder.contains(e.target)) popAway(); }, true);
      // Escape puts the pop-up away and nothing else: first, before the page hears it.
      document.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && isOpen()) { e.preventDefault(); e.stopImmediatePropagation(); popAway(); }
      }, true);
    }
    popAway();
    opener = at instanceof Element ? at : (at.opener || null);
    closed = onClose;
    holder.replaceChildren(content);
    holder.hidden = false;
    holder.style.maxHeight = "";
    const r = opener ? opener.getBoundingClientRect() : { left: at.x, right: at.x, top: at.y, bottom: at.y };
    const w = holder.offsetWidth, below = innerHeight - r.bottom - 8, above = r.top - 8;
    const up = holder.offsetHeight > below && above > below;
    holder.style.maxHeight = `${Math.max(120, up ? above : below)}px`;
    const h = holder.offsetHeight;
    holder.style.left = `${Math.max(4, Math.min(r.left, innerWidth - w - 6))}px`;
    holder.style.top = `${Math.max(4, up ? r.top - h - 4 : Math.min(r.bottom + 4, innerHeight - h - 6))}px`;
    return holder;
  }
  /**
   * A menu: items `{label, act, on, color, sub, title, disabled}` or "sep".
   * Under `at` (an element, or {x, y}); the arrow keys move through it and
   * Enter chooses; longer than eight, a box on top narrows it as it is typed
   * (Enter there takes the first left).
   */
  function menu(at, items, opts = {}) {
    let hot = -1, buttons = [];
    const real = items.filter((it) => it !== "sep");
    const list = el("div", { class: "menu-list", role: "menu" });
    const draw = (q = "") => {
      const shown = q ? real.filter((it) => matches(q, it.label)) : items;
      buttons = [];
      hot = -1;
      list.replaceChildren(...shown.map((it) => {
        if (it === "sep") return el("div", { class: "menu-sep" });
        const b = el("button", { class: "menu-item" + (it.on ? " on" : ""), title: it.title || null, disabled: it.disabled || null,
          onclick: (e) => { e.stopPropagation(); popAway(); it.act(); } },
          it.color ? el("span", { class: "sw", style: `background:${it.color}` }) : null,
          el("span", { class: "lbl" }, it.label), it.sub ? el("span", { class: "n" }, it.sub) : null);
        buttons.push(b);
        return b;
      }));
      if (!buttons.length) list.append(empty("Nothing matches"));
    };
    const mark = () => buttons.forEach((b, i) => { b.classList.toggle("hot", i === hot); if (i === hot) b.scrollIntoView({ block: "nearest" }); });
    const keys = (e) => {
      if ((e.key === "ArrowDown" || e.key === "ArrowUp") && buttons.length) {
        e.preventDefault();
        hot = (hot + (e.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
        mark();
      } else if (e.key === "Enter" && buttons.length) {
        e.preventDefault();
        buttons[Math.max(0, hot)].click();
      }
    };
    draw();
    const filter = real.length > 8 ? el("input", { type: "text", class: "kit-filter", spellcheck: "false", placeholder: "Find" }) : null;
    if (filter) filter.addEventListener("input", () => draw(filter.value));
    const box = el("div", { tabindex: "-1" }, filter, list);
    box.addEventListener("keydown", keys);
    pop(at, box, opts);
    (filter || box).focus();
    return box;
  }

  // ------------------------------------------------------------ choosing a day, a time

  const ICON_PREV = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M10 3.5 5.5 8 10 12.5"/></svg>';
  const ICON_NEXT = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3.5 10.5 8 6 12.5"/></svg>';
  /**
   * A month to choose a day in: Sunday first, today ringed, the chosen one
   * lit; ‹ › by the month. `chips`: quick choices under it, each
   * `[label, date | value]` (the standard set: `Kit.DAY_CHIPS`, with Clear when
   * `clear` is set) — the first a button, the rest in a pulldown beside it,
   * Clear last. `pick` is given the day (or a chip's value).
   */
  /**
   * The quick days, the same everywhere: today, a day and a week on from `base` (the day chosen, else today),
   * and each day of the next week — the first of its name strictly after today, Monday first.
   */
  const DAY_CHIPS = (base = null) => {
    const t = startOfDay(new Date()), b = base ? startOfDay(base) : t;
    const next = (dow) => addDays(t, ((dow - t.getDay() + 7) % 7) || 7);
    return [["Today", t], ["+1 day", addDays(b, 1)], ["+1 week", addDays(b, 7)],
      ...["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d, i) => [`Next ${d}`, next((i + 1) % 7)])];
  };
  function monthPicker(chosen, pick, { chips = null, clear = false, years = false } = {}) {
    let month0 = new Date((chosen || new Date()).getFullYear(), (chosen || new Date()).getMonth(), 1);
    const wrap = el("div", { class: "kit-mini" });
    const choose = (e, v) => { e.stopPropagation(); popAway(); pick(v); };
    const draw = () => {
      const first = addDays(month0, -month0.getDay());
      const step = (n) => (e) => { e.stopPropagation(); month0 = new Date(month0.getFullYear(), month0.getMonth() + n, 1); draw(); };
      const prev = el("button", { class: "icon-btn", title: "The month before", onclick: step(-1) }), next = el("button", { class: "icon-btn", title: "The month after", onclick: step(1) });
      prev.innerHTML = ICON_PREV; next.innerHTML = ICON_NEXT;
      // A year at a time too, for a day long ago (a birthday).
      const back = years ? el("button", { class: "icon-btn", title: "The year before", onclick: step(-12) }, "«") : null;
      const on = years ? el("button", { class: "icon-btn", title: "The year after", onclick: step(12) }, "»") : null;
      const chip = ([label, v]) => el("button", { class: "t-btn", onclick: (e) => choose(e, v) }, label);
      const [lead, ...rest] = chips || [];
      // The rest in a pulldown of the picker's own, opening up over the month: one pop-up at a time.
      let more = null;
      if (rest.length) {
        const list = el("div", { class: "menu-list kit-more-list", role: "menu", hidden: true },
          rest.map(([label, v]) => el("button", { class: "menu-item", onclick: (e) => choose(e, v) }, el("span", { class: "lbl" }, label))));
        const btn = el("button", { class: "t-btn", "aria-haspopup": "menu", onclick: (e) => { e.stopPropagation(); list.hidden = !list.hidden; } }, "More ▾");
        more = el("span", { class: "kit-more" }, btn, list);
        wrap.onpointerdown = (e) => { if (!more.contains(e.target)) list.hidden = true; };
      }
      const quick = [lead ? chip(lead) : null, more, clear ? chip(["Clear", null]) : null].filter(Boolean);
      wrap.replaceChildren(
        el("div", { class: "kit-mini-head" }, back, prev, el("span", { class: "m" }, month(month0)), next, on),
        el("div", { class: "kit-mini-grid" },
          ["S", "M", "T", "W", "T", "F", "S"].map((d) => el("span", { class: "dow" }, d)),
          Array.from({ length: 42 }, (_, i) => {
            const d = addDays(first, i);
            return el("button", { class: "day" + (d.getMonth() !== month0.getMonth() ? " other" : "") + (sameDay(d, chosen) ? " on" : "") + (sameDay(d, new Date()) ? " today" : ""),
              onclick: (e) => choose(e, d) }, String(d.getDate()));
          })),
        quick.length ? el("div", { class: "kit-chips" }, quick) : null);
    };
    draw();
    return wrap;
  }
  /** Times of day by the quarter hour, scrolled to the chosen one. `pick` is given minutes after midnight. */
  function timeList(current, pick) {
    const list = el("div", { class: "kit-times" });
    for (let m = 0; m < 24 * 60; m += 15) {
      list.append(el("button", { class: "time" + (m === current ? " on" : ""), onclick: (e) => { e.stopPropagation(); popAway(); pick(m); } }, minutes(m)));
    }
    setTimeout(() => { const on = list.querySelector(".on") || list.children[Math.floor((current ?? 540) / 15)]; if (on) list.scrollTop = on.offsetTop - 60; }, 0);
    return list;
  }

  // ------------------------------------------------------------ asking before doing

  /*
   * The first press only says what the second will do: the button reads
   * `ask` ("Delete it?"), in the danger color, for four seconds; a second
   * press does it; Escape, or the time running out, puts it back. Kept by
   * `key` across a redraw, so a list drawn again each second keeps its asking.
   */
  const ASK_MS = 4000;
  const armed = new Map(); // key → time it stops asking
  const labels = new WeakMap(); // button → what it said before it asked
  const live = (k) => (armed.get(k) || 0) > Date.now();
  function paint(button, k, ask) {
    if (!labels.has(button)) labels.set(button, button.innerHTML);
    const on = live(k);
    button.classList.toggle("armed", on);
    if (on) button.textContent = ask; else button.innerHTML = labels.get(button);
  }
  /**
   * Inside a press's own handler: false the first time (the button now asks),
   * true the second (do it). `key` keeps the asking across a redraw.
   */
  function ask(button, { key, ask: question, ms = ASK_MS }) {
    const k = key || button;
    if (live(k)) { armed.delete(k); paint(button, k, question); return true; }
    armed.set(k, Date.now() + ms);
    paint(button, k, question);
    setTimeout(() => { if (!live(k)) { armed.delete(k); if (button.isConnected) paint(button, k, question); } }, ms + 20);
    if (!button.dataset.kitAsks) {
      button.dataset.kitAsks = "1";
      button.addEventListener("keydown", (e) => { if (e.key === "Escape" && live(k)) { e.stopPropagation(); armed.delete(k); paint(button, k, question); } });
    }
    return false;
  }
  /** A button that asks before it acts (`ask` below, as its whole press). Drawn again under the same key, it is still asking. */
  function twice(button, { key, ask: question, act, ms = ASK_MS }) {
    const k = key || button;
    if (live(k)) paint(button, k, question);
    button.addEventListener("click", (e) => { e.stopPropagation(); if (ask(button, { key: k, ask: question, ms })) act(); });
    return button;
  }
  /** Whether a key is asking now (a redraw paints it so). */
  const asking = (key) => live(key);
  /** Asking no more (a menu shown afresh): the button says what it said. */
  function unask(button, key) { const k = key || button; armed.delete(k); if (button && labels.has(button)) { button.classList.remove("armed"); button.innerHTML = labels.get(button); } }

  // ------------------------------------------------------------ finding by typing

  /** Lower case, accents gone: "Käufer" finds "kaufer". */
  const fold = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  /** Every word typed is somewhere in one of `texts`. */
  function matches(query, ...texts) {
    const words = fold(query).split(/\s+/).filter(Boolean);
    if (!words.length) return true;
    const hay = texts.map(fold).join(" \u0000 ");
    return words.every((w) => hay.includes(w));
  }
  /** How well `text` answers `query`: whole, then its start, then a word's start, then anywhere; 0 for not at all. */
  function rank(query, text) {
    const q = fold(query).trim(), t = fold(text);
    if (!q) return 1;
    if (t === q) return 100;
    if (t.startsWith(q)) return 80;
    if (new RegExp(`(^|[^a-z0-9])${q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(t)) return 60;
    return matches(q, t) ? 40 : 0;
  }
  /** A box typed into to narrow a list: Escape clears it first (and goes no further); empty, Escape is the page's. */
  function searchBox(input, onChange) {
    input.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && input.value) {
        e.preventDefault();
        e.stopPropagation();
        input.value = "";
        input.dispatchEvent(new Event("input", { bubbles: true }));
        if (onChange) onChange("");
      }
    });
    return input;
  }
  /** How long typing pauses before a search is asked of the core: the same everywhere. */
  const SEARCH_MS = 200;
  /** One call after typing has paused: the same pause everywhere. */
  function debounce(fn, ms = SEARCH_MS) {
    let t = null;
    return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  }

  // ------------------------------------------------------------ dragging

  /*
   * By pointer, never the browser's drag and drop: that goes through the
   * compositor's drag protocol, which a layer surface does not take part in
   * (found by the task views; the drawers and Tasks used it, and the dock,
   * which trades places along its row as it goes, never did). A copy follows
   * the pointer; whatever is under it that takes what is carried says where it
   * lands — above, below, or in — with the one drop line every list has; near
   * the edge of what scrolls, it scrolls. The press that ends a drag is not a
   * click on what was dragged.
   */
  const MARKS = { above: "drop-above", below: "drop-below", in: "drop-in" };
  let carrying = null; // { payload, node }
  const unmark = (z) => { if (z) { z.classList.remove("kit-over", ...Object.values(MARKS)); } };
  /** Whatever holds what is under the pointer and scrolls. */
  function scroller(hit) {
    for (let e = hit; e && e !== document.body; e = e.parentElement) {
      const cs = getComputedStyle(e);
      if (/(auto|scroll)/.test(cs.overflowY + cs.overflowX) && (e.scrollHeight > e.clientHeight || e.scrollWidth > e.clientWidth)) return e;
    }
    return null;
  }
  /**
   * `node` can be picked up and carried: `payload` is what a zone is given (or
   * a function giving it, asked as it is picked up — the rows chosen then).
   * Not from a button or a field inside it (`ignore`), and only once it has
   * moved a few pixels, so a press is still a press.
   */
  function draggable(node, payload, { ignore = "button, input, textarea, select, a, .no-drag", onStart = null } = {}) {
    node.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || (ignore && e.target.closest(ignore))) return;
      const sx = e.clientX, sy = e.clientY;
      let ghost = null, over = null, where = null, got = null;
      const move = (ev) => {
        if (!ghost) {
          if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 5) return;
          popAway();
          const r = node.getBoundingClientRect();
          ghost = node.cloneNode(true);
          ghost.classList.add("kit-ghost");
          Object.assign(ghost.style, { width: `${r.width}px`, left: `${r.left}px`, top: `${r.top}px` });
          document.body.append(ghost);
          node.classList.add("kit-dragging");
          document.body.classList.add("kit-drag-on");
          got = typeof payload === "function" ? payload() : payload;
          carrying = { payload: got, node };
          if (onStart) onStart();
        }
        ghost.style.transform = `translate(${ev.clientX - sx}px, ${ev.clientY - sy}px)`;
        const hit = document.elementFromPoint(ev.clientX, ev.clientY);
        let z = hit && hit.closest("[data-kit-drop]");
        while (z && !(z.kitZone.accepts(got, node))) z = z.parentElement && z.parentElement.closest("[data-kit-drop]");
        const w = z ? z.kitZone.where(ev, z, got) : null;
        if (z !== over || w !== where) {
          unmark(over);
          over = z; where = w;
          if (over) { over.classList.add("kit-over"); if (MARKS[where]) over.classList.add(MARKS[where]); }
        }
        const sc = scroller(hit);
        if (sc) {
          const b = sc.getBoundingClientRect(), edge = 36;
          if (ev.clientY > b.bottom - edge) sc.scrollTop += 14; else if (ev.clientY < b.top + edge) sc.scrollTop -= 14;
          if (ev.clientX > b.right - edge) sc.scrollLeft += 14; else if (ev.clientX < b.left + edge) sc.scrollLeft -= 14;
        }
      };
      const up = (ev) => {
        removeEventListener("pointermove", move);
        removeEventListener("pointerup", up);
        removeEventListener("pointercancel", up);
        if (!ghost) return;
        ghost.remove();
        node.classList.remove("kit-dragging");
        document.body.classList.remove("kit-drag-on");
        unmark(over);
        carrying = null;
        const swallow = (c) => { c.stopPropagation(); c.preventDefault(); };
        addEventListener("click", swallow, true);
        setTimeout(() => removeEventListener("click", swallow, true), 0);
        if (ev.type === "pointerup" && over) over.kitZone.drop(got, where, ev, node);
      };
      addEventListener("pointermove", move);
      addEventListener("pointerup", up);
      addEventListener("pointercancel", up);
    });
    return node;
  }
  /** Where on `node` the pointer is: its upper or lower half, or — when `into` — the top and bottom thirds, and in between. */
  function halves(ev, node, into = false) {
    const b = node.getBoundingClientRect(), f = (ev.clientY - b.top) / b.height;
    if (!into) return f < .5 ? "above" : "below";
    return f < .3 ? "above" : f > .7 ? "below" : "in";
  }
  /**
   * `node` takes what is carried: `accepts(payload, dragged)` says whether,
   * `where(ev, node, payload)` where on it (default: above or below by the
   * half; null for no line, the whole of it lit), `drop(payload, where, ev,
   * dragged)` what happens.
   */
  function dropZone(node, { accepts = () => true, where = (ev, n) => halves(ev, n), drop }) {
    node.dataset.kitDrop = "1";
    node.kitZone = { accepts, where, drop };
    return node;
  }
  /** What is being carried now, if anything. */
  const carried = () => (carrying ? carrying.payload : null);

  // ------------------------------------------------------------ asking the core

  /*
   * Every page asks the core through its bridge and hears back by id: one book
   * of what is waiting, kept the same way. A 2xx answer is the answer; any
   * other is an error in the core's words ("the core answered 404" when it
   * gave none); no bridge is "Not connected"; and an answer that never comes
   * is given up on (longer than the slowest the process waits, a backup's)
   * rather than left pending for ever.
   */
  const CORE_GIVE_UP_MS = 11 * 60 * 1000;
  function core(send) {
    const waiting = new Map();
    let next = Math.floor(Math.random() * 1e9);
    function call(method, path, body) {
      return new Promise((ok, fail) => {
        const id = String(++next);
        const timer = setTimeout(() => { if (waiting.delete(id)) fail(new Error("The core did not answer")); }, CORE_GIVE_UP_MS);
        waiting.set(id, (status, data) => {
          clearTimeout(timer);
          if (status >= 200 && status < 300) ok(data);
          else fail(new Error((data && data.error) || `The core answered ${status}`));
        });
        let sent = false;
        try { sent = send(id, method, path, body === undefined ? "" : typeof body === "string" ? body : JSON.stringify(body)) !== false; } catch { sent = false; }
        if (!sent) { clearTimeout(timer); waiting.delete(id); fail(new Error("Not connected")); }
      });
    }
    /** An answer come back: `{id, status, data}`, or its three parts (data as text, read as JSON when it is). */
    function reply(id, status, data) {
      if (id && typeof id === "object") ({ id, status, data } = id);
      const done = waiting.get(String(id));
      if (!done) return;
      waiting.delete(String(id));
      if (typeof data === "string") { try { data = JSON.parse(data); } catch { /* words, as they are */ } }
      done(status, data);
    }
    return { call, reply };
  }

  // ------------------------------------------------------------ what is said back

  /**
   * A line said back, in sentence case: an error stays until something else is
   * said; anything else goes after a few seconds.
   */
  const sayTimers = new WeakMap();
  function say(target, text, error = false, ms = 5000) {
    if (!target) return;
    clearTimeout(sayTimers.get(target));
    target.textContent = text || "";
    target.classList.toggle("err", !!(text && error));
    if (text && !error && ms) sayTimers.set(target, setTimeout(() => { if (target.textContent === text) target.textContent = ""; }, ms));
  }
  /** A list drawn again where it was scrolled to: what `draw` does to `box`, without sending it back to the top. */
  function keepScroll(box, draw) { const top = box ? box.scrollTop : 0; const out = draw(); if (box && top) box.scrollTop = top; return out; }
  /** The fold mark, one way: a small ▾, turned to point along when what it folds is shut (kit.css). */
  const caret = (open) => el("span", { class: "kit-caret" + (open ? "" : " shut") }, "▾");
  /** An empty list said one way: "Nothing here yet", "Nothing matches" — sentence case, no stop. */
  const empty = (text) => el("div", { class: "kit-empty" }, String(text).replace(/\.$/, ""));

  return {
    el, setClock, clock, hour, minutes, day, relDay, ago, stamp, future, left, month, startOfDay, addDays, sameDay, isoDay,
    parseDay, parseTime, pop, popAway, isOpen, openedBy, menu, monthPicker, timeList, DAY_CHIPS,
    core, draggable, dropZone, halves, carried, twice, ask, asking, unask, ASK_MS, fold, matches, rank, searchBox, debounce, SEARCH_MS, say, empty, caret, keepScroll,
  };
})();
