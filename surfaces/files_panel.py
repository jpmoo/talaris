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
import threading

from PySide6.QtCore import Signal, Slot
from PySide6.QtWebEngineCore import QWebEngineProfile

from core import Bridge, local_call
from files import choose_files
from views import log
from overlay import Overlay

#: What the page may ask the core for: Files' own routes, projects, tags, and a link on a task.
ALLOWED = re.compile(r"^/(files|projects|tags|tasks|entity-types)(/|$|\?)|^/entities/[A-Za-z0-9_.:%-]+/links$")
HOME = os.path.expanduser("~")


def _in_home(path: str) -> str | None:
    """A path the page names, only if it is in the home folder: nothing else is opened from here."""
    full = os.path.realpath(os.path.expanduser(path or ""))
    return full if full.startswith(HOME + os.sep) else None


def _launch(*args: str) -> None:
    subprocess.Popen(list(args), start_new_session=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


class FilesBridge(Bridge):
    #: The core's answer to `core`: {id, status, data}.
    coreReply = Signal(str)
    #: Files chosen in the desktop's chooser, to bring in: [path].
    chosen = Signal(str)

    @Slot(str, str, str, str)
    def core(self, ident: str, method: str, path: str, body: str) -> None:
        if not ALLOWED.match(path):
            self.coreReply.emit(json.dumps({"id": ident, "status": 400, "data": {"error": "not a route Files uses"}}))
            return

        def run() -> None:
            status, text = local_call(method, path, body or None, timeout=60)
            try:
                data = json.loads(text) if text else None
            except ValueError:
                data = {"error": text}
            self.coreReply.emit(json.dumps({"id": ident, "status": status, "data": data}))
        threading.Thread(target=run, daemon=True).start()

    @Slot(str)
    def open(self, path: str) -> None:
        """A file in its application, as the system opens it."""
        full = _in_home(path)
        if full and os.path.exists(full):
            _launch("xdg-open", full)
            # Out of the way of what opens: the panel goes (a window stays, as windows do).
            self.owner.file_away()

    @Slot(str)
    def reveal(self, path: str) -> None:
        """A file shown in the file manager, chosen there; a folder, opened."""
        full = _in_home(path)
        if not full:
            return
        self.owner.file_away()
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
    def describe(self) -> dict:
        # The project you are in: what the list starts on, and where a file dropped goes.
        return {**super().describe(), "project": self.desktop.project.get("id", "")}

    def choose(self) -> None:
        """Files from elsewhere, from the desktop's chooser, to bring in."""
        self.owner.choose()

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
    TITLE = "Files"
    IDLE_MS = 10 * 60 * 1000

    def __init__(self, profile: QWebEngineProfile, desktop) -> None:
        super().__init__(profile, desktop, "talaris-ui://ui/filespanel.html", FilesBridge(None, None))
        self.bridge.owner = self
        self.bridge.setParent(self)

    def choose(self) -> None:
        choose_files(self, "Files to bring in", lambda paths: self.bridge.chosen.emit(json.dumps(paths)))

    def opened(self) -> None:
        self.desktop.bar.changed()

    def closed(self) -> None:
        self.desktop.bar.changed()
