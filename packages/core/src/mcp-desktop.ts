// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore

import { createConnection } from "node:net";
import { join } from "node:path";
import type { CanvasDocument, CanvasItem, CanvasNode, PageNode } from "@talaris/model";

/**
 * The desktop on Talaris's MCP (DESIGN, *Morgan*: "The desktop is what Morgan
 * knows"; step 10): what is on the screen, the verbs, and the project's pages
 * and canvases to read and change — Canvas Chat's one job, as tools.
 *
 * What is on the screen and the verbs are the surfaces process's to answer
 * (`surfaces/desktop_api.py`), over its control socket; pages and canvases are
 * the core's. **No screenshot**: what is current is read as structure.
 *
 * A page or a canvas changed here is read again by the drawer showing it; a
 * canvas's open page holding an older copy has its save refused as stale
 * (canvases.ts, `talaris:rev`) and reads itself back.
 */

type Core = <T>(method: string, path: string, body?: unknown) => Promise<T>;
export interface DesktopTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: { readOnlyHint: boolean; title: string };
  run: (args: Record<string, unknown>) => Promise<string>;
}

const SURFACES = join(process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.() ?? 1000}`, "talaris-surfaces.sock");

/** One request to the surfaces process: a JSON line, answered with one. */
function surfaces<T = Record<string, unknown>>(req: Record<string, unknown>): Promise<T> {
  return new Promise((ok, fail) => {
    const sock = createConnection(SURFACES);
    let got = "";
    const timer = setTimeout(() => { sock.destroy(); fail(new Error("Talaris's desktop did not answer")); }, 8000);
    sock.on("connect", () => sock.write(JSON.stringify(req) + "\n"));
    sock.on("data", (d) => { got += d.toString("utf8"); });
    sock.on("error", () => { clearTimeout(timer); fail(new Error("Talaris's desktop is not running")); });
    sock.on("close", () => {
      clearTimeout(timer);
      try {
        const r = JSON.parse(got.trim()) as { ok: boolean; error?: string } & T;
        if (!r.ok) fail(new Error(r.error ?? "it could not be done"));
        else ok(r);
      } catch {
        fail(new Error("Talaris's desktop answered nothing"));
      }
    });
  });
}

interface Now {
  project: { id: string; name: string; home: boolean };
  desktop: string;
  focused: { address: string; app: string; title: string } | null;
  windowsHere: { address: string; app: string; title: string }[];
  panelsOut: string[];
  drawers: Record<string, { out: boolean; canvas?: { id: string; title: string; trail: string[] }; page?: { path: string } | null }>;
}
interface ProjectRow { id: string; name: string; code: string; home?: boolean }

const str = (v: unknown) => (typeof v === "string" ? v : "");
const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
const PANELS = ["canvas", "writing", "tasks", "calendar", "people", "glance", "morgan", "new"];

export function desktopTools(core: Core): DesktopTool[] {
  const now = async () => (await surfaces<{ now: Now }>({ do: "now" })).now;

  /** A project by id or name (exact, then part of one); none given, the current one. */
  async function project(name: unknown): Promise<ProjectRow> {
    const all = await core<ProjectRow[]>("GET", "/projects");
    const n = str(name).trim();
    if (!n) {
      const here = await now().then((x) => x.project.id, () => "");
      return all.find((p) => p.id === here) ?? all.find((p) => p.home) ?? all[0]!;
    }
    const l = n.toLowerCase();
    const hit = all.find((p) => p.id === n) ?? all.find((p) => p.name.toLowerCase() === l || p.code.toLowerCase() === l)
      ?? all.find((p) => p.name.toLowerCase().includes(l));
    if (!hit) throw new Error(`no project called ${n}; there are ${all.map((p) => p.name).join(", ")}`);
    return hit;
  }

  /** A canvas by id or title in a project; none given, the one the canvas drawer shows there, or the top one. */
  async function canvas(p: ProjectRow, which: unknown): Promise<CanvasNode> {
    const tree = await core<CanvasNode>("GET", `/projects/${p.id}/canvases`);
    const all: CanvasNode[] = [];
    const walk = (n: CanvasNode) => { all.push(n); n.children.forEach(walk); };
    walk(tree);
    const w = str(which).trim();
    if (!w) {
      const shown = await now().then((x) => (x.project.id === p.id ? x.drawers.canvas?.canvas?.id : undefined), () => undefined);
      return all.find((c) => c.id === shown) ?? tree;
    }
    const l = w.toLowerCase();
    const hit = all.find((c) => c.id === w) ?? all.find((c) => c.title.toLowerCase() === l) ?? all.find((c) => c.title.toLowerCase().includes(l));
    if (!hit) throw new Error(`no canvas called ${w} in ${p.name}; it has ${all.map((c) => c.title).join(", ")}`);
    return hit;
  }

  const told = (kind: "page" | "canvas", projectId: string, where: string) =>
    surfaces({ do: "changed", kind, project: projectId, where }).catch(() => undefined);

  const pageList = (nodes: PageNode[], depth = 0): string[] =>
    nodes.flatMap((n) => [`${"  ".repeat(depth)}- ${n.title}${n.starred ? " ★" : ""}  (path: ${n.path})`, ...pageList(n.children, depth + 1)]);
  const canvasList = (n: CanvasNode, depth = 0): string[] =>
    [`${"  ".repeat(depth)}- ${n.title}${n.starred ? " ★" : ""} [${n.id}]`, ...n.children.flatMap((c) => canvasList(c, depth + 1))];

  /** A canvas in words: every item with its id, where it is and what it says; then the links. */
  function describeCanvas(doc: CanvasDocument, node: CanvasNode): string {
    const out = [`Canvas "${doc.title}" [${doc.id}] — ${doc.items.length} item(s), ${doc.links.length} link(s). Positions are x,y of the top left; sizes w×h.`];
    for (const i of doc.items) {
      const kind = i.kind === "card" ? `card for ${i.seen?.kind ?? "entity"} ${i.entity}` : i.kind === "canvas" ? `child canvas ${i.canvas}` : i.kind === "canvas-link" ? `link to canvas ${i.canvas}` : (i.shape as string) ?? "note";
      const words = i.kind === "card" || i.kind?.startsWith("canvas") ? i.seen?.title ?? "" : String(i.text ?? "");
      out.push(`- [${i.id}] ${kind} at ${Math.round(i.x)},${Math.round(i.y)} ${Math.round(i.w)}×${Math.round(i.h)}${i.fill ? ` fill ${i.fill}` : ""}: ${JSON.stringify(words.length > 400 ? words.slice(0, 400) + "…" : words)}`);
    }
    if (doc.links.length) {
      out.push("", "Links:");
      for (const l of doc.links) out.push(`- [${l.id}] ${l.from} → ${l.to}`);
    }
    if (doc.regions.length) {
      out.push("", "Regions:");
      for (const r of doc.regions) out.push(`- [${r.id}] ${r.title ?? ""}: ${(r.members ?? []).join(", ")}`);
    }
    if (node.children.length) out.push("", `Canvases inside it: ${node.children.map((c) => `${c.title} [${c.id}]`).join(", ")}`);
    return out.join("\n");
  }

  const id = () => `i${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

  return [
    {
      name: "talaris_now",
      description: "What is on the user's screen right now, as Talaris knows it — no screenshot: the current project, the focused window (application and title), the other windows on this desktop, which Talaris panels are out, and the canvas and the writing page the drawers show. Use it for \"what am I looking at\", \"this canvas\", \"this page\", \"this project\".",
      inputSchema: { type: "object", properties: {} },
      annotations: { readOnlyHint: true, title: "What is on screen" },
      run: async () => {
        const n = await now();
        const lines = [`Project: ${n.project.name}${n.project.home ? " (Home)" : ""} [${n.project.id}]`];
        lines.push(n.focused ? `Focused window: ${n.focused.app} — ${n.focused.title}` : "No window has focus.");
        const others = n.windowsHere.filter((w) => w.address !== n.focused?.address);
        if (others.length) lines.push(`Also on this desktop: ${others.map((w) => `${w.app} — ${w.title}`).join("; ")}`);
        if (n.panelsOut.length) lines.push(`Talaris panels out: ${n.panelsOut.join(", ")}`);
        const c = n.drawers.canvas, w = n.drawers.writing;
        if (c?.canvas) lines.push(`Canvas drawer${c.out ? " (out)" : " (put away)"} shows: ${[...c.canvas.trail].join(" / ")} [${c.canvas.id}]`);
        if (w?.page) lines.push(`Writing drawer${w.out ? " (out)" : " (put away)"} shows the page: ${w.page.path}`);
        return lines.join("\n");
      },
    },
    {
      name: "talaris_windows",
      description: "The open windows: on this desktop, or (all) every desktop — each with its address, for talaris_focus_window and talaris_close_window.",
      inputSchema: { type: "object", properties: { all: { type: "boolean" } } },
      annotations: { readOnlyHint: true, title: "Open windows" },
      run: async (a) => {
        const r = await surfaces<{ windows: { address: string; app: string; title: string; desktop: string; hidden: boolean; focused: boolean }[] }>({ do: "windows", all: Boolean(a.all) });
        return r.windows.map((w) => `- ${w.app} — ${w.title} (desktop ${w.desktop}${w.hidden ? ", hidden" : ""}${w.focused ? ", focused" : ""}) [${w.address}]`).join("\n") || "No windows.";
      },
    },
    {
      name: "talaris_project_contents",
      description: "What a Talaris project holds: its writing pages (nested, with paths), its canvases (nested, with ids) and the files in its folder. No project given: the current one.",
      inputSchema: { type: "object", properties: { project: { type: "string", description: "Name or id; empty for the current project." } } },
      annotations: { readOnlyHint: true, title: "A project's contents" },
      run: async (a) => {
        const p = await project(a.project);
        const [pages, tree, g] = await Promise.all([
          core<PageNode[]>("GET", `/projects/${p.id}/pages`),
          core<CanvasNode>("GET", `/projects/${p.id}/canvases`),
          core<{ nodes: { kind: string; own: boolean; path?: string }[] }>("GET", `/projects/${p.id}/glance?steps=1`).catch(() => ({ nodes: [] })),
        ]);
        const files = g.nodes.filter((n) => n.kind === "file" && n.own).map((n) => n.path!);
        return [`Project ${p.name} [${p.id}]`, "", "Pages:", ...(pageList(pages).length ? pageList(pages) : ["(none)"]),
          "", "Canvases:", ...canvasList(tree), "", `Files (${files.length}):`, ...files.slice(0, 100).map((f) => `- ${f}`)].join("\n");
      },
    },
    {
      name: "talaris_page_read",
      description: "Read a writing page of a Talaris project, as Markdown. No project: the current one. No path: the page the writing drawer shows.",
      inputSchema: { type: "object", properties: { project: { type: "string" }, path: { type: "string", description: "The page's path, e.g. \"Plans/Budget\"." } } },
      annotations: { readOnlyHint: true, title: "Read a page" },
      run: async (a) => {
        const p = await project(a.project);
        let path = str(a.path);
        if (!path) path = (await now()).drawers.writing?.page?.path ?? "";
        if (!path) throw new Error("which page? no path given and the writing drawer shows none");
        const text = await core<string>("GET", `/projects/${p.id}/page?path=${encodeURIComponent(path)}`);
        return `${path} (in ${p.name}):\n\n${typeof text === "string" ? text : JSON.stringify(text)}`;
      },
    },
    {
      name: "talaris_canvas_read",
      description: "Read a canvas of a Talaris project: every item (notes, shapes, cards of people, tasks and events, child canvases) with its id, position, size and words, and the links between them. No canvas given: the one the canvas drawer shows, or the project's top canvas.",
      inputSchema: { type: "object", properties: { project: { type: "string" }, canvas: { type: "string", description: "Its title or id." } } },
      annotations: { readOnlyHint: true, title: "Read a canvas" },
      run: async (a) => {
        const p = await project(a.project);
        const node = await canvas(p, a.canvas);
        return describeCanvas(await core<CanvasDocument>("GET", `/projects/${p.id}/canvases/${node.id}`), node);
      },
    },
    {
      name: "talaris_archive_search",
      description: "Search the archive: the pages, canvases and files of projects the user has archived — which are in no other result, nor in talaris_now. Use it only when the user asks about old or archived work (\"what did I write about the retreat last year?\"). Read talaris_page_read with the project's id for a whole page.",
      inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
      annotations: { readOnlyHint: true, title: "Search the archive" },
      run: async (a) => {
        const hits = await core<{ project: string; projectName: string; kind: string; where: string; title: string; snippet?: string }[]>("GET", `/archive/search?q=${encodeURIComponent(str(a.query))}`);
        return hits.length ? hits.map((h) => `- ${h.kind} "${h.title}" in archived project ${h.projectName} [${h.project}] (${h.kind === "page" ? `path: ${h.where}` : h.where})${h.snippet ? `: …${h.snippet}…` : ""}`).join("\n")
          : "Nothing in the archive says that.";
      },
    },
    // ------------------------------------------------------------ verbs
    {
      name: "talaris_archive_project",
      description: "Archive a Talaris project: its folder goes to the archive, and it leaves every list, search and context until it is brought back (from the archive browser). Home cannot be archived.",
      inputSchema: { type: "object", properties: { project: { type: "string", description: "Name or id." } }, required: ["project"] },
      annotations: { readOnlyHint: false, title: "Archive a project" },
      run: async (a) => {
        const p = await project(a.project);
        if (p.home) throw new Error("Home cannot be archived");
        // Through the desktop, which leaves the project first if it is the current one.
        await surfaces({ do: "archive", project: p.id });
        return `Archived ${p.name}.`;
      },
    },
    {
      name: "talaris_go",
      description: "Go to a Talaris project: its desktop comes up, and its canvas and writing drawers become current.",
      inputSchema: { type: "object", properties: { project: { type: "string", description: "Name or id." } }, required: ["project"] },
      annotations: { readOnlyHint: false, title: "Go to a project" },
      run: async (a) => {
        const p = await project(a.project);
        await surfaces({ do: "go", project: p.id });
        return `Went to ${p.name}.`;
      },
    },
    {
      name: "talaris_open",
      description: "Open something where it lives: a page or a canvas in its drawer (going to its project), a file of a project in its application, or an entity by id — a task in Tasks, a person in People, a calendar event in the calendar.",
      inputSchema: { type: "object", properties: {
        page: { type: "string", description: "A page's path." },
        canvas: { type: "string", description: "A canvas's title or id." },
        file: { type: "string", description: "A file's path in the project's folder." },
        project: { type: "string", description: "For a page, canvas or file; empty for the current project." },
        id: { type: "string", description: "An entity's id (from talaris_find)." },
      } },
      annotations: { readOnlyHint: false, title: "Open in Talaris" },
      run: async (a) => {
        if (a.id) {
          const eid = encodeURIComponent(str(a.id));
          const place = await core<{ kind: string; project: string; where: string }>("GET", `/entities/${eid}/place`).catch(() => null);
          if (place) { await surfaces({ do: "open", ...place }); return "Opened."; }
          const r = await core<{ kinds: string[]; title: string; entity: Record<string, unknown> & { properties: Record<string, unknown> } }>("GET", `/entities/${eid}`);
          if (r.kinds.includes("task")) await surfaces({ do: "open", kind: "task", id: str(a.id) });
          else if (r.kinds.includes("contact")) await surfaces({ do: "open", kind: "person", id: str(a.id) });
          else if (r.kinds.includes("event")) {
            const src = ((r.entity["talaris:sources"] as { kind: string; key: string }[] | undefined) ?? []).find((s) => s.kind === "eds-event");
            if (!src) throw new Error(`${r.title} is not on a calendar; read it with talaris_read instead`);
            const at = src.key.indexOf("/");
            await surfaces({ do: "open", kind: "event", calendar: src.key.slice(0, at), uid: src.key.slice(at + 1), start: str(r.entity.properties.start) });
          } else throw new Error(`${r.title} has no place of its own to open; read it with talaris_read`);
          return `Opened ${r.title}.`;
        }
        const p = await project(a.project);
        if (a.page) { await surfaces({ do: "open", kind: "page", project: p.id, where: str(a.page) }); return `Opened the page ${str(a.page)}.`; }
        if (a.canvas) { const c = await canvas(p, a.canvas); await surfaces({ do: "open", kind: "canvas", project: p.id, where: c.id }); return `Opened the canvas ${c.title}.`; }
        if (a.file) { await surfaces({ do: "open", kind: "file", project: p.id, path: str(a.file) }); return `Opened ${str(a.file)}.`; }
        throw new Error("open what? give a page, canvas, file or id");
      },
    },
    {
      name: "talaris_show",
      description: `Bring out one of Talaris's panels: ${PANELS.join(", ")}.`,
      inputSchema: { type: "object", properties: { panel: { type: "string", enum: PANELS } }, required: ["panel"] },
      annotations: { readOnlyHint: false, title: "Show a panel" },
      run: async (a) => { await surfaces({ do: "show", panel: str(a.panel) }); return `${str(a.panel)} is out.`; },
    },
    {
      name: "talaris_launch",
      description: "Start an application, by its name (\"Firefox\", \"Files\") or desktop id, on the current desktop — as the launcher does: one that keeps a single window already open is brought here instead.",
      inputSchema: { type: "object", properties: { app: { type: "string" } }, required: ["app"] },
      annotations: { readOnlyHint: false, title: "Launch an application" },
      run: async (a) => { const r = await surfaces<{ app: string }>({ do: "launch", app: str(a.app) }); return `Started ${r.app}.`; },
    },
    {
      name: "talaris_focus_window",
      description: "Bring a window forward and give it the keyboard, by its address from talaris_windows.",
      inputSchema: { type: "object", properties: { address: { type: "string" } }, required: ["address"] },
      annotations: { readOnlyHint: false, title: "Focus a window" },
      run: async (a) => { await surfaces({ do: "focus", address: str(a.address) }); return "Focused."; },
    },
    {
      name: "talaris_close_window",
      description: "Close a window, by its address from talaris_windows. The application may ask to save first.",
      inputSchema: { type: "object", properties: { address: { type: "string" } }, required: ["address"] },
      annotations: { readOnlyHint: false, title: "Close a window" },
      run: async (a) => { await surfaces({ do: "close-window", address: str(a.address) }); return "Asked it to close."; },
    },
    // ------------------------------------------------------------ writing and canvases
    {
      name: "talaris_page_write",
      description: "Write a Talaris writing page, in Markdown: replace its words, or append to them. A page that does not exist is made (a path's folders are its parent pages). No path: the page the writing drawer shows. The drawer showing it reads it again.",
      inputSchema: { type: "object", properties: {
        project: { type: "string" }, path: { type: "string" }, text: { type: "string" },
        mode: { type: "string", enum: ["replace", "append"], description: "Default append." },
      }, required: ["text"] },
      annotations: { readOnlyHint: false, title: "Write a page" },
      run: async (a) => {
        const p = await project(a.project);
        let path = str(a.path);
        if (!path) path = (await now()).drawers.writing?.page?.path ?? "";
        if (!path) throw new Error("which page? give a path");
        const q = `/projects/${p.id}/page?path=${encodeURIComponent(path)}`;
        let before: string | null = await core<string>("GET", q).then((t) => (typeof t === "string" ? t : ""), () => null);
        if (before === null) {
          const at = path.lastIndexOf("/");
          const made = await core<PageNode>("POST", `/projects/${p.id}/pages`, { parent: at > 0 ? path.slice(0, at) : null, title: path.slice(at + 1) });
          path = made.path;
          before = "";
        }
        const text = str(a.mode) === "replace" || !before.trim() ? str(a.text) : `${before.replace(/\s+$/, "")}\n\n${str(a.text)}`;
        await core("PUT", `/projects/${p.id}/page?path=${encodeURIComponent(path)}`, text);
        await told("page", p.id, path);
        return `Wrote ${path} in ${p.name}.`;
      },
    },
    {
      name: "talaris_canvas_edit",
      description: [
        "Change a Talaris canvas: a list of operations, done in order and saved together. No canvas given: the one the canvas drawer shows. Read it first with talaris_canvas_read for ids and positions.",
        "Operations: {op:\"note\", text, x?, y?, w?, h?, fill?} a note (Markdown; fill a #rrggbb color) — without x,y it goes to the right of what is there;",
        "{op:\"card\", entity, x?, y?} a card showing an entity (a person, task or event id from talaris_find);",
        "{op:\"update\", item, text?, x?, y?, w?, h?, fill?}; {op:\"remove\", item} (also takes its links);",
        "{op:\"link\", from, to} an arrow between two items; {op:\"unlink\", link};",
        "{op:\"canvas\", title, x?, y?} a new canvas inside this one, as a card.",
        "The ids of what was made are returned, so a later operation in the same call can use \"$1\", \"$2\"… for the first, second… thing made.",
      ].join(" "),
      inputSchema: { type: "object", properties: {
        project: { type: "string" }, canvas: { type: "string" },
        ops: { type: "array", items: { type: "object" } },
      }, required: ["ops"] },
      annotations: { readOnlyHint: false, title: "Edit a canvas" },
      run: async (a) => {
        const p = await project(a.project);
        const node = await canvas(p, a.canvas);
        const ops = (Array.isArray(a.ops) ? a.ops : []) as Record<string, unknown>[];
        if (!ops.length) throw new Error("no operations");
        const path = `/projects/${p.id}/canvases/${node.id}`;
        // Children first, by the core's own verb: it writes the parent too.
        const made: string[] = [];
        const madeCanvases: string[] = [];
        for (const op of ops.filter((o) => o.op === "canvas")) {
          const r = await core<{ canvas: { id: string; title: string } }>("POST", `${path}/children`, { title: str(op.title), x: num(op.x, 0), y: num(op.y, 0) });
          madeCanvases.push(`${r.canvas.title} [${r.canvas.id}]`);
        }
        const doc = await core<CanvasDocument>("GET", path);
        const ref = (v: unknown) => { const s = str(v); const m = /^\$(\d+)$/.exec(s); return m ? made[Number(m[1]) - 1] ?? s : s; };
        const find = (v: unknown) => { const k = ref(v); const it = doc.items.find((i) => i.id === k); if (!it) throw new Error(`no item ${k} on ${doc.title}`); return it; };
        // Somewhere free: right of everything, stacked down.
        const right = () => (doc.items.length ? Math.max(...doc.items.map((i) => i.x + i.w)) + 40 : 0);
        let column = right(), row = doc.items.length ? Math.min(...doc.items.map((i) => i.y)) : 0;
        const spot = (op: Record<string, unknown>, h: number) => {
          if (typeof op.x === "number" && typeof op.y === "number") return { x: op.x, y: op.y };
          const at = { x: column, y: row };
          row += h + 30;
          return at;
        };
        const done: string[] = [];
        for (const op of ops) {
          switch (op.op) {
            case "note": {
              const w = num(op.w, 220), h = num(op.h, 130);
              const item: CanvasItem = { id: id(), ...spot(op, h), w, h, text: str(op.text), ...(str(op.fill) ? { fill: str(op.fill) } : {}) };
              doc.items.push(item);
              made.push(item.id);
              done.push(`note ${item.id}`);
              break;
            }
            case "card": {
              const e = await core<{ title: string; kinds: string[] }>("GET", `/entities/${encodeURIComponent(str(op.entity))}`);
              const kind = ["task", "event", "contact", "note"].find((k) => e.kinds.includes(k)) ?? "note";
              const h = kind === "task" ? 72 : kind === "event" ? 96 : kind === "contact" ? 76 : 110;
              const item: CanvasItem = { id: id(), kind: "card", entity: str(op.entity), ...spot(op, h), w: 240, h, seen: { title: e.title, kind } };
              doc.items.push(item);
              made.push(item.id);
              done.push(`card ${item.id} (${e.title})`);
              break;
            }
            case "update": {
              const it = find(op.item);
              for (const k of ["x", "y", "w", "h"] as const) if (typeof op[k] === "number") it[k] = op[k] as number;
              if (op.text !== undefined && it.kind !== "card") it.text = str(op.text);
              if (op.fill !== undefined) it.fill = str(op.fill) || null;
              done.push(`updated ${it.id}`);
              break;
            }
            case "remove": {
              const it = find(op.item);
              if (it.kind === "canvas") throw new Error(`${it.id} is a child canvas: it is deleted in the drawer, not here`);
              doc.items = doc.items.filter((i) => i !== it);
              doc.links = doc.links.filter((l) => l.from !== it.id && l.to !== it.id);
              for (const r of doc.regions) if (r.members) r.members = r.members.filter((m) => m !== it.id);
              done.push(`removed ${it.id}`);
              break;
            }
            case "link": {
              const from = find(op.from), to = find(op.to);
              const l = { id: crypto.randomUUID(), from: from.id, to: to.id, color: null };
              doc.links.push(l);
              done.push(`link ${l.id}`);
              break;
            }
            case "unlink": {
              const before = doc.links.length;
              doc.links = doc.links.filter((l) => l.id !== str(op.link));
              if (doc.links.length === before) throw new Error(`no link ${str(op.link)}`);
              done.push(`unlinked ${str(op.link)}`);
              break;
            }
            case "canvas":
              break;
            default:
              throw new Error(`no operation ${String(op.op)}: note, card, update, remove, link, unlink or canvas`);
          }
        }
        await core("PUT", path, doc);
        await told("canvas", p.id, node.id);
        return [`${doc.title}: ${[...madeCanvases.map((c) => `canvas ${c}`), ...done].join("; ")}.`].join("\n");
      },
    },
  ];
}
