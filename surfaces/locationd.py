#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-only
# Copyright (c) 2026 Jeff Moore
"""
Location's D-Bus side: Talaris as GeoClue's agent — the desktop that asks you
before an application learns where you are — and Talaris's own fix, for the
sun, the weather and the time zone. A child process of the surfaces
(location.py), speaking JSON lines, as the tray's and the notifications' are,
for the same reasons: D-Bus wants a GLib main loop.

**The agent.** GeoClue asks the agent of your session whether an application
may have your location, and how closely. It hears only from an agent its
configuration lists, and on a desktop that is not GNOME's there is none — so
until Talaris is one, applications are refused (or never answered). Talaris
is listed by `setup/location.sh` (a file in /etc/geoclue/conf.d, which needs
sudo); until then this says so, and Talaris's own fix is all that works.

**Talaris's own fix** is asked for now and then, at a city's accuracy — all
the sun, the weather and the time zone need — and let go at once: GeoClue
stops looking, and its "in use" says what other applications are doing.

**Out** (stdout), one JSON object a line:
  {"agent": "on" | "refused" | "absent", "why": …}
  {"ask": id, "app": desktop id, "accuracy": n}    — an application asking
  {"inUse": true|false}                            — anything looking now
  {"fix": {"lat", "lon", "accuracy"}} | {"fix": null, "why": …}
**In** (stdin):
  {"do": "on", "on": bool}                         — location on for Talaris at all
  {"do": "answer", "id": …, "allow": bool, "accuracy": n}
  {"do": "locate"}                                 — Talaris's own fix, once
  {"do": "agent"}                                  — be GeoClue's agent, now (just set up)
"""

from __future__ import annotations

import json
import sys

import gi

gi.require_version("Gio", "2.0")
from gi.repository import Gio, GLib  # noqa: E402

NAME = "org.freedesktop.GeoClue2"
MANAGER = "/org/freedesktop/GeoClue2/Manager"
AGENT_PATH = "/org/freedesktop/GeoClue2/Agent"
#: The desktop id Talaris is known by, as an agent and as an application.
TALARIS = "talaris"
CITY, EXACT = 4, 8
#: An application asking, and nobody answering: refused after this long.
ASK_S = 60
FIX_S = 45

AGENT_XML = """
<node>
  <interface name="org.freedesktop.GeoClue2.Agent">
    <method name="AuthorizeApp">
      <arg name="desktop_id" type="s" direction="in"/>
      <arg name="req_accuracy_level" type="u" direction="in"/>
      <arg name="authorized" type="b" direction="out"/>
      <arg name="allowed_accuracy_level" type="u" direction="out"/>
    </method>
    <property name="MaxAccuracyLevel" type="u" access="read"/>
  </interface>
</node>
"""


