# Talaris — design

> **A thinking-space desktop for Hyprland, with an assistant built in.**
>
> At greater length: a project-centric desktop shell for Hyprland, with a
> built-in assistant and plugins for your knowledge tools.

**Status: design, not built.** Worked out in conversation on 2026-10-22 and
23, first as a plan for Talaria's Linux front end and then, once it was plainly
its own thing, as this. One spike has run (see *What the layer spike found*).

## What it is

**A desktop for Hyprland, and nothing else on the screen.** No desktop shell
underneath — no Noctalia, no waybar, no dock. Talaris draws everything you see
that is not an application window; the few things it does not draw come from
small single-purpose tools named in *What Talaris borrows*.

**Projects, not workspaces.** Every project has a canvas and a writing surface,
and may grow a workspace of tiled applications, a folder and a set of cards
that reopen what you had open. Everything opens *from where it lives* on a
canvas, or flies in from nowhere if it lives on none. You can ask for any of it
by name — in the launcher, or out loud.

**Morgan is built in.** The assistant (`jpmoo/heyclaude`, called Morgan) is how
the desktop is talked to, and the desktop is what Morgan knows about. It is
the one chat. See *Morgan*.

**Knowledge tools are plugins.** Hermes Notes is how this started, and it is
not baked in: dropping a block or a collection onto a canvas, making one, and
linking to one are what a Hermes plugin does, speaking the `pkm-interchange`
spec. So is anything else that connects the desktop to something outside it.
See *Plugins*.

**Its own thing.** It is not Talaria, and does not need Talaria's daemon.
Talaria is the Hermes companion on macOS and KDE and stays that; Talaris took
what it had learned and a few of its parts (`from-talaria/`). There is no KRunner
and no KDE path.

**Hyprland first, not Hyprland only.** See *The compositor is a backend*.

The name is the adjective *talaris*, "of the ankle," of which Hermes' winged
sandals, *talaria*, are the plural.

## The screen

**Four edges, each with one job.** Nothing is in the middle but your work.
This is the default arrangement:

| edge | what lives there |
|---|---|
| **Top — the bar** | The launcher, the machine's status (clock, battery, volume, network, Bluetooth), the power menu. |
| **Bottom — the dock** | What is running: open applications, and the projects that have a workspace. Where you see what is alive and switch to it. |
| **Left and right — the drawers** | The current project's **canvas** and **writing surface**, and the **file tree** of its folder. |
| **Morgan** | A button on the bar or the dock (which, is a design question), a hotkey, and the wake word. Never only one of the three. |

**Any of it can move** (decided 2026-10-23):

- **Any piece goes on any edge that is free** — the bar on the left, the drawers
  along the top, whatever suits the screen. The bar, the dock and the drawers
  each take one edge; nothing is hardcoded to its default.
- **Drawers can share an edge, and then they are tabs.** Canvas, writing and
  files can be three drawers on three edges or three tabs on one.
- **The bar and the dock can hide themselves**, each on its own switch, and come
  back when the pointer reaches their edge. Off by default.

So every surface is laid out from its edge, never from "top" or "left" — the
drawer that slides in from the right is the same code as the one that drops from
the top. An exclusive zone is reserved only for what is pinned; a hidden bar
gives its space back to the windows.

### The drawers

The canvas and the writing surface are not the wallpaper and not windows. They
are **drawers**:

- **On an empty workspace they are out** — the canvas *is* what an empty
  desktop shows, and the writing surface is a pull away.
- **Once windows are tiled they are filed away** to their edge, as a handle or a
  button, and **pull out over the windows** when wanted — above the
  applications, not behind them — and file back.
- They belong to **the current project**: switch project and the drawers are
  that project's.

That is the spike's two layers given a meaning: `bottom` is "out on an empty
desktop," `overlay` is "pulled out over the windows." The way back is never
optional — a compositor bind, Escape, and filing itself away after a stretch
with no input — because the first spike had none and ended in a restart.

### It should look like an operating system

