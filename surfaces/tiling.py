# SPDX-License-Identifier: GPL-3.0-only
# Copyright (c) 2026 Jeff Moore
"""
How windows are laid out on this machine (Settings, Windows, Tiling) — the
machine's own, never synced (prefsync.py keeps to the wallpapers).

**Tiles**: Hyprland's dwindle, each new window splitting the space of the one
in use. **Carousel**: windows in a strip of columns, as niri lays them out,
each a little narrower than the screen so the edges of the ones beside it
show; the strip slides to the window in use. It is Hyprland's own scrolling
layout, a plugin (`hyprland-plugin-hyprscrolling`, built for the Hyprland
installed), loaded here when chosen.

**Moving through it**: Super and the arrows move to the window that way, as in
Tiles. Super+Shift and Left or Right go to the next window or the one before
(bin/move-or-split asks which layout it is in); Up and Down do nothing. A
three-finger swipe across the touchscreen does the same (gestures.py).

Runtime keywords, so hyprland.conf is untouched; a reload puts its own layout
back, and the surfaces apply this again when it does (surfaces.py,
`style_compositor`).

**The space round the windows** is not Hyprland's gaps in the carousel: the
scrolling layout took them only now and then (and once slid every window off
the screen when they were set again). The bar and the dock reserve it instead,
each its gap beyond its own edge (`edge_gap`), which the layout always keeps
clear; the gaps themselves are none.
"""

from __future__ import annotations

import glob
import json
import time

from PySide6.QtCore import QObject, QTimer

import hypr
from views import log

#: Where Ubuntu's package puts the plugin, and where a hand-built one may be.
PLUGIN_GLOBS = (
    "/usr/lib/*/hyprland/plugins/*hyprscrolling*.so",
    "/usr/lib/hyprland/plugins/*hyprscrolling*.so",
    "/usr/lib/*/hyprland/*hyprscrolling*.so",
    "/usr/local/lib/hyprland/*hyprscrolling*.so",
)
PACKAGE = "hyprland-plugin-hyprscrolling"

#: How much of the screen a column takes: the rest shows the edges of the windows on either side.
COLUMN = "0.9"

_said = ""


def plugin_path() -> str:
    for pattern in PLUGIN_GLOBS:
        found = sorted(glob.glob(pattern))
        if found:
            return found[0]
    return ""


def available() -> bool:
    """Whether Carousel can be had here: the plugin installed."""
    return bool(plugin_path())


def _layout(name: str) -> bool:
    """The layout set, only when it is not already: told again, Hyprland may lay every window out afresh. Whether it changed."""
    try:
        now = json.loads(hypr.ask("j/getoption general:layout") or "{}").get("str", "")
    except ValueError:
        now = ""
    if now != name:
        hypr.keyword("general:layout", name)
        return True
    return False


def _loaded() -> bool:
    return "hyprscrolling" in (hypr.ask("plugin list") or "")


def apply(mode: str) -> str:
    """The layout as Settings says ("tiles" or "carousel"). Answers the layout in use, "scrolling" or "dwindle"."""
    global _said
    if mode == "carousel":
        path = plugin_path()
        if not path:
            if _said != "missing":
                log(f"tiling: Carousel needs {PACKAGE}; tiles until it is installed")
                _said = "missing"
            _layout("dwindle")
            return "dwindle"
        if not _loaded():
            out = hypr.ask(f"plugin load {path}")
            if "error" in out.lower() and not _loaded():
                log(f"tiling: the scrolling layout did not load ({out.strip()[:120]})")
                _layout("dwindle")
                return "dwindle"
        switched = _layout("scrolling")
        hypr.keyword("plugin:hyprscrolling:column_width", COLUMN)
        # The windows already out keep the widths they had as tiles (a half each); the new width is for new columns.
        if switched:
            hypr.ask(f"/dispatch layoutmsg colresize all {COLUMN}")
        # One window alone fills the screen, rather than sitting in a column with nothing beside it.
        hypr.keyword("plugin:hyprscrolling:fullscreen_on_one_column", "true")
        # The window moved to is put in the middle, the strip sliding under it.
        hypr.keyword("plugin:hyprscrolling:focus_fit_method", "0")
        if _said != "carousel":
            log("tiling: carousel")
            _said = "carousel"
        return "scrolling"
    _layout("dwindle")
    if _said not in ("", "tiles"):
        log("tiling: tiles")
    _said = "tiles"
    return "dwindle"


class Centering(QObject):
    """
    In the carousel, the window with the keys always in the middle. The layout centers a window only when it is gone
    to by its own `focus` (the keys, the swipe: `slide`); one that took the keys any other way — clicked, just opened,
    the one in use as the carousel was chosen — stayed at the screen's edge. So, a moment after the keys move, the
    window with them is looked at, and one off the middle is gone from and back to by the layout's `focus`, which
    centers it. What that does itself is not looked at again.
    """

    def __init__(self, events, wanted) -> None:
        super().__init__(events)
        self.wanted = wanted
        self._quiet_until = 0.0
        self._later = QTimer(self)
        self._later.setSingleShot(True)
        self._later.setInterval(150)
        self._later.timeout.connect(self.center)
        events.focus.connect(lambda _a: self._later.start())
        events.opened.connect(lambda _a: self._later.start())
        events.closed.connect(lambda _a: self._later.start())

    def center(self) -> None:
        if time.monotonic() < self._quiet_until or not self.wanted():
            return
        try:
            if json.loads(hypr.ask("j/getoption general:layout") or "{}").get("str") != "scrolling":
                return
            w = json.loads(hypr.ask("j/activewindow") or "{}")
            mons = json.loads(hypr.ask("j/monitors") or "[]")
        except ValueError:
            return
        if not w or w.get("floating") or w.get("fullscreen"):
            return
        mon = next((m for m in mons if m.get("id") == w.get("monitor")), None)
        if not mon:
            return
        turned = int(mon.get("transform", 0)) % 2 == 1
        width = (mon["height"] if turned else mon["width"]) / (mon.get("scale") or 1)
        middle = mon["x"] + width / 2
        here = w["at"][0] + w["size"][0] / 2
        if abs(here - middle) <= 24 or w["size"][0] >= width - 40:
            return  # in the middle already, or alone and filling the screen
        self._quiet_until = time.monotonic() + 0.6
        was = w.get("address")
        active = lambda: json.loads(hypr.ask("j/activewindow") or "{}").get("address")  # noqa: E731
        hypr.ask("/dispatch layoutmsg focus r")
        if active() != was:
            hypr.ask("/dispatch layoutmsg focus l")
            return
        hypr.ask("/dispatch layoutmsg focus l")
        if active() != was:
            hypr.ask("/dispatch layoutmsg focus r")


def slide(way: int) -> None:
    """
    To the next window (+1) or the one before (-1): it takes the keys, and the strip brings it to the middle. The
    layout's `focus`, not its `move`: `move` slides the view alone, past the last window into empty screen, and
    leaves the keys where they were.
    """
    hypr.ask(f"/dispatch layoutmsg focus {'r' if way > 0 else 'l'}")
