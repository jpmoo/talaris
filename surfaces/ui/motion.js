// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore
/*
 * How a panel comes and goes: the drawers, the launcher, Morgan.
 *
 * The theme's motions, as design/theme-tuner.html first showed them: slide in
 * from the edge; draw (marks first, then lines between them in random order,
 * direction and timing — always mark to mark, never loose — then filled); and
 * none — and for things that are not drawers (the launcher, Morgan, Settings,
 * which follow the windows' setting) pop, swelling from a little smaller, and
 * fade. Draw is stored as "chaos", its first name; "draw" (the windows' name
 * for it) gets it too. Leaving is arriving backwards.
 *
 * Each call takes what to move and how:
 *   kind     "slide", "chaos", "pop", "fade" or "none"
 *   speed    "slow", "normal", "fast" or "fastest"
 *   edge     the edge it comes from: "left", "right", "top" or "bottom"
 *   flush    whether it sits against that edge (that side has no line to draw)
 *   rules    (rule, rel, box) => …: the lines inside it, `rule(a, b)` for each,
 *            from screen points made local by `rel(x, y)`
 *   backdrop an element whose background (a dim) fades in and out with it
 *   viewport the page's size once its surface is placed, [w, h] in page pixels:
 *            arriving waits for it
 */
"use strict";

