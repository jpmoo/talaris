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

import time
from typing import Callable

import shiboken6
from PySide6.QtCore import QEvent, QObject, Qt, QTimer, Slot
from PySide6.QtWebEngineCore import QWebEngineProfile
from PySide6.QtWidgets import QApplication, QWidget

import hypr
from core import Bridge
from layershell import EDGE_ANCHOR, EDGE_SPAN, KEYBOARD_NONE, TOP, LayerSurface, Placement, full_screen, to_compositor
from views import make_view

#: The touch target, as Settings sets it (Desktop keeps this current): how
#: thick, in Qt's units, and how much of the edge it covers, in percent,
#: centered. Thicker than the space round the windows, it lies over their edge.
TARGET = {"thick": 6, "length": 100}
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
        #: The top layer, under the drawers; the overlay while a fullscreen window covers the top (fullscreen.py).
        self.layer = TOP
        # Disarmed, a touch does nothing until the pointer has left the strip:
        # put away with the pointer still at the edge, a drawer would otherwise
        # come straight back out under it.
        self.armed = True
        self.bridge = SensorBridge(self, self)
        self.view = make_view(profile, f"edge-{name}", "talaris-ui://ui/edge.html", self.bridge, self)
        self.surface = LayerSurface(self.view, f"talaris-edge-{name}")
        Hover(self.view, lambda inside: None if inside else setattr(self, "armed", True))

    def describe(self) -> dict:
        return {}

    def show(self, edge: str | None = None, layer: int | None = None) -> None:
        if edge and edge != self.edge:
            self.edge = edge
            self.surface.placement = None
        if layer is not None:
            self.layer = layer
        screen = QApplication.primaryScreen().geometry()
        across = self.edge in ("left", "right")
        thick = int(TARGET["thick"])
        share = max(10, min(100, int(TARGET["length"]))) / 100
        long = int((screen.height() if across else screen.width()) * share)
        w, h = (thick, long) if across else (long, thick)
        # The whole edge spans it; a part of it, anchored to the edge alone, is
        # centered along it by the compositor.
        anchors = EDGE_ANCHOR[self.edge] | (EDGE_SPAN[self.edge] if share >= 1 else 0)
        self.surface.placement = None
        self.surface.apply(Placement(self.layer, anchors, w, h, KEYBOARD_NONE))
        self.up = True

    def hide(self) -> None:
        if self.up:
            self.up = False
            self.view.hide()
            self.surface.placement = None

    def touched_edge(self) -> None:
        if self.armed:
            self.on_touch()

    def disarm_if_under_pointer(self) -> None:
        """Disarmed if the pointer is at this edge now, until it leaves."""
        if hypr.near_edge(self.edge, to_compositor(TARGET["thick"]) + 2):
            self.armed = False

    # What the page's bridge may call on its owner; a sensor has nothing to do.
    def toggle(self) -> None:
        pass

    def file_away(self) -> None:
        pass

    def left(self) -> None:
        pass

    def touched(self) -> None:
        pass


class Catcher(QObject):
    """
    A clear layer over the windows, under a pulled drawer: a press on it —
    anywhere off the drawer — puts the drawer away. On the top layer, so the
    drawers (on the overlay) stay above it; reserving nothing, and over the
    bar and dock too (exclusive -1), so it dims all of it as the launcher does.
    """

    def __init__(self, profile: QWebEngineProfile, on_catch: Callable[[], None], parent: QObject, name: str = "catcher") -> None:
        super().__init__(parent)
        self.on_catch = on_catch
        self.up = False
        self.bridge = SensorBridge(self, self)
        self.view = make_view(profile, name, "talaris-ui://ui/catch.html", self.bridge, self)
        self.surface = LayerSurface(self.view, f"talaris-{name}")
        # The press is watched in Qt as well as in the page: the page's own
        # listener did not hear it, and a catcher that misses a click is a
        # drawer that will not go away.
        self._watched = None
        # Dimmed or not, as last asked: said again once the page has loaded — a
        # catcher made on its first use was asked before its page could hear.
        self.dimmed = False
        self.view.loadFinished.connect(lambda _ok: (self._watch(), self.dim(self.dimmed) if self.up else None))

    def describe(self) -> dict:
        return {}

    def dim(self, on: bool) -> None:
        """The rest of the screen sat back behind the drawer, or not; the page fades it."""
        self.dimmed = on
        self.view.page().runJavaScript(f"window.dim && dim({'true' if on else 'false'})")

    def show(self, dim: bool = False, clear_of_bar: bool = False) -> None:
        self.dim(dim)
        if self.up:
            return
        self.surface.placement = None
        # Clear of the bar (a dropdown's): it keeps out of the space the bar
        # reserves, so a press on another of the bar's buttons reaches it.
        self.surface.apply(full_screen(KEYBOARD_NONE, layer=TOP, exclusive=0 if clear_of_bar else -1))
        self.up = True
        self._watch()

    def hide(self) -> None:
        if self.up:
            self.up = False
            self.view.hide()
            self.surface.placement = None

    def _watch(self) -> None:
        target = self.view.focusProxy() or self.view
        if target is not self._watched:
            target.installEventFilter(self)
            self._watched = target

    def eventFilter(self, _watched, event) -> bool:  # noqa: N802 — Qt's name
        if event.type() in (QEvent.Type.MouseButtonPress, QEvent.Type.TouchBegin) and self.up:
            self.touched_edge()
        return False

    def touched_edge(self) -> None:
        if self.up:
            self.on_catch()

    def toggle(self) -> None:
        pass

    def file_away(self) -> None:
        pass

    def left(self) -> None:
        pass

    def touched(self) -> None:
        pass


