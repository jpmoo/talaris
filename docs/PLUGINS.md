# Writing a Talaris plugin

How to build a plugin for Talaris, written for a coding agent that will build
one. Every statement here can be checked against the code; the file it comes
from is named so you can. Where this document and the code disagree, the code
is right and this document has a bug.

Sources:

| what | where |
|---|---|
| The host: manifest parsing, supervision, the MCP conversation, the `talaris/…` requests, permissions | `packages/core/src/plugins.ts` |
| The TOML reader for `plugin.toml` | `packages/core/src/toml.ts` |
| How plugin tools reach Morgan | `packages/core/src/mcp.ts` (`pluginTools`, `tools/call`) |
| The HTTP routes Settings and the panels call | `packages/core/src/server.ts` (`/plugins…`) |
| A complete plugin with no dependencies | `examples/plugins/hello/` (`plugin.toml`, `main.mjs`) |
| The test that drives `hello` through the real host | `packages/core/test/entities.test.ts` ("a plugin: installed from a folder…") |
| Backup and restore of a plugin's settings and state | `packages/core/test/plugin-backup.test.ts` |
| Settings → Plugins (install, enable, settings, log, decisions) | `surfaces/ui/settings.js` (`loadPlugins`, `plDecisions`), `surfaces/settings.py` |
| Action buttons on sheets and lists | `surfaces/ui/peek.js` (`actionButtons`) |
| The design and its reasons | `DESIGN.md`, *Plugins* and *Order* item 13 |
| The data format plugins read and write | [`PKM-INTERCHANGE.md`](PKM-INTERCHANGE.md) |

---

## 1. What a plugin is

- **A program of its own**, started and supervised by the Talaris core. It is
  never loaded into the core's process, so a crash does not take the desktop
  with it, it can be written in any language, and it can carry any license
  (DESIGN, *Plugins*).
- **An MCP server on its standard input and output.** Talaris is the MCP
  client. Messages are JSON-RPC 2.0, one JSON object per line, newline
  terminated, in both directions.
- **Two-way on one connection.** Talaris asks the plugin the usual MCP things
  (`initialize`, `tools/list`, `tools/call`). The plugin asks Talaris for what
  MCP has no words for, with JSON-RPC requests whose method starts with
  `talaris/` (its settings, Talaris's data, a notification, a status line, a
  question for the person). Talaris announces this extension at `initialize`
  in `capabilities.experimental.talaris`.
- **Declared before it runs.** `plugin.toml` says what the plugin is, what
  starts it, which tools it offers, which settings it keeps, and what it may
  ask of Talaris. Talaris reads it without running anything and shows it to
  the person before they enable the plugin.
- **A program running as you.** Talaris enforces what a plugin may ask *of
  Talaris*. It cannot stop a plugin reading files or using the network, and
  does not try: `network` and `files` in the manifest are shown, not enforced
  (see §8).

What is **not** built, though DESIGN lists it as intended: plugin launcher
results, canvas item kinds, bar and dock items, a plugin-supplied Settings
page or item page in a sandboxed frame, desktop events (project changed, card
opened), MCP resources, and starting a plugin on first use. Today a plugin
contributes **tools**, **apps** (web-app windows), **actions** (buttons),
**settings**, **decisions**, a **status line**, and **notifications** — and
nothing else. Do not build against the unbuilt list.

---

## 2. Quick start

1. Copy `examples/plugins/hello/` to a new folder.
2. In `plugin.toml`, change `id` (and `name`). The folder name must equal the
   `id` once installed; the installer takes care of that.
3. Edit `main.mjs`: its `TOOLS` array and its `call()` function are the plugin.
4. Settings → Plugins → install from that folder → enable it.
5. Watch "Its log" in Settings → Plugins for anything it writes to stderr.

`hello` is about a hundred lines, has no dependencies, and shows every part of
the protocol by hand: answering `initialize`, `tools/list` and `tools/call`;
sending `talaris/interchange`, `talaris/status` and `talaris/notify`;
receiving `notifications/talaris/settings_changed`. Read it before writing
anything; an MCP SDK in your language works too, as long as it lets you send
requests *to* the client (see §6.4).

---

## 3. Where a plugin lives, and how it is installed

**Installed** means a folder at `<plugins>/<id>/` containing `plugin.toml`:

```
<plugins> = $TALARIS_PLUGINS
         or $XDG_DATA_HOME/talaris/plugins
         or ~/.local/share/talaris/plugins
```

(`PLUGINS_DIR` in `plugins.ts`.) Every subfolder not starting with `.` is
scanned. A folder whose `plugin.toml` is missing or invalid, or whose name is
not the manifest's `id`, is listed in Settings as "Not a plugin Talaris can
read: <why>" and is otherwise ignored.

