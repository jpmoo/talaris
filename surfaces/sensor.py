# SPDX-License-Identifier: GPL-3.0-only
# Copyright (c) 2026 Jeff Moore
"""
Showing a thing when the pointer touches its edge, as an autohiding bar does.

**The edge sensor** is a strip two units thick along an edge, invisible, on
the `top` layer, taking no keyboard and reserving no space: the pointer
touching it says "come out". It is a layer surface like everything else here,
with a page that only reports that it was touched.

**Hover** reports the pointer entering and leaving a surface from Qt's own
events on the view, rather than from inside its page: a drawer holds the
canvas in a frame, and a page's own leave events are easily confused by one.

**Autohide** puts the two together for the bar and the dock: hidden, the
sensor waits; touched, the surface comes out over the windows (reserving
nothing, so the windows keep the space); left for a moment, it goes again.
"""

from __future__ import annotations

from typing import Callable

from PySide6.QtCore import QEvent, QObject, QTimer, Slot
from PySide6.QtWebEngineCore import QWebEngineProfile
from PySide6.QtWidgets import QApplication, QWidget

from core import Bridge
from layershell import EDGE_ANCHOR, EDGE_SPAN, KEYBOARD_NONE, TOP, LayerSurface, Placement
from views import make_view

#: How thick the sensor is, in Qt's units.
THICK = 2
#: How long the pointer must be away before a revealed thing goes again.
AWAY_MS = 700


class SensorBridge(Bridge):
    @Slot()
    def touched(self) -> None:
        self.owner.touched_edge()


class EdgeSensor(QObject):
    def __init__(self, profile: QWebEngineProfile, name: str, edge: str, on_touch: Callable[[], None], parent: QObject) -> None:
        super().__init__(parent)
        self.edge = edge
        self.on_touch = on_touch
        self.up = False
        self.bridge = SensorBridge(self, self)
        self.view = make_view(profile, f"edge-{name}", "talaris-ui://ui/edge.html", self.bridge, self)
        self.surface = LayerSurface(self.view, f"talaris-edge-{name}")

    def describe(self) -> dict:
        return {}

    def show(self, edge: str | None = None) -> None:
        if edge and edge != self.edge:
            self.edge = edge
            self.surface.placement = None
        screen = QApplication.primaryScreen().geometry()
        across = self.edge in ("left", "right")
        w = THICK if across else screen.width()
        h = screen.height() if across else THICK
        self.surface.apply(Placement(TOP, EDGE_ANCHOR[self.edge] | EDGE_SPAN[self.edge], w, h, KEYBOARD_NONE))
        self.up = True

    def hide(self) -> None:
        if self.up:
            self.up = False
            self.view.hide()
            self.surface.placement = None

    def touched_edge(self) -> None:
        self.on_touch()

    # What the page's bridge may call on its owner; a sensor has nothing to do.
    def toggle(self) -> None:
        pass

    def file_away(self) -> None:
        pass

    def left(self) -> None:
        pass

    def touched(self) -> None:
        pass


class Hover(QObject):
    """Calls `on_change(inside)` as the pointer enters and leaves a view."""

    def __init__(self, view: QWidget, on_change: Callable[[bool], None]) -> None:
        super().__init__(view)
        self.on_change = on_change
        view.installEventFilter(self)

    def eventFilter(self, _watched, event) -> bool:  # noqa: N802 — Qt's name
        if event.type() == QEvent.Type.Enter:
            self.on_change(True)
        elif event.type() == QEvent.Type.Leave:
            self.on_change(False)
        return False


class Autohide(QObject):
    """
    A surface that hides itself until its edge is touched.

    `reveal` and `conceal` place and remove the surface; `busy` says whether
    something of it (a popup) is still out, so it is not taken away under it.
    """

    def __init__(self, profile: QWebEngineProfile, name: str, view: QWidget,
                 reveal: Callable[[], None], conceal: Callable[[], None],
                 busy: Callable[[], bool] = lambda: False, parent: QObject | None = None) -> None:
        super().__init__(parent)
        self.on = False
        self.out = False
        self._reveal, self._conceal, self._busy = reveal, conceal, busy
        self.sensor = EdgeSensor(profile, name, "top", self.touched, self)
        self._away = QTimer(self)
        self._away.setSingleShot(True)
        self._away.timeout.connect(self._gone)
        Hover(view, self._hover)

    def set(self, on: bool, edge: str) -> None:
        """Turned on or off, or moved to another edge."""
        self.on = on
        if on:
            self.out = False
            self._conceal()
            self.sensor.show(edge)
        else:
            self.sensor.hide()
            self._away.stop()

    def touched(self) -> None:
        if self.on and not self.out:
            self.out = True
            self._reveal()
            # Out because the pointer came; if it does not stay, it goes.
            self._away.start(AWAY_MS * 2)

    def _hover(self, inside: bool) -> None:
        if not (self.on and self.out):
            return
        if inside:
            self._away.stop()
        else:
            self._away.start(AWAY_MS)

    def _gone(self) -> None:
        if not (self.on and self.out):
            return
        if self._busy():
            self._away.start(AWAY_MS)
            return
        self.out = False
        self._conceal()
