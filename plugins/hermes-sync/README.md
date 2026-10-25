# Hermes Notes sync

A Talaris plugin keeping **tasks, projects, people and notes** in step with
Hermes Notes, through pkm-interchange alone: it reads and writes both apps
through their profiles, and knows neither one's field names. Install it from
this folder (Settings, Plugins), give it Hermes Notes' address and an access
key, and enable it.

**In Hermes Notes first:** mark your types in the type editor's "What this is,
to other apps" — a person, a project — and your task type's project field. A kind no Hermes type declares does not sync, and the plugin says so.

**The first time**, nothing is written until you say so. Things are matched
where that is certain — a project by its name, a person by an address, a task
by its name within a matched project — and
where it is not (two people of one name, no address), you are asked. Then the
plan is put to you: how many matched, how many to make on each side.

**After that**, every few minutes (and on "sync now", from Morgan too):

- **Merge** (the default): a change on one side is carried to the other; a
  change on both, differently, is put to you, side by side, to keep one. A gap
  on one side is filled from the other without asking.
- **Hermes Notes wins** / **Talaris wins**: every difference is made to match
  the winner, and what only the winner has is made on the other side. Asked
  once before it starts deciding that way.
- **Nothing is ever deleted.** Something deleted on one side is asked about:
  make it again on the other, or keep it where it is and stop syncing it.

**What goes where.** Talaris's people go to Hermes Notes only if *People* says
*Everyone* (Talaris keeps whole address books); otherwise the people Hermes
Notes has are matched and kept in step, and new ones come across.

**Events do not sync.** They belong to your calendars, which each app reads
for itself; a copy of a copy, with the calendar's word and each app's edits to
weigh, was more trouble than it was worth.

**Hermes Notes in a window.** While the plugin is enabled, Super+Shift+H (or
"Hermes Notes" in the launcher) opens Hermes Notes in a window of its own,
signed in once and kept; pressed again, it brings that window forward.

**Every five minutes** by default: when nothing has changed, a sync is two
small questions; it reads both libraries only when something has.

**A way back.** Every Talaris thing linked to a Hermes Notes one carries its
address (the format's `url`) as `hermes-sync:link`, and Talaris shows it as
"Open in Hermes Notes" — in Tasks' editor, a person's entry, and a thing's card.

**Sync now, from where you are.** With "Sync now buttons" on (the default), a
person's entry, Tasks' editor, a project's sheet and an undated note have a
Sync with Hermes Notes button, and the tops of People, Tasks and the undated
notes have Sync all with Hermes Notes (each an `[[actions]]` in `plugin.toml`). It runs the ordinary sync — everything that
changed, not only that one thing: a sync of one alone would move the cursor past
what it did not look at. It says Done, what went wrong, or how many decisions
wait in Settings, Plugins.

**Notes**, when the Notes setting says so: Talaris's undated notes (the
Writing drawer's Undated tab, `~/Projects/Notes`) and Hermes Notes' notes —
all of them, or, on either side, only those wearing a tag named in Note tags
(tag a Talaris note in the writing drawer to share it); never a day's
page (a type that declares the format's `journal`, and carries its day). A
note's words travel as its body: Hermes Notes keeps them in the body slot,
Talaris in its Note type's `body` field, and the profiles say which. Where a
note sits among the undated notes is Talaris's alone: Hermes Notes' are flat,
and one made there arrives at the top. A note made in Hermes Notes from
Talaris, in tagged mode, wears the first tag named.

**Daily notes**, when the Daily notes setting is on: Talaris's (Home's, one a
day) and Hermes Notes' daily pages, as the format's `journal` — the page for a
day, its date its identity. Two pages for the same day are paired, never made
twice; a day with no words is not made on the other side (both apps make an
empty page on opening a day). Their words travel as a note's do; a day made in
Hermes Notes is titled as it titles its own ("Sunday, October 25, 2026").
Hermes Notes says it has days only once it has one, so open Today there once.

**Attachments**, on anything whose type keeps files on both sides — the first
field of the format's `attachment` kind, found by its kind and never its name.
They compare as which files (by hash), so a file renamed is the same file. A
file added on one side is handed to the other by its hash first
(`/interchange/files/<sha256>`), then named in the field; a file taken off is
taken off there too, and each side frees a file nothing names any more.

**Tags**, on everything that syncs, as the format writes them: added and
taken off one by one, so a tag one side never knew about is never wiped by
the other's whole list. A Talaris page keeps its tags on the entity that
stands for it, so an undated note's tags are its object's.

**Statuses**, by what they mean. Each app says what each of its statuses
means in the format's five words — not started, in progress, waiting, done,
cancelled (the task profile's `states`): Talaris in Settings, Types; Hermes
Notes in its type editor. Once every status on both sides has a meaning, a
task's status goes across as its meaning, into the other side's status that
means the same. A meaning one side has and the other lacks goes to the
nearest both share — waiting as in progress, cancelled as done — so the two
compare equal rather than trading it back and forth. Until then statuses are
held: only whether a task is done goes across, and the plugin's status line
names the statuses still without a meaning. The first time statuses go by
meaning, a pair that differs only because one side could not say more
before keeps the more particular one.

**In a Talaris backup**: its settings (never the access key, which stays in
this machine's keyring and is typed again after reviving) and its state — which
Talaris thing is which Hermes Notes one, and what each pair last agreed on
(`[backup]` in `plugin.toml`). Revived, the sync picks up where it left off
rather than matching everything again.

**Not yet:** a task's notes (the format's `task` profile has no body slot),
archiving (the binding has no way to write it), and an organization kept as a
thing of its own (carried only where both sides keep it as words).

Tests: `npm test` — the plan on made-up libraries, then the whole thing end to
end against a fake Hermes Notes and a Talaris core of its own.
