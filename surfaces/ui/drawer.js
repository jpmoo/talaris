// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore
//
// A drawer's page. It reaches the core through `bridge` — a QWebChannel object
// in the process that holds it — never through a URL, so a write is a function
// call with a string, of any size and any characters.

"use strict";

const NAMES = { canvas: "Canvas", writing: "Writing" };
let bridge = null;
let state = { drawer: "", mode: "filed", edge: "left", project: { id: "", code: "", name: "Home" }, theme: {} };

// Asked of the core as every page asks it (kit.js): one book of what waits, 2xx the answer, given up on if none comes.
const asked = Kit.core((id, method, path, body) => !!bridge && (bridge.request(Number(id), method, path, body), true));
function core(method, path, body) { return asked.call(method, path, body); }
const onReply = (id, status, text) => asked.reply(id, status, text);

const $ = (id) => document.getElementById(id);
function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (k === "class") e.className = v;
    else e.setAttribute(k, v);
  }
  // Nothing (a top canvas's star, say) is left out, not written as "null".
  for (const k of kids) if (k != null && k !== false) e.append(k);
  return e;
}
// Said as every page says it (kit.js): sentence case; an error in the danger color, until something else is said.
function status(text, error = false) { Kit.say($("status"), text, error, 0); }

function applyTheme(theme) {
  const root = document.documentElement;
  root.dataset.mode = theme.mode === "light" ? "light" : "dark";
  root.dataset.motion = theme.motion || "slide";
  if (theme.accent) {
    root.style.setProperty("--accent", theme.accent);
    const n = parseInt(theme.accent.slice(1), 16);
    root.style.setProperty("--accent-wash", `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${theme.mode === "light" ? .16 : .14})`);
  }
  if (theme.font) root.style.setProperty("--font", `'${theme.font}', system-ui, sans-serif`);
  const frame = document.querySelector(".canvas-frame");
  if (frame) shareTheme(frame);
}

// ---------------------------------------------------------------- motion
//
// Slide, draw or none, as Settings says (motion.js has them).
const motion = () => document.documentElement.dataset.motion || "slide";
// What were drawers are panels from the bar (workspace.py): centered over the
// dimmed screen, or — loaded with ?window=1 — an ordinary window, filling it.
const WINDOW = new URLSearchParams(location.search).has("window");
if (WINDOW) document.documentElement.dataset.window = "1";

// How it comes and goes (motion.js), as a panel: from the top, with the rules
// inside it drawn too — under the header, over the footer, beside the side column.
function how() {
  return {
    kind: motion(), speed: (state.theme || {}).motionSpeed, edge: "top", flush: false, viewport: state.viewport,
    shown: () => bridge && bridge.drawn(),
    rules: (rule, rel, P) => {
      const header = document.querySelector("header"), footer = document.querySelector("footer"), side = document.querySelector(".tree");
      if (header) { const r = header.getBoundingClientRect(); rule(rel(P.left, r.bottom + 4), rel(P.right, r.bottom + 4)); }
      if (footer) { const r = footer.getBoundingClientRect(); rule(rel(P.left, r.top - 4), rel(P.right, r.top - 4)); }
      if (side && side.offsetParent) {
        const r = side.getBoundingClientRect(), b = $("body").getBoundingClientRect();
        rule(rel(r.right + 6, b.top), rel(r.right + 6, b.bottom));
      }
    },
  };
}

function arrive() {
  Motion.arrive($("panel"), how());
}

/*
 * Leaving is the arrival backwards: back into the edge it came from, a little
 * quicker and accelerating, the way something is pushed away rather than
 * drawn out. Then the process is told, and moves the surface to its handle.
 */
function leave() {
  if (saveTimer) save();
  // The panel's leaving; a window is not going anywhere.
  if (WINDOW) return;
  if (state.mode === "filed") { bridge.left(); return; }
  // Held at the edge until the new mode arrives, so the panel never springs
  // back into view between the slide ending and the surface moving. Drawn
  // in, it goes the quiet way: it fades.
  // Drawn in, it goes the same way backwards: emptied, its lines shown, the
  // lines drawn back to their marks.
  leaving = Motion.leave($("panel"), how());
  if (!leaving) { bridge.left(); return; }
  leaving.onfinish = () => bridge.left();
}
let leaving = null;

function update(next) {
  if (window.Kit && next.clock) Kit.setClock(next.clock);
  const was = state.mode;
  // Another project: what was open belonged to the last one.
  if (state.project && next.project && state.project.id && next.project.id !== state.project.id) {
    viewing = null;
    open = null;
    canvasTreeCache = null;
  }
  state = next;
  // A window is always out, and fills itself.
  if (WINDOW) state = { ...state, mode: "expanded", insets: { top: 0, right: 0, bottom: 0, left: 0 } };
  document.body.dataset.mode = state.mode;
  // Called back while still going: everything its leaving touched undone — the
  // contents' fades too, which outlast the frame's and would keep it empty.
  if (leaving) { Motion.reset($("panel")); leaving = null; }
  document.body.dataset.edge = state.edge;
  for (const [side, px] of Object.entries(state.insets || {})) document.body.style.setProperty(`--in-${side}`, `${px}px`);
  // A panel's one button makes it a window (the expand corners); a window's closes it.
  $("grow").innerHTML = WINDOW ? Icons.close() : Icons.grow();
  $("grow").title = WINDOW ? "Close" : "Make it a window";
  const look = state.look || {};
  document.body.dataset.outline = look.outline || "focus";
  if (look.dismissOutside) document.body.dataset.dismiss = "1"; else delete document.body.dataset.dismiss;
  if (look.shadow === false) delete document.body.dataset.shadow; else document.body.dataset.shadow = "1";
  for (const end of ["top", "bottom"]) {
    if ((state.room || {})[end] && state.mode === "pulled") document.body.dataset[`room${end[0].toUpperCase()}${end.slice(1)}`] = "1";
    else delete document.body.dataset[`room${end[0].toUpperCase()}${end.slice(1)}`];
  }
  document.body.style.setProperty("--alpha", `${look.opacity ?? 100}%`);
  document.body.style.setProperty("--type-scale", String(state.typeScale ?? 1));
  // The paper — the writing page, the canvas — is always solid inside a frame
  // that may be see-through: what is written on it is read.
  document.body.style.setProperty("--paper-alpha", "100%");
  document.body.dataset.solidPaper = "1";
  const frame = document.querySelector(".canvas-frame");
  if (frame) shareTheme(frame);
  applyTheme(state.theme || {});
  $("handle").title = NAMES[state.drawer] || state.drawer;
  document.body.dataset.drawer = state.drawer;
  // Canvas: a framed grid with a card on it. Writing: lines of a page.
  $("mark").innerHTML = state.drawer === "writing"
    ? '<path d="M2 3h10M2 6h10M2 9h10M2 12h6"/>'
    : '<rect x="1.5" y="1.5" width="11" height="11" rx="2"/><rect x="4" y="4.5" width="4" height="3" rx=".6"/>';
  if (state.drawer !== "canvas") {
    $("where").innerHTML = "";
    $("where").append(state.project.name || "Home", el("span", { class: "slash" }, " / "), NAMES[state.drawer] || state.drawer);
  }
  if (!WINDOW && state.mode !== "filed" && was === "filed") arrive();
  if (state.mode !== "filed") load();
}

// ---------------------------------------------------------------- trees

/**
 * The twisty for one node: ▾ open, ▸ shut, · no children. Which branches are
 * shut is the viewer's, not the project's, so it lives in this page's storage
 * under `store`, and survives a restart.
 */
function shutSet(store) {
  try { return new Set(JSON.parse(localStorage.getItem(store) || "[]")); } catch { return new Set(); }
}
function twisty(key, hasKids, kids, shut, store) {
  if (shut.has(key)) kids.classList.add("shut");
  // The fold mark every page has (kit.js): ▾, turned along when shut. A page with nothing in it, a dot.
  const t = el("span", { class: "tw" + (hasKids ? " kit-caret" + (shut.has(key) ? " shut" : "") : "") }, hasKids ? "▾" : "·");
  if (!hasKids) return t;
  t.addEventListener("click", (e) => {
    e.stopPropagation();
    kids.classList.toggle("shut");
    if (kids.classList.contains("shut")) shut.add(key); else shut.delete(key);
    try { localStorage.setItem(store, JSON.stringify([...shut])); } catch { /* fine */ }
    t.classList.toggle("shut", kids.classList.contains("shut"));
  });
  return t;
}

