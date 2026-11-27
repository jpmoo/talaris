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
  const ABSENT = new Set(["keyboard", "machine", "reading", "glanceAt", "then", "toJSON"]);
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
    // A task, or a thing's card, asked for from another module (Calendar's agenda, a collection's row, a mention): the
    // desktop opens it in its own panel; here, that module's page is gone to, opened on it — Back comes back.
    if (name === "openTask" || name === "libraryAt") {
      const [id] = args;
      if (!id) return;
      const to = name === "openTask" ? `tasks?task=${encodeURIComponent(id)}` : `library?card=${encodeURIComponent(id)}`;
      location.assign(`${WEB.prefix}/${to}`);
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

  /*
   * What the web cannot carry out (UX-AUDIT 4.7): the desktop's verbs that reach the machine itself — going to a
   * project (its workspace), the file manager, a folder chosen on its disk, a file opened in an application, a window
   * made or closed. Asked as `bridge.can(verb)` (the desktop's bridge has no `can`, so a page reads a missing one as
   * yes) and leaves out what it would offer; and anything a page marks `data-verb="…"` with one of these is hidden here
   * without asking.
   */
  const DESKTOP_ONLY = new Set(["goProject", "reveal", "showFolder", "openPath", "chooseFolder", "grow", "closeWindow", "openArchive", "refreshFolder"]);
  const can = (verb) => !DESKTOP_ONLY.has(String(verb));
  {
    const style = document.createElement("style");
    style.textContent = `${[...DESKTOP_ONLY].map((v) => `[data-verb="${v}"]`).join(", ")} { display: none !important; }`;
    document.head.append(style);
  }

  const bridge = new Proxy({ can }, {
    // What a page puts on its bridge is its own, as on a QWebChannel object (Morgan's page wraps `call` around
    // `callLater`, morgan/index.html): kept, and given back, rather than taken for a call to the host.
    set(t, name, value) { t[name] = value; return true; },
    get(t, name) {
      if (Object.prototype.hasOwnProperty.call(t, name)) return t[name];
      if (typeof name !== "string" || ABSENT.has(name)) return undefined;
      const fn = (...args) => call(name, args);
      fn.connect = (listener) => { if (!heard.has(name)) heard.set(name, []); heard.get(name).push(listener); };
      fn.disconnect = (listener) => heard.set(name, (heard.get(name) || []).filter((f) => f !== listener));
      return fn;
    },
  });

  // Changes from elsewhere, as the desktop's `synced`: the page reads again what it shows.
  try {
    const events = new EventSource(`${WEB.prefix}/api/events?page=${encodeURIComponent(WEB.page)}`, { withCredentials: true });
    events.addEventListener("synced", (e) => emit("synced", e.data));
    // Morgan's page: each of Morgan's events (`event`), and its state when that changes (`state`), as morgan.py's Link.
    // What the browser itself is doing for Morgan's voice (public/voice.js: listening, transcribing, speaking) is shown
    // over the brain's state while it lasts (`WEB.morgan.doing`), as a device's own listening and speaking are.
    let morganNow = "", brainNow = "", doing = "";
    const hearers = [];
    const showState = (ev) => {
      const now = doing || brainNow;
      if (now && now !== morganNow) { morganNow = now; emit("state", now); }
      emit("event", JSON.stringify({ ...ev, type: "state", state: now || "idle" }));
    };
    events.addEventListener("morgan", (e) => {
      let ev = null;
      try { ev = JSON.parse(e.data); } catch { /* not JSON: passed on as it came */ }
      for (const fn of hearers) { try { fn(ev ?? {}); } catch (error) { console.error(error); } }
      if (ev?.type === "state" && ev.state) { brainNow = ev.state; showState(ev); return; }
      emit("event", e.data);
    });
    WEB.morgan = {
      /** Each of Morgan's events, as it comes, before the page has it. */
      hear: (fn) => hearers.push(fn),
      /** What the browser is doing for Morgan's voice, shown as Morgan's state; "" gives the brain's back. */
      doing: (state) => { if (state === doing) return; doing = state || ""; showState({}); },
      /** One of Morgan's events, made here (a level, an error), as if Morgan had said it. */
      event: (ev) => emit("event", JSON.stringify(ev)),
      /** Morgan's state as an answer said it (`status`): a turn stopped while thinking may send no state of its own. */
      known: (state) => { if (!state || state === brainNow) return; brainNow = state; showState({}); },
      get state() { return brainNow; },
    };
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
