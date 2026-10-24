# SPDX-License-Identifier: GPL-3.0-only
# Copyright (c) 2026 Jeff Moore
"""
Talaris's surfaces: everything on the screen that is not an application window.

The bar (`bar.py`), the dock (`dock.py`), the launcher (`launcher.py`),
Morgan's face (`morgan.py`) and the drawers. Each drawer belongs to one edge and is in one of three
modes:

- **filed** — a handle on its edge, above the windows, so it can be pulled out.
- **out** — on an empty workspace, the canvas *is* the desktop: full size, on
  the `bottom` layer, below where windows would be.
- **pulled** — out over the windows, on the `overlay` layer.

**Every way back exists from the first line.** The first spike pulled a surface
over the screen with no way back but a terminal it had covered, and ended in a
restart. So a pulled drawer goes back on its compositor bind, on Escape, on a
command, and by itself after a stretch with no input.

Run through `talaris-surfaces`, which sets the layer-shell integration for the
whole process — that has to happen before Qt starts.
"""

from __future__ import annotations

import json
import time
import mimetypes
import os
import sys

from PySide6.QtCore import QByteArray, QBuffer, QIODevice, QObject, QTimer, QUrl, QUrlQuery
from PySide6.QtNetwork import QLocalServer, QLocalSocket
from PySide6.QtWebEngineCore import (
    QWebEngineProfile,
    QWebEngineUrlRequestJob,
    QWebEngineUrlScheme,
    QWebEngineUrlSchemeHandler,
)
from PySide6.QtWidgets import QApplication

import hypr
from apps import Apps
from bar import Bar
from bar import margins as bar_margins
from config import load_config
from dock import Dock
from launcher import Launcher
from morgan import Link, Panel, Voice
from osd import Osd
from sensor import Catcher, EdgeSensor, Hover
import sensor as sensor_module
from settings import Settings
from machine import Machine
from views import AREAS, log, make_view, set_zoom, zoom, zoom_of
from core import Bridge, call
from layershell import (
    ANCHOR_BOTTOM,
    ANCHOR_LEFT,
    ANCHOR_RIGHT,
    ANCHOR_TOP,
    BOTTOM,
    EDGE_ANCHOR,
    EDGE_SPAN,
    KEYBOARD_EXCLUSIVE,
    KEYBOARD_NONE,
    KEYBOARD_ON_DEMAND,
    OVERLAY,
    TOP,
    LayerSurface,
    QT_SCALE,
    Placement,
    to_compositor,
)

HERE = os.path.dirname(os.path.abspath(__file__))
UI = os.path.join(HERE, "ui")
LAUNCHER = os.path.join(HERE, "talaris-surfaces")
SCHEME = b"talaris-ui"
CONTROL = f"talaris-surfaces-{os.getuid()}"
# Small on purpose: the handle says "something is here", not "look at me".
HANDLE = (10, 56)


def register_scheme() -> None:
    """Before any profile exists, or Qt quietly gives a scheme with no permissions."""
    scheme = QWebEngineUrlScheme(SCHEME)
    scheme.setSyntax(QWebEngineUrlScheme.Syntax.Host)
    scheme.setFlags(
        QWebEngineUrlScheme.Flag.SecureScheme
        | QWebEngineUrlScheme.Flag.LocalAccessAllowed
        | QWebEngineUrlScheme.Flag.CorsEnabled
        | QWebEngineUrlScheme.Flag.ContentSecurityPolicyIgnored
    )
    QWebEngineUrlScheme.registerScheme(scheme)


