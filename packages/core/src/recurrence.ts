// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore

/**
 * Recurrence, as `pkm-interchange` has it: a rule on a series, and real tasks
 * that are its instances. Written from the format's fixtures
 * (`fixtures/recurrence.json`), which the tests run as they are.
 *
 * Two anchors, and they are different things:
 * - **schedule** — a calendar pattern. The next occurrence is the rule's next
 *   date after the current one's due date, whenever it was completed; weekly
 *   intervals count from the series' first date, so rescheduling one instance
 *   does not re-phase the rest.
 * - **completion** — an interval since an event. The next due date is the
 *   completion date plus the interval; only one instance is ever knowable
 *   (horizon 1), and a weekday list has no meaning.
 *
 * Months: `byMonthDay` says which day, always — a rule is readable on its own;
 * `monthEnd` says what a month too short for it does, `skip` or `clamp`, and a
 * clamp never re-anchors the series to the day it clamped to.
 *
 * Dates are wall-clock, `YYYY-MM-DD` or `YYYY-MM-DDTHH:mm`, no zone; a time on
 * the due date is kept on the next one.
 */

export type Weekday = "MO" | "TU" | "WE" | "TH" | "FR" | "SA" | "SU";
export const WEEKDAYS: Weekday[] = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

export interface Rule {
  anchor: "schedule" | "completion";
  freq: "daily" | "weekly" | "monthly" | "yearly";
  interval: number;
  byWeekday?: Weekday[];
  byMonthDay?: number;
  monthEnd?: "skip" | "clamp";
  end?: { type: "never" } | { type: "after"; count: number } | { type: "on"; date: string };
  [extra: string]: unknown;
}

export interface Span {
  start?: string;
  due?: string;
}

export interface RuleError {
  code: string;
  message: string;
}

/** What makes a rule unusable, by the format's codes. */
export function ruleErrors(rule: Rule, horizon = 1): RuleError[] {
  const out: RuleError[] = [];
  if (!["schedule", "completion"].includes(rule.anchor)) out.push({ code: "series.anchor", message: "a rule is anchored to the schedule or to completion" });
  if (!["daily", "weekly", "monthly", "yearly"].includes(rule.freq)) out.push({ code: "series.freq", message: "daily, weekly, monthly or yearly" });
  if (!Number.isInteger(rule.interval) || rule.interval < 1) out.push({ code: "series.interval", message: "every 1 or more" });
  if (rule.anchor === "completion" && horizon !== 1) {
    out.push({ code: "series.completion-horizon", message: "a rule anchored to completion can only know its next instance" });
  }
  if (rule.anchor === "completion" && rule.byWeekday?.length) {
    out.push({ code: "series.completion-byweekday", message: "a weekday pattern has no meaning counted from a completion" });
  }
  if ((rule.freq === "monthly" || rule.freq === "yearly") && rule.anchor === "schedule") {
    if (!rule.byMonthDay) out.push({ code: "series.month-day-required", message: "a monthly or yearly rule says which day of the month" });
    if (!rule.monthEnd) out.push({ code: "series.month-end-required", message: "a monthly or yearly rule says what a short month does" });
  }
  return out;
}

// ------------------------------------------------------------ dates, wall-clock

/** A day as a UTC midnight, so arithmetic on it never meets a clock change. */
function day(s: string): Date {
  const [y, m, d] = s.slice(0, 10).split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d));
}
const iso = (d: Date) => d.toISOString().slice(0, 10);
const timeOf = (s: string | undefined) => (s && s.length > 10 ? s.slice(10) : "");
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86400000);
const daysBetween = (a: Date, b: Date) => Math.round((b.getTime() - a.getTime()) / 86400000);
const lastOfMonth = (y: number, m: number) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();

/** The day `dom` of the month `months` after (y, m): clamped to the month's end, or null for skip. */
function inMonth(y: number, m: number, months: number, dom: number, monthEnd: "skip" | "clamp"): Date | null {
  const t = new Date(Date.UTC(y, m + months, 1));
  const last = lastOfMonth(t.getUTCFullYear(), t.getUTCMonth());
  if (dom > last) {
    if (monthEnd === "skip") return null;
    return new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), last));
  }
  return new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), dom));
}

/** Monday of the week a day is in (weeks counted Monday to Sunday, as ISO does). */
function weekOf(d: Date): Date {
  return addDays(d, -((d.getUTCDay() + 6) % 7));
}

