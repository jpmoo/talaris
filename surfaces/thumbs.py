# SPDX-License-Identifier: GPL-3.0-only
# Copyright (c) 2026 Jeff Moore
"""
Project thumbnails: what each project's desktop looked like when last seen,
for the bar's project menu and the project carousel — so a project is found by
its look as well as its name.

A small picture of the screen (grim), taken a moment after a project becomes
the current one, after a window opens, closes or moves, and once a minute while it
stays if anything on it has moved (a picture costs a capture and an encoding;
the same windows in the same places are the same likeness) — only what is in view can be pictured, so a desktop a window
left keeps its old likeness until it is next seen — but never while a
Talaris panel or menu is out — a dimmed screen is no likeness. Kept in the
runtime directory, which only the user reads and which is cleared at logout:
a picture of the screen is not something to leave on disk. A project not yet
seen shows its wallpaper instead (the page asks `talaris-ui://thumb/`, which
falls back) — and so does one left with no windows while out of view: an empty
desktop is its wallpaper, so its old likeness is let go rather than kept.

Each window in view is pictured at those times too, for the dock (DockPreview):
as it last looked, since a window not on screen cannot be pictured.
"""

from __future__ import annotations

import base64
import json
import os
import re
import subprocess
import threading

from PySide6.QtCore import QBuffer, QObject, QRect, Qt, QTimer
from PySide6.QtGui import QImage

import core
import hypr
from views import log

DIR = os.path.join(os.environ.get("XDG_RUNTIME_DIR", f"/run/user/{os.getuid()}"), "talaris-thumbs")
#: Width of a thumbnail, in pixels: enough for a 128-wide tile on a dense screen.
WIDTH = 384
EVERY_MS = 60 * 1000
#: Surfaces of Talaris that are always there; any other one out means a panel or menu is.
RESIDENT = ("talaris-bar", "talaris-dock", "talaris-edge-dock", "talaris-desk", "talaris-edge", "talaris-corner-")
#: A window opened, closed or moved: this long for the screen to settle before it is looked at.
SETTLE_MS = 1500


def path_for(project: str) -> str:
    return os.path.join(DIR, re.sub(r"[^A-Za-z0-9_-]", "", project) + ".png")


#: Each window's picture, apart from the projects' (which `_let_go_of_empty` looks through), and its width.
WINDOWS_DIR = os.path.join(DIR, "windows")
WINDOW_WIDTH = 480


def window_path(address: str) -> str:
    return os.path.join(WINDOWS_DIR, re.sub(r"[^A-Za-z0-9]", "", address) + ".png")


def window_picture(address: str) -> str:
    """A window as it last looked, for a page; empty if it has not been seen."""
    try:
        with open(window_path(address), "rb") as f:
            return base64.b64encode(f.read()).decode("ascii")
    except OSError:
        return ""


