// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore

/**
 * Morgan on the web (docs/WEB.md, *Morgan*): the desktop's conversation page, talking to Morgan's brain over the
 * brain's own socket — this machine is where the brain runs (home-server), so there is no device between. Text only:
 * nothing here listens or speaks.
 *
 * **The socket can do anything** (heymorgan's docs/protocol.md, §1: whatever reaches it may add an MCP server, which
 * runs a program). So the page's lines are let through by name, and only those the conversation page sends: a turn
 * typed, the conversations and their record, reminders. `ask` loses any `files` (paths on this machine); `admin`
 * passes only cancelling a reminder. Anything else is answered as Morgan answers an unknown command.
 *
 * **What Morgan is doing** (`watch`, §3) is followed on one connection while any page wants it, and handed to each
 * (server.mjs, the `morgan` events).
 */

import { createConnection } from "node:net";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** The brain's socket: `HEYMORGAN_SOCKET`; a server's, in its checkout; else this user's own daemon's. */
export const SOCKET = process.env.HEYMORGAN_SOCKET ?? [join(homedir(), "heymorgan", "data", "heymorgan.sock"),
  join(process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid()}`, "heymorgan.sock")].find((p) => existsSync(p))
  ?? join(homedir(), "heymorgan", "data", "heymorgan.sock");

/** The commands the conversation page sends (ui/morgan/index.html), and nothing else. */
const PLAIN = new Set(["status", "type", "new", "interview", "stop", "interrupt", "continue", "rate", "settle", "delete",
  "reminders", "recent", "days", "conversation", "incognito"]);
const ADMIN_OPS = new Set(["reminders.cancel"]);
/** A project's chat (projectchat.js; the desktop's core.py `projectChat`): Morgan's `project`, these four ops only. */
const PROJECT_OPS = new Set(["list", "history", "chat", "clear"]);

/** The line as it may go to the brain, or null. */
export function allowed(line) {
  const text = String(line ?? "").replace(/[\r\n]+/g, " ").trim();
  const word = text.split(" ")[0];
  if (PLAIN.has(word)) return text;
  if (word === "ask") {
    try {
      const a = JSON.parse(text.slice(4));
      // Files are paths on the brain's machine, never the web's to name; what was attached travels as its content.
      return `ask ${JSON.stringify({ text: String(a.text ?? ""), attached: Array.isArray(a.attached) ? a.attached : [] })}`;
    } catch { return null; }
  }
  if (word === "project") {
    try { return PROJECT_OPS.has(JSON.parse(text.slice(8)).op) ? text : null; } catch { return null; }
  }
  if (word === "admin") {
    try { return ADMIN_OPS.has(JSON.parse(text.slice(6)).op) ? text : null; } catch { return null; }
  }
  return null;
}

/** One command, and its one line of answer (or Morgan's way of saying it is not there). */
export function command(line, timeoutMs = 20_000) {
  const ok = allowed(line);
  if (!ok) return Promise.resolve(JSON.stringify({ ok: false, error: `not on the web: ${String(line).split(" ")[0]}` }));
  return new Promise((resolve) => {
    let out = "";
    const s = createConnection(SOCKET);
    const done = (text) => { clearTimeout(timer); s.destroy(); resolve(text); };
    const timer = setTimeout(() => done(JSON.stringify({ ok: false, error: "Morgan didn't answer in time" })), timeoutMs);
    s.on("connect", () => s.write(`${ok}\n`));
    s.on("data", (c) => { out += c; });
    s.on("end", () => done(out.trim() || JSON.stringify({ ok: false, error: "Morgan didn't answer" })));
    s.on("error", (e) => done(JSON.stringify({ ok: false, error: `Morgan is not running (${e.code || e.message})` })));
  });
}

// ------------------------------------------------------------ what Morgan is doing, followed

const hearers = new Set();
let stream = null;
let retry = null;

function follow() {
  if (stream || !hearers.size) return;
  let buffer = "";
  const s = createConnection(SOCKET);
  stream = s;
  s.on("connect", () => s.write("watch\n"));
  s.on("data", (c) => {
    buffer += c;
    const lines = buffer.split("\n");
    buffer = lines.pop();
    for (const line of lines) if (line.trim()) for (const h of hearers) h(line);
  });
  const lost = () => {
    if (stream !== s) return;
    stream = null;
    for (const h of hearers) h(JSON.stringify({ type: "state", state: "absent" }));
    // The brain's unit brings it back within seconds; looked for again a little after.
    clearTimeout(retry);
    if (hearers.size) retry = setTimeout(follow, 3000);
  };
  s.on("close", lost);
  s.on("error", lost);
}

/** Each of Morgan's events, as the brain writes it, until the returned function is called. */
export function hear(fn) {
  hearers.add(fn);
  follow();
  return () => {
    hearers.delete(fn);
    if (!hearers.size && stream) { const s = stream; stream = null; s.destroy(); }
  };
}

// ------------------------------------------------------------ a question from elsewhere (Siri)

/**
 * A typed turn, waited on: Morgan's answer as it would be spoken (its `sentence` events, markdown gone), for
 * something that only asks and reads back — "Hey Siri, Ask Morgan", an iPhone Shortcut (docs/WEB.md, *Asking from
 * Siri*). Answered when Morgan has written its answer, or with what there is after `ms` — a Shortcut does not wait long.
 */
export function askAndWait(text, ms = 25_000) {
  const said = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!said) return Promise.resolve({ ok: false, error: "Nothing was asked" });
  return new Promise((resolve) => {
    const sentences = [];
    let whole = "", started = false, finished = false;
    const finish = (extra = {}) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      stop();
      const answer = (sentences.join(" ") || whole.replace(/[*_`#>]/g, "")).replace(/\s+/g, " ").trim();
      resolve(answer ? { ok: true, answer, ...extra } : { ok: false, error: "Morgan is still working on that. Look in Talaris for the answer.", ...extra });
    };
    const stop = hear((line) => {
      let e;
      try { e = JSON.parse(line); } catch { return; }
      if (e.type === "user") started = true;
      if (!started) return;
      if (e.type === "sentence" && e.text) sentences.push(e.text);
      if (e.type === "assistant") { whole = String(e.text ?? ""); finish(); }
      if (e.type === "state" && e.state === "idle" && (sentences.length || whole)) finish();
      if (e.type === "state" && e.state === "absent") finish();
    });
    const timer = setTimeout(() => finish({ partial: true }), ms);
    // Followed first, then asked: nothing of the answer is missed.
    setTimeout(() => command(`type ${said}`).then((r) => {
      try { const j = JSON.parse(r); if (!j.ok) { finished = true; clearTimeout(timer); stop(); resolve({ ok: false, error: j.error || "Morgan didn't take it" }); } } catch { /* answered below */ }
    }), 150);
  });
}
