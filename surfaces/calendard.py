#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-only
# Copyright (c) 2026 Jeff Moore
"""
The calendar's data side: Evolution Data Server, as a child process of the
surfaces (calendar.py), speaking JSON lines.

**Borrowed, not built** (DESIGN.md, "What Talaris borrows"). The accounts are
GNOME Online Accounts' — Google, Microsoft 365 (over Graph, by evolution-ews),
Apple and any CalDAV server (WebDAV) — and Evolution Data Server keeps their
calendars, in step with each service, offline included. Talaris reads and
writes events through it and keeps nothing of its own.

**Why a process of its own:** EDS is GLib and D-Bus, wanting a main loop of
its own, as the tray's does (trayd.py); and a slow account must never hold the
screen up.

**Out** (stdout), one JSON object a line:
  {"ready": true} | {"ready": false, "error": …}
  {"calendars": [{id, name, color, account, writable}]}
  {"events": {"req": n, "items": [{calendar, uid, rid, title, location, notes, start, end, allDay, recurring}]}}
  {"done": {"req": n, "error": "", "uid": …}}
  {"changed": true}                       — something changed: read the range again
**In** (stdin):
  {"do": "range", "req": n, "from": ms, "to": ms}
  {"do": "create", "req": n, "calendar": id, "event": {title, location, notes, start, end, allDay}}
  {"do": "update", "req": n, "calendar": id, "uid": …, "rid": …, "event": {…}, "which": "this"|"all"}
  {"do": "delete", "req": n, "calendar": id, "uid": …, "rid": …, "which": "this"|"all"}

Times are milliseconds since the epoch; an all-day event's start and end are
local midnights, the end the day after its last.
"""

from __future__ import annotations

import json
import sys
import time

import gi

gi.require_version("EDataServer", "1.2")
gi.require_version("ECal", "2.0")
gi.require_version("ICalGLib", "3.0")
from gi.repository import ECal, EDataServer, GLib, ICalGLib  # noqa: E402

UTC = ICalGLib.Timezone.get_utc_timezone()


