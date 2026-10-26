# SPDX-License-Identifier: GPL-3.0-only
# Copyright (c) 2026 Jeff Moore
"""
Files, for every page that keeps or opens them: chosen in the desktop's own
chooser, sent to the core (a task's attachments, a project's `Files/`), and
opened in their applications — as they are where they are plain, or as a
copy, unsealed into the runtime directory only the user reads, where they are
sealed.
"""

from __future__ import annotations

import base64
import json
import mimetypes
import os
import re
import subprocess
import threading
from urllib.parse import quote

from PySide6.QtCore import QProcess

from core import call as core_call
from views import log

#: Sealed files opened, unsealed where only the user can read them and that is
#: cleared at logout: the runtime directory, which lives in memory.
OPENED = os.path.join(os.environ.get("XDG_RUNTIME_DIR", f"/run/user/{os.getuid()}"), "talaris-opened")
#: Larger than this is refused rather than read into the core whole.
LARGEST = 48 * 1024 * 1024


#: Folders not looked into when a whole folder is brought in: the machinery of programs, not anyone's files.
SKIP_DIRS = {"node_modules", "__pycache__", ".git", "venv", ".venv", "dist", "build", "target"}
#: At most this many files from one folder.
MOST_FROM_A_FOLDER = 2000


def files_under(folder: str) -> list[str]:
    """Every file in a folder and its subfolders, but hidden ones and programs' machinery, by name."""
    out: list[str] = []
    for root, dirs, files in os.walk(folder):
        dirs[:] = sorted(d for d in dirs if not d.startswith(".") and d not in SKIP_DIRS)
        for name in sorted(files):
            if name.startswith(".") or name.endswith((".tmp", "~")):
                continue
            path = os.path.join(root, name)
            if os.path.isfile(path) and not os.path.islink(path):
                out.append(path)
                if len(out) >= MOST_FROM_A_FOLDER:
                    return out
    return out


def choose_folder(overlay, title: str, chosen) -> None:
    """A folder chosen in the desktop's chooser; `chosen` hears its path, or ""."""
    if getattr(overlay, "_chooser", None):
        return
    chooser = QProcess(overlay)
    chooser.setProgram("zenity")
    chooser.setArguments(["--file-selection", "--directory", f"--title={title}"])

    def done(code: int, _status) -> None:
        overlay._chooser = None
        path = bytes(chooser.readAllStandardOutput()).decode().strip() if code == 0 else ""
        chooser.deleteLater()
        overlay.come_back()
        chosen(path)

    chooser.finished.connect(done)
    overlay._chooser = chooser
    overlay.step_aside()
    chooser.start()


def choose_files(overlay, title: str, chosen) -> None:
    """
    Files chosen in the desktop's chooser, for `overlay`, which steps aside for
    it (a layer surface over everything would sit on the chooser); `chosen`
    hears the paths, or none.
    """
    if getattr(overlay, "_chooser", None):
        return
    chooser = QProcess(overlay)
    chooser.setProgram("zenity")
    chooser.setArguments(["--file-selection", "--multiple", "--separator=\n", f"--title={title}"])

    def done(code: int, _status) -> None:
        overlay._chooser = None
        paths = [p for p in bytes(chooser.readAllStandardOutput()).decode().split("\n") if p.strip()] if code == 0 else []
        chooser.deleteLater()
        overlay.come_back()
        chosen(paths)

    chooser.finished.connect(done)
    overlay._chooser = chooser
    overlay.step_aside()
    chooser.start()


def send_files(path: str, files: list, extra: dict | None = None) -> tuple[int, list]:
    """Files read and kept by the core at `path` (a task's attachments, an entity's files): how many, and what went wrong."""
    added, errors = 0, []
    for file in files:
        name = os.path.basename(file)
        try:
            if os.path.getsize(file) > LARGEST:
                errors.append(f"{name} is larger than {LARGEST // (1024 * 1024)} MB")
                continue
            with open(file, "rb") as f:
                data = base64.b64encode(f.read()).decode()
        except OSError as e:
            errors.append(f"{name}: {e.strerror}")
            continue
        kind = mimetypes.guess_type(name)[0]
        status, text = core_call("POST", path, json.dumps({"filename": name, "data": data, **({"mediaType": kind} if kind else {}), **(extra or {})}), timeout=120)
        if status == 200:
            added += 1
        else:
            errors.append(f"{name}: {text[:120]}")
    return added, errors


def send_project_files(project: str, files: list) -> dict:
    """Files kept in a project's `Files/`: {files: [{name, path}], error}."""
    kept, errors = [], []
    for file in files:
        name = os.path.basename(file)
        try:
            if os.path.getsize(file) > LARGEST:
                errors.append(f"{name} is larger than {LARGEST // (1024 * 1024)} MB")
                continue
            with open(file, "rb") as f:
                data = base64.b64encode(f.read()).decode()
        except OSError as e:
            errors.append(f"{name}: {e.strerror}")
            continue
        status, text = core_call("POST", f"/projects/{quote(project)}/files", json.dumps({"name": name, "data": data}), timeout=120)
        if status == 200:
            kept.append(json.loads(text))
        else:
            errors.append(f"{name}: {text[:120]}")
    return {"files": kept, "error": "; ".join(errors)}


def _launch(path: str) -> None:
    subprocess.Popen(["xdg-open", path], start_new_session=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def _copy_out(tag: str, filename: str, data: bytes) -> str:
    folder = os.path.join(OPENED, re.sub(r"[^0-9A-Za-z_-]", "", tag)[:24] or "file")
    os.makedirs(folder, mode=0o700, exist_ok=True)
    os.chmod(OPENED, 0o700)
    path = os.path.join(folder, os.path.basename(filename) or "file")
    with open(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "wb") as f:
        f.write(data)
    return path


def open_kept_file(sha: str, filename: str) -> None:
    """A file kept by its hash (a task's attachment), opened in its application from a copy."""
    def run() -> None:
        status, text = core_call("GET", f"/files/{sha}", timeout=60)
        if status != 200:
            log(f"files: could not open {filename}: {text[:120]}")
            return
        _launch(_copy_out(sha[:16], filename, base64.b64decode(json.loads(text)["data"])))
    threading.Thread(target=run, daemon=True).start()


def open_project_file(project: str, path: str) -> None:
    """
    A project's file (`Files/…`), opened in its application: the file itself
    where it is plain, so what is changed there is kept; a copy where it is
    sealed, since nothing else can read it as it is.
    """
    def run() -> None:
        where = f"/projects/{quote(project)}/file?path={quote(path)}"
        status, text = core_call("GET", where, timeout=30)
        if status != 200:
            log(f"files: could not open {path}: {text[:120]}")
            return
        at = json.loads(text)
        if not at.get("sealed"):
            _launch(at["abs"])
            return
        status, text = core_call("GET", f"/projects/{quote(project)}/file/data?path={quote(path)}", timeout=60)
        if status == 200:
            _launch(_copy_out(project, path.split("/")[-1], base64.b64decode(json.loads(text)["data"])))
    threading.Thread(target=run, daemon=True).start()
