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

import json
import math

from PySide6.QtCore import QObject, QPointF, QRectF, Qt
from PySide6.QtGui import QColor, QPainter, QPainterPath
from PySide6.QtWidgets import QWidget

import hypr
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


def monitor_scale() -> float:
    try:
        return float(json.loads(hypr.ask("j/monitors") or "[]")[0].get("scale", 1))
    except (ValueError, IndexError, OSError, TypeError):
        return 1.0


def whole_side(radius: int) -> int:
    """
    A square, in Qt's units, at least `radius` of the screen's pixels across,
    that is a whole number of them and of the display's own pixels too — so
    one pinned to the right or bottom edge meets it. 13 at 1.25 was 16.25 of
    the display's, and left a hairline beside the top-right corner.
    """
    scale = monitor_scale()
    for units in range(1, 200):
        logical = units * QT_SCALE
        if logical + 1e-6 >= radius and abs(logical - round(logical)) < 1e-6 and abs(logical * scale - round(logical * scale)) < 1e-6:
            return units
    return max(1, math.ceil(radius / QT_SCALE))


class _Corner(QWidget):
    def __init__(self, centre: tuple[int, int], radius: float) -> None:
        super().__init__()
        self.centre = centre
        #: The curve's radius in Qt's units; the square may be larger, clear past it.
        self.radius = radius
        self.setAttribute(Qt.WidgetAttribute.WA_TranslucentBackground)
        self.setWindowFlag(Qt.WindowType.FramelessWindowHint, True)
        # A press in the corner is the screen's, not this surface's.
        self.setWindowFlag(Qt.WindowType.WindowTransparentForInput, True)

    def paintEvent(self, _event) -> None:  # noqa: N802 — Qt's name
        side, r = float(self.width()), self.radius
        # The screen's corner of this square, and the r × r of it the curve is drawn in.
        cx, cy = (1 - self.centre[0]) * side, (1 - self.centre[1]) * side
        x0, y0 = (cx if cx == 0 else cx - r), (cy if cy == 0 else cy - r)
        black = QPainterPath()
        black.addRect(QRectF(x0, y0, r, r))
        round_ = QPainterPath()
        round_.addEllipse(QPointF(x0 + self.centre[0] * r, y0 + self.centre[1] * r), r, r)
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
        # The setting is the screen's pixels; a surface is sized in Qt's, whole at both scales.
        side = whole_side(r)
        for name, (anchors, centre) in CORNERS.items():
            widget = _Corner(centre, r / QT_SCALE)
            widget.resize(side, side)
            surface = LayerSurface(widget, f"talaris-corner-{name}", nudge=False)
            # Over every other surface's reserved space (-1): the screen's very corner, not the bar's.
            surface.apply(Placement(OVERLAY, anchors, side, side, KEYBOARD_NONE, exclusive=-1))
            self.shown[name] = (widget, surface)
