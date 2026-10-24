# SPDX-License-Identifier: GPL-3.0-only
# Copyright (c) 2026 Jeff Moore
"""
Tooltips for the bar and the dock.

Their buttons have always said what they are (`title`), but Qt's own tooltip
is a window of its own, and over a layer surface it never shows; the bar and
the dock are only as tall as their buttons, so the page has nowhere to draw one
either. So a tip is a surface of its own: a label — not a page, so it is up the
moment it is asked for — just clear of the bar or the dock, centered on the
button, never taking the keyboard, and gone when the pointer leaves.

The pages decide when (`ui/tips.js`, after a short rest on a button) and say
what; this only puts it there.
"""

from __future__ import annotations

import glob
import os

from PySide6.QtCore import QObject, QRectF, Qt
from PySide6.QtGui import QColor, QFont, QFontDatabase, QFontMetrics, QPainter, QPen
from PySide6.QtWidgets import QApplication, QLabel

from layershell import ANCHOR_BOTTOM, ANCHOR_LEFT, ANCHOR_TOP, KEYBOARD_NONE, OVERLAY, LayerSurface, Placement
from views import zoom

#: The typefaces the pages use, shipped as web fonts and not installed: Qt is
#: given them too, or a tip would fall back to the system's sans.
FONTS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "ui", "fonts")
_loaded = False


def _load_fonts() -> None:
    global _loaded
    if _loaded:
        return
    for path in glob.glob(os.path.join(FONTS, "*.woff2")):
        QFontDatabase.addApplicationFont(path)
    _loaded = True

#: The theme's colors for a tip (ui/tokens.css): surface, frame, text.
COLORS = {"dark": ("#222528", "#3a3f44", "#d5d9dc"), "light": ("#eceef0", "#b7bcc1", "#25292d")}
PAD_X, PAD_Y = 9, 4
#: Space between the tip and what it is about.
GAP = 6


class _Label(QLabel):
    """
    A label that paints its own rounded, solid background. A stylesheet's
    background is not painted on a translucent window (which the rounded
    corners need), and the tip came out with its words on nothing.
    """

    def __init__(self) -> None:
        super().__init__()
        self.fill, self.edge, self.radius = QColor("#222528"), QColor("#3a3f44"), 5

    def paintEvent(self, event) -> None:  # noqa: N802 — Qt's name
        p = QPainter(self)
        p.setRenderHint(QPainter.RenderHint.Antialiasing)
        p.setPen(QPen(self.edge, 1))
        p.setBrush(self.fill)
        p.drawRoundedRect(QRectF(self.rect()).adjusted(0.5, 0.5, -0.5, -0.5), self.radius, self.radius)
        p.end()
        super().paintEvent(event)


class Tip(QObject):
    def __init__(self, desktop) -> None:
        super().__init__(desktop)
        self.desktop = desktop
        self.label = _Label()
        self.label.setWindowFlag(Qt.WindowType.FramelessWindowHint)
        self.label.setAttribute(Qt.WidgetAttribute.WA_TranslucentBackground)
        self.label.setAttribute(Qt.WidgetAttribute.WA_TransparentForMouseEvents)
        self.label.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.surface = LayerSurface(self.label, "talaris-tip")
        self.text = ""

    def _style(self, area: str) -> QFont:
        _load_fonts()
        theme = self.desktop.config["theme"]
        surface, frame, text = COLORS.get(theme.get("mode"), COLORS["dark"])
        font = QFont(theme.get("font") or "Barlow Semi Condensed")
        # The size the bar or the dock gives its own text (Settings → Look).
        font.setPixelSize(zoom(13, area))
        self.label.setFont(font)
        self.label.fill, self.label.edge, self.label.radius = QColor(surface), QColor(frame), zoom(5)
        self.label.setStyleSheet(f"QLabel {{ background: transparent; color: {text}; padding: {zoom(PAD_Y)}px {zoom(PAD_X)}px; }}")
        return font

    def show(self, text: str, x: float, edge: str, off: int = 0, area: str = "bar") -> None:
        """`text` centered on `x` (screen pixels), just clear of the bar or dock on `edge`; `off` more besides."""
        text = text.strip()
        if not text:
            self.hide()
            return
        font = self._style(area)
        self.label.setText(text)
        metrics = QFontMetrics(font)
        w = metrics.horizontalAdvance(text) + 2 * zoom(PAD_X) + 4
        h = metrics.height() + 2 * zoom(PAD_Y) + 2
        screen = QApplication.primaryScreen().geometry()
        left = max(4, min(int(x - w / 2), screen.width() - w - 4))
        gap = zoom(GAP) + off
        if edge == "top":
            placement = Placement(OVERLAY, ANCHOR_TOP | ANCHOR_LEFT, w, h, KEYBOARD_NONE, margins=(left, gap, 0, 0))
        else:
            placement = Placement(OVERLAY, ANCHOR_BOTTOM | ANCHOR_LEFT, w, h, KEYBOARD_NONE, margins=(left, 0, 0, gap))
        # Respecting the reserved space is what puts it clear of the bar or dock.
        self.surface.placement = None
        self.surface.apply(placement)
        self.text = text

    def hide(self) -> None:
        if self.text:
            self.text = ""
            self.label.hide()
            self.surface.placement = None
