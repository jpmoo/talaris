# SPDX-License-Identifier: GPL-3.0-only
# Copyright (c) 2026 Jeff Moore
"""
Where you are, and what Talaris does with it — **all off until Location is on**
(Settings, Location), and each use a switch of its own.

- **Applications asking** (locationd.py, GeoClue's agent): an application
  wanting your location asks Talaris, and Talaris asks you — Allow once,
  Always, Don't allow — remembered per application, each one taken back in
  Settings. While anything but Talaris is looking, the bar shows it.
- **Talaris's own fix**, at a city's accuracy, every half hour while on: kept
  rounded to about a kilometre, and only on this machine (config.json).
- **Light and dark by the sun**: the theme set dark at sunset and light at
  sunrise, worked out here (sun.py).
- **Night light**: the screen warmed after sunset, gradually, by a shader of
  Hyprland's (nothing to install), and back after sunrise.
- **Weather by the clock**: sky and temperature, from Open-Meteo — asked with
  the rounded fix and nothing else, no account and no key.
- **The time zone, kept**: the zone where you are (Open-Meteo says it with the
  weather) made the system's when it changes — and the calendar, the core and
  Morgan told. Setting the system's zone needs, once, the rule
  setup/location.sh adds; without it, each change would ask for a password.
- **Morgan may know** roughly where you are, when switched on: through
  Talaris's MCP, to Morgan's own client only, and never passed to the Oracle.
"""

from __future__ import annotations

import json
import locale
import math
import os
import shutil
import subprocess
import sys
import threading
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone

from PySide6.QtCore import QObject, QProcess, QTimer, Signal

import core
import hypr
import spawn
from config import save_config
from sun import is_day, next_change
from views import log

HERE = os.path.dirname(os.path.abspath(__file__))
SETUP = os.path.join(os.path.dirname(HERE), "setup", "location.sh")
#: What set up writes first: there, and the setup has been done (however it was run).
AGENT_CONF = "/etc/geoclue/conf.d/90-talaris.conf"
DEFAULTS = {"on": False, "apps": {}, "weather": True, "units": "auto", "zone": True,
            "sunTheme": False, "nightLight": False, "warmth": 4000, "morgan": False,
            # Where Talaris takes you to be: found ("auto"), or a place you chose ("hand": `place`).
            "by": "auto", "place": None,
            # Places known by their Wi-Fi: on one of these networks, that place — exactly, where a guess cannot be.
            "places": []}
#: How often the Wi-Fi in use is looked at, for a known place arrived at or left.
NETWORK_EVERY_MS = 2 * 60 * 1000
#: A fix this rough came from the internet address, not from Wi-Fi: said so, not taken as a distance.
COARSE_M = 15000
FIX_EVERY_MS = 30 * 60 * 1000
WEATHER_EVERY_MS = 20 * 60 * 1000
TICK_MS = 60 * 1000
#: Night light comes on over this long before sunset, and goes over this long after sunrise.
RAMP_S = 45 * 60
SHADER = os.path.join(os.environ.get("XDG_RUNTIME_DIR", f"/run/user/{os.getuid()}"), "talaris-night.frag")
#: Countries whose weather is told in Fahrenheit.
FAHRENHEIT = {"US", "LR", "MM", "BS", "KY", "PW", "FM", "MH"}
ACCURACY = {1: "your country", 4: "your city", 5: "your neighbourhood", 6: "your street", 8: "exactly where you are"}

#: WMO weather codes (Open-Meteo's): what the sky is doing, and the bar's icon for it.
SKY = {0: ("Clear", "clear"), 1: ("Mostly clear", "clear"), 2: ("Partly cloudy", "partly"), 3: ("Cloudy", "cloud"),
       45: ("Fog", "fog"), 48: ("Fog", "fog"), 51: ("Drizzle", "rain"), 53: ("Drizzle", "rain"), 55: ("Drizzle", "rain"),
       56: ("Freezing drizzle", "rain"), 57: ("Freezing drizzle", "rain"), 61: ("Light rain", "rain"), 63: ("Rain", "rain"),
       65: ("Heavy rain", "rain"), 66: ("Freezing rain", "rain"), 67: ("Freezing rain", "rain"), 71: ("Light snow", "snow"),
       73: ("Snow", "snow"), 75: ("Heavy snow", "snow"), 77: ("Snow grains", "snow"), 80: ("Showers", "rain"),
       81: ("Showers", "rain"), 82: ("Heavy showers", "rain"), 85: ("Snow showers", "snow"), 86: ("Snow showers", "snow"),
       95: ("Thunderstorm", "storm"), 96: ("Thunderstorm, hail", "storm"), 99: ("Thunderstorm, hail", "storm")}


