// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore

/**
 * Enough TOML for a plugin's `plugin.toml`: keys (bare, quoted, or dotted),
 * strings (basic with escapes, literal, and both multi-line forms), integers
 * and floats, booleans, arrays (across lines, trailing comma allowed), inline
 * tables, `[tables]` and `[[arrays of tables]]`, and comments. Dates are not
 * read — a manifest has none. What it cannot read it refuses, saying where,
 * rather than guessing: a manifest read wrongly is a plugin shown as asking
 * for less than it asks for.
 */

export class TomlError extends Error {}

type Table = Record<string, unknown>;

export function parseToml(text: string): Table {
  const root: Table = {};
  let here: Table = root;
  let i = 0;
  let line = 1;
  const fail = (why: string): never => { throw new TomlError(`plugin.toml, line ${line}: ${why}`); };
  const peek = () => text[i];
  const ws = () => { while (i < text.length && (text[i] === " " || text[i] === "\t")) i++; };
  const comment = () => { if (peek() === "#") while (i < text.length && text[i] !== "\n") i++; };
  const newline = () => {
    ws(); comment();
    if (i >= text.length) return;
    if (text[i] === "\r") i++;
    if (text[i] !== "\n") fail(`expected the end of the line, found ${JSON.stringify(text[i])}`);
    i++; line++;
  };
  const blank = () => {
    // Whitespace, comments and newlines, inside an array.
    for (;;) {
      ws(); comment();
      if (text[i] === "\r") i++;
      if (text[i] === "\n") { i++; line++; continue; }
      return;
    }
  };

  function key(): string[] {
    const parts: string[] = [];
    for (;;) {
      ws();
      if (peek() === '"' || peek() === "'") parts.push(string());
      else {
        const m = /^[A-Za-z0-9_-]+/.exec(text.slice(i));
        if (!m) fail("expected a key");
        parts.push(m![0]);
        i += m![0].length;
      }
      ws();
      if (peek() !== ".") return parts;
      i++;
    }
  }

  function string(): string {
    const q = text[i]!;
    const triple = text.startsWith(q.repeat(3), i);
    i += triple ? 3 : 1;
    if (triple && text[i] === "\n") { i++; line++; }
    let out = "";
    for (;;) {
      if (i >= text.length) fail("a string with no end");
      if (triple ? text.startsWith(q.repeat(3), i) : text[i] === q) { i += triple ? 3 : 1; return out; }
      const c = text[i]!;
      if (c === "\n") { if (!triple) fail("a string runs past the end of its line"); line++; }
      if (q === '"' && c === "\\") {
        const e = text[i + 1];
        const simple: Record<string, string> = { n: "\n", t: "\t", r: "\r", '"': '"', "\\": "\\", b: "\b", f: "\f" };
        if (e && e in simple) { out += simple[e]; i += 2; continue; }
        if (e === "u" || e === "U") {
          const n = e === "u" ? 4 : 8;
          const hex = text.slice(i + 2, i + 2 + n);
          if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length !== n) fail("a broken \\u escape");
          out += String.fromCodePoint(parseInt(hex, 16));
          i += 2 + n;
          continue;
        }
        if (triple && (e === "\n" || e === " " || e === "\r")) { // a line-ending backslash: the newline and the space after go
          i++;
          while (i < text.length && /[ \t\r\n]/.test(text[i]!)) { if (text[i] === "\n") line++; i++; }
          continue;
        }
        fail(`an escape TOML does not have: \\${e}`);
      }
      out += c;
      i++;
    }
  }

  function value(): unknown {
    ws();
    const c = peek();
    if (c === '"' || c === "'") return string();
    if (c === "[") {
      i++;
      const arr: unknown[] = [];
      for (;;) {
        blank();
        if (peek() === "]") { i++; return arr; }
        arr.push(value());
        blank();
        if (peek() === ",") { i++; continue; }
        if (peek() === "]") { i++; return arr; }
        fail("expected , or ] in an array");
      }
    }
    if (c === "{") {
      i++;
      const t: Table = {};
      ws();
      if (peek() === "}") { i++; return t; }
      for (;;) {
        const k = key();
        if (peek() !== "=") fail("expected = in an inline table");
        i++;
        put(t, k, value());
        ws();
        if (peek() === ",") { i++; continue; }
        if (peek() === "}") { i++; return t; }
        fail("expected , or } in an inline table");
      }
    }
    const m = /^(true|false|[+-]?(?:0x[0-9a-fA-F_]+|0o[0-7_]+|0b[01_]+|[0-9_]+(?:\.[0-9_]+)?(?:[eE][+-]?[0-9_]+)?|inf|nan))/.exec(text.slice(i));
    if (!m) fail("a value TOML does not have here (dates are not read in a manifest)");
    i += m![0].length;
    const v = m![0];
    if (v === "true") return true;
    if (v === "false") return false;
    const n = Number(v.replace(/_/g, "").replace(/^\+/, ""));
    if (Number.isNaN(n) && !/nan/.test(v)) fail(`not a number: ${v}`);
    return n;
  }

  function put(t: Table, path: string[], v: unknown): void {
    let at = t;
    for (const p of path.slice(0, -1)) {
      if (at[p] === undefined) at[p] = {};
      if (typeof at[p] !== "object" || Array.isArray(at[p])) fail(`${p} is already a value`);
      at = at[p] as Table;
    }
    const last = path[path.length - 1]!;
    if (last in at) fail(`${path.join(".")} is given twice`);
    at[last] = v;
  }

  function table(path: string[], many: boolean): Table {
    let at = root;
    path.forEach((p, n) => {
      const end = n === path.length - 1;
      if (end && many) {
        if (at[p] === undefined) at[p] = [];
        if (!Array.isArray(at[p])) fail(`${p} is not an array of tables`);
        const t: Table = {};
        (at[p] as Table[]).push(t);
        at = t;
        return;
      }
      if (at[p] === undefined) at[p] = {};
      const next = at[p];
      at = (Array.isArray(next) ? next[next.length - 1] : next) as Table;
      if (typeof at !== "object") fail(`${p} is already a value`);
    });
    return at;
  }

  while (i < text.length) {
    ws(); comment();
    if (i >= text.length) break;
    if (text[i] === "\n" || text[i] === "\r") { newline(); continue; }
    if (text[i] === "[") {
      const many = text[i + 1] === "[";
      i += many ? 2 : 1;
      const path = key();
      if (text.slice(i, i + (many ? 2 : 1)) !== (many ? "]]" : "]")) fail("a table header with no end");
      i += many ? 2 : 1;
      here = table(path, many);
      newline();
      continue;
    }
    const k = key();
    if (peek() !== "=") fail("expected =");
    i++;
    put(here, k, value());
    newline();
  }
  return root;
}