const Motion = (() => {
  const SPEEDS = { slow: 1.6, normal: 1, fast: .6, fastest: .3 };
  const kindOf = (o) => (o.kind === "draw" ? "chaos" : o.kind || "slide");
  const still = (o) => matchMedia("(prefers-reduced-motion: reduce)").matches || kindOf(o) === "none";
  let P = (ms) => ms;
  const use = (o) => { const k = SPEEDS[o.speed] || 1; P = (ms) => Math.round(ms * k); };

  function make(tag, cls, style = "") {
    const e = document.createElement(tag);
    e.className = cls;
    if (style) e.setAttribute("style", style);
    return e;
  }

  /** Off-screen, past its edge: how far to move it, whatever its place on the screen. */
  function off(panel, edge) {
    const r = panel.getBoundingClientRect();
    return {
      left: `${-(r.right + 8)}px 0`, right: `${innerWidth - r.left + 8}px 0`,
      top: `0 ${-(r.bottom + 8)}px`, bottom: `0 ${innerHeight - r.top + 8}px`,
    }[edge];
  }

  // ------------------------------------------------------------ the lines

  /*
   * Drawn once, as for a panel on the left edge — depth across, breadth down,
   * the flush side at x = 0 — on a layer that one transform turns to the edge
   * the panel really comes from.
   */
  function layer(panel, edge) {
    const r = panel.getBoundingClientRect();
    const Wp = r.width, Hp = r.height;
    const across = edge === "left" || edge === "right";
    const W = across ? Wp : Hp, H = across ? Hp : Wp;
    const turn = { left: "none", right: `matrix(-1,0,0,1,${Wp},0)`, top: "matrix(0,1,1,0,0,0)", bottom: `matrix(0,-1,1,0,0,${Hp})` }[edge];
    // Each panel its own layer, so two at once (two windows opening) keep theirs.
    if (panel._fx) panel._fx.remove();
    const fx = make("div", "fx", `left:${r.left + scrollX}px;top:${r.top + scrollY}px;width:${W}px;height:${H}px;transform:${turn}`);
    document.documentElement.append(fx);
    panel._fx = fx;
    return { fx, W, H };
  }
  function segment(fx, p, q, far) {
    const flat = p[1] === q[1];
    const s = make("div", "fx-seg");
    Object.assign(s.style, flat
      ? { left: `${Math.min(p[0], q[0])}px`, top: `${p[1] - 1}px`, width: `${Math.abs(q[0] - p[0])}px`, height: "2px", transformOrigin: far ? "right" : "left" }
      : { left: `${p[0] - 1}px`, top: `${Math.min(p[1], q[1])}px`, width: "2px", height: `${Math.abs(q[1] - p[1])}px`, transformOrigin: far ? "bottom" : "top" });
    fx.append(s);
    return [s, flat ? "scaleX" : "scaleY"];
  }
  function grow([s, axis], delay, duration) {
    s.animate([
      { transform: `${axis}(0)`, opacity: 1 },
      { transform: `${axis}(1)`, opacity: 1, offset: .45 },
      { transform: `${axis}(1)`, opacity: 1, offset: .8 },
      { transform: `${axis}(1)`, opacity: 0 },
    ], { duration: P(duration), delay: P(delay), easing: "ease-out", fill: "both" }).onfinish = () => s.remove();
  }
  // The panel stays empty — no fill, no frame, no contents — until the lines have done.
  function fillAfter(panel, at) {
    panel.animate([{ background: "transparent", borderColor: "transparent", boxShadow: "none" },
      { background: "transparent", borderColor: "transparent", boxShadow: "none", offset: at }, {}], { duration: P(1100), easing: "ease-out" });
    for (const child of panel.children) {
      if (!child.classList.contains("xh")) child.animate([{ opacity: 0 }, { opacity: 0, offset: at }, { opacity: 1 }], { duration: P(1100), easing: "ease-out" });
    }
  }
  /** Screen points, relative to the panel, as the left-edge frame the lines are drawn in. */
  function toLocal(edge, Wp, Hp) {
    return {
      left: ([x, y]) => [x, y], right: ([x, y]) => [Wp - x, y],
      top: ([x, y]) => [y, x], bottom: ([x, y]) => [Hp - y, x],
    }[edge];
  }

  /*
   * The lines of this panel, as the left-edge frame sees them: the frame (but
   * not a flush side, which has no border), split every so often so a tall
   * panel has as many marks as the tuner's small one, and the rules inside it.
   */
  function lines(panel, o, W, H) {
    const box = panel.getBoundingClientRect();
    const local = toLocal(o.edge, box.width, box.height);
    const rel = (x, y) => local([x - box.left, y - box.top]);
    const split = (p, q) => {
      const length = Math.hypot(q[0] - p[0], q[1] - p[1]);
      const n = Math.max(1, Math.round(length / 180));
      const pts = [];
      for (let i = 0; i <= n; i++) pts.push([Math.round(p[0] + (q[0] - p[0]) * i / n), Math.round(p[1] + (q[1] - p[1]) * i / n)]);
      return pts;
    };
    const paths = [split([0, 0], [W, 0]), split([0, H], [W, H]), split([W, 0], [W, H])];
    if (!o.flush) paths.push(split([0, 0], [0, H]));
    if (o.rules) o.rules((a, b) => { if (a && b) paths.push(split(a, b)); }, rel, box);
    // Only lines that run along one axis, as everything here is square.
    return paths.filter((pts) => pts.length > 1 && (pts[0][0] === pts.at(-1)[0] || pts[0][1] === pts.at(-1)[1]));
  }
  function marksAndPieces(paths) {
    const marks = new Map();
    const pieces = [];
    for (const pts of paths) {
      pts.forEach((p) => marks.set(p.join(","), p));
      for (let i = 1; i < pts.length; i++) pieces.push([pts[i - 1], pts[i]]);
    }
    return { marks: [...marks.values()], pieces };
  }

  function trace(panel, o) {
    const { fx, W, H } = layer(panel, o.edge);
    const { marks, pieces } = marksAndPieces(lines(panel, o, W, H));
    // Every mark first, then a line between each pair of neighbors, in
    // random order, direction and timing — always mark to mark, never loose.
    fillAfter(panel, .72);
    const shown = marks.map(([x, y]) => {
      const m = make("span", "fx-mark", `left:${x}px;top:${y}px`);
      fx.append(m);
      m.animate([{ transform: "scale(0)", opacity: 0 }, { transform: "scale(1.5)", opacity: 1, offset: .6 }, { transform: "scale(1)", opacity: 1 }],
        { duration: P(240), delay: P(Math.random() * 260), fill: "both" });
      return m;
    });
    pieces.sort(() => Math.random() - .5).forEach(([p, q]) => grow(segment(fx, p, q, Math.random() < .5), 220 + Math.random() * 520, 380 + Math.random() * 300));
    // The marks go once the lines are down, and leave nothing behind.
    setTimeout(() => {
      shown.forEach((m) => m.animate([{ opacity: 1 }, { opacity: 0 }], { duration: P(260), fill: "forwards" }));
      setTimeout(() => fx.remove(), P(320));
    }, P(1150));
  }

  /** Draw, leaving: the reverse of arriving. Returns the animation that says when it is done. */
  function untrace(panel, o) {
    const { fx, W, H } = layer(panel, o.edge);
    const { marks, pieces } = marksAndPieces(lines(panel, o, W, H));
    const length = P(820);
    // Emptied first: contents, fill and frame, leaving only the lines.
    for (const child of panel.children) {
      if (!child.classList.contains("xh")) child.animate([{ opacity: 1 }, { opacity: 0, offset: .25 }, { opacity: 0 }], { duration: length, fill: "forwards" });
    }
    const done = panel.animate([{}, { background: "transparent", borderColor: "transparent", boxShadow: "none", offset: .25 },
      { background: "transparent", borderColor: "transparent", boxShadow: "none" }], { duration: length, fill: "forwards" });
    const shrink = ([s, axis], delay, duration) => s.animate([
      { transform: `${axis}(1)`, opacity: 0 }, { transform: `${axis}(1)`, opacity: 1, offset: .2 }, { transform: `${axis}(0)`, opacity: 1 },
    ], { duration: P(duration), delay: P(delay), easing: "ease-in", fill: "both" });
    pieces.forEach(([p, q]) => shrink(segment(fx, p, q, Math.random() < .5), Math.random() * 260, 300 + Math.random() * 220));
    for (const [x, y] of marks) {
      const m = make("span", "fx-mark", `left:${x}px;top:${y}px`);
      fx.append(m);
      m.animate([{ opacity: 0 }, { opacity: 1, offset: .3 }, { opacity: 1, offset: .75 }, { opacity: 0, transform: "scale(0)" }],
        { duration: length, fill: "both" });
    }
    done.addEventListener("finish", () => fx.remove());
    return done;
  }

  // ------------------------------------------------------------ in and out

  /** Whatever a last leaving left held (it fills forwards) let go, before anything arrives. */
  function reset(panel, o = {}) {
    for (const a of panel.getAnimations({ subtree: true })) a.cancel();
    if (o.backdrop) for (const a of o.backdrop.getAnimations()) a.cancel();
    if (panel._fx) panel._fx.remove();
  }

  /*
   * The page's own size, settled. A panel is told it is out as its surface is
   * made, before the compositor has given the surface its size; measured then,
   * the panel is somewhere it will not be, and the arrival plays there. So
   * arriving waits for two frames running at the same size (a third of a
   * second at most), the panel held unseen meanwhile.
   */
  function settled(expect) {
    return new Promise((done) => {
      const began = performance.now();
      let last = "", same = 0;
      const look = () => {
        const now = `${innerWidth}x${innerHeight}`;
        same = innerWidth > 0 && now === last ? same + 1 : 0;
        last = now;
        // The size it was told it will be (`viewport`, page pixels), when told:
        // a page can sit still at its old size for frames before the new one comes.
        const there = expect ? Math.abs(innerWidth - expect[0]) <= 2 && Math.abs(innerHeight - expect[1]) <= 2 && same >= 1 : same >= 2;
        if (there || performance.now() - began > (expect ? 600 : 330)) done();
        else requestAnimationFrame(look);
      };
      requestAnimationFrame(look);
    });
  }
  let arrival = 0;

  function arrive(panel, o) {
    reset(panel, o);
    if (still(o)) return;
    const mine = ++arrival;
    panel.style.visibility = "hidden";
    settled(o.viewport).then(() => {
      panel.style.visibility = "";
      // Gone again, or arriving afresh, before it settled: this arrival is not wanted.
      if (mine === arrival) play(panel, o);
    });
  }

  function play(panel, o) {
    use(o);
    if (o.backdrop) {
      const dim = getComputedStyle(o.backdrop).backgroundColor;
      o.backdrop.animate([{ backgroundColor: "rgba(0, 0, 0, 0)" }, { backgroundColor: dim }], { duration: P(300), easing: "ease-out" });
    }
    if (kindOf(o) === "chaos") { trace(panel, o); return; }
    const from = { pop: { scale: ".87", opacity: 0 }, fade: { opacity: 0 } }[kindOf(o)] || { translate: off(panel, o.edge) };
    const to = { pop: { scale: "1", opacity: 1 }, fade: { opacity: 1 } }[kindOf(o)] || { translate: "0 0" };
    panel.animate([from, to], { duration: P(450), easing: "cubic-bezier(.2,.8,.2,1)" });
  }

  /**
   * Back into the edge it came from, a little quicker and accelerating, the
   * way something is pushed away rather than drawn out — or its lines drawn
   * back to their marks. Held where it ends until `reset`. Answers the
   * animation to wait for, or null when there is nothing to wait for.
   */
  function leave(panel, o) {
    arrival++;
    panel.style.visibility = "";
    if (still(o)) return null;
    use(o);
    if (o.backdrop) o.backdrop.animate([{}, { backgroundColor: "rgba(0, 0, 0, 0)" }], { duration: P(kindOf(o) === "chaos" ? 820 : 300), fill: "forwards" });
    if (kindOf(o) === "chaos") return untrace(panel, o);
    const from = { pop: { scale: "1", opacity: 1 }, fade: { opacity: 1 } }[kindOf(o)] || { translate: "0 0" };
    const to = { pop: { scale: ".87", opacity: 0 }, fade: { opacity: 0 } }[kindOf(o)] || { translate: off(panel, o.edge) };
    return panel.animate([from, to], { duration: P(300), easing: "cubic-bezier(.5,0,.9,.4)", fill: "forwards" });
  }

  return { arrive, leave, reset, still };
})();