// ---------------------------------------------------------------- list order

/*
 * Both lists — the writing pages, the canvases — in the viewer's chosen order
 * (kept in this page's storage, per list): as dragged (Manual), by when last
 * edited or made, newest first, or by name. Starred ones, however deep, are
 * also gathered at the top of the list — always in an order of their own,
 * by hand (dragged there; the newly starred last). Dragging a row
 * among its siblings sets the order by hand, which the core keeps for
 * everyone, and turns the list to Manual to show it.
 */
const SORTS = [["manual", "Manual"], ["edited", "Date edited"], ["created", "Date created"], ["name", "Name"]];
const sortStore = (list) => `talaris.${list}.sort`;
function sortOf(list) { try { return localStorage.getItem(sortStore(list)) || "manual"; } catch { return "manual"; } }
function setSort(list, value) { try { localStorage.setItem(sortStore(list), value); } catch { /* fine */ } }
const newest = (k) => (a, b) => String(b.n[k] || "").localeCompare(String(a.n[k] || ""));
const ORDERS = {
  manual: (a, b) => a.i - b.i,
  edited: newest("modified"),
  created: newest("created"),
  name: (a, b) => a.n.title.localeCompare(b.n.title, undefined, { numeric: true, sensitivity: "base" }),
};
function sorted(nodes, list) {
  const by = ORDERS[sortOf(list)] || ORDERS.manual;
  return nodes.map((n, i) => ({ n, i })).sort((a, b) => by(a, b) || a.i - b.i).map((x) => x.n);
}

/**
 * The starred, from anywhere in the tree, as a section of their own at the top:
 * each a row that opens it, with where it lives beneath its name. In the
 * order they were dragged into (`kept`, keys as `keyOf` gives them), then the
 * rest as the tree has them; dragged among themselves, the new order is
 * handed to `commit`.
 */
function starredSection(roots, list, keyOf, kept, row, commit) {
  const found = [];
  const walk = (nodes, trail) => {
    for (const n of nodes) {
      if (n.starred) found.push({ n, trail });
      walk(n.children || [], [...trail, n.title]);
    }
  };
  walk(roots, []);
  if (!found.length) return "";
  const rank = (f) => { const i = kept.indexOf(keyOf(f.n)); return i < 0 ? kept.length : i; };
  const order = found.map((f, i) => ({ f, i })).sort((a, b) => rank(a.f) - rank(b.f) || a.i - b.i).map((x) => x.f);
  const keys = order.map((f) => keyOf(f.n));
  return el("div", { class: "starred" },
    el("div", { class: "label section" }, "STARRED"),
    ...order.map((f) => {
      const r = row(f.n, f.trail.join(" / "));
      dragRow(r, `${list}-starred`, "", keyOf(f.n), keys, commit);
      return r;
    }));
}

/** The list's order, chosen from a small menu under its button. */
function sortButton(list, reload) {
  const name = (SORTS.find(([k]) => k === sortOf(list)) || SORTS[0])[1];
  const b = el("button", { class: "sort-btn", title: "Order the list" }, `${name.toUpperCase()} ▾`);
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    if (Kit.openedBy() === b) { closeMenu(); return; }
    Kit.pop(b, el("div", { class: "menu-list" },
      ...SORTS.map(([k, l]) => el("button", { class: "menu-item" + (k === sortOf(list) ? " on" : ""), onclick: () => { closeMenu(); setSort(list, k); reload(); } }, l)),
      el("div", { class: "menu-sep" }), el("div", { class: "hint" }, "Drag to order by hand")));
  });
  return el("div", { class: "list-head" }, b);
}

// ---------------------------------------------------------------- tags

/*
 * A page's tags (tags.ts: kept on the page's entity, so a rename carries them
 * and an undated note's travel to Hermes Notes): chips under the page, × to
 * take one off, and a field to add one, offered the tags already in use. And
 * the list filtered to one tag — the pages of this set carrying it, flat.
 */
