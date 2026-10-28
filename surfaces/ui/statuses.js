// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore
//
// The task statuses, the person's to define (Settings → Types): their
// order, their words, their colors, which count as done, which a new task
// starts in, and what each means to other apps — one of the five shared states
// (pkm-interchange's task profile `states`), so a sync knows "Blocked" here is
// "waiting" there. The list editor's sheet (listeditor.css) is borrowed for the look.
//
// A status keeps its name when its words change — tasks, board columns and a
// sync point at the name — and one taken away asks where its tasks go. The
// core holds the rules and says when something cannot be (PUT /tasks/statuses).

"use strict";

(() => {
  const PALETTE = ["#868c92", "#5fa4b5", "#7f9fbf", "#8aa878", "#c7a55a", "#c98a5b", "#c26b6b", "#b97f8e", "#6c7277"];

  function el(tag, attrs = {}, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
      else if (k === "class") e.className = v;
      else if (k === "style") e.setAttribute("style", v);
      else e.setAttribute(k, v);
    }
    for (const k of kids.flat()) if (k != null && k !== false) e.append(k);
    return e;
  }

  /** The statuses as the type has them now. */
  function read(type) {
    const p = (type.profiles || {}).task || {};
    const field = type.fields.find((f) => f.key === p.status) || {};
    const labels = field["talaris:labels"] || {};
    const colors = field["talaris:colors"] || {};
    const complete = new Set(p.completeValues || []);
    const states = p.states || {};
    return {
      rows: (field.options || []).map((v) => ({ value: v, label: labels[v] || v, color: colors[v] || "", complete: complete.has(v), state: states[v] || "" })),
      def: type["talaris:defaultStatus"] || (field.options || [])[0],
    };
  }

  // What a status can mean: a finished one done or cancelled, an open one the other three.
  const MEANINGS = { "not-started": "not started", "in-progress": "in progress", waiting: "waiting", done: "done", cancelled: "cancelled" };
  const fits = (complete) => (complete ? ["done", "cancelled"] : ["not-started", "in-progress", "waiting"]);

  function open(ctx) {
    return new Promise((resolve) => {
      const { rows: start, def: startDef } = read(ctx.taskType);
      let rows = start.map((r) => ({ ...r }));
      let def = startDef;
      const moveTo = {};
      const dim = el("div", { class: "le-dim" });
      const sheet = el("div", { class: "le-sheet", role: "dialog" });
      const list = el("div", { class: "st-rows" });
      const gone = el("div", { class: "st-gone" });
      const err = el("div", { class: "le-err" });
      const close = (value) => { dim.remove(); removeEventListener("keydown", esc, true); resolve(value); };
      const esc = (e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(null); } };

      function draw() {
        list.replaceChildren(...rows.map((r, i) => {
          const swatches = el("span", { class: "st-swatches" }, PALETTE.map((c) =>
            el("button", { type: "button", class: "st-sw" + (r.color === c ? " on" : ""), style: `background:${c}`, title: c,
              onclick: () => { r.color = c; draw(); } })));
          return el("div", { class: "st-row" + (r.complete ? " done" : "") },
            el("span", { class: "st-move" },
              el("button", { type: "button", class: "icon-btn", title: "Up", disabled: i === 0 ? "" : null, onclick: () => { [rows[i - 1], rows[i]] = [rows[i], rows[i - 1]]; draw(); } }, "↑"),
              el("button", { type: "button", class: "icon-btn", title: "Down", disabled: i === rows.length - 1 ? "" : null, onclick: () => { [rows[i + 1], rows[i]] = [rows[i], rows[i + 1]]; draw(); } }, "↓")),
            el("span", { class: "st-dot", style: `background:${r.color || "var(--muted)"}` }),
            el("input", { type: "text", class: "st-label", value: r.label, spellcheck: "false", oninput: (e) => { r.label = e.target.value; drawGone(); } }),
            swatches,
            // No browser picker (a <select> opens a window of its own): a button, and a small menu of what fits.
            el("span", { class: "st-means-wrap" },
              el("button", { type: "button", class: "t-btn st-means" + (r.state ? "" : " unset"), title: "What it means to other apps",
                // The kit's menu (kit.js): put away by a press elsewhere or Escape, as every menu is.
                onclick: (e) => {
                  e.stopPropagation();
                  if (Kit.openedBy() === e.currentTarget) { Kit.popAway(); return; }
                  Kit.menu(e.currentTarget, fits(r.complete).map((m) => ({ label: MEANINGS[m], on: r.state === m, act: () => { r.state = m; draw(); } })));
                } }, r.state ? MEANINGS[r.state] : "Means…")),
            el("button", { type: "button", class: "t-btn st-flag" + (r.complete ? " on" : ""), title: "Counts as done", onclick: () => { r.complete = !r.complete; if (r.state && !fits(r.complete).includes(r.state)) r.state = r.complete ? "done" : "not-started"; if (r.complete && def === r.value) def = (rows.find((x) => !x.complete) || {}).value; draw(); } }, "Done"),
            el("button", { type: "button", class: "t-btn st-flag" + (def === r.value && r.value ? " on" : ""), title: "New tasks start here",
              disabled: r.complete || !r.value ? "" : null, onclick: () => { def = r.value; draw(); } }, "Start"),
            el("button", { type: "button", class: "icon-btn", title: "Remove", onclick: () => { rows.splice(i, 1); if (def === r.value) def = (rows.find((x) => !x.complete && x.value) || {}).value; draw(); } }, "×"));
        }));
        drawGone();
      }

      // Statuses taken away: where their tasks go. A finished one's go to a
      // finished status unless said — sending them to the start would reopen
      // them all; an open one's go to the start.
      const fallback = (s) => (s.complete ? (rows.find((r) => r.value && r.complete) || {}).value || def : def);
      function drawGone() {
        const kept = new Set(rows.map((r) => r.value).filter(Boolean));
        const removed = start.filter((s) => !kept.has(s.value));
        const targets = rows.filter((r) => r.value);
        gone.replaceChildren(...(removed.length ? [el("div", { class: "le-muted st-gone-head" }, "Removed — when saved, their tasks move to:")] : []), ...removed.map((s) => {
          const now = moveTo[s.value] && kept.has(moveTo[s.value]) ? moveTo[s.value] : fallback(s);
          return el("div", { class: "le-row" },
            el("span", { class: "le-label" }, s.label),
            el("span", { class: "le-val" },
              targets.map((t) => el("button", { type: "button", class: "t-btn st-flag" + (t.value === now ? " on" : ""), onclick: () => { moveTo[s.value] = t.value; drawGone(); } }, t.label))));
        }));
      }

      async function save() {
        err.textContent = "";
        err.className = "le-err";
        sheet.classList.add("busy");
        try {
          const statuses = rows.map((r) => ({ ...(r.value ? { value: r.value } : {}), label: r.label, ...(r.color ? { color: r.color } : {}), complete: r.complete, ...(r.state ? { state: r.state } : {}) }));
          const kept = new Set(rows.map((r) => r.value).filter(Boolean));
          const moves = {};
          for (const s of start) if (!kept.has(s.value)) moves[s.value] = moveTo[s.value] && kept.has(moveTo[s.value]) ? moveTo[s.value] : fallback(s);
          const type = await ctx.api("PUT", "/tasks/statuses", { statuses, default: def, moveTo: moves });
          close(type);
        } catch (e) {
          err.textContent = e.message;
          sheet.classList.remove("busy");
        }
      }

      sheet.append(
        el("div", { class: "title le-title" }, "Statuses"),
        el("div", { class: "le-muted st-hint" }, "“Means” is what a status is to other apps — a sync with Hermes Notes carries statuses only once every one has a meaning."),
        list,
        el("div", {}, el("button", { type: "button", class: "t-btn", onclick: () => {
          rows.push({ label: "New status", color: PALETTE[rows.length % PALETTE.length], complete: false, state: "" });
          draw();
          const inputs = list.querySelectorAll(".st-label");
          inputs[inputs.length - 1]?.select();
        } }, "+ Status")),
        gone, err,
        el("div", { class: "le-acts" }, el("span", { class: "spacer" }),
          el("button", { type: "button", class: "t-btn", onclick: () => close(null) }, "Cancel"),
          el("button", { type: "button", class: "t-btn le-save", onclick: save }, "Save")));
      dim.append(sheet);
      dim.addEventListener("pointerdown", (e) => { if (e.target === dim) close(null); });
      addEventListener("keydown", esc, true);
      document.body.append(dim);
      draw();
    });
  }

  // The look it adds to the list editor's sheet.
  const style = document.createElement("style");
  style.textContent = `
    .st-rows { display: flex; flex-direction: column; gap: 6px; }
    .st-row { display: flex; align-items: center; gap: 6px; font-size: 12.5px; }
    .st-move { display: inline-flex; }
    .st-move .icon-btn { width: 20px; height: 22px; padding: 0; font-size: 12px; }
    .st-dot { width: 10px; height: 10px; border-radius: 50%; flex: none; }
    .st-label { flex: 1; min-width: 90px; padding: 4px 8px; font-size: 12.5px; }
    .st-row.done .st-label { color: var(--muted); }
    .st-swatches { display: inline-flex; gap: 3px; }
    .st-sw { width: 14px; height: 14px; border-radius: 4px; padding: 0; border: 1px solid transparent !important; cursor: pointer; }
    .st-sw.on { box-shadow: 0 0 0 2px var(--text); }
    .st-flag { font-size: 11.5px !important; padding: 2px 9px !important; }
    .st-flag.on { border-color: var(--accent) !important; color: var(--accent) !important; background: var(--accent-wash) !important; }
    .st-means-wrap { position: relative; display: inline-flex; }
    .st-means { font-size: 11.5px !important; padding: 2px 9px !important; white-space: nowrap; }
    .st-means.unset { color: var(--danger) !important; border-color: var(--danger) !important; }
    .st-menu { position: absolute; top: calc(100% + 4px); left: 0; z-index: 5; display: flex; flex-direction: column; min-width: 120px; padding: 4px; }
    .st-menu .menu-item.on { color: var(--accent); }
    .st-hint { margin: -2px 0 8px; font-size: 11.5px; }
    .st-gone:empty { display: none; }
    .st-gone-head { margin: 6px 0 4px; }
    .st-gone .le-label { text-decoration: line-through; }
  `;
  document.head.append(style);

  window.StatusEditor = { open };
})();
