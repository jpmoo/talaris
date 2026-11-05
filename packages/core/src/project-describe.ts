// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore

/**
 * A project with no description given one by Morgan (DESIGN, *A project
 * described by its tasks*), from its tasks — those done and those still to
 * do, each with its notes. Nothing else: a project with no tasks is not
 * described, and that is all right. Written where the project's type keeps
 * its description (its `project` profile's `body`), so it is the project's
 * description everywhere — Tasks, Library, Glance, and Hermes Notes through
 * the sync — and it is what the project is found and suggested by.
 *
 * Only an empty one is written. Cleared by hand, it is written again from the
 * tasks as they are then; one written over by hand is yours, and stays. What
 * Morgan wrote is kept beside it (`talaris:describedByMorgan`), so it can be
 * told as Morgan's. A project Morgan found nothing to say of is not asked
 * again until its tasks change.
 */

import { createHash } from "node:crypto";
import { join } from "node:path";
import { allRecords, titleOf, types, updateEntity, type Entity } from "./entities.js";
import { filedUnder, projectEntity as entityFor } from "./filing.js";
import { indexed } from "./meaning.js";
import { profileOf } from "./project-profile.js";
import { morganDescribeProject } from "./morgan-describe.js";
import { STATE_DIR } from "./paths.js";
import { listProjects } from "./projects.js";
import { readJson, writeJson } from "./store.js";
import { isComplete, notesOf, shapeOf } from "./tasks.js";

export const BY_MORGAN = "talaris:describedByMorgan";
/** What Morgan finds a project to be about, kept for Talaris's own use, written over as the project changes; what it was read from, and when. */
export const SUMMARY = "talaris:summary";
const SUMMARY_OF = "talaris:summaryOf", SUMMARY_AT = "talaris:summaryAt";
const SUMMARY_EVERY_MS = 24 * 60 * 60 * 1000;
const NOTHING_SAID = () => join(STATE_DIR, "project-descriptions.json");

/** Where a project's type keeps its description: its `project` profile's body. */
function bodyKey(o: Entity): string | null {
  const body = types().find((t) => t.id === o.type)?.profiles?.project?.body;
  return typeof body === "string" ? body : null;
}
const said = (v: unknown) => (typeof v === "string" ? v.trim() !== "" : v != null && JSON.stringify(v) !== "{}" && JSON.stringify(v) !== "[]");

/** A project's tasks, as Morgan is told them: still to do, then done; each its title and the start of its notes. "" for none. */
export function projectTasksText(projectEntity: string): string {
  const todo: string[] = [], done: string[] = [];
  for (const { object: o } of allRecords()) {
    if (o.archived || o.stub) continue;
    const shape = shapeOf(o);
    if (!shape || !filedUnder(o).includes(projectEntity)) continue;
    const notes = notesOf(o, shape).replace(/\s+/g, " ").trim().slice(0, 300);
    (isComplete(o, shape) ? done : todo).push(`- ${titleOf(o)}${notes ? ` — ${notes}` : ""}`);
  }
  return [todo.length ? `Still to do:\n${todo.join("\n")}` : "", done.length ? `Done:\n${done.join("\n")}` : ""].filter(Boolean).join("\n\n");
}

/** Each project with no description and some tasks, described by Morgan. Answers how many; stops when Morgan cannot be asked. */
export async function describeProjects(): Promise<{ described: number; morganAway?: boolean }> {
  let nothing: Record<string, string> = {};
  try { nothing = readJson<Record<string, string>>(NOTHING_SAID()); } catch { /* none yet */ }
  let described = 0;
  for (const p of listProjects()) {
    if (p.home) continue;
    const e = entityFor(p.id);
    const key = e && bodyKey(e);
    if (!e || !key || said(e.properties[key])) continue;
    const text = projectTasksText(e.id);
    if (!text) continue;
    const hash = createHash("sha256").update(text).digest("hex").slice(0, 16);
    if (nothing[p.id] === hash) continue;
    const about = await morganDescribeProject(text, p.name);
    if (about === null) return { described, morganAway: true };
    if (!about) { nothing[p.id] = hash; writeJson(NOTHING_SAID(), nothing); continue; }
    updateEntity(e.id, { properties: { [key]: about }, [BY_MORGAN]: about });
    described++;
  }
  return { described };
}

/** What a project holds, as Morgan is told it: its tasks, then what else is in it, by name, and its telling words. */
function projectMaterial(projectId: string, e: Entity): string {
  const profile = profileOf(projectId);
  const names: string[] = [];
  for (const key of profile?.members ?? []) {
    const doc = indexed(key);
    if (doc && doc.kind !== "task" && doc.title) names.push(`- ${doc.title} (${doc.kind})`);
  }
  return [projectTasksText(e.id), names.length ? `Also in it:\n${names.slice(0, 80).join("\n")}` : "", profile?.keywords.length ? `Words it often uses: ${profile.keywords.join(", ")}` : ""].filter(Boolean).join("\n\n");
}

/**
 * Each project's summary, for Talaris's own use and never shown as its description: written by Morgan
 * from all it holds, and again when that has changed, at most once a day. Answers how many; stops when Morgan cannot be asked.
 */
export async function summarizeProjects(): Promise<{ summarized: number; morganAway?: boolean }> {
  let summarized = 0;
  for (const p of listProjects()) {
    if (p.home) continue;
    const e = entityFor(p.id);
    if (!e) continue;
    const text = projectMaterial(p.id, e);
    if (!text) continue;
    const hash = createHash("sha256").update(text).digest("hex").slice(0, 16);
    if (e[SUMMARY_OF] === hash) continue;
    if (e[SUMMARY] && Date.now() - Date.parse(String(e[SUMMARY_AT] ?? 0)) < SUMMARY_EVERY_MS) continue;
    const about = await morganDescribeProject(text, p.name);
    if (about === null) return { summarized, morganAway: true };
    updateEntity(e.id, { [SUMMARY]: about, [SUMMARY_OF]: hash, [SUMMARY_AT]: new Date().toISOString() });
    summarized++;
  }
  return { summarized };
}

/** What Talaris has come to know of a project, for its card. */
export function projectProfile(projectId: string): { keywords: string[]; summary: string; things: number } {
  const profile = profileOf(projectId);
  const e = entityFor(projectId);
  return { keywords: profile?.keywords ?? [], summary: e && typeof e[SUMMARY] === "string" ? e[SUMMARY] as string : "", things: profile?.members.size ?? 0 };
}

/** A project's description as the Library shows it: whose it is, and whether it can be written at all (Home has none). */
export function projectAbout(projectId: string): { entity?: string; about: string; aboutByYou: boolean; can: boolean } {
  const e = entityFor(projectId);
  const key = e && bodyKey(e);
  if (!e || !key) return { about: "", aboutByYou: false, can: false };
  const v = e.properties[key];
  const about = typeof v === "string" ? v : "";
  return { entity: e.id, about, aboutByYou: Boolean(about) && about !== e[BY_MORGAN], can: true };
}

/** Written by the person: theirs from now on. Cleared, it is Morgan's to write again from the tasks. */
export function setProjectAbout(projectId: string, about: string): ReturnType<typeof projectAbout> {
  const e = entityFor(projectId);
  const key = e && bodyKey(e);
  if (!e || !key) throw new Error("this project keeps no description");
  updateEntity(e.id, { properties: { [key]: about.trim() || null }, [BY_MORGAN]: null });
  return projectAbout(projectId);
}
