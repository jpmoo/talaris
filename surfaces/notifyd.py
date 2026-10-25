#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-only
# Copyright (c) 2026 Jeff Moore
"""
Notifications' D-Bus side: the desktop's notification server
(`org.freedesktop.Notifications`, the Desktop Notifications spec, 1.2), as a
child process of the surfaces (notifications.py), speaking JSON lines — as
the tray's is (trayd.py), and for the same reasons: D-Bus wants a GLib main
loop, PySide6 here has no QtDBus, and if this falls over notifications fall
back to mako, which D-Bus starts again when the next one comes.

**Taking the name.** Asked for with replacement allowed and asked; mako does
not let it go when asked, so the surfaces stop mako first (by its pid) and
this takes the name as it frees.

**Out** (stdout), one JSON object a line:
  {"ready": true|false}
  {"notify": {id, app, icon, summary, body, actions: [[key, label]], urgency,
              timeout, image, desktop, category, transient, resident, replaces}}
  {"close": {"id": …}}                       — the application closed it
**In** (stdin):
  {"do": "closed", "id": …, "reason": 1|2|3} — expired | dismissed | closed
  {"do": "action", "id": …, "key": …}        — a button, or "default" (the body)
"""

from __future__ import annotations

import base64
import json
import struct
import sys
import zlib

import gi

gi.require_version("Gio", "2.0")
from gi.repository import Gio, GLib  # noqa: E402

from trayd import named_icon  # noqa: E402

NAME, PATH = "org.freedesktop.Notifications", "/org/freedesktop/Notifications"
XML = """
<node>
  <interface name="org.freedesktop.Notifications">
    <method name="GetCapabilities"><arg type="as" direction="out"/></method>
    <method name="Notify">
      <arg type="s" name="app_name" direction="in"/>
      <arg type="u" name="replaces_id" direction="in"/>
      <arg type="s" name="app_icon" direction="in"/>
      <arg type="s" name="summary" direction="in"/>
      <arg type="s" name="body" direction="in"/>
      <arg type="as" name="actions" direction="in"/>
      <arg type="a{sv}" name="hints" direction="in"/>
      <arg type="i" name="expire_timeout" direction="in"/>
      <arg type="u" name="id" direction="out"/>
    </method>
    <method name="CloseNotification"><arg type="u" name="id" direction="in"/></method>
    <method name="GetServerInformation">
      <arg type="s" name="name" direction="out"/><arg type="s" name="vendor" direction="out"/>
      <arg type="s" name="version" direction="out"/><arg type="s" name="spec_version" direction="out"/>
    </method>
    <signal name="NotificationClosed"><arg type="u" name="id"/><arg type="u" name="reason"/></signal>
    <signal name="ActionInvoked"><arg type="u" name="id"/><arg type="s" name="action_key"/></signal>
    <signal name="ActivationToken"><arg type="u" name="id"/><arg type="s" name="activation_token"/></signal>
  </interface>
</node>
"""
#: What Talaris draws: bodies with simple markup, buttons, icons, and lasting ones.
CAPABILITIES = ["actions", "body", "body-markup", "body-hyperlinks", "icon-static", "persistence"]


def say(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def raw_png(data) -> str:
    """The `image-data` hint, (iiibiiay) — width, height, rowstride, alpha, bits, channels, pixels — as a PNG data URL."""
    try:
        w, h, stride, alpha, bits, channels, pixels = data
        pixels = bytes(pixels)
        if bits != 8 or channels not in (3, 4) or w <= 0 or h <= 0:
            return ""
        rows = b"".join(b"\x00" + pixels[y * stride:y * stride + w * channels] for y in range(h))

        def chunk(kind: bytes, body: bytes) -> bytes:
            return struct.pack(">I", len(body)) + kind + body + struct.pack(">I", zlib.crc32(kind + body) & 0xFFFFFFFF)
        color = 6 if channels == 4 else 2
        png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, color, 0, 0, 0)) \
            + chunk(b"IDAT", zlib.compress(rows, 6)) + chunk(b"IEND", b"")
        return "data:image/png;base64," + base64.b64encode(png).decode()
    except (ValueError, TypeError, IndexError, struct.error):
        return ""


