// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore

import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import { join } from "node:path";
import type { CanvasDocument, CanvasItem, CanvasNode } from "@talaris/model";

/**
 * Hermes Notes' tools, by Hermes' names and arguments, answered by Talaris —
 * so Claude keeps the verbs it learned there once Hermes is retired
 * (`apps/server/src/mcp/toolkit.ts` in jpmoo/hermesnotes is the spec matched).
 *
 * A translation, not a second store: every tool asks the running core over
 * its socket, through the routes the panels use, and owns no business logic
 * of its own. Completing a task is the core's PATCH, which stamps the time
 * and brings a series' next; a block made is the live binding's create, which
 * knows a note is a page and a project a folder.
 *
 * Hermes' words, Talaris's things: a block is an entity; a collection is a
 * list (Tasks' lists, boards and matrices) or a canvas; a daily note is
 * Home's `Daily/<date>` page. Where Talaris has no counterpart for part of a
 * tool, the description says so and the answer says what was not done —
 * never a success that did not happen.
 *
 * Nothing here names a type or a field: a task is what declares the task
 * profile, its status and what counts as complete are its profile's, and a
 * title or a body is wherever the type's profile puts it.
 */

type Core = <T>(method: string, path: string, body?: unknown) => Promise<T>;
export interface HermesTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: { readOnlyHint: boolean; title: string; destructiveHint?: boolean };
  run: (args: Record<string, unknown>) => Promise<string>;
}

// ------------------------------------------------------------ shapes the core answers in

interface Field { key: string; kind: string; many?: boolean; options?: string[]; label?: string; [k: string]: unknown }
interface EntityType { id: string; name: string; fields: Field[]; profiles?: Record<string, Record<string, unknown>>; [k: string]: unknown }
interface Entity { id: string; type?: string; properties: Record<string, unknown>; content?: string; tags?: string[]; archived?: boolean; created: string; updated: string; version: number; [k: string]: unknown }
interface Summary { id: string; title: string; kinds: string[]; type?: string; stub?: boolean; archived?: boolean }
interface Connection { by: "field" | "relation"; name: string; entity: Summary }
interface Read { entity: Entity; title: string; kinds: string[]; out: Connection[]; in: Connection[] }
interface Row { id: string; title: string; kinds: string[]; status?: string; complete?: boolean; start?: string; due?: string; overdue?: boolean; recurring?: boolean; projects?: { id: string; title: string }[]; tags?: string[]; region?: string; body?: string; fields: Record<string, unknown> }
interface Region { name: string; label?: string; [k: string]: unknown }
interface List { id: string; name: string; kind: string; membership: { mode: string; materialized?: boolean; query?: unknown }; members: { object: string; region?: string }[]; placement?: { regions: (string | Region)[] }; archived?: boolean; "talaris:bind"?: string; [k: string]: unknown }
interface Shown { list: List; rows: Row[]; drawer?: Row[] }
interface Shape { statusKey: string; statuses: string[]; complete: string[]; defaultStatus: string; type: EntityType }
interface ProjectMatch { id?: string; name: string; code?: string; home?: boolean; entity?: string; archived?: boolean }
interface TaskProject { id: string; title: string; archived?: boolean; workspace?: string; description?: string }
interface Mentionable { id: string; title: string; kind: string; project?: string; projectName?: string; where?: string }
interface Meaning { key: string; kind: string; title: string; id?: string; project?: string; path?: string; score: number; passage: string }

// ------------------------------------------------------------ small helpers

const str = (v: unknown) => (typeof v === "string" ? v : "");
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.map(str).filter(Boolean) : typeof v === "string" && v ? [v] : []);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const q = encodeURIComponent;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
/** Hermes' way of comparing a word: case, spaces and punctuation don't matter. */
const letters = (v: string) => v.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
const DONE_WORDS = new Set(["done", "complete", "completed", "finish", "finished", "closed"]);
/** Tags as Hermes took them: trimmed, a leading # dropped. Talaris keeps the case a tag was first written in. */
const tagOf = (t: string) => t.trim().replace(/^#+/, "").trim();
const fmtDate = (v: string) => (v.includes("T") ? v.replace("T", " ") : v);
const pad = (n: number) => String(n).padStart(2, "0");
/** The date here — the machine Talaris runs on, the same day the panels show. */
const localDate = (at = new Date()) => `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
const nextDay = (date: string) => { const d = new Date(`${date}T12:00:00`); d.setDate(d.getDate() + 1); return localDate(d); };
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
/** A fill a canvas puts in a CSS background: a hex value or a color's name, never anything that could fetch (`url(…)`). */
const SAFE_COLOR = /^(#[0-9a-fA-F]{3,8}|[a-zA-Z]{3,20})$/;

const SCHEMA = {
  s: { type: "string" },
  b: { type: "boolean" },
  n: { type: "number" },
  ss: { type: "array", items: { type: "string" } },
  o: { type: "object" },
  date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "YYYY-MM-DD" },
};
const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, ...(required.length ? { required } : {}) });

const SURFACES = join(process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.() ?? 1000}`, "talaris-surfaces.sock");
/**
 * The drawer showing a page or canvas told it changed, so it reads it again
 * (mcp-desktop.ts does the same). Best effort: no desktop running, nothing to tell.
 */
function told(kind: "page" | "canvas", project: string, where: string): Promise<void> {
  return new Promise((ok) => {
    const sock = createConnection(SURFACES);
    const done = () => { clearTimeout(timer); sock.destroy(); ok(); };
    const timer = setTimeout(done, 3000);
    sock.on("connect", () => sock.write(JSON.stringify({ do: "changed", kind, project, where }) + "\n"));
    sock.on("data", done);
    sock.on("error", done);
    sock.on("close", done);
  });
}

