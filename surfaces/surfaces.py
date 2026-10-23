# SPDX-License-Identifier: GPL-3.0-only
# Copyright (c) 2026 Jeff Moore
"""
Talaris's surfaces: everything on the screen that is not an application window.

So far, the drawers. Each drawer belongs to one edge and is in one of three
modes:

- **filed** — a handle on its edge, above the windows, so it can be pulled out.
- **out** — on an empty workspace, the canvas *is* the desktop: full size, on
  the `bottom` layer, below where windows would be.
- **pulled** — out over the windows, on the `overlay` layer.

**Every way back exists from the first line.** The first spike pulled a surface
over the screen with no way back but a terminal it had covered, and ended in a
restart. So a pulled drawer goes back on its compositor bind, on Escape, on a
command, and by itself after a stretch with no input.

Run through `talaris-surfaces`, which sets the layer-shell integration for the
whole process — that has to happen before Qt starts.
"""

from __future__ import annotations

import json
import mimetypes
import os
import sys

from PySide6.QtCore import QByteArray, QBuffer, QIODevice, QObject, QTimer, QUrl, Qt
from PySide6.QtGui import QColor
from PySide6.QtNetwork import QLocalServer, QLocalSocket
from PySide6.QtWebChannel import QWebChannel
from PySide6.QtWebEngineCore import (
    QWebEnginePage,
    QWebEngineProfile,
    QWebEngineUrlRequestJob,
    QWebEngineUrlScheme,
    QWebEngineUrlSchemeHandler,
)
from PySide6.QtWebEngineWidgets import QWebEngineView
from PySide6.QtWidgets import QApplication

import hypr
from core import Bridge, call
from layershell import (
    BOTTOM,
    EDGE_ANCHOR,
    EDGE_SPAN,
    KEYBOARD_NONE,
    KEYBOARD_ON_DEMAND,
    OVERLAY,
    TOP,
    LayerSurface,
    Placement,
)

HERE = os.path.dirname(os.path.abspath(__file__))
UI = os.path.join(HERE, "ui")
LAUNCHER = os.path.join(HERE, "talaris-surfaces")
SCHEME = b"talaris-ui"
CONTROL = f"talaris-surfaces-{os.getuid()}"
CONFIG = os.path.join(
    (os.environ.get("XDG_CONFIG_HOME") or "").strip() or os.path.expanduser("~/.config"), "talaris", "config.json"
)

DEFAULTS = {
    "theme": {"mode": "dark", "accent": "#c98a5b", "font": "Barlow Semi Condensed", "motion": "slide"},
    "drawers": {
        # 0.58 + 0.40 leaves a gap: both pulled at once never overlap.
        "canvas": {"edge": "left", "size": 0.58, "outWhenEmpty": True},
        "writing": {"edge": "right", "size": 0.4, "outWhenEmpty": False},
    },
    # A pulled drawer files itself after this long with no input. Idle, not a
    # deadline: a fixed timeout fired mid-scroll in the spike.
    "idleSeconds": 45,
}

# Small on purpose: the handle says "something is here", not "look at me".
HANDLE = (10, 56)


def log(*parts: object) -> None:
    print("talaris-surfaces:", *parts, file=sys.stderr, flush=True)


def load_config() -> dict:
    config = json.loads(json.dumps(DEFAULTS))
    try:
        with open(CONFIG, encoding="utf-8") as f:
            mine = json.load(f)
    except (OSError, ValueError):
        return config
    for key, value in mine.items():
        if isinstance(value, dict) and isinstance(config.get(key), dict):
            for k, v in value.items():
                if isinstance(v, dict) and isinstance(config[key].get(k), dict):
                    config[key][k].update(v)
                else:
                    config[key][k] = v
        else:
            config[key] = value
    return config


def register_scheme() -> None:
    """Before any profile exists, or Qt quietly gives a scheme with no permissions."""
    scheme = QWebEngineUrlScheme(SCHEME)
    scheme.setSyntax(QWebEngineUrlScheme.Syntax.Host)
    scheme.setFlags(
        QWebEngineUrlScheme.Flag.SecureScheme
        | QWebEngineUrlScheme.Flag.LocalAccessAllowed
        | QWebEngineUrlScheme.Flag.CorsEnabled
        | QWebEngineUrlScheme.Flag.ContentSecurityPolicyIgnored
    )
    QWebEngineUrlScheme.registerScheme(scheme)


