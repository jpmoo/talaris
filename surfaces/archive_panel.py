# SPDX-License-Identifier: GPL-3.0-only
# Copyright (c) 2026 Jeff Moore
"""
The archive's browser: archived projects — out of every other list (core,
archive.ts) — by the year they were archived, each opened to read: its pages,
its canvases' words, its files in their applications. Searched on purpose,
and brought back from here: beside a project of its name, or merged into it.

From the bar's project menu ("Archive…"), the launcher (the Archive verb, or
"archive <words>"), or `talaris-surfaces --archive`; a panel over the dimmed
screen like the others (overlay.py), or a window by its button.
"""

from __future__ import annotations

import json
import re
import threading

from PySide6.QtCore import QTimer, Signal, Slot
from PySide6.QtWebEngineCore import QWebEngineProfile

from core import Bridge, local_call
from overlay import Overlay

#: What the page may ask the core for: the archive, an archived project's pages and canvases, and bringing one back.
ALLOWED = re.compile(r"^/(archive(/|$|\?)|projects/[A-Za-z0-9_]+/(page|pages|canvases|restore)(/|$|\?))")


class ArchiveBridge(Bridge):
    #: The core's answer to `core`: {id, status, data}.
    coreReply = Signal(str)

    @Slot(str, str, str, str)
    def core(self, ident: str, method: str, path: str, body: str) -> None:
        writes = method == "POST" and path.endswith("/restore")
        if not ALLOWED.match(path) or (method != "GET" and not writes):
            self.coreReply.emit(json.dumps({"id": ident, "status": 400, "data": {"error": "not a route the archive uses"}}))
            return

        def run() -> None:
            status, text = local_call(method, path, body or None, timeout=120)
            try:
                data = json.loads(text) if text else None
            except ValueError:
                # A page is its Markdown, not JSON: answered as text; a failure says why.
                data = text if status == 200 else {"error": text}
            self.coreReply.emit(json.dumps({"id": ident, "status": status, "data": data}))
            # Back in use: the bar's list and the switcher have it again.
            if writes and status == 200:
                QTimer.singleShot(0, self.owner.desktop.bar.changed)
        threading.Thread(target=run, daemon=True).start()

    @Slot(str)
    def goProject(self, project: str) -> None:  # noqa: N802 — called from the page by this name
        """A project brought back, gone to."""
        self.owner.file_away()
        self.owner.desktop.go_to_project(project, announce=True)


class Archive(Overlay):
    NAME = "archive"
    TITLE = "Archive"
    IDLE_MS = 10 * 60 * 1000

    def __init__(self, profile: QWebEngineProfile, desktop) -> None:
        super().__init__(profile, desktop, "talaris-ui://ui/archive.html", ArchiveBridge(None, None))
        self.bridge.owner = self
        self.bridge.setParent(self)

    def show(self, query: str = "") -> None:
        """Out, searching for `query` if there is one."""
        self.open()
        view = self.window if self.windowed and self.window else self.view
        ask = f"window.ArchivePage && ArchivePage.search({json.dumps(query)})"
        view.page().runJavaScript(ask)
        # The page may still be loading the first time: asked again a moment on.
        QTimer.singleShot(900, lambda: view.page().runJavaScript(ask))

    def opened(self) -> None:
        self.desktop.bar.changed()

    def closed(self) -> None:
        self.desktop.bar.changed()