**Installing** (`install()` in `plugins.ts`; Settings → Plugins, or
`POST /plugins/install {from, replace?}` on the core's socket):

- `from` is a folder path (a leading `~/` is expanded) or a git address. A
  git address is anything starting `http://`, `https://`, `git@`, `ssh://`, or
  ending `.git`; it is cloned with `git clone --depth 1` (120 s timeout) into a
  temporary folder, which is removed afterwards.
- The manifest is read and checked first. A bad manifest refuses the install
  with the reason.
- The folder is copied to `<plugins>/<id>/`, **excluding any `.git` folder**.
  Everything else is copied — including `node_modules` if present. Talaris
  does not run `npm install` or any build step, so ship what `command` needs
  to run, or keep to no dependencies as `hello` does.
- If the id is already installed the install is refused unless
  `replace: true` (Settings offers "Replace it with this one"); replacing stops
  the running copy, deletes the folder, and copies the new one.
- **Installing never enables.** The one exception: if this id was enabled
  before (its enabled flag is still kept — e.g. after a replace, or after a
  backup was revived before the plugin was installed), it is started.

**Uninstalling** (`DELETE /plugins/<id>`) stops it, deletes its folder, forgets
its secrets from the keyring, and forgets its enabled flag and settings. It
does **not** delete its state folder (`TALARIS_PLUGIN_STATE`, §5).

Layout of a plugin folder — nothing is required but `plugin.toml` and whatever
`command` runs:

```
my-plugin/
├── plugin.toml        # required; read before anything runs
├── main.mjs           # or any program; run by `command`, in this folder
├── icon.png           # optional; named by an [[apps]] entry's `icon`
└── test/              # yours; Talaris never looks at it
```

---

## 4. `plugin.toml`, every key

Read by `readManifest()` in `plugins.ts`, through the TOML reader in
`toml.ts`. Keys the reader does not know are **ignored**, not refused — so a
typo in a key name is silently dropped. Check your manifest by installing it
and opening the plugin in Settings, which shows what Talaris understood.

### 4.1 The TOML that is understood

`toml.ts` reads: bare, quoted and dotted keys; basic strings (with escapes,
including `\uXXXX` and `\UXXXXXXXX`), literal strings, and both multi-line
forms (a line-ending backslash in a basic multi-line string eats the newline
and following whitespace); integers and floats; booleans; arrays (multi-line,
trailing comma allowed); inline tables; `[tables]`; `[[arrays of tables]]`;
comments. It **refuses** — failing the install with `plugin.toml, line N: …` —
dates and times, a key given twice, a table redefined as a value, and
anything else it cannot read. It never guesses.

### 4.2 Top-level keys

| key | type | required | rule |
|---|---|---|---|
| `id` | string | yes | `^[a-z0-9][a-z0-9-]{1,40}$` — 2 to 41 characters, lowercase letters, digits, dashes, not starting with a dash. The installed folder's name. |
| `name` | string | yes | Non-empty. Shown everywhere a person sees the plugin. |
| `version` | string | yes | Non-empty. Shown, not interpreted. |
| `command` | string or array of strings | yes | The program and its arguments, run with the plugin's folder as working directory. A string is one program with no arguments (it is **not** split on spaces). Not run through a shell. |
| `description` | string | no | Shown in Settings. |
| `author` | string | no | Shown in Settings. |
| `license` | string | no | Shown in Settings. |
| `homepage` | string | no | Shown in Settings. |

### 4.3 `[[tools]]`

| key | type | required | rule |
|---|---|---|---|
| `name` | string | yes | The MCP tool name the program offers. |
| `description` | string | no | Shown in Settings before enabling. What Morgan sees is the description the *program* gives in `tools/list`, not this one. |

**Only tools named here are passed on.** When the program answers
`tools/list`, any tool it offers that the manifest does not name is dropped
and the log says `offers tools its manifest does not name, not passed on: …`.
A tool named here that the program does not offer is simply absent.

### 4.4 `[permissions]`

| key | type | default | meaning | enforced? |
|---|---|---|---|---|
| `read` | array of kinds | `[]` | Kinds it may read through `talaris/interchange`. | yes |
| `write` | array of kinds | `[]` | Kinds it may create and change. **Writing implies reading**: every kind in `write` is added to `read`. | yes |
| `notify` | boolean | `false` | May send desktop notifications (`talaris/notify`). Only the literal `true` counts. | yes |
| `network` | array of strings | `[]` | Free words: what it reaches ("your Hermes Notes server"). | **no** — shown only |
| `files` | array of strings | `[]` | Free words: what files it uses. | **no** — shown only |

Kinds are the pkm-interchange profile names Talaris lets a plugin name:
`task`, `project`, `event`, `contact`, `note`. `person` is accepted as a
synonym for `contact`. Any other word refuses the manifest. A kind means "any
object whose type declares that profile" — so a daily note, whose type
declares both `note` and `journal`, is covered by `note`.

### 4.5 `[[settings]]`

| key | type | required | rule |
|---|---|---|---|
| `key` | string | yes | `^[A-Za-z0-9_-]+$`. The name the plugin receives it under. |
| `label` | string | no | Defaults to `key`. Shown in Settings. |
| `kind` | string | no | `text` (default), `secret`, `choice`, `boolean`, `number`. |
| `choices` | array of strings | for `choice` | The allowed values, shown as a chooser. |
| `default` | any | no | Handed to the plugin when the person has set nothing. Not used for `secret`. |
| `help` | string | no | Shown under the field. |

How each is kept and checked (`setSettings`):

- `text`, `choice`, `boolean`, `number` are kept in the core's config folder,
  `$TALARIS_CONFIG_DIR` or `~/.config/talaris/`, file `plugins.json`
  (`{enabled: {id: bool}, settings: {id: {key: value}}}`).
- A write is checked: `boolean` must be a JSON boolean, `number` a JSON
  number, `choice` one of `choices`. `text` is not checked. Writing `null`
  removes the person's value, so `default` applies again.
- `secret` is never written to a file. It goes to the login keyring under the
  name `plugin:<id>:<key>` (`vault.ts`, through `keyring.py`/libsecret).
  Writing `null` or `""` forgets it. Settings shows a secret only as set or
  not set and never reads it back.

### 4.6 `[[apps]]` — a web app in a window of its own

| key | type | required | rule |
|---|---|---|---|
| `id` | string | yes | `^[a-z0-9][a-z0-9-]{0,30}$` |
| `name` | string | yes | The window's name in the launcher and dock. |
| `url` | string | yes | May contain `{settingKey}` placeholders naming the plugin's own **non-secret** settings; naming a secret or a key that is not a setting refuses the manifest. |
| `key` | string | no | A Hyprland bind in Hyprland's form, matching `^[A-Z ]*,\s*\S+$`, e.g. `"SUPER SHIFT, H"`. |
| `icon` | string | no | A path inside the plugin's folder. Ignored if it resolves outside the folder or does not exist. |

While the plugin is **enabled** (not merely running), the surfaces
(`webapps.py`, via `GET /plugins/apps`) give each app a window with its own
kept sign-in, a launcher entry, a dock place and its key. An app is offered
only once its `url`, with placeholders filled from settings, is complete and
matches `^https?://\S+$`; one waiting on an unset setting is not offered yet.

### 4.7 `[[actions]]` — buttons on Talaris's own sheets and lists

| key | type | required | rule |
|---|---|---|---|
| `id` | string | yes | `^[a-z0-9][a-z0-9-]{0,30}$` |
| `label` | string | yes | The button's words. |
| `on` | array of strings | yes | Where it appears (below). `person` is accepted for `contact`. |
| `tool` | string | yes | One of this manifest's `[[tools]]`. |
| `when` | string or array of strings | no | `boolean` settings of this plugin; the button shows only while **every** one is `true`. |
| `only` | string | no | Only `"missing-files"`: shown only on a thing with a linked file gone from disk (`links.ts`, `unbacked()`). |

Places for `on`:

| value | where | the tool is called with |
|---|---|---|
| `task` | a task's sheet (Tasks' editor, a card) | `{entity: <id>, kind: "task"}` |
| `project` | a project's sheet | `{entity, kind: "project"}` |
| `contact` / `person` | a person's entry | `{entity, kind: "contact"}` |
| `note` | an unaffiliated note's sheet | `{entity, kind: "note"}` |
| `people` | the top of People's list | `{kind: "people"}` |
| `tasks` | the top of Tasks' list | `{kind: "tasks"}` |
| `notes` | the top of the unaffiliated notes | `{kind: "notes"}` |
| `daily` | Home's daily notes | `{kind: "daily"}` |
| `settings` | the plugin's own row in Settings → Plugins | `{kind: "settings"}` |

