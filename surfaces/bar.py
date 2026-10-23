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
from sensor import Autohide
from views import log, make_view

#: Room below the bar (or above the dock) for a shadow to fall into.
SHADOW_ROOM = 14

#: The bar's thickness. Enough for 14px type and a 24px control with air round it.
BAR = 34

#: What each popup is, and its size. They hang from the bar's right end, where
#: the readings and the power button are.
POPUPS = {"power": (210, 266), "volume": (240, 104), "network": (300, 420), "bluetooth": (300, 400)}

#: A popup nobody touches puts itself away — later for the ones where a
#: password is typed or a scan is waited on.
POPUP_IDLE_MS = 12000
POPUP_IDLE_LONG_MS = 45000

#: Making the surface anew takes its focus away and gives it back, which the
#: page hears as the pointer going elsewhere. For this long after a popup
#: appears, its page cannot send it away.
POPUP_SETTLE_S = 0.5


def margins(look: dict) -> dict:
    """A floating bar's margins, side by side of the screen: the four set, or `inset` on all of them."""
    inset = int(look.get("inset", 8))
    given = look.get("margins") or {}
    return {side: int(given.get(side, inset)) for side in ("top", "right", "bottom", "left")}


class BarBridge(Bridge):
    """The drawer's bridge, plus what the bar and its popup may ask."""

    #: Pushed to the page: a new reading of the machine.
    machine = Signal(str)
    #: Pushed to the popup: a Wi-Fi or Bluetooth panel's state, `{kind, state, error}`.
    panel = Signal(str)

    @Slot(str, bool)
    def panelRead(self, kind: str, deep: bool) -> None:  # noqa: N802 — called from the page by this name
        self.owner.desktop.machine.panel_read(kind, deep)

    @Slot(str)
    def network(self, request: str) -> None:
        self.owner.desktop.machine.network(json.loads(request))

    @Slot(str)
    def bluetooth(self, request: str) -> None:
        self.owner.desktop.machine.bluetooth(json.loads(request))

    @Slot(str)
    def volume(self, change: str) -> None:
        self.owner.desktop.machine.volume(change)

    @Slot(str)
    def power(self, verb: str) -> None:
        self.owner.desktop.bar.close_popup()
        if verb == "settings":
            self.owner.desktop.settings.open()
        else:
            self.owner.desktop.machine.power(verb)

    @Slot(str)
    def openTool(self, name: str) -> None:  # noqa: N802 — called from the page by this name
        self.owner.desktop.machine.open_tool(name)

    @Slot(str)
    def popup(self, kind: str) -> None:
        self.owner.desktop.bar.toggle_popup(kind)

    @Slot(str)
    def launcher(self, mode: str) -> None:
        self.owner.desktop.bar.close_popup()
        self.owner.desktop.launcher.toggle(mode)

    @Slot()
    def settings(self) -> None:
        self.owner.desktop.bar.close_popup()
        self.owner.desktop.settings.toggle()

    @Slot()
    def morgan(self) -> None:
        self.owner.desktop.bar.close_popup()
        self.owner.desktop.morgan.toggle()

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
        if kind in ("network", "bluetooth"):
            self.desktop.machine.panel_read(kind)
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
            self.idle.start(POPUP_IDLE_LONG_MS if self.kind in ("network", "bluetooth") else POPUP_IDLE_MS)


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
        self.hider = Autohide(profile, "bar", self.view, self._show, self._hide,
                              busy=lambda: bool(self.popup.kind), parent=self)
        desktop.machine.read.connect(self._reading)
        desktop.machine.panel.connect(self.popup.bridge.panel.emit)
        # Morgan's state, from the stream the process follows: the button wears it.
        desktop.morgan_link.state.connect(lambda _now: self.bridge.state.emit(json.dumps(self.describe())))

    def place(self) -> None:
        """Along its edge — or, set to hide, away until the edge is touched."""
        hide = bool(self.desktop.config["bar"].get("autohide"))
        self.hider.set(hide, self.edge)
        if not hide:
            self._show()

    def _show(self) -> None:
        screen = QApplication.primaryScreen().geometry()
        edge = ANCHOR_BOTTOM if self.edge == "bottom" else ANCHOR_TOP
        hide = bool(self.desktop.config["bar"].get("autohide"))
        # A hiding bar reserves nothing: the windows keep the space, and it
        # comes out over them.
        look = self.desktop.config["bar"]
        # Floating, the bar stands off the screen's edges: its surface is the
        # bar and the space between it and the edge, and reserves both.
        near = margins(look)[self.edge] if look.get("shape") == "floating" else 0
        tall = BAR + near
        # A shadow needs room to fall into: the surface is that much taller
        # than the space it reserves, and the extra is clear.
        room = SHADOW_ROOM if look.get("shadow") else 0
        self.surface.placement = None
        self.surface.apply(Placement(TOP, edge | ANCHOR_LEFT | ANCHOR_RIGHT, screen.width(), tall + room,
                                     KEYBOARD_NONE, exclusive=0 if hide else tall))
        self.bridge.state.emit(json.dumps({**self.describe(), "arrived": hide}))

    def _hide(self) -> None:
        self.view.hide()
        self.surface.placement = None

    def describe(self) -> dict:
        return {
            "edge": self.edge,
            "project": self.desktop.project,
            "theme": self.desktop.config["theme"],
            "clock": self.desktop.config["clock"],
            "look": {**self.desktop.config["bar"], "margins": margins(self.desktop.config["bar"])},
            "popup": self.popup.kind,
            # `absent`, `idle`, `listening`, `thinking`… and whether its
            # conversation is out.
            "morgan": self.desktop.morgan_link.now,
            "morganOpen": bool(getattr(self.desktop, "morgan", None) and self.desktop.morgan.up),
        }

    def _reading(self, text: str) -> None:
        self.bridge.machine.emit(text)
        self.popup.bridge.machine.emit(text)

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
