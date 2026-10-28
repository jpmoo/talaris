// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore

import { bySource, findEntities, getEntity, profilesOf, types, type Entity, type EntityType } from "./entities.js";
import { NotFound, ensureHome, listProjects } from "./projects.js";

/**
 * What is filed under which project, decided once.
 *
 * **A Talaris project and its entity.** Every project in use but Home has an
 * entity standing for it (tasks.ts, `taskProjects`), known by its source —
 * `talaris-project`, the project's id — so either is found from the other
 * here, and nowhere by walking sources by hand.
 *
 * **Filed under.** A thing is filed under the project entities its type says
 * it is: the `project` slot a profile of its type names, where one does; a
 * type naming none, any reference field, where it points at a project. Only
 * references count — never an id found somewhere in its words.
 */

export const PROJECT_SOURCE = "talaris-project";

/** The entity standing for a Talaris project, by the project's id. */
export function projectEntity(projectId: string): Entity | null {
  return bySource({ kind: PROJECT_SOURCE, key: projectId });
}

/** The Talaris project an entity stands for, by its id; none for a project only the store knows. */
export function projectIdOf(o: Entity): string | undefined {
  const sources = Array.isArray(o["talaris:sources"]) ? (o["talaris:sources"] as { kind: string; key: string }[]) : [];
  return sources.find((s) => s.kind === PROJECT_SOURCE)?.key;
}

const typeOf = (o: Entity) => types().find((t) => t.id === o.type);

/** The fields a type files under: the `project` slot its profiles name, else every reference field. */
function filingKeys(t: EntityType | undefined): string[] {
  if (!t) return [];
  const declared = [...new Set(Object.values(t.profiles ?? {}).map((p) => p?.project).filter((k): k is string => typeof k === "string"))];
  return declared.length ? declared : t.fields.filter((f) => f.kind === "reference").map((f) => f.key);
}

function isProject(id: string): boolean {
  try { return profilesOf(getEntity(id)).includes("project"); } catch { return false; }
}

/** The project entities a thing is filed under, in the order it holds them. */
export function filedUnder(o: Entity): string[] {
  const out: string[] = [];
  for (const key of filingKeys(typeOf(o))) {
    const v = o.properties[key];
    for (const ref of Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]) {
      if (typeof ref === "string" && !out.includes(ref) && isProject(ref)) out.push(ref);
    }
  }
  return out;
}

/** A thing taken out of one project wherever it is filed under it: the properties that change, or null if it was not. */
export function unfile(o: Entity, projectEntityId: string): Record<string, unknown> | null {
  const patch: Record<string, unknown> = {};
  for (const key of filingKeys(typeOf(o))) {
    const v = o.properties[key];
    if (Array.isArray(v) && v.includes(projectEntityId)) {
      const rest = v.filter((x) => x !== projectEntityId);
      patch[key] = rest.length ? rest : null;
    } else if (v === projectEntityId) patch[key] = null;
  }
  return Object.keys(patch).length ? patch : null;
}

/**
 * The one field a thing of this type is filed under by, to write: the slot a
 * profile names, else the first reference field whose target is a project
 * type. None, it cannot be filed.
 */
export function filingKey(t: EntityType | undefined): string | null {
  if (!t) return null;
  const declared = Object.values(t.profiles ?? {}).map((p) => p?.project).find((k): k is string => typeof k === "string");
  if (declared) return declared;
  const projectTypes = new Set(types().filter((x) => x.profiles?.project || x["talaris:role"] === "project").map((x) => x.id));
  return t.fields.find((f) => f.kind === "reference" && f.targetType && projectTypes.has(f.targetType))?.key ?? null;
}

/** The project things are filed under, written: the field holding exactly these (none, cleared). */
export function filingPatch(t: EntityType | undefined, ids: string[]): Record<string, unknown> {
  const key = filingKey(t);
  if (!key) return {};
  const many = t?.fields.find((f) => f.key === key)?.many !== false;
  return { [key]: ids.length ? (many ? ids : ids[0]) : null };
}

/**
 * The Talaris project of the first project a thing is filed under that has a
 * folder; none, Home's (ensureHome: Home is always there, made if it is not).
 */
export function folderProjectOf(o: Entity): string {
  for (const id of filedUnder(o)) {
    const ws = projectIdOf(getEntity(id));
    if (ws) return ws;
  }
  return ensureHome().id;
}

// ------------------------------------------------------------ a project by its name

export interface ProjectMatch {
  /** The Talaris project — a folder — where it is one. */
  id?: string;
  name: string;
  code?: string;
  home?: boolean;
  /** The entity tasks are filed under, where it has one (Home has none). */
  entity?: string;
  archived?: boolean;
}

/** Asked for by these, Home: the pages of no other project are Home's. */
const HOME_WORDS = ["notes", "unaffiliated", "home"];

/**
 * A project as a person or Morgan names it: by its id or its entity's id,
 * then its code, then its exact name (any case), then part of a name.
 * "notes", "unaffiliated" and "home" are Home; so is none at all. Both of
 * Talaris's MCP tool sets ask this, so a name means one project to both.
 */
export function resolveProject(name: string): ProjectMatch {
  const n = name.trim();
  const l = n.toLowerCase();
  const home = ensureHome();
  const homeMatch: ProjectMatch = { id: home.id, name: home.name, code: home.code, home: true };
  if (!n || HOME_WORDS.includes(l)) return homeMatch;
  const all: ProjectMatch[] = listProjects().map((p) => {
    const e = p.home ? null : projectEntity(p.id);
    return { id: p.id, name: p.name, code: p.code, ...(p.home ? { home: true } : {}), ...(e ? { entity: e.id } : {}) };
  });
  const had = new Set(all.map((c) => c.entity));
  // Projects only the store knows (or archived with their folder): found for their tasks, with no folder to open.
  for (const s of findEntities({ kind: "project", limit: 1000, archived: true })) {
    if (had.has(s.id)) continue;
    const e = getEntity(s.id);
    all.push({ name: s.title, entity: s.id, ...(e.archived ? { archived: true } : {}) });
  }
  const hit = all.find((c) => c.id === n || c.entity === n)
    ?? all.find((c) => c.code?.toLowerCase() === l)
    ?? all.find((c) => c.name.toLowerCase() === l)
    ?? all.find((c) => c.name.toLowerCase().includes(l));
  if (!hit) throw new NotFound(`no project called ${n}; there are ${all.filter((c) => !c.archived).map((c) => c.name).join(", ")}`);
  return hit;
}
