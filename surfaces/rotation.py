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

Following the device only on a machine with an accelerometer: Settings shows
the switch there and nowhere else (`available`). The bar's button, which turns
the screen a quarter by hand, is wherever there is a built-in screen to turn
(`can_turn`) — a panel on a Pi has no sensor — and on the bar as Settings, Bar
says: by itself where a sensor turns the screen, by choice elsewhere.
"""

from __future__ import annotations

import glob
import json
import os
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


#: The firmware's tablet-mode switch, as Linux names it: on the mini, Intel's HID driver, once told to report it
#: (`options intel_hid enable_sw_tablet_mode=1`). It appears only at the first fold after the driver starts.
TABLET_SWITCHES = ("Intel HID switches", "Tablet Mode Switch")
TALARIS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "talaris-surfaces")


def tablet_switch() -> bool:
    """Whether this machine says when it is a tablet: Intel's driver told to, or such a switch already there."""
    try:
        if open("/sys/module/intel_hid/parameters/enable_sw_tablet_mode").read().strip() in ("1", "Y"):
            return True
    except OSError:
        pass
    try:
        names = [x.get("name", "") for x in json.loads(hypr.ask("j/devices") or "{}").get("switches", [])]
    except ValueError:
        return False
    return any(n in TABLET_SWITCHES for n in names)


def _tablet_device() -> str | None:
    """The tablet switch's event device (/dev/input/eventN), by its name in the kernel's list of inputs."""
    try:
        text = open("/proc/bus/input/devices").read()
    except OSError:
        return None
    for block in text.split("\n\n"):
        if any(f'Name="{n}"' in block for n in TABLET_SWITCHES):
            m = re.search(r"Handlers=.*?\b(event\d+)", block)
            if m:
                return f"/dev/input/{m.group(1)}"
    return None


def tablet_now() -> bool | None:
    """
    Whether the machine is folded back right now, read from the switch itself — None when that cannot be read
    (no such switch yet, or not this user's to read: install.sh gives the seat's user the tablet switch).
    Asked at start and after every wake: a fold or unfold while asleep is never sent, and a mini that went to
    sleep folded woke up open still taken for a tablet, its keyboard switched off by its firmware.
    """
    path = _tablet_device()
    if not path:
        return None
    import fcntl  # noqa: PLC0415
    size = 8
    request = (2 << 30) | (size << 16) | (ord("E") << 8) | 0x1B  # EVIOCGSW(size)
    try:
        with open(path, "rb") as f:
            bits = bytearray(size)
            fcntl.ioctl(f, request, bits)
    except OSError:
        return None
    return bool(bits[0] & (1 << 1))  # SW_TABLET_MODE


def flat() -> bool:
    """
    Whether the accelerometer lies flat — gravity nearly all on its z axis — and so cannot say which way is up.
    On the mini the sensor is in the keyboard half: open as a laptop on a desk it lies flat, and iio-sensor-proxy,
    with nothing to go on, says `normal` (the panel's own way, portrait). A flat reading is not obeyed: the screen
    stays as it is until the device is tilted up. Read from the sensor's own files, which need no claim.
    """
    for d in glob.glob("/sys/bus/iio/devices/*/"):
        try:
            x, y, z = (float(open(f"{d}in_accel_{a}_raw").read()) for a in "xyz")
        except (OSError, ValueError):
            continue
        # Within about 25° of lying flat.
        return z * z > 4 * (x * x + y * y)
    return False


def can_turn() -> bool:
    """Whether there is a built-in screen to turn by the bar's button: with a sensor or without (a panel on a Pi)."""
    return _built_in() is not None


def _built_in() -> dict | None:
    """The built-in screen as Hyprland has it now, or None."""
    try:
        mons = json.loads(hypr.ask("j/monitors") or "[]")
    except ValueError:
        return None
    return next((m for m in mons if BUILT_IN.match(m.get("name", ""))), None)



def say_turn(transform: int) -> None:
    """
    The screen's turn, written where the pen helper reads it (setup/pen/talaris-pen): it gives the pen as a pointer,
    which Hyprland does not turn as it turns a pen, so it turns it itself.
    """
    path = os.path.join(os.environ.get("XDG_RUNTIME_DIR") or f"/run/user/{os.getuid()}", "talaris-turn")
    try:
        with open(path + ".tmp", "w") as f:
            f.write(str(int(transform) % 4))
        os.chmod(path + ".tmp", 0o644)
        os.replace(path + ".tmp", path)
    except OSError:
        pass

