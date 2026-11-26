# Talaris on the web

**Status: designed; step 1 done** (2026-11-26). Argue with it here, not in the
code.

**The goal.** Retire Hermes Notes and the hermes-sync plugin. In their place,
Talaris itself on the web — `https://app.schoolahead.today/talaris`, served by
home-server through Caddy — for the phone and for any browser. It is **a
Talaris machine of its own**, joined like the laptop and the mini, and, being
the one that is always on, the one the others sync through.

Why not keep Hermes as the web side: two systems kept in step by a plugin is
two models of the same things, a bridge that must run on one machine that is
awake, and a second copy of every rule. Talaris already holds everything Hermes
does (the plugin filled it), merges between machines by its own rules
(SYNC.md), and draws everything as web pages. The web is one more machine.

## The shape

```
  laptop ──┐                        ┌── phone (browser)
  mini   ──┼── sync ── home-server ─┤
  deck   ──┘        talaris-core    └── any browser
                    + the web side
                    behind Caddy
```

- **The core, with no screen.** `packages/core` is already a Node program
  with no screen of its own; the screens are the surfaces (`surfaces/`), which
  home-server does not run. It joins with the recovery key, as any machine
  does (SYNC.md, *Keys and joining*), and applies every record, so it has the
  whole of Talaris: its entities, pages, canvases, and a real `~/Projects` with
  the Library's files.
- **The web side.** A small server beside the core (Node): it serves the pages
  under `/talaris`, signs you in (*Signing in*), and answers the pages' requests
  — most by asking the core, as the surfaces do now.
- **Caddy** terminates HTTPS and passes `/talaris*` to it. Nothing else of the
  core is reachable from outside.

**The key is on home-server.** A full machine reads what it holds: anyone who
got into home-server as you could read your Talaris, where today they would
find sealed files. What stands between the web and it is the sign-in and
HTTPS; between the machine and it, the machine's own login. Accepted, for an
always-on Talaris you can reach from the phone.

## Signing in

One person, so no accounts, no identity provider, no passwords. **Passkeys,
decided 2026-11-26.**

**You, in a browser: passkeys** (WebAuthn), in the web side itself. Face ID or
Touch ID on the phone, a fingerprint or a security key on a laptop; nothing to
type, nothing to phish, nothing on the server worth stealing (a passkey's public
half). Two or three are registered — the phone, a laptop, a spare key — and
listed, named and removable in Settings.

- **The first passkey, and a lost one**, are never registered from the web:
  `talaris-web passkey` run on home-server over SSH prints a one-time code,
  good for ten minutes, that lets one new passkey be added. Nothing on the web
  can reset access.
- **A session** is a cookie — `HttpOnly`, `Secure`, `SameSite=Strict`, path
  `/talaris` — good for 30 days from its last use, listed (which device, last
  seen) and revocable in Settings.
- **Asking again** for anything that cannot be undone or that reaches the keys:
  revealing the recovery key, removing a passkey, revoking a machine.
- **Failures slow down**: each failed sign-in from an address waits longer
  before the next is heard.

**Machines: a token each**, made when a machine joins and good only for sync
(*Sync over HTTPS*), never for signing in. A lost laptop is one token revoked.

**Not chosen:**
- *Caddy's basic auth* — a password on every request, guessable, phishable.
- *An identity provider* (Authelia, Authentik, Keycloak) — a second service to
  run and keep current, for one person.
- *Pocket ID* in front of Caddy — small and passkey-only, the best of these if
  passkeys are not to be in Talaris's own code; still a second service.
- *Tailscale only* — the safest and simplest, but the phone works only with
  Tailscale on. Worth keeping as a second fence: the web side can be told to
  answer only from the tailnet, later or at once.

## What it shows

**Five modules, and the Library as the hub.** On the web, and above all on the
phone, Talaris is what you do away from the desk:

| | |
|---|---|
| **Library** | The front page: search, the projects, and every thing's card. What is named anywhere opens here, as on the desktop (DESIGN, *The Library, what everything opens to*). |
| **Tasks** | Today, upcoming, a project's; done, added, moved. |
| **Calendar** | The desktop's page. The accounts' calendars as a desktop machine last shared them (*Calendar*, below), read-only; Talaris's own calendar, made and changed as on the desktop. |
| **Notes** | Today's daily note, a project's pages; written in the same editor. |
| **People** | A person's or an organization's card. |
| **Canvas** | Seen whole and moved around; a note added or edited. Drawing and laying out are for a bigger screen and a pen. |

**One card per thing**, the same cards as the desktop (`thingcard.js`,
`taskcard.js`, `eventcard.js`): not a second set for the web.

