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

**Morgan is built in.** The assistant (`jpmoo/heymorgan`, called Morgan) is how
the desktop is talked to, and the desktop is what Morgan knows about. It is
the one chat. See *Morgan*.

**Knowledge tools are plugins.** Hermes Notes is how this started, and it is
not baked in: dropping a block or a collection onto a canvas, making one, and
linking to one are what a Hermes plugin does, speaking the `pkm-interchange`
spec. So is anything else that connects the desktop to something outside it.
See *Plugins*.

**Its own thing.** It is not Talaria, and does not need Talaria's daemon.
Talaria is the Hermes companion on macOS and KDE and stays that; Talaris took
what it had learned and a few of its parts. There is no KRunner
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
| **Morgan** | A button on the bar, beside the launcher's search — asking starts in one place, typed or spoken. Also a hotkey and the wake word; never only one of the three. |

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

### What opens from the bar (decided 2026-10-24)

**There are no drawers.** The canvas and the writing surface are bar items, as
Morgan's conversation and the calendar are, and all four behave alike
(`surfaces/overlay.py`; the canvas and writing in `workspace.py`):

- **A panel:** centered over the rest of the screen, which it dims, wider than
  tall for the canvas and writing; it comes and goes with the windows' or the
  panels' motion (Settings, Bar), and goes on a press off it, on Escape, or
  after a stretch untouched.
- **A window:** the panel's one button (the expand corners) makes it an
  ordinary window of the same process, which Hyprland tiles beside the rest
  and puts full screen by its own key. A window's one button closes it. No
  desktop of its own is needed: a window is already where windows are.

This rests on layer-shell attached per window rather than per process
(`layershell.py`, 2026-10-24): one process holds the bar's layer surfaces and
these ordinary windows. The bar reads left to right: making and finding (the
launcher, Morgan, the canvas, writing; People to come), the date and time with
the calendar in the middle, and the machine on the right.

The drawers' design follows, kept as what was built and replaced:

### The drawers (replaced 2026-10-24)

The canvas and the writing surface are not the wallpaper and not windows. They
are **drawers**:

- **On an empty workspace they are out** — the canvas *is* what an empty
  desktop shows, and the writing surface is a pull away.
- **Once windows are tiled they are filed away** to their edge, as a handle or a
  button, and **pull out over the windows** when wanted — above the
  applications, not behind them — and file back.
- They belong to **the current project**: switch project and the drawers are
  that project's.

**Handles are small, and optional.** A filed drawer is a slim tab on its edge
— enough to say something is there. A setting, later, removes the handle
entirely and **opens a drawer when the pointer bumps its edge**, filing it again
when the pointer leaves, as an autohiding bar does: a thin, invisible strip on
the edge watches for the pointer. A pulled drawer also has its own **close**
control, not only Escape and the keys: **a tab where the handle was** — the
middle of the screen-side edge, the handle's size — so the way back is where
the way in was. There is no X in the corner.

**A drawer can expand to the whole screen** (later). The canvas or the writing
surface fills the screen, and the project's windows **fly off** — each toward
its nearest edge — the way *show desktop* clears the screen on a Mac or
Windows, except that what is left is a surface to work on, not wallpaper.
Collapsing it brings the windows back to exactly where they were. In Hyprland
terms the windows are moved aside, not closed (a special workspace, or slid
off-screen), so nothing they hold is lost and nothing needs relaunching.

**How a drawer closes is a setting** (later): the close tab only; clicking
anywhere outside the drawer, with no tab; or both, with the tab shown. Escape, the keys and the idle timeout work under all three.

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

**One set of controls.** Every button, menu and field — the drawers' and the
canvas's, which came from Hermes with its own — takes its look from one file,
`surfaces/ui/controls.css`: icon buttons are rounded squares, text buttons are
pills, menus are one kind of panel. A control that looks unlike its neighbor
is a bug in that file, not a local style to add. The tuner's table has the
measurements.

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
  choice**: a handful of soft, muted ones are offered — an orange, a green, a
  steel blue, an amber, a dusty rose — and a standard color picker takes any
  other.
- **Softly rounded corners.**
- **Technical type**, in the *Minority Report* family but a little less narrow
  — a semi-condensed sans. **The user chooses the face**; a few are offered
  (Rajdhani, Barlow Semi Condensed, Saira Semi Condensed, Exo 2 were tried).
- **The detail is part of the look**: thin rules, small letter-spaced labels,
  quiet codes and counts in the margins (`PRJ-03 · 14 ITEMS`, `LIVE`,
  `ASLEEP`). Information first — every small label says something true — never
  decoration for its own sake.
- **Motion is a setting**, three ways (2026-10-23):
  - **Slide** — the drawer slides in smoothly. The default.
  - **Draw in** — the frame is traced, top and bottom edges then the far side,
    and the panel fills.
  - **Connect** — crosshairs appear first at the frame's corners and along its
    edges and dividers, then lines run between them in random order, random
    direction and random timing, and the panel fills once they meet. The
    *Chaos Computer* feeling, but the lines always go somewhere — from mark to
    mark — never loose across the panel.

  All three honor a reduced-motion setting that makes them near-instant.

**The reference is `design/theme-tuner.html`** — the approved grays, accents,
typefaces, motions and touches in one page that opens in any browser, with the
values tabulated beneath it. The real theme is built from it; if the two ever
disagree, decide which is right and change the other.
- **Small instrument touches, where they mean something**: a blinking block
  cursor in a field that is waiting for you; crosshair marks at a surface's
  corners; a crosshair and live coordinates over a canvas, where position is
  real information. Same rule as the labels — never where they say nothing.

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

- **The launcher's entrance**, and its hotkey — and **Morgan's button** beside
  it, showing listening, thinking or speaking. Search or ask, in one place.
- **The machine**: clock, battery, volume, network, Bluetooth. Read from
  `wpctl`, `nmcli`, `bluetoothctl` and `/sys` — all already here. Clicking one
  opens a small panel. **Wi-Fi and Bluetooth get real controls** (changed
  2026-10-23; the first pass handed them to `nmtui` and `bluetoothctl` in a
  terminal): the networks in reach, joining one, with a password asked for in
  the panel; Bluetooth on and off, devices paired and in reach, connecting.
  Still through `nmcli` and `bluetoothctl`, not rebuilt. **Built**: each is a
  popup from its bar item — Wi-Fi on and off, networks by strength with saved
  ones first, a press joins an open or saved network and opens a password row
  for the rest, Disconnect and Forget (asked twice); Bluetooth on and off, your
  devices with connect, disconnect and forget, Find devices (an eight-second
  scan), and Pair (pair, trust, connect). What the panels cannot do —
  enterprise sign-in, a PIN to confirm — is *More settings*, the full tool in
  a terminal. The password reaches `nmcli` as an argument, so it is on this
  machine's process list for the moment of joining.
- **The power menu**: lock, log out, suspend, restart, shut down.
- **Plugin items**, where a plugin asks for one.

**No tray, to begin with.** A StatusNotifierItem host plus DBusMenu is the most
fiddly thing a shell does, and Qt offers no host for either. Which applications
here actually need one is the question to answer before building it.

### The dock

Along the bottom: open applications, grouped by the project whose workspace
they are on, and the projects that are live. Click to go; the count of live
windows per project is the same number pruning acts on.

**Another project's apps** (2026-10-26) are drawn fainter and greyer, their
tip naming the project. One open only in another project does, when pressed,
what its menu chooses — a new window here, its window brought here, or gone
to — the default being a new window here for an app whose desktop file says
it opens new windows (a browser, a terminal), and the rule in Settings for
the rest, which are taken as keeping one. Its menu lists every window of it
on every desktop, with its project, to go to one; and opens a new window
here. The launcher keeps to the same choice.

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
| Idle | **`hypridle`**. Settings, Power, when Talaris manages power, writes `~/.config/talaris/hypridle.conf` (dim, lock, screen off, suspend) and runs a hypridle of its own with it; off, the user's own hypridle is left alone. Two at once would each lock and turn the screen off, so the page says when another is running. Plugged in and on battery each have their times; Talaris watches the charger and starts its hypridle again with the other set. |
| Lid | **logind**, until Talaris manages power: then Talaris holds a `handle-lid-switch` inhibitor (`systemd-inhibit`, a child process) and acts on Hyprland's lid switch binds — suspend, lock, screen off or nothing, plugged in, on battery, and with another screen (first; screen off darkens only the laptop's). |
| Tray | **Talaris's own**: `surfaces/trayd.py`, a child process, is the StatusNotifierWatcher and host on the session bus (GLib, since PySide6 here has no QtDBus); `tray.py` passes its items to the bar and the bar's presses back. Left press activates (or opens the menu of an item that is only a menu), middle is the second action, right is the item's dbusmenu in a popup under it. Settings, Bar turns it off or puts single icons away, by application id. |
| Charging | **The battery's own** `charge_types` and start/stop limits in sysfs, set from Settings, Power, Charging, whether or not Talaris manages power. Root's files, so `systemd/90-talaris-battery.rules` (installed once, with sudo) makes them writable by `users`. |
| Polkit agent | **`hyprpolkitagent`**, started by `talaris.conf`. Without it password prompts quietly stop appearing. |
| Notifications | **Talaris's own** (`notifications.py`, `notifyd.py`) since 2026-10-24: it stops `mako` and holds the bus; `mako`, still installed and D-Bus-activated, answers whenever Talaris is not running. |
| Wallpaper | **`hyprpaper`**, started by `talaris.conf`; `install.sh` writes its file once when `TALARIS_WALLPAPER` names a picture; Settings, Look, Wallpaper (`wallpaper.py`) reads that file, and a picture or fit chosen there rewrites it and restarts hyprpaper. |
| Network and Bluetooth settings | `nmtui`, `bluetoothctl`, opened from the bar. |

