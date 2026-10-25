// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore

import { trusted } from "./entities.js";
import { backupPlugins, restorePlugins, type PluginBackup } from "./plugins.js";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { CONFIG_DIR, STATE_DIR } from "./paths.js";
import { exportEnvelope, importEnvelope, type Envelope, type Finding } from "./interchange.js";
import { sealTo, unsealWith } from "./seal.js";
import { readJson, writeAtomic, writeJson } from "./store.js";
import { DATA_DIR, adopt, storeKey, vaultForBackup, vaultPublicKey } from "./vault.js";
import { resealProjects } from "./sealed-projects.js";

/**
 * Backups: the entity store as an interchange export, sealed to the recovery
 * key, written to a folder of the person's choosing on a schedule.
 *
 * Sealing needs only the recovery key's public half, which Talaris keeps; so
 * backups run unattended, and nothing on this machine can open one. Reviving
 * needs the recovery key itself, typed in.
 *
 * Each backup is checked as it is made — by the format's own checker where
 * this machine has it, given the export through a pipe so that nothing
 * unsealed is ever written to disk — and the result is kept for Settings.
 */

export interface DataSettings {
  backupFolder?: string;
  schedule?: "off" | "daily" | "weekly";
  keep?: number;
}

export interface BackupRecord {
  at: string;
  file: string;
  bytes: number;
  objects: number;
  check: "passed" | "failed" | "not checked";
  detail?: string;
}

export interface BackupStatus {
  settings: DataSettings;
  last: BackupRecord | null;
  error: string | null;
  backups: { file: string; at: string; bytes: number }[];
}

const STATUS = join(STATE_DIR, "backups.json");
const SUFFIX = ".talaris-backup";
const FALLBACK = join(DATA_DIR, "backups");
const CHECKER = process.env.PKM_CHECK ?? join(homedir(), "Documents/Scripts/hermesnotes/pkm-interchange/check/src/cli.js");
const DAY = 24 * 60 * 60 * 1000;

export function dataSettings(): DataSettings {
  try {
    const c = readJson<{ data?: DataSettings }>(join(CONFIG_DIR, "config.json"));
    return c.data ?? {};
  } catch {
    return {};
  }
}

const expand = (p: string) => (p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);
function folder(): string {
  const f = dataSettings().backupFolder;
  return f ? expand(f) : FALLBACK;
}

function readStatus(): { last: BackupRecord | null; error: string | null } {
  try {
    return readJson(STATUS);
  } catch {
    return { last: null, error: null };
  }
}

export function listBackups(dir = folder()): { file: string; at: string; bytes: number }[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => n.endsWith(SUFFIX))
    .map((n) => {
      const st = statSync(join(dir, n));
      return { file: join(dir, n), at: st.mtime.toISOString(), bytes: st.size };
    })
    .sort((a, b) => b.at.localeCompare(a.at));
}

export function backupStatus(): BackupStatus {
  const s = readStatus();
  return { settings: dataSettings(), last: s.last, error: s.error, backups: listBackups() };
}

/**
 * The checker, if this machine has it: its own `assess`, handed the export on
 * standard input (`readFileSync(0)` — opening `/dev/stdin` fails on the socket
 * Node gives a child), so nothing unsealed is written anywhere.
 */