const tagFilter = new Map((() => { try { return JSON.parse(localStorage.getItem("talaris.writing.tagFilter") || "[]"); } catch { return []; } })());
function setTagFilter(tag) {
  if (tag) tagFilter.set(wpid(), tag); else tagFilter.delete(wpid());
  try { localStorage.setItem("talaris.writing.tagFilter", JSON.stringify([...tagFilter])); } catch { /* fine */ }
  loadWriting();
}
function tagFilterButton() {
  const on = tagFilter.get(wpid());
  const b = el("button", { class: "sort-btn tag-filter" + (on ? " on" : ""), title: on ? `Showing only #${on}` : "Show only pages with a tag" }, on ? `#${on} ▾` : "TAG ▾");
  b.addEventListener("click", async (e) => {
    e.stopPropagation();
    if (Kit.openedBy() === b) { closeMenu(); return; }
    const all = await core("GET", "/tags").catch(() => []);
    // The kit's menu (kit.js): a box on top to narrow the tags as they are typed, then it scrolls.
    Kit.menu(b, [{ label: "All pages", on: !on, act: () => setTagFilter(null) }, ...(all.length ? ["sep"] : []),
      ...all.map(({ tag, count }) => ({ label: `#${tag}`, sub: String(count), title: `#${tag}`, on: tag === on, act: () => setTagFilter(tag) }))]);
  });
  return b;
}
/** The pages carrying the filter's tag, flat, each with where it sits. */
function taggedList(pages, paths) {
  const flat = [];
  const walk = (nodes) => { for (const n of nodes) { if (paths.has(n.path)) flat.push(n); walk(n.children); } };
  walk(pages);
  if (!flat.length) return Kit.empty("No page here has that tag");
  return el("div", {}, ...flat.map((n) => el("div", { class: "row" + (n.path === open ? " on" : ""), onclick: () => edit(n.path) },
    el("span", { class: "starred-t" }, n.title, n.path.includes("/") ? el("span", { class: "where" }, n.path.slice(0, n.path.lastIndexOf("/"))) : ""))));
}
async function drawPageTags() {
  const box = $("pageTags");
  if (!box) return;
  if (!open) { box.replaceChildren(); return; }
  const path = open, pid = wpid();
  const tags = await core("GET", `/projects/${pid}/page/tags?path=${encodeURIComponent(path)}`).catch(() => []);
  if (open !== path) return;
  const save = async (next) => {
    try { await core("PUT", `/projects/${pid}/page/tags?path=${encodeURIComponent(path)}`, { tags: next }); }
    catch (e) { status(String(e.message || e), true); }
    drawPageTags();
    if (tagFilter.get(pid)) loadWriting();
  };
  const input = el("input", { type: "text", class: "tag-add", placeholder: tags.length ? "+ tag" : "Add a tag", spellcheck: "false", autocomplete: "off" });
  const add = (t) => { if (t && !tags.includes(t)) save([...tags, t]); else input.value = ""; };
  /*
   * The tags already in use, offered as it is typed, in the drawer's own menu
   * — themed, and scrolling when there are many. It was a <datalist>, which is
   * the browser's own list: drawn in no theme, and no taller than it chose.
   * Above the box when there is more room there (the tags sit at the page's foot).
   */
  let known = [], offered = [], at = -1;
  core("GET", "/tags").then((all) => { known = all; if (document.activeElement === input) offer(); }).catch(() => {});
  let offeredList = null;
  const mark = () => offeredList && [...offeredList.children].forEach((b, i) => { b.classList.toggle("hot", i === at); if (i === at) b.scrollIntoView({ block: "nearest" }); });
  const offer = () => {
    closeMenu();
    at = -1;
    const q = input.value.trim().replace(/^#+/, "").toLowerCase();
    offered = known.filter(({ tag }) => !tags.includes(tag) && Kit.matches(q, tag));
    if (!offered.length || document.activeElement !== input) return;
    offeredList = el("div", { class: "menu-list" }, ...offered.map(({ tag, count }) =>
      el("button", { class: "menu-item", title: `#${tag}`, onmousedown: (e) => { e.preventDefault(); closeMenu(); add(tag); } },
        el("span", { class: "tg" }, `#${tag}`), el("span", { class: "n" }, String(count)))));
    // Placed by the kit (kit.js): under the box, or above it when there is more room there (the tags sit at the page's foot).
    Kit.pop(input, offeredList);
  };
  input.addEventListener("focus", offer);
  input.addEventListener("input", offer);
  input.addEventListener("blur", () => setTimeout(() => { if (document.activeElement !== input) closeMenu(); }, 0));
  input.addEventListener("keydown", (e) => {
    if ((e.key === "ArrowDown" || e.key === "ArrowUp") && Kit.isOpen() && offered.length) {
      e.preventDefault();
      at = e.key === "ArrowDown" ? (at + 1) % offered.length : (at - 1 + offered.length) % offered.length;
      mark();
    } else if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      const chosen = at >= 0 && e.key === "Enter" ? offered[at].tag : input.value.trim().replace(/^#+/, "").trim();
      closeMenu();
      add(chosen);
    } else if (e.key === "Backspace" && !input.value && tags.length) save(tags.slice(0, -1));
    else if (e.key === "Escape") { closeMenu(); input.value = ""; input.blur(); e.stopPropagation(); }
  });
  box.replaceChildren(
    ...tags.map((t) => el("span", { class: "tag-chip" }, `#${t}`, el("button", { title: `Take off #${t}`, onclick: () => save(tags.filter((x) => x !== t)) }, "×"))),
    input);
}

/** A row's star: on, it is kept at the top of its list. */
function starButton(starred, set) {
  return el("button", { class: "star" + (starred ? " on" : ""), title: starred ? "Unstar" : "Star: keep it at the top", draggable: "false",
    onclick: (e) => { e.stopPropagation(); set(!starred); } }, starred ? "★" : "☆");
}

/*
 * A row dragged among its siblings: a line shows where it will land, and the
 * siblings' new order, as shown, is handed to `commit`. Only within the same
 * parent — moving a page or a canvas to another parent is its own act.
 */
// Dragged as every list's are (kit.js): by pointer, a copy following it, the one drop line.
function dragRow(row, list, parent, key, keys, commit) {
  Kit.draggable(row, { list, parent, key }, { ignore: "button, input, .tw" });
  Kit.dropZone(row, {
    accepts: (p) => p.list === list && p.parent === parent && p.key !== key,
    drop: (p, where) => {
      const next = keys.filter((k) => k !== p.key);
      next.splice(next.indexOf(key) + (where === "below" ? 1 : 0), 0, p.key);
      setSort(list, "manual");
      commit(next);
    },
  });
}

// ---------------------------------------------------------------- canvas

const CANVAS_SHUT = "talaris.canvas.shut";
const TREE_KEY = "talaris.canvas.tree";
const LIST_KEY = "talaris.writing.list";
let viewing = null;  // the canvas on show; new canvases go inside it
let canvasTreeCache = null;

// What the canvas frame asks for, it asks through these: only this frame can
// reach the process, so the canvas borrows its door.
window.talarisCore = (method, path, body) => core(method, path, body);
// What every @ in the drawer works from (mentions.js): this project's things
// first, and a page or a canvas opened where it lives.
// Files dropped into a page or a canvas note are this project's (files.js).
window.talarisFileDefaults = TalarisFiles(core, () => state.project.id, () => bridge);
let lastOpened = { id: "", at: 0 };
window.talarisMentionDefaults = {
  project: () => state.project.id,
  openPlace: (p) => bridge && bridge.openPlace(p.kind, p.project, p.where),
  openPerson: (id) => bridge && bridge.openPerson(id),
  openTask: (id) => bridge && bridge.openTask(id),
  openEvent: (calendar, uid, start) => bridge && bridge.openEvent(calendar, uid, start),
  openUrl: (url) => bridge && bridge.openUrl(url),
};
window.talarisStatus = (text) => status(text);

function pathTo(tree, id, trail = []) {
  if (tree.id === id) return [...trail, tree];
  for (const c of tree.children) {
    const found = pathTo(c, id, [...trail, tree]);
    if (found) return found;
  }
  return null;
}

async function loadCanvas() {
  const tree = await core("GET", `/projects/${state.project.id}/canvases`);
  canvasTreeCache = tree;
  if (!viewing || !pathTo(tree, viewing)) viewing = tree.id;
  const trail = pathTo(tree, viewing);
  const shut = shutSet(CANVAS_SHUT);
  let count = 0;
  const pid = state.project.id;
  const walk = (node, parent, siblings) => {
    count++;
    const kids = el("div", { class: "kids" });
    const children = sorted(node.children, "canvas");
    for (const c of children) kids.append(walk(c, node.id, children.map((x) => x.id)));
    const row = el("div", { class: "row" + (node.id === viewing ? " on" : ""), onclick: () => view(node.id), ondblclick: () => renameCanvas(node) },
      el("span", {}, twisty(node.id, node.children.length > 0, kids, shut, CANVAS_SHUT), node.title),
      parent ? star(node) : null);
    // The top canvas has no siblings to be ordered among.
    if (parent) dragRow(row, "canvas", parent, node.id, siblings, async (ids) => { await core("PUT", `/projects/${pid}/canvases/${parent}/order`, { children: ids }); loadCanvas(); });
    return el("div", {}, row, kids);
  };

  // The trail is the header: each step goes back up to that canvas.
  const where = $("where");
  where.replaceChildren(state.project.name || "Home");
  for (const step of trail) {
    where.append(el("span", { class: "slash" }, " / "),
      el("span", { class: "crumb", title: "Double-click to rename", onclick: () => view(step.id), ondblclick: () => renameCanvas(step) }, step.title));
  }

  const frame = el("iframe", {
    class: "canvas-frame",
    src: `canvas/index.html?project=${encodeURIComponent(state.project.id)}&canvas=${encodeURIComponent(viewing)}`,
    title: "Canvas",
  });
  frame.addEventListener("load", () => shareTheme(frame));
  const star = (node) => starButton(node.starred, async (on) => { await core("PUT", `/projects/${pid}/canvases/${node.id}/star`, { starred: on }); loadCanvas(); });
  const starredRow = (node, where) => el("div", { class: "row" + (node.id === viewing ? " on" : ""), onclick: () => view(node.id), ondblclick: () => renameCanvas(node) },
    el("span", { class: "starred-t" }, node.title, where ? el("span", { class: "where" }, where) : ""), star(node));
  const kept = await core("GET", `/projects/${pid}/starred-order`).catch(() => ({ canvases: [] }));
  const treePane = el("div", { class: "tree canvas-tree" }, sortButton("canvas", loadCanvas),
    starredSection(tree.children, "canvas", (n) => n.id, kept.canvases || [], starredRow,
      async (keys) => { await core("PUT", `/projects/${pid}/starred-order`, { kind: "canvases", keys }); loadCanvas(); }),
    walk(tree, null, []));
  const listKey = `canvas:${pid}`, top = scrolledTo(listKey);
  $("body").replaceChildren(treePane, el("div", { class: "canvas-pane" }, frame));
  scrollBack(treePane, listKey, top);
  $("count").textContent = `${state.project.code} · ${count} CANVAS${count === 1 ? "" : "ES"}`;
  // Making a canvas inside belongs with the tree it lands in: shown with it.
  const inside = el("button", { onclick: newCanvas }, "New canvas inside");
  const node = trail[trail.length - 1];
  const actions = [
    sideToggle(treePane, TREE_KEY, "tree", [inside]),
    " ", inside,
    " ", el("button", { onclick: () => renameCanvas(node) }, "Rename"),
  ];
  if (viewing !== tree.id) {
    actions.push(" ", el("button", { class: "danger", onclick: () => deleteCanvas(node, trail[trail.length - 2]) }, "Delete"));
  }
  $("actions").replaceChildren(...actions);
  status("");
  // What is on show, for "what is current" (desktop_api.py).
  if (bridge) bridge.seen(JSON.stringify({ canvas: { id: viewing, title: node.title, trail: trail.map((t) => t.title) } }));
}

/*
 * Hide or show the side column — the canvas tree, the writing list —
 * remembered for each. The calendar's button (icons.js), lit while it shows.
 */
function sideToggle(pane, key, noun, along = []) {
  const shown = () => { try { return localStorage.getItem(key) !== "off"; } catch { return true; } };
  // What goes with the side column (its own buttons) comes and goes with it.
  const follow = () => { for (const e of [pane, ...along]) e.classList.toggle("hidden", !shown()); };
  follow();
  const button = el("button", { class: "icon-btn side-toggle" });
  button.innerHTML = Icons.sideList();
  const label = () => { button.title = `${shown() ? "Hide" : "Show"} the ${noun}`; button.classList.toggle("on", shown()); };
  button.addEventListener("click", () => {
    try { localStorage.setItem(key, shown() ? "off" : "on"); } catch { /* fine */ }
    follow();
    label();
  });
  label();
  return button;
}

function view(id) {
  viewing = id;
  loadCanvas();
}

/*
 * Where a list was scrolled, kept across its being drawn again. Choosing a
 * page or a canvas draws the whole tree afresh, and a new one starts at the
 * top: a page chosen far down Home's list sent the list back up past it.
 * Kept only for the same list (`key`: the drawer, the tab, the project).
 */
function scrolledTo(key) {
  const t = $("body").querySelector(".tree");
  return t && t.dataset.list === key ? t.scrollTop : 0;
}
function scrollBack(tree, key, top) {
  tree.dataset.list = key;
  if (top) tree.scrollTop = top;
}

// The canvas's own theme follows the drawer's: mode, accent and typeface.
function shareTheme(frame) {
  try {
    const mine = document.documentElement;
    const theirs = frame.contentDocument.documentElement;
    theirs.dataset.mode = mine.dataset.mode || "dark";
    for (const v of ["--accent", "--accent-wash", "--font"]) {
      const value = mine.style.getPropertyValue(v);
      if (value) theirs.style.setProperty(v, value);
    }
    // The drawer's opacity, so the canvas's paper is as see-through as its frame.
    theirs.style.setProperty("--alpha", document.body.style.getPropertyValue("--paper-alpha") || "100%");
    // Settings' canvas size: the type in notes and shapes.
    theirs.style.setProperty("--type-scale", document.body.style.getPropertyValue("--type-scale") || "1");
  } catch { /* not loaded yet */ }
}

// A canvas card double-clicked inside the frame.
addEventListener("message", (e) => {
  const m = e.data;
  if (m && m.talaris === "open-url" && /^https?:/.test(m.url || "")) { bridge && bridge.openUrl(m.url); return; }
  // A mention clicked in a canvas note: the peek opens over the panel.
  // A card's double-click (open-entity) too: a page or a canvas opens where it is, anything else peeks.
  // A card sends both, one after the other: the second is the same opening.
  if (m && (m.talaris === "peek" || m.talaris === "open-entity") && typeof m.id === "string") {
    const now = Date.now();
    if (lastOpened.id !== m.id || now - lastOpened.at > 500) TalarisMentions(core).open(m.id);
    lastOpened = { id: m.id, at: now };
    return;
  }
  if (m && m.talaris === "status") { status(String(m.text || "")); return; }
  if (m && m.talaris === "exported") {
    // Where it went, said once, and a click away from opening.
    const full = `${m.folder}/${m.path}`;
    const said = $("status");
    said.replaceChildren(el("span", { class: "exported", title: "Open it", onclick: () => bridge && bridge.openPath(full) },
      `SAVED TO ${m.path.toUpperCase()} — OPEN ↗`));
    return;
  }
  if (!m || m.talaris !== "open-canvas") return;
  if (m.project && m.project !== state.project.id) {
    status("Other projects arrive with projects");
    return;
  }
  view(m.canvas);
});

// A new name for a canvas, the top one too; its cards everywhere follow (the core).
function renameCanvas(node) {
  askName(`Rename “${node.title}”`, node.title, async (title) => {
    await core("PUT", `/projects/${state.project.id}/canvases/${node.id}/title`, { title });
    loadCanvas();
  });
}

function deleteCanvas(node, parent) {
  const pid = state.project.id;
  const gone = () => { viewing = parent ? parent.id : null; loadCanvas(); };
  confirmDelete(`Delete “${node.title}”?`, "Its card comes off its parent canvas. A copy is kept in its versions.", async () => {
    const { count } = await core("GET", `/projects/${pid}/canvases/${node.id}/below`);
    if (!count) { await core("DELETE", `/projects/${pid}/canvases/${node.id}`); gone(); return; }
    // Something inside it: asked again, saying what else goes.
    return () => confirmDelete(`Delete everything inside “${node.title}” too?`,
      `${count === 1 ? "1 canvas is" : `${count} canvases are`} inside it, and ${count === 1 ? "it goes" : "they all go"} with it. A copy of each is kept in its versions.`,
      async () => { await core("DELETE", `/projects/${pid}/canvases/${node.id}?all=1`); gone(); }, `Delete all ${count + 1}`);
  });
}

async function newCanvas() {
  const tree = canvasTreeCache ?? await core("GET", `/projects/${state.project.id}/canvases`);
  const parent = viewing ?? tree.id;
  // Named for when it was made, until it is renamed.
  await core("POST", `/projects/${state.project.id}/canvases/${parent}/children`, { title: "" });
  const shut = shutSet(CANVAS_SHUT);
  shut.delete(parent);
  try { localStorage.setItem(CANVAS_SHUT, JSON.stringify([...shut])); } catch { /* fine */ }
  // The new card lands on the canvas on show, so reload it.
  loadCanvas();
}

// ---------------------------------------------------------------- writing

/*
 * Three ways to look at a page, remembered per viewer:
 *
 * - **Live** — every block rendered except the one the caret is in, which shows
 *   its own Markdown. Talaria's editor, Obsidian's idea. The default.
 * - **Raw** — the whole file as text.
 * - **Preview** — rendered, to read.
 *
 * The text is the same in all three, and the file round-trips byte for byte:
 * the live editor rejoins its blocks exactly as they were cut.
 */
let open = null;      // path of the page being edited
let text = "";        // its Markdown, as the page holds it now
let saveTimer = null;
const WRITING_SHUT = "talaris.writing.shut";
const MODE_KEY = "talaris.writing.mode";
let mode = (() => { try { return localStorage.getItem(MODE_KEY) || "live"; } catch { return "live"; } })();
let modules = null;
// The editor is CodeMirror 6 with live preview, built from packages/editor.
const editorModules = () => (modules ??= Promise.all([import("./editor.js"), import("./markdown.js")])
  .then(([ed, md]) => ({ createEditor: ed.createEditor, render: md.render })));
let editor = null;   // the one editor, kept across Live and Raw

// The files a page links (`talaris:file` chips), listed under it to open.
const FILE_LINK = () => /\[([^\]\n]*)\]\(talaris-file:([^)\s]+)\)/g;
function drawPageFiles() {
  const box = $("pageFiles");
  if (!box) return;
  const seen = new Map();
  for (const m of (open ? text : "").matchAll(FILE_LINK())) {
    const path = decodeURI(m[2]).replace(/%28/g, "(").replace(/%29/g, ")");
    if (!seen.has(path)) seen.set(path, m[1] || path.split("/").pop());
  }
  box.replaceChildren(...(seen.size ? [el("span", { class: "label" }, `FILES · ${seen.size}`),
    ...[...seen].map(([path, name]) => el("button", { class: "file-chip", title: path, onclick: () => bridge && bridge.openProjectFile(state.project.id, path) }, name))] : []));
}

