// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore

import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";

/**
 * Where things live. The XDG variables are honored, and **unset and empty are
 * both fallbacks**: a KDE session exports `XDG_DATA_HOME` as an empty string,
 * and Talaria learned that reading it literally puts everything at the root.
 */
function xdg(name: string, fallback: string): string {
  const value = process.env[name];
  return value && value.trim() ? value : join(homedir(), fallback);
}

export const CONFIG_DIR = process.env.TALARIS_CONFIG_DIR ?? join(xdg("XDG_CONFIG_HOME", ".config"), "talaris");
export const STATE_DIR = process.env.TALARIS_STATE_DIR ?? join(xdg("XDG_STATE_HOME", ".local/state"), "talaris");

/**
 * The socket. In the runtime directory, which is private to the user and
 * cleared at logout — so no port is open, and nothing stale survives a reboot.
 */
export const SOCKET =
  process.env.TALARIS_SOCKET ?? join(process.env.XDG_RUNTIME_DIR || join(STATE_DIR, "run"), "talaris.sock");

interface Config {
  projectsRoot?: string;
}

function readConfig(): Config {
  try {
    return JSON.parse(readFileSync(join(CONFIG_DIR, "config.json"), "utf8")) as Config;
  } catch {
    return {};
  }
}

/**
 * Where projects live. `~/Projects` unless the settings say otherwise; the
 * environment wins over both, which is how the tests keep away from the real
 * one.
 */
export function projectsRoot(): string {
  const configured = process.env.TALARIS_PROJECTS ?? readConfig().projectsRoot;
  if (!configured) return join(homedir(), "Projects");
  return configured.startsWith("~/") ? join(homedir(), configured.slice(2)) : configured;
}

/** Talaris's own folder inside a project: hidden, so the folder stays the user's. */
export const MACHINERY = ".talaris";
export const WRITING = "Writing";
/** A project's files — attached to a page or a canvas note — in a visible folder of their own. */
export const FILES = "Files";
