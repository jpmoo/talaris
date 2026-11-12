// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore

/*
 * Notes, for the live binding (interchange.ts) and so for a sync: every
 * writing page, in every project, but a day's (those are daily notes, below).
 *
 * A note's words live in its page's file, and the file is the truth. What the
 * binding hands out is an entity standing for it — the same one that holds its
 * mentions (a page's source, `<project>/<path>`) — carrying its title, its
 * words where the note profile puts a body (Talaris's own Note type: its `body`
 * field; `content` for a type that says so), the project it is in where the
 * profile names a `project` slot (none for one of Home's Pages, the notes of no
 * project), and a mark, `talaris:undated` — a page written through to its
 * file, the name kept from when only Home's Pages were notes — so that a sync
 * can tell these from every other note-shaped thing in the store (a canvas
 * note's mentions). Renamed or moved, even to another project, it is the same
 * entity (`movedText`); nested, it is too: where it sits is Talaris's alone,
 * and only its own title and project travel.
 *
 * Kept in step by looking (`reconcileNotes`), before every read and write
 * through the binding: so a note edited in another editor, one moved to
 * another project, and one deleted (its entity goes, which the feed says) are
 * all seen, without every page call having to remember to say so. An archived
 * project's pages stay notes: archiving a project is not deleting its writing.
 *
 * A write through the binding goes to the file: a new title renames the page
 * where it is, new words are written to it, another project moves it there
 * (none: among Home's Pages); a note made through the binding is made at the
 * top of its project's writing, or of Home's Pages, at the id asked for.
 */

import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { allRecords, bySource, createEntity, deleteEntity, getEntity, getFile, typeFor, types, updateEntity, type Entity } from "./entities.js";
import { Conflict, PAGES, UNDATED, allProjects, attachedFile, ensureHome, findProject, pagesPlace, putProjectFile } from "./projects.js";
import { DAILY, createPage, fileLinkText, movePage, pageFiles, pageTree, readPage, transferPage, withoutFileLink, writePage } from "./pages.js";
import { linkedBytes, setPageLinks } from "./links.js";
import { ensureProjectEntity, projectIdOf } from "./filing.js";
import { WRITING } from "./paths.js";
import type { PageNode } from "@talaris/model";

export const MARK = "talaris:undated";
/** Their old address, before they were Home's (pages-home.ts): never written, only refused. */
const LEGACY = `${UNDATED}/`;
/** A note is a project's page: `<project>/<path>`, the key its page source already has (pages.ts, writePage). */
interface Place { project: string; path: string }
const keyOf = (at: Place) => `${at.project}/${at.path}`;
const sourceOf = (at: Place) => ({ kind: "page", key: keyOf(at) });
const placeOf = (key: string): Place | null => {
  const cut = key.indexOf("/");
  return cut > 0 ? { project: key.slice(0, cut), path: key.slice(cut + 1) } : null;
};
const titleOf = (path: string) => path.split("/").pop() ?? path;
/** A page of Home's: a note of no project — Home is the scratchpad, and nothing is filed under it (tasks.ts). */
const unfiled = (at: Place) => at.project === homeId();
const pageSource = (e: Entity) => ((e["talaris:sources"] as { kind: string; key: string }[] | undefined) ?? []).find((s) => s.kind === "page");

/** The property a note's title is kept in, as the note profile says (Talaris's own note type: `title`). */
function titleKey(typeId: string | undefined): string {
  const t = types().find((x) => x.id === typeId)?.profiles?.note?.title;
  return typeof t === "string" ? t : "title";
}
/** Where a note's words are kept, as the note profile says: a field (Talaris's own: `body`), or `content`. */
export function bodyKey(typeId: string | undefined): string {
  const b = types().find((x) => x.id === typeId)?.profiles?.note?.body;
  return typeof b === "string" ? b : "content";
}
/** A note entity's words, wherever its type keeps them. */
const wordsOf = (e: Entity) => { const k = bodyKey(e.type); return String((k === "content" ? e.content : e.properties[k]) ?? ""); };
/** The property a note's project is kept in, where its type's note profile names one (Talaris's own: `project`). */
function projectKey(typeId: string | undefined): string | null {
  const p = types().find((x) => x.id === typeId)?.profiles?.note?.project;
  return typeof p === "string" ? p : null;
}
/** The project a note lives in — the entity standing for the project whose writing holds its page; none for Home's. */
const livesIn = (at: Place): string | null => {
  if (unfiled(at)) return null;
  let p;
  try { p = findProject(at.project); } catch { return null; }
  return ensureProjectEntity(p)?.id ?? null;
};
/** Where a note's entity keeps the project it lives in, apart from the rest of its projects. */
const LIVES = "talaris:livesIn";
/**
 * A note's projects, as its project field holds them: the one it lives in first, then any it is also in — kept
 * whatever happens to its page, but the one it lived in before, which a move leaves behind.
 */
