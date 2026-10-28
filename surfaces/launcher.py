# SPDX-License-Identifier: GPL-3.0-only
# Copyright (c) 2026 Jeff Moore
"""
The launcher: one box, everything.

**The process gathers, the page ranks.** When the launcher opens, the process
reads what there is — projects, the current project's canvases, pages and
files, live windows, applications — and hands the page the lot. Typing then
never waits on anything: the page filters what it already has. Gathering again
on every open keeps it current without watching anything.

**The page names, the process acts** — and checks: a page can ask to open a
file only inside the current project, to launch only an application the
index listed, to focus only a window Hyprland reported.

**Morgan is the fallthrough.** Text that is not a thing is a question: it is
typed to Morgan, and Morgan's conversation opens to show the answer.

On the `overlay` layer with the keyboard to itself, covering the space between
the bar and the dock, and with every way back: Escape, a press outside the
box, its keys again, the bar's button, `--file-all`, and an idle timeout.
"""

from __future__ import annotations

import json
import subprocess
import os

from PySide6.QtCore import QRunnable, QThreadPool, QTimer, QUrl, Signal, Slot
from PySide6.QtGui import QDesktopServices
from PySide6.QtWebEngineCore import QWebEngineProfile

import hypr
from apps import Apps, keeps_one_window, opens_new_windows
from core import Bridge, call, get_json, projects as core_projects
from layershell import KEYBOARD_EXCLUSIVE
from morgan import command as morgan_command
from overlay import Overlay
from views import log

#: How long a started application has to show a new window before its
#: window elsewhere is brought here instead (one that offers new windows, a
#: browser, is never moved, so this need not wait for a slow one); and how
#: often it is looked for meanwhile.
FOLLOW_MS = 1800
LOOK_MS = 250

#: How far into a project folder files are looked for, and how many at most —
#: a launcher, not a file search.
FILE_DEPTH = 4
FILE_LIMIT = 3000


def _flatten(nodes: list, key: str, trail: str = "") -> list[dict]:
    out = []
    for n in nodes:
        where = f"{trail} › {n['title']}" if trail else n["title"]
        out.append({key: n[key], "title": n["title"], "where": trail})
        out.extend(_flatten(n.get("children", []), key, where))
    return out


def _files(folder: str) -> list[dict]:
    """The project's own files: not Talaris's machinery, not hidden, not its pages (listed as pages)."""
    found: list[dict] = []
    base = folder.rstrip(os.sep)
    for root, dirs, files in os.walk(base):
        rel = os.path.relpath(root, base)
        depth = 0 if rel == "." else rel.count(os.sep) + 1
        dirs[:] = sorted(d for d in dirs if not d.startswith(".") and not (rel == "." and d == "Writing")
                         and d not in ("node_modules", "__pycache__"))
        if depth >= FILE_DEPTH:
            dirs[:] = []
        for name in sorted(files):
            if name.startswith("."):
                continue
            found.append({"path": os.path.join(root, name), "title": name,
                          "where": "" if rel == "." else rel})
            if len(found) >= FILE_LIMIT:
                return found
    return found


class _MorganSearch(QRunnable):
    """Morgan's search, off the screen's thread: the query goes to Morgan's brain to be embedded."""

    def __init__(self, bridge: "LauncherBridge", query: str) -> None:
        super().__init__()
        self.bridge, self.query = bridge, query

    def run(self) -> None:
        try:
            answer = json.loads(morgan_command(f"search {self.query}"))
        except (ValueError, OSError):
            answer = {"ok": False}
        results = answer.get("results", []) if answer.get("ok") else []
        self.bridge.morganFound.emit(json.dumps({"query": self.query, "results": results}))


class _MeaningSearch(QRunnable):
    """The core's search by meaning, off the screen's thread: the query is embedded by the model server it uses."""

    def __init__(self, bridge: "LauncherBridge", query: str) -> None:
        super().__init__()
        self.bridge, self.query = bridge, query

    def run(self) -> None:
        from urllib.parse import quote
        results = get_json(f"/meaning?q={quote(self.query)}&limit=8", [])
        self.bridge.meaningFound.emit(json.dumps({"query": self.query, "results": results if isinstance(results, list) else []}))


