# SPDX-License-Identifier: GPL-3.0-only
# Copyright (c) 2026 Jeff Moore
"""
The calendar (calendar_panel.py, not calendar.py, which would hide Python's own
module of that name): the accounts' events, read and written, in a panel that comes
up from the bar's date and time.

**The panel** is an overlay (overlay.py), as Morgan's conversation is: up over
a dimmed screen with the windows' or the drawers' motion, away on a press off
it, and full screen by its expand button.

**The data** is Evolution Data Server's, through `calendard.py`, a child
process speaking JSON lines (why a process of its own is said there); the
accounts are GNOME Online Accounts', added in Settings, Accounts. Talaris
keeps no events of its own.
"""

from __future__ import annotations

import json
import os
import sys

from PySide6.QtCore import QObject, QProcess, QTimer, Signal, Slot
from PySide6.QtWebEngineCore import QWebEngineProfile

from core import Bridge
from overlay import Overlay
from views import log

HERE = os.path.dirname(os.path.abspath(__file__))
#: What to install when the calendar's bindings are missing.
NEEDS = ("gir1.2-ecal-2.0 gir1.2-edataserver-1.2 gir1.2-ebook-1.2 gir1.2-ebookcontacts-1.2 "
         "gir1.2-goa-1.0 gnome-online-accounts-gtk evolution-ews")


class CalendarService(QObject):
    """calendard.py, started and spoken to; started again if it falls over, a few times."""

    calendars = Signal(str)
    events = Signal(str)
    done = Signal(str)
    changed = Signal()
    #: `{ready, error, needs}`: whether there is a calendar to show at all.
    status = Signal(str)

    def __init__(self, parent: QObject) -> None:
        super().__init__(parent)
        self.process: QProcess | None = None
        self.last_calendars = "[]"
        self.state = {"ready": False, "error": "Starting", "needs": ""}
        self._buffer = b""
        self._errors = ""
        self._restarts = 0
        self._start()

    def _start(self) -> None:
        p = QProcess(self)
        p.setProgram(sys.executable)
        p.setArguments(["-W", "ignore::DeprecationWarning", os.path.join(HERE, "calendard.py")])
        p.readyReadStandardOutput.connect(self._read)
        p.readyReadStandardError.connect(self._stderr)
        p.finished.connect(self._ended)
        self._errors = ""
        p.start()
        self.process = p

    def _stderr(self) -> None:
        text = bytes(self.process.readAllStandardError()).decode("utf-8", "replace")
        self._errors += text
        for line in text.strip().splitlines():
            log(f"calendar: {line}")

    def _ended(self, code: int, _status) -> None:
        if "Namespace" in self._errors and "not available" in self._errors:
            # The bindings are not installed: say what to install, and do not try again.
            self._tell({"ready": False, "error": "The calendar needs a few packages", "needs": NEEDS})
            return
        self._tell({"ready": False, "error": f"The calendar stopped ({code})", "needs": ""})
        if self._restarts < 3:
            self._restarts += 1
            QTimer.singleShot(3000, self._start)

    def _tell(self, state: dict) -> None:
        log(f"calendar: {'ready' if state.get('ready') else state.get('error', '')}")
        self.state = state
        self.status.emit(json.dumps(state))

    def _read(self) -> None:
        self._buffer += bytes(self.process.readAllStandardOutput())
        *lines, self._buffer = self._buffer.split(b"\n")
        for line in lines:
            try:
                msg = json.loads(line)
            except ValueError:
                continue
            if "ready" in msg:
                self._tell({"ready": bool(msg["ready"]), "error": msg.get("error", ""), "needs": ""})
            elif "calendars" in msg:
                self.last_calendars = json.dumps(msg["calendars"])
                self.calendars.emit(self.last_calendars)
            elif "events" in msg:
                self.events.emit(json.dumps(msg["events"]))
            elif "done" in msg:
                self.done.emit(json.dumps(msg["done"]))
            elif msg.get("changed"):
                self.changed.emit()

    def send(self, msg: dict) -> None:
        if self.process and self.process.state() == QProcess.ProcessState.Running:
            self.process.write((json.dumps(msg) + "\n").encode())

    def stop(self) -> None:
        self._restarts = 3
        if self.process and self.process.state() != QProcess.ProcessState.NotRunning:
            self.process.closeWriteChannel()
            self.process.waitForFinished(1000)


class CalendarBridge(Bridge):
    calendars = Signal(str)
    events = Signal(str)
    done = Signal(str)
    changed = Signal()
    status = Signal(str)

    @Slot(result=str)
    def hello(self) -> str:
        """What there is now, for a page just loaded: the status and the calendars."""
        svc = self.owner.service
        return json.dumps({"status": svc.state, "calendars": json.loads(svc.last_calendars)})

    @Slot(str)
    def ask(self, request: str) -> None:
        """`{do: range|create|update|delete, req, …}`, passed to the calendar's process as it is."""
        msg = json.loads(request)
        if msg.get("do") in ("range", "create", "update", "delete"):
            self.owner.service.send(msg)

    @Slot()
    def accounts(self) -> None:
        """Settings, Accounts."""
        self.owner.file_away()
        self.owner.desktop.settings.open("accounts")


class Calendar(Overlay):
    NAME = "calendar"
    IDLE_MS = 5 * 60 * 1000

    def __init__(self, profile: QWebEngineProfile, desktop, service: CalendarService) -> None:
        super().__init__(profile, desktop, "talaris-ui://ui/calendar.html", CalendarBridge(None, None))
        self.bridge.owner = self
        self.bridge.setParent(self)
        self.service = service
        service.calendars.connect(self.bridge.calendars.emit)
        service.events.connect(self.bridge.events.emit)
        service.done.connect(self.bridge.done.emit)
        service.changed.connect(self.bridge.changed.emit)
        service.status.connect(self.bridge.status.emit)

    def opened(self) -> None:
        self.desktop.bar.bridge.state.emit(json.dumps(self.desktop.bar.describe()))

    def closed(self) -> None:
        self.desktop.bar.bridge.state.emit(json.dumps(self.desktop.bar.describe()))