## Morgan

A voice-and-chat assistant: wake word, speech in and out, a local model for the
talking, Claude ("the Oracle") when that is not enough, memory, reminders, MCP
tools. Its daemon is `heymorgan.service`, it answers on
`$XDG_RUNTIME_DIR/heymorgan.sock` with commands (`toggle`, `ask`, `say`,
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

**Talaris always talks to the Morgan on this machine** (decided 2026-10-23).
Out of the box that Morgan is in its **local** role — brain, ears and voice all
here. Moving the brain to the home server later is one setting, *Morgan's home*
in Connections: Morgan becomes a **client**, which already means a
`~/.config/heymorgan/client.json` naming the server and Morgan forwarding to it
from the same local socket. So Talaris never needs to know where the brain is,
and is built and tested against a local Morgan from the first day. The DIY Echo
Dot is another client of the same home, with no Talaris on it at all.

**What lives where.** Morgan's repository keeps everything that is not a
screen — the brain, its roles, speech, memory, connections, and the Echo build.
Talaris keeps Morgan's face. Between them is **Morgan's client protocol** —
commands, the event stream, the admin calls — written down and versioned in
Morgan's repository, as `pkm-interchange` is for Hermes, so the two can change
independently and a mismatch is reported rather than half-working. Out of the
box, typed conversation works at once; voice's models (about 820 MB today) are
fetched the first time voice is turned on, with progress shown.

**Before Talaris depends on it, in Morgan's repository:** rename it Morgan (the
repository, the command, the unit); give it a license — it is public with none,
which means nobody may legally use it — matching Talaris's GPL-3.0-only and
contributor agreement; and write the client protocol down.

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

**Renamed, 2026-10-23:** Morgan's repository, command, unit, socket and folders are all `heymorgan` now; the old `heyclaude` names still answer.

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

**Hermes plugin ideas**, kept as they come:

- **Sync daily notes.** A project's `Writing/Daily/<date>.md` and Hermes' daily
  note for that date kept as one. The format already says how — a note
  identified by a date is a closed entry in `pkm-interchange/LIMITS.md` — so
  this is a plugin speaking the spec, not a format change. Which side wins when
  both changed is the question to answer first.

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

### The protocol

Decided 2026-10-23.

- **A plugin speaks MCP, and Talaris is its client**, over the plugin's standard
  input and output. MCP already says most of what is needed — a plugin's
  **tools** are its verbs, its **resources** are the things it can show, and
  **notifications** say when they change — and has toolkits in every common
  language. **Talaris adds an extension** for what MCP has no words for:
  launcher results, canvas item kinds, bar items, a Settings page, and desktop
  events (the current project changed, a card opened). It is negotiated at
  start-up, in MCP's own capabilities.
- **A plugin acts on the desktop through the verbs** — the same ones a click
  uses — over the same connection. No private door.
- **Morgan gets plugin verbs without wiring.** Talaris already serves Morgan an
  MCP; a plugin's tools pass through it, so installing the Hermes plugin is
  enough for Morgan to make a block.
- **Talaris starts and supervises plugins.** A crash restarts it with a
  growing delay; disabling stops it; one rarely needed can start on first use.
- **Each plugin has a manifest**, `plugin.toml`: its id, name, version, the
  command that starts it, **what it contributes**, and **what it may ask of
  Talaris**. Talaris reads it without running the plugin, so what a plugin does
  is shown before it is enabled.
- **Installing is a folder** in `~/.local/share/talaris/plugins/`, copied in or
  cloned from a git address. A catalog can come when there are plugins to list.
  A paid plugin handles its own license key.
- **A backup carries a plugin's own part** (`[backup]` in its manifest,
  2026-10-25): its settings, whether it was on, and the files it names in the
  state folder Talaris hands it (`TALARIS_PLUGIN_STATE`). Never a secret: those
  stay in this machine's keyring, and reviving says which to type again. A
  plugin not installed when a backup is revived finds its part waiting when it
  is.

### How a plugin's things look

**Both ways, from the start.** A plugin can **describe** an item — title, icon,
fields, status, actions — and Talaris draws it in the theme, which is the right
choice for most things and costs the plugin nothing in looks. Or it can supply
**its own page**, for anything a description cannot say: Talaris hosts it in a
sandboxed frame, hands it the theme (the grays, the accent, the typeface, the
motion setting, light or dark) and a narrow message bridge to the plugin's
process, and nothing else. The same two ways serve a Settings page.

**Every placed item keeps a last-known picture** — title, icon, fields — so an
item whose plugin is missing or stopped is an honest placeholder, never a blank
box.

### Trust

**A plugin is a program running as you**, like any application you install.
Talaris controls what a plugin may *ask of Talaris* — read what is current, act
through verbs, put something on the bar — and shows that before it is enabled.
It cannot stop a plugin reading your files or using the network, and does not
pretend to. Real confinement (the kind Flatpak gives) is a later option.

### Plugins are not connections

**An existing MCP server is not a plugin.** Plugins extend the *desktop* — they
put things on the screen. MCP servers are among the **connections** — things
Morgan reaches out to (see *Connections*). Two separate lists in Settings, two
separate ideas.

One rule is fixed: **what Talaris does not understand on a canvas, it must not
destroy** — an item from a missing plugin is kept and shown as a placeholder,
never dropped.

## Connections

**Where Morgan (and the desktop) reach out to.** A page of its own in Settings,
separate from plugins. Decided 2026-10-23:

