# SPDX-License-Identifier: GPL-3.0-only
# Copyright (c) 2026 Jeff Moore
"""
The wallpaper: hyprpaper's, chosen in Settings or from the desktop's menu.

**Borrowed, not built** (DESIGN.md, "What Talaris borrows"): hyprpaper draws
it, started by `talaris.conf`, from `~/.config/hypr/hyprpaper.conf`. **The
default** — every project's that has none of its own — is that file: Settings
reads it to show what is there and writes it when it changes, so hyprpaper
starts with it.

**A project's own** (Home is a project like the rest) is kept in Talaris's
config (`wallpaper.projects`, by project id), and shown by asking the running
hyprpaper for it (`hyprctl hyprpaper wallpaper`) as that project becomes the
current one — no restart, so no black frame between them.
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


def check(path: str, fit: str) -> str:
    """Why this is not a wallpaper, or nothing."""
    path = os.path.expanduser(path)
    if not (os.path.isfile(path) and path.lower().endswith(PICTURES)):
        return "Not a picture: a .jpg, .png or .webp"
    return "" if fit in FITS else "Not a fit"


def for_project(config: dict, project: str) -> dict:
    """A project's wallpaper: its own (`own`), or the default; `{path, fit, own}`."""
    mine = config.get("wallpaper", {}).get("projects", {}).get(project) if project else None
    if mine and mine.get("path"):
        return {"path": mine["path"], "fit": mine.get("fit", "cover"), "own": True}
    return {**current(), "own": False}


def show(config: dict, project: str) -> None:
    """The current project's wallpaper, on screen now: asked of the running hyprpaper."""
    w = for_project(config, project)
    if not w["path"] or not os.path.isfile(w["path"]):
        return
    subprocess.Popen(["hyprctl", "hyprpaper", "wallpaper", f",{w['path']},{w['fit']}"],
                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)


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


def pick(parent, start: str, chosen) -> None:
    """A picture, chosen in the desktop's own chooser; `chosen` hears its path, or "" if none was."""
    from PySide6.QtCore import QProcess
    chooser = QProcess(parent)
    chooser.setProgram("zenity")
    chooser.setArguments(["--file-selection", "--title=A wallpaper", f"--filename={start or os.path.expanduser('~/Pictures')}/",
                          "--file-filter=Pictures | *.jpg *.jpeg *.png *.webp *.JPG *.JPEG *.PNG"])

    def done(code: int, _status) -> None:
        path = bytes(chooser.readAllStandardOutput()).decode().strip() if code == 0 else ""
        chooser.deleteLater()
        chosen(path)

    chooser.finished.connect(done)
    chooser.start()

