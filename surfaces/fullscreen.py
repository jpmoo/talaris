# SPDX-License-Identifier: GPL-3.0-only
# Copyright (c) 2026 Jeff Moore
"""
A window fullscreen on the desktop in front, noticed and written down — and
the bar still reachable over it.

Fullscreen in Hyprland's own sense (mode 2) covers the background and top
layers: the wallpaper, and the bar with its edge sensor. A window can go there
by itself — Zoom's meeting window came back from a breakout room so, and the
screen was the meeting and nothing else (2026-10-27). Talaris's own key for
filling the screen (Super+Shift+F) is the other mode, maximized, which leaves
the bar where it is.

So while a window is fullscreen the bar and the dock hide as if set to, their
edge sensors on the overlay layer above the window: the pointer at the edge
brings one out over the window, as a Mac's menu bar comes out over a
fullscreen app, and it goes again when the pointer leaves. When nothing is
fullscreen they are as Settings has them.

**A game that fills the screen without saying so** counts too: one that makes
a borderless window exactly the monitor's size, floating over everything
rather than asking to be fullscreen, covers the screen all the same — and
would otherwise play under the bar.

And Super+Escape, the key that puts everything away, takes it out of
fullscreen too (`leave`): Zoom, sharing a screen, goes fullscreen and says
Escape brings it back, but its Escape does not always reach the window that
is fullscreen (2026-10-28). Talaris binds Super+Escape itself, so it works
whatever covers the screen; the window goes back to its tile, and is told so.

**A window sitting where the bar is** puts the bar away too, and the dock
the same: a floating window on the screen in front reaching into the strip
the bar stands in — Zoom's sharing toolbar, which places itself at the top of
the screen (2026-11-10, and could not be pressed: the bar, on the layer above
windows, took every press). Only floating windows, and pinned ones from any
desktop: a tiled one never reaches the bar's strip while it is kept, and one
that grows into it once the bar is away must not keep it away. Floating
windows move without Hyprland saying so, so while one is about, it is looked
at again every two seconds.

Each change is logged with the window — which application, its title, which
desktop, and the mode it is in and the one it was told it is in — so that the
next time the screen is taken, the journal says by what.
"""

from __future__ import annotations

import json

from PySide6.QtCore import QObject, QTimer

import hypr
from views import log

#: Hyprland's fullscreen modes, as `j/clients` gives them: what each covers.
FULL = 2


def covering() -> dict | None:
    """
    The window covering the workspace in front: fullscreen (covering the layers
    under the overlay), or the monitor's exact size and place with no frame to
    it (a game, borderless) — None if there is none.
    """
    try:
        active = json.loads(hypr.ask("j/activeworkspace") or "{}")
        clients = json.loads(hypr.ask("j/clients") or "[]")
        monitor = next((m for m in json.loads(hypr.ask("j/monitors") or "[]") if m.get("id") == active.get("monitorID")), None)
    except (OSError, ValueError):
        return None
    here = [c for c in clients if c.get("workspace", {}).get("id") == active.get("id") and c.get("mapped", True) and not c.get("hidden")]

    def said(c: dict, mode: int) -> dict:
        return {"address": c.get("address", ""), "class": c.get("class") or c.get("initialClass") or "",
                "title": c.get("title", ""), "mode": mode, "client": int(c.get("fullscreenClient", 0)),
                "workspace": active.get("name", "")}
    if active.get("hasfullscreen"):
        for c in here:
            if int(c.get("fullscreen", 0)) & FULL:
                return said(c, int(c.get("fullscreen", 0)))
    if monitor:
        scale = float(monitor.get("scale") or 1)
        x, y = monitor.get("x", 0), monitor.get("y", 0)
        w, h = round(monitor.get("width", 0) / scale), round(monitor.get("height", 0) / scale)
        for c in here:
            # Floating, at the monitor's corner and its size: a borderless window filling it. (A tiled one never
            # is — the bar's space is kept from it — and Talaris's own fill, Super+Shift+F, leaves the bar's.)
            if c.get("floating") and list(c.get("at", [])) == [x, y] and list(c.get("size", [])) == [w, h]:
                return said(c, 0)
    return None


def in_the_way(strips: dict[str, tuple[str, int, float, float]]) -> dict[str, dict | None]:
    """
    For each strip (`{"bar": ("top", 43, 0, 1), ...}`: an edge, how far in
    from it, and from where to where along it as shares of the screen's
    width), the floating window on the monitor in front reaching into it, or
    None. Pinned windows count from whatever desktop they were pinned on.
    """
    out: dict[str, dict | None] = {k: None for k in strips}
    try:
        active = json.loads(hypr.ask("j/activeworkspace") or "{}")
        clients = json.loads(hypr.ask("j/clients") or "[]")
        monitor = next((m for m in json.loads(hypr.ask("j/monitors") or "[]") if m.get("id") == active.get("monitorID")), None)
    except (OSError, ValueError):
        return out
    if not monitor:
        return out
    scale = float(monitor.get("scale") or 1)
    mx, my = monitor.get("x", 0), monitor.get("y", 0)
    mw, mh = round(monitor.get("width", 0) / scale), round(monitor.get("height", 0) / scale)
    for c in clients:
        if not c.get("floating") or not c.get("mapped", True) or c.get("hidden"):
            continue
        if c.get("monitor") != monitor.get("id") or not (c.get("pinned") or c.get("workspace", {}).get("id") == active.get("id")):
            continue
        (x, y), (w, h) = c.get("at", [0, 0]), c.get("size", [0, 0])
        # On this monitor's screen at all.
        if w <= 0 or h <= 0 or x + w <= mx or x >= mx + mw:
            continue
        for key, (edge, far, lo, hi) in strips.items():
            across = x < mx + mw * hi and x + w > mx + mw * lo
            if out[key] is None and across and (y < my + far if edge == "top" else y + h > my + mh - far) and y + h > my and y < my + mh:
                out[key] = {"address": c.get("address", ""), "class": c.get("class") or c.get("initialClass") or "", "title": c.get("title", "")}
    return out


