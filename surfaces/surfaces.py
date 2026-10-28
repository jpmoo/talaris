# SPDX-License-Identifier: GPL-3.0-only
# Copyright (c) 2026 Jeff Moore
"""
Talaris's surfaces: everything on the screen that is not an application window.

The bar (`bar.py`), the dock (`dock.py`), the launcher (`launcher.py`), and
what opens from the bar: Morgan's conversation (`morgan.py`), the calendar
(`calendar_panel.py`), the canvas and the writing surface (`workspace.py`) —
each a panel over the dimmed screen, or an ordinary window that Hyprland tiles
(`overlay.py`). Until 2026-10-24 the canvas and the writing surface were
drawers, sliding from an edge.

**Every way back exists from the first line.** The first spike pulled a surface
over the screen with no way back but a terminal it had covered, and ended in a
restart. So a panel goes away on a press off it, on Escape, on a compositor
bind, on a command, and by itself after a stretch with no input.

Run through `talaris-surfaces`. Each surface is made a layer surface by itself
(layershell.py), so the process holds ordinary windows too.
"""

from __future__ import annotations

import json
import mimetypes
import os
import re
import subprocess
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
from config import load_config, pace, save_config
from dock import Dock
from launcher import Launcher
from morgan import Link, Panel, Voice
from calendar_panel import Calendar, CalendarService
from tasks_panel import Tasks
from new_panel import New
from jump_panel import Jump
from people_panel import People
from files_panel import FilesPanel
from glance_panel import Glance
from archive_panel import Archive
from webapps import WebApps
from desk import Desk
from notifications import Notifications
import docs
import thumbs
from osd import Osd
from dim import Dim
from fullscreen import Fullscreen
from pins import Pins
from tip import Tip
import desktop_api
from tray import Tray
from winfx import WindowDraw
import wallpaper
from wallpaper import current as wallpaper_current
from power import Power
from workspace import Workspace
import sensor as sensor_module
from settings import Settings
from machine import Machine
from views import AREAS, log, set_zoom, zoom
import core
from core import call
from layershell import to_compositor

HERE = os.path.dirname(os.path.abspath(__file__))
UI = os.path.join(HERE, "ui")
LAUNCHER = os.path.join(HERE, "talaris-surfaces")
SCHEME = b"talaris-ui"
# A path, not a bare name (which Qt puts in a temporary folder of its own choosing):
# the core's MCP server finds it here to ask what is on the screen (desktop_api.py).
CONTROL = os.path.join(os.environ.get("XDG_RUNTIME_DIR", f"/run/user/{os.getuid()}"), "talaris-surfaces.sock")
# Small on purpose: the handle says "something is here", not "look at me".


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


#: The project carousel (jump_panel.py), and putting every panel away.
PROJECTS_KEYS = "SUPER, TAB"
FILE_ALL_KEYS = "SUPER, ESCAPE"
#: What Super+Alt was once bound to — the project jump, its letters, the old way
#: to put everything away — unbound at start, so a crash's leftovers do not stay.
RETIRED = (*(f"SUPER ALT, {chr(c)}" for c in range(ord("A"), ord("Z") + 1)),
           "SUPER ALT, Alt_L", "SUPER ALT, Alt_R", "SUPER ALT, Super_L", "SUPER ALT, Super_R", "SUPER ALT, ESCAPE", "SUPER ALT, SPACE")

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
        # `talaris-ui://docicon/?n=<file>`: a pinned page's icon, saved by docs.py
        # when it was pinned — by its file name in that folder, never a path.
        if url.host() == "docicon":
            got = docs.saved_icon(QUrlQuery(url).queryItemValue("n"))
            if not got:
                job.fail(QWebEngineUrlRequestJob.Error.UrlNotFound)
                return
            self._reply(job, got[0], got[1])
            return
        # `talaris-ui://thumb/?project=<id>`: what the project's desktop last
        # looked like (thumbs.py), or its wallpaper if it has not been seen.
        if url.host() == "thumb":
            project = QUrlQuery(url).queryItemValue("project")
            shot = thumbs.path_for(project) if project else ""
            if shot and os.path.isfile(shot):
                with open(shot, "rb") as f:
                    self._reply(job, f.read(), "image/png")
                return
            config = getattr(self.parent(), "config", None)
            path = wallpaper.for_project(config, project)["path"] if project and config else wallpaper_current()["path"]
            if not path or not os.path.isfile(path):
                job.fail(QWebEngineUrlRequestJob.Error.UrlNotFound)
                return
            with open(path, "rb") as f:
                self._reply(job, f.read(), mimetypes.guess_type(path)[0] or "image/jpeg")
            return
        # `talaris-ui://wallpaper/`: the default wallpaper, or `?project=<id>`
        # one project's — a picture Talaris itself is set to show, never a
        # path a page names — for Settings' previews.
        if url.host() == "wallpaper":
            project = QUrlQuery(url).queryItemValue("project")
            config = getattr(self.parent(), "config", None)
            path = wallpaper.for_project(config, project)["path"] if project and config else wallpaper_current()["path"]
            if not path or not os.path.isfile(path):
                job.fail(QWebEngineUrlRequestJob.Error.UrlNotFound)
                return
            with open(path, "rb") as f:
                self._reply(job, f.read(), mimetypes.guess_type(path)[0] or "image/jpeg")
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


