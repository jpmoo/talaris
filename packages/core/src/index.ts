#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore

/**
 * talaris-core: projects, canvases and writing, served on a Unix socket.
 *
 * Run by `talaris-core.service`. On start it makes sure Home exists — Home is
 * the project that is always there — then listens. SIGTERM closes the socket
 * cleanly so the next start finds nothing stale.
 */

// First: in demo mode it says where every folder is, before any module decides (demo.ts).
import { inDemo } from "./demo.js";
import { chmodSync, lstatSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR, SOCKET, STATE_DIR, projectsRoot } from "./paths.js";
import { DATA_DIR } from "./vault.js";
import { ensureHome } from "./projects.js";
import { listen, VERSION } from "./server.js";
import { startSealing } from "./sealed-projects.js";
import { startSchedule } from "./backup.js";
import { startWatching } from "./files.js";
import { startMeaning } from "./meaning.js";
import { forgetNonPeople } from "./entities.js";
import { startPlugins, stopPlugins } from "./plugins.js";

/**
 * Talaris's own folders, the person's alone: its settings (a plugin's choices,
 * the backup folder), what it knows of the state of things (a sync's copies of
 * synced words), and its store. Whatever made them, they are made so again at
 * every start, and the files in the first two with them.
 */
function keepPrivate(): void {
  for (const dir of [CONFIG_DIR, STATE_DIR, DATA_DIR]) {
    try { mkdirSync(dir, { recursive: true, mode: 0o700 }); chmodSync(dir, 0o700); } catch { /* said when it is used */ }
  }
  const walk = (dir: string) => {
    let names: string[] = [];
    try { names = readdirSync(dir); } catch { return; }
    for (const n of names) {
      const p = join(dir, n);
      try {
        const st = lstatSync(p);
        if (st.isSymbolicLink()) continue;
        if (st.isDirectory()) { chmodSync(p, 0o700); walk(p); } else chmodSync(p, st.mode & 0o700);
      } catch { /* gone meanwhile */ }
    }
  };
  walk(CONFIG_DIR);
  walk(STATE_DIR);
}

async function main(): Promise<void> {
  keepPrivate();
  const home = ensureHome();
  // The demo world made the first time (demo-seed.ts); and no backups of it.
  if (inDemo) {
    const { seedDemo } = await import("./demo-seed.js");
    try { if (seedDemo()) console.log("talaris-core: demo world made"); } catch (e) { console.log(`talaris-core: demo not made: ${(e as Error).stack}`); }
  }
  startSealing();
  if (!inDemo) startSchedule();
  // Files: every project's folder read once, then followed (files.ts).
  try { startWatching(); } catch (e) { console.log(`talaris-core: files not watched yet: ${(e as Error).message}`); }
  // Search by meaning: kept current in the background, when a model server is set (meaning.ts).
  startMeaning();
  // People once made from calendars' own addresses, put right (entities.ts).
  try {
    const n = forgetNonPeople();
    if (n) console.log(`talaris-core: ${n} calendar addresses were people; no longer`);
  } catch (e) {
    console.log(`talaris-core: people not checked yet: ${(e as Error).message}`);
  }
  const server = await listen(SOCKET);
  // Plugins after the socket: they may ask for what it serves.
  startPlugins();
  console.log(`talaris-core ${VERSION}: ${projectsRoot()} (Home ${home.code}), on ${SOCKET}`);
  const stop = () => { stopPlugins(); server.close(() => process.exit(0)); };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

// `talaris-core mcp`: the MCP server, over standard input, beside a running core.
if (process.argv[2] === "mcp") {
  const { serveMcp } = await import("./mcp.js");
  serveMcp();
} else main().catch((e) => {
  console.error("talaris-core:", e instanceof Error ? e.message : e);
  // 78 is "configuration error": the unit does not restart on it, so a second
  // copy refusing to steal the socket does not spin.
  process.exit(78);
});
