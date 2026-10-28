// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore

/**
 * A profile's slots, read: what a type says its title, status, due and the
 * rest are, and so what an object holds there. Pure — a type and an object
 * in, a value out — so the store's tasks and `measure` (the format's fixtures,
 * against this same reading) cannot come to disagree.
 *
 * A slot is a field (`"status"`), the reserved `content`, or a part of one
 * (`{field: "schedule", part: "end"}`). An empty string reads as no value.
 */

export type ProfiledType = { profiles?: Record<string, Record<string, unknown>> };
export type ProfiledObject = { properties?: Record<string, unknown>; content?: string | null };
export type Slot = { field: string; part?: string };

/** The format's five shared states, which a type's `states` maps its statuses onto. */
export const STATES = ["not-started", "in-progress", "waiting", "done", "cancelled"];

const blank = (v: unknown) => (v === "" ? undefined : v);

/** A slot as a type declares it: a field, a part of one, or null for `content` and for none. */
export function slotOf(type: ProfiledType | undefined, key: string, profile = "task"): Slot | null {
  const spec = type?.profiles?.[profile]?.[key];
  if (typeof spec === "string") return spec === "content" ? null : { field: spec };
  if (spec && typeof spec === "object" && typeof (spec as Slot).field === "string") {
    const s = spec as Slot;
    return { field: s.field, ...(typeof s.part === "string" ? { part: s.part } : {}) };
  }
  return null;
}

/** What an object holds in a profile's slot. A task's `state` is its status through the type's `states`. */
export function readSlot(type: ProfiledType | undefined, object: ProfiledObject | undefined, key: string, profile = "task"): unknown {
  if (profile === "task" && key === "state") {
    const status = readSlot(type, object, "status", "task");
    const state = typeof status === "string" ? (type?.profiles?.task?.states as Record<string, unknown> | undefined)?.[status] : undefined;
    return STATES.includes(state as string) ? state : undefined;
  }
  const spec = type?.profiles?.[profile]?.[key];
  if (spec === undefined || spec === null) return undefined;
  if (spec === "content") return blank(object?.content);
  const slot = slotOf(type, key, profile);
  if (!slot) return undefined;
  const v = object?.properties?.[slot.field];
  if (v === null || v === undefined) return undefined;
  return blank(slot.part ? (v as Record<string, unknown>)?.[slot.part] : v);
}

/** Complete, as its type says: a status among its complete values. A status unset is not complete. */
export function isCompleteBy(type: ProfiledType | undefined, object: ProfiledObject | undefined): boolean {
  const map = type?.profiles?.task as { status?: unknown; completeValues?: unknown[] } | undefined;
  if (!map?.status) return false;
  const status = readSlot(type, object, "status", "task");
  return status !== undefined && (map.completeValues ?? []).includes(status);
}
