# SPDX-License-Identifier: GPL-3.0-only
# Copyright (c) 2026 Jeff Moore
"""
The Tasks panel (DESIGN, *Tasks*): up from the bar's Tasks button, as every
bar item is (overlay.py) — a panel over the dimmed screen, or by its button a
window Hyprland tiles.

The page (`ui/tasks.html`) does the work against the core — projects and
lists down the left, the chosen one on the right — through `core`, which
answers later (`coreReply`) so a slow answer never holds the page up. Only the
core's task, list and entity routes go through: this is not a door to the rest
of it.
"""

from __future__ import annotations

import base64
import json
import mimetypes
import os
import re
import subprocess
import threading

from PySide6.QtCore import QProcess, Signal, Slot
from PySide6.QtWebEngineCore import QWebEngineProfile

from core import Bridge, call as core_call
from overlay import Overlay
from views import log

#: Files opened from a task, decrypted where only the user can read them and
#: that is cleared at logout: the runtime directory, which lives in memory.
OPENED = os.path.join(os.environ.get("XDG_RUNTIME_DIR", f"/run/user/{os.getuid()}"), "talaris-opened")
#: Larger than this is refused rather than read into the core whole.
LARGEST = 48 * 1024 * 1024

#: What the page may ask the core for.
ALLOWED = re.compile(r"^/(tasks|lists|entities|entity-types)(/|$|\?)")


class TasksBridge(Bridge):
    #: The core's answer to `core`: {id, status, data}.
    coreReply = Signal(str)

    @Slot(str, str, str, str)
    def core(self, ident: str, method: str, path: str, body: str) -> None:
        if not ALLOWED.match(path):
            self.coreReply.emit(json.dumps({"id": ident, "status": 400, "data": {"error": "not a route the Tasks panel uses"}}))
            return

        def run() -> None:
            status, text = core_call(method, path, body or None, timeout=30)
            try:
                data = json.loads(text) if text else None
            except ValueError:
                data = {"error": text}
            self.coreReply.emit(json.dumps({"id": ident, "status": status, "data": data}))
        threading.Thread(target=run, daemon=True).start()


    #: Files attached, or why not: {task, added, error}.
    attached = Signal(str)

    @Slot(str)
    def attach(self, task: str) -> None:
        """Files for a task, chosen in the desktop's chooser (the panel steps aside for it)."""
        self.owner.choose_files(task)

    @Slot(str, str)
    def openFile(self, sha: str, filename: str) -> None:  # noqa: N802 — called from the page by this name
        self.owner.open_file(sha, filename)


class Tasks(Overlay):
    NAME = "tasks"
    TITLE = "Tasks"
    IDLE_MS = 10 * 60 * 1000

    def __init__(self, profile: QWebEngineProfile, desktop) -> None:
        super().__init__(profile, desktop, "talaris-ui://ui/tasks.html", TasksBridge(None, None))
        self.bridge.owner = self
        self.bridge.setParent(self)

    def choose_files(self, task: str) -> None:
        if getattr(self, "_chooser", None):
            return
        chooser = QProcess(self)
        chooser.setProgram("zenity")
        chooser.setArguments(["--file-selection", "--multiple", "--separator=\n", "--title=Files for the task"])

        def done(code: int, _status) -> None:
            self._chooser = None
            paths = [p for p in bytes(chooser.readAllStandardOutput()).decode().split("\n") if p.strip()] if code == 0 else []
            chooser.deleteLater()
            self.come_back()
            if paths:
                threading.Thread(target=self._send, args=(task, paths), daemon=True).start()

        chooser.finished.connect(done)
        self._chooser = chooser
        self.step_aside()
        chooser.start()

    def _send(self, task: str, paths: list) -> None:
        added, errors = 0, []
        for path in paths:
            name = os.path.basename(path)
            try:
                if os.path.getsize(path) > LARGEST:
                    errors.append(f"{name} is larger than {LARGEST // (1024 * 1024)} MB")
                    continue
                with open(path, "rb") as f:
                    data = base64.b64encode(f.read()).decode()
            except OSError as e:
                errors.append(f"{name}: {e.strerror}")
                continue
            kind = mimetypes.guess_type(name)[0]
            status, text = core_call("POST", f"/tasks/{task}/attachments",
                                     json.dumps({"filename": name, "data": data, **({"mediaType": kind} if kind else {})}), timeout=120)
            if status == 200:
                added += 1
            else:
                errors.append(f"{name}: {text[:120]}")
        self.bridge.attached.emit(json.dumps({"task": task, "added": added, "error": "; ".join(errors)}))

    def open_file(self, sha: str, filename: str) -> None:
        """A kept file, opened in its application: unsealed into the runtime directory, which only the user reads."""
        def run() -> None:
            status, text = core_call("GET", f"/files/{sha}", timeout=60)
            if status != 200:
                log(f"tasks: could not open {filename}: {text[:120]}")
                return
            folder = os.path.join(OPENED, re.sub(r"[^0-9a-f]", "", sha)[:16])
            os.makedirs(folder, mode=0o700, exist_ok=True)
            os.chmod(OPENED, 0o700)
            path = os.path.join(folder, os.path.basename(filename) or "file")
            with open(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "wb") as f:
                f.write(base64.b64decode(json.loads(text)["data"]))
            subprocess.Popen(["xdg-open", path], start_new_session=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        threading.Thread(target=run, daemon=True).start()

    def opened(self) -> None:
        self.desktop.bar.changed()

    def closed(self) -> None:
        self.desktop.bar.changed()
