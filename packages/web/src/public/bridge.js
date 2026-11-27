// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore

/*
 * The browser's bridge (docs/WEB.md, *How the pages talk to it*): what a page reaches on the desktop through Qt's
 * channel (`QWebChannel`, `bridge.core(...)`, `bridge.state.connect(...)`), here over HTTPS to the web side, so the
 * desktop's pages run unchanged. Loaded first, in place of the desktop's `qwebchannel.js`.
 *
 * - `bridge.core(id, method, path, body)`: asked of `/api/core` (checked there against this page's routes), the answer
 *   coming back on `bridge.coreReply` as the desktop's does.
 * - Any other call, `bridge.name(args…, callback?)`: asked of `/api/call`; a verb the web has nothing for answers
 *   nothing, and the page carries on.
 * - Any signal, `bridge.name.connect(fn)`: heard here; a change from another machine arrives as `synced`.
 * - What only the desktop has (the on-screen keyboard, the machine's readings, Glance's window) is not there at all,
 *   so a page asking `if (bridge.keyboard)` leaves it out.
 */
(() => {
  const WEB = window.TALARIS_WEB || { page: "", prefix: "/talaris" };
  const ABSENT = new Set(["keyboard", "machine", "reading", "glanceAt", "libraryAt", "then", "toJSON"]);
  const heard = new Map(); // signal → [fn]
  const emit = (name, ...args) => { for (const fn of heard.get(name) || []) { try { fn(...args); } catch (e) { console.error(e); } } };

  async function post(path, body) {
    const r = await fetch(`${WEB.prefix}${path}`, {
      method: "POST", credentials: "same-origin",
      headers: { "content-type": "application/json", "x-talaris": "1" },
      body: JSON.stringify({ page: WEB.page, ...body }),
    });
    if (r.status === 401) { location.href = `${WEB.prefix}/login?then=${encodeURIComponent(location.pathname)}`; throw new Error("signed out"); }
    return r.json();
  }

  function call(name, args) {
    const cb = typeof args[args.length - 1] === "function" ? args.pop() : null;
    if (name === "core") {
      const [id, method, path, body] = args;
      post("/api/core", { method, path, body })
        .then((r) => emit("coreReply", JSON.stringify({ id, status: r.status, data: r.data })))
        .catch((e) => emit("coreReply", JSON.stringify({ id, status: 503, data: { error: e.message } })));
      return;
    }
    // A link (the desktop opens it in the browser, so its pages hand every link to the bridge — the Notes drawer does,
    // for every <a> — the modules' bar's too, and on the web nothing then happened): here, one of Talaris's own pages
    // is gone to, anything else opened in a tab of its own.
    if (name === "openUrl") {
      const [href] = args;
      try {
        const u = new URL(href, location.href);
        if (u.origin === location.origin && u.pathname.startsWith(`${WEB.prefix}/`)) location.assign(u.href);
        else window.open(u.href, "_blank", "noopener");
      } catch { /* not an address */ }
      return;
    }
    if (name === "request") {
      // The drawers' way (core.py, `request`): answered on `replied` with the status and the text as it came.
      const [id, method, path, body] = args;
      post("/api/core", { method, path, body })
        .then((r) => emit("replied", id, r.status, r.text ?? ""))
        .catch((e) => emit("replied", id, 503, JSON.stringify({ error: e.message })));
      return;
    }
    post("/api/call", { name, args })
      .then((r) => {
        for (const [signal, ...said] of r.emit || []) emit(signal, ...said);
        if (r.web && cb && !r.emit) cb(r.result);
      })
      .catch(() => {});
  }

  const bridge = new Proxy({}, {
    get(_t, name) {
      if (typeof name !== "string" || ABSENT.has(name)) return undefined;
      const fn = (...args) => call(name, args);
      fn.connect = (listener) => { if (!heard.has(name)) heard.set(name, []); heard.get(name).push(listener); };
      fn.disconnect = (listener) => heard.set(name, (heard.get(name) || []).filter((f) => f !== listener));
      return fn;
    },
  });

  // Changes from elsewhere, as the desktop's `synced`: the page reads again what it shows.
  try {
    const events = new EventSource(`${WEB.prefix}/api/events`, { withCredentials: true });
    events.addEventListener("synced", (e) => emit("synced", e.data));
  } catch { /* no live changes; a reload shows them */ }

  // A phone, the first time: what the desktop's pages start on suits a wide screen. Calendar opens on three days, and
  // a page's left column (Tasks' lists, Calendar's calendars) starts put away. Only where nothing was chosen yet.
  try {
    if (matchMedia("(max-width: 760px)").matches) {
      const first = (key, value) => { if (localStorage.getItem(key) === null) localStorage.setItem(key, value); };
      if (WEB.page === "calendar") { first("talaris.calendar.mode", "agenda"); first("talaris.calendar.side", "0"); }
      if (WEB.page === "tasks") first("talaris.tasks.side", "false");
    }
  } catch { /* no storage: the page's own defaults */ }

  window.qt = { webChannelTransport: {} };
  window.QWebChannel = function QWebChannel(_transport, ready) { setTimeout(() => ready({ objects: { bridge } }), 0); };
  window.talarisWeb = WEB;
  document.documentElement.classList.add("web", `page-${WEB.page || "none"}`);
})();
