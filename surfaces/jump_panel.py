# SPDX-License-Identifier: GPL-3.0-only
# Copyright (c) 2026 Jeff Moore
"""
The project carousel: Super+Tab brings every project up in a ring over the
dimmed screen, most recent first, turned to the one before this — so
Super+Tab and Enter is back where you were. Left and Right turn it (Super+Tab
again, the next one); letters typed narrow it to the projects with them
anywhere in the name, still most recent first, and it goes the moment one is
left. Enter or a click goes to the one in front; Escape puts it away.

It also asks which project, for something else to be done there (`pick`):
the dock's Send to — the same ring, saying what it is for, without the
project you are in, and choosing does that rather than going.
"""

from __future__ import annotations

import json
import os

from PySide6.QtCore import Signal, Slot
from PySide6.QtGui import QGuiApplication
from PySide6.QtWebEngineCore import QWebEngineProfile

from core import Bridge, call
from layershell import ANCHOR_BOTTOM, ANCHOR_LEFT, ANCHOR_RIGHT, ANCHOR_TOP, KEYBOARD_EXCLUSIVE, OVERLAY, Placement
from overlay import Overlay
from views import log

#: The order projects were last gone to, kept across a restart.
RECENT = os.path.join(os.environ.get("XDG_STATE_HOME") or os.path.expanduser("~/.local/state"), "talaris", "recent-projects.json")


class JumpBridge(Bridge):
    #: Super+Tab again while the carousel is out: one on.
    step = Signal(int)

    @Slot(str)
    def choose(self, project_id: str) -> None:
        picking, self.owner.picking = self.owner.picking, None
        self.owner.file_away()
        if picking:
            picking(project_id)
        else:
            self.owner.desktop.go_to_project(project_id, announce=True)


class Jump(Overlay):
    NAME = "jump"
    LAZY = True
    TITLE = "Projects"
    IDLE_MS = 60 * 1000

    def __init__(self, profile: QWebEngineProfile, desktop) -> None:
        super().__init__(profile, desktop, "talaris-ui://ui/jump.html", JumpBridge(None, None))
        self.bridge.owner = self
        self.bridge.setParent(self)
        self.projects: list = []
        #: Asked for a project for something else (`pick`): what it says, and what is done with the one chosen.
        self.prompt = ""
        self.picking = None
        try:
            with open(RECENT, encoding="utf-8") as f:
                self.recent: list[str] = [x for x in json.load(f) if isinstance(x, str)]
        except (OSError, ValueError):
            self.recent = []

    def describe(self) -> dict:
        here = self.desktop.project.get("id", "")
        return {**super().describe(), "prompt": self.prompt, "projects": [{**p, "current": p.get("id") == here} for p in self.projects]}

    def _place(self) -> None:
        # The keyboard is the carousel's while it is out: it was opened by a key, to be answered by keys.
        screen = QGuiApplication.primaryScreen().geometry()
        self.surface.placement = None
        self.surface.apply(Placement(OVERLAY, ANCHOR_TOP | ANCHOR_BOTTOM | ANCHOR_LEFT | ANCHOR_RIGHT,
                                     screen.width(), screen.height(), KEYBOARD_EXCLUSIVE, exclusive=-1))
        self.bridge.state.emit(json.dumps(self.describe()))

    def grow(self) -> None:
        """A carousel, not a panel: there is no window of it."""

    def went(self, project_id: str) -> None:
        """A project gone to, by any way: first in the order."""
        self.recent = [project_id, *[x for x in self.recent if x != project_id]][:200]
        try:
            os.makedirs(os.path.dirname(RECENT), exist_ok=True)
            with open(f"{RECENT}.tmp", "w", encoding="utf-8") as f:
                json.dump(self.recent, f)
            os.replace(f"{RECENT}.tmp", RECENT)
        except OSError as e:
            log(f"projects: the recent order was not kept: {e}")

    def _ordered(self) -> list:
        """Every project not archived, the current first, then by when last gone to; never gone to, by name."""
        status, text = call("GET", "/projects")
        try:
            projects = [p for p in json.loads(text) if not p.get("archived")] if status == 200 else []
        except ValueError:
            projects = []
        here = self.desktop.project.get("id", "")
        rank = {pid: i for i, pid in enumerate([here, *[x for x in self.recent if x != here]])}
        return sorted(projects, key=lambda p: (rank.get(p.get("id"), len(rank)), p.get("name", "").lower()))

    def carousel(self) -> None:
        """Super+Tab: the carousel out; out already, turned one on."""
        if self.up:
            self.bridge.step.emit(1)
            return
        self.prompt, self.picking = "", None
        self.projects = self._ordered()
        self.open()

    def pick(self, prompt: str, then) -> None:
        """Which project, for `then` (given its id): every one but this, most recent first, saying what it is for."""
        here = self.desktop.project.get("id", "")
        self.prompt, self.picking = prompt, then
        self.projects = [p for p in self._ordered() if p.get("id") != here]
        if self.up:
            self.bridge.state.emit(json.dumps(self.describe()))
        else:
            self.open()
