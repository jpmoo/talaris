# SPDX-License-Identifier: GPL-3.0-only
# Copyright (c) 2026 Jeff Moore
"""
People (DESIGN, *People*): up from the bar's People button, as every bar item
is (overlay.py) — a panel over the dimmed screen, or by its button a window
Hyprland tiles.

The page (`ui/people.html`) lists everyone — grouped by organization, or A to
Z — and shows the one chosen: every field the person type has, what they are
connected to, and the contact cards they are tied to, with likely ones
offered. The cards are the address books' (`/contacts/cards`, answered in this
process by the calendar's helper, which holds them); a tie is the person's,
kept in the core.
"""

from __future__ import annotations

import json
import re
import threading

from PySide6.QtCore import QTimer, Signal, Slot
from PySide6.QtWebEngineCore import QWebEngineProfile

from core import Bridge
from files import choose_files, open_kept_file, send_files
from overlay import Overlay

#: What the page may ask the core for.
# And plugins' buttons on a person (peek.js, actionButtons): listed and pressed, nothing else of plugins.
ALLOWED = re.compile(r"^/(people|entities|entity-types|mentionables|contacts/cards|files|tasks|suggestions)(/|$|\?)|^/plugins/actions(\?|$)|^/plugins/[a-z0-9-]+/actions/[a-z0-9-]+$")


class PeopleBridge(Bridge):
    #: Files kept with a person, or why not: {id, field, added, error}.
    attached = Signal(str)

    @Slot(str, str, str, str)
    def core(self, ident: str, method: str, path: str, body: str) -> None:
        """Answered later, on `coreReply` (core.Bridge.answer_core)."""
        self.answer_core(ident, method, path, body, ALLOWED, timeout=30, who="People")

    @Slot(str, str)
    def attach(self, person: str, field: str) -> None:
        """Files for a person's field (their files, or their picture), from the desktop's chooser."""
        self.owner.attach(person, field)

    @Slot(str, str)
    def openFile(self, sha: str, filename: str) -> None:  # noqa: N802 — called from the page by this name
        open_kept_file(sha, filename)


class People(Overlay):
    NAME = "people"
    LAZY = True
    TITLE = "People"
    IDLE_MS = 10 * 60 * 1000

    def __init__(self, profile: QWebEngineProfile, desktop) -> None:
        super().__init__(profile, desktop, "talaris-ui://ui/people.html", PeopleBridge(None, None))
        self.bridge.owner = self
        self.bridge.setParent(self)

    def attach(self, person: str, field: str) -> None:
        def chosen(paths: list) -> None:
            if not paths:
                return
            # A picture is one: the first chosen.
            if field == "image":
                paths = paths[:1]

            def run() -> None:
                added, errors = send_files(f"/entities/{person}/files", paths, {"field": field})
                self.bridge.attached.emit(json.dumps({"id": person, "field": field, "added": added, "error": "; ".join(errors)}))
            threading.Thread(target=run, daemon=True).start()
        choose_files(self, "A picture" if field == "image" else "Files for them", chosen)

    def show_person(self, entity: str) -> None:
        """One person's entry: the panel out (or its window forward), on them."""
        self.open()
        # Its window, if it is one: that page is the one in view.
        view = self.window if self.windowed and self.window else self.view
        ask = f"window.People && People.show({json.dumps(entity)})"
        view.page().runJavaScript(ask)
        # The page may still be loading the first time: asked again a moment on.
        QTimer.singleShot(900, lambda: view.page().runJavaScript(ask))

    def opened(self) -> None:
        self.desktop.bar.changed()

    def closed(self) -> None:
        self.desktop.bar.changed()
