# SPDX-License-Identifier: GPL-3.0-only
# Copyright (c) 2026 Jeff Moore
"""
Hyprland, as the first compositor backend.

DESIGN.md: nothing outside a backend talks to the compositor. This is the
Hyprland one, and so far it answers four questions — is the current workspace
empty, what windows are open and where, tell me when either might have
changed, and bind these keys. And it does one thing: focus a window.

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


def windows() -> dict:
    """Every window on a regular workspace, with the workspaces and what has focus."""
    try:
        clients = json.loads(ask("j/clients"))
        spaces = json.loads(ask("j/workspaces"))
        active = json.loads(ask("j/activeworkspace"))
        focused = json.loads(ask("j/activewindow") or "{}")
    except (OSError, ValueError):
        return {"windows": [], "workspaces": [], "active": None, "focused": None}
    # Special workspaces are scratchpads summoned by a key, not places you go.
    regular = [c for c in clients if c.get("workspace", {}).get("id", -1) > 0 and c.get("mapped", True)]
    return {
        "windows": [
            {"address": c["address"], "class": c.get("class") or c.get("initialClass") or "",
             "title": c.get("title", ""), "workspace": c["workspace"]["id"],
             "recent": c.get("focusHistoryID", 999)}
            for c in regular
        ],
        "workspaces": [{"id": w["id"], "name": w.get("name", str(w["id"]))} for w in spaces if w.get("id", -1) > 0],
        "active": active.get("id"),
        "focused": (focused or {}).get("address"),
    }


def focus(address: str) -> None:
    """Bring a window forward, going to its workspace if it is on another."""
    if address.startswith("0x") and all(c in "0123456789abcdefx" for c in address.lower()):
        ask(f"/dispatch focuswindow address:{address}")


def close(address: str) -> None:
    if address.startswith("0x") and all(c in "0123456789abcdefx" for c in address.lower()):
        ask(f"/dispatch closewindow address:{address}")


def bind(keys: str, command: str, flags: str = "") -> None:
    """
    A runtime bind, replacing whatever the key did. A config reload drops it;
    `Events` says when. `flags` are Hyprland's: `e` repeats while held, `l`
    works on the lock screen — what volume keys want.
    """
    ask(f"/keyword unbind {keys}")
    ask(f"/keyword bind{flags} {keys}, exec, {command}")


def unbind(keys: str) -> None:
    ask(f"/keyword unbind {keys}")


class Events(QObject):
    """The event socket, read on Qt's loop."""

    #: Something that can change what is on the current workspace happened.
    changed = Signal()
    #: The config was reloaded, which drops runtime binds.
    reloaded = Signal()
    #: Something the dock shows changed: a window, its title, focus, a workspace.
    windows = Signal()

    WATCH = ("workspace", "openwindow", "closewindow", "movewindow", "focusedmon", "activespecial")
    WINDOWS = WATCH + ("activewindow", "windowtitle", "renameworkspace", "createworkspace", "destroyworkspace")

    def __init__(self, parent: QObject | None = None) -> None:
        super().__init__(parent)
        self._buffer = b""
        self._sock = QLocalSocket(self)
        self._sock.readyRead.connect(self._read)
        self._sock.connectToServer(os.path.join(_socket_dir(), ".socket2.sock"))

    def _read(self) -> None:
        self._buffer += bytes(self._sock.readAll())
        *lines, self._buffer = self._buffer.split(b"\n")
        fire = windows = False
        for line in lines:
            name = line.split(b">>", 1)[0].decode("ascii", "replace")
            if name == "configreloaded":
                self.reloaded.emit()
            bare = name[:-2] if name.endswith("v2") else name
            if bare in self.WATCH:
                fire = True
            if bare in self.WINDOWS:
                windows = True
        if fire:
            self.changed.emit()
        if windows:
            self.windows.emit()
