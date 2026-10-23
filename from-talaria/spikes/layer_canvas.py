"""
Spike: the Talaria canvas as a wlr-layer-shell surface, from PySide6.

Not part of the shell. It answers the first question in `../DESKTOP.md`'s
*Spikes* — can the canvas we already have draw on the bottom layer, take input,
and come up over the windows on demand — and it is kept because the answer is
in how it had to be written.

**LayerShellQt has no Python bindings**, so `Window::get(QWindow*)` is called
through ctypes and everything else is set through the Qt property system on the
object it returns. Three things had to be learned to make that work:

- Attaching one window of an ordinary process does not work for a `QWidget`:
  the widget's platform window exists before `get()` can choose its shell, and
  LayerShellQt quietly falls back to an xdg toplevel — which tiled onto a
  workspace. So the whole process runs with
  `QT_WAYLAND_SHELL_INTEGRATION=layer-shell`, which is fine for a process that
  is only the canvas.
- In that mode the integration makes its own `Window` for the surface, and a
  `get()` before the first show builds a second, orphaned one ("already has a
  shell integration"). So: show, then `get()`, then set.
- Neither the namespace nor a layer change reaches a live surface. A hide and
  show makes a new surface that reads them; the page is untouched by it.

**The way out is not optional.** The first run had no route back from the
overlay but a signal sent from a terminal — and the terminal was under the
overlay. It ended in a restart. So: the overlay drops back by itself after
`OVERLAY_SECONDS` with no input, Escape inside the page drops it, SIGUSR2 forces the bottom,
and the swap key is a compositor bind, which fires whatever is on screen.

Run with `run.sh` beside this file, never from a terminal inside a window.
"""
import ctypes
import json
import os
import signal
import sys
import time

SHELL = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "shell")
sys.path.insert(0, SHELL)

from PySide6.QtCore import QEvent, QObject, QPoint, QPointF, Qt, QTimer, QUrl
from PySide6.QtGui import QWheelEvent
from PySide6.QtWebEngineCore import QWebEnginePage, QWebEngineProfile
from PySide6.QtWebEngineWidgets import QWebEngineView
from PySide6.QtWidgets import QApplication
import shiboken6

import scheme

# Enum values from LayerShellQt's window.h.
BOTTOM, OVERLAY = 1, 3
ALL_EDGES = 1 | 2 | 4 | 8
ON_DEMAND = 2
OVERLAY_SECONDS = 20


def log(*a):
    print(time.strftime("%H:%M:%S"), "spike:", *a, file=sys.stderr, flush=True)


scheme.register_scheme()
app = QApplication(sys.argv)
log("platform", app.platformName(), "pid", os.getpid())
# Signalled by pid, not `pkill -f`: a pattern also matches the shell that runs
# it — a compositor bind's `sh -c`, an agent's shell — and kills that instead.
with open(os.path.join(os.environ["SPIKE_DIR"], "pid"), "w") as f:
    f.write(str(os.getpid()))

lsq = ctypes.CDLL(os.environ["SPIKE_LSQ"])
get = lsq._ZN12LayerShellQt6Window3getEP7QWindow
get.restype = ctypes.c_void_p
get.argtypes = [ctypes.c_void_p]

profile = QWebEngineProfile("talaria-spike", app)
profile.setPersistentStoragePath(os.path.join(os.environ["SPIKE_DIR"], "web"))
handler = scheme.DaemonScheme(app)
profile.installUrlSchemeHandler(scheme.SCHEME, handler)

view = QWebEngineView()
view.setPage(QWebEnginePage(profile, view))
view.setWindowTitle("talaria-canvas-spike")

state = {"layer": BOTTOM, "lw": None}
failsafe = QTimer(app)
failsafe.setSingleShot(True)


def apply(layer):
    state["layer"] = layer
    state["lw"].setProperty("layer", layer)
    view.hide()
    view.show()
    if layer == OVERLAY:
        failsafe.start(OVERLAY_SECONDS * 1000)
    else:
        failsafe.stop()
    log("layer", "overlay" if layer == OVERLAY else "bottom")


def configure():
    ptr = get(shiboken6.getCppPointer(view.windowHandle())[0])
    state["lw"] = lw = shiboken6.wrapInstance(ptr, QObject)
    for name, value in (("scope", "talaria-canvas"), ("anchors", ALL_EDGES),
                        ("keyboardInteractivity", ON_DEMAND), ("exclusionZone", 0)):
        lw.setProperty(name, value)
    apply(BOTTOM)


