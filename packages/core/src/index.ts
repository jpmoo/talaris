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

async function main(): Promise<void> {
  const home = ensureHome();
  startSealing();
  startSchedule();
  const server = await listen(SOCKET);
  console.log(`talaris-core ${VERSION}: ${projectsRoot()} (Home ${home.code}), on ${SOCKET}`);
  const stop = () => server.close(() => process.exit(0));
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

main().catch((e) => {
  console.error("talaris-core:", e instanceof Error ? e.message : e);
  // 78 is "configuration error": the unit does not restart on it, so a second
  // copy refusing to steal the socket does not spin.
  process.exit(78);
});
