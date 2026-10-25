# Hermes Notes sync

A Talaris plugin keeping **tasks, projects and people** in step with
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

**A way back.** Every Talaris thing linked to a Hermes Notes one carries its
address (the format's `url`) as `hermes-sync:link`, and Talaris shows it as
"Open in Hermes Notes" — in Tasks' editor, a person's entry, and a thing's card.

**Not yet:** attachments (the format has no slot naming the field that holds
them, and the live binding no way to hand over one file), a task's notes (the format's `task` profile has no body slot),
archiving (the binding has no way to write it), and an organization kept as a
thing of its own (carried only where both sides keep it as words).

Tests: `npm test` — the plan on made-up libraries, then the whole thing end to
end against a fake Hermes Notes and a Talaris core of its own.