class Files(QWebEngineUrlSchemeHandler):
    """The pages' own files, and nothing else — every one a GET, so no request body is ever touched."""

    def requestStarted(self, job: QWebEngineUrlRequestJob) -> None:  # noqa: N802 — Qt's name
        rel = job.requestUrl().path().lstrip("/") or "drawer.html"
        full = os.path.realpath(os.path.join(UI, rel))
        if not full.startswith(os.path.realpath(UI) + os.sep) or not os.path.isfile(full):
            job.fail(QWebEngineUrlRequestJob.Error.UrlNotFound)
            return
        with open(full, "rb") as f:
            data = f.read()
        mime = mimetypes.guess_type(full)[0] or "application/octet-stream"
        buf = QBuffer(job)
        buf.setData(QByteArray(data))
        buf.open(QIODevice.OpenModeFlag.ReadOnly)
        job.reply(mime.encode("ascii"), buf)


class Page(QWebEnginePage):
    """A page whose warnings and errors reach the journal — no other way to see them on a layer surface."""

    def __init__(self, profile: QWebEngineProfile, parent: QObject, name: str) -> None:
        super().__init__(profile, parent)
        self.name = name

    def javaScriptConsoleMessage(self, level, message, line, source):  # noqa: N802 — Qt's name
        if level != QWebEnginePage.JavaScriptConsoleMessageLevel.InfoMessageLevel:
            log(f"{self.name} page: {message} ({source.rsplit('/', 1)[-1]}:{line})")


class Drawer(QObject):
    def __init__(self, name: str, config: dict, profile: QWebEngineProfile, desktop: "Desktop") -> None:
        super().__init__(desktop)
        self.name = name
        self.desktop = desktop
        self.edge = config["edge"]
        self.size = float(config["size"])
        self.out_when_empty = bool(config.get("outWhenEmpty"))
        self.pulled = False
        self.mode = ""
        self.leaving = False

        self.view = QWebEngineView()
        self.view.setWindowTitle(f"talaris-{name}")
        self.view.setAttribute(Qt.WidgetAttribute.WA_TranslucentBackground)
        page = Page(profile, self.view, name)
        page.setBackgroundColor(QColor(0, 0, 0, 0))
        self.view.setPage(page)
        self.bridge = Bridge(self, self)
        self.channel = QWebChannel(self)
        self.channel.registerObject("bridge", self.bridge)
        page.setWebChannel(self.channel)
        page.loadFinished.connect(lambda ok: log(f"{name} page: {'loaded' if ok else 'FAILED to load'}"))
        self.view.setUrl(QUrl(f"talaris-ui://ui/drawer.html?drawer={name}"))
        self.surface = LayerSurface(self.view, f"talaris-{name}")

        self.idle = QTimer(self)
        self.idle.setSingleShot(True)
        self.idle.timeout.connect(self._idle)

    def describe(self) -> dict:
        return {
            "drawer": self.name,
            "edge": self.edge,
            "mode": self.mode,
            "project": self.desktop.project,
            "theme": self.desktop.config["theme"],
        }

    def _placement(self, mode: str) -> Placement:
        screen = QApplication.primaryScreen().geometry()
        anchor = EDGE_ANCHOR[self.edge]
        across = self.edge in ("left", "right")
        if mode == "filed":
            w, h = HANDLE if across else HANDLE[::-1]
            # Anchored to its edge alone, the compositor centers it along that edge.
            return Placement(TOP, anchor, w, h, KEYBOARD_NONE)
        w = int(screen.width() * self.size) if across else screen.width()
        h = screen.height() if across else int(screen.height() * self.size)
        return Placement(BOTTOM if mode == "out" else OVERLAY, anchor | EDGE_SPAN[self.edge], w, h, KEYBOARD_ON_DEMAND)

    #: How long a page has to finish leaving before the surface goes anyway.
    #: A page that never answers must not leave a drawer stuck over the screen.
    LEAVE_LIMIT_MS = 800

    def settle(self) -> None:
        mode = "pulled" if self.pulled else "out" if (self.out_when_empty and self.desktop.empty) else "filed"
        if mode == self.mode or self.leaving:
            return
        # Going back to a handle: the page plays its leaving first, then says
        # so, and only then does the surface move. Moving it first is what made
        # closing a snap rather than a slide.
        if mode == "filed" and self.mode in ("pulled", "out"):
            self.leaving = True
            self.idle.stop()
            self.bridge.leave.emit()
            QTimer.singleShot(self.LEAVE_LIMIT_MS, lambda: self.left(late=True))
            return
        self._become(mode)

    def left(self, late: bool = False) -> None:
        """The page has finished leaving — or ran out of time to."""
        if not self.leaving:
            return
        if late:
            log(f"{self.name}: the page did not finish leaving in time; filed anyway")
        self.leaving = False
        mode = "pulled" if self.pulled else "out" if (self.out_when_empty and self.desktop.empty) else "filed"
        self._become(mode)

    def _become(self, mode: str) -> None:
        if mode == self.mode:
            return
        self.mode = mode
        self.surface.apply(self._placement(mode))
        self.bridge.state.emit(json.dumps(self.describe()))
        if mode == "pulled":
            self.touched()
        else:
            self.idle.stop()
        log(f"{self.name}: {mode}")

    def toggle(self) -> None:
        if self.leaving:
            return
        self.pulled = not self.pulled
        self.settle()

    def file_away(self) -> None:
        if self.pulled:
            self.pulled = False
            self.settle()

    def touched(self) -> None:
        if self.pulled:
            self.idle.start(int(self.desktop.config["idleSeconds"]) * 1000)

    def _idle(self) -> None:
        log(f"{self.name}: filed after {self.desktop.config['idleSeconds']}s with no input")
        self.file_away()


