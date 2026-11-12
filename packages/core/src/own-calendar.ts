// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore
/**
 * Talaris's own calendar: events that are no account's.
 *
 * Every other event Talaris shows is kept somewhere else — an account's
 * calendar, through Evolution Data Server (calendard.py), or a plugin's
 * (`[calendar]`, plugins.ts). These are kept here, as the core keeps
 * anything: an Event entity, marked as this calendar's (`talaris:calendar`).
 * Made on it in the calendar, or made yours from a feed's event — and then
 * carrying where it came from (`talaris:fromFeed`, the feed's calendar, the
 * event's UID and the occurrence's), so the feed's own copy is not shown
 * beside it.
 *
 * Or brought by a sync from another app (`<plugin>:link`, merge.ts): an
 * event no account keeps is on this calendar however it came.
 *
 * Being Talaris's, they are what a sync may carry to another app (Hermes
 * Notes' sync does); an account's events never are. One a sync brings that is
 * also an account's — the same meeting, kept in both — is joined to the
 * account's (`joinAccountTwins`): Talaris's still, shown on this calendar in
 * its color with its notes, the account's copy not shown beside it
 * (`takenElsewhere`, as a feed's made yours is), and following the account's
 * times as the calendar's mirror reads them.
 */

import { join } from "node:path";
import { allRecords, profilesOf, titleOf, typeFor, type Entity, type Source } from "./entities.js";
import { mergeEntities, syncedBy } from "./merge.js";
import { CONFIG_DIR } from "./paths.js";
import { readJson, writeJson } from "./store.js";
import { instantOn, TIMEZONE } from "./zoned.js";

/** The mark, on the entity, saying which of Talaris's own calendars it is on (there is one). */
export const OWN = "talaris:calendar";
export const OWN_ID = "talaris";
/** Where one made from a feed came from: `<calendar>/<uid>/<rid>`. */
export const FROM_FEED = "talaris:fromFeed";

/** Its settings — its color — kept with Talaris's other settings, so an export of them takes it along. */
const SETTINGS = () => join(CONFIG_DIR, "own-calendar.json");
const COLOR = /^#[0-9a-f]{6}$/;

function ownColor(): string {
  try {
    const c = readJson<{ color?: unknown }>(SETTINGS()).color;
    return typeof c === "string" && COLOR.test(c) ? c : "";
  } catch {
    return "";
  }
}

/** Its color, `#rrggbb`; empty for the accent's. */
export function setOwnColor(color: string): void {
  const c = color.toLowerCase();
  if (c && !COLOR.test(c)) throw new Error("a color is #rrggbb");
  writeJson(SETTINGS(), { color: c });
}

export function ownCalendar() {
  const color = ownColor();
  return { id: OWN_ID, name: "Talaris", account: "Talaris", writable: true as const, own: true as const, ...(color ? { color } : {}) };
}

/** A time as it is drawn: Date.parse reads a date alone as UTC, and a day is the day where you are. */
export function whenOf(v: unknown, zone?: unknown): { at: number; day: boolean } | null {
  if (typeof v === "number") return { at: v, day: false };
  if (typeof v !== "string") return null;
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  const on = !d && typeof zone === "string" && zone ? instantOn(v, zone) : NaN;
  const at = d ? new Date(Number(d[1]), Number(d[2]) - 1, Number(d[3])).getTime() : Number.isNaN(on) ? Date.parse(v) : on;
  return Number.isNaN(at) ? null : { at, day: Boolean(d) };
}

/** Where else an entity lives: an account's calendar, an address book. */
const sourcesOf = (o: Entity): Source[] => (o["talaris:sources"] as Source[] | undefined) ?? [];
/** Whether an account's calendar keeps it (calendar_panel.py's mirror). */
const accountKeeps = (o: Entity): boolean => sourcesOf(o).some((s) => s.kind === "eds-event");

/**
 * Whether an entity is an event on Talaris's own calendar: marked so; an event no account keeps; or one a sync keeps
 * in step that was joined to an account's (`joinAccountTwins`) — shown here, the account's copy not.
 */
export const isOwnEvent = (o: Entity): boolean =>
  o[OWN] === OWN_ID || (profilesOf(o).includes("event") && (!accountKeeps(o) || syncedBy(o) !== null));

/**
 * An event entity drawn as a calendar's events are, on `calendar`, if it
 * falls between two times; null if not, or if it has no start.
 */
