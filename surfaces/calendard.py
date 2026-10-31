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
  {"do": "search", "req": n, "q": words}    — events within a year either side holding
                                              every word: answered as {"events": …}, the
                                              nearest occurrence of each repeating one
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
import os
import sys
import time
from datetime import datetime

import gi

gi.require_version("EDataServer", "1.2")
gi.require_version("ECal", "2.0")
gi.require_version("ICalGLib", "3.0")
gi.require_version("EBook", "1.2")
gi.require_version("EBookContacts", "1.2")
from gi.repository import EBook, EBookContacts, ECal, EDataServer, GLib, ICalGLib  # noqa: E402

import re  # noqa: E402

#: Addresses that are nobody's: a calendar's own, a room's, no-reply (as entities.ts isPersonAddress).
NOT_A_PERSON = re.compile(r"@(group|resource|import|group\.v)\.calendar\.google\.com$|^(no-?reply|do-?not-?reply|calendar-notification)@", re.I)

#: An attendee's answer, as iCalendar has it and as the page shows it.
ANSWERS = {"ACCEPTED": "accepted", "DECLINED": "declined", "TENTATIVE": "maybe", "NEEDS-ACTION": "waiting", "DELEGATED": "delegated"}

UTC = ICalGLib.Timezone.get_utc_timezone()


