# SPDX-License-Identifier: GPL-3.0-only
# Copyright (c) 2026 Jeff Moore
"""
New (DESIGN, *Entities*): one sheet, from Super+Shift+N anywhere, for making
a thing — a task, an event, a person, a note, a project — without first
opening the place it lives.

The page (`ui/new.html`) makes each through the core, as the Tasks panel
does; an event goes to a calendar through the calendar's own process, where
events are written, and becomes an entity when the calendar is next mirrored.
The keyboard is the sheet's while it is up: it is opened to be typed into.
"""

from __future__ import annotations

import json
import os
import re
import threading

from PySide6.QtCore import Signal, Slot
from PySide6.QtGui import QGuiApplication
from PySide6.QtWebEngineCore import QWebEngineProfile

from core import Bridge, local_call
from layershell import ANCHOR_BOTTOM, ANCHOR_LEFT, ANCHOR_RIGHT, ANCHOR_TOP, KEYBOARD_EXCLUSIVE, OVERLAY, Placement
from overlay import Overlay
from files import choose_files, send_files, send_project_files
from views import log

#: What the page may ask the core for: making things, and finding people and projects.
ALLOWED = re.compile(r"^/(tasks|entities|entity-types|people/find|mentionables|projects)(/|$|\?)")


class NewBridge(Bridge):
    #: The core's answer to `core`: {id, status, data}.
    coreReply = Signal(str)
    #: A calendar's answer to `createEvent`: {req, error, uid}.
    eventMade = Signal(str)
    #: Files chosen for a field, not yet sent: {field, files: [{path, name, size}]}.
    chosen = Signal(str)
    #: Files sent to a thing made: {id, added, error}.
    sent = Signal(str)

    @Slot(str, str, str, str)
    def core(self, ident: str, method: str, path: str, body: str) -> None:
        if not ALLOWED.match(path):
            self.coreReply.emit(json.dumps({"id": ident, "status": 400, "data": {"error": "not a route New uses"}}))
            return

        def run() -> None:
            status, text = local_call(method, path, body or None, timeout=30)
            try:
                data = json.loads(text) if text else None
            except ValueError:
                data = {"error": text}
            self.coreReply.emit(json.dumps({"id": ident, "status": status, "data": data}))
        threading.Thread(target=run, daemon=True).start()

    @Slot(result=str)
    def calendars(self) -> str:
        """The calendars an event can be written to, those turned off left out."""
        return json.dumps(self.owner.calendars())

    @Slot(str, str)
    def createEvent(self, calendar: str, event: str) -> None:  # noqa: N802 — called from the page by this name
        self.owner.create_event(calendar, json.loads(event))

    @Slot(str)
    def chooseFiles(self, field: str) -> None:  # noqa: N802 — called from the page by this name
        """Files for an attachment field, chosen now and sent once the thing is made."""
        def chosen(paths: list) -> None:
            files = []
            self.owner.chosen_paths.update(paths)
            for p in paths:
                try:
                    files.append({"path": p, "name": os.path.basename(p), "size": os.path.getsize(p)})
                except OSError:
                    pass
            self.chosen.emit(json.dumps({"field": field, "files": files}))
        choose_files(self.owner, "Files", chosen)

    @Slot(str, str, str)
    def sendFiles(self, ident: str, field: str, paths: str) -> None:  # noqa: N802 — called from the page by this name
        def run() -> None:
            # Only what the chooser gave: the page names files, it does not get to read any it likes.
            asked = [p for p in json.loads(paths) if p in self.owner.chosen_paths]
            added, errors = send_files(f"/entities/{ident}/files", asked, {"field": field})
            self.sent.emit(json.dumps({"id": ident, "added": added, "error": "; ".join(errors)}))
        threading.Thread(target=run, daemon=True).start()

    @Slot(str, str)
    def sendProjectFiles(self, project: str, paths: str) -> None:  # noqa: N802 — called from the page by this name
        """Chosen files kept in a project's `Files/` (a note's, a new project's): {id: project, added, error, files}."""
        def run() -> None:
            asked = [p for p in json.loads(paths) if p in self.owner.chosen_paths]
            r = send_project_files(project, asked)
            self.sent.emit(json.dumps({"id": project, "added": len(r["files"]), "error": r["error"], "files": r["files"]}))
        threading.Thread(target=run, daemon=True).start()

    @Slot(str, str)
    def openThing(self, kind: str, ident: str) -> None:  # noqa: N802 — called from the page by this name
        """Made, and to be looked at: a task in Tasks, an event in the calendar."""
        self.owner.show_thing(kind, ident)


class New(Overlay):
    NAME = "new"
    TITLE = "New"
    IDLE_MS = 5 * 60 * 1000

    def __init__(self, profile: QWebEngineProfile, desktop, service) -> None:
        super().__init__(profile, desktop, "talaris-ui://ui/new.html", NewBridge(None, None))
        self.bridge.owner = self
        self.bridge.setParent(self)
        self.service = service
        #: Paths the chooser has given the page, the only ones it may send.
        self.chosen_paths: set = set()
        service.made.connect(self.bridge.eventMade.emit)

    def describe(self) -> dict:
        # The current project, which a note is written into unless another is chosen.
        return {**super().describe(), "project": self.desktop.project.get("id", "")}

    def _place(self) -> None:
        # As every panel, the whole screen — but the keyboard is its own: it opened to be typed into.
        screen = QGuiApplication.primaryScreen().geometry()
        self.surface.placement = None
        self.surface.apply(Placement(OVERLAY, ANCHOR_TOP | ANCHOR_BOTTOM | ANCHOR_LEFT | ANCHOR_RIGHT,
                                     screen.width(), screen.height(), KEYBOARD_EXCLUSIVE, exclusive=-1))
        self.bridge.state.emit(json.dumps(self.describe()))

    def grow(self) -> None:
        """A sheet, not a panel: there is no window of it."""

    def calendars(self) -> list:
        hidden = set(self.desktop.config.get("calendar", {}).get("hidden", []))
        try:
            listed = json.loads(self.service.last_calendars)
        except ValueError:
            listed = []
        return [c for c in listed if c.get("writable") and c.get("id") not in hidden]

    def create_event(self, calendar: str, event: dict) -> None:
        req = self.service.make_event(calendar, event)
        log(f"new: an event asked of the calendar ({req})")

    def show_thing(self, kind: str, ident: str) -> None:
        self.file_away()
        if kind == "task":
            self.desktop.show_task(ident)
        elif kind == "event":
            self.desktop.calendar.open()
        elif kind == "page":
            project, _, path = ident.partition("/")
            self.desktop.open_place("page", project, path)

    def opened(self) -> None:
        self.desktop.bar.changed()

    def closed(self) -> None:
        self.desktop.bar.changed()
