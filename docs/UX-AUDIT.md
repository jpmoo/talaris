# Talaris — UX audit (2026-11-26)

A senior UI/UX read of everything the person sees: `surfaces/ui/` (bar, dock,
launcher, popups, notifications, Settings, every panel, the shared cards and kit)
and the web layer (`packages/web/src/public/`). Method: the design intent in
DESIGN.md and WEB.md, the screenshots in `docs/screenshots/`, the code, and the
web version live in a browser at desktop (1280–1400 px) and phone (375 px) sizes.
Recommendations only; nothing was changed.

*Since then:* the Top 10 were built on 2026-11-26, and the rest on 2026-11-27.
Each item outside the Top 10 ends with what was **Done**, or what is
**Proposed** for a decision where doing it would change how the desktop is used
day to day. A few parts are owed in `filespanel.js`, which other work was changing
at the time; each says so where it falls.

## Summary

**Strongest**

- **A real system underneath.** `tokens.css` / `controls.css` / `kit.css` and
  `kit.js` give one pop-up, one menu, one month picker, one "ask twice", one
  search box, one drag. Most pages use them. Few personal projects get this far.
- **Asking twice** (`Kit.ask`) is consistent and well worded ("Delete it?",
  "Move it to the trash?", "Take 3 shortcuts away?"), and it says what the second
  press will do.
- **One card per thing** (`thingcard.js`, `taskcard.js`, `eventcard.js`) is the
  right information architecture. It is what makes the Library a hub.
- **Calm, coherent dark look.** Mostly gray with one accent, thin rules, small
  labels: on the desktop it reads as one product.

**Weakest**

- **The phone.** People has no phone layout at all, and Calendar leaves about
  three hours of grid under four rows of header. Each module gets "back to the
  list" in a different way, all touch targets are under 44 px, and the promised
  New (+) is missing.
- **Losing work by accident.** New clears its form every time it opens. Panels
  close on a click outside, and some close themselves after 45 seconds untouched.
  "+ Task" and "+ Person" make real records named "New task" and "New person"
  before you type anything. The event card's Cancel throws edits away without
  asking.
- **Accessibility.** There is almost no ARIA. Icon-only bar buttons lose their
  name when hovered (`tips.js` deletes the `title`). The focus ring is 1 px. Rows
  are `div`s. Line contrast is 1.45:1. In light mode the accent is used as text
  at 2.5:1.
- **Words.** Notes, the writing surface and pages all name one thing. Files names
  three things. Glance names three things. Archive names two.
- **Type scale.** 19 distinct font sizes, from 9 px to 28 px, nine of them
  between 9 and 13.5 px.

---

## 1. Data safety and feedback

### 1.1 New loses everything typed when it closes — **high / small**
**Seen.** `new.js:822-828`. On every open (`s.up && !was.up`), `reset()` sets
`v = {}` (`new.js:564`). New closes on a press outside it, on Escape, or after
5 minutes untouched (`new_panel.py:98`). A half-written task with a project,
dates and notes is gone with one stray click.
**Why.** New is the most-used way of capturing things. Capture has to be the
safest flow in the product.
**Do.** Keep `v` and `kind` across close and open. Clear them only after "Make"
succeeds or after an explicit "Clear". If you want a fresh form by default, show
a "Restore what you were writing" line when a draft exists.

### 1.2 "+ Task" and "+ Person" create records before you name them — **high / small**
**Seen.** `tasks.js:697-713` POSTs `{ title: "New task" }`, then opens it.
`people.js:824` does the same with "New person". On the live web Tasks page, the
Inbox held a stray "New task" left behind exactly this way.
**Why.** Abandoned placeholders pile up, sync to every machine, and show in search
and in Glance.
**Do.** Open an unsaved card and create the record on the first real title. Or
delete the record when the card closes with the placeholder title unchanged. One
helper in the kit should serve both panels.

### 1.3 Panels close themselves after inconsistent idle times — **high / small**
**Seen.** Notes and Canvas close after 45 s with no input (`config.py:144`,
`workspace.py:83`). The launcher and Jump close after 1 min, Settings after 3,
Calendar, New and Morgan after 5, Library, Tasks, People, Glance and Archive
after 10, and Weekly review after 30. Settings › Panels › "Put away" says it
applies to panels but only sets the drawers' value (`settings.html:405-409`).
Only Morgan defines `busy()`.
**Why.** Reading a long page is "no input". 45 s is short enough to close a page
while you are reading it, and the person cannot predict which panel will stay up.
**Do.** Use one idle value for every panel, with "Never" as an option and a
default of several minutes. Never put a panel away while a field has focus, a
draft exists (1.1), or a card is unsaved (1.4). Implement that as a shared
`busy()` that asks the page. Make the Settings text describe what the setting
actually does.

