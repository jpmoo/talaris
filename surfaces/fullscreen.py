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

So while a window is fullscreen the bar and the dock hide as if set to, their
edge sensors on the overlay layer above the window: the pointer at the edge
brings one out over the window, as a Mac's menu bar comes out over a
fullscreen app, and it goes again when the pointer leaves. When nothing is
fullscreen they are as Settings has them.

**A game that fills the screen without saying so** counts too: one that makes
a borderless window exactly the monitor's size, floating over everything
rather than asking to be fullscreen, covers the screen all the same — and
would otherwise play under the bar.

And Super+Escape, the key that puts everything away, takes it out of
fullscreen too (`leave`): Zoom, sharing a screen, goes fullscreen and says
Escape brings it back, but its Escape does not always reach the window that
is fullscreen (2026-10-28). Talaris binds Super+Escape itself, so it works
whatever covers the screen; the window goes back to its tile, and is told so.

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
    """
    The window covering the workspace in front: fullscreen (covering the layers
    under the overlay), or the monitor's exact size and place with no frame to
    it (a game, borderless) — None if there is none.
    """
    try:
        active = json.loads(hypr.ask("j/activeworkspace") or "{}")
        clients = json.loads(hypr.ask("j/clients") or "[]")
        monitor = next((m for m in json.loads(hypr.ask("j/monitors") or "[]") if m.get("id") == active.get("monitorID")), None)
    except (OSError, ValueError):
        return None
    here = [c for c in clients if c.get("workspace", {}).get("id") == active.get("id") and c.get("mapped", True) and not c.get("hidden")]

    def said(c: dict, mode: int) -> dict:
        return {"address": c.get("address", ""), "class": c.get("class") or c.get("initialClass") or "",
                "title": c.get("title", ""), "mode": mode, "client": int(c.get("fullscreenClient", 0)),
                "workspace": active.get("name", "")}
    if active.get("hasfullscreen"):
        for c in here:
            if int(c.get("fullscreen", 0)) & FULL:
                return said(c, int(c.get("fullscreen", 0)))
    if monitor:
        scale = float(monitor.get("scale") or 1)
        x, y = monitor.get("x", 0), monitor.get("y", 0)
        w, h = round(monitor.get("width", 0) / scale), round(monitor.get("height", 0) / scale)
        for c in here:
            # Floating, at the monitor's corner and its size: a borderless window filling it. (A tiled one never
            # is — the bar's space is kept from it — and Talaris's own fill, Super+Shift+F, leaves the bar's.)
            if c.get("floating") and list(c.get("at", [])) == [x, y] and list(c.get("size", [])) == [w, h]:
                return said(c, 0)
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
        # A window moved or made to the screen's size (a game going borderless): looked at once things settle.
        self._settle = QTimer(self)
        self._settle.setSingleShot(True)
        self._settle.timeout.connect(self.check)
        ev.windows.connect(lambda: self._settle.start(300))
        QTimer.singleShot(1500, self.check)

    def check(self) -> None:
        now = covering()
        before = self.now
        same = (now or {}).get("address") == (before or {}).get("address") and (now or {}).get("mode") == (before or {}).get("mode")
        self.now = now
        if same:
            return
        if now:
            how = f"mode {now['mode']}, told {now['client']}" if now["mode"] else "the screen's size, borderless"
            log(f"fullscreen: {now['class'] or '?'} \"{now['title'][:60]}\" on {now['workspace']}"
                f" ({how}): the bar and dock out over it from the edge")
        elif before:
            log(f"fullscreen: nothing covers the desktop in front (was {before['class'] or '?'} on {before['workspace']}); the bar and dock as Settings has them")
        self.desktop.bar.cover(bool(now))
        if getattr(self.desktop, "dock", None) is not None:
            self.desktop.dock.cover(bool(now))

    def leave(self) -> bool:
        """The window covering the desktop in front, out of fullscreen and back in its tile; False if none was."""
        now = covering()
        # A borderless window filling the screen is not fullscreen: nothing to take it out of.
        if not now or not now["mode"] or not now["address"].startswith("0x"):
            return False
        hypr.ask(f"/dispatch focuswindow address:{now['address']}")
        # Neither Hyprland's fullscreen nor the one the window was told: it is a window again, and knows it.
        hypr.ask("/dispatch fullscreenstate 0 0")
        log(f"fullscreen: {now['class'] or '?'} taken out of fullscreen (Super+Escape)")
        QTimer.singleShot(0, self.check)
        return True