class Files(QWebEngineUrlSchemeHandler):
    """The pages' own files and applications' icons, and nothing else — every one a GET, so no request body is ever touched."""

    def __init__(self, parent: QObject, apps: Apps) -> None:
        super().__init__(parent)
        self.apps = apps

    def requestStarted(self, job: QWebEngineUrlRequestJob) -> None:  # noqa: N802 — Qt's name
        url = job.requestUrl()
        # `talaris-ui://icon/?n=<name>`: an application's icon, which a page has no
        # way to read for itself. Names only — the theme lookup, or the path a
        # `.desktop` file gave — never a path a page made up.
        if url.host() == "icon":
            name = QUrlQuery(url).queryItemValue("n", QUrl.ComponentFormattingOption.FullyDecoded)
            data = self.apps.icon_png(name) if name in self.apps.known_icons() else None
            if not data:
                job.fail(QWebEngineUrlRequestJob.Error.UrlNotFound)
                return
            self._reply(job, data, "image/png")
            return
        rel = url.path().lstrip("/") or "drawer.html"
        full = os.path.realpath(os.path.join(UI, rel))
        if not full.startswith(os.path.realpath(UI) + os.sep) or not os.path.isfile(full):
            job.fail(QWebEngineUrlRequestJob.Error.UrlNotFound)
            return
        with open(full, "rb") as f:
            data = f.read()
        self._reply(job, data, mimetypes.guess_type(full)[0] or "application/octet-stream")

    @staticmethod
    def _reply(job: QWebEngineUrlRequestJob, data: bytes, mime: str) -> None:
        buf = QBuffer(job)
        buf.setData(QByteArray(data))
        buf.open(QIODevice.OpenModeFlag.ReadOnly)
        job.reply(mime.encode("ascii"), buf)


