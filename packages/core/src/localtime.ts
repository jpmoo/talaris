// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore

/**
 * This machine's day and minute, written the one way the core writes them:
 * `2026-10-27` and `2026-10-27T09:14`, local, no zone. Dates a person gives —
 * a task's due, its available, the day a list asks about — are local and
 * zoneless like these, so they compare as text.
 *
 * Two kinds of time are kept, and they do not mix: a task's `done_at` is
 * stamped here, local and zoneless (as Hermes stamps it); an entity's
 * `created`, `updated` and an archive's time are UTC ISO. One of those is
 * compared with a local value only through `localMinute(new Date(iso))`,
 * never as text as it stands.
 */

const pad = (n: number) => String(n).padStart(2, "0");

/** The local date: `2026-10-27`. */
export function localDate(at = new Date()): string {
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

/** The local minute: `2026-10-27T09:14`. */
export function localMinute(at = new Date()): string {
  return `${localDate(at)}T${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

/** A date moved by whole days, its time of day (whatever follows the date) kept as it was. */
export function addDays(value: string, days: number): string {
  if (!/^\d{4}-\d\d-\d\d/.test(value)) return value;
  const d = new Date(`${value.slice(0, 10)}T12:00:00`);
  d.setDate(d.getDate() + days);
  return `${localDate(d)}${value.slice(10)}`;
}

/**
 * Overdue, one rule everywhere: a due with a time is overdue once that time
 * has passed; a due that is only a date, from the next day — the whole of
 * its day is still in time.
 */
export function isOverdue(due: string | undefined | null, at = new Date()): boolean {
  if (!due) return false;
  return due.length > 10 ? due < localMinute(at) : due < localDate(at);
}