export function hermesTools(core: Core): HermesTool[] {
  // ---------------------------------------------------------- types, read through their profiles

  const allTypes = () => core<EntityType[]>("GET", "/entity-types");
  const typeOf = async (o: Entity) => (await allTypes()).find((t) => t.id === o.type);
  /** Where a type keeps its title: any profile's `title`, else `title`. */
  const titleKey = (t: EntityType | undefined) => {
    for (const p of Object.values(t?.profiles ?? {})) if (typeof p.title === "string") return p.title;
    return "title";
  };
  /** Where a type keeps its words: its note profile's body, else any profile's; null for none. */
  const bodyKey = (t: EntityType | undefined): string | null => {
    const note = t?.profiles?.note?.body;
    if (typeof note === "string") return note;
    for (const p of Object.values(t?.profiles ?? {})) if (typeof p.body === "string") return p.body;
    return null;
  };
  /** The type a plain note is: the one Talaris makes notes of, by its role, else by its note profile. */
  const noteType = (all: EntityType[]) =>
    all.find((t) => t["talaris:role"] === "note")
    ?? all.find((t) => t.profiles?.note && !t.profiles.journal && !t.profiles.task);
  const dayType = (all: EntityType[]) => all.find((t) => t.profiles?.journal);
  const kindWord = (kinds: string[]) =>
    kinds.includes("contact") ? "person" : kinds.includes("journal") ? "daily note" : ["task", "event", "project", "organization", "note"].find((k) => kinds.includes(k)) ?? "thing";

  // ---------------------------------------------------------- tasks: the profile's status

  const taskShape = async (): Promise<Shape> => {
    const t = await core<{ shape: Shape | null }>("GET", "/tasks/types");
    if (!t.shape) throw new Error("No type here declares the task profile, so there are no tasks.");
    return t.shape;
  };
  const statusLabels = (shape: Shape) =>
    (shape.type.fields.find((f) => f.key === shape.statusKey)?.["talaris:labels"] ?? {}) as Record<string, string>;
  /**
   * A status as asked: one the type offers (by value or its label, case and
   * spacing aside), or — for "completed", "finished" and the like — the first
   * of its complete values it offers. As Hermes' resolveStatus.
   */
  const resolveStatus = (shape: Shape, want: string): string | null => {
    const w = letters(want);
    const labels = statusLabels(shape);
    const options = shape.statuses.length ? shape.statuses : shape.complete;
    const hit = options.find((o) => letters(o) === w || letters(labels[o] ?? "") === w);
    if (hit) return hit;
    if (DONE_WORDS.has(w)) return shape.complete.find((v) => options.includes(v)) ?? null;
    return null;
  };
  /** One task as a line: `[status] Title — due …, from … · Projects (id)`, Hermes' shape. */
  const taskLine = (r: Row, asOf?: string) => {
    const bits: string[] = [];
    if (r.due) {
      const late = asOf ? !r.complete && r.due.slice(0, 10) < asOf : r.overdue;
      bits.push(`due ${fmtDate(r.due)}${late ? " OVERDUE" : ""}`);
    }
    if (r.start) bits.push(`from ${fmtDate(r.start)}`);
    if (r.recurring) bits.push("repeats");
    const projects = r.projects?.length ? ` · ${r.projects.map((p) => p.title).join(", ")}` : "";
    const tags = r.tags?.length ? ` ${r.tags.map((t) => `#${t}`).join(" ")}` : "";
    return `[${r.status || "—"}] ${r.title}${bits.length ? ` — ${bits.join(", ")}` : ""}${projects}${tags} (${r.id})`;
  };

  /** A task by id or (unique) title. */
  const resolveTask = async (ident: string): Promise<Read> => {
    const s = ident.trim();
    const byId = await core<Read>("GET", `/entities/${q(s)}`).catch(() => null);
    if (byId) {
      if (!byId.kinds.includes("task")) throw new Error(`${byId.title} [${s}] is a ${kindWord(byId.kinds)}, not a task.`);
      return byId;
    }
    const hits = await core<Summary[]>("GET", `/entities?q=${q(s)}&kind=task&limit=25`);
    const exact = hits.filter((h) => h.title.trim().toLowerCase() === s.toLowerCase());
    const pick = exact.length === 1 ? exact[0] : exact.length === 0 && hits.length === 1 ? hits[0] : undefined;
    if (!pick) {
      if (!hits.length) throw new Error(`No task matching "${ident}".`);
      throw new Error(`"${ident}" fits ${hits.length} tasks: ${hits.slice(0, 10).map((h) => `${h.title} (${h.id})`).join("; ")}. Give the id.`);
    }
    return core<Read>("GET", `/entities/${q(pick.id)}`);
  };

  // ---------------------------------------------------------- projects

  const resolveProject = (name: string) => core<ProjectMatch>("GET", `/projects/resolve?name=${q(name)}`);
  /** The entity tasks are filed under, by a project's name or either id; unknown, made when asked to (a folder and all, as Tasks makes one). */
  const projectEntity = async (name: string, orCreate = false): Promise<{ id: string; title: string }> => {
    const p = await resolveProject(name).catch((e: Error) => {
      if (!orCreate) throw e;
      return null;
    });
    if (p?.home) throw new Error("Home is not a project tasks are filed under: a task in no project is filed nowhere.");
    if (p?.entity) return { id: p.entity, title: p.name };
    if (p) throw new Error(`${p.name} has no tasks.`);
    const made = await core<{ id: string }>("POST", "/tasks/projects", { title: name.trim() });
    return { id: made.id, title: name.trim() };
  };

  // ---------------------------------------------------------- reading any entity

  /** A field's value as a reader sees it: a choice by its label, a reference by its title, a file by its name. */
  const fieldLines = (t: EntityType | undefined, props: Record<string, unknown>, skip: Set<string>, titles: Map<string, string>): string[] => {
    const out: string[] = [];
    for (const f of t?.fields ?? []) {
      if (skip.has(f.key)) continue;
      const v = props[f.key];
      const label = (typeof f.label === "string" && f.label.trim()) || f.key.replace(/_/g, " ");
      if (f.kind === "number") { out.push(`- ${label}: ${typeof v === "number" ? v : "-"}${typeof f.units === "string" ? ` ${f.units}` : ""}`); continue; }
      if (v === undefined || v === null || v === "" || (Array.isArray(v) && !v.length)) continue;
      const labels = (f["talaris:labels"] ?? {}) as Record<string, string>;
      const one = (x: unknown): string => {
        if (typeof x === "string") return f.kind === "reference" ? titles.get(x) ?? x : labels[x] ?? x;
        if (x && typeof x === "object" && (x as { kind?: string }).kind === "attachment") return String((x as { filename?: string }).filename ?? "file");
        return typeof x === "object" ? JSON.stringify(x) : String(x);
      };
      if (f.kind === "datespan" && v && typeof v === "object" && !Array.isArray(v)) {
        const span = v as { start?: string; end?: string };
        const parts = [span.start ? `${String(f.startLabel ?? "start")} ${fmtDate(span.start)}` : "", span.end ? `${String(f.endLabel ?? "end")} ${fmtDate(span.end)}` : ""].filter(Boolean);
        if (parts.length) out.push(`- ${label}: ${parts.join(", ")}`);
        continue;
      }
      out.push(`- ${label}: ${Array.isArray(v) ? v.map(one).join(", ") : one(v)}`);
    }
    // Everything its type does not declare, so nothing stored is hidden.
    const known = new Set([...(t?.fields ?? []).map((f) => f.key), ...skip]);
    for (const [k, v] of Object.entries(props)) {
      if (known.has(k) || v === null || v === undefined || v === "") continue;
      out.push(`- ${k}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`);
    }
    return out;
  };
  /** What a reference field points at, by title: the connections the core already names. */
  const refTitles = (r: Read) => new Map(r.out.map((c) => [c.entity.id, c.entity.title]));
  /** The lists that hold a thing by hand (or a matrix that placed it): a smart list's members are its rule's, not listed. */
  const listsHolding = async (id: string) => (await core<List[]>("GET", "/lists")).filter((l) => l.members.some((m) => m.object === id));
  /** Where an entity standing for a page or canvas points; null for any other. */
  const placeOf = (id: string) => core<{ kind: string; project: string; where: string }>("GET", `/entities/${q(id)}/place`).catch(() => null);

  /** A thing by id, or by title or words (the best match, an exact title first); a page or canvas with no entity yet is given one, as an @ does. */
  const resolveThing = async (ident: string): Promise<{ id: string; title: string }> => {
    const s = ident.trim();
    const byId = await core<Read>("GET", `/entities/${q(s)}`).catch(() => null);
    if (byId) return { id: byId.entity.id, title: byId.title };
    const hits = await core<Summary[]>("GET", `/entities?q=${q(s)}&limit=10`);
    const exact = hits.find((h) => h.title.trim().toLowerCase() === s.toLowerCase());
    if (exact) return exact;
    const places = await core<Mentionable[]>("GET", `/mentionables?q=${q(s)}&limit=10`).catch(() => [] as Mentionable[]);
    const place = places.find((m) => (m.kind === "page" || m.kind === "canvas") && m.title.trim().toLowerCase() === s.toLowerCase())
      ?? (hits.length ? null : places.find((m) => m.kind === "page" || m.kind === "canvas"));
    if (place) {
      if (place.id) return { id: place.id, title: place.title };
      const e = await core<{ id: string }>("POST", "/entities/place", { kind: place.kind, project: place.project, where: place.where, title: place.title });
      return { id: e.id, title: place.title };
    }
    if (hits[0]) return hits[0];
    throw new Error(`Nothing in Talaris matches "${ident}".`);
  };

  // ---------------------------------------------------------- collections: lists, and canvases

  type Found = { list: List } | { canvas: { project: string; projectName: string; node: CanvasNode } };
  /** Every canvas of every project in use, with where it is. */
  const allCanvases = async (only?: string) => {
    const projects = (await core<{ id: string; name: string }[]>("GET", "/projects")).filter((p) => !only || p.id === only);
    const out: { project: string; projectName: string; node: CanvasNode }[] = [];
    for (const p of projects) {
      const tree = await core<CanvasNode>("GET", `/projects/${p.id}/canvases`).catch(() => null);
      const walk = (n: CanvasNode) => { out.push({ project: p.id, projectName: p.name, node: n }); n.children.forEach(walk); };
      if (tree) walk(tree);
    }
    return out;
  };
  /** A collection by id or title: a list first (as Tasks names them), then a canvas. More than one canvas by a name is put back to choose. */
  const resolveCollection = async (ident: string, want?: "list" | "canvas"): Promise<Found> => {
    const s = ident.trim();
    const l = s.toLowerCase();
    if (want !== "canvas") {
      const lists = [...await core<List[]>("GET", "/lists"), ...await core<List[]>("GET", "/lists?archived=1")];
      const list = lists.find((x) => x.id === s) ?? lists.find((x) => x.name.toLowerCase() === l) ?? lists.find((x) => x.name.toLowerCase().includes(l));
      if (list) return { list };
      if (want === "list") throw new Error(`No list matching "${ident}". Lists: ${lists.map((x) => x.name).join(", ") || "none"}.`);
    }
    const canvases = await allCanvases();
    const byId = canvases.find((c) => c.node.id === s);
    if (byId) return { canvas: byId };
    const pick = (hits: typeof canvases) => {
      if (hits.length > 1) throw new Error(`${hits.length} canvases answer to "${ident}": ${hits.map((c) => `${c.node.title} in ${c.projectName} [${c.node.id}]`).join("; ")}. Give the id.`);
      return hits[0];
    };
    const hit = pick(canvases.filter((c) => c.node.title.toLowerCase() === l)) ?? pick(canvases.filter((c) => c.node.title.toLowerCase().includes(l)));
    if (hit) return { canvas: hit };
    throw new Error(`No ${want ?? "list or canvas"} matching "${ident}".`);
  };
  const resolveCanvas = async (ident: string) => {
    const f = await resolveCollection(ident, "canvas");
    if (!("canvas" in f)) throw new Error(`"${ident}" is a list, not a canvas.`);
    return f.canvas;
  };
  const canvasPath = (c: { project: string; node: { id: string } }) => `/projects/${c.project}/canvases/${c.node.id}`;
  const readDoc = (c: { project: string; node: { id: string } }) => core<CanvasDocument>("GET", canvasPath(c));
  const saveDoc = async (c: { project: string; node: { id: string } }, doc: CanvasDocument) => {
    await core("PUT", canvasPath(c), doc);
    await told("canvas", c.project, c.node.id);
  };
  const isNote = (i: CanvasItem) => !i.kind || i.kind === "note";
  const itemLabel = (i: CanvasItem) => (isNote(i) ? String(i.text ?? "").replace(/\s+/g, " ").trim() : String(i.seen?.title ?? i.entity ?? i.canvas ?? i.id));
  /** Something on a canvas, by its item id, the entity a card shows, a card's title, or a fragment of a note's words. */
  const canvasItem = (doc: CanvasDocument, ref: string): CanvasItem => {
    const r = ref.trim();
    const l = r.toLowerCase();
    const items = doc.items.filter((i) => i.kind !== "ink");
    const hit = items.find((i) => i.id === r) ?? items.find((i) => i.entity === r) ?? items.find((i) => i.canvas === r)
      ?? items.find((i) => itemLabel(i).toLowerCase() === l) ?? items.find((i) => itemLabel(i).toLowerCase().includes(l));
    if (!hit) throw new Error(`Nothing on "${doc.title}" matches "${ref}". Read it with collection_members first — notes are matched by their words, cards by their title or id.`);
    return hit;
  };
  /** A card's size by what it shows, as the canvas draws them (mcp-desktop.ts). */
  const cardFor = async (entity: string, at: { x: number; y: number }, fill?: string): Promise<CanvasItem> => {
    const e = await core<Read>("GET", `/entities/${q(entity)}`);
    const kind = ["task", "event", "contact", "note"].find((k) => e.kinds.includes(k)) ?? "note";
    const h = kind === "task" ? 72 : kind === "event" ? 96 : kind === "contact" ? 76 : 110;
    return { id: `i${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`, kind: "card", entity: e.entity.id, ...at, w: 240, h, seen: { title: e.title, kind }, ...(fill ? { fill } : {}) };
  };
  /** Cells for a layout: Hermes' grid, row or column, cards 240 wide. */
  const cells = (n: number, layout: string, origin: { x: number; y: number }) => {
    const cols = layout === "row" ? n : layout === "column" ? 1 : Math.max(1, Math.ceil(Math.sqrt(n)));
    return (i: number) => ({ x: origin.x + (i % cols) * 300, y: origin.y + Math.floor(i / cols) * 170 });
  };
  const rightOf = (doc: CanvasDocument) => {
    const items = doc.items;
    return items.length ? { x: Math.max(...items.map((i) => i.x + i.w)) + 60, y: Math.min(...items.map((i) => i.y)) } : { x: 0, y: 0 };
  };
  const checkColor = (c: unknown): string | undefined => {
    const s = str(c).trim();
    if (!s) return undefined;
    if (!SAFE_COLOR.test(s)) throw new Error(`"${s}" is not a color Talaris draws: give a hex value like #f97316, or a color's name.`);
    return s;
  };

  /** A canvas in words: its cards, its notes, the canvases on it, and the lines between them. */
  const describeCanvas = (doc: CanvasDocument, c: { projectName: string; node: CanvasNode }) => {
    const cards = doc.items.filter((i) => i.kind === "card");
    const notes = doc.items.filter(isNote);
    const kids = doc.items.filter((i) => i.kind === "canvas" || i.kind === "canvas-link");
    const ink = doc.items.filter((i) => i.kind === "ink").length;
    const out: string[] = [`Canvas "${doc.title}" in ${c.projectName} [${doc.id}]`];
    if (cards.length) out.push("", `Cards (${cards.length}):`, ...cards.map((i) => `- ${i.seen?.title ?? i.entity} (${i.seen?.kind ?? "entity"}) at ${Math.round(i.x)},${Math.round(i.y)} [${i.entity}]`));
    if (notes.length) out.push("", "Sticky notes (canvas-only, not entities):", ...notes.map((i) => `- "${itemLabel(i).slice(0, 120)}" [${i.id}]`));
    if (kids.length) out.push("", "Canvases on it:", ...kids.map((i) => `- ${i.seen?.title ?? i.canvas} (${i.kind === "canvas" ? "inside this one" : "a link"}) [${i.canvas}]`));
    if (ink) out.push("", `Ink: ${plural(ink, "pen stroke")}.`);
    if (doc.links.length) {
      const name = (id: string) => { const i = doc.items.find((x) => x.id === id); return i ? (isNote(i) ? `note "${itemLabel(i).slice(0, 40)}"` : itemLabel(i)) : id; };
      out.push("", "Connections:", ...doc.links.map((l) => `- ${name(l.from)} → ${name(l.to)}${typeof l.style === "string" && l.style !== "solid" ? ` (${l.style})` : ""} [${l.id}]`));
    }
    if (out.length === 1) out.push("Nothing on it yet.");
    return out.join("\n");
  };

  const regionsOf = (l: List): Region[] => (l.placement?.regions ?? []).map((r) => (typeof r === "string" ? { name: r } : r));
  const findRegion = (l: List, want: string): Region => {
    const w = want.trim().toLowerCase();
    const all = regionsOf(l);
    const hit = all.find((r) => r.name.toLowerCase() === w || (r.label ?? "").toLowerCase() === w)
      ?? all.find((r) => r.name.toLowerCase().includes(w) || (r.label ?? "").toLowerCase().includes(w));
    if (!hit) throw new Error(`No region "${want}" in "${l.name}". Regions: ${all.map((r) => r.label ?? r.name).join(", ") || "none"}.`);
    return hit;
  };
  const listKindWord = (l: List) => `${l.membership.mode === "query" ? "smart " : ""}${l.kind}`;

  // ---------------------------------------------------------- the calendar

  interface CalItem { start: number; allDay: boolean; title: string; location: string; source: string; id?: string }
  const fmtTime = (ms: number) => new Date(ms).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  /**
   * A range's events: Talaris's own calendar (and any a plugin brings) and the
   * accounts' calendars as a desktop shared them. What could not be read is
   * said, never dropped: "no events" and "could not look" are opposite facts.
   */
  const gatherCalendar = async (start: string, end: string): Promise<{ events: CalItem[]; warning: string | null }> => {
    const from = new Date(`${start}T00:00:00`).getTime();
    const to = new Date(`${nextDay(end)}T00:00:00`).getTime();
    let warning: string | null = null;
    const [own, cals, view, taken] = await Promise.all([
      core<Record<string, unknown>[]>("GET", `/plugins/calendars/events?from=${from}&to=${to}`).catch((e: Error) => { warning = `Talaris's own calendar could not be read (${e.message})`; return []; }),
      core<{ id: string; name: string }[]>("GET", "/plugins/calendars").catch(() => []),
      core<{ calendars: { id: string; name: string }[]; items: Record<string, unknown>[]; at: string; covers: { from: number; to: number } | null }>("GET", `/calendar/view?from=${from}&to=${to}`)
        .catch((e: Error) => { warning = `the accounts' calendars could not be read (${e.message})`; return null; }),
      core<string[]>("GET", "/plugins/calendars/taken").catch(() => [] as string[]),
    ]);
    const names = new Map([...cals, ...(view?.calendars ?? [])].map((c) => [c.id, c.name]));
    const events: CalItem[] = own.map((e) => ({
      start: Number(e.start), allDay: Boolean(e.allDay), title: str(e.title) || "Untitled", location: str(e.location),
      source: names.get(str(e.calendar)) ?? str(e.calendar), ...(str(e.entity) ? { id: str(e.entity) } : {}),
    }));
    if (view && !view.covers && !view.calendars.length) {
      // No desktop has shared its accounts' calendars here: there may be none to share. Said, not guessed.
      warning = warning ?? "no accounts' calendars have been shared with Talaris here, so only Talaris's own calendar is shown";
    } else if (view?.covers && (view.covers.from > from || view.covers.to < to)) {
      warning = warning ?? `the accounts' calendars were shared only for ${localDate(new Date(view.covers.from))} to ${localDate(new Date(view.covers.to))}, so events outside that are MISSING`;
    }
    const gone = new Set(taken);
    for (const e of view?.items ?? []) {
      const key = `${str(e.uid)}/${str(e.rid)}`;
      if (gone.has(`${str(e.calendar)}/${key}`) || gone.has(`*/${key}`)) continue;
      events.push({ start: Number(e.start), allDay: Boolean(e.allDay), title: str(e.title) || "Untitled", location: str(e.location), source: names.get(str(e.calendar)) ?? "calendar" });
    }
    events.sort((a, b) => a.start - b.start);
    return { events, warning };
  };
  const eventLine = (e: CalItem, withDate: boolean) =>
    `- ${withDate ? `${localDate(new Date(e.start))} ` : ""}${e.allDay ? "all day" : fmtTime(e.start)} — ${e.title}${e.location ? ` @ ${e.location}` : ""} [${e.source}]${e.id ? ` (${e.id})` : ""}`;

  // ---------------------------------------------------------- daily notes: Home's Daily pages

  const home = async () => {
    const h = await resolveProject("home");
    if (!h.id) throw new Error("Talaris has no Home project");
    return h.id;
  };
  const dayPath = (date: string) => `Daily/${date}`;
  const readDay = async (date: string) => {
    const h = await home();
    const text = await core<string>("GET", `/projects/${h}/page?path=${q(dayPath(date))}`).then((t) => (typeof t === "string" ? t : ""), () => null);
    const e = await core<Entity>("GET", `/entities/by-source?kind=page&key=${q(`${h}/${dayPath(date)}`)}`).catch(() => null);
    return { home: h, text, id: e?.id ?? null };
  };

  // ---------------------------------------------------------- tags

  /** Every spelling of a tag in use (Talaris keeps the case it was first written in), and what carries each. */
  const carrying = async (tag: string) => {
    const want = tagOf(tag).toLowerCase();
    const spellings = (await core<{ tag: string }[]>("GET", "/tags")).map((t) => t.tag).filter((t) => t.toLowerCase() === want);
    const things = new Map<string, { id: string; title: string; tags: string[]; page?: { project: string; path: string }; file?: unknown }>();
    for (const s of spellings) for (const t of await core<{ id: string; title: string; tags: string[]; page?: { project: string; path: string }; file?: unknown }[]>("GET", `/tags/things?tag=${q(s)}`)) things.set(t.id, t);
    return [...things.values()];
  };
  const setTags = async (t: { id: string; file?: unknown }, tags: string[]) => {
    // A file's through the Library's own write, which tells the Library it changed.
    if (t.file) await core("PUT", "/files/tags", { entity: t.id, tags });
    else await core("PATCH", `/entities/${q(t.id)}`, { tags });
  };
  /** `#old` written in a page's words, as tags.ts reads them (after a space or a line's start, not in code). */
  const inlineTag = (tag: string) => new RegExp(`(^|[\\s(\\[{>])#${tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}_\\-/])`, "giu");
  const outsideCode = (text: string, fn: (prose: string) => string) =>
    text.split(/(```[\s\S]*?```|`[^`\n]*`)/g).map((part, i) => (i % 2 ? part : fn(part))).join("");

  // ---------------------------------------------------------- an entity's write, through the live binding

  /**
   * A partial write as the binding does it (interchange.ts, patchObject): what
   * is set is set, what is unset goes, everything else — known or not — stays;
   * a daily note's or a note's words go to its page, a project's title renames
   * its folder. Its answer is the format's: ok, fidelity, reports.
   */
  const patchObject = async (id: string, patch: Record<string, unknown>) => {
    try {
      return await core<{ ok: boolean; fidelity: string; reports: string[] }>("PATCH", `/interchange/objects/${q(id)}`, patch);
    } catch (e) {
      // A refusal (a stale version, a tag both added and removed) is the binding's answer too, not a failure to reach it.
      try { return JSON.parse((e as Error).message) as { ok: boolean; fidelity: string; reports: string[] }; } catch { throw e; }
    }
  };

  // ============================================================ the tools

  const tools: HermesTool[] = [];
  const tool = (name: string, title: string, readOnly: boolean, description: string, inputSchema: Record<string, unknown>, run: HermesTool["run"], destructive = false) =>
    tools.push({ name, description, inputSchema, annotations: { readOnlyHint: readOnly, title, ...(destructive ? { destructiveHint: true } : {}) }, run });

  // ---------------------------------------------------------- tasks

  tool("task_create", "Create a task", false,
    "Create a task. Dates are YYYY-MM-DD (optionally with THH:mm). status is one of the task statuses (completed/finished land on whichever means done). project/projects accept a project title or id — unknown names create the project (a Talaris project, folder and desktop, as Tasks makes one). Tags are created as needed. (Hermes also made people from raw @Name mentions; Talaris does not — mention someone with talaris_tie or the editor's @.)",
    obj({ title: SCHEMA.s, notes: SCHEMA.s, available_date: SCHEMA.s, due_date: SCHEMA.s, start: SCHEMA.s, due: SCHEMA.s, status: SCHEMA.s, project: SCHEMA.s, projects: SCHEMA.ss, tags: SCHEMA.ss }, ["title"]),
    async (a) => {
      const title = str(a.title).trim();
      if (!title) throw new Error("A task needs a title.");
      let status: string | undefined;
      if (a.status) {
        const shape = await taskShape();
        status = resolveStatus(shape, str(a.status)) ?? undefined;
        if (!status) throw new Error(`Unknown status "${str(a.status)}". Options: ${shape.statuses.join(", ")}`);
      }
      const projects: string[] = [];
      for (const p of [...strs(a.projects), ...strs(a.project)]) projects.push((await projectEntity(p, true)).id);
      const t = await core<{ id: string }>("POST", "/tasks", {
        title, description: str(a.notes) || undefined,
        start: str(a.available_date) || str(a.start) || undefined, due: str(a.due_date) || str(a.due) || undefined,
        status, projects, tags: strs(a.tags).map(tagOf).filter(Boolean),
      });
      return `Created task "${title}" (${t.id}).`;
    });

  tool("task_find", "Find tasks", true,
    "List/search tasks. All params optional and composable. status takes one of the task statuses, or \"open\" for everything unfinished, or \"complete\" (comma-separated for several); when: overdue|today|tomorrow|week|available|unscheduled, or a date as YYYY-MM-DD for what is due by that day; term: text search; tag/tags; project: title or id; list: a list's title or id (from list_lists); region: a matrix region (or board column) title within that list (e.g. \"Do\").",
    obj({ status: SCHEMA.s, when: SCHEMA.s, term: SCHEMA.s, tag: SCHEMA.s, tags: SCHEMA.ss, project: SCHEMA.s, list: SCHEMA.s, region: SCHEMA.s, limit: { type: "integer", minimum: 1, maximum: 200 } }),
    async (a) => {
      const limit = Math.min(200, Math.max(1, Number(a.limit) || 50));
      const params = new URLSearchParams();
      if (a.status) {
        const wanted = str(a.status).split(",").map((s) => s.trim()).filter(Boolean);
        if (wanted.length === 1 && (wanted[0] === "open" || wanted[0] === "complete")) params.set("status", wanted[0]);
        else {
          const shape = await taskShape();
          params.set("status", wanted.map((s) => {
            const r = resolveStatus(shape, s);
            if (!r) throw new Error(`Unknown status "${s}". Options: open, complete, ${shape.statuses.join(", ")}`);
            return r;
          }).join(","));
        }
      }
      if (a.when) params.set("when", str(a.when).trim());
      if (a.term) params.set("text", str(a.term));
      const tags = [...strs(a.tags), ...strs(a.tag)].map(tagOf).filter(Boolean);
      if (tags[0]) params.set("tag", tags[0]);
      if (a.project) params.set("project", (await projectEntity(str(a.project))).id);
      let scope = "";
      let inRegion: Set<string> | null = null;
      if (a.list) {
        const f = await resolveCollection(str(a.list), "list");
        if (!("list" in f)) throw new Error("not a list");
        params.set("list", f.list.id);
        scope = f.list.name;
        if (a.region) {
          if (f.list.kind !== "matrix" && !f.list["talaris:bind"]) throw new Error(`"${scope}" is not a matrix or a board — region only applies to those.`);
          const r = findRegion(f.list, str(a.region));
          const shown = await core<Shown>("GET", `/lists/${q(f.list.id)}`);
          inRegion = new Set(shown.rows.filter((x) => x.region === r.name).map((x) => x.id));
          scope += ` › ${r.label ?? r.name}`;
        }
      } else if (a.region) throw new Error("region requires list (the matrix to look in).");
      params.set("limit", "5000");
      let rows = await core<Row[]>("GET", `/tasks/find?${params}`);
      // The core takes one tag; any more are each required, as Hermes' were.
      const more = tags.slice(1).map((t) => t.toLowerCase());
      if (more.length) rows = rows.filter((r) => more.every((t) => (r.tags ?? []).some((x) => x.toLowerCase() === t)));
      if (inRegion) rows = rows.filter((r) => inRegion!.has(r.id));
      if (!rows.length) return scope ? `No matching tasks in "${scope}".` : "No matching tasks.";
      const shown = rows.slice(0, limit).map((r) => taskLine(r));
      // Today said with them, as talaris_tasks does: due dates are read against it, not a day the model supposes.
      const today = new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
      return `Today is ${today} (${localDate()}).\n` + shown.join("\n") + (rows.length > limit ? `\n…and ${rows.length - limit} more (raise limit to see them).` : "");
    });

  tool("task_info", "A task's details", true,
    "Get full details for one task by id or (unique) title: status, available/due, projects, repeats, tags, lists, every other field, and its notes. Prefer this over block_get for tasks.",
    obj({ task: SCHEMA.s }, ["task"]),
    async (a) => {
      const shape = await taskShape();
      const r = await resolveTask(str(a.task));
      const id = r.entity.id;
      const [row] = (await core<Row[]>("GET", `/tasks/find?text=${q(r.title)}&limit=5000`)).filter((x) => x.id === id);
      const t = await typeOf(r.entity);
      const p = r.entity.properties;
      const status = String(p[shape.statusKey] ?? "");
      const label = statusLabels(shape)[status];
      const recur = await core<{ summary: string }>("GET", `/tasks/${q(id)}/recurrence`).catch(() => ({ summary: "" }));
      const lists = await listsHolding(id);
      const out = [
        `Task: ${r.title}${r.entity.archived ? " (archived)" : ""}`,
        `Id: ${id}`,
        `Status: ${status || "—"}${label && label !== status ? ` (${label})` : ""}`,
        row?.projects?.length ? `Projects: ${row.projects.map((x) => x.title).join(", ")}` : null,
        row?.start ? `Available: ${fmtDate(row.start)}` : null,
        row?.due ? `Due: ${fmtDate(row.due)}${row.overdue ? " OVERDUE" : ""}` : null,
        recur.summary ? `Repeats: ${recur.summary}` : null,
        r.entity.tags?.length ? `Tags: ${r.entity.tags.map((x) => `#${x}`).join(" ")}` : null,
        lists.length ? `Collections: ${lists.map((l) => l.name).join(", ")}` : null,
      ].filter((x): x is string => Boolean(x));
      // What this already said in task terms is not said twice; everything else its type has, and anything it does not declare, is.
      const profile = t?.profiles?.task ?? {};
      const slot = (v: unknown) => (typeof v === "string" ? v : v && typeof v === "object" ? str((v as { field?: unknown }).field) : "");
      const said = new Set([titleKey(t), shape.statusKey, slot(profile.start), slot(profile.due), str(profile.project), str(profile.body)].filter(Boolean));
      const rest = fieldLines(t, p, said, refTitles(r));
      if (rest.length) out.push("", "Fields:", ...rest);
      const notes = typeof profile.body === "string" ? p[profile.body] : r.entity.content;
      if (typeof notes === "string" && notes.trim()) out.push("", `Notes:\n${notes}`);
      return out.join("\n");
    });

  tool("task_update", "Update a task", false,
    "Update a task by id or title. Only supplied fields change. status is one of the task statuses; case and spacing don't matter, and \"completed\"/\"finished\" land on whichever of them means done (completing one that repeats brings its next). Empty string clears a date. add/remove_tags and add/remove_projects adjust without replacing; unknown project names are created (a Talaris project, as Tasks makes one), new tags too.",
    obj({ task: SCHEMA.s, title: SCHEMA.s, notes: SCHEMA.s, status: SCHEMA.s, available_date: SCHEMA.s, due_date: SCHEMA.s, start: SCHEMA.s, due: SCHEMA.s,
      add_tags: SCHEMA.ss, remove_tags: SCHEMA.ss, add_projects: SCHEMA.ss, remove_projects: SCHEMA.ss }, ["task"]),
    async (a) => {
      const r = await resolveTask(str(a.task));
      const opt = (v: unknown) => (typeof v === "string" ? v : undefined);
      const changed: string[] = [];
      const patch: Record<string, unknown> = {};
      if (opt(a.title) !== undefined) { patch.title = a.title; changed.push("title"); }
      if (opt(a.notes) !== undefined) { patch.body = a.notes; changed.push("notes"); }
      if (opt(a.status) !== undefined) {
        const shape = await taskShape();
        const s = resolveStatus(shape, str(a.status));
        if (!s) throw new Error(`Unknown status "${str(a.status)}". Options: ${shape.statuses.join(", ")}`);
        patch.status = s;
        changed.push(`status → ${s}`);
      }
      const start = opt(a.available_date) ?? opt(a.start), due = opt(a.due_date) ?? opt(a.due);
      if (start !== undefined) patch.start = start;
      if (due !== undefined) patch.due = due;
      if (start !== undefined || due !== undefined) changed.push("schedule");
      const add = [], drop = [];
      for (const n of strs(a.add_projects)) add.push((await projectEntity(n, true)).id);
      for (const n of strs(a.remove_projects)) drop.push((await projectEntity(n)).id);
      if (add.length || drop.length) { patch.addProjects = add; patch.removeProjects = drop; changed.push("projects"); }
      const addTags = strs(a.add_tags).map(tagOf).filter(Boolean), removeTags = strs(a.remove_tags).map(tagOf).filter(Boolean);
      if (addTags.length || removeTags.length) { patch.addTags = addTags; patch.removeTags = removeTags; changed.push("tags"); }
      if (!changed.length) return "Nothing to change.";
      await core("PATCH", `/tasks/${q(r.entity.id)}`, patch);
      return `Updated ${r.title}: ${changed.join(", ")}.`;
    });

  tool("task_archive", "Archive a task", false,
    "Archive a task (id or title): hide it from every normal view and query. Reversible — it comes back as it was on block_unarchive. There is no delete tool; only the user deletes.",
    obj({ task: SCHEMA.s }, ["task"]),
    async (a) => {
      const r = await resolveTask(str(a.task));
      await core("PATCH", `/entities/${q(r.entity.id)}`, { archived: true });
      return `Archived "${r.title}" [${r.entity.id}].`;
    });

  // ---------------------------------------------------------- projects

  const projectLines = async (archived: boolean) => {
    const all = (await core<TaskProject[]>("GET", "/tasks/projects")).filter((p) => Boolean(p.archived) === archived);
    if (!all.length) return archived ? "No archived projects." : "No active projects.";
    const counts = archived ? {} : await core<Record<string, number>>("GET", "/tasks/open-counts").catch(() => ({} as Record<string, number>));
    return all.map((p) => `${p.title}${archived ? "" : ` — ${plural(counts[p.id] ?? 0, "open task")}`} (${p.id})`).join("\n");
  };
  tool("project_list", "List projects", true, "List active (non-archived) projects with open-task counts.", obj({}), () => projectLines(false));
  tool("project_archived", "List archived projects", true, "List archived projects.", obj({}), () => projectLines(true));

  tool("project_info", "A project's details", true,
    "Get a project's details and its tasks, by id or title. Also says its Talaris project id, for the talaris_ tools that open its pages and canvases.",
    obj({ project: SCHEMA.s }, ["project"]),
    async (a) => {
      const m = await resolveProject(str(a.project));
      if (m.home) return `Project: ${m.name} (Home)\nTalaris project: ${m.id}\n\nHome is where the pages of no other project are; no tasks are filed under it.`;
      if (!m.entity) return `Project: ${m.name}\nTalaris project: ${m.id}\n\nIt has no tasks.`;
      const r = await core<Read>("GET", `/entities/${q(m.entity)}`);
      const t = await typeOf(r.entity);
      const about = bodyKey(t);
      const out = [`Project: ${r.title}${r.entity.archived || m.archived ? " (archived)" : ""}`, `Id: ${m.entity}`, ...(m.id ? [`Talaris project: ${m.id}${m.code ? ` (${m.code})` : ""}`] : [])];
      const rest = fieldLines(t, r.entity.properties, new Set([titleKey(t), ...(about ? [about] : [])]), refTitles(r));
      if (rest.length) out.push("", "Fields:", ...rest);
      const words = about ? r.entity.properties[about] : undefined;
      if (typeof words === "string" && words.trim()) out.push("", `About:\n${words}`);
      const [open, done] = await Promise.all([
        core<Row[]>("GET", `/tasks/find?project=${q(m.entity)}&status=open&limit=5000`),
        core<Row[]>("GET", `/tasks/find?project=${q(m.entity)}&status=complete&limit=5000`),
      ]);
      // Each task's line without its projects: they would all say this one.
      const line = (x: Row) => taskLine({ ...x, projects: x.projects?.filter((p) => p.id !== m.entity) });
      if (open.length) out.push("", "Open tasks:", ...open.map(line));
      if (done.length) out.push("", "Completed tasks:", ...done.map(line));
      if (!open.length && !done.length) out.push("", "No tasks.");
      return out.join("\n");
    });

  tool("project_create", "Create a project", false,
    "Create a project. In Talaris a project is a folder and a desktop as well as what tasks are filed under — made as Tasks makes one.",
    obj({ title: SCHEMA.s, description: SCHEMA.s }, ["title"]),
    async (a) => {
      const title = str(a.title).trim();
      if (!title) throw new Error("A project needs a title.");
      const made = await core<Entity>("POST", "/tasks/projects", { title });
      if (str(a.description)) {
        const key = bodyKey(await typeOf(made));
        if (!key) throw new Error(`Created project "${title}" (${made.id}), but its type keeps no description, so the description was not written.`);
        await core("PATCH", `/entities/${q(made.id)}`, { properties: { [key]: str(a.description) } });
      }
      return `Created project "${title}" (${made.id}).`;
    });

  const setArchived = async (ident: string, archived: boolean, confirm: unknown) => {
    const m = await resolveProject(ident);
    if (m.home) throw new Error("Home cannot be archived.");
    if (!m.entity) throw new Error(`${m.name} has no project entity to archive; archive it from the desktop (talaris_archive_project).`);
    const verb = archived ? "archive" : "unarchive";
    if (confirm !== true) return `This will ${verb} "${m.name}"${archived ? " — its folder goes to the archive, and tasks filed only under it go with it" : ""}. Call again with confirm=true.`;
    // The core's own archive: the project's folder and the tasks filed only under it, as Tasks' Archive does (server.ts, PATCH /entities).
    await core("PATCH", `/entities/${q(m.entity)}`, { archived });
    return `${archived ? "Archived" : "Unarchived"} "${m.name}".`;
  };
  tool("project_archive", "Archive a project", false,
    "Archive a project: in Talaris its folder goes to the archive and the tasks filed only under it are archived with it; it comes back whole with project_unarchive. Two-step confirm.",
    obj({ project: SCHEMA.s, confirm: SCHEMA.b }, ["project"]), (a) => setArchived(str(a.project), true, a.confirm));
  tool("project_unarchive", "Unarchive a project", false,
    "Unarchive a project: its folder and what was archived with it come back. Refused if a project of that name is in use (bring it back from the archive browser to keep both or merge). Two-step confirm.",
    obj({ project: SCHEMA.s, confirm: SCHEMA.b }, ["project"]), (a) => setArchived(str(a.project), false, a.confirm));

  // ---------------------------------------------------------- lists and tags

  tool("list_lists", "List collections", true,
    "List the saved collections: Tasks' lists, boards and matrices (usable as task_find's `list` param), then every project's canvases. Hermes' document/masonry kinds have no counterpart in Talaris.",
    obj({}),
    async () => {
      const [lists, canvases] = await Promise.all([core<List[]>("GET", "/lists"), allCanvases()]);
      const out = lists.map((l) => `${l.name} — ${listKindWord(l)} (${l.id})`);
      if (canvases.length) out.push("", "Canvases:", ...canvases.map((c) => `${c.node.title} — canvas in ${c.projectName}${c.node.empty ? ", empty" : ""} (${c.node.id})`));
      return out.length ? out.join("\n") : "No collections.";
    });

  tool("tag_list", "List tags", true, "List all tags, each with how many things carry it.", obj({}), async () => {
    const tags = await core<{ tag: string; count: number }[]>("GET", "/tags");
    return tags.length ? tags.map((t) => `#${t.tag} (${t.count})`).join("\n") : "No tags.";
  });

  tool("tag_rename", "Rename a tag", false,
    "Rename a tag on everything that has it — tasks, people, pages, files — and in the words of the pages that write it as #tag. Two-step confirm.",
    obj({ old_tag: SCHEMA.s, new_tag: SCHEMA.s, confirm: SCHEMA.b }, ["old_tag", "new_tag"]),
    async (a) => {
      const from = tagOf(str(a.old_tag)), to = tagOf(str(a.new_tag));
      if (!from || !to) throw new Error("Name both tags.");
      if (a.confirm !== true) return `This will rename #${from} → #${to} everywhere. Call again with confirm=true.`;
      const things = await carrying(from);
      let rewritten = 0;
      for (const t of things) {
        // Written in a page's words, it is rewritten there first — a page's words put back any tag they still write (tags.ts, addInlineTags).
        if (t.page) {
          const path = `/projects/${t.page.project}/page?path=${q(t.page.path)}`;
          const text = await core<string>("GET", path).then((x) => (typeof x === "string" ? x : ""), () => "");
          const next = outsideCode(text, (prose) => prose.replace(inlineTag(from), `$1#${to}`));
          if (next !== text) { await core("PUT", path, next); await told("page", t.page.project, t.page.path); rewritten++; }
        }
        const kept = t.tags.filter((x) => x.toLowerCase() !== from.toLowerCase());
        await setTags(t, kept.some((x) => x.toLowerCase() === to.toLowerCase()) ? kept : [...kept, to]);
      }
      return `Renamed #${from} → #${to} on ${plural(things.length, "thing")} (text mentions rewritten in ${plural(rewritten, "page")}).`;
    });

  tool("tag_delete", "Delete a tag", false,
    "Remove a tag from everything that has it. A page whose words write #tag keeps those words, and gets the tag back the next time it is saved; the answer counts them. Two-step confirm.",
    obj({ tag: SCHEMA.s, confirm: SCHEMA.b }, ["tag"]),
    async (a) => {
      const t = tagOf(str(a.tag));
      if (!t) throw new Error("Name a tag.");
      if (a.confirm !== true) return `This will remove #${t} from everything. Call again with confirm=true.`;
      const things = await carrying(t);
      let written = 0;
      for (const x of things) {
        await setTags(x, x.tags.filter((y) => y.toLowerCase() !== t.toLowerCase()));
        if (x.page) {
          const text = await core<string>("GET", `/projects/${x.page.project}/page?path=${q(x.page.path)}`).then((y) => (typeof y === "string" ? y : ""), () => "");
          let hit = false;
          outsideCode(text, (prose) => { if (inlineTag(t).test(prose)) hit = true; return prose; });
          if (hit) written++;
        }
      }
      return `Removed #${t} from ${plural(things.length, "thing")}.${written ? ` ${plural(written, "page")} still ${written === 1 ? "writes" : "write"} #${t} in ${written === 1 ? "its" : "their"} words, so it comes back when they are next saved unless those words change.` : ""}`;
    }, true);

  // ---------------------------------------------------------- search and reading

  tool("search", "Search everything", true,
    "Search EVERYTHING — people, tasks, events, projects, pages (notes), canvases, files and lists — by literal match on titles and words, plus meaning (when search by meaning is on), like the launcher's search. Use this for requests like \"find my note about X\". Returns ids for block_get; a page with no id yet says its project and path.",
    obj({ query: SCHEMA.s }, ["query"]),
    async (a) => {
      const words = str(a.query).trim();
      if (!words) throw new Error("Search for what?");
      const [ents, places, near, lists] = await Promise.all([
        core<Summary[]>("GET", `/entities?q=${q(words)}&limit=25`),
        core<Mentionable[]>("GET", `/mentionables?q=${q(words)}&limit=40`).catch(() => [] as Mentionable[]),
        core<Meaning[]>("GET", `/meaning?q=${q(words)}&limit=10`).catch(() => [] as Meaning[]),
        core<List[]>("GET", "/lists"),
      ]);
      const seen = new Set<string>();
      const passage = new Map<string, string>();
      for (const m of near) passage.set(m.id ?? m.key, m.passage);
      const out: string[] = [];
      const excerpt = (k: string) => (passage.get(k) ? `\n  ${passage.get(k)}` : "");
      for (const e of ents) { seen.add(e.id); out.push(`- ${e.title} — ${kindWord(e.kinds)} [${e.id}]${excerpt(e.id)}`); }
      for (const p of places) {
        if (p.kind !== "page" && p.kind !== "canvas") continue;
        const key = p.id || `${p.kind}:${p.project}/${p.where}`;
        const placeKey = `${p.kind}:${p.project}/${p.where}`;
        const dup = seen.has(key);
        // Known by where it is as well, so meaning's hit on the same page is not said twice.
        seen.add(key).add(placeKey);
        if (dup) continue;
        const where = p.kind === "page" ? `page in ${p.projectName ?? p.project} (path: ${p.where})` : `canvas in ${p.projectName ?? p.project} (${p.where})`;
        out.push(`- ${p.title} — ${where}${p.id ? ` [${p.id}]` : ""}${excerpt(p.id || `page:${p.project}/${p.where}`)}`);
      }
      const l = words.toLowerCase();
      for (const x of lists.filter((x) => x.name.toLowerCase().includes(l))) out.push(`- ${x.name} — ${listKindWord(x)} [${x.id}]`);
      for (const m of near) {
        const id = m.id ?? "";
        if ((id && seen.has(id)) || seen.has(m.key)) continue;
        seen.add(id || m.key);
        const what = m.kind === "page" ? `page in project ${m.project} (path: ${m.path})` : m.kind === "file" ? `file — read it with talaris_file_read, key ${m.key.startsWith("file:p:") ? `file:${m.key.slice(7)}` : `att:${m.key.slice(5)}`}` : m.kind;
        out.push(`- ${m.title} — ${what} (semantic match)${id ? ` [${id}]` : ""}\n  ${m.passage}`);
      }
      if (!out.length) return "No matches.";
      return out.join("\n")
        + "\n\nEach excerpt is only a few lines of what the result holds. Before using what one holds (to answer from it, or to build on it), read it whole with block_get.";
    });

  tool("block_get", "Read anything", true,
    "Read one thing by id (from search): an entity (a note, task, person, event, project…) with its words, fields, tags and the lists holding it; a list with its members; a canvas with what is on it. Pass as:\"interchange\" to get the pkm-interchange object instead of prose.",
    obj({ id: SCHEMA.s, as: { type: "string", enum: ["prose", "interchange"] } }, ["id"]),
    async (a) => {
      const id = str(a.id).trim();
      const r = await core<Read>("GET", `/entities/${q(id)}`).catch(() => null);
      if (!r) {
        const f = await resolveCollection(id).catch(() => null);
        if (f && "list" in f && f.list.id === id) {
          if (a.as === "interchange") return JSON.stringify(f.list, null, 2);
          const shown = await core<Shown>("GET", `/lists/${q(id)}`);
          return [`# ${f.list.name}`, `Collection (${listKindWord(f.list)}) [${id}]`, `Members (${shown.rows.length}):`, ...shown.rows.map((x) => `- ${x.title} [${x.id}]`)].join("\n");
        }
        if (f && "canvas" in f && f.canvas.node.id === id) {
          const doc = await readDoc(f.canvas);
          return a.as === "interchange" ? JSON.stringify(doc, null, 2) : describeCanvas(doc, f.canvas);
        }
        throw new Error(`Nothing in Talaris has the id ${id}. Find it with search first.`);
      }
      if (a.as === "interchange") return JSON.stringify(r.entity, null, 2);
      const t = await typeOf(r.entity);
      const body = bodyKey(t);
      const lines = [`# ${r.title}`, `${t?.name ?? kindWord(r.kinds)} [${r.entity.id}]${r.entity.archived ? " (archived)" : ""} created ${fmtDate(r.entity.created.slice(0, 16))}, edited ${fmtDate(r.entity.updated.slice(0, 16))}`];
      // A page's words are its file's (the entity only stands for it).
      const place = await placeOf(r.entity.id);
      let words = body ? r.entity.properties[body] : r.entity.content;
      if (place?.kind === "page") {
        words = await core<string>("GET", `/projects/${place.project}/page?path=${q(place.where)}`).catch(() => words);
        lines.push(`Page in project ${place.project} (path: ${place.where})`);
      } else if (place?.kind === "canvas") lines.push(`Stands for the canvas ${place.where} in project ${place.project}`);
      if (typeof words === "string" && words.trim()) lines.push("", words);
      const props = fieldLines(t, r.entity.properties, new Set([titleKey(t), ...(body ? [body] : [])]), refTitles(r));
      if (props.length) lines.push("", "Properties:", ...props);
      if (r.entity.tags?.length) lines.push("", `Tags: ${r.entity.tags.map((x) => `#${x}`).join(" ")}`);
      const lists = await listsHolding(r.entity.id);
      if (lists.length) lines.push(`In collections: ${lists.map((l) => `${l.name} [${l.id}]`).join(", ")}`);
      const linked = r.out.filter((c) => c.by === "relation");
      if (linked.length) lines.push("", "Linked to:", ...linked.map((c) => `- ${c.entity.title} (${c.name}) [${c.entity.id}]`));
      if (r.in.length) lines.push("", `Connected to this (${r.in.length}):`, ...r.in.slice(0, 50).map((c) => `- ${c.entity.title} — its ${c.name} [${c.entity.id}]`));
      return lines.join("\n");
    });

  tool("block_update", "Update anything", false,
    "Update ANY thing by id (from search/block_get): its words (content), title, arbitrary properties (shallow-merged — keys must be its type's fields, or prefixed like app:key; read it with block_get first), unset to remove properties, and add/remove tags. A list accepts a title; a canvas a title. For tasks, prefer task_update (status, projects, date shorthand).",
    obj({ id: SCHEMA.s, title: SCHEMA.s, content: SCHEMA.s, properties: SCHEMA.o, unset: SCHEMA.ss, add_tags: SCHEMA.ss, remove_tags: SCHEMA.ss }, ["id"]),
    async (a) => {
      const id = str(a.id).trim();
      const changed: string[] = [];
      const r = await core<Read>("GET", `/entities/${q(id)}`).catch(() => null);
      if (!r) {
        const f = await resolveCollection(id).catch(() => null);
        if (f && "list" in f && f.list.id === id) {
          if (a.content !== undefined || a.properties) throw new Error("A list has no words or properties of its own — give a title.");
          if (typeof a.title === "string") { await core("PATCH", `/lists/${q(id)}`, { name: a.title }); changed.push("title"); }
          return changed.length ? `Updated [${id}]: ${changed.join(", ")}.` : "Nothing to change.";
        }
        if (f && "canvas" in f && f.canvas.node.id === id) {
          if (a.content !== undefined || a.properties) throw new Error("A canvas has no words of its own — put a note on it with canvas_note.");
          if (typeof a.title === "string") { await core("PUT", `${canvasPath(f.canvas)}/title`, { title: a.title }); changed.push("title"); }
          return changed.length ? `Updated [${id}]: ${changed.join(", ")}.` : "Nothing to change.";
        }
        throw new Error(`Nothing in Talaris has the id ${id}.`);
      }
      const t = await typeOf(r.entity);
      const tk = titleKey(t), bk = bodyKey(t);
      const set: Record<string, unknown> = {};
      const props = (a.properties && typeof a.properties === "object" ? a.properties : {}) as Record<string, unknown>;
      // A key its type does not have is stored and shown nowhere: refused, with what the fields are, as Hermes refused it.
      // A prefixed key is an app's own, and is kept as any unknown field is.
      const known = new Set([...(t?.fields ?? []).map((f) => f.key), "title"]);
      const unknown = Object.keys(props).filter((k) => !known.has(k) && !k.includes(":"));
      if (unknown.length) throw new Error(`This thing's type has no field ${unknown.map((k) => `"${k}"`).join(", ")}. Its fields are: ${[...known].join(", ")}. Nothing was written.`);
      Object.assign(set, props);
      changed.push(...Object.keys(props));
      if (typeof a.title === "string") { set[tk] = a.title; changed.push("title"); }
      const unset = strs(a.unset);
      changed.push(...unset.map((k) => `-${k}`));
      const place = await placeOf(id);
      const isDay = r.kinds.includes("journal");
      const isOwnNote = typeof r.entity["talaris:undated"] !== "undefined" || isDay;
      if (isDay && typeof a.title === "string") throw new Error("A daily note is its date: its title does not change.");
      let content: string | undefined;
      if (typeof a.content === "string") {
        changed.push("content");
        if (place?.kind === "page" && !isOwnNote) {
          // A project's page: its words are its file.
          await core("PUT", `/projects/${place.project}/page?path=${q(place.where)}`, a.content);
          await told("page", place.project, place.where);
        } else if (bk) set[bk] = a.content;
        else content = a.content;
      }
      if (place?.kind === "page" && !isOwnNote && typeof a.title === "string") {
        // A project's page renamed where it is: its title is its file's name.
        const at = place.where.lastIndexOf("/");
        await core("POST", `/projects/${place.project}/page/move`, { path: place.where, parent: at > 0 ? place.where.slice(0, at) : null, title: a.title });
        delete set[tk];
      }
      if (place?.kind === "canvas" && typeof a.title === "string") {
        await core("PUT", `/projects/${place.project}/canvases/${place.where}/title`, { title: a.title });
        delete set[tk];
      }
      const addTags = strs(a.add_tags).map(tagOf).filter(Boolean), removeTags = strs(a.remove_tags).map(tagOf).filter(Boolean);
      if (addTags.length || removeTags.length) changed.push("tags");
      if (Object.keys(set).length || unset.length || content !== undefined || addTags.length || removeTags.length) {
        const answer = await patchObject(id, {
          ...(Object.keys(set).length ? { set } : {}), ...(unset.length ? { unset } : {}), ...(content !== undefined ? { content } : {}),
          ...(addTags.length ? { addTags } : {}), ...(removeTags.length ? { removeTags } : {}),
        });
        if (!answer.ok) throw new Error(`Not written: ${answer.reports.join(", ") || "it changed since it was read; read it again"}.`);
        if (answer.fidelity !== "full") changed.push(`(reduced: ${answer.reports.join(", ")})`);
      }
      return changed.length ? `Updated [${id}]: ${changed.join(", ")}.` : "Nothing to change.";
    });

  tool("list_types", "List types", true,
    "List the types of thing there are (name, which one is the plain note, and the profiles each declares). Pass as:\"interchange\" for the pkm-interchange form — fields with value kinds, and the profiles each type declares — which is how to learn which field carries a due date or a completion state.",
    obj({ as: { type: "string", enum: ["prose", "interchange"] } }),
    async (a) => {
      const all = await allTypes();
      if (a.as === "interchange") return JSON.stringify(all, null, 2);
      const note = noteType(all);
      return all.length ? all.map((t) => `- ${t.name}${t === note ? " (text)" : ""}${t.profiles && Object.keys(t.profiles).length ? ` — ${Object.keys(t.profiles).join(", ")}` : ""}`).join("\n") : "No types.";
    });

  tool("block_create", "Create anything", false,
    "Create a thing of ANY type. `type` is a type's name (omit, or 'text', for a plain note — in Talaris a page among Home's Pages). Pass `title`, `content` (its words, Markdown), and any other fields via `fields` (field key → value, e.g. {\"location\":\"…\"}). A project made so is a Talaris project (a folder); a daily note is that day's page. Tags are created as needed. Not for putting something new on a canvas — that is canvas_note — unless the user explicitly asked for a block.",
    obj({ type: SCHEMA.s, title: SCHEMA.s, content: SCHEMA.s, fields: SCHEMA.o, tags: SCHEMA.ss }),
    async (a) => {
      const all = await allTypes();
      const want = str(a.type).trim().toLowerCase();
      const t = !want || want === "text" || want === "note" ? noteType(all)
        : all.find((x) => x.name.toLowerCase() === want) ?? all.find((x) => x.name.toLowerCase().includes(want));
      if (!t) throw new Error(`No type "${str(a.type)}". Available: ${all.map((x) => x.name).join(", ")}.`);
      const properties: Record<string, unknown> = { ...((a.fields && typeof a.fields === "object" ? a.fields : {}) as Record<string, unknown>) };
      if (typeof a.title === "string") properties[titleKey(t)] = a.title;
      const bk = bodyKey(t);
      let content: string | undefined;
      if (typeof a.content === "string") { if (bk && bk !== "content") properties[bk] = a.content; else content = a.content; }
      // A day's note needs its day: a date given as its title, else today.
      const dayKey = t.profiles?.journal?.date;
      if (typeof dayKey === "string" && typeof properties[dayKey] !== "string") properties[dayKey] = ISO_DATE.test(str(a.title)) ? str(a.title) : localDate();
      // A note with no title is called by its first line, as the writing drawer names one.
      if (t === noteType(all) && !str(properties[titleKey(t)]).trim()) properties[titleKey(t)] = (str(a.content).split("\n").find((x) => x.trim()) ?? "").replace(/^#+\s*/, "").slice(0, 80).trim();
      const id = randomUUID();
      // The binding's create (interchange.ts, createObject): a note is a page, a project a folder, a day its page.
      const answer = await core<{ ok: boolean; reports: string[]; object?: { id: string } }>("PUT", `/interchange/objects/${id}`, {
        id, type: t.id, properties, ...(content !== undefined ? { content } : {}), ...(strs(a.tags).length ? { tags: strs(a.tags).map(tagOf).filter(Boolean) } : {}),
      }).catch((e: Error) => { try { return JSON.parse(e.message) as { ok: boolean; reports: string[]; object?: { id: string } }; } catch { throw e; } });
      if (!answer.ok) throw new Error(`Not created: ${answer.reports.join(", ")}.`);
      return `Created ${t === noteType(all) ? "note" : t.name} [${answer.object?.id ?? id}].`;
    });

  tool("block_archive", "Archive anything", false,
    "Archive a thing (id or title): hide it from every normal view and query. Reversible via block_unarchive. A project's entity archived is the project archived (its folder too); a list can be archived as well. There is no delete tool.",
    obj({ block: SCHEMA.s }, ["block"]),
    async (a) => {
      const ident = str(a.block).trim();
      const lists = await core<List[]>("GET", "/lists");
      const list = lists.find((l) => l.id === ident);
      if (list) { await core("PATCH", `/lists/${q(list.id)}`, { archived: true }); return `Archived the list "${list.name}" [${list.id}].`; }
      const thing = await resolveThing(ident);
      await core("PATCH", `/entities/${q(thing.id)}`, { archived: true });
      return `Archived "${thing.title}" [${thing.id}].`;
    });

  tool("block_unarchive", "Unarchive anything", false,
    "Restore an archived thing by id — it reappears everywhere it was. (Pass the id; archived things aren't found by title search.)",
    obj({ id: SCHEMA.s }, ["id"]),
    async (a) => {
      const id = str(a.id).trim();
      const list = (await core<List[]>("GET", "/lists?archived=1")).find((l) => l.id === id);
      if (list) { await core("PATCH", `/lists/${q(id)}`, { archived: false }); return `Unarchived the list "${list.name}" [${id}].`; }
      await core("PATCH", `/entities/${q(id)}`, { archived: false });
      return `Unarchived [${id}].`;
    });

  // ---------------------------------------------------------- collections

  const KINDS: Record<string, string> = { list: "list", table: "table", matrix: "matrix", kanban: "board", calendar: "calendar", document: "list", masonry: "list" };
  const kindNote = (k: string) => (k === "document" || k === "masonry" ? ` (Talaris has no ${k} view; it is a list)` : "");

  /** A canvas made inside a project's top canvas, as a child card on it — Talaris's only way to make one. */
  const makeCanvas = async (title: string, project: unknown) => {
    const p = await resolveProject(str(project));
    if (!p.id) throw new Error(`${p.name} has no folder, so no canvases.`);
    const top = await core<CanvasNode>("GET", `/projects/${p.id}/canvases`);
    const at = rightOf(await core<CanvasDocument>("GET", `/projects/${p.id}/canvases/${top.id}`));
    const made = await core<{ canvas: { id: string; title: string } }>("POST", `/projects/${p.id}/canvases/${top.id}/children`, { title, x: at.x, y: at.y });
    await told("canvas", p.id, top.id);
    return { project: p.id, projectName: p.name, node: { id: made.canvas.id, title: made.canvas.title, parent: top.id, children: [] } as CanvasNode };
  };
  /** Cards for things on a canvas, laid out; those already there moved into place. Answers how many were placed. */
  const place = async (c: { project: string; node: { id: string } }, items: string[], layout: string, color: string | undefined, replace: boolean, connect = false) => {
    const ids: string[] = [];
    for (const it of items) ids.push((await resolveThing(it)).id);
    const doc = await readDoc(c);
    let removed = 0;
    if (replace) {
      // Only the cards go: its notes, the canvases on it and its ink are the canvas's own.
      const going = new Set(doc.items.filter((i) => i.kind === "card" && !ids.includes(String(i.entity))).map((i) => i.id));
      removed = going.size;
      doc.items = doc.items.filter((i) => !going.has(i.id));
      doc.links = doc.links.filter((l) => !going.has(l.from) && !going.has(l.to));
      for (const r of doc.regions) if (r.members) r.members = r.members.filter((m) => !going.has(m));
    }
    const at = cells(ids.length, layout, replace ? { x: 0, y: 0 } : rightOf({ ...doc, items: doc.items.filter((i) => !(i.kind === "card" && ids.includes(String(i.entity)))) }));
    const placed: CanvasItem[] = [];
    for (const [n, id] of ids.entries()) {
      const there = doc.items.find((i) => i.kind === "card" && i.entity === id);
      if (there) { Object.assign(there, at(n), color ? { fill: color } : {}); placed.push(there); continue; }
      const card = await cardFor(id, at(n), color);
      doc.items.push(card);
      placed.push(card);
    }
    if (connect) for (let i = 0; i + 1 < placed.length; i++) {
      const from = placed[i]!.id, to = placed[i + 1]!.id;
      if (!doc.links.some((l) => (l.from === from && l.to === to) || (l.from === to && l.to === from))) doc.links.push({ id: randomUUID(), from, to, color: null });
    }
    await saveDoc(c, doc);
    return { n: placed.length, removed };
  };

  tool("collection_create", "Create a collection", false,
    "Create a collection. kind: list | table | matrix | kanban (a Talaris board, by status) | calendar | canvas; document and masonry have no Talaris counterpart and are made lists. Optionally seed it with existing things by id or title. A canvas is made inside a project's top canvas (project: name or id; Home if none). (For a laid-out canvas use canvas_create instead.) Talaris lists keep no description.",
    obj({ kind: { type: "string", enum: ["list", "document", "matrix", "table", "canvas", "kanban", "masonry", "calendar"] }, title: SCHEMA.s, description: SCHEMA.s, members: SCHEMA.ss, project: SCHEMA.s }, ["kind", "title"]),
    async (a) => {
      const kind = str(a.kind), title = str(a.title).trim();
      if (!title) throw new Error("A collection needs a title.");
      const unsaid = str(a.description) ? " Its description was not kept: Talaris lists have none." : "";
      if (kind === "canvas") {
        const c = await makeCanvas(title, a.project);
        const n = strs(a.members).length ? (await place(c, strs(a.members), "grid", undefined, false)).n : 0;
        return `Created canvas "${title}" in ${c.projectName} [${c.node.id}]${n ? ` with ${plural(n, "card")}` : ""}.`;
      }
      if (!KINDS[kind]) throw new Error(`kind is one of ${Object.keys(KINDS).join(", ")}, canvas.`);
      const l = await core<List>("POST", "/lists", { name: title, kind: KINDS[kind] });
      let added = 0;
      for (const m of strs(a.members)) {
        try { await core("POST", `/lists/${q(l.id)}/members`, { object: (await resolveThing(m)).id }); added++; } catch { /* one not found is skipped, as Hermes skipped it */ }
      }
      return `Created ${kind} collection "${title}" [${l.id}]${added ? ` with ${plural(added, "member")}` : ""}${kindNote(kind)}.${unsaid}`;
    });

  tool("collection_create_smart", "Create a smart collection", false,
    "Create a query-fed (smart) collection that includes matching things as they change. Filter by `type` (a type's name), `tags`, and/or a text `term`. match: all (default) requires every condition, any requires one. kind as for collection_create (no canvas).",
    obj({ kind: { type: "string", enum: ["list", "document", "matrix", "table", "kanban", "masonry", "calendar"] }, title: SCHEMA.s, type: SCHEMA.s, tags: SCHEMA.ss, term: SCHEMA.s, match: { type: "string", enum: ["all", "any"] } }, ["kind", "title"]),
    async (a) => {
      const kind = str(a.kind);
      if (!KINDS[kind]) throw new Error(`kind is one of ${Object.keys(KINDS).join(", ")}.`);
      const items: Record<string, unknown>[] = [];
      if (a.type) {
        const all = await allTypes();
        const w = str(a.type).toLowerCase();
        const t = all.find((x) => x.name.toLowerCase() === w) ?? all.find((x) => x.name.toLowerCase().includes(w));
        if (!t) throw new Error(`No type "${str(a.type)}". Available: ${all.map((x) => x.name).join(", ")}.`);
        items.push({ kind: "type", typeId: t.id });
      }
      for (const tg of strs(a.tags)) items.push({ kind: "tag", tag: tagOf(tg), op: "include" });
      if (a.term) items.push({ kind: "text", value: str(a.term) });
      if (!items.length) throw new Error("Give at least one of type, tags, or term.");
      const l = await core<List>("POST", "/lists", { name: str(a.title), kind: KINDS[kind], query: { kind: "group", match: a.match === "any" ? "any" : "all", items }, materialized: false });
      return `Created smart ${kind} "${str(a.title)}" [${l.id}] (${plural(items.length, "condition")})${kindNote(kind)}.`;
    });

  tool("collection_members", "What a collection holds", true,
    "What's in a collection (id or title): a list's members with their titles and ids, plus the matrix region (or board column) where placed. For a CANVAS: its cards, its sticky notes, the canvases on it and every connection drawn between things on it.",
    obj({ collection: SCHEMA.s }, ["collection"]),
    async (a) => {
      const f = await resolveCollection(str(a.collection));
      if ("canvas" in f) return describeCanvas(await readDoc(f.canvas), f.canvas);
      const shown = await core<Shown>("GET", `/lists/${q(f.list.id)}`);
      const regions = regionsOf(shown.list);
      const label = (r?: string) => { if (!r) return ""; const x = regions.find((g) => g.name === r); return ` — region "${x?.label ?? r}"`; };
      const out = shown.rows.map((r) => `- ${r.title}${label(r.region)} [${r.id}]`);
      if (shown.drawer?.length) out.push("", `Not placed yet (${shown.drawer.length}):`, ...shown.drawer.map((r) => `- ${r.title} [${r.id}]`));
      return out.length ? out.join("\n") : "No members.";
    });

  tool("collection_add", "Add to a collection", false,
    "Add one or more existing things (ids or titles) to a collection (id or title): a list by hand, or a canvas as cards. Pass every one in one call — this is not a one-at-a-time tool. A smart list's members are its rule's, so nothing is added to one.",
    obj({ collection: SCHEMA.s, block: SCHEMA.s, blocks: SCHEMA.ss }, ["collection"]),
    async (a) => {
      const named = strs(a.blocks).length ? strs(a.blocks) : strs(a.block);
      if (!named.length) return "Name a block, or several.";
      const f = await resolveCollection(str(a.collection));
      if ("canvas" in f) {
        const { n } = await place(f.canvas, named, "grid", undefined, false);
        return `Added ${plural(n, "block")} to canvas [${f.canvas.node.id}].`;
      }
      if (f.list.membership.mode === "query" && f.list.kind !== "matrix") throw new Error(`"${f.list.name}" is a smart list: what it holds is what its rule matches, so nothing is added by hand.`);
      const ids: string[] = [];
      for (const it of named) ids.push((await resolveThing(it)).id);
      for (const id of ids) await core("POST", `/lists/${q(f.list.id)}/members`, { object: id });
      return `Added ${plural(ids.length, "block")} to collection [${f.list.id}].`;
    });

  tool("collection_remove", "Remove from a collection", false,
    "Remove a thing (id or title) from a collection (id or title) — a list's member, or a card on a canvas. The thing itself is NOT deleted.",
    obj({ collection: SCHEMA.s, block: SCHEMA.s }, ["collection", "block"]),
    async (a) => {
      const f = await resolveCollection(str(a.collection));
      if ("canvas" in f) {
        const doc = await readDoc(f.canvas);
        const it = canvasItem(doc, str(a.block));
        if (it.kind === "canvas") throw new Error(`${itemLabel(it)} is a canvas inside this one: it is deleted in the drawer, not here.`);
        doc.items = doc.items.filter((i) => i !== it);
        doc.links = doc.links.filter((l) => l.from !== it.id && l.to !== it.id);
        for (const r of doc.regions) if (r.members) r.members = r.members.filter((m) => m !== it.id);
        await saveDoc(f.canvas, doc);
        return `Removed [${it.entity ?? it.id}] from canvas [${f.canvas.node.id}].`;
      }
      const id = (await resolveThing(str(a.block))).id;
      await core("DELETE", `/lists/${q(f.list.id)}/members/${q(id)}`);
      return `Removed [${id}] from collection [${f.list.id}].`;
    });

  tool("matrix_place", "Place in a matrix", false,
    "Place a thing (id or title) into a named region of a matrix — e.g. the \"Do\" quadrant of an Eisenhower matrix — or a board's column. `region` matches the region's title. Entering a region does what it says (a matrix region may add a tag; a board column is a status).",
    obj({ matrix: SCHEMA.s, block: SCHEMA.s, region: SCHEMA.s }, ["matrix", "block", "region"]),
    async (a) => {
      const f = await resolveCollection(str(a.matrix), "list");
      if (!("list" in f)) throw new Error("not a list");
      const l = f.list;
      const shown = (await core<Shown>("GET", `/lists/${q(l.id)}`)).list;
      if (l.kind !== "matrix" && !l["talaris:bind"]) throw new Error(`"${l.name}" is not a matrix.`);
      const region = findRegion(shown, str(a.region));
      const id = (await resolveThing(str(a.block))).id;
      await core("POST", `/lists/${q(l.id)}/members`, { object: id, region: region.name });
      return `Placed [${id}] in region "${region.label ?? region.name}" of matrix [${l.id}].`;
    });

  // ---------------------------------------------------------- canvases

  tool("canvas_create", "Create a canvas", false,
    "Create a canvas and arrange the given things (ids or titles) on it as cards. layout: grid | row | column. connect=true chains them with arrows in the given order (use this for an ordered flow). Decide the order yourself, then pass items in that order. color sets the background of every card (a hex value like '#f97316', or a color's name); use canvas_style afterwards to color or resize single ones. In Talaris a canvas lives in a project, inside its top canvas: project (name or id) says which — Home if none.",
    obj({ title: SCHEMA.s, items: { ...SCHEMA.ss, minItems: 1 }, layout: { type: "string", enum: ["grid", "row", "column"] }, connect: SCHEMA.b, color: SCHEMA.s, project: SCHEMA.s }, ["title", "items"]),
    async (a) => {
      const items = strs(a.items);
      if (!items.length) throw new Error("Give the things to put on it.");
      const color = checkColor(a.color);
      // Every item found before anything is made: a canvas half made by a name that is not there helps no one.
      for (const it of items) await resolveThing(it);
      const c = await makeCanvas(str(a.title).trim() || "Canvas", a.project);
      const { n } = await place(c, items, str(a.layout) || "grid", color, false, a.connect === true);
      return `Created canvas "${c.node.title}" in ${c.projectName} [${c.node.id}] with ${plural(n, "block")}${a.connect === true ? ", connected in order" : ""}.`;
    });

  tool("canvas_place", "Put things on a canvas", false,
    "Put things on a canvas that ALREADY EXISTS, as cards, arranged and optionally colored. Use this whenever the user means a canvas they already have — 'this canvas', 'my canvas', or one named or given by id. canvas_create is only for making a NEW canvas. layout: grid | row | column — placed to the right of what is there. replace=true takes the cards already there off first (its notes stay), which is what 'replace this canvas' means. Pass every one in one call.",
    obj({ canvas: SCHEMA.s, items: { ...SCHEMA.ss, minItems: 1 }, layout: { type: "string", enum: ["grid", "row", "column"] }, color: SCHEMA.s, replace: SCHEMA.b }, ["canvas", "items"]),
    async (a) => {
      const c = await resolveCanvas(str(a.canvas));
      const color = checkColor(a.color);
      const { n, removed } = await place(c, strs(a.items), str(a.layout) || "grid", color, a.replace === true);
      return `${a.replace === true ? `Replaced ${removed} with ${n}` : `Placed ${n}`} block${n === 1 ? "" : "s"} on canvas [${c.node.id}]${color ? `, colored ${color}` : ""}.`;
    });

  tool("canvas_style", "Style things on a canvas", false,
    "Change how things already on a canvas are drawn: background color, size, or position. Takes the canvas (id or title) and items (ids or titles of what the cards show, item ids, or a fragment of a note's words). A hex color like '#f97316', or a color's name.",
    obj({ canvas: SCHEMA.s, items: { ...SCHEMA.ss, minItems: 1 }, color: SCHEMA.s, w: SCHEMA.n, h: SCHEMA.n, x: SCHEMA.n, y: SCHEMA.n }, ["canvas", "items"]),
    async (a) => {
      const color = checkColor(a.color);
      const change: Partial<CanvasItem> = {};
      if (color) change.fill = color;
      for (const k of ["w", "h", "x", "y"] as const) if (num(a[k]) !== undefined) change[k] = num(a[k])!;
      if (!Object.keys(change).length) return "Nothing to change — name a color, size, or position.";
      const c = await resolveCanvas(str(a.canvas));
      const doc = await readDoc(c);
      const hit = strs(a.items).map((it) => canvasItem(doc, it));
      // Only what was named: coloring a card does not move it.
      for (const it of hit) Object.assign(it, change);
      await saveDoc(c, doc);
      return `Set ${Object.keys(change).map((k) => (k === "fill" ? "color" : k)).join(", ")} on ${plural(hit.length, "block")}.`;
    });

  tool("canvas_note", "A note on a canvas", false,
    "THE DEFAULT for anything new on a canvas: a thought, consideration, pro/con, summary or next step goes here, not into a new block, unless the user explicitly asks for a block. Sticky notes are the free-floating text that lives ONLY on the canvas: no entity, not in search. `action` is add (default), edit, or remove; for edit/remove, `note` identifies it by its id or a fragment of its text (read the canvas with collection_members first). x/y are canvas coordinates, `color` a hex background. `text` is Markdown.",
    obj({ canvas: SCHEMA.s, action: { type: "string", enum: ["add", "edit", "remove"] }, text: { type: "string", maxLength: 10000 }, note: SCHEMA.s, x: SCHEMA.n, y: SCHEMA.n, color: { type: "string", pattern: "^#[0-9a-fA-F]{3,8}$" } }, ["canvas"]),
    async (a) => {
      const c = await resolveCanvas(str(a.canvas));
      const doc = await readDoc(c);
      const color = str(a.color);
      if (color && !/^#[0-9a-fA-F]{3,8}$/.test(color)) throw new Error("color must be a hex value like #fdf3d8");
      const action = str(a.action) || "add";
      if (action === "add") {
        if (!str(a.text)) throw new Error("A note needs text to add.");
        // Cascaded when no place is given, so they don't stack exactly.
        const step = (doc.items.filter(isNote).length % 6) * 36;
        const item: CanvasItem = { id: `i${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`, x: num(a.x) ?? 40 + step, y: num(a.y) ?? 40 + step, w: 220, h: 130, text: str(a.text), ...(color ? { fill: color } : {}) };
        doc.items.push(item);
        await saveDoc(c, doc);
        return `Added a sticky note to canvas "${doc.title}" [${item.id}].`;
      }
      if (!str(a.note)) throw new Error("Which note? Give its id or a fragment of its text.");
      const it = canvasItem(doc, str(a.note));
      if (!isNote(it)) throw new Error(`"${str(a.note)}" is a card on this canvas, not a sticky note.`);
      if (action === "remove") {
        doc.items = doc.items.filter((i) => i !== it);
        doc.links = doc.links.filter((l) => l.from !== it.id && l.to !== it.id);
        for (const r of doc.regions) if (r.members) r.members = r.members.filter((m) => m !== it.id);
        await saveDoc(c, doc);
        return "Removed the sticky note and any connections to it.";
      }
      if (typeof a.text === "string") it.text = a.text;
      if (num(a.x) !== undefined) it.x = num(a.x)!;
      if (num(a.y) !== undefined) it.y = num(a.y)!;
      if (color) it.fill = color;
      await saveDoc(c, doc);
      return `Updated the sticky note [${it.id}].`;
    });

  tool("canvas_connect", "Connect things on a canvas", false,
    "Draw or erase a connection between two things on a canvas — cards, sticky notes, or one of each. Each side is named by id, by a card's title, or by a fragment of a note's text. `action` is connect (default) or disconnect. `dash` is solid, dashed or dotted. Talaris's canvas draws every line as an arrow from the first to the second, with no words on it: `label` and `arrow` other than forward are not kept, and the answer says so. Two things are connected once; connecting them again restyles that line.",
    obj({ canvas: SCHEMA.s, from: SCHEMA.s, to: SCHEMA.s, action: { type: "string", enum: ["connect", "disconnect"] }, label: { type: "string", maxLength: 200 }, arrow: { type: "string", enum: ["forward", "back", "both", "none"] }, dash: { type: "string", enum: ["solid", "dashed", "dotted"] } }, ["canvas", "from", "to"]),
    async (a) => {
      const c = await resolveCanvas(str(a.canvas));
      const doc = await readDoc(c);
      const from = canvasItem(doc, str(a.from)).id, to = canvasItem(doc, str(a.to)).id;
      if (from === to) throw new Error("Those are the same thing.");
      const existing = doc.links.find((l) => (l.from === from && l.to === to) || (l.from === to && l.to === from));
      if (str(a.action) === "disconnect") {
        if (!existing) return "They weren't connected.";
        doc.links = doc.links.filter((l) => l !== existing);
        await saveDoc(c, doc);
        return `Disconnected "${str(a.from)}" from "${str(a.to)}".`;
      }
      const unkept = [a.label ? "label" : "", a.arrow && a.arrow !== "forward" ? `arrow "${str(a.arrow)}"` : ""].filter(Boolean);
      const unsaid = unkept.length ? ` Not kept: ${unkept.join(" and ")} — Talaris's canvas draws lines as forward arrows without words.` : "";
      const style = a.dash && a.dash !== "solid" ? str(a.dash) : undefined;
      if (existing) {
        if (style) existing.style = style; else delete existing.style;
        await saveDoc(c, doc);
        return `Those were already connected — restyled that line instead.${unsaid}`;
      }
      doc.links.push({ id: randomUUID(), from, to, color: null, ...(style ? { style } : {}) });
      await saveDoc(c, doc);
      return `Connected "${str(a.from)}" → "${str(a.to)}" on "${doc.title}".${unsaid}`;
    });

  // ---------------------------------------------------------- the day

  tool("daily_note_get", "Read a daily note", true,
    "Read the daily note for a date — Home's daily page for that day, what the writing drawer's calendar opens. date defaults to today (YYYY-MM-DD). A day nobody has written in has no page yet and reads as empty; writing to it (daily_note_append) makes it. Use this rather than searching for a note by its date.",
    obj({ date: SCHEMA.date }),
    async (a) => {
      const date = str(a.date).trim() || localDate();
      if (!ISO_DATE.test(date)) throw new Error("date must be YYYY-MM-DD");
      const d = await readDay(date);
      return `Daily note ${date}${d.id ? ` [${d.id}]` : ""} (Home, path: ${dayPath(date)})\n\n${(d.text ?? "").trim() || "(empty)"}`;
    });

  tool("daily_note_append", "Add to a daily note", false,
    "Add text to the end of a day's daily note (Home's daily page), making it if that day has none yet. Markdown — use \"- \" for a bullet, \"- [ ] \" for a checklist item. date defaults to today. To replace the whole note instead, read it with daily_note_get and write it with block_update.",
    obj({ text: SCHEMA.s, date: SCHEMA.date }, ["text"]),
    async (a) => {
      const date = str(a.date).trim() || localDate();
      if (!ISO_DATE.test(date)) throw new Error("date must be YYYY-MM-DD");
      const addition = str(a.text).trim();
      if (!addition) throw new Error("Add what?");
      const d = await readDay(date);
      const before = (d.text ?? "").replace(/\s+$/, "");
      // A blank line between what was there and what arrives: a list appended to a paragraph would swallow its first item.
      await core("PUT", `/projects/${d.home}/page?path=${q(dayPath(date))}`, before ? `${before}\n\n${addition}\n` : `${addition}\n`);
      await told("page", d.home, dayPath(date));
      return `Added to the daily note for ${date}.`;
    });

  tool("daily_review", "Review a day", true,
    "Everything bearing on one day, in one call: the calendar (Talaris's own and the accounts' calendars), tasks overdue as of that day, tasks due that day, tasks available to work on, and the day's note. date defaults to today (YYYY-MM-DD). Use this for \"how does my day look\", a morning or evening review, or planning a specific date. Tasks are judged as of that day from the open tasks now, so a past day leaves out what has been completed since; other things dated to the day (besides tasks and events) are not gathered.",
    obj({ date: SCHEMA.date }),
    async (a) => {
      const date = str(a.date).trim() || localDate();
      if (!ISO_DATE.test(date)) throw new Error("date must be YYYY-MM-DD");
      const label = new Date(`${date}T00:00`).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
      const out = [`Daily review — ${label} (${date})`];
      const cal = await gatherCalendar(date, date);
      out.push("", "Calendar:");
      // Loud, and never as an empty calendar: "your day is clear" when it could not be read is the worst thing this could say.
      if (cal.warning) out.push(`- NOTE: ${cal.warning}. Do not tell the user their calendar is clear on that account.`);
      if (!cal.events.length) out.push("- nothing scheduled");
      out.push(...cal.events.map((e) => eventLine(e, false)));
      const open = await core<Row[]>("GET", "/tasks/find?status=open&limit=100000");
      const day = (v?: string) => (v ? v.slice(0, 10) : "");
      const overdue = open.filter((r) => day(r.due) && day(r.due) < date);
      const dueToday = open.filter((r) => day(r.due) === date);
      const listed = new Set([...overdue, ...dueToday].map((r) => r.id));
      const available = open.filter((r) => !listed.has(r.id) && day(r.start) && day(r.start) <= date);
      const section = (title: string, rows: Row[]) => { out.push("", `${title}:`, ...(rows.length ? rows.map((r) => `- ${taskLine(r, date)}`) : ["- none"])); };
      section(`Overdue as of ${date}`, overdue);
      section("Due that day", dueToday);
      section("Available (started, not yet due)", available);
      const d = await readDay(date);
      out.push("", `Daily note: ${(d.text ?? "").trim() ? `\n${(d.text ?? "").trim()}` : "(empty)"}`);
      return out.join("\n");
    });

  tool("calendar_events", "Calendar events", true,
    "The user's actual schedule for a day or range: Talaris's own calendar merged with the accounts' calendars (Google, Outlook, iCloud…) as the desktop shares them, in time order. Use this for ANY question about the calendar, schedule, meetings, availability, or 'what's on today' — task_find does NOT include calendar events, so never assume the calendar is clear without calling this. Dates are YYYY-MM-DD: pass `date` for one day, `start`+`end` for a range, or omit for today.",
    obj({ date: SCHEMA.date, start: SCHEMA.date, end: SCHEMA.date }),
    async (a) => {
      let start = str(a.date) || str(a.start), end = str(a.date) || str(a.end);
      if (!start) start = localDate();
      if (!end) end = start;
      if (!ISO_DATE.test(start) || !ISO_DATE.test(end)) throw new Error("dates must be YYYY-MM-DD");
      if (end < start) [start, end] = [end, start];
      const { events, warning } = await gatherCalendar(start, end);
      const range = start === end ? `on ${start}` : `from ${start} to ${end}`;
      const note = warning ? `\n\nNOTE: ${warning}. Do not tell the user their calendar is clear on that account.` : "";
      if (!events.length) return `No calendar events ${range}.${note}`;
      return `Calendar ${start === end ? start : `${start} → ${end}`}:\n${events.map((e) => eventLine(e, start !== end)).join("\n")}${note}`;
    });

  // ---------------------------------------------------------- the interchange binding

  tool("interchange_conformance", "Interchange conformance", true,
    "What this Talaris honors, as a pkm-interchange manifest: levels per role, bindings, profiles, features. Ask before writing rather than discovering by trying.",
    obj({}), async () => JSON.stringify(await core("GET", "/conformance"), null, 2));

  tool("interchange_types", "Interchange types", true,
    "The types as pkm-interchange declares them: fields with value kinds, and the profiles each type declares (task, note, and so on). This is how to find out which field carries a due date or a completion state without knowing what this store calls them.",
    obj({}), async () => JSON.stringify(await allTypes(), null, 2));

  tool("interchange_object", "Interchange object", true,
    "One object as pkm-interchange has it: properties, tags, archived, created, updated (Talaris's own keys prefixed talaris:). Paired with interchange_types, this is readable by anything that knows the format and nothing about Talaris.",
    obj({ id: { type: "string", description: "object id" } }, ["id"]),
    async (a) => JSON.stringify((await core<Read>("GET", `/entities/${q(str(a.id))}`)).entity, null, 2));

  tool("interchange_patch", "Interchange patch", false,
    "Write part of an object: set these properties, remove those, leave everything else exactly as it is — including properties you have never heard of. This is the safe way to change one field. The answer says whether anything was lost.",
    obj({ id: { type: "string", description: "object id" }, set: { type: "object", description: "properties to write" }, unset: { type: "array", items: { type: "string" }, description: "properties to remove — the only way to remove one" } }, ["id"]),
    async (a) => {
      const answer = await patchObject(str(a.id), { set: (a.set && typeof a.set === "object" ? a.set : {}), unset: strs(a.unset) });
      return JSON.stringify({ ok: answer.ok, fidelity: answer.fidelity, reports: answer.reports });
    });

  return tools;
}
