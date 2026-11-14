# Talaris — sync between machines

**Status: design, not built.** Worked out on 2026-11-14, after Talaris went
onto a second machine (a mini laptop) beside the first, and the two were each
syncing with Hermes Notes on their own. Read before building any of it; argue
with it here, not in the code.

## What it is for

**One Talaris on several machines.** Everything you make or change on one —
projects, pages, canvases, people, tasks, connections, the Library's files,
the preferences that are yours rather than the machine's — is on the others,
with **no conflicts that leave two copies, no duplicate records, and nothing
silently lost**. Where two machines changed the same thing, one rule settles it
the same way on both, and what was replaced can be got back.

**For anyone who installs Talaris.** It assumes no server, no Hermes Notes and
no particular sync service. Talaris carries its own changes; how they travel
between machines is a choice (*Transport*), and the simplest needs nothing but
a folder that something already keeps in step — Syncthing, Nextcloud, Dropbox,
a network share.

**Not in it.** The machines are not mirrored disks. A machine's screen, power,
text sizes, accounts and the like stay its own (*What syncs*). Morgan's memory
is Morgan's, on Morgan's server, and is not touched. Real-time co-editing of one
page by two people is not the aim: this is one person on several machines.

## The shape

**Each machine writes only its own log.** Every change Talaris makes is a
small record — this field of this thing is now that; this card moved; this
page's text is now this — appended, sealed, to a log that only that machine
writes. The other machines read it and apply it. No file is ever written by two
machines, so the transport cannot make a conflict of its own (no
`.sync-conflict` copies, whatever carries the logs); every merge happens inside
Talaris, record by record, by rules it states.

**Applied through the core, never underneath it.** A record from another
machine goes through the same code a local change does — `updateEntity`,
`writePage`, the canvas's save — so the core's caches, the open panels and the
plugins hear it as they hear any change. Nothing writes Talaris's files from
outside a running Talaris (the inventory found most of its stores are loaded
once and rewritten whole; a file changed underneath would be overwritten).

**One set of ids.** A record means the same thing on every machine only if the
thing has the same id everywhere. A machine joins by taking everything from the
others first (*Joining*), so ids are shared from the start; what is made after
gets a random id (`newId`) that never collides, or an id worked out from what
it is when two machines could each make it on their own (*Ids*).

## Records

A record:

| | |
|---|---|
| `of` | what it is about: `e:<entityId>`, `canvas:<prjId>/<cvId>`, `item:<cvId>/<itId>`, `page:<pageId>`, `project:<prjId>`, `file:<prjId>/<fileId>`, `plugin:<pluginId>/<key>`, `pref:<key>`, … |
| `set` | the fields changed and their new values — never the whole thing |
| `at` | its clock (*Order*) |
| `by` | the machine that made it |
| `batch` | changes made together, applied together or not at all |

**Batches.** One action is one batch: a task completed with its next
occurrence spawned, a page moved with its order, look and versions, a merge of
two people. A machine applies a batch whole, so nothing is seen half-done — the
Hermes pairing that arrives before the task it pairs (the plugin would think
the task deleted) cannot happen.

**The feed is where records come from.** The core already appends a row to
`entities/feed.jsonl` on every put and delete. That becomes the source of
records, widened from "this object changed" to "these fields of it", and
widened to the stores that write no feed row today (canvases, pages, project
files, the single-file stores below). Startup migrations that rewrite files
without a feed row (entities.ts:347–381) must either run identically on every
machine or write records.

## Order

**A hybrid logical clock.** Each record carries `(time, counter, machine)`:
the wall time, corrected forward to past anything the machine has already seen,
and a counter for changes in the same instant; the machine's id breaks a final
tie. Two machines whose clocks disagree still agree on which of two records is
later, and a machine whose clock jumps back does not lose its edits. Wall-clock
time alone cannot do this, and a machine's own counter orders only its own
changes.

## Merging

**Different fields never clash.** A title changed here and a due date there:
both stand.

**The same field, changed on two machines before either saw the other's:** the
later record by the clock wins, on every machine alike. The value it replaced
goes into a **replaced log** (`replaced.sealed`, per record and field, kept 90
days) and Talaris says so where the thing is shown — "Changed on the mini as
well; this edit kept" — with the other one a press away. Pages and canvases
also keep it in their version history, which exists only for them.