An action is shown only while its plugin is **running** (`pluginActions()`).
Pressing one calls `POST /plugins/<id>/actions/<action>` → `runAction()`,
which calls the tool and answers `{text, error, decisions, here}`: the tool's
text content joined, whether it set `isError`, how many decisions the plugin
now has that are asked in Settings, and how many are asked in this place
(`on` equal to this list's kind). The button then says, in order of
precedence: "Didn't work" (with the text on hover), opens the place's own
chooser (when `here` > 0 and the page has one), "N to decide", or "Done"
(`peek.js`, `actionButtons`).

### 4.8 `[backup]`

| key | type | rule |
|---|---|---|
| `state` | array of strings | Paths relative to the plugin's state folder (`TALARIS_PLUGIN_STATE`). Not absolute, no `..`, no empty segment. A folder is carried whole. |

A Talaris backup always carries each installed plugin's id, name, version,
enabled flag and non-secret settings; with `[backup] state` it also carries
those files, base64, up to 32 MB per plugin (beyond that it carries what fit
and says `its state is larger than 32 MB`). Secrets are never in a backup;
after a revival Settings lists which to type again. A backup naming a plugin
that is not installed keeps its settings, state and enabled flag waiting for
when it is (`backupPlugins`, `restorePlugins`; tested in
`plugin-backup.test.ts`).

### 4.9 A full, annotated manifest

Every key, valid as written:

```toml
# Identity — id, name, version and command are required.
id = "acme-sync"                       # 2–41 chars: a-z 0-9 -; the folder's name
name = "Acme sync"
version = "0.3.1"
description = "Keeps tasks in step with Acme."
author = "Someone"
license = "MIT"                        # any license: a plugin is its own program
homepage = "https://example.org/acme-sync"

# Run in the plugin's folder, no shell. A string means one program, no arguments.
command = ["node", "main.mjs"]

# Only these reach Morgan or anything else, whatever tools/list says.
[[tools]]
name = "sync_now"
description = "Sync with Acme now"

[[tools]]
name = "sync_status"
description = "When it last synced"

# Held to by Talaris: read/write by kind, notify. network/files are only shown.
[permissions]
read = ["task", "project", "person"]   # person = contact
write = ["task"]                       # writing a kind brings reading it
notify = true
network = ["your Acme server"]
files = []

[[settings]]
key = "server"
label = "Acme address"
kind = "text"
help = "https only."

[[settings]]
key = "token"
label = "Access token"
kind = "secret"                        # login keyring, never a file, never a backup

[[settings]]
key = "mode"
label = "When they differ"
kind = "choice"
choices = ["Merge, and ask me", "Acme wins", "Talaris wins"]
default = "Merge, and ask me"

[[settings]]
key = "seconds"
label = "Look every (seconds)"
kind = "number"
default = 30

[[settings]]
key = "buttons"
label = "Sync buttons"
kind = "boolean"
default = false

# Acme itself in a window; {server} is a non-secret setting, filled in.
[[apps]]
id = "acme"
name = "Acme"
url = "{server}"
key = "SUPER SHIFT, A"
icon = "icon.png"

# Always in Settings while it runs.
[[actions]]
id = "sync-settings"
label = "Sync now"
on = ["settings"]
tool = "sync_now"

# On each task and project, while the setting is on.
[[actions]]
id = "sync"
label = "Sync with Acme"
on = ["task", "project"]
tool = "sync_now"
when = "buttons"

# Files under TALARIS_PLUGIN_STATE that a backup carries.
[backup]
state = ["state.json"]
```

---

## 5. Lifecycle

### 5.1 States

`listPlugins()` reports one of: `disabled` (not enabled), `stopped` (enabled,
not running — e.g. just stopped), `starting`, `running`, `crashed`.

### 5.2 Starting

When enabled (`POST /plugins/<id>/enable {on: true}`), or at core start for
every enabled plugin (`startPlugins()`), Talaris:

1. Spawns `command` with `cwd` = the plugin's folder, stdio all piped, and the
   core's environment plus:

   | variable | value |
   |---|---|
   | `TALARIS_PLUGIN` | the plugin's id |
   | `TALARIS_PLUGIN_DIR` | its installed folder |
   | `TALARIS_PLUGIN_STATE` | `<Talaris state dir>/plugins/<id>` — `$TALARIS_STATE_DIR` or `$XDG_STATE_HOME/talaris` or `~/.local/state/talaris`. Keep what you know here. **Talaris does not create it**; `mkdir -p` it yourself. |

2. Sends `initialize` (20 s timeout) — see §6.1.
3. On the answer, sends the notification `notifications/initialized`.
4. Sends `tools/list` (20 s timeout) and keeps the declared subset (§4.3).
5. Marks it `running` and logs `running (<serverInfo.name>)`.

If `initialize` or `tools/list` fails or times out, Talaris logs
`did not answer as an MCP server: …` and sends SIGTERM; the exit then counts
as a crash.

### 5.3 Crashes and restarts

Any exit Talaris did not ask for is a crash. Every request in flight fails
with `<name> stopped`, the tool list empties, the state becomes `crashed`, and
a restart is scheduled after `min(1 s × 2^n, 5 min)`, where `n` counts
restarts and is reset to 0 if the process had been up more than ten minutes.
A crash-restart keeps the same in-memory log.

### 5.4 Stopping, restarting

- Disabling (`enable {on: false}`), uninstalling, replacing, and core
  shutdown stop it: stdin is closed, then SIGTERM, then SIGKILL after 3 s if
  it has not exited. **Exit promptly on stdin end or SIGTERM.**
- `POST /plugins/<id>/restart` (Settings' "Restart") refuses unless enabled,
  then stops and starts a fresh one. Enabling or restarting creates a fresh
  supervisor, so **the log starts empty**.

### 5.5 Logs

Kept in memory, the last 300 lines, each prefixed `HH:MM:SS` (UTC). Lines come
from:

- everything the plugin writes to **stderr**;
- the `data` of any `notifications/message` notification it sends;
- Talaris itself: start failures, `refused <method>: <why>`, undeclared tools,
  crash reasons, and `not JSON on its output: …` for any stdout line that is
  not JSON.

**Stdout is the protocol.** Never print anything else to it. Settings →
Plugins → "Its log" shows the last 60 lines (`GET /plugins/<id>/log`).

---

## 6. The conversation

### 6.1 `initialize`, from Talaris

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{
  "protocolVersion":"2025-06-18",
  "capabilities":{"experimental":{"talaris":{
    "version":1,
    "requests":["talaris/settings","talaris/interchange","talaris/notify",
                "talaris/status","talaris/decide","talaris/restoreLinks"],
    "settings":{"server":"https://…","token":"…","mode":"Merge, and ask me"}}}},
  "clientInfo":{"name":"talaris","version":"0.1.0"}}}
```

`settings` is the plugin's current settings **with secrets in clear**, and
defaults filled in for anything the person has not set. A secret not set is
absent. Answer like any MCP server:

```json
{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-06-18",
  "capabilities":{"tools":{}},"serverInfo":{"name":"acme-sync","version":"0.3.1"}}}
