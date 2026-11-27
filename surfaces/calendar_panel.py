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
import re
import sys
import threading
import time
from datetime import datetime

from PySide6.QtCore import QObject, QProcess, QTimer, Signal, Slot
from PySide6.QtWebEngineCore import QWebEngineProfile

from core import Bridge, call as core_call, get_json
from files import attach_files, attach_to_task, link_to_task, open_kept_file
from overlay import Overlay
from views import log

HERE = os.path.dirname(os.path.abspath(__file__))

#: How far round today the calendars are mirrored into entities (DESIGN, Entities).
MIRROR_BACK_DAYS, MIRROR_AHEAD_DAYS = 90, 180
#: How far back the calendars are shared (calendar-view.ts): the weeks behind are looked back at; further, not on the web.
VIEW_BACK_DAYS = 30
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
    # A series: any occurrence that says so (a rule, or an occurrence's own id), or more than one under one UID.
    series: set = set()
    for e in items:
        if e["calendar"] in hidden or not e.get("uid"):
            continue
        key = (e["calendar"], e["uid"])
        if e.get("recurring") or e.get("rid") or key in best:
            series.add(key)
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
            # One of a series: never joined to a single meeting a sync brings (the core's own-calendar.ts).
            "recurring": (calendar, uid) in series,
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
    people = get_json("/people", [], timeout=10)
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
    #: An event's card in the Library, answered: {req, error, uid}.
    asked = Signal(str)

    def __init__(self, parent: QObject) -> None:
        super().__init__(parent)
        self.process: QProcess | None = None
        self.last_calendars = "[]"
        #: The calendars another machine shared (the core's /calendar/view), shown read-only where this one reads no
        #: account of its own — the mini, a new machine — as the web shows them (docs/WEB.md, Calendar).
        self.shared: list = []
        #: The page's range and search requests, by number: what to add the shared calendars' events to.
        self._asked: dict = {}
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

    def zone_changed(self) -> None:
        """The time zone changed (location.py): calendard reads it as it starts, so it is started again."""
        if self.process and self.process.state() == QProcess.ProcessState.Running:
            self._again = True
            self.process.terminate()
        else:
            self._start()

    def _ended(self, code: int, _status) -> None:
        if getattr(self, "_again", False):
            # Ended on purpose, to read the new zone: started again at once, and not counted as falling over.
            self._again = False
            self._start()
            return
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
                    self.quiet()
            elif "calendars" in msg:
                self.last_calendars = json.dumps(msg["calendars"])
                self.calendars.emit(self.calendars_now())
                threading.Thread(target=self._read_shared, daemon=True).start()
            elif "events" in msg and msg["events"].get("req") in self._finding:
                # A search asked from another thread (find_events): handed to it.
                waiting = self._finding.get(msg["events"].get("req"))
                if waiting:
                    waiting[1] = msg["events"].get("items", [])
                    waiting[0].set()
            elif "events" in msg:
                if msg["events"].get("req") in self._mirror_waiting:
                    self._mirror_waiting.discard(msg["events"]["req"])
                    self._mirror_out(msg["events"].get("items", []))
                elif not self.reads_accounts() and msg["events"].get("req") in self._asked:
                    # No accounts here: the shared calendars' events beside this machine's own, read off this thread.
                    asked = self._asked.pop(msg["events"]["req"])
                    threading.Thread(target=lambda: self.events.emit(json.dumps(self._with_shared(msg["events"], asked))), daemon=True).start()
                else:
                    self._asked.pop(msg["events"].get("req"), None)
                    self.events.emit(json.dumps(msg["events"]))
            elif "done" in msg:
                # New's own, and an event's card's in the Library, numbered from where the calendar page's never reach.
                req = msg["done"].get("req", 0)
                (self.asked if req > 4 * MIRROR_REQ else self.made if req > 3 * MIRROR_REQ else self.done).emit(json.dumps(msg["done"]))
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

    # ---------------------------------------------------------------- with no accounts: what another machine shared

    def reads_accounts(self) -> bool:
        """Whether this machine reads an account's calendar: one that is neither a feed nor only on this computer."""
        try:
            return any(not c.get("feed") and c.get("account") not in ("On this computer", "Feeds") for c in json.loads(self.last_calendars or "[]"))
        except (ValueError, TypeError):
            return False

    def calendars_now(self) -> str:
        """This machine's calendars, and the shared ones when it reads no account itself."""
        mine = json.loads(self.last_calendars or "[]")
        return json.dumps(mine if self.reads_accounts() else mine + self.shared)

    def _read_shared(self) -> None:
        """The shared calendars, read again (off the Qt thread); the page told if they changed."""
        if self.reads_accounts():
            if self.shared:
                self.shared = []
                self.calendars.emit(self.calendars_now())
            return
        status, text = core_call("GET", "/calendar/view?from=0&to=0", timeout=15)
        if status != 200:
            return
        try:
            v = json.loads(text)
        except ValueError:
            return
        by = v.get("by") or "another machine"
        at = ""
        try:
            at = datetime.fromisoformat(str(v.get("at", "")).replace("Z", "+00:00")).astimezone().strftime("%b %-d, %-I:%M %p")
        except ValueError:
            pass
        shared = [{**c, "account": f"Shared by {by}" + (f" · {at}" if at else ""), "writable": False, "invites": False,
                   "connected": True, "shared": True} for c in v.get("calendars", [])]
        if shared != self.shared:
            self.shared = shared
            self.calendars.emit(self.calendars_now())

    def _with_shared(self, events: dict, asked: dict) -> dict:
        """A range or a search answered here, with the shared calendars' events in it too."""
        if asked.get("do") == "range":
            frm, to = int(asked.get("from") or 0), int(asked.get("to") or 0)
        else:
            now, year = int(time.time() * 1000), 365 * 24 * 60 * 60 * 1000
            frm, to = now - year, now + year
        status, text = core_call("GET", f"/calendar/view?from={frm}&to={to}", timeout=15)
        try:
            items = json.loads(text).get("items", []) if status == 200 else []
        except ValueError:
            items = []
        if asked.get("do") == "search":
            words = str(asked.get("q", "")).lower().split()
            items = [e for e in items if all(w in f"{e.get('title', '')} {e.get('location', '')} {e.get('notes', '')}".lower() for w in words)]
        self._read_shared()
        return {**events, "items": list(events.get("items", [])) + items}

    def quiet(self) -> None:
        """The calendars hidden or muted: their reminders off (calendard `quiet`); the rest's as they were."""
        cal = getattr(self.parent(), "config", {}).get("calendar", {})
        self.send({"do": "quiet", "req": 0, "calendars": sorted(set(cal.get("hidden", [])) | set(cal.get("muted", [])))})

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
        # A feed's events are someone else's, often hundreds of them: not things of yours until one is made yours (calendar.js).
        try:
            hidden |= {c["id"] for c in json.loads(self.last_calendars or "[]") if c.get("feed")}
        except (ValueError, TypeError, KeyError):
            pass
        events = mirrored(items, hidden)
        # The same reading, shared whole (calendar-view.ts): every calendar's name and color and every occurrence over
        # a window, for the machines with no accounts of their own — home-server, and the web (docs/WEB.md, Calendar).
        now = time.time() * 1000
        day = 24 * 60 * 60 * 1000
        try:
            calendars = [c for c in json.loads(self.last_calendars or "[]") if c.get("id") not in hidden]
        except (ValueError, TypeError):
            calendars = []
        view = {"from": now - VIEW_BACK_DAYS * day, "to": now + MIRROR_AHEAD_DAYS * day, "calendars": calendars,
                "items": [e for e in items if e.get("calendar") not in hidden and e.get("end", 0) >= now - VIEW_BACK_DAYS * day]}

        # A machine that reads no account shares nothing: its reading would put an empty view over the one a machine
        # with accounts shared, which is what this machine shows (`shared`) and what the web and Morgan read.
        shares = self.reads_accounts()

        def send() -> None:
            status, text = core_call("PUT", "/calendar/view", json.dumps(view), timeout=60) if shares else (204, "{}")
            if status == 200:
                said = json.loads(text)
                if said.get("changed"):
                    log(f"calendar: shared, {said.get('events', 0)} occurrences")
            elif shares:
                log(f"calendar: not shared ({status}): {text[:200]}")
            done = 0
            for i in range(0, len(events), 100):
                status, text = core_call("POST", "/entities/mirror/events", json.dumps({"events": events[i:i + 100]}), timeout=60)
                if status != 200:
                    log(f"calendar: mirroring stopped ({status}): {text[:200]}")
                    return
                done += len(events[i:i + 100])
            log(f"calendar: {done} events mirrored as entities")
            self._name_people()
            self.tie_people()
        threading.Thread(target=send, daemon=True).start()

    def tie_people(self) -> None:
        """
        Everyone in the address books, as people (DESIGN, People): each card
        tied to the person with its address, or made one — what it says
        filling only what is empty — save cards whose person was deleted, and
        anyone marked never to be offered a contact. Only an exact address
        ties without asking; a name alike stays a suggestion, in People. From
        a worker thread, after each reading of the calendars.
        """
        cards = [c for c in self.find_cards(everything=True, wait=20) if c.get("book") and c.get("uid") and not c.get("gone")]
        made = tied = 0
        for i in range(0, len(cards), 200):
            batch = [{"key": f"{c['book']}/{c['uid']}", "name": c.get("name", ""), "emails": c.get("emails", []),
                      "phones": c.get("phones", []), "org": c.get("org", ""), "role": c.get("role", "")} for c in cards[i:i + 200]]
            status, text = core_call("POST", "/people/from-cards", json.dumps({"cards": batch}), timeout=60)
            if status == 200:
                r = json.loads(text)
                made, tied = made + r.get("made", 0), tied + r.get("tied", 0)
        if made or tied:
            log(f"calendar: from {len(cards)} contact cards, {made} people made and {tied} tied")

    def _name_people(self) -> None:
        """
        People known only by an address, given the name an address book has
        for it: a person is called by name where one is known, by address only
        until then. From the mirror's own thread.
        """
        contacts = get_json("/entities?kind=contact&limit=5000", None, timeout=30)
        if not isinstance(contacts, list):
            return
        named = 0
        for p in contacts:
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

    def find_cards(self, query: str = "", keys: list | None = None, wait: float = 3.0, everything: bool = False) -> list:
        """Address-book cards (calendard `cards`), from a worker thread, waited for here: by search, or by "book/uid"."""
        if not self.state.get("ready"):
            return []
        with self._lock:
            self._find_req += 1
            req = self._find_req
        waiting = [threading.Event(), []]
        self._finding[req] = waiting
        self._ask.emit(json.dumps({"do": "cards", "req": req, "q": query, "keys": keys or [], "all": everything}))
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

    def find_events(self, query: str, wait: float = 4.0) -> list:
        """Events holding every word, a year either side (calendard `search`), from a worker thread, waited for here."""
        if not self.state.get("ready"):
            return []
        with self._lock:
            self._find_req += 1
            req = self._find_req
        waiting = [threading.Event(), []]
        self._finding[req] = waiting
        self._ask.emit(json.dumps({"do": "search", "req": req, "q": query}))
        waiting[0].wait(wait)
        self._finding.pop(req, None)
        return waiting[1]

    def today_text(self, wait: float = 4.0) -> str | None:
        """
        Today's events in the calendars shown, as lines for a model to read (a project chat's brief, core.py): from a
        worker thread, waited for here. "" for a day with nothing on it; None when the calendar is not up or does not
        answer in time — not known, which is not the same as empty.
        """
        if not self.state.get("ready"):
            return None
        with self._lock:
            self._find_req += 1
            req = self._find_req
        waiting = [threading.Event(), None]
        self._finding[req] = waiting
        midnight = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0)
        start = int(midnight.timestamp() * 1000)
        self._ask.emit(json.dumps({"do": "range", "req": req, "from": start, "to": start + 24 * 60 * 60 * 1000}))
        waiting[0].wait(wait)
        self._finding.pop(req, None)
        if waiting[1] is None:
            return None
        hidden = set(getattr(self.parent(), "config", {}).get("calendar", {}).get("hidden", []))
        lines = []
        for e in waiting[1]:
            if e.get("calendar") in hidden:
                continue
            if e.get("allDay"):
                when = "all day"
            else:
                fmt = lambda ms: datetime.fromtimestamp(ms / 1000).strftime("%-I:%M %p")  # noqa: E731
                when = f"{fmt(e['start'])}–{fmt(e['end'])}"
            where = f" ({e['location']})" if e.get("location") else ""
            lines.append(f"- {when}: {e.get('title') or 'Busy'}{where}")
        return "\n".join(lines)

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


