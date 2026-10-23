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

**Its ways back**: Morgan's button again, Super+Alt+M, Escape while Morgan is
idle, `--file-all`, and a long idle — long, because a conversation is read,
and only counted while Morgan is idle.
"""

from __future__ import annotations

import json
import os
import shutil
import socket
import subprocess

from PySide6.QtCore import QObject, QProcess, QTimer, Signal, Slot
from PySide6.QtNetwork import QLocalSocket
from PySide6.QtWebEngineCore import QWebEngineProfile
from PySide6.QtWidgets import QApplication

from core import Bridge
from layershell import ANCHOR_LEFT, ANCHOR_TOP, KEYBOARD_ON_DEMAND, OVERLAY, LayerSurface, Placement
from views import log, make_view

RUNTIME = os.environ.get("XDG_RUNTIME_DIR", f"/run/user/{os.getuid()}")
SOCKET = os.environ.get("HEYMORGAN_SOCKET") or os.path.join(RUNTIME, "heymorgan.sock")

#: The panel: wide enough for an answer with code in it, most of the height.
WIDTH = 540
HEIGHT_SHARE = 0.78
#: Put away after this long with no input while Morgan is idle.
IDLE_MS = 5 * 60 * 1000

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
        return json.dumps({"accent": "", "font": "../fonts/tabler-icons-outline.woff2", "glyphs": glyphs,
                           "theme": self.owner.desktop.config["theme"]})

    @Slot(result=str)
    def pick(self) -> str:
        """Files to attach. The chooser runs beside, not inside, so the screen keeps drawing; they arrive as a drop."""
        self.owner.pick_files()
        return "[]"

    @Slot()
    def settings(self) -> None:
        # Morgan's page in Talaris's Settings is step seven. Until then, its
        # settings are where they have been: the Noctalia plugin's panel.
        noctalia = shutil.which("noctalia") or os.path.expanduser("~/.local/bin/noctalia")
        if os.path.exists(noctalia):
            subprocess.Popen([noctalia, "msg", "panel-open", "jpmoo/morgan:settings"],
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)

    @Slot(str)
    def title(self, _text: str) -> None:
        pass


class Panel(QObject):
    def __init__(self, profile: QWebEngineProfile, desktop, link: Link) -> None:
        super().__init__(desktop)
        self.desktop = desktop
        self.link = link
        self.up = False
        self.bridge = MorganBridge(self, self)
        self.view = make_view(profile, "morgan", "talaris-ui://ui/morgan/index.html", self.bridge, self)
        self.surface = LayerSurface(self.view, "talaris-morgan")
        link.event.connect(self.bridge.event.emit)
        self.idle = QTimer(self)
        self.idle.setSingleShot(True)
        self.idle.timeout.connect(self._idle)
        self._chooser: QProcess | None = None

    def describe(self) -> dict:
        return {"up": self.up, "theme": self.desktop.config["theme"]}

    def open(self) -> None:
        if not self.up:
            screen = QApplication.primaryScreen().geometry()
            self.surface.apply(Placement(OVERLAY, ANCHOR_TOP | ANCHOR_LEFT, WIDTH,
                                         int(screen.height() * HEIGHT_SHARE), KEYBOARD_ON_DEMAND))
            self.up = True
            self.desktop.bar.bridge.state.emit(json.dumps(self.desktop.bar.describe()))
            log("morgan: open")
        self.view.setFocus()
        self.view.page().runJavaScript("document.getElementById('draft') && document.getElementById('draft').focus()")
        self.touched()

    def toggle(self) -> None:
        if self.up:
            self.file_away()
        else:
            self.open()

    def file_away(self) -> None:
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
