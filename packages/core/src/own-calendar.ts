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
 * Being Talaris's, they are what a sync may carry to another app (Hermes
 * Notes' sync does); an account's events never are.
 */

import { allRecords, profilesOf, titleOf, typeFor, type Entity } from "./entities.js";
import { instantOn, TIMEZONE } from "./zoned.js";

/** The mark, on the entity, saying which of Talaris's own calendars it is on (there is one). */
export const OWN = "talaris:calendar";
export const OWN_ID = "talaris";
/** Where one made from a feed came from: `<calendar>/<uid>/<rid>`. */
export const FROM_FEED = "talaris:fromFeed";

export function ownCalendar() {
  return { id: OWN_ID, name: "Talaris", account: "Talaris", writable: true as const, own: true as const };
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

/** Whether an entity is an event on Talaris's own calendar. */
export const isOwnEvent = (o: Entity): boolean => o[OWN] === OWN_ID;

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
    ...(typeof o[FROM_FEED] === "string" ? { fromFeed: o[FROM_FEED] } : {}) };
}

const ownRecords = () => allRecords().filter(({ object: o }) => !o.archived && !o.stub && isOwnEvent(o) && profilesOf(o).includes("event"));

/** What is on Talaris's own calendar between two times. */
export function ownEvents(from: number, to: number): Record<string, unknown>[] {
  return ownRecords().map(({ object: o }) => drawnEvent(o, OWN_ID, from, to)).filter((e): e is Record<string, unknown> => e !== null);
}

/** The feed occurrences made yours (`<calendar>/<uid>/<rid>`), whenever they now are: not shown twice. */
export function takenFromFeeds(): string[] {
  return ownRecords().map(({ object: o }) => o[FROM_FEED]).filter((k): k is string => typeof k === "string");
}
