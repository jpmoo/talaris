# SPDX-License-Identifier: GPL-3.0-only
# Copyright (c) 2026 Jeff Moore
"""
The screen's own corners, rounded — by Talaris, not by a screen shader.

A screen shader rounded them once (`screen_shader` in hyprland.conf), and left
broken corners behind: Hyprland repaints only what changed, the shader ran on
part of a frame, and a corner nowhere near what changed was half-drawn until
something repainted the whole screen (2026-10-28).

So each corner is a surface of its own: a small square on the overlay layer,
over everything, fullscreen windows too, taking no press (a press there goes
to whatever is under it). Its black is drawn by Qt, outside a quarter circle,
and the compositor puts the whole square on screen every time.

The size is Settings' (Look, Screen corners), in the screen's pixels; 0 is
square corners and no surfaces at all.
"""

from __future__ import annotations

import math

from PySide6.QtCore import QObject, QPointF, QRectF, Qt
from PySide6.QtGui import QColor, QPainter, QPainterPath
from PySide6.QtWidgets import QWidget

from layershell import ANCHOR_BOTTOM, ANCHOR_LEFT, ANCHOR_RIGHT, ANCHOR_TOP, KEYBOARD_NONE, OVERLAY, QT_SCALE, LayerSurface, Placement

#: Each corner: its anchors, and where in its square the circle's centre is (as fractions of the square).
CORNERS = {
    "top-left": (ANCHOR_TOP | ANCHOR_LEFT, (1, 1)),
    "top-right": (ANCHOR_TOP | ANCHOR_RIGHT, (0, 1)),
    "bottom-left": (ANCHOR_BOTTOM | ANCHOR_LEFT, (1, 0)),
    "bottom-right": (ANCHOR_BOTTOM | ANCHOR_RIGHT, (0, 0)),
}
#: How large Settings may make them.
MOST = 32


class _Corner(QWidget):
    def __init__(self, centre: tuple[int, int]) -> None:
        super().__init__()
        self.centre = centre
        self.setAttribute(Qt.WidgetAttribute.WA_TranslucentBackground)
        self.setWindowFlag(Qt.WindowType.FramelessWindowHint, True)
        # A press in the corner is the screen's, not this surface's.
        self.setWindowFlag(Qt.WindowType.WindowTransparentForInput, True)

    def paintEvent(self, _event) -> None:  # noqa: N802 — Qt's name
        side = float(self.width())
        black = QPainterPath()
        black.addRect(QRectF(0, 0, side, side))
        round_ = QPainterPath()
        round_.addEllipse(QPointF(self.centre[0] * side, self.centre[1] * side), side, side)
        p = QPainter(self)
        p.setRenderHint(QPainter.RenderHint.Antialiasing)
        p.fillPath(black.subtracted(round_), QColor(0, 0, 0))
        p.end()


class Corners(QObject):
    def __init__(self, desktop) -> None:
        super().__init__(desktop)
        self.desktop = desktop
        self.shown: dict[str, tuple[_Corner, LayerSurface]] = {}
        self.apply()

    def radius(self) -> int:
        try:
            return max(0, min(MOST, int(self.desktop.config.get("screen", {}).get("corners", 0))))
        except (TypeError, ValueError):
            return 0

    def apply(self) -> None:
        """As Settings has them: put up at the size set, or taken down at 0."""
        for widget, _surface in self.shown.values():
            widget.hide()
            widget.deleteLater()
        self.shown = {}
        r = self.radius()
        if not r:
            return
        # The setting is the screen's pixels; a surface is sized in Qt's.
        side = max(1, math.ceil(r / QT_SCALE))
        for name, (anchors, centre) in CORNERS.items():
            widget = _Corner(centre)
            widget.resize(side, side)
            surface = LayerSurface(widget, f"talaris-corner-{name}", nudge=False)
            # Over every other surface's reserved space (-1): the screen's very corner, not the bar's.
            surface.apply(Placement(OVERLAY, anchors, side, side, KEYBOARD_NONE, exclusive=-1))
            self.shown[name] = (widget, surface)
