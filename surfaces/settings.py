# SPDX-License-Identifier: GPL-3.0-only
# Copyright (c) 2026 Jeff Moore
"""
Settings: one place for the whole shell — not a Talaris panel beside a Morgan
panel. Appearance, where things go, the keys, and Morgan.

**A change applies the moment it is made.** The theme reaches every surface
at once; an edge or a size re-places the surfaces it moves; the launcher's key
is bound again. There is no Apply button, because there is nothing a change
waits for — except Morgan's, which can restart Morgan, and so are saved
together with a button that says so.

**Morgan's settings are Morgan's.** This page reads and writes them through
Morgan's own admin calls (`config.get`, `config.set`, `voice.list`,
`voice.preview` — its `docs/protocol.md`, §4) and keeps no copy.

A panel in the middle of the screen on the `overlay` layer, taking the
keyboard when a field is pressed. Its ways back: Escape, Done, `--file-all`,
and an idle of a few minutes.
"""

from __future__ import annotations

import copy
import json
import os
import re

from PySide6.QtCore import QObject, QProcess, QTimer, Signal, Slot
from PySide6.QtWebEngineCore import QWebEngineProfile

import hypr
import wallpaper
from config import DEFAULTS, save_config
from core import Bridge
from layershell import KEYBOARD_ON_DEMAND, OVERLAY, LayerSurface, Placement
from morgan import command
from views import log, make_view, zoom

SIZE = (860, 620)
IDLE_MS = 3 * 60 * 1000

FONTS = ["Barlow Semi Condensed", "Rajdhani", "Saira Semi Condensed", "Exo 2"]
EDGES = ("top", "bottom", "left", "right")
LAUNCHER_KEYS = ("SUPER ALT, SPACE", "SUPER, SPACE")
DATE_STYLES = ("weekday-month-day", "weekday-day-month", "month-day", "day-month", "iso", "off")

#: The Morgan calls this page may make, and nothing else.
MORGAN_OPS = {"config.get", "config.set", "voice.list", "voice.preview"}


