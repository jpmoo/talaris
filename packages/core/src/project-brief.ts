// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore
//
// A project's brief: what a project chat (heymorgan's projects.mjs, through Talaris's bridge) is told at each turn,
// from Talaris — which has the projects, tasks and people, with or without Hermes. The project itself (its About and
// what Talaris has worked out it is about), its open tasks with their notes, the people those tasks name, and the
// rest of the day it is weighed against: what is due today and overdue across every project. Today's calendar is
// added by the surfaces, which read the calendars (calendar_panel.py).
//
// Plain text, for a model to read. Read where each type keeps things (tasks' shape, people's rows); nothing by a
// type's name.

import { connections, getEntity, listPeople, type Entity } from "./entities.js";
import { canvasTree } from "./canvases.js";
import { glance } from "./glance.js";
import { pageTree } from "./pages.js";
import { projectEntity } from "./filing.js";
import { findTasks, showProject, type Row } from "./lists.js";
import { localDate } from "./localtime.js";
import { mentionsIn, plain } from "./mentions.js";
import { projectAbout, projectProfile } from "./project-describe.js";
import { NotFound, listProjects } from "./projects.js";
import { notesOf } from "./tasks.js";

/** A task's notes, at most this long in the brief. */
const NOTES_MAX = 700;
/** Tasks of the project in the brief, at most. */
const TASKS_MAX = 60;

const line = (r: Row, withProject = false): string => {
  const bits = [r.due ? `due ${r.due}` : "", r.start ? `from ${r.start}` : "", r.overdue ? "OVERDUE" : "", r.status ? `status ${r.status}` : "",
    r.tags?.length ? `tags ${r.tags.join(", ")}` : "", withProject && r.projects?.length ? `in ${r.projects.map((p) => p.title).join(", ")}` : ""].filter(Boolean);
  return `- ${plain(r.title)}${bits.length ? ` (${bits.join("; ")})` : ""}`;
};

const words = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "");

export function projectBrief(projectId: string): { id: string; name: string; text: string } {
  const project = listProjects().find((p) => p.id === projectId);
  if (!project) throw new NotFound(`no project ${projectId}`);
  const out: string[] = [`Project: ${project.name}`];
  const safely = <T>(f: () => T, fallback: T): T => { try { return f(); } catch { return fallback; } };
  const about = safely(() => projectAbout(projectId), null);
  if (about?.about) out.push("", "About it:", about.about.trim());
  const profile = safely(() => projectProfile(projectId), null);
  if (profile?.summary) out.push("", "What Talaris has worked out it is about:", profile.summary.trim());

  // What it holds: its pages, its canvases, the files in its folder — each read whole with the desktop's tools.
  type Node = { title: string; path?: string; id?: string; starred?: boolean; children: Node[] };
  const tree = (nodes: Node[], depth = 0, max = { left: 80 }): string[] => nodes.flatMap((n) => {
    if (max.left-- <= 0) return [];
    return [`${"  ".repeat(depth)}- ${n.title}${n.starred ? " ★" : ""}${n.path ? `  (path: ${n.path})` : n.id ? `  [${n.id}]` : ""}`, ...tree(n.children ?? [], depth + 1, max)];
  });
  const pages = safely(() => pageTree(projectId) as unknown as Node[], []);
  out.push("", "Its writing pages (read one with talaris_page_read):", ...(pages.length ? tree(pages) : ["(none)"]));
  const canvas = safely(() => canvasTree(projectId) as unknown as Node, null);
  out.push("", "Its canvases (read one with talaris_canvas_read):", ...(canvas ? tree([canvas]) : ["(none)"]));
  const files = safely(() => glance(projectId, 1).nodes.filter((n) => n.kind === "file" && n.own).map((n) => n.path ?? n.title ?? ""), [] as string[]).filter(Boolean);
  out.push("", `Files in its folder (${files.length}):`, ...(files.length ? files.slice(0, 40).map((f) => `- ${f}`) : ["(none)"]), ...(files.length > 40 ? [`- …and ${files.length - 40} more`] : []));

  // Its open tasks, in the order they are kept, each with its notes.
  const entity = projectEntity(projectId);
  const rows = entity ? safely(() => showProject(entity.id).rows, [] as Row[]).filter((r) => !r.complete) : [];
  const texts: string[] = [];
  const named = new Set<string>();
  out.push("", rows.length ? `Its open tasks (${rows.length}):` : "Its open tasks: none.");
  for (const r of rows.slice(0, TASKS_MAX)) {
    out.push(line(r));
    const o = safely(() => getEntity(r.id) as Entity, null);
    const notes = o ? notesOf(o).trim() : "";
    if (notes) {
      for (const m of mentionsIn(notes)) named.add(m.id);
      const said = plain(notes).replace(/\s+\n/g, "\n");
      out.push(`  Notes: ${said.length > NOTES_MAX ? `${said.slice(0, NOTES_MAX)}…` : said}`.replace(/\n/g, "\n  "));
    }
    for (const m of mentionsIn(r.title)) named.add(m.id);
    texts.push(words(`${plain(r.title)}\n${plain(notes)}`));
  }
  if (rows.length > TASKS_MAX) out.push(`- …and ${rows.length - TASKS_MAX} more`);

  // The people the tasks name: by a mention, or by their full name written out.
  const all = texts.join("\n");
  const people = safely(() => listPeople(), []).filter((p) => {
    if (named.has(p.id)) return true;
    const name = words(p.title);
    if (!/\s/.test(name) || name.length < 5 || name.includes("@")) return false;
    return new RegExp(`(^|[^\\p{L}])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^\\p{L}]|$)`, "u").test(all);
  });
  if (people.length) {
    out.push("", "People its tasks name (from People):");
    for (const p of people.slice(0, 30)) {
      const bits = [p.role, p.organization, p.email].filter(Boolean);
      out.push(`- ${p.title}${bits.length ? ` — ${bits.join(", ")}` : ""}`);
    }
  }

  // What is tied to it from elsewhere: a daily note or a page that names it (@), a person or an event about it — every
  // link into the project but tasks filed under it (its own; the open ones are above).
  if (entity) {
    const own = new Set(rows.map((r) => r.id));
    const tied = safely(() => connections(entity.id).in, [] as ReturnType<typeof connections>["in"])
      .filter((c) => !own.has(c.entity.id) && !(c.by === "field" && (c.entity.kinds ?? []).includes("task")));
    if (tied.length) {
      out.push("", "Tied to it from elsewhere:");
      for (const c of tied.slice(0, 40)) {
        const o = safely(() => getEntity(c.entity.id) as Entity, null);
        const said = o ? plain(String(o.content ?? notesOf(o) ?? "")).replace(/\s+/g, " ").trim() : "";
        out.push(`- ${plain(c.entity.title ?? "")} (${(c.entity.kinds ?? []).join("/") || "thing"}, by ${c.name ?? c.by})${said ? `: ${said.slice(0, 300)}${said.length > 300 ? "…" : ""}` : ""}`);
      }
    }
  }

  // The rest of the day: what is due today and overdue, every project.
  const today = localDate();
  const due = safely(() => findTasks({ when: "today", limit: 40 }), [] as Row[]).filter((r) => !r.overdue);
  const overdue = safely(() => findTasks({ when: "overdue", limit: 40 }), [] as Row[]);
  out.push("", `Due today (${today}), across every project:`, ...(due.length ? due.map((r) => line(r, true)) : ["(nothing)"]));
  out.push("", "Overdue, across every project:", ...(overdue.length ? overdue.map((r) => line(r, true)) : ["(nothing)"]));
  return { id: projectId, name: project.name, text: out.join("\n") };
}
