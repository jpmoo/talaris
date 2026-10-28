// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore

/**
 * The activity log (DESIGN, roadmap 20): what the person does through
 * Talaris — an application opened, a window sent to a project, a page
 * opened, a launcher pick — kept so that suggestions about how they work can
 * be drawn from it, by Talaris's own rules and by Morgan as far as they allow.
 *
 * Off until the person turns it on, and that is the surfaces' to know: they
 * send only when it is on, filtered to the grain chosen (surfaces/activity.py).
 * The core keeps what it is sent.
 *
 * **Sealed**, as the clipboard history is (clipboard.ts): one sealed JSON
 * array of entries per local day, `activity/<YYYY-MM-DD>.sealed`, so a day
 * past `keep` goes as one file. Beside them `settings.sealed` (`keep`,
 * `share`) and `dismissed.sealed` (suggestions turned down for good).
 *
 * **What Morgan may read** is `share`, held here and told by the surfaces
 * (`PUT /activity/settings`). The routes that read the log answer the
 * surfaces whatever it says — Talaris's own suggestions need the summary even
 * when nothing is shared. The gate is on Morgan's side: the MCP tools ask
 * `GET /activity/settings` first and fetch nothing the person keeps to this
 * machine; what they then say is `patternsSaid` and `logSaid` here, which
 * refuse by `share` themselves too.
 *
 * **Morgan's alone, never the Oracle's.** The two tools (`work_patterns`,
 * `work_log`) are offered only to an MCP client whose `initialize` named
 * itself exactly `heymorgan`: any other — Claude Code, Claude Desktop, the
 * Oracle's `claude` (Morgan's escalation, which may connect here too) — is
 * neither shown them nor answered by them (mcp.ts, `toolsFor`). What they say
 * is Morgan's to keep: their descriptions tell it never to pass it to the
 * Oracle or any other model or service.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { addDays, localDate } from "./localtime.js";
import { seal, unseal } from "./seal.js";
import { writeAtomic } from "./store.js";
import { DATA_DIR, storeKey } from "./vault.js";

/** One thing done, as it is kept. */
export interface Act {
  /** When, in milliseconds: stamped here. */
  at: number;
  /** What was done: `window.send`, `launcher.pick`, … An open vocabulary. */
  verb: string;
  /** An application: its desktop id or window class. */
  app?: string;
  /** The project it was done in ("" is Home). */
  project?: string;
  /** Where it went: a project, for a send or a go. */
  to?: string;
  /** What it was done to: a page path, a canvas, an entity, a launcher key. */
  target?: string;
  /** A window's title, only at the grain that keeps them. */
  title?: string;
  /** How long a focus span lasted. */
  seconds?: number;
}

export type NewAct = Omit<Act, "at">;

/** What Morgan may read: the summary, every entry, or nothing. */
export type Share = "summary" | "raw" | "local";
export const SHARES: Share[] = ["summary", "raw", "local"];

export interface ActivitySettings { keep: number; share: Share }

/** Until the surfaces say otherwise: three months kept, nothing shared. */
export const DEFAULT_SETTINGS: ActivitySettings = { keep: 90, share: "local" };

export const VERB = /^[a-z][a-z0-9.-]{0,39}$/;
/** The longest a title, or any other word kept, may be. */
export const MAX_TEXT = 300;

const DIR = () => join(DATA_DIR, "activity");
const DAY_FILE = (day: string) => join(DIR(), `${day}.sealed`);
const SETTINGS = () => join(DIR(), "settings.sealed");
const DISMISSED = () => join(DIR(), "dismissed.sealed");
const DAY_NAME = /^(\d{4}-\d\d-\d\d)\.sealed$/;

/** Days read, by date: what is on disk, kept in step with every append. */
const days = new Map<string, Act[]>();
let settings: ActivitySettings | null = null;
let dismissed: string[] | null = null;
/** The local day the old days were last pruned on. */
let prunedOn = "";

function readSealed<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try { return JSON.parse(unseal(storeKey(), readFileSync(path)).toString("utf8")) as T; } catch { return fallback; }
}

function writeSealed(path: string, value: unknown): void {
  mkdirSync(DIR(), { recursive: true, mode: 0o700 });
  writeAtomic(path, seal(storeKey(), JSON.stringify(value)));
}

function day(date: string): Act[] {
  let acts = days.get(date);
  if (!acts) {
    acts = readSealed<Act[]>(DAY_FILE(date), []);
    days.set(date, acts);
  }
  return acts;
}

/** The dates that have a file, oldest first. */
function keptDays(): string[] {
  if (!existsSync(DIR())) return [];
  return readdirSync(DIR()).map((f) => DAY_NAME.exec(f)?.[1]).filter((d): d is string => !!d).sort();
}

