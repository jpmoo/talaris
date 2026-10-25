// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore

import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, renameSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { allRecords, getFile, putFile, reloadEntities, sealedList, sealedPut, types, type Entity, type EntityType, type Relation } from "./entities.js";
import { allSeries } from "./tasks.js";
import { show, type List } from "./lists.js";
import { ENTITIES_DIR } from "./vault.js";
import { seal } from "./seal.js";
import { storeKey } from "./vault.js";
import { writeAtomic } from "./store.js";

/**
 * The entity store as a `pkm-interchange/0` envelope, and back.
 *
 * This is Talaris's own reading of the format, written from the specification
 * and not from Hermes' code: two implementations that agree are what make the
 * format mean anything. The export is what a backup is, and what a plugin
 * syncing with another tool speaks.
 *
 * **What is claimed is what is done.** The manifest below says relations,
 * attachments (and their files, when asked for) and stable ids, and nothing
 * else; it is held against the checker by the tests.
 */

export const FORMAT = "pkm-interchange/0";

export interface Envelope {
  format: string;
  producer: { name: string; version: string; stableIds?: boolean; [k: string]: unknown };
  conformance?: Record<string, unknown>;
  types?: EntityType[];
  objects?: Entity[];
  relations?: Relation[];
  /** What could not be said: present even when empty, which is itself the statement. */
  findings?: Finding[];
  [extra: string]: unknown;
}

export interface Finding {
  code: string;
  severity: "info" | "reduced" | "error";
  message: string;
  object?: string;
}

/**
 * Level 1 until the fixture suite says otherwise: the round trip is tested
 * here, but a claim is what the format's own cases have measured, not what
 * this code believes of itself (Hermes' rule, kept).
 */
export const MANIFEST = {
  produce: 1,
  consume: 1,
  operate: 0,
  bindings: ["file"],
  profiles: ["contact", "event", "note", "task", "project"],
  features: ["relations", "attachments"],
  unsupported: ["hierarchy"],
};

const PRODUCER_VERSION = "0.1.0";

/** Every attachment value in an object's properties, wherever it sits. */
function attachmentsIn(value: unknown, found: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (Array.isArray(value)) for (const v of value) attachmentsIn(v, found);
  else if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    if (o.kind === "attachment" && typeof o.filename === "string") found.push(o);
    else for (const v of Object.values(o)) attachmentsIn(v, found);
  }
  return found;
}

/**
 * The store as an envelope. With `bytes`, each attached file travels inside it
 * (a backup); without, by name and hash (a sync, which fetches what it lacks).
 */
export function exportEnvelope(options: { bytes?: boolean } = {}): Envelope {
  const objects: Entity[] = [];
  const relations: Relation[] = [];
  const findings: Finding[] = [];
  for (const rec of allRecords()) {
    let o = rec.object;
    if (options.bytes) {
      o = structuredClone(o);
      for (const a of attachmentsIn(o.properties)) {
        const bytes = getFile(String(a.sha256 ?? ""));
        if (bytes) a.bytes = bytes.toString("base64");
        else findings.push({ code: "attachment.known-missing", severity: "reduced", object: o.id,
          message: `${String(a.filename)} is known by its hash and this store does not have the file` });
      }
    }
    objects.push(o);
    // Kept as they were made, `from` and all: an edge goes out as it came in.
    relations.push(...rec.relations.map((r) => (r.from === rec.object.id ? r : { ...r, from: rec.object.id })));
  }
  const collections = sealedList<List>("lists").map(collectionOf);
  const series = allSeries();
  // Declared as they are present, never more: the checker holds the manifest
  // to the data (conformance.undeclared-feature), and a promise is the data.
  const features = [...MANIFEST.features, ...(options.bytes ? ["attachment-bytes"] : [])];
  if (series.length) features.push("series");
  if (collections.some((c) => c.placement)) features.push("placement");
  if (collections.some((c) => (c.membership as { mode?: string })?.mode === "query")) features.push("derivations");
  if (collections.some((c) => (c.order as { sort?: unknown; groupBy?: unknown } | undefined)?.sort || (c.order as { groupBy?: unknown } | undefined)?.groupBy)) features.push("ordering");
  return {
    format: FORMAT,
    producer: { name: "talaris", version: PRODUCER_VERSION, stableIds: true },
    conformance: { ...MANIFEST, features },
    types: types(),
    objects,
    relations,
    ...(collections.length ? { collections } : {}),
    ...(series.length ? { series } : {}),
    findings,
  };
}

/**
 * A list as a format collection. A live query's members are its answer now —
 * a snapshot for reference, as the format says (`materialized: false`); a
 * board's members carry the column their value puts them in; the list's own
 * keys go as they are, `talaris:` ones included.
 */