**Not like a web page.** The surfaces are web views — that is how the canvas
and the writing surface already work, and the spike showed it holds on a layer
surface — but nothing about them should read as a browser: no page chrome, no
default form controls, no scrollbars that look like a document's, no text that
selects when you drag a panel, consistent motion, one type scale, one set of
icons, the system's own font rendering, keyboard everywhere, no first frame at
the wrong size, and the compositor's own blur, rounding and shadow behind
translucent surfaces rather than a page drawing them.

**Themes are swappable.** The look is a theme, and more can be added later; the
first one ships as the default.

**The default: the future as the late '90s and early 2000s imagined it.** Film
and game interfaces of that era, not its operating systems — closest to
*Minority Report* (2002) — with clean lines and easy on the eyes. Not a
terminal, and not a starship console. Settled 2026-10-23:

- **Dark at heart.** The light version is designed to match, and leans heavily
  on grays rather than going white. Both, plus following the time of day.
- **Mostly gray, one accent.** Neutral grays carry everything; a single color
  marks what is selected, live or actionable. **The accent is the user's
  choice**, and the offered ones are soft and muted — an orange, a green —
  never neon.
- **Softly rounded corners.**
- **Technical type**, in the *Minority Report* family but a little less narrow
  — a semi-condensed sans. Which face is still being chosen.
- **The detail is part of the look**: thin rules, small letter-spaced labels,
  quiet codes and counts in the margins (`PRJ-03 · 14 ITEMS`, `LIVE`,
  `ASLEEP`). Information first — every small label says something true — never
  decoration for its own sake.
- **Motion is a setting.** Drawers slide in smoothly by default; the other choice
  draws the frame in lines first and then fills it. Both honor a reduced-motion
  setting that makes them near-instant.

## The model

| | |
|---|---|
| **Project** | A canvas and a writing surface. That is the whole requirement. A workspace, a folder and a set of cards are facets it grows when used. A plugin may bind a project to something outside — a Hermes project, say — and then it carries that thing's id. |
| **Home** | The project that is always there: a scratchpad and the front door. It holds loose notes, a card for each project, and the **Recent** strip (see *Floating*). |
| **Canvas** | A document Talaris owns. Notes, shapes, connections, regions and cards. An item a plugin placed carries the plugin's id and the thing's id, and is drawn by the plugin. |
| **Writing surface** | Markdown files in the project's own folder of writing — the Talaria writing surface, per project. |
| **Card** | A placed thing on a canvas: an app on a target, a website, a file, a plugin's thing. Asleep, it is a snapshot and an intent. Open, it is bound to a live window or editor. |
| **Floating** | A thing that is open and placed nowhere — the browser you are riffing in, something you just looked up. *Place* turns it into a card. |
| **Workspace** | A project's desktop: `name:<project id>` in Hyprland, created the first time something in the project opens. The bar and dock show the project's title, never the id. |

**Talaris keeps furniture; plugins keep knowledge.** Window cards, launch
targets, folders, snapshots and notes drawn on a canvas belong to this machine
and to Talaris. A Hermes block on a canvas belongs to Hermes, is referenced by
id, and is still one block when it sits on three canvases. The tool strip keeps
the difference visible: "note on this canvas" and "thing from Hermes" are not
the same, and a line drawn between two things stays on the canvas unless the
plugin offers *make it a relation*.

### Two kinds of card, chosen when the card is made

- **Bookmark** — always opens to the target it was made with. The snapshot is
  what was saved, so the card looks like what it points to.
- **Resume** — opens where you left it. Target and snapshot update on every
  close, so the card looks like where you stopped.

Placing a floating thing defaults to *resume* (you are mid-something); making a
card fresh from the tool strip defaults to *bookmark*. One toggle on the
placement prompt, changeable later. **Store the original target beside the
current one from the start**, or "reset to original" has nothing to reset to.
The two must look different on the canvas.

What *resume* can mean is set by the app, and the card says so honestly: a web
page resumes its URL; an editor its folder; a terminal only its directory — a
resumed terminal reads "in `~/ogham`", not "where you left off."

**Bookmark cards are built first. Resume is a spike** — see *Apps*.

### Floating things are not lost

Closed without being placed, a floating thing does not vanish: it lands on
Home's **Recent** strip, to be placed or thrown away. Home is where triage
happens.

## Verbs

