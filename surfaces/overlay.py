# SPDX-License-Identifier: GPL-3.0-only
# Copyright (c) 2026 Jeff Moore
"""
What opens from the bar — Morgan's conversation, the calendar — as a panel,
or as a window.

**A panel:** centered over the rest of the screen, which it dims (the page
draws the panel and the dim; `ui/motion.js` plays its coming and going, with
the windows' or the drawers' motion as Settings says), a layer surface over
everything; a press on the dim puts it away (`sensor.Presses`, which hears
what the page may not).

**A window:** the panel's button (the expand corners) makes it an ordinary
window of this process — the same page, loaded again with `?window=1`, sharing
the panel's bridge — which Hyprland tiles beside the rest, and puts full screen
by its own key. A window has one button, close; closed by it or as any window
is closed, it is put away, and the bar opens the panel again next time. What was a desktop of
its own for this (`hypr.DESK`) is not needed: a window is already where windows
are. Layer surfaces and ordinary windows share the process because layer-shell
is attached per window (layershell.py).
"""

from __future__ import annotations

import json
import os

from PySide6.QtCore import QEvent, QObject, Qt, QTimer
from PySide6.QtWebEngineCore import QWebEngineProfile
from PySide6.QtWidgets import QApplication

import hypr
from core import Bridge
from layershell import ANCHOR_BOTTOM, ANCHOR_LEFT, ANCHOR_RIGHT, ANCHOR_TOP, KEYBOARD_ON_DEMAND, OVERLAY, LayerSurface, Placement
from sensor import Presses
from views import log, make_view

def point_at(view) -> None:
    """
    The pointing hand, from Qt, until the page says otherwise. A page sets its
    cursor only after a move it has seen, and one shown for the first time has
    seen none: the pointer, over the dim where the bar's button was, showed an
    arrow until it moved. The dim is a button (a press there closes the panel).
    """
    target = view.focusProxy() or view
    target.setCursor(Qt.CursorShape.PointingHandCursor)


def viewport(view) -> list:
    """The size a page will be once its surface covers the screen, in its own pixels: arriving waits for it."""
    screen = QApplication.primaryScreen().geometry()
    z = view.zoomFactor() or 1
    return [round(screen.width() / z), round(screen.height() / z)]


#: How long the page has to finish leaving before the surface goes anyway.
LEAVE_LIMIT_MS = 1600
#: A window's size when first made, before Hyprland tiles it.
WINDOW_SIZE = (1000, 720)


class Overlay(QObject):
    #: Who it is: its log's name, its surface's, and its motion's in Settings (`overlays`).
    NAME = ""
    #: Its window's title, which Hyprland and the dock show.
    TITLE = ""
    #: Put away after this long untouched; 0 is never.
    IDLE_MS = 0

    def __init__(self, profile: QWebEngineProfile, desktop, url: str, bridge: Bridge, area: str = "interface") -> None:
        super().__init__(desktop)
        self.desktop = desktop
        self.profile, self.url, self.area = profile, url, area
        self.up = False
        self.leaving = False
        self.bridge = bridge
        self.view = make_view(profile, self.NAME, url, bridge, self, area=area)
        self.surface = LayerSurface(self.view, f"talaris-{self.NAME}", nudge=False)
        Presses(self.view)
        # The same page as an ordinary window, made the first time it is wanted.
        self.window = None
        self.windowed = False
        self.idle = QTimer(self)
        self.idle.setSingleShot(True)
        self.idle.timeout.connect(self._idle)

    def describe(self) -> dict:
        return {"up": self.up, "theme": self.desktop.config["theme"], "windowed": self.windowed,
                "motion": self.desktop.motion(self.NAME), "viewport": viewport(self.view)}

    def _place(self) -> None:
        screen = QApplication.primaryScreen().geometry()
        self.surface.placement = None
        self.surface.apply(Placement(OVERLAY, ANCHOR_TOP | ANCHOR_BOTTOM | ANCHOR_LEFT | ANCHOR_RIGHT,
                                     screen.width(), screen.height(), KEYBOARD_ON_DEMAND, exclusive=-1))
        self.bridge.state.emit(json.dumps(self.describe()))

    # What a subclass adds to coming and going.
    def opened(self) -> None:
        pass

    def closed(self) -> None:
        pass

    def open(self) -> None:
        if self.windowed:
            self.focus_window()
            return
        self.leaving = False
        if not self.up:
            self.up = True
            point_at(self.view)
            self._place()
            log(f"{self.NAME}: open")
            self.opened()
        self.view.setFocus()
        self.touched()

    def toggle(self) -> None:
        """The bar's button: the panel out or away — or, when it is a window, that window brought forward."""
        if self.windowed:
            self.focus_window()
        elif self.up:
            self.file_away()
        else:
            self.open()

    # ------------------------------------------------------------ a window

    def grow(self) -> None:
        """The panel's button: a window. The window's: a panel again."""
        if self.windowed:
            self.to_panel()
        else:
            self.to_window()

    def to_window(self) -> None:
        if self.window is None:
            sep = "&" if "?" in self.url else "?"
            self.window = make_view(self.profile, f"{self.NAME}-window", f"{self.url}{sep}window=1", self.bridge, self, area=self.area)
            self.window.setWindowTitle(self.TITLE or self.NAME.title())
            self.window.resize(*WINDOW_SIZE)
            self.window.installEventFilter(self)
        # The panel goes at once — the window is where it went.
        if self.up:
            self.up = False
            self.leaving = False
            self.idle.stop()
            self.view.hide()
            self.surface.placement = None
        self.windowed = True
        self.window.show()
        self.bridge.state.emit(json.dumps(self.describe()))
        self.opened()
        log(f"{self.NAME}: a window")
        QTimer.singleShot(250, self.focus_window)

    def to_panel(self) -> None:
        self.windowed = False
        if self.window is not None:
            self.window.hide()
        self.open()

    def _address(self) -> str:
        """This window's address in Hyprland: this process's window with its title."""
        try:
            clients = json.loads(hypr.ask("j/clients") or "[]")
        except ValueError:
            return ""
        title = self.window.windowTitle() if self.window is not None else ""
        return next((c["address"] for c in clients if c.get("pid") == os.getpid() and c.get("title") == title), "")

    def focus_window(self) -> None:
        address = self._address()
        if address:
            hypr.focus(address)

    def close_window(self) -> None:
        """The window's close button: closed as any window is (the event filter hears it)."""
        if self.window is not None:
            self.window.close()

    def eventFilter(self, watched, event) -> bool:  # noqa: N802 — Qt's name
        # Closed as any window is closed (Hyprland's key, say): put away, a window no longer.
        if watched is self.window and event.type() == QEvent.Type.Close:
            self.windowed = False
            self.bridge.state.emit(json.dumps(self.describe()))
            self.closed()
            log(f"{self.NAME}: window closed")
        return False

    def windows_changed(self, _now: dict) -> None:
        """Nothing to follow: a window is Hyprland's to place."""

    # ------------------------------------------------------------ going

    def file_away(self) -> None:
        # A window stays: it is put away as windows are.
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
        # Gone, said: a page that arrives only from away (the canvas's, the
        # writing's) hears that it is away, so that the next time it arrives.
        self.bridge.state.emit(json.dumps(self.describe()))

    def touched(self) -> None:
        if self.up and self.IDLE_MS:
            self.idle.start(self.IDLE_MS)

    def busy(self) -> bool:
        """Something under way that idling must not interrupt."""
        return False

    def _idle(self) -> None:
        if self.busy():
            self.touched()
            return
        self.file_away()
