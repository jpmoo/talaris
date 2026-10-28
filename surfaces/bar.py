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

import dataclasses
import json
import math
import os
import threading
import time
from urllib.parse import quote

from PySide6.QtCore import QObject, QTimer, Signal, Slot
from PySide6.QtWebEngineCore import QWebEngineProfile
from PySide6.QtWidgets import QApplication

from core import Bridge, call, get_json, projects as core_projects
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
    whole,
)
from machine import Machine
from morgan import command as morgan_command
from sysmon import monitor
from sensor import Autohide, ClickAway
from views import log, make_view, zoom, zoom_of

#: Room below the bar (or above the dock) for a shadow to fall into.
SHADOW_ROOM = 14

#: The bar's thickness. Enough for 14px type and a 24px control with air round it.
BAR = 34

#: What each popup is, and its size. They hang from the bar's right end, where
#: the readings and the power button are.
#: Each popup's surface: the panel and the clear room round it for the
#: shadow every menu here wears (18 a side, 4 above, 26 below; popup.html).
POPUPS = {"power": (234, 220), "volume": (264, 122), "network": (324, 438), "bluetooth": (324, 418), "tray": (284, 218),
          "trayicons": (244, 98), "battery": (304, 300), "projects": (300, 160), "notifications": (380, 460),
          "clipboard": (460, 560)}

