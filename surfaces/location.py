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
from config import save_config
from sun import is_day, next_change
from views import log

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULTS = {"on": False, "apps": {}, "weather": True, "units": "auto", "zone": True,
            "sunTheme": False, "nightLight": False, "warmth": 4000, "morgan": False}
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
        QTimer.singleShot(4000, self.configured)

    # ------------------------------------------------------------ settings

    def settings(self) -> dict:
        return {**DEFAULTS, **self.desktop.config.get("location", {})}

    def on(self) -> bool:
        return bool(self.settings()["on"])

    def last(self) -> dict | None:
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
                self.agent = msg["agent"]
                self.changed.emit()
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

    def locate(self) -> None:
        if not self.on() or self.locating:
            return
        self.locating = True
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

    def forecast(self) -> None:
        """
        The weather popup's: the next 24 hours, hour by hour, and the next 10
        days — asked of Open-Meteo off the screen's thread, with the rounded
        fix and nothing else, each time the popup opens.
        """
        fix = self.last()
        if not self.on() or not fix:
            self.forecast_ready.emit(json.dumps({"kind": "weather", "state": None,
                                                 "error": "Location is off" if not self.on() else "Not found yet"}))
            return
        unit = self.units()
        q = urllib.parse.urlencode({"latitude": fix["lat"], "longitude": fix["lon"], "timezone": "auto",
                                    "current": "temperature_2m,weather_code,is_day,apparent_temperature",
                                    "hourly": "temperature_2m,weather_code,is_day,precipitation_probability",
                                    "daily": "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max",
                                    "forecast_hours": 24, "forecast_days": 10,
                                    "temperature_unit": "fahrenheit" if unit == "f" else "celsius"})

        def run() -> None:
            try:
                with urllib.request.urlopen(f"https://api.open-meteo.com/v1/forecast?{q}", timeout=15) as reply:
                    got = json.loads(reply.read().decode("utf-8"))
                sky = lambda code: SKY.get(int(code if code is not None else -1), ("", "cloud"))  # noqa: E731
                h, d, c = got["hourly"], got["daily"], got["current"]
                state = {
                    "unit": "°F" if unit == "f" else "°C",
                    "now": {"temp": round(c["temperature_2m"]), "feels": round(c.get("apparent_temperature", c["temperature_2m"])),
                            "sky": sky(c["weather_code"])[0], "icon": sky(c["weather_code"])[1], "day": bool(c.get("is_day", 1))},
                    "hours": [{"at": t, "temp": round(tt), "icon": sky(code)[1], "sky": sky(code)[0], "day": bool(dd), "rain": rain or 0}
                              for t, tt, code, dd, rain in zip(h["time"], h["temperature_2m"], h["weather_code"], h["is_day"],
                                                               h.get("precipitation_probability") or [0] * len(h["time"]))],
                    "days": [{"at": t, "hi": round(hi), "lo": round(lo), "icon": sky(code)[1], "sky": sky(code)[0], "rain": rain or 0}
                             for t, code, hi, lo, rain in zip(d["time"], d["weather_code"], d["temperature_2m_max"], d["temperature_2m_min"],
                                                              d.get("precipitation_probability_max") or [0] * len(d["time"]))],
                }
                self.forecast_ready.emit(json.dumps({"kind": "weather", "state": state, "error": ""}))
            except Exception as e:  # noqa: BLE001 — offline, or the service down
                self.forecast_ready.emit(json.dumps({"kind": "weather", "state": None, "error": "No forecast just now"}))
                log(f"location: no forecast ({type(e).__name__})")
        threading.Thread(target=run, daemon=True).start()

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
        return {"on": s["on"], "agent": self.agent, "looking": self.others_looking(),
                "weather": self.weather if s["on"] and s["weather"] else None,
                "fix": {"accuracy": fix.get("accuracy", 0), "at": fix.get("at", 0)} if fix else None,
                "zone": _system_zone(), "units": self.units(),
                "apps": [{"id": a, "name": self.app_name(a), "how": h} for a, h in sorted(s["apps"].items())]}