def warm_rgb(kelvin: int) -> tuple[float, float, float]:
    """A colour temperature as what to multiply red, green and blue by (6500 K: nothing changed). Tanner Helland's fit."""
    t = max(1000, min(6500, kelvin)) / 100
    r = 1.0 if t <= 66 else min(1.0, 329.698727446 * ((t - 60) ** -0.1332047592) / 255)
    g = (99.4708025861 * math.log(t) - 161.1195681661) / 255 if t <= 66 else 288.1221695283 * ((t - 60) ** -0.0755148492) / 255
    b = 1.0 if t >= 66 else (0.0 if t <= 19 else (138.5177312231 * math.log(t - 10) - 305.0447927307) / 255)
    return max(0.0, min(1.0, r)), max(0.0, min(1.0, g)), max(0.0, min(1.0, b))


def _fingerprint() -> bool:
    """A finger enrolled for you (fprintd): polkit's password windows then wait for it before a password."""
    try:
        listed = subprocess.run(["fprintd-list", os.environ.get("USER", "")], capture_output=True, text=True, timeout=5).stdout
    except (OSError, subprocess.SubprocessError):
        return False
    return " - #" in listed


#: US states by their postal abbreviations, for "Clinton, NJ".
STATES = dict(zip("AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY".split(),
                  ["Alabama", "Alaska", "Arizona", "Arkansas", "California", "Colorado", "Connecticut", "Delaware", "District of Columbia", "Florida",
                   "Georgia", "Hawaii", "Idaho", "Illinois", "Indiana", "Iowa", "Kansas", "Kentucky", "Louisiana", "Maine", "Maryland", "Massachusetts",
                   "Michigan", "Minnesota", "Mississippi", "Missouri", "Montana", "Nebraska", "Nevada", "New Hampshire", "New Jersey", "New Mexico",
                   "New York", "North Carolina", "North Dakota", "Ohio", "Oklahoma", "Oregon", "Pennsylvania", "Rhode Island", "South Carolina",
                   "South Dakota", "Tennessee", "Texas", "Utah", "Vermont", "Virginia", "Washington", "West Virginia", "Wisconsin", "Wyoming"]))


def find_places(query: str) -> list[dict]:
    """
    Places by name, for where you are: Open-Meteo's geocoding, told only what
    was typed. It finds by the name alone and ranks by size, so a small town
    sits behind bigger ones of its name: asked for a hundred, and what comes
    after a comma ("Clinton, NJ", "Clinton, Hunterdon", "Paris, France")
    keeps those it names. Each said with its county, so two of a name in one
    state are told apart.
    """
    name, _, rest = query.strip()[:120].partition(",")
    wants = [w.strip().lower() for w in rest.split(",") if w.strip()]
    wants = [STATES.get(w.upper(), w).lower() for w in wants]
    q = urllib.parse.urlencode({"name": name.strip(), "count": 100, "language": "en", "format": "json"})
    try:
        with urllib.request.urlopen(f"https://geocoding-api.open-meteo.com/v1/search?{q}", timeout=12) as reply:
            got = json.loads(reply.read().decode("utf-8")).get("results") or []
    except Exception:  # noqa: BLE001 — offline, or the service down: nothing found
        return []

    def says(p: dict) -> list[str]:
        county = p.get("admin2", "")
        county = county if not county or county.endswith(("County", "Parish", "Borough")) or p.get("country_code") != "US" else f"{county} County"
        return [x for x in (p.get("name"), county, p.get("admin1"), p.get("country")) if x]

    def named(p: dict) -> bool:
        held = " ".join(says(p) + [p.get("country_code", ""), p.get("admin2", "")]).lower()
        return all(w in held for w in wants)
    found = [p for p in got if "latitude" in p and named(p)][:8]
    return [{"name": ", ".join(says(p)), "lat": round(float(p["latitude"]), 2), "lon": round(float(p["longitude"]), 2)} for p in found]


def _fingerprint() -> bool:
    """A finger enrolled for you (fprintd): polkit's password windows then wait for it before a password."""
    try:
        listed = subprocess.run(["fprintd-list", os.environ.get("USER", "")], capture_output=True, text=True, timeout=5).stdout
    except (OSError, subprocess.SubprocessError):
        return False
    return " - #" in listed


def _system_zone() -> str:
    try:
        return os.path.realpath("/etc/localtime").split("zoneinfo/", 1)[1]
    except (OSError, IndexError):
        return ""


