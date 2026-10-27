// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore

/**
 * The undated notes moved into Home, once (DESIGN, *Pages of no other
 * project are Home's*). They were a place of their own, `<projects>/Notes`,
 * asked for as the project `notes`; now they are Home's `Writing/Pages`,
 * beside its `Daily`, and are Home's pages in Files, Glance, lists and search.
 *
 * **Nothing about them changes but where they are.** Each keeps its entity —
 * its id, its mark (`talaris:undated`), its mentions, its tags — so Hermes
 * Notes, which keeps them in step by those, sees no note go or come. Their
 * order, look, stars and versions go with them; what search read of them,
 * their descriptions and suggestions said no to are moved to their new keys,
 * not read or made again.
 *
 * Done carefully, because a note the sync takes for gone is deleted in Hermes
 * Notes too. A copy of the folder and of the store is kept first. The files
 * move before anything else, and if one cannot, those moved go back and
 * nothing else is touched. Until every note's entity is at its new address,
 * the notes are not tidied (notes.ts, `reconcileNotes`). Home already holding
 * a `Pages` with something in it: not done, and said.
 */

import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { allRecords } from "./entities.js";
import { renameKept } from "./filetext.js";
import { renameIndexed } from "./meaning.js";
import { movedText } from "./mentions.js";
import { MACHINERY, STATE_DIR, WRITING } from "./paths.js";
import { PAGES, UNDATED, ensureHome, notesFolder } from "./projects.js";
import { readJson, writeJson } from "./store.js";
import { renameSuggestKeys } from "./suggest.js";
import { DATA_DIR } from "./vault.js";
import { versionDir } from "./versions.js";

const DONE = () => join(STATE_DIR, "pages-in-home.json");
const LEGACY = `${UNDATED}/`;

type Said = { moved: number; entities: number; backup?: string; skipped?: string };

export function movePagesIntoHome(): Said {
  if (existsSync(DONE())) return { moved: 0, entities: 0 };
  const src = notesFolder();
  const home = ensureHome();
  const pagesDir = join(home.folder, WRITING, PAGES);
  const names = existsSync(src) ? readdirSync(src).filter((n) => n !== MACHINERY && !n.startsWith(".") && !n.endsWith(".tmp")) : [];
  const legacy = allRecords().map((r) => r.object).filter((o) =>
    ((o["talaris:sources"] as { kind: string; key: string }[] | undefined) ?? []).some((s) => s.kind === "page" && s.key.startsWith(LEGACY)));
  const done = (said: Said) => { mkdirSync(STATE_DIR, { recursive: true }); writeFileSync(DONE(), JSON.stringify({ at: new Date().toISOString(), ...said })); return said; };
  if (!names.length && !legacy.length) {
    if (existsSync(src) && !readdirSync(src).some((n) => n !== MACHINERY)) rmSync(src, { recursive: true, force: true });
    return done({ moved: 0, entities: 0 });
  }
  if (names.length && existsSync(pagesDir) && readdirSync(pagesDir).some((n) => !n.startsWith("."))) {
    const skipped = `Home already has a ${PAGES} with something in it: the pages of no project stay in ${src} for now`;
    console.log(`talaris-core: ${skipped}`);
    return { moved: 0, entities: 0, skipped };
  }

  // A copy of all of it first: the folder, and the store its entities are in.
  const backup = join(dirname(DATA_DIR), `talaris-before-pages-in-home-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  if (existsSync(src)) cpSync(src, join(backup, "Notes"), { recursive: true });
  cpSync(DATA_DIR, join(backup, "data"), { recursive: true });

  // The files, all or none.
  mkdirSync(pagesDir, { recursive: true });
  const moved: Array<[string, string]> = [];
  try {
    for (const n of names) {
      renameSync(join(src, n), join(pagesDir, n));
      moved.push([join(src, n), join(pagesDir, n)]);
    }
  } catch (e) {
    for (const [a, b] of moved.reverse()) { try { renameSync(b, a); } catch { /* the copy has it */ } }
    console.log(`talaris-core: the pages of no project could not be moved into Home (${(e as Error).message}); left where they were`);
    return { moved: 0, entities: 0, skipped: (e as Error).message, backup };
  }

  // Their order, look (stars, paper) and versions, under Pages.
  const from = join(src, MACHINERY), to = join(home.folder, MACHINERY);
  const read = <T>(f: string, empty: T): T => { try { return readJson<T>(f); } catch { return empty; } };
  const order = read<Record<string, string[]>>(join(from, "writing-order.json"), {});
  const homeOrder = read<Record<string, string[]>>(join(to, "writing-order.json"), {});
  for (const [parent, list] of Object.entries(order)) homeOrder[parent ? `${PAGES}/${parent}` : PAGES] = list;
  if (homeOrder[""] && !homeOrder[""].includes(PAGES)) homeOrder[""].push(PAGES);
  writeJson(join(to, "writing-order.json"), homeOrder);
  const look = read<Record<string, unknown>>(join(from, "writing-look.json"), {});
  const homeLook = read<Record<string, unknown>>(join(to, "writing-look.json"), {});
  for (const [p, v] of Object.entries(look)) homeLook[`${PAGES}/${p}`] = v;
  writeJson(join(to, "writing-look.json"), homeLook);
  const versions = join(from, "versions", "page");
  if (existsSync(versions)) {
    for (const key of readdirSync(versions)) {
      const target = versionDir(to, "page", `${PAGES}/${decodeURIComponent(key)}`);
      mkdirSync(dirname(target), { recursive: true });
      if (!existsSync(target)) renameSync(join(versions, key), target);
    }
  }

  // Each note's entity at its new address: the same entity, so the same note to Hermes Notes.
  for (const o of legacy) {
    for (const s of (o["talaris:sources"] as { kind: string; key: string }[]).filter((x) => x.kind === "page" && x.key.startsWith(LEGACY))) {
      movedText(s, { kind: "page", key: `${home.id}/${PAGES}/${s.key.slice(LEGACY.length)}` });
    }
  }

  // What search read of them, their descriptions, and suggestions said no to: at their new keys.
  const rename = (k: string) => (k.startsWith(`page:${LEGACY}`) ? `page:${home.id}/${PAGES}/${k.slice(`page:${LEGACY}`.length)}` : null);
  renameIndexed(rename, (d) => (d.kind === "page" ? { project: home.id, path: `${PAGES}/${d.path}` } : {}));
  renameKept(rename);
  renameSuggestKeys(rename);

  if (existsSync(src)) rmSync(src, { recursive: true, force: true });
  console.log(`talaris-core: ${names.length} pages of no project moved into Home's ${PAGES} (a copy of before: ${backup})`);
  return done({ moved: names.length, entities: legacy.length, backup });
}