class Drawer(QObject):
    def __init__(self, name: str, config: dict, profile: QWebEngineProfile, desktop: "Desktop") -> None:
        super().__init__(desktop)
        self.name = name
        self.desktop = desktop
        self.edge = config["edge"]
        self.size = float(config["size"])
        # "Canvas as desktop" — a drawer out on an empty workspace — was taken
        # out of Settings (2026-10-23); an old setting does not bring it back.
        self.out_when_empty = False
        # Touch to show: no handle; the pointer touching the edge pulls the
        # drawer, and leaving it files it again. Pulled by its keys instead,
        # it stays until put away, as before.
        self.autoshow = bool(config.get("autoshow"))
        self.bumped = False
        self.pulled = False
        # Expanded, the drawer is the desktop: a workspace of its own
        # (`hypr.DESK`), and `came_from` the one to go back to.
        self.expanded = False
        self.came_from = None
        self.expanded_at = 0.0
        self.mode = ""
        self.leaving = False

        self.bridge = Bridge(self, self)
        self.view = make_view(profile, name, f"talaris-ui://ui/drawer.html?drawer={name}", self.bridge, self, area=name)
        self.surface = LayerSurface(self.view, f"talaris-{name}")
        self.sensor = EdgeSensor(profile, name, self.edge, self._bump, self)
        self.away = QTimer(self)
        self.away.setSingleShot(True)
        self.away.timeout.connect(self._away)
        Hover(self.view, self._hover)

        self.idle = QTimer(self)
        self.idle.setSingleShot(True)
        self.idle.timeout.connect(self._idle)

    def describe(self) -> dict:
        return {
            "drawer": self.name,
            "edge": self.edge,
            "mode": self.mode,
            "project": self.desktop.project,
            "theme": self.desktop.config["theme"],
            "look": self.desktop.config["panels"],
            # Where a window's frame would be, side by side, in this page's own
            # pixels: Hyprland's gaps are the compositor's, which a page sees
            # through Qt's scale and its own zoom.
            "insets": {side: round(px / (QT_SCALE * zoom_of(self.name)), 2)
                       for side, px in getattr(self.desktop, "gaps", {}).items()},
        }

    def _placement(self, mode: str) -> Placement:
        screen = QApplication.primaryScreen().geometry()
        anchor = EDGE_ANCHOR[self.edge]
        across = self.edge in ("left", "right")
        if mode == "expanded":
            # The whole desktop, between the bar and the dock, below where
            # windows would be — so one coming back shows above it.
            return Placement(BOTTOM, ANCHOR_TOP | ANCHOR_BOTTOM | ANCHOR_LEFT | ANCHOR_RIGHT,
                             screen.width(), screen.height(), KEYBOARD_ON_DEMAND)
        if mode == "filed":
            w, h = (zoom(HANDLE[0]), zoom(HANDLE[1])) if across else (zoom(HANDLE[1]), zoom(HANDLE[0]))
            # Anchored to its edge alone, the compositor centers it along that edge.
            return Placement(TOP, anchor, w, h, KEYBOARD_NONE)
        w = int(screen.width() * self.size) if across else screen.width()
        h = screen.height() if across else int(screen.height() * self.size)
        # Pulled out, the drawer keeps the keyboard to itself: moving the
        # pointer onto a window cannot hand that window the keyboard — waking
        # it from its dimmed look and flickering the drawer's in-use outline —
        # while scrolling still reaches whatever is under the pointer. To type
        # in a window, put the drawer away.
        # With click-outside on, the catcher already keeps the pointer off the
        # windows — and an exclusive drawer kept clicks from reaching the
        # catcher — so it takes the keyboard the ordinary way.
        exclusive = mode == "pulled" and not self.desktop.config["panels"].get("dismissOutside")
        keyboard = KEYBOARD_EXCLUSIVE if exclusive else KEYBOARD_ON_DEMAND
        return Placement(BOTTOM if mode == "out" else OVERLAY, anchor | EDGE_SPAN[self.edge], w, h, keyboard)

    #: How long a page has to finish leaving before the surface goes anyway.
    #: A page that never answers must not leave a drawer stuck over the screen.
    LEAVE_LIMIT_MS = 800

    def _wanted(self) -> str:
        if self.expanded:
            return "expanded"
        return "pulled" if self.pulled else "out" if (self.out_when_empty and self.desktop.empty) else "filed"

    def settle(self) -> None:
        mode = self._wanted()
        if mode == self.mode or self.leaving:
            return
        # Going back to a handle: the page plays its leaving first, then says
        # so, and only then does the surface move. Moving it first is what made
        # closing a snap rather than a slide.
        if mode == "filed" and self.mode in ("pulled", "out"):
            self.leaving = True
            self.idle.stop()
            self.bridge.leave.emit()
            QTimer.singleShot(self.LEAVE_LIMIT_MS, lambda: self.left(late=True))
            return
        self._become(mode)

    def left(self, late: bool = False) -> None:
        """The page has finished leaving — or ran out of time to."""
        if not self.leaving:
            return
        if late:
            log(f"{self.name}: the page did not finish leaving in time; filed anyway")
        self.leaving = False
        self._become(self._wanted())

    def _become(self, mode: str) -> None:
        if mode == self.mode:
            return
        self.mode = mode
        if mode == "filed" and self.autoshow:
            # No handle: the surface goes, and the edge waits to be touched.
            self.view.hide()
            self.surface.placement = None
            self.sensor.show(self.edge)
            self.sensor.disarm_if_under_pointer()
        else:
            self.surface.apply(self._placement(mode))
            if not self.autoshow:
                self.sensor.hide()
        self.bridge.state.emit(json.dumps(self.describe()))
        if mode == "pulled":
            self.touched()
        else:
            self.idle.stop()
        self.desktop.catcher_update()
        log(f"{self.name}: {mode}")

    # ------------------------------------------------------------ expanded

    def grow(self) -> None:
        """The expand button: the desktop, or back to a drawer."""
        if self.expanded:
            self.collapse()
        else:
            self.expand()

    def expand(self) -> None:
        """
        The desktop: a workspace of its own, empty but for this drawer. The
        windows are not moved — moving them out and back made Hyprland tile
        them again in the order they came, losing their layout — they stay on
        the workspace left, as they were, and that is where collapsing goes.
        """
        for other in self.desktop.drawers.values():
            if other is not self:
                other.collapse()
                other.file_away()
        now = hypr.windows()
        self.came_from = now["active"]
        self.expanded = True
        self.expanded_at = time.monotonic()
        self.pulled = True
        self.bumped = False
        self.away.stop()
        self.settle()
        # The surface first, the workspace after: making the surface anew
        # hands the keyboard back to the last window, and Hyprland, following
        # focus, would take the screen back to that window's workspace.
        QTimer.singleShot(150, lambda: self.expanded and hypr.go(hypr.DESK))

    def collapse(self, follow: bool = True) -> None:
        """
        Back to a drawer, and to the workspace it was expanded from — with any
        window opened meanwhile, which comes along. `follow` is false when the
        user went to another workspace themself, and is left there.
        """
        if not self.expanded:
            return
        self.expanded = False
        back = getattr(self, "came_from", None)
        if back is not None:
            now = hypr.windows()
            names = {w["id"]: w["name"] for w in now["workspaces"]}
            for w in now["windows"]:
                if names.get(w["workspace"]) == hypr.DESK:
                    hypr.bring(w["address"], back)
            if follow and now["activeName"] == hypr.DESK:
                hypr.go(back)
        # Settings says whether it stays out as a drawer, or goes away too.
        if self.desktop.config["panels"].get("afterExpand", "open") == "closed":
            self.pulled = False
        self.settle()

    def windows_changed(self, now: dict) -> None:
        """Expanded: a window opened on its desktop, or another desktop gone to, makes it a drawer again."""
        if not self.expanded or time.monotonic() - self.expanded_at < 0.6:
            return
        names = {w["id"]: w["name"] for w in now["workspaces"]}
        if now["activeName"] != hypr.DESK:
            self.collapse(follow=False)
        elif any(names.get(w["workspace"]) == hypr.DESK and not w["hidden"] for w in now["windows"]):
            self.collapse()

    def toggle(self) -> None:
        if self.leaving:
            return
        self.pulled = not self.pulled
        self.bumped = False
        self.settle()

    def _bump(self) -> None:
        """The edge was touched: out, until the pointer leaves."""
        if self.autoshow and not self.pulled and not self.leaving:
            self.pulled = True
            self.bumped = True
            self.settle()
            self.away.start(1400)

    def _hover(self, inside: bool) -> None:
        if not (self.bumped and self.pulled):
            return
        if inside:
            self.away.stop()
        else:
            self.away.start(700)

    def _away(self) -> None:
        if self.bumped and self.pulled:
            self.bumped = False
            self.file_away()

    def file_away(self) -> None:
        # Expanded, Escape and the like make it a drawer again first.
        if self.expanded:
            self.collapse()
            return
        if self.pulled:
            self.pulled = False
            self.settle()

    def touched(self) -> None:
        if self.pulled and not self.expanded:
            self.idle.start(int(self.desktop.config["idleSeconds"]) * 1000)

    def _idle(self) -> None:
        log(f"{self.name}: filed after {self.desktop.config['idleSeconds']}s with no input")
        self.file_away()


