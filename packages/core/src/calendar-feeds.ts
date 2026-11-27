// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore

/**
 * The calendar's feeds, the same on every machine: someone else's calendar read from an address (calendard.py,
 * Feeds), brought in on one desktop machine and so brought in on each. Each machine's calendar process reads its
 * feeds itself — a feed needs no account, only its address — so what travels is the list, not the events.
 *
 * **One record a feed** (`feed:<id>` — address, name, color, and `gone` once put away), the latest kept. The id is
 * the one the first machine gave it, used by every machine after, so a feed is the same calendar everywhere: hidden
 * or muted by its id, and the same calendar in the shared view (calendar-view.ts). The address can carry a secret
 * (a published Outlook calendar's does); records are sealed, as every record is, and go to this user's machines only.
 *
 * **Who acts on it:** each desktop's calendar panel (calendar_panel.py): what it has that the list has not is added
 * here; what the list has that it has not, it brings in; what the list says is gone, it puts away.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./vault.js";
import { write as writeRecord, type Rec } from "./records.js";

export interface Feed { url: string; name: string; color?: string; gone?: boolean; at: string }

const FILE = () => join(DATA_DIR, "calendar-feeds.json");
const validId = (id: unknown): id is string => typeof id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(id);
const validUrl = (u: unknown): u is string => typeof u === "string" && /^(https?|webcal):\/\//i.test(u) && u.length < 4096;

function kept(): Record<string, Feed> {
  try { return JSON.parse(readFileSync(FILE(), "utf8")) as Record<string, Feed>; } catch { return {}; }
}
function keep(all: Record<string, Feed>): void {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(FILE(), JSON.stringify(all), { mode: 0o600 });
}

/** Every feed known, put-away ones too (so a machine that has one still puts it away). */
export const feeds = (): Record<string, Feed> => kept();

/** A feed brought in, renamed or recolored on this machine — or, `gone`, put away. Kept and sent on. */
export function tell(id: unknown, f: { url?: unknown; name?: unknown; color?: unknown; gone?: unknown }): Feed | { error: string } {
  if (!validId(id)) return { error: "No feed id" };
  const all = kept();
  const was = all[id];
  const url = f.url ?? was?.url;
  if (!validUrl(url)) return { error: "Not a feed's address" };
  const color = typeof f.color === "string" && /^#[0-9a-fA-F]{6}$/.test(f.color) ? f.color.toLowerCase() : was?.color;
  const next: Feed = { url, name: String(f.name ?? was?.name ?? "Feed").slice(0, 120), ...(color ? { color } : {}), ...(f.gone ? { gone: true } : {}), at: new Date().toISOString() };
  if (was && was.url === next.url && was.name === next.name && was.color === next.color && !!was.gone === !!next.gone) return was;
  all[id] = next;
  keep(all);
  writeRecord({ of: `feed:${id}`, set: { ...next } });
  return next;
}

/** Another machine's word (sync-apply.ts): kept if newer than what is kept. */
export function applyFeed(r: Rec): boolean {
  const id = r.of.slice("feed:".length);
  const s = r.set ?? {};
  if (!validId(id) || !validUrl(s.url)) return true;
  const all = kept();
  const at = String(s.at ?? "");
  if (all[id] && all[id]!.at >= at) return true;
  all[id] = { url: String(s.url), name: String(s.name ?? "Feed"), ...(typeof s.color === "string" ? { color: s.color } : {}), ...(s.gone ? { gone: true } : {}), at };
  keep(all);
  return true;
}
