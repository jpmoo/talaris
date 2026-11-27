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

**One phone shell** (built 2026-11-26, UX-AUDIT 4.2): every module the same way
on a phone, in `public/modules.js`. A bar along the top — Back on the left, the
module's name in the middle, what is chosen (the Library's project) under it —
and one pane at a time: the list; the detail, when something in the list is
pressed; a sheet the page opens itself (a task's card, an event's editor); or
the side column, in over the list from the bar's left button. Each step away
from the list is a step in the browser's history, so the phone's back gesture
and the browser's Back do what the bar's Back does. Which element is the list,
the detail, the side and the sheets each page **declares** in `server.mjs`
(`PAGES[…].panes`, CSS selectors, with the rows whose press shows the detail):
nothing is guessed from a page's markup, and nothing of the page's own changes.
A page whose markup moves changes its declaration, in one place.

**Fingers** (UX-AUDIT 4.3): under `(pointer: coarse)` every control is 44 px
(`--control`), and rows, text buttons and segments as tall; a small × has a
32 px hit area; the type tokens are a step up (about 1.15 times, which the
page-wide `zoom` used to do, with its `100vh` and measuring trouble); and under
`(hover: none)` whatever the desktop shows only under the pointer is shown. The
sign-in and consent pages load `tokens.css` and the shipped typefaces (served to
anyone, as nothing in them is anyone's) and use the kit's look.

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

### Morgan's own Talaris, and Morgan on the web (2026-11-27)

**The brain keeps a Talaris of its own.** Morgan's brain runs on home-server,
which is a whole Talaris machine; it used to have Talaris only through a device
that offered it (the laptop's `talaris-core mcp`), so with the laptop asleep a
question about the calendar or tasks went unanswered. Now the brain has its own
server, `talaris`: home-server's core, `talaris-core mcp --data` (everything
but the screen), added with Morgan's `mcp.add`. The laptop offers
`talaris-desktop`: `talaris-core mcp --desktop`, only what needs its screen —
what is on it, its windows, going and opening and launching there
(`SCREEN_TOOLS`, `mcp-desktop.ts`) — and its activity (`work_log`, `where`).
Never the same tool twice. Home-server's calendar for the brain is the one the
laptop shares (*Calendar*, above), on the user's clock (the brain's Talaris is
started with `TZ`, until home-server's own zone is the user's).

**Morgan on the web, typed** (`morgan.mjs`; the `morgan` module). Its page is
the desktop's (`ui/morgan/index.html`), and it talks to the brain's own socket
— `~/heymorgan/data/heymorgan.sock`, on this same machine — as the desktop's
talks to its daemon through `morgan.py`: one line, one answer (`callLater`,
answered on `answered`), and what Morgan is doing followed on one `watch` for
every open page, handed on as the `morgan` event (`event`, and `state` when it
changes). **The socket can do anything** — whatever reaches it may add an MCP
server, which runs a program — so only the lines the conversation sends pass:
a turn typed (`ask` without `files`) or spoken (`say`, below), the
conversations and their record, reminders, incognito; of `admin`, only
cancelling a reminder. Not on the web: the daemon's own listening (`toggle`),
files from this disk, Morgan's settings, and project chat (its brief comes from
`core.py`).

### Morgan's voice on the web (2026-11-27)

Press the microphone on Morgan's page, talk, and Morgan's answer is spoken
back, in a browser and on the phone as an installed app (`voice.mjs` on the
web side, `public/voice.js` in the browser; the page itself is the desktop's,
unchanged).

**Why the web side asks the speech service itself.** Morgan's socket has no
command that takes sound or gives it: a brain does speech only for devices on
its server link (protocol §6, the `speech` ops), and joining as a device takes
an access key that can do everything (§6: there are no read-only keys) and
16 kHz PCM both ways. So the web side does what the brain does for a device,
with the same speech service (heymorgan's `speech.mjs serve` on home-ai,
`speechUrl`), and hands Morgan only words — a turn as `say`, through the same
list as everything else:

1. **Press to talk.** A tap on the microphone starts listening and a second
   tap sends; held down, it sends when let go. Pressed while Morgan works or
   speaks, it stops (`stop`), as the desktop's does. Nothing listens otherwise:
   the microphone is taken for the turn (`getUserMedia`, `MediaRecorder`) and
   given back as soon as it ends, which is also what lets an iPhone play the
   answer through its speaker rather than its earpiece.
2. The recording goes as it was made — AAC in MP4 from an iPhone, Opus in WebM
   or MP4 from Chrome, Opus in Ogg from Firefox — to `POST
   /talaris/api/morgan/hear` (signed in, `x-talaris`, at most 8 MB). ffmpeg
   makes it 16 kHz mono PCM (from a file: an MP4's index may be at its end; at
   most two minutes; the file deleted at once), and the speech service's
   `/transcribe` makes it words, told to expect Morgan's name and the brain's
   `sttPrompt`. Nothing is kept.
3. The words go to Morgan as **`say`**: a turn as spoken, so Morgan answers as
   it does aloud — short, plain sentences. A brain has no speaker, so that is
   all `say` does there; the devices speak only turns spoken to them (§6). On
   a device's socket (a laptop trying the web side out, `status` saying
   `role: "client"`) it goes as `type` instead, or the laptop would speak too.
4. **The answer, spoken.** For the turn asked in this browser (from its `user`
   event until Morgan is idle again), each `sentence` event is sent to `POST
   /talaris/api/morgan/speak`, which asks the service's `/speak` and answers
   WAV in the voice the brain keeps loaded there; the browser plays them one
   after another as they come. Turns asked elsewhere, typed turns and reminders
   are not spoken here.
5. **iOS plays sound only after a press.** The press on the microphone makes
   and resumes the page's audio (`AudioContext`, with a moment of silence
   played) — on `pointerup` and `click` too, which are what WebKit counts as a
   touch's press — and it stays unlocked for the answer.

The page shows it as it shows the desktop's Morgan: the bridge
(`WEB.morgan`, `bridge.js`) puts the browser's own listening, transcribing and
speaking over the brain's state while they last, and its level meter follows
the microphone and Morgan's voice. Morgan's state is read with `status` when
the page connects and after a stop, since a turn stopped while thinking may
send no state of its own after. A browser that cannot record (no
`MediaRecorder`, or not over HTTPS) has no microphone button, as before.

**Where the speech service is**: `TALARIS_WEB_SPEECH_URL` and
`TALARIS_WEB_SPEECH_KEY` in the web side's environment, if set; otherwise the
brain's own settings, `speechUrl` and `speechKey` in `HEYMORGAN_CONFIG` or
`~/heymorgan/data/config.json` (on home-server the web side runs as the
brain's user, so nothing needs setting). Read at each use, so a changed key is
taken up; never logged, and never in an answer. home-server needs ffmpeg
(it has it).

### Asking from Siri (2026-11-27)

iOS lets only Siri listen for a wake word, so "Hey Siri, Ask Morgan" is an iPhone
Shortcut: Dictate Text, then `POST /talaris/morgan/ask` with `{"text": …}` and
`Authorization: Bearer <key>`, then Speak Text of the answer's `answer`. The
key is made by `talaris-web token siri` (only a `siri` key is taken here, not an
MCP key). The turn is a typed one, through the same list as the web page; the
answer is what Morgan would say aloud (its `sentence` events), sent back when
Morgan has written it, or after 25 seconds with `ok: false` and a word to look
in Talaris.

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
   **Begun 2026-11-26**: the bottom bar, and one phone shell for every module
   (*What it shows*); New, and the wide screen's side-by-side, still to come.
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
