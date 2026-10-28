// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const sandbox = mkdtempSync(join(tmpdir(), "talaris-clip-"));
process.env.TALARIS_DATA_DIR = join(sandbox, "data");
process.env.TALARIS_CONFIG_DIR = join(sandbox, "config");
process.env.TALARIS_STATE_DIR = join(sandbox, "state");
process.env.TALARIS_KEY = randomBytes(32).toString("base64");

const clip = await import("../src/clipboard.js");
after(() => rmSync(sandbox, { recursive: true, force: true }));
const dir = join(sandbox, "data", "clipboard");

test("words, a picture and files are kept, sealed, and read back", () => {
  clip.addClip({ kind: "text", text: "hunter2 is my password" });
  const png = Buffer.from("\x89PNG fake picture bytes");
  const { clip: pic } = clip.addClip({ kind: "image", image: png.toString("base64"), mime: "image/png" });
  clip.addClip({ kind: "files", paths: ["/a/one.txt", "/a/two.txt"] });
  for (const f of readdirSync(dir)) {
    const raw = readFileSync(join(dir, f));
    assert.ok(!raw.includes("hunter2") && !raw.includes("fake picture") && !raw.includes("one.txt"), `${f} is plain`);
  }
  clip.forgetLoadedClips();
  assert.deepEqual(clip.listClips().map((c) => c.kind), ["files", "image", "text"]);
  assert.deepEqual(clip.clipPicture(pic.id)?.bytes, png);
  clip.clearClips();
});

test("the same copied again straight away is the one clip; copied again later, a new one", () => {
  assert.equal(clip.addClip({ kind: "text", text: "a" }).added, true);
  assert.equal(clip.addClip({ kind: "text", text: "a" }).added, false);
  clip.addClip({ kind: "text", text: "b" });
  assert.equal(clip.addClip({ kind: "text", text: "a" }).added, true);
  assert.equal(clip.listClips().length, 3);
  clip.clearClips();
});

test("pinned come first and outlast the keep; the oldest unpinned go, pictures with them", async () => {
  const first = clip.addClip({ kind: "image", image: Buffer.from("old").toString("base64") }).clip;
  const pinned = clip.addClip({ kind: "text", text: "keep me" }).clip;
  clip.pinClip(pinned.id, true);
  for (let i = 0; i < 12; i++) {
    await new Promise((r) => setTimeout(r, 2));
    clip.addClip({ kind: "text", text: `n${i}` }, 10);
  }
  const all = clip.listClips();
  assert.equal(all[0]!.id, pinned.id);
  assert.equal(all.filter((c) => !c.pinned).length, 10);
  assert.equal(clip.clipPicture(first.id), null);
  assert.ok(!readdirSync(dir).includes(`${first.id}.sealed`));
  assert.equal(all[1]!.text, "n11");
  clip.clearClips();
  assert.equal(clip.listClips().length, 0);
});

test("one removed; nothing in it refused", () => {
  const c = clip.addClip({ kind: "text", text: "x" }).clip;
  assert.equal(clip.removeClip(c.id), true);
  assert.equal(clip.removeClip(c.id), false);
  assert.throws(() => clip.addClip({ kind: "text", text: "" }));
  assert.throws(() => clip.addClip({ kind: "image", image: "" }));
  assert.throws(() => clip.addClip({ kind: "file", paths: [] }));
});
