# SPDX-License-Identifier: GPL-3.0-only
# Copyright (c) 2026 Jeff Moore
"""
Morgan's face: what Talaris shows of the assistant whose brain is its own process.

**One stream, followed for everyone.** Morgan's daemon says what it is doing on
`watch` (its `docs/protocol.md`, §3). The process follows it once, and picks it
up again when Morgan restarts; the bar's button hears the state from it, and
the conversation hears every event.

**The conversation is Morgan's own page** (`ui/morgan/index.html`, from
Morgan's application window), hung from the bar as a panel on the `overlay`
layer — under the bar's left end, where Morgan's button is. It talks to the
daemon through this bridge, as it did through Morgan's window: one command, one
answer, over the daemon's socket.

**Its ways back**: Morgan's button again, Super+Shift+M, Escape while Morgan is
idle, `--file-all`, and a long idle — long, because a conversation is read,
and only counted while Morgan is idle.

**The voice popup** is for a turn said aloud while the conversation is shut:
who has the floor, a waveform of their voice, what was asked and the answer as
it is spoken — as Morgan's Noctalia plugin showed it. It comes up when Morgan
leaves idle on a spoken turn (a typed one is watched where it was typed),
lingers a moment after Morgan goes idle, since a follow-up often comes
straight after, and goes at once on `stop`. It never takes the keyboard.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import socket
import threading

from PySide6.QtCore import QObject, QProcess, QTimer, Signal, Slot
from PySide6.QtNetwork import QLocalSocket
from PySide6.QtWebEngineCore import QWebEngineProfile

from core import Bridge, route_ok
from layershell import ANCHOR_TOP, KEYBOARD_NONE, OVERLAY, LayerSurface, Placement
from overlay import Overlay
from views import log, make_view, zoom

RUNTIME = os.environ.get("XDG_RUNTIME_DIR", f"/run/user/{os.getuid()}")
SOCKET = os.environ.get("HEYMORGAN_SOCKET") or os.path.join(RUNTIME, "heymorgan.sock")

def installed() -> bool:
    """
    heymorgan on this machine: its user service known to systemd, or its
    socket there. Morgan is a companion, installed on its own; where it is
    not, Talaris shows none of Morgan's pieces (the button, the panel, its
    page in Settings, "Ask Morgan", its key) — not a button that only ever
    says Morgan is not running.
    """
    # As though it were not, to see Talaris on its own (TALARIS_NO_MORGAN=1).
    if os.environ.get("TALARIS_NO_MORGAN"):
        return False
    if os.path.exists(SOCKET):
        return True
    try:
        import subprocess
        return subprocess.run(["systemctl", "--user", "cat", "heymorgan.service"], capture_output=True, timeout=3).returncode == 0
    except (OSError, subprocess.SubprocessError):
        return False


#: Put away after this long with no input while Morgan is idle.
IDLE_MS = 5 * 60 * 1000

#: The voice popup's size, and how long it stays after Morgan goes idle.
#: The voice popup's box (408 × 288) and the room round it for its shadow (voice.html).
VOICE = (452, 332)
LINGER_MS = 1200

HERE = os.path.dirname(os.path.abspath(__file__))
GLYPHS = os.path.join(HERE, "ui", "morgan", "tabler.json")

#: What the page may ask the core for: `@` in the composer (mentions.js), the
#: card a mention opens (peek.js), and what is read to go with the message.
#: Not a door to the rest of the core.
ALLOWED = tuple((method, re.compile(path)) for method, path in (
    ("GET", r"/mentionables\?.*"),
    ("GET", r"/people/find\?.*"),
    ("GET", r"/entities/[A-Za-z0-9_]+(/place)?"),
    ("GET", r"/projects/[^/?]+/page\?path=.*"),
    ("POST", r"/entities(/people/known|/person|/place)?"),
    ("POST", r"/tasks"),
))


def command(line: str, timeout: float = 20) -> str:
    """One command to the daemon, and its one line of answer."""
    try:
        with socket.socket(socket.AF_UNIX) as link:
            link.settimeout(timeout)
            link.connect(SOCKET)
            link.sendall(" ".join(line.split("\n")).encode("utf-8") + b"\n")
            answer = b""
            while chunk := link.recv(65536):
                answer += chunk
        return answer.decode("utf-8", "replace")
    except OSError as error:
        return json.dumps({"ok": False, "error": f"Morgan is not running ({error.strerror or error})"})


class Link(QObject):
    """Morgan's event stream, followed, and its state kept."""

    #: One event, as the daemon wrote it.
    event = Signal(str)
    #: Morgan's state changed — `idle`, `listening`, `thinking`… or `absent`.
    state = Signal(str)

    def __init__(self, parent: QObject | None = None) -> None:
        super().__init__(parent)
        self.now = "absent"
        self.typed = False
        self._buffer = b""
        self._stream = QLocalSocket(self)
        self._stream.readyRead.connect(self._read)
        self._stream.connected.connect(lambda: self._stream.write(b"watch\n"))
        # In the demo, Morgan remembers nothing said (its `memory.hold`): asked on each connection — the daemon may have
        # restarted and let go — and again every half hour, each time for two hours, so a demo that ends without
        # saying so leaves Morgan forgetful for two hours at most. Out of the demo, let go of at once.
        self._stream.connected.connect(self._hold)
        self._holding = QTimer(self)
        self._holding.setInterval(30 * 60 * 1000)
        self._holding.timeout.connect(self._hold)
        if os.environ.get("TALARIS_DEMO"):
            self._holding.start()
        self._stream.disconnected.connect(self._lost)
        self._stream.errorOccurred.connect(lambda _e: self._lost())
        self._follow()

    def _hold(self) -> None:
        on = bool(os.environ.get("TALARIS_DEMO"))
        line = "admin " + json.dumps({"op": "memory.hold", "args": {"on": on, "hours": 2}})
        threading.Thread(target=lambda: command(line, timeout=10), daemon=True).start()

    def _follow(self) -> None:
        if self._stream.state() == QLocalSocket.LocalSocketState.UnconnectedState:
            self._buffer = b""
            self._stream.connectToServer(SOCKET)

    def _lost(self) -> None:
        self._set("absent")
        # The daemon's unit restarts it within seconds; look again a little after.
        QTimer.singleShot(3000, self._follow)

    def _set(self, now: str) -> None:
        if now != self.now:
            self.now = now
            self.state.emit(now)

    def _read(self) -> None:
        self._buffer += bytes(self._stream.readAll())
        *lines, self._buffer = self._buffer.split(b"\n")
        for line in lines:
            if not line.strip():
                continue
            text = line.decode("utf-8", "replace")
            try:
                e = json.loads(text)
            except ValueError:
                continue
            if e.get("type") == "state" and e.get("state"):
                self.typed = bool(e.get("typed"))
                self._set(e["state"])
            self.event.emit(text)