class Desktop(QObject):
    def __init__(self, app: QApplication) -> None:
        super().__init__(app)
        self.config = load_config()
        self.empty = hypr.workspace_is_empty()
        self.project = self._home()
        profile = QWebEngineProfile("talaris", self)
        profile.setPersistentStoragePath(
            os.path.join((os.environ.get("XDG_DATA_HOME") or "").strip() or os.path.expanduser("~/.local/share"),
                         "talaris", "web")
        )
        self.files = Files(self)
        profile.installUrlSchemeHandler(SCHEME, self.files)
        self.profile = profile
        self.drawers = {
            name: Drawer(name, cfg, profile, self) for name, cfg in self.config["drawers"].items()
        }
        for d in self.drawers.values():
            d.settle()

        self.events = hypr.Events(self)
        self.events.changed.connect(self._changed)
        self.events.reloaded.connect(self._bind)
        self._bind()

        self.control = QLocalServer(self)
        QLocalServer.removeServer(CONTROL)
        self.control.listen(CONTROL)
        self.control.newConnection.connect(self._command)

    def _home(self) -> dict:
        status, text = call("GET", "/projects")
        try:
            projects = json.loads(text) if status == 200 else []
        except ValueError:
            projects = []
        home = next((p for p in projects if p.get("home")), None)
        return home or {"id": "", "code": "", "name": "Home"}

    def _changed(self) -> None:
        empty = hypr.workspace_is_empty()
        if empty != self.empty:
            self.empty = empty
            for d in self.drawers.values():
                d.settle()

    def _bind(self) -> None:
        """Compositor binds, so the way back works whatever is covering the screen."""
        for name, keys in (("canvas", "SUPER ALT, C"), ("writing", "SUPER ALT, W")):
            if name in self.drawers:
                hypr.bind(keys, f"{LAUNCHER} --toggle {name}")
        hypr.bind("SUPER ALT, ESCAPE", f"{LAUNCHER} --file-all")

    def unbind(self) -> None:
        for keys in ("SUPER ALT, C", "SUPER ALT, W", "SUPER ALT, ESCAPE"):
            hypr.unbind(keys)

    def _command(self) -> None:
        conn = self.control.nextPendingConnection()

        def read() -> None:
            line = bytes(conn.readAll()).decode("utf-8", "replace").strip()
            verb, _, arg = line.partition(" ")
            if verb == "toggle" and arg in self.drawers:
                self.drawers[arg].toggle()
            elif verb == "file-all":
                for d in self.drawers.values():
                    d.file_away()
            elif verb == "quit":
                QApplication.quit()
            conn.write(b"ok\n")
            conn.flush()
            conn.disconnectFromServer()

        conn.readyRead.connect(read)


def send(command: str) -> int:
    """`talaris-surfaces --toggle canvas`: tell the running process."""
    sock = QLocalSocket()
    sock.connectToServer(CONTROL)
    if not sock.waitForConnected(1000):
        print("talaris-surfaces is not running", file=sys.stderr)
        return 1
    sock.write(command.encode() + b"\n")
    sock.flush()
    sock.waitForReadyRead(1000)
    return 0


def main() -> int:
    args = sys.argv[1:]
    if args[:1] == ["--toggle"] and len(args) == 2:
        return send(f"toggle {args[1]}")
    if args[:1] == ["--file-all"]:
        return send("file-all")
    if args[:1] == ["--quit"]:
        return send("quit")

    register_scheme()
    app = QApplication(sys.argv)
    app.setApplicationName("talaris-surfaces")
    app.setQuitOnLastWindowClosed(False)
    desktop = Desktop(app)
    import signal

    signal.signal(signal.SIGTERM, lambda *_: QTimer.singleShot(0, app.quit))
    signal.signal(signal.SIGINT, lambda *_: QTimer.singleShot(0, app.quit))
    # Signal handlers run between Python bytecodes; a ticking timer gives them some.
    tick = QTimer(app)
    tick.timeout.connect(lambda: None)
    tick.start(250)
    app.aboutToQuit.connect(desktop.unbind)
    log("up:", ", ".join(f"{n} on the {d.edge}" for n, d in desktop.drawers.items()))
    return app.exec()


if __name__ == "__main__":
    sys.exit(main())