def say(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def _local_zone():
    """
    This machine's zone as libical knows it, for all-day dates and new events:
    /etc/localtime first — the one timedated changes when the zone is set
    (location.py keeps it where you are) — and /etc/timezone, which it may
    leave behind, only if that says nothing.
    """
    try:
        import os
        name = os.path.realpath("/etc/localtime").split("zoneinfo/", 1)[1]
    except (OSError, IndexError):
        name = ""
    if not name:
        try:
            name = open("/etc/timezone", encoding="utf-8").read().strip()
        except OSError:
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
        #: Each address book's name, as its account calls it: shown beside a card.
        self.book_names: dict[str, str] = {}
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
        items = self._instances(start_ms, end_ms)
        items.sort(key=lambda e: (e["start"], not e["allDay"]))
        say({"events": {"req": req, "items": items}})

    def search(self, req: int, query: str) -> None:
        """Events holding every word typed (title, place, notes), a year either side of now: upcoming first, then past, nearest first."""
        words = [w for w in query.lower().split() if w]
        now = int(time.time() * 1000)
        year = 366 * 86400 * 1000
        found: dict[tuple, dict] = {}
        for e in self._instances(now - year, now + year) if words else []:
            hay = f"{e['title']} {e['location']} {e['notes']}".lower()
            if not all(w in hay for w in words):
                continue
            # A repeating one, once: its occurrence nearest now, the next one before any past.
            key = (e["calendar"], e["uid"])
            best = found.get(key)
            rank = lambda x: (x["end"] < now, abs(x["start"] - now))  # noqa: E731
            if best is None or rank(e) < rank(best):
                found[key] = e
        items = sorted(found.values(), key=lambda e: (e["end"] < now, e["start"] if e["end"] >= now else -e["start"]))[:150]
        say({"events": {"req": req, "items": items, "search": query}})

    def _instances(self, start_ms: int, end_ms: int) -> list:
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
        return items

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

            self.book_names[uid] = source.get_display_name() or "Contacts"

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

    @staticmethod
    def _card(book: str, book_name: str, c) -> dict:
        """One address-book card, as People shows it beside a person."""
        def values(field) -> list:
            return [v for v in (a.get_value() or "" for a in (c.get_attributes(field) or [])) if v]
        return {"book": book, "bookName": book_name, "uid": c.get_property("id") or "",
                "name": c.get_property("full-name") or "", "emails": [e.lower() for e in values(EBookContacts.ContactField.EMAIL)],
                "phones": values(EBookContacts.ContactField.TEL), "org": c.get_property("org") or "",
                "role": c.get_property("title") or c.get_property("role") or ""}

    def cards(self, req: int, query: str, keys: list, everything: bool = False) -> None:
        """
        Address-book cards: those a person is tied to (`keys`, "book/uid"), or
        those whose name or address holds `query` — what People suggests a
        person be tied to.
        """
        items = []
        for key in keys:
            book, _, uid = str(key).partition("/")
            client = self.books.get(book)
            if not client or not uid:
                continue
            try:
                _ok, c = client.get_contact_sync(uid, None)
                items.append(self._card(book, self.book_names.get(book, ""), c))
            except GLib.Error:
                items.append({"book": book, "uid": uid, "gone": True})
        if everything:
            # Every card in every address book: People holds everyone in them.
            for book, client in list(self.books.items()):
                try:
                    _ok, contacts = client.get_contacts_sync('(contains "x-evolution-any-field" "")', None)
                except GLib.Error:
                    continue
                items.extend(self._card(book, self.book_names.get(book, ""), c) for c in contacts)
            say({"cards": {"req": req, "items": items}})
            return
        q = query.strip().replace("\\", "").replace('"', "")
        if len(q) >= 2:
            for book, client in list(self.books.items()):
                sexp = f'(or (contains "full_name" "{q}") (contains "email" "{q}"))'
                try:
                    _ok, contacts = client.get_contacts_sync(sexp, None)
                except GLib.Error:
                    continue
                for c in contacts[:40]:
                    items.append(self._card(book, self.book_names.get(book, ""), c))
        say({"cards": {"req": req, "items": items}})

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
            # A calendar's own address (a shared calendar, a room) is nobody to invite or name.
            if NOT_A_PERSON.search(f["email"]):
                continue
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
        elif verb == "search":
            self.search(req, str(msg.get("q", ""))[:200])
        elif verb == "create":
            self.create(req, str(msg["calendar"]), msg["event"])
        elif verb == "update":
            self.update(req, str(msg["calendar"]), str(msg["uid"]), str(msg.get("rid", "")), msg["event"], msg.get("which", "all"))
        elif verb == "respond":
            self.respond(req, str(msg["calendar"]), str(msg["uid"]), str(msg.get("rid", "")), str(msg["answer"]), msg.get("which", "all"))
        elif verb == "people":
            self.people(req, str(msg.get("q", "")))
        elif verb == "cards":
            self.cards(req, str(msg.get("q", "")), [str(k) for k in msg.get("keys", [])][:200], bool(msg.get("all")))
        elif verb == "color":
            self.color(req, str(msg["calendar"]), str(msg["color"]))
        elif verb == "delete":
            self.delete(req, str(msg["calendar"]), str(msg["uid"]), str(msg.get("rid", "")), msg.get("which", "all"))


class DemoCalendars:
    """
    Demo mode's calendar (the core's demo.ts): the demo's own events, from
    `calendar.json` beside its store (made by the core's demo-seed.ts) —
    nothing of the accounts read or written. A made-up event says which day
    it falls on as days from today (`day`), or that it falls on every weekday
    (`weekdays`), so a demo is always of this week; one made or changed while
    showing it off is kept as it was made, by its times, in `made`.
    """

    def __init__(self, root: str) -> None:
        self.file = os.path.join(root, "calendar.json")
        try:
            with open(self.file) as f:
                self.data = json.load(f)
        except (OSError, ValueError):
            self.data = {"calendars": [], "events": [], "made": []}
        self.data.setdefault("made", [])

    def _save(self) -> None:
        tmp = f"{self.file}.tmp"
        with open(tmp, "w") as f:
            json.dump(self.data, f)
        os.replace(tmp, self.file)

    def tell_calendars(self) -> None:
        say({"calendars": [{**c, "writable": True} for c in self.data["calendars"]]})

    @staticmethod
    def _item(e: dict, start: datetime, end: datetime, all_day: bool, rid: str = "") -> dict:
        return {"calendar": e["calendar"], "uid": e["uid"], "rid": rid, "title": e.get("title", ""), "location": e.get("location", ""),
                "notes": e.get("notes", ""), "start": int(start.timestamp() * 1000), "end": int(end.timestamp() * 1000),
                "allDay": all_day, "recurring": bool(rid), "attendees": [], "mine": "", "organizer": ""}

    def _instances(self, start_ms: int, end_ms: int) -> list:
        from datetime import timedelta
        today = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0)
        lo, hi = datetime.fromtimestamp(start_ms / 1000), datetime.fromtimestamp(end_ms / 1000)
        out = []

        def at(day: datetime, e: dict) -> tuple:
            if e.get("allDay"):
                return day, day + timedelta(days=int(e.get("days", 1))), True
            h, m = (int(x) for x in str(e.get("at", "09:00")).split(":"))
            start = day.replace(hour=h, minute=m)
            return start, start + timedelta(minutes=int(e.get("minutes", 60))), False

        for e in self.data["events"]:
            if e.get("weekdays"):
                d = max(lo.replace(hour=0, minute=0, second=0, microsecond=0), today - timedelta(days=400))
                while d < hi:
                    rid = d.strftime("%Y%m%d")
                    if d.weekday() < 5 and rid not in e.get("skip", []):
                        s, t, all_day = at(d, e)
                        if s < hi and t > lo:
                            out.append(self._item(e, s, t, all_day, rid))
                    d += timedelta(days=1)
            else:
                s, t, all_day = at(today + timedelta(days=int(e.get("day", 0))), e)
                if s < hi and t > lo:
                    out.append(self._item(e, s, t, all_day))
        for e in self.data["made"]:
            s, t = datetime.fromtimestamp(e["start"] / 1000), datetime.fromtimestamp(e["end"] / 1000)
            if s < hi and t > lo:
                out.append(self._item(e, s, t, bool(e.get("allDay"))))
        return out

    def range(self, req: int, start_ms: int, end_ms: int) -> None:
        items = sorted(self._instances(start_ms, end_ms), key=lambda e: (e["start"], not e["allDay"]))
        say({"events": {"req": req, "items": items}})

    def search(self, req: int, query: str) -> None:
        words = [w for w in query.lower().split() if w]
        now = int(time.time() * 1000)
        year = 366 * 86400 * 1000
        found: dict = {}
        for e in self._instances(now - year, now + year) if words else []:
            if not all(w in f"{e['title']} {e['location']} {e['notes']}".lower() for w in words):
                continue
            rank = lambda x: (x["end"] < now, abs(x["start"] - now))  # noqa: E731
            if (e["calendar"], e["uid"]) not in found or rank(e) < rank(found[(e["calendar"], e["uid"])]):
                found[(e["calendar"], e["uid"])] = e
        items = sorted(found.values(), key=lambda e: (e["end"] < now, e["start"] if e["end"] >= now else -e["start"]))[:150]
        say({"events": {"req": req, "items": items, "search": query}})

    def _changed(self, req: int, uid: str = "") -> None:
        self._save()
        say({"done": {"req": req, "error": "", **({"uid": uid} if uid else {})}})
        say({"changed": True})

    def _find(self, uid: str):
        for where in ("made", "events"):
            for e in self.data[where]:
                if e["uid"] == uid:
                    return where, e
        return None, None

    def do(self, msg: dict) -> None:
        import uuid
        verb, req = msg.get("do"), int(msg.get("req", 0))
        if verb == "range":
            self.range(req, int(msg["from"]), int(msg["to"]))
        elif verb == "search":
            self.search(req, str(msg.get("q", ""))[:200])
        elif verb == "create":
            ev = msg["event"]
            uid = str(uuid.uuid4())
            self.data["made"].append({"calendar": str(msg["calendar"]), "uid": uid, **{k: ev.get(k) for k in ("title", "location", "notes", "start", "end", "allDay")}})
            self._changed(req, uid)
        elif verb == "update":
            where, e = self._find(str(msg["uid"]))
            if not e:
                say({"done": {"req": req, "error": "No such event"}})
                return
            ev = msg["event"]
            fresh = {"calendar": e["calendar"], "uid": e["uid"], **{k: ev.get(k) for k in ("title", "location", "notes", "start", "end", "allDay")}}
            # A made-up one changed: kept by its times from now on (one of every weekday's: that day's, the rest as they were).
            if where == "events" and e.get("weekdays") and msg.get("which") == "this" and msg.get("rid"):
                e.setdefault("skip", []).append(str(msg["rid"]))
                fresh["uid"] = str(uuid.uuid4())
            else:
                self.data[where].remove(e)
            self.data["made"].append(fresh)
            self._changed(req)
        elif verb == "delete":
            where, e = self._find(str(msg["uid"]))
            if e and e.get("weekdays") and msg.get("which") == "this" and msg.get("rid"):
                e.setdefault("skip", []).append(str(msg["rid"]))
            elif e:
                self.data[where].remove(e)
            self._changed(req)
        elif verb == "color":
            for c in self.data["calendars"]:
                if c["id"] == msg.get("calendar"):
                    c["color"] = str(msg.get("color", c.get("color")))
            self._save()
            self.tell_calendars()
            say({"done": {"req": req, "error": ""}})
        elif verb == "respond":
            say({"done": {"req": req, "error": ""}})
        elif verb == "people":
            say({"people": {"req": req, "items": []}})
        elif verb == "cards":
            say({"cards": {"req": req, "items": []}})


def demo_main(root: str) -> int:
    """Demo mode: the demo's calendar answering, line by line, as the real one does."""
    cals = DemoCalendars(root)
    say({"ready": True})
    cals.tell_calendars()
    for line in sys.stdin:
        try:
            cals.do(json.loads(line))
        except (ValueError, KeyError, TypeError) as e:
            sys.stderr.write(f"calendar (demo): {e}\n")
    return 0


def main() -> int:
    if os.environ.get("TALARIS_DEMO") and os.environ.get("TALARIS_DEMO_ROOT"):
        return demo_main(os.environ["TALARIS_DEMO_ROOT"])
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
