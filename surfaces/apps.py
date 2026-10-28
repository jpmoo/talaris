# SPDX-License-Identifier: GPL-3.0-only
# Copyright (c) 2026 Jeff Moore
"""
Applications, as the dock and the launcher need them: a window's class to a
name and an icon, and an icon's name to a picture.

**The `.desktop` files are the source**, from every place the system keeps
them — the XDG data directories, snaps, flatpaks. A window says only its class
(`com.mitchellh.ghostty`, `org.gnome.Nautilus`); the file whose
`StartupWMClass` is that class, or whose own name is, says what the
application is called and which icon it wears. Read once, and again when a
class turns up that the index has never seen — a newly installed application.

**Icons through Qt's theme lookup**, in the theme GNOME's settings name, so
the dock wears the same icons as everything else on the machine. A page
cannot read files, so `icon_png` hands the surfaces' file handler the picture.
"""

from __future__ import annotations

import os
import re
import shlex
import subprocess

from PySide6.QtCore import QBuffer, QByteArray, QIODevice
from PySide6.QtGui import QIcon


def _data_dirs() -> list[str]:
    home = (os.environ.get("XDG_DATA_HOME") or "").strip() or os.path.expanduser("~/.local/share")
    dirs = [home] + [d for d in (os.environ.get("XDG_DATA_DIRS") or "/usr/local/share:/usr/share").split(":") if d]
    # Snaps and flatpaks export their files here, and a user service may start
    # without the XDG_DATA_DIRS that would have named them.
    for extra in ("/var/lib/snapd/desktop", "/var/lib/flatpak/exports/share",
                  os.path.expanduser("~/.local/share/flatpak/exports/share")):
        if extra not in dirs:
            dirs.append(extra)
    return dirs


def _read_entry(path: str) -> dict:
    entry: dict[str, str] = {}
    section = ""
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            for line in f:
                line = line.strip()
                if line.startswith("["):
                    section = line
                    continue
                # Only the main entry; actions have their own names and icons.
                if section != "[Desktop Entry]" or "=" not in line:
                    continue
                key, _, value = line.partition("=")
                if key in ("Name", "Icon", "StartupWMClass", "NoDisplay", "Exec", "Type",
                           "GenericName", "Keywords", "Hidden"):
                    entry.setdefault(key, value)
    except OSError:
        pass
    return entry


def keeps_one_window(app_id: str) -> bool:
    """Whether an application's desktop file says it has a single main window (`SingleMainWindow=true`)."""
    for d in _data_dirs():
        path = os.path.join(d, "applications", f"{app_id}.desktop")
        if os.path.isfile(path):
            try:
                main = open(path, encoding="utf-8", errors="replace").read().split("\n[", 1)[0]
            except OSError:
                return False
            return bool(re.search(r"^SingleMainWindow\s*=\s*true", main, re.M | re.I))
    return False


def new_window_command(app_id: str) -> list[str] | None:
    """
    The command an application's own "new window" action runs (a browser's
    `firefox --new-window %u`), with its field codes left in; None where its
    desktop file has no such action.
    """
    for d in _data_dirs():
        path = os.path.join(d, "applications", f"{app_id}.desktop")
        if not os.path.isfile(path):
            continue
        try:
            text = open(path, encoding="utf-8", errors="replace").read()
        except OSError:
            return None
        for section in text.split("\n[")[1:]:
            head = section.split("]", 1)[0]
            if not re.match(r"Desktop Action\s+new[-_ ]?window$", head, re.I):
                continue
            found = re.search(r"^Exec\s*=(.*)$", section, re.M)
            return shlex.split(found.group(1)) if found else None
        return None
    return None


def opens_new_windows(app_id: str) -> bool:
    """
    Whether an application opens a new window when started again, as its
    desktop file says: a "new window" action (a browser, a terminal), and not
    `SingleMainWindow=true`. Read from the file each time; it is asked rarely.
    """
    for d in _data_dirs():
        path = os.path.join(d, "applications", f"{app_id}.desktop")
        if not os.path.isfile(path):
            continue
        try:
            text = open(path, encoding="utf-8", errors="replace").read()
        except OSError:
            return False
        main = text.split("\n[", 1)[0]
        if re.search(r"^SingleMainWindow\s*=\s*true", main, re.M | re.I):
            return False
        actions = re.search(r"^Actions\s*=(.*)$", main, re.M)
        return bool(actions and re.search(r"new[-_ ]?(private[-_ ]?)?window", actions.group(1), re.I))
    return False