const projectsOf = (at: Place, e: Entity | null, pk: string | null): string[] | null => {
  const here = livesIn(at);
  const had = e && pk ? (Array.isArray(e.properties[pk]) ? (e.properties[pk] as unknown[]).map(String) : e.properties[pk] ? [String(e.properties[pk])] : []) : [];
  const was = e ? (e[LIVES] as string | undefined) : undefined;
  const also = had.filter((x) => x !== here && x !== was);
  const list = [...(here ? [here] : []), ...also];
  return list.length ? list : null;
};

/** The patch that puts words where a type keeps them. */
const wordsAt = (typeId: string | undefined, text: string) => { const k = bodyKey(typeId); return k === "content" ? { content: text } : { properties: { [k]: text } }; };

/**
 * Every note's place: every page of every project's writing (an archived project's too), but Home's daily pages,
 * and Home's Pages folder itself (its pages are notes; it is only where they are kept).
 */
function allPlaces(): Place[] {
  const out: Place[] = [];
  const home = homeId();
  for (const project of allProjects()) {
    let tree: PageNode[] = [];
    try { tree = pageTree(project.id); } catch { continue; }
    const walk = (nodes: PageNode[]) => {
      for (const n of nodes) {
        const daily = project.id === home && (n.path === DAILY || n.path.startsWith(`${DAILY}/`));
        if (daily) continue;
        if (!(project.id === home && n.path === PAGES)) out.push({ project: project.id, path: n.path });
        walk(n.children);
      }
    };
    walk(tree);
  }
  return out;
}

/** A note's entity brought up to date with its page — made, if it has none; `id` only when it is made. */
function mirror(at: Place, id?: string): Entity {
  const title = titleOf(at.path);
  let text = "";
  try { text = readPage(at.project, at.path); } catch { /* a folder with no page of its own: a note with no words */ }
  const e = bySource(sourceOf(at));
  const here = livesIn(at);
  if (!e) {
    const type = typeFor("note");
    const words = wordsAt(type.id, text);
    const pk = projectKey(type.id);
    const project = projectsOf(at, null, pk);
    return createEntity({ ...(id ? { id } : {}), type: type.id,
      properties: { [titleKey(type.id)]: title, ...(words.properties ?? {}), ...(pk && project ? { [pk]: project } : {}) },
      ...(words.content !== undefined ? { content: words.content } : {}), sources: [sourceOf(at)], "talaris:textElsewhere": true, [MARK]: true,
      [LIVES]: here });
  }
  const key = titleKey(e.type);
  const pk = projectKey(e.type);
  const project = projectsOf(at, e, pk);
  const sameProject = !pk || JSON.stringify(e.properties[pk] ?? null) === JSON.stringify(project);
  if (e.properties[key] === title && wordsOf(e) === text && e[MARK] === true && sameProject && (e[LIVES] ?? null) === here) return e;
  const words = wordsAt(e.type, text);
  return updateEntity(e.id, { properties: { [key]: title, ...(words.properties ?? {}), ...(pk ? { [pk]: project } : {}) },
    ...(words.content !== undefined ? { content: words.content } : {}), [MARK]: true, [LIVES]: here });
}

// ------------------------------------------------------------ daily notes

