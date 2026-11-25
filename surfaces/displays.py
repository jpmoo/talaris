# SPDX-License-Identifier: GPL-3.0-only
# Copyright (c) 2026 Jeff Moore
"""
A display plugged in: beside the built-in screen (extend), or showing the same (mirror) — Settings, Look,
"External display", and the bar's display button while one is connected.

**Mirror is the external display copying the built-in screen**, never the other way round. The built-in screen
is always there, so the bar, the dock and the desktop stay on a screen that does not come and go; the copy shows
them too. The other way — the built-in screen set to mirror the external one, as nwg-displays wrote it — made
the built-in screen a copy apps cannot draw on: plugged in, the bar and the dock went with it; taken away, it
was left a copy of nothing, and Hyprland told every application it was 0×0 until the session was started
again (2026-11-20).

**Extend** is the external display as the person's own Hyprland configuration places it (a `monitor=` line for
it, as nwg-displays writes them), or Hyprland's own choice where there is none.

Applied as runtime keywords when a display comes, when the setting changes, and at start; hyprland.conf and its
sources are only read. Only what differs from how Hyprland has it now is set, so applying again changes nothing.
"""

from __future__ import annotations

import glob
import json
import os
import re

from PySide6.QtCore import QObject, QTimer, Signal

import hypr
from views import log

#: The built-in screen's connector names (as rotation.py knows them).
BUILT_IN = re.compile(r"^(eDP|DSI|LVDS)", re.I)
MODES = ("extend", "mirror")


def outputs() -> list[dict]:
    """Every display Hyprland knows, mirrored and turned off ones too."""
    try:
        return json.loads(hypr.ask("j/monitors all") or "[]")
    except (ValueError, OSError):
        return []


def built_in(mons: list[dict] | None = None) -> dict | None:
    return next((m for m in (mons if mons is not None else outputs()) if BUILT_IN.match(m.get("name", ""))), None)


def external(mons: list[dict] | None = None) -> list[dict]:
    """The displays plugged in: every one but the built-in screen."""
    return [m for m in (mons if mons is not None else outputs()) if not BUILT_IN.match(m.get("name", ""))]


def _conf_rule(name: str) -> str:
    """The person's own `monitor=` line for this display (hyprland.conf and the files beside it), without a mirror."""
    found = ""
    for path in sorted(glob.glob(os.path.expanduser("~/.config/hypr/*.conf"))):
        try:
            with open(path, encoding="utf-8", errors="replace") as f:
                for line in f:
                    line = line.split("#", 1)[0].strip()
                    m = re.match(r"monitor\s*=\s*(.+)$", line)
                    if m and m.group(1).split(",", 1)[0].strip() == name:
                        found = m.group(1).strip()
        except OSError:
            continue
    parts = [p.strip() for p in found.split(",")] if found else []
    if "mirror" in parts:
        parts = parts[: parts.index("mirror")]
    return ",".join(parts) if len(parts) >= 4 else ""


class Displays(QObject):
    #: The displays plugged in, or how they are shown, changed: the bar and its popup say so.
    changed = Signal()

    def __init__(self, desktop) -> None:
        super().__init__(desktop)
        self.desktop = desktop
        self._soon = QTimer(self)
        self._soon.setSingleShot(True)
        self._soon.timeout.connect(self.apply)
        desktop.events.monitors.connect(lambda: self._soon.start(800))
        # A reload puts the configuration's own lines back: applied again over them.
        desktop.events.reloaded.connect(lambda: self._soon.start(800))
        QTimer.singleShot(2000, self.apply)
        self._seen: list[str] = []
        self._said: dict | None = None

    def mode(self) -> str:
        m = self.desktop.config.get("screen", {}).get("external", "mirror")
        return m if m in MODES else "mirror"

    def apply(self) -> None:
        """Each display plugged in shown as the setting says; only what differs from now is changed."""
        mons = outputs()
        inside = built_in(mons)
        mode = self.mode()
        for m in external(mons):
            name = m["name"]
            mirroring = m.get("mirrorOf") not in (None, "", "none")
            if mode == "mirror" and inside and not mirroring:
                hypr.keyword("monitor", f"{name},preferred,auto,1,mirror,{inside['name']}")
                log(f"displays: {name} mirrors {inside['name']}")
            elif mode == "extend" and (mirroring or m.get("disabled")):
                rule = _conf_rule(name) or f"{name},preferred,auto,1"
                hypr.keyword("monitor", rule)
                log(f"displays: {name} beside {inside['name'] if inside else 'the screen'} ({rule})")
        # The built-in screen never a copy: one left mirroring (an old configuration) is made a screen of its own.
        if inside and inside.get("mirrorOf") not in (None, "", "none"):
            rule = _conf_rule(inside["name"]) or f"{inside['name']},preferred,auto,auto"
            hypr.keyword("monitor", rule)
            log(f"displays: {inside['name']} a screen of its own again, not a copy")
        now = [m["name"] for m in external()]
        if now != self._seen:
            log(f"displays: plugged in: {', '.join(now) or 'none'}")
            self._seen = now
        self._said = self._describe()
        self.changed.emit()

    def describe(self) -> dict:
        """For the bar's display button and its popup: what is plugged in, and how it is shown — as last read."""
        if self._said is None:
            self._said = self._describe()
        return {**self._said, "mode": self.mode()}

    def _describe(self) -> dict:
        mons = outputs()
        return {
            "mode": self.mode(),
            "external": [{"name": m.get("name", ""), "label": " ".join(x for x in (m.get("make", ""), m.get("model", "")) if x and x != "Unknown") or m.get("description", "") or m.get("name", ""),
                          "size": f"{m.get('width', 0)}×{m.get('height', 0)}", "hz": round(float(m.get("refreshRate", 0) or 0)),
                          "mirroring": m.get("mirrorOf") not in (None, "", "none")} for m in external(mons)],
        }
