// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore

/**
 * What a file says, as text (DESIGN, *Search by meaning*): so a file is found
 * by what is in it, not only by its name, and so what it says can suggest what
 * it belongs with (suggest.ts).
 *
 * Read by the programs already on the machine, each given the file and
 * nothing else, for a minute at most:
 *
 * - text, Markdown, code, CSV: read as they are;
 * - PDF: `pdftotext`; a PDF with no text in it (a scan), its first pages
 *   drawn with `pdftoppm` and read by `tesseract`;
 * - documents, spreadsheets, slides: LibreOffice, headless, with a profile of
 *   its own (so a LibreOffice the person has open is not disturbed), to text,
 *   to CSV, or to PDF and then text;
 * - images: `tesseract`; and a picture (or a scanned PDF's first page) in
 *   which it finds no words, described instead (`setDescriber`: Morgan's
 *   `describe`, morgan-describe.ts) — what it is and shows, and any writing
 *   OCR could not read. Kept as "Picture: …", and found by it.
 *
 * Nothing else is read (audio, video, archives). A program that is missing is
 * a file with no text, not an error.
 *
 * What was read is kept, sealed with the store's key, by what says the file
 * changed — so a file is read again only when it is new or different.
 */

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { seal, unseal } from "./seal.js";
import { STATE_DIR } from "./paths.js";
import { readBytes, writeAtomic } from "./store.js";
import { DATA_DIR, storeKey } from "./vault.js";

/** Said when a picture's describer could not be asked: the file waits, and is tried again, rather than kept as one with no words. */
export class Unavailable extends Error {}
/** What describes a picture with no words in it (meaning.ts sets Morgan's, as Settings says); none: no description. */
let describer: ((bytes: Buffer, name: string) => Promise<string | null>) | null = null;
export function setDescriber(f: typeof describer): void { describer = f; }
async function described(bytes: Buffer, name: string): Promise<string> {
  if (!describer) return "";
  const said = await describer(bytes, name);
  if (said === null) throw new Unavailable("Morgan is not answering");
  return said ? tidy(`Picture: ${said}`) : "";
}

/** At most this much of a file's text is kept: enough to say what it is about. */
const MOST = 120_000;
const TEXT = new Set(".txt .md .markdown .csv .tsv .json .toml .yaml .yml .xml .html .htm .css .js .mjs .ts .py .sh .sql .ini .conf .log .tex .rs .go .java .c .h .cpp .rb .lua .org .rst".split(" "));
const WRITER = new Set(".odt .ott .doc .docx .rtf .pages .wpd".split(" "));
const CALC = new Set(".ods .ots .xls .xlsx .numbers".split(" "));
const IMPRESS = new Set(".odp .otp .ppt .pptx .key".split(" "));
const IMAGE = new Set(".png .jpg .jpeg .tif .tiff .bmp .webp .gif".split(" "));

/** Whether a file of this name has text to read at all. */
export const readable = (name: string): boolean => {
  const e = extname(name).toLowerCase();
  return TEXT.has(e) || WRITER.has(e) || CALC.has(e) || IMPRESS.has(e) || IMAGE.has(e) || e === ".pdf";
};

function run(cmd: string, args: string[], timeout = 60_000): Promise<string> {
  return new Promise((ok) => {
    execFile(cmd, args, { timeout, maxBuffer: 32 * 1024 * 1024, encoding: "utf8" }, (err, stdout) => ok(err ? "" : stdout));
  });
}

/**
 * What OCR read, kept only if it is words: a photo with no writing in it reads
 * as scraps ("lth hy"), which would only make it seem near anything.
 */