/**
 * The rule's first date strictly after `after`, counting from `origin` (the
 * series' first due date) — the schedule anchor. Null if none within reach.
 */
function nextScheduled(rule: Rule, origin: Date, after: Date): Date | null {
  const n = rule.interval;
  if (rule.freq === "daily") {
    const k = Math.floor(daysBetween(origin, after) / n) + 1;
    return addDays(origin, Math.max(1, k) * n);
  }
  if (rule.freq === "weekly") {
    const days = (rule.byWeekday?.length ? rule.byWeekday : [WEEKDAYS[origin.getUTCDay()]!]).map((w) => WEEKDAYS.indexOf(w));
    const week0 = weekOf(origin);
    // Weeks in phase with the series' first: every n-th from it.
    for (let probe = addDays(after, 1), i = 0; i < 7 * n * 60; i++, probe = addDays(probe, 1)) {
      const weeks = Math.round(daysBetween(week0, weekOf(probe)) / 7);
      if (weeks % n === 0 && days.includes(probe.getUTCDay())) return probe;
    }
    return null;
  }
  const step = rule.freq === "yearly" ? 12 * n : n;
  const dom = rule.byMonthDay ?? origin.getUTCDate();
  const monthEnd = rule.monthEnd ?? "clamp";
  for (let k = 1; k <= 400; k++) {
    // From the series' first month, never from a clamped instance: the 31st
    // stays the 31st after a February.
    const candidate = inMonth(origin.getUTCFullYear(), origin.getUTCMonth(), k * step, dom, monthEnd);
    if (candidate && candidate.getTime() > after.getTime()) return candidate;
  }
  return null;
}

/** The completion anchor: the interval counted from the day it was done. */
function afterCompletion(rule: Rule, completed: Date): Date {
  const n = rule.interval;
  if (rule.freq === "daily") return addDays(completed, n);
  if (rule.freq === "weekly") return addDays(completed, 7 * n);
  const months = rule.freq === "yearly" ? 12 * n : n;
  return inMonth(completed.getUTCFullYear(), completed.getUTCMonth(), months, rule.byMonthDay ?? completed.getUTCDate(), "clamp")!;
}

/**
 * The next instance's span, or null when the series has ended.
 *
 * `origin` is the series' first due date (the schedule anchor counts from it);
 * `instances` how many there have been, the current one included — `after N`
 * ends by counting them, never by a counter on the rule.
 */
export function nextSpan(rule: Rule, current: Span, completed: string, origin?: string, instances = 1): Span | null {
  const dueText = current.due ?? current.start;
  if (!dueText) return null;
  const end = rule.end ?? { type: "never" };
  if (end.type === "after" && instances >= end.count) return null;
  const due = day(dueText);
  let next: Date | null;
  if (rule.anchor === "completion") next = afterCompletion(rule, day(completed));
  else next = nextScheduled(rule, day(origin ?? dueText), due);
  if (!next) return null;
  if (end.type === "on" && iso(next) > end.date) return null;
  const out: Span = { due: iso(next) + timeOf(current.due ?? current.start) };
  if (current.start && current.due) {
    // The span keeps its shape: scheduled, it moves whole; from completion, the
    // available date keeps its gap before the new due date.
    const gap = daysBetween(day(current.start), due);
    out.start = iso(addDays(next, -gap)) + timeOf(current.start);
  } else if (current.start && !current.due) {
    out.start = out.due;
    delete out.due;
  }
  return out;
}

/** In a line, for a person: "Every 2 weeks on Wed, from the due date". */
export function summary(rule: Rule): string {
  const unit = { daily: "day", weekly: "week", monthly: "month", yearly: "year" }[rule.freq];
  let s = rule.interval === 1 ? `Every ${unit}` : `Every ${rule.interval} ${unit}s`;
  const names: Record<Weekday, string> = { MO: "Mon", TU: "Tue", WE: "Wed", TH: "Thu", FR: "Fri", SA: "Sat", SU: "Sun" };
  if (rule.freq === "weekly" && rule.byWeekday?.length) s += ` on ${rule.byWeekday.map((w) => names[w]).join(", ")}`;
  if ((rule.freq === "monthly" || rule.freq === "yearly") && rule.byMonthDay) s += ` on the ${ordinal(rule.byMonthDay)}`;
  s += rule.anchor === "completion" ? ", from completion" : "";
  const end = rule.end;
  if (end?.type === "after") s += `, ${end.count} times`;
  if (end?.type === "on") s += `, until ${end.date}`;
  return s;
}

function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]!);
}
