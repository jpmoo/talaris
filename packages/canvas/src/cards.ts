// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore

/*
 * Entity cards, as data.
 *
 * A card (`kind: "card"`) shows an entity from the core live: its title, and
 * whatever its profile says is worth a glance — a task's status and due date,
 * an event's time and place, a person's email. Everything here is a question
 * asked of the core, kept per id, so forty cards of the same person are one
 * question and a redraw is none.
 *
 * Asked again only when the canvas document is read again (`refreshCards`,
 * from `main.tsx`) or when a card has just changed its own entity. Never on a
 * timer: a canvas left open all day should cost nothing while nobody is
 * looking at it.
 *
 * **What a card shows comes from `kinds`, never from a type's name.** The same
 * rule `entities.ts` keeps.
 */
import { useEffect, useReducer, useState } from "react";
import { ask, keepSeen } from "./api.ts";
import { entityDetail, type Detail } from "./entities.ts";

/** The profiles a card knows how to draw, most particular first. */
const DRAWN = ["task", "event", "contact", "note"];

/** Which of an entity's profiles a card is drawn by. */
export function cardKind(kinds: string[]): string {
  return DRAWN.find((k) => kinds.includes(k)) ?? kinds[0] ?? "note";
}

/** What a card is drawn from: the core's answer, or word that it is gone. */
export type CardData = Detail | "gone";

const details = new Map<string, CardData>();
const asked = new Map<string, number>();
let generation = 0;

/*
 * Who is listening. `null` is "everything may have changed" — the document was
 * read again — and an id is "this one has an answer".
 */
type Heard = (id: string | null) => void;
const heard = new Set<Heard>();
const announce = (id: string | null) => heard.forEach((h) => h(id));

/** The canvas was read again: every card asks once more. */
export function refreshCards() {
  generation++;
  shapeAsked = null;
  announce(null);
}

/*
 * One question per id per reading. Two cards of the same entity mounting in
 * the same frame, or StrictMode mounting one twice, ask once between them.
 */
function fetchDetail(id: string, again = false) {
  if (!again && asked.get(id) === generation) return;
  asked.set(id, generation);
  entityDetail(id).then(withWords).then(
    (d) => {
      details.set(id, d);
      keepSeen(id, { title: d.title, kind: cardKind(d.kinds) });
      announce(id);
    },
    (err) => {
      /*
       * Gone only when the core says so. Any other failure — the core
       * restarting, a bridge hiccup — leaves whatever was drawn last, because
       * "gone" on a card that is merely unreachable is a lie about somebody's
       * data.
       */
      if (/^no entity/.test(String((err as Error)?.message ?? err))) {
        details.set(id, "gone");
        announce(id);
      }
    },
  );
}

/*
 * A page's entity keeps its words where the page is (`talaris:textElsewhere`):
 * for its card, they are read from the page, so the card shows what it says.
 */
async function withWords(d: Detail): Promise<Detail> {
  const e = d.entity as { id?: string; properties?: Record<string, unknown>; "talaris:textElsewhere"?: boolean };
  if (!e["talaris:textElsewhere"] || !e.id) return d;
  const place = await ask<{ kind: string; project: string; where: string } | null>("GET", `/entities/${encodeURIComponent(e.id)}/place`).catch(() => null);
  // One of Morgan's threads: its card says what it was about, as Morgan summed it up.
  if (place?.kind === "thread") {
    const t = await ask<{ summary?: string } | null>("GET", `/threads/${encodeURIComponent(place.where)}`).catch(() => null);
    return { ...d, entity: { ...e, properties: { ...(e.properties ?? {}), body: t?.summary ?? "" } } };
  }
  if (place?.kind !== "page") return d;
  const words = await ask<string>("GET", `/projects/${encodeURIComponent(place.project)}/page?path=${encodeURIComponent(place.where)}`).catch(() => "");
  return { ...d, entity: { ...e, properties: { ...(e.properties ?? {}), body: typeof words === "string" ? words : "" } } };
}