/*
 * Daily notes, for the binding too: Home's `Daily/<date>` pages (pages.ts),
 * each handed out as its page's entity, typed a Daily note — the format's
 * `journal`, its date the day's identity, and a `note` with its words — and
 * marked `talaris:daily`. The file is the truth, as for an undated note: a
 * write puts the words in it; the date never changes; a day made through the
 * binding is written as that day's page, and one already there is refused
 * (`journal.duplicate`), never a second page for the day.
 */
export const DAY_MARK = "talaris:daily";
const DATE = /^\d{4}-\d{2}-\d{2}$/;
// Home, made if it is not yet: the project that is always there, and where the undated notes and daily notes are.
const homeId = () => ensureHome().id;
const daySource = (date: string) => ({ kind: "page", key: `${homeId()}/${DAILY}/${date}` });

function dayDates(): string[] {
  const home = homeId();
  if (!home) return [];
  const dir = join(pagesPlace(home).folder, WRITING, DAILY);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((n) => /^\d{4}-\d{2}-\d{2}\.md$/.test(n)).map((n) => n.slice(0, 10));
}

/** A day's entity brought up to date with its page — made, if it has none; `id` only when it is made. */
function mirrorDay(date: string, id?: string): Entity {
  let text = "";
  try { text = readPage(homeId(), `${DAILY}/${date}`); } catch { /* none yet */ }
  const type = typeFor("daily");
  const e = bySource(daySource(date));
  const props = { title: date, date, body: text };
  if (!e) return dayFiles(createEntity({ ...(id ? { id } : {}), type: type.id, properties: props, sources: [daySource(date)], "talaris:textElsewhere": true, [DAY_MARK]: date }), text);
  // An empty page's body is never kept (updateEntity drops ""), so none counts as empty: compared bare, an empty day
  // was written again on every reconcile, a new version each time — every write to it refused as stale, and every
  // reader of changes (the calendar) told of one, every few seconds.
  if (e.type === type.id && e.properties.date === date && String(e.properties.body ?? "") === text && e.properties.title === date && e[DAY_MARK] === date) return dayFiles(e, text);
  // The page's entity (its mentions' holder, made as a plain note) becomes the day's.
  return dayFiles(updateEntity(e.id, { type: type.id, properties: props, [DAY_MARK]: date }), text);
}

/** Where a type keeps its files: its first attachment field, by kind. */
const filesKey = (typeId: string | undefined): string | null => types().find((t) => t.id === typeId)?.fields.find((f) => f.kind === "attachment")?.key ?? null;

/** A day's files, as its page links them: each a link to the file where it is (links.ts), so a sync can carry it. */
function dayFiles(e: Entity, text: string): Entity {
  const key = filesKey(e.type);
  if (!key) return e;
  const paths: string[] = [];
  for (const rel of pageFiles(text)) {
    try { const f = attachedFile(homeId()!, rel); if (!f.sealed) paths.push(f.abs); } catch { /* gone, or not a file: not one of its files */ }
  }
  return setPageLinks(e.id, key, paths) ? getEntity(e.id) : e;
}

/**
 * The files a write says a day has: one it lacks filed in Home's Files and linked at the end of its page, as attaching
 * there does; one it has and the write does not name, its link taken out of the page — the file itself stays.
 */
function takeDayFiles(date: string, e: Entity, wanted: unknown): void {
  const key = filesKey(e.type);
  if (!key) return;
  const want = (Array.isArray(wanted) ? wanted : wanted ? [wanted] : [])
    .filter((a): a is { kind: string; sha256: string; filename?: string } => Boolean(a) && typeof a === "object" && (a as { kind?: string }).kind === "attachment" && typeof (a as { sha256?: unknown }).sha256 === "string");
  const wantSha = new Set(want.map((a) => a.sha256));
  let text = "";
  try { text = readPage(homeId(), `${DAILY}/${date}`); } catch { /* none yet */ }
  // Which file each link is, by the hash its link on the entity holds.
  const shaAt = new Map<string, string>();
  for (const v of (Array.isArray(e.properties[key]) ? e.properties[key] : []) as { sha256?: string; "talaris:link"?: { path: string } }[]) {
    if (v?.sha256 && v["talaris:link"]?.path) shaAt.set(v["talaris:link"].path, v.sha256);
  }
  const have = new Set<string>();
  for (const rel of pageFiles(text)) {
    let sha: string | undefined;
    try { sha = shaAt.get(attachedFile(homeId()!, rel).abs); } catch { /* gone */ }
    if (!sha) continue;
    if (wantSha.has(sha)) have.add(sha);
    else text = withoutFileLink(text, rel);
  }
  const added: string[] = [];
  for (const a of want) {
    if (have.has(a.sha256)) continue;
    have.add(a.sha256);
    const bytes = getFile(a.sha256) ?? linkedBytes(a.sha256);
    if (!bytes) continue;
    const put = putProjectFile(homeId()!, a.filename || "file", bytes);
    added.push(fileLinkText(put.name, put.path));
  }
  if (added.length) text = `${text.replace(/\s+$/, "")}${text.trim() ? "\n\n" : ""}${added.join(" ")}\n`;
  writePage(homeId(), `${DAILY}/${date}`, text);
}

