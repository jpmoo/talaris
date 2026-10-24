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
import re
import threading

from PySide6.QtCore import Signal, Slot
from PySide6.QtWebEngineCore import QWebEngineProfile

from core import Bridge, call as core_call
from overlay import Overlay

#: What the page may ask the core for.
ALLOWED = re.compile(r"^/(tasks|lists|entities|entity-types)(/|$|\?)")


class TasksBridge(Bridge):
    #: The core's answer to `core`: {id, status, data}.
    coreReply = Signal(str)

    @Slot(str, str, str, str)
    def core(self, ident: str, method: str, path: str, body: str) -> None:
        if not ALLOWED.match(path):
            self.coreReply.emit(json.dumps({"id": ident, "status": 400, "data": {"error": "not a route the Tasks panel uses"}}))
            return

        def run() -> None:
            status, text = core_call(method, path, body or None, timeout=30)
            try:
                data = json.loads(text) if text else None
            except ValueError:
                data = {"error": text}
            self.coreReply.emit(json.dumps({"id": ident, "status": status, "data": data}))
        threading.Thread(target=run, daemon=True).start()


class Tasks(Overlay):
    NAME = "tasks"
    TITLE = "Tasks"
    IDLE_MS = 10 * 60 * 1000

    def __init__(self, profile: QWebEngineProfile, desktop) -> None:
        super().__init__(profile, desktop, "talaris-ui://ui/tasks.html", TasksBridge(None, None))
        self.bridge.owner = self
        self.bridge.setParent(self)

    def opened(self) -> None:
        self.desktop.bar.changed()

    def closed(self) -> None:
        self.desktop.bar.changed()
