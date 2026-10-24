# SPDX-License-Identifier: GPL-3.0-only
# Copyright (c) 2026 Jeff Moore
"""
Project jump: Super+Alt+a letter goes to the project whose name starts with
it. One such project, and it is simply the current project now; more than
one, and they are offered in a short list over the dimmed screen — arrows and
Enter, a click, or more letters typed to narrow it. None, and the list says
so and goes.
"""

from __future__ import annotations

import json

from PySide6.QtCore import Slot
from PySide6.QtGui import QGuiApplication
from PySide6.QtWebEngineCore import QWebEngineProfile

from core import Bridge, call
from layershell import ANCHOR_BOTTOM, ANCHOR_LEFT, ANCHOR_RIGHT, ANCHOR_TOP, KEYBOARD_EXCLUSIVE, OVERLAY, Placement
from overlay import Overlay
from views import log


class JumpBridge(Bridge):
    @Slot(str)
    def choose(self, project_id: str) -> None:
        self.owner.file_away()
        self.owner.desktop.go_to_project(project_id)


class Jump(Overlay):
    NAME = "jump"
    TITLE = "Projects"
    IDLE_MS = 60 * 1000

    def __init__(self, profile: QWebEngineProfile, desktop) -> None:
        super().__init__(profile, desktop, "talaris-ui://ui/jump.html", JumpBridge(None, None))
        self.bridge.owner = self
        self.bridge.setParent(self)
        self.letter = ""
        self.projects: list = []

    def describe(self) -> dict:
        here = self.desktop.project.get("id", "")
        return {**super().describe(), "letter": self.letter,
                "projects": [{**p, "current": p.get("id") == here} for p in self.projects]}

    def _place(self) -> None:
        # The keyboard is the list's while it is out: it was opened by a key, to be answered by keys.
        screen = QGuiApplication.primaryScreen().geometry()
        self.surface.placement = None
        self.surface.apply(Placement(OVERLAY, ANCHOR_TOP | ANCHOR_BOTTOM | ANCHOR_LEFT | ANCHOR_RIGHT,
                                     screen.width(), screen.height(), KEYBOARD_EXCLUSIVE, exclusive=-1))
        self.bridge.state.emit(json.dumps(self.describe()))

    def grow(self) -> None:
        """A list, not a panel: there is no window of it."""

    def jump(self, letter: str) -> None:
        letter = letter[:1].lower()
        status, text = call("GET", "/projects")
        try:
            projects = [p for p in json.loads(text) if not p.get("archived")] if status == 200 else []
        except ValueError:
            projects = []
        starting = [p for p in projects if p.get("name", "").lower().startswith(letter)]
        if len(starting) == 1:
            if self.up:
                self.file_away()
            self.desktop.go_to_project(starting[0]["id"])
            return
        log(f"jump: {letter}, {len(starting)} projects")
        # More than one, or none: the list, holding every project, narrowed to the letter on the page.
        self.letter, self.projects = letter, sorted(projects, key=lambda p: p.get("name", "").lower())
        if self.up:
            self.bridge.state.emit(json.dumps(self.describe()))
        else:
            self.open()