export function drawnEvent(o: Entity, calendar: string, from: number, to: number): Record<string, unknown> | null {
  const body = typeFor("event")?.profiles?.event?.body;
  const zone = o.properties[TIMEZONE];
  const start = whenOf(o.properties.start, zone);
  if (!start) return null;
  const allDay = start.day;
  const last = whenOf(o.properties.end, zone) ?? start;
  // A day's end is that day's: drawn to the start of the next, as an all-day event of a real calendar's is.
  const end = allDay ? last.at + 24 * 60 * 60 * 1000 : Math.max(last.at, start.at);
  if (end < from || start.at > to) return null;
  return { calendar, uid: o.id, entity: o.id, rid: "", title: titleOf(o), start: start.at, end, allDay, ...(typeof zone === "string" && zone ? { timezone: zone } : {}), recurring: false,
    location: typeof o.properties.location === "string" ? o.properties.location : "", notes: typeof body === "string" && typeof o.properties[body] === "string" ? o.properties[body] : "",
    ...(typeof o[FROM_FEED] === "string" ? { fromFeed: o[FROM_FEED] } : {}),
    // The account's event it was joined to, if it was (joinAccountTwins): its words are the account's to show.
    ...(sourcesOf(o).some((s) => s.kind === "eds-event") ? { account: sourcesOf(o).find((s) => s.kind === "eds-event")!.key } : {}) };
}

const ownRecords = () => allRecords().filter(({ object: o }) => !o.archived && !o.stub && isOwnEvent(o) && profilesOf(o).includes("event"));

/** What is on Talaris's own calendar between two times. */
export function ownEvents(from: number, to: number): Record<string, unknown>[] {
  return ownRecords().map(({ object: o }) => drawnEvent(o, OWN_ID, from, to)).filter((e): e is Record<string, unknown> => e !== null);
}

/**
 * The occurrences elsewhere that one of these stands for (`<calendar>/<uid>/<rid>`), so the calendar does not show
 * them twice: a feed's made yours, and an account's event a sync's was joined to (one occurrence, never a series) —
 * and, by its iCalendar UID (a key of "*", the UID and the occurrence), that same meeting wherever else it is: another account's calendar, or a
 * feed publishing one (an Outlook calendar's published .ics carries its meetings' own UIDs).
 */
export function takenElsewhere(): string[] {
  return ownRecords().flatMap(({ object: o }) => [
    ...(typeof o[FROM_FEED] === "string" ? [o[FROM_FEED] as string] : []),
    ...sourcesOf(o).filter((s) => s.kind === "eds-event").map((s) => `${s.key}/`),
    ...sourcesOf(o).filter((s) => s.kind === "ical-uid").map((s) => `*/${s.key}/`),
  ]);
}

/** The same meeting, as two apps would write it: its title, and when it starts, to the minute. */
const meetingKey = (o: Entity): string => `${titleOf(o).trim().toLowerCase()}|${String(o.properties.start ?? "").slice(0, 16)}`;

/**
 * Each event a sync keeps in step (`<plugin>:link`) that is also an
 * account's — one of each with the same title starting at the same minute,
 * the account's a single meeting, not a series — made one: the sync's kept
 * (its going would read as a deletion there), taking on the account's
 * sources, so the calendar's mirror keeps its times and the sync carries them
 * on. Run as either arrives. Answers how many were joined.
 */
export function joinAccountTwins(): number {
  const synced = new Map<string, Entity[]>(), kept = new Map<string, Entity[]>();
  for (const { object: o } of allRecords()) {
    if (o.archived || o.stub || !profilesOf(o).includes("event") || !o.properties.start) continue;
    // A series is one entity whose start moves to its next occurrence (the mirror's): never joined to one meeting.
    const into = syncedBy(o) ? (accountKeeps(o) ? null : synced) : accountKeeps(o) && o["talaris:recurring"] !== true ? kept : null;
    if (into) into.set(meetingKey(o), [...(into.get(meetingKey(o)) ?? []), o]);
  }
  let joined = 0;
  for (const [key, ours] of synced) {
    const theirs = kept.get(key);
    // Only where there is no doubt: one of each.
    if (ours.length !== 1 || theirs?.length !== 1) continue;
    mergeEntities(theirs[0]!.id, ours[0]!.id);
    joined++;
  }
  return joined;
}