export function activitySettings(): ActivitySettings {
  if (!settings) settings = { ...DEFAULT_SETTINGS, ...readSealed<Partial<ActivitySettings>>(SETTINGS(), {}) };
  return settings;
}

/** Kept as told, and the days now past `keep` gone at once. */
export function setActivitySettings(s: { keep?: unknown; share?: unknown }): ActivitySettings {
  const now = activitySettings();
  const keep = s.keep === undefined ? now.keep : Number(s.keep);
  if (!Number.isInteger(keep) || keep < 1 || keep > 3650) throw new Error("keep is a whole number of days, 1 to 3650");
  const share = s.share === undefined ? now.share : s.share;
  if (!SHARES.includes(share as Share)) throw new Error(`share is one of ${SHARES.join(", ")}`);
  settings = { keep, share: share as Share };
  writeSealed(SETTINGS(), settings);
  prune();
  return settings;
}

/** Day files strictly older than `keep` days, deleted. */
function prune(at = new Date()): void {
  const today = localDate(at);
  const oldest = addDays(today, -activitySettings().keep);
  for (const d of keptDays()) {
    if (d < oldest) {
      rmSync(DAY_FILE(d), { force: true });
      days.delete(d);
    }
  }
  prunedOn = today;
}

function pruneIfDue(at = new Date()): void {
  if (prunedOn !== localDate(at)) prune(at);
}

function text(v: unknown, name: string, emptyKept = false): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw new Error(`${name} is text`);
  const t = v.trim().slice(0, MAX_TEXT);
  return t || emptyKept ? t : undefined;
}

/** What the surfaces sent, checked: a verb of the vocabulary's shape, words trimmed, seconds whole. */
export function checkAct(input: Record<string, unknown>): NewAct {
  const verb = typeof input.verb === "string" ? input.verb.trim() : "";
  if (!VERB.test(verb)) throw new Error("a verb is lower-case letters, digits, dots and dashes, at most 40");
  const act: NewAct = { verb };
  const app = text(input.app, "app"); if (app !== undefined) act.app = app;
  const project = text(input.project, "project", true); if (project !== undefined) act.project = project;
  const to = text(input.to, "to", true); if (to !== undefined) act.to = to;
  const target = text(input.target, "target"); if (target !== undefined) act.target = target;
  const title = text(input.title, "title"); if (title !== undefined) act.title = title;
  if (input.seconds !== undefined && input.seconds !== null) {
    const s = input.seconds;
    if (typeof s !== "number" || !Number.isInteger(s) || s < 0 || s > 86400) throw new Error("seconds is a whole number, 0 to 86400");
    act.seconds = s;
  }
  return act;
}

/** One thing done, kept in its day's file. `at` is now, but for a test. */
export function appendAct(input: Record<string, unknown>, at = Date.now()): Act {
  const act: Act = { at, ...checkAct(input) };
  const when = new Date(at);
  pruneIfDue(new Date());
  const date = localDate(when);
  const acts = day(date);
  acts.push(act);
  writeSealed(DAY_FILE(date), acts);
  return act;
}

/** The first moment of the day `n - 1` days before today: where the last `n` days begin. */
function startOf(n: number, now: Date): { dates: string[]; from: number } {
  const first = addDays(localDate(now), -(n - 1));
  const [y, m, d] = first.split("-").map(Number) as [number, number, number];
  const dates: string[] = [];
  for (let i = 0; i < n; i++) dates.push(addDays(first, i));
  return { dates, from: new Date(y, m - 1, d).getTime() };
}

const clampDays = (n: unknown, fallback: number) => {
  const v = Math.floor(Number(n));
  return Number.isFinite(v) && v >= 1 ? Math.min(v, 3650) : fallback;
};

/** The entries of the last `days` days (today one of them), oldest first; the newest `limit` of them. */
export function listActs(daysBack: unknown = 7, limit: unknown = 2000, now = new Date()): Act[] {
  pruneIfDue(now);
  const n = clampDays(daysBack, 7);
  const lim = Math.floor(Number(limit));
  const max = Number.isFinite(lim) && lim >= 1 ? Math.min(lim, 100_000) : 2000;
  const { dates, from } = startOf(n, now);
  const have = new Set(keptDays());
  const all = dates.filter((d) => have.has(d) || days.has(d)).flatMap((d) => day(d)).filter((a) => a.at >= from);
  all.sort((a, b) => a.at - b.at);
  return all.length > max ? all.slice(all.length - max) : all;
}

/** Every entry gone; the settings and what was dismissed kept. */
export function clearActs(): void {
  for (const d of keptDays()) rmSync(DAY_FILE(d), { force: true });
  days.clear();
}

export function dismissedSuggestions(): string[] {
  if (!dismissed) dismissed = readSealed<string[]>(DISMISSED(), []);
  return dismissed;
}

