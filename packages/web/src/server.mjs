// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore

/**
 * Talaris on the web (docs/WEB.md): the desktop's own pages, served under `/talaris` to a signed-in browser, with a
 * bridge of the browser's (`public/bridge.js`) in place of the desktop's Qt one. Beside this machine's core, which
 * answers on its socket; reached from outside only through Caddy, which passes `/talaris*` here.
 *
 * - `/talaris/` and `/talaris/library`: the Library, the hub (WEB.md, *What it shows*).
 * - `/talaris/ui/…`: the pages and what they load, from `surfaces/ui`, as the desktop has them; a page has the
 *   browser's bridge put in where the desktop's Qt channel was.
 * - `/talaris/api/core`: a page's request of the core, checked against that page's own routes — the same `ALLOWED`
 *   the desktop's panel checks (read from its Python, so there is one list).
 * - `/talaris/api/state`, `/talaris/api/call`, `/talaris/api/events`: the rest of a page's bridge.
 * - `/talaris/auth/…`, `/talaris/login`: passkeys (auth.mjs).
 *
 * Everything but the sign-in page and what it needs answers only to a signed-in session.
 */

import { createServer, request } from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import * as auth from "./auth.mjs";
import * as oauth from "./oauth.mjs";
import * as mcp from "./mcp.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..", "..");
const UI = join(ROOT, "surfaces", "ui");
const PUBLIC = join(HERE, "public");
const BROWSER_PASSKEYS = join(HERE, "..", "node_modules", "@simplewebauthn", "browser", "dist", "bundle", "index.umd.min.js");
const PREFIX = "/talaris";
const PORT = Number(process.env.TALARIS_WEB_PORT ?? 8091);
const HOST = process.env.TALARIS_WEB_HOST ?? "127.0.0.1";
const SOCKET = join(process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid()}`, "talaris.sock");

// ------------------------------------------------------------ the pages on the web

/**
 * Each page the web offers: its file, and the desktop panel whose routes it keeps to (its Python's `ALLOWED`).
 * Only these; a page not here is not served.
 *
 * `panes`: how the page is one pane at a time on a phone (public/modules.js, the phone's shell) — each a CSS selector,
 * said here so that nothing is guessed from the page's markup:
 * - `list` and `detail`: shown one at a time; a press on one of `rows` in the list shows the detail, once the page has
 *   drawn it (or a moment after, for what was chosen already), as a step in the browser's history — Back, or the
 *   phone's own back gesture, shows the list again. `opens`: presses outside the list that end in the detail too (a
 *   new one, made and shown), waited on for as long as the page takes.
 * - `side`: a column that comes in over the list from the left (the bar's button); a press on one of `sideRows` puts
 *   it away again.
 * - `sheets`: what the page itself opens over the list and closes (a task's card, an event's editor): seen as it
 *   opens, so Back closes it, by `close` — a button of the page's, or `"Escape"` as the page hears it.
 * - `where`: what the bar says under the title (the project chosen). `hide`: what the bar says already, or a phone has
 *   no room or no use for. `listOnly`: what belongs to the list (its search, its ways of showing), not shown with the
 *   detail or a sheet.
 */
const PAGES = {
  library: { file: "filespanel.html", panel: "files_panel.py", title: "Library",
    panes: { side: "#side", sideRows: ".s-item", list: "#middle", detail: "#detail",
      rows: ".row[data-key], .row.crow, .grow-row, .d-proj", where: "#side .s-item.on .nm",
      hide: "header h1, #count, #days, #readf, #msg", listOnly: "header" } },
  tasks: { file: "tasks.html", panel: "tasks_panel.py", title: "Tasks",
    panes: { side: "#side", sideRows: "#side .item:not(.grp)",
      sheets: [{ el: "#sheet", close: "Escape" }, { el: "#psheet", close: "#p-close" }], hide: "#side-toggle, #count", listOnly: "header" } },
  calendar: { file: "calendar.html", panel: "calendar_panel.py", routes: "TASK_ROUTES", title: "Calendar",
    panes: { side: "#side", sheets: [{ el: "#editor", close: "Escape" }], hide: "#side-toggle" } },
  notes: { file: "drawer.html", query: "drawer=writing", panel: "workspace.py", routes: "ROUTES", title: "Notes",
    panes: { list: "#body > .tree", detail: "#body > .pane", rows: ".row, .cal-day", opens: "#new-page", hide: ".side-toggle, #count, #grow, .page-map, .page-map-open" } },
  people: { file: "people.html", panel: "people_panel.py", title: "People",
    panes: { list: "#list", detail: "#person", rows: ".prow", opens: "#add", hide: "header h1, #count, header .seg", listOnly: "header, #twice" } },
  canvas: { file: "drawer.html", query: "drawer=canvas", panel: "workspace.py", routes: "ROUTES", title: "Canvas",
    panes: { list: "#body > .tree", detail: "#body > .canvas-pane", rows: ".row", hide: ".side-toggle, #count, #grow" } },
};
/** The page a request for a file is, by its file and its query (the two drawers are one file). */
const pageFor = (rel, search) => Object.entries(PAGES).find(([, p]) => p.file === rel && (!p.query || search.includes(p.query)))?.[0];

/** A panel's routes (`ALLOWED`, or the name given), read from its Python: the raw strings of `re.compile(r"…")`, as one pattern. */
function allowedOf(panel, name = "ALLOWED") {
  const src = readFileSync(join(ROOT, "surfaces", panel), "utf8");
  const m = src.match(new RegExp(`^\\s*${name}\\s*=\\s*re\\.compile\\(([\\s\\S]*?)\\)\\s*$`, "m"));
  if (!m) throw new Error(`${panel}: no ${name}`);
  const parts = [...m[1].matchAll(/r"((?:[^"\\]|\\.)*)"/g)].map((x) => x[1]);
  return new RegExp(parts.join(""));
}
for (const p of Object.values(PAGES)) p.allowed = allowedOf(p.panel, p.routes);

/** The desktop's defaults for the look (surfaces/config.py): read once, so the web looks as Talaris does. */
const LOOK = (() => {
  try {
    const out = execFileSync("python3", ["-c", "import sys,json;sys.path.insert(0,sys.argv[1]);from config import DEFAULTS as D;print(json.dumps({'theme':D['theme'],'clock':D.get('clock',{}),'panels':D.get('panels',{})}))", join(ROOT, "surfaces")], { encoding: "utf8" });
    return JSON.parse(out);
  } catch { return { theme: { mode: "dark", accent: "#c98a5b" }, clock: {} }; }
})();

// ------------------------------------------------------------ the core

function core(method, path, body) {
  return new Promise((ok) => {
    const data = body == null || body === "" ? undefined : Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
    const req = request({ socketPath: SOCKET, method, path, headers: data ? { "content-type": "application/json", "content-length": data.length } : {} }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => ok({ status: res.statusCode ?? 500, text: Buffer.concat(chunks).toString("utf8") }));
    });
    req.setTimeout(60_000, () => req.destroy(new Error("timeout")));
    req.on("error", () => ok({ status: 503, text: JSON.stringify({ error: "the core is not answering" }) }));
    if (data) req.write(data);
    req.end();
  });
}
/** As the desktop tells a page a reply was (core.py, `reply_data`): its JSON, nothing, or `{error}`. */
function replyData(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch { return { error: text }; }
}

// ------------------------------------------------------------ a page's state, as its desktop panel would say it

let home = null;
async function homeProject() {
  if (home) return home;
  const r = await core("GET", "/projects");
  const list = replyData(r.text);
  const projects = Array.isArray(list) ? list : list?.projects ?? [];
  home = projects.find((p) => p.home) ?? { id: "", name: "Home" };
  return home;
}
async function stateOf(page) {
  const project = await homeProject();
  const base = { up: true, windowed: true, web: true, theme: LOOK.theme, clock: LOOK.clock, motion: { motion: "none", speed: "normal" }, viewport: null,
    morganHere: false, project: project.id ?? "", start: {}, page };
  // A drawer (Notes, Canvas: workspace.py's describe) has the project whole, and is out, at the top, at its own size.
  const drawer = { notes: "writing", canvas: "canvas" }[page];
  if (drawer) return { ...base, drawer, edge: "top", mode: "expanded", project, look: LOOK.panels ?? {}, typeScale: 1, insets: { top: 0, bottom: 0, left: 0, right: 0 } };
  return base;
}

/**
 * The rest of a page's bridge: what the desktop's verbs become on the web. A verb with nothing to do here (open in an
 * application, show in the file manager, pin to the dock) is answered `{web: false}`, and the page carries on.
 */
const CALLS = {
  current: async (page) => JSON.stringify(await stateOf(page)),
  calendarList: async () => JSON.stringify(replyData((await core("GET", "/calendar/view?from=0&to=0")).text)?.calendars ?? []),
  // The Calendar (calendar_panel.py's bridge, its calendar process's answers): the accounts' calendars as a desktop
  // machine last shared them (the core's /calendar/view), read-only here; Talaris's own calendar the page asks the core
  // for itself, and changes as on the desktop.
  hello: async () => {
    const v = replyData((await core("GET", "/calendar/view?from=0&to=0")).text) ?? {};
    const shared = v.by ? `As ${v.by} last read them, ${v.at ? new Date(v.at).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" }) : ""}` : "";
    return JSON.stringify({ status: { ready: true, error: "", needs: "", shared }, calendars: (v.calendars ?? []).map((c) => ({ ...c, writable: false })) });
  },
  ask: async (_page, request) => {
    const msg = JSON.parse(request || "{}");
    if (msg.do === "range") {
      const v = replyData((await core("GET", `/calendar/view?from=${Number(msg.from) || 0}&to=${Number(msg.to) || 0}`)).text) ?? {};
      return { emit: [["events", JSON.stringify({ req: msg.req, items: v.items ?? [] })]] };
    }
    if (msg.do === "search") {
      const now = Date.now(), year = 365 * 86_400_000;
      const v = replyData((await core("GET", `/calendar/view?from=${now - year}&to=${now + year}`)).text) ?? {};
      const words = String(msg.q || "").toLowerCase().split(/\s+/).filter(Boolean);
      const seen = new Set();
      const items = (v.items ?? []).filter((e) => words.every((w) => `${e.title} ${e.location ?? ""} ${e.notes ?? ""}`.toLowerCase().includes(w)))
        .sort((a, b) => Math.abs(a.start - now) - Math.abs(b.start - now))
        .filter((e) => (seen.has(`${e.calendar}/${e.uid}`) ? false : seen.add(`${e.calendar}/${e.uid}`)));
      return { emit: [["events", JSON.stringify({ req: msg.req, items })]] };
    }
    if (msg.do === "people") return { emit: [["people", JSON.stringify({ req: msg.req, items: [] })]] };
    if (["create", "update", "delete", "respond", "color", "subscribe", "unsubscribe"].includes(msg.do)) {
      return { emit: [["done", JSON.stringify({ req: msg.req, error: "An account's calendar is changed on a desktop machine, not on the web yet" })]] };
    }
    return null;
  },
};