```

Talaris does not check the protocol version you answer with.

### 6.2 Messages Talaris sends

| message | kind | params | your answer |
|---|---|---|---|
| `initialize` | request | above | MCP `InitializeResult` |
| `notifications/initialized` | notification | `{}` | — (a good moment to start background work) |
| `tools/list` | request | `{}` | `{tools: [{name, description, inputSchema, annotations?}]}` |
| `tools/call` | request | `{name, arguments}` | `{content: [{type:"text", text}], isError?}` — 120 s timeout |
| `talaris/decided` | request | `{item, choice, value?}` | anything; see §9 — 120 s timeout |
| `notifications/talaris/settings_changed` | notification | `{settings}` | — replace your settings; sent at once on every change |
| `notifications/talaris/changed` | notification | `{}` | — something in Talaris's store changed |

`notifications/talaris/changed` is sent only to running plugins whose
`read` permission is non-empty, at most once per 1.5 s burst. It says only
*that* something changed; ask what with a `since` read (§7).

Talaris's own request ids are integers counting up from 1.

### 6.3 Messages a plugin may send

| message | kind | params | answer |
|---|---|---|---|
| `ping` | request | — | `{}` |
| `talaris/settings` | request | — | `{settings}` (as at `initialize`) |
| `talaris/status` | request | `{text}` | `{}`; shown beside the plugin in Settings, cut to 200 characters |
| `talaris/notify` | request | `{title?, body?}` | `{}`; needs `notify = true`, else error −32001. Sent through `org.freedesktop.Notifications` as the plugin's `name`; `title` defaults to the name. |
| `talaris/interchange` | request | `{method, path, body?}` | the binding's answer — §7 |
| `talaris/decide` | request | `{items: Decision[]}` | `{}` — §9 |
| `talaris/restoreLinks` | request | `{entity}` | `{restored, still}` — §7.5 |
| `notifications/tools/list_changed` | notification | — | Talaris asks `tools/list` again |
| `notifications/message` | notification | `{data}` | `data` goes to the log |

Any other method is refused with −32601 `Talaris has no <method>`. A request
that fails (including every permission refusal inside `talaris/interchange`)
is answered with error −32000 and the reason as `message`, and the refusal is
logged.

### 6.4 Ids and the two directions

Both sides send requests on the same pipe, so a plugin must:

- tell a message with `method` (a request or notification **to** you) from one
  without (an **answer** to something you asked);
- keep its own map of request id → pending promise for what it asked.

`hello` uses string ids (`"h1"`, `"h2"`, …) for its own requests. Talaris
matches answers to its own requests only by integer id, and answers yours with
the id you sent, so any id type works; strings avoid any confusion when
reading a log.

---

## 7. `talaris/interchange` — Talaris's data, through the binding

Talaris's data is pkm-interchange objects (see
[`PKM-INTERCHANGE.md`](PKM-INTERCHANGE.md)). A plugin reaches it with one
request that carries an HTTP-shaped call:

```json
{"jsonrpc":"2.0","id":"a1","method":"talaris/interchange",
 "params":{"method":"GET","path":"/interchange?profile=task"}}
