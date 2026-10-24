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
import shutil
import re
import threading

import shiboken6
from PySide6.QtCore import QObject, QProcess, QTimer, Signal, Slot
from PySide6.QtWebEngineCore import QWebEngineProfile

import hypr
import accounts
import power
import wallpaper
from power import LID_ACTIONS
from config import DEFAULTS, save_config, settle_accent, settle_opacity
from core import Bridge, call as core_call
from layershell import KEYBOARD_ON_DEMAND, OVERLAY, LayerSurface, Placement
from morgan import command
from sensor import Catcher
from views import log, make_view, zoom

SIZE = (860, 620)
IDLE_MS = 3 * 60 * 1000
#: How long the page has to finish leaving before the surface goes anyway.
LEAVE_LIMIT_MS = 1600

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
    if not all(re.fullmatch(r"#[0-9a-fA-F]{6}", str(t.get(k, ""))) for k in ("accent", "accentDark", "accentLight")):
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
    p, b, d = c["panels"], c["bar"], c["dock"]
    speeds = ("slow", "normal", "fast", "fastest")
    if t.get("fontSize", "medium") not in ("small", "medium", "large") or any(v not in ("small", "medium", "large") for v in c.get("text", {}).values()):
        return "Text is small, medium or large"
    BAR_ITEMS = ("ask", "new", "morgan", "people", "tasks", "canvas", "writing", "where", "day", "time", "theme", "net", "bt", "vol", "bat", "bat-n", "power")
    if not all(x in BAR_ITEMS for x in c["bar"].get("hidden", [])):
        return "Not something the bar shows"
    if not 0 <= int(c["bar"].get("spacing", 4)) <= 24:
        return "Spacing on the bar is 0 to 24"
    if c["bar"].get("project", "both") not in ("name", "code", "both"):
        return "The bar shows the project's name, its code, or both"
    if not isinstance(c["bar"].get("trayFold", False), bool) or not isinstance(c["bar"].get("tray", True), bool) or not all(isinstance(x, str) for x in c["bar"].get("trayHidden", [])):
        return "Not a tray setting"
    if not all(isinstance(x, str) for x in c.get("calendar", {}).get("hidden", [])):
        return "Not a calendar"
    if any(c.get("overlays", {}).get(k, "windows") not in ("windows", "drawers") for k in ("launcher", "new", "jump", "morgan", "settings", "calendar", "tasks", "canvas", "writing")):
        return "What opens from the bar moves as windows or as panels"
    backups = c.get("data", {})
    if backups.get("schedule", "off") not in ("off", "daily", "weekly") or not 1 <= int(backups.get("keep", 7)) <= 60 \
            or not isinstance(backups.get("backupFolder", ""), str):
        return "Backups are off, daily or weekly, keeping one to sixty"
    if not 16 <= int(c["dock"].get("iconSize", 24)) <= 48:
        return "The dock's icons are 16 to 48 pixels"
    if t.get("motionSpeed", "normal") not in speeds or any(x.get("speed", "normal") not in speeds for x in (b, d)):
        return "Speed is slow, normal, fast or very fast"
    if p.get("outline") not in ("focus", "line", "none") or not isinstance(p.get("shadow"), bool) or not isinstance(p.get("paperFollows", True), bool):
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
    if not isinstance(pw.get("managed"), bool) or not 1 <= int(pw.get("dimTo", 20)) <= 100 \
            or any(not 0 <= int(pw.get(s, {}).get(k, 0)) <= 7200 for s in ("ac", "battery") for k in ("dim", "lock", "screenOff", "suspend")):
        return "Not a power setting"
    if any(v not in LID_ACTIONS for v in pw.get("lid", {}).values()):
        return "The lid suspends, locks, turns the screen off or does nothing"
    if not (2 <= int(c["touch"]["thick"]) <= 30 and 10 <= int(c["touch"]["length"]) <= 100):
        return "A touch target is 2 to 30 thick and 10 to 100 percent of its edge"
    if not 0 <= int(c["windows"]["gap"]) <= 40:
        return "The space round windows is 0 to 40 pixels"
    if not 0 <= int(c["windows"].get("between", 10)) <= 40:
        return "The space between windows is 0 to 40 pixels"
    if c["windows"].get("outline", "focus") not in ("focus", "accent", "line", "none") or not 1 <= int(c["windows"].get("border", 2)) <= 6:
        return "A window's outline is the accent, a line or none, 1 to 6 pixels wide"
    if c["windows"].get("motion", "pop") not in ("slide", "pop", "fade", "draw", "none") or c["windows"].get("speed", "normal") not in speeds:
        return "Windows slide, pop, fade or neither"
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
    #: Pushed to the page: Wi-Fi's or Bluetooth's state after a read or a change, `{kind, state, error}`.
    panel = Signal(str)

    @Slot(str, bool)
    def panelRead(self, kind: str, deep: bool) -> None:  # noqa: N802 — called from the page by this name
        self.owner.desktop.machine.panel_read(kind, deep)

    @Slot(str)
    def openTool(self, name: str) -> None:  # noqa: N802 — called from the page by this name
        """A network that needs more than a password: nmtui, in a terminal."""
        self.owner.desktop.machine.open_tool(name)

    @Slot(str)
    def network(self, request: str) -> None:
        self.owner.desktop.machine.network(json.loads(request))

    @Slot(str)
    def bluetooth(self, request: str) -> None:
        self.owner.desktop.machine.bluetooth(json.loads(request))

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

    #: Pushed to the page: the accounts changed (one was added in its window, say).
    accountsChanged = Signal()

    @Slot(result=str)
    def accounts(self) -> str:
        return json.dumps(accounts.listing())

    @Slot(str, str)
    def calendarColor(self, calendar: str, color: str) -> None:  # noqa: N802 — called from the page by this name
        self.owner.desktop.calendar_service.send({"do": "color", "req": 0, "calendar": calendar, "color": color})

    @Slot(result=str)
    def calendars(self) -> str:
        """The calendars Evolution has, each with its account's name: for showing or hiding, by account."""
        return self.owner.desktop.calendar_service.last_calendars

    @Slot(str, str, bool, result=str)
    def accountSwitch(self, path: str, what: str, on: bool) -> str:  # noqa: N802 — called from the page by this name
        return accounts.switch(path, what, on)

    @Slot(str, result=str)
    def accountRemove(self, path: str) -> str:  # noqa: N802 — called from the page by this name
        return accounts.remove(path)

    @Slot(str, result=str)
    def accountSignIn(self, path: str) -> str:  # noqa: N802 — called from the page by this name
        return accounts.sign_in_again(path)

    @Slot()
    def accountAdd(self) -> None:  # noqa: N802 — called from the page by this name
        self.owner.add_account()

    @Slot(result=str)
    def trayItems(self) -> str:  # noqa: N802 — called from the page by this name
        """Every tray item there is now, shown on the bar or not."""
        return self.owner.desktop.tray.last

    @Slot(result=str)
    def charging(self) -> str:
        return json.dumps(power.charging())

    @Slot(str, result=str)
    def setCharging(self, wanted: str) -> str:  # noqa: N802 — called from the page by this name
        w = json.loads(wanted)
        return power.set_charging(str(w.get("mode", "")), w.get("start"), w.get("stop"))

    @Slot(result=str)
    def power(self) -> str:
        return json.dumps(self.owner.desktop.power.status())

    # ------------------------------------------------------------ data

    #: The core's answer to `core`: {id, status, data}.
    coreReply = Signal(str)
    #: A folder or a backup file chosen: {kind, path}.
    picked = Signal(str)

    @Slot(str, str, str, str)
    def core(self, ident: str, method: str, path: str, body: str) -> None:
        """
        The entity store's routes, for the Data page. Answered later
        (`coreReply`): a backup or a revival takes seconds, and the page must
        not freeze meanwhile. Only the store's own routes: this is not a door
        to the rest of the core.
        """
        if not re.match(r"^/(vault|backups|entities|projects)(/|$|\?)", path):
            self.coreReply.emit(json.dumps({"id": ident, "status": 400, "data": {"error": "not a route the Data page uses"}}))
            return

        def run() -> None:
            # A revival or a backup of a large store takes a while.
            status, text = core_call(method, path, body or None, timeout=600 if path.startswith("/backups") else 30)
            try:
                data = json.loads(text) if text else None
            except ValueError:
                data = {"error": text}
            self.coreReply.emit(json.dumps({"id": ident, "status": status, "data": data}))
        threading.Thread(target=run, daemon=True).start()

    @Slot(str)
    def choose(self, kind: str) -> None:
        """A folder for backups, or a backup to revive, in the desktop's own chooser."""
        self.owner.choose_path(kind)

    @Slot(str)
    def copyText(self, text: str) -> None:  # noqa: N802 — called from the page by this name
        """Onto the clipboard (the recovery key, to put in a password manager)."""
        try:
            import subprocess
            subprocess.run(["wl-copy"], input=text.encode(), timeout=3, check=False)
        except (OSError, subprocess.SubprocessError):
            pass

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
        # A clear layer behind it, over the windows: a click off Settings closes it.
        self.catcher = Catcher(profile, self.file_away, self, name="settings-catcher")
        # Wi-Fi and Bluetooth: the same readings and changes as the bar's panels.
        desktop.machine.panel.connect(self.bridge.panel.emit)
        self.idle = QTimer(self)
        self.idle.setSingleShot(True)
        self.idle.timeout.connect(self.file_away)

    def describe(self) -> dict:
        # Its size in its page's pixels, for arriving to wait for.
        return {"up": self.up, "page": self.page, "theme": self.desktop.config["theme"], "motion": self.desktop.motion("settings"),
                "viewport": [round(zoom(SIZE[0]) / (self.view.zoomFactor() or 1)), round(zoom(SIZE[1]) / (self.view.zoomFactor() or 1))]}

    def open(self, page: str = "") -> None:
        self.page = page
        self.leaving = False
        if not self.up:
            # No anchors: the compositor puts it in the middle of the screen.
            self.surface.apply(Placement(OVERLAY, 0, zoom(SIZE[0]), zoom(SIZE[1]), KEYBOARD_ON_DEMAND))
            self.up = True
            if not getattr(self, "_chooser", None):
                self.catcher.show(dim=True)
            log("settings: open")
        self.bridge.state.emit(json.dumps(self.describe()))
        self.page = ""
        self.touched()
        self.desktop.bar.changed()

    def toggle(self) -> None:
        if self.up:
            self.file_away()
        else:
            self.open()

    def _step_aside(self) -> None:
        """
        Another program's window is coming — GNOME's sign-in for an account, a
        file chooser. Ordinary windows open under Settings' layer, in the middle
        of the screen where Settings is, and could not be reached: Settings goes
        while it is open (its page as it was), and comes back when it closes.
        """
        self.idle.stop()
        self.catcher.hide()
        if self.up:
            self._aside = True
            self.view.hide()
            self.surface.placement = None

    def _come_back(self) -> None:
        if not getattr(self, "_aside", False):
            return
        self._aside = False
        if not self.up:
            return
        self.surface.apply(Placement(OVERLAY, 0, zoom(SIZE[0]), zoom(SIZE[1]), KEYBOARD_ON_DEMAND))
        self.catcher.show(dim=True)
        self.touched()

    def file_away(self) -> None:
        if not self.up:
            return
        self.up = False
        self.idle.stop()
        self.catcher.hide()
        self.desktop.bar.changed()
        # The page plays its leaving, then says so (`left`); then the surface goes.
        self.leaving = True
        self.bridge.leave.emit()
        QTimer.singleShot(LEAVE_LIMIT_MS, self.left)

    def left(self) -> None:
        if not getattr(self, "leaving", False):
            return
        self.leaving = False
        self.view.hide()
        self.surface.placement = None
        self.bridge.state.emit(json.dumps(self.describe()))

    def touched(self) -> None:
        if self.up:
            self.idle.start(IDLE_MS)

    def add_account(self) -> None:
        """GNOME Online Accounts' own window, beside Settings: the provider's sign-in, then the account is here."""
        if getattr(self, "_adder", None) or not shutil.which(accounts.ADDER):
            return
        adder = QProcess(self)
        adder.setProgram(accounts.ADDER)

        def done(_code: int, _status) -> None:
            # Ended as Talaris itself shuts down: Settings may be gone already.
            if not shiboken6.isValid(self) or not shiboken6.isValid(adder):
                return
            self._adder = None
            adder.deleteLater()
            self._come_back()
            self.bridge.accountsChanged.emit()

        adder.finished.connect(done)
        self._adder = adder
        self._step_aside()
        adder.start()

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
            self._come_back()
            path = bytes(chooser.readAllStandardOutput()).decode().strip() if code == 0 else ""
            chooser.deleteLater()
            if path:
                error = wallpaper.choose(path, wallpaper.current()["fit"])
                self.bridge.wallpaperChanged.emit(json.dumps({**wallpaper.current(), "error": error}))

        chooser.finished.connect(done)
        self._chooser = chooser
        self._step_aside()
        chooser.start()

    def choose_path(self, kind: str) -> None:
        if getattr(self, "_chooser", None):
            return
        chooser = QProcess(self)
        chooser.setProgram("zenity")
        if kind == "folder":
            chooser.setArguments(["--file-selection", "--directory", "--title=A folder for backups"])
        else:
            start = self.desktop.config.get("data", {}).get("backupFolder") or os.path.expanduser("~/.local/share/talaris/backups")
            chooser.setArguments(["--file-selection", "--title=A backup to revive", f"--filename={os.path.expanduser(start)}/",
                                  "--file-filter=Talaris backups | *.talaris-backup"])

        def done(code: int, _status) -> None:
            self._chooser = None
            self._come_back()
            path = bytes(chooser.readAllStandardOutput()).decode().strip() if code == 0 else ""
            chooser.deleteLater()
            if path:
                self.bridge.picked.emit(json.dumps({"kind": kind, "path": path}))

        chooser.finished.connect(done)
        self._chooser = chooser
        self._step_aside()
        chooser.start()

    def apply(self, wanted: dict) -> str:
        """Take a whole configuration, check it, keep it, and make the screen match it."""
        before = self.desktop.config
        after = copy.deepcopy(before)
        for key in ("theme", "bar", "dock", "launcher", "overlays", "calendar", "windows", "clock", "panels", "touch", "text", "power", "data"):
            after.setdefault(key, copy.deepcopy(DEFAULTS.get(key, {})))
            after[key].update(wanted.get(key, {}))
        if "idleSeconds" in wanted:
            after["idleSeconds"] = int(wanted["idleSeconds"])
        # An accent picked is the mode in force's; a mode changed brings its own.
        settle_accent(after["theme"], wanted.get("theme", {}).get("accent"))
        settle_opacity(after)
        error = _checked(after)
        if error:
            return error
        save_config(after)
        self.desktop.reconfigure(before, after)
        return ""
