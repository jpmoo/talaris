# SPDX-License-Identifier: GPL-3.0-only
# Copyright (c) 2026 Jeff Moore
"""
Clipboard history, after Notchnik's: each copy watched for, read and handed to
the core (packages/core/src/clipboard.ts, sealed there), and a clip put back on
the clipboard when it is chosen from the bar's list.

What is on the clipboard is read as Notchnik reads the pasteboard: files first
(`text/uri-list`, or GNOME's own list), then a picture, then words. `wl-paste
--watch` says when it changed, one line each time.

**What a password manager marks as secret is never kept** — KeePassXC and the
others offer `x-kde-passwordManagerHint` beside the password, and a copy that
offers it is passed over before anything of it is read.

A clip put back is not copied again: the change that follows is ours, and is
let go (Notchnik's `lastChangeCount`). Which clip is on the clipboard now is
known (`current`), so the list can mark it; one removed while it is there is
taken off the clipboard too, or the next change would bring it back.
"""

from __future__ import annotations

import base64
import json
import mimetypes
import os
import shutil
import subprocess
import threading
import time
from urllib.parse import quote, unquote, urlsplit

from PySide6.QtCore import QObject, QProcess, QTimer, Signal

import core
from views import log

#: Offered beside a copy that is a secret (KDE's name; KeePassXC, KeePass and others use it).
SECRET_TYPES = ("x-kde-passwordManagerHint",)
#: Words longer than this are not kept; nor a picture larger.
MOST_TEXT = 1_000_000
MOST_PICTURE = 25 * 1024 * 1024
#: How long a change after one of ours is taken to be ours.
OURS_S = 1.5
TEXT_TYPES = ("text/plain;charset=utf-8", "UTF8_STRING", "text/plain", "TEXT", "STRING")


def _paste(mime: str, limit: int) -> bytes | None:
    try:
        out = subprocess.run(["wl-paste", "--no-newline", "--type", mime], capture_output=True, timeout=4)
    except (OSError, subprocess.TimeoutExpired):
        return None
    if out.returncode != 0 or len(out.stdout) > limit:
        return None
    return out.stdout


def _paths(uris: str) -> list[str]:
    """`file://` URIs, one a line (a `#` line a comment; GNOME's list starts with copy or cut), as paths."""
    out = []
    for line in uris.splitlines():
        line = line.strip()
        if line.startswith("file://"):
            path = unquote(urlsplit(line).path)
            if path:
                out.append(path)
    return out


def read_clipboard() -> dict | None:
    """What is on the clipboard now, as a clip for the core; None for nothing to keep (nothing, a secret, too large)."""
    try:
        listed = subprocess.run(["wl-paste", "--list-types"], capture_output=True, text=True, timeout=3)
    except (OSError, subprocess.TimeoutExpired):
        return None
    types = [t.strip() for t in listed.stdout.splitlines() if t.strip()] if listed.returncode == 0 else []
    if not types:
        return None
    if any(t in SECRET_TYPES for t in types):
        log("clipboard: a copy marked secret, not kept")
        return None
    for kind in ("text/uri-list", "x-special/gnome-copied-files"):
        if kind in types:
            data = _paste(kind, MOST_TEXT)
            paths = _paths(data.decode("utf-8", "replace")) if data else []
            if paths:
                return {"kind": "files" if len(paths) > 1 else "file", "paths": paths}
    pictures = [t for t in types if t.startswith("image/")]
    if pictures:
        mime = "image/png" if "image/png" in pictures else pictures[0]
        data = _paste(mime, MOST_PICTURE)
        if data:
            return {"kind": "image", "image": base64.b64encode(data).decode("ascii"), "mime": mime}
    for mime in TEXT_TYPES:
        if mime in types:
            data = _paste(mime, MOST_TEXT)
            text = data.decode("utf-8", "replace") if data else ""
            if text.strip():
                return {"kind": "text", "text": text}
            break
    return None


def picture(path: str) -> tuple[bytes, str] | None:
    """`/clipboard/<id>/picture` from the core: the bytes and their type, as they are (not text)."""
    conn = core._UnixConnection(10)
    try:
        conn.request("GET", path)
        res = conn.getresponse()
        data = res.read()
        return (data, res.getheader("content-type") or "image/png") if res.status == 200 else None
    except OSError:
        return None
    finally:
        conn.close()