| | |
|---|---|
| **Model server** | Morgan's own voice: an address and port — this machine or another on the network (today's is `192.168.0.244:11434`). Ollama, or anything that speaks the common OpenAI-style API (llama.cpp's server, LM Studio, vLLM and the like). Talaris asks the server what models it has and offers them, rather than making you type a name. The embedding model Morgan's memory uses is chosen here too. |
| **Oracle** | Claude, for what the model server cannot do. **By sign-in** — your Claude subscription, through the `claude` command's own login, so there are no per-token charges — **or by API key**. |

**At least one of the two is required, and either can be the only one.** With
both, the model server talks and the Oracle is consulted, as now. **With only
the Oracle, the Oracle is Morgan's voice** — every turn goes to Claude. That
works, with three costs worth saying in Settings: every word leaves the machine;
a voice assistant makes many small turns, which a subscription's usage limits
feel sooner than a typed chat does, and an API key pays for each; and Claude
offers no embedding model, so Morgan's memory search needs one from somewhere
else (a small model server, or another provider) or does without. Morgan is
built around a local voice today, so this mode is a change to Morgan, not only
to its settings.
| **MCP servers** | The tools Morgan can use: Hermes Notes' MCP and anything like it, local or remote, each with what Morgan may do there (read, or read and write). |

**Proposed, not yet agreed:**

| | |
|---|---|
| **Speech** | Speech-to-text and text-to-speech run on this machine today; Morgan's server-and-satellites plan moves them to the AI server over HTTP. That makes them endpoints like the model: local by default, a server by choice. |
| **Morgan's home** | Where Morgan's brain runs — this machine, or the home server once that plan is built. The one connection that decides where all the others are kept. |

**Morgan owns these; Talaris is their page.** Morgan's daemon holds its
connections, and when its brain moves to the home server they move with it.
Talaris's Connections page reads and writes them through Morgan's own socket
(`heymorgan admin`), so there is never a second copy. **Keys and tokens go in
the login keyring**, not in a file — Morgan's `config.json` holds MCP keys in
plain text today, which is the thing to fix on the way.

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

## Data

Decided 2026-10-23:

- **Talaris starts clean.** Nothing is imported from Talaria — not its Home
  canvas, not its writing.
- **Writing is pages.** A project's writing surface is a set of pages, listed in
  its drawer, not one running document. Each page is a Markdown file.
- **Canvases and pages are versioned.** You can go back to an earlier state of
  either, without a backup and without git.
- **Plain files, no database** — for what a project holds. JSON for projects
  and canvases, Markdown for pages. One writer — the core — and every write
  goes to a temporary file renamed into place, so a crash never leaves half a
  canvas. Any search index is a rebuildable cache, never the source of truth.
  *Entities* (below) are the one exception, kept centrally and encrypted.

### A project is a folder

**Every project is a real, visible folder**, because other applications save
into it too — a document from LibreOffice belongs in the project as much as a
canvas does. By default they live under **`~/Projects`**; the root is a
setting, and changing it **migrates** the projects there (pointing it at
`~/Nextcloud/Projects`, say, syncs every project across machines with nothing
else to do).

```
~/Projects/Ogham/
  Writing/              the writing drawer's pages, as Markdown
    Camp rules.md
    Camp rules/         a page's children live in a folder of its name
      Hourly rolls.md
  …                     anything you or your applications save here
  .talaris/             hidden: canvas, project settings, card snapshots, versions
```

- **Everything visible is yours.** Talaris's machinery stays in `.talaris/`, so
  the folder looks like any other in a file manager, and moving, backing up or
  syncing it carries everything.
- **Home is a project like the others**, at `~/Projects/Home`.
- **A project can adopt an existing folder** — `~/Documents/Scripts/ogham`
  rather than a new one. In a git repository, `.talaris/` goes into the
  repository's own `.git/info/exclude`: local, never committed, never in anyone
  else's checkout.
- **Versions** live in `.talaris/versions/`, saved as you work and thinned with
  age — close together recently, sparser further back. Plain copies, not git,
  so they are easy to see and restore.

### Archiving a project

Decided and built 2026-10-25. **Archived is out of every context**, and
browsed on purpose. Its folder moves to `<projects>/Archived/<year>/<folder>`
(one adopted from elsewhere stays put, marked), so a file manager can browse
it; nothing points at a folder, so nothing breaks. It leaves the switcher, the
bar, the launcher's results, `@`, Bring in, Glance, Tasks' lists and pickers,
and Morgan's "what is current": the project's entity, the entities standing
for its pages, canvases and notes, and the tasks filed only under it are
archived *with* it (`talaris:archivedWith`), so every search that leaves out
the archived leaves them out too, and bringing it back brings back exactly
those. A person's or an event's links into it are kept, folded under "In
archived projects". It is read, never written, until it is brought back.

**The archive browser** (`archive_panel.py`), from the bar's project menu or
the launcher ("Archive", or `archive <words>` to search it), lists archived
projects by year and month; one opens to read its pages, its canvases' words,
its files in their applications. Morgan searches it only when asked about old
work (`talaris_archive_search`). Archiving is Tasks' project sheet, or
`talaris_archive_project`.

**Bringing one back** puts the folder where it was. When a project in use has
its name, the person chooses: keep both (it comes back "Name (2)"), or merge —
its pages, canvases, files and tasks folded into the one in use, every page or
file both have decided one by one (keep the one in use, the archived one, or
both), and whatever is not kept set aside in `.talaris/merged-away/`, never
deleted.

### Writing pages nest

**Pages are Markdown files in `Writing/`, and they nest** — shown in the drawer
as a tree that expands and collapses. On disk a page's children live in a
folder named after it, beside it (`Camp rules.md` and `Camp rules/`), so the
structure reads the same in a file manager as in the drawer. Renaming or moving
a page renames or moves its folder with it.

The file system has no order, so **sibling order is Talaris's**, kept in
`.talaris/`; a page that appears from outside — written by another app, synced
in — is listed, at the end, rather than ignored. Which branches are expanded is
a viewer's state, in `~/.local/state/talaris/`, not the project's.

### Canvases nest too

Decided 2026-10-23. **A project's canvas is a tree, like its pages.** The
project has one top canvas; any canvas can have child canvases, and any of them
can link to a canvas in another project.

- **A child canvas sits on its parent as a card**, made with it, and opening the
  card opens the child *out of it* — the same rule as every other card. The
  drawer's header says where you are (`OGHAM / CANVAS / CAMP`), each part of it
  a step back up; Escape is one step.
- **Each canvas has exactly one parent, and any number of links.** Anywhere
  else it is wanted, it is a **link card** — in this project or another, as many
  as you like. *Stage 3* lives under *X Project*'s canvas, and Home can carry a
  link to it beside every other place that does. The parent decides only where
  the canvas lives (its project, its place in the tree, what deleting it means);
  a link card and the parent's card open it the same way, and differ on the
  canvas only by a small link mark. Opening a link to another
  project's canvas is `go` to that project, then open that canvas. One parent
  keeps "where does this live" answerable; links keep it from being limiting.
- **A canvas shows where it is linked from** — a quiet line in its header
  (`↖ 2 LINKS`) that lists them and goes to any. The core knows every link
  already; this only says so.
- **The drawer can show the tree**, expanding and collapsing, as the writing
  drawer does.
- **Removing a child's card from its parent does not delete the child** — it
  asks. Deleting a canvas is its own act, with its own confirmation, and it is
  in the versions afterwards.
- **A link whose canvas has gone** — deleted, or its project removed — stays on
  the canvas as a placeholder saying what it pointed to, never silently
  dropped. The same rule as a missing plugin's item.

On disk each canvas is its own file in `.talaris/canvases/`, its parent named
inside it, and each is versioned on its own.

### The editor

Decided 2026-10-23. **Pages are edited in CodeMirror 6 with live preview**, as
Obsidian does it: one continuous editor in which formatting renders in place as
you type, and only the Markdown right around the cursor shows — block marks
(`#`, `>`, bullets, task boxes, rules) on the cursor's line, inline marks
(`**`, `_`, backticks, a link's address) only in the span the cursor touches.
**The document is the file at every moment**: live preview changes how the
text looks, never the text, so nothing is converted and nothing can be lost.
Raw is the same editor with the preview off; Preview is read-only rendering.
A rendered link opens on a click, in the browser.

**Lists are things to handle, not just text** (2026-10-23):

- **Task boxes are drawn**, in the theme — never the engine's white square —
  and stay drawn while you type on their line; a click ticks `[ ]` ↔ `[x]`
  without moving the cursor. Only a cursor inside the brackets shows them raw.
- **A task with tasks under it counts the branch** — `2/5` at the end of its
  line, every depth, in the accent once all are done. Still there when folded.
- **Tab and Shift+Tab nest and un-nest** a list item by its marker's width (two
  spaces under `-`, three under `1.`), which is what Markdown needs for the
  nesting to count; elsewhere they indent the line.
- **Any item with items under it collapses**, from a chevron in the margin, as
  do headings with their sections. Folding changes the view, never the file.
- **Every list item can be dragged** by the grip in its margin. It moves with
  everything nested under it, among its own siblings; the spacing between items
  stays where it is, and a numbered list renumbers from where it started.

### Daily notes

Decided 2026-10-23. **A daily note is a page at `Writing/Daily/<YYYY-MM-DD>.md`**
— the same editor, the same versions, never a second kind of document. The
writing drawer shows a **Daily** section above the pages, with a month
calendar: each day that has a note shows how many words it holds (a number, not
a dot), today is outlined, and ◂ TODAY ▸ step through days. A day becomes a
note only once something is written, so opening an empty day makes no file.
**Only Home keeps daily notes.**

**Three sets of notes, a tab each** at the top of the writing drawer (decided
2026-10-25): **Project** — this project's own pages; **Unaffiliated** (called
Undated at first, and still `undated` in the code) — notes of no
project, the same from every project, kept in `~/Projects/Notes` (the core's
`notes`, so every page call works on them unchanged); **Daily** — Home's daily
notes, editable from any project and said plainly to be Home's there. A page
(with everything beneath it) moves or is copied between Project and Unaffiliated,
either way; a daily note is never moved or copied.

### Starting a file in a project

**"New …" comes from `~/Templates`**, the folder file managers already use for
the same thing: each file there is a choice, named after the file. Adding a kind
of document is dropping a file in that folder; Talaris puts a few there on first
run (a Markdown note, a text file, a blank LibreOffice document, spreadsheet and
presentation). **Which application opens it is the system's default** for that
type, not a Talaris mapping. So `new <template>` is one verb: copy it into the
project, name it, open it. From the launcher ("new spr…") or the canvas's tool
strip, where it lands as a card where you were.

**Applications started the ordinary way are caught three ways**, because Linux
has no single "default save folder" every application obeys:

1. They are **launched in the project folder** — terminals, editors and
   command-line tools honor that, and some others.
2. The **current project sits at the top of the Save dialog's sidebar**, through
   the GTK bookmarks most applications' dialogs read.
3. **"File it here"**: a file saved outside the project while you are working in
   it gets a quiet offer to move it in, read from the system's recently-used
   list.

### Files (designed and built 2026-10-25)