**The phone** has a bar along the bottom — Library, Tasks, Calendar, Notes,
People — with Canvas reached from a project or a card, and **New** (the +) in
the corner of each. **A browser on a larger screen** shows the same modules
side by side as the desktop's panels do, without the desktop's bar, dock and
windows.

**What stays on the desktop**: windows, the dock, the bar and their settings;
opening a file in an application (on the web a file is downloaded or shown);
the desktop's calendar store and its accounts (on the web, calendars are what
came through sync); the pen; Morgan's voice. Settings on the web is only what
is the web's: passkeys, sessions, machines, and the recovery key.

## Calendar

**The laptop shares the calendars** (decided 2026-11-26). The accounts stay
signed in on the desktop machines only. Each time a desktop machine's
calendar reads them (calendard.py, the reading the event mirror already made:
90 days back, 180 ahead), it also shares the reading whole — every calendar's
name and color, every occurrence from 30 days back — through the core
(`calendar-view.ts`, `PUT /calendar/view`): one sealed blob and a `calview:`
record, only when it changed, the newest winning. Home-server keeps it and the
web's Calendar draws it (`GET /calendar/view`), saying whose reading it is and
when.

- **As current as the last desktop machine awake.** A week with the laptop shut
  is a week of invitations the web has not seen.
- **Read-only for an account's calendar**: a change made on the web is said to
  wait for a desktop machine. Talaris's own calendar is the core's, and changes
  on the web as anywhere.
- **Later, if wanted:** a calendar's private subscription link read by
  home-server itself, current while the laptop sleeps, read-only.

## How the pages talk to it

The panels are web pages already; on the desktop they talk to Talaris through
a Qt bridge (`QWebChannel`): `bridge.core(id, method, path, body)` for the
core's routes, each panel allowed only its own (`ALLOWED` in each panel's
Python), and a few verbs that are the desktop's (open a file, reveal it, pin it).

**The web bridge** is the same object for the pages, over HTTPS: `core(...)`
becomes a request to `/talaris/api/...`, which the web side checks against
the same per-module routes and passes to the core; a change the core reports
reaches open pages over a WebSocket, as the surfaces' `synced` does now. The
desktop's verbs answer with what the web can do instead, or are not offered.
One page, two bridges: a panel never asks which it is in, it asks what it can
do.

## Sync over HTTPS

**First, Syncthing as now**: the web node's sync folder is home-server's
Syncthing share, and it is one more machine in it. Nothing new to build for
the transport; the carrier-only copy home-server holds today becomes this
machine's own folder.

**Then the relay, in the web side** (SYNC.md, *Transport*): each machine sends
its sealed logs and blobs to `/talaris/sync` with its token and asks for what
it has not seen. Then:

- **Syncthing goes**, everywhere — laptop, mini, deck, home-server.
- **Away from home it is plain HTTPS**: no Tailscale needed for sync.
- **One-at-a-time plugins get a lease** (SYNC.md, *Who runs a one-at-a-time
  plugin*): whichever machine is up runs them, never two.

## The weekly review, brought over whole

**Built 2026-11-26 — on the desktop only** (decided: not a web module; DESIGN,
*The weekly review*).

Hermes' weekly review comes to Talaris in every form it has there, as a
panel on the desktop — not left behind with Hermes. What it is in Hermes (`packages/shared/src/weekly-review.ts`,
`apps/server/src/review/routes.ts`, `ReviewPage.tsx`):

- **The steps.** A template of steps that come every week, in an order you
  set by dragging; steps added for this week only; each checked off as done,
  the checks cleared when the next review opens. A step can point at a thing —
  in Talaris, any thing's card or a list — or at nothing, for what is done
  outside and only ticked here.
- **The task that brings it.** A recurring "Do weekly review" task Talaris
  keeps: due on the weekday you choose, available some days before, filed in
  the projects you choose. Its next occurrence opening is what starts a new
  review. Found by the task profile and a mark of its own, never by its title
  or type's name.
- **Its settings**: the weekday, the days before, the projects, the template.
- **Its look**: the picture Hermes gives the review's page (its banner) comes
  as the review's own picture.
- **Not brought:** the weekly reflection note (decided 2026-11-26), and the
  Gmail sweep, which is a Claude skill and stays one — it only needs to make
  its inbox tasks in Talaris instead of Hermes (*Claude and Morgan*).

Its state is yours, so it syncs: the template and the week's checks are
records like any other (SYNC.md), so a step ticked on the phone is ticked on
the laptop.

## Claude and Morgan