class Desktop(QObject):
    def __init__(self, app: QApplication) -> None:
        super().__init__(app)
        self.config = load_config()

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
        # Before the bar, which shows its icons.
        self.tray = Tray(self)
        # Morgan's stream, before the bar: the bar's button wears its state.
        self.morgan_link = Link(self)
        # A timer or reminder of Morgan's come due: on screen too, not only said.
        self.morgan_link.event.connect(self._morgan_reminder)
        # The bar first: its reserved space is what the drawers keep clear of.
        self.bar = Bar(self.config["bar"], profile, self)
        self.bar.place()
        # The dim behind every panel, the launcher and Settings: one, the same for all (dim.py).
        self.dim = Dim(profile, self)
        self.events = hypr.Events(self)
        self.dock = Dock(self.config["dock"], profile, self, self.apps)
        self.dock.place()
        self.launcher = Launcher(profile, self, self.apps)
        self.morgan = Panel(profile, self, self.morgan_link)
        # The calendar: its data in a process of its own, its panel up from the bar's clock.
        self.calendar_service = CalendarService(self)
        core.find_people = self.calendar_service.find_people
        core.find_cards = self.calendar_service.find_cards
        self.calendar = Calendar(profile, self, self.calendar_service)
        # Tasks: projects and lists, up from the bar's Tasks button.
        self.tasks = Tasks(profile, self)
        # People: everyone, grouped by organization, up from the bar's People button.
        self.people = People(profile, self)
        # Files: every project's files, and what Talaris holds for them, up from the bar's Files button.
        self.files_panel = FilesPanel(profile, self)
        # Glance: the current project, all of it, as a list or a graph (Super+Shift+G).
        self.glance = Glance(profile, self)
        # Plugins' windows: a desktop entry, a key, one window each (webapps.py).
        self.webapps = WebApps(self, LAUNCHER)
        self.archive = Archive(profile, self)
        # New: a task, an event, a person, a note or a project, from Super+Shift+N.
        self.new = New(profile, self, self.calendar_service)
        # The project carousel: Super+Tab.
        self.jump = Jump(profile, self)
        # A window focused on another project's desktop slides in as any change of project does (`_slide_toward`).
        hypr.before_focus = self._slide_toward
        # Notifications: Talaris's own, in place of mako; the bar's bell lists them.
        self.notifications = Notifications(self, profile)
        self.notifications.changed.connect(self.bar.changed)
        self.notifications.changed.connect(self.bar.notifications_changed)
        # The empty desktop, under the windows: its right-click menu (the wallpaper).
        self.desk = Desk(profile, self)
        self.desk.place()
        # Each project's likeness, for the project menus.
        self.thumbs = thumbs.Thumbs(self)
        self.thumbs.arrived()
        self.voice = Voice(profile, self, self.morgan_link)
        self.osd = Osd(profile, self)
        self.tip = Tip(self)
        self.settings = Settings(profile, self)
        self.power = Power(self)
        self.power.apply()
        # The canvas and the writing surface: panels from the bar, as the rest.
        self.workspaces = {name: Workspace(name, profile, self) for name in ("canvas", "writing")}
        self.winfx = WindowDraw(profile, self)
        self.events.reloaded.connect(self._bind)
        # Home's desktop is the ordinary workspaces: the last one of them, to go back to.
        self._ordinary = "1"
        self.events.workspace.connect(self._workspace_changed)
        # Pinned windows carried from desktop to desktop instead, so they take clicks (pins.py).
        self.pins = Pins(self)
        # A window fullscreen in front: logged, and the bar brought out over it from the edge (fullscreen.py).
        self.fullscreen = Fullscreen(self)
        # Started on a project's desktop, that project is the current one; on an ordinary one, it is the last.
        try:
            active = str(json.loads(hypr.ask("j/activeworkspace")).get("name", ""))
        except (ValueError, OSError):
            active = ""
        if hypr.is_ordinary(active):
            self._ordinary = active
        elif hypr.project_of(active, ""):
            QTimer.singleShot(0, lambda: self._workspace_changed(active))
        self._bind()

        self.control = QLocalServer(self)
        QLocalServer.removeServer(CONTROL)
        self.control.listen(CONTROL)
        self.control.newConnection.connect(self._command)
        # The current project's own wallpaper, once hyprpaper (started beside this) is up.
        QTimer.singleShot(4000, lambda: wallpaper.show(self.config, self.project.get("id", "")))

    def _home(self) -> dict:
        home = next((p for p in core.projects() if p.get("home")), None)
        return home or {"id": "", "code": "", "name": "Home"}

    def overlays(self) -> list:
        """What opens from the bar, as a panel or a window: Morgan, the calendar, the canvas, the writing surface."""
        return [p for p in (getattr(self, "morgan", None), getattr(self, "calendar", None), getattr(self, "tasks", None), getattr(self, "people", None), getattr(self, "files_panel", None), getattr(self, "glance", None), getattr(self, "archive", None), getattr(self, "new", None), getattr(self, "jump", None),
                            *getattr(self, "workspaces", {}).values()) if p]

    #: How far the dock's panel stops short of the space it reserves (dock.html:
    #: a 44px panel and a 3px margin in a 50px surface). The gap on the dock's
    #: edge is that much less, so the space you see is the same on every side.
    DOCK_SHORT = 3

    def motion(self, who: str = "") -> dict:
        """
        How the launcher, Morgan and Settings come and go: as windows do, or —
        for the launcher and Morgan, if Settings says so — as the drawers do.
        """
        if who and self.config.get("overlays", {}).get(who) == "drawers":
            theme = self.config["theme"]
            return {"motion": theme.get("motion", "slide"), "speed": theme.get("motionSpeed", "normal")}
        win = self.config["windows"]
        return {"motion": win.get("motion", "pop"), "speed": win.get("speed", "normal")}

    def window_motion(self) -> None:
        """
        How windows open, close and move, as Settings says — Hyprland's own
        animations, set at runtime like the borders, with the pages' curves
        (in quick and settling, out accelerating). Draw has no window form:
        the compositor animates a window, it cannot draw round one.
        """
        win = self.config["windows"]
        motion = win.get("motion", "pop")
        # Hyprland's speeds are tenths of a second; the pages' factors, applied.
        factor = pace(win.get("speed", "normal"))
        ds = lambda base: f"{max(.5, base * factor):.2f}"  # noqa: E731
        hypr.keyword("bezier", "talarisIn,0.2,0.8,0.2,1")
        hypr.keyword("bezier", "talarisOut,0.5,0,0.9,0.4")
        style = {"slide": "slide", "pop": "popin 87%"}.get(motion, "")
        moving = motion != "none"
        opening = motion in ("slide", "pop")
        if motion == "draw":
            # Drawn over by winfx.py: Hyprland only fades the window, in late
            # and slowly, so it fills in as the lines finish, as a drawer does.
            hypr.keyword("bezier", "talarisLate,0.75,0,0.85,0.7")
            hypr.keyword("animation", f"windows,1,{ds(4.5)},talarisIn")
            hypr.keyword("animation", "windowsIn,0")
            hypr.keyword("animation", "windowsOut,0")
            hypr.keyword("animation", f"windowsMove,1,{ds(4.5)},talarisIn")
            hypr.keyword("animation", f"fadeIn,1,{ds(9)},talarisLate")
            hypr.keyword("animation", f"fadeOut,1,{ds(7)},talarisOut")
            return
        hypr.keyword("animation", f"windows,{int(moving)},{ds(4.5)},talarisIn" + (f",{style}" if style else ""))
        hypr.keyword("animation", f"windowsIn,{int(opening)},{ds(4.5)},talarisIn" + (f",{style}" if style else ""))
        hypr.keyword("animation", f"windowsOut,{int(opening)},{ds(3)},talarisOut" + (f",{style}" if style else ""))
        hypr.keyword("animation", f"windowsMove,{int(moving)},{ds(4.5)},talarisIn")
        # Fading goes with everything but none: the whole of "fade", and under the others.
        hypr.keyword("animation", f"fadeIn,{int(moving)},{ds(2.5)},talarisIn")
        hypr.keyword("animation", f"fadeOut,{int(moving)},{ds(2)},talarisOut")

    def solid_windows(self, before: list | None = None) -> None:
        """
        Applications whose windows are always drawn solid (Settings, Windows:
        Always solid) — whatever hyprland.conf says of windows not in use. A
        sharing bar that never takes focus would otherwise stay see-through.
        Runtime rules, so hyprland.conf is untouched; one taken away cannot be
        taken back while Hyprland runs, so Hyprland reads its own file again,
        and `_bind` puts Talaris's back.
        """
        now = [c for c in self.config["windows"].get("solid", []) if isinstance(c, str) and c]
        if before is not None and set(before) - set(now):
            hypr.ask("/reload")
            return
        added = [cls for cls in now if before is None or cls not in before]
        for cls in added:
            hypr.keyword("windowrule", f"match:class ^({re.escape(cls)})$, opaque on")
        # A rule is read as a window opens: those open already are told directly.
        for w in hypr.windows()["windows"]:
            if w["class"] in added:
                hypr.ask(f"/dispatch setprop address:{w['address']} opaque 1")

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
        win = self.config["windows"]
        outline = win.get("outline", "focus")
        # The outline, as Settings says: the focused window's in the accent and
        # the rest a line, all one or the other, or none (no border at all).
        hypr.keyword("general:border_size", "0" if outline == "none" else str(int(win.get("border", 2))))
        hypr.keyword("general:col.active_border", f"rgba({line}aa)" if outline == "line" else f"rgba({accent}ee)")
        hypr.keyword("general:col.inactive_border", f"rgba({accent}ee)" if outline == "accent" else f"rgba({line}aa)")
        self.window_motion()
        gap = int(self.config["windows"]["gap"])
        sides = {"top": gap, "right": gap, "bottom": gap, "left": gap}
        # A floating bar's margin on the side away from its edge is the space
        # between it and the windows: the window gap on that side.
        bar = self.config["bar"]
        if bar.get("shape") == "floating" and not bar.get("autohide"):
            sides[self.bar.edge] = zoom(bar_margins(bar)["bottom" if self.bar.edge == "top" else "top"], "bar")
        # Only a dock that reserves its edge stops short of it.
        dock = self.config["dock"]
        if dock.get("enabled", True) and not dock.get("autohide"):
            sides[self.dock.edge] = max(0, gap - to_compositor(self.DOCK_SHORT))
        # Commas: at runtime Hyprland reads "10 10 7 10" as one number and the
        # rest is lost; written with commas it takes all four sides.
        # Between two windows Hyprland leaves its inner gap on each side, so the
        # space seen is twice the number: the setting is the space seen.
        hypr.keyword("general:gaps_in", str(round(int(self.config["windows"].get("between", 10)) / 2)))
        hypr.keyword("general:gaps_out", f"{sides['top']},{sides['right']},{sides['bottom']},{sides['left']}")
        self.gaps = sides

    def _bind(self) -> None:
        """Compositor binds, so the way back works whatever is covering the screen."""
        self.style_compositor()
        self.solid_windows()
        for name, keys in (("canvas", "SUPER SHIFT, C"), ("writing", "SUPER SHIFT, W")):
            hypr.bind(keys, f"{LAUNCHER} --toggle {name}")
        # The forms these were bound as before, gone if a crash left them.
        for keys in ("SUPER, Alt_L", "SUPER, Alt_R", "ALT, Super_L", "ALT, Super_R", *RETIRED):
            hypr.unbind(keys)
        # Super+Tab: the projects, most recent first; again while it is out, the next one.
        hypr.bind(PROJECTS_KEYS, f"{LAUNCHER} --projects")
        hypr.bind(FILE_ALL_KEYS, f"{LAUNCHER} --file-all")
        hypr.bind(self.config["launcher"]["keys"], f"{LAUNCHER} --launcher")
        hypr.bind("SUPER SHIFT, M", f"{LAUNCHER} --morgan")
        hypr.bind("SUPER SHIFT, N", f"{LAUNCHER} --new")
        hypr.bind("SUPER SHIFT, G", f"{LAUNCHER} --glance")
        # The lid, for when Talaris holds it (power.py); on the lock screen too.
        hypr.bind(", switch:on:Lid Switch", f"{LAUNCHER} --lid closed", flags="l")
        hypr.bind(", switch:off:Lid Switch", f"{LAUNCHER} --lid open", flags="l")
        self.osd.bind(LAUNCHER)
        # A reload dropped plugins' window keys too.
        if hasattr(self, "webapps"):
            self.webapps.rebind()

    def unbind(self) -> None:
        for keys in ("SUPER SHIFT, C", "SUPER SHIFT, W", PROJECTS_KEYS, FILE_ALL_KEYS, "SUPER SHIFT, M", "SUPER SHIFT, N", "SUPER SHIFT, G", ", switch:on:Lid Switch",
                     ", switch:off:Lid Switch", self.config["launcher"]["keys"]):
            hypr.unbind(keys)
        self.osd.unbind()
        self.webapps.unbind()
        self.power.stop()
        self.tray.stop()
        self.notifications.stop()
        self.calendar_service.stop()

    # ---------------------------------------------------------------- settings

    def touch_targets(self) -> None:
        """Every edge sensor, made again at the size Settings gives."""
        sensor_module.TARGET.update(self.config["touch"])
        for s in [self.bar.hider.sensor, self.dock.hider.sensor]:
            if s.up:
                s.show()

    def text_sizes(self) -> dict:
        """Each area's text size: its own if set, else the one size there was before areas."""
        every = self.config["theme"].get("fontSize", "medium")
        return {area: self.config.get("text", {}).get(area, every) for area in AREAS}

    def every_surface(self) -> list:
        """Everything that draws a page and wears the theme."""
        return [self.bar, self.bar.popup, self.dock, self.launcher, self.morgan, self.voice,
                self.osd, self.settings, self.desk, *self.overlays()]

    def reconfigure(self, before: dict, after: dict) -> None:
        """Make the screen match a new configuration, moving only what changed."""
        self.config = after
        if after.get("notifications") != before.get("notifications") or after["theme"] != before["theme"]:
            self.notifications.toasts._tell()
        if after["bar"] != before["bar"]:
            self.bar.edge = after["bar"]["edge"]
            self.bar.place()
            # The tray as Settings now has it (on, off, which icons): said again, not
            # left as it was until an icon next changes.
            if any(after["bar"].get(k) != before["bar"].get(k) for k in ("tray", "trayHidden", "trayFold")):
                self.bar._tray_changed()
        if after["dock"] != before["dock"]:
            self.dock.edge = after["dock"]["edge"]
            self.dock.place()
        changed = set_zoom(self.text_sizes())
        if "bar" in changed:
            self.bar.place()
        if "morgan" in changed and self.morgan.up:
            self.morgan.file_away()
            self.morgan.open()
        if "interface" in changed:
            # Larger or smaller text: everything with a fixed size is made again.
            self.bar.close_popup()
            self.dock.menu.close()
            if self.settings.up:
                self.settings.surface.placement = None
                self.settings.up = False
                self.settings.open()
        self.style_compositor()
        if after["windows"].get("solid", []) != before["windows"].get("solid", []):
            self.solid_windows(before["windows"].get("solid", []))
        if after["panels"] != before["panels"] or changed & {"interface", "writing", "canvas"}:
            # How the canvas and the writing surface look, and their text: told again.
            for w in self.workspaces.values():
                w.bridge.state.emit(json.dumps(w.describe()))
        if after.get("calendar") != before.get("calendar"):
            # Which calendars show: the calendar's page draws again with them.
            self.calendar.bridge.state.emit(json.dumps(self.calendar.describe()))
        if after["power"] != before["power"]:
            self.power.apply()
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
            {"keys": "Super + Shift + M", "does": "Morgan's conversation"},
            {"keys": "Super + Shift + N", "does": "New: a task, an event, a person, a note, a project"},
            {"keys": "Super + Shift + G", "does": "Glance: this project, all of it"},
            {"keys": "Super + Shift + C", "does": "The canvas"},
            {"keys": "Super + Shift + W", "does": "The writing surface"},
            {"keys": "Super + Alt", "does": "The projects, to go to one (type to find it)"},
            {"keys": "Super + Alt + a letter", "does": "The project it starts, or a choice of them"},
            {"keys": "Super + Alt + Escape", "does": "Put everything away"},
            {"keys": "Volume, mute, brightness", "does": "Change it, and show the level"},
        ]

    # ---------------------------------------------------------------- what the launcher asks

    def say_where(self, found: dict) -> None:
        """Where you are now, said: the bar's project name flashed — or, with the bar off, the OSD's note."""
        if self.config["bar"].get("enabled", True):
            self.bar.went()
        else:
            self.osd.announce(found.get("name", ""), found.get("code", ""))

    def workspace_for(self, project_id: str) -> str:
        """A project's desktop as a dispatcher names it: Home's, the ordinary one last used; any other, by its id."""
        if project_id == self._home().get("id", ""):
            return hypr.target(self._ordinary)
        return hypr.target(project_id)

    def go_to_project(self, project_id: str, move: bool = True, announce: bool = False) -> None:
        """
        The current project changes: the bar says so, the canvas and the
        writing surface open on it, the dock shows its pins, the wallpaper its
        own — and (`move`) the screen goes to its desktop.

        **A project is a desktop** (DESIGN, *Workspace*): Hyprland's workspace
        named by its id, empty the first time it is gone to. **Home is the
        ordinary ones** — the numbered workspaces (or named by you), where the windows of no
        project in particular live — and going Home is going back to the last
        of those. Going to a workspace by other means (its keys, the dock)
        makes its project current in turn (`_workspace_changed`).
        """
        found = next((p for p in core.projects() if p.get("id") == project_id), None)
        if not found:
            return
        if move:
            # Slid in from its side of the carousel's ring, as every change of project is (`_slide_toward`).
            self._slide_toward(found["id"])
            hypr.ask(f"/dispatch workspace {self.workspace_for(found['id'])}")
        # Already there (an app opened, a window focused): nothing to say — the flash is for arriving.
        if found["id"] == self.project.get("id"):
            return
        self.project = found
        self.jump.went(found["id"])
        for w in self.workspaces.values():
            w.bridge.state.emit(json.dumps(w.describe()))
        self.bar.bridge.state.emit(json.dumps(self.bar.describe()))
        # The dock: what is pinned in this project; the wallpaper: its own, or the default.
        self.dock.refresh()
        wallpaper.show(self.config, found["id"])
        self.desk.changed()
        self.thumbs.arrived()
        # Gone to by a key, with nothing on screen to say so: the bar's name of it flashes.
        if announce:
            self.say_where(found)
        log(f"project: {found['name']}")

    #: How the carousel's change of desktop goes: a slide part of the way, faded as it moves — in that way,
    #: out the same — over half a second, on a curve that changes most at once (the fade is seen as soon as
    #: it moves) and settles gently. Hyprland's tenths of a second.
    SLIDE_STYLE, SLIDE_SPEED, SLIDE_CURVE = "slidefade {side} 30%", 5, "talarisGlide,0.16,1,0.3,1"
    #: How long it may take before the workspaces' own animation is put back.
    SLIDE_BACK_MS = 900

    def _slide_toward(self, target: str) -> None:
        """
        Every change of project, by whatever way — the carousel, the bar's
        menu, the launcher, the dock, a window focused on another desktop —
        slides and fades in from the side of the carousel's ring the project
        sits on, the nearer way round: one routine. `target` is a project's
        id, or a workspace's name (a project's desktop is named by its id;
        the numbered ones are Home's). The same project, or a special
        workspace, is no change, and keeps the workspaces' own animation.
        """
        if not target or hypr.is_special(target):
            return
        ring = self.jump._ordered()
        home = next((p.get("id") for p in ring if p.get("home")), "")
        pid = hypr.project_of(target, home)
        here = self.project.get("id", "")
        ids = [p.get("id") for p in ring]
        if pid == here or pid not in ids or here not in ids:
            return
        n, d = len(ids), ids.index(pid) - ids.index(here)
        if n >= 5:
            if d > n / 2:
                d -= n
            if d < -n / 2:
                d += n
        self._slide_once("right" if d > 0 else "left")

    def _slide_once(self, side: str) -> None:
        """
        The next change of desktop slides and fades in from `side`, and out the
        same way: the workspaces' animations given the carousel's own
        (`SLIDE_*`), and put back as they were once it has played. Hyprland
        follows the side it is told, plain slide and slidefade alike (checked
        2026-10-27: told left and told right, the same two moves went opposite
        ways).
        """
        try:
            now = json.loads(hypr.ask("j/animations") or "[]")
        except ValueError:
            return
        found = [a for g in now for a in (g if isinstance(g, list) else [g])
                 if isinstance(a, dict) and a.get("name") in ("workspaces", "workspacesIn", "workspacesOut")]
        if not found:
            return
        # Kept from the first slide of a run, so a second before the first is put back does not keep the slide as "theirs".
        if not getattr(self, "_slide_kept", None):
            self._slide_kept = {a["name"]: a for a in found}
        hypr.keyword("bezier", self.SLIDE_CURVE)
        curve = self.SLIDE_CURVE.split(",", 1)[0]
        for name in self._slide_kept:
            hypr.keyword("animation", f"{name},1,{self.SLIDE_SPEED},{curve},{self.SLIDE_STYLE.format(side=side)}")
        if not hasattr(self, "_slide_back"):
            self._slide_back = QTimer(self)
            self._slide_back.setSingleShot(True)
            self._slide_back.timeout.connect(self._slide_restore)
        self._slide_back.start(self.SLIDE_BACK_MS)

    def _slide_restore(self) -> None:
        for name, a in (getattr(self, "_slide_kept", None) or {}).items():
            style = f",{a['style']}" if a.get("style") else ""
            on = 1 if a.get("enabled") else 0
            hypr.keyword("animation", f"{name},{on},{a.get('speed', 4)},{a.get('bezier', 'default')}{style}")
        self._slide_kept = None

    def _workspace_changed(self, name: str) -> None:
        """A workspace gone to: a project's (by its id), or an ordinary one — numbered, or named by you — which is Home's (hypr.project_of)."""
        if hypr.is_ordinary(name):
            # Home's desktop is the ordinary one last used: going Home goes back to it.
            self._ordinary = name
        pid = hypr.project_of(name, self._home().get("id", ""))
        if pid and pid != self.project.get("id"):
            self.go_to_project(pid, move=False, announce=True)

    def set_wallpaper(self, scope: str, path: str | None = None, fit: str | None = None, clear: bool = False) -> str:
        """
        The default wallpaper (`scope` empty) or one project's: a new picture,
        a new fit, or (`clear`) the project's own given up for the default.
        Shown at once if it is what the current project shows. Answers why
        not, or nothing.
        """
        here = self.project.get("id", "")
        now = wallpaper.for_project(self.config, scope) if scope else {**wallpaper.current(), "own": False}
        if not scope:
            path, fit = path or now["path"], fit or now["fit"]
            if not path:
                return "No picture yet"
            error = wallpaper.choose(path, fit)
            # hyprpaper starts again on the default; a project with its own is shown it again after.
            if not error and wallpaper.for_project(self.config, here)["own"]:
                QTimer.singleShot(1500, lambda: wallpaper.show(self.config, here))
            return error
        projects = self.config.setdefault("wallpaper", {}).setdefault("projects", {})
        if clear:
            projects.pop(scope, None)
        else:
            path, fit = path or (now["path"] if now["own"] else ""), fit or now["fit"]
            if not path:
                # A fit for a project still on the default: it takes the default's picture as its own.
                path = wallpaper.current()["path"]
            error = wallpaper.check(path, fit)
            if error:
                return error
            projects[scope] = {"path": os.path.expanduser(path), "fit": fit}
        save_config(self.config)
        if scope == here:
            wallpaper.show(self.config, here)
        self.desk.changed()
        return ""

    def _morgan_reminder(self, text: str) -> None:
        """
        A `reminder` event without `set` is one come due (heymorgan, `fire`):
        a desktop notification, as well as Morgan's saying it — heard or not,
        it is there when you look. Urgent, so it stays until it is seen.
        """
        try:
            e = json.loads(text)
        except ValueError:
            return
        if e.get("type") != "reminder" or e.get("set") or e.get("cancelled"):
            return
        said = str(e.get("text") or "")
        title, body = ("Reminder", said) if said and said != "Your timer is up" else ("Timer", "Your timer is up.")
        subprocess.Popen(["notify-send", "--app-name=Morgan", "--urgency=critical", "--icon=alarm-symbolic", f"Morgan — {title}", body],
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
        log(f"morgan: reminder shown: {body}")

    def open_place(self, kind: str, project: str, where: str) -> None:
        """
        A page or a canvas, opened in its project: that project the current one
        first, if it is not. One of Home's Pages (the pages of no other project)
        is the same from every project, so it opens where you are, on the
        writing drawer's Pages tab. `notes` is their old name, before Home.
        """
        if kind == "page" and project == "notes":
            project, where = self._home().get("id", ""), f"Pages/{where}"
        if kind == "page" and where.startswith("Pages/") and project == self._home().get("id", ""):
            self.show_in_drawer("writing", {"page": where, "scope": "undated"})
            return
        if project and project != self.project.get("id"):
            self.go_to_project(project)
        self.show_in_drawer("writing" if kind == "page" else "canvas", {"page": where} if kind == "page" else {"canvas": where})

    def archive_project(self, project_id: str) -> str:
        """A project archived (archive.ts): out of every list, its folder in the archive. Gone from, if it is the current one."""
        if not project_id:
            return "No project"
        status, text = call("POST", f"/projects/{project_id}/archive")
        if status != 200:
            try:
                return json.loads(text).get("error", "It could not be archived")
            except ValueError:
                return "It could not be archived"
        if self.project.get("id") == project_id:
            self.go_to_project(self._home().get("id", ""), announce=True)
        self.bar.changed()
        return ""

    def _ask_page(self, panel, ask: str) -> None:
        """A panel out (or its window forward) and its page asked something — again a moment on,
        as the page may still be loading the first time."""
        panel.open()
        view = panel.window if getattr(panel, "windowed", False) and getattr(panel, "window", None) else panel.view
        view.page().runJavaScript(ask)
        QTimer.singleShot(900, lambda: view.page().runJavaScript(ask))

    def show_task(self, entity: str) -> None:
        """A task, open in Tasks' editor."""
        self._ask_page(self.tasks, f"window.Tasks && Tasks.openTask({json.dumps(entity)})")

    def show_event(self, calendar: str, uid: str, start: str) -> None:
        """An event, open in the calendar: its day, and its editor."""
        self._ask_page(self.calendar, f"window.Calendar && Calendar.show({json.dumps({'calendar': calendar, 'uid': uid, 'start': start})})")

    def show_in_drawer(self, name: str, target: dict) -> None:
        """The canvas or the writing surface, open on one canvas or one page."""
        w = self.workspaces.get(name)
        if w:
            w.show_target(target)

    #: What the launcher's verbs do. The power ones were asked twice in the page.
    def verb(self, name: str) -> str:
        if name in self.workspaces:
            self.workspaces[name].toggle()
        elif name == "file-all":
            # Every panel out, put away (windows stay: they are put away as windows are).
            for thing in (self.launcher, self.settings, *self.overlays()):
                thing.file_away()
        elif name in ("lock", "suspend", "logout", "restart", "shutdown"):
            self.machine.power(name)
        elif name in ("network", "bluetooth"):
            self.bar.toggle_popup(name)
        elif name == "settings":
            self.settings.open()
        elif name == "glance":
            self.glance.open()
        elif name == "archive":
            self.archive.show("")
        else:
            return "No such thing to do"
        return ""

    def _command(self) -> None:
        conn = self.control.nextPendingConnection()

        def read() -> None:
            line = bytes(conn.readAll()).decode("utf-8", "replace").strip()
            # A JSON line is the MCP's (desktop_api.py), answered with one.
            if line.startswith("{"):
                try:
                    req = json.loads(line)
                    reply = desktop_api.answer(self, req) if isinstance(req, dict) else {"ok": False, "error": "a request is an object"}
                except ValueError:
                    reply = {"ok": False, "error": "not JSON"}
                conn.write((json.dumps(reply) + "\n").encode())
                conn.flush()
                conn.disconnectFromServer()
                return
            verb, _, arg = line.partition(" ")
            if verb == "toggle" and arg in self.workspaces:
                self.workspaces[arg].toggle()
            elif verb == "file-all":
                self.bar.close_popup()
                self.launcher.file_away()
                self.settings.file_away()
                for panel in self.overlays():
                    panel.file_away()
                self.voice.file_away()
                self.settings.file_away()
            elif verb == "grow" and arg in self.workspaces:
                self.workspaces[arg].grow()
            elif verb == "settings":
                self.settings.open(arg)
            elif verb == "osd":
                self.osd.show(arg)
            elif verb == "morgan":
                self.morgan.toggle()
            elif verb == "calendar":
                self.calendar.toggle()
            elif verb == "tasks":
                self.tasks.toggle()
            elif verb == "people":
                self.people.toggle()
            elif verb == "files":
                self.files_panel.toggle()
            elif verb == "glance":
                self.glance.toggle()
            elif verb == "app":
                self.webapps.open(arg)
            elif verb == "archive":
                self.archive.toggle()
            elif verb == "new":
                self.new.toggle()
            elif verb == "projects":
                self.jump.carousel()
            elif verb == "window":
                # A panel as a window, or a window back to a panel: `--window calendar`.
                panel = {p.NAME: p for p in self.overlays()}.get(arg)
                if panel:
                    panel.grow()
            elif verb == "lid":
                self.power.lid(arg)
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
    if args[:1] == ["--calendar"]:
        return send("calendar")
    if args[:1] == ["--tasks"]:
        return send("tasks")
    if args[:1] == ["--people"]:
        return send("people")
    if args[:1] == ["--files"]:
        return send("files")
    if args[:1] == ["--glance"]:
        return send("glance")
    if args[:1] == ["--app"] and len(args) == 2:
        return send(f"app {args[1]}")
    if args[:1] == ["--archive"]:
        return send("archive")
    if args[:1] == ["--new"]:
        return send("new")
    if args[:1] == ["--projects"]:
        return send("projects")
    if args[:1] == ["--window"] and len(args) == 2:
        return send(f"window {args[1]}")
    if args[:1] == ["--lid"] and len(args) == 2:
        return send(f"lid {args[1]}")
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
    # The name Hyprland and the dock know Talaris's ordinary windows by (a
    # panel made a window), rather than python3.
    app.setDesktopFileName("talaris")
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
    log("up")
    return app.exec()


if __name__ == "__main__":
    sys.exit(main())