/** Every daily note's entity as its page is; one whose page is gone, gone. */
export function reconcileDays(): void {
  const dates = new Set(dayDates());
  for (const d of dates) mirrorDay(d);
  for (const r of allRecords()) {
    const d = r.object[DAY_MARK];
    if (typeof d === "string" && !dates.has(d)) deleteEntity(r.object.id);
  }
}

export function isDay(id: string): boolean {
  try { return typeof getEntity(id)[DAY_MARK] === "string"; } catch { return false; }
}

/** A write through the binding to a day: its words, to its page. The date is its identity, and stays. */
export function writeDay(id: string, set: Record<string, unknown>, content: string | undefined): Entity {
  const date = getEntity(id)[DAY_MARK] as string;
  const words = typeof set.body === "string" ? set.body : "body" in set && set.body === null ? "" : content;
  if (words !== undefined) writePage(homeId(), `${DAILY}/${date}`, words);
  const key = filesKey(getEntity(id).type);
  if (key && key in set) takeDayFiles(date, mirrorDay(date), set[key]);
  return mirrorDay(date);
}

/** A day made through the binding: written as that day's page, at the id asked for — unless the day has one already. */
export function createDay(id: string, date: string, words: string, properties: Record<string, unknown> = {}): Entity {
  if (!DATE.test(date)) throw new Conflict("journal.date: a day is YYYY-MM-DD");
  if (dayDates().includes(date)) throw new Conflict(`journal.duplicate: ${date} has a daily note already`);
  writePage(homeId(), `${DAILY}/${date}`, words);
  const made = bySource(daySource(date));
  if (made && made.id !== id) deleteEntity(made.id);
  const e = mirrorDay(date, id);
  // Its files, as a write to it brings them: filed and linked in its page.
  const key = filesKey(e.type);
  if (!key || properties[key] === undefined) return e;
  takeDayFiles(date, e, properties[key]);
  return mirrorDay(date);
}

/** Every note's entity as its page is; any that stood for a page gone, gone (the feed says so). */
export function reconcileNotes(): void {
  reconcileDays();
  // Any note still at its old address: not moved into Home yet (pages-home.ts) — tidying now would take it for gone.
  if (allRecords().some((r) => r.object[MARK] === true && pageSource(r.object)?.key.startsWith(LEGACY))) {
    console.log("talaris-core: undated notes not yet moved into Home; not reconciled");
    return;
  }
  const places = allPlaces();
  const keys = new Set(places.map(keyOf));
  for (const at of places) mirror(at);
  for (const r of allRecords()) {
    const e = r.object;
    if (e[MARK] !== true) continue;
    const src = pageSource(e);
    if (src && keys.has(src.key)) continue;
    // Its page deleted: gone, as the feed will say.
    deleteEntity(e.id);
  }
}

/** Whether an entity is an undated note — written through to its file rather than kept in the store. */
export function isUndated(id: string): boolean {
  try { return getEntity(id)[MARK] === true; } catch { return false; }
}

/**
 * A write through the binding to an undated note: a title renames it where it
 * is; words — in the body field its type names, or `content` — are written to
 * its file. `content` is the patch's body, for a type that keeps words there.
 */