class Server:
    def __init__(self) -> None:
        self.bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
        self.next = 1
        node = Gio.DBusNodeInfo.new_for_xml(XML)
        self.bus.register_object(PATH, node.interfaces[0], self._call, None, None)
        Gio.bus_own_name_on_connection(self.bus, NAME, Gio.BusNameOwnerFlags.ALLOW_REPLACEMENT | Gio.BusNameOwnerFlags.REPLACE,
                                       lambda *_: say({"ready": True}), lambda *_: say({"ready": False}))

    def _call(self, _conn, sender, _path, _iface, method, params, invocation) -> None:
        if method == "GetCapabilities":
            invocation.return_value(GLib.Variant("(as)", (CAPABILITIES,)))
        elif method == "GetServerInformation":
            invocation.return_value(GLib.Variant("(ssss)", ("Talaris", "Talaris", "1.0", "1.2")))
        elif method == "CloseNotification":
            (nid,) = params.unpack()
            say({"close": {"id": int(nid)}})
            invocation.return_value(None)
        elif method == "Notify":
            app, replaces, icon, summary, body, actions, hints, timeout = params.unpack()
            nid = int(replaces) if replaces else self.next
            if not replaces:
                self.next += 1
            image = ""
            for key in ("image-data", "image_data", "icon_data"):
                if key in hints:
                    image = raw_png(hints[key])
                    break
            if not image:
                path = hints.get("image-path") or hints.get("image_path") or ""
                image = named_icon(str(path)) if path else ""
            desktop = str(hints.get("desktop-entry") or "")
            say({"notify": {
                "id": nid, "replaces": bool(replaces), "app": str(app), "summary": str(summary), "body": str(body),
                "icon": named_icon(str(icon)) if icon else (named_icon(desktop) if desktop else ""),
                "image": image if image != (named_icon(str(icon)) if icon else "") else "",
                "actions": [[actions[i], actions[i + 1]] for i in range(0, len(actions) - 1, 2)],
                "urgency": int(hints.get("urgency", 1)), "timeout": int(timeout), "desktop": desktop,
                "category": str(hints.get("category") or ""), "transient": bool(hints.get("transient", False)),
                "resident": bool(hints.get("resident", False)),
            }})
            invocation.return_value(GLib.Variant("(u)", (nid,)))
        else:
            invocation.return_dbus_error("org.freedesktop.DBus.Error.UnknownMethod", method)

    def do(self, msg: dict) -> None:
        nid = int(msg.get("id", 0))
        if msg.get("do") == "closed":
            reason = int(msg.get("reason", 2))
            self.bus.emit_signal(None, PATH, NAME, "NotificationClosed", GLib.Variant("(uu)", (nid, reason if reason in (1, 2, 3) else 2)))
        elif msg.get("do") == "action":
            self.bus.emit_signal(None, PATH, NAME, "ActionInvoked", GLib.Variant("(us)", (nid, str(msg.get("key", "default")))))


def main() -> int:
    server = Server()
    loop = GLib.MainLoop()

    def read(channel, _cond) -> bool:
        line = channel.readline()
        if not line:
            loop.quit()  # the surfaces went: so does this, and mako comes back when needed
            return False
        try:
            server.do(json.loads(line))
        except (ValueError, KeyError, TypeError):
            pass
        return True

    GLib.io_add_watch(GLib.IOChannel.unix_new(sys.stdin.fileno()), GLib.PRIORITY_DEFAULT, GLib.IOCondition.IN | GLib.IOCondition.HUP, read)
    loop.run()
    return 0


if __name__ == "__main__":
    sys.exit(main())