def _row(it: dict) -> dict | None:
    """A thing of the core's context as the launcher opens it; None for one it has no place to open."""
    kind = it.get("kind")
    base = {"kind": kind, "id": it.get("id", ""), "title": it.get("title", "")}
    if kind == "task":
        return {**base, "done": bool(it.get("done")), "due": it.get("due", "")}
    if kind == "person":
        return base
    if kind == "note" and it.get("path"):
        return {**base, "project": it.get("project", ""), "path": it["path"]}
    if kind == "conversation" and it.get("thread"):
        # One of Morgan's threads (the core's threads.ts): opened as its conversation.
        return {**base, "thread": it["thread"], "updated": it.get("updated", "")}
    if kind == "event" and it.get("uid") and it.get("start"):
        return {**base, "calendar": it.get("calendar", ""), "uid": it["uid"], "start": it["start"], "allDay": bool(it.get("allDay")), "location": ""}
    return None


class _ThingSearch(QRunnable):
    """
    Context for what was typed, off the screen's thread: tasks, people, notes
    and events whose words hold it, and for each thing it names whole,
    everything connected to it (the core's /context; a note opened on its
    page), with the calendar's own search for events the core does not keep.
    """

    def __init__(self, bridge: "LauncherBridge", query: str) -> None:
        super().__init__()
        self.bridge, self.query = bridge, query

    def run(self) -> None:
        from datetime import datetime
        from urllib.parse import quote
        q = quote(self.query)
        found: list[dict] = []
        # The core's context (context.ts): what holds the words, and for what they name, everything it touches.
        ctx = get_json(f"/context?q={q}&limit=20", None) or {"hits": [], "about": []}
        hits = [h for h in ctx.get("hits", []) if _row(h)]
        # Open tasks before done ones; no more than a handful of each kind.
        hits.sort(key=lambda h: bool(h.get("done")))
        counts: dict[str, int] = {}
        for h in hits:
            counts[h["kind"]] = counts.get(h["kind"], 0) + 1
            if counts[h["kind"]] <= {"task": 6, "person": 5, "note": 6, "event": 5, "conversation": 4}.get(h["kind"], 0):
                found.append(_row(h))
        about = [{"focus": a["focus"]["id"], "title": a["focus"]["title"], "more": a.get("more", 0),
                  "related": [dict(_row(r), how=r.get("how", ""), incoming=bool(r.get("incoming"))) for r in a.get("related", []) if _row(r)]}
                 for a in ctx.get("about", [])]
        service = getattr(self.bridge.owner.desktop, "calendar_service", None)
        mirrored = {r.get("uid") for r in found if r["kind"] == "event"}
        for e in [e for e in (service.find_events(self.query) if service else []) if e.get("uid") not in mirrored][:5]:
            found.append({"kind": "event", "calendar": e.get("calendar", ""), "uid": e.get("uid", ""), "title": e.get("title", ""),
                          "start": datetime.fromtimestamp(e["start"] / 1000).isoformat(), "allDay": bool(e.get("allDay")), "location": e.get("location", "")})
        self.bridge.thingsFound.emit(json.dumps({"query": self.query, "results": found, "about": about}))


class LauncherBridge(Bridge):
    #: Pushed to the page: Morgan's past conversations for a query, `{query, results}`.
    morganFound = Signal(str)
    #: Pushed to the page: what is nearest a query in meaning, `{query, results}` (the core's meaning.ts).
    meaningFound = Signal(str)
    #: Pushed to the page: tasks, people, notes and events holding a query's words, `{query, results}` (_ThingSearch).
    thingsFound = Signal(str)

    @Slot(str)
    def thingSearch(self, query: str) -> None:  # noqa: N802 — called from the page by this name
        """Tasks, people, notes and events by their words."""
        query = " ".join(query.split())[:200]
        if len(query) >= 2:
            self.owner.searches.start(_ThingSearch(self, query))

    @Slot(str)
    def meaningSearch(self, query: str) -> None:  # noqa: N802 — called from the page by this name
        """Pages, notes, tasks and people by what they are about. Nothing is embedded here: the core asks its model server."""
        query = " ".join(query.split())[:300]
        if len(query) >= 3:
            self.owner.searches.start(_MeaningSearch(self, query))

    @Slot(str)
    def morganSearch(self, query: str) -> None:  # noqa: N802 — called from the page by this name
        """Past conversations with Morgan for what was typed. Nothing is embedded here: Morgan does it, where it runs."""
        query = " ".join(query.split())[:200]
        # Not in the demo: Morgan's past conversations are the person's own, and a demo is shown to others.
        if os.environ.get("TALARIS_DEMO"):
            return
        if len(query) >= 3 and self.owner.desktop.morgan_link.now != "absent":
            self.owner.searches.start(_MorganSearch(self, query))

    @Slot(result=str)
    def catalog(self) -> str:
        return json.dumps(self.owner.catalog())

    @Slot(str, result=str)
    def tagged(self, tag: str) -> str:
        """`#tag` typed: everything carrying it (the core's tags.ts) — pages with where they are, tasks and people by id."""
        from urllib.parse import quote
        status, text = call("GET", f"/tags/things?tag={quote(tag.strip().lstrip('#'))}")
        return text if status == 200 else "[]"

    @Slot(result=str)
    def tags(self) -> str:
        """Every tag in use, for `#` typed alone."""
        status, text = call("GET", "/tags")
        return text if status == 200 else "[]"

    @Slot(str, result=str)
    def act(self, request: str) -> str:
        """Do what was chosen. Answers an error to show, or empty when it was done."""
        try:
            return self.owner.act(json.loads(request))
        except (ValueError, KeyError, TypeError):
            return "That cannot be done"


