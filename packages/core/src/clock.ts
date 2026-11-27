// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore

/**
 * The user's clock, shared: the time zone where they are, said by the machine that follows them (the laptop, whose
 * Location sets its zone as it travels: surfaces/location.py), and taken up by the machines that have no screen of
 * their own to be where anyone is — home-server, whose core answers Morgan and the web. So in Phoenix, "what's on at
 * nine?" is Phoenix's nine, wherever the question is answered.
 *
 * **One record, the latest kept** (`clock:` — zone, which machine, when), carried by sync like the calendar's view
 * (calendar-view.ts). **Who follows it:** a machine whose surfaces are not running (no `talaris-surfaces.sock`) —
 * nobody sits at it, so it has no clock of its own to keep. One with a screen keeps its own: its system's zone, set
 * by its Location or by hand. Following is setting `process.env.TZ`, which Node reads again when it is set; the
 * core's local dates (localtime.ts) and every time it says follow from that.
 *
 * Not the system's zone: home-server's logs and timers stay on its own (`timedatectl`).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./vault.js";
import { machine, write as writeRecord, type Rec } from "./records.js";

export interface Clock { zone: string; by: string; at: string }

const FILE = () => join(DATA_DIR, "clock.json");
const SURFACES = () => join(process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.() ?? 1000}`, "talaris-surfaces.sock");

export const validZone = (zone: unknown): zone is string => {
  if (typeof zone !== "string" || !zone) return false;
  try { new Intl.DateTimeFormat("en-US", { timeZone: zone }); return true; } catch { return false; }
};

function kept(): Clock | null {
  try { return JSON.parse(readFileSync(FILE(), "utf8")) as Clock; } catch { return null; }
}
function keep(c: Clock): void {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(FILE(), JSON.stringify(c));
}

/** Whether this machine follows the shared clock: nobody's screen is here (its surfaces are not running). */
export const follows = (): boolean => !existsSync(SURFACES());

/** The zone this process now reads by: TZ if set, else the system's. */
export const zoneNow = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone;

/** On a machine that follows, the shared zone taken up; elsewhere nothing. */
export function takeUp(): void {
  const c = kept();
  if (c && follows() && validZone(c.zone) && process.env.TZ !== c.zone) process.env.TZ = c.zone;
}

/** Where the user is now, said by this machine (its zone changed): kept, taken up here, and sent on. */
export function share(zone: string): Clock {
  const c: Clock = { zone, by: machine().name, at: new Date().toISOString() };
  const was = kept();
  process.env.TZ = zone;
  if (was?.zone === zone) return was;
  keep(c);
  writeRecord({ of: "clock:", set: { ...c } });
  return c;
}

/** Another machine's word (sync-apply.ts): kept if it is newer than what is kept, and taken up if this one follows. */
export function applyClock(r: Rec): boolean {
  const zone = r.set?.zone, at = String(r.set?.at ?? "");
  if (!validZone(zone)) return true;
  const was = kept();
  if (!was || at > was.at) {
    keep({ zone, by: String(r.set?.by ?? ""), at });
    takeUp();
  }
  return true;
}

/** What GET /time/zone says: the zone this core answers in, and the shared one. */
export const describe = () => ({ zone: zoneNow(), follows: follows(), shared: kept() });
