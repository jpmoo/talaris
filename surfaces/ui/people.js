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

  let ptype = null;     // the type of the one on show: a person's, or an organization's
  let personType = null, orgType = null;
  let allTypes = [];
  let orgs = [];        // every organization, people or none (/people/organizations)
  let people = [];      // /people's rows
  let chosen = store.get("talaris.people.chosen", null);
  let got = null;       // the chosen one, as /entities/:id answers
  let mode = store.get("talaris.people.mode", "org");
  let shut = new Set(store.get("talaris.people.shut", []));
  let reviewing = false; // the right pane is the review of everyone, not one person

  // ---------------------------------------------------------------- the core

  // Two pages may share the bridge — the panel and its window — so each numbers
  // its requests from somewhere of its own, and takes only its own answers.
  // Asked of the core as every page asks it (kit.js): one book of what waits, 2xx the answer, given up on if none comes.
  const asked = Kit.core((id, method, path, body) => !!bridge && (bridge.core(id, method, path, body), true));
  const api = (method, path, body) => asked.call(method, path, body);
  const enc = encodeURIComponent;

  // Said as every page says it (kit.js): one line, sentence case, an error in the danger color.

  function say(text, error = false) { Kit.say($("msg"), text, error, 0); }
  const failed = (e) => say(e.message, true);

  // ---------------------------------------------------------------- the type's words

  const words = (key) => String(key).replace(/_/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (c) => c.toUpperCase());
  const labelOf = (f) => f["talaris:label"] || f.label || words(f.key);
  const field = (key) => (ptype && key ? ptype.fields.find((f) => f.key === key) : null) || null;
  const isOrg = () => Boolean(orgType && ptype === orgType);
  const contact = () => ((ptype && ptype.profiles) || {}).contact || ((ptype && ptype.profiles) || {}).organization || {};
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

  // ---------------------------------------------------------------- the one pop at a time
  //
  // No browser pickers — a <select>, a date or a file field opens a window of
  // the engine's own, which a layer surface cannot hold — so menus and days
  // are small lists drawn in the page.

  // One pop-up at a time, the kit's (kit.js): placed under what opened it (or above, with more room there),
  // kept on screen, scrolling when long, put away by a press elsewhere or Escape — the same on every page.
  const popUnder = (anchor, content) => Kit.pop(anchor, content);
  const popAway = () => Kit.popAway();
  const menuAt = (x, y, items) => Kit.menu({ x, y }, items);


  // ---------------------------------------------------------------- the left
  //
  // Each row as /people has it; a refresh keeps the one chosen and where the list was scrolled.

  const byName = (a, b) => a.localeCompare(b, undefined, { sensitivity: "base" });
  const NO_ORG = "No organization";
  function matches(p, q) {
    if (!q) return true;
    // Found as everything is found (kit.js): every word typed, accents aside.
    return Kit.matches(q, p.title, ...(p.organizations || []).map((o) => o.title), p.role, p.email);
  }
  // Known by a name, or only by an address (a name is what the person has unless it is just their address).
  const unnamed = (p) => /^[^\s@]+@[^\s@]+$/.test(String(p.title || "").trim()) || !String(p.title || "").trim();
  let named = store.get("talaris.people.named", "all");
  // Has an organization, is in one of mine (marked on a group's heading, kept by the core), or has none —
  // apart from how the list is grouped and the other filters. None chosen: everyone.
  let orgd = store.get("talaris.people.orgd", "all");
  let myOrgs = [];
  const hasOrg = (p) => Boolean((p.organizations || []).length);
  const isMine = (org) => myOrgs.some((m) => m.toLowerCase() === String(org || "").trim().toLowerCase());
  const ORGD = { all: () => true, has: hasOrg, mine: (p) => (p.organizations || []).some((o) => isMine(o.title)), none: (p) => !hasOrg(p) };
  // The organizations on show, in Organizations: every one, found by its name, or one of mine.
  function shownOrgs() {
    const q = $("q").value.trim().toLowerCase();
    return orgs.filter((o) => !q || Kit.matches(q, o.title));
  }
  const peopleAt = (orgId) => people.filter((p) => (p.organizations || []).some((o) => o.id === orgId)).length;
  function orgRow(o) {
    const n = peopleAt(o.id);
    return el("div", { class: "prow" + (o.id === chosen ? " on" : ""), "data-id": o.id, onclick: () => { choose(o.id); $("list").focus(); },
      oncontextmenu: (e) => {
        e.preventDefault();
        menuAt(e.clientX, e.clientY, [{ label: o.mine ? "Not one of my organizations" : "One of my organizations", act: () => markMine(o.title, !o.mine) }]);
      } },
      ThingCard.avatar(api, o.id, o.title, null),
      el("div", { class: "p-main" }, el("div", { class: "p-name" }, o.title), el("div", { class: "p-sub" }, n === 1 ? "1 person" : `${n} people`)),
      o.mine ? el("span", { class: "own-mark" }, "Mine") : null);
  }
  function shown() {
    const q = $("q").value.trim().toLowerCase();
    return people.filter((p) => matches(p, q) && (named === "all" || (named === "named") !== unnamed(p)) && (ORGD[orgd] || ORGD.all)(p));
  }
  function markMine(org, on) {
    const next = on ? [...myOrgs, org] : myOrgs.filter((m) => m.toLowerCase() !== org.toLowerCase());
    api("PUT", "/people/my-organizations", { names: next }).then((kept) => { myOrgs = kept || []; const low = new Set(myOrgs.map((m) => m.toLowerCase())); for (const o of orgs) o.mine = low.has(o.title.toLowerCase()); drawList(); }).catch((e) => say(e.message, true));
  }

  function personRow(p) {
    const sub = [p.role, p.email].filter(Boolean).join(" · ");
    return el("div", { class: "prow" + (p.id === chosen ? " on" : ""), "data-id": p.id, onclick: () => { choose(p.id); $("list").focus(); } },
      ThingCard.avatar(api, p.id, p.title, p.image),
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
    const out = [];
    // Organizations, as people are listed: A to Z, each its own row, chosen to see and change it.
    if (mode === "orgs") {
      const rows = shownOrgs();
      $("count").textContent = rows.length === orgs.length ? String(orgs.length) : `${rows.length} of ${orgs.length}`;
      if (!orgs.length) out.push(Kit.empty("No organizations yet"));
      else if (!rows.length) out.push(Kit.empty("Nothing matches"));
      let letter = null;
      for (const o of rows) {
        const first = (o.title.match(/\p{L}/u) || ["#"])[0].toLocaleUpperCase();
        const l = /\p{L}/u.test(first) ? first : "#";
        if (l !== letter) { letter = l; out.push(el("div", { class: "letter" }, l)); }
        out.push(orgRow(o));
      }
      const top = list.scrollTop;
      list.replaceChildren(...out);
      list.scrollTop = top;
      return;
    }
    const rows = shown();
    $("count").textContent = rows.length === people.length ? String(people.length) : `${rows.length} of ${people.length}`;
    // An organization with nobody yet still has its heading: it is here, and found by its name.
    const typed = $("q").value.trim();
    const bare = mode === "org" && orgd !== "none" ? orgs.filter((o) => (orgd !== "mine" || o.mine) && (!typed || Kit.matches(typed.toLowerCase(), o.title))) : [];
    if (!people.length && !bare.length) out.push(Kit.empty("No people yet"));
    else if (!rows.length && !bare.length) out.push(Kit.empty("Nothing matches"));
    else if (mode === "org") {
      const groups = new Map(bare.map((o) => [o.title, []]));
      const idOf = new Map(orgs.map((o) => [o.title, o.id]));
      // Someone at several is under each.
      for (const p of rows) for (const g of (p.organizations || []).length ? p.organizations.map((o) => o.title) : [NO_ORG]) groups.set(g, [...(groups.get(g) || []), p]);
      const names = [...groups.keys()].filter((g) => g !== NO_ORG).sort(byName);
      if (groups.has(NO_ORG)) names.push(NO_ORG);
      // Searching opens every group: what was found is shown. A shut group still shows the one chosen.
      const searching = Boolean($("q").value.trim());
      for (const g of names) {
        const mine = groups.get(g);
        const folded = !searching && shut.has(g);
        const own = g !== NO_ORG && isMine(g);
        const orgId = g !== NO_ORG ? idOf.get(g) : null;
        out.push(el("div", { class: "ghead" + (folded ? " folded" : "") + (own ? " own" : "") + (orgId && orgId === chosen ? " on" : ""), title: own ? `${g} — one of my organizations` : g, onclick: () => toggleGroup(g),
          oncontextmenu: (e) => {
            if (g === NO_ORG) return;
            e.preventDefault();
            menuAt(e.clientX, e.clientY, [{ label: own ? "Not one of my organizations" : "One of my organizations", act: () => markMine(g, !own) }]);
          } },
          Kit.caret(!folded), el("span", { class: "name", title: orgId ? `Open ${g}` : null, onclick: orgId ? (e) => { e.stopPropagation(); choose(orgId); drawList(); } : null }, g), own ? el("span", { class: "own-mark" }, "Mine") : null, el("span", { class: "n" }, String(mine.length))));
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
    seg("mode", [["org", "By Org"], ["az", "A–Z"], ["orgs", "Organizations"]], mode, (m) => { mode = m; store.set("talaris.people.mode", m); drawMode(); drawList(); });
    // Whether someone has a name or an organization says nothing of an organization: in Organizations, put away.
    $("named").hidden = $("orgd").hidden = mode === "orgs";
    $("add").textContent = mode === "orgs" ? "+ Organization" : "+ Person";
    $("review").hidden = mode === "orgs";
    seg("named", [["all", "All"], ["named", "Named"], ["unnamed", "No name"]], named, (n) => { named = n; store.set("talaris.people.named", n); drawMode(); drawList(); });
    // Pressed again, the one chosen lets go: everyone.
    seg("orgd", [["has", "Has org"], ["mine", "My orgs"], ["none", "No org"]], orgd, (o) => {
      orgd = o === orgd ? "all" : o; store.set("talaris.people.orgd", orgd); drawMode(); drawList();
    });
  }

  async function loadPeople() {
    [people, orgs] = await Promise.all([api("GET", "/people").then((x) => x || []), api("GET", "/people/organizations").catch(() => [])]);
    orgs = orgs || [];
    myOrgs = orgs.filter((o) => o.mine).map((o) => o.title);
    drawList();
    warnTwice();
  }

  // People who may be entered twice (suggest.ts, peopleReview), said above everything until reviewed: what is tied
  // to each copy stays with that copy, so whatever reads one of them — Morgan, suggestions, the person's page — sees
  // only part. Hidden while the review is open; asked again whenever the list is.
  let twiceAsked = 0;
  async function warnTwice() {
    const mine = ++twiceAsked;
    let n = 0;
    try { n = ((await api("GET", "/people/review")).pairs || []).length; } catch { n = 0; }
    if (mine !== twiceAsked) return;
    const bar = $("twice");
    bar.hidden = !n || reviewing;
    if (!n) return;
    bar.replaceChildren(
      el("span", { class: "t-text" }, `${n === 1 ? "One person may be" : `${n} people may be`} entered twice. Until they're made one, `
        + "what's tied to each copy stays split between them, so Morgan, suggestions and their pages each see only part of what you know about them."),
      el("button", { class: "t-btn", onclick: () => { if (!reviewing) review().catch(failed); } }, "Review"));
  }

  // ---------------------------------------------------------------- the one chosen

  let loadSeq = 0;
  function choose(id) {
    if (id === chosen && got && !reviewing) return;
    if (reviewing) { reviewing = false; warnTwice(); }
    $("review").classList.remove("on");
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
    ptype = orgType && g.entity && g.entity.type === orgType.id ? orgType : personType;
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

  // A person here is chosen, in the list; anything else is its card, in the Library.
  function openHere(key) {
    const id = key.startsWith("e:") ? key.slice(2) : "";
    if (id && people.some((p) => p.id === id)) { choose(id); return; }
    if (window.Peek) Peek.openCard(key);
  }

  function drawPerson() {
    if (reviewing) return;
    ThingCard.putAway();
    popAway();
    const host = $("person");
    if (!got || !ptype) { host.replaceChildren(people.length ? "" : Kit.empty("No people yet")); return; }
    const top = host.scrollTop;
    const same = host.dataset.id === chosen;
    host.dataset.id = chosen;
    // The one card (thingcard.js), as the Library shows it; the address books and the end of a person are People's to add.
    host.replaceChildren(...ThingCard.drawn(got, allTypes, {
      api, say, failed, bridge, hub: "people",
      open: openHere,
      redraw: () => loadPerson().catch(failed),
      changed: () => loadPeople().catch(failed),
      afterFields: isOrg() ? orgPeoplePart() : contactsPart(),
      end: foot(),
    }));
    host.scrollTop = same ? top : 0;
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
        el("div", { class: "label c-book" }, c.bookName || c.book),
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
      el("div", { class: "c-acts" }, el("button", { class: "t-btn", title: "Tie this card to them; anyone else here tied to it is made one with them",
        onclick: () => sameAsCard(cardKeyOf(c)) }, "Same person")));
  }
  // The same person as a card: tied, and made one with anyone else here already tied to it (suggest.ts, samePerson).
  async function sameAsCard(key) {
    const id = chosen;
    try {
      const r = await api("POST", `/people/${enc(id)}/same`, { card: key });
      say(r.said || "Done");
      await loadPeople();
      if (r.kept && r.kept !== id) { got = null; choose(r.kept); } else if (id === chosen) await loadPerson();
    } catch (err) { failed(err); }
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

  // ---------------------------------------------------------------- an organization's people
  //
  // Who is in it, added and taken off from here: the tie is the person's own
  // field (the contact profile's organization slot), so it is written there.

  const orgSlot = () => (personType && personType.profiles && personType.profiles.contact && typeof personType.profiles.contact.organization === "string"
    ? personType.profiles.contact.organization : null);
  async function setInOrg(personId, orgId, inIt) {
    const key = orgSlot();
    if (!key) throw new Error("People have no organization field");
    const g = await api("GET", `/entities/${enc(personId)}`);
    const v = ((g && g.entity) || {}).properties?.[key];
    const was = Array.isArray(v) ? v : v == null || v === "" ? [] : [v];
    const next = inIt ? (was.includes(orgId) ? was : [...was, orgId]) : was.filter((x) => x !== orgId);
    await api("PATCH", `/entities/${enc(personId)}`, { properties: { [key]: next } });
  }
  function orgPeoplePart() {
    const id = chosen;
    if (!orgSlot()) return null;
    const here = people.filter((p) => (p.organizations || []).some((o) => o.id === id)).sort((a, b) => a.title.localeCompare(b.title));
    const redo = async (text) => { say(text); await loadPeople(); drawPerson(); };
    const row = (p) => el("div", { class: "org-person" },
      el("button", { class: "linkish", title: `Show ${p.title}`, onclick: () => { if (mode === "orgs") { mode = "org"; store.set("talaris.people.mode", mode); drawMode(); drawList(); } choose(p.id); } },
        p.title, p.role ? el("span", { class: "hint" }, `  ${p.role}`) : null),
      el("button", { class: "x", title: `Take ${p.title} out of this organization`, onclick: async () => {
        try { await setInOrg(p.id, id, false); await redo(`${p.title} taken out`); } catch (err) { failed(err); }
      } }, "×"));
    return el("section", { class: "part" },
      el("h3", {}, el("span", {}, "People")),
      here.length ? el("div", {}, ...here.map(row)) : el("div", { class: "hint" }, "No one yet"),
      el("button", { class: "t-btn small", onclick: (e) => pickPerson(e.currentTarget, here.map((p) => p.id), async (p) => {
        try { await setInOrg(p.id, id, true); await redo(`${p.title} added`); } catch (err) { failed(err); }
      }) }, "+ Add person"));
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
    const find = Kit.searchBox(el("input", { type: "search", id: "card-q", placeholder: "Find someone by name or address", spellcheck: "false" }));
    const found = el("div", {});
    let timer = null;
    find.addEventListener("input", () => {
      clearTimeout(timer);
      const q = find.value.trim();
      if (q.length < 2) { found.replaceChildren(); return; }
      timer = setTimeout(() => api("GET", `/contacts/cards?q=${enc(q)}`).then((cards) => {
        if (id !== chosen || find.value.trim() !== q) return;
        const rows = (cards || []).filter((c) => !c.gone && !tied.includes(cardKeyOf(c))).slice(0, 8);
        found.replaceChildren(...(rows.length ? rows.map(likelyCard) : [Kit.empty("Nothing matches")]));
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

  // Someone already here, picked by name or address: for "Both are…" and "Same person as…".
  function pickOrg(anchor, leaveOut, picked) {
    const box = el("input", { type: "search", class: "find", placeholder: "Which organization?", spellcheck: "false" });
    const hits = el("div", { class: "menu-list" });
    const show = () => {
      const q = box.value.trim().toLowerCase();
      const rows = orgs.filter((o) => !leaveOut.includes(o.id) && q && Kit.matches(q, o.title)).slice(0, 8);
      hits.replaceChildren(...(rows.length ? rows.map((o) => el("button", { class: "menu-item", onclick: () => { popAway(); picked(o); } }, o.title))
        : [el("div", { class: "hint" }, q ? "None by that name" : "Type a name")]));
    };
    box.addEventListener("input", show);
    show();
    popUnder(anchor, el("div", {}, box, hits));
    setTimeout(() => box.focus(), 0);
  }
  /**
   * Two of one kind made one (merge.ts), the one asked for kept — unless the other is the one a sync keeps in step,
   * which the core says, and then that one is kept instead. Answers the id kept.
   */
  async function sameThing(drop, keep) {
    try {
      await api("POST", `/entities/${enc(drop)}/merge`, { into: keep });
      return keep;
    } catch (err) {
      if (!/keep that one instead/.test(String(err && err.message))) throw err;
      await api("POST", `/entities/${enc(keep)}/merge`, { into: drop });
      return drop;
    }
  }

  function pickPerson(anchor, leaveOut, picked) {
    const box = el("input", { type: "search", class: "find", placeholder: "Who are they?", spellcheck: "false" });
    const hits = el("div", { class: "menu-list" });
    const show = () => {
      const q = box.value.trim().toLowerCase();
      const rows = people.filter((r) => !leaveOut.includes(r.id) && q
        && (r.title.toLowerCase().includes(q) || String(r.email || "").toLowerCase().includes(q))).slice(0, 8);
      hits.replaceChildren(...(rows.length ? rows.map((r) => el("button", { class: "menu-item", onclick: () => { popAway(); picked(r); } },
        r.title, r.email ? el("span", { class: "hint" }, `  ${r.email}`) : null)) : [el("div", { class: "hint" }, q ? "No one by that name" : "Type a name")]));
    };
    box.addEventListener("input", show);
    show();
    popUnder(anchor, el("div", {}, box, hits));
    setTimeout(() => box.focus(), 0);
  }

  // ---------------------------------------------------------------- review: everyone at once
  //
  // One person entered twice, swept for across everyone: two here who share a
  // name, an address or a card, and people with no card who match one in the
  // address books. One answer for each, whatever the match — Same person
  // (made one, or the card tied, or both: suggest.ts, samePerson) or Not the
  // same, remembered so it is not asked again.

  // A name as it is said: "Groninger, Margaret" is Margaret Groninger (suggest.ts, spokenName).
  const spoken = (t) => {
    const m = String(t || "").match(/^\s*([^,]+),\s*([^,]+)\s*$/);
    return (m ? `${m[2]} ${m[1]}` : String(t || "")).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  };

  async function review() {
    if (reviewing) { reviewing = false; $("review").classList.remove("on"); warnTwice(); got = null; if (chosen) choose(chosen); else drawPerson(); return; }
    reviewing = true;
    $("review").classList.add("on");
    $("twice").hidden = true;
    ThingCard.putAway();
    popAway();
    for (const r of document.querySelectorAll(".prow.on")) r.classList.remove("on");
    const host = $("person");
    host.dataset.id = "";
    const list = el("div", {}, el("div", { class: "hint" }, "Looking through everyone and your address books…"));
    host.replaceChildren(el("section", { class: "part" }, el("h3", {}, el("span", {}, "Probably the same person")), list));
    host.scrollTop = 0;
    let found, cards;
    try {
      [found, cards] = await Promise.all([api("GET", "/people/review"), api("GET", "/contacts/cards?all=1").catch(() => [])]);
    } catch (err) { list.replaceChildren(el("div", { class: "hint err" }, err.message)); return; }
    if (!reviewing) return;
    // After one is made one, asked again: a name three share is three rows, and the others are about who it became.
    const refresh = async () => {
      const again = await api("GET", "/people/review");
      if (reviewing) drawReview(list, reviewItems(again, cards), refresh);
    };
    drawReview(list, reviewItems(found, cards), refresh);
  }

  function reviewItems(found, cards) {
    const items = [];
    for (const p of found.pairs || []) items.push({ kind: "pair", a: p.a, b: p.b, why: p.why });
    // People with no card, matched to one: the same address first, else the same name — one card each, the best.
    const noCard = new Set(people.filter((r) => r.noContact).map((r) => r.id));
    const tiedTo = new Map();
    for (const r of found.people || []) for (const k of r.cards) tiedTo.set(k, [...(tiedTo.get(k) || []), r]);
    const byEmail = new Map(), byName = new Map();
    for (const c of (cards || []).filter((c) => !c.gone && c.uid)) {
      for (const e of c.emails || []) byEmail.set(String(e).toLowerCase(), c);
      const n = spoken(c.name);
      if (n) byName.set(n, [...(byName.get(n) || []), c]);
    }
    for (const r of found.people || []) {
      if (r.cards.length || noCard.has(r.id)) continue;
      const no = new Set((found.notCards || {})[r.id] || []);
      const fits = (c) => c && !no.has(cardKeyOf(c));
      const email = r.emails.map((e) => byEmail.get(e)).find(fits);
      const named = (byName.get(spoken(r.title)) || []).filter(fits);
      const card = email || (named.length === 1 ? named[0] : null); // a name shared by several cards says nothing
      if (!card) continue;
      const others = (tiedTo.get(cardKeyOf(card)) || []).filter((o) => o.id !== r.id);
      items.push({ kind: "card", a: r, card, why: [email ? "The same address" : "The same name"], others });
    }
    // Last, those with no name, who match nothing until they have one.
    for (const r of found.nameless || []) items.push({ kind: "nameless", a: r });
    return items;
  }

  function drawReview(list, items, refresh) {
    if (!items.length) { list.replaceChildren(Kit.empty("No one looks entered twice")); return; }
    const who = (p) => el("div", { class: "c-main" },
      el("div", { class: "c-name" }, p.title),
      p.emails && p.emails.length ? el("div", { class: "c-line" }, p.emails.join(", ")) : null,
      p.organization ? el("div", { class: "c-line" }, p.organization) : null);
    const row = (it) => (it.kind === "nameless" ? namelessRow(it) : pairRow(it));
    const namelessRow = (it) => {
      const nameBox = el("input", { type: "text", class: "find", placeholder: "Their name", spellcheck: "false", hidden: true });
      const line = el("div", { class: "r-item" },
        el("div", { class: "label r-why" }, "No name"),
        el("div", { class: "card" }, el("div", { class: "c-main" },
          el("div", { class: "c-name" }, it.a.emails[0] || it.a.title),
          it.a.emails.length > 1 ? el("div", { class: "c-line" }, it.a.emails.slice(1).join(", ")) : null,
          it.a.organization ? el("div", { class: "c-line" }, it.a.organization) : null, nameBox)),
        el("div", { class: "c-acts" },
          el("button", { class: "t-btn primary", onclick: () => { nameBox.hidden = false; nameBox.focus(); } }, "Name it"),
          el("button", { class: "t-btn", title: "Someone already here: made one with them", onclick: (e) => pickPerson(e.currentTarget, [it.a.id], async (target) => {
            try { await api("POST", `/people/${enc(target.id)}/same`, { person: it.a.id }); await after(`Made one: ${target.title}`); } catch (err) { failed(err); }
          }) }, "Same person as…"),
          el("button", { class: "t-btn", title: "Leave them without a name, and don't ask again", onclick: async () => {
            try { await api("POST", `/people/${enc(it.a.id)}/leave-nameless`); done("Left as they are"); } catch (err) { failed(err); }
          } }, "Leave it")));
      const done = (text) => { line.remove(); say(text); count(); };
      const after = async (text) => {
        done(text);
        await loadPeople();
        const top = $("person").scrollTop;
        await refresh();
        $("person").scrollTop = top;
      };
      nameBox.addEventListener("keydown", async (e) => {
        if (e.key === "Escape") { nameBox.hidden = true; return; }
        if (e.key !== "Enter" || !nameBox.value.trim()) return;
        try {
          await api("PATCH", `/entities/${enc(it.a.id)}`, { properties: { [titleKey()]: nameBox.value.trim() } });
          // Named, they can be matched like anyone: the review asked again may pair them.
          await after(`Named ${nameBox.value.trim()}`);
        } catch (err) { failed(err); }
      });
      return line;
    };
    const pairRow = (it) => {
      const done = (text) => { line.remove(); say(text); count(); };
      const after = async (text) => {
        done(text);
        await loadPeople();
        const top = $("person").scrollTop;
        await refresh();
        $("person").scrollTop = top;
      };
      const same = async () => {
        try {
          const r = await api("POST", `/people/${enc(it.a.id)}/same`, it.kind === "pair" ? { person: it.b.id } : { card: cardKeyOf(it.card) });
          await after(r.said || "Done");
        } catch (err) { failed(err); }
      };
      // Both the same, and someone else already here (two addresses that are both you): each made one with them.
      const bothAre = (e) => pickPerson(e.currentTarget, [it.a.id, it.b.id], async (target) => {
        try {
          for (const x of [it.a.id, it.b.id]) await api("POST", `/people/${enc(target.id)}/same`, { person: x });
          await after(`Made one: ${target.title}`);
        } catch (err) { failed(err); }
      });
      const notSame = async () => {
        try {
          await api("POST", "/suggestions/dismiss", { key: `e:${it.a.id}`, other: it.kind === "pair" ? `e:${it.b.id}` : `card:${cardKeyOf(it.card)}` });
          done("Won't be asked again");
        } catch (err) { failed(err); }
      };
      const other = it.kind === "pair" ? who(it.b) : el("div", { class: "c-main" },
        el("div", { class: "label c-book" }, it.card.bookName || it.card.book),
        el("div", { class: "c-name" }, it.card.name || "No name"), cardLines(it.card),
        it.others.length ? el("div", { class: "c-line c-also" }, `Also tied to ${it.others.map((o) => o.title).join(", ")}: made one too`) : null);
      const line = el("div", { class: "r-item" },
        el("div", { class: "label r-why" }, it.why.join(" · ")),
        el("div", { class: "r-two" }, el("div", { class: "card" }, who(it.a)), el("div", { class: "card" + (it.kind === "card" ? " r-card" : "") }, other)),
        el("div", { class: "c-acts" },
          el("button", { class: "t-btn primary", onclick: same }, "Same person"),
          it.kind === "pair" ? el("button", { class: "t-btn", title: "Both are someone else already here: each made one with them", onclick: bothAre }, "Both are…") : null,
          el("button", { class: "t-btn", onclick: notSame }, "Not the same")));
      return line;
    };
    const head = el("div", { class: "hint" });
    const rows = el("div", {}, ...items.map(row));
    const count = () => { const n = rows.children.length; head.textContent = n ? `${n} to look at` : ""; if (!n) list.replaceChildren(Kit.empty("No one looks entered twice")); };
    list.replaceChildren(head, rows);
    count();
  }

  // ---------------------------------------------------------------- making and removing

  function foot() {
    if (isOrg()) return el("div", { class: "p-foot" },
      // One already here it really is (the same organization twice, under another name): made one with it.
      el("button", { class: "t-btn", title: "An organization already here: this one is made one with it", onclick: (e) => {
        const id = chosen;
        pickOrg(e.currentTarget, [id], async (target) => {
          try {
            const kept = await sameThing(id, target.id);
            say(`Made one with ${target.title}`);
            await loadPeople();
            got = null;
            choose(kept);
          } catch (err) { failed(err); }
        });
      } }, "Same organization as…"),
      el("span", { class: "spacer" }),
      Kit.twice(el("button", { class: "t-btn danger" }, "Delete organization"), { key: `del-org:${chosen}`, ask: "Delete for good?", act: remove }));
    return el("div", { class: "p-foot" },
      // Someone already here they really are (the same person entered twice, under another name or none):
      // made one with them, who is kept, and shown.
      el("button", { class: "t-btn", title: "Someone already here: this one is made one with them", onclick: (e) => {
        const id = chosen;
        pickPerson(e.currentTarget, [id], async (target) => {
          try {
            const r = await api("POST", `/people/${enc(target.id)}/same`, { person: id });
            say(r.said || "Done");
            await loadPeople();
            got = null;
            choose(r.kept || target.id);
          } catch (err) { failed(err); }
        });
      } }, "Same person as…"),
      el("span", { class: "spacer" }),
      // Asked by a second press, as every delete is (Kit.twice); a person is not kept in versions, so it says for good.
      Kit.twice(el("button", { class: "t-btn danger" }, "Delete person"), { key: `del-person:${chosen}`, ask: "Delete for good?", act: remove }));
  }
  async function remove() {
    const id = chosen;
    // The neighbour below takes its place (or above, for the last).
    const order = (mode === "orgs" ? shownOrgs() : shown()).map((p) => p.id);
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
      // In Organizations, an organization: named by its type's organization profile, as everything is.
      const orgTitle = ((orgType && orgType.profiles.organization) || {}).title || "title";
      const made = mode === "orgs" && orgType
        ? await api("POST", "/entities", { type: orgType.id, properties: { [orgTitle]: "New organization" } })
        : await api("POST", "/entities", { role: "person", properties: { [titleKey()]: "New person" } });
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
      allTypes = types;
      personType = ptype = types.find((t) => t["talaris:role"] === "person") || null;
      orgType = types.find((t) => t.profiles && t.profiles.organization) || null;
      if (!ptype) say("There is no person type", true);
      await loadPeople();
      if (!chosen || !(people.some((p) => p.id === chosen) || orgs.some((o) => o.id === chosen))) chosen = people.length ? people[0].id : null;
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
  // Escape clears it first, as every box that narrows a list does (kit.js).
  Kit.searchBox($("q"));
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
  $("review").addEventListener("click", () => review().catch(failed));

  document.addEventListener("keydown", (e) => {
    // Peek and the editor's @ picker keep their own Escape, and say so.
    if (e.defaultPrevented) return;
    if (e.key === "Escape") {
      e.preventDefault();
      // A delete asking (its second press) stops asking before the panel goes.
      const asking = document.querySelector(".p-foot .armed");
      if (!!Kit.isOpen()) popAway();
      else if (asking) Kit.unask(asking, `del-person:${chosen}`);
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
    b.coreReply.connect((text) => asked.reply(JSON.parse(text)));
    // Files chosen and kept (or why not): the person drawn again with them.
    b.attached.connect((text) => {
      const r = JSON.parse(text);
      if (r.error) say(r.error, true);
      if (r.field === (imageField() || {}).key) ThingCard.forgetPictures();
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
    start().then(() => placeHere.ready(), () => placeHere.ready());
  });

  // Who is on show, carried when it is made a window, or a panel again (kit.js).
  const placeHere = Kit.place(() => ({ chosen }), (p) => { if (p.chosen && p.chosen !== chosen) window.People.show(p.chosen); });

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
