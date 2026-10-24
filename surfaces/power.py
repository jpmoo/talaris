# SPDX-License-Identifier: GPL-3.0-only
# Copyright (c) 2026 Jeff Moore
"""
Power: when the screen dims, locks, turns off, and the machine suspends.

**Borrowed, not built** (DESIGN.md, "What Talaris borrows"): the idle timing
is hypridle's and the lock is hyprlock's. What Talaris adds is the page in
Settings and a hypridle file of its own, `~/.config/talaris/hypridle.conf`,
written from the settings — never the user's own `hypridle.conf` — and a
hypridle it runs with that file, as a child of this process.

**Off until switched on.** Two idle managers fight: each locks, each turns the
screen off. So Talaris runs its hypridle only when Settings says Talaris
manages power, and says so if another hypridle is running alongside.
"""

from __future__ import annotations

import os
import subprocess

from PySide6.QtCore import QObject, QProcess

from config import CONFIG
from views import log

IDLE_FILE = os.path.join(os.path.dirname(CONFIG), "hypridle.conf")


def _file(p: dict) -> str:
    """The hypridle file for these settings: each step only if it has a time (0 is never)."""
    lines = [
        "# Written by Talaris from Settings, Power; changes here are overwritten.",
        "general {",
        "    lock_cmd = pidof hyprlock || hyprlock",
        "    before_sleep_cmd = loginctl lock-session",
        "    after_sleep_cmd = hyprctl dispatch dpms on",
        "}",
    ]

    def listener(seconds: int, on: str, back: str = "") -> None:
        if seconds > 0:
            lines.extend(["", "listener {", f"    timeout = {seconds}", f"    on-timeout = {on}"]
                         + ([f"    on-resume = {back}"] if back else []) + ["}"])

    # Dimmed by brightnessctl, which saves the level and puts it back.
    listener(int(p.get("dim", 0)), f"brightnessctl -s set {int(p.get('dimTo', 20))}%", "brightnessctl -r")
    listener(int(p.get("lock", 0)), "loginctl lock-session")
    listener(int(p.get("screenOff", 0)), "hyprctl dispatch dpms off", "hyprctl dispatch dpms on")
    listener(int(p.get("suspend", 0)), "systemctl suspend")
    return "\n".join(lines) + "\n"


def others() -> list[int]:
    """hypridle processes that are not Talaris's own."""
    try:
        out = subprocess.run(["pgrep", "-x", "hypridle"], capture_output=True, text=True, timeout=2).stdout
    except (OSError, subprocess.SubprocessError):
        return []
    return [int(pid) for pid in out.split()]


class Power(QObject):
    def __init__(self, desktop) -> None:
        super().__init__(desktop)
        self.desktop = desktop
        self.process: QProcess | None = None

    def apply(self) -> None:
        """Write the file and run Talaris's hypridle — or stop it, if Talaris does not manage power."""
        p = self.desktop.config["power"]
        if not p.get("managed"):
            self.stop()
            return
        os.makedirs(os.path.dirname(IDLE_FILE), exist_ok=True)
        text = _file(p)
        with open(IDLE_FILE, "w", encoding="utf-8") as f:
            f.write(text)
        # hypridle reads its file once; a change is a new hypridle.
        self.stop()
        self.process = QProcess(self)
        self.process.setProgram("hypridle")
        self.process.setArguments(["-q", "-c", IDLE_FILE])
        self.process.start()
        log("power: hypridle running with Talaris's settings")

    def stop(self) -> None:
        if self.process and self.process.state() != QProcess.ProcessState.NotRunning:
            self.process.terminate()
            self.process.waitForFinished(2000)
        self.process = None

    def status(self) -> dict:
        mine = int(self.process.processId()) if self.process and self.process.state() == QProcess.ProcessState.Running else 0
        return {"managed": bool(self.desktop.config["power"].get("managed")), "running": bool(mine),
                "others": [pid for pid in others() if pid != mine]}
