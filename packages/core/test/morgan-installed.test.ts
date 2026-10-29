// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore

// Morgan known to be here by its socket; and, told so, as though it were not.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sandbox = mkdtempSync(join(tmpdir(), "talaris-morganhere-"));
process.env.HEYMORGAN_SOCKET = join(sandbox, "morgan.sock");
after(() => rmSync(sandbox, { recursive: true, force: true }));

const { morganInstalled } = await import("../src/morgan-describe.js");

test("Morgan here by its socket; TALARIS_NO_MORGAN as though it were not", async () => {
  const server = createServer();
  await new Promise<void>((ok) => server.listen(process.env.HEYMORGAN_SOCKET, ok));
  try {
    assert.equal(morganInstalled(), true);
    process.env.TALARIS_NO_MORGAN = "1";
    assert.equal(morganInstalled(), false);
  } finally {
    delete process.env.TALARIS_NO_MORGAN;
    await new Promise((ok) => server.close(ok));
  }
});