function changed(next) {
  text = next;
  drawPageFiles();
  clearTimeout(saveTimer);
  status("Editing");
  saveTimer = setTimeout(save, 600);
}

async function drawEditor() {
  const host = $("editorHost");
  if (!host) return;
  host.dataset.mode = mode;
  for (const b of document.querySelectorAll("#modes button")) b.classList.toggle("on", b.dataset.mode === mode);
  if (!open) { host.replaceChildren(el("div", { class: "empty" }, "Pick a page, or make one")); return; }
  const { createEditor, render } = await editorModules();
  if (mode === "preview") {
    if (editor) { editor.destroy(); editor = null; }
    const view = el("div", { class: "preview" });
    view.append(text.trim() ? render(text) : el("p", { class: "empty" }, "Nothing written yet"));
    // Ticking a box in Preview writes `[ ]` ↔ `[x]` on its line and nothing else.
    for (const box of view.querySelectorAll('input[type="checkbox"]')) {
      box.disabled = false;
      box.addEventListener("change", () => {
        const lines = text.split("\n");
        const at = Number(box.dataset.line);
        lines[at] = lines[at].replace(/\[([ xX])\]/, box.checked ? "[x]" : "[ ]");
        changed(lines.join("\n"));
        drawEditor();
      });
    }
    host.replaceChildren(view);
    return;
  }
  // Live and Raw are the same editor with the preview on or off, so switching
  // between them keeps the cursor and the undo history.
  if (editor && host.contains(document.querySelector(".cm-editor"))) {
    editor.setLive(mode === "live");
  } else {
    if (editor) editor.destroy();
    host.replaceChildren();
    editor = createEditor(host, text, {
      live: mode === "live",
      onChange: changed,
      onOpenUrl: (url) => bridge && bridge.openUrl(url),
      // @ names anything; a mention clicked opens it, or peeks at it (mentions.js, peek.js).
      mentions: TalarisMentions(core),
      // A file dropped or pasted is kept in the project and linked (files.js).
      files: window.talarisFileDefaults,
    });
  }
  if (paperOf !== open) paperFor(open);
  drawPageFiles();
  editor.focus();
}