#: What the page may ask the core for: the tasks on the days on show, ticking one done, moving its dates.
TASK_ROUTES = re.compile(r"^/tasks/days\?from=\d{4}-\d\d-\d\d&to=\d{4}-\d\d-\d\d(&overdue=1)?$|^/tasks/find\?text=[^&]*&limit=\d+$|^/tasks/[A-Za-z0-9_.:-]+/(done|shift)$"
                         # An event's notes take @ (mentions.js): finding what to name, making a person or a task by name, and opening one.
                         r"|^/mentionables\?|^/people/find\?|^/entities/[A-Za-z0-9_.:-]+(/place)?(\?shown=1)?$|^/entities(/person)?$|^/tasks$"
                         # The calendars plugins bring, and what is on them.
                         r"|^/plugins/calendars(/events\?from=\d+&to=\d+|/taken|/talaris)?$"
                         # An event's projects: the event's entity, made if the mirror has not reached it, and what it is filed under.
                         r"|^/tasks/projects$|^/entities/by-source\?kind=[a-z-]+&key=[^&]*$|^/entities/mirror/events$|^/entities/[A-Za-z0-9_.:-]+/projects$"
                         # And its card: what it is connected to, taken apart, and what it might be.
                         r"|^/entities/[A-Za-z0-9_.:-]+/connect/[A-Za-z0-9_.:-]+$|^/suggestions(/|\?)|^/entity-types$")