class Desktop(QObject):
    def __init__(self, app: QApplication) -> None:
        super().__init__(app)
        self.config = load_config()
        self.empty = hypr.workspace_is_empty()
        # An earlier Talaris set follow_mouse to 2 while a panel was out, which
        # kept the pointer from reaching Settings until it was clicked; if one
        # left it so, it goes back to following the pointer.
        if hypr.option("input:follow_mouse") == 2:
            hypr.keyword("input:follow_mouse", "1")
        self.project = self._home()
        profile = QWebEngineProfile("talaris", self)
        profile.setPersistentStoragePath(
            os.path.join((os.environ.get("XDG_DATA_HOME") or "").strip() or os.path.expanduser("~/.local/share"),
                         "talaris", "web")
        )
        self.apps = Apps()
        self.files = Files(self, self.apps)
        profile.installUrlSchemeHandler(SCHEME, self.files)
        self.profile = profile
        sensor_module.TARGET.update(self.config["touch"])
        set_zoom(self.text_sizes())
        self.machine = Machine(self)
        # Morgan's stream, before the bar: the bar's button wears its state.
        self.morgan_link = Link(self)
        # The bar first: its reserved space is what the drawers keep clear of.
        self.bar = Bar(self.config["bar"], profile, self)
        self.bar.place()
        self.events = hypr.Events(self)
        self.dock = Dock(self.config["dock"], profile, self, self.apps)
        self.dock.place()
        self.launcher = Launcher(profile, self, self.apps)
        self.morgan = Panel(profile, self, self.morgan_link)
        self.voice = Voice(profile, self, self.morgan_link)
        self.osd = Osd(profile, self)
        self.settings = Settings(profile, self)
        self.drawers = {
            name: Drawer(name, cfg, profile, self) for name, cfg in self.config["drawers"].items()
        }
        for d in self.drawers.values():
            d.settle()

        self.events.changed.connect(self._changed)
        # An expanded drawer hears when windows change: one coming back makes
        # it a drawer again. Asked a moment after a burst, once.
        self._windows_soon = QTimer(self)
        self._windows_soon.setSingleShot(True)
        self._windows_soon.timeout.connect(self._windows_changed)
        self.events.windows.connect(lambda: self._windows_soon.start(120))
        # Clicking off a pulled drawer puts it away, when Settings says so.
        self.catcher = Catcher(profile, self._caught, self)
        self.events.reloaded.connect(self._bind)
        self._bind()

        self.control = QLocalServer(self)
        QLocalServer.removeServer(CONTROL)
        self.control.listen(CONTROL)
        self.control.newConnection.connect(self._command)

    def _home(self) -> dict:
        status, text = call("GET", "/projects")
        try:
            projects = json.loads(text) if status == 200 else []
        except ValueError:
            projects = []
        home = next((p for p in projects if p.get("home")), None)
        return home or {"id": "", "code": "", "name": "Home"}

    def _windows_changed(self) -> None:
        if any(d.expanded for d in self.drawers.values()):
            now = hypr.windows()
            for d in self.drawers.values():
                d.windows_changed(now)

    def catcher_update(self) -> None:
        """The catcher is out while a drawer is pulled (not expanded), if clicking outside puts it away."""
        if not hasattr(self, "catcher"):
            return
        want = bool(self.config["panels"].get("dismissOutside")) and any(d.mode == "pulled" for d in self.drawers.values())
        if want:
            self.catcher.show()
        else:
            self.catcher.hide()

    def _caught(self) -> None:
        log("catcher: a click outside the drawer")
        for d in self.drawers.values():
            if d.mode == "pulled":
                d.file_away()

    def _changed(self) -> None:
        empty = hypr.workspace_is_empty()
        if empty != self.empty:
            self.empty = empty
            for d in self.drawers.values():
                d.settle()

    #: How far the dock's panel stops short of the space it reserves (dock.html:
    #: a 44px panel and a 3px margin in a 50px surface). The gap on the dock's
    #: edge is that much less, so the space you see is the same on every side.
    DOCK_SHORT = 3

    def style_compositor(self) -> None:
        """
        What Hyprland draws round the windows, made to match Talaris: the
        borders in the theme's accent, and the same space on every side.
        Runtime keywords, so hyprland.conf is untouched; a reload puts its own
        values back, and `_bind` runs this again when it does.
        """
        theme = self.config["theme"]
        accent = theme["accent"].lstrip("#")
        line = "c3c8cd" if theme.get("mode") == "light" else "3a3f44"
        hypr.keyword("general:col.active_border", f"rgba({accent}ee)")
        hypr.keyword("general:col.inactive_border", f"rgba({line}aa)")
        gap = int(self.config["windows"]["gap"])
        sides = {"top": gap, "right": gap, "bottom": gap, "left": gap}
        # A floating bar's margin on the side away from its edge is the space
        # between it and the windows: the window gap on that side.
        bar = self.config["bar"]
        if bar.get("shape") == "floating" and not bar.get("autohide"):
            sides[self.bar.edge] = zoom(bar_margins(bar)["bottom" if self.bar.edge == "top" else "top"])
        # Only a dock that reserves its edge stops short of it.
        dock = self.config["dock"]
        if dock.get("enabled", True) and not dock.get("autohide"):
            sides[self.dock.edge] = max(0, gap - to_compositor(zoom(self.DOCK_SHORT, "dock")))
        # Commas: at runtime Hyprland reads "10 10 7 10" as one number and the
        # rest is lost; written with commas it takes all four sides.
        # Between two windows Hyprland leaves its inner gap on each side, so the
        # space seen is twice the number: the setting is the space seen.
        hypr.keyword("general:gaps_in", str(round(int(self.config["windows"].get("between", 10)) / 2)))
        hypr.keyword("general:gaps_out", f"{sides['top']},{sides['right']},{sides['bottom']},{sides['left']}")
        # Kept for an expanded drawer, which sits where a window's frame would.
        if sides != getattr(self, "gaps", None):
            self.gaps = sides
            for d in self.drawers.values():
                if d.mode == "expanded":
                    d.bridge.state.emit(json.dumps(d.describe()))

    def _bind(self) -> None:
        """Compositor binds, so the way back works whatever is covering the screen."""
        self.style_compositor()
        for name, keys in (("canvas", "SUPER ALT, C"), ("writing", "SUPER ALT, W")):
            if name in self.drawers:
                hypr.bind(keys, f"{LAUNCHER} --toggle {name}")
        hypr.bind("SUPER ALT, ESCAPE", f"{LAUNCHER} --file-all")
        hypr.bind(self.config["launcher"]["keys"], f"{LAUNCHER} --launcher")
        hypr.bind("SUPER ALT, M", f"{LAUNCHER} --morgan")
        self.osd.bind(LAUNCHER)

    def unbind(self) -> None:
        for keys in ("SUPER ALT, C", "SUPER ALT, W", "SUPER ALT, ESCAPE", "SUPER ALT, M", self.config["launcher"]["keys"]):
            hypr.unbind(keys)
        self.osd.unbind()

    # ---------------------------------------------------------------- settings

    def touch_targets(self) -> None:
        """Every edge sensor, made again at the size Settings gives."""
        sensor_module.TARGET.update(self.config["touch"])
        for s in [self.bar.hider.sensor, self.dock.hider.sensor, *(d.sensor for d in self.drawers.values())]:
            if s.up:
                s.show()

    def text_sizes(self) -> dict:
        """Each area's text size: its own if set, else the one size there was before areas."""
        every = self.config["theme"].get("fontSize", "medium")
        return {area: self.config.get("text", {}).get(area, every) for area in AREAS}

    def every_surface(self) -> list:
        """Everything that draws a page and wears the theme."""
        return [self.bar, self.bar.popup, self.dock, self.launcher, self.morgan, self.voice,
                self.osd, self.settings, *self.drawers.values()]

    def reconfigure(self, before: dict, after: dict) -> None:
        """Make the screen match a new configuration, moving only what changed."""
        self.config = after
        if after["bar"] != before["bar"]:
            self.bar.edge = after["bar"]["edge"]
            self.bar.place()
        if after["dock"] != before["dock"]:
            self.dock.edge = after["dock"]["edge"]
            self.dock.place()
        for name, d in self.drawers.items():
            mine = after["drawers"][name]
            if mine != before["drawers"][name]:
                d.edge, d.size = mine["edge"], float(mine["size"])
                d.autoshow = bool(mine.get("autoshow"))
                d.sensor.hide()
                # Made anew where it now belongs, filed: a drawer that moves edge
                # mid-pull would arrive somewhere it was not asked to be.
                d.pulled = False
                d.mode = ""
                d.settle()
        changed = set_zoom(self.text_sizes())
        if "dock" in changed:
            self.dock.menu.file_away()
            self.dock.place()
        if "morgan" in changed and self.morgan.up:
            self.morgan.file_away()
            self.morgan.open()
        if "interface" in changed:
            # Larger or smaller text: everything with a fixed size is made again.
            self.bar.place()
            self.bar.close_popup()
            if self.settings.up:
                self.settings.surface.placement = None
                self.settings.up = False
                self.settings.open()
            for d in self.drawers.values():
                if d.mode == "filed" and not d.autoshow:
                    d.surface.placement = None
                    d.surface.apply(d._placement("filed"))
        self.style_compositor()
        if after["panels"] != before["panels"]:
            # How a pulled drawer holds the keyboard follows click-outside.
            for d in self.drawers.values():
                if d.mode == "pulled":
                    d.surface.placement = None
                    d.surface.apply(d._placement("pulled"))
            self.catcher_update()
        if after["touch"] != before["touch"]:
            self.touch_targets()
        if after["launcher"]["keys"] != before["launcher"]["keys"]:
            hypr.unbind(before["launcher"]["keys"])
            hypr.bind(after["launcher"]["keys"], f"{LAUNCHER} --launcher")
        # Every surface hears its state again, which carries the theme.
        for surface in self.every_surface():
            surface.bridge.state.emit(json.dumps(surface.describe()))
        log("settings: applied")

    def key_list(self) -> list[dict]:
        """Talaris's keys, as the Keys page lists them."""
        nice = lambda k: k.replace(",", " +").replace("SUPER", "Super").replace("ALT", "Alt").replace("ESCAPE", "Escape").replace("  ", " ").strip(" +")
        return [
            {"keys": nice(self.config["launcher"]["keys"]), "does": "Find anything, or ask"},
            {"keys": "Super + Alt + M", "does": "Morgan's conversation"},
            {"keys": "Super + Alt + C", "does": "The canvas drawer"},
            {"keys": "Super + Alt + W", "does": "The writing drawer"},
            {"keys": "Super + Alt + Escape", "does": "Put everything away"},
            {"keys": "Volume, mute, brightness", "does": "Change it, and show the level"},
        ]

    # ---------------------------------------------------------------- what the launcher asks

    def go_to_project(self, project_id: str) -> None:
        """The current project changes: the bar says so, and the drawers open on it."""
        status, text = call("GET", "/projects")
        try:
            found = next((p for p in json.loads(text) if p.get("id") == project_id), None) if status == 200 else None
        except ValueError:
            found = None
        if not found or found["id"] == self.project.get("id"):
            return
        self.project = found
        for d in self.drawers.values():
            d.bridge.state.emit(json.dumps(d.describe()))
        self.bar.bridge.state.emit(json.dumps(self.bar.describe()))
        log(f"project: {found['name']}")

    def show_in_drawer(self, name: str, target: dict) -> None:
        """Open a drawer on one canvas or one page."""
        d = self.drawers.get(name)
        if not d:
            return
        d.bridge.show.emit(json.dumps(target))
        if not d.pulled and d.mode != "out":
            d.toggle()

    #: What the launcher's verbs do. The power ones were asked twice in the page.
    def verb(self, name: str) -> str:
        if name in ("canvas", "writing"):
            self.drawers[name].toggle()
        elif name == "file-all":
            for d in self.drawers.values():
                d.file_away()
        elif name in ("lock", "suspend", "logout", "restart", "shutdown"):
            self.machine.power(name)
        elif name in ("network", "bluetooth"):
            self.bar.toggle_popup(name)
        elif name == "settings":
            self.settings.open()
        else:
            return "No such thing to do"
        return ""

    def _command(self) -> None:
        conn = self.control.nextPendingConnection()

        def read() -> None:
            line = bytes(conn.readAll()).decode("utf-8", "replace").strip()
            verb, _, arg = line.partition(" ")
            if verb == "toggle" and arg in self.drawers:
                self.drawers[arg].toggle()
            elif verb == "file-all":
                for d in self.drawers.values():
                    d.file_away()
                self.bar.close_popup()
                self.launcher.file_away()
                self.morgan.file_away()
                self.voice.file_away()
                self.settings.file_away()
            elif verb == "grow" and arg in self.drawers:
                self.drawers[arg].grow()
            elif verb == "settings":
                self.settings.open(arg)
            elif verb == "osd":
                self.osd.show(arg)
            elif verb == "morgan":
                self.morgan.toggle()
            elif verb == "launcher":
                self.launcher.toggle(arg)
            elif verb == "popup":
                self.bar.toggle_popup(arg)
            elif verb == "quit":
                QApplication.quit()
            conn.write(b"ok\n")
            conn.flush()
            conn.disconnectFromServer()

        conn.readyRead.connect(read)


