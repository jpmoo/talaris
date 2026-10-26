# SPDX-License-Identifier: GPL-3.0-only
# Copyright (c) 2026 Jeff Moore
"""
Power: when the screen dims, locks, turns off, and the machine suspends — on
battery and plugged in — and what closing the lid does.

**Borrowed, not built** (DESIGN.md, "What Talaris borrows"): the idle timing
is hypridle's and the lock is hyprlock's. What Talaris adds is the page in
Settings and a hypridle file of its own, `~/.config/talaris/hypridle.conf`,
written from the settings — never the user's own `hypridle.conf` — and a
hypridle it runs with that file, as a child of this process.

**Plugged in or on battery** each have their times. hypridle reads one file
and has no notion of a charger, so Talaris watches the charger
(`/sys/class/power_supply/*/online`, for a supply of type Mains) and, when it
changes, writes the other set and starts hypridle again.

**The lid.** systemd-logind suspends on a closed lid unless something holds a
`handle-lid-switch` inhibitor, which a user in an active session may take
without asking. Talaris holds one (`systemd-inhibit … sleep infinity`, a child
of this process, so it goes when Talaris does) and acts on the lid itself,
through Hyprland's lid switch binds: suspend, lock, turn the screen off, or
nothing — set for plugged in, on battery, and with another screen attached,
which comes first.

**Off until switched on.** Two idle managers fight: each locks, each turns the
screen off. So Talaris runs its hypridle, and holds the lid, only when
Settings says Talaris manages power, and says so if another hypridle is
running alongside.
"""

from __future__ import annotations

import glob
import json
import os
import re
import subprocess

from PySide6.QtCore import QObject, QProcess, QTimer

import hypr
from config import CONFIG
from views import log

IDLE_FILE = os.path.join(os.path.dirname(CONFIG), "hypridle.conf")
#: Away this long, and the core is told it may read files (Settings, Data: Reading files, While idle).
IDLE_READ_SECONDS = 300
LID_ACTIONS = ("suspend", "lock", "screen-off", "nothing")
#: How often the charger is looked at. A file read; nothing to listen to without D-Bus.
WATCH_MS = 5000


def on_mains() -> bool:
    """Plugged in: any mains supply online. No mains supply at all (a desktop) counts as plugged in."""
    mains = [d for d in glob.glob("/sys/class/power_supply/*") if _read(os.path.join(d, "type")) == "Mains"]
    return not mains or any(_read(os.path.join(d, "online")) == "1" for d in mains)


def _read(path: str) -> str:
    try:
        with open(path, encoding="utf-8") as f:
            return f.read().strip()
    except OSError:
        return ""


def times(p: dict, plugged: bool) -> dict:
    """The idle times for now: the set for the charger's state, else the single set there was before."""
    flat = {k: p[k] for k in ("dim", "lock", "screenOff", "suspend") if k in p}
    return {**flat, **p.get("ac" if plugged else "battery", {})}


