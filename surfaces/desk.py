# SPDX-License-Identifier: GPL-3.0-only
# Copyright (c) 2026 Jeff Moore
"""
The desk: the empty desktop between the windows, as a surface of Talaris's —
a clear one, just above the wallpaper and under every window — so a
right-click on it has somewhere to land. It offers what belongs to the place
itself: this project's wallpaper, or the default.

Clear everywhere, it draws nothing until its menu is out; hyprpaper's
wallpaper shows through it.
"""

from __future__ import annotations

import json
import os

from PySide6.QtCore import QObject, Slot
from PySide6.QtWebEngineCore import QWebEngineProfile

import wallpaper
from core import Bridge
from layershell import BOTTOM, KEYBOARD_NONE, LayerSurface, full_screen
from views import log, make_view


class DeskBridge(Bridge):
    @Slot(str)
    def wallpaperFor(self, scope: str) -> None:  # noqa: N802 — called from the page by this name
        """A picture for this project (its id) or the default (empty), from the desktop's chooser."""
        self.owner.pick(scope)

    @Slot(str)
    def useDefault(self, scope: str) -> None:  # noqa: N802 — called from the page by this name
        if scope:
            self.owner.desktop.set_wallpaper(scope, clear=True)
            self.owner.changed()

    @Slot()
    def wallpaperSettings(self) -> None:  # noqa: N802 — called from the page by this name
        self.owner.desktop.settings.open("look")


class Desk(QObject):
    def __init__(self, profile: QWebEngineProfile, desktop) -> None:
        super().__init__(desktop)
        self.desktop = desktop
        self.up = False
        self.bridge = DeskBridge(self, self)
        self.view = make_view(profile, "desk", "talaris-ui://ui/desk.html", self.bridge, self)
        self.surface = LayerSurface(self.view, "talaris-desk", nudge=False)
        self._choosing = False

    def describe(self) -> dict:
        here = self.desktop.project
        return {"up": self.up, "theme": self.desktop.config["theme"], "project": here.get("id", ""), "name": here.get("name", ""),
                "home": bool(here.get("home")), "own": wallpaper.for_project(self.desktop.config, here.get("id", ""))["own"]}

    def place(self) -> None:
        """The whole screen, under the windows, clear of what the bar and the dock keep."""
        self.surface.apply(full_screen(KEYBOARD_NONE, layer=BOTTOM, exclusive=0))
        self.up = True
        self.changed()

    def changed(self) -> None:
        self.bridge.state.emit(json.dumps(self.describe()))

    def pick(self, scope: str) -> None:
        if self._choosing:
            return
        self._choosing = True
        now = wallpaper.for_project(self.desktop.config, scope) if scope else wallpaper.current()

        def chosen(path: str) -> None:
            self._choosing = False
            if path:
                error = self.desktop.set_wallpaper(scope, path=path)
                if error:
                    log(f"desk: {error}")
            self.changed()
        wallpaper.pick(self, os.path.dirname(now["path"]), chosen)

    # What the page's bridge may call on its owner; the desk has no panel to put away.
    def toggle(self) -> None:
        pass

    def file_away(self) -> None:
        pass

    def left(self) -> None:
        pass

    def touched(self) -> None:
        pass