**Lists that are sets** — a person's organizations, a thing's projects, tags,
a collection's members: merged as adds and removes, not as one value. Added to
two different projects on two machines, it is in both.

**Deletes.** A delete is a record, and the id is remembered (a tombstone, kept
a year) so the thing does not come back from a machine that had not heard.
**Delete against edit:** the delete wins, and the edited copy goes into the
replaced log, from which it can be brought back. Archive is not delete; it is a
field, merged like any other.

**Page text** is not one field. A page edited on both machines is merged
**three ways**, against the last text both had (kept with the page's sync
state): edits to different parts both stand; edits to the same lines keep the
later and put the other into the page's versions, marked. Today a page is saved
whole with no base check (pages.ts:179; drawer.js:1056); the merge is new.

**Canvases** sync per item, link and region, not per file. Moving a card here
and editing a note there both stand. The whole-file save with its `talaris:rev`
check (canvases.ts:152) stays as the local writer; what is sent is the
difference.

**Files' bytes cannot be merged.** A Library file changed on two machines:
the later wins, the other is kept in the project's versions as "changed on the
mini at 3:12". No second file is made in the folder.

## Ids

What two machines could each make on their own gets an id **worked out from
what it is**, so both make the same one and they merge into one:

| Thing | Today | Becomes |
|---|---|---|
| A page | its path, and its note entity — whose id already lasts through Talaris's own renames (`movePage` → `movedText`) — deleted and re-made when a page is renamed or moved *outside* Talaris (`reconcileNotes`) | **the note entity's id is the page's id.** A page gone and one come with the same words (or, empty, the same title in the same project) is taken for one moved, and keeps its entity — **done** (notes.ts, `movedOutside`). No id in the file: front matter would show in the editor and travel to Hermes |
| Today's daily note | `Daily/<date>`, a random entity id | a day made here is `e_day<yyyymmdd>` — **done** (notes.ts, `dayId`); one from Hermes keeps Hermes' id |
| Home | `ensureHome()` makes one per fresh machine | made once; a joining machine takes the existing one |
| A project's code | `nextCode()`: max + 1, so two machines both make PRJ-22 | a code is a field; a clash is renumbered on the later one, said in its record |
| Something from outside (a plugin's import, a calendar event, an address-book card) | `createEntity` gives a random id | id from the source and its key: `id = hash(kind, key)` (*Mirrors*) |

**Paths stay on disk, and stop at the records.** Page versions, order, look,
starred and file lists keep their paths on disk; a record names a page by its
entity's id and a file by its project and path with its hash (a file moved is
a record saying so; one moved outside Talaris is found by its hash), and the
receiving machine turns them back into its paths. Nothing on disk is reshaped
for sync.

## What syncs

**Everything that is yours:**
- the entity store: objects, types, connections (they live on the objects —
  declared reference fields and `relations`), attachments' bytes (blobs,
  already named by their hash), lists, task series, task and people
  preferences, forgotten cards
- projects: `project.json` (name, archived, encrypted, top canvas), canvases,
  page text, order, look, starred, file lists, versions, the Library's files
  (`Files/`, `Exports/`, anything else in the folder)
- merges (`merged.sealed`), dismissed suggestions (`suggest.sealed`)
- your preferences: theme, clock, bar layout, launcher keys, dock pins
  (where the app exists), panels, notifications muted, clipboard and activity
  settings, `shown`, windows, location's on/off and units, each project's
  wallpaper (where it is a color, or a picture in the Library)
- each plugin's synced storage (*Plugins*)

**What stays the machine's:**
- `screen`, `text`, `touch`, `power`, `meaning` (the model server), `data`'s
  backup folder, `calendar.hidden`, location's last place
- the clipboard and its history, the activity record (it never leaves the
  machine it was made on), the web engine's profile and web apps' logins,
  recent projects, plugin secrets (the keyring), `adopted.json`
- derived indexes, rebuilt on each machine: file text and summaries
  (`filetext.sealed` — a summary you wrote yourself is the one part that is
  yours, and syncs), meaning's embeddings, Morgan's thread copy (re-fetched
  from Morgan)

The single files that hold many records — `writing-look.json`,
`writing-order.json`, `canvas-list.json`, `starred-order.json`,
`file-lists.json`, `merged.sealed`, `suggest.sealed`, `config.json`'s yours
part — are written as **records per entry**, and their file on disk is only
the machine's copy of the merged result.

