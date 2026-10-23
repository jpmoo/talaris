# SPDX-License-Identifier: GPL-3.0-only
# Copyright (c) 2026 Jeff Moore
"""
The bar, and the small panel that drops from it.

**The bar** runs along its edge on the `top` layer and reserves its height, so
tiled windows and the drawers keep clear of it. While Noctalia is still running
its own bar holds the same edge; Hyprland stacks reserved space, so this one
sits just inside Noctalia's until Noctalia goes.

**The popup** is a second surface rather than the bar growing taller: a layer
surface changes size only by being made anew, and a bar that blinked every time
a menu opened would read as broken. It hangs from the bar's end, on the
`overlay` layer, and carries every way back a pulled drawer does — Escape, the
bar's button again, the pointer going elsewhere, and a short idle.
"""

from __future__ import annotations

import json
import os
import time

from PySide6.QtCore import QObject, QTimer, Signal, Slot
from PySide6.QtWebEngineCore import QWebEngineProfile
from PySide6.QtWidgets import QApplication

from core import Bridge
from layershell import (
    ANCHOR_BOTTOM,
    ANCHOR_LEFT,
    ANCHOR_RIGHT,
    ANCHOR_TOP,
    KEYBOARD_NONE,
    KEYBOARD_ON_DEMAND,
    OVERLAY,
    TOP,
    LayerSurface,
    Placement,
)
from machine import Machine
from views import log, make_view

#: The bar's thickness. Enough for 14px type and a 24px control with air round it.
BAR = 34

#: What each popup is, and its size. They hang from the bar's right end, where
#: the readings and the power button are.
POPUPS = {"power": (210, 232), "volume": (240, 104)}

#: A popup nobody touches puts itself away.
POPUP_IDLE_MS = 12000

#: Making the surface anew takes its focus away and gives it back, which the
#: page hears as the pointer going elsewhere. For this long after a popup
#: appears, its page cannot send it away.
POPUP_SETTLE_S = 0.5

MORGAN_SOCKET = os.path.join(os.environ.get("XDG_RUNTIME_DIR", f"/run/user/{os.getuid()}"), "heymorgan.sock")


class BarBridge(Bridge):
    """The drawer's bridge, plus what the bar and its popup may ask."""

    #: Pushed to the page: a new reading of the machine.
    machine = Signal(str)

    @Slot(str)
    def volume(self, change: str) -> None:
        self.owner.desktop.machine.volume(change)

    @Slot(str)
    def power(self, verb: str) -> None:
        self.owner.desktop.bar.close_popup()
        self.owner.desktop.machine.power(verb)

    @Slot(str)
    def openTool(self, name: str) -> None:  # noqa: N802 — called from the page by this name
        self.owner.desktop.machine.open_tool(name)

    @Slot(str)
    def popup(self, kind: str) -> None:
        self.owner.desktop.bar.toggle_popup(kind)

    @Slot(result=str)
    def reading(self) -> str:
        return self.owner.desktop.machine.last


class Popup(QObject):
    def __init__(self, profile: QWebEngineProfile, bar: "Bar") -> None:
        super().__init__(bar)
        self.bar = bar
        self.desktop = bar.desktop
        self.kind = ""
        self.shown_at = 0.0
        self.bridge = BarBridge(self, self)
        self.view = make_view(profile, "popup", "talaris-ui://ui/popup.html", self.bridge, self)
        self.surface = LayerSurface(self.view, "talaris-popup")
        self.idle = QTimer(self)
        self.idle.setSingleShot(True)
        self.idle.timeout.connect(self.close)

    def describe(self) -> dict:
        return {"popup": self.kind, "theme": self.desktop.config["theme"]}

    def show(self, kind: str) -> None:
        self.kind = kind
        self.shown_at = time.monotonic()
        w, h = POPUPS[kind]
        anchor = ANCHOR_BOTTOM if self.bar.edge == "bottom" else ANCHOR_TOP
        # Respecting other surfaces' reserved space puts it just clear of the bar.
        self.surface.apply(Placement(OVERLAY, anchor | ANCHOR_RIGHT, w, h, KEYBOARD_ON_DEMAND))
        self.bridge.state.emit(json.dumps(self.describe()))
        self.touched()

    def file_away(self) -> None:
        """From the page — Escape, or the pointer gone elsewhere."""
        if time.monotonic() - self.shown_at < POPUP_SETTLE_S:
            return
        self.close()

    def close(self) -> None:
        if not self.kind:
            return
        self.kind = ""
        self.idle.stop()
        self.view.hide()
        # Gone, so the next `apply` makes it anew rather than thinking it is up.
        self.surface.placement = None
        self.bar.bridge.state.emit(json.dumps(self.bar.describe()))

    # What a page's bridge calls on its owner.
    def toggle(self) -> None:
        self.close()

    def left(self) -> None:
        pass

    def touched(self) -> None:
        if self.kind:
            self.idle.start(POPUP_IDLE_MS)


class Bar(QObject):
    def __init__(self, config: dict, profile: QWebEngineProfile, desktop) -> None:
        super().__init__(desktop)
        self.desktop = desktop
        # Top or bottom, for now. A bar standing on a side edge is a vertical
        # layout of its own, and waits until somebody wants one.
        self.edge = config.get("edge", "top") if config.get("edge") in ("top", "bottom") else "top"
        self.bridge = BarBridge(self, self)
        self.view = make_view(profile, "bar", "talaris-ui://ui/bar.html", self.bridge, self)
        self.surface = LayerSurface(self.view, "talaris-bar")
        self.popup = Popup(profile, self)
        desktop.machine.read.connect(self._reading)
        self.morgan = None
        self._watch = QTimer(self)
        self._watch.timeout.connect(self._morgan)
        self._watch.start(5000)
        self._morgan()

    def place(self) -> None:
        screen = QApplication.primaryScreen().geometry()
        edge = ANCHOR_BOTTOM if self.edge == "bottom" else ANCHOR_TOP
        self.surface.apply(Placement(TOP, edge | ANCHOR_LEFT | ANCHOR_RIGHT, screen.width(), BAR,
                                     KEYBOARD_NONE, exclusive=BAR))

    def describe(self) -> dict:
        return {
            "edge": self.edge,
            "project": self.desktop.project,
            "theme": self.desktop.config["theme"],
            "popup": self.popup.kind,
            # Whether Morgan is here at all; listening, thinking and speaking
            # come with Morgan's face.
            "morgan": self.morgan,
        }

    def _reading(self, text: str) -> None:
        self.bridge.machine.emit(text)
        self.popup.bridge.machine.emit(text)

    def _morgan(self) -> None:
        here = os.path.exists(MORGAN_SOCKET)
        if here != self.morgan:
            self.morgan = here
            self.bridge.state.emit(json.dumps(self.describe()))

    def toggle_popup(self, kind: str) -> None:
        if kind not in POPUPS:
            return
        if self.popup.kind == kind:
            self.popup.close()
            return
        self.popup.show(kind)
        self.bridge.state.emit(json.dumps(self.describe()))
        log(f"popup: {kind}")

    def close_popup(self) -> None:
        self.popup.close()

    # What the bar page's bridge calls on its owner.
    def toggle(self) -> None:
        self.close_popup()

    def file_away(self) -> None:
        self.close_popup()

    def left(self) -> None:
        pass

    def touched(self) -> None:
        pass
