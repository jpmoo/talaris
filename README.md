<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="design/logo/talaris-logo-on-dark.png">
  <img alt="Talaris" src="design/logo/talaris-logo-on-light.png" width="200">
</picture>

**A thinking-space desktop for Hyprland
with a companion AI assistant.**

</div>

---

**What is this?**

"Talaris" is Latin, meaning "of or pertaining to the ankle or heel." It
refers to the magical sandals of Hermes/Mercury, the messenger god.

Talaris is a desktop for Hyprland that rethinks the files/folders/icons paradigm, 
and focuses on helping you work and think. It has built-in note-taking, 
infinite canvas, calendars, contacts, and more, all
linking and referring and speaking to one another across different workspaces
for each of your projects. It also works with Morgan, a companion AI assistant
(via Ollama and/or Claude) that you install and run separately.

***Key features:***
- task management with different kinds of visualizations, including boards/matrices
- a Markdown note-taker supporting wikilinks, tags, file attachments, and more
- a full contacts module
- a "library" app that rethinks the file manager into a place to store and connect all of your stuff
- a full and fully integrated calendar app
- support for plugins
- all of the above is interoperable and integrated with the system, launcher, and one another
- a launcher that finds anything by name or by meaning, and lists (and closes) every open window by project
- Glance: everything in a project, and how it's connected, as a list or a graph
- works with Morgan, a separate AI assistant that does a lot of things (see below)
- workspaces for each project, each with their own dock, wallpaper, notes, and more
- scheduled backups
- integrated clipboard history
- an attempt at a standardized spec/format for PKMS items (tasks, events, etc.) so that you can connect it to other apps
- attractive, minimalist theming with a few interesting animation options

**Important notes**

This is 99% vibe-coded with Claude, primarily Opus 5.5. The other 1% is 
mostly me hitting Copy/Paste and scratching my head on better questions 
to ask.

I'm running and building this in Ubuntu 26.04 and Hyprland on a Dell
XPS 13 laptop. I haven't tested on any other distribution or machine.

Some of this was built to sync with my home-grown notes/Notion/etc. thing,
also vibe-coded. It should work fine without that, though. I've turned that
into a plugin.

