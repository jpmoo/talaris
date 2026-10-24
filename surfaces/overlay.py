# SPDX-License-Identifier: GPL-3.0-only
# Copyright (c) 2026 Jeff Moore
"""
A panel that comes up over everything, as Morgan's conversation and the
calendar do.

**Floating:** centered over the rest of the screen, which it dims (the page
draws the panel and the dim; `ui/motion.js` plays its coming and going, with
the windows' or the drawers' motion as Settings says), and a press on the dim
puts it away (`sensor.Presses`, which hears what the page may not).

**Expanded**, as a drawer is: the desktop, on a workspace of its own
(`hypr.DESK`), between the bar and the dock where a window's frame would be,
and below the windows, so one coming back shows above it. A window opened
there, another workspace gone to, or the expand button again brings it back —
or closes it, as Settings' "After full screen" says. Expanding one puts the
drawers and any other expanded panel away.
"""

from __future__ import annotations

import json
import time

from PySide6.QtCore import QObject, QTimer
from PySide6.QtWebEngineCore import QWebEngineProfile
from PySide6.QtWidgets import QApplication

import hypr
from core import Bridge
from layershell import (
    ANCHOR_BOTTOM,
    ANCHOR_LEFT,
    ANCHOR_RIGHT,
    ANCHOR_TOP,
    BOTTOM,
    KEYBOARD_ON_DEMAND,
    OVERLAY,
    QT_SCALE,
    LayerSurface,
    Placement,
)
from sensor import Presses
from views import log, make_view

#: How long the page has to finish leaving before the surface goes anyway.
LEAVE_LIMIT_MS = 1600


class Overlay(QObject):
    #: Who it is: its log's name, its surface's, and its motion's in Settings (`overlays`).
    NAME = ""
    #: Put away after this long untouched; 0 is never.
    IDLE_MS = 0

    def __init__(self, profile: QWebEngineProfile, desktop, url: str, bridge: Bridge, area: str = "interface") -> None:
        super().__init__(desktop)
        self.desktop = desktop
        self.up = False
        self.expanded = False
        self.came_from = None
        self.expanded_at = 0.0
        self.leaving = False
        self.bridge = bridge
        self.view = make_view(profile, self.NAME, url, bridge, self, area=area)
        self.surface = LayerSurface(self.view, f"talaris-{self.NAME}")
        Presses(self.view)
        self.idle = QTimer(self)
        self.idle.setSingleShot(True)
        self.idle.timeout.connect(self._idle)

    def describe(self) -> dict:
        return {"up": self.up, "theme": self.desktop.config["theme"], "expanded": self.expanded,
                "closes": self.desktop.config["panels"].get("afterExpand", "open") == "closed",
                "motion": self.desktop.motion(self.NAME)}

    def _place(self) -> None:
        screen = QApplication.primaryScreen().geometry()
        self.surface.placement = None
        if self.expanded:
            gaps = getattr(self.desktop, "gaps", {})
            margins = tuple(round(gaps.get(side, 0) / QT_SCALE) for side in ("left", "top", "right", "bottom"))
            self.surface.apply(Placement(BOTTOM, ANCHOR_TOP | ANCHOR_BOTTOM | ANCHOR_LEFT | ANCHOR_RIGHT,
                                         screen.width(), screen.height(), KEYBOARD_ON_DEMAND, margins=margins))
        else:
            self.surface.apply(Placement(OVERLAY, ANCHOR_TOP | ANCHOR_BOTTOM | ANCHOR_LEFT | ANCHOR_RIGHT,
                                         screen.width(), screen.height(), KEYBOARD_ON_DEMAND, exclusive=-1))
        self.bridge.state.emit(json.dumps(self.describe()))

    # What a subclass adds to coming and going.
    def opened(self) -> None:
        pass

    def closed(self) -> None:
        pass

    def open(self) -> None:
        self.leaving = False
        if not self.up:
            self.up = True
            self._place()
            log(f"{self.NAME}: open")
            self.opened()
        self.view.setFocus()
        self.touched()

    def toggle(self) -> None:
        if self.up:
            self.file_away()
        else:
            self.open()

    # ------------------------------------------------------------ expanded

    def grow(self) -> None:
        """The expand button: the desktop, or back to a panel (or closed, as Settings says)."""
        if self.expanded:
            self.collapse()
        else:
            self.expand()

    def expand(self) -> None:
        for d in self.desktop.drawers.values():
            d.collapse()
            d.file_away()
        for other in self.desktop.overlays():
            if other is not self and other.expanded:
                other.file_away()
        self.came_from = hypr.windows()["active"]
        self.expanded = True
        self.expanded_at = time.monotonic()
        self.idle.stop()
        self.leaving = False
        was_up, self.up = self.up, True
        self._place()
        if not was_up:
            self.opened()
        self.view.setFocus()
        # The surface first, the workspace after, as for a drawer: making it
        # anew hands the keyboard back to the last window, which Hyprland follows.
        QTimer.singleShot(150, lambda: self.expanded and hypr.go(hypr.DESK))

    def collapse(self, follow: bool = True, close: bool | None = None) -> None:
        """Back to the workspace it was expanded from, with any window opened meanwhile."""
        if not self.expanded:
            return
        self.expanded = False
        now = hypr.windows()
        names = {w["id"]: w["name"] for w in now["workspaces"]}
        if self.came_from is not None:
            for w in now["windows"]:
                if names.get(w["workspace"]) == hypr.DESK:
                    hypr.bring(w["address"], self.came_from)
            if follow and now["activeName"] == hypr.DESK:
                hypr.go(self.came_from)
        if close is None:
            close = self.desktop.config["panels"].get("afterExpand", "open") == "closed"
        if close:
            self.file_away()
        else:
            self._place()
            self.touched()

    def windows_changed(self, now: dict) -> None:
        """Expanded: a window opened on its desktop, or another desktop gone to, makes it a panel again."""
        if not self.expanded or time.monotonic() - self.expanded_at < 0.6:
            return
        names = {w["id"]: w["name"] for w in now["workspaces"]}
        if now["activeName"] != hypr.DESK:
            self.collapse(follow=False)
        elif any(names.get(w["workspace"]) == hypr.DESK and not w["hidden"] for w in now["windows"]):
            self.collapse()

    # ------------------------------------------------------------ going

    def file_away(self) -> None:
        if self.expanded:
            self.collapse(close=True)
            return
        if not self.up:
            return
        self.up = False
        self.idle.stop()
        self.closed()
        # The page plays its leaving, then says so (`left`); then the surface goes.
        self.leaving = True
        self.bridge.leave.emit()
        QTimer.singleShot(LEAVE_LIMIT_MS, self.left)

    def left(self) -> None:
        if not self.leaving:
            return
        self.leaving = False
        self.view.hide()
        self.surface.placement = None

    def touched(self) -> None:
        if self.up and self.IDLE_MS:
            self.idle.start(self.IDLE_MS)

    def busy(self) -> bool:
        """Something under way that idling must not interrupt."""
        return False

    def _idle(self) -> None:
        if self.expanded:
            return
        if self.busy():
            self.touched()
            return
        self.file_away()
