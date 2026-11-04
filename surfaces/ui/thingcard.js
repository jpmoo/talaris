// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore
//
// A thing's card: a person, an organization, a task, an event, as it is shown
// everywhere — what it says, what it is tied to, what can be done with it, and
// what it might be tied to. One card, so the Library and a thing's own hub show
// the same. The page says how a thing named on it opens.
//
// A person's or an organization's is edited where it is shown, each field by its
// kind, as the type has it. A task's and an event's are read here, and worked on
// in their hubs: what changes them does more than change them (completing a task
// keeps its series in step), so they do not come here until that is theirs to say.
//
// Asked of the page:
//   api, say, failed    its door to the core, and where it says things
//   open(key)           a thing named on the card, by the key Glance knows it by
//   bridge              openUrl, openFile, attach, glanceAt, thing, openEvent, as it has them
//   redraw()            the card again, asked afresh
//   changed(entity)     something on it changed: for what the page lists beside it
//   hub                 which hub it is drawn in: the way there is not then offered
//   glance(key)         Glance on it, if not by the bridge
//   afterFields, end    what the page adds, under the fields and at the foot

"use strict";

window.ThingCard = (() => {
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
  // The small × that takes one thing off a chip.
  function xBtn(title, onclick) {
    const b = el("button", { class: "x-btn", title, onclick });
    b.innerHTML = Icons.close();
    return b;
  }

  // ---------------------------------------------------------------- a person's mark

  // As the canvas's person card (EntityCard.tsx): a tint by the id, so a rename does not repaint them.
  function tint(id) {
    let h = 0;
    for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
    return `color-mix(in srgb, ${Palette.TINTS[Math.abs(h) % Palette.TINTS.length]} 45%, var(--surface))`;
  }
  function initials(name) {
    const w = String(name || "").split("@")[0].split(/[\s._-]+/).filter((x) => /[\p{L}\p{N}]/u.test(x));
    if (!w.length) return "?";
    const first = [...w[0]];
    return (w.length > 1 ? first[0] + [...w[w.length - 1]][0] : first.slice(0, 2).join("")).toUpperCase();
  }
  // A picture's bytes, once each: a data: URL needs its type, read from the bytes' first few.
  const pictures = new Map();
  function picture(api, sha) {
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
  function avatar(api, id, name, sha, attrs = {}) {
    const a = el(attrs.tag || "span", { class: "av" + (attrs.big ? " big" : ""), style: `background-color:${tint(id)}`, title: attrs.title, onclick: attrs.onclick }, initials(name));
    if (sha) picture(api, sha).then((url) => { if (url) { a.style.backgroundImage = `url("${url}")`; a.classList.add("pic"); } });
    return a;
  }

  // ---------------------------------------------------------------- words

  const GROUP = { contact: "People", organization: "Organizations", event: "Events", task: "Tasks", note: "Pages", project: "Projects" };
  const KIND = { contact: "A person", organization: "An organization", event: "An event", task: "A task", note: "A note", project: "A project" };
  const BACK = { organization: "member", parent: "includes", mentions: "mentioned in", attendees: "invited to", organizer: "organizer of", invitees: "invited to", assignee: "assigned", project: "filed here", about: "connected" };
  const OUT = { organization: "at", parent: "part of", mentions: "mentioned", attendees: "invited", organizer: "organizer", invitees: "invited", project: "project", about: "connected" };
  const fieldWords = (key) => String(key).replace(/_/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (c) => c.toUpperCase());
  const lower = (key) => String(key).replace(/_/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
  const labelOf = (f) => f["talaris:label"] || f.label || fieldWords(f.key);
  const bareWords = (t) => String(t).replace(/\[@?([^\]]*)\]\(talaris:[^)]*\)/g, "$1");
  const asList = (v) => (Array.isArray(v) ? v.map(String) : v == null || v === "" ? [] : [String(v)]);

  // ---------------------------------------------------------------- days

  // A date is wall-clock "YYYY-MM-DD"; a datetime adds "THH:MM".
  const pad = (n) => String(n).padStart(2, "0");
  const sameDay = (a, b) => a && b && a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  const isoDay = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const dayLabel = (d) => Kit.day(d, { weekday: false });
  function readIso(v) {
    const m = String(v || "").match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/);
    return m ? { day: new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])), time: m[4] ? `T${m[4]}:${m[5]}` : "" } : { day: null, time: "" };
  }
  // A birthday is mostly in the past: read as every page reads a day (kit.js), the year kept as typed or this one.
  const parseDay = (text) => Kit.parseDay(text, { past: true });

  // ---------------------------------------------------------------- what is open in it

  let editors = [];
  /** Its editors let go of: before it is drawn again, or anything else is put in its place. */
  function putAway() { for (const ed of editors) { try { ed.destroy(); } catch { /* gone */ } } editors = []; }

  // ---------------------------------------------------------------- what it is connected to

  const FIRST = 20;
  const ARCHIVED = "In archived projects";
  function linkGroup(name, rows, ctx) {
    // What lives in an archived project starts folded: its label opens it.
    let count = name === ARCHIVED ? 0 : FIRST;
    const list = el("div", {});
    const more = el("div", { class: "c-more" });
    const draw = () => {
      list.replaceChildren(...rows.slice(0, count).map((r) => el("div", { class: "c-row" },
        el("button", { class: "c-item", onclick: () => ctx.open(`e:${r.e.id}`) },
          el("span", { class: "c-t" }, r.e.title || "Untitled"), el("span", { class: "c-how", title: r.ties.some((t) => t.fixed === "text") ? "It is written in the text: taken out there, this goes" : r.ties.some((t) => t.fixed === "calendar") ? "It is the calendar's: changed there" : null }, r.how.join(", "))),
        removeTie(r, ctx))));
      const left = rows.length - count;
      more.replaceChildren(...(left > 0 ? [
        el("button", { class: "t-btn small", onclick: () => { count += FIRST; draw(); } }, `${Math.min(FIRST, left)} more`),
        left > FIRST ? el("button", { class: "t-btn small", onclick: () => { count = rows.length; draw(); } }, `All ${rows.length}`) : null,
      ] : []).filter(Boolean));
    };
    draw();
    const label = el("div", { class: "label c-label", style: name === ARCHIVED ? "cursor:pointer" : null }, name, el("span", { class: "n" }, String(rows.length)));
    if (name === ARCHIVED) label.addEventListener("click", () => { count = count ? 0 : FIRST; draw(); });
    return el("div", { class: "c-group" }, label, list, more);
  }

  /** Its × : asked once, then every tie between the two that is not held by something else undone, whichever of them holds it. */
  function removeTie(r, ctx) {
    const mine = r.ties.filter((t) => !t.fixed);
    if (!mine.length) return null;
    const b = el("button", { class: "x-btn", title: "Remove this connection" });
    b.innerHTML = Icons.close();
    return Kit.twice(b, { key: `untie:${ctx.id}:${r.e.id}`, ask: "Remove?", act: async () => {
      try {
        for (const t of mine) await ctx.api("DELETE", t.out ? `/entities/${enc(ctx.id)}/connect/${enc(r.e.id)}` : `/entities/${enc(r.e.id)}/connect/${enc(ctx.id)}`);
        ctx.say(`No longer connected to ${r.e.title || "it"}`);
        if (ctx.changed) await ctx.changed();
        ctx.redraw();
      } catch (e) { ctx.failed(e); }
    } });
  }

  /** What it is tied to, by what the other thing is, the newest first; `leaveOut`, what the fields name already. And what it might be. */
  function connected(got, ctx, leaveOut = new Set()) {
    const id = got.entity.id;
    const byId = new Map();
    const touch = (e, how, tie) => {
      if (!e || e.id === id || leaveOut.has(e.id)) return;
      const had = byId.get(e.id);
      if (had) { if (!had.how.includes(how)) had.how.push(how); had.ties.push(tie); return; }
      byId.set(e.id, { e, how: [how], ties: [tie] });
    };
    // Less what Settings leaves out of connections (complete, archived, too old): said how many.
    const hide = new Set(got.hidden || []);
    for (const c of got.out || []) if (!hide.has(c.entity.id)) touch(c.entity, OUT[c.name] || lower(c.name), { out: true, fixed: c.fixed });
    for (const c of got.in || []) if (!hide.has(c.entity.id)) touch(c.entity, BACK[c.name] || `${lower(c.name)} of`, { out: false, fixed: c.fixed });
    const groups = new Map();
    for (const r of byId.values()) {
      const g = r.e.archived ? ARCHIVED : GROUP[(r.e.kinds || []).find((k) => GROUP[k])] || "Other";
      groups.set(g, [...(groups.get(g) || []), r]);
    }
    for (const rows of groups.values()) rows.sort((a, b) => String(b.e.updated || "").localeCompare(String(a.e.updated || "")));
    const order = [...Object.values(GROUP), "Other", ARCHIVED].filter((g) => groups.has(g));
    // A tie made, the card drawn again.
    const sugg = window.Peek ? Peek.suggestions(`e:${id}`, ctx.api, {
      openKey: (key) => ctx.open(key),
      changed: (r) => { ctx.say(r.said || "Done"); ctx.redraw(); },
    }) : null;
    return el("section", { class: "part" },
      el("h3", {}, el("span", {}, "Connected")),
      order.length ? order.map((g) => linkGroup(g, groups.get(g), { ...ctx, id })) : el("div", { class: "hint" }, hide.size ? "Nothing connected shown" : "Nothing connected yet"),
      hide.size > 0 && window.Peek ? el("div", { class: "hint" }, Peek.hiddenSaid(hide.size)) : null,
      sugg);
  }

  // ---------------------------------------------------------------- one edited

  function edited(got, types, ctx) {
    const { api, say, failed, bridge } = ctx;
    const id = got.entity.id;
    const type = types.find((t) => t.id === got.entity.type) || { fields: [], profiles: {} };
    const org = (got.kinds || []).includes("organization");
    const prof = (type.profiles || {}).contact || (type.profiles || {}).organization || {};
    const titleKey = typeof prof.title === "string" ? prof.title : "title";
    const props = () => got.entity.properties || {};
    const patch = async (body) => {
      const out = await api("PATCH", `/entities/${enc(id)}`, body);
      say("");
      if (out && out.id) got.entity = out;
      if (ctx.changed) await ctx.changed(out);
      return out;
    };
    const setProps = (p) => patch({ properties: p }).catch(failed);
    const popAway = () => Kit.popAway();
    const row = (label, kids, top = false) => el("div", { class: "f-row" + (top ? " top" : "") }, el("span", { class: "lab" }, label), kids);

    function head() {
      const p = props();
      const img = type.fields.find((f) => f.kind === "attachment" && !f.many) || null;
      const sha = img && p[img.key] && p[img.key].sha256;
      const name = el("input", { type: "text", class: "name-in", id: "name-in", value: p[titleKey] || "", placeholder: org ? "Its name" : "Their name", spellcheck: "false" });
      let kept = p[titleKey] || "";
      const save = () => {
        const v = name.value.trim();
        if (!v) { name.value = kept; return; }
        if (v === kept) return;
        kept = v;
        setProps({ [titleKey]: v });
      };
      name.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); name.blur(); }
        if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); name.value = kept; name.blur(); }
      });
      name.addEventListener("blur", save);
      const av = avatar(api, id, got.title, sha, { tag: "button", big: true, title: img ? "Picture" : null,
        onclick: (e) => {
          if (!img) return;
          if (Kit.openedBy() === e.currentTarget) { popAway(); return; }
          const r = e.currentTarget.getBoundingClientRect();
          Kit.menu({ x: r.left, y: r.bottom + 4 }, [
            { label: "Choose a picture…", act: () => { say(""); bridge.attach(id, img.key); } },
            sha ? { label: "Remove picture", act: () => setProps({ [img.key]: null }).then(ctx.redraw) } : null,
          ].filter(Boolean));
        } });
      const glance = ctx.glance || (bridge && bridge.glanceAt ? (k) => bridge.glanceAt(k) : null);
      // Where else they live (a sync's way back to them), under their name.
      // And what plugins put on a person (Sync now), filled in when the core answers.
      const elsewhere = window.Peek ? [...Peek.elsewhereButtons(got.entity, (u) => bridge && bridge.openUrl(u), "t-btn small"), org ? null : Peek.actionButtons("person", id, api, "t-btn small"),
        Peek.glanceButton(`e:${id}`, glance, "t-btn small"),
        ctx.hub === "people" || !bridge.thing ? null : el("button", { class: "t-btn small", title: "The address books, and more that can be done with them", onclick: () => bridge.thing("person", id) }, "Open in People")].filter(Boolean) : [];
      return el("div", { class: "p-head" }, av, elsewhere.length ? el("div", { class: "p-name" }, name, el("div", { class: "p-elsewhere" }, ...elsewhere)) : name);
    }

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
        if (Kit.openedBy() === pick) { popAway(); return; }
        e.stopPropagation();
        Kit.pop(pick, Kit.monthPicker(parseDay(input.value) || day, (d) => { input.value = dayLabel(d); save(); }, { years: true }));
      } }, "▾");
      return [input, pick];
    }

    function enumField(f) {
      const now = props()[f.key];
      const labels = f["talaris:labels"] || {};
      const host = el("div", { class: "grow chips" });
      // A press on the one chosen takes it off again.
      host.append(...(f.options || []).map((o) => el("button", { class: "t-btn tog" + (now === o ? " on" : ""),
        onclick: () => setProps({ [f.key]: now === o ? null : o }).then(ctx.redraw) }, labels[o] || fieldWords(o))));
      return row(labelOf(f), host);
    }

    /** Things it points at, as chips, with a small search for one more. */
    function refField(f) {
      const ids = asList(props()[f.key]);
      const titles = new Map((got.out || []).filter((c) => c.name === f.key).map((c) => [c.entity.id, c.entity.title]));
      const put = (next) => setProps({ [f.key]: next.length ? (f.many ? next : next[0]) : null }).then(() => ctx.redraw());
      const add = el("button", { class: "add", title: "Add", onclick: () => {
        if (Kit.openedBy() === add) { popAway(); return; }
        const find = Kit.searchBox(el("input", { type: "search", class: "find", placeholder: "Find", spellcheck: "false" }));
        const list = el("div", { class: "menu-list" });
        let found = [];
        const target = types.find((t) => t.id === f.targetType);
        const makes = Boolean(target && target.profiles && target.profiles.organization);
        const make = async (name) => {
          popAway();
          try {
            const made = await api("POST", "/entities", { type: f.targetType, properties: { [target.profiles.organization.title || "title"]: name } });
            await put(f.many ? [...ids, made.id] : [made.id]);
          } catch (err) { failed(err); }
        };
        const search = async () => {
          const q = find.value.trim();
          const asked = q;
          const got2 = ((await api("GET", `/entities?q=${enc(q)}&limit=40`).catch(() => [])) || [])
            .filter((x) => (!f.targetType || x.type === f.targetType) && !x.stub && !ids.includes(x.id) && x.id !== id).slice(0, 12);
          if (find.value.trim() !== asked) return;
          found = got2;
          list.replaceChildren(...found.map((x) => el("button", { class: "menu-item", onclick: (e) => { e.stopPropagation(); popAway(); put(f.many ? [...ids, x.id] : [x.id]); } }, x.title)));
          // An organization not here yet is made by naming it: there is nowhere else to make one.
          if (makes && q && !found.some((x) => String(x.title).toLowerCase() === q.toLowerCase())) {
            list.append(el("button", { class: "menu-item", onclick: (e) => { e.stopPropagation(); make(q); } }, `Make “${q}”`));
          }
        };
        find.addEventListener("input", search);
        find.addEventListener("keydown", (e) => {
          if (e.key !== "Enter") return;
          if (found[0]) { popAway(); put(f.many ? [...ids, found[0].id] : [found[0].id]); }
          else if (makes && find.value.trim()) make(find.value.trim());
        });
        Kit.pop(add, el("div", {}, find, list));
        search();
        setTimeout(() => find.focus(), 0);
      } }, "+");
      return row(labelOf(f), el("div", { class: "grow chips" },
        ids.map((x) => el("span", { class: "chip" }, el("span", { class: "lbl to-card", title: "Open its card", onclick: (e) => { e.stopPropagation(); ctx.open(`e:${x}`); } }, titles.get(x) || "Unknown"),
          xBtn("Remove", () => put(ids.filter((y) => y !== x))))),
        f.many || !ids.length ? add : null));
    }

    /** The description, and any long text: the editor, so @ links in it. */
    function writingField(f) {
      const host = el("div", { class: "grow ed-field ed-body" });
      let kept = props()[f.key] || "";
      const mentionOpts = { project: () => "", openPlace: (p) => ctx.open(`${p.kind}:${p.project}/${p.where}`) };
      import("./editor.js").then((m) => {
        if (!host.isConnected) return;
        const ed = m.createEditor(host, kept, { live: true, compact: true, mentions: TalarisMentions(api, (x) => ctx.open(`e:${x}`), mentionOpts), onOpenUrl: (u) => bridge && bridge.openUrl(u), placeholder: "@ to link a person, event or task" });
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
        files.map((a) => el("span", { class: "chip file", title: `Open ${a.filename}`, onclick: () => bridge && bridge.openFile(a.sha256, a.filename) },
          el("span", { class: "lbl" }, a.filename),
          xBtn("Take off", (e) => {
            e.stopPropagation();
            const rest = files.filter((x) => x.sha256 !== a.sha256);
            setProps({ [f.key]: rest.length ? rest : null }).then(ctx.redraw);
          }))),
        el("button", { class: "t-btn", onclick: () => { say(""); bridge.attach(id, f.key); } }, "Add files…")), true);
    }

    function fieldRow(f) {
      const label = labelOf(f);
      switch (f.kind) {
        case "text": return f.many ? manyField(f) : lineField(f);
        case "number": return lineField(f);
        case "richtext": return writingField(f);
        case "boolean": {
          const on = Boolean(props()[f.key]);
          return row(label, el("button", { class: "switch" + (on ? " on" : ""), title: on ? "Yes" : "No", onclick: () => setProps({ [f.key]: on ? null : true }).then(ctx.redraw) }));
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

    const rows = type.fields.filter((f) => !f["talaris:auto"] && f.key !== titleKey).map(fieldRow).flat().filter(Boolean);
    return [head(), el("section", { class: "part fields" }, rows), ctx.afterFields, connected(got, ctx), ctx.end].filter(Boolean);
  }

  // ---------------------------------------------------------------- one read

  function read(got, types, ctx) {
    const { bridge } = ctx;
    const id = got.entity.id;
    const o = got.entity, p = o.properties || {};
    const type = types.find((t) => t.id === o.type) || { fields: [], profiles: {} };
    const kinds = got.kinds || [];
    const titleKeys = new Set(Object.values(type.profiles || {}).map((m) => m && m.title));
    const nameOf = new Map([...(got.out || []), ...(got.in || [])].map((c) => [c.entity.id, c.entity.title]));
    const shownRefs = new Set();
    const toCard = (eid, title) => el("button", { class: "d-proj", title: "Open its card", onclick: () => ctx.open(`e:${eid}`) }, title || "Untitled");
    const lines = [];
    let words = "";
    const files = [];
    for (const f of type.fields) {
      const v = p[f.key];
      if (v === undefined || v === null || v === "" || titleKeys.has(f.key)) continue;
      const label = labelOf(f);
      const list = Array.isArray(v) ? v : [v];
      if (f.kind === "reference") {
        const ids = list.filter((x) => typeof x === "string");
        ids.forEach((x) => shownRefs.add(x));
        lines.push([label, el("span", {}, ...ids.flatMap((x, i) => [i ? ", " : null, toCard(x, nameOf.get(x))]).filter(Boolean))]);
      } else if (f.kind === "richtext") words = words || String(v);
      else if (f.kind === "attachment") { if (f.many) files.push(...list.map((a) => a && a.filename).filter(Boolean)); }
      else if (f.kind === "datespan") lines.push([label, [v.start, v.end].filter(Boolean).join(" to ")]);
      else if (f.kind === "datetime") lines.push([label, Kit.stamp(String(v))]);
      else if (f.kind === "boolean") { if (v === true) lines.push([label, "Yes"]); }
      else if (f.kind === "enum") lines.push([label, (f["talaris:labels"] || {})[v] || String(v)]);
      else if (typeof v !== "object" || Array.isArray(v)) lines.push([label, list.join(", ")]);
    }
    const acts = [];
    const act = (label, fn) => acts.push(el("button", { class: "t-btn small", onclick: fn }, label));
    if (kinds.includes("task")) act("Open in Tasks", () => bridge.thing("task", id));
    else if (kinds.includes("event")) {
      const on = (o["talaris:sources"] || []).find((s) => s.kind === "eds-event");
      if (on) { const cut = on.key.indexOf("/"); act("Open in Calendar", () => bridge.openEvent(on.key.slice(0, cut), on.key.slice(cut + 1), String(p.start || ""))); }
    }
    const glance = ctx.glance || (bridge.glanceAt ? (k) => bridge.glanceAt(k) : null);
    if (window.Peek && glance) acts.push(Peek.glanceButton(`e:${id}`, glance, "t-btn small"));
    return [
      el("h2", {}, got.title || "Untitled"),
      el("div", { class: "d-status" }, el("b", {}, KIND[kinds.find((k) => KIND[k])] || "A thing")),
      ...lines.map(([k, v]) => el("div", { class: "d-line" }, el("span", { class: "k" }, k), el("span", { class: "v" }, v))),
      words ? el("div", { class: "d-sub" }, "About it") : null,
      words ? el("div", { class: "d-said" }, bareWords(words)) : null,
      files.length ? el("div", { class: "d-sub" }, "Files") : null,
      files.length ? el("div", { class: "d-said" }, files.join(", ")) : null,
      acts.length ? el("div", { class: "d-sub" }, "Do") : null,
      acts.length ? el("div", { class: "d-acts" }, ...acts) : null,
      connected(got, ctx, shownRefs)].filter(Boolean);
  }

  // ---------------------------------------------------------------- the card

  /** The card's elements, for what the page already has of it: `got` as /entities/:id?shown=1 answers. */
  function drawn(got, types, ctx) {
    putAway();
    const kinds = got.kinds || [];
    return kinds.includes("contact") || kinds.includes("organization") ? edited(got, types, ctx) : read(got, types, ctx);
  }

  /** The card's elements, asked of the core; null if it is not there. `types()` and `kept(types)`: the page's keeping of the types. */
  async function draw(id, ctx) {
    let got, types;
    try {
      [got, types] = await Promise.all([ctx.api("GET", `/entities/${enc(id)}?shown=1`), ctx.types() || ctx.api("GET", "/entity-types")]);
    } catch (e) { ctx.failed(e); return null; }
    ctx.kept(types);
    return drawn(got, types, ctx);
  }

  return { draw, drawn, putAway, avatar, forgetPictures: () => pictures.clear() };
})();