function collectionOf(l: List): Record<string, unknown> {
  const shown = show(l);
  const members = shown.rows.map((r) => ({
    object: r.id,
    position: r.position,
    ...(l.placement && r.region ? { region: r.region } : {}),
  }));
  const { members: _kept, ...rest } = l;
  return { ...rest, members };
}

/**
 * An envelope into the store, **replacing what is there** — a revival. The
 * store as it was is moved aside first and put back if anything goes wrong.
 *
 * Nothing is coerced quietly: what cannot be kept whole is reported, and a
 * file that does not match its hash fails the import.
 */
export function importEnvelope(env: Envelope): { findings: Finding[]; counts: { types: number; objects: number; relations: number; files: number } } {
  if (env.format !== FORMAT) throw new Error(`not a ${FORMAT} envelope (${String(env.format)})`);
  const findings: Finding[] = [];
  const ids = new Set<string>();
  for (const o of env.objects ?? []) {
    if (!o || typeof o.id !== "string") throw new Error("an object without an id");
    if (ids.has(o.id)) throw new Error(`two objects with the id ${o.id}`);
    ids.add(o.id);
  }
  // Check every carried file before anything is touched.
  for (const o of env.objects ?? []) {
    for (const a of attachmentsIn(o.properties)) {
      if (typeof a.bytes === "string" && a.bytes) {
        if (typeof a.sha256 !== "string") throw new Error(`attachment.hash-missing: ${String(a.filename)} on ${o.id}`);
        const got = createHash("sha256").update(Buffer.from(a.bytes, "base64")).digest("hex");
        if (got !== a.sha256) throw new Error(`a file on ${o.id} (${String(a.filename)}) does not match its hash`);
      } else if (typeof a.sha256 === "string") {
        findings.push({ code: "attachment.known-missing", severity: "reduced", object: o.id,
          message: `${String(a.filename)} is known and was not carried; it is kept as a file this store does not have` });
      }
    }
  }

  const aside = `${ENTITIES_DIR}.before-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const parts = ["objects", "types", "lists", "series"];
  mkdirSync(aside, { recursive: true });
  for (const d of parts) if (existsSync(join(ENTITIES_DIR, d))) renameSync(join(ENTITIES_DIR, d), join(aside, d));
  try {
    for (const d of parts) mkdirSync(join(ENTITIES_DIR, d), { recursive: true });
    const k = storeKey();
    let files = 0;
    for (const t of env.types ?? []) writeAtomic(join(ENTITIES_DIR, "types", t.id.replace(/:/g, "%3A")), seal(k, JSON.stringify(t)));
    const out = new Map<string, Relation[]>();
    for (const r of env.relations ?? []) {
      if (!ids.has(r.from)) {
        findings.push({ code: "relation.dangling", severity: "reduced", message: `an edge from ${r.from}, which did not arrive, was dropped` });
        continue;
      }
      out.set(r.from, [...(out.get(r.from) ?? []), r]);
    }
    for (const o of env.objects ?? []) {
      const object = structuredClone(o);
      for (const a of attachmentsIn(object.properties)) {
        if (typeof a.bytes === "string" && a.bytes) {
          putFile(Buffer.from(a.bytes, "base64"), String(a.filename));
          files++;
          delete a.bytes;
        }
      }
      if (typeof object.version !== "number") object.version = 1;
      // Edges are kept with the object they go out of; `from` is where they are.
      const relations = out.get(o.id) ?? [];
      writeAtomic(join(ENTITIES_DIR, "objects", o.id.replace(/:/g, "%3A")), seal(k, JSON.stringify({ object, relations })));
    }
    // Lists and series, as they came: their own keys are this store's.
    for (const c of (env.collections as List[] | undefined) ?? []) sealedPut("lists", c.id, c);
    for (const se of (env.series as { id: string }[] | undefined) ?? []) sealedPut("series", se.id, se);
    reloadEntities();
    rmSync(aside, { recursive: true, force: true });
    return { findings, counts: { types: env.types?.length ?? 0, objects: env.objects?.length ?? 0, relations: env.relations?.length ?? 0, files } };
  } catch (e) {
    for (const d of parts) {
      rmSync(join(ENTITIES_DIR, d), { recursive: true, force: true });
      if (existsSync(join(aside, d))) renameSync(join(aside, d), join(ENTITIES_DIR, d));
    }
    rmSync(aside, { recursive: true, force: true });
    reloadEntities();
    throw e;
  }
}

/** For the tests: how many sealed entity files there are on disk. */
export function onDisk(): number {
  return existsSync(join(ENTITIES_DIR, "objects")) ? readdirSync(join(ENTITIES_DIR, "objects")).filter((n) => !n.startsWith(".")).length : 0;
}
