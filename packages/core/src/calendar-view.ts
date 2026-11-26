// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore

/**
 * The accounts' calendars, shared (docs/WEB.md, *Calendar*): what a machine with a desktop reads of them — every
 * calendar's name and color, every occurrence over a window — kept here and carried to the others, so a machine
 * with no accounts of its own (home-server, the web) can draw them.
 *
 * The accounts stay signed in on the desktop machines only: a machine reads them through its calendar store
 * (calendard.py) and publishes what it read (`publish`), whole, as one sealed blob and a record naming it
 * (`calview:` — `{sha, by, at}`). The newest wins, as any record does. Published only when it changed.
 *
 * It is a view, not the calendars: as current as the last desktop machine awake. Talaris's own calendar is not in
 * it — that is the core's already, everywhere.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./vault.js";
import { machine, write as writeRecord, type Rec } from "./records.js";
import { getBlob, putBlob } from "./sync-files.js";

export interface ViewCalendar { id: string; name: string; color?: string; account?: string; writable?: boolean; feed?: boolean }
export interface ViewEvent { calendar: string; uid: string; rid?: string; title: string; start: number; end: number; allDay?: boolean; [k: string]: unknown }
export interface View { by: string; at: string; from: number; to: number; calendars: ViewCalendar[]; items: ViewEvent[] }

const FILE = () => join(DATA_DIR, "calendar-view.json");
let held: (View & { sha: string }) | null = null;

function load(): (View & { sha: string }) | null {
  if (held) return held;
  try { held = JSON.parse(readFileSync(FILE(), "utf8")) as View & { sha: string }; } catch { held = null; }
  return held;
}
function keep(view: View, sha: string): void {
  mkdirSync(DATA_DIR, { recursive: true });
  held = { ...view, sha };
  writeFileSync(FILE(), JSON.stringify(held));
}

/** What a desktop machine read of its calendars, kept and sent on if it differs from what is kept. Answers whether it did. */
export function publish(v: { from: number; to: number; calendars: ViewCalendar[]; items: ViewEvent[] }): { changed: boolean; events: number } {
  const body = { from: v.from, to: v.to, calendars: v.calendars ?? [], items: (v.items ?? []).filter((e) => e && e.calendar && typeof e.start === "number") };
  const bytes = Buffer.from(JSON.stringify(body));
  const sha = createHash("sha256").update(bytes).digest("hex");
  if (load()?.sha === sha) return { changed: false, events: body.items.length };
  const view: View = { by: machine().name, at: new Date().toISOString(), ...body };
  keep(view, sha);
  putBlob(sha, bytes);
  writeRecord({ of: "calview:", set: { sha, by: view.by, at: view.at } });
  return { changed: true, events: body.items.length };
}

/** One from another machine (sync-apply.ts): its blob read and kept. False while its bytes have not come. */
export function applyView(r: Rec): boolean {
  const sha = r.set?.sha;
  if (typeof sha !== "string") return false;
  const bytes = getBlob(sha);
  if (!bytes) return false;
  const body = JSON.parse(bytes.toString("utf8")) as Omit<View, "by" | "at">;
  keep({ ...body, by: String(r.set?.by ?? ""), at: String(r.set?.at ?? "") }, sha);
  return true;
}
export const viewBlob = (r: Rec): string | null => (typeof r.set?.sha === "string" ? r.set.sha : null);

/** The calendars and the occurrences between two moments, and who read them when: `{calendars, items, by, at, covers}`. */
export function viewRange(from: number, to: number) {
  const v = load();
  if (!v) return { calendars: [], items: [], by: "", at: "", covers: null };
  return {
    calendars: v.calendars, by: v.by, at: v.at, covers: { from: v.from, to: v.to },
    items: v.items.filter((e) => e.end > from && e.start < to),
  };
}

export const hasView = () => existsSync(FILE());
