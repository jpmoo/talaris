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
  {"do": "color", "req": n, "calendar": id, "color": "#rrggbb"}   — kept in EDS, so every
                                                                    app using it sees it too

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
gi.require_version("EBook", "1.2")
gi.require_version("EBookContacts", "1.2")
from gi.repository import EBook, EBookContacts, ECal, EDataServer, GLib, ICalGLib  # noqa: E402

import re  # noqa: E402

#: An attendee's answer, as iCalendar has it and as the page shows it.
ANSWERS = {"ACCEPTED": "accepted", "DECLINED": "declined", "TENTATIVE": "maybe", "NEEDS-ACTION": "waiting", "DELEGATED": "delegated"}

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
    """A time as this machine's zone has it (TZID), so a repeating 10:00 stays 10:00 across a clock change."""
    t = ICalGLib.Time.new_from_timet_with_zone(int(ms // 1000), 1 if all_day else 0, LOCAL)
    if all_day:
        t.set_is_date(True)
    elif LOCAL is not UTC:
        t.set_timezone(LOCAL)
    return t


class Calendars:
    def __init__(self) -> None:
        self.registry = EDataServer.SourceRegistry.new_sync(None)
        self.clients: dict[str, ECal.Client] = {}
        self.connecting: set[str] = set()
        self.emails: dict[str, str] = {}
        self.met: dict | None = None
        self.books: dict[str, object] = {}
        self.wanted: dict = {}
        self.views: list = []
        self._soon = 0
        self.registry.connect("source-added", lambda *_: self._sources())
        self.registry.connect("source-removed", lambda *_: self._sources())
        self.registry.connect("source-changed", lambda *_: self._sources())
        self.registry.connect("source-enabled", lambda *_: self._sources())
        self.registry.connect("source-disabled", lambda *_: self._sources())
        self._sources()
        self._books()

    # -------------------------------------------------- the calendars

    def _account(self, source) -> str:
        """The account a calendar belongs to: its collection's name (the email address, usually)."""
        parent = source.get_parent()
        found = self.registry.ref_source(parent) if parent else None
        return found.get_display_name() if found else "On this computer"

    def _sources(self) -> None:
        """
        The enabled calendars, said at once with what is known of each; each
        is connected in the background (a Google calendar can take seconds to
        answer, and one must never hold up the rest), and said again as it is.
        """
        self.wanted = {s.get_uid(): s for s in self.registry.list_enabled(EDataServer.SOURCE_EXTENSION_CALENDAR)}
        for uid in [u for u in self.clients if u not in self.wanted]:
            del self.clients[uid]
        for uid, source in self.wanted.items():
            if uid not in self.clients and uid not in self.connecting:
                self.connecting.add(uid)
                ECal.Client.connect(source, ECal.ClientSourceType.EVENTS, 30, None, self._connected, uid)
        self._tell_calendars()

    def _connected(self, _source, result, uid) -> None:
        self.connecting.discard(uid)
        try:
            client = ECal.Client.connect_finish(result)
        except GLib.Error as e:
            sys.stderr.write(f"calendar {uid}: {e.message}\n")
            return
        if uid not in self.wanted:
            return
        self.clients[uid] = client
        try:
            _ok, email = client.get_backend_property_sync("cal-email-address", None)
            self.emails[uid] = (email or "").lower()
        except GLib.Error:
            self.emails[uid] = ""
        self._watch(client)
        self._tell_calendars()
        self._changed()

    def _tell_calendars(self) -> None:
        listed = []
        for uid, source in self.wanted.items():
            ext = source.get_extension(EDataServer.SOURCE_EXTENSION_CALENDAR)
            client = self.clients.get(uid)
            listed.append({"id": uid, "name": source.get_display_name(), "color": ext.get_color() or "",
                           "account": self._account(source), "writable": bool(client and not client.is_readonly()),
                           "connected": bool(client),
                           # Invitations: sent by the service itself (Google, Microsoft), as this address.
                           "invites": bool(client and client.check_capability(ECal.STATIC_CAPABILITY_CREATE_MESSAGES)),
                           "email": self.emails.get(uid, "")})
        listed.sort(key=lambda c: (c["account"], c["name"].lower()))
        say({"calendars": listed})

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
                    **self._people(icomp, self.emails.get(calendar, "")),
                })
                return True
            try:
                client.generate_instances_sync(start, end, None, one)
            except (GLib.Error, TypeError) as e:
                sys.stderr.write(f"calendar {uid}: {e}\n")
        items.sort(key=lambda e: (e["start"], not e["allDay"]))
        say({"events": {"req": req, "items": items}})

    @staticmethod
    def _rrule(icomp) -> str:
        prop = icomp.get_first_property(ICalGLib.PropertyKind.RRULE_PROPERTY)
        # The rule's value alone: the property also carries Evolution's own
        # parameters (X-EVOLUTION-ENDDATE) and the line's folding.
        return (prop.get_value_as_string() or "").replace("\r\n ", "").strip() if prop else ""

    def _people(self, icomp, me: str) -> dict:
        """Who it is with: the organizer, each attendee and their answer, and mine."""
        attendees, mine = [], ""
        prop = icomp.get_first_property(ICalGLib.PropertyKind.ATTENDEE_PROPERTY)
        while prop:
            text = prop.as_ical_string().replace("\r\n ", "")
            email = (prop.get_attendee() or "").removeprefix("mailto:").removeprefix("MAILTO:").lower()
            name = (re.search(r'CN="?([^";:]+)', text) or [None, ""])[1]
            answer = ANSWERS.get((re.search(r"PARTSTAT=([A-Z-]+)", text) or [None, "NEEDS-ACTION"])[1], "waiting")
            if email:
                attendees.append({"email": email, "name": name, "answer": answer})
                if email == me:
                    mine = answer
            prop = icomp.get_next_property(ICalGLib.PropertyKind.ATTENDEE_PROPERTY)
        org = icomp.get_first_property(ICalGLib.PropertyKind.ORGANIZER_PROPERTY)
        organizer = (org.get_organizer() or "").removeprefix("mailto:").removeprefix("MAILTO:").lower() if org else ""
        return {"rrule": self._rrule(icomp), "organizer": organizer, "attendees": attendees,
                "mine": mine, "organizing": bool(organizer) and organizer == me}

    # -------------------------------------------------- writing

    def _fill(self, icomp, event: dict) -> None:
        all_day = bool(event.get("allDay"))
        icomp.set_summary(str(event.get("title", "")) or "New event")
        icomp.set_location(str(event.get("location", "")))
        icomp.set_description(str(event.get("notes", "")))
        icomp.set_dtstart(time_of(int(event["start"]), all_day))
        icomp.set_dtend(time_of(int(event["end"]), all_day))
        # How it repeats: the page's own RRULE (FREQ, INTERVAL, BYDAY, COUNT, UNTIL), or none.
        if "rrule" in event:
            self._drop(icomp, ICalGLib.PropertyKind.RRULE_PROPERTY)
            rule = re.sub(r"[^A-Z0-9=;,+-]", "", str(event.get("rrule") or "").upper())
            if rule.startswith("FREQ="):
                icomp.add_property(ICalGLib.Property.new_from_string(f"RRULE:{rule}"))

    @staticmethod
    def _zone(client) -> None:
        """This machine's zone given to the calendar, so the times written in it can be read back."""
        if LOCAL is not UTC:
            try:
                client.add_timezone_sync(LOCAL, None)
            except GLib.Error:
                pass

    @staticmethod
    def _drop(icomp, kind) -> None:
        prop = icomp.get_first_property(kind)
        while prop:
            icomp.remove_property(prop)
            prop = icomp.get_first_property(kind)

    def _invite(self, icomp, calendar: str, attendees: list) -> None:
        """The people invited: me as organizer, each of them asked to answer — their answers kept where they had one."""
        me = self.emails.get(calendar, "")
        before = {a["email"]: a["answer"] for a in self._people(icomp, me)["attendees"]}
        self._drop(icomp, ICalGLib.PropertyKind.ATTENDEE_PROPERTY)
        self._drop(icomp, ICalGLib.PropertyKind.ORGANIZER_PROPERTY)
        people = [a for a in attendees if re.fullmatch(r"[^@\s<>\"]+@[^@\s<>\"]+", str(a.get("email", "")))]
        if not people or not me:
            return
        back = {v: k for k, v in ANSWERS.items()}
        icomp.add_property(ICalGLib.Property.new_from_string(f"ORGANIZER:mailto:{me}"))
        for a in [{"email": me, "name": ""}] + [p for p in people if p["email"].lower() != me]:
            email = a["email"].lower()
            name = re.sub(r'[";:,\n]', " ", str(a.get("name", ""))).strip()
            state = "ACCEPTED" if email == me else back.get(before.get(email, "waiting"), "NEEDS-ACTION")
            cn = f';CN="{name}"' if name else ""
            rsvp = "" if email == me else ";RSVP=TRUE"
            icomp.add_property(ICalGLib.Property.new_from_string(
                f"ATTENDEE{cn};ROLE=REQ-PARTICIPANT;PARTSTAT={state}{rsvp}:mailto:{email}"))

    def create(self, req: int, calendar: str, event: dict) -> None:
        client = self.clients.get(calendar)
        if not client:
            say({"done": {"req": req, "error": "No such calendar"}})
            return
        self._zone(client)
        icomp = ICalGLib.Component.new_vevent()
        icomp.set_dtstamp(ICalGLib.Time.new_current_with_zone(UTC))
        self._fill(icomp, event)
        if event.get("attendees"):
            self._invite(icomp, calendar, event["attendees"])
        try:
            _ok, uid = client.create_object_sync(icomp, ECal.OperationFlags.NONE, None)
        except GLib.Error as e:
            say({"done": {"req": req, "error": e.message}})
            return
        say({"done": {"req": req, "error": "", "uid": uid}})

    def update(self, req: int, calendar: str, uid: str, rid: str, event: dict, which: str) -> None:
        client = self.clients.get(calendar)
        try:
            self._zone(client)
            _ok, icomp = client.get_object_sync(uid, rid if which == "this" else None, None)
            if which != "this" and rid and "origStart" in event:
                # Every one: the series moved by as much as this one was, from its own first date.
                shift = int(event["start"]) - int(event["origStart"])
                length = int(event["end"]) - int(event["start"])
                first = ms_of(icomp.get_dtstart())
                event = {**event, "start": first + shift, "end": first + shift + length}
            if which == "this":
                event = {k: v for k, v in event.items() if k != "rrule"}
            self._fill(icomp, event)
            if "attendees" in event:
                self._invite(icomp, calendar, event["attendees"])
            mod = ECal.ObjModType.THIS if which == "this" and rid else ECal.ObjModType.ALL
            client.modify_object_sync(icomp, mod, ECal.OperationFlags.NONE, None)
        except (GLib.Error, AttributeError) as e:
            say({"done": {"req": req, "error": getattr(e, "message", str(e))}})
            return
        say({"done": {"req": req, "error": ""}})

    def respond(self, req: int, calendar: str, uid: str, rid: str, answer: str, which: str) -> None:
        """My answer to an invitation: my own line among the attendees changed; the service tells the organizer."""
        client = self.clients.get(calendar)
        me = self.emails.get(calendar, "")
        state = {v: k for k, v in ANSWERS.items()}.get(answer)
        try:
            _ok, icomp = client.get_object_sync(uid, rid if which == "this" else None, None)
            prop = icomp.get_first_property(ICalGLib.PropertyKind.ATTENDEE_PROPERTY)
            found = False
            while prop:
                if (prop.get_attendee() or "").lower().removeprefix("mailto:") == me and state:
                    param = prop.get_first_parameter(ICalGLib.ParameterKind.PARTSTAT_PARAMETER)
                    if param:
                        prop.remove_parameter_by_kind(ICalGLib.ParameterKind.PARTSTAT_PARAMETER)
                    prop.add_parameter(ICalGLib.Parameter.new_from_string(f"PARTSTAT={state}"))
                    found = True
                prop = icomp.get_next_property(ICalGLib.PropertyKind.ATTENDEE_PROPERTY)
            if not found:
                say({"done": {"req": req, "error": "You are not among its attendees"}})
                return
            mod = ECal.ObjModType.THIS if which == "this" and rid else ECal.ObjModType.ALL
            client.modify_object_sync(icomp, mod, ECal.OperationFlags.NONE, None)
        except (GLib.Error, AttributeError) as e:
            say({"done": {"req": req, "error": getattr(e, "message", str(e))}})
            return
        say({"done": {"req": req, "error": ""}})

    # -------------------------------------------------- people

    def _books(self) -> None:
        """Every address book, connected in the background, for finding people to invite."""
        for source in self.registry.list_enabled(EDataServer.SOURCE_EXTENSION_ADDRESS_BOOK):
            uid = source.get_uid()
            if uid in self.books or uid in self.connecting:
                continue
            self.connecting.add(uid)

            def done(_src, result, uid=uid) -> None:
                self.connecting.discard(uid)
                try:
                    self.books[uid] = EBook.BookClient.connect_finish(result)
                except GLib.Error as e:
                    sys.stderr.write(f"address book {uid}: {e.message}\n")
            EBook.BookClient.connect(source, 30, None, done)

    def _met(self) -> dict:
        """
        Everyone in the calendars — organizers and attendees, the past year and
        the coming three months — by address: the people actually met with.
        An account's whole directory (Google Workspace's, Microsoft's) is not
        within what Online Accounts may read; these are most of it that matters.
        Read once, on the first search, and kept.
        """
        if self.met is not None:
            return self.met
        now = time.time()
        start = time.strftime("%Y%m%dT000000Z", time.gmtime(now - 365 * 86400))
        end = time.strftime("%Y%m%dT000000Z", time.gmtime(now + 90 * 86400))
        sexp = f'(occur-in-time-range? (make-time "{start}") (make-time "{end}"))'
        met: dict[str, str] = {}
        for client in list(self.clients.values()):
            try:
                _ok, comps = client.get_object_list_sync(sexp, None)
            except GLib.Error:
                continue
            for comp in comps:
                text = comp.as_ical_string().replace("\r\n ", "")
                for line in text.splitlines():
                    if not line.startswith(("ATTENDEE", "ORGANIZER")):
                        continue
                    email = (re.search(r"mailto:([^\s;]+)$", line, re.I) or [None, ""])[1].lower()
                    name = (re.search(r'CN="?([^";:]+)', line) or [None, ""])[1].strip()
                    if "@" not in email or name.lower() == email:
                        name = met.get(email, "") if "@" in email else ""
                    if "@" in email and not email.endswith(("calendar.google.com", "resource.calendar.google.com")):
                        met[email] = name or met.get(email, "")
        self.met = met
        return met

    def people(self, req: int, query: str) -> None:
        """Contacts whose name or address has this in it — the address books, then everyone in the calendars: for inviting."""
        query = query.strip()
        found = []
        if len(query) >= 2:
            for book in list(self.books.values()):
                q = query.replace("\\", "").replace('"', "")
                sexp = f'(or (contains "full_name" "{q}") (contains "email" "{q}"))'
                try:
                    _ok, contacts = book.get_contacts_sync(sexp, None)
                except GLib.Error:
                    continue
                for c in contacts:
                    name = c.get_property("full-name") or ""
                    for attr in c.get_attributes(EBookContacts.ContactField.EMAIL) or []:
                        email = attr.get_value() or ""
                        if email and query.lower() in (name + " " + email).lower():
                            found.append({"name": name, "email": email.lower()})
            # Then the people met with in the calendars, a name where one was given.
            low = query.lower()
            for email, name in sorted(self._met().items(), key=lambda kv: (not kv[1], kv[1] or kv[0])):
                if low in f"{name} {email}".lower():
                    found.append({"name": name, "email": email})
        seen, items = set(), []
        for f in found:
            if f["email"] not in seen:
                seen.add(f["email"])
                items.append(f)
        say({"people": {"req": req, "items": items[:8]}})

    def delete(self, req: int, calendar: str, uid: str, rid: str, which: str) -> None:
        client = self.clients.get(calendar)
        try:
            mod = ECal.ObjModType.THIS if which == "this" and rid else ECal.ObjModType.ALL
            client.remove_object_sync(uid, rid if which == "this" else None, mod, ECal.OperationFlags.NONE, None)
        except (GLib.Error, AttributeError) as e:
            say({"done": {"req": req, "error": getattr(e, "message", str(e))}})
            return
        say({"done": {"req": req, "error": ""}})

    def color(self, req: int, calendar: str, color: str) -> None:
        source = self.wanted.get(calendar)
        if not source or not (len(color) == 7 and color.startswith("#")):
            say({"done": {"req": req, "error": "Not a calendar or a color"}})
            return
        source.get_extension(EDataServer.SOURCE_EXTENSION_CALENDAR).set_color(color)
        try:
            source.write_sync(None)
        except GLib.Error as e:
            say({"done": {"req": req, "error": e.message}})
            return
        self._tell_calendars()
        self._changed()
        say({"done": {"req": req, "error": ""}})

    def do(self, msg: dict) -> None:
        verb, req = msg.get("do"), int(msg.get("req", 0))
        if verb == "range":
            self.range(req, int(msg["from"]), int(msg["to"]))
        elif verb == "create":
            self.create(req, str(msg["calendar"]), msg["event"])
        elif verb == "update":
            self.update(req, str(msg["calendar"]), str(msg["uid"]), str(msg.get("rid", "")), msg["event"], msg.get("which", "all"))
        elif verb == "respond":
            self.respond(req, str(msg["calendar"]), str(msg["uid"]), str(msg.get("rid", "")), str(msg["answer"]), msg.get("which", "all"))
        elif verb == "people":
            self.people(req, str(msg.get("q", "")))
        elif verb == "color":
            self.color(req, str(msg["calendar"]), str(msg["color"]))
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
