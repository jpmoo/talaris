// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore

import { request } from "node:http";
import { createInterface } from "node:readline";
import { SOCKET } from "./paths.js";
import { desktopTools } from "./mcp-desktop.js";
import { logSaid, mayRead, patternsSaid, type Act, type ActivitySettings, type Summary as ActivitySummary } from "./activity.js";

/**
 * `talaris-core mcp`: the entity graph for any MCP client on this machine —
 * Morgan, Claude Code, Claude Desktop, the Oracle's `claude`.
 *
 * Standard input and output only (DESIGN, *Entities → Morgan*): the store is
 * sealed on disk and this hands out what is in it, opened, so it is reached
 * only by something started as the user, here. It asks the running core over
 * its socket and holds nothing itself.
 *
 * The reading tools say they are read-only (`readOnlyHint`), so a client can
 * be given those and not the rest.
 */

const PROTOCOL = "2025-06-18";

function core<T>(method: string, path: string, body?: unknown): Promise<T> {
  return new Promise((ok, fail) => {
    const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const req = request({ socketPath: SOCKET, method, path, headers: data ? { "content-type": "application/json" } : {} }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let parsed: unknown = text;
        try { parsed = JSON.parse(text); } catch { /* kept as text */ }
        if ((res.statusCode ?? 500) >= 400) {
          const why = (parsed as { error?: string })?.error ?? text;
          fail(new Error(res.statusCode === 423 ? `Talaris's store is locked: ${why}` : why));
        } else ok(parsed as T);
      });
    });
    req.on("error", () => fail(new Error("Talaris is not running (no core on its socket)")));
    if (data) req.write(data);
    req.end();
  });
}

interface Summary { id: string; title: string; kinds: string[]; stub?: boolean }
interface Connection { by: string; name: string; via?: string; entity: Summary }
interface ContextItem { id: string; title: string; kind: string; due?: string; done?: boolean; start?: string }
interface Context { query: string; hits: ContextItem[]; about: { focus: ContextItem; related: (ContextItem & { how: string; incoming: boolean })[]; more: number }[] }
interface Read { entity: Record<string, unknown> & { properties: Record<string, unknown> }; title: string; kinds: string[]; out: Connection[]; in: Connection[] }

const KINDS = ["contact", "event", "note", "task", "project"];
const ROLE: Record<string, string> = { contact: "person", person: "person", event: "event", note: "note", task: "task", project: "project" };
const kindWord = (kinds: string[]) => (kinds.includes("contact") ? "person" : kinds.find((k) => KINDS.includes(k)) ?? "thing");
const line = (s: Summary) => `- ${s.title} (${kindWord(s.kinds)}${s.stub ? ", only a name so far" : ""}) [${s.id}]`;

/** An entity as a person would want it read: what it is, what it says, and everything it touches. */
function describe(r: Read): string {
  const out: string[] = [`${r.title} — ${kindWord(r.kinds)} [${r.entity.id}]`];
  const skip = new Set(["title"]);
  const refs = new Set([...r.out.filter((c) => c.by === "field").map((c) => c.name)]);
  for (const [k, v] of Object.entries(r.entity.properties)) {
    if (skip.has(k) || refs.has(k) || v === null || v === undefined) continue;
    const text = typeof v === "string" ? v : Array.isArray(v) && v.every((x) => typeof x === "string") ? v.join(", ") : JSON.stringify(v);
    out.push(`${k}: ${text.length > 2000 ? text.slice(0, 2000) + "…" : text}`);
  }
  if (Array.isArray(r.entity.tags) && r.entity.tags.length) out.push(`tags: ${(r.entity.tags as string[]).join(", ")}`);
  const group = (cs: Connection[], heading: (n: string) => string) => {
    const by = new Map<string, Connection[]>();
    for (const c of cs) by.set(c.name, [...(by.get(c.name) ?? []), c]);
    for (const [name, list] of by) {
      // The count said outright: a long list is cut short on its way to a model,
      // which then counted what it could see (98 of an event's 146 invitees).
      out.push("", `${heading(name).replace(/:$/, "")} (${list.length}):`);
      for (const c of list) out.push(line(c.entity));
    }
  };
  group(r.out, (n) => `${n}:`);
  group(r.in, (n) => `connected to this as ${n}:`);
  if (!r.out.length && !r.in.length) out.push("", "Nothing is connected to it yet.");
  return out.join("\n");
}

interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: { readOnlyHint: boolean; title: string };
  run: (args: Record<string, unknown>) => Promise<string>;
}

const str = (v: unknown) => (typeof v === "string" ? v : "");

const TOOLS: Tool[] = [
  {
    name: "talaris_find",
    description: "Find people, events, pages, tasks and projects kept in Talaris by words in their title or text. Returns each with its id, for talaris_read.",
    inputSchema: { type: "object", properties: {
      query: { type: "string", description: "Words to look for; empty lists the most likely." },
      kind: { type: "string", enum: ["person", "event", "note", "task", "project"], description: "Only this kind." },
      limit: { type: "number", description: "At most this many (default 20)." },
    } },
    annotations: { readOnlyHint: true, title: "Find in Talaris" },
    run: async (a) => {
      const kind = a.kind ? (a.kind === "person" ? "contact" : str(a.kind)) : "";
      const q = new URLSearchParams({ q: str(a.query), limit: String(Number(a.limit) || 20), ...(kind ? { kind } : {}) });
      const found = await core<Summary[]>("GET", `/entities?${q}`);
      return found.length ? found.map(line).join("\n") : "Nothing in Talaris matches that.";
    },
  },
  {
    name: "talaris_context",
    description: "Everything Talaris knows around some words: the people, tasks, pages, events and projects that hold them, and for each one they name (\"Rich\" names Rich Gelson), everything connected to it — the tasks that mention him, the notes about him, the meetings he was at — though those never say the words. Use it first for \"what do I have on…\", \"anything about…\", or to know the background before answering about a person, project or event.",
    inputSchema: { type: "object", properties: { query: { type: "string", description: "A name or a few words." } }, required: ["query"] },
    annotations: { readOnlyHint: true, title: "Context from Talaris" },
    run: async (a) => {
      const c = await core<Context>("GET", `/context?q=${encodeURIComponent(str(a.query))}`);
      if (!c.hits.length) return "Nothing in Talaris holds those words.";
      const said = (i: ContextItem) => `- ${i.title} (${i.kind}${i.kind === "task" ? (i.done ? ", done" : i.due ? `, due ${i.due}` : "") : i.kind === "event" && i.start ? `, ${i.start}` : ""}) [${i.id}]`;
      const out = [`Holding "${c.query}" (${c.hits.length}):`, ...c.hits.map(said)];
      for (const a of c.about) {
        out.push("", `Connected to ${a.focus.title} (${a.related.length + a.more}${a.more ? `, the ${a.related.length} most current shown` : ""}):`);
        out.push(...(a.related.length ? a.related.map((r) => `${said(r)} — ${r.incoming ? `its ${r.how}: ${a.focus.title}` : `${a.focus.title}'s ${r.how}`}`) : ["- nothing yet"]));
      }
      return out.join("\n");
    },
  },
  {
    name: "talaris_suggestions",
    description: "What a Talaris thing is probably tied to and is not yet — by a name in its words, by being the same thing twice, by closeness in meaning (files by their contents) — each with why, and the ways that fit: mention (the name in its words made a mention), connect, attach (a file put on a thing), merge (two of one kind made one). Give an entity id, or a key (page:<project>/<path>, file:<project>/<path>, project:<id>). Offer them to the user; tie one only when they say so (talaris_tie).",
    inputSchema: { type: "object", properties: { id: { type: "string" }, key: { type: "string" } } },
    annotations: { readOnlyHint: true, title: "Suggested ties" },
    run: async (a) => {
      const key = str(a.key) || `e:${str(a.id)}`;
      const r = await core<{ quiet: boolean; suggestions: { key: string; title: string; kind: string; why: string[]; score: number; ways: { how: string; label: string; text?: string }[] }[] }>("GET", `/suggestions?key=${encodeURIComponent(key)}`);
      if (r.quiet) return "The user has told this one not to suggest ties.";
      if (!r.suggestions.length) return "Nothing more to suggest for it.";
      return [`For ${key}:`, ...r.suggestions.map((x) => `- ${x.title} (${x.kind}) [${x.key}] — ${x.why.join("; ")}. Ways: ${x.ways.map((w) => `${w.how}${w.text ? ` "${w.text}"` : ""} ("${w.label}")`).join(", ")}`)].join("\n");
    },
  },
  {
    name: "talaris_tie",
    description: "Tie two Talaris things as talaris_suggestions offered, only when the user has said to: how is mention (give text, the words to make a mention), connect, or attach. Not merge: that is talaris_merge.",
    inputSchema: { type: "object", properties: {
      key: { type: "string", description: "The thing the suggestion was for (its key, or e:<id>)." },
      other: { type: "string", description: "The suggested thing's key." },
      how: { type: "string", enum: ["mention", "connect", "attach"] },
      text: { type: "string", description: "For a mention: the words in the text to make one." },
    }, required: ["key", "other", "how"] },
    annotations: { readOnlyHint: false, title: "Tie two things" },
    run: async (a) => {
      const r = await core<{ said: string }>("POST", "/suggestions/accept", { key: str(a.key), other: str(a.other), way: { how: str(a.how), label: "", ...(a.text ? { text: str(a.text) } : {}) } });
      return r.said;
    },
  },
  {
    name: "talaris_merge",
    description: "Make two Talaris things of one kind one — the same person entered twice, one task written twice — only when the user has asked to. What pointed at either points at the one kept; the other is gone. Give the two keys (e:<id>); one another app keeps in step is kept.",
    inputSchema: { type: "object", properties: { key: { type: "string" }, other: { type: "string" } }, required: ["key", "other"] },
    annotations: { readOnlyHint: false, title: "Merge two things" },
    run: async (a) => (await core<{ said: string }>("POST", "/suggestions/accept", { key: str(a.key), other: str(a.other), way: { how: "merge", label: "" } })).said,
  },
  {
    name: "talaris_file_read",
    description: "Read what a file in Talaris says, as text — PDFs, documents, spreadsheets, slides, and the words in pictures — by its key: file:<project>/<path in its folder> (from talaris_project_contents or talaris_search_meaning), or att:<…> (a file on a thing, from talaris_read or talaris_suggestions).",
    inputSchema: { type: "object", properties: { key: { type: "string" } }, required: ["key"] },
    annotations: { readOnlyHint: true, title: "Read a file" },
    run: async (a) => {
      const r = await core<{ name: string; text: string }>("GET", `/files/text?key=${encodeURIComponent(str(a.key))}`);
      return r.text ? `${r.name}:\n\n${r.text.length > 30000 ? `${r.text.slice(0, 30000)}\n…(cut short)` : r.text}` : `${r.name} has no words Talaris can read.`;
    },
  },
  {
    name: "talaris_read",
    description: "Read one Talaris entity and everything connected to it, both ways: an event's attendees and organizer, the events and pages a person turns up in, what a project holds, the notes linked to anything.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    annotations: { readOnlyHint: true, title: "Read from Talaris" },
    run: async (a) => describe(await core<Read>("GET", `/entities/${encodeURIComponent(str(a.id))}`)),
  },
  {
    name: "talaris_create",
    description: "Make a new person, event, page, task or project in Talaris. Returns its id. To find or make a person by email, give kind person and email. What the user calls a note is a page: one made here is a page of no other project, kept in Home under Pages (and in Hermes Notes as a note); a page in a project (\"a note in this project\") is made with talaris_page_write.",
    inputSchema: { type: "object", properties: {
      kind: { type: "string", enum: ["person", "event", "page", "task", "project"] },
      title: { type: "string" },
      body: { type: "string", description: "A page's words, in Markdown." },
      email: { type: "string", description: "A person's email." },
    }, required: ["kind", "title"] },
    annotations: { readOnlyHint: false, title: "Create in Talaris" },
    run: async (a) => {
      if (a.kind === "person" && a.email) {
        const p = await core<{ id: string }>("POST", "/entities/person", { email: str(a.email), name: str(a.title) });
        return `${str(a.title)} [${p.id}]`;
      }
      // A page — a note, as it may be asked for — is one of no other project: Home's, under Pages, as the writing drawer makes one.
      if (a.kind === "page" || a.kind === "note") {
        const home = { id: (await project("home")).id! };
        const page = await core<{ path: string }>("POST", `/projects/${home.id}/pages`, { parent: "Pages", title: str(a.title) });
        if (a.body) await core("PUT", `/projects/${home.id}/page?path=${encodeURIComponent(page.path)}`, str(a.body));
        return `Made the page ${page.path} in Home (project "${home.id}", path "${page.path}")`;
      }
      const role = ROLE[str(a.kind)];
      if (!role) throw new Error("kind is person, event, page, task or project");
      const properties: Record<string, unknown> = { title: str(a.title) };
      if (a.body) properties.body = str(a.body);
      const made = await core<{ id: string }>("POST", "/entities", { role, properties });
      return `Made ${str(a.title)} [${made.id}]`;
    },
  },
  {
    name: "talaris_connect",
    description: "Connect one Talaris entity to another — a page to the person or event it is about, a task to its project. Talaris files it where that kind of thing declares such a link.",
    inputSchema: { type: "object", properties: { from: { type: "string" }, to: { type: "string" } }, required: ["from", "to"] },
    annotations: { readOnlyHint: false, title: "Connect in Talaris" },
    run: async (a) => {
      const c = await core<Connection>("POST", `/entities/${encodeURIComponent(str(a.from))}/connect`, { to: str(a.to) });
      return `Connected, as ${c.name}, to ${c.entity.title}.`;
    },
  },
  {
    name: "talaris_update",
    description: "Change fields of a Talaris entity: a title, a page's body, a person's notes, a task's status (todo, doing, done). Only the fields given change; a field set to an empty string is removed.",
    inputSchema: { type: "object", properties: {
      id: { type: "string" },
      fields: { type: "object", description: "Field names and their new values, e.g. {\"notes\": \"Prefers mornings\"}." },
    }, required: ["id", "fields"] },
    annotations: { readOnlyHint: false, title: "Update in Talaris" },
    run: async (a) => {
      const e = await core<{ version: number }>("PATCH", `/entities/${encodeURIComponent(str(a.id))}`, { properties: a.fields ?? {} });
      return `Updated (version ${e.version}).`;
    },
  },
];

// ------------------------------------------------------------ tasks

interface TaskRow { id: string; title: string; status?: string; start?: string; due?: string; overdue?: boolean; recurring?: boolean; projects?: { title: string }[]; tags?: string[] }
const taskLine = (r: TaskRow) => {
  const bits = [r.status?.replace(/_/g, " ")];
  if (r.start) bits.push(`available ${r.start}`);
  if (r.due) bits.push(`due ${r.due}${r.overdue ? " OVERDUE" : ""}`);
  if (r.recurring) bits.push("repeats");
  if (r.projects?.length) bits.push(`project ${r.projects.map((p) => p.title).join(", ")}`);
  if (r.tags?.length) bits.push(`#${r.tags.join(" #")}`);
  return `- ${r.title} (${bits.filter(Boolean).join("; ")}) [${r.id}]`;
};

/**
 * The task type's statuses, as the person has set them (tasks.ts,
 * setStatuses): asked of the core when the tools are listed, never a list
 * kept here that a status renamed or added would leave behind.
 */
async function taskStatuses(): Promise<string[]> {
  const t = await core<{ shape: { statuses?: string[] } | null }>("GET", "/tasks/types").catch(() => null);
  return t?.shape?.statuses ?? [];
}
function withStatuses<T extends { name: string; inputSchema: Record<string, unknown> }>(t: T, statuses: string[]): T {
  const props = t.inputSchema.properties as Record<string, Record<string, unknown>> | undefined;
  if (!statuses.length || !props?.status) return t;
  // Finding takes open, complete or several; a task is given exactly one.
  const status = t.name === "talaris_tasks"
    ? { ...props.status, description: `One of ${statuses.join(", ")}; or open; or complete; or several, separated by commas.` }
    : { ...props.status, enum: statuses };
  return { ...t, inputSchema: { ...t.inputSchema, properties: { ...props, status } } };
}

/** A project as it is named, by the core's one resolver (filing.ts) — the desktop tools ask the same. */
const project = (name: string) => core<{ id?: string; name: string; home?: boolean; entity?: string }>("GET", `/projects/resolve?name=${encodeURIComponent(name)}`);

/** A project tasks are filed under, by name or id; Home is none (nothing is filed there), null. */
async function projectId(name: string): Promise<string | null> {
  const p = await project(name);
  if (p.home) return null;
  if (!p.entity) throw new Error(`${p.name} has no tasks`);
  return p.entity;
}

TOOLS.push(
  {
    name: "talaris_tasks",
    description: "Find tasks in Talaris: by when (overdue, today — which includes overdue, tomorrow, week, available, unscheduled, or a YYYY-MM-DD date to mean due by then), status (one of the task statuses; or open; or complete), project, tag, words, or a list's id.",
    inputSchema: { type: "object", properties: {
      when: { type: "string" }, status: { type: "string" }, project: { type: "string", description: "Its name or id — either id, its own or its desktop's (from talaris_now for \"this project\")." },
      tag: { type: "string" }, text: { type: "string" }, list: { type: "string" }, limit: { type: "number" },
    } },
    annotations: { readOnlyHint: true, title: "Find tasks in Talaris" },
    run: async (a) => {
      const q = new URLSearchParams();
      for (const k of ["when", "status", "tag", "text", "list"]) if (a[k]) q.set(k, str(a[k]));
      if (a.project) {
        const id = await projectId(str(a.project));
        if (!id) throw new Error("Home holds no tasks: a task in no project is filed nowhere");
        q.set("project", id);
      }
      q.set("limit", String(Number(a.limit) || 50));
      const rows = await core<TaskRow[]>("GET", `/tasks/find?${q}`);
      return rows.length ? `${rows.length} task(s):\n${rows.map(taskLine).join("\n")}` : "No tasks match.";
    },
  },
  {
    name: "talaris_projects",
    description: "Talaris's projects, each with how many open tasks it has.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true, title: "Projects in Talaris" },
    run: async () => {
      const all = await core<{ id: string; title: string; archived?: boolean }[]>("GET", "/tasks/projects");
      const lines = await Promise.all(all.filter((p) => !p.archived).map(async (p) => {
        const open = await core<TaskRow[]>("GET", `/tasks/find?project=${encodeURIComponent(p.id)}&status=open&limit=1000`);
        return `- ${p.title}: ${open.length} open [${p.id}]`;
      }));
      return lines.join("\n") || "No projects.";
    },
  },
  {
    name: "talaris_task_create",
    description: "Make a task in Talaris. Dates are YYYY-MM-DD, or YYYY-MM-DDTHH:mm for a time. Projects by name (made if new) or id.",
    inputSchema: { type: "object", properties: {
      title: { type: "string" }, notes: { type: "string" }, available: { type: "string" }, due: { type: "string" },
      status: { type: "string" }, projects: { type: "array", items: { type: "string" } }, tags: { type: "array", items: { type: "string" } },
    }, required: ["title"] },
    annotations: { readOnlyHint: false, title: "Create a task in Talaris" },
    run: async (a) => {
      const projects: string[] = [];
      for (const p of (a.projects as string[] | undefined) ?? []) {
        // Not a project yet: made. Home: filed nowhere.
        let id: string | null;
        try { id = await projectId(p); } catch { id = (await core<{ id: string }>("POST", "/tasks/projects", { title: p })).id; }
        if (id) projects.push(id);
      }
      const t = await core<{ id: string }>("POST", "/tasks", {
        title: str(a.title), description: str(a.notes) || undefined, start: str(a.available) || undefined, due: str(a.due) || undefined,
        status: str(a.status) || undefined, projects, tags: (a.tags as string[] | undefined) ?? [],
      });
      return `Made ${str(a.title)} [${t.id}]`;
    },
  },
  {
    name: "talaris_task_update",
    description: "Change a Talaris task: its title, notes, available or due date (an empty string clears one), status (done completes it; a recurring task then brings its next), projects to add or remove, tags to add or remove.",
    inputSchema: { type: "object", properties: {
      id: { type: "string" }, title: { type: "string" }, notes: { type: "string" }, available: { type: "string" }, due: { type: "string" },
      status: { type: "string" },
      addProjects: { type: "array", items: { type: "string" } }, removeProjects: { type: "array", items: { type: "string" } },
      addTags: { type: "array", items: { type: "string" } }, removeTags: { type: "array", items: { type: "string" } },
    }, required: ["id"] },
    annotations: { readOnlyHint: false, title: "Update a task in Talaris" },
    run: async (a) => {
      // Said by meaning; the core writes each where the task's type keeps it (tasks.ts, updateTask).
      const ids = async (names: unknown) => {
        const out: string[] = [];
        for (const x of (names as string[] | undefined) ?? []) { const id = await projectId(x); if (id) out.push(id); }
        return out;
      };
      const opt = (v: unknown) => (v === undefined ? undefined : str(v));
      await core("PATCH", `/tasks/${encodeURIComponent(str(a.id))}`, {
        title: opt(a.title), body: opt(a.notes), start: opt(a.available), due: opt(a.due), status: opt(a.status),
        addProjects: await ids(a.addProjects), removeProjects: await ids(a.removeProjects),
        addTags: (a.addTags as string[] | undefined) ?? [], removeTags: (a.removeTags as string[] | undefined) ?? [],
      });
      return "Updated.";
    },
  },
);

// What is on the screen, the verbs, pages and canvases (mcp-desktop.ts).
TOOLS.push(...desktopTools(core));

// ------------------------------------------------------------ activity

/**
 * The activity log, read (activity.ts): offered to Morgan alone — the client
 * that names itself `heymorgan` — and never to the Oracle or anything else
 * that connects. `share` is asked first; nothing kept local is fetched.
 */
export const MORGAN_CLIENT = "heymorgan";
const MORGANS_ONLY = new Set(["work_patterns", "work_log"]);
const STAYS = "What this returns is the person's private activity: it stays with Morgan and must never be passed to the Oracle, to any other model, or to any other service. Use it to suggest, never to act.";
const share = async () => (await core<ActivitySettings>("GET", "/activity/settings")).share;
const daysOf = (v: unknown, d: number) => Math.min(365, Math.max(1, Math.floor(Number(v)) || d));

TOOLS.push(
  {
    name: "work_patterns",
    description: `How the person works, from Talaris's activity log: what they open in which project, what they send where, which applications they open together, where their time goes, when in the day and week they are busiest. Use it for "how could I work better", "what do I spend my time on", "where does my day go", and to offer suggestions (pin these two there, keep that app in this project) — the person decides; never act on it yourself. ${STAYS}`,
    inputSchema: { type: "object", properties: { days: { type: "number", description: "The last this many days (default 30)." } } },
    annotations: { readOnlyHint: true, title: "Work patterns" },
    run: async (a) => {
      const s = await share();
      if (!mayRead(s, "summary")) return patternsSaid(s, null);
      return patternsSaid(s, await core<ActivitySummary>("GET", `/activity/summary?days=${daysOf(a.days, 30)}`));
    },
  },
  {
    name: "work_log",
    description: `What the person did through Talaris, one line per thing, oldest first — only when they have chosen to share it entry by entry; otherwise it says so. Prefer work_patterns; use this when the summary does not answer. To suggest, never to act. ${STAYS}`,
    inputSchema: { type: "object", properties: { days: { type: "number", description: "The last this many days (default 7)." } } },
    annotations: { readOnlyHint: true, title: "Work log" },
    run: async (a) => {
      const s = await share();
      if (!mayRead(s, "raw")) return logSaid(s, null);
      return logSaid(s, await core<Act[]>("GET", `/activity?days=${daysOf(a.days, 7)}&limit=2000`));
    },
  },
);

/** The tools a client is offered: the activity tools to Morgan alone (by `clientInfo.name`), the rest to any. */
export function toolsFor(client: string): Tool[] {
  return client === MORGAN_CLIENT ? TOOLS : TOOLS.filter((t) => !MORGANS_ONLY.has(t.name));
}

/** One of Talaris's own tools, run for a client — null when it is none it is offered. */
export async function callTool(client: string, name: unknown, args: Record<string, unknown>): Promise<{ text: string; isError?: boolean } | null> {
  const tool = toolsFor(client).find((t) => t.name === name);
  if (!tool) return null;
  try {
    return { text: await tool.run(args) };
  } catch (e) {
    return { text: (e as Error).message, isError: true };
  }
}

/**
 * The tools of every running plugin, under names of their own —
 * `<plugin>__<tool>` — with their descriptions said to be the plugin's and
 * their read-only hints kept, so Morgan asks before one changes anything
 * exactly as it does for Talaris's own (DESIGN: plugin verbs reach Morgan
 * without wiring).
 */
interface PluginTool { plugin: string; tool: string; listed: { name: string; description: string; inputSchema: Record<string, unknown>; annotations?: Record<string, unknown> } }
async function pluginTools(): Promise<PluginTool[]> {
  const rows = await core<{ plugin: string; pluginName: string; tool: { name: string; description?: string; inputSchema?: Record<string, unknown>; annotations?: Record<string, unknown> } }[]>("GET", "/plugins/tools").catch(() => []);
  return rows.map((r) => ({
    plugin: r.plugin,
    tool: r.tool.name,
    listed: {
      name: `${r.plugin.replace(/[^A-Za-z0-9_]/g, "_")}__${r.tool.name}`.slice(0, 64),
      description: `(${r.pluginName}, a Talaris plugin) ${r.tool.description ?? ""}`.trim(),
      inputSchema: r.tool.inputSchema ?? { type: "object", properties: {} },
      ...(r.tool.annotations ? { annotations: r.tool.annotations } : {}),
    },
  }));
}

type Message = { jsonrpc: "2.0"; id?: number | string; method?: string; params?: Record<string, unknown> };

function reply(id: Message["id"], result: unknown): void {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}
function error(id: Message["id"], code: number, message: string): void {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n");
}

/** Who connected, as its `initialize` said: Morgan is "heymorgan". */
let client = "";

async function answer(m: Message): Promise<void> {
  if (m.id === undefined) return; // a notification: nothing to say back
  switch (m.method) {
    case "initialize":
      client = String((m.params?.clientInfo as { name?: unknown } | undefined)?.name ?? "");
      return reply(m.id, {
        protocolVersion: typeof m.params?.protocolVersion === "string" ? m.params.protocolVersion : PROTOCOL,
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: "talaris", version: "0.1.0" },
        instructions: "Talaris is the user's desktop. It keeps their people, events (mirrored from their calendars, with invitees as people), pages (writing — what the user may call notes), tasks and projects, all connected: talaris_context for everything around a name or some words, talaris_find to look one up, talaris_read for one thing whole, talaris_suggestions for what one might be tied to and is not, talaris_file_read for what a file says. It also knows what is on the screen — talaris_now answers \"what am I looking at\", \"this canvas\", \"this page\" without a screenshot — and does what the user would: go to a project, open things, launch applications, write pages and build canvases (talaris_canvas_read, then talaris_canvas_edit).",
      });
    case "ping":
      return reply(m.id, {});
    case "tools/list":
    {
      const statuses = await taskStatuses();
      return reply(m.id, { tools: [...toolsFor(client).map(({ run: _run, ...t }) => withStatuses(t, statuses)), ...(await pluginTools()).map((p) => p.listed)] });
    }
    case "tools/call": {
      const done = await callTool(client, m.params?.name, (m.params?.arguments as Record<string, unknown>) ?? {});
      if (done) return reply(m.id, { content: [{ type: "text", text: done.text }], ...(done.isError ? { isError: true } : {}) });
      if (MORGANS_ONLY.has(String(m.params?.name))) return error(m.id, -32602, `no tool ${String(m.params?.name)}`);
      // A plugin's tool, passed through to it as it was offered (plugins.ts): its answer is its own.
      const p = (await pluginTools()).find((x) => x.listed.name === m.params?.name);
      if (!p) return error(m.id, -32602, `no tool ${String(m.params?.name)}`);
      try {
        return reply(m.id, await core("POST", `/plugins/${encodeURIComponent(p.plugin)}/call`, { tool: p.tool, arguments: m.params?.arguments ?? {} }));
      } catch (e) {
        return reply(m.id, { content: [{ type: "text", text: (e as Error).message }], isError: true });
      }
    }
    default:
      return error(m.id, -32601, `no method ${String(m.method)}`);
  }
}

const inFlight = new Set<Promise<void>>();

export function serveMcp(): void {
  const lines = createInterface({ input: process.stdin });
  // A plugin enabled, stopped or offering new tools: the client is told its list changed.
  let known = "";
  const watch = setInterval(() => void pluginTools().then((t) => {
    const now = t.map((x) => x.listed.name).sort().join(",");
    if (known && now !== known) process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/tools/list_changed" }) + "\n");
    known = now;
  }), 30_000);
  watch.unref();
  lines.on("line", (text) => {
    if (!text.trim()) return;
    let m: Message;
    try {
      m = JSON.parse(text) as Message;
    } catch {
      error(null as unknown as undefined, -32700, "not JSON");
      return;
    }
    const pending = answer(m);
    inFlight.add(pending);
    void pending.finally(() => inFlight.delete(pending));
  });
  // Input closed: finish what was asked, then go.
  lines.on("close", () => void Promise.allSettled([...inFlight]).then(() => process.exit(0)));
}
