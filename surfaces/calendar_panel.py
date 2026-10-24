# SPDX-License-Identifier: GPL-3.0-only
# Copyright (c) 2026 Jeff Moore
"""
The calendar (calendar_panel.py, not calendar.py, which would hide Python's own
module of that name): the accounts' events, read and written, in a panel that comes
up from the bar's date and time.

**The panel** is an overlay (overlay.py), as Morgan's conversation is: up over
a dimmed screen with the windows' or the drawers' motion, away on a press off
it, and full screen by its expand button.

**The data** is Evolution Data Server's, through `calendard.py`, a child
process speaking JSON lines (why a process of its own is said there); the
accounts are GNOME Online Accounts', added in Settings, Accounts. Talaris
keeps no events of its own.
"""

from __future__ import annotations

import json
import os
import sys
import threading
import time
from datetime import datetime

from PySide6.QtCore import QObject, QProcess, QTimer, Signal, Slot
from PySide6.QtWebEngineCore import QWebEngineProfile

from core import Bridge, call as core_call
from overlay import Overlay
from views import log

HERE = os.path.dirname(os.path.abspath(__file__))

#: How far round today the calendars are mirrored into entities (DESIGN, Entities).
MIRROR_BACK_DAYS, MIRROR_AHEAD_DAYS = 90, 180
#: The mirror's own requests, numbered where the page's never reach, so the page ignores their answers.
MIRROR_REQ = 1_000_000_000


def _local(ms: int) -> str:
    """A time as the format writes a datetime: local, to the minute."""
    return datetime.fromtimestamp(ms / 1000).strftime("%Y-%m-%dT%H:%M")


def mirrored(items: list, hidden: set) -> list:
    """
    The events the calendar answered, as entities want them: one per event —
    a recurring one once, at the occurrence nearest from now on — and none
    from a calendar turned off.
    """
    now = time.time() * 1000
    best: dict = {}
    for e in items:
        if e["calendar"] in hidden or not e.get("uid"):
            continue
        key = (e["calendar"], e["uid"])
        held = best.get(key)
        upcoming = e["end"] >= now
        if held is None:
            best[key] = e
            continue
        held_up = held["end"] >= now
        # The next one still to come; failing that, the latest that has been.
        if (upcoming and (not held_up or e["start"] < held["start"])) or (not upcoming and not held_up and e["start"] > held["start"]):
            best[key] = e
    out = []
    for (calendar, uid), e in best.items():
        out.append({
            "source": {"kind": "eds-event", "key": f"{calendar}/{uid}"},
            # The same meeting in another account has the same UID.
            "also": [{"kind": "ical-uid", "key": uid}],
            "title": e.get("title") or "",
            "start": _local(e["start"]), "end": _local(e["end"]),
            "allDay": bool(e.get("allDay")),
            "location": e.get("location") or "",
            "organizer": {"email": e["organizer"]} if e.get("organizer") else None,
            "attendees": [{"email": a["email"], "name": a.get("name") or "", "status": a.get("answer") or ""}
                          for a in e.get("attendees", []) if a.get("email")],
        })
    return out
#: What to install when the calendar's bindings are missing.
NEEDS = ("gir1.2-ecal-2.0 gir1.2-edataserver-1.2 gir1.2-ebook-1.2 gir1.2-ebookcontacts-1.2 "
         "gir1.2-goa-1.0 gnome-online-accounts-gtk evolution-ews")


def with_talaris_people(query: str, items: list) -> list:
    """
    Who an invitation can go to: what the address books and the calendars
    found (`items`, {name, email}), and Talaris's own people with an address
    — someone made in New, People or an @, who may be in neither — found by
    name or by the address before its @. Each address once.
    """
    q = query.strip().lower()
    if len(q) < 2:
        return items
    status, text = core_call("GET", "/people", timeout=10)
    try:
        people = json.loads(text) if status == 200 else []
    except ValueError:
        people = []
    have = {str(i.get("email", "")).lower() for i in items}
    extra = []
    for p in people:
        email = str(p.get("email", "")).lower()
        name = p.get("title", "") if "@" not in p.get("title", "") else ""
        if not email or email in have or not (q in name.lower() or q in email.split("@")[0]):
            continue
        have.add(email)
        extra.append({"name": name, "email": email})
    return items + extra[:8]


