# SPDX-License-Identifier: GPL-3.0-only
# Copyright (c) 2026 Jeff Moore
"""
A stall of the surfaces' own thread, written down while it happens.

Everything on the screen that is Talaris's is drawn by one thread, and the
clear layer behind a popup is one of its surfaces: while that thread is held,
the pointer moves but nothing anywhere takes a press. It happened for twenty
seconds after the Wi-Fi panel opened (2026-10-28), and left nothing in the
journal to say why.

So a watcher, on a thread of its own, sees the main thread's heartbeat; when
it is late by `LATE_S`, the main thread's stack goes to the journal — once
each stall, with how long it lasted when it ends.
"""

from __future__ import annotations

import sys
import threading
import time
import traceback

from PySide6.QtCore import QObject, QTimer

from views import log

#: How late the heartbeat may be before what the thread is doing is written down.
LATE_S = 2.0
BEAT_MS = 250


class Stall(QObject):
    def __init__(self, parent: QObject) -> None:
        super().__init__(parent)
        self.main = threading.main_thread().ident
        self.beat = time.monotonic()
        self._timer = QTimer(self)
        self._timer.timeout.connect(self._tick)
        self._timer.start(BEAT_MS)
        threading.Thread(target=self._watch, name="stall", daemon=True).start()

    def _tick(self) -> None:
        self.beat = time.monotonic()

    def _watch(self) -> None:
        stalled = 0.0
        while True:
            time.sleep(0.5)
            late = time.monotonic() - self.beat
            if late >= LATE_S and not stalled:
                stalled = self.beat
                frame = sys._current_frames().get(self.main)
                where = "".join(traceback.format_stack(frame)[-12:]) if frame else "(no frame)\n"
                log(f"stall: the main thread has not answered for {late:.1f}s; it is in:\n{where.rstrip()}")
            elif stalled and late < LATE_S:
                log(f"stall: over after {self.beat - stalled:.1f}s")
                stalled = 0.0