## Shortcuts and links to files outside the Library

A shortcut, and a file linked to a task or a page, may point at a path on one
machine only (`talaris:link` holds an absolute path; shortcuts are `t_file`
entities). **They stay shortcuts.** Nothing is moved into a project's Files to
make it travel.

- The record syncs, and says which machine its file is on.
- On that machine it works as it does now.
- On another machine it is **shown flagged** — "On XPS 13" — and does not open.
  If that machine has the same file at the same path (its hash matches), it
  simply works there too.
- A folder linked to a project from outside (`linked-folders.sealed`) is the
  same: its shortcuts are flagged elsewhere, and only the machine with the
  folder keeps them in step with it.

A shortcut to a file inside another project's folder points at a Library file,
which travels, so it works everywhere.

## Mirrors: calendars, address books, imports

Two machines signed in to the same Google account each mirror its events into
entities (`mirrorEvent`, entities.ts:946), and each would make its own — the
`eds-event` key starts with Evolution's source id, which is the machine's own.
So a mirrored thing's id comes from a key the provider gives, the same
everywhere:

- **Events:** the iCalendar UID (`ical-uid`, already recorded beside
  `eds-event`).
- **Address-book cards:** EDS gives no machine-independent key as such; the
  card's own uid for CardDAV and Exchange is likely the provider's but is to
  be checked. Until it is, a mirrored person is found by email first (as
  `personFromCard` already does) and created with an id from the account and
  the card's uid.
- **A plugin's imports:** the plugin passes its own key (*Plugins*).

Only what a mirror owns (the calendar's fields, the card's) is written by it;
what you added to the entity is yours and syncs as yours.

## Plugins

The core knows no plugin. It offers three things any plugin may use:

1. **Synced storage.** A plugin's own keys, under `plugin:<id>/…`, carried
   between machines without the core reading them. A plugin that keeps
   pairings, cursors or choices in its state file moves them here.
2. **One machine at a time.** `plugin.toml` may say `[sync] one = true`: the
   plugin talks to something outside and must not run on two machines at
   once. The core runs it on one machine and keeps it idle on the rest
   (*Who runs a one-at-a-time plugin*). The plugin never learns there are two.
   It runs only once its machine has applied everything it has been sent.
3. **Ids from an outside key.** `create` with `{source: {kind, key}}` makes the
   entity at `hash(kind, key)`, so two machines importing the same outside
   thing make one.

### Hermes sync, as the first to use them

