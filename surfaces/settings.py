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
import subprocess
import base64
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
from core import Bridge, call as core_call, route_ok

#: What Settings may ask the core for.
SETTINGS_ROUTES = re.compile(r"^/(vault|backups|entities|entity-types|projects|plugins|tasks/statuses|meaning)(/|$|\?)")
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
LAUNCHER_KEYS = ("SUPER, SPACE",)
DATE_STYLES = ("weekday-month-day", "weekday-day-month", "month-day", "day-month", "iso", "off")

#: The Morgan calls this page may make, and nothing else.
#: What the Morgan page may ask of Morgan (heymorgan's `admin`; docs/protocol.md): on a client,
#: Morgan answers the voice and "where it lives" ones itself and hands the rest to its server.
MORGAN_OPS = {
    "config.get", "config.set", "client.get", "client.set", "log.recent",
    "voice.list", "voice.preview", "voices.status", "voices.enroll", "voices.forget",
    "ollama.models", "oracle.account",
    "memory.list", "memory.note.add", "memory.note.set", "memory.note.delete", "memory.note.move",
    "memory.topic.add", "memory.topic.rename", "memory.topic.delete",
    "memory.document.get", "memory.document.delete", "memory.picture.view", "memory.picture.delete",
    "memory.garden.report", "memory.garden.run", "memory.garden.undo",
    "reminders.list", "reminders.cancel",
    "mcp.list", "mcp.add", "mcp.remove", "mcp.allow", "mcp.tool", "mcp.reconnect",
    # This machine's own servers (client.json), answered by the Morgan here whatever its role.
    "client.mcp.list", "client.mcp.add", "client.mcp.remove", "client.mcp.allow", "client.mcp.tool",
}
#: Ops that may take Morgan a long while (tidying its memory, a server's restart): waited for longer.
MORGAN_SLOW = {"memory.garden.run", "client.set", "config.set", "ollama.models", "mcp.add", "mcp.reconnect", "client.mcp.add", "client.mcp.remove"}


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
    if c["dock"].get("groups", "one") not in ("one", "pills"):
        return "One dock, or pills"
    if c["bar"]["edge"] == c["dock"]["edge"]:
        return "The bar and the dock need an edge each"
    p, b, d = c["panels"], c["bar"], c["dock"]
    speeds = ("slow", "normal", "fast", "fastest")
    if t.get("fontSize", "medium") not in ("small", "medium", "large") or any(v not in ("small", "medium", "large") for v in c.get("text", {}).values()):
        return "Text is small, medium or large"
    BAR_ITEMS = ("ask", "new", "morgan", "people", "files", "tasks", "canvas", "writing", "where", "day", "time", "theme", "net", "bt", "vol", "bat", "bat-n", "bell", "power")
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
    if any(c.get("overlays", {}).get(k, "windows") not in ("windows", "drawers") for k in ("launcher", "new", "jump", "people", "files", "glance", "archive", "morgan", "settings", "calendar", "tasks", "canvas", "writing")):
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
    if not all(isinstance(x, str) and re.fullmatch(r"[A-Za-z0-9._ -]{1,120}", x) for x in c["windows"].get("solid", [])):
        return "Not an application's window class"
    if c["windows"].get("motion", "pop") not in ("slide", "pop", "fade", "draw", "none") or c["windows"].get("speed", "normal") not in speeds:
        return "Windows slide, pop, fade or neither"
    if not 15 <= int(c["idleSeconds"]) <= 600:
        return "Idle is between 15 seconds and 10 minutes"
    n = c.get("notifications", {})
    if n.get("animation", "slide") not in ("slide", "pop", "fade", "draw") or n.get("outline", "line") not in ("line", "accent", "none"):
        return "Not a notification look"
    if not 2 <= int(n.get("seconds", 6)) <= 60 or not 20 <= int(n.get("opacity", 100)) <= 100:
        return "Notifications stay 2 to 60 seconds, and are 20% to 100% solid"
    if c["launcher"]["keys"] not in LAUNCHER_KEYS:
        return "Not one of the launcher's keys"
    if c["launcher"].get("singleWindow", "bring") not in ("bring", "go"):
        return "Bring it here, or go to it"
    meaning = c.get("meaning", {})
    if not isinstance(meaning.get("on", False), bool) or not isinstance(meaning.get("model", ""), str) \
            or not re.fullmatch(r"(https?://[^\s]{1,200})?", meaning.get("url", "") or ""):
        return "Search by meaning needs an http(s) address and a model's name"
    if meaning.get("scan", "change") not in ("change", "idle", "schedule", "manual") or not re.fullmatch(r"\d{2}:\d{2}", meaning.get("at", "03:00") or ""):
        return "Files are read as they change, while idle, once a day at a time, or only when asked"
    if not isinstance(meaning.get("describe", True), bool):
        return "Describing pictures is on or off"
    shown = c.get("shown", {})
    if not isinstance(shown.get("done", False), bool) or not isinstance(shown.get("archived", False), bool) \
            or shown.get("olderThan", 0) not in (0, 30, 90, 180, 365, 730):
        return "Not a choice of what is shown"
    stays = c["dock"].get("stays", {})
    if not isinstance(stays, dict) or not all(isinstance(k, str) and isinstance(v, str) and v.startswith("prj_") for k, v in stays.items()):
        return "Something kept in a project names the project"
    presses = c["dock"].get("clicksDefault")
    if presses is not None and (not isinstance(presses, dict) or sorted(presses.get(p, "") for p in ("click", "shift", "ctrl")) != ["bring", "go", "new"]):
        return "Each press does a different one of the three"
    if not isinstance(c["dock"].get("brings", []), list):
        return "Not a list of things brought"
    return ""


