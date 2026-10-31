# SPDX-License-Identifier: GPL-3.0-only
# Copyright (c) 2026 Jeff Moore
"""
Files (DESIGN, *Files*): up from the bar's Files button, as every bar item is
(overlay.py) — a panel over the dimmed screen, or by its button a window
Hyprland tiles.

The page (`ui/filespanel.html`) lists every file in the projects and what
Talaris holds for them (the core's `files.ts`), each saying what it is.
What it cannot do in a page is done here: opening a file in its application,
showing it in the file manager, the desktop's chooser for bringing files in,
pinning one to the dock, and opening a page, a task or a person where they live.
"""

from __future__ import annotations

import json
import os
import re
import subprocess

from PySide6.QtCore import Signal, Slot
from PySide6.QtWebEngineCore import QWebEngineProfile

from core import Bridge
from files import choose_files, choose_folder
from views import log
from overlay import Overlay
import spawn

#: What the page may ask the core for: Files' own routes, projects, tags, and a link on a task.
ALLOWED = re.compile(r"^/(files|projects|tags|tasks|entity-types|suggestions)(/|$|\?)|^/entities/[A-Za-z0-9_.:%-]+(/place)?$|^/entities/[A-Za-z0-9_.:%-]+/links$")
HOME = os.path.expanduser("~")


def _in_home(path: str) -> str | None:
    """A path the page names, only if it is in the home folder: nothing else is opened from here."""
    full = os.path.realpath(os.path.expanduser(path or ""))
    return full if full.startswith(HOME + os.sep) else None


def _launch(*args: str) -> None:
    # Apart from Talaris (spawn.py): what you open is not ended when Talaris restarts.
    spawn.start(*args)


class FilesBridge(Bridge):
    #: Files chosen in the desktop's chooser, to bring in: [path].
    chosen = Signal(str)

    @Slot(str, str, str, str)
    def core(self, ident: str, method: str, path: str, body: str) -> None:
        """Answered later, on `coreReply` (core.Bridge.answer_core)."""
        self.answer_core(ident, method, path, body, ALLOWED, timeout=60, who="Files")

    def _follow(self, project: str) -> None:
        """To the desktop of the project it belongs to, first: what opens opens there, and you with it."""
        desktop = self.owner.desktop
        if project and project != desktop.project.get("id"):
            desktop.go_to_project(project)

    @Slot(str, str)
    def open(self, path: str, project: str) -> None:
        """A file in its application, as the system opens it — on its project's desktop."""
        full = _in_home(path)
        if full and os.path.exists(full):
            # Out of the way of what opens: the panel goes (a window stays, as windows do).
            self.owner.file_away()
            self._follow(project)
            _launch("xdg-open", full)

    @Slot(str, str)
    def reveal(self, path: str, project: str) -> None:
        """A file shown in the file manager, chosen there; a folder, opened — on its project's desktop."""
        full = _in_home(path)
        if not full:
            return
        self.owner.file_away()
        self._follow(project)
        if os.path.isdir(full):
            _launch("xdg-open", full)
            return
        # The file managers' own way to show one chosen (Nautilus, Dolphin, Nemo…); else its folder.
        uri = "file://" + full
        try:
            subprocess.run(["gdbus", "call", "--session", "--dest", "org.freedesktop.FileManager1", "--object-path", "/org/freedesktop/FileManager1",
                            "--method", "org.freedesktop.FileManager1.ShowItems", f"['{uri}']", ""], timeout=3, check=True,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except (OSError, subprocess.SubprocessError):
            _launch("xdg-open", os.path.dirname(full))

    @Slot()
    def choose(self) -> None:
        """Files from elsewhere, from the desktop's chooser, to bring in."""
        self.owner.choose()

    @Slot()
    def chooseFolder(self) -> None:  # noqa: N802 — called from the page by this name
        """A folder from elsewhere: everything in it, and in its folders, to bring in as shortcuts."""
        self.owner.choose_folder()

    @Slot(str, str)
    def pin(self, path: str, name: str) -> None:
        """A file pinned to the dock, in this project."""
        full = _in_home(path)
        if full and os.path.isfile(full):
            self.owner.desktop.dock.pin_doc({"kind": "file", "target": full, "name": name or os.path.basename(full)}, "", "here")

    @Slot(str, str)
    def page(self, project: str, path: str) -> None:
        """A writing page, opened in Writing, in its project."""
        where = re.sub(r"\.md$", "", re.sub(r"^Writing/", "", path))
        self.owner.file_away()
        self.owner.desktop.open_place("page", project, where)

    @Slot(str, str)
    def thing(self, kind: str, entity: str) -> None:
        """What a file is on — a task, a person — opened where it lives."""
        from desktop_api import opened
        self.owner.file_away()
        said = opened(self.owner.desktop, {"kind": kind, "id": entity})
        if not said.get("ok"):
            log(f"files: could not open {kind} {entity}: {said.get('error')}")


class FilesPanel(Overlay):
    NAME = "files"
    LAZY = True
    TITLE = "Library"
    IDLE_MS = 10 * 60 * 1000

    def __init__(self, profile: QWebEngineProfile, desktop) -> None:
        super().__init__(profile, desktop, "talaris-ui://ui/filespanel.html", FilesBridge(None, None))
        self.bridge.owner = self
        self.bridge.setParent(self)

    def describe(self) -> dict:
        # The project you are in: what the list starts on, and where a file dropped goes.
        return {**super().describe(), "project": self.desktop.project.get("id", "")}

    def choose(self) -> None:
        choose_files(self, "Files to bring in", lambda paths: self.bridge.chosen.emit(json.dumps(paths)))

    def choose_folder(self) -> None:
        """A whole folder, handed to the page: the core looks in it, links it, and watches it (files.ts, linked folders)."""
        choose_folder(self, "A folder to link", lambda folder: folder and self.bridge.chosen.emit(json.dumps({"folder": folder})))

    def opened(self) -> None:
        self.desktop.bar.changed()

    def closed(self) -> None:
        self.desktop.bar.changed()
