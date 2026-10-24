# The Tasks panel's page — the contract between its parts

Three files own three parts; none edits another's.

| Part | Files | Global it defines |
|---|---|---|
| Shell, list view, task editor, quick add | `tasks.html`, `tasks.js` | `Tasks` |
| List editor and query builder | `listeditor.js`, `listeditor.css` | `ListEditor`, `QueryBuilder` |
| Table, board, matrix and calendar views | `taskviews.js`, `taskviews.css` | `TaskViews` |

`tasks.html` loads, in order: `tokens.css`, `theme.css`, `controls.css`, `listeditor.css`, `taskviews.css`,
then `qrc:///qtwebchannel/qwebchannel.js`, `icons.js`, `surface.js`, `motion.js`, `listeditor.js`, `taskviews.js`, `tasks.js`.

## `Tasks` (tasks.js) — what the others may call

- `Tasks.api(method, path, body?) → Promise<data>` — the core, through the bridge. Rejects with an Error whose message is the core's.
- `Tasks.taskType` — the task type: `{id, name, fields: [{key, kind, options?, "talaris:labels"?, "talaris:colors"?, startLabel?, endLabel?, targetType?, many?}], profiles}`.
- `Tasks.status(value) → {label, color}` — a status option's words and color.
- `Tasks.projects` — `[{id, title, archived?, workspace?, group?, description?}]`. `group` is `talaris:group` on the project's entity: the side column's own arrangement, no meaning outside this page.
- `Tasks.openTask(id)` — opens the task editor on that task.
- `Tasks.update(id, patch) → Promise` — `PATCH /entities/:id` with `{properties?, tags?}`; refreshes the view after.
- `Tasks.setStatus(id, value) → Promise` — sets the status (completing a recurring task brings its next).
- `Tasks.refresh()` — reloads what is on show.
- `Tasks.newTask({title, start?, due?, status?, projects?, list?, region?}) → Promise` — `POST /tasks`.

## The core's answers (all JSON)

- `GET /lists` → `List[]`; `GET /lists/:id` → `Shown`; `GET /tasks/projects/:id` → `Shown` (a project's tasks).
- `POST /lists` `{name, kind?, query?, materialized?, order?, placement?, bind?, view?}` → `List`.
- `PATCH /lists/:id` `{name?, kind?, query? (null = manual), materialized?, order? (null = manual order), placement?, bind?, view?, archived?, position?: {after?, before?}}` → `List`.
- `DELETE /lists/:id` (only when archived). `POST /lists/:id/refresh` (a snapshot, filled again).
- `POST /lists/:id/members` `{object, region?, after?, before?}` — add or move; on a board `region` *is* the status; on a matrix entering a region does its `talaris:enter`.
- `DELETE /lists/:id/members/:object`.
- `POST /lists/preview` `{query}` → `{count, rows: [{id, title, kinds}]}` (first 50).
- `GET /tasks/types` → `{type, shape}`; `POST /tasks`; `PATCH /entities/:id`; `GET /entities/:id` → `{entity, title, kinds, out, in}`.
- `GET /tasks/:id/recurrence` → `{rule, summary}`; `PUT /tasks/:id/recurrence` `{rule | null}`.
- `GET /entities?q=&kind=` → `[{id, title, kinds}]` (for pickers).

`List`:
```
{ id, name, kind: "list"|"table"|"board"|"matrix"|"calendar",
  membership: {mode:"explicit"} | {mode:"query", materialized: bool, query: Condition},
  members: [{object, position, region?}],
  placement?: {semantic: true, regions: (string | {name, label?, "talaris:color"?, "talaris:enter"?: {tag?, status?, untagOnLeave?}})[], "talaris:columns"?: number},
  order?: {sort?: [{by: {field, part?: "start"|"end"} | {meta: "type"|"created"|"updated"}, direction?: "ascending"|"descending"}], groupBy?: <same key>},
  archived?, "talaris:bind"?: "status", "talaris:view"?: {...}, "talaris:starter"? }
```
`Shown` = `{ list, rows: Row[], drawer?: Row[], groups?: [{key, label, rows: [id]}], manual: bool }` — `manual` false means the order is not the user's (a live query, or a sort): no dragging to reorder.

`Row` = `{ id, title, kinds, type?, status?, complete?, start?, due?, doneAt?, overdue?, projects?: [{id,title}], tags?, recurring?, body?, region?, position, fields }`.

`Condition` (a query is always a group at the top):
```
{kind:"group", match:"all"|"any", items:[Condition...]}         nested without limit
{kind:"profile", profile:"task"|"note"|"contact"|"event"|"project", op?:"is"|"isNot"}
{kind:"type", typeId, op?}
{kind:"created"|"edited", op:"before"|"after", date}             date: YYYY-MM-DD, today, today+N, today-N, now
{kind:"tag", tag, op?:"include"|"exclude"}
{kind:"property", key, op:"eq"|"neq"|"contains"|"lt"|"gt"|"empty"|"notEmpty", value?}
     key: a field key, or "schedule.start" / "schedule.end" for a datespan's halves; "title" works too
     reference fields (project) take "contains" with a project id
{kind:"state", value:"open"|"complete"}
{kind:"text", value}
{kind:"hasAttachment", has: bool}
```

## Look and words

Talaris's own: tokens.css colors (`--surface`, `--paper`, `--line`, `--frame`, `--text`, `--muted`, `--accent`, `--accent-wash`, `--danger`), controls.css classes (`t-btn`, `icon-btn`, `seg`, `switch`, `menu`, `menu-item`), the theme's font. Labels are terse — a word or two; no instructions in menus or cards. Dates shown short ("Oct 27", "Today", "Tomorrow", a weekday within the week). Never decide what something is by a type's name: by `kinds` and by the type's fields. No native `<select>`, date or color inputs — they break in layer-shell panels; build pickers in the page.