// ------------------------------------------------------------ serving

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".webp": "image/webp", ".jpg": "image/jpeg",
  ".json": "application/json", ".woff2": "font/woff2", ".ttf": "font/ttf", ".ico": "image/x-icon" };

/** What makes the pages one home-screen app on a phone: the manifest, the icon, its standalone look. */
const APP_HEAD = `<link rel="manifest" href="${PREFIX}/manifest.webmanifest"><link rel="apple-touch-icon" sizes="180x180" href="${PREFIX}/web/icon-180.png"><link rel="icon" type="image/png" sizes="192x192" href="${PREFIX}/web/icon-192.png">` +
  `<meta name="apple-mobile-web-app-capable" content="yes"><meta name="mobile-web-app-capable" content="yes">` +
  `<meta name="apple-mobile-web-app-status-bar-style" content="black"><meta name="apple-mobile-web-app-title" content="Talaris">` +
  `<meta name="theme-color" content="#1c1f22">`;

const SECURITY = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "same-origin",
  // Framed only by Talaris's own pages: the Canvas drawer holds the canvas in a frame (canvas/index.html).
  "x-frame-options": "SAMEORIGIN",
  "cache-control": "no-store",
};

function send(res, status, body, type = "application/json", extra = {}) {
  const data = typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, { ...SECURITY, "content-type": type, ...extra });
  res.end(data);
}

