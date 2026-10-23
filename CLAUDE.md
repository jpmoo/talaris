# Working in this repo

Orientation for a coding agent. Short on purpose.

**Talaris is a thinking-space desktop for Hyprland, with an assistant built
in**: it draws everything on the screen that
is not an application window, organizes work into projects with a canvas and a
writing surface each, has Morgan built in as its one assistant, and connects to
anything outside — Hermes Notes first — through plugins. **Hyprland is the
first compositor backend, not the only one**: nothing outside the backend talks
to Hyprland directly.

**Building has begun.** `DESIGN.md` is the plan and the reasoning; read it
first, all of it. Its *Order* section says what is done and what is next.

## What is here

- `packages/model` — the shared types: projects, canvases, pages, versions.
  One definition of a canvas, for the core and the pages that draw it.
- `packages/core` — the core: projects, canvases, writing and versions, on a
  Unix socket. TypeScript compiled by `tsc` (Ubuntu's Node cannot run
  TypeScript directly). Tests run against a throwaway folder, never `~/Projects`.
- `surfaces/` — the screen furniture: one PySide6 process under layer-shell
  (`talaris-surfaces` sets that before Qt starts). Pages in `surfaces/ui/`
  reach the core through a `QWebChannel` bridge, never through a URL scheme
  carrying a body. Page errors go to `journalctl --user -u talaris-surfaces`.
- `install.sh` — builds, installs `talaris-core.service` and
  `talaris-surfaces.service`, writes `~/.config/hypr/talaris.conf`, and asks
  the socket. It never edits `hyprland.conf`.

```bash
pnpm -r build
pnpm -r test
./install.sh
curl -s --unix-socket $XDG_RUNTIME_DIR/talaris.sock http://talaris/projects
```

- `DESIGN.md` — the design, the decisions, and what the one spike found.
- `from-talaria/` — pieces copied from Talaria, unedited, to be taken from. Its
  `README.md` says where each came from and why. **Nothing in it runs as it
  stands.** Move a piece out when it is adopted and change it there.

## Related repositories

- `jpmoo/hermesnotes` — Hermes Notes, the `pkm-interchange` format, and Talaria.
  Talaris does **not** depend on Talaria's daemon. The Hermes plugin speaks the
  format and only the format. `talaria/linux/CLAUDE.md` there holds a great deal
  of hard-won detail about PySide6, WebEngine, Wayland and Hyprland — read the
  relevant part before rediscovering it.
- `jpmoo/heymorgan` — Morgan. Its own process and repository; Talaris is its
  face and talks to it over `$XDG_RUNTIME_DIR/heymorgan.sock`.

## Things to know before running anything

- **Never start a surface from an agent's shell.** Start it the way the desktop
  starts things — `hyprctl dispatch exec "systemd-run --user --scope …"` — or it
  inherits the wrong environment.
- **Anything on the overlay layer ships with its way back**: a compositor bind,
  Escape, an idle timeout, and a signal. A spike without them ended in a
  restart.
- **Signal processes by pid, never `pkill -f`** — the pattern matches the shell
  running it.
- **Do not capture the owner's screen** to check a surface without asking first.
  Read state from `hyprctl` instead (`hyprctl layers`, `hyprctl clients`).

## License

GPL-3.0-only, and the owner also licenses Talaris commercially — so **every new
source file carries the SPDX header in `CONTRIBUTING.md`**, and nothing licensed
in a way that would block that (another GPL project's code, say) is copied in.
Code from `jpmoo/hermesnotes` is the owner's own and may come across.

## House style

Comments explain *why*; decisions carry their reasoning; American spellings,
including in commit messages.