```

`method` defaults to `GET`; `path` may carry a query string; `body` is a JSON
value. The answer's `result` is the JSON the route would return. **There is
no HTTP status**: a write's success or refusal is in its `ok`, `conflict` and
`reports`; a thrown error (permission, unknown route, a `since` cursor too
old) arrives as a JSON-RPC error. Implementation: `interchangeFor()` in
`plugins.ts`.

### 7.1 Routes, and what each needs

| verb and path | needs | body | answers |
|---|---|---|---|
| `GET /conformance` | nothing | — | `{format: "pkm-interchange/0", …manifest}` |
| `GET /interchange` | any `read` | — | an envelope, narrowed (below) |
| `PUT /interchange/objects/<id>` | `write` on a kind of `body.type` | `{type, properties?, content?, tags?, id?}` | write answer |
| `PATCH /interchange/objects/<id>` | `write` on a kind of the object's type | a patch | write answer |
| `PUT /interchange/files/<sha256>` | any `write` | `{bytes: "<base64>"}` | `{ok, created?, reports}` |
| `GET` / `HEAD /interchange/files/<sha256>` | any `read` | — | `{ok: true, bytes?: "<base64>", reports: []}` (no `bytes` for HEAD) or `{ok: false, reports: ["file.not-held"]}` |
| `PUT`/`PATCH`/`DELETE /interchange/collections/<c>/members/<o>` | `write` includes `task`, and `write` on a kind of the object's type | `{region?}` | `{ok, reports, collection?}` |
| `PUT /interchange/collections/<c>` | `write` includes `task` | a collection | `{ok, created?, reports, collection?}` |
| `PUT /interchange/collections/<c>/definition` | `write` includes `task` | Talaris's own (below) | `{ok, reports, collection?}` |

Anything else is an error: `not a route of the binding: <VERB> <path>`.
Not offered to plugins: the format's `GET /interchange/collections/<id>` and
`PATCH /interchange/collections/<id>`.

`<sha256>` must be 64 lowercase hex characters to match the files route.

### 7.2 Reading

Query parameters: `since=<cursor>`, `profile=<name>`, `q=<words>`, and
`collections=1`. What comes back is `readEnvelope()` (`interchange.ts`)
narrowed to the manifest:

- `objects`: only those whose type declares a profile in your `read` kinds.
- `types`: **all** types, unfiltered — you always get the types your objects
  name, and others besides.
- `relations`: only those whose `from` is one of your objects.
- `cursor`: always present; hand it back as `since`.
- `changes` (with `since`): **unfiltered** — the last change row for every
  changed object, any kind, deletes included. A delete is said by id alone.
- `collections`: only when you ask (`collections=1`) **and** `read` includes
  `task`; each one's `members` narrowed to your objects.
- `conformance`: the live manifest.

A `since` cursor from before what the feed keeps, or from another era (the
store was revived from a backup), fails the request with the message `that
cursor is from before what this feed keeps — read everything again`. On the
socket that is a 410; to a plugin it is a JSON-RPC error. Treat any error on
a `since` read as "read everything again".

The loop `hello` uses to count open tasks — never by a type's name, always by
its profile:

```js
const env = await talaris("talaris/interchange", { method: "GET", path: "/interchange?profile=task" });
const types = new Map((env.types ?? []).map((t) => [t.id, t]));
const open = (env.objects ?? []).filter((o) => {
  const map = types.get(o.type)?.profiles?.task;
  return map && !(map.completeValues ?? []).includes(o.properties?.[map.status]);
});
```

### 7.3 Writing objects

Creates and patches follow the format's rules exactly (see
`PKM-INTERCHANGE.md` §8): the client chooses the id; a `PUT` at an existing id
changes nothing and answers `created: false`; a patch touches only what it
names (`set`, `unset`, `addTags`, `removeTags`, `content`, `archived`,
`version`). Answers:

```json
{"ok": true, "created": true, "object": {…as it stands now…},
 "fidelity": "full", "reports": [], "cursor": "a1b2c3d4.812"}
