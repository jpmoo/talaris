// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore

// The projects kept for one call: looked for once, and never one out of date when a project is made in it.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const sandbox = mkdtempSync(join(tmpdir(), "talaris-kept-"));
process.env.TALARIS_DATA_DIR = join(sandbox, "data");
process.env.TALARIS_PROJECTS = join(sandbox, "Projects");
process.env.TALARIS_CONFIG_DIR = join(sandbox, "config");
process.env.TALARIS_STATE_DIR = join(sandbox, "state");
process.env.TALARIS_KEY = randomBytes(32).toString("base64");
after(() => rmSync(sandbox, { recursive: true, force: true }));

const projects = await import("../src/projects.js");

test("kept for one call, the same list; a project made in it is in it; after it, looked for again", () => {
  projects.ensureHome();
  projects.withProjectsKept(() => {
    const first = projects.allProjects();
    assert.equal(projects.allProjects(), first, "the same list, not looked for again");
    const made = projects.createProject("Garden");
    assert.ok(projects.allProjects().some((p) => p.id === made.id), "made in the call: in the list");
    projects.renameProject(made.id, "Allotment");
    assert.equal(projects.allProjects().find((p) => p.id === made.id)?.name, "Allotment", "renamed in the call: so named");
  });
  assert.notEqual(projects.allProjects(), projects.allProjects(), "outside a call: looked for each time");
});
