// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore

/**
 * A picture described by Morgan (heymorgan's protocol 1.7, `describe`): what
 * it is, what it shows, any text in it — by the model Morgan looks with. Asked
 * on Morgan's own socket, as Talaris's other Morgan calls are; nothing said,
 * kept, remembered or recorded on its side. For a picture, or a scanned page,
 * in which OCR found no words (filetext.ts).
 *
 * Answers the description; "" when Morgan saw nothing to say; null when Morgan
 * could not be asked (not running, too old to know `describe`), so the file
 * waits and is tried again rather than taken for one with no words.
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";

const SOCKET = () => process.env.HEYMORGAN_SOCKET || join(process.env.XDG_RUNTIME_DIR || "/tmp", "heymorgan.sock");
/** Larger than this is not sent: a picture that size is a photograph, and Morgan's side reads it whole. */
const LARGEST = 20 * 1024 * 1024;

export function morganDescribe(bytes: Buffer, _name: string): Promise<string | null> {
  if (bytes.length > LARGEST) return Promise.resolve("");
  return ask({ image: bytes.toString("base64") });
}

/** A file's words described by Morgan (its chat model): what the file is and what it is about. Null: Morgan could not be asked. */
export function morganDescribeText(text: string, name: string): Promise<string | null> {
  return ask({ text: text.slice(0, 12_000), name });
}

/**
 * What is in a project described by Morgan as what the project is for (protocol 1.9). Null: Morgan could not be
 * asked, or is too old to know a project from a file — which would describe it as a file, and that is not kept.
 */
export function morganDescribeProject(text: string, name: string): Promise<string | null> {
  return morganCommand(`describe ${JSON.stringify({ text: text.slice(0, 12_000), name, what: "project" })}`).then((r) =>
    r?.ok && r.what === "project" ? String(r.text ?? "").trim() : null);
}

function ask(body: Record<string, unknown>): Promise<string | null> {
  return morganCommand(`describe ${JSON.stringify(body)}`).then((r) =>
    // An older Morgan answers "unknown command": not asked, then.
    r?.ok ? String(r.text ?? "").trim() : null);
}

/** One command on Morgan's socket, and its one line of answer; null when Morgan could not be asked. */
export function morganCommand(line: string, timeout = 240_000): Promise<Record<string, unknown> | null> {
  return new Promise((ok) => {
    const chunks: Buffer[] = [];
    let done = false;
    const finish = (v: Record<string, unknown> | null) => { if (!done) { done = true; ok(v); } };
    const sock = createConnection({ path: SOCKET(), allowHalfOpen: false });
    sock.setTimeout(timeout, () => { sock.destroy(); finish(null); });
    sock.on("error", () => finish(null));
    sock.on("data", (c) => {
      chunks.push(c);
      // One line of answer, then Morgan closes; taken as soon as it is whole.
      if (c.includes(10)) sock.end();
    });
    sock.on("end", () => {
      try {
        finish(JSON.parse(Buffer.concat(chunks).toString("utf8").trim().split("\n").pop() || "{}") as Record<string, unknown>);
      } catch { finish(null); }
    });
    // Written, and the connection left open: Morgan drops one half-closed before it answers.
    sock.on("connect", () => sock.write(`${line}\n`));
  });
}

/**
 * heymorgan on this machine, as the surfaces judge it (morgan.py, `installed`): its socket there, or its user
 * service known to systemd. Without it nothing is described, and nothing says a description is coming.
 * TALARIS_NO_MORGAN=1: as though it were not.
 */
let serviceKnown = false;
let serviceAsked = 0;
export function morganInstalled(): boolean {
  if (process.env.TALARIS_NO_MORGAN) return false;
  if (existsSync(SOCKET())) return true;
  // systemd asked off the request, a couple of minutes apart; its last answer stands meanwhile.
  if (Date.now() - serviceAsked > 120_000) {
    serviceAsked = Date.now();
    execFile("systemctl", ["--user", "cat", "heymorgan.service"], { timeout: 3000 }, (err) => { serviceKnown = !err; });
  }
  return serviceKnown;
}