class CalendarService(QObject):
    """calendard.py, started and spoken to; started again if it falls over, a few times."""

    calendars = Signal(str)
    events = Signal(str)
    done = Signal(str)
    people = Signal(str)
    changed = Signal()
    #: `{ready, error, needs}`: whether there is a calendar to show at all.
    status = Signal(str)
    #: A message for calendard from another thread, sent from this one.
    _ask = Signal(str)
    #: An event New asked for, written or not: {req, error, uid}.
    made = Signal(str)

    def __init__(self, parent: QObject) -> None:
        super().__init__(parent)
        self.process: QProcess | None = None
        self.last_calendars = "[]"
        self.state = {"ready": False, "error": "Starting", "needs": ""}
        self._buffer = b""
        self._errors = ""
        self._restarts = 0
        # Events into entities: a wide range, on start and when anything changes.
        self._mirror_req = MIRROR_REQ
        self._mirror_waiting: set = set()
        self._mirror_soon = QTimer(self)
        self._mirror_soon.setSingleShot(True)
        self._mirror_soon.timeout.connect(self.mirror)
        self.changed.connect(lambda: self._mirror_soon.start(30_000))
        self._mirror_every = QTimer(self)
        self._mirror_every.timeout.connect(self.mirror)
        self._mirror_every.start(6 * 60 * 60 * 1000)
        # People looked up for an @, waited on by the asking thread: req → [Event, answer].
        self._finding: dict = {}
        self._find_req = 2 * MIRROR_REQ
        self._make_req = 3 * MIRROR_REQ
        #: The calendar page's invitee searches, by request: what was typed, to find Talaris's people by too.
        self._queries: dict = {}
        self._lock = threading.Lock()
        self._ask.connect(lambda text: self.send(json.loads(text)))
        self._start()

    def _start(self) -> None:
        p = QProcess(self)
        p.setProgram(sys.executable)
        p.setArguments(["-W", "ignore::DeprecationWarning", os.path.join(HERE, "calendard.py")])
        p.readyReadStandardOutput.connect(self._read)
        p.readyReadStandardError.connect(self._stderr)
        p.finished.connect(self._ended)
        self._errors = ""
        p.start()
        self.process = p

    def _stderr(self) -> None:
        text = bytes(self.process.readAllStandardError()).decode("utf-8", "replace")
        self._errors += text
        for line in text.strip().splitlines():
            log(f"calendar: {line}")

    def _ended(self, code: int, _status) -> None:
        if "Namespace" in self._errors and "not available" in self._errors:
            # The bindings are not installed: say what to install, and do not try again.
            self._tell({"ready": False, "error": "The calendar needs a few packages", "needs": NEEDS})
            return
        self._tell({"ready": False, "error": f"The calendar stopped ({code})", "needs": ""})
        if self._restarts < 3:
            self._restarts += 1
            QTimer.singleShot(3000, self._start)

    def _tell(self, state: dict) -> None:
        log(f"calendar: {'ready' if state.get('ready') else state.get('error', '')}")
        self.state = state
        self.status.emit(json.dumps(state))

    def _read(self) -> None:
        self._buffer += bytes(self.process.readAllStandardOutput())
        *lines, self._buffer = self._buffer.split(b"\n")
        for line in lines:
            try:
                msg = json.loads(line)
            except ValueError:
                continue
            if "ready" in msg:
                self._tell({"ready": bool(msg["ready"]), "error": msg.get("error", ""), "needs": ""})
                # Accounts connect one by one after ready: give them a moment.
                if msg["ready"]:
                    self._mirror_soon.start(20_000)
            elif "calendars" in msg:
                self.last_calendars = json.dumps(msg["calendars"])
                self.calendars.emit(self.last_calendars)
            elif "events" in msg:
                if msg["events"].get("req") in self._mirror_waiting:
                    self._mirror_waiting.discard(msg["events"]["req"])
                    self._mirror_out(msg["events"].get("items", []))
                else:
                    self.events.emit(json.dumps(msg["events"]))
            elif "done" in msg:
                # New's own, numbered from where the calendar page's never reach.
                (self.made if msg["done"].get("req", 0) > 3 * MIRROR_REQ else self.done).emit(json.dumps(msg["done"]))
            elif "cards" in msg:
                waiting = self._finding.get(msg["cards"].get("req"))
                if waiting:
                    waiting[1] = msg["cards"].get("items", [])
                    waiting[0].set()
            elif "people" in msg:
                waiting = self._finding.get(msg["people"].get("req"))
                if waiting:
                    waiting[1] = msg["people"].get("items", [])
                    waiting[0].set()
                else:
                    # The calendar page's invitee search: Talaris's people added, off this thread.
                    found = msg["people"]
                    query = self._queries.pop(found.get("req"), "")
                    threading.Thread(target=lambda: self.people.emit(json.dumps(
                        {**found, "items": with_talaris_people(query, found.get("items", []))})), daemon=True).start()
            elif msg.get("changed"):
                self.changed.emit()

    def mirror(self) -> None:
        """Ask for the wide range; its answer goes to the core, not the page."""
        if not self.state.get("ready"):
            return
        self._mirror_req += 1
        self._mirror_waiting.add(self._mirror_req)
        now = int(time.time() * 1000)
        day = 24 * 60 * 60 * 1000
        self.send({"do": "range", "req": self._mirror_req, "from": now - MIRROR_BACK_DAYS * day, "to": now + MIRROR_AHEAD_DAYS * day})

    def _mirror_out(self, items: list) -> None:
        desktop = self.parent()
        hidden = set(getattr(desktop, "config", {}).get("calendar", {}).get("hidden", []))
        events = mirrored(items, hidden)

        def send() -> None:
            done = 0
            for i in range(0, len(events), 100):
                status, text = core_call("POST", "/entities/mirror/events", json.dumps({"events": events[i:i + 100]}), timeout=60)
                if status != 200:
                    log(f"calendar: mirroring stopped ({status}): {text[:200]}")
                    return
                done += len(events[i:i + 100])
            log(f"calendar: {done} events mirrored as entities")
            self._name_people()
        threading.Thread(target=send, daemon=True).start()

    def _name_people(self) -> None:
        """
        People known only by an address, given the name an address book has
        for it: a person is called by name where one is known, by address only
        until then. From the mirror's own thread.
        """
        status, text = core_call("GET", "/entities?kind=contact&limit=5000", timeout=30)
        if status != 200:
            return
        named = 0
        for p in json.loads(text):
            title = p.get("title", "")
            if "@" not in title or " " in title.strip():
                continue
            email = title.strip().lower()
            found = next((f for f in self.find_people(email) if f.get("email", "").lower() == email and f.get("name") and "@" not in f["name"]), None)
            if found:
                status, _ = core_call("POST", "/entities/person", json.dumps({"email": email, "name": found["name"]}), timeout=10)
                named += status == 200
        if named:
            log(f"calendar: {named} people named from the address books")

    def find_cards(self, query: str = "", keys: list | None = None, wait: float = 3.0) -> list:
        """Address-book cards (calendard `cards`), from a worker thread, waited for here: by search, or by "book/uid"."""
        if not self.state.get("ready"):
            return []
        with self._lock:
            self._find_req += 1
            req = self._find_req
        waiting = [threading.Event(), []]
        self._finding[req] = waiting
        self._ask.emit(json.dumps({"do": "cards", "req": req, "q": query, "keys": keys or []}))
        waiting[0].wait(wait)
        self._finding.pop(req, None)
        return waiting[1]

    def find_people(self, query: str, wait: float = 2.0) -> list:
        """
        The address books' people and those met in the calendars, as the
        invitee picker finds them — for an @, from a worker thread: asked on
        this object's own thread, the answer waited for here. Nothing, if the
        calendar is not up or does not answer in time.
        """
        if not self.state.get("ready"):
            return []
        with self._lock:
            self._find_req += 1
            req = self._find_req
        waiting = [threading.Event(), []]
        self._finding[req] = waiting
        self._ask.emit(json.dumps({"do": "people", "req": req, "q": query}))
        waiting[0].wait(wait)
        self._finding.pop(req, None)
        return with_talaris_people(query, waiting[1])

    def make_event(self, calendar: str, event: dict) -> int:
        """An event written to a calendar, for New: the answer comes as `made`, under the number given back."""
        self._make_req += 1
        self.send({"do": "create", "req": self._make_req, "calendar": calendar, "event": event})
        return self._make_req

    def send(self, msg: dict) -> None:
        if self.process and self.process.state() == QProcess.ProcessState.Running:
            self.process.write((json.dumps(msg) + "\n").encode())

    def stop(self) -> None:
        self._restarts = 3
        if self.process and self.process.state() != QProcess.ProcessState.NotRunning:
            self.process.closeWriteChannel()
            self.process.waitForFinished(1000)


