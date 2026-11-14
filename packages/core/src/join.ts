// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore

/**
 * Joining (docs/SYNC.md, *Keys and joining*): this machine made one Talaris with
 * the others in a sync folder — filled from them, everything at their ids.
 *
 *   node packages/core/dist/src/join.js --folder <the sync folder>
 *
 * Run with talaris-core stopped; start it after, and it fills itself from the
 * folder. What this machine had is not merged in — the machine it joins wins
 * everywhere — and not deleted either: its data folder and its projects are
 * moved aside, dated (`…-before-join-<when>`), to be looked through by hand.
 * Installed plugins and the web engine's profiles stay where they are.
 *
 * The store key is taken from the folder's `vault.json` with the recovery key,
 * asked for here and never shown (or TALARIS_RECOVERY_KEY, under test).
 */

import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { createConnection } from "node:net";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { DATA_DIR, ENTITIES_DIR } from "./vault.js";
import { SOCKET, projectsRoot } from "./paths.js";

const KEEP = ["plugins", "web", "apps"];

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function coreRunning(): Promise<boolean> {
  return new Promise((done) => {
    const s = createConnection(SOCKET);
    s.on("connect", () => { s.destroy(); done(true); });
    s.on("error", () => done(false));
  });
}

function askHidden(question: string): Promise<string> {
  if (process.env.TALARIS_RECOVERY_KEY) return Promise.resolve(process.env.TALARIS_RECOVERY_KEY);
  return new Promise((done) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const out = rl as unknown as { _writeToOutput: (s: string) => void; output: NodeJS.WriteStream };
    process.stdout.write(question);
    out._writeToOutput = () => { /* what is typed is not shown */ };
    rl.question("", (answer) => { rl.close(); process.stdout.write("\n"); done(answer.trim()); });
  });
}

async function main(): Promise<void> {
  const folder = arg("--folder");
  if (!folder || !existsSync(folder)) throw new Error("--folder: the sync folder, already shared with the machine to join");
  const shared = join(folder, "vault.json");
  if (!existsSync(shared)) throw new Error(`${shared} is not there yet: start sync on the first machine, and let the folder arrive`);
  if (await coreRunning()) throw new Error("talaris-core is running: stop it first (systemctl --user stop talaris-core)");

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  // What this machine had, moved aside whole; what is the machine's own, put back.
  if (existsSync(DATA_DIR)) {
    const aside = `${DATA_DIR}-before-join-${stamp}`;
    renameSync(DATA_DIR, aside);
    mkdirSync(DATA_DIR, { recursive: true });
    for (const n of KEEP) if (existsSync(join(aside, n))) renameSync(join(aside, n), join(DATA_DIR, n));
    console.log(`Moved aside: ${aside}`);
  }
  const root = projectsRoot();
  if (existsSync(root)) {
    const aside = `${root}-before-join-${stamp}`;
    renameSync(root, aside);
    console.log(`Moved aside: ${aside}`);
  }
  mkdirSync(root, { recursive: true });
  mkdirSync(ENTITIES_DIR, { recursive: true });

  // The same store key as the others, opened with the recovery key.
  const { adopt } = await import("./vault.js");
  const recovery = await askHidden("Recovery key: ");
  adopt(JSON.parse(readFileSync(shared, "utf8")), recovery);

  const { setSyncing } = await import("./records.js");
  const { setFolder, tick, startSync } = await import("./sync-folder.js");
  setSyncing(true);
  setFolder(folder);
  // Filled now, before Talaris first starts here: so it finds the others' Home and makes no Home of its own —
  // which, written as this machine's change, would reach the others.
  const { writeFileSync } = await import("node:fs");
  const flag = join(DATA_DIR, "sync", "joining");
  writeFileSync(flag, new Date().toISOString());
  const { startRecordingProjects } = await import("./project-records.js");
  startRecordingProjects();
  startSync();
  const n = tick();
  const { rmSync } = await import("node:fs");
  rmSync(flag, { force: true });
  console.log(`Joined: ${n} change(s) applied from the folder.`);
  console.log("Start Talaris: systemctl --user start talaris-core");
}

main().catch((e) => { console.error(`join: ${(e as Error).message}`); process.exit(1); });
