# SPDX-License-Identifier: GPL-3.0-only
# Copyright (c) 2026 Jeff Moore
"""
Project jump: Super+Alt brings up every project in a short list over the
dimmed screen, and the letters typed narrow it — held with Super+Alt, or
after — going to the project the moment only one is left; with more, the
list waits for arrows and Enter, or a click. Super+Alt+a letter typed all
at once goes straight there when one project starts with it.
"""

from __future__ import annotations

import json
import re

from PySide6.QtCore import Signal, Slot
from PySide6.QtGui import QGuiApplication
from PySide6.QtWebEngineCore import QWebEngineProfile

from core import Bridge, call
from layershell import ANCHOR_BOTTOM, ANCHOR_LEFT, ANCHOR_RIGHT, ANCHOR_TOP, KEYBOARD_EXCLUSIVE, OVERLAY, Placement
from overlay import Overlay
from views import log


class JumpBridge(Bridge):
    #: A letter typed with Super+Alt still held, while the list is out: it narrows the list.
    typed = Signal(str)

    @Slot(str)
    def choose(self, project_id: str) -> None:
        self.owner.file_away()
        self.owner.desktop.go_to_project(project_id, announce=True)


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

    def _projects(self) -> list:
        status, text = call("GET", "/projects")
        try:
            return [p for p in json.loads(text) if not p.get("archived")] if status == 200 else []
        except ValueError:
            return []

    def show_all(self) -> None:
        """Super+Alt alone: every project, waiting for a letter."""
        if self.up:
            return
        self.letter, self.projects = "", sorted(self._projects(), key=lambda p: p.get("name", "").lower())
        self.open()

    def jump(self, letter: str) -> None:
        letter = letter[:1].lower()
        if self.up:
            # The list is out (Super+Alt went down first): the letter narrows it, there.
            self.bridge.typed.emit(letter)
            return
        status, text = call("GET", "/projects")
        try:
            projects = [p for p in json.loads(text) if not p.get("archived")] if status == 200 else []
        except ValueError:
            projects = []
        # The start of the name, or of any word in it, as the list matches (jump.html).
        starting = [p for p in projects if any(w.startswith(letter) for w in re.split(r"\W+", p.get("name", "").lower()) if w)]
        if len(starting) == 1:
            if self.up:
                self.file_away()
            self.desktop.go_to_project(starting[0]["id"], announce=True)
            return
        log(f"jump: {letter}, {len(starting)} projects")
        # More than one, or none: the list, holding every project, narrowed to the letter on the page.
        self.letter, self.projects = letter, sorted(projects, key=lambda p: p.get("name", "").lower())
        if self.up:
            self.bridge.state.emit(json.dumps(self.describe()))
        else:
            self.open()