class Fullscreen(QObject):
    def __init__(self, desktop) -> None:
        super().__init__(desktop)
        self.desktop = desktop
        #: The window covering the desktop in front, as last seen; None when nothing is.
        self.now: dict | None = None
        ev = desktop.events
        # Looked at again whenever it could have changed: the window's own say, a desktop gone to, a window gone.
        for signal in (ev.fullscreen, ev.workspace, ev.closed):
            signal.connect(lambda *_: QTimer.singleShot(0, self.check))
        # A window moved or made to the screen's size (a game going borderless): looked at once things settle.
        self._settle = QTimer(self)
        self._settle.setSingleShot(True)
        self._settle.timeout.connect(self.check)
        ev.windows.connect(lambda: self._settle.start(300))
        #: What is in the bar's and the dock's way now (in_the_way), by which.
        self.under: dict[str, dict | None] = {"bar": None, "dock": None}
        # Floating windows move without a word from Hyprland: looked at every two seconds (cheap: three small questions).
        self._watch = QTimer(self)
        self._watch.setInterval(2000)
        self._watch.timeout.connect(self.check)
        self._watch.start()
        QTimer.singleShot(1500, self.check)

    def _strips(self) -> dict[str, tuple[str, int, float, float]]:
        """Where the bar and the dock stand, whether or not they are out: each one's edge, depth, and span along it."""
        strips = {"bar": (self.desktop.bar.edge, self.desktop.bar.depth(), 0.0, 1.0)}
        dock = getattr(self.desktop, "dock", None)
        if dock is not None and self.desktop.config["dock"].get("enabled", True):
            # The dock is narrower than the screen: only what is beside it is in its way (its span, as its page last said).
            lo, hi = getattr(dock, "_span", (0.0, 1.0))
            strips["dock"] = (dock.edge, dock.thickness(), lo, hi)
        return strips

    def check(self) -> None:
        self._check_under()
        now = covering()
        before = self.now
        same = (now or {}).get("address") == (before or {}).get("address") and (now or {}).get("mode") == (before or {}).get("mode")
        self.now = now
        if same:
            return
        if now:
            how = f"mode {now['mode']}, told {now['client']}" if now["mode"] else "the screen's size, borderless"
            log(f"fullscreen: {now['class'] or '?'} \"{now['title'][:60]}\" on {now['workspace']}"
                f" ({how}): the bar and dock out over it from the edge")
        elif before:
            log(f"fullscreen: nothing covers the desktop in front (was {before['class'] or '?'} on {before['workspace']}); the bar and dock as Settings has them")
        self._cover()

    def _check_under(self) -> None:
        """A floating window in the bar's or the dock's way, come or gone: logged, and that one put away or back."""
        under = in_the_way(self._strips())
        changed = False
        for key in ("bar", "dock"):
            was, now = self.under.get(key), under.get(key)
            if (was or {}).get("address") == (now or {}).get("address"):
                continue
            changed = True
            if now:
                log(f"in the way: {now['class'] or '?'} \"{now['title'][:60]}\" where the {key} stands: the {key} away, out from the edge")
            else:
                log(f"in the way: nothing where the {key} stands any more (was {(was or {}).get('class') or '?'}); the {key} as Settings has it")
        self.under = {"bar": under.get("bar"), "dock": under.get("dock")}
        if changed:
            self._cover()

    def _cover(self) -> None:
        self.desktop.bar.cover(bool(self.now) or bool(self.under["bar"]))
        if getattr(self.desktop, "dock", None) is not None:
            self.desktop.dock.cover(bool(self.now) or bool(self.under["dock"]))

    def leave(self) -> bool:
        """The window covering the desktop in front, out of fullscreen and back in its tile; False if none was."""
        now = covering()
        # A borderless window filling the screen is not fullscreen: nothing to take it out of.
        if not now or not now["mode"] or not now["address"].startswith("0x"):
            return False
        hypr.ask(f"/dispatch focuswindow address:{now['address']}")
        # Neither Hyprland's fullscreen nor the one the window was told: it is a window again, and knows it.
        hypr.ask("/dispatch fullscreenstate 0 0")
        log(f"fullscreen: {now['class'] or '?'} taken out of fullscreen (Super+Escape)")
        QTimer.singleShot(0, self.check)
        return True
