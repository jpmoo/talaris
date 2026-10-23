# SPDX-License-Identifier: GPL-3.0-only
# Copyright (c) 2026 Jeff Moore
"""
The on-screen display: the level, for a moment, when a key changes it.

**The keys stay compositor binds** calling `wpctl` and `brightnessctl`, as they
were in `hyprland.conf`; Talaris binds them again at runtime, each followed by
`talaris-surfaces --osd <kind>`, which reads the level now and shows it. The
binds are put back as they were when Talaris quits, so the keys never go dead.
`hyprland.conf` itself is not touched.

A small panel just above the dock, centered, on the `overlay` layer, never
taking the keyboard, gone a moment after the last press.
"""

from __future__ import annotations

import json
import re
import subprocess

from PySide6.QtCore import QObject, QTimer
from PySide6.QtWebEngineCore import QWebEngineProfile

import hypr
from core import Bridge
from layershell import ANCHOR_BOTTOM, KEYBOARD_NONE, OVERLAY, LayerSurface, Placement
from views import make_view

SIZE = (300, 64)
SHOW_MS = 1400

SINK, SOURCE = "@DEFAULT_AUDIO_SINK@", "@DEFAULT_AUDIO_SOURCE@"

#: The keys, their flags, what they do, and what they show. What they do is what
#: `hyprland.conf` had them do; it is also what they go back to doing on quit.
KEYS = [
    (",XF86AudioRaiseVolume", "el", f"wpctl set-volume -l 1 {SINK} 5%+", "volume"),
    (",XF86AudioLowerVolume", "el", f"wpctl set-volume {SINK} 5%-", "volume"),
    (",XF86AudioMute", "el", f"wpctl set-mute {SINK} toggle", "volume"),
    (",XF86AudioMicMute", "el", f"wpctl set-mute {SOURCE} toggle", "mic"),
    (",XF86MonBrightnessUp", "el", "brightnessctl -e4 -n2 set 5%+", "brightness"),
    (",XF86MonBrightnessDown", "el", "brightnessctl -e4 -n2 set 5%-", "brightness"),
]


def _run(*cmd: str) -> str:
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=2).stdout
    except (OSError, subprocess.SubprocessError):
        return ""


def level(kind: str) -> dict:
    if kind in ("volume", "mic"):
        out = _run("wpctl", "get-volume", SINK if kind == "volume" else SOURCE)
        m = re.search(r"Volume:\s*([\d.]+)", out)
        return {"kind": kind, "level": round(float(m.group(1)) * 100) if m else 0, "muted": "[MUTED]" in out}
    if kind == "brightness":
        # brightnessctl -m: device,class,current,percent,max
        parts = _run("brightnessctl", "-m", "info").strip().split(",")
        pct = parts[3].rstrip("%") if len(parts) >= 4 else "0"
        return {"kind": kind, "level": int(pct) if pct.isdigit() else 0, "muted": False}
    return {"kind": kind, "level": 0, "muted": False}


class Osd(QObject):
    def __init__(self, profile: QWebEngineProfile, desktop) -> None:
        super().__init__(desktop)
        self.desktop = desktop
        self.up = False
        self.bridge = Bridge(self, self)
        self.view = make_view(profile, "osd", "talaris-ui://ui/osd.html", self.bridge, self)
        self.surface = LayerSurface(self.view, "talaris-osd")
        self.shown = {"kind": "volume", "level": 0, "muted": False}
        self._hide = QTimer(self)
        self._hide.setSingleShot(True)
        self._hide.timeout.connect(self.file_away)

    def describe(self) -> dict:
        return {"up": self.up, **self.shown, "theme": self.desktop.config["theme"]}

    def show(self, kind: str) -> None:
        if kind not in ("volume", "mic", "brightness"):
            return
        self.shown = level(kind)
        if not self.up:
            # On the bottom edge, clear of what reserves it — just above the dock.
            self.surface.apply(Placement(OVERLAY, ANCHOR_BOTTOM, *SIZE, KEYBOARD_NONE))
            self.up = True
        self.bridge.state.emit(json.dumps(self.describe()))
        self._hide.start(SHOW_MS)
        # The bar's reading of the volume catches up at once, not at its next poll.
        self.desktop.machine.refresh()

    def file_away(self) -> None:
        if not self.up:
            return
        self.up = False
        self.view.hide()
        self.surface.placement = None
        self.bridge.state.emit(json.dumps(self.describe()))

    def bind(self, launcher: str) -> None:
        for keys, flags, command, kind in KEYS:
            hypr.bind(keys, f"{command}; {launcher} --osd {kind}", flags)

    def unbind(self) -> None:
        """Back to what the keys did before: the command, without the display."""
        for keys, flags, command, _kind in KEYS:
            hypr.bind(keys, command, flags)

    # What the page's bridge calls on its owner; it has nothing to do.
    def toggle(self) -> None:
        pass

    def left(self) -> None:
        pass

    def touched(self) -> None:
        pass
