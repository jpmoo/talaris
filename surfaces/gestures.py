# SPDX-License-Identifier: GPL-3.0-only
# Copyright (c) 2026 Jeff Moore
"""
A three-finger swipe across the touchscreen, for the carousel (tiling.py):
left brings the next window in, right the one before — the strip following
the fingers, as a page is turned.

**Read beside, never taken.** The touchscreen's event device is read as it is
(no grab): every touch still reaches the window under it, so one finger and two
are the apps' own, and three going sideways is read here as well. Hyprland's
own gestures are for touchpads; a touchscreen's would need a plugin Ubuntu
does not package.

**The way it is turned.** The panel's own axes are not the screen's when it is
turned (rotation.py): a swipe is measured in the panel's, and turned by the
screen's transform into across or up and down as the screen is seen.

**Allowed by udev.** The device is read only with leave: install.sh puts a
rule giving the session's user its touchscreens (`uaccess`) — not the `input`
group, which reads every keyboard. Without it this says so once, and nothing
else changes.
"""

from __future__ import annotations

import fcntl
import json
import re
import struct
import threading
import time

import hypr
from views import log

EV_SYN, EV_ABS = 0, 3
SYN_REPORT = 0
ABS_MT_SLOT, ABS_MT_POSITION_X, ABS_MT_POSITION_Y, ABS_MT_TRACKING_ID = 0x2F, 0x35, 0x36, 0x39
EVENT = struct.Struct("qqHHi")  # struct input_event on 64-bit: time, type, code, value
FINGERS = 3
#: How far across, as a share of the screen's width, a swipe must go to count.
ACROSS = 0.15


def touchscreen() -> str:
    """The touchscreen's event device, by the kernel's list: one that is direct (on the screen), not its stylus."""
    try:
        text = open("/proc/bus/input/devices").read()
    except OSError:
        return ""
    for block in text.split("\n\n"):
        name = re.search(r'N: Name="([^"]*)"', block)
        handler = re.search(r"H: Handlers=.*?(event\d+)", block)
        prop = re.search(r"B: PROP=(\w+)", block)
        if not (name and handler and prop):
            continue
        n = name.group(1).lower()
        if "touchscreen" in n and "stylus" not in n and "pen" not in n and int(prop.group(1), 16) & 0x2:
            return f"/dev/input/{handler.group(1)}"
    return ""


def _range(f, code: int) -> tuple[int, int]:
    """An axis's least and most (EVIOCGABS)."""
    buf = bytearray(24)
    fcntl.ioctl(f, (2 << 30) | (24 << 16) | (ord("E") << 8) | (0x40 + code), buf)
    _value, low, high, *_rest = struct.unpack("6i", buf)
    return low, high


def _transform() -> int:
    """The built-in screen's transform now (0–7): which way the panel is turned."""
    try:
        for m in json.loads(hypr.ask("j/monitors") or "[]"):
            if m.get("name", "").startswith(("eDP", "DSI", "LVDS")):
                return int(m.get("transform", 0))
    except ValueError:
        pass
    return 0


def across(dx: float, dy: float, transform: int) -> tuple[float, float]:
    """A move in the panel's axes, as the screen is seen: (across, down). Turned a quarter at a time, as Wayland's transforms are."""
    t = transform % 4
    if t == 0:
        return dx, dy
    # Read off the mini (2026-11-15): turned to 3, a finger up from the screen's bottom read as the panel's
    # u falling from 1 — the quarter-turns are the other way round from the first guess.
    if t == 1:
        return -dy, dx
    if t == 2:
        return -dx, -dy
    return dy, -dx


def place(u: float, v: float, transform: int) -> tuple[float, float]:
    """A point in the panel's axes (shares of each, 0–1), as the screen is seen: (across, down), each 0–1."""
    t = transform % 4
    if t == 0:
        return u, v
    if t == 1:
        return 1 - v, u
    if t == 2:
        return 1 - u, 1 - v
    return v, 1 - u


#: A finger come down this near an edge (a share of the screen) and drawn this far in: the edge's bar or dock out.
EDGE_NEAR, EDGE_IN = 0.035, 0.04


