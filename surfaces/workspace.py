# SPDX-License-Identifier: GPL-3.0-only
# Copyright (c) 2026 Jeff Moore
"""
The canvas and the writing surface: up from the bar, as Morgan's
conversation and the calendar are.

**What were drawers** (until 2026-10-24) — panels that slid from an edge, with
handles, edge sensors and a desktop of their own when expanded — are now what
every bar item is (overlay.py): a panel centered over the dimmed screen, wider
than tall, away on a press off it; or, by its button, an ordinary window that
Hyprland tiles beside the rest.

The page is the drawers' own (`ui/drawer.html?drawer=…`), told it is a panel
by its state: mode `expanded` while out, with the insets that center it, and
`filed` once gone, so that the next time it arrives; loaded as a window
(`?window=1`), it fills the window.
"""

from __future__ import annotations

import json

from PySide6.QtWebEngineCore import QWebEngineProfile
from PySide6.QtWidgets import QApplication

from core import Bridge
from overlay import Overlay
from views import type_scale, zoom_of

#: A panel's share of the screen: wider than tall, as a desk is.
WIDE, TALL = 0.86, 0.80
#: …and no wider than this, in the page's pixels.
WIDEST = 1500


class Workspace(Overlay):
    def __init__(self, name: str, profile: QWebEngineProfile, desktop) -> None:
        self.NAME = name
        self.TITLE = {"canvas": "Canvas", "writing": "Writing"}.get(name, name.title())
        super().__init__(profile, desktop, f"talaris-ui://ui/drawer.html?drawer={name}", Bridge(None, None))
        self.bridge.owner = self
        self.bridge.setParent(self)

    @property
    def IDLE_MS(self) -> int:  # noqa: N802 — read as the class constant it overrides
        return int(self.desktop.config.get("idleSeconds", 120)) * 1000

    def _insets(self) -> dict:
        """Where the panel sits in the surface, in the page's pixels: centered, wide, and shorter than the screen."""
        screen = QApplication.primaryScreen().geometry()
        z = zoom_of("interface") or 1
        w, h = screen.width() / z, screen.height() / z
        pw, ph = min(WIDEST, w * WIDE), h * TALL
        x, y = round((w - pw) / 2, 1), round((h - ph) / 2, 1)
        return {"top": y, "bottom": y, "left": x, "right": x}

    def describe(self) -> dict:
        return {
            **super().describe(),
            "drawer": self.NAME,
            "edge": "top",
            "mode": "expanded" if self.up else "filed",
            "project": self.desktop.project,
            "look": self.desktop.config["panels"],
            "typeScale": type_scale(self.NAME),
            "insets": self._insets(),
        }

    def opened(self) -> None:
        self.desktop.bar.bridge.state.emit(json.dumps(self.desktop.bar.describe()))

    def closed(self) -> None:
        self.desktop.bar.bridge.state.emit(json.dumps(self.desktop.bar.describe()))

    def show_target(self, target: dict) -> None:
        """Open on one canvas or one page (the launcher asked)."""
        if not self.up and not self.windowed:
            self.open()
        elif self.windowed:
            self.focus_window()
        self.bridge.show.emit(json.dumps(target))

