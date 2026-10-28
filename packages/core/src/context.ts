// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore

/**
 * Context for whatever was typed (DESIGN, *Launcher*): not only the things
 * whose words hold it, but, for the ones it plainly names, everything they
 * touch. "Rich" is Rich Gelson and Rich Wiener, and with each the tasks that
 * mention him, the notes about him, the meetings he was at — whether or not
 * those say "Rich" anywhere. The launcher draws it; Morgan reads it
 * (talaris_context).
 *
 * One step out, both ways (entities.connections): a person's events and the
 * notes and tasks that point at them; a project's tasks; an event's people.
 */

import { bySource, connections, findEntities, getEntity, kindOfEntity, titleOf, types, type Entity } from "./entities.js";
import { readSlot } from "./profile.js";
import { placeOf, placeSource } from "./mentionables.js";
import { currentId, homeId, threads } from "./threads.js";
import { isComplete, shapeOf, spanOf } from "./tasks.js";

export type Kind = "person" | "task" | "note" | "event" | "project" | "conversation" | "thing";

export interface Item {
  id: string;
  title: string;
  kind: Kind;
  /** A task's due date and whether it is complete. */
  due?: string;
  done?: boolean;
  /** An event's start, and the calendar it can be opened on. */
  start?: string;
  allDay?: boolean;
  calendar?: string;
  uid?: string;
  /** One of Morgan's threads (threads.ts): its id, to open the conversation by. */
  thread?: string;
  /** A note's page: its project and path. */
  project?: string;
  path?: string;
  updated?: string;
}

/** Something connected to a named thing, and how: "mentions", "attendees", "project". */
export interface Related extends Item { how: string; incoming: boolean }

export interface Context {
  query: string;
  hits: Item[];
  about: { focus: Item; related: Related[]; more: number }[];
}

// Who is asked about first: a person or project named is more often the point than a task with the name in it.
const ORDER: Kind[] = ["person", "project", "event", "note", "task", "conversation", "thing"];
const FOCUSES = 4;
const RELATED = 15;

/**
 * An event's start through its type's `event` profile; all day by its type's
 * one yes-or-no field — the format names no slot for that, so the field is
 * found by its kind, never by its name.
 */
function eventTimes(o: Entity): { start?: string; allDay?: boolean } {
  const type = types().find((t) => t.id === o.type);
  const start = readSlot(type, o, "start", "event");
  const flags = type?.fields.filter((f) => f.kind === "boolean") ?? [];
  const allDay = flags.length === 1 && o.properties[flags[0]!.key] === true;
  return { ...(typeof start === "string" ? { start } : {}), ...(allDay ? { allDay } : {}) };
}

export function item(o: Entity): Item {
  const kind: Kind = kindOfEntity(o);
  const it: Item = { id: o.id, title: titleOf(o), kind, ...(o.updated ? { updated: String(o.updated) } : {}) };
  if (kind === "task") {
    const shape = shapeOf(o);
    const span = spanOf(o, shape);
    if (span.due) it.due = span.due;
    it.done = isComplete(o, shape);
  } else if (kind === "event") {
    Object.assign(it, eventTimes(o));
    const src = ((o["talaris:sources"] as { kind: string; key: string }[] | undefined) ?? []).find((s) => s.kind === "eds-event");
    const at = src ? src.key.indexOf("/") : -1;
    if (src && at > 0) { it.calendar = src.key.slice(0, at); it.uid = src.key.slice(at + 1); }
  }
  const place = placeOf(o);
  if (place?.kind === "page") { it.project = place.project; it.path = place.where; }
  if (place?.kind === "thread") { it.kind = "conversation"; it.thread = currentId(place.where); }
  return it;
}

const escape = (w: string) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Every word typed is a whole word of the title: "Rich" names Rich Gelson, not Max Richter. */
const names = (title: string, words: string[]) =>
  words.length > 0 && words.every((w) => new RegExp(`(^|[^\\p{L}\\p{N}])${escape(w)}($|[^\\p{L}\\p{N}])`, "iu").test(title));

// What is still to come or still open first, then the rest, newest first; done tasks last.
function weigh(r: Related, now: number): number[] {
  const ahead = r.kind === "event" && r.start ? Date.parse(r.start) >= now : false;
  const open = r.kind === "task" && !r.done;
  return [open || ahead ? 0 : r.kind === "task" ? 2 : 1, ahead ? Date.parse(r.start!) : -(Date.parse(r.updated ?? r.start ?? "") || 0)];
}

export function contextFor(query: string, options: { limit?: number } = {}): Context {
  const q = query.trim().replace(/\s+/g, " ");
  if (!q) return { query: q, hits: [], about: [] };
  const words = q.toLowerCase().split(" ");
  const hits = findEntities({ q, limit: options.limit ?? 20 }).map((s) => item(getEntity(s.id)));
  // Morgan's threads whose titles hold every word: the conversations about it (those tied to something are entities, above).
  const had = new Set(hits.map((h) => h.thread).filter(Boolean));
  for (const t of threads()) {
    if (had.has(t.id) || !words.every((w) => t.title.toLowerCase().includes(w))) continue;
    const e = bySource(placeSource("thread", homeId(), t.id));
    hits.push(e ? item(e) : { id: `thread:${t.id}`, title: t.title, kind: "conversation", thread: t.id, updated: new Date(t.t1).toISOString() });
    if (hits.length >= (options.limit ?? 20) + 5) break;
  }
  const named = hits.filter((h) => names(h.title, words) && !h.id.startsWith("thread:"))
    .sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind))
    .slice(0, FOCUSES);
  const now = Date.now();
  const about = named.map((focus) => {
    const c = connections(focus.id);
    const seen = new Set([focus.id]);
    const related: Related[] = [];
    for (const [list, incoming] of [[c.out, false], [c.in, true]] as const) {
      for (const k of list) {
        if (seen.has(k.entity.id)) continue;
        seen.add(k.entity.id);
        related.push({ ...item(getEntity(k.entity.id)), how: k.name, incoming });
      }
    }
    related.sort((a, b) => {
      const [x, y] = [weigh(a, now), weigh(b, now)];
      return x[0]! - y[0]! || x[1]! - y[1]!;
    });
    return { focus, related: related.slice(0, RELATED), more: Math.max(0, related.length - RELATED) };
  });
  return { query: q, hits, about };
}