class CalendarBridge(Bridge):
    calendars = Signal(str)
    events = Signal(str)
    done = Signal(str)
    people = Signal(str)
    changed = Signal()
    status = Signal(str)

    @Slot(result=str)
    def hello(self) -> str:
        """What there is now, for a page just loaded: the status and the calendars."""
        svc = self.owner.service
        return json.dumps({"status": svc.state, "calendars": json.loads(svc.last_calendars)})

    @Slot(str)
    def ask(self, request: str) -> None:
        """`{do: range|create|update|delete, req, …}`, passed to the calendar's process as it is."""
        msg = json.loads(request)
        if msg.get("do") in ("range", "create", "update", "delete", "respond", "people"):
            if msg.get("do") == "people":
                self.owner.service._queries[msg.get("req")] = str(msg.get("q", ""))
            self.owner.service.send(msg)

    @Slot()
    def accounts(self) -> None:
        """Settings, Accounts."""
        self.owner.file_away()
        self.owner.desktop.settings.open("accounts")


class Calendar(Overlay):
    NAME = "calendar"
    TITLE = "Calendar"
    IDLE_MS = 5 * 60 * 1000

    def describe(self) -> dict:
        return {**super().describe(), "hidden": self.desktop.config.get("calendar", {}).get("hidden", [])}

    def __init__(self, profile: QWebEngineProfile, desktop, service: CalendarService) -> None:
        super().__init__(profile, desktop, "talaris-ui://ui/calendar.html", CalendarBridge(None, None))
        self.bridge.owner = self
        self.bridge.setParent(self)
        self.service = service
        service.calendars.connect(self.bridge.calendars.emit)
        service.events.connect(self.bridge.events.emit)
        service.done.connect(self.bridge.done.emit)
        service.people.connect(self.bridge.people.emit)
        service.changed.connect(self.bridge.changed.emit)
        service.status.connect(self.bridge.status.emit)

    def opened(self) -> None:
        self.desktop.bar.bridge.state.emit(json.dumps(self.desktop.bar.describe()))

    def closed(self) -> None:
        self.desktop.bar.bridge.state.emit(json.dumps(self.desktop.bar.describe()))
