# SPDX-License-Identifier: GPL-3.0-only
# Copyright (c) 2026 Jeff Moore
"""
Notifications (DESIGN, item 16): Talaris's own, in place of mako.

**The server** is a child process (notifyd.py) holding the desktop's
notification name on D-Bus; mako, which held it, is stopped first — by its
pid — and comes back by itself (D-Bus starts it) whenever Talaris is not
running. **What comes in** is kept here, the newest first, a few hundred at
most, in the runtime directory as well so a restart of the surfaces keeps
them and logging out clears them; each is read once the list is opened.

**Shown** as a pop-up at the top right (ui/notify.html, `Toasts`), as
Settings says (`notifications`: on or off, the motion, shadow, opacity,
outline, how long one stays, which applications are muted) — urgent ones stay
until dismissed. Muted or switched off, they are still kept and listed (the
bar's bell, ui/popup.js), only not popped up. **Open** goes to the sending
application: a window of it brought forward, else the application started.
"""

from __future__ import annotations

import json
import os
import signal
import subprocess
import sys
import time

from PySide6.QtCore import QObject, QProcess, QTimer, Signal, Slot
from PySide6.QtGui import QGuiApplication
from PySide6.QtWebEngineCore import QWebEngineProfile

import hypr
from config import save_config
from core import Bridge
from layershell import ANCHOR_RIGHT, ANCHOR_TOP, KEYBOARD_NONE, OVERLAY, LayerSurface, Placement
from views import log, make_view, zoom

HERE = os.path.dirname(os.path.abspath(__file__))
KEPT = os.path.join(os.environ.get("XDG_RUNTIME_DIR", f"/run/user/{os.getuid()}"), "talaris-notifications.json")
MOST = 300
#: The pop-ups' column: this wide, and as tall as what is showing (the page says).
WIDTH = 380
DEFAULTS = {"enabled": True, "animation": "slide", "shadow": True, "opacity": 100, "outline": "line", "seconds": 6, "muted": [], "seen": []}