class Gestures:
    def __init__(self, wanted, slide, on_edge=None) -> None:
        """
        `wanted()`: whether to act (the carousel is in use). `slide(way)`: +1 the next window, -1 the one before.
        `on_edge(edge)`: one finger drawn in from an edge ("top", "bottom", "left", "right") — a hidden dock or bar
        brought out (surfaces.py). Called on this reader's own thread: the caller passes it to the screens' own.
        """
        self.wanted = wanted
        self.slide = slide
        self.on_edge = on_edge
        self.path = touchscreen()
        if not self.path:
            return
        threading.Thread(target=self._run, daemon=True).start()

    def _run(self) -> None:
        try:
            f = open(self.path, "rb", buffering=0)
        except PermissionError:
            log(f"gestures: the touchscreen ({self.path}) cannot be read — install.sh's udev rule gives it; no swipes until then")
            return
        except OSError as e:
            log(f"gestures: no touchscreen ({e})")
            return
        try:
            xr, yr = _range(f, ABS_MT_POSITION_X), _range(f, ABS_MT_POSITION_Y)
        except OSError:
            xr, yr = (0, 1000), (0, 1000)
        log(f"gestures: reading the touchscreen ({self.path})")
        slot = 0
        at: dict[int, list[int]] = {}
        live: set[int] = set()
        start = None  # where the fingers were, together, when the third came down
        most = 0
        now = (0.0, 0.0)
        one = None  # one finger: where it came down, as the screen is seen, the screen's turn then, and whether it has acted
        turn = 0
        while True:
            try:
                data = f.read(EVENT.size)
            except OSError:
                time.sleep(1)
                continue
            if len(data) < EVENT.size:
                continue
            _s, _u, kind, code, value = EVENT.unpack(data)
            if kind == EV_ABS:
                if code == ABS_MT_SLOT:
                    slot = value
                elif code == ABS_MT_TRACKING_ID:
                    if value < 0:
                        live.discard(slot)
                    else:
                        live.add(slot)
                        at[slot] = at.get(slot, [0, 0])
                elif code == ABS_MT_POSITION_X:
                    at.setdefault(slot, [0, 0])[0] = value
                elif code == ABS_MT_POSITION_Y:
                    at.setdefault(slot, [0, 0])[1] = value
                continue
            if kind != EV_SYN or code != SYN_REPORT:
                continue
            n = len(live)
            was_most = most
            most = max(most, n)
            # One finger, from an edge (the edge's bar or dock): looked at as it moves, acting once it is far enough in.
            if n == 1 and was_most == 0 and self.on_edge:
                turn = _transform()
                p = self._middle(at, live)
                one = {"at": place((p[0] - xr[0]) / max(1, xr[1] - xr[0]), (p[1] - yr[0]) / max(1, yr[1] - yr[0]), turn), "done": False}
                u0, v0 = one["at"]
                near = [e for e, ok in (("top", v0 <= EDGE_NEAR), ("bottom", v0 >= 1 - EDGE_NEAR), ("left", u0 <= EDGE_NEAR), ("right", u0 >= 1 - EDGE_NEAR)) if ok]
                if near:
                    log(f"gestures: a finger down at the {near[0]} edge ({u0:.3f}, {v0:.3f}; turn {turn})")
            elif n == 1 and most == 1 and one and not one["done"]:
                p = self._middle(at, live)
                u, v = place((p[0] - xr[0]) / max(1, xr[1] - xr[0]), (p[1] - yr[0]) / max(1, yr[1] - yr[0]), turn)
                edge = self._from_edge(one["at"], (u, v))
                if edge:
                    one["done"] = True
                    self.on_edge(edge)
            if n == 0:
                one = None
            if n == FINGERS and start is None:
                start = self._middle(at, live)
                now = start
            elif n == FINGERS and start is not None:
                now = self._middle(at, live)
            if n == 0:
                # All lifted: a swipe if three went far enough sideways, and only three.
                if start is not None and most == FINGERS and self.wanted():
                    self._ended(start, now, xr, yr)
                start, most = None, 0

    @staticmethod
    def _from_edge(start: tuple[float, float], now: tuple[float, float]) -> str:
        """The edge a finger came in from — begun near it, and drawn in from it far enough and more than along it — or ""."""
        (u0, v0), (u, v) = start, now
        if v0 >= 1 - EDGE_NEAR and v0 - v >= EDGE_IN and v0 - v > abs(u - u0):
            return "bottom"
        if v0 <= EDGE_NEAR and v - v0 >= EDGE_IN and v - v0 > abs(u - u0):
            return "top"
        if u0 <= EDGE_NEAR and u - u0 >= EDGE_IN and u - u0 > abs(v - v0):
            return "left"
        if u0 >= 1 - EDGE_NEAR and u0 - u >= EDGE_IN and u0 - u > abs(v - v0):
            return "right"
        return ""

    @staticmethod
    def _middle(at: dict[int, list[int]], live: set[int]) -> tuple[float, float]:
        pts = [at[s] for s in live if s in at]
        return (sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts)) if pts else (0.0, 0.0)

    def _ended(self, start, end, xr, yr) -> None:
        t = _transform()
        # Panel units to a share of each axis, then turned as the screen is.
        dx = (end[0] - start[0]) / max(1, xr[1] - xr[0])
        dy = (end[1] - start[1]) / max(1, yr[1] - yr[0])
        a, d = across(dx, dy, t)
        if abs(a) >= ACROSS and abs(a) > abs(d) * 1.5:
            # Fingers to the left bring the next window in from the right.
            way = 1 if a < 0 else -1
            log(f"gestures: swipe {'left' if a < 0 else 'right'} (transform {t}): {'next' if way > 0 else 'previous'} window")
            self.slide(way)
