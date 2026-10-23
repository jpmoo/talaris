# SPDX-License-Identifier: GPL-3.0-only
# Copyright (c) 2026 Jeff Moore
"""
The dock: the applications you keep, and what is open.

Along the bottom with its height reserved, like the bar along the top. One row:
the **pinned** applications first, in the order you put them, then a rule,
then whatever else is open. An item is one application — a dot under it for
each of its windows, a longer bar for the focused one — and a press goes to
the window you were last in, or, for a pin with nothing open, starts it.

**Which windows** is a setting: those on this desktop, or on all of them. When
projects have workspaces (milestone two), "this desktop" becomes "this
project", which is what the setting was asked for.

**Right-click** opens a menu just above the item, on a surface of its own: show
or hide, pin or unpin, a new window, close. Hyprland has no minimizing, so a
hidden window waits on a special workspace nobody summons
(`hypr.HIDDEN`), and its item stays on the dock, dimmed.

**Order** is yours: items are dragged along the dock, and the order is kept in
the settings with the pins.

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
from config import save_config
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
from sensor import Autohide
from views import make_view, zoom

#: The dock's thickness: a 32px icon, its dots, and room around them.
DOCK = 50
#: The item menu's size.
MENU = (200, 190)


def _key(app: dict, wm_class: str) -> str:
    """What an item is known by: its launcher's id where there is one, else its window class."""
    return app.get("id") or f"class:{wm_class}"


class DockBridge(Bridge):
    #: Pushed to the page: the items, in order.
    windows = Signal(str)

    @Slot(str)
    def focus(self, address: str) -> None:
        hypr.focus(address)

    @Slot(str)
    def press(self, key: str) -> None:
        self.owner.press(key)

    @Slot(str)
    def order(self, keys: str) -> None:
        self.owner.reorder(json.loads(keys))

    @Slot(str, int)
    def menu(self, key: str, x: int) -> None:
        self.owner.menu.open(key, x)

    @Slot(str, str)
    def act(self, verb: str, key: str) -> None:
        self.owner.act(verb, key)

    @Slot(result=str)
    def listing(self) -> str:
        return self.owner.last