Every caller — a click on a card, a launcher result, a hotkey, Morgan, a
plugin — uses the same small set, defined once, in the core:

| | |
|---|---|
| `go <project>` | switch to its workspace; its drawers become current |
| `open <card>` | focus its window if one is bound; otherwise launch its target and bind what appears |
| `open <thing>` | see *Opening* |
| `launch <app> [target]` | start an app in the current project, in the project's folder |
| `place <thing> [canvas]` | floating → card, on the current canvas or a named one |
| `close <project>` | snapshot and close its placed windows; ask about its floating ones |
| `export <canvas> png\|pdf` | the canvas as a picture or a document |
| `new …` | project, note on Home, card from the focused window |

Plugins **add** verbs; they never redefine these. "Open the Ogham editor," said
to Morgan, is `open <card>` reached through Talaris's MCP — not a second
implementation of opening.

## Opening

**Everything opens.** What differs is where from.

- **On the current canvas:** it opens *out of its card*, and the animation and
  presentation make that plain.
- **On another canvas:** `go` there, then open out of the card.
- **On no canvas:** it flies in floating, with *place on a canvas* offered.

For things drawn by Talaris or a plugin the editor can grow from the card's
exact rectangle. For app windows Hyprland owns the animation and takes no origin
per window, so the canvas fakes it: the snapshot zooms toward where the window
will land, the real window maps underneath, and a crossfade hands over. A
floating launch can name its rectangle (`exec [float; move …; size …]`); a tiled
one learns its tile only once mapped, so the first version zooms to the center.

## The surfaces

**Every piece of screen furniture is a layer surface in one process** — the
spike showed a Qt process under `QT_WAYLAND_SHELL_INTEGRATION=layer-shell`
makes every window a layer surface, which is what furniture wants and what
ordinary windows do not. None of it is a window rule, so none of it is dropped
when Hyprland reloads its config.

### The bar

Along the top with an exclusive zone, so tiled windows and the drawers keep
clear of it.

- **The launcher's entrance**, and its hotkey.
- **The machine**: clock, battery, volume, network, Bluetooth. Read from
  `wpctl`, `nmcli`, `bluetoothctl` and `/sys` — all already here. Clicking one
  opens a small panel; deeper settings hand off to existing tools (`nmtui`,
  `bluetoothctl`) rather than being rebuilt.
- **The power menu**: lock, log out, suspend, restart, shut down.
- **Plugin items**, where a plugin asks for one.

**No tray, to begin with.** A StatusNotifierItem host plus DBusMenu is the most
fiddly thing a shell does, and Qt offers no host for either. Which applications
here actually need one is the question to answer before building it.

### The dock

Along the bottom: open applications, grouped by the project whose workspace
they are on, and the projects that are live. Click to go; the count of live
windows per project is the same number pruning acts on.

### The launcher

An overlay with exclusive keyboard while it is up. One box, everything:

- **Projects** (ranked high), **cards** ("Ogham › VS Code on `~/ogham`"),
  **files** in the current project's folder, **live windows**, **applications**
  from the XDG `.desktop` files, the **verbs**, and whatever **plugins**
  contribute — Hermes blocks, for one.
- **Morgan, as the fallthrough.** Text that matches nothing is a question, and
  Enter asks Morgan.
