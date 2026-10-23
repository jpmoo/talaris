# SPDX-License-Identifier: GPL-3.0-only
# Copyright (c) 2026 Jeff Moore
"""
Hyprland, as the first compositor backend.

DESIGN.md: nothing outside a backend talks to the compositor. This is the
Hyprland one, and so far it answers three questions — is the current workspace
empty, tell me when that might have changed, and bind these keys.

**Pulled, not pushed.** The event socket says *that* something happened;
what is true now is asked for. Anything that arrives only by event also has to
be established at startup, or after a restart the state is simply missing until
the next event happens to come — Talaria learned that from Rift.
"""

from __future__ import annotations

import json
import os
import socket

from PySide6.QtCore import QObject, Signal
from PySide6.QtNetwork import QLocalSocket


def _socket_dir() -> str:
    runtime = os.environ.get("XDG_RUNTIME_DIR", f"/run/user/{os.getuid()}")
    sig = os.environ.get("HYPRLAND_INSTANCE_SIGNATURE", "")
    if not sig:
        # A user service may start without the variable; the newest instance
        # directory is the session we are in.
        base = os.path.join(runtime, "hypr")
        found = sorted(
            (d for d in os.listdir(base) if os.path.exists(os.path.join(base, d, ".socket.sock"))),
            key=lambda d: os.path.getmtime(os.path.join(base, d)),
        ) if os.path.isdir(base) else []
        sig = found[-1] if found else ""
    return os.path.join(runtime, "hypr", sig)


def ask(command: str) -> str:
    """One request on the command socket — what `hyprctl` does, without a process."""
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.settimeout(2)
    try:
        s.connect(os.path.join(_socket_dir(), ".socket.sock"))
        s.sendall(command.encode())
        chunks = []
        while True:
            data = s.recv(65536)
            if not data:
                break
            chunks.append(data)
        return b"".join(chunks).decode("utf-8", "replace")
    finally:
        s.close()


def workspace_is_empty() -> bool:
    try:
        return int(json.loads(ask("j/activeworkspace")).get("windows", 0)) == 0
    except (OSError, ValueError):
        return False


def bind(keys: str, command: str) -> None:
    """A runtime bind, replacing whatever the key did. A config reload drops it; `Events` says when."""
    ask(f"/keyword unbind {keys}")
    ask(f"/keyword bind {keys}, exec, {command}")


def unbind(keys: str) -> None:
    ask(f"/keyword unbind {keys}")


class Events(QObject):
    """The event socket, read on Qt's loop."""

    #: Something that can change what is on the current workspace happened.
    changed = Signal()
    #: The config was reloaded, which drops runtime binds.
    reloaded = Signal()

    WATCH = ("workspace", "openwindow", "closewindow", "movewindow", "focusedmon", "activespecial")

    def __init__(self, parent: QObject | None = None) -> None:
        super().__init__(parent)
        self._buffer = b""
        self._sock = QLocalSocket(self)
        self._sock.readyRead.connect(self._read)
        self._sock.connectToServer(os.path.join(_socket_dir(), ".socket2.sock"))

    def _read(self) -> None:
        self._buffer += bytes(self._sock.readAll())
        *lines, self._buffer = self._buffer.split(b"\n")
        fire = False
        for line in lines:
            name = line.split(b">>", 1)[0].decode("ascii", "replace")
            if name == "configreloaded":
                self.reloaded.emit()
            if name.rstrip("v2") in self.WATCH or name in self.WATCH:
                fire = True
        if fire:
            self.changed.emit()