**Claude** (Claude Code and the desktop app) reaches Hermes today through
Hermes' MCP server: to look things up when you ask ("what's due this week?",
"find the note about…"), to make and change tasks, to read and add to the daily
note, and for the Gmail sweep's inbox tasks. **Morgan** reads Talaris through
whichever Talaris machine is about (a device's `talaris_*` tools), and falls
back to Hermes where none is — for a project's details and the day (calendar,
due and overdue) in project chat — so on the Echo, with no Talaris, Hermes is
all it has.

**A Talaris MCP server, in the web side**, covers both, and being always on,
Morgan never needs a fallback. **It offers everything Claude gets from Hermes'
MCP today** (decided 2026-11-26) — Hermes' 45 tools
(`hermesnotes/apps/server/src/mcp/toolkit.ts`), each by Talaris's own means,
beside what Talaris's MCP already offers on a machine (`talaris-core mcp`:
`mcp.ts`, `mcp-desktop.ts`). Hermes' reaches Claude as a **claude.ai
connector**, so in every Claude app, the phone's too; the web side's must as
well, and a connector signs in by OAuth — the passkey sign-in is what its
consent page asks for. Not built yet. Hermes' Today-sheet tools (`today_layout_*`) are not
brought over (decided 2026-11-26): Talaris has no Today sheet, and the daily
note and `daily_review` cover what it showed. At the least:

| Reads | Writes |
|---|---|
| search everything | make a task (in a project, or the inbox) |
| tasks: find, one task's card | change a task: done, dates, title, project |
| the calendar for a day or range | add to the daily note |
| the daily note | |
| a project's details and its day | |
| the weekly review and its steps | tick a step of the review |

Each client has a token of its own (Claude's, Morgan's), revocable like a
machine's, and each is told which side it may use — Morgan reads only, as its
project chat does now.

## Retiring Hermes

What reaches Hermes besides you must have a Talaris way first, or it breaks:

- **Claude's and Morgan's Hermes tools**: the Talaris MCP server (*Claude and
  Morgan*).
- **The weekly review** (*The weekly review, brought over whole*), and the
  Gmail sweep's tasks made in Talaris.
- **The pkm-interchange binding**: Talaris's own (`packages/core` already
  speaks the format's profiles); Hermes' becomes history.

**Nothing to migrate**: everything Hermes holds came into Talaris through the
plugin, with Hermes' ids kept. Hermes sync is switched off once the web side
covers what the phone did in Hermes; Hermes is switched off when nothing asks
it anything any more.

## Order of work

Each step works on its own; nothing is broken while the next is built.

1. **The core on home-server**, joined as a machine, over Syncthing. Seen in
   the laptop's Settings, Sync, as a machine rather than a carrier. **Done
   2026-11-26**: `~/Documents/Scripts/talaris` on home-server, only the core
   and the model built; `talaris-core.service` (user, lingering) with
   `TALARIS_KEYRING_FILE=~/.config/talaris/keyring.json`; joined with
   `join.js --folder ~/TalarisSync`. It holds the same 16 projects and 393
   Library files. Plugins' records wait there (51), as they do on any machine
   without the plugin; the web side will decide what of them it runs.
2. **The web side**: Caddy, `/talaris`, passkeys, the web bridge, the Library
   and the five modules at a browser's size. Talaris in a browser. **Begun
   2026-11-26**: `packages/web` (`server.mjs`, `auth.mjs`, `public/bridge.js`),
   run on home-server as `talaris-web.service` on 127.0.0.1:8091, Caddy's
   `handle /talaris*` passing to it. The Library works whole in a browser on
   the core's own data; the five modules follow, each a page added to `PAGES`
   with its panel's routes. A page's desktop verbs (open in an application,
   the file manager, the dock) answer nothing yet. **Deploying** on
   home-server: `git pull`, then build the core, the editor and the canvas
   (`pnpm --filter "@talaris/core..." --filter @talaris/editor --filter
   @talaris/canvas build` — Notes and Canvas load the last two, built into
   `surfaces/ui`, which git does not carry), then restart `talaris-core` and
   `talaris-web`.
3. **The phone**: the bottom bar, each module laid out for a narrow screen, New.
4. **The weekly review**, in Talaris on the desktop — **done 2026-11-26**.
5. **The Talaris MCP server**; Claude, Morgan and the Gmail sweep moved to it.
6. **Sync over HTTPS**, with machine tokens and the plugin lease; Syncthing
   removed.
7. **Hermes sync off, then Hermes.**

## Open questions

- **Tailscale as a second fence** from the start, or not.
- **Morgan**: the web side could talk to Morgan's brain (home-server too) for
  typed conversation; voice stays the desktop's and the devices'.
- **Backups of the web node**: it holds everything; Talaris's backups
  (DESIGN, *Backups*) should run there, kept off home-server too.