/** A file from a folder, never outside it. */
function fileFrom(base, rel) {
  const full = normalize(join(base, rel));
  if (!full.startsWith(base + "/") || !existsSync(full) || !statSync(full).isFile()) return null;
  return full;
}

/** A page as the browser gets it: the desktop's Qt channel replaced by the browser's bridge, told which page it is. */
function pageHtml(name) {
  const p = PAGES[name];
  let html = readFileSync(join(UI, p.file), "utf8");
  const modules = Object.entries(PAGES).map(([id, q]) => ({ id, title: q.title }));
  // Every page as the desktop's window of it (`?window`): there all along, not arriving from the top as a panel over a
  // dimmed screen, and nothing pressed beside it putting it away. A drawer is told which (its query) in the same way.
  const query = [p.query, "window=1"].filter(Boolean).join("&");
  const ours = `<base href="${PREFIX}/ui/"><script>window.TALARIS_WEB = ${JSON.stringify({ page: name, prefix: PREFIX, title: p.title, modules, ...(p.panes ? { panes: p.panes } : {}) })};` +
    // What the address already asks (`?task=…`, `?card=…`: opened on one thing) is kept beside it.
    `{ const q = new URLSearchParams(location.search); for (const [k, v] of new URLSearchParams("${query}")) q.set(k, v); ` +
    `history.replaceState(null, "", location.pathname + "?" + q); }</script>` +
    `<script src="${PREFIX}/web/bridge.js"></script><link rel="stylesheet" href="${PREFIX}/web/web.css">`;
  html = html.replace(/<script src="qrc:\/\/\/qtwebchannel\/qwebchannel\.js"><\/script>/, "");
  html = html.replace(/<head>/i, `<head>${ours.replace(/<link[^>]*>/, "")}`);
  html = html.replace(/<\/head>/i, `<link rel="stylesheet" href="${PREFIX}/web/web.css">${APP_HEAD}</head>`);
  // A phone's width, not a desktop's shrunk (without it the iPhone lays the page out 980 wide and scales it down).
  if (!/name="viewport"/.test(html)) html = html.replace(/<head>/i, `<head><meta name="viewport" content="width=device-width, initial-scale=1">`);
  html = html.replace(/<\/body>/i, `<script src="${PREFIX}/web/modules.js"></script></body>`);
  return html;
}

