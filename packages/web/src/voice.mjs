// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore

/**
 * Morgan's voice on the web (docs/WEB.md, *Morgan's voice on the web*): what the browser recorded, turned into words,
 * and Morgan's sentences turned into sound — by Morgan's own speech service (heymorgan's `speech.mjs serve`, on
 * home-ai), the one the brain uses for its devices. Morgan's socket has no command that takes sound or gives it (its
 * speech is offered only to devices on the server link, with a device key that can do everything), so the web side
 * asks the service itself, as the brain does: `POST /transcribe` (16 kHz 16-bit mono PCM in, `{text}` out) and
 * `POST /speak` (`{text}` in, 16-bit mono PCM at `X-Rate` out), each with `Authorization: Bearer <key>`.
 *
 * - Where the service is: `TALARIS_WEB_SPEECH_URL` and `TALARIS_WEB_SPEECH_KEY`, or else the brain's own settings
 *   (`speechUrl`, `speechKey` in `HEYMORGAN_CONFIG`, or `~/heymorgan/data/config.json`), read at each use so a
 *   changed key is taken up. The key is sent to the service and nowhere else: never logged, never in an answer.
 * - What the browser recorded (an iPhone's MediaRecorder gives AAC in MP4, Chrome's Opus in WebM, Firefox's Opus in
 *   Ogg) is made 16 kHz mono PCM by ffmpeg, from a file (an MP4's index may be at its end, which a pipe cannot reach),
 *   at most two minutes of it. Nothing is kept: the file goes as soon as it is read.
 * - Morgan's sentence comes back as WAV, which every browser plays.
 */

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const MOST_SECONDS = 120;
/** The longest a recording may be as sent (two minutes of AAC is about 1 MB; WAV from a browser that sends it, ~4 MB). */
export const MOST_BYTES = 8 * 1024 * 1024;

/** The brain's settings, where speech is said to be. */
function brainConfig() {
  const file = process.env.HEYMORGAN_CONFIG ?? join(process.env.HEYMORGAN_DATA ?? join(homedir(), "heymorgan", "data"), "config.json");
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return {}; }
}

/** The speech service: `{ url, key, prompt }`, or null when none is set. */
function service() {
  const cfg = brainConfig();
  const url = process.env.TALARIS_WEB_SPEECH_URL ?? cfg.speechUrl;
  if (!url) return null;
  return { url: String(url).replace(/\/+$/, ""), key: process.env.TALARIS_WEB_SPEECH_KEY ?? cfg.speechKey ?? "", sttPrompt: cfg.sttPrompt ?? "" };
}

async function ask(path, body, headers, ms = 60_000) {
  const s = service();
  if (!s) throw new Error("Morgan's speech service is not set (speechUrl in Morgan's settings, or TALARIS_WEB_SPEECH_URL)");
  let r;
  try {
    r = await fetch(`${s.url}${path}`, { method: "POST", body, headers: { ...(s.key ? { authorization: `Bearer ${s.key}` } : {}), ...headers }, signal: AbortSignal.timeout(ms) });
  } catch (e) { throw new Error(`Morgan's speech service is not answering (${e.cause?.code || e.name})`); }
  if (!r.ok) throw new Error(`Morgan's speech service answered ${r.status}`);
  return r;
}

/** A recording, as the browser made it, as 16 kHz 16-bit mono PCM. */
export function toPcm(audio) {
  return new Promise((resolve, reject) => {
    const dir = mkdtempSync(join(process.env.XDG_RUNTIME_DIR || tmpdir(), "talaris-voice-"));
    const file = join(dir, "heard");
    writeFileSync(file, audio, { mode: 0o600 });
    const done = () => rmSync(dir, { recursive: true, force: true });
    const ff = spawn("ffmpeg", ["-nostdin", "-hide_banner", "-loglevel", "error", "-i", file, "-t", String(MOST_SECONDS),
      "-vn", "-ac", "1", "-ar", "16000", "-f", "s16le", "pipe:1"], { stdio: ["ignore", "pipe", "pipe"] });
    const out = [];
    let err = "";
    ff.stdout.on("data", (c) => out.push(c));
    ff.stderr.on("data", (c) => { err += c; });
    ff.on("error", (e) => { done(); reject(new Error(e.code === "ENOENT" ? "ffmpeg is not installed on the web side" : e.message)); });
    ff.on("close", (code) => {
      done();
      if (code !== 0) return reject(new Error(`That recording could not be read (${err.trim().split("\n").pop() || `ffmpeg ${code}`})`));
      resolve(Buffer.concat(out));
    });
  });
}

/** What was said in a recording; `name` is Morgan's, for whisper to expect, with the brain's own words to expect. */
export async function transcribe(audio, name = "Morgan") {
  const pcm = await toPcm(audio);
  // Under a quarter of a second is a press, not something said.
  if (pcm.length < 16000 * 2 / 4) return "";
  const prompt = `${name}. ${service()?.sttPrompt ?? ""}`.trim();
  const r = await ask("/transcribe", pcm, { "content-type": "application/octet-stream", "x-prompt": encodeURIComponent(prompt) });
  return String((await r.json()).text ?? "").trim();
}

/** A sentence of Morgan's as WAV, in the voice the brain keeps loaded on the service. */
export async function speak(text) {
  const said = String(text ?? "").replace(/\s+/g, " ").trim().slice(0, 1000);
  if (!said) return null;
  const r = await ask("/speak", JSON.stringify({ text: said }), { "content-type": "application/json" });
  const pcm = Buffer.from(await r.arrayBuffer());
  return wav(pcm, Number(r.headers.get("x-rate")) || 24000);
}

/** 16-bit mono PCM at `rate`, with a WAV header. */
export function wav(pcm, rate) {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + pcm.length, 4); h.write("WAVE", 8);
  h.write("fmt ", 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write("data", 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}
