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
    # Special workspaces are scratchpads summoned by a key, not places you go —
    # except Talaris's own, where the dock puts a window it hides.
    # A project's desktop is a named workspace, and Hyprland gives those negative
    # ids as it does special ones: told apart by name, not by the sign.
    ordinary = lambda w: not str(w.get("name", "")).startswith("special:") and w.get("id", 0) != 0
    regular = [c for c in clients if c.get("mapped", True) and (ordinary(c.get("workspace", {}))
                                                                 or c.get("workspace", {}).get("name") == HIDDEN)]
    return {
        "windows": [
            {"address": c["address"], "class": c.get("class") or c.get("initialClass") or "",
             "title": c.get("title", ""), "workspace": c["workspace"]["id"],
             "hidden": c["workspace"].get("name") == HIDDEN,
             "recent": c.get("focusHistoryID", 999), "pid": c.get("pid", 0)}
            for c in regular
        ],
        "workspaces": [{"id": w["id"], "name": w.get("name", str(w["id"]))} for w in spaces if ordinary(w)],
        "active": active.get("id"),
        # The active workspace as a dispatcher names it (`target`).
        "activeTarget": target(active) if active else "1",
        "activeName": active.get("name", ""),
        "focused": (focused or {}).get("address"),
    }


#: Where the dock puts a window it hides: a special workspace nobody summons.
HIDDEN = "special:talaris-hidden"


def _address(address: str) -> bool:
    return address.startswith("0x") and all(c in "0123456789abcdefx" for c in address.lower())


def hide(address: str) -> None:
    if _address(address):
        ask(f"/dispatch movetoworkspacesilent {HIDDEN},address:{address}")


def target(workspace: dict) -> str:
    """
    How a dispatcher names a workspace. By name for a named one (a project's
    desktop): its id is negative, and a dispatcher reads "-1337" as "that
    many workspaces back".
    """
    wid = workspace.get("id", 1)
    return str(wid) if isinstance(wid, int) and wid > 0 else f"name:{workspace.get('name', '')}"


def show(address: str, to: str | None = None) -> None:
    """Back from hiding (or from another desktop), onto the workspace in front of you — or `to` — and focused."""
    if not _address(address):
        return
    if to is None:
        try:
            to = target(json.loads(ask("j/activeworkspace")))
        except (OSError, ValueError):
            to = "1"
    ask(f"/dispatch movetoworkspacesilent {to},address:{address}")
    focus(address)


#: Where an expanded drawer is the desktop: a workspace of its own, empty but
#: for it, so the windows left behind keep their layout untouched.
DESK = "talaris-desk"


def go(workspace) -> None:
    """To a workspace: a number, or a name."""
    target = f"name:{workspace}" if isinstance(workspace, str) else str(int(workspace))
    ask(f"/dispatch workspace {target}")


def bring(address: str, workspace: int) -> None:
    """A window to a workspace, without following it."""
    if _address(address):
        ask(f"/dispatch movetoworkspacesilent {int(workspace)},address:{address}")


def restore(address: str, workspace: int) -> None:
    """Back from hiding onto the workspace it was on."""
    if _address(address):
        ask(f"/dispatch movetoworkspacesilent {int(workspace)},address:{address}")


def toggle_pin(address: str) -> None:
    if _address(address):
        ask(f"/dispatch pin address:{address}")


def carry(address: str, to: str) -> None:
    """A window to a workspace (as a dispatcher names it), without going there or taking focus."""
    if _address(address):
        ask(f"/dispatch movetoworkspacesilent {to},address:{address}")


def focus(address: str) -> None:
    """Bring a window forward, going to its workspace if it is on another."""
    if address.startswith("0x") and all(c in "0123456789abcdefx" for c in address.lower()):
        ask(f"/dispatch focuswindow address:{address}")


def close(address: str) -> None:
    if address.startswith("0x") and all(c in "0123456789abcdefx" for c in address.lower()):
        ask(f"/dispatch closewindow address:{address}")


def option(name: str):
    """One of Hyprland's settings as it is now: its number, or its text."""
    try:
        found = json.loads(ask(f"j/getoption {name}"))
    except (OSError, ValueError):
        return None
    for key in ("int", "float", "str", "custom"):
        if key in found:
            return found[key]
    return None


def refocus_pointer() -> None:
    """
    The cursor nudged and put back where it was. A surface appearing makes
    Hyprland let go of what the pointer was over — the cursor falls back to an
    arrow, and a press goes nowhere — until the pointer moves; this is that move.
    """
    try:
        at = json.loads(ask("j/cursorpos"))
        x, y = int(at["x"]), int(at["y"])
        # A pixel over and back: a page sets its cursor (the pointing hand on a
        # button) only on a move it sees, and a move to the same place is none.
        ask(f"/dispatch movecursor {x + 1} {y}")
        ask(f"/dispatch movecursor {x} {y}")
    except (OSError, ValueError, KeyError):
        pass


def near_edge(edge: str, within: float) -> bool:
    """Whether the pointer is within `within` (compositor pixels) of an edge of the monitor it is on."""
    try:
        cursor = json.loads(ask("j/cursorpos"))
        x, y = cursor["x"], cursor["y"]
        for m in json.loads(ask("j/monitors")):
            mw, mh = m["width"] / m["scale"], m["height"] / m["scale"]
            if m["x"] <= x < m["x"] + mw and m["y"] <= y < m["y"] + mh:
                return {"left": x - m["x"], "right": m["x"] + mw - x, "top": y - m["y"], "bottom": m["y"] + mh - y}[edge] <= within
    except (OSError, ValueError, KeyError):
        pass
    return False


def keyword(name: str, value: str) -> None:
    """One of Hyprland's settings, changed while it runs. A config reload puts it back; `Events` says when."""
    ask(f"/keyword {name} {value}")


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
    #: The workspace gone to, by name: "3", or a project's id.
    workspace = Signal(str)
    #: A window asked to be brought forward (an application started again raises the one it has): its address.
    urgent = Signal(str)
    #: A window opened, or closed: its address (as `j/clients` writes it, 0x…).
    opened = Signal(str)
    closed = Signal(str)
    #: A window pinned (shown on every workspace) or unpinned: its address, and whether it now is.
    pinned = Signal(str, bool)
    #: The workspace in front gained or lost a fullscreen window (which, and how, is asked: fullscreen.py).
    fullscreen = Signal()

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
            if name == "urgent":
                self.urgent.emit("0x" + line.split(b">>", 1)[1].decode("ascii", "replace").strip())
            if name == "workspace":
                self.workspace.emit(line.split(b">>", 1)[1].decode("utf-8", "replace"))
            if name == "fullscreen":
                self.fullscreen.emit()
            if name == "pin":
                addr, _, state = line.split(b">>", 1)[1].decode("ascii", "replace").partition(",")
                self.pinned.emit("0x" + addr.strip(), state.strip() == "1")
            if name in ("openwindow", "closewindow"):
                address = "0x" + line.split(b">>", 1)[1].split(b",", 1)[0].decode("ascii", "replace")
                (self.opened if name == "openwindow" else self.closed).emit(address)
            bare = name[:-2] if name.endswith("v2") else name
            if bare in self.WATCH:
                fire = True
            if bare in self.WINDOWS:
                windows = True
        if fire:
            self.changed.emit()
        if windows:
            self.windows.emit()
