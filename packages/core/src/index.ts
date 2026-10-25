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

import { SOCKET, projectsRoot } from "./paths.js";
import { ensureHome } from "./projects.js";
import { listen, VERSION } from "./server.js";
import { startSealing } from "./sealed-projects.js";
import { startSchedule } from "./backup.js";
import { startWatching } from "./files.js";
import { startMeaning } from "./meaning.js";
import { forgetNonPeople } from "./entities.js";
import { startPlugins, stopPlugins } from "./plugins.js";

async function main(): Promise<void> {
  const home = ensureHome();
  startSealing();
  startSchedule();
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
