# SPDX-License-Identifier: GPL-3.0-only
# Copyright (c) 2026 Jeff Moore
"""
A window as a wlr-layer-shell surface, through LayerShellQt.

LayerShellQt has a C++ API and no Python bindings, so `Window::get(QWindow*)`
is called through ctypes and everything else is set through the Qt property
system on the object it returns. What the spike learned, and this follows:

- **Per window, before it is first shown** (layer-shell-qt 6): the widget's
  native window made (`winId()`), then `get()`, then the properties set, then
  shown. That window is a layer surface; every other window of the process is
  an ordinary one, which Hyprland tiles — how a panel becomes a window
  (overlay.py). The spike's first finding, that one window of an ordinary
  process fell back to an ordinary window, was `get()` called before the
  native window existed: an orphan the surface never read. Until 2026-10-24
  the whole process ran with `QT_WAYLAND_SHELL_INTEGRATION=layer-shell` instead.
- **A layer, a size or an anchor change needs a new surface.** Setting them on
  a live one did nothing, so `apply` always ends in a hide and show. The page
  inside keeps its state across it.
"""

from __future__ import annotations

import ctypes
import math
import os
from dataclasses import dataclass

import shiboken6
from PySide6.QtCore import QEvent, QMargins, QObject, QTimer
from PySide6.QtWidgets import QWidget

import hypr

_LIB = ctypes.CDLL("libLayerShellQtInterface.so.6")
_get = _LIB._ZN12LayerShellQt6Window3getEP7QWindow
_get.restype = ctypes.c_void_p
_get.argtypes = [ctypes.c_void_p]

# Enum values from LayerShellQt's window.h.
BACKGROUND, BOTTOM, TOP, OVERLAY = 0, 1, 2, 3
ANCHOR_TOP, ANCHOR_BOTTOM, ANCHOR_LEFT, ANCHOR_RIGHT = 1, 2, 4, 8
KEYBOARD_NONE, KEYBOARD_EXCLUSIVE, KEYBOARD_ON_DEMAND = 0, 1, 2

# Qt draws every surface QT_SCALE_FACTOR times larger than its size in Qt's
# units, but hands the exclusive zone to the compositor as given. At 1.25 the
# 34px bar was drawn 43px tall and reserved 34, so windows ran under it.
QT_SCALE = float(os.environ.get("QT_SCALE_FACTOR") or 1)


def to_compositor(px: float) -> int:
    """A length in Qt's units, as the compositor measures it — rounded up, as Qt draws a part pixel whole."""
    return math.ceil(px * QT_SCALE - 1e-9)


def whole(units: int) -> int:
    """
    The nearest length to `units` that lands on whole pixels all the way to the
    screen. Qt draws a surface QT_SCALE_FACTOR times its size, and the
    compositor shows that at the monitor's scale; at 1.25 and 1.25 the bar's
    49 units were 61.25 and then 76.56 pixels, and the bar came out squeezed
    from top to bottom — every bottom edge on it fainter than its top. 48 is
    60 and then 75.
    """
    import json

    import hypr
    try:
        monitors = json.loads(hypr.ask("j/monitors") or "[]")
        scale = next((m["scale"] for m in monitors if m.get("focused")), monitors[0]["scale"] if monitors else 1)
    except (ValueError, KeyError, IndexError):
        scale = 1
    whole_at = lambda q, f: abs(q * f - round(q * f)) < 1e-6  # noqa: E731
    step = next((q for q in range(1, 65) if whole_at(q, QT_SCALE) and whole_at(q, QT_SCALE * scale)), 1)
    return max(step, round(units / step) * step)


EDGE_ANCHOR = {"top": ANCHOR_TOP, "bottom": ANCHOR_BOTTOM, "left": ANCHOR_LEFT, "right": ANCHOR_RIGHT}
# The two edges a surface stretches between when it runs along an edge.
EDGE_SPAN = {
    "left": ANCHOR_TOP | ANCHOR_BOTTOM,
    "right": ANCHOR_TOP | ANCHOR_BOTTOM,
    "top": ANCHOR_LEFT | ANCHOR_RIGHT,
    "bottom": ANCHOR_LEFT | ANCHOR_RIGHT,
}


@dataclass(frozen=True)
class Placement:
    """Where a surface is: everything about it that takes a new surface to change."""

    layer: int
    anchors: int
    width: int
    height: int
    keyboard: int = KEYBOARD_NONE
    # -1 asks other surfaces' exclusive zones to be ignored; 0 respects them
    # (a drawer stays clear of the bar); a positive number reserves space.
    exclusive: int = 0
    # Distance from the anchored edges (left, top, right, bottom), in Qt's
    # units: how a menu is put just above the dock item it belongs to.
    margins: tuple[int, int, int, int] = (0, 0, 0, 0)


class _Exposed(QObject):
    """Hears the compositor put a surface on screen (Qt's expose), and gives the pointer back then."""

    def eventFilter(self, watched, event) -> bool:  # noqa: N802 — Qt's name
        if event.type() == QEvent.Type.Expose and watched.isExposed():
            # Again later too: the first time, the page inside may not have
            # drawn yet, and a page that has not drawn does not set its cursor.
            # Each looks where the pointer is then, so a moving one is not pulled back.
            for ms in (20, 300, 700):
                QTimer.singleShot(ms, hypr.refocus_pointer)
        return False


class LayerSurface:
    """One widget, drawn as a layer surface, re-placed on demand."""

    def __init__(self, widget: QWidget, scope: str, nudge: bool = True) -> None:
        self.widget = widget
        self.scope = scope
        # A page that says when it has drawn (a panel's) gives the pointer back
        # then (core.Bridge.drawn): nudged before, it answered with an arrow.
        self.nudge = nudge
        self._window: QObject | None = None
        self._exposed = None
        self.placement: Placement | None = None

    def _attach(self) -> QObject:
        if self._window is None:
            ptr = _get(shiboken6.getCppPointer(self.widget.windowHandle())[0])
            self._window = shiboken6.wrapInstance(ptr, QObject)
        return self._window

    def apply(self, placement: Placement) -> None:
        """Put the surface where `placement` says, by making it anew there."""
        if placement == self.placement and self.widget.isVisible():
            return
        # Sized before it is shown, so the compositor is never handed Qt's
        # 640×480 default for a frame before the real size arrives.
        if placement.width and placement.height:
            self.widget.resize(placement.width, placement.height)
        # The native window first, and layer-shell attached to it, before it is ever shown.
        self.widget.winId()
        window = self._attach()
        window.setProperty("scope", self.scope)
        window.setProperty("layer", placement.layer)
        window.setProperty("anchors", placement.anchors)
        window.setProperty("keyboardInteractivity", placement.keyboard)
        window.setProperty("margins", QMargins(*(to_compositor(m) for m in placement.margins)))
        window.setProperty("exclusionZone", to_compositor(placement.exclusive) if placement.exclusive > 0 else placement.exclusive)
        self.widget.hide()
        self.widget.show()
        self.placement = placement
        # Hyprland let go of the pointer when this appeared; it is given back
        # (hypr.py) once the compositor has put the surface on screen — which
        # the first time, a page and its drawing made, takes longer than any
        # guess — heard as Qt's expose.
        if self._exposed is None and self.nudge:
            self._exposed = _Exposed(self.widget)
            self.widget.windowHandle().installEventFilter(self._exposed)
