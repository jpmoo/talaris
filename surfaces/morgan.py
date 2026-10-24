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
import shutil
import socket
import time

from PySide6.QtCore import QObject, QProcess, QTimer, Signal, Slot
from PySide6.QtNetwork import QLocalSocket
from PySide6.QtWebEngineCore import QWebEngineProfile
from PySide6.QtWidgets import QApplication

import hypr
from core import Bridge
from layershell import (
    ANCHOR_BOTTOM,
    ANCHOR_LEFT,
    ANCHOR_RIGHT,
    ANCHOR_TOP,
    BOTTOM,
    KEYBOARD_NONE,
    KEYBOARD_ON_DEMAND,
    OVERLAY,
    QT_SCALE,
    LayerSurface,
    Placement,
)
from views import log, make_view, zoom

RUNTIME = os.environ.get("XDG_RUNTIME_DIR", f"/run/user/{os.getuid()}")
SOCKET = os.environ.get("HEYMORGAN_SOCKET") or os.path.join(RUNTIME, "heymorgan.sock")

#: The panel: wide enough for an answer with code in it, most of the height.
WIDTH = 540
HEIGHT_SHARE = 0.78
#: Put away after this long with no input while Morgan is idle.
IDLE_MS = 5 * 60 * 1000

#: The voice popup's size, and how long it stays after Morgan goes idle.
VOICE = (420, 300)
LINGER_MS = 1200

HERE = os.path.dirname(os.path.abspath(__file__))
GLYPHS = os.path.join(HERE, "ui", "morgan", "tabler.json")


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
        self._stream.disconnected.connect(self._lost)
        self._stream.errorOccurred.connect(lambda _e: self._lost())
        self._follow()

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


class MorganBridge(Bridge):
    """What Morgan's page asks of its host — the same as Morgan's own window answered."""

    event = Signal(str)
    dropped = Signal(str)

    @Slot(str, result=str)
    def call(self, line: str) -> str:
        return command(line)

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


class Panel(QObject):
    def __init__(self, profile: QWebEngineProfile, desktop, link: Link) -> None:
        super().__init__(desktop)
        self.desktop = desktop
        self.link = link
        self.up = False
        self.bridge = MorganBridge(self, self)
        self.view = make_view(profile, "morgan", "talaris-ui://ui/morgan/index.html", self.bridge, self, area="morgan")
        self.surface = LayerSurface(self.view, "talaris-morgan")
        link.event.connect(self.bridge.event.emit)
        self.idle = QTimer(self)
        self.idle.setSingleShot(True)
        self.idle.timeout.connect(self._idle)
        self._chooser: QProcess | None = None
        # Expanded, as a drawer is: the conversation is the desktop, on a
        # workspace of its own (`hypr.DESK`), and `came_from` the one to go back to.
        self.expanded = False
        self.came_from = None
        self.expanded_at = 0.0

    def describe(self) -> dict:
        return {"up": self.up, "theme": self.desktop.config["theme"], "expanded": self.expanded,
                "closes": self.desktop.config["panels"].get("afterExpand", "open") == "closed"}

    def _place(self) -> None:
        screen = QApplication.primaryScreen().geometry()
        self.surface.placement = None
        if self.expanded:
            # Between the bar and the dock, where a window's frame would be,
            # and below the windows, so one coming back shows above it.
            gaps = getattr(self.desktop, "gaps", {})
            margins = tuple(round(gaps.get(side, 0) / QT_SCALE) for side in ("left", "top", "right", "bottom"))
            self.surface.apply(Placement(BOTTOM, ANCHOR_TOP | ANCHOR_BOTTOM | ANCHOR_LEFT | ANCHOR_RIGHT,
                                         screen.width(), screen.height(), KEYBOARD_ON_DEMAND, margins=margins))
        else:
            self.surface.apply(Placement(OVERLAY, ANCHOR_TOP | ANCHOR_LEFT, zoom(WIDTH, "morgan"),
                                         int(screen.height() * HEIGHT_SHARE), KEYBOARD_ON_DEMAND))
        self.bridge.state.emit(json.dumps(self.describe()))

    def open(self) -> None:
        if not self.up:
            self._place()
            self.up = True
            self.desktop.bar.bridge.state.emit(json.dumps(self.desktop.bar.describe()))
            self.desktop.voice.file_away()
            log("morgan: open")
        self.view.setFocus()
        self.view.page().runJavaScript("document.getElementById('draft') && document.getElementById('draft').focus()")
        self.touched()

    def toggle(self) -> None:
        if self.up:
            self.file_away()
        else:
            self.open()

    # ------------------------------------------------------------ expanded

    def grow(self) -> None:
        """The expand button: the desktop, or back to a panel (or closed, as Settings says)."""
        if self.expanded:
            self.collapse()
        else:
            self.expand()

    def expand(self) -> None:
        """The desktop, as an expanded drawer is — the windows left where they were."""
        for d in self.desktop.drawers.values():
            d.collapse()
            d.file_away()
        self.came_from = hypr.windows()["active"]
        self.expanded = True
        self.expanded_at = time.monotonic()
        self.idle.stop()
        self.up = True
        self._place()
        self.view.setFocus()
        # The surface first, the workspace after, as for a drawer: making it
        # anew hands the keyboard back to the last window, which Hyprland follows.
        QTimer.singleShot(150, lambda: self.expanded and hypr.go(hypr.DESK))

    def collapse(self, follow: bool = True, close: bool | None = None) -> None:
        """Back to the workspace it was expanded from, with any window opened meanwhile."""
        if not self.expanded:
            return
        self.expanded = False
        now = hypr.windows()
        names = {w["id"]: w["name"] for w in now["workspaces"]}
        if self.came_from is not None:
            for w in now["windows"]:
                if names.get(w["workspace"]) == hypr.DESK:
                    hypr.bring(w["address"], self.came_from)
            if follow and now["activeName"] == hypr.DESK:
                hypr.go(self.came_from)
        if close is None:
            close = self.desktop.config["panels"].get("afterExpand", "open") == "closed"
        if close:
            self.file_away()
        else:
            self._place()
            self.touched()

    def windows_changed(self, now: dict) -> None:
        """Expanded: a window opened on its desktop, or another desktop gone to, makes it a panel again."""
        if not self.expanded or time.monotonic() - self.expanded_at < 0.6:
            return
        names = {w["id"]: w["name"] for w in now["workspaces"]}
        if now["activeName"] != hypr.DESK:
            self.collapse(follow=False)
        elif any(names.get(w["workspace"]) == hypr.DESK and not w["hidden"] for w in now["windows"]):
            self.collapse()

    def file_away(self) -> None:
        if self.expanded:
            self.collapse(close=True)
            return
        if not self.up:
            return
        self.up = False
        self.idle.stop()
        self.view.hide()
        self.surface.placement = None
        self.desktop.bar.bridge.state.emit(json.dumps(self.desktop.bar.describe()))

    def left(self) -> None:
        pass

    def touched(self) -> None:
        if self.up:
            self.idle.start(IDLE_MS)

    def _idle(self) -> None:
        if self.expanded:
            return
        # Not in the middle of an answer: wait for Morgan to finish first.
        if self.link.now not in ("idle", "absent"):
            self.touched()
            return
        self.file_away()

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
