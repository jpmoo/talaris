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
import re

from PySide6.QtCore import QObject, QTimer, Slot
from PySide6.QtWebEngineCore import QWebEngineProfile

import hypr
from config import DEFAULTS, save_config
from core import Bridge
from layershell import KEYBOARD_ON_DEMAND, OVERLAY, LayerSurface, Placement
from morgan import command
from views import log, make_view

SIZE = (860, 620)
IDLE_MS = 3 * 60 * 1000

FONTS = ["Barlow Semi Condensed", "Rajdhani", "Saira Semi Condensed", "Exo 2"]
EDGES = ("top", "bottom", "left", "right")
LAUNCHER_KEYS = ("SUPER ALT, SPACE", "SUPER, SPACE")

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
    if c["bar"]["edge"] not in ("top", "bottom") or c["dock"]["edge"] not in ("top", "bottom"):
        return "The bar and the dock go on the top or the bottom"
    if c["bar"]["edge"] == c["dock"]["edge"]:
        return "The bar and the dock need an edge each"
    edges = [d["edge"] for d in c["drawers"].values()]
    if any(e not in EDGES for e in edges):
        return "Not an edge"
    if len(set(edges)) != len(edges):
        return "Each drawer needs an edge of its own, for now"
    if any(e == c["bar"]["edge"] or e == c["dock"]["edge"] for e in edges):
        return "A drawer cannot share the bar's or the dock's edge"
    if any(not 0.25 <= float(d["size"]) <= 0.9 for d in c["drawers"].values()):
        return "A drawer is a quarter to nine tenths of the screen"
    if not 0 <= int(c["windows"]["gap"]) <= 40:
        return "The space round windows is 0 to 40 pixels"
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
        except (ValueError, KeyError, TypeError) as e:
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
            self.surface.apply(Placement(OVERLAY, 0, *SIZE, KEYBOARD_ON_DEMAND))
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

    def apply(self, wanted: dict) -> str:
        """Take a whole configuration, check it, keep it, and make the screen match it."""
        before = self.desktop.config
        after = copy.deepcopy(before)
        for key in ("theme", "bar", "dock", "launcher", "windows"):
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
