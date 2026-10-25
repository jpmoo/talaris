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
import threading
from urllib.parse import parse_qs, urlsplit

from PySide6.QtCore import QObject, QRunnable, QThreadPool, QUrl, Signal, Slot
from PySide6.QtGui import QDesktopServices

import hypr

SOCKET = os.environ.get(
    "TALARIS_SOCKET",
    os.path.join(os.environ.get("XDG_RUNTIME_DIR", f"/run/user/{os.getuid()}"), "talaris.sock"),
)


class _UnixConnection(http.client.HTTPConnection):
    def __init__(self, timeout: float = 10) -> None:
        super().__init__("talaris", timeout=timeout)

    def connect(self) -> None:
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect(SOCKET)


def call(method: str, path: str, body: str | None = None, timeout: float = 10) -> tuple[int, str]:
    conn = _UnixConnection(timeout)
    try:
        data = body.encode("utf-8") if body is not None else None
        conn.request(method, path, body=data, headers={"content-type": "application/json"} if data else {})
        res = conn.getresponse()
        return res.status, res.read().decode("utf-8", "replace")
    except OSError as e:
        return 503, json.dumps({"error": f"the core is not answering ({e.strerror or e})"})
    finally:
        conn.close()


#: Answers `/people/find?q=` — the calendar's address books, which live in this
#: process and not the core's — when the calendar has set it (surfaces.py).
find_people = None
#: Answers `/contacts/cards?q=&keys=` — address-book cards, by search or by "book/uid" — likewise.
find_cards = None


def local_call(method: str, path: str, body: str | None, timeout: float | None = None) -> tuple[int, str]:
    """A page's call to the core, or the one question this process answers itself."""
    if method == "GET" and path.startswith("/contacts/cards?"):
        query = parse_qs(urlsplit(path).query)
        keys = [k for k in query.get("keys", [""])[0].split(",") if k]
        return 200, json.dumps(find_cards(query.get("q", [""])[0], keys) if find_cards else [])
    if method == "GET" and path.startswith("/people/find?"):
        q = parse_qs(urlsplit(path).query).get("q", [""])[0]
        return 200, json.dumps(find_people(q) if find_people else [])
    return call(method, path, body, **({"timeout": timeout} if timeout else {}))


class _Call(QRunnable):
    def __init__(self, bridge: "Bridge", rid: int, method: str, path: str, body: str | None) -> None:
        super().__init__()
        self.bridge, self.rid, self.method, self.path, self.body = bridge, rid, method, path, body

    def run(self) -> None:
        status, text = local_call(self.method, self.path, self.body)
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
    #: Pushed to the page: play your leaving, then call `left`.
    leave = Signal()
    #: Pushed to a drawer's page: open on this — `{canvas}` or `{page}`.
    show = Signal(str)
    #: Files chosen and kept in a project (`attachToProject`): {project, files: [{name, path}], error}.
    projectFiles = Signal(str)

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
    def grow(self) -> None:
        """A drawer's expand button: the desktop, or back to a drawer. A panel's: a window, or a panel again."""
        if hasattr(self.owner, "grow"):
            self.owner.grow()

    @Slot()
    def drawn(self) -> None:
        """A panel's page has drawn itself, arrived: the pointer given back now, to a page that can answer it."""
        if hasattr(self.owner, "pointer_back"):
            self.owner.pointer_back()
        else:
            hypr.refocus_pointer()

    @Slot()
    def closeWindow(self) -> None:  # noqa: N802 — called from the page by this name
        """A panel made a window: its close button."""
        if hasattr(self.owner, "close_window"):
            self.owner.close_window()

    @Slot()
    def left(self) -> None:
        """The page has played its leaving; the surface can go to its handle now."""
        self.owner.left()

    @Slot()
    def activity(self) -> None:
        """The page saw input. The idle timeout counts from the last of these."""
        self.owner.touched()

    @Slot(str, str, str)
    def openPlace(self, kind: str, project: str, where: str) -> None:  # noqa: N802 — called from the page by this name
        """A page or a canvas a mention points at, opened where it lives — in its project."""
        desktop = getattr(self.owner, "desktop", None)
        if desktop and kind in ("page", "canvas"):
            # Asked from a panel (Tasks, New): it goes, so what opens is seen.
            if getattr(self.owner, "NAME", "") not in ("canvas", "writing") and hasattr(self.owner, "file_away"):
                self.owner.file_away()
            desktop.open_place(kind, project, where)

    @Slot(str)
    def openPerson(self, entity: str) -> None:  # noqa: N802 — called from the page by this name
        """A person clicked anywhere: their entry in People. Asked from another panel, that one goes."""
        desktop = getattr(self.owner, "desktop", None)
        if not desktop or not entity:
            return
        if getattr(self.owner, "NAME", "") not in ("canvas", "writing", "people") and hasattr(self.owner, "file_away"):
            self.owner.file_away()
        desktop.people.show_person(entity)

    @Slot(str, str)
    def openProjectFile(self, project: str, path: str) -> None:  # noqa: N802 — called from the page by this name
        """A file a page or a note links (`Files/…`), opened in its application."""
        from files import open_project_file
        open_project_file(project, path)

    @Slot(str)
    def attachToProject(self, project: str) -> None:  # noqa: N802 — called from the page by this name
        """Files chosen in the desktop's chooser and kept in the project's `Files/`; the page hears where."""
        from files import choose_files, send_project_files
        if not hasattr(self.owner, "step_aside"):
            return

        def chosen(paths: list) -> None:
            if paths:
                threading.Thread(target=lambda: self.projectFiles.emit(json.dumps({"project": project, **send_project_files(project, paths)})), daemon=True).start()
        choose_files(self.owner, "Attach files", chosen)

    @Slot(str)
    def openUrl(self, url: str) -> None:  # noqa: N802 — called from the page by this name
        """A web link from a page opens in the browser — never inside a drawer, never anything but http(s)."""
        if url.startswith(("http://", "https://")):
            QDesktopServices.openUrl(QUrl(url))

    @Slot(str)
    def openPath(self, path: str) -> None:  # noqa: N802 — called from the page by this name
        """
        Open a file Talaris made — an export — in its default application.
        Only something inside the projects root: a page cannot name any file
        on the machine and have it opened.
        """
        root = os.path.realpath(os.path.expanduser(os.environ.get("TALARIS_PROJECTS", "~/Projects")))
        real = os.path.realpath(path)
        if real.startswith(root + os.sep) and os.path.isfile(real):
            QDesktopServices.openUrl(QUrl.fromLocalFile(real))

    @Slot(result=str)
    def current(self) -> str:
        return json.dumps(self.owner.describe())