def say(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


class Location:
    def __init__(self) -> None:
        self.bus = Gio.bus_get_sync(Gio.BusType.SYSTEM, None)
        self.on = False
        self.asking: dict[int, tuple] = {}  # id: (invocation, timeout source)
        self.next = 0
        self.locating = False
        self.manager = Gio.DBusProxy.new_sync(self.bus, Gio.DBusProxyFlags.NONE, None, NAME, MANAGER, f"{NAME}.Manager", None)
        self.manager.connect("g-properties-changed", lambda *_: self._in_use())
        node = Gio.DBusNodeInfo.new_for_xml(AGENT_XML)
        self.bus.register_object(AGENT_PATH, node.interfaces[0], self._call, self._get, None)
        self.agent = ""
        self._add_agent()
        self._in_use()
        # GeoClue starts when asked for and leaves when idle, forgetting its agent: told again each time it is back.
        Gio.bus_watch_name_on_connection(self.bus, NAME, Gio.BusNameWatcherFlags.NONE, lambda *_: self._add_agent(), None)
        # No asking again on a timer: each try would wake GeoClue only to be refused. Set up (Settings, Location)
        # says {"do": "agent"}; and GeoClue started by anything else is watched for, above.

    # ------------------------------------------------------------ the agent

    def _add_agent(self) -> None:
        """
        Asked of GeoClue without waiting on it: as it takes an agent, GeoClue
        asks the agent its MaxAccuracyLevel — a call waited on here would not
        be answered, and both would wait until the call timed out.
        """
        self.manager.call("AddAgent", GLib.Variant("(s)", (TALARIS,)), Gio.DBusCallFlags.NONE, 10000, None, self._agent_added)

    def _agent_added(self, proxy, result) -> None:
        try:
            proxy.call_finish(result)
            now, why = "on", ""
        except GLib.Error as e:
            # Not listed in GeoClue's configuration (setup/location.sh), or GeoClue not there at all — or
            # GeoClue busy starting (just set up, it is restarted to read its configuration), or leaving
            # (idle): asked again in a few seconds, a few times, rather than taken as an answer.
            msg = e.message.lower()
            if "noreply" in msg or "disconnected" in msg or "timeout" in msg:
                self._busy_tries = getattr(self, "_busy_tries", 0) + 1
                if self._busy_tries <= 5:
                    GLib.timeout_add_seconds(4, lambda: (self._add_agent(), False)[1])
                return
            refused = "not allowed" in msg or "accessdenied" in msg or "denied" in msg
            now, why = ("refused" if refused else "absent"), e.message[:160]
        self._busy_tries = 0
        if now != self.agent:
            self.agent = now
            say({"agent": now, **({"why": why} if why else {})})

    def _get(self, _conn, _sender, _path, _iface, prop):
        if prop == "MaxAccuracyLevel":
            return GLib.Variant("u", EXACT if self.on else 0)
        return None

    def _call(self, _conn, _sender, _path, _iface, method, params, invocation) -> None:
        if method != "AuthorizeApp":
            invocation.return_dbus_error("org.freedesktop.DBus.Error.UnknownMethod", method)
            return
        app, accuracy = params.unpack()
        if not self.on:
            invocation.return_value(GLib.Variant("(bu)", (False, 0)))
            return
        if app == TALARIS:
            # Talaris itself, asking for its own fix: on is answer enough.
            invocation.return_value(GLib.Variant("(bu)", (True, min(accuracy, CITY))))
            return
        self.next += 1
        ident = self.next
        timer = GLib.timeout_add_seconds(ASK_S, self._unanswered, ident)
        self.asking[ident] = (invocation, timer)
        say({"ask": ident, "app": app, "accuracy": accuracy})

    def _unanswered(self, ident: int) -> bool:
        self.answer(ident, False, 0, timed_out=True)
        return False  # the timer, done: GLib removes it

    def answer(self, ident: int, allow: bool, accuracy: int, timed_out: bool = False) -> None:
        held = self.asking.pop(ident, None)
        if not held:
            return
        invocation, timer = held
        if not timed_out:
            GLib.source_remove(timer)
        invocation.return_value(GLib.Variant("(bu)", (bool(allow), int(accuracy) if allow else 0)))

    def set_on(self, on: bool) -> None:
        self.on = bool(on)
        # Off: every question waiting answered no.
        if not self.on:
            for ident in list(self.asking):
                self.answer(ident, False, 0)
        try:
            self.bus.emit_signal(None, AGENT_PATH, "org.freedesktop.DBus.Properties", "PropertiesChanged",
                                 GLib.Variant("(sa{sv}as)", ("org.freedesktop.GeoClue2.Agent",
                                                             {"MaxAccuracyLevel": GLib.Variant("u", EXACT if self.on else 0)}, [])))
        except GLib.Error:
            pass

    def _in_use(self) -> None:
        v = self.manager.get_cached_property("InUse")
        say({"inUse": bool(v.unpack()) if v is not None else False})

    # ------------------------------------------------------------ Talaris's own fix

    def locate(self) -> None:
        if self.locating or not self.on:
            return
        self.locating = True
        try:
            path = self.manager.call_sync("GetClient", None, Gio.DBusCallFlags.NONE, 10000, None).unpack()[0]
            client = Gio.DBusProxy.new_sync(self.bus, Gio.DBusProxyFlags.NONE, None, NAME, path, f"{NAME}.Client", None)
            props = lambda name, v: self.bus.call_sync(NAME, path, "org.freedesktop.DBus.Properties", "Set",  # noqa: E731
                                                      GLib.Variant("(ssv)", (f"{NAME}.Client", name, v)), None, Gio.DBusCallFlags.NONE, 10000, None)
            props("DesktopId", GLib.Variant("s", TALARIS))
            props("RequestedAccuracyLevel", GLib.Variant("u", CITY))
        except GLib.Error as e:
            self.locating = False
            say({"fix": None, "why": e.message[:160]})
            return
        state = {"done": False, "signal": 0, "timer": 0}

        def finish(fix: dict | None, why: str = "") -> None:
            if state["done"]:
                return
            state["done"] = True
            if state["signal"]:
                client.disconnect(state["signal"])
            if state["timer"]:
                GLib.source_remove(state["timer"])
            try:
                client.call_sync("Stop", None, Gio.DBusCallFlags.NONE, 5000, None)
            except GLib.Error:
                pass
            self.locating = False
            say({"fix": fix} if fix else {"fix": None, "why": why})

        def read(location_path: str) -> None:
            try:
                where = Gio.DBusProxy.new_sync(self.bus, Gio.DBusProxyFlags.NONE, None, NAME, location_path, f"{NAME}.Location", None)
                lat, lon, acc = (where.get_cached_property(k).unpack() for k in ("Latitude", "Longitude", "Accuracy"))
                finish({"lat": lat, "lon": lon, "accuracy": acc})
            except (GLib.Error, AttributeError) as e:
                finish(None, str(e)[:160])

        def signalled(_proxy, _sender, signal, params) -> None:
            if signal == "LocationUpdated":
                read(params.unpack()[1])

        state["signal"] = client.connect("g-signal", signalled)
        state["timer"] = GLib.timeout_add_seconds(FIX_S, lambda: (finish(None, "no fix in time"), False)[1])
        # Not waited on: starting it, GeoClue asks this very agent whether Talaris may (AuthorizeApp), and a
        # call waited on here would leave that unanswered until it timed out.
        def started(proxy, result) -> None:
            try:
                proxy.call_finish(result)
            except GLib.Error as e:
                finish(None, e.message[:160])
        client.call("Start", None, Gio.DBusCallFlags.NONE, 15000, None, started)

    def do(self, msg: dict) -> None:
        what = msg.get("do")
        if what == "on":
            self.set_on(msg.get("on"))
        elif what == "answer":
            self.answer(int(msg.get("id", 0)), bool(msg.get("allow")), int(msg.get("accuracy", CITY)))
        elif what == "locate":
            self.locate()
        elif what == "agent":
            self._add_agent()


def main() -> int:
    try:
        location = Location()
    except GLib.Error as e:
        say({"agent": "absent", "why": e.message[:160]})
        return 1
    loop = GLib.MainLoop()

    def read(channel, _cond) -> bool:
        line = channel.readline()
        if not line:
            loop.quit()  # the surfaces went: so does this
            return False
        try:
            location.do(json.loads(line))
        except (ValueError, KeyError, TypeError):
            pass
        return True

    GLib.io_add_watch(GLib.IOChannel.unix_new(sys.stdin.fileno()), GLib.PRIORITY_DEFAULT, GLib.IOCondition.IN | GLib.IOCondition.HUP, read)
    loop.run()
    return 0


if __name__ == "__main__":
    sys.exit(main())