Talaris is really meant to be installed alongside
[Morgan](https://github.com/jpmoo/heymorgan), my AI assistant. It runs without
Morgan, but without all of the AI bells and whistles it was designed for.
For now, Morgan is a separate project that you install and run on its own; I
plan to bring Morgan into Talaris itself in the near future.

In other words, taking all of the above into consideration, your mileage
may vary. You're entering the crazy, maze-like brain folds of a dedicated
tinkerer. I mean, I took toasters apart as a kid and usually failed to
put them back together into working things. But Talaris is working for me.

**Media**

<p>
  <img src="docs/screenshots/settings-dock.webp" alt="The desktop: the bar, the dock, and Settings" width="49%">
  <img src="docs/screenshots/tasks-eisenhower.webp" alt="Tasks, as an Eisenhower matrix" width="49%">
</p>

More screenshots: [docs/SCREENSHOTS.md](docs/SCREENSHOTS.md).

**Getting started**

You'll need Hyprland, Node 22 or later, pnpm, and Python 3 with PySide6; the
full list is under What it needs, below.

```bash
git clone https://github.com/jpmoo/talaris.git
cd talaris
./install.sh
```

The installer builds everything, starts Talaris's services, and writes
`~/.config/hypr/talaris.conf`. To turn Talaris on, add this line to the end of
your `hyprland.conf`, then log out and back in:

```
source = ~/.config/hypr/talaris.conf
```

[examples/hyprland.conf](examples/hyprland.conf) shows what to leave out of
your own config, because Talaris does it. To turn Talaris off, take the line
out again.

To look around before giving it any of your own stuff, turn on demo mode
(Settings → Data → Demo mode): a made-up world of projects, people, tasks and
pages. The screenshots above come from it.

**Keys**

| Keys | Does |
|---|---|
| Super+Space | The launcher: find anything, or ask Morgan |
| Super+Tab | The projects |
| Super+Shift+N | New: a task, an event, a person, a note, a project |
| Super+V | Clipboard history |
| Super+Shift+G | Glance at the project you're in |
| Super+Escape | Put everything away; a fullscreen window back in its place |
| Super+Shift+C / W | The canvas / the writing drawer |
| Super+Shift+M | Morgan, when it's installed |

**AI Assistant**

Morgan is a separate, companion project:
[heymorgan](https://github.com/jpmoo/heymorgan), installed and run on its own.
Talaris works without it, but without all of the AI bells and whistles it
was designed for, and shows none of Morgan's pieces until it's installed. Once it is, Talaris gives Morgan its face: a bar button, a voice
popup, a conversation panel, a key (Super+Shift+M), and "Ask Morgan" in the
launcher. Morgan is available via voice ("Hey Morgan!" or whatever you want
to call it), that key, and the bar button.

Morgan runs through Ollama, and can use Claude as a backup (as "the Oracle").
It can also run its brain on a server, with your laptop as a client, so that
multiple devices talk to one centralized Morgan.

Morgan offers:
- full MCP support
- tracking (off unless you turn it on, and never passed to the Oracle) of your work for suggestions on how to be more productive
- tracking, ingesting, and embedding everything on your system to help identify related things
- full awareness of notes, contacts, calendar events, etc., etc.
- ability to work in all of those modules to do things like:
  - "Put all of the tasks in the 'Do' box of my Eisenhower matrix on a canvas."
  - "Look at my calendar and tasks and give me some suggestions on staging my day."
  - "Take a look at everything you can find about my friend Rich and suggest a birthday present."

**Under the Hood**

Talaris is two processes and a set of pages.

- **The core** (`packages/core`) — TypeScript on Node. It keeps everything:
  projects, pages, canvases, tasks, people, events, notes and files, as
  entities in the shape of the [pkm-interchange](https://github.com/jpmoo/hermesnotes/tree/main/pkm-interchange)
  format. It serves a Unix socket (`$XDG_RUNTIME_DIR/talaris.sock`) that
  everything else talks to, hosts plugins, and offers the entity graph over
  MCP for Morgan or any other MCP client started on this machine. It has no
  runtime dependencies beyond Node itself. It runs as a systemd user
  service, `talaris-core`, so it outlives anything on screen.
- **The surfaces** (`surfaces/`) — one PySide6 process that draws the bar,
  the dock, the panels (Tasks, People, Library, Calendar, Glance, Archive,
  New), the canvas and writing drawers, the launcher, notifications,
  Settings and Morgan's panel, as Wayland layer-shell surfaces. Each is an
  HTML page in QtWebEngine, served from a private URL scheme and connected
  to the process by a `QWebChannel`. It talks to Hyprland over its sockets
  and to the core over its own. It runs as `talaris-surfaces`, which
  restarts if it falls over.
- **The pages** (`surfaces/ui/`) — plain HTML, CSS and JavaScript with no
  build step, drawn from one set of shared files: `tokens.css` (every
  colour, corner, shadow and timing), `controls.css`, `kit.css`/`kit.js`
  (menus, pickers, asking twice, dragging), `icons.js`. A check that runs
  with the tests fails when a page writes a value of its own.
- **The editor and the canvas** (`packages/editor`, `packages/canvas`) —
  TypeScript, bundled into `surfaces/ui/`: CodeMirror for writing, and the
  canvas forked from Hermes Notes.
- **Morgan**, the voice and chat assistant, is a separate companion project
  ([heymorgan](https://github.com/jpmoo/heymorgan)), installed and run as its
  own service. Talaris looks for it (its user service or its socket) and,
  when it's there, shows its panel and gives it the entity graph; when it
  isn't, Morgan's pieces stay hidden. Talaris runs without Morgan, but
  without the AI it was designed around.
- **Plugins** are separate processes in any language, spoken to over MCP on
  their standard input and output. Each declares in a `plugin.toml` what it
  may read, change and do before it is enabled. How to write one: [docs/PLUGINS.md](docs/PLUGINS.md);
  the shape Talaris's data is shared in: [docs/PKM-INTERCHANGE.md](docs/PKM-INTERCHANGE.md).

Hyprland's own configuration stays yours: the installer writes a
`talaris.conf` beside it, and one `source =` line in `hyprland.conf` turns
Talaris on. Binds are made at runtime, so taking that line out takes Talaris
out.

**What it needs**

- **Linux with Hyprland**, and `hyprpaper`, `hypridle`/`hyprlock` and
  `hyprpolkitagent` beside it.
- **Node 22 or later** and **pnpm**, for the core and the bundles.
- **Python 3 with PySide6** (QtWebEngine and layer-shell support), and
  **PyGObject** for the keyring (libsecret), and for calendars and contacts
  through Evolution Data Server (`EDataServer`, `ECal`, `EBook`).
- **A login keyring** (GNOME Keyring or another Secret Service), unlocked at
  login: it holds the key everything is sealed with.
- **systemd** user services.
- The usual desktop tools, each only for what it reads or sets:
  `wl-clipboard` (clipboard history), `grim` (project thumbnails),
  `nmcli` (Wi-Fi), `bluetoothctl`, `wpctl` (PipeWire volume), `upower` and
  `powerprofilesctl` (battery and power mode), `brightnessctl`,
  `notify-send`.
- **Optional: Morgan.** Installed separately from
  [heymorgan](https://github.com/jpmoo/heymorgan), with its own needs
  (Node 22 and an Ollama server, and a Claude key if you want the Oracle).

`./install.sh` builds everything, installs and starts the services, and
writes `talaris.conf`; one `source =` line in your `hyprland.conf` turns it
on. [examples/hyprland.conf](examples/hyprland.conf) is an annotated
starting point: what stays yours, and what to leave out because Talaris
does it.

**How security is handled**

- **Everything stored is sealed.** Entities, their attached files, the
  clipboard history and backups are encrypted on disk with
  AES-256-GCM, a fresh nonce each time. The key is 32 random bytes kept in
  the login keyring, never in a file.
- **A recovery key, shown once.** The store's key is also kept sealed to a
  recovery key (X25519) whose private half Talaris never keeps: write it
  down or put it in a password manager. If the keyring is lost, the recovery
  key opens the sealed copy. A locked or missing keyring leaves the store
  *locked*, never empty: a new key is never made over existing data.
- **Backups** are the whole store as an interchange export, sealed to the
  recovery key and written to a folder you choose, on a schedule. Sealing
  needs only the public half, so backups run unattended and nothing on the
  machine can open one; restoring asks for the recovery key.
- **Projects can be encrypted too**, one by one (Settings → Data). Then the
  pages, files and canvases Talaris writes into the project's folder are
  sealed as well. Not by default, because a project is an ordinary folder
  other applications save into; file names, and what other applications
  save there, are left to the disk's own encryption.
- **Nothing listens on the network.** The core's socket is readable and
  writable by you alone (mode 0600). The MCP server speaks only on standard
  input and output, so only something you started can reach it.
- **Each page reaches only what it needs.** A page asks the core through its
  bridge, and the bridge passes on only that page's own routes: the bar's
  popups cannot install a plugin or open the vault. A path the core would
  read differently from how it is written is refused.
- **Plugins say what they may do, and are held to it.** A plugin's manifest
  names the kinds of things it may read and change and whether it may
  notify; Talaris shows that before it is enabled and refuses anything
  outside it. A plugin is still a program running as you: Talaris cannot
  stop it reading files or using the network, and says so. Plugins' secrets
  go in the keyring.
- **Secrets stay out of the clipboard history.** What a password manager
  marks as secret is never read, and the recovery key, copied from
  Settings, is left out.
- **What leaves the machine is what you point it at:** the sync plugins'
  servers, the address set for search by meaning, and Morgan's brain where
  you run it.

**Credits**

Built on [Hyprland](https://hyprland.org), [Qt for Python](https://doc.qt.io/qtforpython-6/)
(PySide6 and QtWebEngine), and [CodeMirror](https://codemirror.net). Icons
from [Tabler Icons](https://tabler.io/icons) (MIT); the fonts Barlow Semi
Condensed, Exo 2, Rajdhani and Saira Semi Condensed are under the SIL Open
Font License (their licenses are beside them in `surfaces/ui/fonts`).

**License**

Copyright © 2026 Jeff Moore. GPL-3.0-only — see [LICENSE](LICENSE). Also available on other terms from the
owner. Contributions need the [Contributor License Agreement](CLA.md); see
[CONTRIBUTING.md](CONTRIBUTING.md).