/** The entity a card shows, as last answered; `undefined` until the first answer. */
export function useCardData(id: string): CardData | undefined {
  const [, tick] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    const h: Heard = (which) => {
      if (which === null) fetchDetail(id);
      else if (which === id) tick();
    };
    heard.add(h);
    fetchDetail(id);
    return () => {
      heard.delete(h);
    };
  }, [id]);
  return details.get(id);
}

/* ---------------------------------------------------------------- tasks */

interface StatusField {
  key: string;
  options?: string[];
  "talaris:labels"?: Record<string, string>;
  "talaris:colors"?: Record<string, string>;
}

/** How the task type is a task, in the core's words — `GET /tasks/types`. */
export interface TaskShape {
  titleKey: string;
  statusKey: string;
  complete: string[];
  defaultStatus: string;
  spanKey: string | null;
  /** The status field itself, for its options, labels and colors. */
  status: StatusField | null;
}

let shapeAsked: Promise<TaskShape | null> | null = null;

function taskShape(): Promise<TaskShape | null> {
  shapeAsked ??= ask<{ type: { fields?: StatusField[] } | null; shape: Omit<TaskShape, "status"> | null }>(
    "GET",
    "/tasks/types",
  ).then(
    ({ type, shape }) =>
      shape ? { ...shape, status: type?.fields?.find((f) => f.key === shape.statusKey) ?? null } : null,
    () => null,
  );
  return shapeAsked;
}

/** The task shape, once known; asked for only by a card that is a task. */
export function useTaskShape(wanted: boolean): TaskShape | null {
  const [shape, setShape] = useState<TaskShape | null>(null);
  useEffect(() => {
    if (!wanted) return;
    let live = true;
    void taskShape().then((s) => live && setShape(s));
    return () => {
      live = false;
    };
  }, [wanted]);
  return shape;
}

const humanize = (v: string) => (v ? v[0].toUpperCase() + v.slice(1).replace(/[_-]+/g, " ") : v);

/** A status as shown: the type's own label and color, or the value itself. */
export function statusLook(shape: TaskShape, value: string): { label: string; color: string } {
  const f = shape.status;
  return {
    label: f?.["talaris:labels"]?.[value] || humanize(value),
    color: f?.["talaris:colors"]?.[value] || "var(--muted)",
  };
}

/**
 * A task's status, changed — and nothing else.
 *
 * The core stamps the done time and makes the next occurrence of a repeating
 * task; doing either here would be a second copy of that, free to drift. The
 * answer is drawn at once and the whole detail asked again behind it, since a
 * completed repeat can change what the card's connections say.
 */
export async function setStatus(id: string, shape: TaskShape, value: string) {
  const entity = await ask<Record<string, unknown>>("PATCH", `/entities/${encodeURIComponent(id)}`, {
    properties: { [shape.statusKey]: value },
  });
  const had = details.get(id);
  if (had && had !== "gone" && entity && typeof entity === "object") {
    details.set(id, { ...had, entity });
    announce(id);
  }
  fetchDetail(id, true);
}

/* ---------------------------------------------------------------- words */

/** `[label](talaris:id)` is a mention; on a card it reads as its label. */
export const plainMentions = (text: string) => text.replace(/\[([^\]]*)\]\(talaris:[^)]*\)/g, "$1");

/** "YYYY-MM-DD", read as a local day rather than as midnight in Greenwich. */
function localDay(v: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
}

export function shortDay(v: string): string {
  const d = localDay(v);
  if (!d) return v;
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }) });
}

/** "YYYY-MM-DDTHH:MM" to a local time of day; nothing when there is no time in it. */
export function timeOf(v: string): string {
  const m = /T(\d{2}):(\d{2})/.exec(v);
  if (!m) return "";
  return new Date(2000, 0, 1, Number(m[1]), Number(m[2])).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}
