# SPDX-License-Identifier: GPL-3.0-only
# Copyright (c) 2026 Jeff Moore
"""
Settings, exported and imported: one file to take Talaris's settings to
another machine, or back to this one (Settings, Data).

**What goes.** Talaris's own settings — `config.json` (everything Settings
changes: the bar, the dock, the theme, its keys, search by meaning), the
calendar's feeds, the plugins' settings and which are on — and, if asked,
your Hyprland files, as they are: `hyprland.conf` and what sits beside it
(monitors, workspaces, idle, lock, wallpaper). Talaris's own keys are not
in hyprland.conf: it binds them as it runs, from `config.json`, so they go
with it. What never goes: anything secret (plugins' access keys are in the
keyring, and are typed again), the store (Settings, Data's backups are for
that), backups of the Hyprland files (`*.bak*`, `*.before-*`), and
`talaris.conf`, which install.sh writes.

**The file** is a zip, `*.talaris-settings`, with `manifest.json` saying
what it holds; nothing in it is taken but what the manifest names, and only
by a plain name — no paths.

**Importing** backs up everything it would replace first, into a folder of
its own with the time in its name, so an import can be undone by hand. Your
Hyprland files are written only when asked for, and Hyprland is reloaded;
Talaris is restarted to take the rest.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import socket
import time
import zipfile

FORMAT = "talaris-settings"
VERSION = 1
CONFIG = os.environ.get("TALARIS_CONFIG_DIR") or os.path.join(os.path.expanduser("~"), ".config", "talaris")
HYPR = os.path.join(os.environ.get("XDG_CONFIG_HOME") or os.path.join(os.path.expanduser("~"), ".config"), "hypr")
BACKUPS = os.path.join(os.environ.get("XDG_DATA_HOME") or os.path.join(os.path.expanduser("~"), ".local", "share"), "talaris", "settings-backups")
#: Talaris's own settings files, by name: what an export takes from its config folder, and an import may write there.
TALARIS_FILES = ("config.json", "feeds.json", "plugins.json")
#: What of the Hyprland folder is never taken: copies kept by hand, and what install.sh writes.
NOT_HYPR = re.compile(r"(\.bak|\.before-|~$|^talaris\.conf$)")
#: A name, and only a name: no folders, nothing hidden, nothing odd.
PLAIN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$")
LARGEST = 4 * 1024 * 1024


def hypr_files() -> list[str]:
    """The Hyprland folder's own files: what would go with an export."""
    try:
        names = sorted(os.listdir(HYPR))
    except OSError:
        return []
    return [n for n in names if PLAIN.match(n) and not NOT_HYPR.search(n) and os.path.isfile(os.path.join(HYPR, n))
            and os.path.getsize(os.path.join(HYPR, n)) <= LARGEST]


def export(path: str, with_hypr: bool) -> dict:
    """Written to `path` (made to end in .talaris-settings): what went."""
    if not path.endswith(".talaris-settings"):
        path += ".talaris-settings"
    talaris = [n for n in TALARIS_FILES if os.path.isfile(os.path.join(CONFIG, n))]
    hypr = hypr_files() if with_hypr else []
    manifest = {"format": FORMAT, "version": VERSION, "made": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "host": socket.gethostname(),
                "talaris": talaris, "hypr": hypr}
    tmp = path + ".part"
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("manifest.json", json.dumps(manifest, indent=1))
        for n in talaris:
            z.write(os.path.join(CONFIG, n), f"talaris/{n}")
        for n in hypr:
            z.write(os.path.join(HYPR, n), f"hypr/{n}")
    os.replace(tmp, path)
    os.chmod(path, 0o600)
    return {"path": path, "talaris": talaris, "hypr": hypr}


def read(path: str) -> dict:
    """What a settings file holds, checked: its manifest. Raises ValueError for anything that is not one."""
    try:
        with zipfile.ZipFile(path) as z:
            manifest = json.loads(z.read("manifest.json"))
            names = set(z.namelist())
    except (OSError, KeyError, zipfile.BadZipFile, ValueError) as e:
        raise ValueError(f"Not a Talaris settings file ({e})") from e
    if manifest.get("format") != FORMAT or not isinstance(manifest.get("version"), int):
        raise ValueError("Not a Talaris settings file")
    if manifest["version"] > VERSION:
        raise ValueError("Made by a newer Talaris than this one")
    talaris = [n for n in manifest.get("talaris", []) if n in TALARIS_FILES and f"talaris/{n}" in names]
    hypr = [n for n in manifest.get("hypr", []) if isinstance(n, str) and PLAIN.match(n) and not NOT_HYPR.search(n) and f"hypr/{n}" in names]
    return {"made": manifest.get("made", ""), "host": manifest.get("host", ""), "talaris": talaris, "hypr": hypr}


def restore(path: str, with_hypr: bool) -> dict:
    """
    Its settings written here — your Hyprland files only if `with_hypr` —
    after everything it replaces is copied aside: what was written, and where
    the copies are.
    """
    held = read(path)
    if "config.json" in held["talaris"]:
        # A config that is not JSON would leave Talaris on its defaults: refused before anything is touched.
        with zipfile.ZipFile(path) as z:
            json.loads(z.read("talaris/config.json"))
    stamp = time.strftime("%Y-%m-%d %H.%M.%S")
    aside = os.path.join(BACKUPS, f"before import {stamp}")
    plan = [("talaris", n, CONFIG) for n in held["talaris"]] + ([("hypr", n, HYPR) for n in held["hypr"]] if with_hypr else [])
    os.makedirs(aside, mode=0o700, exist_ok=True)
    for kind, n, folder in plan:
        here = os.path.join(folder, n)
        if os.path.isfile(here):
            os.makedirs(os.path.join(aside, kind), exist_ok=True)
            shutil.copy2(here, os.path.join(aside, kind, n))
    with zipfile.ZipFile(path) as z:
        for kind, n, folder in plan:
            data = z.read(f"{kind}/{n}")
            if len(data) > LARGEST:
                raise ValueError(f"{n} is larger than a settings file is")
            os.makedirs(folder, exist_ok=True)
            tmp = os.path.join(folder, f".{n}.importing")
            with open(tmp, "wb") as f:
                f.write(data)
            os.chmod(tmp, 0o600 if kind == "talaris" else 0o644)
            os.replace(tmp, os.path.join(folder, n))
    return {"talaris": held["talaris"], "hypr": held["hypr"] if with_hypr else [], "aside": aside}