class SettingsBridge(Bridge):
    @Slot(result=str)
    def openWindows(self) -> str:  # noqa: N802 — called from the page by this name
        """The applications with a window open now, by class and name: for choosing which are always solid."""
        seen = {}
        for w in hypr.windows()["windows"]:
            if w["class"] and w["class"] not in seen:
                seen[w["class"]] = self.owner.desktop.apps.lookup(w["class"])["name"]
        return json.dumps([{"class": k, "name": v} for k, v in sorted(seen.items(), key=lambda x: x[1].lower())])

    @Slot(result=str)
    def applications(self) -> str:
        """Every application a menu would show: for choosing one to keep in a project."""
        return json.dumps([{"id": a["id"], "name": a["name"]} for a in self.owner.desktop.apps.launchable()])

    # ---- demo mode (demo.py): a made-up world to show Talaris off; each of these starts Talaris again
    @Slot(result=str)
    def demo(self) -> str:
        import demo
        return json.dumps({"on": demo.on(), "root": demo.ROOT})

    @Slot(str)
    def demoMode(self, verb: str) -> None:  # noqa: N802 — called from the page by this name
        import demo
        {"enter": demo.enter, "leave": demo.leave, "reset": demo.reset}.get(verb, lambda: None)()

    @Slot(result=str)
    def config(self) -> str:
        return json.dumps({"config": self.owner.desktop.config, "fonts": FONTS,
                           "defaults": DEFAULTS})

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

    #: Morgan's answer to `morganAsk`: {id, reply}.
    morganReply = Signal(str)

    @Slot(str, str)
    def morganAsk(self, ident: str, request: str) -> None:  # noqa: N802 — called from the page by this name
        """One of Morgan's `admin` ops, answered later (`morganReply`): some take minutes, and the page must not wait on them."""
        try:
            r = json.loads(request)
        except ValueError:
            r = {}
        op = r.get("op")

        def run() -> None:
            if op not in MORGAN_OPS:
                reply = {"ok": False, "error": "Not something this page asks of Morgan"}
            else:
                text = command("admin " + json.dumps({"op": op, "args": r.get("args", {})}), timeout=300 if op in MORGAN_SLOW else 45)
                try:
                    reply = json.loads(text)
                except ValueError:
                    reply = {"ok": False, "error": text.strip() or "No answer"}
                # A picture from memory: the page cannot read a file, so it is given the picture itself.
                if op == "memory.picture.view" and reply.get("ok") and reply.get("path") and not reply.get("data"):
                    try:
                        with open(reply["path"], "rb") as f:
                            reply["data"] = base64.b64encode(f.read()).decode()
                    except OSError:
                        pass
            self.morganReply.emit(json.dumps({"id": ident, "reply": reply}))
        threading.Thread(target=run, daemon=True).start()

    @Slot()
    def testNotification(self) -> None:  # noqa: N802 — called from the page by this name
        """One notification, as any application would send it: to see the look just chosen."""
        subprocess.Popen(["notify-send", "--app-name=Talaris", "--icon=preferences-system-notifications",
                          "A test notification", "This is how they look now. It goes when its bar runs out."],
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)

    @Slot(str)
    def morganAccount(self, verb: str) -> None:  # noqa: N802 — called from the page by this name
        """Signing the Oracle's Claude account in or out: `heymorgan login` / `logout`, in a terminal, where it asks."""
        if verb in ("login", "logout"):
            self.owner.desktop.machine.open_tool(f"morgan-{verb}")

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

    @Slot(str, result=str)
    def wallpaper(self, scope: str) -> str:
        """The default's (`scope` empty) or a project's wallpaper, with every project's say: {path, fit, own, projects}."""
        return json.dumps(self.owner.wallpapers(scope))

    @Slot(str)
    def chooseWallpaper(self, scope: str) -> None:  # noqa: N802 — called from the page by this name
        self.owner.choose_wallpaper(scope)

    @Slot(str, str)
    def fitWallpaper(self, scope: str, fit: str) -> None:  # noqa: N802 — called from the page by this name
        error = self.owner.desktop.set_wallpaper(scope, fit=fit)
        self.wallpaperChanged.emit(json.dumps({**self.owner.wallpapers(scope), "error": error}))

    @Slot(str)
    def defaultWallpaper(self, scope: str) -> None:  # noqa: N802 — called from the page by this name
        """A project's own wallpaper given up: it shows the default again."""
        error = self.owner.desktop.set_wallpaper(scope, clear=True) if scope else ""
        self.wallpaperChanged.emit(json.dumps({**self.owner.wallpapers(scope), "error": error}))

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
    #: A plugin was enabled, stopped, set or removed: said from the worker thread, heard on Qt's.
    pluginsTouched = Signal()
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
        if not route_ok(SETTINGS_ROUTES, path):
            self.coreReply.emit(json.dumps({"id": ident, "status": 400, "data": {"error": "not a route the Data page uses"}}))
            return

        def run() -> None:
            # A revival or a backup of a large store takes a while.
            # A revival or a backup of a large store takes a while; so does cloning a plugin.
            status, text = core_call(method, path, body or None, timeout=600 if path.startswith("/backups") else 180 if path.startswith("/plugins") else 30)
            try:
                data = json.loads(text) if text else None
            except ValueError:
                data = {"error": text}
            self.coreReply.emit(json.dumps({"id": ident, "status": status, "data": data}))
            # A plugin enabled, stopped, set or gone: its windows, keys and entries follow.
            if path.startswith("/plugins") and method != "GET":
                self.pluginsTouched.emit()
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
        # Its windows, keys and launcher entries follow a plugin's change, once it has started or stopped.
        self.bridge.pluginsTouched.connect(lambda: QTimer.singleShot(1500, self.desktop.webapps.refresh))
        # Its page, and the clear layer behind it, made the first time Settings opens: kept for a page opened now and then.
        self.profile = profile
        self._view = self._surface = self._catcher = None
        # Wi-Fi and Bluetooth: the same readings and changes as the bar's panels.
        desktop.machine.panel.connect(self.bridge.panel.emit)
        self.idle = QTimer(self)
        self.idle.setSingleShot(True)
        self.idle.timeout.connect(self.file_away)

    def _make(self) -> None:
        self._view = make_view(self.profile, "settings", "talaris-ui://ui/settings.html", self.bridge, self)
        self._surface = LayerSurface(self._view, "talaris-settings")
        # A clear layer behind it, over the windows: a click off Settings closes it.
        self._catcher = Catcher(self.profile, self.file_away, self, name="settings-catcher")

    @property
    def view(self):
        if self._view is None:
            self._make()
        return self._view

    @property
    def surface(self):
        if self._surface is None:
            self._make()
        return self._surface

    @property
    def catcher(self):
        if self._catcher is None:
            self._make()
        return self._catcher

    def describe(self) -> dict:
        # Its size in its page's pixels, for arriving to wait for — once it has a page.
        z = (self._view.zoomFactor() or 1) if self._view is not None else 1
        return {"up": self.up, "page": self.page, "theme": self.desktop.config["theme"], "motion": self.desktop.motion("settings"),
                "viewport": [round(zoom(SIZE[0]) / z), round(zoom(SIZE[1]) / z)]}

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

    def wallpapers(self, scope: str) -> dict:
        """What Settings shows: one wallpaper (the default, or a project's), and every project's state."""
        desktop = self.desktop
        status, text = core_call("GET", "/projects")
        try:
            projects = json.loads(text) if status == 200 else []
        except ValueError:
            projects = []
        here = desktop.project.get("id", "")
        mine = wallpaper.for_project(desktop.config, scope) if scope else {**wallpaper.current(), "own": False}
        return {**mine, "scope": scope, "here": here,
                "projects": [{"id": p["id"], "name": p.get("name", ""), "home": bool(p.get("home")),
                              "own": wallpaper.for_project(desktop.config, p["id"])["own"]} for p in projects]}

    def choose_wallpaper(self, scope: str = "") -> None:
        """A picture, chosen in the desktop's own chooser beside the surface, not inside it."""
        if getattr(self, "_chooser", None):
            return
        now = wallpaper.for_project(self.desktop.config, scope) if scope else wallpaper.current()

        def chosen(path: str) -> None:
            self._chooser = None
            self._come_back()
            if path:
                error = self.desktop.set_wallpaper(scope, path=path)
                self.bridge.wallpaperChanged.emit(json.dumps({**self.wallpapers(scope), "error": error, "changed": not error}))

        self._chooser = True
        self._step_aside()
        wallpaper.pick(self, os.path.dirname(now["path"]), chosen)

    def choose_path(self, kind: str) -> None:
        if getattr(self, "_chooser", None):
            return
        chooser = QProcess(self)
        chooser.setProgram("zenity")
        if kind == "folder":
            chooser.setArguments(["--file-selection", "--directory", "--title=A folder for backups"])
        elif kind == "plugin":
            chooser.setArguments(["--file-selection", "--directory", "--title=A plugin's folder (it has a plugin.toml)"])
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
        for key in ("theme", "bar", "dock", "launcher", "overlays", "calendar", "windows", "clock", "panels", "touch", "text", "power", "data", "notifications", "meaning", "shown"):
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