### 1.4 The event card mixes two save models and discards silently — **medium / small**
**Seen.** `eventcard.js` saves projects and notes immediately (`:312`, `:455`).
Everything else waits for Save (`:589`), and Cancel calls `ctx.close` with no
check (`:588`). Task and person cards save every field as it changes. All three
cards look the same.
**Why.** After a task card, people expect autosave. On an event card they lose
their changes.
**Do.** Track whether the card has unsaved changes. Show "Unsaved changes" beside
Save. Make Cancel, close and click-outside ask "Discard changes?" with `Kit.ask`.
`shot.js:450` already has the wording.

### 1.5 No undo after a destructive act — **medium / medium**
**Seen.** Every `Kit.ask` is a four-second second press, then the act happens.
Examples: "Delete {list} and the lists in it?" (`listeditor.js`), "Delete it for
good?" (`filespanel.js`), "Make them one?" (merge).
**Why.** Asking twice stops slips but not mistakes. Merges and nested deletes are
the expensive ones.
**Do.** After a delete, archive or merge, show a toast with an Undo button
(`Kit.say` plus one action) for about 8 s. Merges have `rememberMerge`, so check
whether the core can reverse one. If it cannot, keep asking twice and add the
number of affected items to the question.

### 1.6 Messages are cut to one line — **low / small**
**Seen.** `.kit-msg` is `white-space: nowrap; text-overflow: ellipsis`
(`kit.css:47`). Errors from the core pass straight through `failed(e) =>
say(e.message, true)` (e.g. `review.js:34`).
**Do.** Let an error wrap to two lines, or show the full text in a tip on hover
and on focus. Map the common core errors (offline, not found, conflict) to plain
sentences.
**Done (2026-11-27).** `Kit.say` says an error through `Kit.plain` (not answering,
signed out, not there any more, changed elsewhere, too large, the core's 5xx) and
keeps the core's own words in its tip, reachable by Tab; `kit.css` lets an error
take two lines wherever a page put its line.

---

## 2. Consistency

### 2.1 What one thing is called — **high / small (words) to medium (code)**
| Concept | Names seen |
|---|---|
| Written pages | bar "Notes" (`bar.html:195`); Keys "The writing surface" (`surfaces.py:1014`); Settings "the writing surface" (`settings.html:405`); New's kind "Note" (`new.js:41`); Library type "Pages"; empty state "No pages yet"; footer "New page"; "Open in Notes" (`filespanel.js:814`). DESIGN *Pages, not notes* says a page is a page everywhere. |
| Files | the system file manager ("This project's folder, in Files", `filespanel.html:225`); a tab inside the Library (Overview · Suggestions · Files); each project's `Files/` folder; the Library's old name. |
| Glance | its own window; the "List · Glance" toggle inside the Library; a button on cards; Super+Shift+G. |
| Archive | archived projects (a launcher-only panel); the "Archives" file type (zip files) in the Library sidebar; "Archive it?" on lists. |
| Card | "Open its card", "See its card", "A card", against DESIGN's "card is kept for what is placed on a canvas" (*People, not cards*) and its later "everything has a card in the Library". |

**Do.** Settle a glossary and enforce it the way `check-look.mjs` enforces
colors (a string lint):
- The module is **Notes** and holds **pages**. New's kind becomes "Page", and the
  Keys page reads "Notes".
- **Files** means only the folder or tab. Call the system app "the file manager"
  ("Open folder" already does).
- Rename the file type to **Compressed** or **Zip**.
- Use **Graph** for the in-Library toggle, so **Glance** means only "open this
  thing's glance".
- Update DESIGN's *People, not cards* paragraph.

### 2.2 Panel headers are laid out differently — **medium / medium**
**Seen.**
- Search sits next to the title in the Library, People, Archive and Glance
  (`filespanel.html:217`, `people.html:118`, `archive.html:78`). It sits at the
  right, before the actions, in Tasks and Calendar (`tasks.html:147`,
  `calendar.html:173`).
- Placeholders vary: "Find", "Find tasks", "Find events and tasks", "Find in the
  archive".
- The create button varies: "+ Task", "+ Person", "New event" (no +), "Add…"
  (Library), "Make" (New).
- The grow button's tip is "Full screen" in Calendar, "Make this the desktop" in
  Notes and Canvas, and empty elsewhere.
- Library and People wrap grow and close in `.corner`; Tasks, Calendar, Review
  and Archive do not.
- The title is the panel name in some panels, the current project in Tasks, and
  a date range in Calendar.

**Why.** Every panel needs its own scan to find search, new and close. DESIGN's
own rule says a control that differs from its neighbor is a bug.
**Do.** Add one header component to the kit, in this order: [side toggle] Title ·
count · context | search ("Find in {panel}") | view controls | primary create
("New task" / "New person" / "New event" / "Add files") | grow · close. Give grow
a single tip ("Open as a window").

### 2.3 Primary looks the same as "on" — **medium / small**
**Seen.** `controls.css:120-122` gives `.t-btn.on` and `.t-btn.primary` the same
rule. The web login page uses a solid accent fill instead (`login.html`).
**Why.** "Make", "Save" and "Done — mark the review task complete" cannot be told
apart from a toggled filter beside them.
**Do.** Make `.primary` a filled accent with dark text, as the login page already
does. Keep `.on` as the wash. One extra rule.

### 2.4 Weekly review breaks the shared patterns — **medium / small**
**Seen.** `review.js:100-103` uses plain `↑`, `↓`, "Edit" and `✕` buttons
instead of `Kit.draggable` and `.x-btn`. Taking a step out of every week's
template happens on one press with no `Kit.ask`. The controls appear only on
hover (`review.html:58`). WEB.md says the order is set by dragging.
**Do.** Use `Kit.draggable` for order and `.x-btn` for removal. Use `Kit.twice`
with "Remove from every week?" for template steps; this-week-only steps can stay
one press.
**Done (2026-11-27).** Steps are put in order with `Kit.draggable` and the one
drop line; the × is the `.x-btn`, faded rather than hidden (Tab reaches it) and
always shown under a finger; an every-week step asks "Remove from every week?";
a step's words are changed by pressing them.

### 2.5 Dates are formatted outside the kit — **low / small**
**Seen.** The kit is meant to word dates one way, but about 12 places format their
own with `toLocaleDateString("en-US", …)`: `calendar.js:129,132,474,537`,
`taskviews.js:711,731`, `filespanel.js:166`, `popup.js:491`, `archive.js:51`,
`drawer.js:987`, `new.js:224`. `settings.js:2114` uses a bare `toLocaleString()`,
so the format follows the machine's locale, unlike everything else. Calendar's
docs screenshot shows a hyphen in the range; the code uses an en dash.
**Do.** Add `Kit.range(a, b)`, `Kit.dayName(d, style)` and `Kit.monthName` and
route these through them. Add a `check-look` rule against `toLocale*String(` in
pages.
**Done (2026-11-27).** `Kit.range` ("Nov 2 – 8, 2026"), `Kit.fullDay`,
`Kit.dayName`, `Kit.monthName`, and `Kit.day` with a long weekday, a long month
or the year always. Every page's dates go through them (Settings' import time
too, no longer the machine's locale), and `check-look` fails on a page's own
`toLocaleDateString` or `toLocaleTimeString`. Two exceptions: the bar's clock,
which keeps the shape Settings gives it (marked `look:`), and `filespanel.js`'s
day headings, owed (it was being changed by other work; the rule names it).

### 2.6 The look check is failing, and the web layer is not checked — **medium / small**
**Seen.** `node surfaces/check-look.mjs` reports 44 hand-written values today: 21
colors, 9 corners, 5 weights over 500, 4 shadows, 4 accent tints and 1 z-index.
The most are in `shot.html`, `morgan/index.html`, `drawer.html`, `surface.js`
and `notify.html`. `packages/web/src/public/web.css` and `login.html` are not
checked at all. They carry their own palette (`#24282c`, `#9aa1a8`, `#e6e8ea`,
which do not match the tokens `#222528`, `#868c92`, `#d5d9dc`), weight 600, and
radii of 9 and 14 px. Morgan uses a second icon set (a Tabler font,
`morgan/index.html:48`) instead of `icons.js`.
**Do.** Fix the 44 or mark them with `look:`. Add the web folder to the check.
Have login load `tokens.css` and the shipped fonts: today the login page names
Barlow without an `@font-face`, so it falls back to the system font. Move
Morgan's glyphs into `icons.js`.

### 2.7 Keyboard shortcuts are uneven and hard to find — **medium / small**
**Seen.** Bar tips show keys for Ask, New, Canvas and Notes (`bar.html:188-195`).
Tasks, People, Library, Calendar, Weekly review and Glance have no key, or none
shown; Glance's is Super+Shift+G, which appears only on the Keys page. In the
launcher, Shift+Enter means "Glance" for things (only in a row's hover tip,
`launcher.js:397`) and "go there" for apps (`:540`). The footer hint mentions
neither (`launcher.html:77`). New's Ctrl+1–5 appear only in tips. Inside panels,
keyboard support varies: People and the Library list have arrow keys; Tasks,
Calendar, Glance and a Library project have none (`grep ArrowDown`).
**Do.** Give every bar panel a Super+Shift key (T, P, L, K for calendar, R for
review) and show it in each tip and on the Keys page. Make the launcher footer
change with the selected row ("Enter open · Shift+Enter glance"). Bring arrow
keys and Enter to every list through one `Kit.listNav`.
**Done (2026-11-27).** Super+Shift+T Tasks, P People, L Library, K calendar, R
weekly review (`surfaces.py`, `PANEL_KEYS`), in the bar's tips and on the Keys
page. The launcher's footer follows the row chosen ("Shift+Enter Glance", "Shift+Enter
go there"). `Kit.listNav` (↑ ↓ Home End Enter, one Tab stop at the chosen row) on
Tasks' side and rows, Calendar's agenda and Glance's list. The Library's project
view is `filespanel.js`'s and still to do.

---

## 3. Accessibility

### 3.1 Controls have no accessible names or roles — **high / medium**
**Seen.**
- No `aria-*` in any `.html`, and almost none in the `.js` files (editor aside).
- Bar buttons are icon-only with `title`. `tips.js:26-29` *removes* the `title`
  on hover, so after the first hover the button has no name.
- Switches are empty `<button class="switch">` elements; their label is a sibling
  span (`settings.html:415-417`).
- Library, Tasks and People rows are `div`s. The browser reports them as
  "generic" (seen live), so Tab cannot reach them.

**Why.** Screen readers and voice control (including Morgan, if it ever drives the
UI) cannot name or press these. Keyboard users cannot reach rows.
**Do.**
- In `tips.js`, copy the title to `aria-label` before removing it.
- Make `Kit` switches `role="switch"` with `aria-checked`, labelled by their row.
- Give list rows `role="option"` inside a `role="listbox"` with `tabindex`
  roving (with 2.7's `Kit.listNav`).
- Give `.seg` `role="radiogroup"`.

### 3.2 Focus is barely visible — **high / small**
**Seen.** `theme.css:29` uses `:focus-visible { outline: 1px solid var(--accent);
outline-offset: 1px }`. Fields drop the outline for an accent border
(`controls.css:236`), and menu items have no focus state of their own.
`thingcard.css:58` shows the × on `:focus-visible`, but the button is
`visibility: hidden` until then, and a hidden element cannot take focus, so the
fallback never works.
**Do.** Use a 2 px outline with a 2 px offset, plus `.menu-item:focus-visible` the
same as `.hot`. Hide hover-only controls with `opacity: 0` (still focusable), not
`visibility: hidden`, and show them on `:focus-within` of the row.

### 3.3 Contrast — **high / small**
Measured with WCAG 2.x formulas from `tokens.css`:

| Pair | Ratio | Needs |
|---|---|---|
| `--line` on `--surface` (button and field borders), dark and light | **1.45** | 3.0 for a control's edge |
| default accent `#c98a5b` as text on light `--surface` (hover, `.on`, `.seg .on`, links, selected tab) | **2.48** | 4.5 |
| `--warn` on light surface | **1.98** | 3.0 |
| `--danger` on light surface | **3.22** | 4.5 |
| `--muted` on light `--desk` | 3.54 | 4.5 |
| `--muted` on dark `--paper` (cards), used for 10 px `.label` | 4.25 | 4.5 (and 10 px needs more) |
| the light green accent offered in Settings (`#b4dca8`, docs screenshot) on light surface | **1.31** | 4.5 |

Then `.menu-item.off` uses `--muted` *and* `opacity: .45` (`controls.css:183`),
and Settings › Panels › Opacity goes down to 30 % over the wallpaper
(`settings.html:412`). Contrast there is whatever the wallpaper allows.
**Why.** Light mode is where it fails. Every selected thing and every hover is
drawn in the accent.
**Do.**
- Derive an `--accent-text` per mode: `color-mix` the accent toward `--text`
  until it reaches 4.5:1 on `--surface`, computed once in `surface.js` when the
  accent is set. Use it for text and keep `--accent` for fills and lines.
- Raise `--line` to about 3:1, or keep the hairline for rules only and give
  controls a `--control-edge`.
- Darken light-mode `--warn` and `--danger`.
- Floor panel opacity at about 70 % unless the compositor blur is on.

### 3.4 Small text — **medium / medium**
**Seen.** 19 font sizes (`grep font-size`): 12 px (102 uses), 13, 12.5, 10, 11,
11.5, 15, 14, 10.5, 16, 9, 17, 13.5, 9.5, 28, 26, 24, 18. The uppercase,
letter-spaced `.label` is 10 px, and 9 and 9.5 px appear in Morgan and in fold
carets. DESIGN asks for "one type scale".
**Do.** Add type tokens: `--t-xs 11`, `--t-sm 12`, `--t-md 13.5`, `--t-lg 16`,
`--t-xl 20`, `--t-2xl 26`. Fail `check-look` on any other `font-size`. Raise
`.label` to 11 px; at 2 px letter-spacing it still reads as small. Offer an
interface scale in Settings › Look and feel if there is not one already.

### 3.5 Reduced motion is only partly honored — **low / small**
**Seen.** `motion.js`, `dock.js`, `bar.js`, `notify.html` and `glanceview.js`
check `prefers-reduced-motion`. Several CSS transitions do not: the phone drawers
in `web.css:28,31`, `--dur` hovers, and the countdown bars.
**Do.** Add one global `@media (prefers-reduced-motion: reduce) { :root { --dur:
0s } }` and use `--dur` in `web.css` too.
**Done (2026-11-27).** In `tokens.css`, which every page and the web load:
`--dur: 0s`, and every CSS transition and animation all but instant (a hundredth
of a millisecond, so `animationend` still comes). The web's own motion was
already on `--dur`.

---

## 4. The phone and the web

### 4.1 People has no phone layout — **high / medium**
**Seen.** Live at 375 px, People is the desktop's two columns squeezed together.
The list takes about two thirds, and the card is a strip of field labels cut off
at the right edge. `web.css` has rules for `page-library`, `page-tasks`,
`page-calendar`, `page-notes` and `page-canvas`, and none for `page-people`.
**Do.** Copy the Library pattern: the list alone, a pressed person's card over
everything with Back.

### 4.2 Each module gets back to the list differently — **high / medium**
**Seen.**
- Library: a "Projects" button on its own row, with "‹ Back" placed inside the
  card (`phone.js:24-33`).
- Notes and Canvas: "‹ Back" fixed at the *top right* (`web.css:70`), plus the
  side-toggle icon at the bottom left, which drawerphone.js redefines as "switch
  panes".
- Tasks and Calendar: the desktop's side-toggle icon only.

All of this works by listening for clicks on desktop DOM, with `setTimeout`s of
60–120 ms and selector guesses such as `.node, .row, li, .item, .name,
[data-path], [data-id]` (`drawerphone.js:35`).
**Why.** Every module needs to be learned separately, and any redraw on the
desktop page can break it without anyone noticing.
**Do.** Add one phone shell in `modules.js`: a top app bar with Back on the left
and the title in the middle, a "list | detail" state, and the browser's history
(`pushState`) so the system back gesture works. Have each page *declare* its
list, detail and side elements (data attributes) instead of having them guessed.

### 4.3 Touch targets are under 44 px — **high / small**
**Seen.** Measured live: buttons are about 24 px tall, icon buttons 33 px, rows
33 px, and the `.x-btn` about 21 px, even after the global `zoom: 1.18`
(`web.css:17`). Hover-only controls are made visible for a handful of selectors
(`web.css:79-92`), but the card's × on each connection or chip
(`thingcard.css:58`) and the review's step controls are missed.
**Do.** Under `@media (pointer: coarse)`, set `--control: 44px`, put
`min-height: 44px` on rows, `.t-btn` and `.seg button`, and give `.x-btn` a
32 px hit area. Then drop the `zoom` hack, which also changes `100vh` math and
`getBoundingClientRect` in ways each page has to correct for. Make every
hover-only control visible under `(hover: none)` with a single rule.

### 4.4 Calendar on a phone — **high / medium**
**Seen.** Live at 375 px:
- The header wraps to four rows (side, Today, prev/next; title; search; Day ·
  3 days · Week · Month, sync, New event).
- The task strip then takes about 40 % of the height, with chips cut to six
  characters ("Come ba…").
- About three hours of grid are left.
- WEB.md says the web's calendars are read-only, but the sync button ("Sync
  again: accounts and feeds") is still offered.

**Do.** Default the phone to an **agenda list**: days as headings, events and
then tasks, nothing cut off. Fold search into an icon. Collapse the task strip
into a "7 tasks" row that expands. On the web, label the account calendars
"Read only · from {machine}, {time}", which WEB.md already promises, and hide
sync.

### 4.5 The web does not match WEB.md — **medium / small**
**Seen.**
- WEB.md: a bottom bar of Library, Tasks, Calendar, Notes and People, with Canvas
  reached from a project. `modules.js` shows six, Canvas included, and its own
  comment still says Calendar "joins it once…".
- WEB.md: New (+) in the corner of each page. There is none.
- WEB.md: Tasks opens on Today, Notes on today's daily page. Tasks opens on the
  last collection, and Notes on the page list.
- On a wide browser, WEB.md promises the modules "side by side as the desktop's
  panels". What ships is a phone tab bar, centered and 560 px wide, under one
  module.
- The tab titles read "Talaris drawer" for both Notes and Canvas, and "Talaris
  library" and "Talaris tasks" elsewhere.

**Do.** Drop Canvas from the bar or update WEB.md. Add a floating + that opens
New for the current module. Make Today and the daily page the phone defaults.
Set `document.title` from `TALARIS_WEB.title`. On wide screens, use a left rail
instead of a bottom bar.
**Done, but for Canvas (2026-11-27).** A + in the corner over a phone's list
presses the page's own New (`PAGES[…].panes.create`: New task, New event, New
person, New page, New canvas), whose header button a phone then leaves out; it
shows only while the page offers one (Notes' dailies have none). Tasks opens on
Today on a phone when there is a starter Today; Notes on today's daily page
(`panes.start: "detail"`), the calendar of days a step back. Wider than a phone,
the modules are a rail down the left. Tab titles were already "Tasks · Talaris"
and so on, and the "joins it once" comment was gone.
**Proposed — Canvas in the bar.** It is still a seventh module (Morgan made it
seven). Either drop it from the bottom bar and reach a canvas from a project's
card in the Library, as WEB.md says, or keep it and change WEB.md's list to say
so. Which one is a choice about how the phone is used, so it is left to decide;
WEB.md was outside this change.

### 4.6 Light and dark disagree between login and app — **low / small**
**Seen.** Login follows the phone's `prefers-color-scheme` (`login.html:11`). The
app follows the laptop's setting (`surface.js:37`). A phone in light mode signs
in on white and lands in dark. Login's light surface is pure `#fff`; DESIGN says
light mode "leans heavily on grays rather than going white".
**Do.** On the web, let "Follow the system" be the default mode, and give login
the tokens.
**Done (2026-11-27).** Login had the tokens already (top 10, item 6). The app on
the web now takes the browser's `prefers-color-scheme` and follows it as it
changes (`surface.js`, `modeOf`); the desktop's Mode is the laptop's. The
drawers take their look through `Surface.applyTheme` rather than a copy of it,
which also gives them the accent's readable text color.

### 4.7 Desktop-only actions are shown on the web — **medium / small**
**Seen.** In a Library project on the web: "Go to this project", "Refresh" and
"Unlink" on a linked folder whose path shows "not there now" in the danger color
(it is on the laptop), and the project chat. WEB.md says a page's desktop verbs
"answer nothing yet".
**Do.** Hide any verb the web cannot carry out, through a `Bridge.can(verb)` the
web bridge answers. Say linked folders are "On the laptop" in muted text, not as
an error.
**Done in part (2026-11-27).** `bridge.can(verb)` in the web's bridge says no for
the verbs that reach the machine itself (going to a project, the file manager, a
folder on disk, a window, the Archive), and anything marked `data-verb="…"` with
one is hidden. Tasks asks it. Until `filespanel.js` asks it too (it was being
changed by other work), `web.css` hides a project's "Go to this project" and a
linked folder's Refresh, and mutes "not there now". Still owed in `filespanel.js`:
`bridge.can` on those verbs, and the words "On the laptop". Unlink stays: it is a
change to the data, which the web can make. The project chat stays: Morgan
answers on the web now.

### 4.8 Notes and Canvas lists on a phone — **low / small**
**Seen.**
- The header is in letter-spaced capitals and wraps to two lines ("CANVAS / HOME
  ▾ / CANVAS"), with "PRJ-00 · 309 PAGES" beside it.
- The list has no search; "Manual ▾" and "Tag ▾" are its only controls.
- The footers differ: "New page" in Notes, "New canvas inside" and "Rename" in
  Canvas.

**Do.** Use sentence case for the title on a phone and drop the code. Add the
search box. Match the footers ("New page", "New canvas"; Rename goes in the item's
menu).
**Done, but for Rename (2026-11-27).** On a phone the header reads "Home ▾ /
Canvas" in sentence case, the module's name left to the shell's bar, the code
hidden; the page's heading is in capitals by its style, not its words, so the
phone's sentence case is the same words. A find box ("Find in Notes", "Find in
Canvas") narrows the list as it is typed, on the desktop too. "New canvas inside"
is "New canvas". Rename stays in the footer: rows have no menu of their own to
put it in, and Notes has its Rename there too, so the two now match.

---

## 5. Information architecture

### 5.1 The bar carries too much — **medium / medium**
**Seen.** The default bar (`bar.html:185-217`) has 9 icon-only buttons on the left
(Ask, Morgan, New, Tasks, People, Library, Canvas, Notes, Review), the clock and
weather, and 12 or more on the right, plus the tray. There are no labels, and the
icons are 16–18 px glyphs of similar weight (screenshots). Glance and Archive
are not on it.
**Why.** Telling the panels apart depends on remembering icons. The machine
icons and the work icons are only separated by the clock.
**Do.**
- Group the work panels (Tasks, People, Library, Notes, Canvas) into one
  segmented strip, with an optional "Show names" setting that puts short text
  under or beside each.
- Move Screenshot, Clipboard and Light/dark into the power or quick-settings
  popup by default; they are keys anyway.
- Leave Review's button hidden until a review is open; the notification already
  brings it.

**Proposed (2026-11-27), not done: each changes what the bar is, every day.**
- *Names, first.* The cheapest step, and one that takes nothing away: a "Show
  names" switch in Settings › Bar that puts a short word beside each work panel's
  icon (Tasks, People, Library, Canvas, Notes). Off by default; the keys
  (Super+Shift+T, P, L, C, W, now said in every tip) are the other way to tell
  them apart without remembering icons.
- *One strip for the work panels.* Tasks, People, Library, Notes and Canvas in
  one segmented group with a hairline round it, so they read as one set apart
  from Ask, Morgan and New. A look change only; the order stays the person's.
- *Fewer machine buttons on the right.* Screenshot, Clipboard and Light/dark
  moved into the power popup by default (Print, Super+V and the popup still reach
  them), each put back on the bar from Settings › Bar as any item is.
- *Review only while open.* Already a setting ("only while a review is open");
  proposed as the default.
Glance and Archive stay off the bar: Glance is a press on a card or a key, and
the Archive now has a way in from Tasks (5.3).

### 5.2 Library, Glance and the card overlap — **medium / medium**
**Seen.**
- A Library project shows Overview · Suggestions · Files.
- Overview has a second toolbar: List · Glance, "This project only", "Steps 1 2
  3", refresh.
- Below that is a row of 12 kind chips with All and None.
- The right-hand card repeats parts of this: "About it", "What it seems to be
  about", possible connections, chat.

The Glance window is the same view again. Seen live, that is three rows of
controls before any content. "Steps 1 2 3" means hops and is not explained.
**Do.**
- Collapse the kind chips behind a "Kinds ▾" pick with counts.
- Rename "Steps" to "Reach: 1 · 2 · 3 steps" or put it in the graph's own
  overlay.
- Merge the two "about" blocks into one, with "Written by Morgan / by you".
- Make chat a tab of the card, not a section of it.

**Done in part (2026-11-27).** The kind chips are one "Kinds ▾" pick (it reads "9
of 10 kinds ▾" when some are hidden), its pop-up each kind on or off with its
count and All or None, staying up while they change; in the Glance window it sits
on the header's row (`glanceview.js`). "Steps 1 2 3" reads "Reach 1 2 3 steps",
its tip saying what a step is. Still owed in `filespanel.js` (being changed by
other work): putting the Kinds pick on the Overview's toolbar row
(`glance.kinds` beside `glance.steps`, as `glance.js` now does) so it stops being
a row of its own, and the Library list's own kind chips (`filespanel.js:209`)
made the same pick.
**Proposed, not done.**
- *The two "about" blocks into one.* "About it" (written by Morgan or by you)
  and "What it seems to be about" (worked out from what is in it) are different
  sources. Proposed: one block, "About it", with the written text first and the
  worked-out keywords under it as chips, the summary dropped when there is a
  written one, and a muted "by Morgan" or "by you" beside the heading.
- *Chat a tab of the card.* Proposed: the card's sections stay, and chat becomes
  a third tab beside Overview · Suggestions · Files ("Chat"), so a long
  conversation does not push the card's facts off screen. It changes where you
  talk with a project, so it is left to decide.
- *Glance the window and the Library's Overview.* They are the same view
  (`glanceview.js`) in two places. Proposed: keep both, and let the Glance window
  be what Super+Shift+G and a card's Glance button open, the Library's Overview
  its in-place copy; merging them would remove a window the person uses.

### 5.3 Archive has no home — **low / small**
**Seen.** The Archive panel is reachable only from a launcher verb
(`launcher.js:32`).
**Do.** Put "Archived projects (n)" at the foot of the Library's project list and
of Tasks' Projects.
**Done for Tasks (2026-11-27).** "Archived projects" with its count at the foot
of Tasks' projects opens the Archive panel (`core.Bridge.openArchive`); not on the
web, which has no Archive (`bridge.can`). Owed in `filespanel.js`: the same row at
the foot of the Library's projects, calling `bridge.openArchive()`.

### 5.4 "What is shown" switches are hard to read — **low / small**
**Seen.** Settings › Panels › "Finished tasks — Hidden" with a switch
(`settings.html:415`). Is on "hidden" or "shown"?
**Do.** Use a two-way segment, "Shown · Hidden", or word it "Show finished tasks"
with on meaning shown.
**Done (2026-11-27).** Finished tasks and Archived are each a "Shown · Hidden"
segment; the setting kept is the same (`shown.done`, `shown.archived`).

---

## 6. Visual details

- **Weight.** Only 400 and 500 are shipped, so the 10 px uppercase `.label` and a
  500-weight title are the whole hierarchy, and panel titles (`h1`) read about the
  same size as rows. Use the type tokens (3.4) for a clear step: title 16–18 px,
  section 11 px label, row 13.5 px. *Low / small.*
- **Accent pair in Settings › Look and feel.** "Mode: Dark · Light" and "Accent:
  Dark · Light" are identical segments one row apart (settings-look screenshot).
  The second chooses which mode's accent you are editing, which is not obvious.
  Show two swatch rows labeled "In dark" and "In light" instead. *Low / small.*
- **Unexplained marks.** People rows show filled or hollow dots (seen live) with
  no tip or legend. The Library uses "lit, or grey and red" for read status. Every
  status mark needs a tip, and the first use of each needs a legend line.
  *Low / small.*
- **The docs screenshots are out of date.** `library.webp` still shows "No
  project" (retired 2026-11-04) and "Open in Writing". `settings-look.webp` shows
  "Look" where the page is now "Look and feel". Retake them from the demo.
  *Low / small.*
- **Doc conflict.** DESIGN *On the web* says "the weekly review brought over
  whole"; *The weekly review* and WEB.md say it stays on the desktop only. Pick
  one sentence. *Low / small.*

**Section 6, as of 2026-11-27.**
- *Weight:* **done** but for the Library. Panel titles are `--t-xl` (18 px), the
  size `tokens.css` names for a panel's heading, in Tasks, Calendar, People,
  Glance, Archive and the weekly review; rows stay `--t-md`, the label `--t-xs`.
  `filespanel.html`'s `header h1` is still `--t-lg`, owed with the other work
  there.
- *Accent pair:* **done.** Settings › Look and feel has "Accent in dark" and
  "Accent in light", a row of swatches each; the hex field and the picker go with
  the row last pressed.
- *Unexplained marks:* **done for People.** The tied and untied marks are named
  for what reads aloud, and a legend at the foot of the list says what each is.
  The Library's read marks are `filespanel.js`'s, owed.
- *Screenshots:* **skipped.** Retaking them means driving the desktop in its
  demo, which was not to be touched from here.
- *Doc conflict:* **done.** DESIGN's *On the web* now says the weekly review
  stays on the desktop.

---

## Top 10, in order

1. **Keep what is typed** in New across close (1.1), and stop "+ Task" and
   "+ Person" making placeholder records (1.2). *High, small.*
2. **One idle rule that never closes a busy panel**, with "Never" in Settings
   (1.3). *High, small.*
3. **Accent text that passes contrast in light mode, and control edges at 3:1**
   (3.3). *High, small.*
4. **Visible 2 px focus, and accessible names** (`aria-label` from tips,
   switches, row roles) (3.1, 3.2). *High, small to medium.*
5. **People on the phone** (4.1) and **a phone agenda for Calendar** (4.4).
   *High, medium.*
6. **One phone shell**: top bar with Back, history, declared list and detail,
   44 px targets, and the `zoom` hack removed (4.2, 4.3). *High, medium.*
7. **The glossary**: Notes/pages, Files, Glance, Archive, card, linted (2.1).
   *High, small.*
8. **One panel header component** in the kit, with a primary button style that
   differs from "on" (2.2, 2.3). *Medium, medium.*
9. **Type tokens**: six sizes, `check-look` enforcing them, 44 current violations
   fixed, the web layer checked (3.4, 2.6). *Medium, medium.*
10. **Unsaved-changes guard on the event card, and Undo toasts** for delete,
    archive and merge (1.4, 1.5). *Medium, small to medium.*
