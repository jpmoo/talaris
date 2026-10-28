# SPDX-License-Identifier: GPL-3.0-only
# Copyright (c) 2026 Jeff Moore
"""
What is done through Talaris, kept — and what it suggests about how you work
(DESIGN, roadmap 20; the core's activity.ts keeps it, sealed).

**Every choice is yours** (Settings, Activity), and nothing is kept until it
is turned on:

- how much: what is done through Talaris (`actions`); that and which
  application has your attention, for how long (`focus`); that and the
  windows' titles (`titles`);
- how long it is kept: 30, 90 or 365 days;
- where suggestions come: Morgan, asked any time, with a nudge once a week
  (`morgan`); a notification with Do it and Not for me (`notify`); or only
  when asked (`asked`);
- what Morgan may read: a summary (`summary`), everything (`raw`), or
  nothing, Talaris's own rules only (`local`).

**Never the Oracle.** Morgan reads it through Talaris's MCP, which offers it
to Morgan's own client alone; and Morgan, having read it, does not consult
the Oracle in that conversation.

Recording is off the screen's thread, in order: one worker, a queue.
"""

from __future__ import annotations

import json
import queue
import threading
import time

from PySide6.QtCore import QObject, QTimer, Signal

import core
import hypr
from views import log

DEFAULTS = {"enabled": False, "grain": "actions", "keep": 90, "suggest": "morgan", "share": "summary"}
#: A focus span shorter than this is passing through, not attention.
FOCUS_MIN_S = 5
#: How often suggestions are looked for, and how long between two offered unasked.
LOOK_MS = 6 * 3600 * 1000
OFFER_EVERY_S = 7 * 24 * 3600
#: How many times a thing must have happened, in the last 30 days, to be a habit.
HABIT = 4


