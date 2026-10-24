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
import os

from PySide6.QtCore import QObject, QTimer, QUrl, Slot
from PySide6.QtGui import QDesktopServices
from PySide6.QtWebEngineCore import QWebEngineProfile
from PySide6.QtWidgets import QApplication

import hypr
from apps import Apps
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
from views import log, make_view

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


class LauncherBridge(Bridge):
    @Slot(result=str)
    def catalog(self) -> str:
        return json.dumps(self.owner.catalog())

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
        self.bridge = LauncherBridge(self, self)
        self.view = make_view(profile, "launcher", "talaris-ui://ui/launcher.html", self.bridge, self, area="launcher")
        self.surface = LayerSurface(self.view, "talaris-launcher")
        self.idle = QTimer(self)
        self.idle.setSingleShot(True)
        self.idle.timeout.connect(self.file_away)
        self.leaving = False

    def describe(self) -> dict:
        return {"up": self.up, "mode": self.mode, "project": self.desktop.project,
                "theme": self.desktop.config["theme"], "motion": self.desktop.config["overlays"]}

    def open(self, mode: str = "") -> None:
        self.mode = mode
        self.up = True
        self.leaving = False
        screen = QApplication.primaryScreen().geometry()
        self.surface.apply(Placement(OVERLAY, ANCHOR_TOP | ANCHOR_BOTTOM | ANCHOR_LEFT | ANCHOR_RIGHT,
                                     screen.width(), screen.height(), KEYBOARD_EXCLUSIVE))
        self.view.setFocus()
        self.bridge.state.emit(json.dumps(self.describe()))
        self.touched()
        log("launcher: open" + (f" ({mode})" if mode else ""))

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
        self.file_away()
        if kind == "app":
            if not self.apps.is_launchable(r["id"]):
                return "No such application"
            # Through the compositor, so it starts with the session's environment
            # and on the workspace in front of you.
            hypr.ask(f"/dispatch exec gtk-launch {r['id']}")
        elif kind == "window":
            if r["address"] not in self._windows:
                return "That window has gone"
            hypr.focus(r["address"])
        elif kind == "project":
            self.desktop.go_to_project(str(r["id"]))
        elif kind == "canvas":
            self.desktop.show_in_drawer("canvas", {"canvas": str(r["id"])})
        elif kind == "page":
            self.desktop.show_in_drawer("writing", {"page": str(r["path"])})
        elif kind == "file":
            return self._open_file(str(r["path"]))
        elif kind == "verb":
            return self.desktop.verb(str(r["name"]))
        else:
            return "That cannot be done"
        return ""

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
