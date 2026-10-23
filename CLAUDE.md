# Working in this repo

Orientation for a coding agent. Short on purpose.

**Talaris is a desktop for Hyprland**: it draws everything on the screen that
is not an application window, organizes work into projects with a canvas and a
writing surface each, has Morgan built in as its one assistant, and connects to
anything outside — Hermes Notes first — through plugins.

**Nothing is built yet.** `DESIGN.md` is the plan and the reasoning; read it
first, all of it. Its *Order* section is where work starts.

## What is here

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
- `jpmoo/heyclaude` — Morgan. Its own process and repository; Talaris is its
  face and talks to it over `$XDG_RUNTIME_DIR/heyclaude.sock`.

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

## House style

Comments explain *why*; decisions carry their reasoning; American spellings,
including in commit messages.