#: Any path, for route_ok's check of what the core would rewrite (the routes themselves are ALLOWED's).
_ANY = re.compile(r"^/")


class MorganBridge(Bridge):
    """What Morgan's page asks of its host — the same as Morgan's own window answered, and the core for `@`."""

    event = Signal(str)
    dropped = Signal(str)

    @Slot(int, str, str, str)
    def request(self, rid: int, method: str, path: str, body: str) -> None:
        if not route_ok(_ANY, path) or not any(m == method.upper() and r.fullmatch(path) for m, r in ALLOWED):
            self.replied.emit(rid, 400, json.dumps({"error": "not a route Morgan's page uses"}))
            return
        super().request(rid, method, path, body)

    #: The daemon's answer to `callLater`: `(id, its line)`.
    answered = Signal(int, str)

    @Slot(int, str)
    def callLater(self, rid: int, line: str) -> None:  # noqa: N802 — called from the page by this name
        """
        One command to the daemon, answered later on `answered`. Never on this
        thread: asked here, a daemon slow to answer held every surface for up
        to the command's 20 seconds — the pointer moved and nothing took a
        press — and the panel asks every minute (2026-10-28).
        """
        threading.Thread(target=lambda: self.answered.emit(rid, command(line)), daemon=True).start()

    @Slot(result=str)
    def look(self) -> str:
        try:
            with open(GLYPHS, encoding="utf-8") as f:
                glyphs = json.load(f)
        except (OSError, ValueError):
            glyphs = {}
        return json.dumps({"accent": "", "font": "talaris-ui://ui/fonts/tabler-icons-outline.woff2", "glyphs": glyphs,
                           "theme": self.owner.desktop.config["theme"]})

    @Slot(result=str)
    def pick(self) -> str:
        """Files to attach. The chooser runs beside, not inside, so the screen keeps drawing; they arrive as a drop."""
        self.owner.pick_files()
        return "[]"

    @Slot()
    def settings(self) -> None:
        """Morgan's page in Talaris's Settings."""
        self.owner.desktop.settings.open("morgan")

    @Slot(str)
    def title(self, _text: str) -> None:
        pass

    @Slot()
    def conversation(self) -> None:
        """From the voice popup: open the conversation, to type or read back."""
        self.owner.desktop.morgan.open()