def say(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def _local_zone():
    """This machine's zone as libical knows it, for all-day dates and new events."""
    try:
        name = open("/etc/timezone", encoding="utf-8").read().strip()
    except OSError:
        name = ""
    if not name:
        try:
            import os
            name = os.path.realpath("/etc/localtime").split("zoneinfo/", 1)[1]
        except (OSError, IndexError):
            name = ""
    zone = ICalGLib.Timezone.get_builtin_timezone(name) if name else None
    return zone or UTC


LOCAL = _local_zone()


def ms_of(t, zone=None) -> int:
    """An ICalGLib.Time as milliseconds — a date as its local midnight."""
    if t.is_date():
        return int(t.as_timet_with_zone(LOCAL)) * 1000
    z = t.get_timezone() or zone or UTC
    return int(t.as_timet_with_zone(z)) * 1000


def time_of(ms: int, all_day: bool):
    t = ICalGLib.Time.new_from_timet_with_zone(int(ms // 1000), 1 if all_day else 0, LOCAL if all_day else UTC)
    if all_day:
        t.set_is_date(True)
    return t


class Calendars:
    def __init__(self) -> None:
        self.registry = EDataServer.SourceRegistry.new_sync(None)
        self.clients: dict[str, ECal.Client] = {}
        self.views: list = []
        self._soon = 0
        self.registry.connect("source-added", lambda *_: self._sources())
        self.registry.connect("source-removed", lambda *_: self._sources())
        self.registry.connect("source-changed", lambda *_: self._sources())
        self.registry.connect("source-enabled", lambda *_: self._sources())
        self.registry.connect("source-disabled", lambda *_: self._sources())
        self._sources()

    # -------------------------------------------------- the calendars

    def _account(self, source) -> str:
        """The account a calendar belongs to: its collection's name (the email address, usually)."""
        parent = source.get_parent()
        found = self.registry.ref_source(parent) if parent else None
        return found.get_display_name() if found else "On this computer"

    def _sources(self) -> None:
        listed = []
        wanted = set()
        for source in self.registry.list_enabled(EDataServer.SOURCE_EXTENSION_CALENDAR):
            uid = source.get_uid()
            ext = source.get_extension(EDataServer.SOURCE_EXTENSION_CALENDAR)
            wanted.add(uid)
            if uid not in self.clients:
                try:
                    client = ECal.Client.connect_sync(source, ECal.ClientSourceType.EVENTS, 30, None)
                except GLib.Error as e:
                    sys.stderr.write(f"calendar {source.get_display_name()}: {e.message}\n")
                    continue
                self.clients[uid] = client
                self._watch(client)
            client = self.clients[uid]
            listed.append({"id": uid, "name": source.get_display_name(), "color": ext.get_color() or "",
                           "account": self._account(source), "writable": not client.is_readonly()})
        for uid in [u for u in self.clients if u not in wanted]:
            del self.clients[uid]
        listed.sort(key=lambda c: (c["account"], c["name"].lower()))
        say({"calendars": listed})
        self._changed()

    def _watch(self, client) -> None:
        """Tell the screen whenever this calendar's events change — here, or on the service."""
        try:
            ok, view = client.get_view_sync("#t", None)
        except GLib.Error:
            return
        for signal in ("objects-added", "objects-modified", "objects-removed"):
            view.connect(signal, lambda *_: self._changed())
        view.start()
        self.views.append(view)

    def _changed(self) -> None:
        if not self._soon:
            self._soon = GLib.timeout_add(150, self._said)

    def _said(self) -> bool:
        self._soon = 0
        say({"changed": True})
        return False

    # -------------------------------------------------- reading

    def range(self, req: int, start_ms: int, end_ms: int) -> None:
        items = []
        start, end = int(start_ms // 1000), int(end_ms // 1000)
        for uid, client in list(self.clients.items()):
            def one(icomp, istart, iend, *_args, calendar=uid) -> bool:
                all_day = istart.is_date()
                items.append({
                    "calendar": calendar, "uid": icomp.get_uid() or "",
                    "rid": icomp.get_recurrenceid().as_ical_string() if icomp.get_recurrenceid() and not icomp.get_recurrenceid().is_null_time() else
                           (istart.as_ical_string() if icomp.get_first_property(ICalGLib.PropertyKind.RRULE_PROPERTY) else ""),
                    "title": icomp.get_summary() or "", "location": icomp.get_location() or "",
                    "notes": icomp.get_description() or "",
                    "start": ms_of(istart), "end": ms_of(iend), "allDay": bool(all_day),
                    "recurring": bool(icomp.get_first_property(ICalGLib.PropertyKind.RRULE_PROPERTY)),
                })
                return True
            try:
                client.generate_instances_sync(start, end, None, one)
            except (GLib.Error, TypeError) as e:
                sys.stderr.write(f"calendar {uid}: {e}\n")
        items.sort(key=lambda e: (e["start"], not e["allDay"]))
        say({"events": {"req": req, "items": items}})

    # -------------------------------------------------- writing

    def _fill(self, icomp, event: dict) -> None:
        all_day = bool(event.get("allDay"))
        icomp.set_summary(str(event.get("title", "")) or "New event")
        icomp.set_location(str(event.get("location", "")))
        icomp.set_description(str(event.get("notes", "")))
        icomp.set_dtstart(time_of(int(event["start"]), all_day))
        icomp.set_dtend(time_of(int(event["end"]), all_day))

    def create(self, req: int, calendar: str, event: dict) -> None:
        client = self.clients.get(calendar)
        if not client:
            say({"done": {"req": req, "error": "No such calendar"}})
            return
        icomp = ICalGLib.Component.new_vevent()
        icomp.set_dtstamp(ICalGLib.Time.new_current_with_zone(UTC))
        self._fill(icomp, event)
        try:
            _ok, uid = client.create_object_sync(icomp, ECal.OperationFlags.NONE, None)
        except GLib.Error as e:
            say({"done": {"req": req, "error": e.message}})
            return
        say({"done": {"req": req, "error": "", "uid": uid}})

    def update(self, req: int, calendar: str, uid: str, rid: str, event: dict, which: str) -> None:
        client = self.clients.get(calendar)
        try:
            _ok, icomp = client.get_object_sync(uid, rid if which == "this" else None, None)
            self._fill(icomp, event)
            mod = ECal.ObjModType.THIS if which == "this" and rid else ECal.ObjModType.ALL
            client.modify_object_sync(icomp, mod, ECal.OperationFlags.NONE, None)
        except (GLib.Error, AttributeError) as e:
            say({"done": {"req": req, "error": getattr(e, "message", str(e))}})
            return
        say({"done": {"req": req, "error": ""}})

    def delete(self, req: int, calendar: str, uid: str, rid: str, which: str) -> None:
        client = self.clients.get(calendar)
        try:
            mod = ECal.ObjModType.THIS if which == "this" and rid else ECal.ObjModType.ALL
            client.remove_object_sync(uid, rid if which == "this" else None, mod, ECal.OperationFlags.NONE, None)
        except (GLib.Error, AttributeError) as e:
            say({"done": {"req": req, "error": getattr(e, "message", str(e))}})
            return
        say({"done": {"req": req, "error": ""}})

    def do(self, msg: dict) -> None:
        verb, req = msg.get("do"), int(msg.get("req", 0))
        if verb == "range":
            self.range(req, int(msg["from"]), int(msg["to"]))
        elif verb == "create":
            self.create(req, str(msg["calendar"]), msg["event"])
        elif verb == "update":
            self.update(req, str(msg["calendar"]), str(msg["uid"]), str(msg.get("rid", "")), msg["event"], msg.get("which", "all"))
        elif verb == "delete":
            self.delete(req, str(msg["calendar"]), str(msg["uid"]), str(msg.get("rid", "")), msg.get("which", "all"))


def main() -> int:
    try:
        cals = Calendars()
    except GLib.Error as e:
        say({"ready": False, "error": e.message})
        return 1
    say({"ready": True})
    loop = GLib.MainLoop()

    def read(channel, _cond) -> bool:
        line = channel.readline()
        if not line:
            loop.quit()
            return False
        try:
            cals.do(json.loads(line))
        except (ValueError, KeyError, TypeError) as e:
            sys.stderr.write(f"calendar: {e}\n")
        return True

    GLib.io_add_watch(GLib.IOChannel.unix_new(sys.stdin.fileno()), GLib.PRIORITY_DEFAULT, GLib.IOCondition.IN | GLib.IOCondition.HUP, read)
    loop.run()
    return 0


if __name__ == "__main__":
    sys.exit(main())
