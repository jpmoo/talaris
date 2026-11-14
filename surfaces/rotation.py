# SPDX-License-Identifier: GPL-3.0-only
# Copyright (c) 2026 Jeff Moore
"""
Turning with the device: a tablet, or a mini laptop, held another way round.

**Borrowed, not built**: iio-sensor-proxy reads the accelerometer and says
which way up the screen is — `normal`, `left-up`, `bottom-up`, `right-up`,
from its own mounting data — and `monitor-sensor` (its own small program)
prints each change. Talaris runs that program and reads its lines: no polling,
and no D-Bus binding of its own. The claim on the sensor is the logged-in
session's to make, which is where this runs.

**The screen and touch together.** Each orientation is a transform of the
built-in screen, asked of Hyprland while it runs (`keyword monitor`), and the
touchscreen's and the stylus's transform with it — without that a tap lands
where the screen was before it turned. hyprland.conf is not edited: its
monitor line is where the screen starts, and where it goes back to when this
is turned off. A config reload puts Hyprland's own back, so the orientation
is asked for again after one.

Only on a machine with an accelerometer: Settings shows the switch there and
nowhere else (`available`).
"""

from __future__ import annotations

import glob
import json
import re
import shutil

from PySide6.QtCore import QObject, QProcess, QTimer

import hypr
from config import save_config
from views import log

#: iio-sensor-proxy's orientations, as Wayland's output transforms: the panel's own way up is 0.
TRANSFORMS = {"normal": 0, "left-up": 1, "bottom-up": 2, "right-up": 3}
#: Built-in screens, by the names their connectors are given.
BUILT_IN = re.compile(r"^(eDP|DSI|LVDS)", re.I)


def available() -> bool:
    """Whether this machine can say which way up it is: an accelerometer, and iio-sensor-proxy's program to read it."""
    return bool(shutil.which("monitor-sensor")) and bool(glob.glob("/sys/bus/iio/devices/*/in_accel_x_raw"))


def _built_in() -> dict | None:
    """The built-in screen as Hyprland has it now, or None."""
    try:
        mons = json.loads(hypr.ask("j/monitors") or "[]")
    except ValueError:
        return None
    return next((m for m in mons if BUILT_IN.match(m.get("name", ""))), None)


class Rotation(QObject):
    def __init__(self, desktop) -> None:
        super().__init__(desktop)
        self.desktop = desktop
        self.process: QProcess | None = None
        #: The way up the sensor last said.
        self.orientation = ""
        #: The built-in screen's transform when this started: where it goes back to when turned off.
        self.home: int | None = None
        self._buffer = b""
        #: Held where it started (the bar's button), whatever the sensor says: a convertible's screen folded back on its
        #: hinge moves the screen and not the sensor, so it never hears it is a laptop again.
        self.locked = bool(desktop.config.get("screen", {}).get("rotateLocked"))
        # A device being turned passes through ways up on its way: the last one, once it has settled.
        self._settle = QTimer(self)
        self._settle.setSingleShot(True)
        self._settle.setInterval(350)
        self._settle.timeout.connect(self._turn)
        desktop.events.reloaded.connect(lambda: self.on() and self.orientation and self._settle.start())

    def on(self) -> bool:
        return bool(self.desktop.config.get("screen", {}).get("rotate")) and available()

    def apply(self) -> None:
        """As Settings says: reading the sensor and turning with it, or not — and back as it started."""
        if self.on():
            if self.process is None:
                self._start()
            return
        if self.process is not None:
            self.process.kill()
            self.process = None
        if self.home is not None:
            self._set(self.home)
            self.home = None
        self.orientation = ""

    def _start(self) -> None:
        mon = _built_in()
        if mon is None:
            log("rotation: no built-in screen")
            return
        self.home = int(mon.get("transform", 0))
        self.process = QProcess(self)
        self.process.setProgram("monitor-sensor")
        self.process.setArguments(["--accel"])
        self.process.readyReadStandardOutput.connect(self._read)
        self.process.finished.connect(self._gone)
        self.process.start()
        log("rotation: following the accelerometer")

    def _gone(self, code: int, _status) -> None:
        if self.process is not None:
            log(f"rotation: monitor-sensor stopped ({code})")
            self.process = None

    def _read(self) -> None:
        if self.process is None:
            return
        self._buffer += bytes(self.process.readAllStandardOutput())
        *lines, self._buffer = self._buffer.split(b"\n")
        for line in lines:
            text = line.decode("utf-8", "replace")
            # "=== Has accelerometer (orientation: normal)" at the start; "Accelerometer orientation changed: left-up" after.
            m = re.search(r"orientation(?: changed)?:\s*([a-z-]+)", text)
            if m and m.group(1) in TRANSFORMS:
                self.orientation = m.group(1)
                self._settle.start()
            elif "Failed to claim" in text or "No accelerometer" in text:
                log(f"rotation: {text.strip()}")

    def _turn(self) -> None:
        if not self.on() or self.locked or self.orientation not in TRANSFORMS:
            return
        self._set(TRANSFORMS[self.orientation])

    def toggle_lock(self) -> None:
        """Held where it started — the screen put back there now — or following the device again."""
        if not self.on():
            return
        self.locked = not self.locked
        # Kept: a restart (or a login) holds it as it was, rather than turning to whatever the sensor says first.
        self.desktop.config.setdefault("screen", {})["rotateLocked"] = self.locked
        save_config(self.desktop.config)
        if self.locked:
            if self.home is not None:
                self._set(self.home)
        else:
            self._turn()
        self.desktop.bar.bridge.state.emit(json.dumps(self.desktop.bar.describe()))

    def describe(self) -> dict:
        """For the bar's button: shown while this follows the device, and whether it is held."""
        return {"on": self.on(), "locked": self.locked}

    def _set(self, transform: int) -> None:
        """The built-in screen at this transform, and its touchscreen and stylus with it."""
        mon = _built_in()
        if mon is None:
            return
        name = mon["name"]
        if int(mon.get("transform", 0)) != transform:
            # Its mode, place and scale as they are: only the way round changes.
            mode = f"{mon['width']}x{mon['height']}@{mon['refreshRate']:.3f}"
            hypr.keyword("monitor", f"{name},{mode},{mon['x']}x{mon['y']},{mon['scale']:g},transform,{transform}")
        for device in ("touchdevice", "tablet"):
            hypr.keyword(f"input:{device}:output", name)
            hypr.keyword(f"input:{device}:transform", str(transform))
        log(f"rotation: {self.orientation or 'back'} (transform {transform})")