class Panel(Overlay):
    """Morgan's conversation: an overlay (overlay.py), opened from the bar's button or Super+Shift+M."""

    NAME = "morgan"
    TITLE = "Morgan"
    IDLE_MS = IDLE_MS

    def __init__(self, profile: QWebEngineProfile, desktop, link: Link) -> None:
        super().__init__(profile, desktop, "talaris-ui://ui/morgan/index.html", MorganBridge(None, None), area="morgan")
        self.bridge.owner = self
        self.bridge.setParent(self)
        self.link = link
        link.event.connect(self.bridge.event.emit)
        self._chooser: QProcess | None = None

    def opened(self) -> None:
        self.desktop.bar.bridge.state.emit(json.dumps(self.desktop.bar.describe()))
        self.desktop.voice.file_away()

    def open(self) -> None:
        super().open()
        self.view.page().runJavaScript("window.focusDraft && focusDraft()")

    def closed(self) -> None:
        self.desktop.bar.bridge.state.emit(json.dumps(self.desktop.bar.describe()))

    def busy(self) -> bool:
        # Not in the middle of an answer: wait for Morgan to finish first.
        return self.link.now not in ("idle", "absent")

    def show_conversation(self, conversation: str) -> None:
        """An earlier conversation, from the launcher: the panel opened on it."""
        self.open()
        self.view.page().runJavaScript(f"window.openConversation && openConversation({json.dumps(conversation)})")

    def ask(self, text: str) -> str:
        """A question from the launcher: typed to Morgan, with the conversation open to show it."""
        self.open()
        try:
            reply = json.loads(command(f"type {text}"))
        except ValueError:
            return "Morgan did not answer"
        return "" if reply.get("ok") else reply.get("error", "Morgan did not take it")

    def pick_files(self) -> None:
        if self._chooser or not shutil.which("zenity"):
            return
        chooser = QProcess(self)
        chooser.setProgram("zenity")
        chooser.setArguments(["--file-selection", "--multiple", "--separator=\n",
                              "--title=Attach to your message", f"--filename={os.path.expanduser('~')}/"])

        def done(code: int, _status) -> None:
            paths = [p for p in bytes(chooser.readAllStandardOutput()).decode().splitlines() if p] if code == 0 else []
            self._chooser = None
            if paths:
                self.bridge.dropped.emit(json.dumps(paths))
            chooser.deleteLater()

        chooser.finished.connect(done)
        self._chooser = chooser
        chooser.start()


class Voice(QObject):
    def __init__(self, profile: QWebEngineProfile, desktop, link: Link) -> None:
        super().__init__(desktop)
        self.desktop = desktop
        self.link = link
        self.up = False
        self._refused = False
        self.bridge = MorganBridge(self, self)
        self.view = make_view(profile, "voice", "talaris-ui://ui/voice.html", self.bridge, self, area="morgan")
        self.surface = LayerSurface(self.view, "talaris-voice")
        link.event.connect(self._heard)
        self._linger = QTimer(self)
        self._linger.setSingleShot(True)
        self._linger.timeout.connect(self._gone_quiet)

    def describe(self) -> dict:
        return {"up": self.up, "theme": self.desktop.config["theme"]}

    def _heard(self, text: str) -> None:
        try:
            e = json.loads(text)
        except ValueError:
            return
        kind = e.get("type")
        if kind == "dismiss":
            self.file_away()
        elif kind == "voice":
            # A voice Morgan was not taught: the popup says so, and stays long
            # enough to be read rather than the usual moment.
            self._refused = not e.get("name")
        elif kind == "state":
            if e.get("state") == "idle":
                if self.up:
                    self._linger.start(LINGER_MS * 4 if self._refused else LINGER_MS)
            elif not e.get("typed") and e.get("state") in ("listening", "transcribing", "thinking", "consulting", "speaking"):
                if e.get("state") == "listening":
                    self._refused = False
                self._linger.stop()
                self.show()
        # The page hears every event itself, through the bridge, and draws them.
        self.bridge.event.emit(text)

    def _gone_quiet(self) -> None:
        if self.link.now in ("idle", "absent"):
            self.file_away()

    def show(self) -> None:
        # The conversation has its own meter; two at once is one too many.
        if self.up or self.desktop.morgan.up:
            return
        # Anchored to the top alone, the compositor centers it under the bar.
        self.surface.apply(Placement(OVERLAY, ANCHOR_TOP, zoom(VOICE[0], "morgan"), zoom(VOICE[1], "morgan"), KEYBOARD_NONE))
        self.up = True
        log("voice: up")
        self.bridge.state.emit(json.dumps(self.describe()))

    def file_away(self) -> None:
        if not self.up:
            return
        self.up = False
        self._linger.stop()
        self.view.hide()
        self.surface.placement = None
        self.bridge.state.emit(json.dumps(self.describe()))

    # What the page's bridge calls on its owner.
    def toggle(self) -> None:
        self.file_away()

    def left(self) -> None:
        pass

    def touched(self) -> None:
        pass