def send(command: str) -> int:
    """`talaris-surfaces --toggle canvas`: tell the running process."""
    sock = QLocalSocket()
    sock.connectToServer(CONTROL)
    if not sock.waitForConnected(1000):
        print("talaris-surfaces is not running", file=sys.stderr)
        return 1
    sock.write(command.encode() + b"\n")
    sock.flush()
    sock.waitForReadyRead(1000)
    return 0


def main() -> int:
    args = sys.argv[1:]
    if args[:1] == ["--toggle"] and len(args) == 2:
        return send(f"toggle {args[1]}")
    if args[:1] == ["--grow"] and len(args) == 2:
        return send(f"grow {args[1]}")
    if args[:1] == ["--settings"]:
        return send("settings " + (args[1] if len(args) > 1 else ""))
    if args[:1] == ["--osd"] and len(args) == 2:
        return send(f"osd {args[1]}")
    if args[:1] == ["--morgan"]:
        return send("morgan")
    if args[:1] == ["--launcher"]:
        return send("launcher " + (args[1] if len(args) > 1 else ""))
    if args[:1] == ["--popup"] and len(args) == 2:
        return send(f"popup {args[1]}")
    if args[:1] == ["--file-all"]:
        return send("file-all")
    if args[:1] == ["--quit"]:
        return send("quit")

    register_scheme()
    app = QApplication(sys.argv)
    app.setApplicationName("talaris-surfaces")
    app.setQuitOnLastWindowClosed(False)
    desktop = Desktop(app)
    import signal

    signal.signal(signal.SIGTERM, lambda *_: QTimer.singleShot(0, app.quit))
    signal.signal(signal.SIGINT, lambda *_: QTimer.singleShot(0, app.quit))
    # Signal handlers run between Python bytecodes; a ticking timer gives them some.
    tick = QTimer(app)
    tick.timeout.connect(lambda: None)
    tick.start(250)
    app.aboutToQuit.connect(desktop.unbind)
    log("up:", ", ".join(f"{n} on the {d.edge}" for n, d in desktop.drawers.items()))
    return app.exec()


if __name__ == "__main__":
    sys.exit(main())
