// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore
//
// Search by meaning through Morgan (meaning.ts, `via: "morgan"`): the core's own
// embedder, asking a stand-in for Morgan on a socket of its own — never the
// Morgan running on this machine.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const sandbox = mkdtempSync(join(tmpdir(), "talaris-morgan-embed-"));
process.env.TALARIS_DATA_DIR = join(sandbox, "data");
process.env.TALARIS_PROJECTS = join(sandbox, "Projects");
process.env.TALARIS_CONFIG_DIR = join(sandbox, "config");
process.env.TALARIS_STATE_DIR = join(sandbox, "state");
process.env.TALARIS_KEY = randomBytes(32).toString("base64");
process.env.TALARIS_NO_NOTIFY = "1";
const sock = join(sandbox, "morgan.sock");
process.env.HEYMORGAN_SOCKET = sock;

const meaning = await import("../src/meaning.js");

/** A stand-in Morgan: each line asked, answered as `answer` says, and kept. */
const heard: string[] = [];
let answer: (line: string) => Record<string, unknown> = () => ({ ok: false, error: "unset" });
let morgan: Server | null = null;
const listen = () => new Promise<void>((ok) => {
  morgan = createServer((c) => {
    let got = "";
    c.on("data", (d) => {
      got += d;
      if (!got.includes("\n")) return;
      const line = got.trim();
      heard.push(line);
      c.end(JSON.stringify(answer(line)) + "\n");
    });
  });
  morgan.listen(sock, ok);
});
after(() => { morgan?.close(); rmSync(sandbox, { recursive: true, force: true }); });

test("through Morgan: its `embed` asked with the texts as framed and the model, and the vectors made unit length", async () => {
  await listen();
  answer = (line) => {
    const body = JSON.parse(line.slice("embed ".length));
    return { ok: true, model: body.model, embeddings: body.texts.map((_: string, i: number) => [3, 4 * (i + 1)]) };
  };
  const vecs = await meaning.embedder({ via: "morgan", model: "nomic-embed-text" }, ["search_document: tea", "search_document: coffee"]);
  const asked = JSON.parse(heard.at(-1)!.slice("embed ".length));
  assert.ok(heard.at(-1)!.startsWith("embed "));
  assert.deepEqual(asked, { texts: ["search_document: tea", "search_document: coffee"], model: "nomic-embed-text" });
  assert.equal(vecs.length, 2);
  assert.ok(Math.abs(vecs[0]![0]! - 0.6) < 1e-6 && Math.abs(vecs[0]![1]! - 0.8) < 1e-6, "unit length");
  assert.equal(meaning.modelServerAway(), false);
});

test("a brain too old to know `embed` says so, and is not taken for one out of reach", async () => {
  answer = () => ({ ok: false, error: "unknown command: embed" });
  await assert.rejects(meaning.embedder({ via: "morgan", model: "m" }, ["x"]), /does not know embed yet/);
  assert.equal(meaning.modelServerAway(), false);
});

test("the brain's model server failing is said as the brain said it", async () => {
  answer = () => ({ ok: false, error: "the model server answered 404 (is m pulled there?)" });
  await assert.rejects(meaning.embedder({ via: "morgan", model: "m" }, ["x"]), /Morgan's brain: the model server answered 404/);
  assert.equal(meaning.modelServerAway(), false);
});

test("Morgan not answering: out of reach, and not asked again for a while", async () => {
  await new Promise<void>((ok) => morgan!.close(() => ok()));
  rmSync(sock, { force: true });
  await assert.rejects(meaning.embedder({ via: "morgan", model: "m" }, ["x"]), /could not be asked/);
  assert.equal(meaning.modelServerAway(), true);
  const n = heard.length;
  await assert.rejects(meaning.embedder({ via: "morgan", model: "m" }, ["x"]), /a moment ago/);
  assert.equal(heard.length, n, "not asked again meanwhile");
});