class Notifications(QObject):
    #: The list changed (a new one, read, dismissed): the bar's dot and list, and the pop-ups.
    changed = Signal()

    def __init__(self, desktop, profile: QWebEngineProfile) -> None:
        super().__init__(desktop)
        self.desktop = desktop
        self.items: list[dict] = self._load()
        self._buffer = b""
        self._restarts = 0
        self.process: QProcess | None = None
        self.toasts = Toasts(profile, self)
        self._take_over()
        self._start()

    # ------------------------------------------------------------ settings

    def settings(self) -> dict:
        return {**DEFAULTS, **self.desktop.config.get("notifications", {})}

    def app_key(self, n: dict) -> str:
        """Who sent it, as the muting knows them: the desktop entry if it said, else its name."""
        return (n.get("desktop") or n.get("app") or "").strip()

    # ------------------------------------------------------------ the server

    def _take_over(self) -> None:
        """mako out of the way, by pid: it does not give the name up when asked."""
        try:
            pids = subprocess.run(["pgrep", "-x", "-u", str(os.getuid()), "mako"], capture_output=True, text=True, timeout=3).stdout.split()
        except (OSError, subprocess.SubprocessError):
            pids = []
        for pid in pids:
            try:
                os.kill(int(pid), signal.SIGTERM)
                log(f"notifications: mako ({pid}) stopped; Talaris shows them now")
            except (ValueError, OSError):
                pass

    def _start(self) -> None:
        p = QProcess(self)
        p.setProgram(sys.executable)
        p.setArguments(["-W", "ignore::DeprecationWarning", os.path.join(HERE, "notifyd.py")])
        p.readyReadStandardOutput.connect(self._read)
        p.readyReadStandardError.connect(lambda: log("notifications: " + bytes(p.readAllStandardError()).decode("utf-8", "replace").strip()))
        p.finished.connect(self._ended)
        p.start()
        self.process = p

    def _ended(self, code: int, _status) -> None:
        log(f"notifications: the server ended ({code}); mako will answer until it is back")
        if self._restarts < 3:
            self._restarts += 1
            QTimer.singleShot(3000, lambda: (self._take_over(), self._start()))

    def stop(self) -> None:
        self._restarts = 3
        if self.process and self.process.state() != QProcess.ProcessState.NotRunning:
            self.process.closeWriteChannel()
            self.process.waitForFinished(1000)

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
            if "ready" in msg:
                log(f"notifications: {'the server is Talaris' if msg['ready'] else 'another server holds the name'}")
            elif "notify" in msg:
                self._came(msg["notify"])
            elif "close" in msg:
                self._gone(int(msg["close"]["id"]), told=False)

    # ------------------------------------------------------------ the list

    def _load(self) -> list:
        try:
            with open(KEPT, encoding="utf-8") as f:
                return json.load(f)[:MOST]
        except (OSError, ValueError):
            return []

    def _keep(self) -> None:
        try:
            fd = os.open(KEPT, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump(self.items[:MOST], f)
        except OSError:
            pass

    def _came(self, n: dict) -> None:
        n = {**n, "at": int(time.time() * 1000), "read": False}
        # A replacement takes the place of the one it replaces.
        self.items = [n] + [x for x in self.items if x.get("id") != n["id"]]
        del self.items[MOST:]
        s = self.settings()
        key = self.app_key(n)
        if key and key not in s["seen"]:
            self.desktop.config.setdefault("notifications", {})["seen"] = sorted(set(s["seen"]) | {key}, key=str.lower)
            save_config(self.desktop.config)
        if s["enabled"] and key not in s["muted"]:
            self.toasts.show(n)
        self._keep()
        self.changed.emit()

    def _gone(self, nid: int, told: bool = True, reason: int = 2) -> None:
        """Off the screen: closed by its application (`told` False), or by you."""
        self.toasts.drop(nid)
        if told:
            self._send({"do": "closed", "id": nid, "reason": reason})

    def unread(self) -> int:
        return sum(1 for n in self.items if not n.get("read"))

    def read_all(self) -> None:
        if self.unread():
            for n in self.items:
                n["read"] = True
            self._keep()
            self.changed.emit()

    def dismiss(self, nid: int) -> None:
        """Out of the list, and off the screen."""
        self.items = [n for n in self.items if n.get("id") != nid]
        self._gone(nid)
        self._keep()
        self.changed.emit()

    def clear(self) -> None:
        for n in list(self.items):
            self._gone(int(n.get("id", 0)))
        self.items = []
        self._keep()
        self.changed.emit()

    def act(self, nid: int, key: str) -> None:
        """One of its buttons, or its body ("default"): the application told; gone unless it says it stays."""
        n = next((x for x in self.items if x.get("id") == nid), None)
        self._send({"do": "action", "id": nid, "key": key})
        if not (n and n.get("resident")):
            self._gone(nid)

    def open_app(self, nid: int) -> None:
        """The application that sent it: a window of it brought forward, else started."""
        n = next((x for x in self.items if x.get("id") == nid), None)
        if not n:
            return
        apps = self.desktop.apps
        names = {s.lower() for s in (n.get("desktop"), n.get("app")) if s}
        now = hypr.windows()
        for w in sorted(now["windows"], key=lambda w: w["recent"]):
            app = apps.lookup(w["class"])
            if {w["class"].lower(), str(app.get("id", "")).lower(), str(app.get("name", "")).lower()} & names:
                hypr.show(w["address"]) if w["hidden"] else hypr.focus(w["address"])
                self._gone(nid)
                return
        entry = n.get("desktop")
        if entry and apps.is_launchable(entry):
            hypr.ask(f"/dispatch exec gtk-launch {entry}")
            self._gone(nid)

    def can_open(self, n: dict) -> bool:
        """Whether there is an application to go to: a desktop entry, or a name that is one."""
        entry = n.get("desktop") or ""
        return bool(entry and self.desktop.apps.is_launchable(entry)) or bool(n.get("app"))


class ToastsBridge(Bridge):
    @Slot(str)
    def done(self, request: str) -> None:
        """The page's word on a pop-up: {id, how: "expired"|"dismissed"|"action"|"open", key}."""
        try:
            r = json.loads(request)
        except ValueError:
            return
        owner, nid = self.owner, int(r.get("id", 0))
        how = r.get("how")
        if how == "expired":
            owner.drop(nid)
            owner.notifications._send({"do": "closed", "id": nid, "reason": 1})
        elif how == "dismissed":
            owner.notifications._gone(nid, reason=2)
        elif how == "action":
            owner.notifications.act(nid, str(r.get("key") or "default"))
        elif how == "open":
            owner.notifications.open_app(nid)

    @Slot(int)
    def fit(self, height: int) -> None:
        """The page's content height: the surface as tall as that, and gone at none."""
        self.owner.fit(height)


class Toasts(QObject):
    """The pop-ups: a column at the top right, as tall as what is showing."""

    def __init__(self, profile: QWebEngineProfile, notifications: Notifications) -> None:
        super().__init__(notifications)
        self.notifications = notifications
        self.desktop = notifications.desktop
        self.showing: list[dict] = []
        self.height = 0
        self.bridge = ToastsBridge(self, self)
        self.view = make_view(profile, "notify", "talaris-ui://ui/notify.html", self.bridge, self)
        self.surface = LayerSurface(self.view, "talaris-notify", nudge=False)

    def describe(self) -> dict:
        n = self.notifications
        return {"up": bool(self.showing), "theme": self.desktop.config["theme"], "look": n.settings(),
                "toasts": [{**t, "canOpen": n.can_open(t)} for t in self.showing],
                # The clock as Settings has it, so a time on a toast reads as the bar's does.
                "clock": self.desktop.config.get("clock", {})}

    def _tell(self) -> None:
        self.bridge.state.emit(json.dumps(self.describe()))

    def show(self, n: dict) -> None:
        self.showing = [n] + [t for t in self.showing if t.get("id") != n.get("id")]
        del self.showing[6:]
        if not self.height:
            self.fit(1)
        self._tell()

    def drop(self, nid: int) -> None:
        if any(t.get("id") == nid for t in self.showing):
            self.showing = [t for t in self.showing if t.get("id") != nid]
            self._tell()

    def fit(self, height: int) -> None:
        height = max(0, int(height))
        if not height and not self.showing:
            self.height = 0
            self.view.hide()
            self.surface.placement = None
            return
        if height == self.height:
            return
        self.height = height
        screen = QGuiApplication.primaryScreen().geometry()
        h = min(max(height, 1), screen.height() - 80)
        # Under the bar, at the right; it takes no keyboard, so typing goes on where it was.
        self.surface.apply(Placement(OVERLAY, ANCHOR_TOP | ANCHOR_RIGHT, WIDTH + 24, h, KEYBOARD_NONE, margins=(0, zoom(4), zoom(8), 0)))

    # What the page's bridge calls on its owner; the pop-ups are no panel.
    def toggle(self) -> None:
        pass

    def file_away(self) -> None:
        pass

    def left(self) -> None:
        pass

    def touched(self) -> None:
        pass
