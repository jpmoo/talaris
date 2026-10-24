# SPDX-License-Identifier: GPL-3.0-only
# Copyright (c) 2026 Jeff Moore
"""
Talaris's settings, as a file: `~/.config/talaris/config.json`.

What is not in the file is the default below, so the file holds only what was
chosen and a new default reaches everyone who never chose otherwise. Settings
(`settings.py`) writes it; the process reads it at start and applies a change
the moment it is made.
"""

from __future__ import annotations

import json
import os
import tempfile

CONFIG = os.path.join(
    (os.environ.get("XDG_CONFIG_HOME") or "").strip() or os.path.expanduser("~/.config"), "talaris", "config.json"
)

DEFAULTS = {
    "theme": {"mode": "dark", "accent": "#c98a5b", "font": "Barlow Semi Condensed", "motion": "slide"},
    # shape: "strip" runs edge to edge; "floating" stands off the screen's
    # edges by `margins` (top, right, bottom, left; with none, `inset` on every
    # side), its corners rounded. opacity is the panel's, in percent.
    # outline: "line" or "none"; shadow under it; motion as it comes out from
    # hiding: "slide" or "none".
    "bar": {"edge": "top", "autohide": False, "shape": "strip", "inset": 8, "opacity": 100,
            "outline": "line", "shadow": False, "motion": "slide", "speed": "normal"},
    # The bar's clock: 12- or 24-hour, seconds or not, and how the date reads.
    "clock": {"hours": "12", "seconds": False, "date": "weekday-month-day"},
    # Super+Space while Noctalia holds it; Talaris takes it when Noctalia goes.
    "launcher": {"keys": "SUPER ALT, SPACE"},
    # How the launcher and Morgan's conversation come and go, from the top:
    # slide, draw ("chaos") or none, and how quickly.
    "overlays": {"motion": "slide", "speed": "normal"},
    # pinned: launcher ids, in order; order: every item's place, as dragged;
    # scope: the windows of "desktop" (this one) or "all".
    "dock": {"enabled": True, "edge": "bottom", "autohide": False, "opacity": 100, "pinned": [], "order": [], "scope": "desktop",
             "outline": "line", "shadow": False, "motion": "slide", "speed": "normal",
             # Icons swell as the pointer passes: their largest size, in
             # percent of their own; 100 is off.
             "magnify": 100},
    # How the drawers look: their outline (in the accent while in use, a plain
    # line, or none), a shadow, and their opacity in percent.
    # afterExpand: back from being the desktop, a drawer stays "open" or is "closed".
    # dim: the rest of the screen dims behind a pulled drawer, and a click there puts it away.
    "panels": {"outline": "focus", "shadow": True, "opacity": 100, "dismissOutside": False, "afterExpand": "open", "dim": True,
               # Whether the writing page and the canvas follow the opacity too,
               # or stay solid inside a see-through frame.
               "paperFollows": True},
    # The edge you touch to bring out a hidden bar or dock, or a drawer set to
    # touch-to-show: how thick (Qt units) and how much of the edge (percent).
    "touch": {"thick": 6, "length": 100},
    # Text size per area (small, medium or large): interface, dock, launcher,
    # morgan, writing, canvas. One not set takes theme.fontSize.
    "text": {},
    # When the screen dims, locks, turns off and the machine suspends, in
    # seconds (0 is never), run by a hypridle of Talaris's own — only when
    # `managed`, so it never runs alongside the user's own. dimTo is percent.
    # Plugged in (`ac`) and on battery each have their times. `lid` is what
    # closing it does — suspend, lock, screen-off or nothing — plugged in, on
    # battery, and with another screen attached (`docked`), which comes first.
    "power": {"managed": False, "dimTo": 20,
              "ac": {"dim": 0, "lock": 600, "screenOff": 900, "suspend": 0},
              "battery": {"dim": 120, "lock": 300, "screenOff": 420, "suspend": 1200},
              "lid": {"ac": "suspend", "battery": "suspend", "docked": "nothing"}},
    # The space between the windows and whatever is round them — the bar, the
    # dock, the screen's edge — the same on every side.
    # outline: the focused window's border in the accent and the rest a line
    # ("focus"), all "accent", all "line", or "none"; border is its width in px.
    # motion: how windows open and close — "slide", "pop", "fade" or "none" —
    # at a speed, as everything else comes and goes.
    "windows": {"gap": 10, "between": 10, "outline": "focus", "border": 2, "motion": "pop", "speed": "normal"},
    "drawers": {
        # One size for both (Settings shows them as one): under half each, so
        # both pulled at once leave a gap rather than overlapping. Height is a
        # share of the whole screen, aligned top, center or bottom; full
        # height or at the top, a drawer lies over the bar (at the bottom, the dock).
        "canvas": {"edge": "left", "size": 0.48, "height": 1.0, "align": "center", "outWhenEmpty": False, "autoshow": False},
        "writing": {"edge": "right", "size": 0.48, "height": 1.0, "align": "center", "outWhenEmpty": False, "autoshow": False},
    },
    # A pulled drawer files itself after this long with no input. Idle, not a
    # deadline: a fixed timeout fired mid-scroll in the spike.
    "idleSeconds": 45,
}


def load_config() -> dict:
    config = json.loads(json.dumps(DEFAULTS))
    try:
        with open(CONFIG, encoding="utf-8") as f:
            mine = json.load(f)
    except (OSError, ValueError):
        return config
    for key, value in mine.items():
        if isinstance(value, dict) and isinstance(config.get(key), dict):
            for k, v in value.items():
                if isinstance(v, dict) and isinstance(config[key].get(k), dict):
                    config[key][k].update(v)
                else:
                    config[key][k] = v
        else:
            config[key] = value
    return config


def _differences(mine: dict, base: dict) -> dict:
    """What `mine` says that `base` does not — what the file needs to hold."""
    out = {}
    for key, value in mine.items():
        if isinstance(value, dict) and isinstance(base.get(key), dict):
            inner = _differences(value, base[key])
            if inner:
                out[key] = inner
        elif base.get(key) != value:
            out[key] = value
    return out


def save_config(config: dict) -> None:
    """Write what differs from the defaults, atomically: a crash leaves the old file or the new one."""
    os.makedirs(os.path.dirname(CONFIG), exist_ok=True)
    text = json.dumps(_differences(config, DEFAULTS), indent=2) + "\n"
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(CONFIG), prefix=".config.")
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(text)
    os.replace(tmp, CONFIG)
