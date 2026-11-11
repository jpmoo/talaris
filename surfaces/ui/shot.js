// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore
//
// The screenshot panel (screenshot.py, shot.html): what to take, and then the
// shot — panned and zoomed, marked up, kept, copied, or let go of.
//
// Marks are kept as shapes in the shot's own pixels and drawn again over it
// whenever they change, so undo is a list and a mark is as sharp at any zoom.
// What is kept or copied is the shot with its marks, drawn once at full size.

(() => {
  const $ = (id) => document.getElementById(id);
  const el = Kit.el;
  let bridge = null;
  let surface = { up: false };

  const svg = (d) => `<svg viewBox="0 0 24 24">${d}</svg>`;
  const ICON = {
    region: svg('<path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3"/>'),
    scroll: svg('<rect x="6" y="3" width="12" height="18" rx="2"/><path d="M12 8v8M9.5 13.5 12 16l2.5-2.5M9.5 10.5 12 8l2.5 2.5"/>'),
    window: svg('<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 9h18M6.5 7h.01M9 7h.01"/>'),
    full: svg('<rect x="2" y="4" width="20" height="13" rx="2"/><path d="M8 21h8M12 17v4"/>'),
    move: svg('<path d="M18 11V6a2 2 0 0 0-4 0v5M14 10V4a2 2 0 0 0-4 0v6M10 10.5V6a2 2 0 0 0-4 0v8"/><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"/>'),
    pen: svg('<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>'),
    marker: svg('<path d="m9 11-6 6v3h9l3-3"/><path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4"/>'),
    arrow: svg('<path d="M5 19 19 5M10 5h9v9"/>'),
    rect: svg('<rect x="4" y="6" width="16" height="12" rx="1.5"/>'),
    ellipse: svg('<ellipse cx="12" cy="12" rx="9" ry="6.5"/>'),
    text: svg('<path d="M5 6V4h14v2M12 4v16M9 20h6"/>'),
    redact: svg('<rect x="3" y="7" width="18" height="10" rx="1.5"/><path d="M7 7v10M11 7v10M15 7v10M3 12h18"/>'),
    undo: svg('<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>'),
    redo: svg('<path d="m15 14 5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/>'),
    fit: svg('<path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/>'),
    one: svg('<path d="M3 12h4M17 12h4M12 3v4M12 17v4"/><circle cx="12" cy="12" r="3"/>'),
    copy: svg('<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/>'),
    save: svg('<path d="M12 3v12M7 10l5 5 5-5"/><path d="M5 21h14"/>'),
    close: svg('<path d="M6 6l12 12M18 6 6 18"/>'),
  };

  // ---------------------------------------------------------------- choosing

  const KINDS = [["region", "Region", "R"], ["scroll", "Scrolling", "S"], ["window", "Window", "W"], ["full", "Full screen", "F"]];
  function drawKinds() {
    $("kinds").replaceChildren(...KINDS.map(([kind, label, key]) => {
      const b = el("button", { class: "kind", onclick: () => choose(kind) });
      b.innerHTML = ICON[kind];
      b.append(el("span", {}, label), el("span", { class: "k" }, key));
      return b;
    }));
  }
  function choose(kind) { if (bridge && mode === "choose") bridge.choose(kind); }

  // ---------------------------------------------------------------- the shot and its marks

  let mode = "choose";
  let img = null;            // the shot, loaded
  let W = 0, H = 0;          // its size, in its pixels
  let marks = [], undone = [];
  let draft = null;          // the mark being made
  let kept = false;          // saved or copied since the last change
  let tool = "arrow";
  const COLORS = ["#e5484d", "#f76b15", "#ffc53d", "#30a46c", "#0090ff", "#8e4ec6", "#ffffff", "#111111"];
  let color = COLORS[0];
  let size = 1;              // a step: small, medium, large
  const SIZES = [["S", 0.6], ["M", 1], ["L", 1.8]];

  const board = () => $("board");
  let ink = null, inkCtx = null, base = null;
  // Each shot's own scale for a line's width: the same marks look the same on a small region and a whole screen.
  const unit = () => Math.max(2, Math.round(Math.max(W, H) / 400));

  function loadShot() {
    if (!bridge) return;
    bridge.image((text) => {
      const s = JSON.parse(text || "{}");
      if (!s.url) { board().replaceChildren(el("div", { class: "kit-empty" }, "No screenshot")); return; }
      const i = new Image();
      i.onload = () => {
        img = i; W = s.width; H = s.height;
        marks = []; undone = []; draft = null; kept = false;
        base = document.createElement("canvas");
        base.width = W; base.height = H;
        base.getContext("2d").drawImage(img, 0, 0);
        ink = document.createElement("canvas");
        ink.width = W; ink.height = H;
        inkCtx = ink.getContext("2d");
        board().style.width = `${W}px`;
        board().style.height = `${H}px`;
        board().replaceChildren(img, ink);
        fit();
        drawTools();
        say("");
      };
      i.src = s.url;
    });
  }

  // ---- drawing marks

  function arrowHead(ctx, a, b, w) {
    const ang = Math.atan2(b.y - a.y, b.x - a.x), len = Math.max(10, w * 4.2);
    ctx.beginPath();
    ctx.moveTo(b.x, b.y);
    ctx.lineTo(b.x - len * Math.cos(ang - 0.42), b.y - len * Math.sin(ang - 0.42));
    ctx.lineTo(b.x - len * Math.cos(ang + 0.42), b.y - len * Math.sin(ang + 0.42));
    ctx.closePath();
    ctx.fill();
  }
  function box(m) {
    return { x: Math.min(m.a.x, m.b.x), y: Math.min(m.a.y, m.b.y), w: Math.abs(m.b.x - m.a.x), h: Math.abs(m.b.y - m.a.y) };
  }
  function paintMark(ctx, m) {
    const w = m.width;
    ctx.save();
    ctx.lineCap = "round"; ctx.lineJoin = "round";
    ctx.strokeStyle = ctx.fillStyle = m.color;
    ctx.lineWidth = w;
    if (m.tool === "pen" || m.tool === "marker") {
      if (m.tool === "marker") { ctx.globalAlpha = 0.38; ctx.globalCompositeOperation = "multiply"; ctx.lineWidth = w * 5; ctx.lineCap = "square"; }
      ctx.beginPath();
      m.points.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      if (m.points.length === 1) ctx.lineTo(m.points[0].x + 0.1, m.points[0].y);
      ctx.stroke();
    } else if (m.tool === "arrow") {
      const ang = Math.atan2(m.b.y - m.a.y, m.b.x - m.a.x), back = Math.max(10, w * 4.2) * 0.8;
      ctx.beginPath();
      ctx.moveTo(m.a.x, m.a.y);
      ctx.lineTo(m.b.x - back * Math.cos(ang), m.b.y - back * Math.sin(ang));
      ctx.stroke();
      arrowHead(ctx, m.a, m.b, w);
    } else if (m.tool === "rect") {
      const r = box(m);
      ctx.strokeRect(r.x, r.y, r.w, r.h);
    } else if (m.tool === "ellipse") {
      const r = box(m);
      ctx.beginPath();
      ctx.ellipse(r.x + r.w / 2, r.y + r.h / 2, Math.max(1, r.w / 2), Math.max(1, r.h / 2), 0, 0, Math.PI * 2);
      ctx.stroke();
    } else if (m.tool === "redact") {
      // Hidden for good: the shot's own pixels under it, made into large blocks.
      const r = box(m);
      if (r.w >= 2 && r.h >= 2) {
        const cell = Math.max(8, Math.round(unit() * 5));
        const small = document.createElement("canvas");
        small.width = Math.max(1, Math.ceil(r.w / cell)); small.height = Math.max(1, Math.ceil(r.h / cell));
        small.getContext("2d").drawImage(base, r.x, r.y, r.w, r.h, 0, 0, small.width, small.height);
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(small, 0, 0, small.width, small.height, r.x, r.y, r.w, r.h);
      }
    } else if (m.tool === "text") {
      ctx.font = `600 ${m.font}px system-ui, sans-serif`;
      ctx.textBaseline = "top";
      // Legible on anything: a thin edge in the opposite tone.
      const dark = isDark(m.color);
      ctx.lineWidth = Math.max(2, m.font / 7);
      ctx.strokeStyle = dark ? "rgba(255,255,255,.85)" : "rgba(0,0,0,.65)";
      m.text.split("\n").forEach((line, i) => {
        ctx.strokeText(line, m.a.x, m.a.y + i * m.font * 1.2);
        ctx.fillText(line, m.a.x, m.a.y + i * m.font * 1.2);
      });
    }
    ctx.restore();
  }
  function isDark(hex) {
    const n = parseInt(hex.slice(1), 16);
    return ((n >> 16) * 299 + ((n >> 8) & 255) * 587 + (n & 255) * 114) / 1000 < 140;
  }
  function paint() {
    if (!inkCtx) return;
    inkCtx.clearRect(0, 0, W, H);
    for (const m of marks) paintMark(inkCtx, m);
    if (draft) paintMark(inkCtx, draft);
  }
  function rendered() {
    const out = document.createElement("canvas");
    out.width = W; out.height = H;
    const ctx = out.getContext("2d");
    ctx.drawImage(img, 0, 0);
    for (const m of marks) paintMark(ctx, m);
    return out.toDataURL("image/png");
  }

  // ---------------------------------------------------------------- panning and zooming

  let z = 1, tx = 0, ty = 0;
  const MIN_Z = 0.05, MAX_Z = 16;
  function place() {
    board().style.transform = `translate(${tx}px, ${ty}px) scale(${z})`;
    $("stage").classList.toggle("pixels", z >= 2);
    const zl = $("zoom");
    if (zl) zl.textContent = `${Math.round(z * 100)}%`;
  }
  function fit() {
    const st = $("stage").getBoundingClientRect();
    if (!W || !st.width) return;
    z = Math.min(1, (st.width - 32) / W, (st.height - 32) / H);
    tx = (st.width - W * z) / 2;
    ty = Math.max(16, (st.height - H * z) / 2);
    place();
  }
  function actual() {
    const st = $("stage").getBoundingClientRect();
    zoomAt(1 / z, st.width / 2, st.height / 2);
  }
  function zoomAt(by, cx, cy) {
    const next = Math.min(MAX_Z, Math.max(MIN_Z, z * by));
    const k = next / z;
    tx = cx - (cx - tx) * k;
    ty = cy - (cy - ty) * k;
    z = next;
    place();
  }
  /** A point on the screen, in the shot's own pixels. */
  function at(e) {
    const st = $("stage").getBoundingClientRect();
    return { x: (e.clientX - st.left - tx) / z, y: (e.clientY - st.top - ty) / z };
  }

  $("stage").addEventListener("wheel", (e) => {
    if (mode !== "view") return;
    e.preventDefault();
    const st = $("stage").getBoundingClientRect();
    // A pinch on the touchpad comes as a wheel with Ctrl held; so does Ctrl and the mouse's wheel.
    if (e.ctrlKey) zoomAt(Math.exp(-e.deltaY * (e.deltaMode ? 0.05 : 0.0025) * (Math.abs(e.deltaY) < 50 ? 4 : 1)), e.clientX - st.left, e.clientY - st.top);
    else {
      const k = e.deltaMode === 1 ? 32 : 1;
      tx -= (e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX) * k;
      ty -= (e.shiftKey && !e.deltaX ? 0 : e.deltaY) * k;
      place();
    }
  }, { passive: false });

  let pan = null, spaceHeld = false;
  $("stage").addEventListener("pointerdown", (e) => {
    if (mode !== "view" || !img) return;
    if (typingBox) { commitText(); return; }
    const panning = tool === "move" || e.button === 1 || spaceHeld;
    if (panning) {
      pan = { x: e.clientX, y: e.clientY, tx, ty };
      $("stage").classList.add("dragging");
      $("stage").setPointerCapture(e.pointerId);
      e.preventDefault();
      return;
    }
    if (e.button !== 0) return;
    const p = at(e);
    if (tool === "text") { startText(p, e); e.preventDefault(); return; }
    const width = unit() * SIZES[size][1] * (tool === "marker" ? 1.4 : 1);
    draft = tool === "pen" || tool === "marker" ? { tool, color, width, points: [p] } : { tool, color, width, a: p, b: p };
    $("stage").setPointerCapture(e.pointerId);
    paint();
  });
  $("stage").addEventListener("pointermove", (e) => {
    if (pan) { tx = pan.tx + e.clientX - pan.x; ty = pan.ty + e.clientY - pan.y; place(); return; }
    if (!draft) return;
    const p = at(e);
    if (draft.points) draft.points.push(p);
    else {
      // Shift: an arrow held to the nearest 45°, a box made square.
      if (e.shiftKey && (draft.tool === "rect" || draft.tool === "ellipse" || draft.tool === "redact")) {
        const d = Math.max(Math.abs(p.x - draft.a.x), Math.abs(p.y - draft.a.y));
        p.x = draft.a.x + Math.sign(p.x - draft.a.x || 1) * d; p.y = draft.a.y + Math.sign(p.y - draft.a.y || 1) * d;
      } else if (e.shiftKey && draft.tool === "arrow") {
        const ang = Math.round(Math.atan2(p.y - draft.a.y, p.x - draft.a.x) / (Math.PI / 4)) * (Math.PI / 4), len = Math.hypot(p.x - draft.a.x, p.y - draft.a.y);
        p.x = draft.a.x + len * Math.cos(ang); p.y = draft.a.y + len * Math.sin(ang);
      }
      draft.b = p;
    }
    paint();
  });
  const endDrag = () => {
    if (pan) { pan = null; $("stage").classList.remove("dragging"); return; }
    if (!draft) return;
    const m = draft;
    draft = null;
    const tiny = m.points ? false : Math.hypot(m.b.x - m.a.x, m.b.y - m.a.y) < 3;
    if (!tiny) add(m); else paint();
  };
  $("stage").addEventListener("pointerup", endDrag);
  $("stage").addEventListener("pointercancel", endDrag);

  function add(m) { marks.push(m); undone = []; kept = false; paint(); drawTools(); }
  function undo() { if (marks.length) { undone.push(marks.pop()); kept = false; paint(); drawTools(); } }
  function redo() { if (undone.length) { marks.push(undone.pop()); kept = false; paint(); drawTools(); } }

  // ---- text

  let typingBox = null, typingAt = null;
  function startText(p) {
    const font = Math.round(unit() * 7 * SIZES[size][1]);
    typingAt = { p, font, color };
    const t = el("div", { id: "typing", contenteditable: "plaintext-only", spellcheck: "false" });
    t.style.color = color;
    t.style.fontSize = `${font * z}px`;
    const st = $("stage").getBoundingClientRect();
    t.style.left = `${p.x * z + tx}px`;
    t.style.top = `${p.y * z + ty}px`;
    t.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Escape") { e.preventDefault(); cancelText(); }
      else if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); commitText(); }
    });
    $("stage").append(t);
    typingBox = t;
    void st;
    setTimeout(() => t.focus(), 0);
  }
  function commitText() {
    if (!typingBox) return;
    const text = typingBox.innerText.replace(/\n+$/, "");
    const { p, font, color: c } = typingAt;
    typingBox.remove();
    typingBox = null;
    if (text.trim()) add({ tool: "text", color: c, width: 0, a: p, font, text });
  }
  function cancelText() { if (typingBox) { typingBox.remove(); typingBox = null; } }

  // ---------------------------------------------------------------- the toolbar

  const TOOLS = [["move", "Move (V, or hold Space)"], ["pen", "Pen (P)"], ["marker", "Highlighter (H)"], ["arrow", "Arrow (A)"], ["rect", "Box (B)"], ["ellipse", "Oval (O)"], ["text", "Text (T)"], ["redact", "Hide (X)"]];
  function iconBtn(name, title, act, opts = {}) {
    const b = el("button", { class: "tool" + (opts.on ? " on" : ""), title, onclick: act, ...(opts.disabled ? { disabled: "" } : {}) });
    b.innerHTML = ICON[name];
    return b;
  }
  function drawTools() {
    if (mode !== "view") return;
    const stage = $("stage");
    stage.classList.toggle("move", tool === "move");
    stage.classList.toggle("draw", tool !== "move" && tool !== "text");
    stage.classList.toggle("text", tool === "text");
    $("tools").replaceChildren(
      ...TOOLS.map(([t, title]) => iconBtn(t, title, () => { commitText(); tool = t; drawTools(); }, { on: tool === t })),
      el("span", { class: "sep" }),
      ...COLORS.map((c) => el("button", { class: "color" + (c === color ? " on" : ""), style: `background:${c}`, title: c, onclick: () => { color = c; drawTools(); } })),
      el("span", { class: "sep" }),
      el("span", { class: "seg widths" }, ...SIZES.map(([label], i) => el("button", { class: i === size ? "on" : "", title: "Line and text size", onclick: () => { size = i; drawTools(); } }, label))),
      el("span", { class: "sep" }),
      iconBtn("undo", "Undo (Ctrl+Z)", undo, { disabled: !marks.length }),
      iconBtn("redo", "Redo (Ctrl+Shift+Z)", redo, { disabled: !undone.length }),
      el("span", { class: "sep" }),
      iconBtn("fit", "Fit (0)", fit),
      iconBtn("one", "Actual size (1)", actual),
      el("span", { id: "zoom" }, `${Math.round(z * 100)}%`),
      msgEl,
      el("span", { class: "spacer" }),
      el("span", { class: "dim-note", style: "font-size:11px;color:var(--muted)" }, W ? `${W} × ${H}` : ""),
      el("button", { class: "t-btn", title: "Copy it (Ctrl+C)", onclick: copy }, "Copy"),
      el("button", { class: "t-btn primary", title: "Keep it in Screenshots (Ctrl+S)", onclick: save }, "Save"),
      closeButton());
  }
  function closeButton() {
    const b = el("button", { class: "t-btn", title: "Close without saving (Esc)" }, "Close");
    b.addEventListener("click", () => close(b));
    closeBtn = b;
    return b;
  }
  let closeBtn = null;

  // One line for what happened (Saved as …, Copied), kept across the toolbar's redraws.
  const msgEl = el("span", { id: "msg" });
  function say(text, error = false, html = null) {
    const m = msgEl;
    m.className = error ? "err" : "";
    m.replaceChildren(...(html ? [html] : [text]));
  }

  // ---------------------------------------------------------------- keeping it, or not

  function save() {
    if (!img || !bridge) return;
    commitText();
    say("Saving…");
    bridge.save(rendered(), (text) => {
      const r = JSON.parse(text);
      if (r.error) { say(r.error, true); return; }
      kept = true;
      const a = el("a", { title: "Show it in its folder", onclick: () => bridge.showFolder() }, r.name);
      say("", false, el("span", {}, "Saved as ", a));
    });
  }
  function copy() {
    if (!img || !bridge) return;
    commitText();
    bridge.copy(rendered(), (text) => {
      const r = JSON.parse(text);
      if (r.error) { say(r.error, true); return; }
      kept = true;
      say("Copied");
    });
  }
  /** Closed without saving: asked once first if it has been neither saved nor copied since it last changed. */
  function close(button) {
    if (!kept && img && !Kit.ask(button || closeBtn, { ask: "Discard it?" })) return;
    if (bridge) bridge.discard();
  }

  // ---------------------------------------------------------------- keys

  addEventListener("keydown", (e) => { if (e.key === " ") spaceHeld = true; });
  addEventListener("keyup", (e) => { if (e.key === " ") spaceHeld = false; });
  document.addEventListener("keydown", (e) => {
    if (e.defaultPrevented) return;
    if (mode === "choose") {
      if (e.key === "Escape") { e.preventDefault(); if (bridge) bridge.file(); return; }
      const k = KINDS.find(([, , key]) => key.toLowerCase() === e.key.toLowerCase());
      if (k && !e.ctrlKey && !e.altKey && !e.metaKey) { e.preventDefault(); choose(k[0]); }
      return;
    }
    if (typingBox) return;
    const ctrl = e.ctrlKey || e.metaKey;
    if (e.key === "Escape") { e.preventDefault(); if (Kit.isOpen()) Kit.popAway(); else close(closeBtn); return; }
    if (ctrl && e.key.toLowerCase() === "z") { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
    if (ctrl && e.key.toLowerCase() === "y") { e.preventDefault(); redo(); return; }
    if (ctrl && e.key.toLowerCase() === "s") { e.preventDefault(); save(); return; }
    if (ctrl && e.key.toLowerCase() === "c") { e.preventDefault(); copy(); return; }
    if (ctrl && (e.key === "=" || e.key === "+")) { e.preventDefault(); const st = $("stage").getBoundingClientRect(); zoomAt(1.25, st.width / 2, st.height / 2); return; }
    if (ctrl && e.key === "-") { e.preventDefault(); const st = $("stage").getBoundingClientRect(); zoomAt(0.8, st.width / 2, st.height / 2); return; }
    if (ctrl || e.altKey) return;
    if (e.key === "0") { fit(); return; }
    if (e.key === "1") { actual(); return; }
    const keyed = { v: "move", p: "pen", h: "marker", a: "arrow", b: "box", r: "rect", o: "ellipse", t: "text", x: "redact" }[e.key.toLowerCase()];
    const t = keyed === "box" ? "rect" : keyed;
    if (t) { tool = t; drawTools(); }
  });
  addEventListener("resize", () => { if (mode === "view" && img) place(); });

  // ---------------------------------------------------------------- coming and going

  function setMode(m) {
    mode = m === "view" ? "view" : "choose";
    document.body.className = mode;
    if (mode === "choose") { drawKinds(); img = null; board().replaceChildren(); cancelText(); }
  }
  function how() {
    const m = surface.motion || {};
    return { kind: m.motion, speed: m.speed, edge: "top", flush: false, viewport: surface.viewport,
      shown: () => {
        if (bridge) bridge.drawn();
        if (mode === "choose") { const first = document.querySelector(".kind"); if (first) first.focus(); }
        else if (img) fit();
      } };
  }
  function onState(s) {
    const was = surface;
    surface = s;
    if (s.up && !was.up) {
      setMode(s.mode);
      if (mode === "view") loadShot();
      Motion.arrive(document.body, how());
    } else if (s.up && s.mode !== mode && s.mode !== "busy") {
      setMode(s.mode);
      if (mode === "view") loadShot();
    }
  }
  // A press on the dim: only the choice goes by it — a shot is let go of on purpose, never by a stray press.
  document.addEventListener("pointerdown", (e) => { if (e.target === document.documentElement && bridge && surface.up && mode === "choose") bridge.file(); });
  window.pressedAt = (x, y) => { if (bridge && surface.up && mode === "choose" && document.elementFromPoint(x, y) === document.documentElement) bridge.file(); };

  Surface.connect({ onState }).then((b) => {
    bridge = b;
    b.leave.connect(() => {
      surface = { ...surface, up: false };
      cancelText();
      const going = Motion.leave(document.body, how());
      if (going) going.onfinish = () => bridge.left(); else bridge.left();
    });
    if (surface.up && mode === "view") loadShot();
  });
  drawKinds();
})();
