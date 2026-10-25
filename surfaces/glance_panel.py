# SPDX-License-Identifier: GPL-3.0-only
# Copyright (c) 2026 Jeff Moore
"""
Glance: the current project at a glance (core, glance.ts) — everything that
belongs to it and what that touches, as a list grouped by kind or as a graph
of how it is tied, the project at its middle. From Super+Shift+G, the bar's
project menu, or the launcher; a panel over the dimmed screen like the
others (overlay.py), or a window by its button.

A thing chosen opens where it lives: a page or a canvas in its drawer, a task
in Tasks, a file in its application, anything else as its card.
"""

from __future__ import annotations

import json
import re
import threading

from PySide6.QtCore import Signal, Slot
from PySide6.QtWebEngineCore import QWebEngineProfile

from core import Bridge, local_call
from overlay import Overlay

#: What the page may ask the core for: the glance, and an entity's card.
ALLOWED = re.compile(r"^/(projects/[A-Za-z0-9_]+/glance|entities|mentionables)(/|$|\?)")


class GlanceBridge(Bridge):
    #: The core's answer to `core`: {id, status, data}.
    coreReply = Signal(str)

    @Slot(str, str, str, str)
    def core(self, ident: str, method: str, path: str, body: str) -> None:
        if not ALLOWED.match(path) or method != "GET":
            self.coreReply.emit(json.dumps({"id": ident, "status": 400, "data": {"error": "not a route Glance uses"}}))
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
    def goProject(self, project: str) -> None:  # noqa: N802 — called from the page by this name
        """A project in the graph, gone to: its desktop, and it the current project."""
        self.owner.file_away()
        self.owner.desktop.go_to_project(project, announce=True)


class Glance(Overlay):
    NAME = "glance"
    TITLE = "Glance"
    IDLE_MS = 10 * 60 * 1000

    def __init__(self, profile: QWebEngineProfile, desktop) -> None:
        super().__init__(profile, desktop, "talaris-ui://ui/glance.html", GlanceBridge(None, None))
        self.bridge.owner = self
        self.bridge.setParent(self)

    def describe(self) -> dict:
        # Which project it is a glance of: the current one, as it is opened.
        here = self.desktop.project
        return {**super().describe(), "project": {"id": here.get("id", ""), "name": here.get("name", ""), "code": here.get("code", "")}}

    def opened(self) -> None:
        self.desktop.bar.changed()

    def closed(self) -> None:
        self.desktop.bar.changed()
