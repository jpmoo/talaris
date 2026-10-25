// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { LIVE_MANIFEST, applyPatch, createRule, follow, type WritePatch } from "./interchange.js";

/**
 * `pnpm --filter @talaris/core measure`: the format's fixtures against
 * Talaris's own reading of it — the live binding's writes (`patch`, `create`,
 * `follow`) and the profile reads a consumer leans on — and the claim held to
 * what was earned, as Hermes' is. A claim is what the suite measured, never
 * what this code believes of itself.
 *
 * Only the operations below are Talaris's to answer here; the rest of the
 * suite (validating, importing, ordering lists) is reported as not measured
 * rather than failed, and claims nothing.
 */

type Type = { profiles?: Record<string, Record<string, unknown>> };
type Obj = { properties?: Record<string, unknown>; content?: string | null };

const V0 = ["task", "event", "contact", "note", "journal", "project"];
const blank = (v: unknown) => (v === "" ? undefined : v);
function read(type: Type, object: Obj, key: string, profile = "task"): unknown {
  const spec = type?.profiles?.[profile]?.[key];
  if (spec === undefined || spec === null) return undefined;
  if (spec === "content") return blank(object?.content);
  if (typeof spec === "string") return blank(object?.properties?.[spec]);
  if (typeof spec === "object" && (spec as { field?: string }).field) {
    const s = spec as { field: string; part?: string };
    const v = object?.properties?.[s.field] as Record<string, unknown> | undefined;
    if (v === null || v === undefined) return undefined;
    return blank(s.part ? v?.[s.part] : v);
  }
  return undefined;
}

const adapter = {
  conformance: { profiles: LIVE_MANIFEST.profiles, features: LIVE_MANIFEST.features },
  profilesOf: (t: Type) => Object.keys(t?.profiles ?? {}).filter((p) => V0.includes(p)),
  read,
  isComplete: (t: Type, o: Obj) => {
    const map = t?.profiles?.task as { status?: unknown; completeValues?: unknown[] } | undefined;
    if (!map?.status) return false;
    return (map.completeValues ?? []).includes(read(t, o, "status", "task"));
  },
  patch: (object: Record<string, unknown>, p: WritePatch) => applyPatch(object as never, p ?? {}),
  create: (body: Record<string, unknown>, how: { at: string; existing: Record<string, unknown> | null; types: { id: string }[] }) =>
    createRule(body as never, how.at, how.existing, (id) => how.types.some((t) => t.id === id))
      ?? { ok: true, created: true, object: { ...body, id: how.at }, fidelity: "full" as const, reports: [] },
  follow,
};
const MEASURED = new Set(["profilesOf", "read", "isComplete", "patch", "create", "follow"]);

const spec = process.env.PKM_SPEC ?? join(homedir(), "Documents/Scripts/hermesnotes/pkm-interchange");
if (!existsSync(join(spec, "fixtures"))) {
  console.error(`no pkm-interchange at ${spec} (set PKM_SPEC)`);
  process.exit(2);
}
const { runSuites, levelsFrom } = (await import(pathToFileURL(join(spec, "check/src/runner.js")).href)) as {
  runSuites: (a: unknown, dir: string) => { suite: string; level: number; id: string; op: string; pass: boolean; na?: boolean; got: unknown; roles?: string[] }[];
  levelsFrom: (r: unknown[]) => { roles: Record<"produce" | "consume" | "operate", number> };
};
const all = runSuites(adapter, join(spec, "fixtures"));
const results = all.filter((r) => MEASURED.has(r.op));

let suite = "";
for (const r of results) {
  if (r.suite !== suite) { suite = r.suite; console.log(`\n${suite}`); }
  const why = r.pass || r.na ? "" : `   ${String(JSON.stringify(r.got)).slice(0, 100)}`;
  console.log(`  ${r.na ? "n/a " : r.pass ? "pass" : "FAIL"}  L${r.level} ${r.id}${why}`);
}
const { roles } = levelsFrom(results);
const passed = results.filter((r) => r.pass).length, na = results.filter((r) => r.na).length;
console.log(`\n${passed}/${results.length - na} passing (${na} not applicable); ${all.length - results.length} cases are other operations, not measured here`);
console.log(`Talaris earns: operate ${roles.operate}`);
if (LIVE_MANIFEST.operate > roles.operate) {
  console.log(`\nThe live manifest overclaims: operate says ${LIVE_MANIFEST.operate}, earned ${roles.operate}.`);
  process.exit(1);
}
console.log(`The live manifest claims operate ${LIVE_MANIFEST.operate}; the suite earned ${roles.operate}.`);