class Apps:
    def __init__(self) -> None:
        self._by_class: dict[str, dict] = {}
        self._icons: dict[tuple[str, int], bytes] = {}
        self._missed: set[str] = set()
        self._handed: set[str] = set()
        self._listed: dict[str, dict] = {}
        # Qt adds the system's icon folders only through a desktop platform
        # theme, which a layer-shell process does not load; named here instead.
        paths = [os.path.expanduser("~/.icons")] + [os.path.join(d, "icons") for d in _data_dirs()]
        QIcon.setThemeSearchPaths([p for p in paths if os.path.isdir(p)] + QIcon.themeSearchPaths())
        theme = self._gnome_theme()
        if theme:
            QIcon.setThemeName(theme)
        QIcon.setFallbackThemeName("hicolor")
        QIcon.setFallbackSearchPaths(QIcon.fallbackSearchPaths() + ["/usr/share/pixmaps"])
        self.index()

    @staticmethod
    def _gnome_theme() -> str:
        try:
            out = subprocess.run(["gsettings", "get", "org.gnome.desktop.interface", "icon-theme"],
                                 capture_output=True, text=True, timeout=2).stdout.strip()
            return out.strip("'")
        except (OSError, subprocess.SubprocessError):
            return ""

    def _stamp(self) -> tuple:
        """When each applications folder last changed: an application installed or removed changes its folder."""
        out = []
        for base in _data_dirs():
            try:
                out.append(os.stat(os.path.join(base, "applications")).st_mtime_ns)
            except OSError:
                out.append(0)
        return tuple(out)

    def fresh(self) -> None:
        """Read again if anything was installed or removed since: cheap enough to ask whenever the list is wanted."""
        if self._stamp() != getattr(self, "_read_at", None):
            self.index()

    def index(self) -> None:
        self._read_at = self._stamp()
        found: dict[str, dict] = {}
        listed: dict[str, dict] = {}
        # Later directories are lower priority, so the first one to claim a key keeps it.
        for base in _data_dirs():
            apps = os.path.join(base, "applications")
            if not os.path.isdir(apps):
                continue
            for root, _dirs, files in os.walk(apps):
                for name in files:
                    if not name.endswith(".desktop"):
                        continue
                    entry = _read_entry(os.path.join(root, name))
                    if entry.get("Type", "Application") != "Application" or "Name" not in entry:
                        continue
                    stem = name[: -len(".desktop")]
                    desktop_id = os.path.relpath(os.path.join(root, name), apps)[: -len(".desktop")].replace("/", "-")
                    # `id` is what gtk-launch starts it by: a dock pin keeps it.
                    app = {"name": entry["Name"], "icon": entry.get("Icon", ""), "id": desktop_id}
                    keys = [stem.lower()]
                    # A snap's file is `<snap>_<app>.desktop`; its windows say `<app>`.
                    if "_" in stem:
                        keys.append(stem.split("_", 1)[1].lower())
                    if entry.get("StartupWMClass"):
                        keys.insert(0, entry["StartupWMClass"].lower())
                    for k in keys:
                        found.setdefault(k, app)
                    # What the launcher offers: everything a menu would show.
                    if entry.get("NoDisplay") != "true" and entry.get("Hidden") != "true":
                        listed.setdefault(desktop_id, {
                            "id": desktop_id, "name": entry["Name"], "icon": app["icon"],
                            "also": " ".join(x for x in (entry.get("GenericName", ""),
                                                         entry.get("Keywords", "").replace(";", " ")) if x),
                        })
        self._by_class = found
        self._listed = listed

    def launchable(self) -> list[dict]:
        """Every application a menu would show, by its desktop id — just installed ones included."""
        self.fresh()
        for app in self._listed.values():
            if app["icon"]:
                self._handed.add(app["icon"])
        return sorted(self._listed.values(), key=lambda a: a["name"].lower())

    def by_id(self, desktop_id: str) -> dict | None:
        """A launchable application by its desktop id — a dock pin with nothing open."""
        app = self._listed.get(desktop_id)
        if app and app["icon"]:
            self._handed.add(app["icon"])
        return app

    def is_launchable(self, desktop_id: str) -> bool:
        return desktop_id in self._listed

    def known_icons(self) -> set[str]:
        """Every icon name the index has handed out — the only ones the file handler will draw."""
        return self._handed

    def lookup(self, wm_class: str) -> dict:
        """The application a window of this class belongs to; a guess from the class when none says so."""
        key = (wm_class or "").lower()
        if key and key not in self._by_class and key not in self._missed:
            self._missed.add(key)
            self.index()
        app = self._by_class.get(key) or self._by_class.get(key.rsplit(".", 1)[-1])
        if not app:
            # `com.example.Thing` is called Thing, and may have an icon by its class.
            short = (wm_class or "Window").rsplit(".", 1)[-1]
            app = {"name": short[:1].upper() + short[1:], "icon": wm_class or "", "id": ""}
        if app["icon"]:
            self._handed.add(app["icon"])
        return app

    def windows_of(self, key: str, windows: list) -> list:
        """
        Which of `windows` (as hypr.windows lists them) are an application's —
        `key` as the dock knows it (`item_key`) — most recently used first. The
        one rule the dock's menu and the launcher both tell windows apart by.
        """
        return sorted((w for w in windows if item_key(self.lookup(w["class"]), w["class"]) == key), key=lambda w: w["recent"])


    def icon_png(self, name: str, size: int = 64) -> bytes | None:
        """An icon by theme name or absolute path, as PNG bytes; `None` if there is none."""
        if not name:
            return None
        cached = self._icons.get((name, size))
        if cached is not None:
            return cached or None
        icon = QIcon(name) if os.path.isabs(name) else QIcon.fromTheme(name)
        if icon.isNull() and not os.path.isabs(name):
            icon = QIcon.fromTheme(name.lower())
        data = b""
        if not icon.isNull():
            pixmap = icon.pixmap(size, size)
            if not pixmap.isNull():
                buf = QBuffer()
                buf.open(QIODevice.OpenModeFlag.WriteOnly)
                pixmap.save(buf, "PNG")
                data = bytes(QByteArray(buf.data()))
        self._icons[(name, size)] = data
        return data or None


def item_key(app: dict, wm_class: str) -> str:
    """What an application is known by: its launcher's id where there is one, else its window class."""
    return app.get("id") or f"class:{wm_class}"
