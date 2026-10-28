# Talaris

**A thinking-space desktop for Hyprland, with an assistant built in.**

A desktop for Hyprland built around projects instead of workspaces. Each
project has a canvas and a writing surface, kept in drawers at the screen's
edges; applications open from cards on the canvas and are put away again when
you are done with them. Morgan, a voice-and-chat assistant, is built in.
Anything outside the desktop, starting with Hermes Notes, connects through
plugins.

**Not built yet.** See [DESIGN.md](DESIGN.md).

## Under the Hood

### How it is put together

Talaris is a desktop shell for Hyprland, in two processes and a set of pages.

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
- **Morgan**, the voice and chat assistant, is its own project
  ([heymorgan](https://github.com/jpmoo/heymorgan)) and its own service.
  Talaris shows its panel and gives it the entity graph; it does not need
  Morgan to run.
- **Plugins** are separate processes in any language, spoken to over MCP on
  their standard input and output. Each declares in a `plugin.toml` what it
  may read, change and do before it is enabled. How to write one: [PLUGINS.md](PLUGINS.md);
  the shape Talaris's data is shared in: [PKM-INTERCHANGE.md](PKM-INTERCHANGE.md).

Hyprland's own configuration stays yours: the installer writes a
`talaris.conf` beside it, and one `source =` line in `hyprland.conf` turns
Talaris on. Binds are made at runtime, so taking that line out takes Talaris
out.

### What it needs

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

`./install.sh` builds everything, installs and starts the services, and
writes `talaris.conf`; one `source =` line in your `hyprland.conf` turns it
on. [examples/hyprland.conf](examples/hyprland.conf) is an annotated
starting point: what stays yours, and what to leave out because Talaris
does it.

### How security is handled

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

## License

GPL-3.0-only — see [LICENSE](LICENSE). Also available on other terms from the
owner. Contributions need the [Contributor License Agreement](CLA.md); see
[CONTRIBUTING.md](CONTRIBUTING.md).
