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
Tiles. Super+Shift and Left or Right slide the strip a column
(bin/move-or-split asks which layout it is in); Up and Down do nothing. A
three-finger swipe across the touchscreen does the same (gestures.py).

Runtime keywords, so hyprland.conf is untouched; a reload puts its own layout
back, and the surfaces apply this again when it does (surfaces.py,
`style_compositor`). Applied before the gaps are set: the scrolling layout
reads the gaps round the screen only when they are set after it took over —
before, its windows ran up under the bar.
"""

from __future__ import annotations

import glob
import json

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
COLUMN = "0.8"

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


def slide(way: int) -> None:
    """The strip a column on (+1) or back (-1): the window there comes to the middle."""
    hypr.ask(f"/dispatch layoutmsg move {'+col' if way > 0 else '-col'}")