def _file(p: dict, plugged: bool) -> str:
    """The hypridle file for these settings: each step only if it has a time (0 is never)."""
    t = times(p, plugged)
    lines = [
        "# Written by Talaris from Settings, Power; changes here are overwritten.",
        f"# {'Plugged in' if plugged else 'On battery'}.",
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
    listener(int(t.get("dim", 0)), f"brightnessctl -s set {int(p.get('dimTo', 20))}%", "brightnessctl -r")
    listener(int(t.get("lock", 0)), "loginctl lock-session")
    listener(int(t.get("screenOff", 0)), "hyprctl dispatch dpms off", "hyprctl dispatch dpms on")
    listener(int(t.get("suspend", 0)), "systemctl suspend")
    # Away five minutes, and back: told to the core, which reads files then if Settings, Data says so ("While idle").
    sock = os.environ.get("TALARIS_SOCKET") or os.path.join(os.environ.get("XDG_RUNTIME_DIR", "/tmp"), "talaris.sock")
    tell = lambda idle: f"curl -s -m 5 --unix-socket {sock} -X POST -H 'content-type: application/json' -d '{{\"idle\":{idle}}}' http://talaris/meaning/idle"  # noqa: E731
    listener(IDLE_READ_SECONDS, tell("true"), tell("false"))
    return "\n".join(lines) + "\n"


# ------------------------------------------------------------ charging

def battery() -> str:
    """The battery's directory in sysfs, or empty."""
    found = [d for d in sorted(glob.glob("/sys/class/power_supply/*")) if _read(os.path.join(d, "type")) == "Battery"]
    return found[0] if found else ""


def charging() -> dict:
    """
    What the battery offers and is set to: its modes (`charge_types`, the
    bracketed one current), its start and stop limits, and whether this user
    may change them — which takes the udev rule in `systemd/`.
    """
    bat = battery()
    if not bat:
        return {"present": False}
    types = _read(os.path.join(bat, "charge_types")).split()
    files = [os.path.join(bat, f) for f in ("charge_types", "charge_control_start_threshold", "charge_control_end_threshold")]
    start, stop = _read(files[1]), _read(files[2])
    return {
        "present": True,
        "modes": [t.strip("[]") for t in types],
        "mode": next((t.strip("[]") for t in types if t.startswith("[")), ""),
        "start": int(start) if start.isdigit() else None,
        "stop": int(stop) if stop.isdigit() else None,
        "writable": all(os.access(f, os.W_OK) for f in files if os.path.exists(f)),
        "level": int(_read(os.path.join(bat, "capacity")) or 0),
    }


def set_charging(mode: str, start: int | None, stop: int | None) -> str:
    """Set the mode, and for Custom the limits. Answers why not, or nothing."""
    now = charging()
    if not now.get("present"):
        return "No battery"
    if not now["writable"]:
        return "Talaris may not change charging yet: install systemd/90-talaris-battery.rules"
    if mode not in now["modes"]:
        return "Not one of the battery's modes"
    bat = battery()
    try:
        if mode == "Custom" and start is not None and stop is not None:
            if not 50 <= start < stop <= 100:
                return "Start below stop, both from 50 to 100 percent"
            # The kernel keeps start below stop at every step: raise stop
            # first when going up, lower start first when going down.
            order = [("charge_control_end_threshold", stop), ("charge_control_start_threshold", start)]
            if stop < (now["stop"] or 100):
                order.reverse()
            for name, value in order:
                with open(os.path.join(bat, name), "w", encoding="utf-8") as f:
                    f.write(str(value))
        with open(os.path.join(bat, "charge_types"), "w", encoding="utf-8") as f:
            f.write(mode)
    except OSError as e:
        return f"The battery refused: {e.strerror}"
    return ""


def others() -> list[int]:
    """hypridle processes that are not Talaris's own."""
    try:
        out = subprocess.run(["pgrep", "-x", "hypridle"], capture_output=True, text=True, timeout=2).stdout
    except (OSError, subprocess.SubprocessError):
        return []
    return [int(pid) for pid in out.split()]


def _monitors() -> int:
    try:
        return len(json.loads(hypr.ask("j/monitors") or "[]"))
    except ValueError:
        return 1


class Power(QObject):
    def __init__(self, desktop) -> None:
        super().__init__(desktop)
        self.desktop = desktop
        self.process: QProcess | None = None
        self.inhibitor: QProcess | None = None
        self.plugged = on_mains()
        self.watch = QTimer(self)
        self.watch.timeout.connect(self._charger)

    def apply(self) -> None:
        """Write the file and run Talaris's hypridle, and hold the lid — or let both go, if Talaris does not manage power."""
        p = self.desktop.config["power"]
        if not p.get("managed"):
            self.stop()
            return
        self.plugged = on_mains()
        self._idle(p)
        self._hold_lid()
        self.watch.start(WATCH_MS)

    def _idle(self, p: dict) -> None:
        os.makedirs(os.path.dirname(IDLE_FILE), exist_ok=True)
        with open(IDLE_FILE, "w", encoding="utf-8") as f:
            f.write(_file(p, self.plugged))
        # hypridle reads its file once; a change is a new hypridle.
        self._stop_idle()
        self.process = QProcess(self)
        self.process.setProgram("hypridle")
        # Not quiet: when a step fired is worth having in the log ("did the
        # screen go off?" is otherwise unanswerable afterwards).
        self.process.setArguments(["-c", IDLE_FILE])
        self.process.setProcessChannelMode(QProcess.ProcessChannelMode.MergedChannels)
        self.process.readyReadStandardOutput.connect(self._heard)
        self.process.finished.connect(self._ended)
        self.process.start()
        log(f"power: hypridle running with Talaris's settings ({'plugged in' if self.plugged else 'on battery'})")

    def _ended(self, code: int, _status) -> None:
        """
        Talaris's hypridle stopped without being asked (killed, crashed): start
        it again — but never beside another hypridle, so two never fire the same
        timeouts. One someone started by hand is theirs; this waits for it to go.
        """
        if self.process is None or not self.desktop.config["power"].get("managed"):
            return
        self.process = None
        log(f"power: hypridle stopped ({code}); starting it again when no other is running")
        QTimer.singleShot(5000, self._again)

    def _again(self) -> None:
        if self.process is not None or not self.desktop.config["power"].get("managed"):
            return
        if subprocess.run(["pgrep", "-x", "hypridle"], capture_output=True).returncode == 0:
            QTimer.singleShot(60_000, self._again)
            return
        self._idle(self.desktop.config["power"])

    def _heard(self) -> None:
        """hypridle's own lines worth keeping: a step run, a return, a refusal."""
        if not self.process:
            return
        text = bytes(self.process.readAllStandardOutput()).decode("utf-8", "replace")
        for line in text.splitlines():
            if re.search(r"running|timeout|resume|inhibit|err|warn", line, re.I):
                log(f"power: hypridle: {line.strip()[:200]}")

    def _charger(self) -> None:
        now = on_mains()
        if now != self.plugged and self.desktop.config["power"].get("managed"):
            self.plugged = now
            self._idle(self.desktop.config["power"])

    # ------------------------------------------------------------ the lid

    def _hold_lid(self) -> None:
        if self.inhibitor and self.inhibitor.state() != QProcess.ProcessState.NotRunning:
            return
        self.inhibitor = QProcess(self)
        self.inhibitor.setProgram("systemd-inhibit")
        self.inhibitor.setArguments(["--what=handle-lid-switch", "--who=Talaris", "--why=Talaris acts on the lid, as Settings says",
                                     "--mode=block", "sleep", "infinity"])
        self.inhibitor.start()
        log("power: holding the lid switch")

    def lid(self, state: str) -> None:
        """The lid closed or opened (Hyprland's switch bind says which)."""
        if not self.holding():
            return
        if state == "open":
            hypr.ask("/dispatch dpms on")
            return
        lid = self.desktop.config["power"].get("lid", {})
        # Another screen first: closing the lid on a desk with a monitor is not leaving.
        which = "docked" if _monitors() > 1 else "ac" if on_mains() else "battery"
        action = lid.get(which, "nothing" if which == "docked" else "suspend")
        log(f"power: lid closed ({which}): {action}")
        if action == "suspend":
            subprocess.Popen(["systemctl", "suspend"], start_new_session=True)
        elif action == "lock":
            subprocess.Popen(["loginctl", "lock-session"], start_new_session=True)
        elif action == "screen-off":
            # With another screen, only the laptop's own goes dark.
            internal = next((m["name"] for m in json.loads(hypr.ask("j/monitors") or "[]")
                             if m["name"].startswith(("eDP", "LVDS", "DSI"))), "")
            hypr.ask(f"/dispatch dpms off {internal}" if which == "docked" and internal else "/dispatch dpms off")

    def holding(self) -> bool:
        return bool(self.inhibitor and self.inhibitor.state() == QProcess.ProcessState.Running)

    # ------------------------------------------------------------ stopping

    def _stop_idle(self) -> None:
        # Asked to stop: not an ending to recover from.
        process, self.process = self.process, None
        if process and process.state() != QProcess.ProcessState.NotRunning:
            process.finished.disconnect(self._ended)
            process.terminate()
            process.waitForFinished(2000)

    def stop(self) -> None:
        self.watch.stop()
        self._stop_idle()
        if self.inhibitor and self.inhibitor.state() != QProcess.ProcessState.NotRunning:
            self.inhibitor.terminate()
            self.inhibitor.waitForFinished(2000)
            log("power: the lid is logind's again")
        self.inhibitor = None

    def status(self) -> dict:
        mine = int(self.process.processId()) if self.process and self.process.state() == QProcess.ProcessState.Running else 0
        return {"managed": bool(self.desktop.config["power"].get("managed")), "running": bool(mine),
                "others": [pid for pid in others() if pid != mine], "plugged": on_mains(), "lid": self.holding()}
