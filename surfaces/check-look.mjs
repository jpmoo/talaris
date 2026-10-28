#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore
//
// One visual language, checked (DESIGN, *One visual language*). The pages draw
// from tokens.css, controls.css and kit.css; a page that writes a value of its
// own instead drifts, and the audit of 2026-10-28 found 117 places that had.
// This fails on what that audit fixed:
//
//   a colour written as hex or rgb() — a token says it, or palette.js does;
//   a corner in pixels — one of the four radii (1–3px hairlines and tracks, and 50%, excepted);
//   a shadow written out — the menu's or the edge's;
//   a tint of the accent at its own strength — the four tiers;
//   a weight over 500 — only 400 and 500 are shipped;
//   a z-index of 10 or more written as a number — the scale's tokens.
//
// A line that must be an exception says so: `look: <why>` in a comment on it.
// node surfaces/check-look.mjs  (exit 1 on anything found)

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const UI = join(new URL(".", import.meta.url).pathname, "ui");
// Where the values are defined, and what is not Talaris's to change: the
// canvas's bundle (only its Talaris block is read), the editor and markdown
// bundles, the icon set (drawings, not colours), the fonts.
const SKIP = new Set(["tokens.css", "palette.js", "editor.js", "editor.js.map", "markdown.js", "TASKS-CONTRACT.md"]);
const SKIP_DIRS = new Set(["fonts"]);

const RULES = [
  ["colour", /#[0-9a-fA-F]{3,8}\b(?![\w-])|rgba?\(\s*\d/, (l) => !/url\(|href=|&#|#[0-9a-f]{3,8}"?\s*:\s*\[|\bid=|getElementById/.test(l)],
  ["corner", /border-radius\s*:\s*(\d+(\.\d+)?)px/i, (l, m) => !["0", "1", "2", "3"].includes(m[1])],
  ["corner", /borderRadius\s*[:=]\s*["']?(\d+)(px)?/, (l, m) => !["0", "1", "2", "3"].includes(m[1])],
  ["shadow", /box-shadow\s*:[^;]*rgba?\(|box-shadow\s*:[^;]*#[0-9a-fA-F]{3,8}|boxShadow\s*[:=][^,;]*rgba?\(/i, () => true],
  ["accent tint", /color-mix\([^)]*var\(--accent\)\s*\d+%/, (l) => !/@keyframes|^\s*\d+%\s*\{/.test(l)],
  ["weight", /font-weight\s*:\s*(6|7|8|9)\d\d|fontWeight\s*[:=]\s*["']?(6|7|8|9)\d\d|font-weight\s*:\s*bold/i, () => true],
  ["z-index", /z-index\s*:\s*(\d{2,})|zIndex\s*[:=]\s*["']?(\d{2,})/, () => true],
];

function files(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { if (!SKIP_DIRS.has(name)) out.push(...files(p)); continue; }
    if (SKIP.has(name) || !/\.(html|css|js)$/.test(name)) continue;
    out.push(p);
  }
  return out;
}

/** The canvas is a bundle: only the Talaris block in canvas.js (between its markers) is ours to hold to this. */
function linesOf(path) {
  const text = readFileSync(path, "utf8");
  const rel = relative(UI, path);
  if (rel.startsWith("canvas/")) {
    if (rel !== "canvas/canvas.js") return [];
    return text.split("\n").map((l, i) => [i + 1, l]).filter(([, l]) => l.length < 400);
  }
  return text.split("\n").map((l, i) => [i + 1, l]);
}

const found = [];
for (const path of files(UI)) {
  for (const [n, line] of linesOf(path)) {
    if (/look:\s*\S/.test(line)) continue;
    for (const [what, re, keep] of RULES) {
      const m = line.match(re);
      if (m && keep(line, m)) found.push(`${relative(UI, path)}:${n}  ${what}  ${line.trim().slice(0, 140)}`);
    }
  }
}
if (found.length) {
  console.log(found.join("\n"));
  console.log(`\n${found.length} value(s) written by hand where the shared look has one (surfaces/check-look.mjs).`);
  process.exit(1);
}
console.log("check-look: one visual language — nothing written by hand.");