/** A suggestion turned down for good, by its key. */
export function dismissSuggestion(key: unknown): string[] {
  const k = typeof key === "string" ? key.trim().slice(0, MAX_TEXT) : "";
  if (!k) throw new Error("a suggestion's key is needed");
  const all = dismissedSuggestions();
  if (!all.includes(k)) {
    all.push(k);
    writeSealed(DISMISSED(), all);
  }
  return all;
}

// ------------------------------------------------------------ the summary

export interface Summary {
  days: number; from: number; to: number; total: number;
  verbs: Record<string, number>;
  /** 24 counts, by local hour. */
  byHour: number[];
  /** 7 counts, Sunday first. */
  byWeekday: number[];
  opens: { app: string; project: string; count: number }[];
  sends: { app: string; from: string; to: string; count: number }[];
  together: { a: string; b: string; count: number }[];
  focus: { app: string; project: string; seconds: number }[];
  projects: { project: string; goes: number; seconds: number }[];
  launcher: { target: string; count: number }[];
}

/** How close two opens must be to count as together. */
export const TOGETHER_MS = 3 * 60_000;
const OPENS = new Set(["window.open", "app.open"]);

function tally<T>(rows: Map<string, T>, key: string, make: () => T, add: (t: T) => void): void {
  let t = rows.get(key);
  if (!t) { t = make(); rows.set(key, t); }
  add(t);
}

const top = <T>(rows: Iterable<T>, by: (t: T) => number, n: number, name: (t: T) => string) =>
  [...rows].sort((a, b) => by(b) - by(a) || name(a).localeCompare(name(b))).slice(0, n);

/**
 * The last `days` days, counted: by verb, hour and weekday; what is opened
 * where; what is sent where; which two applications are opened together;
 * where the time goes; what the launcher is asked for.
 *
 * Together: two different applications, the later opened within three
 * minutes of the earlier, in one project. Each open counts once for every
 * other application opened in the three minutes before it.
 */
export function summarize(acts: Act[], daysBack: number, from: number, to: number): Summary {
  const verbs: Record<string, number> = {};
  const byHour = new Array<number>(24).fill(0);
  const byWeekday = new Array<number>(7).fill(0);
  const opens = new Map<string, Summary["opens"][number]>();
  const sends = new Map<string, Summary["sends"][number]>();
  const focus = new Map<string, Summary["focus"][number]>();
  const projects = new Map<string, Summary["projects"][number]>();
  const launcher = new Map<string, Summary["launcher"][number]>();
  const opened = new Map<string, Act[]>();
  for (const a of acts) {
    verbs[a.verb] = (verbs[a.verb] ?? 0) + 1;
    const d = new Date(a.at);
    byHour[d.getHours()]! += 1;
    byWeekday[d.getDay()]! += 1;
    const project = a.project ?? "";
    if (OPENS.has(a.verb) && a.app) {
      tally(opens, JSON.stringify([a.app, project]), () => ({ app: a.app!, project, count: 0 }), (t) => { t.count++; });
      tally(opened, project, () => [], (t) => { t.push(a); });
    } else if (a.verb === "window.send" && a.app) {
      const where = a.to ?? "";
      tally(sends, JSON.stringify([a.app, project, where]), () => ({ app: a.app!, from: project, to: where, count: 0 }), (t) => { t.count++; });
    } else if (a.verb === "window.focus" && a.seconds) {
      if (a.app) tally(focus, JSON.stringify([a.app, project]), () => ({ app: a.app!, project, seconds: 0 }), (t) => { t.seconds += a.seconds!; });
      tally(projects, project, () => ({ project, goes: 0, seconds: 0 }), (t) => { t.seconds += a.seconds!; });
    } else if (a.verb === "project.go" && a.to !== undefined) {
      tally(projects, a.to, () => ({ project: a.to!, goes: 0, seconds: 0 }), (t) => { t.goes++; });
    } else if (a.verb === "launcher.pick" && a.target) {
      tally(launcher, a.target, () => ({ target: a.target!, count: 0 }), (t) => { t.count++; });
    }
  }
  const together = new Map<string, Summary["together"][number]>();
  for (const list of opened.values()) {
    list.sort((x, y) => x.at - y.at);
    for (let j = 0; j < list.length; j++) {
      const later = list[j]!;
      const seen = new Set<string>();
      for (let i = j - 1; i >= 0 && later.at - list[i]!.at <= TOGETHER_MS; i--) {
        const other = list[i]!.app!;
        if (other === later.app || seen.has(other)) continue;
        seen.add(other);
        const [a, b] = other < later.app! ? [other, later.app!] : [later.app!, other];
        tally(together, JSON.stringify([a, b]), () => ({ a, b, count: 0 }), (t) => { t.count++; });
      }
    }
  }
  return {
    days: daysBack, from, to, total: acts.length, verbs, byHour, byWeekday,
    opens: top(opens.values(), (t) => t.count, 30, (t) => t.app + t.project),
    sends: top(sends.values(), (t) => t.count, 30, (t) => t.app + t.from + t.to),
    together: top([...together.values()].filter((t) => t.count >= 2), (t) => t.count, 20, (t) => t.a + t.b),
    focus: top(focus.values(), (t) => t.seconds, 30, (t) => t.app + t.project),
    projects: top(projects.values(), (t) => t.seconds * 1000 + t.goes, Infinity, (t) => t.project),
    launcher: top(launcher.values(), (t) => t.count, 20, (t) => t.target),
  };
}

