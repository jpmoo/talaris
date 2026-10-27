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
import { allRecords, bySource, titleOf, types, updateEntity, type Entity } from "./entities.js";
import { morganDescribeProject } from "./morgan-describe.js";
import { STATE_DIR } from "./paths.js";
import { listProjects } from "./projects.js";
import { readJson, writeJson } from "./store.js";
import { isComplete, shapeOf } from "./tasks.js";

export const BY_MORGAN = "talaris:describedByMorgan";
const NOTHING_SAID = () => join(STATE_DIR, "project-descriptions.json");

/** Where a project's type keeps its description: its `project` profile's body. */
function bodyKey(o: Entity): string | null {
  const body = types().find((t) => t.id === o.type)?.profiles?.project?.body;
  return typeof body === "string" ? body : null;
}
const said = (v: unknown) => (typeof v === "string" ? v.trim() !== "" : v != null && JSON.stringify(v) !== "{}" && JSON.stringify(v) !== "[]");

/** A project's tasks, as Morgan is told them: still to do, then done; each its title and the start of its notes. "" for none. */
export function projectTasksText(projectEntity: string): string {
  const refs = new Map(types().map((t) => [t.id, t.fields.filter((f) => f.kind === "reference").map((f) => f.key)]));
  const todo: string[] = [], done: string[] = [];
  for (const { object: o } of allRecords()) {
    if (o.archived || o.stub) continue;
    const shape = shapeOf(o);
    if (!shape) continue;
    // Filed under it by the slot its type names for a task's project; a type naming none, by any reference.
    const slot = shape.type.profiles?.task?.project;
    const filed = (typeof slot === "string" ? [slot] : refs.get(o.type ?? "") ?? []).some((k) => [o.properties[k]].flat().includes(projectEntity));
    if (!filed) continue;
    const bodyAt = shape.type.profiles?.task?.body;
    const notes = typeof bodyAt === "string" && typeof o.properties[bodyAt] === "string" ? (o.properties[bodyAt] as string).replace(/\s+/g, " ").trim().slice(0, 300) : "";
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
    const e = bySource({ kind: "talaris-project", key: p.id });
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
