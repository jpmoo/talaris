# SPDX-License-Identifier: GPL-3.0-only
# Copyright (c) 2026 Jeff Moore
"""
The machine, as the bar shows it: volume, network, Bluetooth, battery.

Read from the tools already here — `wpctl`, `nmcli`, `bluetoothctl` and
`/sys` — rather than from D-Bus libraries that would each be a dependency and
a binding to keep working. A poll every few seconds, off the GUI thread, is
what that costs; each read is a few milliseconds of a small process.

And what the bar can do to it: the volume, the power menu, and Wi-Fi and
Bluetooth — joining a network, connecting a device — still through `nmcli`
and `bluetoothctl` rather than rebuilt. Anything those panels cannot say (an
enterprise network's certificates, a device that wants a PIN confirmed) goes
to the full tool in a terminal, as everything did in the first pass.
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


# ---------------------------------------------------------------- Wi-Fi and Bluetooth

def _fields(line: str) -> list[str]:
    """One line of `nmcli -t`: colon-separated, with colons inside a value escaped."""
    out, cur, esc = [], "", False
    for ch in line:
        if esc:
            cur += ch
            esc = False
        elif ch == "\\":
            esc = True
        elif ch == ":":
            out.append(cur)
            cur = ""
        else:
            cur += ch
    out.append(cur)
    return out


def wifi_state(rescan: bool = False) -> dict:
    on = _run("nmcli", "radio", "wifi").strip() == "enabled"
    if not on:
        return {"on": False, "networks": []}
    known = {}
    active = None
    # Every network this machine remembers, in range or not: Settings lists
    # them, with whether each is joined by itself.
    saved = []
    for line in _run("nmcli", "-t", "-f", "NAME,UUID,TYPE,AUTOCONNECT,DEVICE", "connection", "show").splitlines():
        f = _fields(line)
        if len(f) >= 5 and f[2] == "802-11-wireless":
            known[f[0]] = True
            saved.append({"name": f[0], "uuid": f[1], "autoconnect": f[3] == "yes", "active": bool(f[4])})
            if f[4]:
                active = f[0]
    seen: dict[str, dict] = {}
    rows = _run("nmcli", "-t", "-f", "IN-USE,SSID,SIGNAL,SECURITY", "dev", "wifi", "list",
                # NetworkManager scans by itself every so often; only Rescan asks it to now.
                "--rescan", "yes" if rescan else "no", timeout=20 if rescan else 4).splitlines()
    for line in rows:
        f = _fields(line)
        if len(f) < 4 or not f[1]:
            continue
        ssid, security = f[1], f[3].strip()
        try:
            signal = int(f[2])
        except ValueError:
            signal = 0
        n = seen.get(ssid)
        # One row per name: the strongest of its access points.
        if n and n["signal"] >= signal and not f[0] == "*":
            continue
        seen[ssid] = {
            "ssid": ssid, "signal": signal, "secure": bool(security and security != "--"),
            # A network this panel cannot join with a password alone.
            "enterprise": "802.1X" in security, "known": ssid in known,
            "connected": f[0] == "*" or (n or {}).get("connected", False),
        }
    networks = sorted(seen.values(), key=lambda n: (not n["connected"], not n["known"], -n["signal"]))
    for s in saved:
        s["inRange"] = s["name"] in seen
        s["signal"] = seen.get(s["name"], {}).get("signal")
    saved.sort(key=lambda s: (not s["active"], not s["inRange"], s["name"].lower()))
    return {"on": True, "active": active, "networks": networks, "saved": saved}


def _bt_info(mac: str) -> dict:
    info = _run("bluetoothctl", "info", mac)
    get = lambda key: (re.search(rf"^\s*{key}:\s*(.+)$", info, re.M) or [None, ""])[1].strip()
    battery = re.search(r"Battery Percentage:.*\((\d+)\)", info)
    return {"connected": get("Connected") == "yes", "icon": get("Icon"), "trusted": get("Trusted") == "yes",
            "battery": int(battery.group(1)) if battery else None}


def _bt_devices(which: str = "") -> list[tuple[str, str]]:
    found = []
    for line in _run("bluetoothctl", "devices", *([which] if which else [])).splitlines():
        parts = line.split(" ", 2)
        if len(parts) == 3 and parts[0] == "Device":
            found.append((parts[1], parts[2]))
    return found


_MAC = re.compile(r"^[0-9A-F]{2}(:[0-9A-F]{2}){5}$", re.I)


def bluetooth_state(scan_seconds: int = 0) -> dict:
    show = _run("bluetoothctl", "show")
    if not show:
        return {"present": False}
    on = bool(re.search(r"Powered:\s*yes", show))
    visible = bool(re.search(r"Discoverable:\s*yes", show))
    alias = (re.search(r"^\s*Alias:\s*(.+)$", show, re.M) or [None, ""])[1].strip()
    if not on:
        return {"present": True, "on": False, "visible": False, "alias": alias, "paired": [], "nearby": []}
    if scan_seconds:
        _run("bluetoothctl", "--timeout", str(scan_seconds), "scan", "on", timeout=scan_seconds + 5)
    paired = [{"mac": mac, "name": name, **_bt_info(mac)} for mac, name in _bt_devices("Paired")]
    taken = {d["mac"] for d in paired}
    # Nearby: what a scan turned up and is not already yours. A device with
    # no name shows its address as its name, and is not worth a row.
    nearby = [{"mac": mac, "name": name} for mac, name in _bt_devices()
              if mac not in taken and name.replace("-", ":").upper() != mac.upper()]
    return {"present": True, "on": True, "visible": visible, "alias": alias, "paired": paired, "nearby": nearby}


class _Panel(QRunnable):
    """A panel's slow work — a scan, a connection — off the screen's thread."""

    def __init__(self, machine: "Machine", kind: str, work) -> None:
        super().__init__()
        self.machine, self.kind, self.work = machine, kind, work

    def run(self) -> None:
        error = ""
        try:
            error = self.work() or ""
        except Exception as e:  # noqa: BLE001 — whatever went wrong is shown, not raised
            error = str(e)
        state = wifi_state() if self.kind == "network" else bluetooth_state()
        self.machine.panel.emit(json.dumps({"kind": self.kind, "state": state, "error": error}))
        self.machine.refresh()


def _ran(*cmd: str, timeout: float = 30) -> str:
    """Run it; answer the tool's own complaint if it failed, empty if it did not."""
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        return "That took too long"
    except OSError as e:
        return str(e)
    if r.returncode == 0 and "failed" not in r.stdout.lower():
        return ""
    text = (r.stderr or r.stdout).strip().splitlines()
    # nmcli says "Error: …"; the last line is the reason.
    return (text[-1] if text else "It did not work").removeprefix("Error: ")


