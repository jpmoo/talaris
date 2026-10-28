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

from PySide6.QtCore import QTimer, Signal, Slot
from PySide6.QtWebEngineCore import QWebEngineProfile

from core import Bridge
from overlay import Overlay

#: What the page may ask the core for: the archive, an archived project's pages and canvases, and bringing one back.
ALLOWED = re.compile(r"^/(archive(/|$|\?)|projects/[A-Za-z0-9_]+/(page|pages|canvases|restore)(/|$|\?))")


class ArchiveBridge(Bridge):
    #: A project brought back: said from the worker thread, heard on Qt's, where the bar is redrawn.
    restored = Signal()

    @Slot(str, str, str, str)
    def core(self, ident: str, method: str, path: str, body: str) -> None:
        """
        Answered later, on `coreReply` (core.Bridge.answer_core): reads, and
        bringing a project back. A page is its Markdown, not JSON: answered as
        the text (`text_ok`); a failure says why.
        """
        restoring = method.upper() == "POST" and path.endswith("/restore")

        def then(status: int) -> None:
            # Back in use: the bar's list and the switcher have it again.
            if restoring and status == 200:
                self.restored.emit()
        self.answer_core(ident, method, path, body, ALLOWED, timeout=120, who="the archive", text_ok=True, then=then,
                         writes=lambda m, p: m == "POST" and p.endswith("/restore"))

    @Slot(str)
    def goProject(self, project: str) -> None:  # noqa: N802 — called from the page by this name
        """A project brought back, gone to."""
        self.owner.file_away()
        self.owner.desktop.go_to_project(project, announce=True)


class Archive(Overlay):
    NAME = "archive"
    LAZY = True
    TITLE = "Archive"
    IDLE_MS = 10 * 60 * 1000

    def __init__(self, profile: QWebEngineProfile, desktop) -> None:
        super().__init__(profile, desktop, "talaris-ui://ui/archive.html", ArchiveBridge(None, None))
        self.bridge.owner = self
        self.bridge.setParent(self)
        self.bridge.restored.connect(self.desktop.bar.changed)

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
