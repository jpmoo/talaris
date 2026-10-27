// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore

/**
 * What is left out of Glance, a thing's connections and its suggestions, as
 * Settings says (DESIGN, *What is shown*): tasks that are complete, what is
 * archived, and what has not changed since a while back. Nothing is changed
 * or lost — only not shown there; the launcher, @ and search still find it,
 * and the thing a glance is of is always shown.
 *
 * Complete is as the thing's type says (its task profile's `completeValues`),
 * never a status by name. Its date is when it last changed: an entity's
 * `updated`, a page's or a file's modified time, a conversation's last
 * exchange. Something with no date (a project, a canvas) is never too old.
 */

import { join } from "node:path";
import type { Entity } from "./entities.js";
import { CONFIG_DIR } from "./paths.js";
import { readJson } from "./store.js";
import { isComplete } from "./tasks.js";

export interface Shown {
  /** Complete tasks left out. */
  done?: boolean;
  /** Archived things left out. */
  archived?: boolean;
  /** Left out when last changed more than this many days ago; 0 or none, never. */
  olderThan?: number;
}

export function shownSettings(): Shown {
  try { return readJson<{ shown?: Shown }>(join(CONFIG_DIR, "config.json")).shown ?? {}; } catch { return {}; }
}

/** Whether anything is left out at all: when nothing is, nothing need be looked at. */
export const leavesOut = (s: Shown = shownSettings()) => Boolean(s.done || s.archived || (s.olderThan ?? 0) > 0);

/** Last changed before the line Settings draws. */
export function tooOld(iso: string | undefined, s: Shown = shownSettings()): boolean {
  const days = s.olderThan ?? 0;
  if (!days || !iso) return false;
  const at = Date.parse(iso);
  return Number.isFinite(at) && at < Date.now() - days * 86_400_000;
}

/** An entity left out: complete, archived, or too old, as Settings says. */
export function leftOut(o: Pick<Entity, "type" | "properties" | "archived" | "updated">, s: Shown = shownSettings()): boolean {
  if (s.archived && o.archived) return true;
  if (s.done && isComplete(o as Entity)) return true;
  return tooOld(o.updated, s);
}