export function wordsOnly(text: string): string {
  const tokens = text.split(/\s+/).filter(Boolean);
  const words = tokens.filter((t) => /^[\p{L}][\p{L}'’-]{2,}[.,;:!?]?$/u.test(t));
  return words.length >= 6 && words.length / tokens.length >= 0.55 ? text : "";
}

const tidy = (s: string) => s.replace(/\r/g, "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim().slice(0, MOST);

/** LibreOffice's own profile, apart from the person's: the first run makes it. */
const OFFICE_PROFILE = () => join(STATE_DIR, "soffice-profile");

async function office(file: string, to: string): Promise<string | null> {
  const out = mkdtempSync(join(tmpdir(), "talaris-office-"));
  try {
    mkdirSync(OFFICE_PROFILE(), { recursive: true, mode: 0o700 });
    await run("soffice", [`-env:UserInstallation=file://${OFFICE_PROFILE()}`, "--headless", "--norestore", "--convert-to", to, "--outdir", out, file], 120_000);
    const made = readdirSync(out)[0];
    return made ? join(out, made) : null;
  } catch {
    return null;
  } finally {
    // The made file is read by the caller first: taken away after a moment.
    setTimeout(() => rmSync(out, { recursive: true, force: true }), 30_000).unref();
  }
}

async function pdf(file: string, name = basename(file)): Promise<string> {
  const text = tidy(await run("pdftotext", ["-q", "-layout", file, "-"]));
  if (text.replace(/\s/g, "").length > 40) return text;
  // A scan: its first pages, read as pictures.
  const dir = mkdtempSync(join(tmpdir(), "talaris-ocr-"));
  try {
    await run("pdftoppm", ["-r", "150", "-l", "8", "-png", file, join(dir, "p")], 120_000);
    const pages = readdirSync(dir).filter((n) => n.endsWith(".png")).sort();
    const read: string[] = [];
    for (const p of pages) read.push(await run("tesseract", [join(dir, p), "-", "--psm", "3"], 60_000));
    const words = wordsOnly(tidy(read.join("\n\n")));
    // No words even so (a drawing, a photograph, handwriting): its first page described.
    return words || (pages[0] ? described(readFileSync(join(dir, pages[0])), name) : "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The text of a file on disk (opened first if sealed), by what kind of file it is. */
export async function textOf(path: string, name = basename(path)): Promise<string> {
  const e = extname(name).toLowerCase();
  if (!readable(name)) return "";
  // A sealed file (a project's sealed folder) is opened here, and read from a private copy.
  let bytes: Buffer;
  try { bytes = readBytes(path); } catch { return ""; }
  if (TEXT.has(e)) return tidy(bytes.toString("utf8"));
  return textOfBytes(bytes, name);
}

/** A plain-text file's words, read at once (no program to run): for what is asked before the background has read it. */
export function plainText(path: string, name = basename(path)): string {
  if (!TEXT.has(extname(name).toLowerCase())) return "";
  try { return tidy(readBytes(path).subarray(0, 200_000).toString("utf8")); } catch { return ""; }
}

/** The text of a file held only as bytes (a snapshot on a task), by its name. */
export async function textOfBytes(bytes: Buffer, name: string): Promise<string> {
  const e = extname(name).toLowerCase();
  if (!readable(name)) return "";
  if (TEXT.has(e)) return tidy(bytes.toString("utf8"));
  const dir = mkdtempSync(join(tmpdir(), "talaris-read-"));
  const file = join(dir, `file${e}`);
  try {
    writeFileSync(file, bytes, { mode: 0o600 });
    if (e === ".pdf") return await pdf(file, name);
    // Words in a picture, read; none, the picture described.
    if (IMAGE.has(e)) return wordsOnly(tidy(await run("tesseract", [file, "-", "--psm", "3"]))) || await described(bytes, name);
    if (WRITER.has(e)) { const t = await office(file, "txt:Text"); return t ? tidy(readFileSync(t, "utf8")) : ""; }
    if (CALC.has(e)) { const t = await office(file, "csv"); return t ? tidy(readFileSync(t, "utf8")) : ""; }
    if (IMPRESS.has(e)) { const t = await office(file, "pdf"); return t ? await pdf(t, name) : ""; }
    return "";
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------ kept

const CACHE = () => join(DATA_DIR, "filetext.sealed");
let cache: Map<string, { stamp: string; text: string }> | null = null;

function loadCache(): Map<string, { stamp: string; text: string }> {
  if (cache) return cache;
  cache = new Map();
  if (!existsSync(CACHE())) return cache;
  try {
    const raw = JSON.parse(unseal(storeKey(), readFileSync(CACHE())).toString("utf8")) as [string, { stamp: string; text: string }][];
    cache = new Map(raw);
  } catch {
    // Unreadable: read the files again.
  }
  return cache;
}
let dirty = false;
export function saveFileText(): void {
  if (!dirty || !cache) return;
  writeAtomic(CACHE(), seal(storeKey(), JSON.stringify([...cache])));
  dirty = false;
}

/** What a file said when last read, if it has not changed since (by `stamp`). */
// How files are read: a change here reads each again, once.
const READER = "r3";
export function keptText(key: string, stamp?: string): string | null {
  const had = loadCache().get(key);
  return had && (stamp === undefined || had.stamp === `${stamp}|${READER}`) ? had.text : null;
}

/** A file's text, read again only if `stamp` says it changed; kept for next time. */
export async function fileText(key: string, stamp: string, read: () => Promise<string>): Promise<string> {
  const had = keptText(key, stamp);
  if (had !== null) return had;
  const text = await read();
  loadCache().set(key, { stamp: `${stamp}|${READER}`, text });
  dirty = true;
  return text;
}

/** What a file said, forgotten: read from it again next time (a file that gave no words, asked again). */
export function forgetText(key: string): void {
  if (loadCache().delete(key)) dirty = true;
}

/** Forget the files no longer there. */
export function keepOnly(keys: Set<string>): void {
  const c = loadCache();
  for (const k of [...c.keys()]) if (!keys.has(k)) { c.delete(k); dirty = true; }
}
