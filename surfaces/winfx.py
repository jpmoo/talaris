# SPDX-License-Identifier: GPL-3.0-only
# Copyright (c) 2026 Jeff Moore
"""
Draw, for windows: the drawers' marks and lines, played over a window as it
opens and closes.

**An overlay, not the window.** Hyprland animates a window but cannot draw
round one, so Talaris draws beside it: a clear layer over the whole screen,
taking neither the pointer nor the keyboard, up only while something is being
drawn. Opening, the lines are drawn where the window is as Hyprland fades it
in (slowly, late — `Desktop.window_motion` sets that); closing, they are
drawn back to their marks where it was as it fades out.

**Where a window was** is remembered, because by the time Hyprland says a
window closed it has none: every change to the windows refreshes the record.
Only windows on the workspace in view are drawn.
"""

from __future__ import annotations

import json

from PySide6.QtCore import QObject, Qt, QTimer, Signal
from PySide6.QtWebEngineCore import QWebEngineProfile
from PySide6.QtWidgets import QApplication

import hypr
from core import Bridge
from layershell import ANCHOR_BOTTOM, ANCHOR_LEFT, ANCHOR_RIGHT, ANCHOR_TOP, KEYBOARD_NONE, QT_SCALE, TOP, LayerSurface, Placement
from views import make_view

#: How long the layer stays up after the last drawing began, at normal speed.
LINGER_MS = 1700


class WinFxBridge(Bridge):
    #: Pushed to the page: draw one — `{kind: "open"|"close", x, y, w, h, speed}`.
    draw = Signal(str)


class WindowDraw(QObject):
    def __init__(self, profile: QWebEngineProfile, desktop) -> None:
        super().__init__(desktop)
        self.desktop = desktop
        self.up = False
        self.where: dict[str, dict] = {}
        self.bridge = WinFxBridge(self, self)
        # Its own area: no text-size zoom, so the page's pixels are the screen's.
        self.view = make_view(profile, "winfx", "talaris-ui://ui/winfx.html", self.bridge, self, area="winfx")
        # Clicks go through to the windows under it.
        self.view.setWindowFlag(Qt.WindowType.WindowTransparentForInput, True)
        self.surface = LayerSurface(self.view, "talaris-winfx")
        self.down = QTimer(self)
        self.down.setSingleShot(True)
        self.down.timeout.connect(self._down)
        self.soon = QTimer(self)
        self.soon.setSingleShot(True)
        self.soon.timeout.connect(self._remember)
        desktop.events.windows.connect(lambda: self.soon.start(120))
        desktop.events.opened.connect(self._opened)
        desktop.events.closed.connect(self._closed)
        self._remember()

    def on(self) -> bool:
        return self.desktop.config["windows"].get("motion") == "draw"

    def _speed(self) -> str:
        return self.desktop.config["windows"].get("speed", "normal")

    # ------------------------------------------------------------ where windows are

    def _clients(self) -> dict[str, dict]:
        """Each window in view: its rectangle on the screen, in Hyprland's (logical) pixels."""
        try:
            clients = json.loads(hypr.ask("j/clients") or "[]")
            monitors = {m["id"]: m for m in json.loads(hypr.ask("j/monitors") or "[]")}
        except ValueError:
            return {}
        shown = {m.get("activeWorkspace", {}).get("id") for m in monitors.values()}
        out = {}
        for c in clients:
            m = monitors.get(c.get("monitor"))
            if not m or c.get("workspace", {}).get("id") not in shown or not c.get("mapped", True):
                continue
            # Hyprland's pixels are the compositor's; the page's are Qt's, each
            # QT_SCALE of the compositor's — so the rectangle is scaled down to them.
            (x, y), (w, h) = c["at"], c["size"]
            out[c["address"]] = {k: round(v / QT_SCALE, 1) for k, v in
                                 {"x": x - m["x"], "y": y - m["y"], "w": w, "h": h}.items()}
        return out

    def _remember(self) -> None:
        self.where = self._clients()

    # ------------------------------------------------------------ drawing

    def _opened(self, address: str) -> None:
        if not self.on():
            return
        # Laid out a moment after it opens; asked then.
        QTimer.singleShot(60, lambda: self._draw("open", self._clients().get(address)))

    def _closed(self, address: str) -> None:
        if self.on():
            self._draw("close", self.where.pop(address, None))

    def _draw(self, kind: str, rect: dict | None) -> None:
        if not rect or rect["w"] < 20 or rect["h"] < 20:
            return
        if not self.up:
            screen = QApplication.primaryScreen().geometry()
            self.surface.placement = None
            self.surface.apply(Placement(TOP, ANCHOR_TOP | ANCHOR_BOTTOM | ANCHOR_LEFT | ANCHOR_RIGHT,
                                         screen.width(), screen.height(), KEYBOARD_NONE, exclusive=-1))
            self.up = True
        self.bridge.draw.emit(json.dumps({"kind": kind, **rect, "speed": self._speed(),
                                          "accent": self.desktop.config["theme"]["accent"]}))
        pace = {"slow": 1.6, "normal": 1, "fast": .6, "fastest": .3}.get(self._speed(), 1)
        self.down.start(int(LINGER_MS * pace) + 200)

    def _down(self) -> None:
        if self.up:
            self.up = False
            self.view.hide()
            self.surface.placement = None

    # What the page's bridge may call on its owner; this layer has no modes.
    def describe(self) -> dict:
        return {"theme": self.desktop.config["theme"]}

    def toggle(self) -> None:
        pass

    def file_away(self) -> None:
        pass

    def left(self) -> None:
        pass

    def touched(self) -> None:
        pass
