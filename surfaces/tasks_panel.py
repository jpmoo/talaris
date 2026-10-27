# SPDX-License-Identifier: GPL-3.0-only
# Copyright (c) 2026 Jeff Moore
"""
The Tasks panel (DESIGN, *Tasks*): up from the bar's Tasks button, as every
bar item is (overlay.py) — a panel over the dimmed screen, or by its button a
window Hyprland tiles.

The page (`ui/tasks.html`) does the work against the core — projects and
lists down the left, the chosen one on the right — through `core`, which
answers later (`coreReply`) so a slow answer never holds the page up. Only the
core's task, list and entity routes go through: this is not a door to the rest
of it.
"""

from __future__ import annotations

import json
import os
import re
import threading

from PySide6.QtCore import Signal, Slot
from PySide6.QtWebEngineCore import QWebEngineProfile

from core import Bridge, call, local_call, route_ok
from files import choose_files, open_kept_file, send_files
from overlay import Overlay
import wallpaper

#: What the page may ask the core for.
# And plugins' buttons on a task or a project (peek.js, actionButtons): listed and pressed, nothing else of plugins.
ALLOWED = re.compile(r"^/(tasks|lists|entities|entity-types|people/find|mentionables|suggestions)(/|$|\?)|^/projects/[A-Za-z0-9_]+/(name|about)$|^/plugins/actions(\?|$)|^/plugins/decisions\?on=tasks$|^/plugins/[a-z0-9-]+/decide\?on=tasks$|^/plugins/[a-z0-9-]+/actions/[a-z0-9-]+$")


class TasksBridge(Bridge):
    #: The core's answer to `core`: {id, status, data}.
    coreReply = Signal(str)

    @Slot(str, str, str, str)
    def core(self, ident: str, method: str, path: str, body: str) -> None:
        if not route_ok(ALLOWED, path):
            self.coreReply.emit(json.dumps({"id": ident, "status": 400, "data": {"error": "not a route the Tasks panel uses"}}))
            return

        def run() -> None:
            status, text = local_call(method, path, body or None, timeout=30)
            try:
                data = json.loads(text) if text else None
            except ValueError:
                data = {"error": text}
            self.coreReply.emit(json.dumps({"id": ident, "status": status, "data": data}))
        threading.Thread(target=run, daemon=True).start()


    #: Files attached, or why not: {task, added, error}.
    attached = Signal(str)

    @Slot(str)
    def attach(self, task: str) -> None:
        """Files for a task, chosen in the desktop's chooser (the panel steps aside for it)."""
        self.owner.choose_files(task)

    #: A project's wallpaper, after a change: {project, path, fit, own, error}.
    wallpaperChanged = Signal(str)

    @Slot(str, result=str)
    def wallpaperOf(self, project: str) -> str:  # noqa: N802 — called from the page by this name
        """A project's wallpaper (by its Talaris id): its own, or the default."""
        return json.dumps({"project": project, **wallpaper.for_project(self.owner.desktop.config, project)})

    @Slot(str)
    def chooseWallpaper(self, project: str) -> None:  # noqa: N802 — called from the page by this name
        self.owner.choose_wallpaper(project)

    @Slot(str)
    def defaultWallpaper(self, project: str) -> None:  # noqa: N802 — called from the page by this name
        error = self.owner.desktop.set_wallpaper(project, clear=True)
        self.wallpaperChanged.emit(json.dumps({"project": project, **wallpaper.for_project(self.owner.desktop.config, project), "error": error}))

    @Slot(str, str)
    def openFile(self, sha: str, filename: str) -> None:  # noqa: N802 — called from the page by this name
        self.owner.open_file(sha, filename)

    @Slot(str)
    def link(self, task: str) -> None:
        """Files to link on a task, where they are (links.ts), chosen in the desktop's chooser."""
        self.owner.choose_links(task)

    @Slot(str)
    def openLinked(self, path: str) -> None:  # noqa: N802 — called from the page by this name
        """A linked file itself, in its application — only one in the home folder, as a link may be."""
        full = os.path.realpath(path)
        if full.startswith(os.path.expanduser("~") + os.sep) and os.path.isfile(full):
            from files import _launch
            _launch(full)

    @Slot(str)
    def showLinked(self, path: str) -> None:  # noqa: N802 — called from the page by this name
        """The folder a linked file is in, in the file manager."""
        folder = os.path.dirname(os.path.realpath(path))
        if folder.startswith(os.path.expanduser("~")) and os.path.isdir(folder):
            from files import _launch
            _launch(folder)


class Tasks(Overlay):
    NAME = "tasks"
    TITLE = "Tasks"
    IDLE_MS = 10 * 60 * 1000

    def __init__(self, profile: QWebEngineProfile, desktop) -> None:
        super().__init__(profile, desktop, "talaris-ui://ui/tasks.html", TasksBridge(None, None))
        self.bridge.owner = self
        self.bridge.setParent(self)

    def choose_files(self, task: str) -> None:
        def chosen(paths: list) -> None:
            if paths:
                threading.Thread(target=self._send, args=(task, paths), daemon=True).start()
        choose_files(self, "Files for the task", chosen)

    def _send(self, task: str, paths: list) -> None:
        added, errors = send_files(f"/tasks/{task}/attachments", paths)
        self.bridge.attached.emit(json.dumps({"task": task, "added": added, "error": "; ".join(errors)}))

    def choose_links(self, task: str) -> None:
        """Files linked where they are, not copied: only ones in the home folder (the core says so for any other)."""
        def chosen(paths: list) -> None:
            if paths:
                threading.Thread(target=self._link, args=(task, paths), daemon=True).start()
        choose_files(self, "Files to link to the task", chosen)

    def _link(self, task: str, paths: list) -> None:
        added, errors = 0, []
        for path in paths:
            status, text = call("POST", f"/entities/{task}/links", json.dumps({"path": path}))
            if status == 200:
                added += 1
            else:
                try:
                    errors.append(f"{os.path.basename(path)}: {json.loads(text).get('error', '')}")
                except ValueError:
                    errors.append(os.path.basename(path))
        self.bridge.attached.emit(json.dumps({"task": task, "added": added, "linked": True, "error": "; ".join(errors)}))

    def choose_wallpaper(self, project: str) -> None:
        """A picture for a project, from the desktop's chooser (the panel steps aside for it)."""
        if getattr(self, "_chooser", None):
            return
        self._chooser = True
        now = wallpaper.for_project(self.desktop.config, project)

        def chosen(path: str) -> None:
            self._chooser = None
            self.come_back()
            error = self.desktop.set_wallpaper(project, path=path) if path else ""
            self.bridge.wallpaperChanged.emit(json.dumps({"project": project, **wallpaper.for_project(self.desktop.config, project), "error": error}))

        self.step_aside()
        wallpaper.pick(self, os.path.dirname(now["path"]), chosen)

    def open_file(self, sha: str, filename: str) -> None:
        open_kept_file(sha, filename)

    def opened(self) -> None:
        self.desktop.bar.changed()

    def closed(self) -> None:
        self.desktop.bar.changed()