function check(env: Envelope): { check: BackupRecord["check"]; detail?: string } {
  const assess = join(dirname(CHECKER), "assess.js");
  if (!existsSync(assess)) return { check: "not checked", detail: "the pkm-interchange checker is not on this machine" };
  const script = `import { assess } from ${JSON.stringify(assess)}; import { readFileSync } from "node:fs";
    process.stdout.write(JSON.stringify(assess(JSON.parse(readFileSync(0, "utf8")))));`;
  try {
    const out = execFileSync("node", ["--input-type=module", "-e", script], { input: JSON.stringify(env), encoding: "utf8", timeout: 60000, maxBuffer: 16 << 20 });
    const r = JSON.parse(out) as { checks: { name: string; ok: boolean; detail: string }[]; produce: number };
    const failed = r.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`);
    return failed.length ? { check: "failed", detail: failed.join("; ") } : { check: "passed", detail: `produce level ${r.produce}` };
  } catch (e) {
    return { check: "failed", detail: String((e as { stderr?: string }).stderr || (e as Error).message).slice(0, 400) };
  }
}

/** Make one now. Answers what it made; a failure is kept for Settings too. */
export function backupNow(reason = "asked"): BackupRecord {
  try {
    storeKey();
    const env = exportEnvelope({ bytes: true });
    const verdict = check(env);
    const made = new Date();
    // Plugins' own parts too: their settings (never a secret) and the state they declare (plugins.ts).
    const payload = JSON.stringify({ kind: "talaris-backup", version: 1, made: made.toISOString(), reason, vault: vaultForBackup(), envelope: env, plugins: backupPlugins() });
    const sealed = sealTo(vaultPublicKey(), payload);
    const dir = folder();
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `talaris-${made.toISOString().replace(/[:.]/g, "-")}${SUFFIX}`);
    writeAtomic(file, sealed);
    const record: BackupRecord = { at: made.toISOString(), file, bytes: sealed.length, objects: env.objects?.length ?? 0, ...verdict };
    writeJson(STATUS, { last: record, error: null });
    prune(dir);
    return record;
  } catch (e) {
    writeJson(STATUS, { ...readStatus(), error: `${new Date().toISOString()}: ${(e as Error).message}` });
    throw e;
  }
}

function prune(dir: string): void {
  const keep = Math.max(1, Number(dataSettings().keep ?? 7));
  for (const old of listBackups(dir).slice(keep)) rmSync(old.file, { force: true });
}

interface Opened {
  made: string;
  plugins?: PluginBackup[];
  vault: { publicKey: string; wrapped: string; check: string };
  envelope: Envelope;
}

function open(file: string, recoveryKey: string): Opened {
  const data = unsealWith(recoveryKey, readFileSync(expand(file)));
  const o = JSON.parse(data.toString("utf8")) as Opened & { kind?: string };
  if (o.kind !== "talaris-backup") throw new Error("this is not a Talaris backup");
  return o;
}

/** What a backup holds, before anything is replaced. */
export function previewBackup(file: string, recoveryKey: string): { made: string; objects: number; types: number; relations: number; kinds: Record<string, number>; plugins: string[] } {
  const o = open(file, recoveryKey);
  const kinds: Record<string, number> = {};
  const profileOf = new Map((o.envelope.types ?? []).map((t) => [t.id, Object.keys(t.profiles ?? {})[0] ?? (t["talaris:role"] as string) ?? "other"]));
  for (const x of o.envelope.objects ?? []) {
    const k = x.stub ? "stub" : profileOf.get(x.type ?? "") ?? "other";
    kinds[k] = (kinds[k] ?? 0) + 1;
  }
  return { made: o.made, objects: o.envelope.objects?.length ?? 0, types: o.envelope.types?.length ?? 0, relations: o.envelope.relations?.length ?? 0, kinds , plugins: (o.plugins ?? []).map((p) => p.name) };
}

/**
 * Bring a backup back. The store as it is now is backed up first (so a
 * revival can itself be undone), the backup's key becomes the store's (so an
 * encrypted project sealed with it opens; projects sealed here are sealed again
 * with it), and then the envelope is imported — the same import as any other.
 */
export function reviveBackup(file: string, recoveryKey: string): { findings: Finding[]; counts: Record<string, number>; safety: string | null; plugins: ReturnType<typeof restorePlugins> } {
  const o = open(file, recoveryKey);
  let safety: string | null = null;
  try {
    safety = backupNow("before reviving a backup").file;
  } catch {
    safety = null; // a locked or empty store has nothing to lose
  }
  let before: Buffer | null = null;
  try { before = storeKey(); } catch { before = null; }
  adopt(o.vault, recoveryKey);
  const after = storeKey();
  if (before && !before.equals(after)) resealProjects(before, after);
  // The person's own backup: its linked files are theirs, kept as links (entities.ts, `trusted`).
  const result = trusted(() => importEnvelope(o.envelope));
  // After the things they refer to are back: a sync's state names them by id.
  const plugins = restorePlugins(o.plugins ?? []);
  return { ...result, safety, plugins };
}

let timer: NodeJS.Timeout | null = null;

/** On a schedule: checked every half hour, made when the last is a day (or a week) old. */
export function startSchedule(): void {
  if (timer) return;
  const tick = () => {
    const s = dataSettings();
    if (!s.schedule || s.schedule === "off") return;
    const every = s.schedule === "weekly" ? 7 * DAY : DAY;
    // The newest backup in the folder set now: one made before the folder changed is not there, and does not count.
    const newest = listBackups(folder())[0];
    if (newest && Date.now() - Date.parse(newest.at) < every) return;
    try {
      backupNow("scheduled");
      console.log("talaris-core: backed up");
    } catch (e) {
      console.error("talaris-core: backup failed:", (e as Error).message);
    }
  };
  setTimeout(tick, 60_000).unref();
  timer = setInterval(tick, 30 * 60_000);
  timer.unref();
}
