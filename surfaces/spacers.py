# SPDX-License-Identifier: GPL-3.0-only
# Copyright (c) 2026 Jeff Moore
"""
The space round the windows in the carousel, held where nothing else holds it.

The scrolling layout (tiling.py) keeps clear what the screen's edges reserve,
and only now and then Hyprland's gaps. The bar and the dock reserve their gap
beyond themselves (surfaces.py, `edge_gap`); an edge with neither — the sides,
or the bottom while the dock hides — has a spacer here: a layer surface a
pixel thick, on the bottom level under the windows, that reserves the gap and
draws nothing. In Tiles there are none; Hyprland's gaps do it.
"""

from __future__ import annotations

from PySide6.QtCore import Qt
from PySide6.QtWidgets import QApplication, QWidget

from layershell import ANCHOR_BOTTOM, ANCHOR_LEFT, ANCHOR_RIGHT, ANCHOR_TOP, BOTTOM, KEYBOARD_NONE, LayerSurface, Placement

#: Each edge, and the edges a spacer along it spans.
ALONG = {"top": ANCHOR_TOP | ANCHOR_LEFT | ANCHOR_RIGHT, "bottom": ANCHOR_BOTTOM | ANCHOR_LEFT | ANCHOR_RIGHT,
         "left": ANCHOR_LEFT | ANCHOR_TOP | ANCHOR_BOTTOM, "right": ANCHOR_RIGHT | ANCHOR_TOP | ANCHOR_BOTTOM}


class _Spacer:
    def __init__(self, edge: str) -> None:
        self.edge = edge
        self.widget = QWidget()
        self.widget.setAttribute(Qt.WidgetAttribute.WA_TranslucentBackground)
        self.widget.setAttribute(Qt.WidgetAttribute.WA_TransparentForMouseEvents)
        self.widget.setWindowFlags(Qt.WindowType.FramelessWindowHint)
        self.widget.setStyleSheet("background: transparent;")
        self.surface = LayerSurface(self.widget, f"talaris-spacer-{edge}", nudge=False)
        self.gap = 0

    def set(self, gap: int) -> None:
        if gap == self.gap and (gap == 0) == (not self.widget.isVisible()):
            return
        self.gap = gap
        if gap <= 0:
            self.widget.hide()
            self.surface.placement = None
            return
        screen = QApplication.primaryScreen().geometry()
        across = self.edge in ("left", "right")
        w, h = (1, screen.height()) if across else (screen.width(), 1)
        self.surface.placement = None
        self.surface.apply(Placement(BOTTOM, ALONG[self.edge], w, h, KEYBOARD_NONE, exclusive=gap))


_spacers: dict[str, _Spacer] = {}


def hold(gaps: dict[str, int]) -> None:
    """Each edge's spacer reserving its gap (Qt's units), or gone where it is 0."""
    for edge in ALONG:
        gap = int(gaps.get(edge, 0))
        if gap <= 0 and edge not in _spacers:
            continue
        _spacers.setdefault(edge, _Spacer(edge)).set(gap)