```

Refusals are `ok: false` with `reports` (`create.id-mismatch`,
`create.unknown-type`, `tags.added-and-removed`) or `conflict: true` for a
stale `version`. A patch on an id that does not exist is a JSON-RPC error
(`no object <id>`).

What Talaris does on a write, beyond storing it — so you are not surprised by
the echo:

- A create whose type declares `project` makes a real Talaris project (a
  folder and a workspace), named from the profile's `title`; no name is
  refused with `create.project-needs-a-name`. Renaming a project through a
  patch renames the project.
- A create whose type declares `journal` with a date is that day's daily note;
  one already existing for the day refuses.
- A create whose type declares `note` (and not `task`) becomes an undated
  note — a Markdown file among Home's Pages; its title and body live in the
  file, everything else on the entity.
- Completing a task through a patch does what completing it in Tasks does
  (time stamped, next occurrence spawned). Read the answer's `object`, and
  expect a change row for the new occurrence.

### 7.4 Files

Attachments travel by hash (format *Files*). To attach: `PUT
/interchange/files/<sha>` with `{bytes}` (base64 here, because the pipe is
JSON), then patch the field with `{kind: "attachment", filename, mediaType?,
sha256}`. A put whose bytes do not hash to the address answers
`{ok: false, reports: ["file.hash-mismatch"]}`. A patch naming a hash Talaris
does not hold is accepted as known-missing and reported
`attachment.known-missing`. There is no delete; a file nothing names is freed
by Talaris.

### 7.5 Collections and `restoreLinks`

Member writes (`PUT` adds, `PATCH` moves, `DELETE` removes; `{region}` or
`{region: null}`) and creating a collection follow the format's *Collections*
section, with Talaris's limits: kinds `list`, `table`, `board`, `matrix`,
`calendar` only; a `query` rule only in Talaris's own condition language; any
`context` is refused; a smart list's membership is its rule's. Report codes
carry a `: explanation` suffix, e.g. `placement.unknown-region: X is not one
of this collection's regions`.

`PUT …/definition` is Talaris's own route for a plugin keeping a collection in
step with another app: `{name?, placement?, order?, membership?, bind?,
synced?}`; it marks the collection `talaris:syncedBy` / `talaris:syncedPlugin`
(Tasks shows it as kept in step), and `{synced: false}` takes the mark off.
A collection a plugin creates is marked the same way.

`talaris/restoreLinks {entity}` puts linked files that went missing from disk
back where they were, from copies the plugin has already handed over by hash
(`links.ts`). It needs `write` on a kind of that entity's type. Answers
`{restored: <count>, still: [<filenames>]}`.

---

## 8. Permissions — what is enforced, what is said

| | enforced by | how |
|---|---|---|
| `read` kinds | `interchangeFor` | reads narrowed to them; a read with none at all is refused; no `notifications/talaris/changed` without any |
| `write` kinds | `interchangeFor`, `talaris/restoreLinks` | create checks `body.type`, patch and member writes check the existing object's type; file puts need any write; collection writes need `task` |
| `notify` | `talaris/notify` | refused −32001 without it |
| tools | `refreshTools`, `callPluginTool` | undeclared tools are not listed or callable |
| `network`, `files` | nobody | shown to the person as "said, not something Talaris can hold it to" |
| everything else the process does | nobody | it runs as the user |

A type with several profiles is allowed if **any** of them is permitted
(`kindsOfType(...).some(...)`). `GET /conformance` needs nothing.

Before enabling, Settings asks "Enable <name>? It may:" and lists "Read your
…", "Make and change …", "Show notifications", or "Nothing of Talaris", and
any `network`/`files` words (`plAsks` in `settings.js`). Ask for the least you
need: it is what the person reads.

---

## 9. Decisions — asking the person

A plugin that needs a person to choose (a conflict, an ambiguous match, a
plan to confirm) sends its **whole current list** each time:

```json
{"jsonrpc":"2.0","id":"d1","method":"talaris/decide","params":{"items":[
  {"id":"conflict:42","title":"Pack coffee","detail":"Changed on both sides.",
   "sides":["Talaris","Acme"],
   "fields":[{"label":"Due","here":"2026-11-02","there":"2026-11-04"},
             {"label":"Notes","here":"…","there":"…","text":true}],
   "choices":[{"key":"here","label":"Keep Talaris's"},
              {"key":"there","label":"Keep Acme's"},
              {"key":"merge","label":"Merge…","edit":true}]}]}}
```

| key | type | rule |
|---|---|---|
| `id` | string | required; ≤ 200 chars |
| `title` | string | required; ≤ 300 |
| `choices` | `[{key, label?, edit?}]` | required, non-empty; ≤ 12; `label` defaults to `key` |
| `detail` | string | ≤ 2000 |
| `fields` | `[{label, here?, there?, text?}]` | ≤ 40; values ≤ 2000 chars, or ≤ 200 000 with `text: true` (shown as a line diff) |
| `sides` | `[string, string]` | column headings |
| `on` | string | ask in that place instead of Settings: one of `people`, `tasks`, `notes`, `daily`, `settings`; anything else is dropped |
| `group`, `prompt` | string | ≤ 100 / ≤ 200; items sharing a `group` are asked together under "<n> <group>. <prompt>" |

