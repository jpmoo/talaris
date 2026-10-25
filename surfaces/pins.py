# SPDX-License-Identifier: GPL-3.0-only
# Copyright (c) 2026 Jeff Moore
"""
Pinned windows, carried rather than pinned.

A window an application pins — shown on every workspace: Zoom's sharing bar
and its floating video, a picture-in-picture player — is drawn on a project's
desktop but never given a click there: the press goes through it to whatever
is underneath. A project's desktop is a named workspace, which Hyprland gives
a negative id as it does its special ones, and a pinned window on one is not
offered the pointer (found 2026-10-25, Hyprland 0.53, with Zoom's bar: unpinned,
it took clicks at once).

So Talaris takes the pin over: the window is unpinned, and carried to each
workspace gone to — still on every desktop, and clickable on all of them. One
already pinned when Talaris starts, or that opens pinned, is taken over too.
"""

from __future__ import annotations

import json

from PySide6.QtCore import QObject, QTimer

import hypr
from views import log


class Pins(QObject):
    def __init__(self, desktop) -> None:
        super().__init__(desktop)
        self.desktop = desktop
        #: The windows carried: unpinned by Talaris, moved to each workspace gone to.
        self.carried: set[str] = set()
        #: Unpinned by Talaris, and its own pin event not yet heard back: not taken as the person unpinning it.
        self._ours: set[str] = set()
        ev = desktop.events
        ev.pinned.connect(self._pinned)
        ev.workspace.connect(lambda _name: QTimer.singleShot(0, self._follow))
        ev.closed.connect(self.carried.discard)
        # One that opens pinned may say so only in its state: looked at once it has settled.
        ev.opened.connect(lambda _a: QTimer.singleShot(400, self.sweep))
        QTimer.singleShot(1500, self.sweep)

    def _pinned(self, address: str, on: bool) -> None:
        if on:
            self._take(address)
        elif address in self._ours:
            self._ours.discard(address)
        else:
            # Unpinned some other way than by Talaris: no longer carried.
            self.carried.discard(address)

    def _take(self, address: str) -> None:
        self._ours.add(address)
        self.carried.add(address)
        hypr.toggle_pin(address)
        log(f"pins: {address} carried rather than pinned")

    def sweep(self) -> None:
        """Every pinned window, taken over."""
        try:
            clients = json.loads(hypr.ask("j/clients") or "[]")
        except (OSError, ValueError):
            return
        for c in clients:
            if c.get("pinned") and c.get("address") not in self._ours:
                self._take(c["address"])

    def _follow(self) -> None:
        """The windows carried, to the workspace now in front, without taking focus."""
        if not self.carried:
            return
        now = hypr.windows()
        here = now["activeTarget"]
        alive = {w["address"]: w for w in now["windows"]}
        for address in list(self.carried):
            w = alive.get(address)
            if not w:
                self.carried.discard(address)
                continue
            if not w["hidden"] and w["workspace"] != now["active"]:
                hypr.carry(address, here)