class Thumbs(QObject):
    def __init__(self, desktop) -> None:
        super().__init__(desktop)
        self.desktop = desktop
        #: What the desktop looked like at each project's last picture: its windows, where, and what they said.
        self._seen: dict[str, str] = {}
        self._every = QTimer(self)
        self._every.timeout.connect(lambda: self.take(only_if_changed=True))
        self._every.start(EVERY_MS)
        self._soon = QTimer(self)
        self._soon.setSingleShot(True)
        self._soon.timeout.connect(self.take)
        # A window opened, closed or moved: the current desktop pictured again if it changed,
        # and any other left empty let go to its wallpaper.
        self._settle = QTimer(self)
        self._settle.setSingleShot(True)
        self._settle.timeout.connect(self._windows_moved)
        ev = desktop.events
        for signal in (ev.opened, ev.closed):
            signal.connect(lambda _a: self._settle.start(SETTLE_MS))
        ev.closed.connect(self._window_gone)
        ev.windows.connect(lambda: self._settle.start(SETTLE_MS))
        # And once at the start: what was left empty while Talaris was away.
        self._settle.start(SETTLE_MS * 2)

    @staticmethod
    def _window_gone(address: str) -> None:
        try:
            os.remove(window_path(address))
        except OSError:
            pass

    def _picture_windows(self) -> None:
        """Off the screen's thread: the screen, once, and each window in view cut out of it."""
        try:
            mon = next(m for m in json.loads(hypr.ask("j/monitors")) if m.get("focused"))
            active = mon.get("activeWorkspace", {}).get("id")
            w, h = int(mon["width"] / mon["scale"]), int(mon["height"] / mon["scale"])
            shot = subprocess.run(["grim", "-g", f"{mon['x']},{mon['y']} {w}x{h}", "-t", "png", "-l", "1", "-"], check=True, timeout=10, capture_output=True).stdout
            screen = QImage.fromData(shot, "PNG")
            if screen.isNull():
                return
            ratio = screen.width() / w
            os.makedirs(WINDOWS_DIR, mode=0o700, exist_ok=True)
            os.chmod(WINDOWS_DIR, 0o700)
            for c in json.loads(hypr.ask("j/clients")):
                if c.get("workspace", {}).get("id") != active or not c.get("mapped", True) or c.get("hidden"):
                    continue
                (x, y), (cw, ch) = c["at"], c["size"]
                part = screen.copy(QRect(int((x - mon["x"]) * ratio), int((y - mon["y"]) * ratio), int(cw * ratio), int(ch * ratio)))
                small = part.scaledToWidth(min(WINDOW_WIDTH, part.width()), Qt.TransformationMode.SmoothTransformation)
                tmp = window_path(c["address"]) + ".tmp"
                buffer = QBuffer()
                buffer.open(QBuffer.OpenModeFlag.WriteOnly)
                small.save(buffer, "PNG", 30)
                with open(tmp, "wb") as f:
                    f.write(bytes(buffer.data()))
                os.chmod(tmp, 0o600)
                os.replace(tmp, window_path(c["address"]))
        except (StopIteration, ValueError, KeyError, OSError, subprocess.SubprocessError) as e:
            log(f"thumbs: windows: {e}")

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

    def _looks(self) -> str:
        """The desktop in view, as words: its windows, where they are, what they say."""
        try:
            now = hypr.windows()
        except Exception:  # noqa: BLE001 — no likeness to compare: taken
            return ""
        shown = sorted((w["address"], w["title"], w.get("focused", False)) for w in now["windows"] if w["workspace"] == now["active"] and not w["hidden"])
        try:
            places = {c["address"]: (c["at"], c["size"]) for c in json.loads(hypr.ask("j/clients"))}
        except (ValueError, OSError):
            places = {}
        return json.dumps([now["active"], now["focused"], [(a, t, places.get(a)) for a, t, _f in shown]])

    def _windows_moved(self) -> None:
        self.take(only_if_changed=True)
        here = self.desktop.project.get("id", "")
        threading.Thread(target=self._let_go_of_empty, args=(here,), daemon=True).start()

    def _let_go_of_empty(self, here: str) -> None:
        """Each project but this one with a likeness and no windows now: the likeness gone, its wallpaper shown instead."""
        try:
            pictured = [f[:-4] for f in os.listdir(DIR) if f.endswith(".png")]
        except OSError:
            return
        if not pictured:
            return
        home = next((p.get("id", "") for p in core.projects() if p.get("home")), "")
        now = hypr.windows()
        names = {w["id"]: w["name"] for w in now["workspaces"]}
        if not names:
            return  # Hyprland did not answer: nothing known to be empty
        holding = {hypr.project_of(names.get(w["workspace"], ""), home) for w in now["windows"] if not w["hidden"]}
        for project in pictured:
            if project != here and project not in holding:
                try:
                    os.remove(path_for(project))
                except OSError:
                    pass
                self._seen.pop(project, None)

    def take(self, only_if_changed: bool = False) -> None:
        project = self.desktop.project.get("id", "")
        if not project or not self._clear():
            return
        looks = self._looks()
        if only_if_changed and looks and self._seen.get(project) == looks and os.path.exists(path_for(project)):
            return
        self._seen[project] = looks

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
            self._picture_windows()
        threading.Thread(target=run, daemon=True).start()
