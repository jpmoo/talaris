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

from PySide6.QtCore import QObject, QRunnable, QThreadPool, QTimer, QUrl, Signal, Slot
from PySide6.QtGui import QDesktopServices
from PySide6.QtWebEngineCore import QWebEngineProfile
from PySide6.QtWidgets import QApplication

import hypr
from apps import Apps, keeps_one_window, opens_new_windows
from core import Bridge, call
from layershell import (
    ANCHOR_BOTTOM,
    ANCHOR_LEFT,
    ANCHOR_RIGHT,
    ANCHOR_TOP,
    KEYBOARD_EXCLUSIVE,
    OVERLAY,
    LayerSurface,
    Placement,
)
from morgan import command as morgan_command
from overlay import point_at, pointer_back, viewport
from sensor import Presses
from views import log, make_view

#: How long a started application has to show a new window before its
#: window elsewhere is brought here instead (one that offers new windows, a
#: browser, is never moved, so this need not wait for a slow one); and how
#: often it is looked for meanwhile.
FOLLOW_MS = 1800
LOOK_MS = 250
#: An open launcher nobody types into puts itself away.
IDLE_MS = 60000
#: How long the page has to finish leaving before the surface goes anyway.
LEAVE_LIMIT_MS = 1600

#: How far into a project folder files are looked for, and how many at most —
#: a launcher, not a file search.
FILE_DEPTH = 4
FILE_LIMIT = 3000


def _json(path: str, fallback):
    status, text = call("GET", path)
    try:
        return json.loads(text) if status == 200 else fallback
    except ValueError:
        return fallback


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
        results = _json(f"/meaning?q={quote(self.query)}&limit=8", [])
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
        ctx = _json(f"/context?q={q}&limit=20", None) or {"hits": [], "about": []}
        hits = [h for h in ctx.get("hits", []) if _row(h)]
        # Open tasks before done ones; no more than a handful of each kind.
        hits.sort(key=lambda h: bool(h.get("done")))
        counts: dict[str, int] = {}
        for h in hits:
            counts[h["kind"]] = counts.get(h["kind"], 0) + 1
            if counts[h["kind"]] <= {"task": 6, "person": 5, "note": 6, "event": 5}.get(h["kind"], 0):
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


