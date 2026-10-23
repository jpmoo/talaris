# SPDX-License-Identifier: GPL-3.0-only
# Copyright (c) 2026 Jeff Moore
"""
The machine, as the bar shows it: volume, network, Bluetooth, battery.

Read from the tools already here — `wpctl`, `nmcli`, `bluetoothctl` and
`/sys` — rather than from D-Bus libraries that would each be a dependency and
a binding to keep working. A poll every few seconds, off the GUI thread, is
what that costs; each read is a few milliseconds of a small process.

And what the bar can do to it: the volume, and the power menu. The deeper
settings are handed to the tools that already do them well (`nmtui`,
`bluetoothctl`) in a terminal, not rebuilt.
"""

from __future__ import annotations

import glob
import json
import os
import re
import shutil
import subprocess

from PySide6.QtCore import QObject, QRunnable, QThreadPool, QTimer, Signal

#: How often the bar's readings are refreshed, when nothing has asked sooner.
POLL_MS = 3000


def _run(*cmd: str, timeout: float = 2.0) -> str:
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout).stdout
    except (OSError, subprocess.SubprocessError):
        return ""


def _volume() -> dict:
    out = _run("wpctl", "get-volume", "@DEFAULT_AUDIO_SINK@")
    m = re.search(r"Volume:\s*([\d.]+)", out)
    if not m:
        return {"present": False}
    return {"present": True, "level": round(float(m.group(1)) * 100), "muted": "[MUTED]" in out}


def _network() -> dict:
    kind, name = "", ""
    for line in _run("nmcli", "-t", "-f", "TYPE,STATE,CONNECTION", "device").splitlines():
        parts = line.split(":")
        if len(parts) >= 3 and parts[1] == "connected" and parts[0] in ("wifi", "ethernet"):
            kind, name = parts[0], ":".join(parts[2:])
            if kind == "ethernet":
                break
    signal = None
    if kind == "wifi":
        for line in _run("nmcli", "-t", "-f", "IN-USE,SIGNAL", "dev", "wifi", "list", "--rescan", "no").splitlines():
            if line.startswith("*:"):
                try:
                    signal = int(line.split(":")[1])
                except ValueError:
                    pass
                break
    return {"kind": kind or "none", "name": name, "signal": signal}


def _bluetooth() -> dict:
    show = _run("bluetoothctl", "show")
    if not show:
        return {"present": False}
    powered = bool(re.search(r"Powered:\s*yes", show))
    connected = []
    if powered:
        for line in _run("bluetoothctl", "devices", "Connected").splitlines():
            parts = line.split(" ", 2)
            if len(parts) == 3 and parts[0] == "Device":
                connected.append(parts[2])
    return {"present": True, "powered": powered, "connected": connected}


def _battery() -> dict:
    found = sorted(glob.glob("/sys/class/power_supply/BAT*"))
    if not found:
        return {"present": False}

    def read(name: str) -> str:
        try:
            with open(os.path.join(found[0], name), encoding="ascii") as f:
                return f.read().strip()
        except OSError:
            return ""

    try:
        level = int(read("capacity"))
    except ValueError:
        return {"present": False}
    return {"present": True, "level": level, "state": read("status").lower()}


def read_all() -> dict:
    return {"volume": _volume(), "network": _network(), "bluetooth": _bluetooth(), "battery": _battery()}


class _Read(QRunnable):
    def __init__(self, machine: "Machine") -> None:
        super().__init__()
        self.machine = machine

    def run(self) -> None:
        self.machine.read.emit(json.dumps(read_all()))


def _detach(*cmd: str) -> None:
    """Started and let go: the bar never waits on what it launched."""
    try:
        subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                         stderr=subprocess.DEVNULL, start_new_session=True)
    except OSError:
        pass


#: The power menu's verbs, and what each one runs. The bar asks for the first
#: three again before acting; locking and suspending lose nothing.
POWER = {
    "lock": ("loginctl", "lock-session"),
    "suspend": ("systemctl", "suspend"),
    "logout": ("hyprctl", "dispatch", "exit"),
    "restart": ("systemctl", "reboot"),
    "shutdown": ("systemctl", "poweroff"),
}

#: The settings the bar hands off rather than rebuilds.
TOOLS = {"network": ("nmtui",), "bluetooth": ("bluetoothctl",)}


class Machine(QObject):
    """One reading of the machine, shared by every surface that shows it."""

    #: The latest reading, as JSON — emitted from a worker, delivered on the GUI thread.
    read = Signal(str)

    def __init__(self, parent: QObject | None = None) -> None:
        super().__init__(parent)
        self.last = "{}"
        self.read.connect(self._keep)
        self._pool = QThreadPool(self)
        self._pool.setMaxThreadCount(1)
        self._timer = QTimer(self)
        self._timer.timeout.connect(self.refresh)
        self._timer.start(POLL_MS)
        self.refresh()

    def _keep(self, text: str) -> None:
        self.last = text

    def refresh(self) -> None:
        # One reading at a time: a slow nmcli must not pile up readers behind it.
        if self._pool.activeThreadCount() == 0:
            self._pool.start(_Read(self))

    def volume(self, change: str) -> None:
        """`+5`, `-5`, a level like `40`, or `mute` to flip it."""
        if change == "mute":
            _run("wpctl", "set-mute", "@DEFAULT_AUDIO_SINK@", "toggle")
        elif re.fullmatch(r"[+-]\d{1,3}", change):
            _run("wpctl", "set-volume", "-l", "1.0", "@DEFAULT_AUDIO_SINK@",
                 f"{change[1:]}%{change[0]}")
        elif re.fullmatch(r"\d{1,3}", change):
            _run("wpctl", "set-volume", "-l", "1.0", "@DEFAULT_AUDIO_SINK@", f"{min(int(change), 100)}%")
        self.refresh()

    def power(self, verb: str) -> None:
        if verb in POWER:
            _detach(*POWER[verb])

    def open_tool(self, name: str) -> None:
        """A setting handed off: its own tool, in the user's terminal."""
        if name not in TOOLS:
            return
        terminal = os.environ.get("TERMINAL") or next(
            (t for t in ("ghostty", "kitty", "foot", "alacritty") if shutil.which(t)), None)
        if terminal:
            _detach(terminal, "-e", *TOOLS[name])
