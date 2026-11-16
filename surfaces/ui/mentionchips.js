// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore
//
// A task's title with what it names by @ drawn as chips: each a press away from that thing's card. For Tasks' rows
// (tasks.js) and its views (taskviews.js), wherever a title is shown.
//
// A row's `title` is the words only; the mentions are in the field its type keeps the title in, as
// `[@Name](talaris:id)`. That field is found as the one whose words are the title — no field named, as a type's
// fields are its own.
//
//   MentionChips.title(row, { cls, open, attrs })  → a span: the words, and a chip for each mention
//     open(id, label): what a press on a chip does (Peek's card, by default)

window.MentionChips = (() => {
  const MENTION = () => /\[([^\]\n]*)\]\(talaris:([A-Za-z0-9_-]+)\)/g;
  const plain = (s) => s.replace(MENTION(), (_m, label) => label);

  /** The title as written, with its mentions: the field whose words are the row's title; else the title itself. */
  function rawTitle(row) {
    const title = row.title || "";
    for (const v of Object.values(row.fields || {})) {
      if (typeof v === "string" && v.includes("](talaris:") && plain(v).trim() === title.trim()) return v;
    }
    return title;
  }

  const openCard = (id) => { if (window.Peek && Peek.openCard) Peek.openCard(`e:${id}`); };

  function title(row, { cls = "", open = openCard, attrs = {} } = {}) {
    const span = document.createElement("span");
    if (cls) span.className = cls;
    for (const [k, v] of Object.entries(attrs)) {
      if (k.startsWith("on")) span.addEventListener(k.slice(2), v);
      else span.setAttribute(k, v);
    }
    const raw = rawTitle(row);
    if (!raw) { span.textContent = "Untitled"; return span; }
    let at = 0;
    for (const m of raw.matchAll(MENTION())) {
      if (m.index > at) span.append(raw.slice(at, m.index));
      const [, label, id] = m;
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "m-chip";
      chip.textContent = label.replace(/^@/, "");
      chip.title = `Open ${label.replace(/^@/, "")}'s card`;
      // Its own press: not the row's (which opens the task), nor a drag's start.
      chip.addEventListener("pointerdown", (e) => e.stopPropagation());
      chip.addEventListener("click", (e) => { e.stopPropagation(); e.preventDefault(); open(id, label); });
      chip.addEventListener("dblclick", (e) => e.stopPropagation());
      span.append(chip);
      at = m.index + m[0].length;
    }
    if (at < raw.length) span.append(raw.slice(at));
    return span;
  }

  return { title, rawTitle };
})();
