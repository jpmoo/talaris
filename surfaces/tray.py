# SPDX-License-Identifier: GPL-3.0-only
# Copyright (c) 2026 Jeff Moore
"""
The tray: running applications' icons on the bar — Nextcloud, BlueBubbles,
whatever puts one up.

The D-Bus side is `trayd.py`, a child process speaking JSON lines (why a
process of its own is said there). This is its Qt end: it starts it, reads
what it says — the items, a menu asked for — and passes on what the bar asks
of an item. If it falls over it is started again, a few times; then the bar
simply has no tray.
"""

from __future__ import annotations

import json
import os
import sys

from PySide6.QtCore import QObject, QProcess, QTimer, Signal

from views import log

HERE = os.path.dirname(os.path.abspath(__file__))
#: Started again after falling over, at most this many times.
RESTARTS = 3


class Tray(QObject):
    #: The items, as `[{id, appId, title, tooltip, status, icon, menu, itemIsMenu}]`.
    items = Signal(str)
    #: A menu asked for: `{id, items}`.
    menu = Signal(str)

    def __init__(self, parent: QObject) -> None:
        super().__init__(parent)
        self.last = "[]"
        self.known: dict[str, dict] = {}
        self._buffer = b""
        self._restarts = 0
        self.process: QProcess | None = None
        self._start()

    def _start(self) -> None:
        p = QProcess(self)
        p.setProgram(sys.executable)
        p.setArguments(["-W", "ignore::DeprecationWarning", os.path.join(HERE, "trayd.py")])
        p.readyReadStandardOutput.connect(self._read)
        p.readyReadStandardError.connect(lambda: log("tray: " + bytes(p.readAllStandardError()).decode("utf-8", "replace").strip()))
        p.finished.connect(self._ended)
        p.start()
        self.process = p

    def _ended(self, code: int, _status) -> None:
        log(f"tray: the tray process ended ({code})")
        self.known = {}
        self.last = "[]"
        self.items.emit(self.last)
        if self._restarts < RESTARTS:
            self._restarts += 1
            QTimer.singleShot(3000, self._start)

    def _read(self) -> None:
        self._buffer += bytes(self.process.readAllStandardOutput())
        *lines, self._buffer = self._buffer.split(b"\n")
        for line in lines:
            try:
                msg = json.loads(line)
            except ValueError:
                continue
            if "items" in msg:
                self.known = {i["id"]: i for i in msg["items"]}
                self.last = json.dumps(msg["items"])
                self.items.emit(self.last)
            elif "menu" in msg:
                self.menu.emit(json.dumps(msg["menu"]))
            elif msg.get("watcher") is False:
                log("tray: another tray holds the watcher's name; Talaris shows none")

    def do(self, **msg) -> None:
        if self.process and self.process.state() == QProcess.ProcessState.Running:
            self.process.write((json.dumps(msg) + "\n").encode())

    def stop(self) -> None:
        self._restarts = RESTARTS
        if self.process and self.process.state() != QProcess.ProcessState.NotRunning:
            self.process.closeWriteChannel()  # it goes when its input does
            self.process.waitForFinished(1000)