class DockMenu(QObject):
    """The right-click menu: a surface of its own, just above the item."""

    def __init__(self, profile: QWebEngineProfile, dock: "Dock") -> None:
        super().__init__(dock)
        self.dock = dock
        self.desktop = dock.desktop
        self.key = ""
        self.bridge = DockBridge(self, self)
        self.view = make_view(profile, "dock-menu", "talaris-ui://ui/dockmenu.html", self.bridge, self)
        self.surface = LayerSurface(self.view, "talaris-dock-menu")
        self.idle = QTimer(self)
        self.idle.setSingleShot(True)
        self.idle.timeout.connect(self.file_away)

    @property
    def last(self) -> str:
        return self.dock.last

    def describe(self) -> dict:
        item = self.dock.items.get(self.key, {})
        return {"up": bool(self.key), "item": item, "theme": self.desktop.config["theme"]}

    def open(self, key: str, x: int) -> None:
        if key not in self.dock.items:
            return
        self.key = key
        screen = QApplication.primaryScreen().geometry()
        w, h = zoom(MENU[0]), zoom(MENU[1])
        # The page says where the item is in its own pixels; at a text size
        # other than medium, those are zoomed.
        x = zoom(int(x))
        left = max(4, min(int(x) - w // 2, screen.width() - w - 4))
        bottom = self.dock.edge == "bottom"
        # Clear of the dock: its reserved space does that, unless it is hiding
        # and so reserves none, when the menu stands off by the dock's height.
        off = zoom(DOCK) if self.desktop.config["dock"].get("autohide") else 0
        anchor = (ANCHOR_BOTTOM if bottom else ANCHOR_TOP) | ANCHOR_LEFT
        margins = (left, 0 if bottom else off, 0, off if bottom else 0)
        self.surface.placement = None
        self.surface.apply(Placement(OVERLAY, anchor, w, h, KEYBOARD_ON_DEMAND, margins=margins))
        self.bridge.state.emit(json.dumps(self.describe()))
        self.idle.start(10000)

    def file_away(self) -> None:
        if not self.key:
            return
        self.key = ""
        self.idle.stop()
        self.view.hide()
        self.surface.placement = None
        self.bridge.state.emit(json.dumps(self.describe()))

    def act(self, verb: str, key: str) -> None:
        self.file_away()
        self.dock.act(verb, key)

    # What a page's bridge may call on its owner.
    def toggle(self) -> None:
        self.file_away()

    def left(self) -> None:
        pass

    def touched(self) -> None:
        if self.key:
            self.idle.start(10000)

    def press(self, key: str) -> None:
        pass

    def reorder(self, keys: list) -> None:
        pass


class Dock(QObject):
    def __init__(self, config: dict, profile: QWebEngineProfile, desktop, apps: Apps) -> None:
        super().__init__(desktop)
        self.desktop = desktop
        self.apps = apps
        # The bar's edge is the other one; side edges wait, as the bar's do.
        self.edge = config.get("edge", "bottom") if config.get("edge") in ("top", "bottom") else "bottom"
        self.last = "{}"
        self.items: dict[str, dict] = {}
        self.bridge = DockBridge(self, self)
        self.view = make_view(profile, "dock", "talaris-ui://ui/dock.html", self.bridge, self)
        self.surface = LayerSurface(self.view, "talaris-dock")
        self.hider = Autohide(profile, "dock", self.view, self._show, self._hide,
                              busy=lambda: bool(self.menu.key), parent=self)
        self.menu = DockMenu(profile, self)
        self._soon = QTimer(self)
        self._soon.setSingleShot(True)
        self._soon.timeout.connect(self.refresh)
        desktop.events.windows.connect(lambda: self._soon.start(80))

    def place(self) -> None:
        """Along its edge — or, set to hide, away until the edge is touched — or, turned off, nowhere."""
        if not self.desktop.config["dock"].get("enabled", True):
            self.hider.set(False, self.edge)
            self.menu.file_away()
            self._hide()
            return
        hide = bool(self.desktop.config["dock"].get("autohide"))
        self.hider.set(hide, self.edge)
        if not hide:
            self._show()
        self.refresh()

    def _show(self) -> None:
        screen = QApplication.primaryScreen().geometry()
        edge = ANCHOR_TOP if self.edge == "top" else ANCHOR_BOTTOM
        hide = bool(self.desktop.config["dock"].get("autohide"))
        # Room beyond the space reserved, clear: for a shadow to fall into, and
        # for icons to swell into when magnified (a 36px item at its largest).
        look = self.desktop.config["dock"]
        swell = round(36 * (int(look.get("magnify", 100)) - 100) / 100)
        room = zoom(max(14 if look.get("shadow") else 0, swell + 6 if swell else 0))
        self.surface.placement = None
        self.surface.apply(Placement(TOP, edge | ANCHOR_LEFT | ANCHOR_RIGHT, screen.width(), zoom(DOCK) + room,
                                     KEYBOARD_NONE, exclusive=0 if hide else zoom(DOCK)))
        self.bridge.state.emit(json.dumps({**self.describe(), "arrived": hide}))

    def _hide(self) -> None:
        self.view.hide()
        self.surface.placement = None

    def describe(self) -> dict:
        return {"edge": self.edge, "theme": self.desktop.config["theme"], "look": self.desktop.config["dock"]}

    # ------------------------------------------------------------ what is shown

    def refresh(self) -> None:
        cfg = self.desktop.config["dock"]
        pinned = list(cfg.get("pinned", []))
        order = list(cfg.get("order", []))
        everywhere = cfg.get("scope") == "all"
        now = hypr.windows()
        items: dict[str, dict] = {}
        for key in pinned:
            app = self.apps.by_id(key)
            if app:
                items[key] = {"key": key, "id": key, "name": app["name"], "icon": app["icon"], "pinned": True, "windows": []}
        for w in sorted(now["windows"], key=lambda w: w["recent"]):
            # Hidden windows count wherever they were; the others only on this
            # desktop, unless the dock is set to show every desktop's.
            if not (w["hidden"] or everywhere or w["workspace"] == now["active"]):
                continue
            app = self.apps.lookup(w["class"])
            key = _key(app, w["class"])
            item = items.setdefault(key, {"key": key, "id": app.get("id", ""), "name": app["name"], "icon": app["icon"],
                                          "pinned": False, "windows": []})
            # Most recently focused first, so a press goes to the one you were in.
            item["windows"].append({"address": w["address"], "title": w["title"], "hidden": w["hidden"],
                                    "focused": w["address"] == now["focused"]})
        # Your order first; anything never placed goes after, by name, so an
        # icon does not jump about as focus moves.
        rank = {key: i for i, key in enumerate(order)}
        def place(item):
            return (rank.get(item["key"], len(rank)), item["name"].lower())
        self.items = items
        listing = {
            "pinned": sorted((i for i in items.values() if i["pinned"]), key=place),
            "open": sorted((i for i in items.values() if not i["pinned"]), key=place),
        }
        text = json.dumps(listing)
        if text != self.last:
            self.last = text
            self.bridge.windows.emit(text)

    # ------------------------------------------------------------ what it does

    def press(self, key: str) -> None:
        """A press: the window last used; again, the next; a pin with nothing open is started."""
        item = self.items.get(key)
        if not item:
            return
        windows = item["windows"]
        if not windows:
            if item["id"] and self.apps.is_launchable(item["id"]):
                hypr.ask(f"/dispatch exec gtk-launch {item['id']}")
            return
        at = next((i for i, w in enumerate(windows) if w["focused"]), -1)
        target = windows[0] if at < 0 else windows[(at + 1) % len(windows)]
        if target["hidden"]:
            hypr.show(target["address"])
        else:
            hypr.focus(target["address"])

    def act(self, verb: str, key: str) -> None:
        item = self.items.get(key)
        if not item:
            return
        cfg = self.desktop.config["dock"]
        if verb in ("pin", "unpin"):
            if not item["id"]:
                return  # nothing to start it by again, so nothing to pin
            pinned = [k for k in cfg.get("pinned", []) if k != item["id"]]
            if verb == "pin":
                pinned.append(item["id"])
            cfg["pinned"] = pinned
            save_config(self.desktop.config)
        elif verb == "hide":
            for w in item["windows"]:
                if not w["hidden"]:
                    hypr.hide(w["address"])
        elif verb == "show":
            for w in reversed(item["windows"]):
                if w["hidden"]:
                    hypr.show(w["address"])
        elif verb == "close":
            if item["windows"]:
                hypr.close(item["windows"][0]["address"])
        elif verb == "close-all":
            for w in item["windows"]:
                hypr.close(w["address"])
        elif verb == "new" and item["id"] and self.apps.is_launchable(item["id"]):
            hypr.ask(f"/dispatch exec gtk-launch {item['id']}")
        self._soon.start(80)

    def reorder(self, keys: list) -> None:
        """The order the items were dragged into, kept."""
        known = [k for k in keys if isinstance(k, str)]
        self.desktop.config["dock"]["order"] = known
        save_config(self.desktop.config)
        self.refresh()

    # What the page's bridge calls on its owner; a dock has no modes.
    def toggle(self) -> None:
        pass

    def file_away(self) -> None:
        self.menu.file_away()

    def left(self) -> None:
        pass

    def touched(self) -> None:
        pass
