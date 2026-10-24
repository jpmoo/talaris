#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-only
# Copyright (c) 2026 Jeff Moore
"""
The tray's D-Bus side: the StatusNotifierItem watcher and host, as a child
process of the surfaces (tray.py), speaking JSON lines.

**Why a process of its own.** The protocol is D-Bus, which wants a GLib main
loop of its own and an object exported on the session bus; PySide6 here has
no QtDBus. A child keeps all of that out of the surfaces, and if it falls
over, the bar just loses its tray icons.

**What it is.** Applications put an icon in a tray by registering a
StatusNotifierItem with `org.kde.StatusNotifierWatcher`. Talaris is that
watcher (and the one host that shows them). For each item it reads the icon,
title, tooltip and status, and reads them again when the item says they
changed; when the item's owner leaves the bus, the item goes.

**Out** (stdout), one JSON object a line:
  {"items": [{id, title, tooltip, status, icon, menu, itemIsMenu}]}
  {"menu": {"id": …, "items": [{id, label, enabled, type, toggle, state, children}]}}
**In** (stdin):
  {"do": "activate"|"secondary"|"context", "id": …, "x": …, "y": …}
  {"do": "menu", "id": …}                       — read the item's menu
  {"do": "click", "id": …, "item": <menu item id>}

Icons go out as data URLs: a named icon looked up in the item's own theme
path and then the icon themes on disk, or the item's own pixels made a PNG.
"""

from __future__ import annotations

import base64
import glob
import json
import os
import struct
import sys
import time
import zlib

from gi.repository import Gio, GLib

WATCHER = "org.kde.StatusNotifierWatcher"
ITEM_IFACE = "org.kde.StatusNotifierItem"
MENU_IFACE = "com.canonical.dbusmenu"

WATCHER_XML = """
<node>
  <interface name="org.kde.StatusNotifierWatcher">
    <method name="RegisterStatusNotifierItem"><arg type="s" direction="in"/></method>
    <method name="RegisterStatusNotifierHost"><arg type="s" direction="in"/></method>
    <property name="RegisteredStatusNotifierItems" type="as" access="read"/>
    <property name="IsStatusNotifierHostRegistered" type="b" access="read"/>
    <property name="ProtocolVersion" type="i" access="read"/>
    <signal name="StatusNotifierItemRegistered"><arg type="s"/></signal>
    <signal name="StatusNotifierItemUnregistered"><arg type="s"/></signal>
    <signal name="StatusNotifierHostRegistered"/>
    <signal name="StatusNotifierHostUnregistered"/>
  </interface>
</node>
"""


def say(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


# ------------------------------------------------------------------ icons

def _themes() -> list[str]:
    """Icon theme directories to look in: the user's and the system's, the usual themes first."""
    bases = [os.path.expanduser("~/.local/share/icons"), os.path.expanduser("~/.icons")]
    bases += [os.path.join(d, "icons") for d in (os.environ.get("XDG_DATA_DIRS") or "/usr/local/share:/usr/share").split(":")]
    out = []
    for base in bases:
        for theme in ("hicolor", "Yaru", "Adwaita", "breeze", "Papirus", "gnome"):
            if os.path.isdir(os.path.join(base, theme)):
                out.append(os.path.join(base, theme))
    return out


THEMES = _themes()


def _data_url(path: str) -> str:
    kind = "image/svg+xml" if path.endswith(".svg") else "image/png"
    try:
        with open(path, "rb") as f:
            return f"data:{kind};base64,{base64.b64encode(f.read()).decode()}"
    except OSError:
        return ""


def named_icon(name: str, theme_path: str = "") -> str:
    """A named icon as a data URL: a path as it is, else the item's theme path, the themes, pixmaps."""
    if not name:
        return ""
    if name.startswith("/") and os.path.isfile(name):
        return _data_url(name)
    roots = ([theme_path] if theme_path else []) + THEMES
    for root in roots:
        # Biggest first, scalable best of all; any category.
        found = (glob.glob(os.path.join(root, "scalable", "*", name + ".svg"))
                 + sorted(glob.glob(os.path.join(root, "*", "*", name + ".png")), key=_size, reverse=True)
                 + glob.glob(os.path.join(root, name + ".png")) + glob.glob(os.path.join(root, name + ".svg"))
                 + glob.glob(os.path.join(root, "*", name + ".png")))
        if found:
            return _data_url(found[0])
    for ext in (".png", ".svg"):
        p = os.path.join("/usr/share/pixmaps", name + ext)
        if os.path.isfile(p):
            return _data_url(p)
    return ""


def _size(path: str) -> int:
    for part in path.split(os.sep):
        head = part.split("x", 1)[0].split("@", 1)[0]
        if head.isdigit():
            return int(head)
    return 0


def pixmap_icon(pixmaps) -> str:
    """The item's own pixels — (width, height, ARGB32 big-endian bytes), the largest — as a PNG data URL."""
    if not pixmaps:
        return ""
    w, h, data = max(pixmaps, key=lambda p: p[0] * p[1])
    data = bytes(data)
    if w <= 0 or h <= 0 or len(data) < w * h * 4:
        return ""
    rows = bytearray()
    for y in range(h):
        rows.append(0)
        for x in range(w):
            a, r, g, b = data[(y * w + x) * 4:(y * w + x) * 4 + 4]
            rows += bytes((r, g, b, a))

    def chunk(kind: bytes, body: bytes) -> bytes:
        return struct.pack(">I", len(body)) + kind + body + struct.pack(">I", zlib.crc32(kind + body) & 0xFFFFFFFF)

    png = (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0))
           + chunk(b"IDAT", zlib.compress(bytes(rows))) + chunk(b"IEND", b""))
    return "data:image/png;base64," + base64.b64encode(png).decode()


