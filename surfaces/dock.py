# SPDX-License-Identifier: GPL-3.0-only
# Copyright (c) 2026 Jeff Moore
"""
The dock: the applications you keep, and what is open.

Along the bottom with its height reserved, like the bar along the top. One row:
the **pinned** applications first, in the order you put them — those pinned
in every project and those pinned in the current one only — then a rule, then
whatever else is open. An item is one application — a dot under it for
each of its windows, a longer bar for the focused one — and a press goes to
the window you were last in, or, for a pin with nothing open, starts it.

**Which windows** is a setting: those on this desktop, or on all of them. When
projects have workspaces (milestone two), "this desktop" becomes "this
project", which is what the setting was asked for.

**Right-click** opens a menu just above the item, on a surface of its own: show
or hide, pin or unpin, a new window, close. Hyprland has no minimizing, so a
hidden window waits on a special workspace nobody summons
(`hypr.HIDDEN`), and its item stays on the dock, dimmed.

**A document** can be pinned too — a spreadsheet, a page in the browser — as
an item of its own beside its application: right-click a window showing it,
"Pin this document…", or drop a file or a link on the dock. It wears its
application's icon with the page's own icon (or a sheet of paper) at its
corner, a press brings forward the window showing it or opens it there, and
its tip says what it is and what it opens in. Which document a window shows is
looked for, not guessed (docs.py); where it cannot be told, nothing is offered.

**Open only in another project**, a press does as its menu says: opens a
new window here, brings its window here, or goes to it. Unchosen, an
application whose desktop file has a "new window" action (a browser, a
terminal) opens a new window here; the rest follow the rule in Settings. The
menu also lists each of its windows on every desktop, with its project, to go
to one, and opens a new window here — and, for one kept in a project, a new
window there (that project gone to).

**Kept in a project**: anything pinned can be (its menu, "Keep in this
project"). Pressed in another project, its project is gone to and it is shown
or opened there, never brought to where you are; the launcher and an app's
own key keep to that as well.

**Order** is yours: items are dragged along the dock, and the order is kept in
the settings with the pins.

**Pulled, like everything from the compositor.** An event says the windows
changed; the dock then asks what they are. Events come in bursts — opening a
window is an open, a focus and a title — so it waits a moment and asks once.
"""

from __future__ import annotations

import json
import os
import shlex
import time

from PySide6.QtCore import QObject, QTimer, Signal, Slot
from PySide6.QtWebEngineCore import QWebEngineProfile
from PySide6.QtWidgets import QApplication

import docs
import hypr
from apps import Apps, keeps_one_window, new_window_command, opens_new_windows
from config import save_config
from core import Bridge, call
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

