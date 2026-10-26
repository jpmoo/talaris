# SPDX-License-Identifier: GPL-3.0-only
# Copyright (c) 2026 Jeff Moore
"""
Demo mode, from the surfaces' side (the core's demo.ts says what it is): a
made-up world to show Talaris off, its own store, Projects folder and
settings under `~/.local/share/talaris-demo`. Chosen by a mark in the
person's own settings folder, which `talaris-surfaces` and the core read as
they start; so entering it, leaving it and making it afresh are each the
mark (or the demo's own folders) changed, then Talaris started again.
"""

from __future__ import annotations

import os
import shutil
import subprocess

_config = (os.environ.get("XDG_CONFIG_HOME") or "").strip() or os.path.expanduser("~/.config")
_data = (os.environ.get("XDG_DATA_HOME") or "").strip() or os.path.expanduser("~/.local/share")
MARK = os.path.join(_config, "talaris", "demo")
ROOT = os.path.join(_data, "talaris-demo")
#: What a reset takes away: the made-up world. Its key and its settings (how it looks) stay.
MADE = ("data", "state", "Projects", "plugins", "seeded", "calendar.json")


def on() -> bool:
    """Whether this run is the demo (talaris-surfaces said so)."""
    return bool(os.environ.get("TALARIS_DEMO"))


def _restart() -> None:
    """The core and the surfaces started again, into whichever world the mark now says — this process among them."""
    subprocess.Popen(["systemctl", "--user", "restart", "talaris-core", "talaris-surfaces"], start_new_session=True,
                     stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def enter() -> None:
    os.makedirs(os.path.dirname(MARK), exist_ok=True)
    with open(MARK, "w") as f:
        f.write("Talaris starts in its demo world while this file is here (Settings, Data).\n")
    _restart()


def leave() -> None:
    try:
        os.remove(MARK)
    except FileNotFoundError:
        pass
    _restart()


def reset() -> None:
    """The made-up world made afresh at the next start: only the demo's own folder is touched, and only in it."""
    root = os.path.realpath(ROOT)
    if os.path.basename(root) != "talaris-demo" or not root.startswith(os.path.realpath(_data) + os.sep):
        return
    for name in MADE:
        path = os.path.join(root, name)
        if os.path.isdir(path) and not os.path.islink(path):
            shutil.rmtree(path)
        elif os.path.lexists(path):
            os.remove(path)
    _restart()