#: A popup nobody touches puts itself away — later for the ones where a
#: password is typed or a scan is waited on.
POPUP_IDLE_MS = 12000
POPUP_IDLE_LONG_MS = 45000


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
    #: Pushed to the bar: the tray's items, as Settings lets it show them.
    tray = Signal(str)
    #: Pushed to the popup: a tray item's menu, `{id, items}`.
    trayMenu = Signal(str)

    @Slot(str, str, float)
    def trayDo(self, item: str, verb: str, x: float) -> None:  # noqa: N802 — called from the page by this name
        """A press on a tray icon: `activate`, `secondary` or `menu`, at `x` along the bar (its page's pixels)."""
        self.owner.desktop.bar.tray_do(item, verb, x)

    @Slot(float)
    def trayPane(self, x: float) -> None:  # noqa: N802 — called from the page by this name
        self.owner.desktop.bar.tray_pane(x)

    @Slot(int)
    def trayClick(self, entry: int) -> None:  # noqa: N802 — called from the page by this name
        """An entry chosen in a tray item's menu."""
        popup = self.owner.desktop.bar.popup
        if popup.tray_item:
            self.owner.desktop.tray.do(do="click", id=popup.tray_item, item=entry)
        popup.close()

    @Slot(result=str)
    def trayItems(self) -> str:  # noqa: N802 — called from the page by this name
        return self.owner.desktop.bar.tray_listing()

    @Slot(int)
    def fit(self, height: int) -> None:
        """The popup's page says how tall its content is, in its own pixels."""
        if hasattr(self.owner, "fit"):
            self.owner.fit(height)

    @Slot(int)
    def fitWidth(self, width: int) -> None:  # noqa: N802 — called from the page by this name
        """The popup's page says how wide its content is (the folded tray's pane), in its own pixels."""
        if hasattr(self.owner, "fit_width"):
            self.owner.fit_width(width)

    @Slot(str, bool)
    def panelRead(self, kind: str, deep: bool) -> None:  # noqa: N802 — called from the page by this name
        self.owner.desktop.machine.panel_read(kind, deep)

    @Slot(float)
    def shownDrawn(self, shown: float) -> None:  # noqa: N802 — called from the page by this name
        """The popup's page drew this showing (two frames after it): not lost."""
        if hasattr(self.owner, "drawn_ok"):
            self.owner.drawn_ok(shown)

    @Slot(str)
    def network(self, request: str) -> None:
        self.owner.desktop.machine.network(json.loads(request))

    @Slot(str)
    def bluetooth(self, request: str) -> None:
        self.owner.desktop.machine.bluetooth(json.loads(request))

    @Slot(result=str)
    def projects(self) -> str:
        """
        Every project, and which is the current one: for the bar's list to
        switch between — grouped and ordered as Tasks' column is (the core's
        /tasks/column), Home first, and any project Tasks does not show last,
        by name. A group's name comes as `{"group": name}` before its projects.
        """
        listed = [p for p in core_projects() if not p.get("archived")]
        column = get_json("/tasks/column", [])
        column = [x for x in column if isinstance(x, dict)] if isinstance(column, list) else []
        here = self.owner.desktop.project.get("id")
        by_id = {p.get("id"): p for p in listed}
        row = lambda p: {"id": p.get("id"), "name": p.get("name", ""), "code": p.get("code", ""), "current": p.get("id") == here}  # noqa: E731
        out, seen = [], set()
        for p in listed:
            if p.get("home"):
                out.append(row(p))
                seen.add(p.get("id"))
        for x in column:
            members = x.get("projects", []) if x.get("kind") == "group" else [x.get("project", {})]
            # A task project is a desktop by its workspace (`talaris-project`): the folder's id.
            desks = [by_id[m["workspace"]] for m in members if m.get("workspace") in by_id and m["workspace"] not in seen]
            if not desks:
                continue
            if x.get("kind") == "group":
                out.append({"group": x.get("name", "")})
            for p in desks:
                out.append({**row(p), **({"inGroup": True} if x.get("kind") == "group" else {})})
                seen.add(p.get("id"))
        rest = sorted((p for p in listed if p.get("id") not in seen), key=lambda p: p.get("name", "").lower())
        if rest and any("group" in x for x in out):
            out.append({"group": ""})
        out.extend(row(p) for p in rest)
        return json.dumps(out)

    #: Pushed to the popup: the notifications, newest first (the bell's list).
    notices = Signal(str)
    #: Pushed to the popup: Morgan's timers and reminders still to come, as its `reminders` command answers.
    reminders = Signal(str)
    #: Pushed to the bar: a project gone to — its name flashes, so where you are is plain.
    flash = Signal()

    @Slot(result=str)
    def notifications(self) -> str:
        """The bell's list, newest first; opening it reads them all."""
        listing = self.owner.desktop.bar.notification_listing()
        self.owner.desktop.notifications.read_all()
        return listing

    @Slot()
    def remindersRead(self) -> None:  # noqa: N802 — called from the page by this name
        """Morgan's timers and reminders, asked for; the answer comes as `reminders`."""
        self.owner.desktop.bar.read_reminders()

    @Slot(str)
    def cancelReminder(self, rid: str) -> None:  # noqa: N802 — called from the page by this name
        self.owner.desktop.bar.read_reminders(cancel=rid)

    #: Pushed to the popup: the clipboard's history changed (clipboard.py); read it again.
    clips = Signal()

    @Slot(result=str)
    def clipboard(self) -> str:
        """The clipboard's history, pinned first, and which clip is on the clipboard now."""
        listed = get_json("/clipboard", []) or []
        return json.dumps({"clips": listed if isinstance(listed, list) else [], "current": self.owner.desktop.clipboard.current})

    @Slot(str, result=bool)
    def clipCopy(self, cid: str) -> bool:  # noqa: N802 — called from the page by this name
        """A clip put back on the clipboard."""
        return self.owner.desktop.clipboard.put_back(cid)

    @Slot(str, bool)
    def clipPin(self, cid: str, on: bool) -> None:  # noqa: N802 — called from the page by this name
        call("PUT", f"/clipboard/{quote(cid)}/pinned", json.dumps({"pinned": on}))
        self.owner.desktop.clipboard.changed.emit()

    @Slot(str)
    def clipRemove(self, cid: str) -> None:  # noqa: N802 — called from the page by this name
        call("DELETE", f"/clipboard/{quote(cid)}")
        self.owner.desktop.clipboard.removed(cid)

    @Slot()
    def clipClear(self) -> None:  # noqa: N802 — called from the page by this name
        call("DELETE", "/clipboard")
        self.owner.desktop.clipboard.cleared()

    @Slot(int)
    def dismissNotice(self, nid: int) -> None:  # noqa: N802 — called from the page by this name
        self.owner.desktop.notifications.dismiss(nid)

    @Slot()
    def clearNotices(self) -> None:  # noqa: N802 — called from the page by this name
        self.owner.desktop.notifications.clear()

    @Slot(int)
    def openNotice(self, nid: int) -> None:  # noqa: N802 — called from the page by this name
        self.owner.desktop.bar.close_popup()
        self.owner.desktop.notifications.open_app(nid)

    @Slot(int, str)
    def actNotice(self, nid: int, key: str) -> None:  # noqa: N802 — called from the page by this name
        self.owner.desktop.notifications.act(nid, key)

    @Slot()
    def glance(self) -> None:
        """The project menu's "Glance at current project"."""
        self.owner.desktop.bar.close_popup()
        self.owner.desktop.glance.open()

    @Slot()
    def archive(self) -> None:
        """The project menu's "Archive…": the archive's browser."""
        self.owner.desktop.bar.close_popup()
        self.owner.desktop.archive.show("")

    @Slot(str)
    def goProject(self, project: str) -> None:  # noqa: N802 — called from the page by this name
        self.owner.desktop.bar.close_popup()
        # Chosen from the bar's menu, which has gone: the bar's name flashes, as for any other way of going.
        self.owner.desktop.go_to_project(project, announce=True)

    @Slot(str)
    def powerProfile(self, name: str) -> None:  # noqa: N802 — called from the page by this name
        self.owner.desktop.machine.power_profile(name)

    @Slot()
    def powerSettings(self) -> None:  # noqa: N802 — called from the page by this name
        """The battery panel's way on: Settings, Power."""
        self.owner.desktop.bar.close_popup()
        self.owner.desktop.settings.open("power")

    @Slot(str)
    def volume(self, change: str) -> None:
        self.owner.desktop.machine.volume(change)

    @Slot(result=str)
    def system(self) -> str:
        """How the machine is doing, for the power menu's graphs (sysmon.py): asked each second while it is open."""
        try:
            return json.dumps(monitor.read())
        except OSError as e:
            return json.dumps({"error": str(e)})

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

    @Slot()
    def calendar(self) -> None:
        self.owner.desktop.calendar.toggle()

    @Slot(str)
    def openPanel(self, name: str) -> None:  # noqa: N802 — called from the page by this name (`panel` is the popups' signal)
        """The canvas, the writing surface or Tasks, from its button."""
        if name in ("tasks", "new", "people", "files"):
            getattr(self.owner.desktop, "files_panel" if name == "files" else name).toggle()
            return
        w = self.owner.desktop.workspaces.get(name)
        if w:
            w.toggle()

    @Slot(str)
    def popup(self, kind: str) -> None:
        self.owner.desktop.bar.toggle_popup(kind)

    @Slot(str, float)
    def popupAt(self, kind: str, x: float) -> None:  # noqa: N802 — called from the page by this name
        """A popup centered under the button at `x` along the bar (its page's pixels)."""
        self.owner.desktop.bar.toggle_popup(kind, x)

    @Slot(str, float)
    def tip(self, text: str, x: float) -> None:
        """A tooltip under the button at `x` (its page's pixels); empty text puts it away."""
        bar = self.owner.desktop.bar
        # A bar that hides reserves no space; the tip stands off by its height instead.
        off = bar.view.height() if bar.desktop.config["bar"].get("autohide") else 0
        self.owner.desktop.tip.show(text, x * zoom_of("bar"), bar.edge, off, area="bar")

    @Slot(str)
    def launcher(self, mode: str) -> None:
        self.owner.desktop.bar.close_popup()
        self.owner.desktop.launcher.toggle(mode)

    @Slot()
    def settings(self) -> None:
        self.owner.desktop.bar.close_popup()
        self.owner.desktop.settings.toggle()

    @Slot()
    def themeMode(self) -> None:  # noqa: N802 — called from the page by this name
        """Light or dark, the other of the two, through Settings' own keeping (checked and saved as any change is)."""
        theme = self.owner.desktop.config["theme"]
        error = self.owner.desktop.settings.apply({"theme": {"mode": "light" if theme.get("mode", "dark") == "dark" else "dark"}})
        if error:
            log(f"bar: theme not changed: {error}")

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
        # Which tray item's menu is out, and where along the bar its button
        # is (Qt's units), to center a popup under; -1 is at the bar's end.
        self.tray_item = ""
        self.at = -1
        self.closed, self.closed_at, self.closed_item = "", 0.0, ""
        self.bridge = BarBridge(self, self)
        self.profile = profile
        self.view = make_view(profile, "popup", "talaris-ui://ui/popup.html", self.bridge, self)
        self.surface = LayerSurface(self.view, "talaris-popup")
        # Which showing the page has said it drew (`shownDrawn`); one not said is a page not drawing.
        self.drawn_for = 0.0
        self.remade = False
        # A press anywhere off the dropdown puts it away, as the dock's menu (sensor.ClickAway).
        self.away = ClickAway(profile, self.close, self, name="popup-catcher")
        self.idle = QTimer(self)
        self.idle.setSingleShot(True)
        self.idle.timeout.connect(self.close)

    def describe(self) -> dict:
        # `shown`: which showing this is — a popup opened again on the same kind is a new one to its page.
        return {"popup": self.kind, "shown": getattr(self, "shown_at", 0), "theme": self.desktop.config["theme"],
                "clock": self.desktop.config.get("clock", {})}

    def show(self, kind: str) -> None:
        self.kind = kind
        self.shown_at = self.away.shown()
        w, h = POPUPS[kind]
        anchor = ANCHOR_BOTTOM if self.bar.edge == "bottom" else ANCHOR_TOP
        keys = KEYBOARD_ON_DEMAND
        # Respecting other surfaces' reserved space puts it just clear of the bar.
        if kind in ("tray", "trayicons") or self.at >= 0:
            # Centered under the icon it belongs to.
            screen = QApplication.primaryScreen().geometry()
            left = max(4, min(int(self.at - zoom(w) / 2), screen.width() - zoom(w) - 4))
            self.surface.placement = None
            self.surface.apply(Placement(OVERLAY, anchor | ANCHOR_LEFT, zoom(w), zoom(h), keys, margins=(left, 0, 0, 0)))
        else:
            self.surface.apply(Placement(OVERLAY, anchor | ANCHOR_RIGHT, zoom(w), zoom(h), keys))
        self.bridge.state.emit(json.dumps(self.describe()))
        if kind in ("network", "bluetooth", "battery"):
            self.desktop.machine.panel_read(kind)
        self.touched()
        shown = self.shown_at
        QTimer.singleShot(1200, lambda: self._check_drawn(kind, shown))

    def drawn_ok(self, shown: float) -> None:
        self.drawn_for = shown

    def _check_drawn(self, kind: str, shown: float) -> None:
        """
        Shown, but never drawn: the engine lost the popup's picture ("Compositor
        returned null texture") and its surface sits there empty, see-through,
        not even going when closed. Twice it came after a while of ordinary use
        and could not be made to come back on demand. So it is noticed and
        mended: the view made anew, and shown again — once, and logged with what
        was out, to learn what brings it on.
        """
        if self.kind != kind or self.shown_at != shown or self.drawn_for == shown:
            self.remade = False
            return
        out = [p.NAME for p in self.desktop.overlays() if getattr(p, "up", False)]
        log(f"popup: {kind} shown but not drawn (out: {', '.join(out) or 'nothing'}); {'made again' if not self.remade else 'still not drawn'}")
        if self.remade:
            return
        self.remade = True
        old = self.view
        self.surface.placement = None
        old.hide()
        self.view = make_view(self.profile, "popup", "talaris-ui://ui/popup.html", self.bridge, self)
        self.surface = LayerSurface(self.view, "talaris-popup")
        old.deleteLater()
        self.kind = ""

        def again(_ok: bool) -> None:
            self.view.page().loadFinished.disconnect(again)
            self.show(kind)
        self.view.page().loadFinished.connect(again)

    #: Popups sized by what is in them, so no text size or typeface cuts them
    #: off or leaves them half empty; the lists scroll, and keep their size.
    FITTED = ("power", "volume", "tray", "trayicons", "battery", "projects")

    def fit(self, height: int) -> None:
        if self.kind not in self.FITTED or height <= 0:
            return
        want = math.ceil(height * zoom_of("interface"))
        # Never taller than the screen below the bar: what is longer scrolls inside it.
        screen = QApplication.primaryScreen()
        if screen is not None:
            want = min(want, screen.availableGeometry().height() - 60)
        placed = self.surface.placement
        if placed and abs(placed.height - want) > 1:
            self.surface.placement = None
            self.surface.apply(dataclasses.replace(placed, height=want))

    def fit_width(self, width: int) -> None:
        """As wide as asked, and centered again under the button it belongs to."""
        placed = self.surface.placement
        if self.kind != "trayicons" or width <= 0 or not placed:
            return
        want = math.ceil(width * zoom_of("interface"))
        if abs(placed.width - want) <= 1:
            return
        screen = QApplication.primaryScreen().geometry()
        left = max(4, min(int(self.at - want / 2), screen.width() - want - 4))
        self.surface.placement = None
        self.surface.apply(dataclasses.replace(placed, width=want, margins=(left, 0, 0, 0)))

    def file_away(self) -> None:
        """From the page — Escape, or the pointer gone elsewhere."""
        if self.away.settling():
            return
        self.close()

    def close(self) -> None:
        if not self.kind:
            return
        # Remembered a moment: pressing a popup's own button closes it (the
        # popup loses the keyboard) just before the press arrives, which must
        # not open it again.
        self.closed, self.closed_at, self.closed_item = self.kind, time.monotonic(), self.tray_item
        self.away.gone()
        self.kind = ""
        self.tray_item = ""
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
            self.idle.start(POPUP_IDLE_LONG_MS if self.kind in ("network", "bluetooth", "clipboard") else POPUP_IDLE_MS)