Items missing `id`, `title` or `choices` are dropped silently; at most 500 are
kept. Sending a new list replaces the old: an item answered or no longer
relevant is simply absent.

When the person answers (`POST /plugins/<id>/decide`), Talaris removes the
item from its copy and sends **you** a request:

```json
{"jsonrpc":"2.0","id":7,"method":"talaris/decided","params":{"item":"conflict:42","choice":"merge","value":"…the merged words…"}}
```

`value` comes only with a choice marked `edit`. Act on it, answer the request,
and send your list again with `talaris/decide`.

Where they are drawn, today:

- Items with no `on`: Settings → Plugins, under the plugin, at most 50 at a
  time, whether or not the plugin's row is open.
- Items with `on: "tasks"`: Tasks, grouped by `group` (`tasks.js`).
- Items with any other `on`: **nowhere yet** — no surface asks for them.
- An `edit` choice in Settings opens a merge sheet over the **first** field
  with `text: true` and always sends `choice: "merge"` — so give an editable
  choice the key `merge`, or Settings' answer will be refused as "not one of
  its answers".

---

## 10. Tools, and how Morgan sees them

Morgan reaches Talaris through Talaris's own MCP server (`talaris-core mcp`,
`mcp.ts`), a separate process that talks to the core over its socket. It adds
every running plugin's declared tools to its own `tools/list`:

| what Morgan sees | from |
|---|---|
| `name` | `<id>__<tool>`, with every character of the id outside `[A-Za-z0-9_]` replaced by `_` (so `acme-sync` → `acme_sync__sync_now`), cut to 64 characters |
| `description` | `(<plugin name>, a Talaris plugin) <the program's description>` |
| `inputSchema` | the program's, or `{type: "object", properties: {}}` |
| `annotations` | the program's, unchanged |

A call goes `POST /plugins/<id>/call {tool, arguments}` → `tools/call` on the
plugin, and the plugin's result is returned to Morgan as it is. If the plugin
is not running, or the call fails, Morgan gets `isError: true` with the
reason. The MCP server checks for changes every 30 s and sends Morgan
`notifications/tools/list_changed` when the set of names changes.

