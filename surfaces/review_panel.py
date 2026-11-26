# SPDX-License-Identifier: GPL-3.0-only
# Copyright (c) 2026 Jeff Moore
"""
The weekly review (core: review.ts; DESIGN, *The weekly review*): its steps, ticked one by one; the steps for every
week, and for this week only; when it comes and where its task is filed. On this machine's desktop only — not on the
web (docs/WEB.md).

**Brought to you** when it opens: once a review's task is available, a notification Talaris means you not to miss —
in the accent, staying until answered (notifications.py, `prominent`) — whose button opens this. Said once a review,
on each machine (`_said`, kept in the state folder), looked for at start and every quarter hour.

Also from `talaris-surfaces --review`, and the launcher's "Weekly review".
"""

from __future__ import annotations

import datetime
import json
import os
import re

from PySide6.QtCore import QTimer, Slot
from PySide6.QtWebEngineCore import QWebEngineProfile

from core import Bridge, get_json
from overlay import Overlay
from views import log

#: What the page may ask the core for: the review, and to find a thing or a collection for a step, and to mark the task done.
ALLOWED = re.compile(r"^/review(/|$)|^/mentionables\?|^/lists(\?|$)|^/tasks/projects$|^/tasks/[A-Za-z0-9_.:-]+/done$")

#: How often a review opening is looked for.
LOOK_EVERY_MS = 15 * 60 * 1000
SAID = os.path.join(os.environ.get("XDG_STATE_HOME") or os.path.expanduser("~/.local/state"), "talaris", "review-said")


class ReviewBridge(Bridge):
    @Slot(str, str, str, str)
    def core(self, ident: str, method: str, path: str, body: str) -> None:
        """Answered later, on `coreReply` (core.Bridge.answer_core)."""
        self.answer_core(ident, method, path, body, ALLOWED, timeout=30, who="the weekly review")

    @Slot(str)
    def openList(self, list_id: str) -> None:  # noqa: N802 — called from the page by this name
        """A step's collection, in Tasks."""
        self.owner.file_away()
        tasks = getattr(self.owner.desktop, "tasks", None)
        if tasks is not None:
            if hasattr(tasks, "show_list"):
                tasks.show_list(list_id)
            else:
                tasks.open()


class Review(Overlay):
    NAME = "review"
    LAZY = True
    UNLOAD_AFTER_MS = 60_000
    TITLE = "Weekly review"
    IDLE_MS = 30 * 60 * 1000

    def __init__(self, profile: QWebEngineProfile, desktop) -> None:
        super().__init__(profile, desktop, "talaris-ui://ui/review.html", ReviewBridge(None, None))
        self.bridge.owner = self
        self.bridge.setParent(self)
        self._look = QTimer(self)
        self._look.setInterval(LOOK_EVERY_MS)
        self._look.timeout.connect(self.look)
        self._look.start()
        QTimer.singleShot(60_000, self.look)

    #: A review open and not done: the bar's button wears a dot (bar.py, `reviewWaiting`).
    waiting = False

    def _waiting(self, state: dict) -> None:
        was, self.waiting = self.waiting, bool(state.get("configured") and state.get("open") and state.get("task") and not state.get("allDone"))
        if was != self.waiting:
            self.desktop.bar.changed()

    def look(self, now: bool = False) -> None:
        """
        A review newly open, and not yet said on this machine: said, prominently. `now` (`talaris-surfaces
        --review-remind`): said whatever, open or not — to be reminded, or to see how it looks.
        """
        state = get_json("/review", {}) or {}
        self._waiting(state)
        if not state.get("configured") or not state.get("task") or (not now and (not state.get("open") or state.get("allDone"))):
            return
        key = str(state.get("key") or "")
        try:
            with open(SAID, encoding="utf-8") as f:
                if f.read().strip() == key and not now:
                    return
        except OSError:
            pass
        os.makedirs(os.path.dirname(SAID), exist_ok=True)
        with open(SAID, "w", encoding="utf-8") as f:
            f.write(key)
        steps = state.get("steps") or []

        def said(iso: str) -> str:
            try:
                return datetime.date.fromisoformat(iso[:10]).strftime("%A, %B %-d")
            except ValueError:
                return iso
        due = said((state.get("task") or {}).get("due") or "")
        body = f"{len(steps)} step{'s' if len(steps) != 1 else ''}" + (f" · due {due}" if due else "")
        log(f"review: open ({key}), said")
        summary = "Your weekly review is ready" if state.get("open") else f"Your weekly review opens {said((state.get('task') or {}).get('available') or '') or due}"
        self.desktop.notifications.own(summary, body, [("open", "Start the review"), ("later", "Later")],
                                       lambda answer: self.open() if answer in ("open", "default") else None, prominent=True)

    def opened(self) -> None:
        self.desktop.bar.changed()

    def closed(self) -> None:
        # Ticked while it was out: the bar's dot as the review now stands.
        self._waiting(get_json("/review", {}) or {})
        self.desktop.bar.changed()
