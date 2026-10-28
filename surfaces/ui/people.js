// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore
//
// The People panel's page (people_panel.py): everyone down the left, grouped
// by organization or A to Z, and the one chosen on the right. Everything is
// asked of the core through the bridge; nothing is kept here but what is on
// show and this page's own preferences.
//
// What a person is, is read from the person type: its fields are drawn by
// kind, the way New draws them (new.js), so a field somebody adds to the type
// turns up here too. Which field is the name and which the addresses comes
// from the type's contact profile, never from a name.

"use strict";

// One closure: peek.js and mentions.js load first into the same page.
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
    (typeof host === "string" ? $(host) : host).replaceChildren(...choices.map(([value, label]) =>
      el("button", { class: value === current ? "on" : "", onclick: (e) => { e.stopPropagation(); pick(value); } }, label)));
  }
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* fine */ } },
  };

  let bridge = null;
  let surface = { up: false };
  // Loaded as a window (overlay.py), not a panel: always out, no dim, no motion.
  const WINDOW = new URLSearchParams(location.search).has("window");
  if (WINDOW) document.documentElement.dataset.window = "1";

  let ptype = null;     // the person type
  let people = [];      // /people's rows
  let chosen = store.get("talaris.people.chosen", null);
  let got = null;       // the chosen one, as /entities/:id answers
  let mode = store.get("talaris.people.mode", "org");
  let shut = new Set(store.get("talaris.people.shut", []));
  let editors = [];     // the editor fields drawn for the chosen one, to be put away

  // ---------------------------------------------------------------- the core

  // Two pages may share the bridge — the panel and its window — so each numbers
  // its requests from somewhere of its own, and takes only its own answers.
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

  // ---------------------------------------------------------------- the type's words

  const words = (key) => String(key).replace(/_/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (c) => c.toUpperCase());
  const labelOf = (f) => f["talaris:label"] || f.label || words(f.key);
  const field = (key) => (ptype && key ? ptype.fields.find((f) => f.key === key) : null) || null;
  const contact = () => ((ptype && ptype.profiles) || {}).contact || {};
  const titleKey = () => (typeof contact().title === "string" ? contact().title : "title");
  const emailKey = () => (typeof contact().email === "string" ? contact().email : null);
  const phoneKey = () => (typeof contact().phone === "string" ? contact().phone : null);
  // The picture is the one-file attachment; the files, the many.
  const imageField = () => (ptype ? ptype.fields.find((f) => f.kind === "attachment" && !f.many) : null) || null;
  const filesField = () => (ptype ? ptype.fields.find((f) => f.kind === "attachment" && f.many) : null) || null;
  // A card's organization and role land in the type's fields of those names, if it has them — vCard's words.
  const cardKey = (k) => (field(k) ? k : null);

  const props = () => (got && got.entity && got.entity.properties) || {};
  const asList = (v) => (Array.isArray(v) ? v.map(String) : v == null || v === "" ? [] : [String(v)]);
  const ties = () => ((got && got.entity && got.entity["talaris:sources"]) || []).filter((s) => s.kind === "eds-contact").map((s) => s.key);
  const noContact = () => Boolean(got && got.entity && got.entity["talaris:noContact"]);

  // ---------------------------------------------------------------- days
  //
  // A date is wall-clock "YYYY-MM-DD"; a datetime adds "THH:MM".

  const pad = (n) => String(n).padStart(2, "0");
  const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
  const sameDay = (a, b) => a && b && a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  const isoDay = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const dayLabel = (d) => Kit.day(d, { weekday: false });
  const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  function readIso(v) {
    const m = String(v || "").match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/);
    return m ? { day: new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])), time: m[4] ? `T${m[4]}:${m[5]}` : "" } : { day: null, time: "" };
  }
  // A birthday is mostly in the past: read as every page reads a day (kit.js), the year kept as typed or this one.
  const parseDay = (text) => Kit.parseDay(text, { past: true });

  // ---------------------------------------------------------------- the one pop at a time
  //
  // No browser pickers — a <select>, a date or a file field opens a window of
  // the engine's own, which a layer surface cannot hold — so menus and days
  // are small lists drawn in the page.

  let popFor = null;
  function popPlace(left, top, content, anchor) {
    const pop = $("pop");
    pop.replaceChildren(content);
    pop.hidden = false;
    popFor = anchor || null;
    const box = document.body.getBoundingClientRect();
    const w = pop.offsetWidth, h = pop.offsetHeight;
    pop.style.left = `${Math.max(4, Math.min(left - box.left, box.width - w - 6))}px`;
    pop.style.top = `${Math.max(4, Math.min(top - box.top, box.height - h - 6))}px`;
  }
  function popUnder(anchor, content) { const r = anchor.getBoundingClientRect(); popPlace(r.left, r.bottom + 4, content, anchor); }
  function popAway() { $("pop").hidden = true; popFor = null; }
  // A press elsewhere puts it away; a press on what opened it is that one's to decide.
  document.addEventListener("pointerdown", (e) => {
    if ($("pop").hidden || $("pop").contains(e.target)) return;
    if (popFor && popFor.contains(e.target)) return;
    popAway();
  }, true);

  function menuAt(x, y, items, anchor) {
    popPlace(x, y, el("div", { class: "menu-list" }, items.map((it) => (it === "sep" ? el("div", { class: "menu-sep" })
      : el("button", { class: "menu-item" + (it.on ? " on" : ""), onclick: (ev) => { ev.stopPropagation(); popAway(); it.act(); } }, it.label)))), anchor);
  }

  // Years as well as months: a birthday is decades back.
  function monthPicker(chosenDay, pick) {
    let month = new Date((chosenDay || new Date()).getFullYear(), (chosenDay || new Date()).getMonth(), 1);
    const wrap = el("div", { class: "mini" });
    const step = (n) => (e) => { e.stopPropagation(); month = new Date(month.getFullYear(), month.getMonth() + n, 1); draw(); };
    const draw = () => {
      const first = addDays(month, -month.getDay());
      wrap.replaceChildren(
        el("div", { class: "mini-head" },
          el("button", { class: "icon-btn", title: "A year back", onclick: step(-12) }, "«"),
          el("button", { class: "icon-btn", title: "A month back", onclick: step(-1) }, "‹"),
          el("span", {}, Kit.month(month)),
          el("button", { class: "icon-btn", title: "A month on", onclick: step(1) }, "›"),
          el("button", { class: "icon-btn", title: "A year on", onclick: step(12) }, "»")),
        el("div", { class: "mini-grid" },
          ["S", "M", "T", "W", "T", "F", "S"].map((d) => el("span", { class: "dow" }, d)),
          Array.from({ length: 42 }, (_, i) => {
            const d = addDays(first, i);
            return el("button", { class: "day" + (d.getMonth() !== month.getMonth() ? " other" : "") + (sameDay(d, chosenDay) ? " on" : "") + (sameDay(d, new Date()) ? " today" : ""),
              onclick: (e) => { e.stopPropagation(); popAway(); pick(d); } }, String(d.getDate()));
          })));
    };
    draw();
    return wrap;
  }

  // ---------------------------------------------------------------- marks

  // As the canvas's person card (EntityCard.tsx): a tint by the id, so a rename does not repaint them.
  const TINTS = ["var(--accent)", "var(--danger)", "#6f93ad", "#7d9c6c", "#9c82b4", "#b39b5f"];
  function tint(id) {
    let h = 0;
    for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
    return `color-mix(in srgb, ${TINTS[Math.abs(h) % TINTS.length]} 45%, var(--surface))`;
  }
  function initials(name) {
    const w = String(name || "").split("@")[0].split(/[\s._-]+/).filter((x) => /[\p{L}\p{N}]/u.test(x));
    if (!w.length) return "?";
    const first = [...w[0]];
    return (w.length > 1 ? first[0] + [...w[w.length - 1]][0] : first.slice(0, 2).join("")).toUpperCase();
  }
  // A picture's bytes, once each: a data: URL needs its type, read from the bytes' first few.
  const pictures = new Map();
  function picture(sha) {
    if (!pictures.has(sha)) {
      pictures.set(sha, api("GET", `/files/${enc(sha)}`).then((f) => {
        const head = atob(String(f.data || "").slice(0, 24));
        const type = head.startsWith("\x89PNG") ? "image/png" : head.startsWith("\xFF\xD8") ? "image/jpeg"
          : head.startsWith("RIFF") && head.slice(8, 12) === "WEBP" ? "image/webp" : head.startsWith("GIF8") ? "image/gif" : null;
        return type ? `data:${type};base64,${f.data}` : null;
      }).catch(() => { pictures.delete(sha); return null; }));
    }
    return pictures.get(sha);
  }
  function avatar(id, name, sha, attrs = {}) {
    const a = el(attrs.tag || "span", { class: "av" + (attrs.big ? " big" : ""), style: `background-color:${tint(id)}`, title: attrs.title, onclick: attrs.onclick }, initials(name));
    if (sha) picture(sha).then((url) => { if (url) { a.style.backgroundImage = `url("${url}")`; a.classList.add("pic"); } });
    return a;
  }

  // ---------------------------------------------------------------- the left
  //
  // Each row as /people has it; a refresh keeps the one chosen and where the list was scrolled.

  const byName = (a, b) => a.localeCompare(b, undefined, { sensitivity: "base" });
  const NO_ORG = "No organization";
  function matches(p, q) {
    if (!q) return true;
    return [p.title, p.organization, p.role, p.email].some((x) => x && x.toLowerCase().includes(q));
  }
  // Known by a name, or only by an address (a name is what the person has unless it is just their address).
  const unnamed = (p) => /^[^\s@]+@[^\s@]+$/.test(String(p.title || "").trim()) || !String(p.title || "").trim();
  let named = store.get("talaris.people.named", "all");
  // Has an organization, is in one of mine (marked on a group's heading, kept by the core), or has none —
  // apart from how the list is grouped and the other filters. None chosen: everyone.
  let orgd = store.get("talaris.people.orgd", "all");
  let myOrgs = [];
  const hasOrg = (p) => Boolean(String(p.organization || "").trim());
  const isMine = (org) => myOrgs.some((m) => m.toLowerCase() === String(org || "").trim().toLowerCase());
  const ORGD = { all: () => true, has: hasOrg, mine: (p) => isMine(p.organization), none: (p) => !hasOrg(p) };
  function shown() {
    const q = $("q").value.trim().toLowerCase();
    return people.filter((p) => matches(p, q) && (named === "all" || (named === "named") !== unnamed(p)) && (ORGD[orgd] || ORGD.all)(p));
  }
  function markMine(org, on) {
    const next = on ? [...myOrgs, org] : myOrgs.filter((m) => m.toLowerCase() !== org.toLowerCase());
    api("PUT", "/people/my-organizations", { names: next }).then((kept) => { myOrgs = kept || []; drawList(); }).catch((e) => say(e.message, true));
  }

  function personRow(p) {
    const sub = [p.role, p.email].filter(Boolean).join(" · ");
    return el("div", { class: "prow" + (p.id === chosen ? " on" : ""), "data-id": p.id, onclick: () => { choose(p.id); $("list").focus(); } },
      avatar(p.id, p.title, p.image),
      el("div", { class: "p-main" }, el("div", { class: "p-name" }, p.title), sub ? el("div", { class: "p-sub" }, sub) : null),
      // Filled, tied to a card in your address books; a hollow ring, not yet; nothing, for one you said not to look for.
      p.ties.length ? el("span", { class: "tie tied", title: "In your address books" })
        : !p.noContact ? el("span", { class: "tie untied", title: "Not in your address books yet" }) : null);
  }
  function toggleGroup(g) {
    if (shut.has(g)) shut.delete(g); else shut.add(g);
    store.set("talaris.people.shut", [...shut]);
    drawList();
  }

  function drawList() {
    const list = $("list");
    const rows = shown();
    $("count").textContent = rows.length === people.length ? String(people.length) : `${rows.length} of ${people.length}`;
    const out = [];
    if (!people.length) out.push(el("div", { class: "empty" }, "No people yet"));
    else if (!rows.length) out.push(el("div", { class: "empty" }, "No one by that"));
    else if (mode === "org") {
      const groups = new Map();
      for (const p of rows) { const g = p.organization || NO_ORG; groups.set(g, [...(groups.get(g) || []), p]); }
      const names = [...groups.keys()].filter((g) => g !== NO_ORG).sort(byName);
      if (groups.has(NO_ORG)) names.push(NO_ORG);
      // Searching opens every group: what was found is shown. A shut group still shows the one chosen.
      const searching = Boolean($("q").value.trim());
      for (const g of names) {
        const mine = groups.get(g);
        const folded = !searching && shut.has(g);
        const own = g !== NO_ORG && isMine(g);
        out.push(el("div", { class: "ghead" + (folded ? " folded" : "") + (own ? " own" : ""), title: own ? `${g} — one of my organizations` : g, onclick: () => toggleGroup(g),
          oncontextmenu: (e) => {
            if (g === NO_ORG) return;
            e.preventDefault();
            menuAt(e.clientX, e.clientY, [{ label: own ? "Not one of my organizations" : "One of my organizations", act: () => markMine(g, !own) }]);
          } },
          el("span", { class: "caret" }, "▾"), el("span", { class: "name" }, g), own ? el("span", { class: "own-mark" }, "Mine") : null, el("span", { class: "n" }, String(mine.length))));
        out.push(...mine.filter((p) => !folded || p.id === chosen).map(personRow));
      }
    } else {
      let letter = null;
      for (const p of rows) {
        const first = (p.title.match(/\p{L}/u) || ["#"])[0].toLocaleUpperCase();
        const l = /\p{L}/u.test(first) ? first : "#";
        if (l !== letter) { letter = l; out.push(el("div", { class: "letter" }, l)); }
        out.push(personRow(p));
      }
    }
    const top = list.scrollTop;
    list.replaceChildren(...out);
    list.scrollTop = top;
  }

  function drawMode() {
    seg("mode", [["org", "Organization"], ["az", "A–Z"]], mode, (m) => { mode = m; store.set("talaris.people.mode", m); drawMode(); drawList(); });
    seg("named", [["all", "All"], ["named", "Named"], ["unnamed", "No name"]], named, (n) => { named = n; store.set("talaris.people.named", n); drawMode(); drawList(); });
    // Pressed again, the one chosen lets go: everyone.
    seg("orgd", [["has", "Has organization"], ["mine", "My organizations"], ["none", "No organization"]], orgd, (o) => {
      orgd = o === orgd ? "all" : o; store.set("talaris.people.orgd", orgd); drawMode(); drawList();
    });
  }

  async function loadPeople() {
    [people, myOrgs] = await Promise.all([api("GET", "/people").then((x) => x || []), api("GET", "/people/my-organizations").catch(() => [])]);
    drawList();
  }

  // ---------------------------------------------------------------- the one chosen

  let loadSeq = 0;
  function choose(id) {
    if (id === chosen && got) return;
    chosen = id;
    store.set("talaris.people.chosen", id);
    for (const r of document.querySelectorAll(".prow")) r.classList.toggle("on", r.dataset.id === id);
    const row = document.querySelector(`.prow[data-id="${CSS.escape(id || "")}"]`);
    if (row) row.scrollIntoView({ block: "nearest" });
    loadPerson().catch(failed);
  }
  async function loadPerson() {
    const id = chosen;
    const want = ++loadSeq;
    if (!id) { got = null; drawPerson(); return; }
    let g;
    try { g = await api("GET", `/entities/${enc(id)}?shown=1`); } catch (e) {
      if (want !== loadSeq) return;
      // Gone since: the first there is instead.
      chosen = null; got = null;
      if (people.length) { choose(people[0].id); return; }
      drawPerson();
      return;
    }
    if (want !== loadSeq) return;
    got = g;
    drawPerson();
  }
  // What /people lists has changed with them; the row is drawn again, the right pane left as typed.
  async function changed(entity) {
    if (entity && got && entity.id === chosen) got.entity = entity;
    await loadPeople();
  }
  async function patch(body) {
    const id = chosen;
    const out = await api("PATCH", `/entities/${enc(id)}`, body);
    say("");
    if (id === chosen) await changed(out && out.id ? out : null);
    return out;
  }
  const setProps = (p) => patch({ properties: p }).catch(failed);

  // ---------------------------------------------------------------- the right pane

  function putAwayEditors() { for (const ed of editors) { try { ed.destroy(); } catch { /* gone */ } } editors = []; }

  function drawPerson() {
    putAwayEditors();
    popAway();
    const host = $("person");
    if (!got || !ptype) { host.replaceChildren(people.length ? "" : el("div", { class: "empty" }, "No people yet")); return; }
    const top = host.scrollTop;
    const same = host.dataset.id === chosen;
    host.dataset.id = chosen;
    host.replaceChildren(head(), fieldsPart(), contactsPart(), connectedPart(), foot());
    host.scrollTop = same ? top : 0;
  }

  function head() {
    const p = props();
    const img = imageField();
    const sha = img && p[img.key] && p[img.key].sha256;
    const name = el("input", { type: "text", class: "name-in", id: "name-in", value: p[titleKey()] || "", placeholder: "Their name", spellcheck: "false" });
    let kept = p[titleKey()] || "";
    const save = () => {
      const v = name.value.trim();
      if (!v) { name.value = kept; return; }
      if (v === kept) return;
      kept = v;
      setProps({ [titleKey()]: v });
    };
    name.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); name.blur(); }
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); name.value = kept; name.blur(); }
    });
    name.addEventListener("blur", save);
    const av = avatar(chosen, got.title, sha, { tag: "button", big: true, title: img ? "Picture" : null,
      onclick: (e) => {
        if (!img) return;
        if (popFor === e.currentTarget) { popAway(); return; }
        const r = e.currentTarget.getBoundingClientRect();
        menuAt(r.left, r.bottom + 4, [
          { label: "Choose a picture…", act: () => { say(""); bridge && bridge.attach(chosen, img.key); } },
          sha ? { label: "Remove picture", act: () => setProps({ [img.key]: null }).then(drawPerson) } : null,
        ].filter(Boolean), e.currentTarget);
      } });
    // Where else they live (a sync's way back to them), under their name.
    // And what plugins put on a person (Sync now), filled in when the core answers.
    const elsewhere = window.Peek ? [...Peek.elsewhereButtons(got.entity, (u) => bridge && bridge.openUrl(u)), Peek.actionButtons("person", got.entity.id, api),
      Peek.glanceButton(`e:${got.entity.id}`, bridge && bridge.glanceAt ? (k) => bridge.glanceAt(k) : null)].filter(Boolean) : [];
    return el("div", { class: "p-head" }, av, elsewhere.length ? el("div", { class: "p-name" }, name, el("div", { class: "p-elsewhere" }, ...elsewhere)) : name);
  }

  // ---- a field, by its kind

  const row = (label, kids, top = false) => el("div", { class: "f-row" + (top ? " top" : "") }, el("span", { class: "lab" }, label), kids);

  /** One line of text: saved on Enter or leaving it. */
  function lineField(f) {
    let kept = props()[f.key] == null ? "" : String(props()[f.key]);
    const input = el("input", { type: "text", class: "field", value: kept, spellcheck: "false" });
    const save = () => {
      const v = input.value.trim();
      if (v === kept.trim()) return;
      let value = v || null;
      if (f.kind === "number" && v) {
        value = Number(v);
        if (Number.isNaN(value)) { input.classList.add("bad"); say(`${labelOf(f)} isn't a number`, true); return; }
      }
      input.classList.remove("bad");
      kept = v;
      setProps({ [f.key]: value });
    };
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); input.blur(); } });
    input.addEventListener("blur", save);
    return row(labelOf(f), el("div", { class: "grow" }, input));
  }

  /**
   * Several values — addresses, phones, websites — one to a line, since one
   * of them may hold commas (a postal address does). A new line appears as
   * the last is filled; leaving the lines saves them all.
   */
  function manyField(f) {
    let kept = asList(props()[f.key]);
    const box = el("div", { class: "grow col" });
    const read = () => [...box.querySelectorAll("input")].map((i) => i.value.trim()).filter(Boolean);
    const draw = (vals) => {
      const lines = [...vals, ""];
      box.replaceChildren(...lines.map((val, i) => el("input", { type: "text", class: "field", value: val, spellcheck: "false", placeholder: i ? "Another" : "",
        oninput: (e) => {
          // Typing in the last line opens one more under it.
          if (i === box.children.length - 1 && e.target.value.trim()) box.append(el("input", { type: "text", class: "field", spellcheck: "false", placeholder: "Another",
            oninput: (ev) => { if (ev.target === box.lastElementChild && ev.target.value.trim()) { const vals2 = [...box.querySelectorAll("input")].map((x) => x.value); draw(vals2.filter((x, j) => x.trim() || j < vals2.length - 1)); box.children[vals2.length - 1].focus(); } } }));
        },
        onkeydown: (e) => { if (e.key === "Enter") { e.preventDefault(); (box.children[i + 1] || e.target).focus(); if (!box.children[i + 1]) e.target.blur(); } } })));
    };
    const save = () => {
      const now = read();
      if (now.join("\n") === kept.join("\n")) return;
      kept = now;
      setProps({ [f.key]: now.length ? now : null });
    };
    box.addEventListener("focusout", (e) => { if (!box.contains(e.relatedTarget)) { save(); draw(kept); } });
    draw(kept);
    return row(labelOf(f), box, true);
  }

  /** A day: typed or picked; a datetime keeps the time it had. */
  function dayField(label, value, put) {
    const { day, time } = readIso(value);
    const input = el("input", { type: "text", class: "field day", value: day ? dayLabel(day) : "", placeholder: "10/30/1980", spellcheck: "false" });
    const save = () => {
      const t = input.value.trim();
      if (!t) { input.classList.remove("bad"); if (day) put(null); return; }
      const d = parseDay(t);
      if (!d) { input.classList.add("bad"); say(`${label}: that isn't a day I can read`, true); return; }
      input.classList.remove("bad");
      input.value = dayLabel(d);
      if (!sameDay(d, day)) put(isoDay(d) + time);
    };
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); input.blur(); } });
    input.addEventListener("change", save);
    const pick = el("button", { class: "icon-btn", title: "Choose a day", onclick: (e) => {
      if (popFor === pick) { popAway(); return; }
      e.stopPropagation();
      popUnder(pick, monthPicker(parseDay(input.value) || day, (d) => { input.value = dayLabel(d); save(); }));
    } }, "▾");
    return [input, pick];
  }

  function enumField(f) {
    const now = props()[f.key];
    const labels = f["talaris:labels"] || {};
    const host = el("div", { class: "grow chips" });
    // A press on the one chosen takes it off again.
    host.append(...(f.options || []).map((o) => el("button", { class: "t-btn tog" + (now === o ? " on" : ""),
      onclick: () => setProps({ [f.key]: now === o ? null : o }).then(drawPerson) }, labels[o] || words(o))));
    return row(labelOf(f), host);
  }

  /** Things it points at, as chips, with a small search for one more. */
  function refField(f) {
    const ids = asList(props()[f.key]);
    const titles = new Map(((got && got.out) || []).filter((c) => c.name === f.key).map((c) => [c.entity.id, c.entity.title]));
    const put = (next) => setProps({ [f.key]: next.length ? (f.many ? next : next[0]) : null }).then(() => loadPerson());
    const add = el("button", { class: "add", title: "Add", onclick: () => {
      if (popFor === add) { popAway(); return; }
      const find = el("input", { type: "text", class: "find", placeholder: "Find", spellcheck: "false" });
      const list = el("div", { class: "menu-list" });
      let found = [];
      const search = async () => {
        const q = find.value.trim();
        const asked = q;
        const got2 = ((await api("GET", `/entities?q=${enc(q)}&limit=40`).catch(() => [])) || [])
          .filter((x) => (!f.targetType || x.type === f.targetType) && !x.stub && !ids.includes(x.id) && x.id !== chosen).slice(0, 12);
        if (find.value.trim() !== asked) return;
        found = got2;
        list.replaceChildren(...found.map((x) => el("button", { class: "menu-item", onclick: (e) => { e.stopPropagation(); popAway(); put(f.many ? [...ids, x.id] : [x.id]); } }, x.title)));
      };
      find.addEventListener("input", search);
      find.addEventListener("keydown", (e) => { if (e.key === "Enter" && found[0]) { popAway(); put(f.many ? [...ids, found[0].id] : [found[0].id]); } });
      popUnder(add, el("div", {}, find, list));
      search();
      setTimeout(() => find.focus(), 0);
    } }, "+");
    return row(labelOf(f), el("div", { class: "grow chips" },
      ids.map((id) => el("span", { class: "chip-p" }, el("span", { class: "fname" }, titles.get(id) || "Unknown"),
        el("button", { title: "Remove", onclick: () => put(ids.filter((x) => x !== id)) }, "×"))),
      f.many || !ids.length ? add : null));
  }

  /** The description, and any long text: the editor, so @ links in it. */
  function writingField(f) {
    const host = el("div", { class: "grow ed-field ed-body" });
    let kept = props()[f.key] || "";
    import("./editor.js").then((m) => {
      if (!host.isConnected) return;
      const ed = m.createEditor(host, kept, { live: true, compact: true, mentions: TalarisMentions(api, openMention, mentionOpts), placeholder: "@ to link a person, event or task" });
      editors.push(ed);
      host.addEventListener("focusout", (e) => {
        if (host.contains(e.relatedTarget)) return;
        const v = ed.text;
        if (v === kept) return;
        kept = v;
        setProps({ [f.key]: v.trim() ? v : null });
      });
    }).catch(failed);
    return row(labelOf(f), host, true);
  }

  /** Files kept with them: a press opens one; × takes it off. */
  function filesRow(f) {
    const files = Array.isArray(props()[f.key]) ? props()[f.key] : [];
    return row(labelOf(f), el("div", { class: "grow chips" },
      files.map((a) => el("span", { class: "chip-p file", title: `Open ${a.filename}`, onclick: () => bridge && bridge.openFile(a.sha256, a.filename) },
        el("span", { class: "fname" }, a.filename),
        el("button", { title: "Take off", onclick: (e) => {
          e.stopPropagation();
          const rest = files.filter((x) => x.sha256 !== a.sha256);
          setProps({ [f.key]: rest.length ? rest : null }).then(drawPerson);
        } }, "×"))),
      el("button", { class: "t-btn", onclick: () => { say(""); bridge && bridge.attach(chosen, f.key); } }, "Add files…")), true);
  }

  function fieldRow(f) {
    const label = labelOf(f);
    switch (f.kind) {
      case "text": return f.many ? manyField(f) : lineField(f);
      case "number": return lineField(f);
      case "richtext": return writingField(f);
      case "boolean": {
        const on = Boolean(props()[f.key]);
        return row(label, el("button", { class: "switch" + (on ? " on" : ""), title: on ? "Yes" : "No", onclick: () => setProps({ [f.key]: on ? null : true }).then(drawPerson) }));
      }
      case "date": case "datetime":
        return row(label, el("div", { class: "grow chips" }, dayField(label, props()[f.key], (v) => setProps({ [f.key]: v }))));
      case "datespan": {
        const span = props()[f.key] || {};
        const put = (part) => (v) => {
          const next = { ...(props()[f.key] || {}) };
          if (v) next[part] = v; else delete next[part];
          setProps({ [f.key]: next.start || next.end ? next : null });
        };
        return [row(f.startLabel || "From", el("div", { class: "grow chips" }, dayField(f.startLabel || "From", span.start, put("start")))),
          row(f.endLabel || "To", el("div", { class: "grow chips" }, dayField(f.endLabel || "To", span.end, put("end"))))];
      }
      case "enum": return enumField(f);
      case "reference": return refField(f);
      case "attachment": return f.many ? filesRow(f) : null; // the one-file one is the picture, drawn as the mark
      default: return null;
    }
  }

  function fieldsPart() {
    const rows = ptype.fields.filter((f) => !f["talaris:auto"] && f.key !== titleKey()).map(fieldRow).flat().filter(Boolean);
    return el("section", { class: "part fields" }, rows);
  }

  // ---------------------------------------------------------------- contact cards
  //
  // Cards are the address books' (answered by the calendar's helper); a tie
  // is the person's, kept in the core. Nothing of a card is copied unless asked.

  const cardKeyOf = (c) => `${c.book}/${c.uid}`;
  function cardLines(c) {
    return [
      c.emails && c.emails.length ? el("div", { class: "c-line" }, c.emails.join(", ")) : null,
      c.phones && c.phones.length ? el("div", { class: "c-line" }, c.phones.join(", ")) : null,
      c.org || c.role ? el("div", { class: "c-line" }, [c.role, c.org].filter(Boolean).join(" · ")) : null,
    ];
  }
  async function tie(key, on) {
    const id = chosen;
    try {
      const e = on ? await api("POST", `/people/${enc(id)}/ties`, { key }) : await api("DELETE", `/people/${enc(id)}/ties?key=${enc(key)}`);
      if (id !== chosen) return;
      await changed(e && e.id ? e : null);
      if (!(e && e.id)) await loadPerson(); else drawPerson();
    } catch (err) { failed(err); }
  }

  /** What a card has and Talaris doesn't: empty fields filled, addresses and numbers added; nothing overwritten. */
  // What a contact has that this person doesn't yet: only that is offered, and copied.
  function copyCard(c) {
    const out = newFrom(c);
    if (!Object.keys(out).length) { say("Nothing there that isn't here already"); return; }
    setProps(out).then(() => { drawPerson(); say("Copied in"); });
  }
  function newFrom(c) {
    const p = props();
    const out = {};
    const fill = (key, val) => {
      if (!key || !val) return;
      const f = field(key);
      if (!f) return;
      if (f.many) {
        const have = asList(p[key]);
        const low = have.map((x) => x.toLowerCase());
        const more = asList(val).filter((x) => x.trim() && !low.includes(x.trim().toLowerCase()));
        if (more.length) out[key] = [...have, ...more];
      } else if (!String(p[key] ?? "").trim()) out[key] = Array.isArray(val) ? val[0] : val;
    };
    fill(cardKey("organization"), c.org);
    fill(cardKey("role"), c.role);
    fill(emailKey(), c.emails);
    fill(phoneKey(), c.phones);
    return out;
  }

  // Someone else here tied to the same card: one person entered twice — made one here, the one another app keeps in step kept.
  async function makeOne(other) {
    try {
      const r = await api("POST", "/suggestions/accept", { key: `e:${chosen}`, other: `e:${other.id}`, way: { how: "merge", label: `Merge with ${other.title}` } });
      say(r.said || "Made one");
      const kept = String(r.kept || "").replace(/^e:/, "") || chosen;
      await loadPeople();
      got = null;
      choose(kept);
    } catch (err) { failed(err); }
  }

  function tiedCard(c, others = []) {
    const key = cardKeyOf(c);
    const also = others.length ? el("div", { class: "c-line c-also" }, `Also ${others.map((o) => o.title).join(", ")} here — the same person? `,
      ...others.map((o) => el("button", { class: "t-btn", title: `Make ${o.title} and this one one person: what is tied to either is tied to the one kept, and nothing is lost`,
        onclick: () => makeOne(o) }, others.length > 1 ? `Make one with ${o.title}` : "Make them one"))) : null;
    if (c.gone) {
      return el("div", { class: "card gone" },
        el("div", { class: "c-main" }, el("div", { class: "c-name" }, "No longer in your address books")),
        el("div", { class: "c-acts" }, el("button", { class: "t-btn", onclick: () => tie(key, false) }, "Disconnect")));
    }
    return el("div", { class: "card" },
      el("div", { class: "c-main" },
        el("div", { class: "c-book" }, c.bookName || c.book),
        el("div", { class: "c-name" }, c.name || "No name"),
        cardLines(c), also),
      el("div", { class: "c-acts" },
        // Only when it has something this person doesn't.
        Object.keys(newFrom(c)).length ? el("button", { class: "t-btn", title: `Add what Talaris doesn't have yet (${Object.keys(newFrom(c)).map(lower).join(", ")}); nothing is overwritten`, onclick: () => copyCard(c) }, "Copy into Talaris") : null,
        el("button", { class: "t-btn", onclick: () => tie(key, false) }, "Disconnect")));
  }
  function likelyCard(c) {
    return el("div", { class: "card likely" },
      el("div", { class: "c-main" },
        el("div", { class: "c-name" }, c.name || "No name", el("span", { class: "hint" }, `  ${c.bookName || c.book}`)),
        cardLines(c)),
      el("div", { class: "c-acts" }, el("button", { class: "t-btn", onclick: () => tie(cardKeyOf(c), true) }, "Connect")));
  }

  // Ranked: the same address, then the name exactly, then a name that holds theirs (or theirs it).
  function rank(cards, name, emails) {
    const n = name.trim().toLowerCase();
    const mine = new Set(emails.map((x) => x.trim().toLowerCase()));
    const score = (c) => {
      if ((c.emails || []).some((x) => mine.has(String(x).trim().toLowerCase()))) return 3;
      const cn = String(c.name || "").trim().toLowerCase();
      if (n && cn === n) return 2;
      if (n && cn && (cn.includes(n) || n.includes(cn))) return 1;
      return 0;
    };
    return cards.map((c) => ({ c, s: score(c) })).filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s || byName(String(a.c.name || ""), String(b.c.name || ""))).map((x) => x.c);
  }

  function contactsPart() {
    const id = chosen;
    const tiedHost = el("div", {});
    const likelyHost = el("div", {});
    const keys = ties();
    if (keys.length) {
      tiedHost.append(el("div", { class: "hint" }, "Reading your address books…"));
      Promise.all([api("GET", `/contacts/cards?keys=${enc(keys.join(","))}`), api("GET", `/people/${enc(id)}/same-card`).catch(() => [])]).then(([cards, same]) => {
        if (id !== chosen) return;
        tiedHost.replaceChildren(...(cards || []).map((c) => tiedCard(c, (same || []).filter((o) => o.key === cardKeyOf(c)))));
      }).catch((e) => tiedHost.replaceChildren(el("div", { class: "hint err" }, e.message)));
    }
    if (!noContact()) drawLikely(likelyHost, id, keys);
    const off = noContact();
    const sw = el("button", { class: "switch" + (off ? " on" : ""), title: off ? "On" : "Off" });
    return el("section", { class: "part" },
      el("h3", {}, el("span", {}, "In your address books")),
      tiedHost, likelyHost,
      el("label", { class: "nocontact", onclick: () => patch({ "talaris:noContact": off ? null : true }).then(drawPerson).catch(failed) },
        sw, el("span", {}, "Don't look for them in address books")));
  }

  function drawLikely(host, id, tied) {
    const p = props();
    const name = String(p[titleKey()] || "");
    const emails = asList(emailKey() ? p[emailKey()] : []).filter((x) => x.includes("@"));
    const asks = [name.trim(), ...emails].filter((q) => q.trim().length >= 2);
    const list = el("div", {}, el("div", { class: "hint" }, "Looking…"));
    const find = el("input", { type: "text", id: "card-q", placeholder: "Find someone by name or address", spellcheck: "false" });
    const found = el("div", {});
    let timer = null;
    find.addEventListener("input", () => {
      clearTimeout(timer);
      const q = find.value.trim();
      if (q.length < 2) { found.replaceChildren(); return; }
      timer = setTimeout(() => api("GET", `/contacts/cards?q=${enc(q)}`).then((cards) => {
        if (id !== chosen || find.value.trim() !== q) return;
        const rows = (cards || []).filter((c) => !c.gone && !tied.includes(cardKeyOf(c))).slice(0, 8);
        found.replaceChildren(...(rows.length ? rows.map(likelyCard) : [el("div", { class: "hint" }, "No one by that")]));
      }).catch((e) => found.replaceChildren(el("div", { class: "hint err" }, e.message))), 250);
    });
    find.addEventListener("keydown", (e) => { if (e.key === "Escape" && find.value) { e.preventDefault(); e.stopPropagation(); find.value = ""; found.replaceChildren(); } });
    host.append(el("div", { class: "sub-h" }, "Likely the same person"), list, find, found);
    Promise.all(asks.map((q) => api("GET", `/contacts/cards?q=${enc(q)}`).catch(() => []))).then((answers) => {
      if (id !== chosen) return;
      const byKey = new Map();
      for (const c of answers.flat()) if (c && !c.gone && !tied.includes(cardKeyOf(c)) && !byKey.has(cardKeyOf(c))) byKey.set(cardKeyOf(c), c);
      const best = rank([...byKey.values()], name, emails).slice(0, 6);
      list.replaceChildren(...(best.length ? best.map(likelyCard) : [el("div", { class: "hint" }, tied.length ? "No one else likely" : "No one likely in your address books")]));
    });
  }

  // ---------------------------------------------------------------- connected
  //
  // Everything they touch, either way, once each — grouped by what it is,
  // newest first, each saying how it is linked, in peek.js's words.

  const BACK = { mentions: "mentioned in", attendees: "invited to", organizer: "organizer of", invitees: "invited to", assignee: "assigned", project: "filed here" };
  const OUT = { mentions: "mentioned", attendees: "invited", organizer: "organizer", invitees: "invited", project: "project" };
  const GROUP = { contact: "People", event: "Events", task: "Tasks", note: "Pages", project: "Projects" };
  const lower = (key) => String(key).replace(/_/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
  const FIRST = 20;
  const openPlace = (p) => bridge && bridge.openPlace(p.kind, p.project, p.where);
  const mentionOpts = { project: () => "", openPlace };
  // A person among the links is chosen here, in the list; anything else is its card.
  const peek = (id) => window.Peek && Peek.show(id, api, { openPlace, openPerson: (pid) => window.People.show(pid),
    openTask: (tid) => bridge && bridge.openTask(tid), openEvent: (c, u, s) => bridge && bridge.openEvent(c, u, s), openUrl: (u) => bridge && bridge.openUrl(u) });
  // A mention in the description: one of these people is chosen here; anything else peeks.
  function openMention(id) {
    if (people.some((p) => p.id === id)) { choose(id); return; }
    peek(id);
  }

  const ARCHIVED = "In archived projects";
  function linkGroup(name, rows) {
    // What lives in an archived project starts folded: its label opens it.
    let count = name === ARCHIVED ? 0 : FIRST;
    const list = el("div", {});
    const more = el("div", { class: "c-more" });
    const draw = () => {
      list.replaceChildren(...rows.slice(0, count).map(({ e, how }) => el("button", { class: "c-item", onclick: () => peek(e.id) },
        el("span", { class: "c-t" }, e.title), el("span", { class: "c-how" }, how.join(", ")))));
      const left = rows.length - count;
      more.replaceChildren(...(left > 0 ? [
        el("button", { class: "t-btn", onclick: () => { count += FIRST; draw(); } }, `${Math.min(FIRST, left)} more`),
        left > FIRST ? el("button", { class: "t-btn", onclick: () => { count = rows.length; draw(); } }, `All ${rows.length}`) : null,
      ] : []).filter(Boolean));
    };
    draw();
    const label = el("div", { class: "c-label", style: name === ARCHIVED ? "cursor:pointer" : null }, `${name} · ${rows.length}`);
    if (name === ARCHIVED) label.addEventListener("click", () => { count = count ? 0 : FIRST; draw(); });
    return el("div", { class: "c-group" }, label, list, more);
  }

  function connectedPart() {
    // The person's own reference fields are drawn above; what they point at still counts as connected.
    const byId = new Map();
    const touch = (e, how) => {
      if (!e || e.id === chosen) return;
      const had = byId.get(e.id);
      if (had) { if (!had.how.includes(how)) had.how.push(how); return; }
      byId.set(e.id, { e, how: [how] });
    };
    // Less what Settings leaves out of connections (complete, archived, too old): said how many.
    const hide = new Set(got.hidden || []);
    for (const c of got.out || []) if (!hide.has(c.entity.id)) touch(c.entity, OUT[c.name] || lower(c.name));
    for (const c of got.in || []) if (!hide.has(c.entity.id)) touch(c.entity, BACK[c.name] || `${lower(c.name)} of`);
    const groups = new Map();
    for (const r of byId.values()) {
      const g = r.e.archived ? ARCHIVED : GROUP[(r.e.kinds || []).find((k) => GROUP[k])] || "Other";
      groups.set(g, [...(groups.get(g) || []), r]);
    }
    for (const rows of groups.values()) rows.sort((a, b) => String(b.e.updated || "").localeCompare(String(a.e.updated || "")));
    const order = [...Object.values(GROUP), "Other", ARCHIVED].filter((g) => groups.has(g));
    // And what they might be tied to and are not (suggest.ts): a tie made, the person drawn again.
    const sugg = window.Peek ? Peek.suggestions(`e:${chosen}`, api, {
      open: (id) => peek(id),
      openPlace,
      changed: (r) => { say(r.said || "Done"); drawPerson(); },
    }) : null;
    return el("section", { class: "part" },
      el("h3", {}, el("span", {}, "Connected")),
      order.length ? order.map((g) => linkGroup(g, groups.get(g))) : el("div", { class: "hint" }, hide.size ? "Nothing connected shown" : "Nothing connected yet"),
      hide.size > 0 && window.Peek ? el("div", { class: "hint" }, Peek.hiddenSaid(hide.size)) : null,
      sugg);
  }

  // ---------------------------------------------------------------- making and removing

  function foot() {
    const host = el("div", { class: "p-foot" });
    const draw = (asking) => {
      host.replaceChildren(...(asking ? [
        el("span", {}, `Delete ${got.title}? This can't be undone.`),
        el("span", { class: "spacer" }),
        el("button", { class: "t-btn", id: "del-cancel", onclick: () => draw(false) }, "Cancel"),
        el("button", { class: "t-btn danger", onclick: remove }, "Delete"),
      ] : [
        el("span", { class: "spacer" }),
        el("button", { class: "t-btn danger", onclick: () => { draw(true); setTimeout(() => $("del-cancel") && $("del-cancel").focus(), 0); } }, "Delete person"),
      ]));
      host.classList.toggle("asking", asking);
    };
    draw(false);
    return host;
  }
  async function remove() {
    const id = chosen;
    // The neighbour below takes its place (or above, for the last).
    const order = shown().map((p) => p.id);
    const i = order.indexOf(id);
    const next = order[i + 1] || order[i - 1] || null;
    try {
      await api("DELETE", `/entities/${enc(id)}`);
      got = null;
      chosen = null;
      await loadPeople();
      if (next) choose(next); else drawPerson();
      say("");
    } catch (e) { failed(e); }
  }

  async function addPerson() {
    try {
      const made = await api("POST", "/entities", { role: "person", properties: { [titleKey()]: "New person" } });
      $("q").value = "";
      await loadPeople();
      chosen = null;
      choose(made.id);
      // The name is focused once it is drawn.
      const want = made.id;
      const wait = setInterval(() => {
        const n = $("name-in");
        if (chosen !== want) { clearInterval(wait); return; }
        if (n && $("person").dataset.id === want) { clearInterval(wait); n.focus(); n.select(); }
      }, 30);
      setTimeout(() => clearInterval(wait), 3000);
    } catch (e) { failed(e); }
  }

  // ---------------------------------------------------------------- loading

  async function start() {
    try {
      const types = (await api("GET", "/entity-types")) || [];
      ptype = types.find((t) => t["talaris:role"] === "person") || null;
      if (!ptype) say("There is no person type", true);
      await loadPeople();
      if (!chosen || !people.some((p) => p.id === chosen)) chosen = people.length ? people[0].id : null;
      got = null;
      const id = chosen;
      chosen = null;
      if (id) choose(id); else drawPerson();
      honour();
    } catch (e) { failed(e); }
  }
  // A person asked for from elsewhere while the list was loading: chosen once it is in.
  let wanted = null;
  function honour() {
    if (!wanted || !people.some((p) => p.id === wanted)) return;
    const id = wanted;
    wanted = null;
    if (chosen !== id) { chosen = null; choose(id); }
  }
  // Up again: the list read fresh; the one chosen, too, unless it is being typed in.
  async function refresh() {
    try {
      await loadPeople();
      if (!$("person").contains(document.activeElement)) await loadPerson();
      honour();
    } catch (e) { failed(e); }
  }

  // ---------------------------------------------------------------- keys and buttons

  const typing = (t) => t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
  $("list").addEventListener("keydown", (e) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const ids = [...$("list").querySelectorAll(".prow")].map((r) => r.dataset.id);
    if (!ids.length) return;
    const i = ids.indexOf(chosen);
    const next = i < 0 ? ids[0] : ids[Math.max(0, Math.min(ids.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))];
    if (next !== chosen) choose(next);
  });
  $("q").addEventListener("input", drawList);
  $("q").addEventListener("keydown", (e) => {
    if (e.key === "Escape" && $("q").value) { e.preventDefault(); e.stopPropagation(); $("q").value = ""; drawList(); }
    // Down from the search goes into the list.
    if (e.key === "ArrowDown" || e.key === "Enter") {
      e.preventDefault();
      const first = $("list").querySelector(".prow");
      if (first && !$("list").querySelector(".prow.on")) choose(first.dataset.id);
      $("list").focus();
    }
  });
  $("add").addEventListener("click", addPerson);

  document.addEventListener("keydown", (e) => {
    // Peek and the editor's @ picker keep their own Escape, and say so.
    if (e.defaultPrevented) return;
    if (e.key === "Escape") {
      e.preventDefault();
      const asking = document.querySelector(".p-foot.asking #del-cancel");
      if (!$("pop").hidden) popAway();
      else if (asking) asking.click();
      else if (bridge) bridge.file();
      return;
    }
    if (e.key === "/" && !e.ctrlKey && !e.metaKey && !e.altKey && !typing(document.activeElement)) {
      e.preventDefault();
      $("q").focus();
      $("q").select();
    }
  });

  drawMode();

  // A panel's one button makes it a window (the expand corners); a window's one
  // button closes it.
  $("grow").addEventListener("click", () => bridge && bridge.grow());
  $("close").addEventListener("click", () => bridge && bridge.closeWindow());
  $("grow").innerHTML = Icons.grow();
  $("grow").title = "Make it a window";
  $("grow").hidden = WINDOW;
  $("close").innerHTML = Icons.close();
  $("close").title = "Close";
  $("close").hidden = !WINDOW;
  // A press on the dim, off the panel, puts it away (and from Qt, which hears every press).
  document.addEventListener("pointerdown", (e) => { if (!WINDOW && e.target === document.documentElement && bridge && surface.up) bridge.file(); });
  window.pressedAt = (x, y) => { if (!WINDOW && bridge && surface.up && document.elementFromPoint(x, y) === document.documentElement) bridge.file(); };
  // In use: the panel's idle timer starts again.
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
    // What plugins put on the whole list (Sync all …), asked again each time it is out: a setting may have changed.
    if ((s.up && !was.up) || (WINDOW && !was.theme)) $("list-actions").replaceChildren(window.Peek ? Peek.actionButtons("people", null, api) : "");
    if (WINDOW) return;
    if (s.up && !was.up) {
      Motion.arrive(document.body, how());
      if (bridge && ptype) refresh();
    }
  }

  Surface.connect({ onState }).then((b) => {
    bridge = b;
    b.coreReply.connect((text) => { const r = JSON.parse(text); const done = waiting.get(r.id); waiting.delete(r.id); if (done) done(r); });
    // Files chosen and kept (or why not): the person drawn again with them.
    b.attached.connect((text) => {
      const r = JSON.parse(text);
      if (r.error) say(r.error, true);
      if (r.field === (imageField() || {}).key) pictures.clear();
      if (r.id === chosen) loadPerson().catch(failed);
      loadPeople().catch(failed);
    });
    b.leave.connect(() => {
      // The panel's leaving; a window is not going anywhere.
      if (WINDOW) return;
      surface = { ...surface, up: false };
      popAway();
      if (window.Peek) Peek.close();
      const going = Motion.leave(document.body, how());
      if (going) going.onfinish = () => bridge.left(); else bridge.left();
    });
    start();
  });

  // Asked from elsewhere (a person clicked in a page, a card, Glance): that person, shown,
  // whatever the list was narrowed to.
  window.People = {
    async show(id) {
      // Kept until the page's own loading is done with: it would otherwise choose the one it remembered.
      wanted = id;
      store.set("talaris.people.chosen", id);
      if (!people.some((p) => p.id === id)) await loadPeople().catch(() => {});
      $("q").value = "";
      if (named !== "all") { named = "all"; store.set("talaris.people.named", named); drawMode(); }
      drawList();
      chosen = null;
      choose(id);
      if (ptype) wanted = null;
    },
  };
})();
