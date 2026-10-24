# SPDX-License-Identifier: GPL-3.0-only
# Copyright (c) 2026 Jeff Moore
"""
Project thumbnails: what each project's desktop looked like when last seen,
for the bar's project menu and the Super+Alt list — so a project is found by
its look as well as its name.

A small picture of the screen (grim), taken a moment after a project becomes
the current one, after a window is brought to it, and every twenty seconds
while it stays — only what is in view can be pictured, so a desktop a window
left keeps its old likeness until it is next seen — but never while a
Talaris panel or menu is out — a dimmed screen is no likeness. Kept in the
runtime directory, which only the user reads and which is cleared at logout:
a picture of the screen is not something to leave on disk. A project not yet
seen shows its wallpaper instead (the page asks `talaris-ui://thumb/`, which
falls back).
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import threading

from PySide6.QtCore import QObject, QTimer

import hypr
from views import log

DIR = os.path.join(os.environ.get("XDG_RUNTIME_DIR", f"/run/user/{os.getuid()}"), "talaris-thumbs")
#: Width of a thumbnail, in pixels: enough for a 128-wide tile on a dense screen.
WIDTH = 384
EVERY_MS = 20 * 1000
#: Surfaces of Talaris that are always there; any other one out means a panel or menu is.
RESIDENT = ("talaris-bar", "talaris-dock", "talaris-edge-dock", "talaris-desk", "talaris-edge")


def path_for(project: str) -> str:
    return os.path.join(DIR, re.sub(r"[^A-Za-z0-9_-]", "", project) + ".png")


class Thumbs(QObject):
    def __init__(self, desktop) -> None:
        super().__init__(desktop)
        self.desktop = desktop
        self._every = QTimer(self)
        self._every.timeout.connect(self.take)
        self._every.start(EVERY_MS)
        self._soon = QTimer(self)
        self._soon.setSingleShot(True)
        self._soon.timeout.connect(self.take)

    def arrived(self) -> None:
        """A project just became the current one: its likeness, once the screen has settled."""
        self._soon.start(1500)

    def _clear(self) -> bool:
        try:
            layers = json.loads(hypr.ask("j/layers"))
        except (ValueError, OSError):
            return False
        for monitor in layers.values():
            for level in monitor.get("levels", {}).values():
                for layer in level:
                    name = layer.get("namespace", "")
                    if name.startswith("talaris") and not name.startswith(RESIDENT):
                        return False
        return True

    def take(self) -> None:
        project = self.desktop.project.get("id", "")
        if not project or not self._clear():
            return

        def run() -> None:
            try:
                mon = next(m for m in json.loads(hypr.ask("j/monitors")) if m.get("focused"))
                w, h = int(mon["width"] / mon["scale"]), int(mon["height"] / mon["scale"])
                os.makedirs(DIR, mode=0o700, exist_ok=True)
                os.chmod(DIR, 0o700)
                tmp = path_for(project) + ".tmp"
                subprocess.run(["grim", "-g", f"{mon['x']},{mon['y']} {w}x{h}", "-s", f"{WIDTH / mon['width']:.3f}",
                                # PNG: Ubuntu's grim is built without JPEG.
                                "-t", "png", "-l", "6", tmp], check=True, timeout=10, capture_output=True)
                os.chmod(tmp, 0o600)
                os.replace(tmp, path_for(project))
            except (StopIteration, ValueError, OSError, subprocess.SubprocessError) as e:
                log(f"thumbs: {e}")
        threading.Thread(target=run, daemon=True).start()
