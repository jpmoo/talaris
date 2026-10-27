# SPDX-License-Identifier: GPL-3.0-only
# Copyright (c) 2026 Jeff Moore
"""
A window fullscreen on the desktop in front, noticed and written down — and
the bar still reachable over it.

Fullscreen in Hyprland's own sense (mode 2) covers the background and top
layers: the wallpaper, and the bar with its edge sensor. A window can go there
by itself — Zoom's meeting window came back from a breakout room so, and the
screen was the meeting and nothing else (2026-10-27). Talaris's own key for
filling the screen (Super+Shift+F) is the other mode, maximized, which leaves
the bar where it is.

So while a window is fullscreen the bar hides as if set to, its edge sensor
on the overlay layer above the window: the pointer at the edge brings the bar
out over the window, as a Mac's menu bar comes out over a fullscreen app, and
it goes again when the pointer leaves. When nothing is fullscreen the bar is
as Settings has it.

Each change is logged with the window — which application, its title, which
desktop, and the mode it is in and the one it was told it is in — so that the
next time the screen is taken, the journal says by what.
"""

from __future__ import annotations

import json

from PySide6.QtCore import QObject, QTimer

import hypr
from views import log

#: Hyprland's fullscreen modes, as `j/clients` gives them: what each covers.
FULL = 2


def covering() -> dict | None:
    """The window fullscreen on the workspace in front, covering the layers under the overlay; None if there is none."""
    try:
        active = json.loads(hypr.ask("j/activeworkspace") or "{}")
        clients = json.loads(hypr.ask("j/clients") or "[]")
    except (OSError, ValueError):
        return None
    if not active.get("hasfullscreen"):
        return None
    for c in clients:
        if c.get("workspace", {}).get("id") == active.get("id") and int(c.get("fullscreen", 0)) & FULL:
            return {"address": c.get("address", ""), "class": c.get("class") or c.get("initialClass") or "",
                    "title": c.get("title", ""), "mode": int(c.get("fullscreen", 0)),
                    "client": int(c.get("fullscreenClient", 0)), "workspace": active.get("name", "")}
    return None


class Fullscreen(QObject):
    def __init__(self, desktop) -> None:
        super().__init__(desktop)
        self.desktop = desktop
        #: The window covering the desktop in front, as last seen; None when nothing is.
        self.now: dict | None = None
        ev = desktop.events
        # Looked at again whenever it could have changed: the window's own say, a desktop gone to, a window gone.
        for signal in (ev.fullscreen, ev.workspace, ev.closed):
            signal.connect(lambda *_: QTimer.singleShot(0, self.check))
        QTimer.singleShot(1500, self.check)

    def check(self) -> None:
        now = covering()
        before = self.now
        same = (now or {}).get("address") == (before or {}).get("address") and (now or {}).get("mode") == (before or {}).get("mode")
        self.now = now
        if same:
            return
        if now:
            log(f"fullscreen: {now['class'] or '?'} \"{now['title'][:60]}\" on {now['workspace']}"
                f" (mode {now['mode']}, told {now['client']}): the bar out over it from the edge")
        elif before:
            log(f"fullscreen: nothing covers the desktop in front (was {before['class'] or '?'} on {before['workspace']}); the bar as Settings has it")
        self.desktop.bar.cover(bool(now))
