// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore

/**
 * Times written on another clock. A thing's times are written as they read on a
 * clock, with no offset. One that came from somewhere else (a sync: Hermes Notes
 * keeps them on its user's clock) says which, in `talaris:timezone`, its value left
 * as written so the two sides still agree: it is only ever read through this.
 */

export const TIMEZONE = "talaris:timezone";

const pad = (n: number) => String(n).padStart(2, "0");

/** How far `zone` is ahead of UTC at an instant, in milliseconds. */
function ahead(at: number, zone: string): number {
  const p: Record<string, number> = {};
  for (const part of new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" }).formatToParts(new Date(at))) {
    if (part.type !== "literal") p[part.type] = Number(part.value);
  }
  return Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!, p.second!) - Math.floor(at / 1000) * 1000;
}

/** The instant a clock time on `zone` is; NaN if it is not a clock time, or `zone` no zone. */
export function instantOn(wall: string, zone: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(wall);
  if (!m) return NaN;
  const utc = Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +(m[6] ?? 0));
  try {
    // Asked twice: the offset at the guess may be the far side of a change of clocks.
    const first = utc - ahead(utc, zone);
    return utc - ahead(first, zone);
  } catch { return NaN; }
}

/** This one's times, where it says they are on another clock: as they read here, or as written if they cannot be read. */
export function hereFrom(v: string, zone: unknown): string {
  if (typeof zone !== "string" || !zone) return v;
  const at = instantOn(v, zone);
  if (Number.isNaN(at)) return v;
  const d = new Date(at);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
