#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore

/**
 * `talaris-web`, run on the machine that serves Talaris on the web (docs/WEB.md, *Signing in*):
 *
 *   talaris-web passkey     a one-time code, good for ten minutes, to add one passkey from a browser
 *   talaris-web list        the passkeys and the sessions
 *
 * The only way to the first passkey, or to a new one when every other is lost: nothing on the web can reset access.
 */

import * as auth from "./auth.mjs";

const [verb] = process.argv.slice(2);
if (verb === "passkey") {
  const code = auth.makeCode();
  console.log(`A code to add one passkey, for ten minutes:\n\n    ${code}\n\nOn the device: ${auth.ORIGIN}/talaris/login → Add a passkey.`);
} else if (verb === "list") {
  const { passkeys, sessions } = auth.listed(null);
  console.log("Passkeys:");
  for (const p of passkeys) console.log(`  ${p.name} — added ${p.added.slice(0, 10)}, last used ${p.used ? p.used.slice(0, 10) : "never"}`);
  if (!passkeys.length) console.log("  none yet: talaris-web passkey");
  console.log("Sessions:");
  for (const s of sessions) console.log(`  ${s.passkey} — since ${s.started.slice(0, 10)}, last seen ${s.seen.slice(0, 16)} — ${s.device.slice(0, 60)}`);
  if (!sessions.length) console.log("  none");
} else {
  console.log("usage: talaris-web passkey | list");
  process.exit(2);
}