function setMode(next) {
  mode = next;
  try { localStorage.setItem(MODE_KEY, mode); } catch { /* fine */ }
  drawEditor();
}

// ---------------------------------------------------------------- daily

/*
 * Daily notes: pages at `Daily/<date>`, opened from a month calendar. A day is
 * a note once something is written in it, so opening a day makes no file.
 * Each day with a note shows how many words it holds — a number, not a dot,
 * because a number says something.
 */
const DAILY = "Daily";

/*
 * Three sets of notes, a tab each (DESIGN, Writing):
 *   Project — this project's own pages (Home's own, in Home: not its Pages
 *             or its Daily, which have tabs of their own);
 *   Pages   — the pages of no other project: Home's `Pages`, the same from
 *             every project (scope `undated`; kept in Home/Writing/Pages,
 *             and in Hermes Notes as its notes);
 *   Daily   — Home's daily notes, the only ones there are: from any other
 *             project they are said to be Home's, plainly, so a day written
 *             there is not mistaken for this project's.
 * A note moves or is copied between Project and Pages, either way; a daily
 * note stays where it is. Which tab was last chosen is this page's to keep.
 */
const PAGES = "Pages";
const SCOPE_KEY = "talaris.writing.scope";
let scope = (() => { try { return localStorage.getItem(SCOPE_KEY) || "project"; } catch { return "project"; } })();
let homeId = "";
const openIn = { project: new Map(), undated: null }; // the page last open in each, per project for Project
const wpid = () => (scope === "undated" || scope === "daily" ? homeId : state.project.id);
const inHome = () => Boolean(state.project.home);
async function setScope(next) {
  if (next === scope) return;
  if (saveTimer) { clearTimeout(saveTimer); await save(); }
  if (editor) { editor.destroy(); editor = null; }
  if (scope === "project") openIn.project.set(state.project.id, open);
  if (scope === "undated") openIn.undated = open;
  scope = next;
  try { localStorage.setItem(SCOPE_KEY, scope); } catch { /* fine */ }
  open = scope === "daily" ? `${DAILY}/${today()}` : scope === "undated" ? openIn.undated : openIn.project.get(state.project.id) ?? null;
  if (scope === "daily") shownMonth = today().slice(0, 7);
  loadWriting();
}
const pad = (n) => String(n).padStart(2, "0");
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const today = () => iso(new Date());
let shownMonth = today().slice(0, 7);
let dailyOn = false;
const isDaily = (path) => path && path.startsWith(`${DAILY}/`);

function step(date, days) {
  const [y, m, d] = date.split("-").map(Number);
  return iso(new Date(y, m - 1, d + days));
}