class Clipboard(QObject):
    #: A clip kept, gone, pinned, or put back: the list, if it is out, read again.
    changed = Signal()
    _kept = Signal(str)

    def __init__(self, desktop) -> None:
        super().__init__(desktop)
        self.desktop = desktop
        #: The clip on the clipboard now, as far as is known; "" when it is something not kept.
        self.current = ""
        self._ours_until = 0.0
        self._busy = False
        self._again = False
        self.watch: QProcess | None = None
        self._soon = QTimer(self)
        self._soon.setSingleShot(True)
        self._soon.setInterval(120)
        self._soon.timeout.connect(self._read)
        self._kept.connect(self._was_kept)
        self.apply()

    def settings(self) -> dict:
        return self.desktop.config.get("clipboard", {})

    def apply(self) -> None:
        """Watching, or not, as Settings has it; the history trimmed to what it keeps."""
        on = bool(self.settings().get("enabled", True)) and shutil.which("wl-paste") is not None
        if on and self.watch is None:
            self.watch = QProcess(self)
            self.watch.setProcessChannelMode(QProcess.ProcessChannelMode.ForwardedErrorChannel)
            self.watch.readyReadStandardOutput.connect(self._changed)
            self.watch.finished.connect(self._ended)
            self.watch.start("wl-paste", ["--watch", "echo", "x"])
            log("clipboard: watching")
        elif not on and self.watch is not None:
            w, self.watch = self.watch, None
            w.finished.disconnect(self._ended)
            w.kill()
            log("clipboard: not watching")

    def keep(self) -> int:
        return int(self.settings().get("keep", 50))

    def stop(self) -> None:
        if self.watch is not None:
            self.watch.finished.disconnect(self._ended)
            self.watch.kill()
            self.watch = None

    def _ended(self, *_args) -> None:
        """`wl-paste` gone (the compositor restarted, say): started again a moment later."""
        self.watch = None
        log("clipboard: the watch ended; again in 3s")
        QTimer.singleShot(3000, self.apply)

    def _changed(self) -> None:
        if self.watch is not None:
            self.watch.readAllStandardOutput()
        if time.monotonic() < self._ours_until:
            return
        self._soon.start()

    def _read(self) -> None:
        # One reading at a time; a change during one is read after it.
        if self._busy:
            self._again = True
            return
        self._busy = True
        keep = self.keep()

        def job() -> None:
            got = read_clipboard()
            if got is None:
                self._kept.emit("")
                return
            data, why = core.ask_json("POST", f"/clipboard?keep={keep}", json.dumps(got), timeout=20)
            if why:
                log(f"clipboard: not kept ({why[:80]})")
            self._kept.emit((data or {}).get("clip", {}).get("id", "") if data else "")
        threading.Thread(target=job, daemon=True).start()

    def _was_kept(self, cid: str) -> None:
        self._busy = False
        self.current = cid
        self.changed.emit()
        if self._again:
            self._again = False
            self._read()

    def put_back(self, cid: str) -> bool:
        """A clip on the clipboard again, as it was copied: words, a picture, a file or several."""
        clip = next((c for c in core.get_json("/clipboard", []) or [] if c.get("id") == cid), None)
        if not clip:
            return False
        if clip.get("kind") == "image":
            got = picture(f"/clipboard/{cid}/picture")
            if not got:
                return False
            data, mime = got
        elif clip.get("kind") in ("file", "files"):
            data = "".join(f"file://{quote(p)}\r\n" for p in clip.get("paths", [])).encode("utf-8")
            mime = "text/uri-list"
        else:
            data, mime = clip.get("text", "").encode("utf-8"), "text/plain;charset=utf-8"
        self._ours_until = time.monotonic() + OURS_S
        try:
            subprocess.Popen(["wl-copy", "--type", mime], stdin=subprocess.PIPE, stdout=subprocess.DEVNULL,
                             stderr=subprocess.DEVNULL, start_new_session=True).communicate(data, timeout=4)
        except (OSError, subprocess.TimeoutExpired):
            return False
        self.current = cid
        self.changed.emit()
        return True

    def copy_secret(self, text: str) -> None:
        """Words onto the clipboard that the history is not to keep (the vault's recovery key)."""
        self._ours_until = time.monotonic() + OURS_S
        self.current = ""
        try:
            subprocess.run(["wl-copy"], input=text.encode(), timeout=3, check=False)
        except (OSError, subprocess.SubprocessError):
            pass

    def removed(self, cid: str) -> None:
        """A clip gone: if it was on the clipboard, the clipboard emptied, so the next change does not bring it back."""
        if cid and cid == self.current:
            self._ours_until = time.monotonic() + OURS_S
            subprocess.run(["wl-copy", "--clear"], timeout=3, check=False)
            self.current = ""
        self.changed.emit()

    def cleared(self) -> None:
        if self.current:
            self._ours_until = time.monotonic() + OURS_S
            subprocess.run(["wl-copy", "--clear"], timeout=3, check=False)
            self.current = ""
        self.changed.emit()


def file_preview(cid: str, n: int) -> tuple[bytes, str] | None:
    """A clip's file that is a picture, for its tile: only a path the clip holds, never one a page names."""
    clip = next((c for c in core.get_json("/clipboard", []) or [] if c.get("id") == cid), None)
    paths = (clip or {}).get("paths") or []
    if not 0 <= n < len(paths):
        return None
    path = paths[n]
    mime = mimetypes.guess_type(path)[0] or ""
    if not mime.startswith("image/") or not os.path.isfile(path) or os.path.getsize(path) > MOST_PICTURE:
        return None
    with open(path, "rb") as f:
        return f.read(), mime