**A panel for the files of projects**, opened from the bar's left side like the
canvas and writing, with the panels' motion, and a window by its expand corners
like them. It is not a file manager. Copying folders around, previews, mounting
drives and the rest are the system's file manager's, one press away ("Open in
Files", the default for folders, at the folder in view). What it does that a
file manager cannot is know projects, tags, tasks and what Talaris holds.

**Limited to projects, listing everything in them.** Every file in every
project's folder, Home's included; never the rest of the home folder.
Talaris's own `.talaris/` and dot-files are left out, and in a git repository
what `.gitignore` ignores is left out too (a `node_modules` would bury the
rest), with "Show ignored" to see it. Beside the files on disk, it lists what
Talaris holds for a project that is not a file in its folder: shortcuts,
task attachments linked from elsewhere, and snapshots.

**Every row says what it is.** One file can be several of these at once, and
the row says all of them ("In the folder · on 2 tasks"):

| Status | What it is | On disk in the project? |
|---|---|---|
| **In the folder** | A real file in the project's folder or below it. | Yes |
| **Shortcut** | A file elsewhere in the home folder, brought in by a Talaris record and nothing else. No symlink is made, so other applications, backups, sync and git never see it. It shows ↗ and where it lives. | No |
| **Linked on a task** | A task's linked attachment whose file is outside the project. It shows ↗, the task, and where the file lives. A linked file *inside* the folder is just In the folder, on that task. | No |
| **Snapshot** | A copy Talaris keeps in its store, on a task or arrived from Hermes Notes (marked as from there, `hermes-sync:origin`). No file anywhere, until saved into the folder. | No |
| **Missing** | A shortcut or a link whose file has gone. Restored from a snapshot where one is held (`restoreLinks`); otherwise said, and kept until removed. | No |

A task's attachments belong to its project, or to Home's when it has none.

**What a row can do follows from what it is.**

- **In the folder:** open, rename, move to another folder or another project,
  tag, pin to the dock, attach to a task, delete. Delete goes to the trash
  (`gio trash`), never removes the file outright.
- **Shortcut:** open where it lives, tag, pin, attach to a task, "Move it in"
  (below), remove the shortcut (never the file).
- **Linked on a task:** open, show the task, make a snapshot of it (`toSnapshot`).
- **Snapshot:** open a read-only copy, "Save into the project" (written into
  the folder and linked, `toLink`), show the task, export elsewhere.

Renaming and moving inside Talaris keeps Talaris's own references in step:
task links, page entities, tags, dock pins. Nothing outside Talaris (an
application's recent files) follows, and the confirmation says so.

**Bringing a file in from elsewhere** is by dropping it on the panel or
"Bring in…", and is a **shortcut** unless asked otherwise. **Moving** it in
asks first, with the actual warnings rather than one "are you sure":

- **Open in an application now** (read from its open files, as the dock does).
- **Synced or in a repository** (Nextcloud, git): moving it out looks like a
  delete there.
- **Another drive:** really a copy then a delete. The copy is checked by its
  hash before the original goes.
- **A file of that name already in the folder:** offered a new name, never
  written over.
- **Referred to elsewhere:** other shortcuts or links to it are moved with it.
  Anything outside Talaris is not.

**Tags** on a file are kept on an entity that stands for it, as a page's are
(`tags.ts`), known by a `file` source of `<project>/<path>` and carried along
when Talaris renames or moves it. Tagged files then join everything tags reach:
the canvas, the launcher, Morgan, `tagged`.

**Ways of looking:**
- **By project:** the folder tree, the current project's first; or all projects.
- **By type:** documents, spreadsheets, presentations, PDFs, images, audio and
  video, code, other. Read from the file's type, not its extension alone.
- **By date:** changed today, this week, this month, earlier.
- **By name:** search as you type, across projects.
- **Filters:** by tag, status, type and date, combined. A filter can be kept
  as a list in the sidebar, as Tasks keeps its lists.

**Decided as it was built:**
- **Watched** (`files.ts`): a watcher per listed folder, never into what is
  not listed (`.talaris/`, dot-folders, what git ignores), so a
  `node_modules` costs nothing. A project with more than 4,000 folders is read
  when asked instead, and the panel says which.
- **Morgan** finds files (`talaris_files`), tags them, and makes shortcuts.
  Moving a file in is never Morgan's: it is done in the panel, which shows
  what it would disturb first.
- **Kept views** are the page's own, in its local storage, for now.

### Search by meaning (built 2026-10-25)

**What is written, found by what it is about** — "notes on distributed
practice" finds the page about spiraling — beside, never instead of, finding
by words. In the launcher, below what matched the words (marked "By meaning",
with the passage that matched); and for Morgan (`talaris_search_meaning`).

- **What is embedded:** every writing page — each project's, the unaffiliated
  notes, Home's daily notes — in passages of a few paragraphs, each led by its
  page's title; tasks, people, projects and events, as what they write (not
  their statuses, choices or dates, which make all of a kind alike); and
  **files, by their contents** (2026-10-26) — a project folder's and those on
  things — read by `filetext.ts` with what is on the machine: `pdftotext`
  (a scan's pages through `tesseract`), LibreOffice headless with a profile of
  its own (documents to text, sheets to CSV, slides to PDF), `tesseract` for
  pictures, and kept only if what it read is words. What was read is kept
  sealed (`filetext.sealed`) and read again only when the file changes.
  Every file is read again as it changes: a folder's as Files watches it; a
  page by when it was written; a file linked from elsewhere looked at each
  minute (its new contents' hash, which a sync also carries); and a folder
  linked whole (Files, Add from elsewhere, A folder) is remembered and looked
  at each minute for files new in it, which are linked too.
- **When files are read is a setting** (Settings, Data, Reading files): as
  they change (the default), while idle — five minutes away, told by
  Talaris's hypridle, or the screen locked — once a day at a time, or only
  when Scan now is pressed. Pages, tasks and people are read as they change
  whatever it says. The panel says how many files are read, have no words, or
  wait, and while it reads, which one and how far through.
- **By a model server** — Morgan's, unless Settings, Data says another (Ollama's
  `/api/embed`, or the OpenAI-style `/v1/embeddings`). Off until it is turned
  on there, and nothing goes anywhere while it is off.
- **Kept sealed** with the store's key (`meaning.sealed`, beside the entities):
  a vector says something about what it was made from.
- **Kept current by looking**, every few minutes, in the background: a page by
  when it was written, a thing by its version, and only what changed is sent
  again. Another model starts the index again.
- **Not yet:** a smart list's "meaning" condition (*Lists*, above); audio and
  video.

## Tasks

Decided 2026-10-23. **Talaris gets its own task system, copying Hermes Notes'
feature for feature** — not a lighter cousin of it, and not Hermes reached
through a plugin. Tasks belong to projects, live in the project's own files
like everything else, and work with no library connected at all.

**What "feature for feature" means is read from Hermes, not remembered.** Before
any of it is built, Hermes' task model is walked through in its own code and
docs (`jpmoo/hermesnotes`: the block data model in
`docs/hermes-notes-v2-design-doc.md`, the task profile, recurrence, completion
and its side effects, and the views that show tasks) and written down here as
the list to match. Two of Hermes' rules come across as they are: completion is
read from a status and the values that count as complete, never from a name;
and completing a recurring task stamps the time and spawns the next occurrence.

**A plugin syncs projects and tasks through the spec.** The same
`pkm-interchange` the Hermes plugin speaks, so a Talaris project can be a Hermes
project and its tasks the same tasks on both sides. The task system is built so
that sync has a clean seam: Talaris's own task shapes map onto the format's
task profile, and nothing Talaris stores is lost on the way out or back.

**Things become tasks** (noted 2026-10-23, for when tasks are built): a note
or card on a canvas, and a checkbox item in a page, can each be turned into a
task — kept where it was, now linked to the task it became, so ticking one
ticks the other.

**Where tasks are shown** (decided 2026-10-24): **the Tasks panel**, from the
bar's Tasks button, a panel like the rest that expands into a window. Its left
column lists **projects** and **lists** (saved queries); the right shows what
is chosen. Cards on a canvas and checkboxes in a page come later, through the
entity graph.

### The list to match (read from Hermes' code, 2026-10-24)

What Hermes does, with Hermes' own bugs named so they are not copied. Tasks and
projects are entities (DESIGN, *Entities*); lists are interchange
**collections**, which the entity store now has to carry — the format's
`collections`, `placement` and `series` features, measured, not claimed.

**A task** — its type's fields, all renameable, extensible by the user:
- `title`; `description` (the body, Markdown); `schedule`, a datespan read as
  **Available** (start) and **Due** (end), each a date or a date and time, no
  zone (wall-clock); `status`; `recurrence`; `project`, a `reference`, many.
- Status options, Hermes' own so a sync maps one to one: not started, in
  progress, blocked, **done**, **archived**, **won't do** — the last three
  complete. Each with an icon and a color. New tasks take the default (not
  started).
- Tags. `#tag` typed in a field adds the tag.
- No priority field, as in Hermes; importance is where a task sits on a board
  (below).

**Completing** — read from status and its complete values, never a name:
- stamps `done_at`; leaving complete clears it;
- a recurring task spawns its next occurrence. **Not copied from Hermes:**
  un-completing and completing again spawned a second next occurrence; here a
  completion that already spawned one does not spawn again. And the new
  occurrence joins its series at once (Hermes left it out, so "end after N"
  never ended).
- Done tasks archive themselves after a set number of days (Settings), and can
  all be archived at once. Archive is reversible; delete is for the archived.

**Recurrence** — a series, as the format has it:
- from the **scheduled** date or from **completion**; daily, weekly (on chosen
  weekdays), monthly, yearly; every N; a month too short for its day clamps to
  its last day or is skipped; ends never, after N, or on a date.
- The next occurrence copies the task (title, body, projects, custom fields),
  resets its status, moves its dates — the whole span shifted (scheduled), or
  due from the completion day with the available-to-due gap kept (completion).
- Written in a small editor like Hermes' (complete from, frequency, every N,
  weekdays, short months, end); summarized in a line on the task.

**Dates** — overdue is a date-only due before today (a time: before now), and
only for an open task. Quick shifts in the date picker: today, +1 day, +1
week, next weekday, clear the time.

**Projects** — an entity with a title and description; a project page lists
what references it, grouped by kind. Archiving a project hides it from the
list. Unknown project names given when making a task make the project.

**Lists (collections)** — the core of the panel:
- **Manual** (explicit members, dragged into order) or **smart** (a query);
  a smart list is **dynamic** (re-run on every look, read-only order) or a
  **snapshot** (filled now, then edited by hand until refreshed).
- **The query**: groups of **all/any**, nested without limit; conditions on
  kind (a type, or not), created/edited before/after, tag (has/lacks), any
  field (is, is not, contains, before/after, empty, not empty — a datespan's
  start and end separately), text, attachments, and **meaning** (semantic,
  with a threshold — through the local embeddings, DESIGN *Entities*).
  Relative dates: today, today±N, now. A live count of matches as you build.
- **Sorting**: manual, or by fields, several levels (title, created, edited,
  kind, any field); empties last. **Grouping** by kind or any field, groups
  folding, in the field's option order.
- **Views of a list**: **list** (plain, numbered, checklist — a checkbox that
  is the task's status — or full cards), **table** (columns of fields, sort by
  header, widths, inline editing), **board** (columns are a status field's
  options; dropping a card sets it), **matrix** (a grid of named, colored
  regions up to 6×6 — an Eisenhower matrix is a 2×2 — where entering a region
  can add a tag or set a status), and **calendar** (tasks on their dates).
  Day columns (a matrix by date) and rollups (projects → their tasks, nested)
  come after.
- Starting lists, editable like any: **Today** (due today or overdue, open),
  **Upcoming** (due in the next 7 days), **Available** (available now, not
  done), **Unscheduled**, **Done recently**. Hermes has these only as Morgan's
  filters; here they are lists.

**Morgan** reaches all of it through the MCP server: find tasks by status,
when (overdue, today, this week, available, unscheduled), project, tag, list
and region; create, update, complete, archive; projects with their counts.

**Built in this order:** the task and project model with completion and
recurrence; the panel with projects and lists; the query builder; list and
table views; board and matrix; calendar; then the rest.

## Entities

Decided 2026-10-24. Some things have standing of their own: **people, notes,
projects, tasks and events.** They are linked, annotated and asked about —
"who was at that meeting", "what do I have on this person" — from anywhere:
a canvas, a page, the calendar, Morgan. That reverses two earlier rules, on
purpose: *plain files, no database* now holds for a project's own files only,
and *Talaris keeps furniture; plugins keep knowledge* now reads *plugins sync
knowledge* — Talaris keeps its own, and a plugin (Hermes first) syncs it.

**The shape is `pkm-interchange`, not something like it.** Every entity is an
interchange object; its kind is its type's profile (`contact`, `event`,
`task`, `note`, `journal`), never its type's name; links are declared
`reference` fields where a type declares them and `relations` where nobody
did (`via: "edge"` for a line drawn on a canvas, `via: "inline"` for one
written in a page); a name written before its thing exists is a **stub**;
files and apps are **attachments**. Talaris's own keys go under `talaris:`.
**A project is an entity like any other** — the format has no project profile
and needs none: a task's `project` field is a `reference` (`many`, so a task
can belong to two), and "what is in this project" is what references it. What
makes one a Talaris project — its folder, its workspace — is `talaris:` keys.