class CalendarBridge(Bridge):
    #: The forecast for its days and hours, when the page shows the weather ({"state", "error"}; location.py).
    weather = Signal(str)
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
        return json.dumps({"status": svc.state, "calendars": json.loads(svc.calendars_now())})

    @Slot(str)
    def ask(self, request: str) -> None:
        """`{do: range|create|update|delete|subscribe|unsubscribe, req, …}`, passed to the calendar's process as it is."""
        msg = json.loads(request)
        if msg.get("do") in ("range", "search", "create", "update", "delete", "respond", "people", "subscribe", "unsubscribe", "color", "refresh"):
            if msg.get("do") == "people":
                self.owner.service._queries[msg.get("req")] = str(msg.get("q", ""))
            if msg.get("do") in ("range", "search"):
                self.owner.service._asked[msg.get("req")] = msg
            self.owner.service.send(msg)

    @Slot(str, bool)
    def mute(self, calendar: str, on: bool) -> None:
        """A calendar set aside in the list, or brought back: kept in the configuration, its reminders with it."""
        muted = [c for c in self.owner.desktop.config.get("calendar", {}).get("muted", []) if c != calendar] + ([calendar] if on else [])
        error = self.owner.desktop.settings.apply({"calendar": {"muted": muted}})
        if error:
            log(f"calendar: not muted: {error}")

    @Slot(str, str, str, str)
    def core(self, ident: str, method: str, path: str, body: str) -> None:
        """Tasks above the day's events, and @ in an event's notes: only the routes for them (TASK_ROUTES), answered later on `coreReply`."""
        self.answer_core(ident, method, path, body, TASK_ROUTES, timeout=30, who="the calendar")

    #: Files chosen for a card and kept, or why not: {id, field, added, error}, or a task's {task, added, error}.
    attached = Signal(str)

    @Slot(str, str)
    def attach(self, entity: str, field: str) -> None:
        """Files for a field on a card — an event's, or a connected thing's — from the desktop's chooser."""
        attach_files(self.owner, entity, field, self.attached.emit)

    @Slot(str)
    def attachTask(self, task: str) -> None:  # noqa: N802 — called from the page by this name
        attach_to_task(self.owner, task, self.attached.emit)

    @Slot(str)
    def linkTask(self, task: str) -> None:  # noqa: N802 — called from the page by this name
        link_to_task(self.owner, task, self.attached.emit)

    @Slot(str, str)
    def openFile(self, sha: str, filename: str) -> None:  # noqa: N802 — called from the page by this name
        open_kept_file(sha, filename)

    @Slot(str)
    def openTask(self, entity: str) -> None:
        """A task, open in Tasks' editor (the panel goes, out of its way)."""
        self.owner.file_away()
        self.owner.desktop.show_task(entity)

    @Slot()
    def weatherRead(self) -> None:  # noqa: N802 — called from the page by this name
        """The forecast, for the weather on its days and hours: answered on `weather`."""
        location = getattr(self.owner.desktop, "location", None)
        if location is not None:
            location.forecast("calendar")
        else:
            self.weather.emit(json.dumps({"state": None, "error": "Location is off"}))

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
        cal = self.desktop.config.get("calendar", {})
        return {**super().describe(), "hidden": cal.get("hidden", []), "muted": cal.get("muted", [])}

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