- A **modifier** takes the second action ("place it here" rather than "go
  there"), and a result can be **dragged** onto a canvas.

Current project and recency raise the rank. From Talaria's KRunner, two things
worth keeping: an unprefixed query matches **titles only**, and **forty are
fetched to keep ten**. An application launch lands on the current project's
workspace, and Talaris sees the window appear and offers to make it a card.

### Notifications

Talaris is the notification daemon — `org.freedesktop.Notifications` — with
popups as layer surfaces, because a notification here can be **placed** on a
canvas like any floating thing and **Morgan can say it**. The spec is not small
(actions, replacement, urgency, images, expiry), so until it is done `mako`
holds the bus; the bus name is the whole interface, so nothing else changes
when Talaris takes it.

### The small ones

- **The on-screen display** for volume and brightness: the keys stay compositor
  binds calling `wpctl` and `brightnessctl`, and also tell the surface to show
  the level.
- **The theme**: one palette every surface reads. Writing it out for Ghostty and
  GTK is a later nicety.

### Settings

**One settings application for the whole shell** — not a Talaris panel beside a
Hermes panel beside a Morgan panel. The bar, the dock, the drawers, the
launcher, the keys, the theme, Morgan, and **a page per plugin**, which the
plugin provides.

### What Talaris borrows

| | |
|---|---|
| Lock screen | **`hyprlock`**, installed. Never build a lock screen. |
| Idle | **`hypridle`**, installed and already in `hyprland.conf`. |
| Polkit agent | **`hyprpolkitagent`**, not installed. Install it before removing Noctalia, or password prompts quietly stop appearing. |
| Notifications, for now | **`mako`**, not installed, until Talaris holds the bus. |
| Network and Bluetooth settings | `nmtui`, `bluetoothctl`, opened from the bar. |

## Morgan

A voice-and-chat assistant: wake word, speech in and out, a local model for the
talking, Claude ("the Oracle") when that is not enough, memory, reminders, MCP
tools. Its daemon is `heyclaude.service`, it answers on
`$XDG_RUNTIME_DIR/heyclaude.sock` with commands (`toggle`, `ask`, `say`,
`stop`…) and an event stream (`watch`), and its face today is a Noctalia plugin
plus `window/window.py`, a PySide6 web view around `index.html`.

**Its face is Talaris's.** The Morgan button, the voice popup, the conversation
and Morgan's page in Settings are Talaris surfaces. `index.html` comes across
nearly as it is — already a page talking to the daemon through its host — and
is the conversation surface, as a pull-out panel or as an ordinary window you
tile and keep beside work.

**Its brain stays its own process,** over the socket it already has. Morgan
crashing should not take the desktop with it, and `docs/server-and-satellites.md`
in its repository moves the brain to the home server so one Morgan serves every
device. In that plan this laptop is a satellite, and Talaris is the satellite's
face.

**The one chat.** Talaria had two — *Ask Hermes Notes* and Canvas Chat. Neither
comes across. Canvas Chat's one job, building and editing a canvas, becomes
**tools** on Talaris's MCP that Morgan calls; questions about the library go to
Morgan, which reaches Hermes through Hermes' own MCP.

**The desktop is what Morgan knows.** Talaris serves an MCP — projects,
canvases, writing, cards, the drawer, the verbs, plugin tools, and *what is
current* — and Morgan connects to it:

- *What am I looking at?* is answered from Talaris: Ogham, its canvas, this
  card selected, VS Code focused. **No screenshot.** Morgan's sight today is a
  photograph of the screen; structured context is the better answer and the
  private one. Sight stays for when it is asked for in so many words.
- *Open my editor*, *put this on the Ogham canvas*, *close what I'm not using*
  are verbs.
- What is current is **state, not a record**: no history of windows is kept.

**Glance is not coming.** Talaria's Glance read the focused window's pixels and
found related notes. Structured context answers the question it was for.

**Still open in Morgan's own repository:** it is called `heyclaude` — the
repository, the command, the unit. Renaming is its own change, there.

## Plugins

**The plugin surface is the core feature after the screen itself**, because
everything that connects the desktop to the outside — Hermes first — is one.

What a plugin should be able to contribute (a first list, to be designed):

- **Launcher results** and the action each takes.
- **Things on a canvas**: a kind of item it draws, what dragging one in does,
  what opening one does, and a source in the tool strip to drop one from.
- **Verbs**, which Morgan can call through Talaris's MCP like any other.
- **Bar and dock items.**
- **A page in Settings.**
- **Notification actions**, and things to place from a notification.

**The Hermes plugin** is the proving case: drop a block or a collection onto a
canvas, make one there, link to one from anywhere, open one. It **speaks
`pkm-interchange`** and nothing else — the rule Talaria kept, kept here — and
so is one more independent implementation of the format, which is what makes
the format prove anything. Morgan's route to Hermes stays Hermes' MCP; the two
meet on the block id.

**Others already named:** text-message sign-in codes (Talaria's BlueBubbles
reader), what Talaria called *Noticed* (background proposals), a hotkey for the
Hermes window — each a plugin later, or a bind in `hyprland.conf`, not core.

**A plugin is its own process** (decided 2026-10-23). It talks to the core over
a socket, never by being loaded into it. Three reasons, any one enough:

- **A crashing plugin does not take the desktop with it** — the same reason
  Morgan is its own process.
- **Any language.** A plugin is whatever speaks the protocol, so the core's
  language does not become every plugin author's.
- **Any license.** Talaris is GPL. Code loaded into a GPL program's process is
  arguably part of it, and would have to be GPL too; a separate program talking
  over a socket is not. So a plugin can be open, closed or sold — by the owner
  or anyone else. That is what keeps *One product, two licenses* (below)
  workable, and leaves room for plugins as a business.

What the plugin draws inside a surface — its item on a canvas, its Settings
page — is still to be designed: a page the surface hosts but the plugin's
process feeds is the likely shape. **Still open:** the protocol itself (MCP, or
something MCP-shaped), how a plugin is installed and started, and what it is
allowed to touch.

One rule is fixed: **what Talaris does not understand on a canvas, it must not
destroy** — an item from a missing plugin is kept and shown as a placeholder,
never dropped.

## One product, two licenses

Decided 2026-10-23. Talaris is **GPL-3.0-only**, and the same code is also
available from its owner under a commercial license — for anyone who wants to
do what the GPL does not allow, such as shipping it inside a closed product.
There is **no separate paid edition**: everyone gets the same Talaris, and the
license is what is sold. Plugins are where anything else is sold, and because
they are separate processes they carry their own licenses. Outside
contributions come under `CLA.md`, which is what lets the owner keep offering
both licenses; it is a draft until a lawyer has read it.

## Apps

**The real cost is knowing which window belongs to which card.** Hyprland ties a
launch to a window by pid, and that fails for anything single-instance — a
browser, VS Code, often a terminal — because the launch hands off to the running
process and exits. So each kind of app gets an **adapter**: how to open *this
target* in a *new window*, how to recognize that window, whether it can be
closed silently, and what *resume* means for it.

- **Terminal** — Ghostty as a fresh instance with its own class. Easy.
- **Editor** — `code --new-window <folder>`, matched by folder in the title.
- **Web** — the real browser, not one of ours. `firefox --new-window <url>`
  opens a real window with your extensions and logins. To bind it, Talaris
  notes which browser windows exist, launches, and claims the **next new one**
  to map; from then on it follows the Hyprland address, which is fixed for the
  window's life. Two browser windows opened in the same second could cross;
  that is rare enough to accept.

Everything else opens floating and unbound until it earns an adapter.

**Resume for the web is the open spike.** Resume needs the URL you ended on, and
a browser tells the compositor only its title. Three candidates:

1. **A small extension** reporting each window's tabs. Cleanest, and the only
   one that brings back *all* the tabs; adding an extension is the owner's call.
2. **Firefox's session file** (`sessionstore-backups/recovery.jsonlz4`),
   rewritten every fifteen seconds or so, matched to Hyprland's windows by the
   active tab's title. No extension; hacky; a little stale at the moment of
   closing.
3. **A WebEngine window of our own.** Full control, a plainer browser with its
   own cookie store. Held back as a "quick web card."

### Snapshots

A card's snapshot is a capture of *its own* window's rectangle while visible —
on leaving the workspace, on close, and on a slow timer. Ubuntu's grim has no
per-window capture, so this is a region of the screen.

**Bounded on purpose.** Talaria removed an ambient panel because following the
focus meant photographing every window passed through. Snapshots are only ever
of windows that are cards, never of a window because focus crossed it, they
skip password managers and anything else on a blindlist, they stay on this
machine, and **Morgan does not get them** as a way of seeing — they are the
card's face, not a camera.

## Pruning

Several browser windows across several projects eat memory fast. **Cards are
what make closing safe** — a window can be closed only if its card brings it
back:

| | closed automatically? |
|---|---|
| bookmark card | **yes** — reopens exactly as it was |
| resume card | **not yet** — only once resume works for that adapter |
| floating, unplaced | **never** |
| anything with unsaved state | **never** — a polite close to an editor on a hidden workspace is a "Save changes?" dialog nobody can see. The adapter declares it: a web bookmark can; a terminal only when its shell has no children. |

When, gentlest first:

1. **`close <project>`**, asked for — by click, launcher or Morgan.
2. **Projects left alone** for a while — configurable, a few hours.
3. **Memory pressure**, from `/proc/pressure/memory`: least recently used safe
   windows first, never in the current project, never anything focused in the
   last few minutes.

SIGSTOP is not an answer — it frees the CPU and keeps every byte. **Always
visible:** cards show live or asleep, a notification says what was closed and
that it is on the canvas, and the dock counts live windows per project.

## The compositor is a backend

Decided 2026-10-23. Talaris needs two things from a compositor, and they are not
equally portable:

- **Drawing the furniture** — bar, dock, drawers, launcher — needs
  `wlr-layer-shell`. Hyprland, Sway, niri, river, Wayfire, labwc and KWin have
  it; GNOME does not, and X11 window managers cannot. That line is permanent.
- **Driving the windows** — list them, follow focus, make a named workspace,
  launch an app onto one with a size and place, bind a window to a card — has no
  common protocol for the parts that matter. Listing, focusing and closing have
  standard Wayland protocols (`ext-foreign-toplevel-list`,
  `wlr-foreign-toplevel-management`), and `ext-workspace-v1` is young and thinly
  supported; "open this on the Ogham workspace, floating, here" is
  compositor-specific everywhere.

So the core never talks to Hyprland directly. It asks a **backend** — one small
interface: windows, workspaces, launch-with-placement, focus, and the event
stream — and Hyprland is the first one. This is Talaria's `wm/` pattern, kept
from the first line rather than retrofitted.

**Sway** would be the easiest second backend; its i3-style IPC covers the same
ground. **niri** would need thought rather than code — it scrolls a strip of
windows instead of switching workspaces, which changes what "a project's
workspace" means.

## Where it runs

| | |
|---|---|
| **Core** | Projects, canvases, writing, cards, the verbs, the launcher query, the plugin host, and the MCP Morgan connects to. A user service; the one thing that must be running for anything else to mean something. **Its language is open** — see below. |
| **Surfaces** | One PySide6 process under `layer-shell`: bar, dock, drawers, launcher, notification popups, OSD, Morgan's popup. Web views through a socket-backed scheme, as Talaria's `scheme.py` worked out. A user service that restarts — a crashed surfaces process is a blank screen. |
| **Windows** | What are ordinary windows — Settings, Morgan's conversation kept open beside work — in a second process, because layer-shell is chosen per process. |
| **Morgan** | `heyclaude.service`, its own repository. |
| **Borrowed** | `hypridle` → `hyprlock`, `hyprpolkitagent`, `mako` for now. |
| **Hyprland config** | `talaris.conf`, written by the installer and `source`d from `hyprland.conf`, which stays the user's: the binds, workspace rules and `exec-once` lines. Taking Noctalia out is deleting its one `exec-once`. |

**Core, separate from the surfaces,** because state must outlive a surface
crash, Morgan and the CLI need it with no screen at all, and plugins' own
processes need something to talk to.

**The core's language is the first technical decision.** TypeScript on Node is
what Talaria's daemon and Morgan's are, has the MCP SDK, and is what a plugin
author most likely writes; Python is what the surfaces are. Not decided.

## Spikes before committing

- ~~**A layer surface from PySide6.**~~ **Run** — see below.
- **Several layer surfaces in one process**: drawers, bar with an exclusive zone,
  dock, and the launcher with exclusive keyboard, all at once.
- **A drawer**: filed to an edge as a handle, pulled out over tiled windows, and
  back — the spike's layer swap with a slide instead of a jump.
- **Morgan's page as a surface**: `index.html` on a layer surface, talking to
  `heyclaude.sock` through the host, and a voice turn start to finish.
- **Next-new-window binding** against real Firefox and VS Code.
- **Resume for the web** — the session file first.

### What the layer spike found

`from-talaria/spikes/layer_canvas.py`, run on Hyprland 0.53.3, Qt 6.10.2 and
LayerShellQt 6.6.4 (Ubuntu's `layer-shell-qt`, unpacked rather than installed —
**Talaris will need it as a dependency**). Talaria's canvas fork, through
Talaria's `scheme.py`, on a full-screen `bottom` surface. **The Qt route holds;
nothing has to be ported to WebKit.**

- **The furniture is its own process, and has to be.** Attaching one `QWidget`
  window of an ordinary process falls back, silently, to an xdg toplevel — one
  tiled onto a workspace during the spike. With
  `QT_WAYLAND_SHELL_INTEGRATION=layer-shell` the whole process is layer
  surfaces.
- **The order is: show, then `Window::get()`, then set, then hide and show.**
  A `get()` before the first show builds an orphaned `Window` the surface never
  reads. Through ctypes for that one call; everything else is Qt properties.
- **A layer change needs a new surface.** `set_layer` on the live one did
  nothing; a hide and show moves it, and the page keeps its state. It costs one
  frame at 640×480 before the real size arrives, which has to be hidden.
- **Clicks and typing work.** A click gives it the keyboard (on-demand). Taking
  the overlay takes the keyboard at once; leaving it gives it back. The Super
  key of a compositor bind arrives as a stray `Meta` keydown — ignore it.
- **Scrolling works, on both layers.** Two-finger pan and pinch arrive as wheel
  events — 476 in one short session on `bottom`. **Never install a Python event
  filter on the whole application**: PySide was asked to wrap a
  `QWebEngineUrlRequestJob` mid-construction and segfaulted. Filter the objects
  you hold.
- **The first run had no way back, and ended in a restart.** The overlay covered
  the terminal the only escape was typed in. So: a compositor bind, Escape, an
  **idle** timeout (a fixed one fired mid-scroll and pulled the canvas out from
  under the hand using it), and a signal to force it down. **Ships with all of
  them.**
- **Signal by pid.** `pkill -f` also matches the shell running it — it killed
  the agent's own shell, and a bind's `sh -c` would be next.
- **Whatever shares a layer is covered** by what maps after it — Noctalia's
  desktop widgets disappeared under the canvas.
- **Scale**: the page reports 1.5625, because the session sets
  `QT_SCALE_FACTOR=1.25` over a 1.25 monitor — as every other Qt window here.

## Order

**Milestone one — Talaris is the whole screen.** Noctalia can run through all
of it and comes out at the end.

1. The borrowed pieces installed: `layer-shell-qt`, `hyprpolkitagent`, `mako`.
2. The core, with Home: a canvas and a writing surface.
3. The surfaces process as a service: the drawers on an empty desktop and pulled
   out over windows, with every way back.
4. The bar and the dock.
5. The launcher: applications, files, verbs, and Morgan as the fallthrough.
6. Morgan's face: the button, the popup, the conversation.
7. Settings, the theme, the OSD, the power menu.
8. Remove Noctalia's `exec-once`.

**Milestone two — projects and plugins.**

9. Projects: per-project drawers, workspaces, `go`, the dock and launcher.
10. Talaris's MCP — context and verbs — and Morgan connected to it; Canvas
    Chat's job as tools.
11. Bookmark cards with three adapters; snapshots; opening out of the card;
    export.
12. Floating, *place*, Recent.
13. The plugin surface, and the Hermes plugin on it.
14. Pruning.
15. Talaris's own notifications, replacing `mako`.
16. Resume, once the spike says how.

## What did not come from Talaria

Decided in the walkthrough of Talaria's features, 2026-10-23:

| Talaria | here |
|---|---|
| Desk | gone — the drawers are the desk |
| Canvas | **kept**, per project, as a drawer; export to PNG/PDF is a verb; Canvas Chat → Morgan |
| Writing surface | **kept**, per project, as a drawer |
| Collections board | gone |
| New Block, Link to a block | the Hermes plugin |
| Noticed | dropped for now; a plugin later |
| The Hermes window | dropped; a plugin, or a bind in `hyprland.conf` |
| Settings | one settings app for the whole shell |
| Sign-in codes from texts | a plugin |
| Tray and menu | the bar |
| KRunner | gone — no KDE |
| Ask Hermes Notes | Morgan |
| Glance | gone |