**Compliance is measured, not claimed.** The core exports an envelope
(`stableIds: true`) that `pkm-interchange/check` scores, and imports one back;
the tests run the format's fixtures and a round trip, as Hermes' build does.
The core's reading of the format is its own — not Hermes' code — because two
independent implementations is what makes the format prove anything. Syncing
with Hermes is then a plugin's job and needs nothing special here: a Talaris
entity that is also a Hermes object carries the Hermes id under `hermes:`.

**An entity is made the first time something needs to point at it.** Not every
doodle is an object (the format's own known limit: *a canvas holds things that
are not objects*):

- **Events** are mirrored from the calendars as the calendar loads them, one
  entity per event (a recurring one as its series), refreshed when the
  calendar changes. The calendar service stays their owner: Talaris keeps what
  it adds — links, notes — beside what it mirrors.
- **People** are made when they first matter: an invitee or organizer of a
  mirrored event (matched by email to the address books, then to people
  already known), or someone linked or mentioned. **An event's invitees are
  people it references** (`attendees`, `organizer`), so "everyone connected to
  this event" is a lookup, not a search.
- **A canvas note** becomes an entity when it is made one — *this note is an
  event*, *this is a person* — or linked to one. Its card keeps the entity's
  id; it is the entity shown on that canvas, as many canvases as like.
  Shapes and scribbles stay furniture.
- **Pages** are notes by their path, the file still the source of their text;
  the core keeps the id with the page through renames and moves.
- **Apps and files are attachments** on an entity: an app's opening rules as a
  JSON attachment of Talaris's own media type, its picture as another. The
  hash is the identity, so a file attached twice is stored once.

### Where entities live, and encryption

- **Centrally**, in `~/.local/share/talaris/entities/`: one sealed file per
  entity (with the links going out of it), one per attached file, kept by its
  hash. The index — by kind, by source, by who points at what — is built in
  memory at start and is a cache. Plain files rather than a database engine:
  no native module to break on a Node upgrade, and the same one-writer,
  rename-into-place rule as everything else.
- **Everything stored is encrypted** — AES-256-GCM, with a key in the login
  keyring. **A key is never made over existing data**: a keyring that is locked
  or not up yet is a failure to try again, not an empty one (Morgan lost its
  history to exactly that, 21 October 2026). The store's key is also kept
  *wrapped to the recovery key*, so a lost keyring is not lost data.
- **The recovery key** is made with the store and shown once, in Settings →
  Data, until it is said to be kept. It is the private half of a key pair:
  Talaris keeps only the public half, which is enough to seal backups and the
  wrapped key, and never enough to open them. It can be replaced (new backups
  use the new one; old ones still need the old).
- **A project can be encrypted** (Settings → Data). Its pages, canvases and
  versions are then sealed on disk with the store's key — readable through
  Talaris, gibberish to any other application, so it is a choice per project
  and not the default: a project is a folder other applications save into, and
  those files are theirs and are not sealed. The disk itself is better
  protected by full-disk encryption, which this machine does not have.

### Backups

A **backup is an interchange export, sealed to the recovery key**: the
envelope, the files, the wrapped store key, written to a folder chosen in
Settings → Data, on a schedule (daily or weekly), keeping as many as asked.
Each is checked against the format as it is written, and the page says when
the last one ran and whether it passed. **Reviving** one asks for the recovery
key, shows what it holds, keeps the current store as a backup first, and then
imports — the same import as any other, so every revival is also a test that
the round trip loses nothing. Project folders are not in it: they are folders,
for whatever already backs up folders.

### Pages, not notes (2026-10-26)

**What is written is a page, everywhere it is named.** A project's pages, the
unaffiliated pages (of no project), Home's daily pages; New makes a page;
Glance, the cards and the launcher group and label them as pages, whatever
kind of thing stands for them underneath (`note` stays the format's profile
name, and the unaffiliated pages' place is still `notes` on disk and in the
API). Morgan is told the user may say "note" and means a page, and a note it
is asked to make is an unaffiliated page. Hermes Notes' own word is kept when
its side is meant. Still called notes, being something else: a field of notes
on a task, an event or a person; a note card on a canvas; Morgan's memory.