class Machine(QObject):
    """One reading of the machine, shared by every surface that shows it."""

    #: The latest reading, as JSON — emitted from a worker, delivered on the GUI thread.
    read = Signal(str)
    #: A panel's state after it was read or acted on: `{kind, state, error}`.
    panel = Signal(str)

    def __init__(self, parent: QObject | None = None) -> None:
        super().__init__(parent)
        self.last = "{}"
        self.read.connect(self._keep)
        self._pool = QThreadPool(self)
        self._pool.setMaxThreadCount(1)
        self._panels = QThreadPool(self)
        self._panels.setMaxThreadCount(2)
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

    # ------------------------------------------------------------ the panels

    def panel_read(self, kind: str, deep: bool = False) -> None:
        """Read a panel's state — `deep` rescans Wi-Fi, or scans for Bluetooth devices."""
        def work() -> str:
            # The scan's own result is read again by `_Panel`; this only makes it happen.
            if deep and kind == "network":
                wifi_state(rescan=True)
            elif deep and kind == "bluetooth":
                bluetooth_state(scan_seconds=8)
            return ""

        if kind in ("network", "bluetooth"):
            self._panels.start(_Panel(self, kind, work))

    def network(self, r: dict) -> None:
        verb, ssid = r.get("verb"), str(r.get("ssid", ""))
        if verb == "power":
            work = lambda: _ran("nmcli", "radio", "wifi", "on" if r.get("on") else "off")
        elif verb == "join" and ssid:
            password = str(r.get("password", ""))
            if r.get("known"):
                work = lambda: _ran("nmcli", "connection", "up", "id", ssid, timeout=45)
            elif password:
                # nmcli takes the password as an argument; it is on this machine's
                # process list for the moment the join takes, and nowhere else.
                work = lambda: _ran("nmcli", "device", "wifi", "connect", ssid, "password", password, timeout=45)
            else:
                work = lambda: _ran("nmcli", "device", "wifi", "connect", ssid, timeout=45)
        elif verb == "leave" and ssid:
            work = lambda: _ran("nmcli", "connection", "down", "id", ssid)
        elif verb == "forget" and (ssid or r.get("uuid")):
            # By its uuid where Settings has one: two saved networks may share a name.
            uuid = str(r.get("uuid", ""))
            work = (lambda: _ran("nmcli", "connection", "delete", "uuid", uuid)) if uuid else (lambda: _ran("nmcli", "connection", "delete", "id", ssid))
        elif verb == "auto" and r.get("uuid"):
            uuid = str(r["uuid"])
            work = lambda: _ran("nmcli", "connection", "modify", "uuid", uuid, "connection.autoconnect", "yes" if r.get("on") else "no")
        else:
            return
        self._panels.start(_Panel(self, "network", work))

    def bluetooth(self, r: dict) -> None:
        verb, mac = r.get("verb"), str(r.get("mac", ""))
        if verb == "power":
            work = lambda: _ran("bluetoothctl", "power", "on" if r.get("on") else "off")
        elif verb == "visible":
            # Seen by other devices looking to pair, for as long as bluetoothd allows (three minutes, usually).
            work = lambda: _ran("bluetoothctl", "discoverable", "on" if r.get("on") else "off")
        elif mac and _MAC.match(mac) and verb in ("trust", "untrust"):
            work = lambda: _ran("bluetoothctl", verb, mac)
        elif mac and _MAC.match(mac) and verb in ("connect", "disconnect", "forget", "pair"):
            if verb == "pair":
                # Pair, trust so it may come back by itself, then connect. A
                # device that wants a PIN confirmed needs the full tool.
                work = lambda: (_ran("bluetoothctl", "--timeout", "20", "pair", mac, timeout=25)
                                or _ran("bluetoothctl", "trust", mac)
                                or _ran("bluetoothctl", "--timeout", "15", "connect", mac, timeout=20))
            elif verb == "forget":
                work = lambda: _ran("bluetoothctl", "remove", mac)
            else:
                work = lambda: _ran("bluetoothctl", "--timeout", "15", verb, mac, timeout=20)
        else:
            return
        self._panels.start(_Panel(self, "bluetooth", work))
