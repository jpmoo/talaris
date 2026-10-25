# SPDX-License-Identifier: GPL-3.0-only
# Copyright (c) 2026 Jeff Moore
"""
Plugins' windows (`[[apps]]` in a plugin.toml; core, plugins.ts): each a web
app in a window of its own (webapp.py), for as long as its plugin is enabled.

For each one Talaris writes a desktop entry — so the launcher lists it and
the dock shows it by its name — and binds its key. The key, or the launcher,
brings the window forward if it is open (going to its desktop), and opens it
if not: one window, never a second.

Read again when a plugin is enabled, stopped or set (settings.py says so),
after a config reload drops the binds, and every minute besides.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys

from PySide6.QtCore import QObject, QTimer

import hypr
from core import call

HERE = os.path.dirname(os.path.abspath(__file__))
APPS_DIR = os.path.join(os.environ.get("XDG_DATA_HOME") or os.path.expanduser("~/.local/share"), "applications")
PREFIX = "talaris-app-"


def app_key(a: dict) -> str:
    """`<plugin>-<app>`: its app id after the prefix, and its desktop entry's name."""
    return f"{a['plugin']}-{a['id']}"


class WebApps(QObject):
    def __init__(self, desktop, launcher: str) -> None:
        super().__init__(desktop)
        self.desktop = desktop
        self.launcher = launcher
        self.apps: dict[str, dict] = {}
        self.bound: dict[str, str] = {}  # keys -> app key
        self.timer = QTimer(self)
        self.timer.timeout.connect(self.refresh)
        self.timer.start(60_000)
        QTimer.singleShot(3000, self.refresh)

    def refresh(self) -> None:
        status, text = call("GET", "/plugins/apps")
        if status != 200:
            return
        try:
            listed = json.loads(text)
        except ValueError:
            return
        apps = {app_key(a): a for a in listed}
        if json.dumps(apps, sort_keys=True) == json.dumps(self.apps, sort_keys=True):
            return
        self.apps = apps
        self._entries()
        self.rebind()

    def _entries(self) -> None:
        """A desktop entry for each, and none left for one gone."""
        os.makedirs(APPS_DIR, exist_ok=True)
        wanted = {f"{PREFIX}{k}.desktop" for k in self.apps}
        for name in os.listdir(APPS_DIR):
            if name.startswith(PREFIX) and name.endswith(".desktop") and name not in wanted:
                os.remove(os.path.join(APPS_DIR, name))
        for k, a in self.apps.items():
            lines = [
                "[Desktop Entry]", "Type=Application", f"Name={a['name']}",
                f"Comment={a['name']}, in a window of its own ({a['pluginName']}, a Talaris plugin)",
                f"Exec={self.launcher} --app {k}",
                f"Icon={a.get('icon') or 'internet-web-browser'}",
                f"StartupWMClass={PREFIX}{k}", "Categories=Network;Office;", "Terminal=false",
            ]
            path = os.path.join(APPS_DIR, f"{PREFIX}{k}.desktop")
            text = "\n".join(lines) + "\n"
            try:
                with open(path, encoding="utf-8") as f:
                    if f.read() == text:
                        continue
            except OSError:
                pass
            with open(f"{path}.tmp", "w", encoding="utf-8") as f:
                f.write(text)
            os.replace(f"{path}.tmp", path)
        # The dock and the launcher read entries once: told to look again.
        apps = getattr(self.desktop, "apps", None)
        if apps is not None:
            apps.index()

    def rebind(self) -> None:
        """Each window's key, and none left for one gone. Also after a reload, which drops runtime binds."""
        for keys in self.bound:
            hypr.unbind(keys)
        self.bound = {}
        for k, a in self.apps.items():
            if a.get("key"):
                hypr.bind(a["key"], f"{self.launcher} --app {k}")
                self.bound[a["key"]] = k

    def unbind(self) -> None:
        for keys in self.bound:
            hypr.unbind(keys)
        self.bound = {}

    def open(self, k: str) -> None:
        """Its window forward if it is open; else started."""
        a = self.apps.get(k)
        if not a:
            self.refresh()
            a = self.apps.get(k)
        if not a:
            return
        try:
            clients = json.loads(hypr.ask("j/clients"))
        except (OSError, ValueError):
            clients = []
        mine = [c for c in clients if (c.get("class") or c.get("initialClass")) == f"{PREFIX}{k}"]
        if mine:
            hypr.focus(sorted(mine, key=lambda c: c.get("focusHistoryID", 999))[0]["address"])
            return
        # Its dock pin kept in a project (where the rule is to bring): started there, not here.
        cfg = self.desktop.config
        home = cfg["dock"].get("stays", {}).get(f"{PREFIX}{k}") if cfg["launcher"].get("singleWindow", "bring") != "go" else None
        if home:
            self.desktop.go_to_project(home, announce=True)
        args = [sys.executable, os.path.join(HERE, "webapp.py"), "--id", k, "--name", a["name"], "--url", a["url"]]
        if a.get("icon"):
            args += ["--icon", a["icon"]]
        # Its own process, apart from Talaris's: a crash of either leaves the other.
        subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
