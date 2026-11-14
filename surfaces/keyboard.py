# SPDX-License-Identifier: GPL-3.0-only
# Copyright (c) 2026 Jeff Moore
"""
The on-screen keyboard, for a machine with a touchscreen.

**Borrowed, not built**: Squeekboard draws and types (it is what a Linux phone
uses), started by Talaris where it is installed and there is a touchscreen.

**Only when asked.** Squeekboard would come up by itself whenever a text field
has focus; on a machine that is also a laptop that is a keyboard over half the
screen for every search box. Talaris turns that off and asks for it instead:
a field with focus wears a small keyboard button (surface.js), and a press on
it is `show(True)`; leaving the field puts it away.

**Above everything.** Squeekboard is a layer on the `top` level, under
Talaris's panels (`overlay`), which cover the screen: a tap on the keyboard
landed on the panel — outside its box — and put the panel away. While the
keyboard is up, every panel is placed clear of it (layershell.set_keyboard),
so the keyboard is the panel's neighbor rather than under it.
"""

from __future__ import annotations

import json
import shutil
import subprocess

from PySide6.QtCore import QObject, QTimer

import hypr
import layershell
from views import log

#: The one keyboard, for the bridge's slot every page has (core.Bridge.keyboard).
current: "Keyboard | None" = None

OSK = ["gdbus", "call", "--session", "--dest", "sm.puri.OSK0", "--object-path", "/sm/puri/OSK0", "--method", "sm.puri.OSK0.SetVisible"]


def _touchscreen() -> bool:
    try:
        return bool(json.loads(hypr.ask("j/devices") or "{}").get("touch"))
    except ValueError:
        return False


def available() -> bool:
    """Whether this machine has what it takes: Squeekboard installed, and a touchscreen."""
    return bool(shutil.which("squeekboard")) and _touchscreen()


class Keyboard(QObject):
    def __init__(self, desktop) -> None:
        super().__init__(desktop)
        global current
        current = self
        self.desktop = desktop
        self.up = False
        self._room = QTimer(self)
        self._room.setSingleShot(True)
        self._room.timeout.connect(self._measure)
        if available():
            self._start()

    def _start(self) -> None:
        # Never by itself: only when a field's button asks (see above).
        subprocess.run(["gsettings", "set", "org.gnome.desktop.a11y.applications", "screen-keyboard-enabled", "false"],
                       capture_output=True, timeout=3, check=False)
        if subprocess.run(["pgrep", "-x", "squeekboard"], capture_output=True).returncode != 0:
            # Started by Hyprland, not as a child of this process: a restart of Talaris leaves it running.
            hypr.ask("/dispatch exec squeekboard")
            log("keyboard: Squeekboard started")

    def show(self, on: bool) -> None:
        """The keyboard up (a field's button) or away (the field left)."""
        if not available() or on == self.up:
            return
        self.up = on
        subprocess.Popen([*OSK, "true" if on else "false"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
        if on:
            # Its height, once it is on screen: what the panels keep clear of.
            self._room.start(250)
        else:
            self._room.stop()
            layershell.set_keyboard(0)

    def _measure(self) -> None:
        try:
            layers = json.loads(hypr.ask("j/layers") or "{}")
        except ValueError:
            return
        for monitor in layers.values():
            for level in monitor.get("levels", {}).values():
                for layer in level:
                    if layer.get("namespace") == "osk" and self.up:
                        layershell.set_keyboard(int(layer.get("h", 0)))
                        return
        if self.up:
            self._room.start(250)