class Location(QObject):
    #: Something the bar or Settings shows changed: the weather, in use, the agent, a fix.
    changed = Signal()
    _fetched = Signal(str)
    #: The forecast for the weather popup, as its page takes it ({"kind": "weather", "state", "error"}).
    forecast_ready = Signal(str)
    #: The whole forecast, for the calendar's days and hours ({"state", "error"}).
    calendar_weather = Signal(str)
    _forecast_fetched = Signal(str, str)
    _set_up = Signal(int, str)
    _finger = Signal()
    _network_seen = Signal(str)
    _zone_set = Signal(str, str)

    def __init__(self, desktop) -> None:
        super().__init__(desktop)
        self.desktop = desktop
        #: GeoClue's agent: "on", "refused" (setup/location.sh not run), "absent" (no GeoClue), or "" not yet known.
        self.agent = ""
        self.in_use = False
        self.locating = False
        self.weather: dict | None = None
        self.warmth = 6500
        #: The sun up or down at the last look, for the theme: set as it changes, not every minute — a mode you
        #: choose yourself stands until the next sunrise or sunset.
        self._sun_was: bool | None = None
        self.process: QProcess | None = None
        self._buffer = b""
        self._restarts = 0
        self._fetched.connect(self._got_weather)
        self._zone_set.connect(self._zone_done)
        self._set_up.connect(self._setup_done)
        self._finger.connect(lambda: self.desktop.notifications.own(
            "Touch the fingerprint reader", "The password window is waiting for your finger first.", [], lambda _k: None))
        self._forecast_fetched.connect(self._fetched_forecast)
        #: The Wi-Fi in use and the routers in reach, as last looked at (look_at_network).
        self.network: dict = {"ssid": "", "bssids": []}
        self._network_seen.connect(self._got_network)
        self._outlook: dict | None = None
        self._start()
        self._fixes = QTimer(self)
        self._fixes.timeout.connect(self.locate)
        self._fixes.start(FIX_EVERY_MS)
        self._weathers = QTimer(self)
        self._weathers.timeout.connect(self.fetch)
        self._weathers.start(WEATHER_EVERY_MS)
        self._tick = QTimer(self)
        self._tick.timeout.connect(self.daylight)
        self._tick.start(TICK_MS)
        self._networks = QTimer(self)
        self._networks.timeout.connect(lambda: self.on() and self.look_at_network())
        self._networks.start(NETWORK_EVERY_MS)
        QTimer.singleShot(4000, self.configured)

    # ------------------------------------------------------------ settings

    def settings(self) -> dict:
        return {**DEFAULTS, **self.desktop.config.get("location", {})}

    def on(self) -> bool:
        return bool(self.settings()["on"])

    def last(self) -> dict | None:
        """
        Where you are, as Talaris takes it: the place you chose, set by hand;
        else the place you named for the Wi-Fi in use; else the last fix.
        """
        s = self.settings()
        place = s.get("place")
        if s.get("by") == "hand" and isinstance(place, dict) and "lat" in place:
            return {"lat": place["lat"], "lon": place["lon"], "accuracy": 1000, "at": place.get("at", 0), "name": place.get("name", ""), "hand": True}
        known = self.known_place()
        if known:
            return {"lat": known["lat"], "lon": known["lon"], "accuracy": 1000, "at": int(time.time()), "name": known.get("name", ""), "known": True}
        fix = self.desktop.config.get("location", {}).get("last")
        return fix if isinstance(fix, dict) and "lat" in fix else None

    def _keep(self, **values) -> None:
        loc = self.desktop.config.setdefault("location", {})
        loc.update(values)
        save_config(self.desktop.config)

    def configured(self) -> None:
        """The settings, as they now are: the helper told, a fix asked for, the sun and the weather as they say."""
        s = self.settings()
        self._send({"do": "on", "on": s["on"]})
        if s["on"]:
            self.look_at_network()
        # Possibly somewhere else now (set by hand, or back to found): the forecast asked anew.
        self._outlook = None
        if s["on"]:
            if not self.last():
                self.locate()
            else:
                self.fetch()
        else:
            self.weather = None
        self._tell_morgan()
        self.daylight()
        self.changed.emit()

    # ------------------------------------------------------------ the helper

    def _start(self) -> None:
        p = QProcess(self)
        p.setProgram(sys.executable)
        p.setArguments(["-W", "ignore::DeprecationWarning", os.path.join(HERE, "locationd.py")])
        p.readyReadStandardOutput.connect(self._read)
        p.readyReadStandardError.connect(lambda: log("location: " + bytes(p.readAllStandardError()).decode("utf-8", "replace").strip()[:300]))
        p.finished.connect(self._ended)
        p.start()
        self.process = p
        # Started again: told what it was told.
        QTimer.singleShot(500, lambda: self._send({"do": "on", "on": self.on()}))

    def _ended(self, code: int, _status) -> None:
        log(f"location: the helper ended ({code})")
        if self._restarts < 3:
            self._restarts += 1
            QTimer.singleShot(3000, self._start)

    def _send(self, msg: dict) -> None:
        if self.process and self.process.state() == QProcess.ProcessState.Running:
            self.process.write((json.dumps(msg) + "\n").encode())

    def _read(self) -> None:
        self._buffer += bytes(self.process.readAllStandardOutput())
        *lines, self._buffer = self._buffer.split(b"\n")
        for line in lines:
            try:
                msg = json.loads(line)
            except ValueError:
                continue
            if "agent" in msg:
                if msg["agent"] != self.agent:
                    log(f"location: agent {msg['agent']}" + (f" ({msg.get('why', '')})" if msg["agent"] != "on" else ""))
                became = msg["agent"] == "on" and self.agent != "on"
                self.agent = msg["agent"]
                self.changed.emit()
                if became:
                    # The agent now: a fix by the way it is meant to come (GeoClue asking Talaris), at once.
                    self.locate()
            elif "ask" in msg:
                self._asked(int(msg["ask"]), str(msg.get("app", "")), int(msg.get("accuracy", 4)))
            elif "inUse" in msg:
                self.in_use = bool(msg["inUse"])
                self.changed.emit()
            elif "fix" in msg:
                self.locating = False
                if msg["fix"]:
                    self._fixed(msg["fix"])
                else:
                    log(f"location: no fix ({msg.get('why', '')})")
                self.changed.emit()

    def stop(self) -> None:
        self._restarts = 3
        self._night(6500)

    # ------------------------------------------------------------ applications asking

    def app_name(self, desktop_id: str) -> str:
        app = self.desktop.apps.lookup(desktop_id) or self.desktop.apps.lookup(desktop_id.removesuffix(".desktop")) or {}
        return app.get("name") or desktop_id or "An application"

    def _asked(self, ident: int, app: str, accuracy: int) -> None:
        decided = self.settings()["apps"].get(app)
        if decided in ("allow", "deny"):
            self._send({"do": "answer", "id": ident, "allow": decided == "allow", "accuracy": accuracy})
            return
        name = self.app_name(app)

        def answered(key: str) -> None:
            if key in ("always", "no"):
                apps = dict(self.settings()["apps"])
                apps[app] = "allow" if key == "always" else "deny"
                self._keep(apps=apps)
            self._send({"do": "answer", "id": ident, "allow": key in ("once", "always"), "accuracy": accuracy})
        self.desktop.notifications.own(f"{name} wants your location", f"To know {ACCURACY.get(accuracy, 'where you are')}.",
                                       [("once", "Allow once"), ("always", "Always"), ("no", "Don't allow")], answered)

    def set_up(self) -> None:
        """
        setup/location.sh, run as root through pkexec — a password window, no
        terminal (Settings, Location's Set up): Talaris listed as GeoClue's
        agent, and the time zone settable without a password. Then the helper
        becomes the agent at once.
        """
        def run() -> None:
            # A finger enrolled: polkit waits for it first (pam_fprintd), and the password window does not say
            # so — it shows only a password box, and a password typed then goes nowhere. So Talaris says it.
            if _fingerprint():
                self._finger.emit()
            try:
                done = subprocess.run(["pkexec", SETUP], capture_output=True, text=True, timeout=300)
                self._set_up.emit(done.returncode, done.stderr.strip()[-200:])
            except (OSError, subprocess.SubprocessError) as e:
                self._set_up.emit(-1, str(e)[:200])
        threading.Thread(target=run, daemon=True).start()

    def _setup_done(self, code: int, said: str) -> None:
        if code == 0:
            log("location: set up (setup/location.sh)")
            self._send({"do": "agent"})
            self.desktop.notifications.own("Location is set up", "Apps can ask for your location, and the time zone follows you.", [], lambda _k: None)
        elif code in (126, 127):
            # pkexec: the window dismissed (126), or not authorized (127) — which is also what it says when the
            # password window itself fails to hand the password on (hyprpolkitagent with polkit 127: "conversation
            # failed"). Either way, offered the way that does not need it: sudo, in a terminal.
            log(f"location: set up not done (pkexec {code}: {said or 'dismissed, or the password window failed'})")
            self.desktop.notifications.own("Location isn't set up", "The password window didn't finish (with a fingerprint enrolled, it waits for your finger). Set it up in a terminal instead?",
                                           [("terminal", "Use a terminal")], lambda key: self.set_up_in_terminal() if key == "terminal" else None)
        else:
            log(f"location: set up failed ({code}: {said})")
            self.desktop.notifications.own("Location not set up", said or f"It stopped ({code}).", [], lambda _k: None)
        self.changed.emit()

    def set_up_in_terminal(self) -> None:
        """setup/location.sh with sudo, in your terminal (a window of yours); watched for, so it takes at once."""
        terminal = os.environ.get("TERMINAL") or next((t for t in ("ghostty", "kitty", "foot", "alacritty") if shutil.which(t)), None)
        if not terminal:
            self.desktop.notifications.own("No terminal found", f"Run {SETUP} with sudo.", [], lambda _k: None)
            return
        spawn.start(terminal, "-e", "bash", "-c", f'sudo "{SETUP}"; echo; read -rp "Press Enter to close. "')
        self._watch_setup = getattr(self, "_watch_setup", None) or QTimer(self)
        self._watch_setup.setInterval(3000)
        tries = {"n": 0}

        def look() -> None:
            tries["n"] += 1
            if os.path.exists(AGENT_CONF):
                self._watch_setup.stop()
                self._setup_done(0, "")
            elif tries["n"] > 200:  # ten minutes: given up looking
                self._watch_setup.stop()
        try:
            self._watch_setup.timeout.disconnect()
        except (RuntimeError, TypeError):
            pass
        self._watch_setup.timeout.connect(look)
        self._watch_setup.start()

    def forget(self, app: str) -> None:
        apps = {k: v for k, v in self.settings()["apps"].items() if k != app}
        self._keep(apps=apps)
        self.changed.emit()

    def decide(self, app: str, how: str) -> None:
        if how not in ("allow", "deny"):
            return
        apps = dict(self.settings()["apps"])
        apps[app] = how
        self._keep(apps=apps)
        self.changed.emit()

    def others_looking(self) -> bool:
        """Something other than Talaris looking for your location now: the bar shows it."""
        return self.on() and self.in_use and not self.locating

    # ------------------------------------------------------------ Talaris's own fix

    # ------------------------------------------------------------ places known by their Wi-Fi

    def known_place(self) -> dict | None:
        """The place named for the Wi-Fi in use: its name, and one of its routers in reach — so another network called the same is not it."""
        net = self.network
        if not net.get("ssid"):
            return None
        for p in self.settings().get("places") or []:
            if p.get("ssid") == net["ssid"] and set(p.get("bssids") or []) & set(net.get("bssids") or []):
                return p
        return None

    def look_at_network(self) -> None:
        """The Wi-Fi in use, and the routers in reach (nmcli), read off the screen's thread; a known place come or gone, said."""
        def run() -> None:
            try:
                out = subprocess.run(["nmcli", "-t", "-f", "IN-USE,SSID,BSSID", "dev", "wifi", "list"], capture_output=True, text=True, timeout=15).stdout
            except (OSError, subprocess.SubprocessError):
                out = ""
            ssid, bssids = "", []
            for line in out.splitlines():
                # BSSIDs come with their colons escaped (\:): split on the others.
                parts = line.replace("\\:", "\x00").split(":")
                if len(parts) < 3:
                    continue
                bssid = parts[-1].replace("\x00", ":").lower()
                bssids.append(bssid)
                if parts[0] == "*":
                    ssid = ":".join(parts[1:-1]).replace("\x00", ":")
            self._network_seen.emit(json.dumps({"ssid": ssid, "bssids": bssids}))
        threading.Thread(target=run, daemon=True).start()

    def _got_network(self, text: str) -> None:
        was = (self.known_place() or {}).get("name")
        self.network = json.loads(text)
        now = (self.known_place() or {}).get("name")
        if now != was:
            log(f"location: {'at a known place' if now else 'no known place'} by its Wi-Fi")
            self._outlook = None
            self.fetch()
            self.daylight()
            self._tell_morgan()
            self.changed.emit()

    def pin_network(self, place: dict) -> None:
        """The Wi-Fi in use named as this place (Settings, Location): kept with its routers in reach now."""
        net = self.network
        if not net.get("ssid") or not isinstance(place, dict) or "lat" not in place:
            return
        places = [p for p in (self.settings().get("places") or []) if p.get("ssid") != net["ssid"] or not set(p.get("bssids") or []) & set(net["bssids"])]
        places.append({"ssid": net["ssid"], "bssids": sorted(set(net["bssids"]))[:40], "name": str(place.get("name", ""))[:120],
                       "lat": round(float(place["lat"]), 2), "lon": round(float(place["lon"]), 2)})
        self.desktop.settings.apply({"location": {"places": places}})

    def unpin_network(self, index: int) -> None:
        places = list(self.settings().get("places") or [])
        if 0 <= index < len(places):
            places.pop(index)
            self.desktop.settings.apply({"location": {"places": places}})

    def locate(self) -> None:
        # Set by hand: nothing to find.
        if not self.on() or self.locating or self.settings().get("by") == "hand":
            return
        self.locating = True
        # Told it is on first: asked for a fix the moment the helper starts, it may not have heard yet.
        self._send({"do": "on", "on": True})
        self._send({"do": "locate"})
        # Never answered (the helper gone): not locating for ever.
        QTimer.singleShot(60_000, lambda: setattr(self, "locating", False))

    def _fixed(self, fix: dict) -> None:
        # Kept to about a kilometre: all the sun and the weather need, and no more.
        kept = {"lat": round(float(fix["lat"]), 2), "lon": round(float(fix["lon"]), 2),
                "accuracy": round(float(fix.get("accuracy", 0))), "at": int(time.time())}
        moved = (self.last() or {}).get("lat") != kept["lat"] or (self.last() or {}).get("lon") != kept["lon"]
        self._keep(last=kept)
        if moved:
            log(f"location: a fix, to about {kept['accuracy'] // 1000 or 1} km")
            self._outlook = None  # somewhere else: its forecast is not this one
        self.fetch()
        self.daylight()
        self._tell_morgan()

    # ------------------------------------------------------------ weather, and the zone with it

    def units(self) -> str:
        u = self.settings()["units"]
        if u in ("c", "f"):
            return u
        country = (locale.getlocale()[0] or os.environ.get("LANG", "")).split(".")[0].split("_")[-1].upper()
        return "f" if country in FAHRENHEIT else "c"

    def fetch(self) -> None:
        """The weather where you are, and its time zone: asked of Open-Meteo off the screen's thread."""
        s = self.settings()
        fix = self.last()
        if not s["on"] or not fix or not (s["weather"] or s["zone"]):
            return
        q = urllib.parse.urlencode({"latitude": fix["lat"], "longitude": fix["lon"], "timezone": "auto",
                                    "current": "temperature_2m,weather_code,is_day",
                                    "temperature_unit": "fahrenheit" if self.units() == "f" else "celsius"})

        def run() -> None:
            try:
                with urllib.request.urlopen(f"https://api.open-meteo.com/v1/forecast?{q}", timeout=15) as reply:
                    self._fetched.emit(reply.read().decode("utf-8"))
            except Exception as e:  # noqa: BLE001 — offline, or the service down: the last weather stands, then none
                log(f"location: no weather ({type(e).__name__})")
        threading.Thread(target=run, daemon=True).start()

    def forecast(self, to: str = "popup") -> None:
        """
        The forecast — every hour of the next 10 days, and the days — for the
        weather popup (`to` "popup": the next 24 hours of it) or the calendar
        ("calendar": all of it). Asked of Open-Meteo off the screen's thread,
        with the rounded fix and nothing else; kept a quarter of an hour, so
        the popup and the calendar share one asking.
        """
        fix = self.last()
        if not self.on() or not fix:
            self._forecast_out(to, None, "Location is off" if not self.on() else "Not found yet")
            return
        unit = self.units()
        kept = self._outlook
        if kept and kept["unit"] == ("°F" if unit == "f" else "°C") and time.time() - kept["fetched"] < 15 * 60:
            self._forecast_out(to, kept, "")
            return
        q = urllib.parse.urlencode({"latitude": fix["lat"], "longitude": fix["lon"], "timezone": "auto",
                                    "current": "temperature_2m,weather_code,is_day,apparent_temperature",
                                    "hourly": "temperature_2m,weather_code,is_day,precipitation_probability",
                                    "daily": "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max",
                                    "forecast_days": 10, "temperature_unit": "fahrenheit" if unit == "f" else "celsius"})

        def run() -> None:
            try:
                with urllib.request.urlopen(f"https://api.open-meteo.com/v1/forecast?{q}", timeout=15) as reply:
                    got = json.loads(reply.read().decode("utf-8"))
                sky = lambda code: SKY.get(int(code if code is not None else -1), ("", "cloud"))  # noqa: E731
                h, d, c = got["hourly"], got["daily"], got["current"]
                state = {
                    "unit": "°F" if unit == "f" else "°C", "fetched": time.time(),
                    # Where it is now, in the place's own zone (Open-Meteo's): the hour the popup starts from.
                    "hour": str(c.get("time", ""))[:13],
                    "now": {"temp": round(c["temperature_2m"]), "feels": round(c.get("apparent_temperature", c["temperature_2m"])),
                            "sky": sky(c["weather_code"])[0], "icon": sky(c["weather_code"])[1], "day": bool(c.get("is_day", 1))},
                    "hours": [{"at": t, "temp": round(tt), "icon": sky(code)[1], "sky": sky(code)[0], "day": bool(dd), "rain": rain or 0}
                              for t, tt, code, dd, rain in zip(h["time"], h["temperature_2m"], h["weather_code"], h["is_day"],
                                                               h.get("precipitation_probability") or [0] * len(h["time"]))
                              if tt is not None],
                    "days": [{"at": t, "hi": round(hi), "lo": round(lo), "icon": sky(code)[1], "sky": sky(code)[0], "rain": rain or 0}
                             for t, code, hi, lo, rain in zip(d["time"], d["weather_code"], d["temperature_2m_max"], d["temperature_2m_min"],
                                                              d.get("precipitation_probability_max") or [0] * len(d["time"]))
                             if hi is not None and lo is not None],
                }
                self._forecast_fetched.emit(to, json.dumps(state))
            except Exception as e:  # noqa: BLE001 — offline, or the service down
                self._forecast_fetched.emit(to, "")
                log(f"location: no forecast ({type(e).__name__})")
        threading.Thread(target=run, daemon=True).start()

    def _fetched_forecast(self, to: str, text: str) -> None:
        if not text:
            self._forecast_out(to, None, "No forecast just now")
            return
        self._outlook = json.loads(text)
        self._forecast_out(to, self._outlook, "")

    def _forecast_out(self, to: str, state: dict | None, error: str) -> None:
        if to == "calendar":
            self.calendar_weather.emit(json.dumps({"state": state, "error": error}))
            return
        if state:
            # The popup: from this hour, the next 24.
            hours = [h for h in state["hours"] if h["at"][:13] >= state.get("hour", "")][:24]
            state = {**state, "hours": hours}
        self.forecast_ready.emit(json.dumps({"kind": "weather", "state": state, "error": error}))

    def _got_weather(self, text: str) -> None:
        try:
            got = json.loads(text)
            now = got["current"]
        except (ValueError, KeyError):
            return
        code = int(now.get("weather_code", -1))
        sky, icon = SKY.get(code, ("", "cloud"))
        self.weather = {"temp": round(float(now.get("temperature_2m", 0))), "unit": "°F" if self.units() == "f" else "°C",
                        "sky": sky, "icon": icon, "day": bool(now.get("is_day", 1)), "at": int(time.time())}
        self.changed.emit()
        if self.settings()["zone"] and got.get("timezone"):
            self._zone(str(got["timezone"]))

    def _zone(self, zone: str) -> None:
        """The zone where you are made the system's, if it is not already: off the screen's thread (timedated)."""
        if not zone or zone in ("GMT", "UTC") or zone == _system_zone():
            return
        was = _system_zone()

        def run() -> None:
            done = subprocess.run(["timedatectl", "set-timezone", zone], capture_output=True, text=True, timeout=30)
            self._zone_set.emit(zone if done.returncode == 0 else "", was if done.returncode == 0 else done.stderr.strip()[:200])
        threading.Thread(target=run, daemon=True).start()

    def _zone_done(self, zone: str, said: str) -> None:
        if not zone:
            log(f"location: time zone not changed ({said})")
            return
        log(f"location: time zone {said} → {zone}")
        # This process's own clock, and everything told: the core's dates, the calendar, Morgan.
        os.environ.pop("TZ", None)
        time.tzset()
        core.call("PUT", "/time/zone", json.dumps({"zone": zone}))
        calendar = getattr(self.desktop, "calendar_service", None)
        if calendar is not None and hasattr(calendar, "zone_changed"):
            calendar.zone_changed()
        if getattr(self.desktop, "morgan_here", False):
            import morgan
            threading.Thread(target=lambda: morgan.command("config.set " + json.dumps({"values": {"timeZone": zone}})), daemon=True).start()
        self.desktop.notifications.own("Time zone changed", f"{zone.replace('_', ' ')}, where you are now.", [], lambda _k: None)
        self.changed.emit()

    # ------------------------------------------------------------ the sun: light and dark, and the night light

    def daylight(self) -> None:
        s = self.settings()
        fix = self.last()
        if not s["on"] or not fix:
            self._night(6500)
            return
        now = datetime.now(timezone.utc)
        up = is_day(now, fix["lat"], fix["lon"])
        if s["sunTheme"] and up != self._sun_was:
            mode = "light" if up else "dark"
            if self.desktop.config["theme"].get("mode") != mode:
                log(f"location: the sun {'up' if up else 'down'}: {mode}")
                self.desktop.settings.apply({"theme": {"mode": mode}})
        self._sun_was = up if s["sunTheme"] else None
        self._night(self._warmth_now(now, up, fix) if s["nightLight"] else 6500)

    def _warmth_now(self, now: datetime, up: bool, fix: dict) -> int:
        """How warm the screen is now: full after sunset, none in the day, a ramp of RAMP_S either side."""
        warm = int(self.settings()["warmth"])
        nxt = next_change(now, fix["lat"], fix["lon"])
        if up:
            # Day: warming in the last stretch before sunset.
            left = (nxt - now).total_seconds() if nxt else RAMP_S * 2
            share = max(0.0, 1 - left / RAMP_S)
        else:
            # Night: cooling in the last stretch before sunrise.
            left = (nxt - now).total_seconds() if nxt else RAMP_S * 2
            share = min(1.0, left / RAMP_S)
        return round((6500 - (6500 - warm) * share) / 100) * 100

    def _night(self, kelvin: int) -> None:
        """The screen warmed to `kelvin` (Hyprland's screen shader), or (6500) left alone — and only when it changes."""
        if kelvin == self.warmth:
            return
        self.warmth = kelvin
        if kelvin >= 6500:
            hypr.keyword("decoration:screen_shader", "[[EMPTY]]")
            return
        r, g, b = warm_rgb(kelvin)
        try:
            with open(SHADER, "w", encoding="utf-8") as f:
                f.write("#version 300 es\nprecision highp float;\nin vec2 v_texcoord;\nuniform sampler2D tex;\nout vec4 fragColor;\n"
                        f"void main() {{\n    vec4 c = texture(tex, v_texcoord);\n    fragColor = vec4(c.rgb * vec3({r:.4f}, {g:.4f}, {b:.4f}), c.a);\n}}\n")
        except OSError:
            return
        hypr.keyword("decoration:screen_shader", SHADER)

    # ------------------------------------------------------------ Morgan

    def _tell_morgan(self) -> None:
        """Where you are, roughly, for Morgan (Talaris's MCP): only while it may know; forgotten otherwise."""
        s = self.settings()
        fix = self.last()
        if s["on"] and s["morgan"] and fix:
            body = {"lat": fix["lat"], "lon": fix["lon"], "accuracy": fix.get("accuracy", 0), "zone": _system_zone(),
                    **({"weather": self.weather} if self.weather else {})}
        else:
            body = None
        threading.Thread(target=lambda: core.call("PUT", "/location", json.dumps(body)), daemon=True).start()

    # ------------------------------------------------------------ for the bar and Settings

    def describe(self) -> dict:
        s = self.settings()
        fix = self.last()
        return {"on": s["on"], "agent": self.agent, "setUp": os.path.exists(AGENT_CONF), "looking": self.others_looking(),
                "weather": self.weather if s["on"] and s["weather"] else None,
                # Rounded as kept (about a kilometre): for Settings' map, which is drawn on this machine.
                "fix": {"lat": fix["lat"], "lon": fix["lon"], "accuracy": fix.get("accuracy", 0), "at": fix.get("at", 0),
                        "name": fix.get("name", ""), "hand": bool(fix.get("hand")), "known": bool(fix.get("known")),
                        # Not from Wi-Fi: from the internet address, which places the provider, not you.
                        "coarse": not fix.get("hand") and not fix.get("known") and fix.get("accuracy", 0) >= COARSE_M} if fix else None,
                # The Wi-Fi in use (its name only), and the places named for networks: for Settings to name this one, or forget one.
                "network": self.network.get("ssid", ""),
                "places": [{"ssid": p.get("ssid", ""), "name": p.get("name", "")} for p in (s.get("places") or [])],
                "here": (self.known_place() or {}).get("name", ""),
                "zone": _system_zone(), "units": self.units(),
                "apps": [{"id": a, "name": self.app_name(a), "how": h} for a, h in sorted(s["apps"].items())]}