class Bar(QObject):
    #: Morgan's answer about its reminders, from the thread that asked, to the popup on Qt's own thread.
    _reminders = Signal(str)

    def __init__(self, config: dict, profile: QWebEngineProfile, desktop) -> None:
        super().__init__(desktop)
        self.desktop = desktop
        # Top or bottom, for now. A bar standing on a side edge is a vertical
        # layout of its own, and waits until somebody wants one.
        self.edge = config.get("edge", "top") if config.get("edge") in ("top", "bottom") else "top"
        self.bridge = BarBridge(self, self)
        self.view = make_view(profile, "bar", "talaris-ui://ui/bar.html", self.bridge, self, area="bar")
        self.surface = LayerSurface(self.view, "talaris-bar")
        self.popup = Popup(profile, self)
        #: A fullscreen window covers the top layer: the bar hides, and comes out over it from the edge (fullscreen.py).
        self.covered = False
        self.hider = Autohide(profile, "bar", self.view, self._show, self._hide,
                              busy=lambda: bool(self.popup.kind), parent=self)
        desktop.machine.changed.connect(self._reading)
        # Read every few seconds while a popup shows the readings; every so often otherwise (machine.py).
        desktop.machine.watched = lambda: bool(self.popup.kind)
        desktop.machine.panel.connect(self.popup.bridge.panel.emit)
        desktop.tray.items.connect(lambda _text: self._tray_changed())
        desktop.tray.menu.connect(self._tray_menu)
        # Morgan's state, from the stream the process follows: the button wears it.
        desktop.morgan_link.state.connect(lambda _now: self.bridge.state.emit(json.dumps(self.describe())))
        # Morgan's timers and reminders: beside the bell, and in its list. Asked when Morgan says one was set, changed
        # or went off, when its stream comes back, and each minute (one cancelled by voice says nothing).
        self.timers: list[dict] = []
        self._reminders.connect(self._got_reminders)
        desktop.morgan_link.event.connect(self._morgan_event)
        desktop.morgan_link.state.connect(lambda now: self.read_reminders() if now != "absent" and not self.timers_read else None)
        self.timers_read = False
        self._timers_poll = QTimer(self)
        self._timers_poll.setInterval(60_000)
        self._timers_poll.timeout.connect(self.read_reminders)
        self._timers_poll.start()
        QTimer.singleShot(3000, self.read_reminders)

    def went(self) -> None:
        """A project gone to: the bar's name of it flashes — the bar brought out a moment first, if it hides."""
        self.hider.peek(2600)
        self.bridge.flash.emit()

    def place(self) -> None:
        """Along its edge — or, set to hide, away until the edge is touched."""
        if self.covered:
            self.hider.set(True, self.edge, OVERLAY)
            return
        hide = bool(self.desktop.config["bar"].get("autohide"))
        self.hider.set(hide, self.edge)
        if not hide:
            self._show()

    def cover(self, covered: bool) -> None:
        """A fullscreen window in front, or none any more: the bar placed for it."""
        if covered != self.covered:
            self.covered = covered
            self.place()

    def _show(self) -> None:
        screen = QApplication.primaryScreen().geometry()
        edge = ANCHOR_BOTTOM if self.edge == "bottom" else ANCHOR_TOP
        hide = bool(self.desktop.config["bar"].get("autohide")) or self.covered
        # A hiding bar reserves nothing: the windows keep the space, and it
        # comes out over them.
        look = self.desktop.config["bar"]
        # Floating, the bar stands off the screen's edges: its surface is the
        # bar and the space between it and the edge, and reserves both.
        near = margins(look)[self.edge] if look.get("shape") == "floating" else 0
        tall = zoom(BAR + near, "bar")
        # A shadow needs room to fall into: the surface is that much taller
        # than the space it reserves, and the extra is clear.
        room = zoom(SHADOW_ROOM, "bar") if look.get("shadow") else 0
        # The surface on whole pixels from Qt to the screen (layershell.whole):
        # the difference comes out of the clear room where there is any, else
        # out of the bar itself.
        total = whole(tall + room)
        if room:
            room = max(0, total - tall)
        else:
            tall = total
        self.room = room
        self.surface.placement = None
        self.surface.apply(Placement(OVERLAY if self.covered else TOP, edge | ANCHOR_LEFT | ANCHOR_RIGHT, screen.width(), tall + room,
                                     KEYBOARD_NONE, exclusive=0 if hide else tall))
        self.bridge.state.emit(json.dumps({**self.describe(), "arrived": hide}))

    def _hide(self) -> None:
        self.view.hide()
        self.surface.placement = None

    def describe(self) -> dict:
        return {
            "edge": self.edge,
            "project": self.desktop.project,
            # Demo mode (demo.py): the bar says so, so a made-up world is never taken for the real one.
            "demo": bool(os.environ.get("TALARIS_DEMO")),
            "theme": self.desktop.config["theme"],
            # The clear room below (or above) the bar, in the page's pixels.
            "room": round(getattr(self, "room", 0) / (zoom_of("bar") or 1), 3),
            "clock": self.desktop.config["clock"],
            "look": {**self.desktop.config["bar"], "margins": margins(self.desktop.config["bar"])},
            "popup": self.popup.kind,
            # Which tray item's menu is out, for its icon to show it.
            "trayItem": self.popup.tray_item,
            # `absent`, `idle`, `listening`, `thinking`… and whether its
            # conversation is out.
            "morgan": self.desktop.morgan_link.now,
            "morganOpen": bool(getattr(self.desktop, "morgan", None) and self.desktop.morgan.up),
            "calendarOpen": bool(getattr(self.desktop, "calendar", None) and self.desktop.calendar.up),
            "launcherOpen": bool(getattr(self.desktop, "launcher", None) and self.desktop.launcher.up),
            "settingsOpen": bool(getattr(self.desktop, "settings", None) and self.desktop.settings.up),
            "panelsOpen": {**{n: w.up for n, w in getattr(self.desktop, "workspaces", {}).items()},
                           "tasks": bool(getattr(self.desktop, "tasks", None) and (self.desktop.tasks.up or self.desktop.tasks.windowed)),
                           "new": bool(getattr(self.desktop, "new", None) and self.desktop.new.up),
                           "people": bool(getattr(self.desktop, "people", None) and (self.desktop.people.up or self.desktop.people.windowed)),
                           "files": bool(getattr(self.desktop, "files_panel", None) and (self.desktop.files_panel.up or self.desktop.files_panel.windowed))},
            # Morgan's timers and reminders, soonest first: the bell counts the next one down within the hour.
            "timers": getattr(self, "timers", []),
            # The bell's dot: how many notifications have not been seen in its list.
            "unread": self.desktop.notifications.unread() if getattr(self.desktop, "notifications", None) else 0,
        }

    def clips_changed(self) -> None:
        """The clipboard's history changed: its list, if it is out, read again."""
        if self.popup.kind == "clipboard":
            self.popup.bridge.clips.emit()

    def notifications_changed(self) -> None:
        """The list of notifications changed: the bell's list, if it is out, drawn again."""
        if self.popup.kind == "notifications":
            self.popup.bridge.notices.emit(self.notification_listing())

    def read_reminders(self, cancel: str = "") -> None:
        """
        Morgan's timers and reminders, asked for off Qt's thread (a daemon slow
        to answer must not hold the bar), and pushed to the popup — one
        cancelled first, if `cancel` names it. Morgan not running says so.
        """
        def ask() -> None:
            if cancel:
                answer = morgan_command("admin " + json.dumps({"op": "reminders.cancel", "args": {"id": cancel}}), timeout=8)
                log(f"bar: reminder {cancel} cancelled" if '"ok":true' in answer.replace(" ", "") else f"bar: reminder {cancel} not cancelled: {answer[:200]}")
            self._reminders.emit(morgan_command("reminders", timeout=8))
        threading.Thread(target=ask, daemon=True).start()

    def _got_reminders(self, text: str) -> None:
        try:
            answer = json.loads(text)
        except ValueError:
            answer = {}
        if answer.get("ok"):
            self.timers_read = True
            # Morgan's times are on its own clock, a server's maybe, which need not agree with this machine's: moved
            # onto ours by the difference it says (`now`, protocol 1.10), so a two-minute timer counts down from 2:00.
            skew = int(answer["now"] - time.time() * 1000) if isinstance(answer.get("now"), (int, float)) else 0
            for r in answer.get("reminders", []):
                for k in ("at", "made"):
                    if isinstance(r.get(k), (int, float)):
                        r[k] -= skew
            text = json.dumps(answer)
            timers = [{k: r.get(k) for k in ("id", "at", "made", "text")} for r in answer.get("reminders", [])]
            if timers != self.timers:
                self.timers = timers
                self.bridge.state.emit(json.dumps(self.describe()))
        self.popup.bridge.reminders.emit(text)

    def _morgan_event(self, text: str) -> None:
        if '"reminder"' in text:
            try:
                if json.loads(text).get("type") == "reminder":
                    self.read_reminders()
            except ValueError:
                pass

    def notification_listing(self) -> str:
        n = self.desktop.notifications
        return json.dumps([{**x, "canOpen": n.can_open(x)} for x in n.items])

    def changed(self) -> None:
        """Something the bar lights for opened or closed: said again."""
        self.bridge.state.emit(json.dumps(self.describe()))

    def _reading(self, text: str) -> None:
        self.bridge.machine.emit(text)
        self.popup.bridge.machine.emit(text)

    # ------------------------------------------------------------ the tray

    def tray_listing(self) -> str:
        """The tray's items as the bar shows them: none if Settings turned it off, less any put away."""
        look = self.desktop.config["bar"]
        hidden = set(look.get("trayHidden", []))
        items = json.loads(self.desktop.tray.last)
        return json.dumps([{**i, "hidden": i.get("appId") in hidden} for i in items] if look.get("tray", True) else [])

    def _tray_changed(self) -> None:
        listing = self.tray_listing()
        self.bridge.tray.emit(listing)
        self.popup.bridge.tray.emit(listing)

    def tray_pane(self, x: float) -> None:
        """The folded tray's icon: its pane of icons, under it, out or away."""
        if self.popup.kind == "trayicons":
            self.popup.close()
            return
        if self.just_closed("trayicons"):
            return
        self.popup.tray_item, self.popup.at = "", int(x * zoom_of("bar"))
        self.popup.show("trayicons")
        log("popup: trayicons")
        self.popup.bridge.tray.emit(self.tray_listing())
        self.bridge.state.emit(json.dumps(self.describe()))

    def tray_do(self, item: str, verb: str, x: float) -> None:
        known = self.desktop.tray.known.get(item)
        if not known:
            return
        # Where on the screen, for an item that places something of its own
        # there; from the folded tray's pane (x < 0), where the pane is.
        at = int(x * zoom_of("bar")) if x >= 0 else self.popup.at
        if verb == "activate" and known.get("itemIsMenu"):
            verb = "menu"
        if verb == "menu":
            if self.popup.kind == "tray" and self.popup.tray_item == item:
                self.popup.close()
                return
            if self.just_closed("tray") and self.popup.closed_item == item:
                return
            self.popup.tray_item, self.popup.at = item, at
            if known.get("menu"):
                self.desktop.tray.do(do="menu", id=item)
            else:
                self.desktop.tray.do(do="context", id=item, x=at, y=0)
        else:
            self.popup.close()
            self.desktop.tray.do(do=verb, id=item, x=at, y=0)

    def _tray_menu(self, text: str) -> None:
        menu = json.loads(text)
        if menu.get("id") != self.popup.tray_item:
            return
        self.popup.show("tray")
        log(f"popup: tray menu ({len(menu.get('items', []))} entries)")
        menu["title"] = self.desktop.tray.known.get(menu["id"], {}).get("title", "")
        self.popup.bridge.trayMenu.emit(json.dumps(menu))
        self.bridge.state.emit(json.dumps(self.describe()))

    def just_closed(self, kind: str) -> bool:
        """Whether this popup closed a moment ago — as its own button's press arrives."""
        return self.popup.closed == kind and time.monotonic() - self.popup.closed_at < 0.4

    def toggle_popup(self, kind: str, x: float | None = None) -> None:
        if kind not in POPUPS:
            return
        if self.popup.kind == kind:
            self.popup.close()
            return
        if self.just_closed(kind):
            return
        # Under its button when the page says where that is; else at the bar's end.
        self.popup.at = int(x * zoom_of("bar")) if x is not None else -1
        self.popup.show(kind)
        # Fresh as it opens, not as of the last idle reading.
        self.desktop.machine.refresh()
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
