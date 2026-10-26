// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore

/**
 * Demo mode (DESIGN, *Demo*): Talaris running on a made-up world, to show it
 * off — its own store, Projects folder, settings and state, under
 * `~/.local/share/talaris-demo`, and a key of its own in place of the
 * keyring's. The person's own world is not read or written while it runs;
 * leaving is a restart into it again.
 *
 * Chosen by a mark, `~/.config/talaris/demo` (Settings, General), read here
 * before anything else is: every folder this process uses is decided from
 * the environment as its module loads (paths.ts, vault.ts, plugins.ts), so
 * this module is the first `index.ts` imports, and sets the environment
 * those read. A run already told where to live (a test, the end-to-end
 * check: `TALARIS_DATA_DIR`) is left as it was told.
 *
 * In demo nothing reaches past it: no plugins (no sync can carry made-up
 * things into another app), no backups; the calendar shows the demo's own
 * (the surfaces read `calendar.json` here, not the accounts).
 */

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const xdg = (name: string, fallback: string) => (process.env[name] ?? "").trim() || join(homedir(), fallback);

/** The mark that chooses demo mode: in the person's own settings folder, so it is found before demo's is used. */
export const DEMO_MARK = join(xdg("XDG_CONFIG_HOME", ".config"), "talaris", "demo");
/** Where the demo world lives. */
export const DEMO_ROOT = process.env.TALARIS_DEMO_ROOT ?? join(xdg("XDG_DATA_HOME", ".local/share"), "talaris-demo");

export const inDemo = existsSync(DEMO_MARK) && !process.env.TALARIS_DATA_DIR;

if (inDemo) {
  mkdirSync(DEMO_ROOT, { recursive: true, mode: 0o700 });
  // The demo's own key: nothing of it is the person's, so it needs no keyring and asks for no recovery key.
  const keyFile = join(DEMO_ROOT, "key");
  if (!existsSync(keyFile)) writeFileSync(keyFile, randomBytes(32).toString("base64"), { mode: 0o600 });
  Object.assign(process.env, {
    TALARIS_DEMO: "1",
    TALARIS_DATA_DIR: join(DEMO_ROOT, "data"),
    TALARIS_CONFIG_DIR: join(DEMO_ROOT, "config"),
    TALARIS_STATE_DIR: join(DEMO_ROOT, "state"),
    TALARIS_PROJECTS: join(DEMO_ROOT, "Projects"),
    TALARIS_PLUGINS: join(DEMO_ROOT, "plugins"),
    TALARIS_KEY: readFileSync(keyFile, "utf8").trim(),
  });
}
