# SPDX-License-Identifier: GPL-3.0-only
# Copyright (c) 2026 Jeff Moore
"""
The dock: what is open, and where.

Along the bottom with its height reserved, like the bar along the top. It shows
the open windows grouped by workspace — one icon per application per
workspace, a dot under it for each of its windows — and a press goes there.
When projects have workspaces (milestone two), a workspace's group is titled
with its project; until then it wears the workspace's own name.

**Pulled, like everything from the compositor.** An event says the windows
changed; the dock then asks what they are. Events come in bursts — opening a
window is an open, a focus and a title — so it waits a moment and asks once.
"""

from __future__ import annotations

import json

from PySide6.QtCore import QObject, QTimer, Signal, Slot
from PySide6.QtWebEngineCore import QWebEngineProfile
from PySide6.QtWidgets import QApplication

import hypr
from apps import Apps
from core import Bridge
from layershell import ANCHOR_BOTTOM, ANCHOR_LEFT, ANCHOR_RIGHT, ANCHOR_TOP, KEYBOARD_NONE, TOP, LayerSurface, Placement
from views import make_view

#: The dock's thickness: a 32px icon, its dots, and room around them.
DOCK = 50


class DockBridge(Bridge):
    #: Pushed to the page: the windows, grouped and named.
    windows = Signal(str)

    @Slot(str)
    def focus(self, address: str) -> None:
        hypr.focus(address)

    @Slot(str)
    def close(self, address: str) -> None:
        hypr.close(address)

    @Slot(result=str)
    def listing(self) -> str:
        return self.owner.last


class Dock(QObject):
    def __init__(self, config: dict, profile: QWebEngineProfile, desktop, apps: Apps) -> None:
        super().__init__(desktop)
        self.desktop = desktop
        self.apps = apps
        # The bar's edge is the other one; side edges wait, as the bar's do.
        self.edge = config.get("edge", "bottom") if config.get("edge") in ("top", "bottom") else "bottom"
        self.last = "{}"
        self.bridge = DockBridge(self, self)
        self.view = make_view(profile, "dock", "talaris-ui://ui/dock.html", self.bridge, self)
        self.surface = LayerSurface(self.view, "talaris-dock")
        self._soon = QTimer(self)
        self._soon.setSingleShot(True)
        self._soon.timeout.connect(self.refresh)
        desktop.events.windows.connect(lambda: self._soon.start(80))

    def place(self) -> None:
        screen = QApplication.primaryScreen().geometry()
        edge = ANCHOR_TOP if self.edge == "top" else ANCHOR_BOTTOM
        self.surface.apply(Placement(TOP, edge | ANCHOR_LEFT | ANCHOR_RIGHT, screen.width(), DOCK,
                                     KEYBOARD_NONE, exclusive=DOCK))
        self.refresh()

    def describe(self) -> dict:
        return {"edge": self.edge, "theme": self.desktop.config["theme"]}

    def refresh(self) -> None:
        now = hypr.windows()
        names = {w["id"]: w["name"] for w in now["workspaces"]}
        groups: dict[int, dict] = {}
        for w in sorted(now["windows"], key=lambda w: w["recent"]):
            group = groups.setdefault(w["workspace"], {
                "id": w["workspace"], "name": names.get(w["workspace"], str(w["workspace"])),
                "active": w["workspace"] == now["active"], "apps": {},
            })
            app = self.apps.lookup(w["class"])
            entry = group["apps"].setdefault(w["class"], {
                "class": w["class"], "name": app["name"], "icon": app["icon"], "windows": [],
            })
            # Most recently focused first, so a press goes to the one you were in.
            entry["windows"].append({"address": w["address"], "title": w["title"],
                                     "focused": w["address"] == now["focused"]})
        listing = {
            "groups": [
                # Applications in a group keep a steady order — by name — so an
                # icon does not jump about each time focus moves.
                {**g, "apps": sorted(g["apps"].values(), key=lambda a: a["name"].lower())}
                for _, g in sorted(groups.items())
            ],
        }
        text = json.dumps(listing)
        if text != self.last:
            self.last = text
            self.bridge.windows.emit(text)

    # What the page's bridge calls on its owner; a dock has no modes.
    def toggle(self) -> None:
        pass

    def file_away(self) -> None:
        pass

    def left(self) -> None:
        pass

    def touched(self) -> None:
        pass
