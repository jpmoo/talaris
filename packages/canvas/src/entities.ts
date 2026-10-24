/*
 * Entities, as the canvas sees them.
 *
 * A note on a canvas can stand for a person, an event, a task, a note or a
 * project that lives in the core — DESIGN.md, "Entities": "Its card keeps the
 * entity's id; it is the entity shown on that canvas". The card stores the id
 * under `entity` and nothing else, so everything here is a question asked of
 * the core through `ask`, and the answers are kept per id so a canvas of forty
 * people is forty questions once rather than forty on every render.
 *
 * **What something is comes from `kinds`, never from a type's name.** A type is
 * the user's to rename; its profile is what says "this is a person". The same
 * rule the format states as "`if (type.name === "Task")` is a bug".
 */
import { ask } from "./api.ts";

export interface Summary {
  id: string;
  title: string;
  /** Profile names: `contact`, `event`, `task`, `note`, `project`. */
  kinds: string[];
  type?: string;
  stub?: boolean;
}

export interface Connection {
  by: "field" | "relation";
  name: string;
  via?: string;
  entity: Summary;
}

export interface Detail {
  entity: Record<string, unknown>;
  title: string;
  kinds: string[];
  out: Connection[];
  in: Connection[];
}

/** What "Make it" offers, in the core's words for each. */
export type Role = "person" | "event" | "task" | "note" | "project";
export const ROLES: { role: Role; label: string }[] = [
  { role: "note", label: "Note" },
  { role: "person", label: "Person" },
  { role: "event", label: "Event" },
  { role: "task", label: "Task" },
  { role: "project", label: "Project" },
];

/*
 * Summaries, cached as promises.
 *
 * A promise rather than a value so that two notes naming the same person, drawn
 * in the same frame, ask once between them. A failure is remembered as `null`
 * — an entity that is gone draws as a plain note — and forgotten by `forget`,
 * which is what a link or a make calls when it knows better.
 */
const summaries = new Map<string, Promise<Summary | null>>();

export function summaryOf(id: string): Promise<Summary | null> {
  let had = summaries.get(id);
  if (!had) {
    had = entityDetail(id).then(
      (d) => ({ id, title: d.title, kinds: d.kinds }),
      () => null,
    );
    summaries.set(id, had);
  }
  return had;
}

/** Put what is already known in the cache, so it is not asked for again. */
export function remember(s: Summary) {
  summaries.set(s.id, Promise.resolve(s));
}

export function forget(id: string) {
  summaries.delete(id);
}

export const findEntities = (q: string, kind?: string) => {
  const p = new URLSearchParams({ q, limit: "20" });
  if (kind) p.set("kind", kind);
  return ask<Summary[]>("GET", `/entities?${p}`);
};

export const entityDetail = (id: string) => ask<Detail>("GET", `/entities/${encodeURIComponent(id)}`);

export const connectEntities = (from: string, to: string) =>
  ask<Connection>("POST", `/entities/${encodeURIComponent(from)}/connect`, { to });

/** A note's first line, without the markdown that dresses it. */
export function firstLine(text: string): string {
  const line = text.split("\n").find((l) => l.trim()) ?? "";
  return line.replace(/^\s*(#+|[-*+]\s+\[[ xX]\]|[-*+]|>)\s*/, "").trim();
}

/*
 * A note's text, made into an entity of the role asked for.
 *
 * The first line is the title, which is what a person, an event, a task or a
 * project is called. A note keeps its whole text as its body, and takes the
 * first line as a title only when it is short enough to be one — a note that
 * opens with a paragraph is not titled by that paragraph.
 */
export async function makeEntity(role: Role, text: string): Promise<Summary> {
  const title = firstLine(text);
  const properties: Record<string, unknown> =
    role === "note" ? { body: text, ...(title && title.length <= 80 ? { title } : {}) } : { title };
  const made = await ask<{ id: string }>("POST", "/entities", { role, properties });
  // Read back rather than guessed: which profile the new type carries is the
  // core's to say, not this menu's.
  forget(made.id);
  return (await summaryOf(made.id)) ?? { id: made.id, title, kinds: [] };
}
