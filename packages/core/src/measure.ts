// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { isCompleteBy, readSlot, type ProfiledObject, type ProfiledType } from "./profile.js";
import { LIVE_MANIFEST, applyPatch, createRule, fileRule, follow, type WritePatch } from "./interchange.js";

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

type Type = ProfiledType;
type Obj = ProfiledObject;

const V0 = ["task", "event", "contact", "note", "journal", "project"];
// The profile reads are the store's own (profile.ts): what is measured is what Talaris runs.
const read = (type: Type, object: Obj, key: string, profile = "task") => readSlot(type, object, key, profile);

const adapter = {
  conformance: { profiles: LIVE_MANIFEST.profiles, features: LIVE_MANIFEST.features },
  profilesOf: (t: Type) => Object.keys(t?.profiles ?? {}).filter((p) => V0.includes(p)),
  read,
  isComplete: (t: Type, o: Obj) => isCompleteBy(t, o),
  patch: (object: Record<string, unknown>, p: WritePatch) => applyPatch(object as never, p ?? {}),
  // A file by its hash, by the rule /interchange/files applies; `held` stands in for the store's files.
  file: (held: Record<string, string>, args: { op?: string; sha256?: string; bytes?: string }) => {
    const sha = args.sha256 ?? "";
    const ruled = fileRule((h) => h in held, args.op ?? "", sha, args.bytes !== undefined ? Buffer.from(args.bytes, "base64") : undefined);
    return args.op === "get" && ruled.ok ? { ...ruled, bytes: held[sha] } : ruled;
  },
  create: (body: Record<string, unknown>, how: { at: string; existing: Record<string, unknown> | null; types: { id: string }[] }) =>
    createRule(body as never, how.at, how.existing, (id) => how.types.some((t) => t.id === id))
      ?? { ok: true, created: true, object: { ...body, id: how.at }, fidelity: "full" as const, reports: [] },
  follow,
};
const MEASURED = new Set(["profilesOf", "read", "isComplete", "patch", "create", "follow", "file"]);

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