class Launcher(Overlay):
    """
    A panel as the others are (overlay.py) — its coming and going, its dim,
    its idle, its stepping aside for a chooser, a page that will not answer
    put away all the same — with the keyboard to itself, and two ways of
    being out: to find anything, or to ask Morgan. Never a window.
    """

    NAME = "launcher"
    TITLE = "Launcher"
    #: An open launcher nobody types into puts itself away.
    IDLE_MS = 60000
    KEYBOARD = KEYBOARD_EXCLUSIVE

    def __init__(self, profile: QWebEngineProfile, desktop, apps: Apps) -> None:
        super().__init__(profile, desktop, "talaris-ui://ui/launcher.html", LauncherBridge(None, None), area="launcher")
        self.bridge.owner = self
        self.bridge.setParent(self)
        self.apps = apps
        self.mode = ""  # "" to find anything, "ask" when Morgan's button opened it
        self._windows: set[str] = set()
        #: Applications just started again, watched for a window: id → (their windows then, where asked).
        self._pending: dict[str, tuple] = {}
        desktop.events.urgent.connect(self._urgent)
        # One of Morgan's searches at a time, at most two waiting.
        self.searches = QThreadPool(self)
        self.searches.setMaxThreadCount(1)

    def describe(self) -> dict:
        return {**super().describe(), "mode": self.mode, "project": self.desktop.project}

    def open(self, mode: str = "") -> None:
        self.mode = mode
        # Already out, in the other mode: the page hears which it is now.
        if self.up:
            self.bridge.state.emit(json.dumps(self.describe()))
        super().open()

    def toggle(self, mode: str = "") -> None:
        if self.up and self.mode == mode:
            self.file_away()
        else:
            self.open(mode)

    def grow(self) -> None:
        """A box to type in, not a panel: there is no window of it."""

    def opened(self) -> None:
        self.desktop.bar.changed()

    def closed(self) -> None:
        self.desktop.bar.changed()

    # ------------------------------------------------------------------ what there is

    def catalog(self) -> dict:
        project = self.desktop.project
        pid = project.get("id", "")
        projects = core_projects()
        here = next((p for p in projects if p.get("id") == pid), None)
        canvases = _flatten([get_json(f"/projects/{pid}/canvases", {"id": "", "title": "", "children": []})], "id") if pid else []
        pages = _flatten(get_json(f"/projects/{pid}/pages", []), "path") if pid else []
        now = hypr.windows()
        names = {w["id"]: w["name"] for w in now["workspaces"]}
        windows = []
        for w in now["windows"]:
            app = self.apps.lookup(w["class"])
            windows.append({"address": w["address"], "title": w["title"] or app["name"], "app": app["name"],
                            "icon": app["icon"], "where": names.get(w["workspace"], str(w["workspace"])),
                            "recent": w["recent"]})
        self._windows = {w["address"] for w in windows}
        # An application open only in another project: where, and what a press, Shift-press and Ctrl-press do with it
        # (the dock's, as its menu or Settings, Dock says) — offered in the launcher as all three.
        away: dict[str, dict] = {}
        here_apps = set()
        # Where, by its project's name: a project's desktop is named by its id, and the ordinary ones are Home's (hypr.project_of).
        named = {p["id"]: p["name"] for p in projects}
        home = next((p["id"] for p in projects if p.get("home")), "")
        place = lambda ws: (lambda n: named.get(hypr.project_of(n, home)) or ("Home" if hypr.is_ordinary(n) else n))(names.get(ws, str(ws)))  # noqa: E731
        for w in now["windows"]:
            app_id = self.apps.lookup(w["class"]).get("id")
            if not app_id:
                continue
            if w["workspace"] == now["active"] or w["hidden"]:
                here_apps.add(app_id)
            else:
                if app_id not in away or w["recent"] < away[app_id]["recent"]:
                    away[app_id] = {"where": place(w["workspace"]), "recent": w["recent"]}
        apps = []
        for a in self.apps.launchable():
            where = away.get(a["id"]) if a["id"] not in here_apps else None
            presses = self.desktop.dock.clicks(a["id"]) if where else {}
            apps.append({**a, "away": where["where"] if where else "", "presses": presses})
        return {
            "project": project,
            "projects": [{"id": p["id"], "title": p["name"], "code": p["code"]} for p in projects],
            # The top canvas is the drawer itself; it is called Canvas there too.
            "canvases": [dict(c, title=c["title"] if c["where"] else "Canvas") for c in canvases if c["id"]],
            "pages": pages,
            "files": _files(here["folder"]) if here else [],
            "windows": windows,
            "apps": apps,
            "morgan": self.desktop.morgan_link.now != "absent",
        }

    # ------------------------------------------------------------------ doing it

    def act(self, r: dict) -> str:
        kind = r["kind"]
        if kind == "morgan":
            self.file_away()
            return self.desktop.morgan.ask(str(r["text"]))
        if kind == "copy":
            # A worked-out sum, onto the clipboard.
            self.file_away()
            try:
                subprocess.run(["wl-copy"], input=str(r["text"]).encode(), timeout=3, check=False)
            except (OSError, subprocess.SubprocessError):
                return "Could not copy it"
            return ""
        self.file_away()
        if kind == "app":
            if not self.apps.is_launchable(r["id"]):
                return "No such application"
            if r.get("how") in ("new", "bring", "go"):
                self.call_app_as(r["id"], r["how"])
            else:
                self.call_app(r["id"], there=bool(r.get("there")))
        elif kind == "window":
            if r["address"] not in self._windows:
                return "That window has gone"
            hypr.focus(r["address"])
        elif kind == "project":
            self.desktop.go_to_project(str(r["id"]), announce=True)
        elif kind == "canvas" and r.get("project"):
            # A canvas wherever it is, found by what it says: opened in its project.
            self.desktop.open_place("canvas", str(r["project"]), str(r["id"]))
        elif kind == "canvas":
            self.desktop.show_in_drawer("canvas", {"canvas": str(r["id"])})
        elif kind == "page" and r.get("project"):
            # A page wherever it is — another project's, or an undated note — opened there.
            self.desktop.open_place("page", str(r["project"]), str(r["path"]))
        elif kind == "page":
            self.desktop.show_in_drawer("writing", {"page": str(r["path"])})
        elif kind == "event":
            self.desktop.show_event(str(r.get("calendar", "")), str(r.get("uid", "")), str(r.get("start", "")))
        elif kind == "entity":
            from desktop_api import opened
            said = opened(self.desktop, {"kind": str(r.get("as", "")), "id": str(r["id"])})
            if not said.get("ok"):
                return said.get("error", "That cannot be opened")
        elif kind == "file" and r.get("project"):
            # Found by what it says, in any project: its project's file, opened (a sealed one as a copy).
            from files import open_project_file
            open_project_file(str(r["project"]), str(r["path"]))
        elif kind == "file":
            return self._open_file(str(r["path"]))
        elif kind == "verb" and r.get("name") == "archive":
            self.desktop.archive.show(str(r.get("query") or ""))
        elif kind == "verb":
            return self.desktop.verb(str(r["name"]))
        elif kind == "conversation":
            self.desktop.morgan.show_conversation(str(r["id"]))
        elif kind == "glance":
            self.desktop.glance.open_on(str(r["key"]))
        else:
            return "That cannot be done"
        return ""

    def call_app(self, app_id: str, there: bool = False) -> None:
        """An application called — from the launcher, the dock or its key: brought here, gone to, or started, as the rules say."""
        if self.kept(app_id):
            return
        mine = self._app_windows(app_id)
        # What calling it does while it is open elsewhere: its own choice, its keeping, or the rule (the dock's `how`,
        # the one rule for all of them); Shift+Enter swaps bringing and going.
        how = self.desktop.dock.how(app_id)
        go = (how == "go") != there
        now = hypr.windows()
        here = (now["active"], now["activeTarget"])
        if mine and not any(w["workspace"] == now["active"] for w in mine):
            if how == "new":
                self.desktop.dock.new_window(app_id)
            else:
                self._bring(app_id, here, go)
            return
        before = {w["address"] for w in mine}
        # One that says it keeps a single window is brought here, not started again.
        if mine and keeps_one_window(app_id):
            self._bring(app_id, here, go)
            return
        # Through the compositor, so it starts with the session's environment
        # and on the workspace in front of you.
        hypr.ask(f"/dispatch exec gtk-launch {app_id}")
        # Watched: brought here the moment it raises the window it has (urgent), or
        # once it has shown no new window in the time given.
        self._pending[app_id] = (before, here, go)
        self._look(app_id, FOLLOW_MS)

    def call_app_as(self, app_id: str, how: str) -> None:
        """One of the dock's three, chosen in the launcher: a `new` window here, its last window brought here, or gone to."""
        if how == "new":
            self.desktop.dock.new_window(app_id)
            return
        if not self._app_windows(app_id):
            self.call_app(app_id)
            return
        now = hypr.windows()
        self._bring(app_id, (now["active"], now["activeTarget"]), go=how == "go")

    def kept(self, app_id: str) -> bool:
        """
        An application whose dock pin is kept in a project (the dock's menu,
        "Keep in this project"), called from anywhere: open, it is gone to
        where it is — unless the one rule (the dock's `how`: its own choice
        first) says to bring it, or a new window; open nowhere, its project is
        gone to and it is shown or started there. Answers whether it was one;
        the general rule does the rest.
        """
        home = self.desktop.config["dock"].get("stays", {}).get(app_id)
        if not home:
            return False
        mine = self._app_windows(app_id)
        visible = [w for w in mine if not w["hidden"]]
        if visible:
            if self.desktop.dock.how(app_id) != "go":
                return False
            hypr.focus(visible[0]["address"])
            log(f"launcher: gone to {app_id}, kept where it is")
            return True
        self.desktop.go_to_project(home, announce=True)
        if mine:
            hypr.show(mine[0]["address"])
        else:
            hypr.ask(f"/dispatch exec gtk-launch {app_id}")
        log(f"launcher: {app_id} opened in its own project")
        return True

    def _app_windows(self, app_id: str) -> list:
        """An application's windows, most recently used first — told apart as the dock tells them (apps.windows_of)."""
        return self.apps.windows_of(app_id, hypr.windows()["windows"])

    def _look(self, app_id: str, left: int) -> None:
        """A new window of it seen: as asked, nothing to bring. None in the time given: brought."""
        if app_id not in self._pending:
            return
        before = self._pending[app_id][0]
        if any(w["address"] not in before for w in self._app_windows(app_id)):
            self._pending.pop(app_id, None)
        elif left <= 0:
            self._follow(app_id)
        else:
            QTimer.singleShot(LOOK_MS, lambda: self._look(app_id, left - LOOK_MS))

    def _urgent(self, address: str) -> None:
        """A window asked to come forward: one of an application just started again, raising the one it has."""
        for app_id, (before, _here, _go) in list(self._pending.items()):
            if address in before:
                self._follow(app_id)

    def _follow(self, app_id: str) -> None:
        """
        Started again from the launcher, an application either opened a new
        window (here, as asked) or did not: one that keeps a single window —
        a music player, a messenger — ignores a second start, or raises the
        window it has, wherever it is. That window is brought to the desktop
        it was asked for on: the project you are in, not the one it was left in.
        """
        if app_id not in self._pending:
            return
        before, here, go = self._pending.pop(app_id)
        mine = self._app_windows(app_id)
        # One that opens new windows (a browser) is not moved, however slow its new window is to come.
        if not mine or any(w["address"] not in before for w in mine) or opens_new_windows(app_id):
            return
        self._bring(app_id, here, go)

    def _bring(self, app_id: str, here: tuple, go: bool = False) -> None:
        """
        An application's window, from wherever it is, to the desktop it was
        asked for on — drawn in as it comes; or (`go`) that desktop left for
        the one it is on, whose project becomes the current one.
        """
        mine = self._app_windows(app_id)
        wid, spec = here
        if not mine or (any(w["workspace"] == wid and not w["hidden"] for w in mine) and hypr.windows()["active"] == wid):
            return
        window = mine[0]["address"]
        if go and not mine[0]["hidden"]:
            hypr.focus(window)
            log(f"launcher: gone to {app_id}")
            return
        hypr.show(window, spec)
        self.desktop.winfx.arrived(window)
        # This desktop's likeness taken again, with the window in it.
        self.desktop.thumbs.arrived()
        log(f"launcher: {app_id} brought here")

    def _open_file(self, path: str) -> str:
        projects = core_projects()
        here = next((p for p in projects if p.get("id") == self.desktop.project.get("id")), None)
        if not here:
            return "No project"
        root = os.path.realpath(here["folder"])
        real = os.path.realpath(path)
        if not real.startswith(root + os.sep) or not os.path.isfile(real):
            return "Not a file in this project"
        QDesktopServices.openUrl(QUrl.fromLocalFile(real))
        return ""
