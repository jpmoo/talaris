# SPDX-License-Identifier: GPL-3.0-only
# Copyright (c) 2026 Jeff Moore
"""
Talaris's core, over its Unix socket — and the bridge a page uses to reach it.

**Pages reach the core through a `QWebChannel`, not through a URL scheme.**
Talaria carried request bodies through its scheme handler and found that
`QWebEngineUrlRequestJob.requestBody()` segfaults in this PySide6 build, so
every write rode in a header instead — and a header refuses anything outside
Latin-1, so every curly quote failed before it left the page. A channel call
is a plain function call with a string argument: no size limit, no encoding
games. The scheme only serves the pages' own files, which are all GETs.
"""

from __future__ import annotations

import http.client
import json
import os
import socket

from PySide6.QtCore import QObject, QRunnable, QThreadPool, Signal, Slot

SOCKET = os.environ.get(
    "TALARIS_SOCKET",
    os.path.join(os.environ.get("XDG_RUNTIME_DIR", f"/run/user/{os.getuid()}"), "talaris.sock"),
)


class _UnixConnection(http.client.HTTPConnection):
    def __init__(self) -> None:
        super().__init__("talaris", timeout=10)

    def connect(self) -> None:
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(10)
        self.sock.connect(SOCKET)


def call(method: str, path: str, body: str | None = None) -> tuple[int, str]:
    conn = _UnixConnection()
    try:
        data = body.encode("utf-8") if body is not None else None
        conn.request(method, path, body=data, headers={"content-type": "application/json"} if data else {})
        res = conn.getresponse()
        return res.status, res.read().decode("utf-8", "replace")
    except OSError as e:
        return 503, json.dumps({"error": f"the core is not answering ({e.strerror or e})"})
    finally:
        conn.close()


class _Call(QRunnable):
    def __init__(self, bridge: "Bridge", rid: int, method: str, path: str, body: str | None) -> None:
        super().__init__()
        self.bridge, self.rid, self.method, self.path, self.body = bridge, rid, method, path, body

    def run(self) -> None:
        status, text = call(self.method, self.path, self.body)
        self.bridge.replied.emit(self.rid, status, text)


class Bridge(QObject):
    """
    What a page may ask of the process that holds it.

    Core calls run on a worker and come back as `replied`, so a slow answer
    never stops the surface drawing — the same reason Talaria moved its reads
    off the GUI thread. The rest are the surface's own verbs.
    """

    replied = Signal(int, int, str)
    #: Pushed to the page: its mode and its project.
    state = Signal(str)

    def __init__(self, owner, parent: QObject | None = None) -> None:
        super().__init__(parent)
        self.owner = owner
        self._pool = QThreadPool(self)
        self._pool.setMaxThreadCount(2)

    @Slot(int, str, str, str)
    def request(self, rid: int, method: str, path: str, body: str) -> None:
        self._pool.start(_Call(self, rid, method.upper(), path, body if body else None))

    @Slot()
    def toggle(self) -> None:
        self.owner.toggle()

    @Slot()
    def file(self) -> None:
        """Escape, from the page: put it back."""
        self.owner.file_away()

    @Slot()
    def activity(self) -> None:
        """The page saw input. The idle timeout counts from the last of these."""
        self.owner.touched()

    @Slot(result=str)
    def current(self) -> str:
        return json.dumps(self.owner.describe())