class Rotation(QObject):
    def __init__(self, desktop) -> None:
        super().__init__(desktop)
        # Said at once, as the screen is now: the pen helper turns the pen by it (`say_turn`).
        mon = _built_in()
        if mon is not None:
            say_turn(int(mon.get("transform", 0)))
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
        #: Folded back into a tablet, as the firmware's switch says (`tablet`). Until it first says, a laptop.
        self.tablet = False
        self.switch = False
        # A device being turned passes through ways up on its way: the last one, once it has settled.
        self._settle = QTimer(self)
        self._settle.setSingleShot(True)
        self._settle.setInterval(350)
        self._settle.timeout.connect(self._turn)
        desktop.events.reloaded.connect(self._reloaded)

    def _reloaded(self) -> None:
        # A config reload drops runtime binds, and puts Hyprland's own transform back.
        if self.switch:
            self._bind_switch()
        if self.on() and self.orientation:
            self._settle.start()

    def _bind_switch(self) -> None:
        for name in TABLET_SWITCHES:
            hypr.bind(f", switch:on:{name}", f"{TALARIS} --tablet on", "l")
            hypr.bind(f", switch:off:{name}", f"{TALARIS} --tablet off", "l")

    def recheck(self) -> None:
        """Folded or not, read from the switch itself: at start, and after a wake (power.py's after_sleep_cmd)."""
        now = tablet_now()
        if now is not None:
            self.tablet_mode(now)

    def tablet_mode(self, on: bool) -> None:
        """
        Folded back into a tablet, or a laptop again (the switch's binds). A tablet follows the device, whatever a
        press of the button held; a laptop is put back the way it started, and the sensor — in its base, lying
        flat or tilted with the desk — is not followed.
        """
        if on == self.tablet:
            return
        self.tablet = on
        log(f"rotation: {'a tablet' if on else 'a laptop'}")
        import keyboard  # noqa: PLC0415 — the desktop's, made after this
        if keyboard.current is not None:
            keyboard.current.set_auto(on)
        if on:
            if self.locked:
                self._release()
            self._turn()
        elif self.home is not None and not self.locked:
            self.orientation = ""
            self._set(self.home)

    def on(self) -> bool:
        return bool(self.desktop.config.get("screen", {}).get("rotate")) and available()

    def apply(self) -> None:
        """As Settings says: reading the sensor and turning with it, or not; and a screen turned by hand kept turned."""
        if self.on():
            if self.process is None:
                self._start()
            # Where the machine says when it is a tablet, that decides when the device is followed (tablet_mode).
            if not self.switch and tablet_switch():
                self.switch = True
                self._bind_switch()
                self.recheck()
        else:
            if self.process is not None:
                self.process.kill()
                self.process = None
            self.orientation = ""
        turned = self.desktop.config.get("screen", {}).get("turned")
        # Turned by the button, with a sensor or without: kept turned across restarts.
        if self.locked and isinstance(turned, int):
            self._set(turned)

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
        if not self.on() or self.orientation not in TRANSFORMS:
            return
        # A laptop, as its switch says: the sensor in its base is not followed.
        if self.switch and not self.tablet:
            return
        if self.locked:
            # Held by the button only until the device itself turns: a way up other than the one it had when the
            # button was pressed, and not lying flat, lets the hold go and is followed.
            held_from = self.desktop.config.get("screen", {}).get("heldFrom")
            if not held_from or self.orientation == held_from or flat():
                return
            self._release()
        if flat():
            # Its report means nothing lying flat; looked at again in a moment, in case it is being lifted.
            self._settle.start(1500)
            return
        self._set(TRANSFORMS[self.orientation])

    def turn_once(self) -> None:
        """
        The bar's button: the screen turned a quarter, clockwise, and held there — until the device itself is
        turned some other way (_turn), or its long press follows the device at once (`follow`). Kept across
        restarts, where it was turned to.
        """
        mon = _built_in()
        if mon is None:
            return
        transform = (int(mon.get("transform", 0)) + 3) % 4
        self.locked = True
        screen = self.desktop.config.setdefault("screen", {})
        screen["rotateLocked"], screen["turned"] = True, transform
        # Which way up the device was as it was pressed: held until it is turned some other way (_turn).
        if self.orientation:
            screen["heldFrom"] = self.orientation
        else:
            screen.pop("heldFrom", None)
        save_config(self.desktop.config)
        self._set(transform)
        self.desktop.bar.bridge.state.emit(json.dumps(self.desktop.bar.describe()))

    def _release(self) -> None:
        """The button's hold let go: following the device's own way up again."""
        self.locked = False
        screen = self.desktop.config.setdefault("screen", {})
        screen["rotateLocked"] = False
        screen.pop("turned", None)
        screen.pop("heldFrom", None)
        save_config(self.desktop.config)

    def follow(self) -> None:
        """Following the device's own way up again (the button's long press, while Turn with the device is on)."""
        self._release()
        self._turn()
        self.desktop.bar.bridge.state.emit(json.dumps(self.desktop.bar.describe()))

    def describe(self) -> dict:
        """
        For the bar's button: there wherever there is a built-in screen to turn (`on`), shown by Settings, Bar — by
        itself where a sensor turns it (`sensor`), by choice elsewhere; whether it follows the device, and is held.
        """
        return {"on": can_turn(), "sensor": available(), "auto": self.on(), "locked": self.locked}

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
        say_turn(transform)
        log(f"rotation: {self.orientation or 'back'} (transform {transform})")
