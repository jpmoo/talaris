# SPDX-License-Identifier: GPL-3.0-only
# Copyright (c) 2026 Jeff Moore
"""
Glance: the current project at a glance (core, glance.ts) — everything that
belongs to it and what that touches, as a list grouped by kind or as a graph
of how it is tied, the project at its middle. From Super+Shift+G, the bar's
project menu, or the launcher; a panel over the dimmed screen like the
others (overlay.py), or a window by its button.

Or opened on any one thing (`open_on`: the launcher, Morgan) — a person, a
task, an event, a note, a file — with it at the middle; and for whatever is
at the middle, what it might be tied to and is not (suggest.ts), each with
the ways to tie it, taken or turned down there.

A thing chosen opens where it lives: a page or a canvas in its drawer, a task
in Tasks, a file in its application, anything else as its card.
"""

from __future__ import annotations

import json
import re
import threading

from PySide6.QtCore import Slot
from PySide6.QtWebEngineCore import QWebEngineProfile

from core import Bridge, ask_json
from overlay import Overlay

#: What the page may ask the core for: the glance, an entity's card, and suggested ties.
ALLOWED = re.compile(r"^/(projects/[A-Za-z0-9_]+/glance|entities|mentionables|suggestions)(/|$|\?)")
#: All it may change: a suggestion taken or turned down, a thing told to be quiet.
WRITES = re.compile(r"^/suggestions/(accept|dismiss|quiet|reset)$")


class GlanceBridge(Bridge):
    @Slot(str, str, str, str)
    def core(self, ident: str, method: str, path: str, body: str) -> None:
        """Answered later, on `coreReply` (core.Bridge.answer_core); reads, and only the changes WRITES names."""
        self.answer_core(ident, method, path, body, ALLOWED, timeout=60, who="Glance",
                         writes=lambda m, p: m in ("POST", "PUT") and bool(WRITES.match(p)))

    @Slot(str, str, str)
    def openFile(self, path: str, sha256: str, name: str) -> None:  # noqa: N802 — called from the page by this name
        """A file on things but in no folder: linked from elsewhere in the home folder, or the copy kept, opened in its application."""
        import os
        from PySide6.QtCore import QUrl
        from PySide6.QtGui import QDesktopServices
        home = os.path.realpath(os.path.expanduser("~"))
        if path and os.path.realpath(path).startswith(home + os.sep) and os.path.isfile(path):
            QDesktopServices.openUrl(QUrl.fromLocalFile(path))
            return
        if sha256:
            def run() -> None:
                # Read as every reply is (core.ask_json): an answer cut short is no copy, not a crash.
                got, _why = ask_json("POST", "/files/open-copy", json.dumps({"sha256": sha256, "name": name}), timeout=60)
                copy = (got or {}).get("path", "")
                if copy:
                    QDesktopServices.openUrl(QUrl.fromLocalFile(copy))
            threading.Thread(target=run, daemon=True).start()

    @Slot(str)
    def goProject(self, project: str) -> None:  # noqa: N802 — called from the page by this name
        """A project in the graph, gone to: its desktop, and it the current project."""
        self.owner.file_away()
        self.owner.desktop.go_to_project(project, announce=True)


class Glance(Overlay):
    NAME = "glance"
    LAZY = True
    TITLE = "Glance"
    IDLE_MS = 10 * 60 * 1000

    def __init__(self, profile: QWebEngineProfile, desktop) -> None:
        super().__init__(profile, desktop, "talaris-ui://ui/glance.html", GlanceBridge(None, None))
        self.bridge.owner = self
        self.bridge.setParent(self)

    #: A thing to open on, and a count that tells the page it is asked anew.
    start: dict = {}

    def describe(self) -> dict:
        # Which project it is a glance of: the current one, as it is opened.
        here = self.desktop.project
        return {**super().describe(), "project": {"id": here.get("id", ""), "name": here.get("name", ""), "code": here.get("code", "")},
                "start": self.start}

    def open_on(self, key: str) -> None:
        """Out, with this thing at the middle."""
        self.start = {"key": key, "n": int(self.start.get("n", 0)) + 1}
        if self.up or self.windowed:
            self.bridge.state.emit(json.dumps(self.describe()))
        self.open()

    def opened(self) -> None:
        self.desktop.bar.changed()

    def closed(self) -> None:
        self.desktop.bar.changed()
