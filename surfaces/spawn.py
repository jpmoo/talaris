# SPDX-License-Identifier: GPL-3.0-only
# Copyright (c) 2026 Jeff Moore
"""
Something of yours started from Talaris — an application, a file in its
application, a terminal — in a place of its own, not in Talaris's.

The surfaces run as a systemd service, and whatever they start as an ordinary
child stays in that service: stopped or restarted, systemd ends it with them —
a manuscript open in LibreOffice killed because Talaris was restarted. So each
is started in a scope of its own (`systemd-run --user --scope`, as desktops'
launchers do), which Talaris's stopping never touches. Talaris's own helpers
(the tray, the clipboard's watch, hypridle) are not started here: they belong
to it, and go with it.
"""

from __future__ import annotations

import os
import re
import secrets
import shutil
import subprocess


def _scopes() -> bool:
    """Whether systemd's user manager is there to make a scope: its socket, and systemd-run."""
    run = os.environ.get("XDG_RUNTIME_DIR", f"/run/user/{os.getuid()}")
    return bool(shutil.which("systemd-run")) and os.path.exists(os.path.join(run, "systemd", "private"))


def start(*cmd: str) -> None:
    """Started and let go, in a scope of its own — or plainly, where there is no user manager to make one."""
    args = list(cmd)
    if _scopes():
        name = re.sub(r"[^A-Za-z0-9_-]", "-", os.path.basename(cmd[0]))[:40] or "app"
        args = ["systemd-run", "--user", "--scope", "--quiet", "--collect",
                f"--unit=app-talaris-{name}-{secrets.token_hex(4)}", "--", *cmd]
    try:
        subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                         stderr=subprocess.DEVNULL, start_new_session=True)
    except OSError:
        pass