def _checked(c: dict) -> str:
    """Why a configuration cannot be, or empty when it can."""
    t = c["theme"]
    if t.get("mode") not in ("dark", "light"):
        return "Mode is dark or light"
    if not re.fullmatch(r"#[0-9a-fA-F]{6}", str(t.get("accent", ""))):
        return "An accent is a color like #c98a5b"
    if t.get("font") not in FONTS:
        return "Not one of the typefaces"
    if t.get("motion") not in ("slide", "chaos", "none"):
        return "Motion is slide, draw or none"
    k = c["clock"]
    if k.get("hours") not in ("12", "24") or k.get("date") not in DATE_STYLES or not isinstance(k.get("seconds"), bool):
        return "Not a clock setting"
    if c["bar"]["edge"] not in ("top", "bottom") or c["dock"]["edge"] not in ("top", "bottom"):
        return "The bar and the dock go on the top or the bottom"
    if c["bar"]["edge"] == c["dock"]["edge"]:
        return "The bar and the dock need an edge each"
    edges = [d["edge"] for d in c["drawers"].values()]
    if any(e not in ("left", "right") for e in edges):
        return "A drawer is on the left or the right"
    if len(set(edges)) != len(edges):
        return "Each drawer needs an edge of its own, for now"
    if any(e == c["bar"]["edge"] or (c["dock"].get("enabled", True) and e == c["dock"]["edge"]) for e in edges):
        return "A drawer cannot share the bar's or the dock's edge"
    if any(not 0.25 <= float(d["size"]) <= 0.9 for d in c["drawers"].values()):
        return "A drawer is a quarter to nine tenths of the screen"
    p, b, d = c["panels"], c["bar"], c["dock"]
    speeds = ("slow", "normal", "fast", "fastest")
    if t.get("fontSize", "medium") not in ("small", "medium", "large") or any(v not in ("small", "medium", "large") for v in c.get("text", {}).values()):
        return "Text is small, medium or large"
    if t.get("motionSpeed", "normal") not in speeds or any(x.get("speed", "normal") not in speeds for x in (b, d)):
        return "Speed is slow, normal, fast or very fast"
    if p.get("outline") not in ("focus", "line", "none") or not isinstance(p.get("shadow"), bool) or not isinstance(p.get("dismissOutside", False), bool) or p.get("afterExpand", "open") not in ("open", "closed") or not isinstance(p.get("paperFollows", True), bool):
        return "Not a drawer outline or shadow"
    if not all(30 <= int(x.get("opacity", 100)) <= 100 for x in (p, b, d)):
        return "Opacity is 30 to 100 percent"
    if not isinstance(d.get("enabled", True), bool):
        return "The dock is on or off"
    if not 100 <= int(d.get("magnify", 100)) <= 200:
        return "Magnifying is 100 to 200 percent"
    if d.get("scope") not in ("desktop", "all"):
        return "The dock shows this project's windows or all of them"
    for x in (b, d):
        if x.get("outline") not in ("accent", "line", "none") or not isinstance(x.get("shadow"), bool) or x.get("motion") not in ("slide", "none"):
            return "Not a bar or dock outline, shadow or motion"
    if b.get("shape") not in ("strip", "floating") or not all(0 <= int(v) <= 40 for v in (b.get("margins") or {}).values()):
        return "The bar is a strip or floating, its margins up to 40 pixels"
    pw = c["power"]
    if not isinstance(pw.get("managed"), bool) or any(not 0 <= int(pw.get(k, 0)) <= 7200 for k in ("dim", "lock", "screenOff", "suspend")) \
            or not 1 <= int(pw.get("dimTo", 20)) <= 100:
        return "Not a power setting"
    if not (2 <= int(c["touch"]["thick"]) <= 30 and 10 <= int(c["touch"]["length"]) <= 100):
        return "A touch target is 2 to 30 thick and 10 to 100 percent of its edge"
    if not 0 <= int(c["windows"]["gap"]) <= 40:
        return "The space round windows is 0 to 40 pixels"
    if not 0 <= int(c["windows"].get("between", 10)) <= 40:
        return "The space between windows is 0 to 40 pixels"
    if not 15 <= int(c["idleSeconds"]) <= 600:
        return "Idle is between 15 seconds and 10 minutes"
    if c["launcher"]["keys"] not in LAUNCHER_KEYS:
        return "Not one of the launcher's keys"
    return ""


class SettingsBridge(Bridge):
    @Slot(result=str)
    def config(self) -> str:
        return json.dumps({"config": self.owner.desktop.config, "fonts": FONTS,
                           "launcherKeys": list(LAUNCHER_KEYS), "defaults": DEFAULTS})

    @Slot(str, result=str)
    def save(self, text: str) -> str:
        try:
            return self.owner.apply(json.loads(text))
        except Exception as e:  # noqa: BLE001 — said on the page, not lost: a save that fails silently looks like a dead control
            log(f"settings: save failed: {e!r}")
            return f"That cannot be saved ({e})"

    @Slot(str, result=str)
    def morgan(self, request: str) -> str:
        try:
            r = json.loads(request)
        except ValueError:
            return json.dumps({"ok": False, "error": "Not a request"})
        if r.get("op") not in MORGAN_OPS:
            return json.dumps({"ok": False, "error": "Not a setting this page changes"})
        return command("admin " + json.dumps({"op": r["op"], "args": r.get("args", {})}))

    #: Pushed to the page: the wallpaper changed — `{path, fit, error}`.
    wallpaperChanged = Signal(str)

    @Slot(result=str)
    def wallpaper(self) -> str:
        return json.dumps(wallpaper.current())

    @Slot()
    def chooseWallpaper(self) -> None:  # noqa: N802 — called from the page by this name
        self.owner.choose_wallpaper()

    @Slot(str)
    def fitWallpaper(self, fit: str) -> None:  # noqa: N802 — called from the page by this name
        now = wallpaper.current()
        error = wallpaper.choose(now["path"], fit) if now["path"] else "No picture yet"
        self.wallpaperChanged.emit(json.dumps({**wallpaper.current(), "error": error}))

    @Slot(result=str)
    def power(self) -> str:
        return json.dumps(self.owner.desktop.power.status())

    @Slot(result=str)
    def keys(self) -> str:
        return json.dumps(self.owner.desktop.key_list())


