# pkm-interchange, for an implementer

A guide to the pkm-interchange format for a coding agent implementing it — as
a **producer** (exporting), a **consumer** (importing), or a **live binding**
(answering reads and writes) — and to how Talaris implements it.

**Format version: `pkm-interchange/0`.** The version is the one integer in
the envelope's `format`. Additive changes do not bump it, so features have
been added to version 0 since it was first written (task `states`, task
`body`, `archived` on a patch, files by hash, and others); the round-trip rule
is what makes that safe.

**This is a distillation, not the specification.** The specification lives
in the Hermes Notes repository and is authoritative:

| upstream | what it owns |
|---|---|
| [`AGENTS.md`](https://github.com/jpmoo/hermesnotes/blob/main/pkm-interchange/AGENTS.md) | the specification (a wire-format spec written to be handed to an agent — reference, not instructions) |
| [`fixtures/`](https://github.com/jpmoo/hermesnotes/tree/main/pkm-interchange/fixtures) | **authoritative**: where prose and a fixture disagree, the fixture is right |
| [`fixtures/README.md`](https://github.com/jpmoo/hermesnotes/blob/main/pkm-interchange/fixtures/README.md) | the case grammar, the adapter operations, the error codes |
| [`README.md`](https://github.com/jpmoo/hermesnotes/blob/main/pkm-interchange/README.md) | the human introduction, with a worked round trip |
| [`LIMITS.md`](https://github.com/jpmoo/hermesnotes/blob/main/pkm-interchange/LIMITS.md) | what real clients needed and the format could not say; its `## Open` section is the live list |
| [`check/`](https://github.com/jpmoo/hermesnotes/tree/main/pkm-interchange/check) | `pkm-check`: the validator, the fixture runner, the live probe |
| [`example/library.json`](https://github.com/jpmoo/hermesnotes/blob/main/pkm-interchange/example/library.json) | one complete, valid export to pattern-match |

Upstream root: <https://github.com/jpmoo/hermesnotes/tree/main/pkm-interchange>.
On this machine it is also at `~/Documents/Scripts/hermesnotes/pkm-interchange`,
which is where Talaris's tests and `measure` look for it by default.

Each section below says which upstream section it summarizes. Where this
summary is shorter than the spec — which is most places — read the spec
section before implementing it. Where this document and a fixture disagree,
the fixture is right.

---

## 1. The idea in two rules

(AGENTS.md, *The two rules everything else follows from*.)

1. **The data declares its own meaning.** A consumer never needs to know what
   a producer's types or fields are called. A type says *I am task-like, and
   my due date is in this field*. `if (type.name === "Task")` is always a bug.
2. **A view never smuggles in meaning.** Where a card sits on a canvas is
   furniture; where it sits in an Eisenhower matrix is a judgment. The
   producer must say which, because a consumer cannot tell by looking.

Everything else is these two applied to a case.

### Roles

(README.md, *Who is the producer, and who is the consumer?*.) One app usually
plays all three:

| role | does |
|---|---|
| producer | writes an envelope (an export, or the answer to a read) |
| consumer | reads one, keeps what it cannot model, reports what it lost |
| operator | serves a live binding: capabilities, reads, partial writes, a change feed |

### Levels

(AGENTS.md, *Levels*.) A ladder, earned **per role**, and claimed as three
numbers, never one:

| level | name | takes |
|---|---|---|
| 0 | Readable | a valid envelope with types and objects |
| 1 | Legible | profiles on types; no name-guessing |
| 2 | Faithful | round-trip: unknown fields, ids, flags, relation types survive |
| 3 | Honest | loud failure: fidelity reported; manifest matches behavior |
| 4 | Operable | a live surface: patch semantics, capability discovery, a change feed |

The level earned is the highest with nothing failing beneath it, **derived
from a fixture run**, never written by hand (§12).

---

## 2. The envelope

(AGENTS.md, *Envelope*, *Identity*.)

```json
{
  "format": "pkm-interchange/0",
  "producer": { "name": "talaris", "version": "0.1.0", "stableIds": true },
  "conformance": {
    "produce": 1, "consume": 1, "operate": 4,
    "bindings": ["file", "http"],
    "profiles": ["contact", "event", "note", "task", "project"],
    "features": ["relations", "attachments", "attachment-files"],
    "unsupported": ["hierarchy"]
  },
  "types": [],
  "objects": [],
  "collections": [],
  "series": [],
  "relations": [],
  "findings": []
}
```

| key | meaning |
|---|---|
| `format` | `pkm-interchange/<n>`; anything else is `envelope.format` |
| `producer` | `{name, version, stableIds?}`. Ids are stable across exports only if `stableIds: true`. |
| `conformance` | the manifest: what the producer implements (below) |
| `types`, `objects`, `collections`, `series`, `relations` | all optional; `types` + `objects` alone is valid |
| `findings` | what the producer could not express. **Not named in AGENTS.md**, but `pkm-check` reads top-level `findings` (or `reports`) for its "says what it could not express" check, and `example/library.json`, Hermes and Talaris all emit it — present and empty is itself the statement "nothing lost" |
| `cursor`, `changes` | on a live read only (§10) |

**Identity.** Every object, type, collection and series has an `id`: a string,
unique within the export, **opaque** — do not parse it, do not assume a UUID.

**Every object's `type` must name a type declared in the same document.**
This holds for every read, including narrowed ones (AGENTS.md, *`profile` —
what kind*).

### The manifest

| key | meaning |
|---|---|
| `produce`, `consume`, `operate` | the level claimed for each role. Omitting a role while claiming a level is `conformance.missing-roles`. |
| `bindings` | `file`, `http`, `mcp`, or later ones. Claiming `operate` > 0 with only `file` is `conformance.binding-required`. |
| `profiles` | a **claim about scope**: which profiles your types declare, and so what you are measured on. Not how anything is read (README.md, *One warning about that sample*). |
| `features` | what the data uses. Data using a feature the manifest omits is `conformance.undeclared-feature`. |
| `unsupported` | what you do not implement. Saying so is the mechanism working, not a failure. |

Feature names the validator detects in data (`check/src/validate.js`), plus
those the spec defines as claims:

| feature | present when |
|---|---|
| `series` | `series` is non-empty |
| `relations` | `relations` is non-empty |
| `placement` | a collection has `placement` |
| `derivations` | a collection's `membership.mode` is `query` |
| `ordering` | a collection's `order` has `sort` or `groupBy` |
| `hierarchy` | an object has `parent` |
| `attachments` | an attachment value or field exists |
| `attachment-bytes` | an attachment carries non-empty `bytes` |
| `attachment-files` | (claim) the live binding serves `/interchange/files/<sha256>` |
| `addresses` | (claim) objects carry `url` |

---

## 3. Whose key is it

(AGENTS.md, *Whose name is that key?*.)

**Unprefixed keys belong to the format. A producer's own go under a prefix it
controls.** This applies to structural objects — the envelope, a type, a
field, a collection, a region, a member, an object's top level:

```json
{ "id": "o_1", "type": "t_task", "properties": { … },
  "hermes:id": "blk_9", "talaris:sources": [ … ] }
```

| prefix | owner |
|---|---|
| `hermes:` | Hermes Notes |
| `talaris:` | Talaris (e.g. `talaris:role`, `talaris:label`, `talaris:labels`, `talaris:colors`, `talaris:defaultStatus`, `talaris:link`, `talaris:missing`) |
| `<plugin-id>:` | a Talaris plugin's own keys (e.g. the Hermes Notes sync's `hermes-sync:link`) |

The carve-outs:

- **An object's `properties` are not in this namespace.** They are keyed by
  the type's declared fields and are data — `properties.deadline` is not an
  extension. (Undeclared properties are still unknown fields and still
  survive.)
- **A collection's `properties` are not that carve-out and must be
  prefixed**, because a collection has no type to declare them. Writing an
  unprefixed one is refused with `collection.unprefixed-write`.
- **A member's `context` bag is unprefixed and opaque**, because it is
  furniture that is never compared between producers.

A consumer preserves prefixed and unprefixed keys alike.

---

## 4. Unknown fields and loud failure

(AGENTS.md, *Unknown fields*, *Loud failure*; `fixtures/roundtrip.json`.)

**Any property a consumer does not recognize MUST survive a round trip
byte-identical** — not normalized, reordered or coerced. This holds in an
export, in an import, and at write time (a patch leaves everything it does
not name). The reliable way to implement it is to **hold the original and
overlay your model on it**, never to decompose into your own columns and
reassemble (`check/README.md`; `check/src/reference.js` does this).

**A consumer that meets something it cannot represent MUST report it, and
MUST NOT silently coerce.** Import either preserves the semantics, preserves
the data opaquely and reports `reduced` fidelity, or fails.

Every import and every write answers:

```json
{ "fidelity": "full" | "reduced", "reports": ["<code>", …] }
```

`reduced` with an empty `reports` is a failed case — an unexplained warning
trains people to ignore warnings (`fixtures/README.md`).

**An empty string is not a value.** Producers omit rather than store `""`;
consumers read `""` as absent (AGENTS.md, *Value kinds*).

---

## 5. Types and fields

(AGENTS.md, *Types (L1)*, *Value kinds*, *Attachments*; `fixtures/values.json`,
`fixtures/attachments.json`.)

```json
{
  "id": "t_task",
  "name": "Task",
  "fields": [
    { "key": "title",  "kind": "text", "required": true },
    { "key": "dates",  "kind": "datespan", "startLabel": "Available", "endLabel": "Due" },
    { "key": "status", "kind": "enum", "options": ["todo", "doing", "done", "dropped"] },
    { "key": "owner",  "kind": "reference", "targetType": "t_person" },
    { "key": "project","kind": "reference", "targetType": "t_project", "many": true }
  ],
  "profiles": { "task": { "title": "title", "status": "status",
                          "completeValues": ["done", "dropped"],
                          "start": { "field": "dates", "part": "start" },
                          "due":   { "field": "dates", "part": "end" },
                          "project": "project" } }
}
```

Types are user data: a person can rename a type or a field. Never key
behavior on `name` or `key` — read through profiles.

### Value kinds

`text` · `richtext` · `number` · `boolean` · `url` · `date` · `datetime` ·
`datespan` · `enum` · `reference` · `attachment`

| kind | value |
|---|---|
| `date` | `YYYY-MM-DD` |
| `datetime` | `YYYY-MM-DDTHH:mm`, optional `timezone` (IANA) on the field |
| `datespan` | `{start?, end?}`; labels are the producer's (`startLabel`, `endLabel`) — never assume "Start"/"Due" |
| `enum` | one of the field's `options` |
| `reference` | an object id; `targetType` names the type it accepts |
| `attachment` | see below |

- **The list is open.** An unknown kind is carried and treated as opaque; the
  field is never dropped.
- **No recurrence kind.** Recurrence is a series (§9).
- **`many: true`** says the value is a list; a `many` field holds a list and a
  single field does not (`value.cardinality`). A consumer that can hold only
  one may take the first and **must report `reduced`**.

### Attachments

```json
{ "kind": "attachment", "filename": "notes.pdf", "mediaType": "application/pdf",
  "sha256": "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
  "bytes": "<base64>" }
```

- `filename` is the only required key. `mediaType` is an optional label.
- **The hash is the identity**, the filename a label. `sha256` is 64 lowercase
  hex (`attachment.hash-malformed`).
- `bytes` (base64) is optional; `bytes` without `sha256` is invalid
  (`attachment.hash-missing`); `"bytes": ""` is invalid
  (`attachment.bytes-empty`) — omit instead.
- A value with `sha256` and no `bytes` is a **known-missing** file. A consumer
  must not store it as "no attachment"; it reports `reduced`.
- A consumer that keeps bytes **must verify them against the hash**; a
  mismatch fails.
- Two features: `attachments` (values travel), `attachment-bytes` (files
  travel inline). Over the live binding, `attachment-files` (§10.6).

---

## 6. Profiles

(AGENTS.md, *Profiles*, *The page for a date*; `fixtures/profile.json`,
`fixtures/journal.json`.)

A profile maps the producer's own fields onto a shared vocabulary. A type may
declare several, or none (then consumers read its fields generically and do
not guess).

**v0 profiles:** `task`, `event`, `contact`, `note`, `journal`, `project`.

| profile | slots |
|---|---|
| `task` | `title`, `status`, `completeValues` (a list of values), `states` (a map of values), `start`, `due`, `project`, `body` |
| `event` | `title`, `start`, `end`, `location`, `attendees`, `organizer`, `body` |
| `contact` | `title`, `email`, `phone`, `organization`, `role`, `body` |
| `note` | `title`, `body` |
| `journal` | `date` |
| `project` | `title`, `body` |

**A slot** names one of the type's fields by key, or half of a datespan as
`{ "field": "dates", "part": "start" | "end" }`. **Every slot is optional**; a
slot left out means the producer does not have it — never "look for something
like it".

**A mapping must land.** A slot naming a field the type does not declare is
`profile.field-not-declared`. Exempt: list/map values (`completeValues`,
`states`), the `field` inside a part reference (checked as the field), and
`content` (§7). Profiles outside v0 are carried, not checked.

**Reading a slot** — the whole consumer mechanism (README.md, *What a consumer
receives*):

```js
const type = typeById.get(object.type);
const task = type.profiles?.task;
if (!task) return;                                 // not a task; don't guess
const title = object.properties[task.title];
const dueSlot = task.due;                          // "due" or {field, part}
const due = typeof dueSlot === "string"
  ? object.properties[dueSlot]
  : object.properties[dueSlot.field]?.[dueSlot.part];
const done = (task.completeValues ?? []).includes(object.properties[task.status]);
```

A slot named `content` reads the object's `content`, not a property.

### Rules per slot

- **References.** `task.project`, `event.attendees` and `event.organizer` must
  name a `reference` field (`profile.slot-not-a-reference`). A target is a
  person when its type declares `contact`, a project when it declares
  `project`; otherwise it is read generically.
- **`email`, `phone`** may name a `many` field.
- **`organization`** names a `text` field or a `reference` to an organization
  object; read whichever.
- **`body`** may name `content`, on any profile that has it — a task's too.
- **`project` is a thing, not a list.** A type whose objects are the work
  itself. A list of tasks someone keeps is a collection.

### What a status means: `states`

```json
"task": { "status": "status", "completeValues": ["done", "dropped"],
          "states": { "todo": "not-started", "doing": "in-progress", "on hold": "waiting",
                      "done": "done", "dropped": "cancelled" } }
```

Five states, no others: `not-started`, `in-progress`, `waiting`, `done`,
`cancelled`. Rules (`validate`):

- a key of `states` is one of the status field's `options`
  (`profile.state-not-an-option`);
- a value is one of the five (`profile.state-unknown`);
- the options mapped to `done` or `cancelled` are exactly `completeValues`
  (`profile.state-contradicts-complete`).

An option with no state is allowed and means "not declared"; never guess one
from its name. To carry a status to another tool, use **that tool's first
option with the same state**. LIMITS.md (*A status could say finished…*) adds
what this asks of a sync: carry a status only once both sides have given
every option a state; until then carry only finished-or-not.

### The page for a date: `journal`

```json
"profiles": { "note": { "title": "title", "body": "content" },
              "journal": { "date": "on" } }
```

`date` names the field holding the day (`YYYY-MM-DD`). A journal type is
usually a `note` as well. One page per day is expected; a consumer finding
several for one date must not pick one silently — it reports
`journal.duplicate`. Finding "the page for 2026-08-25" is looking, not a query.

---

## 7. Objects

(AGENTS.md, *Objects*, *Where a thing lives*, *Containment*; `fixtures/address.json`.)

```json
{
  "id": "o_412",
  "type": "t_task",
  "properties": { "title": "Weekly review", "status": "todo",
                  "dates": { "start": "2026-08-25", "end": "2026-08-26" } },
  "content": "The body, if the producer keeps one outside the fields.",
  "tags": ["admin"],
  "archived": false,
  "created": "2026-08-19T15:55:06Z",
  "updated": "2026-08-19T15:55:06Z",
  "version": 7,
  "url": "https://notes.example/block/o_412"
}
```

| key | meaning |
|---|---|
| `id`, `type` | opaque id; `type` names a type in the same document |
| `properties` | keyed by the type's field keys |
| `content` | the reserved body slot, outside the property bag. A profile names it as `"body": "content"`. |
| `tags` | strings, shared across types; compared byte-wise. A tag is not a link. |
| `archived` | hidden from normal views, not deleted. A consumer without the concept **preserves the flag**. Collections carry it too. |
| `created`, `updated` | timestamps |
| `version` | opaque; compare for equality only. If you version, **reads must carry it** (§10.8). |
| `url` | an absolute address where a person can see it. Opaque: never rewrite it, never synthesize one, never build one from a template. Declared as `addresses`. |
| `parent`, `position` | containment (below) |
| `stub`, `suggests` | a name written before its thing exists (§8) |

**Containment** (L2; `fixtures/hierarchy.json`). `parent` is the id of the
object this one is inside; `position` orders siblings and is an **opaque
token compared byte-wise** — never parsed as a number, never regenerated on
import. A cycle is `hierarchy.cycle`. A `parent` that names nothing in the
document (common in a `since` delta) is treated as a root for now, never
dropped and never given a placeholder. Flattening an outline is allowed and is
`reduced` fidelity reporting `hierarchy`; keep `parent` and `position`
anyway.

---

## 8. Relations, inline mentions, stubs

(AGENTS.md, *Relations*, *A link is a link*, *A name that isn't a thing yet*,
*Inline references*; `fixtures/inline.json`.)

Two mechanisms:

- **Declared references**: `reference` fields with a `targetType`. Not
  repeated in `relations`.
- **Ad-hoc edges** in `relations`:

```json
{ "from": "o_1", "to": "o_2", "type": "mentions", "via": "inline", "field": "body" }
```

| key | rule |
|---|---|
| `from`, `to` | `to` is required (`relation.no-target`) |
| `type` | a free string; no vocabulary. Preserve types you do not understand. |
| `via` | `"inline"` (written in prose), `"edge"` (drawn, e.g. on a canvas), absent = unspecified |
| `field` | for `via: "inline"`: the field it was found in; **must be a field the type declares** (`inline.field-not-declared`) |

A link says only "this points at that". Do not copy the target's type, title
or existence onto the edge; a render hint must be named as one
(`targetTitleHint`, never `title`).

**Inline references.** Prose is opaque and survives byte-identical; no markup
dialect is standardized. A producer whose prose contains references **must**
mirror each into `relations` with `via: "inline"` and `field`. A consumer
**must not** drop those edges, and a consumer that rewrites prose without
guaranteeing the mentions survive **must** report `reduced`.

**Open limit** (LIMITS.md, *A mention in `content` cannot say where it was
found*): a body kept in `content` cannot be named as an inline edge's `field`,
because `content` is not a declared field. Until the format accepts it,
declare the body as a field (as Talaris does) if your prose carries mentions.

**Stubs.** A name written before its thing exists is an object with an id, a
name and no type:

```json
{ "id": "o_roofer", "stub": true, "properties": { "title": "the roofer" }, "suggests": "contact" }
```

`suggests` names a **profile**, not a type id (`stub.suggests-not-a-profile`).
When the stub becomes real it keeps its id — `stub` comes off, a type goes on —
so every link to it is already right. The client mints the id at the moment of
writing. Text never picked from a picker is text, not a link.

---

## 9. Series, collections, order, derivations

These are summarized briefly; Talaris's live binding does not carry series
over a narrowed read, and implements collections only partly. Read the spec
sections before implementing any of them.

**Series** (AGENTS.md, *Series — recurrence*; `fixtures/recurrence.json`).
Recurrence is an object; instances are real objects listed in `instances`.

```json
{ "id": "s_review",
  "rule": { "anchor": "schedule", "freq": "weekly", "interval": 1, "byWeekday": ["WE"],
            "end": { "type": "never" }, "monthEnd": "skip" },
  "horizon": 4, "instances": ["o_410", "o_411", "o_412"] }
```

`anchor` is `schedule` or `completion`; with `completion`, `horizon` must be 1
(`series.completion-horizon`) and `byWeekday` is meaningless
(`series.completion-byweekday`). `end` is `{type: never}`, `{type: after,
count}` (counted from `instances`) or `{type: on, date}`. Monthly and yearly
rules **must** declare `monthEnd` (`skip` | `clamp`) and `byMonthDay`
(`series.month-end-required`, `series.month-day-required`). Say `clamp` if
you clamp.

**Collections and placement** (AGENTS.md, *Collections and placement*;
`fixtures/placement.json`). A collection has `id`, `name`, `kind` (a rendering
hint), `placement`, `membership`, `members`, optional `order`, `archived`,
`url`, and prefixed `properties`.

- `placement.semantic: true`: a member's `region` is a judgment; dropping it
  is `reduced`. Regions are names, never coordinates; a region is a string or
  `{name, label, …}` (`name` is matched, `label` is display, other keys
  travel).
- `semantic: false`: placement is furniture, in a member's `context` bag;
  discardable. A member with `context` in a semantic collection is invalid
  (`placement.coordinates-not-semantic`).
- A member is `{object, region?, position?, context?}`; a bare id is legal
  shorthand and expanding it is not a loss.

**Order** (AGENTS.md, *The order a collection is shown in*;
`fixtures/sort.json`). `order: {sort?: [{by, direction?}], groupBy?: by}`.
`by` is `{field}`, `{field, part}`, or `{meta: "type" | "created" |
"updated"}` (`order.by-invalid`). `sort` present means stored `position` is
not authoritative; absent, `position` is the truth. Missing values sort last
in both directions; values compare byte-wise unless both are numbers; ties
fall through to the next key and then to `position`. `{meta: "type"}` groups by
type id and sorts by type name. Losing a sort or grouping reports
`order.sort` / `order.grouping`.

**Derivations** (AGENTS.md, *Derivations*; `fixtures/derivation.json`).
`membership: {mode: "explicit"}` — `members` is the truth. `{mode: "query",
materialized: false, query}` — the query is the truth and `members` is a
snapshot **of the query's answer** only; importing it as explicit must be
reported. `materialized: true` — the members are fixed and are the truth.
`query` travels opaquely; there is no shared query language.

---

## 10. The live binding

(AGENTS.md, *The live binding (L4)* and all its subsections;
`fixtures/operational.json`, `create.json`, `tags.json`, `content.json`,
`archive.json`, `files.json`, `membership.json`.)

Same vocabulary as the file, carried over a live surface. `bindings` names
which: `http` (below), `mcp`, or later ones. The spec fixes HTTP paths; it
does not fix MCP tool names.

### 10.1 Routes

Relative to a base the producer chooses (Hermes Notes serves them under its
API base; Talaris at the root of its socket):

| verb | path | does |
|---|---|---|
| `GET` | `/conformance` | the manifest, with `bindings` — ask before writing |
| `GET` | `/interchange` | the library as an envelope, with `cursor` |
| `GET` | `/interchange?since=<cursor>` | what changed, with `changes` |
| `GET` | `/interchange?profile=<p>` | objects whose type declares `<p>` |
| `GET` | `/interchange?q=<words>` | objects matching, most relevant first |
| `GET` | `/interchange/collections/<id>` | one collection, membership evaluated now |
| `PUT` | `/interchange/objects/<id>` | create at a client-chosen id; never edits |
| `PATCH` | `/interchange/objects/<id>` | partial write; never creates |
| `PUT` | `/interchange/files/<sha256>` | hand over a file's raw bytes |
| `GET` / `HEAD` | `/interchange/files/<sha256>` | the bytes / whether held |
| `PUT` | `/interchange/collections/<c>/members/<o>` | add a membership; never edits |
| `PATCH` | `/interchange/collections/<c>/members/<o>` | move it (`region`, `context`) |
| `DELETE` | `/interchange/collections/<c>/members/<o>` | remove the membership; object untouched |
| `PUT` | `/interchange/collections/<c>` | make a collection; never edits |
| `PATCH` | `/interchange/collections/<c>` | write the collection's prefixed `properties` |

AGENTS.md's *Making a collection* shows `PUT <base>/collections/c_scratch`,
without `/interchange`; Hermes Notes' routes (and Talaris's plugin route) use
`/interchange/collections/<c>`, as every other collection write does. Use the
`/interchange/…` form.

### 10.2 Reading

A read returns **a whole envelope**, never a bare array. Every read carries a
top-level **`cursor`**: opaque — not a timestamp, not an integer to add to.

**`since`** answers only what moved, plus `changes`:

```json
{ "cursor": "1013", "objects": [ { "id": "o_1", … } ],
  "changes": [ { "seq": 1004, "object": "o_1", "op": "update", "cause": "membership" },
               { "seq": 1011, "object": "o_7", "op": "delete" } ] }
```

- **Deletions MUST appear in `changes`.** Absence is not deletion.
- **A producer that cannot answer a cursor MUST say so** — HTTP `410 Gone` —
  so the client re-reads in full. Never return the changes it happens to
  still hold.
- **`op` describes the object**, never a storage row: a membership, tag or
  placement removed is an `update` to the object (`changes.child-op`).
  `cause` (optional) says which part moved.
- **The last row about an object is the current one, in both directions** —
  a delete followed by an update means it exists.

**`profile`** narrows to objects whose type declares it. **A narrowed answer
is still whole**: every type an included object points at travels with it.
Narrowing is permission to send less, never an obligation.

**`q`** is free text matched however the producer matches. Order is the
answer (most relevant first); **no scores**. A producer that cannot search
**must refuse** rather than answer unfiltered — the one narrowing that inverts.
(No fixture op; `pkm-check --url` checks it.)

**`GET /interchange/collections/<id>`** evaluates membership at the moment it
is asked — the only way to keep a computed collection current, since a task
falling into a date range today changed nothing a feed would carry. It does
not make the query authoritative. A producer that cannot re-evaluate answers
404 or 405; a consumer falls back to its snapshot without reporting an error.

### 10.3 Creating: `PUT /interchange/objects/<id>`

```json
{ "type": "t_task", "properties": { "title": "Bleed the radiators" } }
```

- **The client chooses the id.** That is what makes creation idempotent.
- **A `PUT` at an existing id MUST NOT modify it**; it answers success with
  `created: false` and the object as it stands. Over HTTP: `201` made, `200`
  already existed.
- The body may carry `id`; if it differs from the address, refuse
  (`create.id-mismatch`).
- A `type` the producer does not have must be reported, never silently
  invented (`create.unknown-type`).
- Unknown properties in the body survive (`create/unknown-properties-survive`).
- A producer that cannot honour a supplied id must say so.

### 10.4 Patching: `PATCH /interchange/objects/<id>`

```json
{ "set": { "status": "done" }, "unset": ["owner"],
  "addTags": ["urgent"], "removeTags": ["someday"],
  "content": "The whole new body.",
  "archived": true,
  "version": 7 }
```

| key | rule |
|---|---|
| `set` | these properties take these values |
| `unset` | these properties are removed. **The only way to remove a value** — not `null`, not an absent key. `"content"` in `unset` removes the body, never a property of that name. |
| *(anything not named)* | **untouched** — including every property the server has never heard of |
| `addTags`, `removeTags` | one by one; adding one present or removing one absent is a success; **the same tag in both MUST be refused** (`tags.added-and-removed`). `set` cannot reach tags. |
| `content` | beside `set`, not inside it; replaces the body whole; not named → untouched. A producer that keeps no body answers `content.not-kept`, `reduced`. A field *called* `content` is a property, reached through `set`. |
| `archived` | beside `set`, a boolean: `true` files away, `false` brings back; not named → untouched (`fixtures/archive.json`) |
| `version` | if you version, a stale one **MUST be refused, not merged** — `ok: false, conflict: true` — and nothing changes, body and archive flag included |

### 10.5 Every write answers for itself

```json
{ "ok": true, "fidelity": "full", "reports": [], "cursor": "1014",
  "object": { "id": "o_1", "version": 8, … } }
{ "ok": true, "fidelity": "reduced", "reports": ["series.anchor"] }
{ "ok": false, "conflict": true, "reports": [] }
```

`object` is the object **as it now stands, including what the producer did
that the client did not ask for** (a completion time stamped, a next
occurrence spawned); `cursor` is where the write landed. Refusals use the same
shape. A bare `ok` is not an answer.

### 10.6 Files

```
PUT  <base>/interchange/files/<sha256>   raw bytes
GET  <base>/interchange/files/<sha256>   raw bytes, or 404 + file.not-held
HEAD <base>/interchange/files/<sha256>   whether held
```

- **The address is the hash.** Bytes that do not hash to it are refused
  (`file.hash-mismatch`). A put of a file already held is a success.
- A `GET` of a file not held is `404` with `file.not-held` — never an empty
  body.
- **Attaching is a patch**: put the file, then `set` the field to `{kind:
  "attachment", filename, mediaType?, sha256}` with no `bytes`. A hash the
  producer does not hold is accepted as known-missing and reported
  `attachment.known-missing`.
- **There is no `DELETE`.** Removing is taking the value out of the field; the
  producer may free a file nothing names.
- Declared as `attachment-files`.

### 10.7 Collection writes

(AGENTS.md, *Writing a placement*, *Adding and removing a member*, *Making a
collection*, *Writing a collection's own keys*.)

- **Member `PATCH`** body: `{region}` (a declared region, or `null` — still a
  member, nowhere in particular), `{context: {…}}` (merged; only on a
  non-semantic collection), `{unset: [keys]}` (removes `context` keys). An
  undeclared region is refused (`placement.region-not-declared`); `context` on
  a semantic collection is refused (`placement.coordinates-not-semantic`).
- **Member `PUT`** takes the same body; at an existing membership it changes
  nothing. **`DELETE`** of a membership that is not there is a success.
- **Collection `PUT`** creates at the client's id and never edits
  (`created: false` if present); unprefixed `properties` are refused
  (`collection.unprefixed-write`); members in the body are refused
  (`collection.members-are-a-separate-write`) — add them one by one.
- **Collection `PATCH`** writes `properties` only, by `set`/`unset`, prefixed
  keys only; `kind`, `placement`, `members` are unreachable through it.
- If you version collections or memberships, reads must carry the version, and
  the compare must be part of the write (one atomic operation).

### 10.8 A follower that also writes

(AGENTS.md, *A follower that also writes*.) A client that mirrors a producer
and writes to it will see its own writes come back down the feed. Make the
echo harmless; do not filter it:

1. **Objects carry `version` on every read** if writes accept one.
2. **Apply the `object` a write answers with.** Then the echo carries a
   version you already hold.
3. **Applying a change twice is a no-op** (by version, or by comparing
   content).
4. **Choose ids when creating**, so retries and echoes land on the same id.
5. **Never skip a change because you caused it** (`origin` may be logged,
   never used to decide). A write can do more than you asked.

### 10.9 Capabilities

`GET /conformance` answers the manifest before a client writes. It is a promise
about behavior: `operate` claimed with only `file` is
`conformance.binding-required`.

---

## 11. Known limits of v0

(AGENTS.md, *Known limits of v0*; LIMITS.md.)

- `placement.semantic` is one flag per collection; some boards mix kinds of
  region.
- A sort key names one field; "title, or else the first line of the body"
  cannot be said.
- A canvas holds things that are not objects (sticky notes, drawn
  connections); they travel as prefixed collection `properties` and cannot be
  addressed from outside.
- Open in LIMITS.md: an inline mention in `content` cannot name its field
  (§8).

Read LIMITS.md before proposing a format change: closed entries keep the
reasoning for how each was answered.

---

## 12. Conformance: the checker, the fixtures, the manifest

(AGENTS.md, *Checking yourself*; README.md, *Checking yourself*;
`fixtures/README.md`; `check/README.md`.)

### 12.1 `pkm-check`

From the upstream folder (`node check/src/cli.js …`) or as `npx pkm-check`:

| command | does |
|---|---|
| `pkm-check <export.json>` | validates one file, scores **producing** only (0 or 1 — levels 2+ are not visible in a file), and names the next step |
| `pkm-check --url <base> [--token <t>]` | read-only probe of a live server: `GET <base>/conformance` (roles present, live binding if `operate` > 0), then with a token (`Authorization: Bearer`) `GET <base>/interchange`: valid, features used are declared, `unsupported` not contradicted, types declare profiles, `findings` present |
| `pkm-check --self` | the whole fixture suite against the reference adapter (`check/src/reference.js`) |

### 12.2 The fixture suite

`fixtures/*.json`, one suite per file, each case:

```json
{ "id": "placement/semantic-must-survive", "level": 2, "op": "import",
  "given": { … }, "with": { "placement": false },
  "expect": { "fidelity": "reduced", … }, "why": "…" }
```

| key | meaning |
|---|---|
| `op` | which adapter operation (closed list below) |
| `given`, `when` | the input; an event for ops that have one |
| `with` | the simulated consumer's capabilities (`placement: false`, `query: false`, `relations: false`, `archive: false`, `attachments: false`, `series: {anchors}`, `conditions`, `profiles`, `richtext: false`, `richtextRewrite: true`, `fixedSchema: true`, `remapIds: true`, `sorting: false`, `grouping: false`, `hierarchy: false`) |
| `expect` | matched as a **subset** — except `patch`, `create`, `place`, `collectionPatch`, `collectionCreate` property bags, matched **exactly**; `expect.object.content` matched exactly, `null` meaning no body |
| `of` | which part `expect.result` is about: `envelope`, `object`, `collection` |
| `requires` | features/profiles the case is about; an implementation that did not declare them is not asked |
| `simulated` | depends on the consumer *lacking* something; a real tool that has it gets n/a, not a failure |
| `roles` | which role it is evidence for (defaulted from `op`) |
| `level` | the rung |
| `why` | the failure the case prevents — **read it before patching** |

At the time of writing the suite has 189 cases (`pkm-check --self`: 186
passing, 3 n/a, every role at level 4 for the reference adapter).

### 12.3 The adapter operations

Implement those your role covers and hand the object to the runner. **Missing
counts as failing.**

| op | given | answers |
|---|---|---|
| `validate` | `export` or a fragment | `{valid, errors: [{code, path}]}` |
| `profilesOf` | `type` | the v0 profile names it declares |
| `read` | `type`, `object`, `args.key` | one profile value |
| `isComplete` | `type`, `object` | boolean |
| `order` | `collection`, `objects`, `types` | ids in order, or `{groups: [{key, members}]}` when grouped |
| `outline` | `objects` | roots in order, `{id, children}` nested |
| `journal` | `types`, `objects`, `args.date` | that day's page id, or null |
| `nextOccurrence` | `series`, `instance`, `when` | `{start?, due?}` or null |
| `import` | `export`, `with` | `{result, fidelity, reports}` |
| `roundtrip` | `export`, `with` | import, serialize, compare |
| `create` | `object`, `existing?`, `args.at?` | `{ok, created, object, fidelity, reports}` |
| `patch` | `object`, `patch`, `with` | `{ok, conflict?, object, fidelity, reports}` |
| `place` | `collection`, `member`, `patch` | `{ok, conflict?, member, fidelity, reports}` |
| `member` | `collection`, `args.object`, `args.op` (`put`/`delete`), `patch?` | `{ok, created?, removed?, member?, reports}` |
| `collectionPatch` | `collection`, `patch` | `{ok, conflict?, collection, fidelity, reports}` |
| `collectionCreate` | `collection`, `existing?`, `args.at?` | `{ok, created, collection, fidelity, reports}` |
| `follow` | `feed` | `{alive, gone}` |
| `file` | `held` (hash → base64), `args.op` (`put`/`get`), `args.sha256`, `args.bytes?` | `{ok, created?, bytes?, reports}` |

The upstream prose variously says "ten" (`cli.js --help`) or "eleven"
(AGENTS.md, README.md, `check/README.md`) operations; the table in
`fixtures/README.md`, reproduced above, lists eighteen and is the one the
runner uses.

```js
import { runSuites, levelsFrom } from "<pkm-interchange>/check/src/runner.js";
const results = runSuites(myAdapter, "<pkm-interchange>/fixtures");
const { roles } = levelsFrom(results);   // { produce, consume, operate }
```

### 12.4 Error and report codes

Validation (`errors[].code`) and writes (`reports`) share codes where the rule
is the same. From `fixtures/README.md`:

| code | rule |
|---|---|
| `envelope.format` | `format` present but not `pkm-interchange/<n>` |
| `value.cardinality` | `many` field holding a scalar, or a single field holding a list |
| `profile.field-not-declared` | a v0 profile slot naming an undeclared field |
| `profile.slot-not-a-reference` | `task.project`, `event.attendees`/`organizer` not a `reference` |
| `profile.state-not-an-option` / `profile.state-unknown` / `profile.state-contradicts-complete` | the `states` rules (§6) |
| `inline.field-not-declared` | an inline edge's `field` not declared |
| `relation.no-target` | an edge with no `to` |
| `stub.suggests-not-a-profile` | `suggests` naming a type id |
| `placement.coordinates-not-semantic` | coordinates/`context` on semantic placement |
| `order.by-invalid` / `order.direction-invalid` | bad sort/group key or direction |
| `hierarchy.cycle` | an object its own ancestor |
| `collection.member-not-carried` | a collection answered alone, naming members it did not send |
| `series.completion-horizon` / `series.completion-byweekday` / `series.month-end-required` / `series.month-day-required` | series rules (§9) |
| `changes.child-op` | a child row's op reported as the object's |
| `conformance.missing-roles` / `conformance.binding-required` / `conformance.undeclared-feature` | manifest rules (§2) |
| `attachment.hash-missing` / `attachment.hash-malformed` / `attachment.bytes-empty` | attachment rules (§5) |
| write-only: `placement.region-not-declared`, `collection.unprefixed-write`, `tags.added-and-removed`, `content.not-kept`, `file.hash-mismatch`, `file.not-held` | |

Other codes used in prose and fixtures: `create.id-mismatch`,
`create.unknown-type`, `collection.members-are-a-separate-write`,
`attachment.known-missing`, `journal.duplicate`, `order.sort`,
`order.grouping`.

### 12.5 The manifest is checked, not written

A claim is what the suite earned. Hermes holds its claim in
`packages/interchange/src/conformance.ts` and `pnpm --filter
@hermes/interchange measure` fails the build if the claim exceeds the run.
Talaris does the same (§13.5). Never raise a level by hand.

---

## 13. How Talaris implements it

Talaris's entity store **is** pkm-interchange: every person, event, note,
task and project is an interchange object; its kind is its type's profile;
Talaris's own keys go under `talaris:` (DESIGN.md, *Entities*). The
implementation is Talaris's own reading of the spec, written without Hermes'
code, because two independent implementations agreeing is what makes the
format prove anything.

### 13.1 Files

| file | holds |
|---|---|
| `packages/core/src/interchange.ts` | `FORMAT`, `MANIFEST`, `LIVE_MANIFEST`; `exportEnvelope`, `importEnvelope`, `readEnvelope`; the pure rules `applyPatch`, `createRule`, `fileRule`, `follow`; the store writes `createObject`, `patchObject`, `putInterchangeFile`, `getInterchangeFile`; collection writes `writeMember`, `makeCollection`, `defineCollection` |
| `packages/core/src/feed.ts` | the change feed and cursor |
| `packages/core/src/profile.ts` | reading slots (`readSlot`, `isCompleteBy`) |
| `packages/core/src/server.ts` | the HTTP routes on the core's socket |
| `packages/core/src/plugins.ts` | the same binding for plugins, held to their manifests (`interchangeFor`) |
| `packages/core/src/measure.ts` | the fixture run |
| `packages/core/src/entities.ts` | the built-in types and their profiles |

### 13.2 The manifests

```ts
MANIFEST      = { produce: 1, consume: 1, operate: 0, bindings: ["file"],
                  profiles: ["contact","event","note","task","project"],
                  features: ["relations","attachments"], unsupported: ["hierarchy"] }
LIVE_MANIFEST = { ...MANIFEST, operate: 4, bindings: ["file","http"],
                  features: [...MANIFEST.features, "attachment-files"] }
```

`exportEnvelope` adds features as the data bears them out: `attachment-bytes`
when bytes are inlined, `series` when tasks repeat, `placement`,
`derivations`, `ordering` from its lists. `liveManifest()` adds `series` when
any series exists. `producer` is `{name: "talaris", version: "0.1.0",
stableIds: true}`.

Built-in types' profiles (`entities.ts`): person `contact`; event `event`;
task `task` (its `body` is its `description` field; `states` is not built in
but given per status in Settings → Types, Edit statuses); note `note` (its
body a declared `body` field, not `content`, because of the open limit in
§8); project `project`; daily note `note` + `journal`; file — no profile
(the format has no kind for a file). The manifest's `profiles` does not list
`journal`, though the daily-note type declares it.

### 13.3 Routes on the socket

The core serves HTTP on a Unix socket: `$TALARIS_SOCKET`, or
`$XDG_RUNTIME_DIR/talaris.sock`. No token; the socket is private to the user.

| route | Talaris answers |
|---|---|
| `GET /conformance` | `{format: "pkm-interchange/0", …liveManifest()}` |
| `GET /interchange[?since&profile&q]` | `readEnvelope`: whole envelope with `conformance` (live), `cursor`, and with `since` the last change row per object in `changes`. A narrowed read keeps every type and drops `series`. |
| `PUT /interchange/objects/:id` | `201` made, `200` existed, `422` `create.unknown-type`, `400` other refusals |
| `PATCH /interchange/objects/:id` | `200`, `409` stale version, `400` other refusals, `404` no such object |
| `PUT /interchange/files/:sha` | raw bytes; `201` new, `200` held, `422` `file.hash-mismatch` |
| `GET` / `HEAD /interchange/files/:sha` | raw bytes, or `404` with `{ok: false, reports: ["file.not-held"]}` |
| `GET /interchange/export` | Talaris's own: the whole store as a file export (`exportEnvelope()`), lists included |

**The cursor** is `<era>.<seq>` (opaque to clients). The era changes when the
store is replaced (a backup revived); a cursor from another era or from before
what the feed keeps is answered **410 Gone**.

**Not served on the socket**: `GET /interchange/collections/<id>`, and every
collection write. Lists travel in the file export. Collection reads
(`?collections=1`) and member, create-collection and definition writes exist
only for plugins (PLUGINS.md §7).

### 13.4 What a write does beyond the rule

`createObject` and `patchObject` apply the pure rule first, then do what the
same action does anywhere in Talaris, so the answer's `object` may differ from
what was sent:

- **A project** (a type declaring `project`) created through the binding is a
  real project — a folder and a workspace — named from its title; no title is
  `create.project-needs-a-name`. Patching its title renames the project.
- **A day's page** (a type declaring `journal`, with a date) is that day's
  daily note; a second for the same day is refused `journal.duplicate`.
- **An undated note** (a type declaring `note`, not `task`) is a Markdown file
  among Home's Pages; its title and body live in the file, other properties on
  the entity. Edits to the file in another editor are reconciled before every
  read and patch.
- **A task** patched to complete stamps its time and spawns the next
  occurrence of its series, as Tasks does.
- **Attachments in a write**: inline `bytes` are stored and dropped from the
  value (the hash says which); a hash not held is kept as known-missing and
  reported. A file named by a field before a patch and not after is freed if
  nothing else names it. A file Talaris *links* (on disk, `talaris:link`)
  stays a link when a sync writes the same hash back.
- `content.not-kept` is never reported: Talaris keeps bodies.

Collection writes (plugins only) differ from the spec in their report codes:
an undeclared region is `placement.unknown-region: …` (spec:
`placement.region-not-declared`), and **any** `context` is refused as
`placement.context-on-semantic: …` (Talaris keeps no furniture placement);
codes carry a `: explanation` suffix.

### 13.5 Measured, not claimed

- `pnpm --filter @talaris/core measure` runs the upstream fixtures (from
  `$PKM_SPEC`, default `~/Documents/Scripts/hermesnotes/pkm-interchange`)
  against Talaris's own functions for the ops `profilesOf`, `read`,
  `isComplete`, `patch`, `create`, `follow`, `file`, and **exits non-zero if
  `LIVE_MANIFEST.operate` exceeds what the run earned**. Other ops are
  reported as not measured, not failed.
- `packages/core/test/entities.test.ts`: unknown keys survive in the store
  and through the format; an export (with bytes) imports back with no
  findings and re-exports identical; a tampered file fails the import and
  changes nothing; and `pkm-check` (from `$PKM_CHECK`, skipped if absent)
  scores the export with no FAIL and `produce: level 1`.

### 13.6 Reaching it from a plugin

A plugin reaches the same binding through `talaris/interchange` over its MCP
connection, narrowed to the kinds its manifest may read and write, with files
as base64 inside the JSON and errors as JSON-RPC errors rather than HTTP
statuses. See [`PLUGINS.md`](PLUGINS.md) §7.

---

## 14. Implementing it: checklists

### Producer (levels 0–1)

- [ ] `format: "pkm-interchange/0"`, `producer`, `conformance` with all three
      roles, `types`, `objects`, `findings` (even empty).
- [ ] Every object's `type` is declared in the document.
- [ ] Each type declares the profiles it is; every slot lands on a declared
      field (or `content`, or a part of a datespan).
- [ ] Dates `YYYY-MM-DD`, datetimes `YYYY-MM-DDTHH:mm`; no `""` values;
      `many` fields hold lists.
- [ ] Your own keys under your prefix; collection `properties` prefixed.
- [ ] Inline mentions mirrored into `relations` with `via: "inline"` and a
      declared `field`.
- [ ] Monthly/yearly series declare `monthEnd` and `byMonthDay`.
- [ ] `features` lists every feature the data uses; `pkm-check export.json`
      shows no FAIL.

### Consumer (levels 1–3)

- [ ] Read only through profiles; a type with no profile is read generically.
- [ ] Hold the original document and overlay your model; re-export unknown
      fields byte-identical.
- [ ] Preserve `archived`, `parent`/`position`, relation types, `via: inline`
      edges, stubs, `url`, prefixed keys.
- [ ] Report `reduced` with a code for every loss (`many` → one, flattened
      outline, dropped region, query frozen to explicit, known-missing file,
      lost sort or grouping); never `reduced` without a code.
- [ ] Verify attachment bytes against `sha256`.

### Live binding (level 4)

- [ ] `GET /conformance`; `GET /interchange` with `cursor`, `since` (deletes
      in `changes`, object-level `op`, last row wins, 410 when it cannot
      answer), `profile` (types travel), `q` (refuse if you cannot search).
- [ ] Reads carry `version` if writes accept it.
- [ ] `PUT` creates at the client's id, never edits, refuses id mismatch,
      reports unknown types.
- [ ] `PATCH`: `set`/`unset`, tags one by one, `content`, `archived`,
      stale `version` refused whole; everything unnamed untouched.
- [ ] Every write answers `{ok, fidelity, reports, object, cursor}`.
- [ ] Files by hash: hash checked, repeat put succeeds, `file.not-held`, no
      `DELETE`.
- [ ] Run the fixtures through your adapter and derive the manifest from the
      run.

### A client that syncs two producers

- [ ] Ask `/conformance` on both before writing.
- [ ] Follow each side's cursor; on 410 (or its equivalent), read in full.
- [ ] Apply each write's returned `object`; treat echoes as no-ops by
      version; never skip "your own" changes.
- [ ] Carry a task's status by `states` only when both sides declare a state
      for every option; otherwise only finished-or-not.
- [ ] Move files by hash: put to the side that lacks it, then patch.