**Connect, one word.** Whatever ties two things — a field, a link, a page
about a person, a file on a task — is a connection, and making one is
connecting: "Connect to Rich Gelson", "Possible connections", "Not
connected", a person's address-book entry connected or disconnected. A page
is connected to what it is about (the writing drawer's "Connect to…"), not
copied there. Only a mention ("Connect “Rich” as a mention") and a merge are
named for what they do besides.

**People, not cards.** An address book's entry is shown as a person, "in your
address books" — likely the same person, no longer in your address books —
never as a card. "Card" is kept for what is placed on a canvas, and for the
Cards style of a list. (In code and the format, a vCard is still a card.)

### Context, Glance on anything, and suggested ties (2026-10-26)

**The launcher is context, not only words.** What was typed finds what holds
its words (`/context`, `context.ts`); and for each thing it names whole
("Rich" names Rich Gelson, not Max Richter) everything tied to it, one step
out both ways, is listed under it — the tasks that mention him, the notes
about him, his meetings — whether or not they say "Rich". Open tasks and what
is coming first, done tasks last. Morgan has the same as `talaris_context`.

**Glance opens on any thing**, not only a project: a person, a task, an event,
a note, a page, a file. Shift+Enter on a launcher result, a Glance button in
a task and a person, or Morgan (`talaris_glance`). Files are tied to the
things they are on, both ways — a folder's, and those only on things (linked
from elsewhere, or kept as a copy).

**Beside it, what the thing at the middle might be tied to and is not**
(`suggest.ts`), each with why and the ways that fit; in the graph, dashed.

- **Found by**: a person's or project's name in its words, not yet a mention
  ("Says “Rich” — one of 2 called that"); a note called by a person's name;
  the same thing twice (one name, one address); closeness in meaning — files
  by their contents among them — with a higher bar for things of few words,
  which are near everything by chance.
- **Ways**: *mention* (the words made a mention, which is a tie and syncs as
  one), *connect* (in the field one kind declares for the other — a note's
  people, a task's project — else a plain link), *attach* (a file put on a
  thing, where it stays), *merge*.
- **Merge is for two of one kind** (`merge.ts`), and only offered where the two
  look like one. The one kept takes what it lacks; whatever pointed at the
  other — a field, a link, a mention in words or a page — points at it; the
  other's id leads to it after. One another app keeps in step is the one kept;
  two such are merged in that app.
- **Nothing is tied unless chosen.** Turned down, a suggestion is not made
  again either way round — until "Reset dismissed" on that thing (Glance, a
  person, a task) offers them all again; a thing can be told to stop suggesting (both kept
  sealed, `suggest.sealed`). Morgan offers them (`talaris_suggestions`) and ties
  or merges only when told (`talaris_tie`, `talaris_merge`); it reads a file's
  words with `talaris_file_read`.

### Demo

A made-up world to show Talaris off — projects with writing and files,
people, tasks in every state (overdue, today, spanning days, repeating,
waiting, done), a matrix, a board, a table and a list, notes, daily notes, and
a week of events — entered from Settings, Data, and kept wholly apart from
the person's own. A mark, `~/.config/talaris/demo`, chooses it; the core
(`demo.ts`, the first module it loads) and `talaris-surfaces` read it as they
start and root every folder in `~/.local/share/talaris-demo` instead: its
own store, under its own key (no keyring, no recovery key), its own Projects
folder, its own settings (copied from the person's the first time, so it
looks the same). Entering, leaving and Reset each change the mark or the
demo's own folders and start Talaris again; nothing of the person's is read
or written meanwhile.

Nothing reaches past it. No plugins run (none is installed there), so no
sync can carry a made-up task into another app; no backups are made; the
calendar shows the demo's own events (`calendar.json`, read by the calendar
process in place of the accounts), and finds no one in the address books;
the launcher does not search Morgan's past conversations, which are the
person's. Its dates count from the day it was made and its events from the
day they are shown (`demo-seed.ts`), so a demo is always of this week.
**Entered, it is always made afresh** (2026-10-26): what was added, tied or
changed in the last demo is gone, so every demo shows Talaris meeting a
world nobody has touched; Reset does the same without leaving. The bar says
DEMO beside the project's name throughout.

**Made to show ties being found** (*Context, Glance on anything, and suggested
ties*): names written plainly in tasks, pages and files ("Call Priya", "Send
Daniel" with two Daniels to choose from); a person entered twice, and one
known by the same address under another name; a task written twice; a page
called by a person's name; pages and tasks of no project plainly about one;
and a PDF, Markdown and text files whose words name people — each of which
Glance and Morgan offer to tie.

**Morgan remembers nothing said in it.** Talaris asks Morgan to hold its
memory (`memory.hold`, heymorgan's protocol 1.6) on each connection and every
half hour, two hours at a time, and lets go out of the demo: no notes,
documents or pictures kept, no tidying, and Morgan says it can't remember
while the demo is on. What it knew before is still there to answer from.
Its conversations are still recorded as they always are.

### Morgan

**Morgan reaches entities through Talaris's MCP server** (`talaris-core mcp`),
not through anything built into Morgan: find an entity, read it with
everything connected to it — the people at an event, the events and notes a
person turns up in, what a project holds — and link or annotate. Running
locally, Morgan adds it like any MCP server. As a client of a server, it needs
one general thing of Morgan's own: **MCP servers kept on the client**, whose
tools the client offers the server and runs when asked, as it already does for
files and sight.

**Any MCP client can use it, which is the point and the risk.** Claude Code,
Claude Desktop, the Oracle's `claude` — anything that speaks MCP on this
machine reads the same graph Morgan does. The store is sealed on disk; this
server hands out what is in it, opened. So it speaks over standard input
only — a client on this machine, started as the user — and its reading tools
and its writing tools are separate, so a client can be given only the first.
Reaching it over the network (MCP over HTTP, with a key) would be a choice made
in Settings, never the default.

### @, and the people it finds

**One `@` for everything**, wherever words are written — a writing page, a
canvas note, a task's title and notes: `[@Name](talaris:e_id)`, mirrored as a
`mentions` relation (`via: inline`) so the graph has it both ways. People come
first among what it finds, and the people it finds are the invitee picker's
too: the address books and everyone in the calendars, by name or the part of
an address before its `@` (not its domain, or "sch" finds a whole school
district). One who is not yet a person here is made on being chosen, by
address — `personFor` — so the same person is never made twice. A mention
clicked opens its card: what it points at and what points at it, in words read
from the far end ("Invited to", "Mentioned in").

### People

**Built (2026-10-24)**: a panel from the bar's People button (`people_panel.py`,
`ui/people.html`). Everyone, grouped by organization or A to Z; the person
chosen drawn from the person type's fields by kind; their picture, files,
links (by kind, newest first); and their contact cards. A tie is a source on
the person (`eds-contact`, "book/uid"); the cards are read from the address
books by the calendar's helper (`calendard.py`, `cards`). Copying a card in
fills only what is empty.


**A person is Talaris's own, and may be tied to contacts.** Made here (New,
an @) a person needs no contact behind them and is no less a person for it.
**Tied by address first:** one with an email is matched to the card in a
contacts account that has it, and kept matched. **One not tied is offered
likely cards** — by name and by address alike, the same organization, the
addresses of the people met with alongside them — to tie to one, or to more
than one, since a person can have a card in each account. Nothing is tied or
merged without being asked. **A switch per person stops the asking**
("don't look for a contact"): they stay a person here, never suggested again.

