# SPDX-License-Identifier: GPL-3.0-only
# Copyright (c) 2026 Jeff Moore
"""
Your settings between machines (docs/SYNC.md, *What syncs*).

**Yours, not the machine's.** The look, the bar, the clock, the launcher's
keys, the dock's pins, panels, notifications, the wallpapers: the same on
every machine you use. The screen, its text sizes, touch, power, the model
server, where backups go, which calendars show (their ids are the machine's
own), where you last were: each machine's.

**By path**, one level in (`theme.accent`, `dock.pinned`), so a change to one
setting here and another there both stand; the core keeps them as the
machines agree (sync-apply.ts, `prefs`) and records each change.

**Out** (`sent`): whenever the settings are saved (config.py), what of yours
changed since last sent goes to the core. **In** (`arrived`): told by the core
that settings came, the screens take them as Settings would — kept, and the
screen made to match.

The default wallpaper is hyprpaper's own file, not the settings: it travels as
`wallpaper.default`. A color wallpaper is made again where it arrives; a
picture is used only if it is there.
"""

from __future__ import annotations

import copy
import json
import os

import wallpaper
from core import call, get_json
from views import log

#: Each of your settings' groups, and what in it is the machine's all the same.
YOURS: dict[str, set[str]] = {
    "theme": {"fontSize", "panelOpacity"},
    "bar": set(), "clock": set(), "launcher": set(), "overlays": set(), "wallpaper": set(),
    "notifications": set(), "clipboard": set(), "activity": set(), "panels": set(), "shown": set(),
    "windows": set(), "drawers": set(),
    "location": {"last", "place", "places"},
    "dock": {"elsewhere", "clicks"},
}
SCALARS = ("idleSeconds",)

STATE = os.path.join(os.environ.get("TALARIS_STATE_DIR") or os.path.join(
    os.environ.get("XDG_STATE_HOME") or os.path.expanduser("~/.local/state"), "talaris"), "prefs-sent.json")

#: Set while what arrived is being kept: its saving is not a change of this machine's to send back.
applying = False


def flat(config: dict) -> dict:
    out: dict = {}
    for top, machine in YOURS.items():
        group = config.get(top)
        if isinstance(group, dict):
            for k, v in group.items():
                if k not in machine:
                    out[f"{top}.{k}"] = v
    for k in SCALARS:
        if k in config:
            out[k] = config[k]
    out["wallpaper.default"] = wallpaper.current()
    return out


def _last() -> dict | None:
    try:
        with open(STATE, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def _keep(state: dict) -> None:
    os.makedirs(os.path.dirname(STATE), exist_ok=True)
    tmp = STATE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(state, f)
    os.replace(tmp, STATE)


def _post(set_: dict, unset: list) -> None:
    try:
        call("POST", "/sync/prefs", json.dumps({"set": set_, "unset": unset}), timeout=3)
    except Exception as e:  # noqa: BLE001 — the core away is not the settings' trouble
        log(f"prefs: not sent ({e})")


def sent(config: dict) -> None:
    """Saved here: what of yours changed since last sent, to the core."""
    if applying:
        return
    now = flat(config)
    last = _last()
    if last is None:
        return  # not started yet (start): the first look decides what is sent
    changed = {k: v for k, v in now.items() if last.get(k) != v}
    gone = [k for k in last if k not in now]
    if changed or gone:
        _post(changed, gone)
        _keep(now)


def start(desktop) -> None:
    """
    As the screens start. Settings already agreed elsewhere are taken (a machine joining, or one that was off);
    with none anywhere yet, this machine's are the first, and sent whole.
    """
    agreed = get_json("/sync/prefs", {}) or {}
    if _last() is None:
        if agreed:
            arrived(desktop)
        else:
            now = flat(desktop.config)
            _post(now, [])
            _keep(now)
        return
    arrived(desktop)


def arrived(desktop) -> None:
    """The settings the machines agree on, taken here as Settings would take them."""
    global applying
    agreed = get_json("/sync/prefs", {}) or {}
    if not agreed:
        return
    before = desktop.config
    after = copy.deepcopy(before)
    for path, value in agreed.items():
        if path == "wallpaper.default":
            continue
        top, _, key = path.partition(".")
        if not key:
            after[top] = value
        elif top in YOURS and key not in YOURS[top]:
            after.setdefault(top, {})[key] = value
    # Color wallpapers are made again here; a picture not here is left out rather than shown missing.
    projects = after.get("wallpaper", {}).get("projects", {})
    for pid, w in list(projects.items()):
        path = w.get("path", "") if isinstance(w, dict) else ""
        color = wallpaper.color_of(path)
        if color:
            w["path"] = wallpaper.color_picture(color)
        elif path and not os.path.isfile(path):
            projects[pid] = before.get("wallpaper", {}).get("projects", {}).get(pid) or None
            if projects[pid] is None:
                del projects[pid]
    default = agreed.get("wallpaper.default")
    flat_after = flat(after)
    if after == before and (not isinstance(default, dict) or default == wallpaper.current()):
        _keep(flat_after)
        return
    from config import save_config  # noqa: PLC0415 — config imports this module
    applying = True
    try:
        desktop.config = after
        save_config(after)
        desktop.reconfigure(before, after)
        if isinstance(default, dict) and default != wallpaper.current():
            path = default.get("path", "")
            color = wallpaper.color_of(path)
            if color:
                path = wallpaper.color_picture(color)
            if path and os.path.isfile(path):
                wallpaper.choose(path, default.get("fit", "cover"))
    finally:
        applying = False
    _keep(flat(after))
    log("prefs: your settings from another machine, taken")
