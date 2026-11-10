// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore

/**
 * A desktop notification, through the notification server Talaris runs
 * (surfaces/notifyd.py), so it lands in the notification area with the rest.
 * Fire and forget: nothing waits on it, and a session with no server says nothing.
 *
 * The timeout is written `int32 -1`: a bare `-1` is taken by gdbus for an
 * option, and it prints its usage and sends nothing — which is how the plugins'
 * notifications went unseen.
 */

import { execFile } from "node:child_process";

export function notifyDesktop(app: string, title: string, body: string): void {
  // Never from a test: it would land on the screen of whoever runs them. NODE_TEST_CONTEXT is node --test's own mark.
  if (process.env.TALARIS_NO_NOTIFY || process.env.NODE_TEST_CONTEXT) return;
  execFile("gdbus", ["call", "--session", "--dest", "org.freedesktop.Notifications", "--object-path", "/org/freedesktop/Notifications",
    "--method", "org.freedesktop.Notifications.Notify", app, "0", "", title, body, "[]", "{}", "int32 -1"], { timeout: 5000 }, () => undefined);
}