function cookies(req) {
  const out = {};
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
const addrOf = (req) => String(req.headers["cf-connecting-ip"] ?? req.headers["x-forwarded-for"] ?? req.socket.remoteAddress ?? "").split(",")[0].trim();

async function textOf(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) { size += c.length; if (size > 25 * 1024 * 1024) throw new Error("too large"); chunks.push(c); }
  return Buffer.concat(chunks).toString("utf8");
}
async function bodyOf(req) {
  const text = await textOf(req);
  return text ? JSON.parse(text) : {};
}
/** A form (OAuth's), or JSON — whichever was sent. */
async function formOf(req) {
  const text = await textOf(req);
  if (/json/.test(String(req.headers["content-type"] ?? ""))) { try { return JSON.parse(text || "{}"); } catch { return {}; } }
  return Object.fromEntries(new URLSearchParams(text));
}

const sessionCookie = (token, maxAge) =>
  `${auth.COOKIE}=${token}; Path=${PREFIX}; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;

// Pages kept up to date: a change from elsewhere told to every open page (as the surfaces' `synced` is).
const listeners = new Set();
let lastCame = null;
setInterval(async () => {
  if (!listeners.size) return;
  const r = await core("GET", "/sync");
  const came = replyData(r.text)?.came ?? null;
  if (came && came !== lastCame) {
    if (lastCame !== null) for (const res of listeners) res.write(`event: synced\ndata: ${JSON.stringify({ came })}\n\n`);
    lastCame = came;
  }
}, 5000).unref();

async function handle(req, res) {
  const url = new URL(req.url ?? "/", "http://talaris");
  let path = url.pathname;
  // OAuth's documents, which a client finds by putting the well-known segment before Talaris's own path (RFC 9728
  // §3.1, RFC 8414 §3.1): Caddy sends /.well-known/oauth-*/talaris… here (docs/WEB.md).
  if (path === `/.well-known/oauth-protected-resource${PREFIX}/mcp` || path === `/.well-known/oauth-protected-resource${PREFIX}`) return send(res, 200, oauth.protectedResource(PREFIX));
  if (path === `/.well-known/oauth-authorization-server${PREFIX}` || path === `/.well-known/openid-configuration${PREFIX}`) return send(res, 200, oauth.authServer(PREFIX));
  if (path === PREFIX) return send(res, 302, "", "text/plain", { location: `${PREFIX}/` });
  if (!path.startsWith(PREFIX + "/")) return send(res, 404, { error: "not here" });
  path = path.slice(PREFIX.length);
  const addr = addrOf(req);

  // The sign-in page and what it needs: open to anyone.
  if (path === "/login") return send(res, 200, readFileSync(join(PUBLIC, "login.html"), "utf8").replace(/<head>/i, `<head>${APP_HEAD}`), TYPES[".html"]);
  // A home-screen app (an iPhone's Add to Home Screen): its manifest and icons, open to anyone, as a browser asks for
  // them without the session — one app, opening within /talaris, not a link that leaves for Safari at each press.
  if (path === "/manifest.webmanifest") return send(res, 200, readFileSync(join(PUBLIC, "manifest.webmanifest")), "application/manifest+json", { "cache-control": "max-age=3600" });
  if (/^\/web\/icon-\d+\.png$/.test(path)) {
    const f = fileFrom(PUBLIC, path.slice(5));
    return f ? send(res, 200, readFileSync(f), "image/png", { "cache-control": "max-age=86400" }) : send(res, 404, { error: "not here" });
  }
  // The look the sign-in and consent pages share with the rest (tokens.css, and the typefaces it names): nothing in
  // them is anyone's, and without them a signed-out page fell back to the system's font and a palette of its own.
  if (path === "/ui/tokens.css" || /^\/ui\/fonts\/[\w-]+\.woff2$/.test(path)) {
    const f = fileFrom(UI, path.slice(4));
    return f ? send(res, 200, readFileSync(f), TYPES[extname(f)], { "cache-control": "max-age=3600" }) : send(res, 404, { error: "not here" });
  }
  if (path === "/web/passkeys.js")return send(res, 200, readFileSync(BROWSER_PASSKEYS), TYPES[".js"], { "cache-control": "max-age=86400" });
  if (path.startsWith("/web/login")) {
    const f = fileFrom(PUBLIC, path.slice(5));
    return f ? send(res, 200, readFileSync(f), TYPES[extname(f)] ?? "application/octet-stream") : send(res, 404, { error: "not here" });
  }

  // The MCP (mcp.mjs) and OAuth's own steps: a token or a code, not the browser's session — save approving, which is
  // the person's, signed in by passkey.
  if (path === "/mcp") {
    if (req.method !== "POST") return send(res, 405, { error: "POST JSON-RPC here (streamable HTTP), with Authorization: Bearer <key>" });
    let body;
    try { body = await bodyOf(req); } catch { return send(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "not JSON" } }); }
    const r = await mcp.handle(req, body, PREFIX, oauth.resourceMetadataUrl(PREFIX));
    return send(res, r.status, r.body, "application/json", r.headers ?? {});
  }
  if (path === "/oauth/register" && req.method === "POST") return send(res, 201, oauth.register(await formOf(req)));
  if (path === "/oauth/token" && req.method === "POST") { const r = oauth.token(await formOf(req)); return send(res, r.status, r.body); }

  const token = cookies(req)[auth.COOKIE];
  const me = auth.session(token);
  if (path === "/oauth/authorize" || path === "/oauth/approve") {
    if (!me) return send(res, 302, "", "text/plain", { location: `${PREFIX}/login?then=${encodeURIComponent(url.pathname + url.search)}` });
    if (path === "/oauth/authorize") { const r = oauth.consentPage(PREFIX, url.searchParams); return send(res, r.status, r.html, TYPES[".html"]); }
    if (req.method !== "POST") return send(res, 405, { error: "not like that" });
    const r = oauth.approve(await formOf(req));
    return r.status === 302 ? send(res, 302, "", "text/plain", { location: r.location }) : send(res, r.status, { error: r.error });
  }

  // Passkeys: asked for by the sign-in page with a JSON body; a header only a page of ours sets, against forms posted from elsewhere.
  if (path.startsWith("/auth/")) {
    if (req.method !== "POST" || req.headers["x-talaris"] !== "1") return send(res, 400, { error: "not like that" });
    const b = await bodyOf(req);
    const answer = (r) => (r.error ? send(res, r.status ?? 400, { error: r.error }) : null);
    if (path === "/auth/register/options") { const r = await auth.registerOptions({ code: b.code, signedIn: !!me, addr }); return answer(r) ?? send(res, 200, r); }
    if (path === "/auth/register") { const r = await auth.register(b); return answer(r) ?? send(res, 200, r); }
    if (path === "/auth/signin/options") { const r = await auth.signInOptions({ addr }); return answer(r) ?? send(res, 200, r); }
    if (path === "/auth/signin") {
      const r = await auth.signIn({ ...b, addr, device: req.headers["user-agent"] });
      return answer(r) ?? send(res, 200, { ok: true }, "application/json", { "set-cookie": sessionCookie(r.token, 30 * 86400) });
    }
    if (path === "/auth/signout") { auth.signOut(token); return send(res, 200, { ok: true }, "application/json", { "set-cookie": sessionCookie("", 0) }); }
    return send(res, 404, { error: "not here" });
  }

  // Everything else: signed in, or to the sign-in page.
  if (!me) {
    if (path.startsWith("/api/")) return send(res, 401, { error: "signed out" });
    return send(res, 302, "", "text/plain", { location: `${PREFIX}/login?then=${encodeURIComponent(url.pathname)}` });
  }

  if (path === "/" || path === "/library") return send(res, 200, pageHtml("library"), TYPES[".html"]);
  // Each module at its own address; one that is a drawer is its file with its query, which the page reads.
  const mod = PAGES[path.slice(1)];
  if (mod) return send(res, 200, pageHtml(path.slice(1)), TYPES[".html"]);
  if (path === "/web/bridge.js") return send(res, 200, readFileSync(join(PUBLIC, "bridge.js")), TYPES[".js"]);
  if (path.startsWith("/web/")) {
    const f = fileFrom(PUBLIC, path.slice(5));
    return f ? send(res, 200, readFileSync(f), TYPES[extname(f)] ?? "application/octet-stream") : send(res, 404, { error: "not here" });
  }
  if (path.startsWith("/ui/")) {
    const rel = decodeURIComponent(path.slice(4));
    const named = pageFor(rel, url.search);
    if (named) return send(res, 200, pageHtml(named), TYPES[".html"]);
    // The canvas itself, inside the Canvas drawer's frame: served as it is — it talks only to the drawer around it.
    if (rel === "canvas/index.html") return send(res, 200, readFileSync(join(UI, rel)), TYPES[".html"]);
    if (rel.endsWith(".html")) return send(res, 404, { error: "not a page on the web yet" });
    const f = fileFrom(UI, rel);
    return f ? send(res, 200, readFileSync(f), TYPES[extname(f)] ?? "application/octet-stream") : send(res, 404, { error: "not here" });
  }

  if (path.startsWith("/api/")) {
    if (path === "/api/events" && req.method === "GET") {
      res.writeHead(200, { ...SECURITY, "content-type": "text/event-stream", connection: "keep-alive" });
      res.write(": connected\n\n");
      listeners.add(res);
      const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
      req.on("close", () => { clearInterval(ping); listeners.delete(res); });
      return;
    }
    if (req.method !== "POST" || req.headers["x-talaris"] !== "1") return send(res, 400, { error: "not like that" });
    const b = await bodyOf(req);
    const page = PAGES[b.page];
    if (!page) return send(res, 400, { error: "not a page on the web" });
    if (path === "/api/core") {
      const method = String(b.method || "GET").toUpperCase();
      const p = String(b.path || "");
      if (!p.startsWith("/") || !page.allowed.test(p)) return send(res, 200, { status: 400, data: { error: `not a route the ${page.title} uses` } });
      const r = await core(method, p, b.body);
      // Both as the desktop gives them: `core`'s answer as data (coreReply), the drawers' `request` as the text (replied).
      return send(res, 200, { status: r.status, data: replyData(r.text), text: r.text });
    }
    if (path === "/api/call") {
      const fn = CALLS[b.name];
      if (!fn) return send(res, 200, { web: false });
      const result = await fn(b.page, ...(Array.isArray(b.args) ? b.args : []));
      // A call whose answer comes on signals (the Calendar's `ask`): told back as `emit`, which the bridge gives the page.
      if (result && typeof result === "object" && Array.isArray(result.emit)) return send(res, 200, { web: true, emit: result.emit });
      return send(res, 200, { web: true, result });
    }
    if (path === "/api/me") return send(res, 200, auth.listed(me));
    return send(res, 404, { error: "not here" });
  }
  return send(res, 404, { error: "not here" });
}

createServer((req, res) => {
  handle(req, res).catch((e) => { try { send(res, 500, { error: e.message }); } catch { /* gone */ } });
}).listen(PORT, HOST, () => console.log(`talaris-web: ${PREFIX} on http://${HOST}:${PORT}, the core on ${SOCKET}, passkeys for ${auth.ORIGIN}`));