#: The dock's thickness beyond its icons: their dots, and room around them.
#: At the 24px icons it starts with, 50.
DOCK_ROOM = 26
#: The item menu's size.
MENU = (220, 310)


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

    @Slot(str, float)
    def tip(self, text: str, x: float) -> None:
        """A tooltip over the item at `x`; empty text puts it away."""
        self.owner.tip(text, x)

    @Slot(str, str)
    def act(self, verb: str, key: str) -> None:
        self.owner.act(verb, key)

    @Slot(str)
    def dropped(self, uris: str) -> None:
        """Files or links let go on the dock: each pinned, to this project."""
        self.owner.dropped(uris)

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
        self.found: dict | None = None
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
        return {"up": bool(self.key), "item": item, "found": self.found, "theme": self.desktop.config["theme"],
                "everywhere": self.everywhere, "elsewhere": self.dock.elsewhere(self.key) if self.key else "",
                "chosen": self.desktop.config["dock"].get("elsewhere", {}).get(self.key, "") if self.key else "",
                "oneWindow": bool(self.key and keeps_one_window(self.key)),
                # Kept in another project: its name, for "New window in …".
                "keptName": self.dock._project_name(item["keptIn"]) if item.get("keptIn") and not item.get("keptHere") else ""}

    #: The item's windows on every desktop, each with its project's name: the menu's list, to go to one.
    everywhere: list = []

    def _everywhere(self, key: str) -> list:
        now = hypr.windows()
        desks = {x["id"]: x["name"] for x in now.get("workspaces", [])}
        out = []
        for w in sorted(now["windows"], key=lambda w: w["recent"]):
            if _key(self.dock.apps.lookup(w["class"]), w["class"]) != key:
                continue
            out.append({"address": w["address"], "title": w["title"], "hidden": w["hidden"], "here": w["workspace"] == now["active"],
                        "project": self.dock._project_name(desks.get(w["workspace"], "")) if desks.get(w["workspace"]) else ""})
        return out

    def open(self, key: str, x: int) -> None:
        if key not in self.dock.items:
            return
        self.key = key
        # The document its last-used window shows, if one can be told: offered to pin.
        item = self.dock.items[key]
        self.found = None
        self.everywhere = [] if item.get("doc") else self._everywhere(key)
        if not item.get("doc") and item["windows"]:
            w = item["windows"][0]
            self.found = docs.document_of(w, self.dock.apps.lookup(w["class"]))
        screen = QApplication.primaryScreen().geometry()
        # Taller by a row for each window listed (two or more), up to ten.
        rows = len(self.everywhere) + 1 if len(self.everywhere) > 1 else 0
        w, h = zoom(MENU[0] + (60 if rows else 0)), zoom(MENU[1] + 26 * min(rows, 11) + 120)
        x = int(x)
        left = max(4, min(int(x) - w // 2, screen.width() - w - 4))
        bottom = self.dock.edge == "bottom"
        # Clear of the dock: its reserved space does that, unless it is hiding
        # and so reserves none, when the menu stands off by the dock's height.
        off = self.dock.thickness() if self.desktop.config["dock"].get("autohide") else 0
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
        found = self.found
        self.file_away()
        if verb.startswith("go:"):
            # One of its windows, chosen from the list: shown, or gone to where it is (its project with it).
            address = verb[3:]
            w = next((x for x in hypr.windows()["windows"] if x["address"] == address), None)
            if w and w["hidden"]:
                hypr.show(address)
            elif w:
                hypr.focus(address)
            return
        if verb in ("doc-here", "doc-all") and found:
            item = self.dock.items.get(key, {})
            self.dock.pin_doc(found, item.get("id", ""), "here" if verb == "doc-here" else "all")
            return
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

    def dropped(self, uris: str) -> None:
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

    def tip(self, text: str, x: float) -> None:
        # Clear of the dock (its reserved space, or its height while it hides)
        # and of an icon magnified under the pointer.
        look = self.desktop.config["dock"]
        swell = round((int(look.get("iconSize", 24)) + 12) * (int(look.get("magnify", 100)) - 100) / 100)
        off = (self.thickness() if look.get("autohide") else 0) + max(0, swell)
        self.desktop.tip.show(text, x * self.view.zoomFactor(), self.edge, off, area="dock")

    def thickness(self) -> int:
        """How tall the dock is: its icons at the size Settings gives, and the room round them."""
        return int(self.desktop.config["dock"].get("iconSize", 24)) + DOCK_ROOM

    def _show(self) -> None:
        screen = QApplication.primaryScreen().geometry()
        edge = ANCHOR_TOP if self.edge == "top" else ANCHOR_BOTTOM
        hide = bool(self.desktop.config["dock"].get("autohide"))
        # Room beyond the space reserved, clear: for a shadow to fall into, and
        # for icons to swell into when magnified (a 36px item at its largest).
        look = self.desktop.config["dock"]
        swell = round((int(look.get("iconSize", 24)) + 12) * (int(look.get("magnify", 100)) - 100) / 100)
        room = max(14 if look.get("shadow") else 0, swell + 6 if swell else 0)
        self.surface.placement = None
        tall = self.thickness()
        self.surface.apply(Placement(TOP, edge | ANCHOR_LEFT | ANCHOR_RIGHT, screen.width(), tall + room,
                                     KEYBOARD_NONE, exclusive=0 if hide else tall))
        self.bridge.state.emit(json.dumps({**self.describe(), "arrived": hide}))

    def _hide(self) -> None:
        self.view.hide()
        self.surface.placement = None

    def describe(self) -> dict:
        return {"edge": self.edge, "theme": self.desktop.config["theme"], "look": self.desktop.config["dock"]}

    # ------------------------------------------------------------ what is shown

    def refresh(self) -> None:
        cfg = self.desktop.config["dock"]
        # Pinned in every project, then in this one only.
        everywhere_pins = list(cfg.get("pinned", []))
        here = self.desktop.project.get("id", "")
        pinned = everywhere_pins + [k for k in cfg.get("pinnedIn", {}).get(here, []) if k not in everywhere_pins]
        order = list(cfg.get("order", []))
        everywhere = cfg.get("scope") == "all"
        now = hypr.windows()
        items: dict[str, dict] = {}
        # Documents pinned everywhere, then here: items of their own, before the applications.
        pinned_docs = [d for d in cfg.get("docs", []) if d.get("where") in ("all", here)]
        pinned_docs.sort(key=lambda d: d.get("where") != "all")
        for d in pinned_docs:
            app = self.apps.by_id(d.get("app", "")) or {"name": d.get("app") or "", "icon": ""}
            key = f"doc:{d['id']}"
            items[key] = {"key": key, "id": d.get("app", ""), "name": d["name"], "appName": app["name"], "icon": app["icon"],
                          "doc": {"kind": d["kind"], "target": d["target"], "badge": d.get("icon", ""),
                                  "missing": d["kind"] == "file" and not os.path.exists(d["target"])},
                          "pinned": True, "pinnedWhere": "all" if d.get("where") == "all" else "here", "windows": []}
        for key in pinned:
            app = self.apps.by_id(key)
            if app:
                items[key] = {"key": key, "id": key, "name": app["name"], "icon": app["icon"], "pinned": True,
                              "pinnedWhere": "all" if key in everywhere_pins else "here", "windows": []}
        for w in sorted(now["windows"], key=lambda w: w["recent"]):
            # Hidden windows count wherever they were; the others only on this
            # desktop, unless the dock is set to show every desktop's.
            if not (w["hidden"] or everywhere or w["workspace"] == now["active"]):
                continue
            app = self.apps.lookup(w["class"])
            key = _key(app, w["class"])
            # A window showing a pinned document is that document's.
            for d in pinned_docs:
                if (d.get("app") == app.get("id") or (d["kind"] == "url" and docs.is_browser(app, w["class"]))) and docs.shows(d, w, app):
                    key = f"doc:{d['id']}"
                    break
            item = items.setdefault(key, {"key": key, "id": app.get("id", ""), "name": app["name"], "icon": app["icon"],
                                          "pinned": False, "windows": []})
            # Most recently focused first, so a press goes to the one you were in.
            item["windows"].append({"address": w["address"], "title": w["title"], "hidden": w["hidden"],
                                    "focused": w["address"] == now["focused"], "class": w["class"], "pid": w["pid"],
                                    "here": w["workspace"] == now["active"], "workspace": w["workspace"]})
        # Your order first; anything never placed goes after, by name, so an
        # icon does not jump about as focus moves.
        # Its exception to the general rule: kept in a project where the rule brings, always brought where it goes.
        going = self.desktop.config["launcher"].get("singleWindow", "bring") == "go"
        stays, brings = cfg.get("stays", {}), cfg.get("brings", [])
        for item in items.values():
            if not item["pinned"]:
                continue
            item["rule"] = "go" if going else "bring"
            if not going and stays.get(item["key"]):
                item["keptIn"] = stays[item["key"]]
                item["keptHere"] = stays[item["key"]] == here
            if going and item["key"] in brings:
                item["brought"] = True
        # Another project's: kept there, and not open here; or (the dock showing every desktop's) open only on other desktops.
        # Which, by name, for its tip.
        desks = {x["id"]: x["name"] for x in now.get("workspaces", [])}
        for item in items.values():
            shown = [w for w in item["windows"] if not w["hidden"]]
            item["away"] = bool((item.get("keptIn") and not item.get("keptHere") and not any(w["here"] for w in item["windows"]))
                                or (shown and not any(w["here"] for w in shown)))
            if item["away"]:
                where = [item["keptIn"]] if item.get("keptIn") and not item.get("keptHere") else []
                where += [desks.get(w["workspace"], "") for w in shown]
                item["awayIn"] = list(dict.fromkeys(self._project_name(x) for x in where if x))
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

    _names: dict = {}
    _names_at = 0.0

    def _project_name(self, key: str) -> str:
        """A project's name, from its id (a desktop is named by its project's id): looked up now and then, not at every refresh."""
        if key not in self._names and time.monotonic() - self._names_at > 30:
            self._names_at = time.monotonic()
            status, text = call("GET", "/projects")
            if status == 200:
                try:
                    self._names = {p["id"]: p["name"] for p in json.loads(text)}
                except (ValueError, KeyError, TypeError):
                    pass
        return self._names.get(key, key)

    # ------------------------------------------------------------ what it does

    def elsewhere(self, key: str) -> str:
        """
        What a press does with an application open in another project and not
        here (the menu's choice for it): `bring` its window here, `go` to it,
        or open a `new` window here. Unchosen, an application its desktop
        file says opens new windows (a "new window" action: a browser, a
        terminal) opens a new one here; any other follows the rule in Settings
        ("") — most say nothing either way, and are taken as keeping one.
        """
        chosen = self.desktop.config["dock"].get("elsewhere", {}).get(key, "")
        if chosen:
            return chosen
        return "new" if not key.startswith(("doc:", "class:")) and opens_new_windows(key) else ""

    def new_window(self, app_id: str) -> None:
        """A new window of an application, here: by its own "new window" action where it has one (a browser's), else started again."""
        fresh = new_window_command(app_id)
        if fresh:
            args = [a for a in fresh if not (a.startswith("%") and len(a) == 2)]
            hypr.ask(f"/dispatch exec {' '.join(shlex.quote(a) for a in args)}")
        elif self.apps.is_launchable(app_id):
            hypr.ask(f"/dispatch exec gtk-launch {shlex.quote(app_id)}")

    def press(self, key: str) -> None:
        """A press: the window last used; again, the next; a pin with nothing open is started."""
        item = self.items.get(key)
        if not item:
            return
        windows = item["windows"]
        if not windows and item.get("keptIn") and not item.get("keptHere"):
            self.go_kept(item)
            return
        # Open only in another project: as its menu says — brought here, gone to, or a new window here.
        choice = self.elsewhere(key)
        # (A hidden window counts as here: pressed, it is shown.)
        if choice and item["id"] and not item.get("doc") and not any(w.get("here") or w["hidden"] for w in windows):
            if choice == "new":
                self.new_window(item["id"])
                return
            mine = self.desktop.launcher._app_windows(item["id"])
            if mine:
                now = hypr.windows()
                self.desktop.launcher._bring(item["id"], (now["active"], now["activeTarget"]), go=choice == "go")
                return
        if not windows:
            if item.get("doc"):
                self.call_doc(item)
            elif item["id"] and self.apps.is_launchable(item["id"]):
                # Brought, gone to or started, as the launcher would.
                self.desktop.launcher.call_app(item["id"])
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
        if item.get("doc") and verb in ("pin-all", "pin-here", "unpin"):
            # A document: moved between every project and this one, or taken off.
            ident = item["key"][4:]
            here = self.desktop.project.get("id", "") or "all"
            kept = []
            for d in cfg.get("docs", []):
                if d["id"] == ident:
                    if verb == "unpin":
                        continue
                    d = {**d, "where": "all" if verb == "pin-all" else here}
                kept.append(d)
            cfg["docs"] = kept
            save_config(self.desktop.config)
        elif verb in ("bring-here", "unbring") and item["pinned"]:
            brings = [k for k in cfg.get("brings", []) if k != key]
            if verb == "bring-here":
                brings.append(key)
            cfg["brings"] = brings
            save_config(self.desktop.config)
        elif verb in ("keep-here", "unkeep") and item["pinned"]:
            here = self.desktop.project.get("id", "")
            stays = {k: v for k, v in cfg.get("stays", {}).items() if k != key}
            if verb == "keep-here" and here:
                stays[key] = here
            cfg["stays"] = stays
            save_config(self.desktop.config)
        elif verb == "open" and item.get("doc"):
            self.open_doc(item)
        elif verb in ("pin-all", "pin-here", "unpin"):
            if not item["id"]:
                return  # nothing to start it by again, so nothing to pin
            # Taken from wherever it was pinned, then put where it was asked: every
            # project (pinned), or this one (pinnedIn, by the project's id).
            here = self.desktop.project.get("id", "")
            pinned = [k for k in cfg.get("pinned", []) if k != item["id"]]
            within = {p: [k for k in ids if k != item["id"]] for p, ids in cfg.get("pinnedIn", {}).items()}
            if verb == "pin-all":
                pinned.append(item["id"])
            elif verb == "pin-here" and here:
                within.setdefault(here, []).append(item["id"])
            cfg["pinned"] = pinned
            cfg["pinnedIn"] = {p: ids for p, ids in within.items() if ids}
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
        elif verb == "new" and item["id"]:
            self.new_window(item["id"])
        elif verb == "new-kept" and item["id"] and item.get("keptIn"):
            # A new window in the project it is kept in: that project gone to, and the window opened there.
            self.desktop.go_to_project(item["keptIn"], announce=True)
            self.new_window(item["id"])
        elif verb.startswith("elsewhere-") and item["id"] and not item.get("doc"):
            # Its choice for when it is open in another project; "elsewhere-rule" back to Settings' rule.
            choice = verb[len("elsewhere-"):]
            chosen = {k: v for k, v in cfg.get("elsewhere", {}).items() if k != key}
            if choice in ("bring", "go", "new"):
                chosen[key] = choice
            cfg["elsewhere"] = chosen
            save_config(self.desktop.config)
        if verb == "unpin":
            # Unpinned, its exception goes with it.
            cfg["stays"] = {k: v for k, v in cfg.get("stays", {}).items() if k != key}
            cfg["brings"] = [k for k in cfg.get("brings", []) if k != key]
            save_config(self.desktop.config)
        self._soon.start(80)

    def go_kept(self, item: dict) -> None:
        """A pinned thing kept in another project: shown where it is, or that project gone to and it opened there."""
        if item.get("doc"):
            now = hypr.windows()
            d = {"kind": item["doc"]["kind"], "target": item["doc"]["target"]}
            showing = [w for w in sorted(now["windows"], key=lambda w: w["recent"])
                       if not w["hidden"] and docs.shows(d, w, self.apps.lookup(w["class"]))]
            if showing:
                hypr.focus(showing[0]["address"])
                return
            self.desktop.go_to_project(item["keptIn"], announce=True)
            self.open_doc(item)
            return
        if item["id"] and self.desktop.launcher.kept(item["id"]):
            return
        self.desktop.go_to_project(item["keptIn"], announce=True)
        if item["id"] and self.apps.is_launchable(item["id"]):
            hypr.ask(f"/dispatch exec gtk-launch {item['id']}")

    def call_doc(self, item: dict) -> None:
        """
        A pinned document with no window here: where the rule is to go, the
        window showing it, wherever it is; where it is to bring (or its
        exception says so), that window brought here; else opened.
        """
        going = self.desktop.config["launcher"].get("singleWindow", "bring") == "go"
        now = hypr.windows()
        d = {"kind": item["doc"]["kind"], "target": item["doc"]["target"]}
        showing = [w for w in sorted(now["windows"], key=lambda w: w["recent"]) if docs.shows(d, w, self.apps.lookup(w["class"]))]
        if showing:
            w = showing[0]
            if going and not item.get("brought") and not w["hidden"]:
                hypr.focus(w["address"])
                return
            # A browser's window holds other pages too: never carried off for one of them; the page opens here instead.
            if item["doc"]["kind"] != "url":
                hypr.show(w["address"], now["activeTarget"])
                return
        self.open_doc(item)

    # ------------------------------------------------------------ documents

    def open_doc(self, item: dict) -> None:
        """A pinned document, opened in its application — or by whatever opens it, if that is gone."""
        target = item["doc"]["target"]
        if item["doc"]["kind"] == "file" and not os.path.exists(target):
            mid = QApplication.primaryScreen().geometry().width() / 2
            self.desktop.tip.show(f"{item['name']} is not where it was pinned", mid, self.edge, self.thickness(), area="dock")
            QTimer.singleShot(3000, self.desktop.tip.hide)
            return
        # A page in a browser: a new window of its own, here — handed to the browser as it is, it would
        # open as a tab in whichever window the browser already has, in whatever project that is.
        fresh = new_window_command(item["id"]) if item["id"] and item["doc"]["kind"] == "url" else None
        if fresh:
            args = [target if a in ("%u", "%U", "%f", "%F") else a for a in fresh if not (a.startswith("%") and len(a) == 2 and a not in ("%u", "%U", "%f", "%F"))]
            if target not in args:
                # An action that takes no address (Chrome's): told to make a new window, and given it.
                if "--new-window" not in args:
                    args.append("--new-window")
                args.append(target)
            hypr.ask(f"/dispatch exec {' '.join(shlex.quote(a) for a in args)}")
        elif item["id"] and self.apps.is_launchable(item["id"]):
            hypr.ask(f"/dispatch exec gtk-launch {shlex.quote(item['id'])} {shlex.quote(target)}")
        else:
            hypr.ask(f"/dispatch exec xdg-open {shlex.quote(target)}")

    def pin_doc(self, found: dict, app_id: str, where: str) -> None:
        """A document kept on the dock: here (this project) or everywhere; the page's icon saved to wear."""
        here = self.desktop.project.get("id", "")
        if not app_id or not self.apps.is_launchable(app_id):
            app_id = self.app_for(found["target"])
        ident = docs.doc_id(found["target"])
        icon = ""
        if found["kind"] == "url":
            icon = os.path.basename(docs.page_icon(found["target"]))
        cfg = self.desktop.config["dock"]
        entry = {"id": ident, "kind": found["kind"], "target": found["target"], "name": found["name"],
                 "app": app_id, "icon": icon, "where": "all" if where == "all" or not here else here}
        cfg["docs"] = [d for d in cfg.get("docs", []) if d["id"] != ident] + [entry]
        save_config(self.desktop.config)
        self._soon.start(80)

    def app_for(self, target: str) -> str:
        """What opens a file or a link by default, as a launchable desktop id; empty if none is."""
        wanted = docs.default_app(target)
        if self.apps.is_launchable(wanted):
            return wanted
        # A browser set as default by a made-up entry ("userapp-Firefox-XXXX"): found by its name.
        name = wanted.removeprefix("userapp-").rsplit("-", 1)[0].lower()
        return next((a["id"] for a in self.apps.launchable() if name and a["name"].lower() == name), "")

    def dropped(self, uris: str) -> None:
        from urllib.parse import unquote
        for line in uris.splitlines():
            u = line.strip()
            if not u or u.startswith("#"):
                continue
            if u.startswith("file://"):
                path = unquote(u[7:])
                if os.path.exists(path):
                    self.pin_doc({"kind": "file", "target": path, "name": os.path.basename(path.rstrip("/")) or path}, "", "here")
            elif u.startswith(("http://", "https://")):
                self.pin_doc({"kind": "url", "target": u, "name": docs.page_name(u)}, "", "here")

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
