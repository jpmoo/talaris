# SPDX-License-Identifier: GPL-3.0-only
# Copyright (c) 2026 Jeff Moore
"""
The wallpaper: hyprpaper's, chosen in Settings.

**Borrowed, not built** (DESIGN.md, "What Talaris borrows"): hyprpaper draws
it, started by `talaris.conf`, from `~/.config/hypr/hyprpaper.conf`. Settings,
Look, reads that file to show what is there, and when a picture or a fit is
chosen there, writes it and restarts hyprpaper so it shows at once. The file
is the one truth: nothing about the wallpaper is kept anywhere else.
"""

from __future__ import annotations

import os
import re
import subprocess

FILE = os.path.join((os.environ.get("XDG_CONFIG_HOME") or "").strip() or os.path.expanduser("~/.config"),
                    "hypr", "hyprpaper.conf")
FITS = ("cover", "contain", "tile", "fill")
PICTURES = (".jpg", ".jpeg", ".png", ".webp")


def current() -> dict:
    """The picture and fit hyprpaper is set to, read from its file."""
    try:
        text = open(FILE, encoding="utf-8").read()
    except OSError:
        return {"path": "", "fit": "cover"}
    path = re.search(r"^\s*path\s*=\s*(.+?)\s*$", text, re.M)
    fit = re.search(r"^\s*fit_mode\s*=\s*(\w+)", text, re.M)
    return {"path": os.path.expanduser(path.group(1)) if path else "", "fit": fit.group(1) if fit else "cover"}


def choose(path: str, fit: str) -> str:
    """Set the wallpaper: write hyprpaper's file and restart it. Answers why not, or nothing."""
    path = os.path.expanduser(path)
    if not (os.path.isfile(path) and path.lower().endswith(PICTURES)):
        return "Not a picture: a .jpg, .png or .webp"
    if fit not in FITS:
        return "Not a fit"
    os.makedirs(os.path.dirname(FILE), exist_ok=True)
    with open(FILE, "w", encoding="utf-8") as f:
        f.write("# Written by Talaris from Settings, Look, Wallpaper.\n"
                f"wallpaper {{\n    monitor =\n    path = {path}\n    fit_mode = {fit}\n}}\nsplash = false\n")
    subprocess.Popen(["systemctl", "--user", "restart", "hyprpaper.service"],
                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
    return ""