export function writeNote(id: string, set: Record<string, unknown>, content: string | undefined): Entity {
  const e = getEntity(id);
  let at = pageSource(e) ? placeOf(pageSource(e)!.key) : null;
  if (!at || e[MARK] !== true) throw new Error(`${id} is not a note`);
  // Its projects: kept as given; and if the one it lives in is not among them, its page moved to the first that is —
  // to the top of that project's writing — or, with none, among Home's Pages.
  const pk = projectKey(e.type);
  if (pk && pk in set) {
    const asked = (Array.isArray(set[pk]) ? (set[pk] as unknown[]) : set[pk] ? [set[pk]] : []).map(String);
    const workspaces = asked.map((x) => { try { return projectIdOf(getEntity(x)) ?? null; } catch { return null; } });
    const bad = asked.find((_, i) => !workspaces[i]);
    if (bad) throw new Conflict(`${bad} is not a Talaris project`);
    const here = livesIn(at);
    if (!here || !asked.includes(here)) {
      const to = (workspaces[0] as string | undefined) ?? null;
      if (to !== (unfiled(at) ? null : at.project)) {
        const node = transferPage(at.project, at.path, to ?? homeId(), to ? null : PAGES, false);
        at = { project: to ?? homeId(), path: node.path };
      }
    }
    // The rest kept on it: mirror puts the one it now lives in first.
    updateEntity(e.id, { properties: { [pk]: asked.length ? asked : null }, [LIVES]: livesIn(at) });
  }
  const key = titleKey(e.type);
  const title = typeof set[key] === "string" ? (set[key] as string).trim() : "";
  if (title && title !== titleOf(at.path)) {
    const parent = at.path.includes("/") ? at.path.slice(0, at.path.lastIndexOf("/")) : null;
    at = { project: at.project, path: movePage(at.project, at.path, parent, title).path };
  }
  const k = bodyKey(e.type);
  const words = k === "content" ? content : typeof set[k] === "string" ? (set[k] as string) : k in set && set[k] === null ? "" : undefined;
  if (words !== undefined) writePage(at.project, at.path, words);
  return mirror(at);
}

/**
 * A page's projects, for the writing drawer: the one it lives in first (none for Home's), then the rest, by the
 * entities standing for them; and set whole, as a write through the binding would (`writeNote`). Answers where the
 * page is now, which a move changes.
 */
export function pageProjects(projectId: string, path: string): string[] {
  const e = mirror({ project: projectId, path });
  const pk = projectKey(e.type);
  const v = pk ? e.properties[pk] : null;
  return Array.isArray(v) ? v.map(String) : v ? [String(v)] : [];
}
export function setPageProjects(projectId: string, path: string, projects: string[]): { project: string; path: string; projects: string[] } {
  const e = mirror({ project: projectId, path });
  const pk = projectKey(e.type);
  if (!pk) throw new Conflict("this note type keeps no project");
  const after = writeNote(e.id, { [pk]: projects.length ? projects : null }, undefined);
  const at = placeOf(pageSource(after)!.key)!;
  return { ...at, projects: pageProjects(at.project, at.path) };
}

/** Home's Pages folder, made if there is none yet: where an undated note is made. */
export function ensurePagesFolder(): void {
  const home = homeId();
  if (home) mkdirSync(join(pagesPlace(home, true).folder, WRITING, PAGES), { recursive: true });
}

/**
 * A note made through the binding: at the top of its project's writing — `project`, the entity standing for one —
 * or, with none, of Home's Pages; at the id asked for.
 */
export function createNote(id: string, title: string, content: string, project?: string | null): Entity {
  let to: string | null = null;
  if (project) { try { to = projectIdOf(getEntity(project)) ?? null; } catch { to = null; } }
  if (!to) ensurePagesFolder();
  const where = to ?? homeId();
  const page = createPage(where, to ? null : PAGES, title);
  if (content) writePage(where, page.path, content);
  const at = { project: where, path: page.path };
  // Made by the page calls above with an id of their own, if it mentions anything: given the one asked for instead.
  const made = bySource(sourceOf(at));
  if (made && made.id !== id) deleteEntity(made.id);
  return mirror(at, id);
}