class Launcher(QObject):
    def __init__(self, profile: QWebEngineProfile, desktop, apps: Apps) -> None:
        super().__init__(desktop)
        self.desktop = desktop
        self.apps = apps
        self.up = False
        self.mode = ""  # "" to find anything, "ask" when Morgan's button opened it
        self._windows: set[str] = set()
        #: Applications just started again, watched for a window: id → (their windows then, where asked).
        self._pending: dict[str, tuple] = {}
        desktop.events.urgent.connect(self._urgent)
        self.bridge = LauncherBridge(self, self)
        # One of Morgan's searches at a time, at most two waiting.
        self.searches = QThreadPool(self)
        self.searches.setMaxThreadCount(1)
        self.view = make_view(profile, "launcher", "talaris-ui://ui/launcher.html", self.bridge, self, area="launcher")
        self.surface = LayerSurface(self.view, "talaris-launcher", nudge=False)
        Presses(self.view)
        self.idle = QTimer(self)
        self.idle.setSingleShot(True)
        self.idle.timeout.connect(self.file_away)
        self.leaving = False

    def describe(self) -> dict:
        return {"up": self.up, "mode": self.mode, "project": self.desktop.project, "viewport": viewport(self.view),
                "theme": self.desktop.config["theme"], "motion": self.desktop.motion("launcher")}

    def open(self, mode: str = "") -> None:
        self.mode = mode
        self.up = True
        self.leaving = False
        point_at(self.view)
        screen = QApplication.primaryScreen().geometry()
        self.surface.apply(Placement(OVERLAY, ANCHOR_TOP | ANCHOR_BOTTOM | ANCHOR_LEFT | ANCHOR_RIGHT,
                                     screen.width(), screen.height(), KEYBOARD_EXCLUSIVE, exclusive=-1))
        self.view.setFocus()
        self.bridge.state.emit(json.dumps(self.describe()))
        self.touched()
        self.desktop.bar.changed()
        log("launcher: open" + (f" ({mode})" if mode else ""))

    def pointer_back(self) -> None:
        pointer_back(self.view)

    def toggle(self, mode: str = "") -> None:
        if self.up and self.mode == mode:
            self.file_away()
        else:
            self.open(mode)

    def file_away(self) -> None:
        """The page plays its leaving, then says so (`left`), and only then does the surface go."""
        if not self.up:
            return
        self.up = False
        self.idle.stop()
        self.desktop.bar.changed()
        self.leaving = True
        self.bridge.leave.emit()
        QTimer.singleShot(LEAVE_LIMIT_MS, self.left)

    def left(self) -> None:
        if not self.leaving:
            return
        self.leaving = False
        self.bridge.state.emit(json.dumps(self.describe()))
        self.view.hide()
        self.surface.placement = None

    def touched(self) -> None:
        if self.up:
            self.idle.start(IDLE_MS)

    # ------------------------------------------------------------------ what there is

    def catalog(self) -> dict:
        project = self.desktop.project
        pid = project.get("id", "")
        projects = _json("/projects", [])
        here = next((p for p in projects if p.get("id") == pid), None)
        canvases = _flatten([_json(f"/projects/{pid}/canvases", {"id": "", "title": "", "children": []})], "id") if pid else []
        pages = _flatten(_json(f"/projects/{pid}/pages", []), "path") if pid else []
        now = hypr.windows()
        names = {w["id"]: w["name"] for w in now["workspaces"]}
        windows = []
        for w in now["windows"]:
            app = self.apps.lookup(w["class"])
            windows.append({"address": w["address"], "title": w["title"] or app["name"], "app": app["name"],
                            "icon": app["icon"], "where": names.get(w["workspace"], str(w["workspace"])),
                            "recent": w["recent"]})
        self._windows = {w["address"] for w in windows}
        return {
            "project": project,
            "projects": [{"id": p["id"], "title": p["name"], "code": p["code"]} for p in projects],
            # The top canvas is the drawer itself; it is called Canvas there too.
            "canvases": [dict(c, title=c["title"] if c["where"] else "Canvas") for c in canvases if c["id"]],
            "pages": pages,
            "files": _files(here["folder"]) if here else [],
            "windows": windows,
            "apps": self.apps.launchable(),
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
            self.call_app(r["id"], there=bool(r.get("there")))
        elif kind == "window":
            if r["address"] not in self._windows:
                return "That window has gone"
            hypr.focus(r["address"])
        elif kind == "project":
            self.desktop.go_to_project(str(r["id"]))
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

    def brings(self, key: str) -> bool:
        """
        Whether something is brought where you are when called: the general
        rule (Settings, Keys: single-window apps), or its exception for that
        pinned thing (the dock's menu) — kept in a project when the rule
        brings, always brought when the rule goes.
        """
        cfg = self.desktop.config
        if cfg["launcher"].get("singleWindow", "bring") == "go":
            return key in cfg["dock"].get("brings", [])
        return key not in cfg["dock"].get("stays", {})

    def call_app(self, app_id: str, there: bool = False) -> None:
        """An application called — from the launcher, the dock or its key: brought here, gone to, or started, as the rules say."""
        if self.kept(app_id):
            return
        mine = self._app_windows(app_id)
        # Its choice for when it is open in another project (the dock's menu): a new window here, or it brought or gone to.
        choice = self.desktop.dock.elsewhere(app_id)
        now = hypr.windows()
        if choice and mine and not any(w["workspace"] == now["active"] for w in mine):
            if choice == "new":
                self.desktop.dock.new_window(app_id)
            else:
                self._bring(app_id, (now["active"], now["activeTarget"]), go=(choice == "go") != there)
            return
        # One that keeps a single window, open elsewhere: brought here, or gone to —
        # as Settings says (Keys, Launcher), or its exception; Shift+Enter the other.
        go = (not self.brings(app_id)) != there
        now = hypr.windows()
        before, here = {w["address"] for w in mine}, (now["active"], now["activeTarget"])
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

    def kept(self, app_id: str) -> bool:
        """
        An application whose dock pin is kept in a project (the dock's menu,
        "Keep in this project"): called from anywhere, it is gone to rather than brought —
        its window where it is, or, with none, its project and then started
        there. Answers whether it was one; the general rule does the rest.
        """
        cfg = self.desktop.config
        home = cfg["dock"].get("stays", {}).get(app_id)
        # Kept only means something where the rule is to bring.
        if not home or cfg["launcher"].get("singleWindow", "bring") == "go":
            return False
        mine = self._app_windows(app_id)
        visible = [w for w in mine if not w["hidden"]]
        if visible:
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
        """An application's windows, most recently used first."""
        now = hypr.windows()
        return sorted((w for w in now["windows"] if self.apps.lookup(w["class"]).get("id") == app_id), key=lambda w: w["recent"])

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
        projects = _json("/projects", [])
        here = next((p for p in projects if p.get("id") == self.desktop.project.get("id")), None)
        if not here:
            return "No project"
        root = os.path.realpath(here["folder"])
        real = os.path.realpath(path)
        if not real.startswith(root + os.sep) or not os.path.isfile(real):
            return "Not a file in this project"
        QDesktopServices.openUrl(QUrl.fromLocalFile(real))
        return ""