#: Making a surface anew takes its focus away and gives it back, which its
#: page hears as the pointer going elsewhere. For this long after a dropdown
#: appears, its page cannot send it away.
SETTLE_S = 0.5


class ClickAway(QObject):
    """
    How a dropdown — the bar's popups, the dock's menu — goes when you are
    done with it, other than by its own buttons: a press anywhere off it,
    heard by a clear layer under it that keeps off the bar and the dock so
    their other buttons still answer; and its page saying the pointer went
    elsewhere, which is not believed while it is still settling (`SETTLE_S`).
    One way, for both: they had a way each, and the dock's had neither.
    """

    def __init__(self, profile: QWebEngineProfile, close: Callable[[], None], parent: QObject, name: str) -> None:
        super().__init__(parent)
        self.catcher = Catcher(profile, close, self, name=name)
        self.shown_at = 0.0

    def shown(self) -> float:
        """The dropdown has come out: the layer under it up. Answers when, which names this showing."""
        self.shown_at = time.monotonic()
        self.catcher.show(clear_of_bar=True)
        return self.shown_at

    def settling(self) -> bool:
        """Too soon after it came out for its page's word that the pointer left to mean anything."""
        return time.monotonic() - self.shown_at < SETTLE_S

    def gone(self) -> None:
        self.catcher.hide()


class Presses(QObject):
    """
    A press on a view, seen in Qt, handed to its page as `pressedAt(x, y)` in
    the page's own pixels — for a page that must hear every press (a click off
    the launcher's box), which its own listeners did not always.
    """

    def __init__(self, view: QWidget, dead: Callable[[], None] | None = None) -> None:
        super().__init__(view)
        self.view = view
        self._watched = None
        # A page whose script never ran far enough to hear presses or keys —
        # an error as it loaded — still has to be got rid of: `dead` does it
        # from here, when a press finds no `pressedAt`, or Escape a page that
        # never connected (surface.js sets `talarisAlive`).
        self.dead = dead
        # The engine's widget that takes the presses is made late and anew;
        # looked for again when the page loads and when the view is shown.
        view.loadFinished.connect(lambda _ok: self._watch())
        view.installEventFilter(self)
        self._watch()

    def _watch(self) -> None:
        if not shiboken6.isValid(self.view):
            return
        target = self.view.focusProxy() or self.view
        if target is not self._watched:
            target.installEventFilter(self)
            self._watched = target

    def eventFilter(self, watched, event) -> bool:  # noqa: N802 — Qt's name
        if not shiboken6.isValid(self.view):
            return False
        kind = event.type()
        if kind == QEvent.Type.MouseButtonPress and watched is self._watched:
            z = self.view.zoomFactor() or 1
            p = event.position()
            script = f"window.pressedAt ? (pressedAt({p.x() / z:.1f}, {p.y() / z:.1f}), 1) : (window.talarisAlive ? 1 : 0)"
            self.view.page().runJavaScript(script, 0, self._answered)
        elif kind == QEvent.Type.KeyPress and watched is self._watched and event.key() == Qt.Key.Key_Escape and self.dead:
            self.view.page().runJavaScript("window.talarisAlive || window.pressedAt ? 1 : 0", 0, self._answered)
        elif kind == QEvent.Type.Show and watched is self.view:
            self._watch()
        return False


    def _answered(self, alive) -> None:
        if not alive and self.dead:
            self.dead()


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

    def set(self, on: bool, edge: str, layer: int = TOP) -> None:
        """Turned on or off, or moved to another edge or layer."""
        self.on = on
        if on:
            self.out = False
            self._conceal()
            self.sensor.show(edge, layer)
        else:
            self.sensor.hide()
            self._away.stop()

    def peek(self, ms: int) -> None:
        """Out for a moment, by itself (a project gone to, said on the bar), then away again unless the pointer stays."""
        if self.on and not self.out:
            self.out = True
            self._reveal()
            self._away.start(ms)

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