- Its pairings (`state.json`'s `links`, `apart`, `only`, collections) move to
  synced storage. Its Talaris cursor (`<era>.<seq>`, the machine's own feed)
  becomes a cursor on the synced records.
- It declares `one = true`.
- **A thing made in Hermes from Talaris** gets a Hermes id worked out from its
  Talaris id (a UUID v5), not a random one (sync.mjs:350). Hermes' create is
  `PUT /interchange/objects/:id`, and a second create at the same id returns
  `created: false` and leaves it alone (hermesnotes routes.ts:734; blocks'
  insert is `onConflictDoNothing`). So two machines, or one that crashed
  before saving its pairings (main.mjs:236–272 saves only at the end), can never
  make a second copy in Hermes.
- A thing made in Talaris from Hermes is already made at Hermes' own id
  (sync.mjs:361).
- Its first-sync matching by name, email and date stays as it is.

## Transport

The logs are files of sealed records, one set per machine, and anything that
carries files can carry them:

**A folder** — the default, needing no server. Point every machine at the same
folder (`Talaris Sync/` in a Syncthing share, Nextcloud or Dropbox): each
writes `<machine>/log-<n>` and reads the others'. Since no file has two
writers, the folder-syncing service never has a conflict to resolve. Files'
bytes go in `blobs/<sha256>`, sealed, once.

**The relay** — optional, for those with an always-on machine: a small service
(Node, a few hundred lines, a SQLite file and a blob folder) that stores the
same sealed logs and hands out what a machine has not seen. Packaged as a
systemd unit and a container; reached over HTTPS with a token per machine. It
reads nothing — everything is sealed before it leaves the machine. It adds one
thing a folder cannot: a proper lease for one-at-a-time plugins.

**Trimming.** Logs grow; a machine writes a sealed **snapshot** now and then,
and records every machine has applied are dropped behind it. A machine that
has been away longer than the logs reach starts again from the snapshot.

## Who runs a one-at-a-time plugin

- **With a relay:** a lease, renewed every few seconds by the machine that
  holds it; when it lapses (asleep, offline) another takes it. Before each batch
  it sends outside, the plugin's machine checks it still holds it.
- **With a folder:** no folder gives a reliable lease. Settings says which
  machine runs it — "Hermes sync runs on: XPS 13" — moved with one press. The
  ids worked out from Talaris ids (above) are the safety net if two ever do.

## Keys and joining

**One store key.** Everything is sealed with the store key (AES-256-GCM,
seal.ts), which lives in each machine's keyring. A machine joining takes the
same key with your **recovery key** — `adopt()` (vault.ts:220) already does
this. The logs, snapshots and blobs are sealed with it, so a folder or relay
holds nothing readable.

**Joining**, in Settings, *Sync*: "Add this machine to your Talaris" asks for
the recovery key and where the logs are (a folder, or a relay's address and
token), then fills the machine from the newest snapshot and the logs after it.
A machine with its own Talaris already is asked first: its things are offered
to be brought in as new (with new ids), or left behind.

**A machine lost:** its relay token revoked; if the recovery key or store key
may be out, a new store key and everything re-sealed (a backup-and-revive,
which Talaris already does).

## The mini, specifically

The mini's Talaris was filled from Hermes, not from the XPS. Things that came
from Hermes have the same ids on both (made at Hermes' ids); things Talaris
made — page notes, canvases, lists, Home, project ids and codes — do not. So:

1. Turn off Hermes sync on the mini now (two copies writing to one Hermes is
   the likeliest source of duplicates until this is built).
2. When sync is built: the mini joins as a machine that already has a Talaris,
   leaving its own behind (what was made only there today — a canvas note or
   two, settings that are its own — redone or carried by hand).
3. Syncthing shares one folder between the two, for the logs; `~/Projects` is
   *not* shared by Syncthing — the Library's files travel as records and blobs.

## Order of work

Each step leaves Talaris working on one machine as it does now.

1. **Ids that last** — done 2026-11-14: a page moved outside Talaris keeps its
   entity; a day made here has its date's id. (Home, project codes and files
   are settled where records are written and applied, steps 2 and 3.)
   Left: a page moved outside Talaris leaves its versions at the old path.
2. **Records.** The feed widened to field-level records with batches and the
   clock, for every store that syncs, including the single-file ones.
   Done 2026-11-14 (records.ts, project-records.ts): entities; pages (with the
   base a merge needs), canvases item by item, a project's own files entry by
   entry, moves, copies, deletes; the small sealed stores, done-once markers,
   merges, dismissed suggestions — all off until a machine syncs.
   Left: the Library's files with their bytes (2b), and the part of
   `config.json` that is yours (the surfaces write it, in Python).
3. **Applying.** Records applied through the core's own paths; the replaced
   log; tombstones; three-way page merge; per-item canvas merge.
   Done 2026-11-14 (sync-apply.ts, merge3.ts): every field's last moment kept,
   the later change winning on both machines whichever arrives first; sets by
   member; deletes winning and remembered; the replaced log; pages taken as
   they are when unchanged here, merged line by line against the text both
   last had when changed on both (the merge written out as this machine's, so
   the other has it), the later kept whole when the same lines changed; cards,
   links and regions each their own; projects, their files, the small stores.
   Left: a project made on one machine and not yet on the other is made where
   machines join (step 4); the replaced log is not yet shown anywhere.
4. **The folder transport**, sealed logs and blobs, snapshots, and *Joining*.
   Two Talarises in one test, syncing through a temporary folder, is the test
   suite for everything above.
5. **Plugins**: synced storage, `one`, ids from an outside key; Hermes sync
   moved onto them, its Hermes ids from Talaris ids.
6. **Mirrors** keyed by provider ids.
7. **Shortcuts flagged** on machines without their file.
8. **The relay**, and its lease.

## Open questions

- Address-book cards: is EDS's card uid the provider's for CardDAV and
  Exchange? Decides whether mirrored people need email matching.
- Encrypted projects seal their files with the store key; on a joined machine
  they open as they do on the first. To check: nothing in them is keyed by a
  machine.
- Dock pins name desktop-file ids; an app not installed on a machine is shown
  as not there rather than dropped.
- How long tombstones and the replaced log are kept, and how large a log may
  grow before a snapshot.