class Settings(QObject):
    def __init__(self, profile: QWebEngineProfile, desktop) -> None:
        super().__init__(desktop)
        self.desktop = desktop
        self.up = False
        # A page asked for — Morgan's settings button asks for its own — sent
        # once with the next state, then forgotten, so a later state (the
        # theme changing) does not pull the page back to it.
        self.page = ""
        self.bridge = SettingsBridge(self, self)
        self.view = make_view(profile, "settings", "talaris-ui://ui/settings.html", self.bridge, self)
        self.surface = LayerSurface(self.view, "talaris-settings")
        self.idle = QTimer(self)
        self.idle.setSingleShot(True)
        self.idle.timeout.connect(self.file_away)

    def describe(self) -> dict:
        return {"up": self.up, "page": self.page, "theme": self.desktop.config["theme"]}

    def open(self, page: str = "") -> None:
        self.page = page
        if not self.up:
            # No anchors: the compositor puts it in the middle of the screen.
            self.surface.apply(Placement(OVERLAY, 0, zoom(SIZE[0]), zoom(SIZE[1]), KEYBOARD_ON_DEMAND))
            self.up = True
            log("settings: open")
        self.bridge.state.emit(json.dumps(self.describe()))
        self.page = ""
        self.touched()

    def toggle(self) -> None:
        if self.up:
            self.file_away()
        else:
            self.open()

    def file_away(self) -> None:
        if not self.up:
            return
        self.up = False
        self.idle.stop()
        self.view.hide()
        self.surface.placement = None
        self.bridge.state.emit(json.dumps(self.describe()))

    def left(self) -> None:
        pass

    def touched(self) -> None:
        if self.up:
            self.idle.start(IDLE_MS)

    def choose_wallpaper(self) -> None:
        """A picture, chosen in the desktop's own chooser beside the surface, not inside it."""
        if getattr(self, "_chooser", None):
            return
        chooser = QProcess(self)
        chooser.setProgram("zenity")
        start = os.path.dirname(wallpaper.current()["path"]) or os.path.expanduser("~/Pictures")
        chooser.setArguments(["--file-selection", "--title=A wallpaper", f"--filename={start}/",
                              "--file-filter=Pictures | *.jpg *.jpeg *.png *.webp *.JPG *.JPEG *.PNG"])

        def done(code: int, _status) -> None:
            self._chooser = None
            path = bytes(chooser.readAllStandardOutput()).decode().strip() if code == 0 else ""
            chooser.deleteLater()
            if path:
                error = wallpaper.choose(path, wallpaper.current()["fit"])
                self.bridge.wallpaperChanged.emit(json.dumps({**wallpaper.current(), "error": error}))

        chooser.finished.connect(done)
        self._chooser = chooser
        chooser.start()

    def apply(self, wanted: dict) -> str:
        """Take a whole configuration, check it, keep it, and make the screen match it."""
        before = self.desktop.config
        after = copy.deepcopy(before)
        for key in ("theme", "bar", "dock", "launcher", "windows", "clock", "panels", "touch", "text", "power"):
            after[key].update(wanted.get(key, {}))
        for name, d in wanted.get("drawers", {}).items():
            if name in after["drawers"]:
                after["drawers"][name].update(d)
        if "idleSeconds" in wanted:
            after["idleSeconds"] = int(wanted["idleSeconds"])
        error = _checked(after)
        if error:
            return error
        save_config(after)
        self.desktop.reconfigure(before, after)
        return ""
