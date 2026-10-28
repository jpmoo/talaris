// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore
//
// Clipboard history, the popup's panel (bar.py, kind "clipboard"; Super+V or
// the bar's button). After Notchnik's: a grid of tiles, newest first and the
// pinned before them, each what was copied — the words, the picture, the file
// or "N files" — with when under it. A press puts it back on the clipboard
// ("Copied"); the one on the clipboard now is marked. Over a tile: pin, look
// (without copying), remove, asked first. Typing finds: words by what they
// say, files by their names; pictures step aside while a search is on.
//
// Keys: arrows move through the tiles, Enter copies and puts the list away,
// Space looks, Escape clears the search, closes the look, then the list.

"use strict";

const Clips = (() => {
  const el = (tag, cls, text) => Object.assign(document.createElement(tag), cls ? { className: cls } : {}, text != null ? { textContent: text } : {});
  const grid = () => document.getElementById("clip-grid");
  const q = () => document.getElementById("clip-q");
  /** Words shown on a tile, as Notchnik cuts them. */
  const PREVIEW_CHARS = 800;
  let all = [];
  let current = "";
  let shown = [];
  let at = 0; // the tile the keys are on
  let looking = null;
  const base = (p) => String(p).split("/").filter(Boolean).pop() || p;
  const isPicture = (p) => /\.(png|jpe?g|gif|webp|bmp|svg|avif)$/i.test(p);

  function read() {
    if (!bridge || !bridge.clipboard) return;
    bridge.clipboard((text) => {
      try { const got = JSON.parse(text); all = got.clips || []; current = got.current || ""; } catch { all = []; }
      draw();
    });
  }

  function open() {
    q().value = "";
    at = 0;
    look(null);
    grid().replaceChildren();
    read();
    q().focus();
  }

  function found() {
    const words = q().value.trim();
    if (!words) return all;
    return all.filter((c) => c.kind === "text" ? Kit.matches(words, c.text)
      : c.kind === "file" || c.kind === "files" ? Kit.matches(words, ...(c.paths || []).map(base)) : false);
  }

  function face(c) {
    const f = el("div", "face");
    if (c.kind === "text") {
      f.classList.add("words");
      f.textContent = c.text.length > PREVIEW_CHARS ? c.text.slice(0, PREVIEW_CHARS) + "…" : c.text;
    } else if (c.kind === "image") {
      f.classList.add("picture");
      f.append(Object.assign(document.createElement("img"), { src: `talaris-ui://clip/?id=${c.id}`, alt: "", loading: "lazy" }));
    } else {
      const paths = c.paths || [];
      f.classList.add("files");
      if (paths.length === 1 && isPicture(paths[0]) && !c.missing) {
        f.classList.add("picture");
        f.append(Object.assign(document.createElement("img"), { src: `talaris-ui://clip/?id=${c.id}&file=0`, alt: "", loading: "lazy" }));
      } else {
        f.insertAdjacentHTML("beforeend", Icons.file());
      }
      f.append(el("span", "fname", paths.length > 1 ? `${paths.length} files` : base(paths[0] || "")));
      if (paths.length > 1) f.append(el("span", "fmore", paths.slice(0, 3).map(base).join(", ") + (paths.length > 3 ? "…" : "")));
    }
    return f;
  }

  function tool(icon, title, cls, act) {
    const b = el("button", "tool " + cls);
    b.title = title;
    b.innerHTML = icon;
    b.addEventListener("click", (e) => { e.stopPropagation(); act(b); });
    return b;
  }

  function tile(c, i) {
    const t = el("div", "clip" + (c.id === current ? " current" : "") + (c.pinned ? " pinned" : "") + (i === at ? " at" : ""));
    t.dataset.id = c.id;
    t.append(face(c));
    const tools = el("div", "tools");
    tools.append(
      tool(Icons.pin(), c.pinned ? "Unpin" : "Pin", "pin" + (c.pinned ? " on" : ""), () => bridge.clipPin(c.id, !c.pinned)),
      el("span", "gap"),
      tool(Icons.eye(), "Look without copying", "eye", () => look(c)),
      tool(Icons.trash(), "Remove", "trash", (b) => { if (Kit.ask(b, { key: `rm:${c.id}`, ask: "Remove?" })) bridge.clipRemove(c.id); }),
    );
    t.append(tools);
    if (c.missing) {
      const w = el("span", "stale");
      w.innerHTML = Icons.warn();
      w.title = (c.paths || []).length > 1 ? "Some of these files are gone" : "The file is gone";
      t.append(w);
    }
    t.append(el("span", "copied", "Copied"));
    t.addEventListener("click", () => copy(c, t, false));
    const cell = el("div", "cell");
    cell.append(t, el("div", "when", Kit.ago(c.at)));
    return cell;
  }

  function draw() {
    if (document.body.dataset.popup !== "clipboard") return;
    shown = found();
    at = Math.min(at, Math.max(0, shown.length - 1));
    document.getElementById("clip-clear").hidden = !all.length;
    const words = q().value.trim();
    Kit.keepScroll(grid(), () => grid().replaceChildren(...(shown.length ? shown.map(tile)
      : [Kit.empty(words ? "Nothing copied says that" : "Nothing copied yet")])));
  }

  function copy(c, t, away) {
    if (!bridge.clipCopy) return;
    bridge.clipCopy(c.id, (ok) => {
      if (!ok) return;
      current = c.id;
      if (away) { bridge.file(); return; }
      for (const x of grid().querySelectorAll(".clip.current")) x.classList.remove("current");
      t.classList.add("current", "flash");
      setTimeout(() => t.classList.remove("flash"), 900);
    });
  }

  // Looked at, whole, without copying: Notchnik's preview.
  function look(c) {
    looking = c;
    const pane = document.getElementById("clip-look");
    pane.hidden = !c;
    if (!c) return;
    const body = document.getElementById("clip-look-body");
    body.replaceChildren();
    if (c.kind === "text") body.append(el("pre", "", c.text));
    else if (c.kind === "image") body.append(Object.assign(document.createElement("img"), { src: `talaris-ui://clip/?id=${c.id}`, alt: "" }));
    else {
      const paths = c.paths || [];
      if (paths.length === 1 && isPicture(paths[0]) && !c.missing) body.append(Object.assign(document.createElement("img"), { src: `talaris-ui://clip/?id=${c.id}&file=0`, alt: "" }));
      body.append(...paths.map((p) => el("div", "path", p)));
    }
    document.getElementById("clip-look-when").textContent = Kit.stamp(c.at);
  }

  function move(by) {
    if (!shown.length) return;
    at = Math.max(0, Math.min(shown.length - 1, at + by));
    const tiles = grid().querySelectorAll(".clip");
    tiles.forEach((x, i) => x.classList.toggle("at", i === at));
    if (tiles[at]) tiles[at].scrollIntoView({ block: "nearest" });
  }
  const columns = () => {
    const cells = grid().querySelectorAll(".cell");
    if (cells.length < 2) return 1;
    const top = cells[0].offsetTop;
    let n = 0;
    for (const c of cells) { if (c.offsetTop !== top) break; n++; }
    return Math.max(1, n);
  };

  function keys(e) {
    if (e.key === "Escape") {
      if (looking) { e.stopPropagation(); look(null); q().focus(); }
      return; // the search box clears itself (Kit.searchBox); else the popup goes
    }
    if (looking) { if (e.key === " " || e.key === "Enter") { e.preventDefault(); look(null); } return; }
    const n = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: columns(), ArrowUp: -columns() }[e.key];
    if (n) { e.preventDefault(); move(n); return; }
    if (e.key === "Enter" && shown[at]) { e.preventDefault(); copy(shown[at], null, true); return; }
    if (e.key === " " && !q().value && shown[at]) { e.preventDefault(); look(shown[at]); }
  }

  function wire() {
    Kit.searchBox(q(), () => { at = 0; draw(); });
    q().addEventListener("input", () => { at = 0; draw(); });
    document.getElementById("clipboard").addEventListener("keydown", keys);
    document.getElementById("clip-look").addEventListener("click", () => { look(null); q().focus(); });
    const clear = document.getElementById("clip-clear");
    Kit.twice(clear, { ask: "Clear all?", act: () => bridge.clipClear() });
  }

  return { open, read, wire };
})();
Clips.wire();