Set `annotations.readOnlyHint` honestly — `true` only for a tool that changes
nothing. It reaches Morgan unchanged; Morgan's per-tool Allow / Ask / Off
(Morgan's side, not this repository) governs whether a tool runs without
asking. Settings says: "Its tools reach Morgan, under Talaris's connection,
with Allow, Ask or Off like any other."

The same tools serve `[[actions]]` (§4.7). A tool used by an action should
accept `{entity?, kind}` and answer one short sentence of text; that sentence
is what the button shows on hover.

Return errors as a result with `isError: true` and a sentence a person can
read, not as a JSON-RPC error, so both Morgan and the action button can show
it.

---

## 11. Other conventions a plugin can use

- **A way back to the other app.** A property on an object named
  `<plugin-id>:link` holding `{url, label}` with an `http(s)` URL is shown as
  an "Open in <label>" button on its card, in Tasks' editor and in a person's
  entry (`peek.js`, `elsewhere()`). Write it with a patch `set`. Use your own
  prefix; unknown properties survive in Talaris's store.
- **Your own keys on objects go under your own prefix** (`acme-sync:…`), never
  unprefixed and never `talaris:` (PKM-INTERCHANGE.md §4).
- **Remembering which thing is which** across two apps belongs in your state
  folder, and in `[backup] state` so a revived Talaris picks up where it left
  off.

---

## 12. How a plugin talks to other apps

A plugin sits between Talaris and something outside it. Two sides, two
questions.

**Talaris's side is always the interchange binding** (§7). Through it a
plugin reads and writes Talaris's people, tasks, projects, events and notes in
a shared shape — the pkm-interchange format, described in
[`PKM-INTERCHANGE.md`](PKM-INTERCHANGE.md) — under the permissions in its
manifest. It finds what a thing *is* by its type's profiles, never by a type
or field name, so it keeps working when a person renames a field.

**The other side depends on the other app.**

- **If the other app speaks pkm-interchange too**, the plugin can carry data
  between the two in that one shape, with no per-app field mapping: read a
  task's due date on both sides through the `task` profile, write it through
  a patch on both sides, follow both change feeds with `since`, move files by
  hash. Hermes Notes speaks it (its live binding is HTTP, with an access key);
  that is how the Hermes Notes sync plugin works. It is an implementation of
  the format of its own that knows neither app's field names: it reads each
  side's types, pairs things by kind, compares the profile slots both sides
  declare, carries a task's status by its shared `states` meaning only once
  both sides have given every status one, writes through each side's binding,
  follows each side's cursor, and puts what it cannot decide to the person
  with `talaris/decide`. Its tests run it against a fake of the other app (an
  in-memory HTTP server answering the binding) and a real Talaris core.
- **If it does not**, the format carries nothing between them. The plugin
  talks to the outside app however that app allows — its HTTP API, its own
  MCP server, files on disk, a command-line tool — and translates to and from
  Talaris's side itself. Talaris's side stays the binding, so the translation
  is to profiles, not to Talaris internals.

Either way, three rules from the format are worth keeping on the far side as
well as Talaris's: never decide what something is by its name; never write
back fields you did not change (patch, do not replace); and say what you
could not carry instead of dropping it.

---

## 13. Testing a plugin

### 13.1 How `hello` is tested

`packages/core/test/entities.test.ts`, "a plugin: installed from a folder,
enabled, supervised over MCP, its tools called, held to its manifest", drives
the real host in-process:

1. Point the core at a sandbox before importing it: `TALARIS_DATA_DIR`,
   `TALARIS_PROJECTS`, `TALARIS_CONFIG_DIR`, `TALARIS_STATE_DIR`,
   `TALARIS_PLUGINS` to temporary folders, and `TALARIS_KEY` to 32 random
   bytes, base64. With `TALARIS_KEY` set, the vault uses no keyring and keeps
   secrets in memory.
2. `plugins.install(<folder>)` — check the manifest as parsed.
3. `plugins.setSettings(id, {...})` — including a secret.
4. `plugins.enable(id, true)`, then poll `listPlugins()` until `running`
   (print `pluginLog(id)` on failure).
5. `pluginTools()`, `callPluginTool(id, tool, args)`, `pluginActions(kind)`,
   `runAction(id, action, entity, kind)` — and assert the effect in the store.
6. `enable(id, false)`, `uninstall(id)`.

Run with `pnpm --filter @talaris/core test` (builds, then runs
`dist/test/*.test.js`).

### 13.2 End to end, against a fake

For a plugin that talks to another app, the pattern the Hermes Notes sync
uses:

- **A fake of the other app**: a small in-memory HTTP server answering only
  the routes the plugin uses (for a pkm-interchange app: `GET /interchange`
  with `since`, `PUT` and `PATCH /interchange/objects/<id>`, files), plus a
  couple of test-only routes to change things "over there" and look at them.
- **A real Talaris core of its own**: start `packages/core/dist/src/index.js`
  (build it first: `pnpm --filter @talaris/core build`) with every folder
  sandboxed — `TALARIS_SOCKET` (its own socket), `TALARIS_DATA_DIR`,
  `TALARIS_PROJECTS`, `TALARIS_CONFIG_DIR`, `TALARIS_STATE_DIR`,
  `TALARIS_PLUGINS`, `XDG_STATE_HOME`, `TALARIS_KEY` — and
  `DBUS_SESSION_BUS_ADDRESS=unix:path=/nonexistent` so no real notification
  is shown.
- **Drive it over the socket**: `POST /plugins/install {from}`,
  `PUT /plugins/<id>/settings {values}`, `POST /plugins/<id>/enable {on:true}`,
  then make changes on each side and poll until they arrive on the other.
  `GET /plugins` shows state, status and decisions; `POST
  /plugins/<id>/decide {item, choice, value?}` answers a decision.
- **Unit tests for the pure parts** (pairing, merging, translating) with
  `node --test`, no core at all.

Never point a test at the real Talaris socket or the real other app.

### 13.3 By hand

The plugin is a line-oriented program; you can talk to it directly:

```bash
cd my-plugin
printf '%s\n' \
 '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{"experimental":{"talaris":{"version":1,"settings":{}}}}}}' \
 '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
 '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' | node main.mjs
```

Any `talaris/…` request it makes will go unanswered here; that is the part
the in-process test or the end-to-end harness covers.

---

## 14. Checklist

Manifest

- [ ] `id` matches `^[a-z0-9][a-z0-9-]{1,40}$`; `name`, `version`, `command` set.
- [ ] `command` is an array if it has arguments; it runs from the plugin's
      folder with no install or build step.
- [ ] Every tool the program lists is in `[[tools]]`, and vice versa.
- [ ] `[permissions]` asks for the fewest kinds; `write` only where it writes;
      `notify` only if it notifies; `network`/`files` say honestly what it does.
- [ ] Every credential is a `secret` setting; no secret in an `[[apps]]` url.
- [ ] Every `[[actions]]` `tool` is a declared tool; every `when` names a
      `boolean` setting.
- [ ] `[backup] state` names what a revived Talaris needs to continue.
- [ ] Installed and opened in Settings: what it shows is what you meant.

Process

- [ ] Nothing but JSON-RPC lines on stdout; logs on stderr.
- [ ] Answers `initialize` and `tools/list` within 20 s.
- [ ] Reads settings from `initialize`, replaces them on
      `notifications/talaris/settings_changed`.
- [ ] Creates `TALARIS_PLUGIN_STATE` before writing to it.
- [ ] Exits on stdin end or SIGTERM within 3 s.
- [ ] Survives being restarted at any moment: state written atomically,
      creates idempotent (client-chosen ids).

Data

- [ ] Finds kinds and fields through profiles, never by a type or field name.
- [ ] Writes with `PATCH` naming only what changed; never re-sends a whole
      object.
- [ ] Applies the `object` a write answers with; treats its own echo on the
      feed as a no-op by version; never skips "its own" changes.
- [ ] Treats an error on a `since` read as "read everything again".
- [ ] Its own keys are under its own prefix.

People

- [ ] Tools return `isError: true` with a readable sentence on failure.
- [ ] `readOnlyHint` is `true` only on tools that change nothing.
- [ ] `talaris/status` says something useful ("synced 2 minutes ago").
- [ ] Questions go through `talaris/decide`, with an `edit` choice keyed
      `merge` if it wants written words back from Settings.
