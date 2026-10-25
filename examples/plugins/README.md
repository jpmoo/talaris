# Writing a Talaris plugin

A plugin is a program of its own, in any language, that Talaris starts and
speaks **MCP** to over its standard input and output. `hello/` is a whole one
in a hundred lines with no dependencies: copy it, change the id, and it is yours.

## The folder

- `plugin.toml` — what Talaris reads before anything runs (see `hello/plugin.toml`):
  - `id`, `name`, `version`, `description`, `author`, `license`, `homepage`
  - `command` — the program and its arguments, run in the plugin's folder
  - `[[tools]]` — the tools it offers. **Only these are passed on**, whatever the program says.
  - `[permissions]` — what it may ask of Talaris, shown before it is enabled and held to after:
    `read` and `write` (kinds: `task`, `project`, `event`, `contact` or `person`, `note`),
    `notify`, and — said, not enforced — `network` and `files`.
  - `[[apps]]` — a window it offers: `id`, `name`, `url` (which may name its own
    settings, `{server}`, never a secret), `key` (Hyprland's form, `"SUPER SHIFT, H"`),
    `icon`. While the plugin is enabled, Talaris gives each a window of its own with
    a kept sign-in, a launcher entry, a place in the dock, and its key — one window,
    brought forward if open.
  - `[[settings]]` — `key`, `label`, `kind` (`text`, `secret`, `choice`, `boolean`,
    `number`), `choices`, `default`, `help`. Secrets live in the login keyring.
- Installed is a copy in `~/.local/share/talaris/plugins/<id>/` (Settings, Plugins:
  from a folder or a git address). Installing never enables.

## The conversation

Talaris is the MCP client. At `initialize` it offers, in
`capabilities.experimental.talaris`: `version`, the `requests` you may make, and
your `settings` (secrets included), so the first call has them. Changes arrive as
`notifications/talaris/settings_changed` with `{ settings }`.

You ask Talaris on the same connection, as JSON-RPC requests of your own:

| request | params | answers |
|---|---|---|
| `talaris/settings` | — | `{ settings }` |
| `talaris/interchange` | `{ method, path, body? }` | the pkm-interchange live binding: `GET /interchange` (with `since`, `profile`, `q`), `GET /conformance`, `PUT` and `PATCH /interchange/objects/<id>` — narrowed to the kinds your manifest may read, refused for kinds it may not change |
| `talaris/notify` | `{ title, body }` | a desktop notification, as your plugin (needs `notify`) |
| `talaris/status` | `{ text }` | a line about yourself, shown in Settings ("synced 2 min ago") |

Your tools reach Morgan as `<id>__<tool>`; `annotations.readOnlyHint` decides
whether Morgan runs one (Allow) or asks first (Ask), and the person can change
either. Write to stderr to log: it is kept, and shown under "Its log".

Talaris restarts a plugin that exits, waiting longer each time (one second up to
five minutes), and stops it when it is disabled or Talaris stops.