async function drawCalendar() {
  const host = $("calendar");
  if (!host) return;
  const { enabled, days } = await core("GET", `/projects/${wpid()}/daily?month=${shownMonth}`);
  dailyOn = enabled;
  const words = new Map(days.map((d) => [d.date, d.words]));
  const [y, m] = shownMonth.split("-").map(Number);
  const first = new Date(y, m - 1, 1);
  const count = new Date(y, m, 0).getDate();
  const name = Kit.month(first);
  const openDate = isDaily(open) ? open.slice(DAILY.length + 1) : null;
  const month = (delta) => () => {
    const d = new Date(y, m - 1 + delta, 1);
    shownMonth = `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
    drawCalendar();
  };
  const grid = el("div", { class: "cal-grid" });
  for (const w of ["S", "M", "T", "W", "T", "F", "S"]) grid.append(el("span", { class: "cal-head" }, w));
  for (let i = 0; i < first.getDay(); i++) grid.append(el("span"));
  for (let day = 1; day <= count; day++) {
    const date = `${shownMonth}-${pad(day)}`;
    const n = words.get(date);
    const cls = ["cal-day", n ? "has" : "", date === today() ? "today" : "", date === openDate ? "on" : ""].filter(Boolean).join(" ");
    grid.append(el("button", { class: cls, title: n ? `${n} words` : "", onclick: () => edit(`${DAILY}/${date}`) },
      el("span", {}, String(day)), el("small", {}, n ? String(n) : "")));
  }
  host.replaceChildren(
    el("div", { class: "cal-bar" },
      el("span", { class: "label" }, "DAILY"),
      el("span", { class: "cal-nav" },
        el("button", { title: "Previous day", onclick: () => edit(`${DAILY}/${step(openDate ?? today(), -1)}`) }, "◂"),
        el("button", { onclick: () => { shownMonth = today().slice(0, 7); edit(`${DAILY}/${today()}`); } }, "TODAY"),
        el("button", { title: "Next day", onclick: () => edit(`${DAILY}/${step(openDate ?? today(), 1)}`) }, "▸"))),
    el("div", { class: "cal-month" },
      el("button", { class: "flat", onclick: month(-1) }, "‹"), el("span", { class: "label" }, name.toUpperCase()),
      el("button", { class: "flat", onclick: month(1) }, "›")),
    grid);
}

function pageHeading() {
  if (!open) return "";
  if (scope === "daily" && isDaily(open)) {
    const [y, m, d] = open.slice(DAILY.length + 1).split("-").map(Number);
    // Said for what it is, the day's own page: "Daily page for Sunday, October 25, 2026" — and, away from Home, whose.
    return `Daily page for ${new Date(y, m - 1, d).toLocaleDateString("en-US", { weekday: "long", day: "numeric", month: "long", year: "numeric" })}${inHome() ? "" : " · in Home"}`.toUpperCase();
  }
  return (scope === "undated" ? `Pages · ${open.slice(PAGES.length + 1).split("/").join(" / ")}${inHome() ? "" : " · in Home"}` : open.split("/").join(" / ")).toUpperCase();
}

async function loadWriting() {
  if (!homeId) homeId = ((await core("GET", "/projects")).find((p) => p.home) || {}).id || "";
  dailyOn = scope === "daily";
  if (dailyOn && !isDaily(open)) open = `${DAILY}/${today()}`;
  if (dailyOn && isDaily(open)) shownMonth = open.slice(DAILY.length + 1, DAILY.length + 8);
  // A tag chosen to filter by (this set of pages'): the pages carrying it, by path.
  const filterTag = dailyOn ? null : tagFilter.get(wpid()) ?? null;
  const filterPaths = filterTag
    ? new Set((await core("GET", `/tags/things?tag=${encodeURIComponent(filterTag)}&kind=page`).catch(() => [])).filter((x) => x.page && x.page.project === wpid()).map((x) => x.page.path))
    : null;
  // Home's own pages hold its daily notes and its Pages too: each shown on its own tab, not among its pages.
  const all = dailyOn ? [] : await core("GET", `/projects/${wpid()}/pages`);
  const pages = scope === "undated" ? ((all.find((n) => n.path === PAGES) || {}).children || [])
    : all.filter((n) => !(scope === "project" && inHome() && (n.path === DAILY || n.path === PAGES)));
  // Where the tree's top is: Pages, for its tab.
  const root = scope === "undated" ? PAGES : "";
  const shut = shutSet(WRITING_SHUT);
  let count = 0;
  const pid = wpid();
  const star = (n) => starButton(n.starred, async (on) => { await core("PUT", `/projects/${pid}/page/star?path=${encodeURIComponent(n.path)}`, { starred: on }); loadWriting(); });
  const kept = await core("GET", `/projects/${pid}/starred-order`).catch(() => ({ pages: [] }));
  const starredRow = (n, where) => el("div", { class: "row" + (n.path === open ? " on" : ""), onclick: () => edit(n.path), ondblclick: () => renamePage(n) },
    el("span", { class: "starred-t" }, n.title, where ? el("span", { class: "where" }, where) : ""), star(n));
  const branch = (nodes, parent) => {
    const wrap = el("div");
    const shown = sorted(nodes, "writing");
    const names = shown.map((n) => n.title);
    for (const n of shown) {
      count++;
      const kids = branch(n.children, n.path);
      kids.className = "kids";
      const twist = twisty(n.path, n.children.length > 0, kids, shut, WRITING_SHUT);
      const row = el("div", { class: "row" + (n.path === open ? " on" : ""), title: n.title, onclick: () => edit(n.path), ondblclick: () => renamePage(n) },
        el("span", {}, twist, n.title), star(n));
      dragRow(row, "writing", parent, n.title, names, async (order) => { await core("PUT", `/projects/${pid}/pages/order`, { parent, names: order }); loadWriting(); });
      wrap.append(el("div", {}, row, kids));
    }
    return wrap;
  };
  const tab = (s, label, title) => el("button", { class: "wtab" + (scope === s ? " on" : ""), title, onclick: () => setScope(s) }, label);
  const tabs = el("div", { class: "wtabs", role: "tablist" },
    tab("project", inHome() ? "Home" : state.project.name, "This project's own pages"),
    tab("daily", "Daily", "Home's daily pages"),
    tab("undated", "Pages", "Home's pages of no other project — the same from every project"));
  // Away from its own project's notes, the drawer says so, at the top of the list — Home's daily notes from another project.
  const whose = scope === "daily" && !inHome() ? el("div", { class: "whose" }, el("b", {}, "Home's"), " daily pages — not ", el("b", {}, state.project.name), "'s")
    : scope === "undated" && !inHome() ? el("div", { class: "whose" }, el("b", {}, "Home's"), " pages — not ", el("b", {}, state.project.name), "'s")
    : "";
  const tree = el("div", { class: "tree" + (scope !== "project" && !inHome() ? " away" : "") },
    tabs, whose,
    dailyOn ? el("div", { class: "calendar", id: "calendar" }) : "",
    !dailyOn && (pages.length || filterTag) ? (() => { const head = sortButton("writing", loadWriting); head.append(tagFilterButton()); return head; })() : "",
    dailyOn ? "" : starredSection(pages, "writing", (n) => n.path, kept.pages || [], starredRow,
      async (keys) => { await core("PUT", `/projects/${pid}/starred-order`, { kind: "pages", keys }); loadWriting(); }),
    dailyOn ? "" : filterTag ? taggedList(pages, filterPaths)
      : pages.length ? branch(pages, root) : Kit.empty("No pages yet"));
  const modes = el("div", { class: "modes", id: "modes" },
    ...["live", "raw", "preview"].map((m) => el("button", { "data-mode": m, onclick: () => setMode(m) }, m.toUpperCase())));
  // Files chosen in the desktop's chooser, kept in the project, linked at the cursor:
  // a thing done to the page, so apart from the ways of seeing it.
  const attach = el("button", { class: "attach", title: "Attach files (or drop them in)", onclick: () => { if (bridge && open) bridge.attachToProject(wpid()); } }, "ATTACH");
  const pane = el("div", { class: "pane" },
    el("div", { class: "pane-bar" }, el("span", { class: "label", id: "heading" }, pageHeading()), el("span", { class: "spacer" }), attach, modes),
    el("div", { class: "editor", id: "editorHost" }),
    el("div", { class: "page-files", id: "pageFiles" }),
    el("div", { class: "page-tags", id: "pageTags" }));
  const listKey = `writing:${scope}:${pid}`, top = scrolledTo(listKey);
  $("body").replaceChildren(tree, pane);
  scrollBack(tree, listKey, top);
  $("count").textContent = scope === "daily" ? "HOME · DAILY" : `${scope === "undated" ? "HOME · PAGES" : state.project.code} · ${count} PAGE${count === 1 ? "" : "S"}`;
  const actions = [sideToggle(tree, LIST_KEY, "list")];
  if (!dailyOn) actions.push(" ", el("button", { onclick: () => newPage(scope === "undated" ? PAGES : null) }, "New page"));
  // What plugins put on the undated notes (Sync all notes) and on one of them (Sync now): peek.js, as People's and Tasks' are.
  if (scope === "undated" && window.Peek) {
    actions.push(" ", Peek.actionButtons("notes", null, core, ""));
    if (open) actions.push(" ", Peek.actionButtons("note", `${homeId}/${open}`, core, ""));
  }
  // And on the daily notes as a whole (Sync all with Hermes Notes).
  if (scope === "daily" && window.Peek) actions.push(" ", Peek.actionButtons("daily", null, core, ""));
  if (open && !dailyOn) {
    const here = { path: open, title: open.split("/").pop() };
    // Across: from this project to Home's Pages, or from them into this project.
    const other = scope === "undated" ? (inHome() ? "Home" : state.project.name) : "Pages";
    actions.push(" ", el("button", { onclick: () => newPage(open) }, "New page inside"),
      " ", el("button", { onclick: () => renamePage(here) }, "Rename"),
      " ", el("button", { onclick: () => transfer(false) }, `Move to ${other}`),
      // Connected, not copied: a page belongs in one place, and is tied to whatever else it is about.
      " ", el("button", { title: "Connect this page to a person, a task, a project, an event or another page", onclick: (e) => connectMenu(e.currentTarget) }, "Connect to…"),
      " ", el("button", { class: "danger", onclick: deletePage }, "Delete"));
  }
  // Glance on the page open: what it is connected to, and possible connections.
  if (open && window.Peek && bridge && bridge.glanceAt) actions.push(" ", Peek.glanceButton(`page:${wpid()}/${open}`, (k) => bridge.glanceAt(k), ""));
  $("actions").replaceChildren(...actions);
  // A day with no note yet reads as empty; the file appears when you write.
  if (open) text = await core("GET", `/projects/${wpid()}/page?path=${encodeURIComponent(open)}`).catch(() => "");
  if (bridge) bridge.seen(JSON.stringify({ page: open ? { path: open } : null }));
  drawEditor();
  drawCalendar();
  drawPageTags();
}

/*
 * A page or a canvas changed from outside — by Morgan, through Talaris's MCP
 * (desktop_api.py) — while this drawer shows it: read again. A page's words
 * typed in the last moment and not yet saved give way to the change; a
 * canvas's are refused by the core as stale (`rev`) and the canvas reads
 * itself back.
 */
window.talarisChanged = (c) => {
  if (!c) return;
  if (c.kind === "canvas" && c.project === state.project.id && state.drawer === "canvas" && c.where === viewing) loadCanvas();
  // A page is the set shown's: this project's, the undated notes', or Home's daily.
  if (c.kind === "page" && c.project === wpid() && state.drawer === "writing" && c.where === open) {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    if (editor) { editor.destroy(); editor = null; }
    loadWriting();
  }
};

async function edit(path) {
  if (saveTimer) { clearTimeout(saveTimer); await save(); }
  if (editor) { editor.destroy(); editor = null; }
  open = path;
  loadWriting();
}

/*
 * A page's paper: its own color, kept by the core beside the page (never in
 * its Markdown), or the theme's. The words take a dark or a light ink as the
 * paper is light or dark.
 */
const PAPERS = ["#fdfaf3", "#fdf3d8", "#e7f1e4", "#e3edf5", "#f5e3e7", "#ece5f6", "#2b2a28", "#1f2a33"];
let paperOf = null; // the page whose paper is on show
function wearPaper(color) {
  const s = document.body.style;
  if (!color) { s.removeProperty("--page-paper"); s.removeProperty("--page-ink"); return; }
  const n = parseInt(color.slice(1), 16);
  const light = 0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255) > 140;
  s.setProperty("--page-paper", color);
  s.setProperty("--page-ink", light ? "#26241f" : "#e8e6e1");
}
async function paperFor(path) {
  if (!path || state.drawer !== "writing") return;
  paperOf = path;
  try {
    const look = await core("GET", `/projects/${wpid()}/page/look?path=${encodeURIComponent(path)}`);
    if (paperOf === path) wearPaper(look.paper);
  } catch { wearPaper(null); }
}
async function setPaper(color) {
  if (!open) return;
  wearPaper(color);
  try { await core("PUT", `/projects/${wpid()}/page/look?path=${encodeURIComponent(open)}`, { paper: color }); }
  catch (e) { status(String(e.message || e), true); }
}

async function save() {
  saveTimer = null;
  if (!open) return;
  try {
    await core("PUT", `/projects/${wpid()}/page?path=${encodeURIComponent(open)}`, text);
    status("Saved");
    if (isDaily(open)) drawCalendar();
  } catch (e) {
    status("Not saved", true);
    console.error(e);
  }
}

async function newPage(parent) {
  // Named for when it was made, until it is renamed.
  const made = await core("POST", `/projects/${wpid()}/pages`, { parent, title: "" });
  if (parent) {
    const shut = shutSet(WRITING_SHUT);
    shut.delete(parent);
    try { localStorage.setItem(WRITING_SHUT, JSON.stringify([...shut])); } catch { /* fine */ }
  }
  edit(made.path);
}

// A new name for a page, where it is; the one being written follows it, and what is beneath it.
function renamePage(n) {
  askName(`Rename “${n.title}”`, n.title, async (title) => {
    if (saveTimer) { clearTimeout(saveTimer); await save(); }
    const parent = n.path.includes("/") ? n.path.slice(0, n.path.lastIndexOf("/")) : null;
    const moved = await core("POST", `/projects/${wpid()}/page/move`, { path: n.path, parent, title });
    if (open && (open === n.path || open.startsWith(`${n.path}/`))) {
      if (editor) { editor.destroy(); editor = null; }
      open = moved.path + open.slice(n.path.length);
    }
    loadWriting();
  });
}

/** The open page, and all beneath it, moved or copied across: to the undated notes, or into this project. */
async function transfer(copy) {
  if (!open) return;
  if (saveTimer) { clearTimeout(saveTimer); await save(); }
  const from = wpid(), to = scope === "undated" ? state.project.id : homeId;
  try {
    const landed = await core("POST", `/projects/${from}/page/transfer`, { path: open, to, parent: scope === "undated" ? null : PAGES, copy });
    status(`${copy ? "Copied" : "Moved"} to ${scope === "undated" ? (inHome() ? "Home" : state.project.name) : "Pages"}`);
    // Moved, it is followed there; copied, this one stays open.
    if (!copy) {
      if (editor) { editor.destroy(); editor = null; }
      if (scope === "undated") { openIn.undated = null; scope = "project"; } else { openIn.project.set(state.project.id, null); scope = "undated"; }
      try { localStorage.setItem(SCOPE_KEY, scope); } catch { /* fine */ }
      open = landed.path;
    }
    loadWriting();
  } catch (e) { status(String(e.message || e), true); }
}

function deletePage() {
  if (!open) return;
  const title = open.split("/").pop();
  const path = open;
  const pid = wpid();
  const gone = async (all) => {
    if (saveTimer) { clearTimeout(saveTimer); await save(); }
    await core("DELETE", `/projects/${pid}/page?path=${encodeURIComponent(path)}${all ? "&all=1" : ""}`);
    if (editor) { editor.destroy(); editor = null; }
    open = null;
    text = "";
    loadWriting();
  };
  confirmDelete(`Delete “${title}”?`, "A copy is kept in its versions.", async () => {
    const { pages } = await core("GET", `/projects/${pid}/page/below?path=${encodeURIComponent(path)}`);
    if (!pages.length) { await gone(false); return; }
    // Pages beneath it: asked again, saying what else goes.
    const n = pages.length;
    return () => confirmDelete(`Delete everything beneath “${title}” too?`,
      `${n === 1 ? "1 page is" : `${n} pages are`} beneath it, and ${n === 1 ? "it goes" : "they all go"} with it. A copy of each is kept in its versions.`,
      () => gone(true), `Delete all ${n + 1}`);
  });
}

// ---------------------------------------------------------------- confirming

/*
 * A confirmation inside the drawer, in the theme — never the browser's own
 * dialog. Deleting something with more beneath it is asked twice, the second
 * time saying how much goes with it. The core has the last word: what it
 * refuses is said here in its words, and nothing is deleted.
 */
function confirmDelete(title, detail, act, label = "Delete") {
  const said = el("p", { class: "said" });
  const close = () => sheet.remove();
  const yes = el("button", { class: "danger" }, label);
  const sheet = el("div", { class: "confirm", role: "dialog" },
    el("div", { class: "box" },
      el("div", { class: "title" }, title),
      el("p", {}, detail),
      said,
      el("div", { class: "buttons" }, el("button", { onclick: close }, "Cancel"), " ", yes)));
  yes.addEventListener("click", async () => {
    try {
      // An act may answer with a second question (there is more beneath it): asked once this one is gone.
      const next = await act();
      close();
      if (typeof next === "function") next();
    } catch (e) {
      said.textContent = e.message;
      yes.remove();
    }
  });
  sheet.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.stopPropagation(); close(); } });
  $("panel").append(sheet);
  sheet.querySelector("button").focus();
}

// A name asked for in the same sheet: Enter keeps it, Escape leaves it.
function askName(title, value, act) {
  const said = el("p", { class: "said" });
  const close = () => sheet.remove();
  const input = el("input", { class: "name", type: "text", value, spellcheck: "false" });
  const yes = el("button", { class: "primary" }, "Rename");
  const sheet = el("div", { class: "confirm", role: "dialog" },
    el("div", { class: "box" },
      el("div", { class: "title" }, title),
      input, said,
      el("div", { class: "buttons" }, el("button", { onclick: close }, "Cancel"), " ", yes)));
  const go = async () => {
    const name = input.value.trim();
    if (!name || name === value) { close(); return; }
    try { await act(name); close(); } catch (e) { said.textContent = e.message; }
  };
  yes.addEventListener("click", go);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });
  sheet.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.stopPropagation(); close(); } });
  $("panel").append(sheet);
  input.focus();
  input.select();
}

// ---------------------------------------------------------------- the rest

async function load() {
  if (!state.project.id) { status("Core not answering", true); return; }
  try {
    if (state.drawer === "canvas") await loadCanvas();
    else if (state.drawer === "writing") await loadWriting();
  } catch (e) {
    status("Core not answering", true);
    console.error(e);
  }
}

// The ways back that live in the page: Escape, and telling the process about
// input so its idle timeout counts from the last of it.
let lastTouch = 0;
function touched() {
  const now = Date.now();
  if (now - lastTouch < 2000 || !bridge) return;
  lastTouch = now;
  bridge.activity();
}
for (const type of ["pointerdown", "keydown", "wheel", "pointermove"]) addEventListener(type, touched, { passive: true, capture: true });
addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || state.mode !== "pulled") return;
  // A confirmation takes Escape to cancel; only an Escape nothing else wanted
  // puts the drawer away.
  if (e.target.closest && e.target.closest(".confirm")) return;
  e.preventDefault();
  if (saveTimer) save();
  bridge.file();
});
// The Super key of a compositor bind arrives as a stray keydown; it means nothing here.
addEventListener("keydown", (e) => { if (e.key === "Meta") e.stopImmediatePropagation(); }, { capture: true });
$("handle").addEventListener("click", () => bridge && bridge.toggle());
$("tuck").addEventListener("click", () => { if (saveTimer) save(); bridge && bridge.file(); });
$("grow").addEventListener("click", () => { if (saveTimer) save(); if (bridge) (WINDOW ? bridge.closeWindow() : bridge.grow()); });
// A press on the dim, off the panel, puts it away (and from Qt, which hears every press).
// Its menus and dialogs, drawn outside the panel's box, are the panel's too.
const offPanel = (target) => !WINDOW && state.mode === "expanded" && target && !target.closest("#panel, .kit-pop, .confirm, .menu");
document.addEventListener("pointerdown", (e) => { if (bridge && offPanel(e.target)) { if (saveTimer) save(); bridge.file(); } });
window.pressedAt = (x, y) => { if (bridge && offPanel(document.elementFromPoint(x, y))) { if (saveTimer) save(); bridge.file(); } };
/*
 * Right-click in the writing editor: the drawer's own small menu, never the
 * engine's. Everywhere else in the drawer a right-click does nothing; the
 * canvas, in its own frame, has its own menu.
 */
// The colors words may take: Google's and Outlook's own, and the accents (as calendars).
const TEXT_COLORS = ["#d50000", "#e67c73", "#f4511e", "#f6bf26", "#33b679", "#0b8043", "#039be5", "#3f51b5", "#7986cb", "#8e24aa", "#616161",
  "#c98a5b", "#8aa878", "#7f9fbf", "#c7a55a", "#b97f8e"];
// One pop-up at a time, the kit's (kit.js): placed, kept on screen, put away by a press elsewhere, a scroll or Escape.
const closeMenu = () => Kit.popAway();

/*
 * Connect to…: the page open tied to something else — found as an @ finds it
 * (the core's /mentionables), this project's things first — in the field a
 * page declares for it (a person, a project), else as a link. The page's own
 * entity, and a page or canvas chosen, are made as they are needed.
 */
const KIND_WORD = { contact: "Person", task: "Task", event: "Event", note: "Page", page: "Page", canvas: "Canvas", project: "Project" };
function connectMenu(anchor) {
  closeMenu();
  const q = el("input", { type: "text", class: "cn-q", placeholder: "Find a person, task, page, project…", spellcheck: "false" });
  const list = el("div", {});
  Kit.pop(anchor, el("div", { class: "cn-menu" }, q, list));
  q.focus();
  let asked = 0;
  const find = async () => {
    const mine = ++asked;
    const rows = await core("GET", `/mentionables?q=${encodeURIComponent(q.value.trim())}&project=${encodeURIComponent(wpid())}&limit=14`).catch(() => []);
    if (mine !== asked || !Kit.isOpen()) return;
    const shown = (rows || []).filter((x) => !(x.kind === "page" && x.project === wpid() && x.where === open));
    list.replaceChildren(...(shown.length ? shown.map((x) => el("button", { class: "menu-item", title: x.projectName ? `${x.title} — ${x.projectName}` : x.title,
      onclick: () => { closeMenu(); connectPage(x); } }, el("span", { class: "tg" }, x.title), el("span", { class: "n" }, KIND_WORD[x.kind] || "Thing")))
      : [el("div", { class: "menu-item off" }, "Nothing by that name")]));
  };
  let timer = null;
  q.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(find, Kit.SEARCH_MS); });
  q.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); const first = list.querySelector("button"); if (first) first.click(); }
  });
  find();
}
async function connectPage(x) {
  try {
    const me = await core("POST", "/entities/place", { kind: "page", project: wpid(), where: open, title: open.split("/").pop() });
    let to = x.id;
    if (!to && (x.kind === "page" || x.kind === "canvas")) to = (await core("POST", "/entities/place", { kind: x.kind, project: x.project, where: x.where, title: x.title })).id;
    if (!to) throw new Error("that cannot be connected to");
    await core("POST", `/entities/${encodeURIComponent(me.id)}/connect`, { to, type: "about" });
    status(`Connected to ${x.title}`);
  } catch (e) { status(String(e.message || e), true); }
}
addEventListener("contextmenu", (e) => {
  e.preventDefault();
  closeMenu();
  if (!e.target.closest || !e.target.closest(".editor .cm-editor")) return;
  const picked = (document.getSelection()?.toString() ?? "").length > 0;
  const item = (label, command, on = true) =>
    el("button", { class: "menu-item" + (on ? "" : " off"), onclick: () => {
      closeMenu();
      if (!on) return;
      editor && editor.focus();
      document.execCommand(command);
    } }, label);
  // Colors for the selected words (or the colored words the cursor is in);
  // the crossed swatch makes them plain again.
  const colors = el("div", { class: "cv-menu-row text-colors" },
    ...TEXT_COLORS.map((c) => el("button", { class: "cv-swatch", style: `background:${c}`, title: c,
      onclick: () => { closeMenu(); editor && editor.setColor(c); } })),
    el("button", { class: "cv-swatch plain", title: "No color", onclick: () => { closeMenu(); editor && editor.setColor(null); } }));
  // The page's paper; the crossed swatch is the theme's own.
  const papers = el("div", { class: "cv-menu-row text-colors" },
    ...PAPERS.map((c) => el("button", { class: "cv-swatch", style: `background:${c}`, title: c, onclick: () => { closeMenu(); setPaper(c); } })),
    el("button", { class: "cv-swatch plain", title: "The theme's paper", onclick: () => { closeMenu(); setPaper(null); } }));
  Kit.pop({ x: e.clientX, y: e.clientY }, el("div", { class: "menu-list" },
    item("Cut", "cut", picked), item("Copy", "copy", picked), item("Paste", "paste"),
    el("div", { class: "menu-sep" }), item("Select all", "selectAll"),
    el("div", { class: "menu-sep" }), el("div", { class: "hint" }, "Text color"), colors,
    el("div", { class: "hint" }, "Paper"), papers));
});

// A link opens in the browser, not in the drawer.
addEventListener("click", (e) => {
  const a = e.target.closest && e.target.closest("a[href]");
  if (!a || !/^https?:/.test(a.href)) return;
  e.preventDefault();
  bridge && bridge.openUrl(a.href);
}, true);
// The drawer you are in shows it — two pulled out at once must not look alike.
addEventListener("focus", () => { document.body.dataset.focus = "1"; });
addEventListener("blur", () => { delete document.body.dataset.focus; });
if (document.hasFocus()) document.body.dataset.focus = "1";

new QWebChannel(qt.webChannelTransport, (channel) => {
  // Connected: the process may count on this page to hear presses and keys (sensor.py, Presses).
  window.talarisAlive = true;
  bridge = channel.objects.bridge;
  bridge.replied.connect(onReply);
  bridge.state.connect((json) => update(JSON.parse(json)));
  bridge.leave.connect(leave);
  // The launcher found a canvas or a page: open on it. If the drawer is on its
  // way out, arriving will load it; if it is already out, load it now.
  // Files chosen for the page and kept: linked where the cursor is.
  bridge.projectFiles.connect((json) => {
    const r = JSON.parse(json);
    if (r.error) status(r.error, true);
    if (editor && r.files && r.files.length && r.project === wpid()) {
      editor.insert(r.files.map((f) => `[${f.name.replace(/[\[\]]/g, "")}](talaris-file:${encodeURI(f.path).replace(/\(/g, "%28").replace(/\)/g, "%29")})`).join(" ") + " ");
    }
  });
  bridge.show.connect((json) => {
    const target = JSON.parse(json);
    if (state.drawer === "canvas" && target.canvas) {
      viewing = target.canvas;
      if (state.mode !== "filed") loadCanvas();
    } else if (state.drawer === "writing" && target.page) {
      // Told which set it is in (an undated note: `undated`), the drawer turns to that tab first.
      const into = target.scope || (scope === "undated" ? "project" : scope === "daily" && !target.page.startsWith(`${DAILY}/`) ? "project" : scope);
      if (into !== scope) {
        if (scope === "project") openIn.project.set(state.project.id, open);
        if (scope === "undated") openIn.undated = open;
        scope = into;
        try { localStorage.setItem(SCOPE_KEY, scope); } catch { /* fine */ }
        if (editor) { editor.destroy(); editor = null; }
      }
      if (state.mode !== "filed") edit(target.page);
      else open = target.page;
    }
  });
  bridge.current((json) => update(JSON.parse(json)));
});