/** The summary of the last `days` days (default 30), today one of them. */
export function activitySummary(daysBack: unknown = 30, now = new Date()): Summary {
  const n = clampDays(daysBack, 30);
  const { from } = startOf(n, now);
  return summarize(listActs(n, Infinity, now), n, from, now.getTime());
}

/** For a test: forgotten in memory, read again from disk. */
export function forgetLoadedActivity(): void {
  days.clear();
  settings = null;
  dismissed = null;
  prunedOn = "";
}

// ------------------------------------------------------------ for Morgan

/** May Morgan read this much? The summary when share is summary or raw; every entry only when raw. */
export function mayRead(share: Share, what: "summary" | "raw"): boolean {
  return what === "summary" ? share === "summary" || share === "raw" : share === "raw";
}

export const KEPT_LOCAL = "The person keeps their activity to this machine: Talaris does not share it, not even as a summary. Talaris's own suggestions still use it; ask them to change Settings → Activity if they want you to see it.";
export const LOG_NOT_SHARED = "The person has not shared their activity entry by entry (only Settings → Activity → \"raw\" does). Use work_patterns for the summary, if that is shared.";

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const where = (p: string) => (p ? p : "Home");
const span = (s: number) => {
  const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m}m`;
};

/** The summary as a model would read it, then as JSON; or why not. */
export function patternsSaid(share: Share, s: Summary | null): string {
  if (!mayRead(share, "summary") || !s) return KEPT_LOCAL;
  if (!s.total) return `Nothing kept in the last ${s.days} days (the log may be off, or only just on).`;
  const out = [`Activity over the last ${s.days} days: ${s.total} things done through Talaris.`];
  const list = <T>(head: string, rows: T[], say: (t: T) => string) => { if (rows.length) out.push("", `${head}:`, ...rows.map((r) => `- ${say(r)}`)); };
  const busiest = s.byHour.map((n, h) => [h, n] as const).filter(([, n]) => n).sort((a, b) => b[1] - a[1]).slice(0, 4);
  if (busiest.length) out.push(`Busiest hours: ${busiest.map(([h, n]) => `${String(h).padStart(2, "0")}:00 (${n})`).join(", ")}.`);
  out.push(`By weekday: ${s.byWeekday.map((n, d) => `${WEEKDAYS[d]!.slice(0, 3)} ${n}`).join(", ")}.`);
  list("Opened, by application and project", s.opens, (t) => `${t.app} in ${where(t.project)}: ${t.count}`);
  list("Sent to another project", s.sends, (t) => `${t.app} from ${where(t.from)} to ${where(t.to)}: ${t.count}`);
  list("Opened together (within 3 minutes, in one project)", s.together, (t) => `${t.a} with ${t.b}: ${t.count}`);
  list("Time in focus", s.focus, (t) => `${t.app} in ${where(t.project)}: ${span(t.seconds)}`);
  list("Projects", s.projects, (t) => `${where(t.project)}: gone to ${t.goes} times${t.seconds ? `, ${span(t.seconds)} in focus` : ""}`);
  list("Asked of the launcher", s.launcher, (t) => `${t.target}: ${t.count}`);
  out.push("", "As JSON:", JSON.stringify(s));
  return out.join("\n");
}

/** Every entry, a line each; or why not. */
export function logSaid(share: Share, acts: Act[] | null): string {
  if (!mayRead(share, "raw") || !acts) return LOG_NOT_SHARED;
  if (!acts.length) return "Nothing kept in those days.";
  const pad = (n: number) => String(n).padStart(2, "0");
  return acts.map((a) => {
    const d = new Date(a.at);
    const bits = [`${localDate(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`, a.verb];
    if (a.app) bits.push(a.app);
    if (a.project !== undefined) bits.push(`in ${where(a.project)}`);
    if (a.to !== undefined) bits.push(`to ${where(a.to)}`);
    if (a.target) bits.push(`→ ${a.target}`);
    if (a.seconds !== undefined) bits.push(span(a.seconds));
    if (a.title) bits.push(`"${a.title}"`);
    return bits.join(" ");
  }).join("\n");
}