Known by name; by address only until a name is known (an address book's, or
an invitation's). Calendars' own addresses (Google's shared calendars, rooms)
are nobody, and are never made people (`isPersonAddress`).

### Making, and going

**New** (Super+Shift+N, or the bar's plus) makes a task, an event, a person,
a note or a project from one sheet. A task, a person, a note and a project are
drawn from their types — every field, by its kind, which field is which read
from the profiles — so a field added to a type is offered there too; only one
the core fills itself (`talaris:auto`, a task's `done_at`) is left out. An
event is the calendar's and gets the calendar's form.

**The project carousel**: Super+Tab brings every project up in a ring over
the dimmed screen, most recent first, turned to the one before this — so
Super+Tab and Enter is back where you were. Left and Right (Tab, the wheel,
or Super+Tab again) turn it; letters narrow it to the projects with them
anywhere in the name, still most recent first, and it goes the moment one is
left; Enter or a click goes to the one in front. Wherever a key changed the
project, the on-screen display says which. It replaced the Super+Alt jump
(Super+Alt and a letter, or held while typing), which was slow to reach for;
Super+Alt is no longer bound at all.

**A project is a desktop**: its Hyprland workspace, named by its id, empty
the first time it is gone to. **Home is the ordinary, numbered workspaces**,
and going Home goes back to the last of them. Going to a workspace any other
way (its keys, the dock) makes its project the current one.

**A project may have a wallpaper of its own** (Home too); the rest show the
default, which is hyprpaper's file. Kept in Talaris's config by project, and
shown by asking the running hyprpaper as the project changes. Chosen in
Settings — a strip of the default and every project, each its own picture or
the default's faded — from a project's properties in Tasks, or by a
right-click on the empty desktop, which is a clear surface of Talaris's under
the windows (`desk.py`).

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
| **Core** | Projects, canvases, writing, cards, the verbs, the launcher query, the plugin host, and the MCP Morgan connects to. A user service; the one thing that must be running for anything else to mean something. TypeScript on Node. |
| **Surfaces** | One PySide6 process under `layer-shell`: bar, dock, drawers, launcher, notification popups, OSD, Morgan's popup. Web views through a socket-backed scheme, as Talaria's `scheme.py` worked out. A user service that restarts — a crashed surfaces process is a blank screen. |
| **Windows** | What are ordinary windows — Settings, Morgan's conversation kept open beside work — in a second process, because layer-shell is chosen per process. |
| **Morgan** | `heymorgan.service`, its own repository. |
| **Borrowed** | `hypridle` → `hyprlock`, `hyprpolkitagent`, `mako` for now. |
| **Hyprland config** | `talaris.conf`, written by the installer and `source`d from `hyprland.conf`, which stays the user's: the binds, workspace rules and `exec-once` lines. Taking Noctalia out is deleting its one `exec-once`. |

**Core, separate from the surfaces,** because state must outlive a surface
crash, Morgan and the CLI need it with no screen at all, and plugins' own
processes need something to talk to.

**The core is TypeScript, on Node** (decided 2026-10-23). The reason that
decided it: the canvas is already TypeScript, so the canvas document's types are
written once and used by both the page that draws it and the core that keeps it
— the drift between those two is the likeliest bug a project like this grows.
It also has the official MCP SDK, and Talaria's and Morgan's daemons are both
TypeScript, so their solved problems (socket servers, event streams, a dying
daemon unlinking its successor's socket) come across as patterns. The surfaces
stay Python — a thin PySide6 host around pages that are themselves TypeScript.
Plugins, being separate processes, may be written in anything.

## Spikes before committing

- ~~**A layer surface from PySide6.**~~ **Run** — see below.
- **Several layer surfaces in one process**: drawers, bar with an exclusive zone,
  dock, and the launcher with exclusive keyboard, all at once.
- **A drawer**: filed to an edge as a handle, pulled out over tiled windows, and
  back — the spike's layer swap with a slide instead of a jump.
- **Morgan's page as a surface**: `index.html` on a layer surface, talking to
  `heymorgan.sock` through the host, and a voice turn start to finish.
- **Next-new-window binding** against real Firefox and VS Code.
- **Resume for the web** — the session file first.

### What the layer spike found

The spike — `talaria/linux/spikes/layer_canvas.py` in `jpmoo/hermesnotes`, since
superseded by `surfaces/layershell.py` — ran on Hyprland 0.53.3, Qt 6.10.2 and
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
2. ~~The core, with Home: a canvas and a writing surface.~~ **Done** —
   `packages/core`, served on `$XDG_RUNTIME_DIR/talaris.sock` by
   `talaris-core.service`; projects, nested canvases with links and
   backlinks, nested pages, versions. `packages/model` holds the shared types.
3. ~~The surfaces process as a service: the drawers on an empty desktop and pulled
   out over windows, with every way back.~~ **First pass done** — `surfaces/`,
   `talaris-surfaces.service`, started by `~/.config/hypr/talaris.conf`. The
   canvas and writing drawers, filed as handles, out on an empty workspace,
   pulled over windows (Super+Shift+C, Super+Shift+W), back on the same keys,
   Super+Escape, Escape, or 45 idle seconds. Writing pages are real, and
   the canvas has come across (`packages/canvas`): notes, shapes, connections,
   regions, panning and zooming, child canvases as cards that open on a
   double-click, a trail in the header. Pictures, library blocks and export
   wait for their own steps.
4. The bar and the dock. **The bar's first pass is done** (`surfaces/bar.py`,
   `machine.py`): along the top with its height reserved — under Noctalia's
   while Noctalia runs, since Hyprland stacks reserved space. The launcher's box
   and Morgan's button (lit when `heymorgan.sock` is there) wait for steps 5
   and 6; the project's name in the middle; network and Bluetooth hand off to
   `nmtui` and `bluetoothctl` in the terminal; volume scrolls, and opens a
   slider; battery; clock; the power menu, which asks twice before logging out,
   restarting or shutting down. Menus drop from the bar as a second surface,
   not by the bar growing, which would make it blink. Top or bottom only, for
   now. **The dock's first pass is done** (`surfaces/dock.py`, `apps.py`):
   along the bottom, height reserved, a panel in the middle of the edge. Open
   windows grouped by workspace, the groups set apart by a rule and not
   labeled — one icon per application per group, a dot per window, the
   focused one in the accent. A press goes to the window last used; again, to
   the next. Icons from the `.desktop` files and the GNOME icon theme, drawn by
   Qt and served to the page as `talaris-ui://icon/?n=…`. Special workspaces
   (scratchpads) are left out.
5. The launcher: applications, files, verbs, and Morgan as the fallthrough.
   **Morgan's conversations in the launcher** (asked for and built
   2026-10-23).
   Morgan gains a `search <text>` command (protocol 1.3) ranking past
   exchanges by meaning and by words together; the query is embedded on the
   home server by the Ollama Morgan already uses, never on the laptop, and
   only after a pause in typing and three letters. The launcher's own
   results stay instant and local; Morgan's arrive a moment later as their
   own group, and choosing one opens Morgan's panel at that conversation.
   Offline, the launcher is as it is. Possibly a setting to keep launcher
   queries on the laptop.
   **First pass done** (`surfaces/launcher.py`, `ui/launcher.js`): Super+Space,
   or the bar's box; Morgan's button opens it
   already asking. Projects, open windows, the current project's canvases,
   pages and files, applications, and verbs (the drawers, the power menu's
   five). The process gathers on each open and the page ranks as you type:
   titles only, keywords weakly, letters-in-order only when nothing matches
   better, picks remembered. Enter on a question sends it to Morgan as a
   spoken turn (`say`) until Morgan has a face here. Choosing a project makes
   it current — the bar and drawers follow; workspaces wait for step 9.
   Not yet: a modifier's second action and dragging a result onto a canvas,
   which wait for cards.
6. Morgan's face: the button, the popup, the conversation. **The button and
   the conversation are done** (`surfaces/morgan.py`): the process follows
   Morgan's `watch` stream once, and the bar's button wears its state —
   listening and speaking breathe, thinking turns an arc. The conversation is
   Morgan's own page (`ui/morgan/`, from its application window, nearly as it
   was), hung under the button as an overlay panel, on Super+Shift+M or the
   button; it wears Talaris's theme and the Tabler icon font shipped in
   `ui/fonts` instead of Noctalia's, with no title bar: its state and controls
   sit in a row under the composer, ending in Full screen and Close. It
   comes up as the launcher does: centered over the rest of the screen,
   dimmed, a press on the dim putting it away. The two share a motion and a
   speed in Settings, Look (slide from the top, draw, or none), played by
   `ui/motion.js`, the drawers' own motions made shareable. A pulled drawer
   dims the rest of the screen too ("Dim behind", on by default), through the
   catcher, so a click there puts it away. Both drawers share a height (a
   share of the whole screen) and an alignment, top, center or bottom: full
   height or at the top a drawer lies over the bar, at the bottom over the dock. Full
   screen works as a drawer's expand: the conversation becomes the desktop on
   its own workspace, between the bar and the dock, and a window opened there,
   another workspace gone to, or the button again brings it back (or closes
   it, as "After full screen" says). A question typed into the launcher goes to
   Morgan as a typed turn and opens the conversation. Attachments come through
   `zenity`'s chooser, beside the surface rather than inside it. **The voice popup is done**: for a turn said aloud while the conversation is
   shut, a panel centered under the bar shows who has the floor, a waveform of
   their voice (a light sweeping along it while Morgan thinks), what was asked
   and the answer as it is spoken; it lingers 1.2 s after Morgan goes idle and
   goes at once on `stop`, and never takes the keyboard. Still to do: files
   dropped on the panel. (Morgan's settings page is built: Settings, Morgan.)
7. Settings, the theme, the OSD, the power menu. **First pass done.**
   *Settings* (`surfaces/settings.py`, `config.py`): one panel in the middle of
   the screen — from the launcher, the power menu, or Morgan's own settings
   button — with Appearance (mode, accent from the tuner's five or any hex,
   typeface), Layout (the bar's edge, the dock taking the other; each drawer's
   edge and size; the canvas as desktop; how long before a pulled drawer goes),
   Keys (the launcher's, and the list of Talaris's), and Morgan (name, wake and
   interrupt words, follow-up, known voices only, Kokoro voice with a sample,
   the chat model, the Oracle — through Morgan's own admin calls, saved
   together because some restart it). Talaris's own settings apply the moment
   they change: the process checks the whole configuration, writes only what
   differs from the defaults to `~/.config/talaris/config.json`, and moves only
   what changed. *The OSD* (`osd.py`): the media keys are bound again at
   runtime with the commands `hyprland.conf` gave them plus `--osd <kind>`, and
   bound back on quit. Since: the clock (12 or 24 hours, seconds,
   the date's order or none), motion (slide, draw — the tuner's "chaos",
   its "connect" — or none; the traced-frame draw was dropped, and Draw is
   stored as `chaos`), the space round windows
   and between them (Talaris sets Hyprland's gaps and border colors at
   runtime), and showing by touch — the bar and the dock hide and come out when
   the pointer touches their edge, giving their space back to the windows, and
   a drawer set to touch-to-show has no handle and goes again when the pointer
   leaves (`sensor.py`: a strip two units thick, invisible, along the edge).
   And how things look: each drawer's outline (accent in use, line, none),
   shadow and opacity; the bar's shape (a strip, or floating off the edges by
   a set distance with rounded corners) and opacity; the dock's opacity.
   A pulled drawer holds the keyboard exclusively, so leaving it for a window
   cannot hand that window the keyboard (waking it, and flickering the
   drawer's in-use outline); scrolling still reaches what is under the
   pointer. (Hyprland's follow_mouse 2 was tried first, and kept the pointer
   from reaching Settings until it was clicked.) After a drawer is put away
   with the pointer at its edge, the edge ignores it until it has left.
   Settings is now one page per thing: Look, Bar, Dock, Drawers, Windows,
   Keys, Morgan. The bar and dock each have hiding, a motion out of hiding
   (slide or none), an outline, a shadow and opacity; a floating bar sets the
   gap below it to its own inset, so it and the windows line up. Draw
   plays on a drawer's way out as on its way in.
   **The dock** (`dock.py`) is one row: pinned applications in your order, a
   rule, then what else is open — on this desktop, or all (the setting
   becomes "this project" with projects). Items drag to reorder; right-click
   opens a menu just above the item (a surface placed by layer-shell margins)
   with show, hide, new window, pin, unpin and close. Hiding moves a window to
   a special workspace nobody summons, and its item dims. Icons can magnify
   as the pointer passes, up to double.
   **A drawer expands to the desktop** (its header's button, or
   `--grow <drawer>`): it fills the space between the bar and the dock on the
   bottom layer, on a workspace of its own (`talaris-desk`), empty but for it.
   The windows are not touched — moving them out and back made Hyprland tile
   them again in arrival order, losing the layout — so going back to the
   workspace left finds them exactly as they were. The same button, Escape,
   a window opened (it comes back too), or another desktop make it a drawer
   again; Settings says whether it then stays out or closes. The switch waits
   a moment after the surface is made anew, or the keyboard's return to the
   last window takes Hyprland straight back to that window's workspace. **Click outside to close** is a setting: a
   clear layer over the windows, under the drawer, catches the click.
   Not yet: side edges for the bar and dock,
   drawers sharing an edge as tabs, Morgan's memory, voices heard and
   connections.
8. Remove Noctalia's `exec-once`.

**Milestone two — projects and plugins.**

9. Projects: per-project drawers, workspaces, `go`, the dock and launcher.
10. ~~Talaris's MCP — context and verbs — and Morgan connected to it; Canvas
    Chat's job as tools.~~ **Done** (2026-10-25): `talaris-core mcp` serves,
    beside the entity and task tools, what is on the screen (`talaris_now`:
    the project, the focused window, the other windows here, the panels out,
    the canvas and page the drawers show — no screenshot), the open windows,
    a project's contents, pages and canvases to read, and the verbs: go,
    open (a page, canvas, file, or an entity where it lives), show a panel,
    launch, focus and close a window, write a page, edit a canvas (notes,
    cards, links, child canvases — Canvas Chat's job). The screen and the
    verbs are the surfaces process's (`surfaces/desktop_api.py`), asked over
    its control socket, now `$XDG_RUNTIME_DIR/talaris-surfaces.sock`; the verbs
    go through what a person uses (`Launcher.act`, `go_to_project`). A page or
    canvas changed this way is read again by the drawer showing it, and a
    canvas page holding an older copy has its save refused (`talaris:rev`)
    and reads itself back. Morgan, a client of the home server, runs it on the
    laptop from `client.json` and offers its tools to the server (protocol
    1.4); only the read-only ones unless that entry says `"allow": "all"`.
11. Bookmark cards with three adapters; snapshots; opening out of the card;
    export.
12. Floating, *place*, Recent.
13. The plugin surface, and the Hermes plugin on it. **Begun 2026-10-25,
    around the Hermes sync** (tasks, projects and people, kept in step,
    merged with conflicts put to the person or replaced wholesale one way).
    Done so far: the format says what a person, an event and a project are
    (`pkm-interchange`, *Profiles*; both Hermes and Talaris declare them), and
    **Talaris speaks the live binding** on its socket — `GET /conformance`,
    `GET /interchange` with a cursor (`?since=`, deletions in `changes`, 410
    when the feed cannot answer), `?profile=` and `?q=`, `PUT` and `PATCH
    /interchange/objects/:id` — measured at operate 4 by the format's own
    fixtures (`pnpm --filter @talaris/core measure`) and clean under
    `pkm-check --url`. The change feed is `feed.ts`. Its lists stay in the file
    export; the live binding carries objects. **The plugin host is built**
    (`packages/core/src/plugins.ts`): `plugin.toml` manifests (a TOML reader of
    its own, `toml.ts`), installed from a folder or a git address and never
    enabled by installing, started and supervised (restarted after a crash, a
    second then longer each time, up to five minutes), spoken to over MCP on
    standard input and output, with Talaris's extension offered in
    `experimental.talaris` — the plugin's settings at the handshake, and
    `talaris/settings`, `talaris/interchange` (the live binding, held to the
    manifest's kinds), `talaris/notify` and `talaris/status` as requests back.
    Only tools the manifest names are passed on; they reach Morgan through
    Talaris's MCP as `<id>__<tool>`, with Morgan's Allow, Ask or Off. Settings,
    Plugins shows each before and after enabling. `examples/plugins/hello` is a
    whole plugin with no dependencies; `examples/plugins/README.md` is how to
    write one. **The Hermes sync plugin is built** (`plugins/hermes-sync`, its
    README says how it decides): matching on the first sync with the unsure
    put to the person and the plan confirmed before anything is written;
    merge with conflicts put to the person, or one side winning; deletions
    asked about, never carried; events not synced at all (they are the
    calendars', which each app reads for itself). The host gained
    `talaris/decide` — a plugin's list of things for the person to decide,
    drawn by Talaris in Settings, Plugins, answered back as `talaris/decided`.
14. Pruning.
15. Tasks — Hermes' system, feature for feature — and the plugin that syncs
    projects and tasks through the spec.
16. ~~Talaris's own notifications, replacing `mako`.~~ **Done** (2026-10-24): pop-ups at the top right in the theme — motion, shadow, opacity, outline, a countdown that pauses under the pointer, ×, the app's buttons and Open — set in Settings, Notifications, with applications muted one by one; the bar's bell, with a dot for unread, lists them all. Ubuntu's AppArmor profile keeps `notify-send` from seeing that Talaris has buttons; applications themselves are not so confined.
17. Resume, once the spike says how.
18. **Calendar and contacts** (asked for 2026-10-23). **The calendar's first
    pass is built** (2026-10-24): `calendar_panel.py` and `ui/calendar.html`,
    an overlay up from the bar's date and time (`overlay.py`, shared with
    Morgan's conversation: dim, motion, click away, full screen); day, week
    and month; events made, changed and deleted, a repeating one's one
    occurrence or all; calendars shown or hidden. Its data is Evolution Data
    Server's through `calendard.py`, a child process; the accounts are GNOME
    Online Accounts', listed and switched in Settings, Accounts
    (`accounts.py`), added in that service's own window. People is next, to
    its own spec. The first description: a
    full calendar — day, week and month; events made, edited and moved;
    invitations answered — and contacts, both kept in step with Google and
    Outlook accounts, any number of each, and Apple (iCloud) accounts.
    **Microsoft by Graph**, not EWS, which Microsoft is retiring for Exchange
    Online: Evolution's `evolution-ews` package carries a Microsoft 365 module
    that speaks Graph. **Apple by CalDAV and CardDAV**, with an app-specific
    password from appleid.apple.com — Apple has no other open way in. Google
    by its own API (or CalDAV/CardDAV). The likely road, to be decided: the
    accounts signed in through GNOME Online Accounts and read and written
    through Evolution Data Server, which this machine already runs (no app of
    ours registered with Google or Microsoft; laptop only); to check first,
    that Online Accounts' Microsoft 365 sign-in feeds Evolution's Graph
    calendar and contacts, not only files. The other road is Talaris or Hermes
    signing in itself (an app registered with Google and Microsoft, CalDAV for
    Apple), which reaches every device. Faces to decide: the clock's dropdown for today and
    the month; a full view as a drawer or full screen; contacts in the
    launcher and to Morgan; the to-do list's dated tasks on the calendar.
19. **Clipboard history** (asked for 2026-10-24; not started). What was copied,
    kept and found again: a hotkey, a list over the dimmed screen as project
    jump's is, typed to narrow, Enter to paste. Questions first: text only or
    images too; how long it is kept and where (sealed, as entities are, since
    passwords get copied); leaving out what a password manager marks as
    secret; whether Morgan may read it.

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