failsafe.timeout.connect(lambda: (log("failsafe"), apply(BOTTOM)))

view.setUrl(QUrl(scheme.ORIGIN + "/ui/canvas/index.html"))
view.loadFinished.connect(lambda ok: log("loadFinished", ok))
view.show()
QTimer.singleShot(300, configure)

# What the page sees, pushed into a title the probe reads. Escape asks for the
# bottom layer the same way: through the title, since the page has no channel.
PROBE = """
(() => {
  if (!window.__spike) {
    window.__spike = {down: 0, keys: 0, wheel: 0, escape: 0, last: ''};
    addEventListener('pointerdown', e => { __spike.down++; __spike.last = 'down ' + e.clientX + ',' + e.clientY; }, true);
    addEventListener('keydown', e => { __spike.keys++; __spike.last = 'key ' + e.key; if (e.key === 'Escape') __spike.escape++; }, true);
    addEventListener('wheel', () => { __spike.wheel++; }, {capture: true, passive: true});
  }
  return JSON.stringify({w: innerWidth, h: innerHeight, focus: document.hasFocus(),
    nodes: document.querySelectorAll('*').length, ...__spike});
})()
"""
seen = {"last": None, "escape": 0}


def probe():
    def got(v):
        if not v:
            return
        if v != seen["last"]:
            log("page", v)
            seen["last"] = v
            # An idle timeout, not a deadline: the first one fired in the middle
            # of a scroll, deep in a zoom, and pulled the canvas out from under
            # the hand still using it.
            if state["layer"] == OVERLAY:
                failsafe.start(OVERLAY_SECONDS * 1000)
        esc = json.loads(v).get("escape", 0)
        if esc > seen["escape"]:
            seen["escape"] = esc
            if state["layer"] == OVERLAY:
                apply(BOTTOM)
    view.page().runJavaScript(PROBE, 0, got)


poll = QTimer(app)
poll.timeout.connect(probe)
poll.start(250)


def swap():
    if state["lw"] is not None:
        apply(OVERLAY if state["layer"] == BOTTOM else BOTTOM)


def down():
    if state["lw"] is not None:
        apply(BOTTOM)


class WheelWatch(QObject):
    """
    Wheel events at the two places Qt hands them through: the platform window,
    then the web view's render widget.

    Not an application-wide filter — that segfaulted in PySide's
    `getWrapperForQObject`, asked to wrap a `QWebEngineUrlRequestJob` mid-
    construction. Python filters belong on objects you already hold.
    """

    def eventFilter(self, obj, ev):  # noqa: N802 — Qt's name
        if ev.type() == QEvent.Type.Wheel:
            log("qt wheel ->", type(obj).__name__, "angle", ev.angleDelta().toTuple(),
                "pixel", ev.pixelDelta().toTuple(), "phase", ev.phase().name,
                "synthetic" if ev.spontaneous() is False else "real")
        return False


watch = WheelWatch(app)


def watch_wheel():
    view.windowHandle().installEventFilter(watch)
    proxy = view.focusProxy()
    if proxy is not None:
        proxy.installEventFilter(watch)
    log("watching wheel on window and", type(proxy).__name__ if proxy else "no proxy")


view.loadFinished.connect(lambda _ok: QTimer.singleShot(500, watch_wheel))


def synthetic_wheel():
    """Does the page's listener hear a wheel at all, with the compositor out of it?"""
    target = view.focusProxy()
    if target is None:
        log("no focus proxy yet")
        return
    at = QPointF(400, 300)
    ev = QWheelEvent(at, view.mapToGlobal(at), QPoint(0, -40), QPoint(0, -120),
                     Qt.MouseButton.NoButton, Qt.KeyboardModifier.NoModifier,
                     Qt.ScrollPhase.NoScrollPhase, False)
    QApplication.sendEvent(target, ev)
    log("sent synthetic wheel to", type(target).__name__)


QTimer.singleShot(4000, synthetic_wheel)

# Signal handlers run between Python bytecodes; the poll timer gives them some.
signal.signal(signal.SIGUSR1, lambda *_: QTimer.singleShot(0, swap))
signal.signal(signal.SIGUSR2, lambda *_: QTimer.singleShot(0, down))
signal.signal(signal.SIGTERM, lambda *_: app.quit())

sys.exit(app.exec())
