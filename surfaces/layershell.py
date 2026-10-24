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
from PySide6.QtCore import QMargins, QObject
from PySide6.QtWidgets import QWidget

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


class LayerSurface:
    """One widget, drawn as a layer surface, re-placed on demand."""

    def __init__(self, widget: QWidget, scope: str) -> None:
        self.widget = widget
        self.scope = scope
        self._window: QObject | None = None
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