class Activity(QObject):
    #: Suggestions found again (Settings' list listens).
    suggested = Signal()

    def __init__(self, desktop) -> None:
        super().__init__(desktop)
        self.desktop = desktop
        self._queue: queue.Queue = queue.Queue()
        threading.Thread(target=self._send_all, name="activity", daemon=True).start()
        self._classes: dict[str, str] = {}
        self._focus: tuple[str, str, str, float] | None = None  # address, app, project, since
        ev = desktop.events
        ev.opened.connect(self._opened)
        ev.closed.connect(self._closed)
        ev.windows.connect(self._focus_changed)
        self.tell_core()
        self._look = QTimer(self)
        self._look.timeout.connect(self.offer)
        self._look.start(LOOK_MS)

    # ------------------------------------------------------------ settings

    def settings(self) -> dict:
        return {**DEFAULTS, **self.desktop.config.get("activity", {})}

    def on(self) -> bool:
        return bool(self.settings()["enabled"])

    def tell_core(self) -> None:
        """How long the core keeps it, and what Morgan may read: the core holds both."""
        s = self.settings()
        self._queue.put(("PUT", "/activity/settings", {"keep": int(s["keep"]), "share": s["share"]}))

    # ------------------------------------------------------------ recording

    def record(self, verb: str, app: str = "", project: str | None = None, to: str = "", target: str = "",
               title: str = "", seconds: int | None = None) -> None:
        """One thing done, kept as far as the settings say — or not at all while they are off."""
        s = self.settings()
        if not s["enabled"]:
            return
        if verb == "window.focus" and s["grain"] == "actions":
            return
        entry = {"verb": verb, "app": app, "project": self.desktop.project.get("id", "") if project is None else project,
                 "to": to, "target": target}
        if title and s["grain"] == "titles":
            entry["title"] = title
        if seconds is not None:
            entry["seconds"] = int(seconds)
        self._queue.put(("POST", "/activity", {k: v for k, v in entry.items() if v not in ("", None)}))

    def _send_all(self) -> None:
        while True:
            method, path, body = self._queue.get()
            status, text = core.call(method, path, json.dumps(body), timeout=5)
            if status >= 400 and status != 503:
                log(f"activity: not kept ({status} {text[:80]})")

    # ------------------------------------------------------------ windows

    def _client(self, address: str) -> dict:
        try:
            return next((c for c in json.loads(hypr.ask("j/clients") or "[]") if c.get("address") == address), {})
        except (OSError, ValueError):
            return {}

    def _app_of(self, c: dict) -> str:
        cls = c.get("class") or c.get("initialClass") or ""
        app = self.desktop.apps.lookup(cls) if cls else {}
        return app.get("id") or cls

    def _project_of(self, c: dict) -> str:
        name = c.get("workspace", {}).get("name", "")
        home = next((p.get("id", "") for p in core.projects() if p.get("home")), "")
        return hypr.project_of(name, home) or self.desktop.project.get("id", "")

    def _opened(self, address: str) -> None:
        if not self.on():
            return
        # Laid out a moment after it opens; asked then.
        def later() -> None:
            c = self._client(address)
            if not c:
                return
            app = self._app_of(c)
            self._classes[address] = app
            self.record("window.open", app=app, project=self._project_of(c), title=c.get("title", ""))
        QTimer.singleShot(400, later)

    def _closed(self, address: str) -> None:
        app = self._classes.pop(address, "")
        if app:
            self.record("window.close", app=app)

    def _focus_changed(self) -> None:
        """Attention moved: the span that ended, kept (at `focus` and finer)."""
        if not self.on() or self.settings()["grain"] == "actions":
            self._focus = None
            return
        try:
            c = json.loads(hypr.ask("j/activewindow") or "{}")
        except (OSError, ValueError):
            return
        address = c.get("address", "")
        if self._focus and self._focus[0] == address:
            return
        now = time.monotonic()
        if self._focus:
            _, app, project, since = self._focus
            if now - since >= FOCUS_MIN_S and app:
                self.record("window.focus", app=app, project=project, seconds=int(now - since))
        self._focus = (address, self._app_of(c), self._project_of(c), now) if address else None

    # ------------------------------------------------------------ suggestions

    def suggestions(self) -> list[dict]:
        """
        What the last 30 days say could go better, as things Talaris can do:
        an application always sent to one project, kept there; one opened
        often in a project and not pinned there, pinned; two always opened
        together, pinned there both. Less what is already so, and what you
        turned down for good.
        """
        summary = core.get_json("/activity/summary?days=30", None)
        dismissed = set(core.get_json("/activity/dismissed", []) or [])
        if not isinstance(summary, dict):
            return []
        dock = self.desktop.config.get("dock", {})
        pinned_all = set(dock.get("pinned", []))
        pinned_in = {p: set(ids) for p, ids in dock.get("pinnedIn", {}).items()}
        stays = dock.get("stays", {})
        names = {p.get("id"): p.get("name", "") for p in core.projects()}
        app_name = lambda a: (self.desktop.apps.lookup(a) or {}).get("name") or a  # noqa: E731
        out = []

        def add(key: str, text: str, do: dict) -> None:
            if key not in dismissed and not any(s["key"] == key for s in out):
                out.append({"key": key, "text": text, "do": do})

        for s in summary.get("sends", []):
            app, to = s.get("app", ""), s.get("to", "")
            if s.get("count", 0) >= HABIT and to in names and stays.get(app) != to:
                add(f"keep:{app}:{to}", f"You often send {app_name(app)} to {names[to]}. Keep it there?", {"keep": app, "in": to})
        for o in summary.get("opens", []):
            app, project = o.get("app", ""), o.get("project", "")
            if o.get("count", 0) >= HABIT * 2 and project in names and app not in pinned_all and app not in pinned_in.get(project, set()):
                add(f"pin:{app}:{project}", f"You open {app_name(app)} often in {names[project]}. Pin it to the dock there?", {"pin": [app], "in": project})
        for t in summary.get("together", []):
            a, b = t.get("a", ""), t.get("b", "")
            where = next((o.get("project") for o in summary.get("opens", []) if o.get("app") == a and o.get("project") in names), "")
            have = pinned_all | pinned_in.get(where, set())
            if t.get("count", 0) >= HABIT and where and not ({a, b} <= have):
                add(f"pair:{a}:{b}:{where}", f"{app_name(a)} and {app_name(b)} are usually opened together. Pin both in {names[where]}?", {"pin": [a, b], "in": where})
        return out[:6]

    def do(self, s: dict) -> None:
        """A suggestion taken: the dock set so, as its own menu would."""
        do = s.get("do", {})
        dock = json.loads(json.dumps(self.desktop.config.get("dock", {})))
        where = do.get("in", "")
        pinned_in = dock.setdefault("pinnedIn", {})
        if "keep" in do:
            app = do["keep"]
            if app not in dock.get("pinned", []):
                pinned_in.setdefault(where, [])
                if app not in pinned_in[where]:
                    pinned_in[where].append(app)
            dock.setdefault("stays", {})[app] = where
        for app in do.get("pin", []):
            if app not in dock.get("pinned", []) and app not in pinned_in.setdefault(where, []):
                pinned_in[where].append(app)
        error = self.desktop.settings.apply({"dock": dock})
        if error:
            log(f"activity: suggestion not taken ({error})")
            return
        self.record("suggestion.done", target=s.get("key", ""))
        self.suggested.emit()

    def dismiss(self, key: str) -> None:
        """Turned down for good: never suggested again."""
        core.call("POST", "/activity/dismissed", json.dumps({"key": key}))
        self.record("suggestion.dismissed", target=key)
        self.suggested.emit()

    def offer(self) -> None:
        """Once a week at most, unasked, as Settings says: a notification each, or one nudge to ask Morgan."""
        s = self.settings()
        if not s["enabled"] or s["suggest"] == "asked":
            return
        last = float(self.desktop.config.get("activity", {}).get("offered", 0))
        if time.time() - last < OFFER_EVERY_S:
            return

        def look() -> None:
            found = self.suggestions()
            if found:
                QTimer.singleShot(0, lambda: self._offer(found))
        threading.Thread(target=look, daemon=True).start()

    def _offer(self, found: list[dict]) -> None:
        s = self.settings()
        self.desktop.config.setdefault("activity", {})["offered"] = time.time()
        from config import save_config
        save_config(self.desktop.config)
        notes = self.desktop.notifications
        if s["suggest"] == "notify":
            for x in found[:3]:
                notes.own("A suggestion", x["text"], [("do", "Do it"), ("no", "Not for me")],
                          lambda key, x=x: self.do(x) if key == "do" else self.dismiss(x["key"]) if key == "no" else None)
        else:
            notes.own("Morgan has thoughts on how you work", f"{len(found)} suggestion{'s' if len(found) != 1 else ''} from your last month.",
                      [("ask", "Ask Morgan")], lambda key: self.desktop.morgan.ask("How could I work better? Look at how I've been working.") if key == "ask" else None)