# ------------------------------------------------------------------ the tray

class Tray:
    def __init__(self) -> None:
        self.bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
        self.items: dict[str, dict] = {}  # key "service/path" -> item
        self.watches: dict[str, int] = {}
        self._soon = 0
        node = Gio.DBusNodeInfo.new_for_xml(WATCHER_XML)
        self.bus.register_object("/StatusNotifierWatcher", node.interfaces[0], self._call, self._get, None)
        Gio.bus_own_name_on_connection(self.bus, WATCHER, Gio.BusNameOwnerFlags.NONE,
                                       lambda *_: self._ready(), lambda *_: self._lost())
        self.host = f"org.kde.StatusNotifierHost-{os.getpid()}"
        Gio.bus_own_name_on_connection(self.bus, self.host, Gio.BusNameOwnerFlags.NONE, None, None)
        self.bus.signal_subscribe(None, ITEM_IFACE, None, None, None, Gio.DBusSignalFlags.NONE, self._item_signal)

    def _ready(self) -> None:
        self.bus.emit_signal(None, "/StatusNotifierWatcher", WATCHER, "StatusNotifierHostRegistered", None)
        say({"watcher": True})

    def _lost(self) -> None:
        # Another watcher holds the name (another desktop shell is running).
        say({"watcher": False})

    # -------------------------------------------------- the watcher's interface

    def _call(self, _conn, sender, _path, _iface, method, params, invocation) -> None:
        if method == "RegisterStatusNotifierItem":
            arg = params.unpack()[0]
            service, path = (sender, arg) if arg.startswith("/") else (arg, "/StatusNotifierItem")
            # A well-known name is held by a unique one; the unique one is what leaves.
            self._add(service, path)
            invocation.return_value(None)
        elif method == "RegisterStatusNotifierHost":
            invocation.return_value(None)
        else:
            invocation.return_dbus_error("org.freedesktop.DBus.Error.UnknownMethod", method)

    def _get(self, _conn, _sender, _path, _iface, prop):
        if prop == "RegisteredStatusNotifierItems":
            return GLib.Variant("as", [k for k in self.items])
        if prop == "IsStatusNotifierHostRegistered":
            return GLib.Variant("b", True)
        if prop == "ProtocolVersion":
            return GLib.Variant("i", 0)
        return None

    # -------------------------------------------------- items

    def _add(self, service: str, path: str) -> None:
        key = f"{service}{path}"
        if key in self.items:
            return
        self.items[key] = {"id": key, "service": service, "path": path}
        self.bus.emit_signal(None, "/StatusNotifierWatcher", WATCHER, "StatusNotifierItemRegistered", GLib.Variant("(s)", (key,)))
        if service not in self.watches:
            self.watches[service] = Gio.bus_watch_name_on_connection(
                self.bus, service, Gio.BusNameWatcherFlags.NONE, None, lambda _c, name: self._gone(name))
        self._read(key)

    def _gone(self, service: str) -> None:
        for key in [k for k, v in self.items.items() if v["service"] == service]:
            del self.items[key]
            self.bus.emit_signal(None, "/StatusNotifierWatcher", WATCHER, "StatusNotifierItemUnregistered", GLib.Variant("(s)", (key,)))
        watch = self.watches.pop(service, None)
        if watch:
            Gio.bus_unwatch_name(watch)
        self._tell()

    def _read(self, key: str) -> None:
        item = self.items.get(key)
        if not item:
            return

        def done(conn, res) -> None:
            try:
                props = conn.call_finish(res).unpack()[0]
            except GLib.Error:
                return
            if key not in self.items:
                return
            theme = props.get("IconThemePath", "")
            status = props.get("Status", "Active")
            name = props.get("AttentionIconName") if status == "NeedsAttention" and props.get("AttentionIconName") else props.get("IconName", "")
            icon = named_icon(name, theme) or pixmap_icon(props.get("IconPixmap")) or named_icon(props.get("Id", "").lower(), theme)
            tip = props.get("ToolTip")
            tooltip = (tip[2] or tip[3]) if isinstance(tip, tuple) and len(tip) >= 4 else ""
            item.update({
                "appId": props.get("Id", ""), "title": props.get("Title", "") or props.get("Id", ""),
                "tooltip": tooltip, "status": status, "icon": icon,
                "menu": props.get("Menu", "") or "", "itemIsMenu": bool(props.get("ItemIsMenu", False)),
            })
            self._tell()

        self.bus.call(item["service"], item["path"], "org.freedesktop.DBus.Properties", "GetAll",
                      GLib.Variant("(s)", (ITEM_IFACE,)), GLib.VariantType("(a{sv})"), Gio.DBusCallFlags.NONE, 3000, None, done)

    def _item_signal(self, _conn, sender, path, _iface, _signal, _params) -> None:
        # NewIcon, NewTitle, NewStatus, NewToolTip…: read it all again.
        for key, item in self.items.items():
            if item["path"] == path and (item["service"] == sender or self._owner(item["service"]) == sender):
                self._read(key)

    def _owner(self, name: str) -> str:
        if name.startswith(":"):
            return name
        try:
            return self.bus.call_sync("org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus", "GetNameOwner",
                                      GLib.Variant("(s)", (name,)), GLib.VariantType("(s)"), Gio.DBusCallFlags.NONE, 1000, None).unpack()[0]
        except GLib.Error:
            return ""

    def _tell(self) -> None:
        # Changes come in bursts (an icon and a tooltip at once): say it once.
        if not self._soon:
            self._soon = GLib.timeout_add(60, self._said)

    def _said(self) -> bool:
        self._soon = 0
        say({"items": [{k: v for k, v in item.items() if k not in ("service", "path")}
                       for item in self.items.values() if "icon" in item and item.get("status") != "Passive"]})
        return False

    # -------------------------------------------------- doing

    def do(self, msg: dict) -> None:
        item = self.items.get(msg.get("id", ""))
        if not item:
            return
        x, y = int(msg.get("x", 0)), int(msg.get("y", 0))
        verb = msg.get("do")
        if verb in ("activate", "secondary", "context"):
            method = {"activate": "Activate", "secondary": "SecondaryActivate", "context": "ContextMenu"}[verb]
            self.bus.call(item["service"], item["path"], ITEM_IFACE, method, GLib.Variant("(ii)", (x, y)),
                          None, Gio.DBusCallFlags.NONE, 3000, None, None)
        elif verb == "menu" and item.get("menu"):
            self._menu(item)
        elif verb == "click" and item.get("menu"):
            self.bus.call(item["service"], item["menu"], MENU_IFACE, "Event",
                          GLib.Variant("(isvu)", (int(msg["item"]), "clicked", GLib.Variant("i", 0), int(time.time()))),
                          None, Gio.DBusCallFlags.NONE, 3000, None, None)

    def _menu(self, item: dict) -> None:
        def laid(conn, res) -> None:
            try:
                _rev, layout = conn.call_finish(res).unpack()
            except GLib.Error as e:
                say({"menu": {"id": item["id"], "items": [], "error": e.message}})
                return
            say({"menu": {"id": item["id"], "items": _entries(layout[2])}})

        # Some build the menu only when told it is about to show.
        self.bus.call(item["service"], item["menu"], MENU_IFACE, "AboutToShow", GLib.Variant("(i)", (0,)),
                      None, Gio.DBusCallFlags.NONE, 1000, None, None)
        self.bus.call(item["service"], item["menu"], MENU_IFACE, "GetLayout",
                      GLib.Variant("(iias)", (0, -1, [])), GLib.VariantType("(u(ia{sv}av))"), Gio.DBusCallFlags.NONE, 3000, None, laid)


def _entries(children) -> list[dict]:
    out = []
    for child in children:
        cid, props, kids = child if isinstance(child, tuple) else child.unpack()
        if props.get("visible", True) is False:
            continue
        out.append({
            "id": cid, "label": props.get("label", "").replace("__", "\0").replace("_", "").replace("\0", "_"),
            "enabled": props.get("enabled", True), "type": props.get("type", "standard"),
            "toggle": props.get("toggle-type", ""), "state": props.get("toggle-state", -1),
            "children": _entries(kids),
        })
    return out


def main() -> int:
    tray = Tray()
    loop = GLib.MainLoop()

    def read(channel, _cond) -> bool:
        line = channel.readline()
        if not line:
            loop.quit()  # the surfaces went: so does the tray
            return False
        try:
            tray.do(json.loads(line))
        except (ValueError, KeyError, TypeError):
            pass
        return True

    GLib.io_add_watch(GLib.IOChannel.unix_new(sys.stdin.fileno()), GLib.PRIORITY_DEFAULT, GLib.IOCondition.IN | GLib.IOCondition.HUP, read)
    loop.run()
    return 0


if __name__ == "__main__":
    sys.exit(main())
