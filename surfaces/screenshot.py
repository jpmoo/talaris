# SPDX-License-Identifier: GPL-3.0-only
# Copyright (c) 2026 Jeff Moore
"""
Screenshots, on Print: a panel to choose what to take — a region drawn, a
region scrolled through, a window, the whole screen — and then the shot, in
the same panel, to look over (panned and zoomed), mark up, save, copy, or let
go of.

**The panel** (`ui/shot.html`) is a panel like the others (overlay.py), and so
comes and goes as Settings, Look, says for it ("Screenshot"). It asks for a
kind (`choose`), goes, and comes back with the shot once there is one.

**Taking one** is grim's, as everything else that reads the screen here is.
For a region or a window, the screen is taken first and held still: the
choosing is done on that picture (`Picker`, drawn by Qt itself rather than a
page, so it is up the moment the panel has gone), and the shot is cut from it
— so what was on the screen when Print was pressed is what is taken, menus and
all. The whole screen is the focused monitor's.

**Scrolling**, as Shottr does it: a region drawn as above, then an arrow
(↑ ↓ ← →) for the way to go, and Talaris scrolls it itself (`VirtualWheel`, a mouse wheel of its own made
through uinput, with the pointer put over the region), a few notches at a
time, grabbing it after each and joining the grabs where they overlap
(`Stitcher`; sideways, each grab turned on its side first); it stops at the
end of the page, or at Enter. A small strip says how far it has got
(`ScrollStrip`), clear of the region so that it is never in it.

**Kept** in `~/Pictures/Screenshots` (or the pictures folder XDG names), as
"Screenshot <date> at <time>.png"; **copied** as a PNG (wl-copy), so the
clipboard's history has it too.
"""

from __future__ import annotations

import base64
import fcntl
import io
import json
import os
import struct
import subprocess
import threading
import time

from PIL import Image, ImageChops, ImageStat
from PySide6.QtCore import QObject, QPoint, QPointF, QRect, QRectF, Qt, QTimer, Signal, Slot
from PySide6.QtGui import QColor, QCursor, QFont, QFontMetrics, QImage, QPainter, QPainterPath, QPen, QPixmap
from PySide6.QtWebEngineCore import QWebEngineProfile
from PySide6.QtWidgets import QApplication, QWidget

import hypr
from core import Bridge
from layershell import ANCHOR_BOTTOM, ANCHOR_LEFT, ANCHOR_RIGHT, ANCHOR_TOP, KEYBOARD_EXCLUSIVE, OVERLAY, LayerSurface, Placement, full_screen
from overlay import Overlay
from views import log, zoom

#: The key, bound by Talaris itself (surfaces._bind).
KEYS = ", Print"
#: A scrolling shot no taller (or wider) in all than this.
SCROLL_TALLEST = 40_000


def pictures_dir() -> str:
    """Where shots are kept: the pictures folder XDG names, else ~/Pictures; its Screenshots."""
    base = ""
    try:
        base = subprocess.run(["xdg-user-dir", "PICTURES"], capture_output=True, text=True, timeout=3).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        pass
    if not base or base == os.path.expanduser("~"):
        base = os.path.expanduser("~/Pictures")
    return os.path.join(base, "Screenshots")


def focused_monitor() -> dict:
    try:
        monitors = json.loads(hypr.ask("j/monitors") or "[]")
    except ValueError:
        monitors = []
    return next((m for m in monitors if m.get("focused")), monitors[0] if monitors else {})


def grab(geometry: str = "", output: str = "") -> Image.Image:
    """The screen as it is now: a region (grim's `x,y wxh`, in the compositor's units), or a monitor."""
    cmd = ["grim", "-t", "ppm"] + (["-g", geometry] if geometry else []) + (["-o", output] if output else []) + ["-"]
    shot = subprocess.run(cmd, capture_output=True, timeout=10, check=True)
    img = Image.open(io.BytesIO(shot.stdout))
    img.load()
    return img.convert("RGB")


def png_bytes(img: Image.Image) -> bytes:
    out = io.BytesIO()
    img.save(out, "PNG", optimize=False, compress_level=3)
    return out.getvalue()


class Look:
    """Talaris's colors and typeface, as the pages have them (ui/tokens.css) and the tips do (tip.py)."""

    def __init__(self) -> None:
        import config
        from tip import COLORS, _load_fonts
        _load_fonts()
        try:
            theme = config.load_config()["theme"]
        except Exception:  # noqa: BLE001 — the default look, whatever happens
            theme = {}
        surface, frame, text = COLORS.get(theme.get("mode"), COLORS["dark"])
        self.surface, self.frame, self.text = QColor(surface), QColor(frame), QColor(text)
        self.accent = QColor(theme.get("accent") or "#7aa2f7")
        # Words on the accent: dark on a light one, light on a dark one, as the pages' primary buttons have them.
        self.on_accent = QColor("#16181a") if self.accent.lightness() > 140 else QColor("#ffffff")
        self.family = theme.get("font") or "Barlow Semi Condensed"

    def font(self, px: int, weight: int = 500) -> QFont:
        f = QFont(self.family)
        f.setPixelSize(zoom(px))
        f.setWeight(QFont.Weight(weight))
        return f


class ActiveLook:
    """
    Every window drawn as the one in use, while a shot is taken.

    Choosing what to take puts the keyboard in Talaris's panel, and so every
    window — the one being worked in too — is drawn as one not in use: its
    border the plain line, and as see-through as hyprland.conf makes windows
    not in use (decoration:inactive_opacity). In a shot, what is in it should
    look as it does when it is used, however many windows that is: so for the
    grab, the inactive look is made the active one, and put back after.
    """

    def __init__(self, desktop) -> None:
        self.desktop = desktop
        self.held: dict | None = None

    @staticmethod
    def _option(name: str, key: str):
        try:
            return json.loads(hypr.ask(f"j/getoption {name}") or "{}").get(key)
        except ValueError:
            return None

    def on(self) -> None:
        if self.held is not None:
            return
        self.held = {"opacity": self._option("decoration:inactive_opacity", "float"), "dim": self._option("decoration:dim_inactive", "int")}
        hypr.keyword("decoration:inactive_opacity", f"{self._option('decoration:active_opacity', 'float') or 1:g}")
        if self.held["dim"]:
            hypr.keyword("decoration:dim_inactive", "0")
        self.desktop.style_compositor(all_active=True)

    def off(self) -> None:
        if self.held is None:
            return
        held, self.held = self.held, None
        if held["opacity"] is not None:
            hypr.keyword("decoration:inactive_opacity", f"{held['opacity']:g}")
        if held["dim"]:
            hypr.keyword("decoration:dim_inactive", str(held["dim"]))
        self.desktop.style_compositor()


#: How long Hyprland is given to draw the windows again, as the one in use, before the screen is taken.
REDRAWN_MS = 120


# ------------------------------------------------------------------ choosing, on the screen held still


class Picker(QWidget):
    """
    The screen as it was, over the screen: a region drawn on it, or a window
    pointed at. Says `picked` with what was chosen, in this widget's units, or
    `cancelled` (Escape, or a press off any window when choosing one).
    """

    picked = Signal(QRect)
    cancelled = Signal()

    def __init__(self, frozen: Image.Image, mode: str, windows: list[QRect]) -> None:
        super().__init__()
        self.mode = mode
        self.windows = windows
        self.pixmap = QPixmap.fromImage(QImage(frozen.tobytes("raw", "RGB"), frozen.width, frozen.height, frozen.width * 3, QImage.Format.Format_RGB888).copy())
        self.start: QPoint | None = None
        self.end: QPoint | None = None
        self.hover: QRect | None = None
        self.look = Look()
        self.accent = self.look.accent
        self.setMouseTracking(True)
        self.setCursor(QCursor(Qt.CursorShape.CrossCursor if mode != "window" else Qt.CursorShape.PointingHandCursor))
        self.setFocusPolicy(Qt.FocusPolicy.StrongFocus)

    def chosen(self) -> QRect | None:
        if self.mode == "window":
            return self.hover
        if self.start is None or self.end is None:
            return None
        return QRect(self.start, self.end).normalized()

    def paintEvent(self, _event) -> None:  # noqa: N802 — Qt's name
        p = QPainter(self)
        p.setRenderHint(QPainter.RenderHint.SmoothPixmapTransform)
        p.drawPixmap(self.rect(), self.pixmap)
        veil = QPainterPath()
        veil.addRect(QRectF(self.rect()))
        pick = self.chosen()
        if pick and pick.width() > 0 and pick.height() > 0:
            hole = QPainterPath()
            hole.addRect(QRectF(pick))
            veil = veil.subtracted(hole)
        p.fillPath(veil, QColor(0, 0, 0, 115))
        if pick and pick.width() > 0 and pick.height() > 0:
            p.setPen(QPen(self.accent, 2))
            p.drawRect(QRectF(pick).adjusted(-1, -1, 1, 1))
            # Its size, in the pixels the shot will have.
            f = self.pixmap.width() / max(1, self.width())
            label = f"{round(pick.width() * f)} × {round(pick.height() * f)}"
            p.setFont(self.look.font(12))
            box = p.fontMetrics().boundingRect(label).adjusted(-7, -3, 7, 3)
            box.moveTopLeft(QPoint(pick.left(), pick.bottom() + 6 if pick.bottom() + 6 + box.height() < self.height() else pick.top() - box.height() - 6))
            p.fillRect(box, QColor(0, 0, 0, 190))
            p.setPen(QColor("white"))
            p.drawText(box, Qt.AlignmentFlag.AlignCenter, label)
        # What to do, once, at the top.
        hint = {"window": "Click a window · Esc to cancel", "scroll": "Drag over what will scroll · Esc to cancel"}.get(self.mode, "Drag a region · Esc to cancel")
        p.setRenderHint(QPainter.RenderHint.Antialiasing)
        p.setFont(self.look.font(14))
        box = p.fontMetrics().boundingRect(hint).adjusted(-zoom(12), -zoom(6), zoom(12), zoom(6))
        box.moveCenter(QPoint(self.width() // 2, zoom(30)))
        p.setPen(QPen(self.look.frame, 1))
        p.setBrush(self.look.surface)
        p.drawRoundedRect(QRectF(box), zoom(8), zoom(8))
        p.setPen(self.look.text)
        p.drawText(box, Qt.AlignmentFlag.AlignCenter, hint)

    def _window_at(self, at: QPoint) -> QRect | None:
        return next((r for r in self.windows if r.contains(at)), None)

    def mousePressEvent(self, e) -> None:  # noqa: N802 — Qt's name
        if e.button() != Qt.MouseButton.LeftButton:
            self.cancelled.emit()
            return
        if self.mode == "window":
            r = self._window_at(e.position().toPoint())
            if r is not None:
                self.picked.emit(r)
            else:
                self.cancelled.emit()
            return
        self.start = self.end = e.position().toPoint()
        self.update()

    def mouseMoveEvent(self, e) -> None:  # noqa: N802 — Qt's name
        at = e.position().toPoint()
        if self.mode == "window":
            r = self._window_at(at)
            if r != self.hover:
                self.hover = r
                self.update()
        elif self.start is not None:
            self.end = at
            self.update()

    def mouseReleaseEvent(self, e) -> None:  # noqa: N802 — Qt's name
        if self.mode == "window" or self.start is None:
            return
        self.end = e.position().toPoint()
        r = self.chosen()
        if r and r.width() > 4 and r.height() > 4:
            self.picked.emit(r)
        else:
            self.start = self.end = None
            self.update()

    def keyPressEvent(self, e) -> None:  # noqa: N802 — Qt's name
        if e.key() == Qt.Key.Key_Escape:
            self.cancelled.emit()


# ------------------------------------------------------------------ scrolling


class Stitcher:
    """
    Grabs of one region, as it is scrolled — down, or up from the bottom of a
    page, or both by turns — joined into one tall picture.

    Each grab is laid over the one before at every distance it might have
    moved, either way, and the distance where they differ least is taken —
    differ least, not match: at a fractional scale (1.25, say) a scroll seldom
    moves the page by whole pixels of the screen, so the same line of text is
    drawn a little differently each time, and no row is ever the same twice.
    The comparing is done by Pillow, on a narrow copy of each grab (its columns
    averaged, which is all a vertical move needs): every distance on a copy
    half as tall, then the best few again at full height. The way it moved
    last is tried first, and the other only if that does not fit.

    What a page keeps in place — a header or a footer that does not scroll —
    is what barely changed at the same height, and is left out of the
    comparing. Each grab is placed on the page by how far it has moved in all
    (above the first, when scrolled up), and what it newly shows kept, with a
    margin of rows already had; at the end the page is laid down in order,
    later over earlier, without the header and the footer — the fewest of
    their rows seen, a blank line beside one being unmoving once by chance —
    and those put back once, at the top and at the bottom.

    A grab that barely changed adds nothing (a cursor blinking is not a
    scroll); one with nowhere it fits — scrolled further than its own height
    since the last — adds nothing either, and says so (`lost`): scrolled
    back a little, the next one joins again.
    """

    #: Rows kept beyond what each grab newly shows: room for a header or footer first taken as larger than it is.
    MARGIN = 96
    #: How wide the copies compared are.
    NARROW = 160
    #: A row that differs from itself by no more than this (of 255, on average) has not changed.
    STILL = 2.0
    #: Two placings this alike are the same picture (mean difference of 255); and must be this much better than not moving.
    FITS = 7.0

    def __init__(self) -> None:
        self.first: Image.Image | None = None
        self.strips: list[tuple[int, int, Image.Image]] = []   # (offset of the grab, its first row kept, those rows)
        self.prev: Image.Image | None = None    # the last joined grab, narrow and grey
        self.last: Image.Image | None = None
        self.offset = 0                         # where the last joined grab's top is on the page; the first's is 0
        self.highest = self.lowest = 0          # the least and most of those
        self.head: int | None = None
        self.foot: int | None = None
        self.way = 1                            # the way it moved last: 1 down the page, -1 up

    @property
    def height(self) -> int:
        return (self.lowest - self.highest + self.first.height) if self.first is not None else 0

    def _narrow(self, img: Image.Image) -> Image.Image:
        return img.convert("L").resize((self.NARROW, img.height), Image.BOX)

    @staticmethod
    def _differ(a: Image.Image, b: Image.Image) -> float:
        return ImageStat.Stat(ImageChops.difference(a, b)).mean[0]

    @staticmethod
    def _rows(diff: Image.Image) -> list[int]:
        """Each row's average difference."""
        return list(diff.resize((1, diff.height), Image.BOX).tobytes())

    def _cost(self, a: Image.Image, b: Image.Image, lo: int, hi: int, moved: int) -> float:
        """How unalike `a` and `b` are with `b` moved up by `moved` rows (down, when less than 0), between rows lo and hi."""
        w = self.NARROW
        if moved > 0:
            return self._differ(a.crop((0, lo + moved, w, hi)), b.crop((0, lo, w, hi - moved)))
        return self._differ(a.crop((0, lo, w, hi + moved)), b.crop((0, lo - moved, w, hi)))

    def _best(self, prev: Image.Image, g: Image.Image, lo: int, hi: int, least: int, way: int) -> tuple[float, int] | None:
        """The distance, one way, where the two differ least: every distance at half height, the best three again at full."""
        h = g.height
        ph, gh = prev.resize((self.NARROW, h // 2), Image.BOX), g.resize((self.NARROW, h // 2), Image.BOX)
        lo2, hi2, least2 = lo // 2, hi // 2, least // 2
        tried = sorted((self._cost(ph, gh, lo2, hi2, way * m), m) for m in range(1, hi2 - lo2 - least2 + 1))
        best = None
        for _, m2 in tried[:3]:
            for m in range(max(1, m2 * 2 - 2), m2 * 2 + 3):
                if hi - lo - m < least:
                    continue
                cost = self._cost(prev, g, lo, hi, way * m)
                if best is None or cost < best[0]:
                    best = (cost, way * m)
        return best

    def add(self, img: Image.Image) -> bool | str:
        """True: joined. False: nothing new. "lost": changed, and nowhere to join it."""
        g = self._narrow(img)
        w, h = img.size
        if self.first is None or self.first.size != img.size:
            self.__init__()
            self.first, self.prev, self.last = img, g, img
            self.strips.append((0, 0, img))
            return True
        prev = self.prev
        rows = self._rows(ImageChops.difference(prev, g))
        still = [r <= self.STILL for r in rows]
        if sum(still) > h * 0.9:
            return False
        third = h // 3
        head = 0
        while head < third and still[head]:
            head += 1
        foot = 0
        while foot < third and still[h - 1 - foot]:
            foot += 1
        lo, hi = head, h - foot
        least = max(16, (hi - lo) // 6)   # overlap needed for a placing to count
        if hi - lo < least * 2:
            return "lost"
        not_moving = self._differ(prev.crop((0, lo, self.NARROW, hi)), g.crop((0, lo, self.NARROW, hi)))
        fits = lambda b: b is not None and b[0] <= self.FITS and b[0] <= not_moving * 0.6  # noqa: E731
        best = self._best(prev, g, lo, hi, least, self.way)
        if not fits(best):
            other = self._best(prev, g, lo, hi, least, -self.way)
            best = other if fits(other) and (best is None or other[0] < best[0]) else None
        if best is None:
            return "lost"
        moved = best[1]
        self.way = 1 if moved > 0 else -1
        self.offset += moved
        self.highest, self.lowest = min(self.highest, self.offset), max(self.lowest, self.offset)
        self.head = head if self.head is None else min(self.head, head)
        self.foot = foot if self.foot is None else min(self.foot, foot)
        if moved > 0:
            # Down the page: what is new is at the bottom of this grab.
            top = max(lo, hi - moved - self.MARGIN)
            self.strips.append((self.offset, top, img.crop((0, top, w, h))))
        else:
            # Up the page: at its top.
            bottom = min(hi, lo - moved + self.MARGIN)
            self.strips.append((self.offset, 0, img.crop((0, 0, w, bottom))))
        self.prev, self.last = g, img
        return True

    def image(self) -> Image.Image | None:
        if self.first is None:
            return None
        w, h = self.first.size
        head, foot = self.head or 0, self.foot or 0
        out = Image.new("RGB", (w, self.height))
        for offset, top, strip in self.strips:
            # The page's own rows of it, without the header's and the footer's, at its place.
            a, b = max(top, head), min(top + strip.height, h - foot)
            if b > a:
                out.paste(strip.crop((0, a - top, w, b - top)), (0, offset - self.highest + a))
        if head:
            out.paste(self.last.crop((0, 0, w, head)), (0, 0))
        if foot:
            out.paste(self.last.crop((0, h - foot, w, h)), (0, out.height - foot))
        return out


class VirtualWheel:
    """
    A mouse wheel of Talaris's own, for scrolling a region by itself: a
    device made through the kernel's uinput (this account may write to
    /dev/uinput), turned a notch at a time. Its turns go where the pointer
    is, as a real wheel's do. Wayland gives a program no other way to scroll
    another's window, and nothing needs installing for this one.
    """

    UI_SET_EVBIT, UI_SET_KEYBIT, UI_SET_RELBIT = 0x40045564, 0x40045565, 0x40045566
    UI_DEV_SETUP, UI_DEV_CREATE, UI_DEV_DESTROY = 0x405C5503, 0x5501, 0x5502
    EV_SYN, EV_KEY, EV_REL = 0, 1, 2
    REL_X, REL_Y, REL_HWHEEL, REL_WHEEL, REL_WHEEL_HI_RES, REL_HWHEEL_HI_RES = 0, 1, 6, 8, 11, 12
    BTN_LEFT = 0x110

    def __init__(self) -> None:
        self.fd = os.open("/dev/uinput", os.O_WRONLY | os.O_NONBLOCK)
        try:
            for ev in (self.EV_KEY, self.EV_REL):
                fcntl.ioctl(self.fd, self.UI_SET_EVBIT, ev)
            # A button too: a device with one is a pointer to libinput, and its wheel is heard.
            fcntl.ioctl(self.fd, self.UI_SET_KEYBIT, self.BTN_LEFT)
            for rel in (self.REL_X, self.REL_Y, self.REL_HWHEEL, self.REL_WHEEL, self.REL_WHEEL_HI_RES, self.REL_HWHEEL_HI_RES):
                fcntl.ioctl(self.fd, self.UI_SET_RELBIT, rel)
            fcntl.ioctl(self.fd, self.UI_DEV_SETUP, struct.pack("HHHH80sI", 0x03, 0x7461, 0x6c61, 1, b"Talaris screenshot scroll", 0))
            fcntl.ioctl(self.fd, self.UI_DEV_CREATE)
        except OSError:
            os.close(self.fd)
            raise

    def _event(self, kind: int, code: int, value: int) -> None:
        os.write(self.fd, struct.pack("llHHi", 0, 0, kind, code, value))

    def turn(self, notches: int, across: bool = False) -> None:
        """
        Turned by so many notches, a notch at a time, toward the end of the page
        when more than 0 (down it, or across it to the right), back when less.
        """
        one = 1 if notches > 0 else -1
        # A wheel's turn down is less than 0 to the kernel, and its tilt right more.
        wheel, fine, sign = (self.REL_HWHEEL, self.REL_HWHEEL_HI_RES, one) if across else (self.REL_WHEEL, self.REL_WHEEL_HI_RES, -one)
        for _ in range(abs(notches)):
            self._event(self.EV_REL, wheel, sign)
            self._event(self.EV_REL, fine, sign * 120)
            self._event(self.EV_SYN, 0, 0)
            time.sleep(0.012)

    def close(self) -> None:
        try:
            fcntl.ioctl(self.fd, self.UI_DEV_DESTROY)
        except OSError:
            pass
        os.close(self.fd)


class ScrollStrip(QWidget):
    """
    A small strip, clear of the region being scrolled: how tall the shot is
    so far (or that it lost its place), Done and Cancel. In Talaris's colors
    and typeface; its corners see-through, painted as the tips are (tip.py).
    """

    done = Signal()
    cancelled = Signal()
    #: An arrow: which way Talaris is to scroll it — "down", "up", "left" or "right".
    way = Signal(str)
    FIRST = "Which way to scroll? ↑ ↓ ← → · Esc to cancel"
    #: The longest things it says, which its width is made for.
    SAYS = (FIRST, "Scrolling right… 99999 pixels · Enter to stop · Esc to cancel", "Talaris cannot scroll it here · Esc to cancel")

    def __init__(self) -> None:
        super().__init__()
        self.look = Look()
        self.said = self.FIRST
        self.setWindowFlag(Qt.WindowType.FramelessWindowHint)
        self.setAttribute(Qt.WidgetAttribute.WA_TranslucentBackground)
        self.setAutoFillBackground(False)
        self.setFocusPolicy(Qt.FocusPolicy.StrongFocus)
        self.buttons: dict[str, QRect] = {}
        self.font_ = self.look.font(13, 400)
        self.button_font = self.look.font(13, 500)

    def size_wanted(self) -> tuple[int, int]:
        fm, bm = QFontMetrics(self.font_), QFontMetrics(self.button_font)
        words = max(fm.horizontalAdvance(t) for t in self.SAYS)
        buttons = sum(bm.horizontalAdvance(t) + zoom(24) for t in ("Done", "Cancel")) + zoom(8)
        return words + buttons + zoom(14 + 16 + 10), max(fm.height(), bm.height()) + zoom(24)

    def say(self, text: str) -> None:
        self.said = text
        self.update()

    def paintEvent(self, _event) -> None:  # noqa: N802 — Qt's name
        p = QPainter(self)
        p.setRenderHint(QPainter.RenderHint.Antialiasing)
        look = self.look
        p.setPen(QPen(look.frame, 1))
        p.setBrush(look.surface)
        p.drawRoundedRect(QRectF(self.rect()).adjusted(0.5, 0.5, -0.5, -0.5), zoom(10), zoom(10))
        self.buttons = {}
        p.setFont(self.button_font)
        bm = p.fontMetrics()
        right = self.width() - zoom(8)
        pad = zoom(6)
        for key, label, primary in (("done", "Done", True), ("cancel", "Cancel", False)):
            w = bm.horizontalAdvance(label) + zoom(24)
            r = QRect(right - w, pad, w, self.height() - 2 * pad)
            right -= w + zoom(8)
            p.setPen(Qt.PenStyle.NoPen if primary else QPen(look.frame, 1))
            p.setBrush(look.accent if primary else Qt.BrushStyle.NoBrush)
            p.drawRoundedRect(QRectF(r).adjusted(0.5, 0.5, -0.5, -0.5), zoom(6), zoom(6))
            p.setPen(look.on_accent if primary else look.text)
            p.drawText(r, Qt.AlignmentFlag.AlignCenter, label)
            self.buttons[key] = r
        p.setFont(self.font_)
        p.setPen(look.text)
        p.drawText(QRect(zoom(14), 0, right - zoom(14), self.height()), Qt.AlignmentFlag.AlignVCenter | Qt.AlignmentFlag.AlignLeft, self.said)

    def mousePressEvent(self, e) -> None:  # noqa: N802 — Qt's name
        at = e.position().toPoint()
        if self.buttons.get("done", QRect()).contains(at):
            self.done.emit()
        elif self.buttons.get("cancel", QRect()).contains(at):
            self.cancelled.emit()

    def keyPressEvent(self, e) -> None:  # noqa: N802 — Qt's name
        if e.key() in (Qt.Key.Key_Return, Qt.Key.Key_Enter):
            self.done.emit()
        elif e.key() == Qt.Key.Key_Escape:
            self.cancelled.emit()
        else:
            way = {Qt.Key.Key_Down: "down", Qt.Key.Key_PageDown: "down", Qt.Key.Key_Up: "up", Qt.Key.Key_PageUp: "up",
                   Qt.Key.Key_Left: "left", Qt.Key.Key_Right: "right"}.get(e.key())
            if way:
                self.way.emit(way)


# ------------------------------------------------------------------ the panel


class ShotBridge(Bridge):
    #: How a scrolling capture stands, from its thread: {frames, height}.
    progress = Signal(str)

    @Slot(str)
    def choose(self, kind: str) -> None:
        self.owner.choose(kind)

    @Slot(result=str)
    def image(self) -> str:
        """The shot, as the page draws it: {url, width, height}; {} when there is none."""
        return json.dumps(self.owner.image_for_page())

    @Slot(str, result=str)
    def save(self, data_url: str) -> str:
        """Kept as drawn (marks and all): {path} or {error}."""
        return json.dumps(self.owner.save(data_url))

    @Slot(str, result=str)
    def copy(self, data_url: str) -> str:
        return json.dumps(self.owner.copy(data_url))

    @Slot()
    def discard(self) -> None:
        self.owner.discard()

    @Slot()
    def showFolder(self) -> None:  # noqa: N802 — called from the page by this name
        self.owner.show_folder()


class Shot(Overlay):
    NAME = "shot"
    TITLE = "Screenshot"
    LAZY = True
    # Answered by keys (R, S, W, F; Escape): the keyboard is its own while it is up.
    KEYBOARD = KEYBOARD_EXCLUSIVE

    def __init__(self, profile: QWebEngineProfile, desktop) -> None:
        super().__init__(profile, desktop, "talaris-ui://ui/shot.html", ShotBridge(None, None))
        self.bridge.owner = self
        self.bridge.setParent(self)
        #: "choose", "busy" (taking it), or "view" (the shot, to look over).
        self.state = "choose"
        self.shot: Image.Image | None = None
        self.picker: QWidget | None = None
        self.picker_surface: LayerSurface | None = None
        self.strip: ScrollStrip | None = None
        self.strip_surface: LayerSurface | None = None
        self.scrolling = False
        self.stitcher: Stitcher | None = None
        self.bridge.progress.connect(self._progress)
        self.look = ActiveLook(desktop)

    def describe(self) -> dict:
        return {**super().describe(), "mode": self.state}

    def grow(self) -> None:
        """A sheet, not a window."""

    # ---- Print

    def start(self) -> None:
        """Print: the choice — or, while a shot is up to look over, that shot brought forward."""
        if self.state == "busy":
            return
        if self.state == "view" and self.shot is not None:
            if not self.up:
                self.open()
            return
        self.state = "choose"
        if self.up:
            self.bridge.state.emit(json.dumps(self.describe()))
        else:
            self.open()

    def choose(self, kind: str) -> None:
        if kind not in ("region", "scroll", "window", "full"):
            return
        self.state = "busy"
        self.file_away()
        # The panel and the dim gone from the screen before it is taken.
        QTimer.singleShot(450, lambda: self._take(kind))

    def _take(self, kind: str) -> None:
        # Whatever is taken, as it looks in use (ActiveLook): drawn so first, then taken.
        self.look.on()
        QTimer.singleShot(REDRAWN_MS, lambda: self._grab(kind))

    def _grab(self, kind: str) -> None:
        mon = focused_monitor()
        try:
            shot = grab(output=mon.get("name", ""))
        except (OSError, subprocess.SubprocessError, ValueError) as e:
            self.look.off()
            log(f"shot: the screen could not be taken ({e})")
            self.state = "choose"
            return
        # Scrolling is taken again and again while it is scrolled: it keeps the look until it is done.
        if kind != "scroll":
            self.look.off()
        if kind == "full":
            self._show(shot)
            return
        self._pick(shot, kind, mon)

    def _pick(self, frozen: Image.Image, kind: str, mon: dict) -> None:
        screen = QApplication.primaryScreen().geometry()
        # This widget's units against the compositor's (for grim and Hyprland's windows) and the shot's pixels.
        logical_w = mon.get("width", frozen.width) / (mon.get("scale") or 1)
        to_comp = logical_w / max(1, screen.width())
        windows = self._windows(mon, to_comp) if kind == "window" else []
        picker = Picker(frozen, "window" if kind == "window" else kind, windows)
        self.picker = picker
        self.picker_surface = LayerSurface(picker, "talaris-shot-pick", nudge=True)
        self.picker_surface.apply(full_screen(KEYBOARD_EXCLUSIVE, OVERLAY))
        picker.setFocus()

        def gone() -> None:
            picker.hide()
            picker.deleteLater()
            self.picker = None
            self.picker_surface = None

        def picked(r: QRect) -> None:
            gone()
            f = frozen.width / max(1, picker.width())
            box = (max(0, round(r.left() * f)), max(0, round(r.top() * f)), min(frozen.width, round((r.right() + 1) * f)), min(frozen.height, round((r.bottom() + 1) * f)))
            if kind == "scroll":
                geometry = f"{round(mon.get('x', 0) + r.left() * to_comp)},{round(mon.get('y', 0) + r.top() * to_comp)} {max(1, round(r.width() * to_comp))}x{max(1, round(r.height() * to_comp))}"
                self._scroll(geometry, r, screen)
            else:
                self._show(frozen.crop(box))

        def cancelled() -> None:
            gone()
            self.look.off()
            self.state = "choose"
            log("shot: cancelled")

        picker.picked.connect(picked)
        picker.cancelled.connect(cancelled)

    @staticmethod
    def _windows(mon: dict, to_comp: float) -> list[QRect]:
        """The windows on the monitor's desktop in front, in the picker's units, the floating and most recently used first."""
        try:
            clients = json.loads(hypr.ask("j/clients") or "[]")
        except ValueError:
            return []
        shown = mon.get("activeWorkspace", {}).get("id")
        special = mon.get("specialWorkspace", {}).get("id")
        here = [c for c in clients if c.get("mapped", True) and not c.get("hidden") and c.get("monitor") == mon.get("id")
                and (c.get("pinned") or c.get("workspace", {}).get("id") in (shown, special))]
        here.sort(key=lambda c: (not c.get("pinned"), not c.get("floating"), c.get("focusHistoryID", 99)))
        out = []
        for c in here:
            (x, y), (w, h) = c.get("at", [0, 0]), c.get("size", [0, 0])
            out.append(QRect(round((x - mon.get("x", 0)) / to_comp), round((y - mon.get("y", 0)) / to_comp), round(w / to_comp), round(h / to_comp)))
        return out

    # ---- scrolling

    def _scroll(self, geometry: str, r: QRect, screen: QRect) -> None:
        self.stitcher = Stitcher()
        self.scrolling = True
        #: The way it is to be scrolled, once an arrow says: "down", "up", "left" or "right"; "" until then.
        self.way = ""
        strip = ScrollStrip()
        self.strip = strip
        width, height = strip.size_wanted()
        # Clear of the region: above it at the top of the screen, unless the region reaches there.
        at_top = r.top() > height + 24
        anchors = (ANCHOR_TOP if at_top else ANCHOR_BOTTOM)
        margins = ((screen.width() - width) // 2, 12, 0, 0) if at_top else ((screen.width() - width) // 2, 0, 0, 12)
        self.strip_surface = LayerSurface(strip, "talaris-shot-scroll", nudge=False)
        self.strip_surface.apply(Placement(OVERLAY, anchors | ANCHOR_LEFT, width, height, KEYBOARD_EXCLUSIVE, exclusive=-1, margins=margins))
        strip.setFocus()
        strip.done.connect(lambda: self._scroll_end(True))
        strip.cancelled.connect(lambda: self._scroll_end(False))
        strip.way.connect(self._scroll_way)
        log(f"shot: scrolling capture of {geometry}")
        at, size = geometry.split(" ")
        x, y = (int(v) for v in at.split(","))
        w, h = (int(v) for v in size.split("x"))
        middle = (x + w // 2, y + h // 2)

        def run() -> None:
            # Nothing taken until an arrow says which way: what was on the screen as it was chosen
            # (the picker fading as it goes, say) must not be taken for the page.
            while self.scrolling and not self.way:
                time.sleep(0.05)
            if not self.scrolling:
                return
            across = self.way in ("left", "right")
            toward = 1 if self.way in ("down", "right") else -1
            # Sideways, each grab is turned on its side: the joining knows only up and down the page.
            turned = (lambda img: img.transpose(Image.Transpose.TRANSPOSE)) if across else (lambda img: img)
            st = self.stitcher
            try:
                wheel = VirtualWheel()
            except OSError as e:
                log(f"shot: no wheel of its own ({e})")
                self.bridge.progress.emit(json.dumps({"say": "Talaris cannot scroll it here · Esc to cancel"}))
                return
            back_to = None
            try:
                back_to = json.loads(hypr.ask("j/cursorpos") or "{}")
            except ValueError:
                pass
            try:
                # Heard by the compositor as a new pointer a moment after it is made; the pointer put
                # over the region, where its turns go.
                time.sleep(0.4)
                hypr.ask(f"/dispatch movecursor {middle[0]} {middle[1]}")
                # The first grab once the region holds still (a hover the pointer set off, the picker's fade).
                was = None
                for _ in range(20):
                    if not self.scrolling or st is None:
                        return
                    img = turned(grab(geometry=geometry))
                    if was is not None and was.size == img.size and st._differ(st._narrow(was), st._narrow(img)) < 0.5:
                        break
                    was = img
                    time.sleep(0.1)
                st.add(img)
                self.bridge.progress.emit(json.dumps({"height": st.height}))
                notches, unmoved = 3, 0
                while self.scrolling:
                    hypr.ask(f"/dispatch movecursor {middle[0]} {middle[1]}")
                    wheel.turn(toward * notches, across)
                    # A page scrolls smoothly: settled before it is taken.
                    time.sleep(0.35)
                    img = turned(grab(geometry=geometry))
                    if not self.scrolling:
                        break
                    before = st.offset
                    joined = st.add(img)
                    if joined == "lost":
                        # Too far to see where it joins: back a little, and smaller steps from now on.
                        wheel.turn(-toward * max(1, notches // 2), across)
                        notches = max(1, notches // 2)
                        time.sleep(0.3)
                    elif joined:
                        unmoved = 0
                        moved = abs(st.offset - before)
                        # About half the region a step: always overlapping, and not more steps than need be.
                        if moved:
                            notches = max(1, min(15, round(notches * (img.height * 0.5) / moved)))
                        self.bridge.progress.emit(json.dumps({"height": st.height}))
                    else:
                        # Turned, and nothing moved: the end of the page (twice, to be sure of it).
                        unmoved += 1
                        if unmoved >= 2:
                            self.bridge.progress.emit(json.dumps({"end": True}))
                            break
                    if st.height >= SCROLL_TALLEST:
                        self.bridge.progress.emit(json.dumps({"full": True}))
                        break
            except (OSError, subprocess.SubprocessError, ValueError) as e:
                log(f"shot: scrolling stopped ({e})")
                self.bridge.progress.emit(json.dumps({"end": True}))
            finally:
                wheel.close()
                if back_to and "x" in back_to:
                    hypr.ask(f"/dispatch movecursor {back_to['x']} {back_to['y']}")
        self._scroller = threading.Thread(target=run, daemon=True)
        self._scroller.start()

    def _scroll_way(self, way: str) -> None:
        """An arrow: scrolled that way by Talaris itself, until the end of the page or Enter. Chosen once."""
        if self.scrolling and not self.way and way in ("down", "up", "left", "right"):
            self.way = way
            log(f"shot: scrolling it {way}")
            if self.strip is not None:
                self.strip.say(f"Scrolling {way}… · Enter to stop · Esc to cancel")

    def _progress(self, text: str) -> None:
        said = json.loads(text)
        if said.get("full") or said.get("end"):
            self._scroll_end(True)
        elif self.strip is None:
            return
        elif said.get("say"):
            self.strip.say(said["say"])
        elif "height" in said:
            # Its length along the way it goes: down or up, how tall; sideways, how wide.
            self.strip.say(f"Scrolling {self.way}… {said['height']} pixels · Enter to stop · Esc to cancel")

    def _scroll_end(self, keep: bool) -> None:
        if not self.scrolling:
            return
        self.scrolling = False
        if getattr(self, "_scroller", None) is not None:
            self._scroller.join(timeout=3)
        if self.strip is not None:
            self.strip.hide()
            self.strip.deleteLater()
        self.strip = self.strip_surface = None
        self.look.off()
        img = self.stitcher.image() if keep and self.stitcher is not None else None
        if img is not None and self.way in ("left", "right"):
            img = img.transpose(Image.Transpose.TRANSPOSE)
        self.stitcher = None
        if img is None:
            self.state = "choose"
            log("shot: scrolling capture cancelled")
            return
        self._show(img)

    # ---- the shot

    def _show(self, img: Image.Image) -> None:
        self.shot = img
        self.state = "view"
        log(f"shot: taken, {img.width}×{img.height}")
        self.open()

    def image_for_page(self) -> dict:
        if self.shot is None:
            return {}
        url = "data:image/png;base64," + base64.b64encode(png_bytes(self.shot)).decode("ascii")
        return {"url": url, "width": self.shot.width, "height": self.shot.height}

    @staticmethod
    def _decode(data_url: str) -> bytes:
        head, _, body = data_url.partition(",")
        if not head.startswith("data:image/png;base64"):
            raise ValueError("not a PNG")
        return base64.b64decode(body)

    def save(self, data_url: str) -> dict:
        try:
            data = self._decode(data_url)
            folder = pictures_dir()
            os.makedirs(folder, exist_ok=True)
            name = time.strftime("Screenshot %Y-%m-%d at %H.%M.%S")
            path = os.path.join(folder, f"{name}.png")
            n = 2
            while os.path.exists(path):
                path = os.path.join(folder, f"{name} ({n}).png")
                n += 1
            with open(path, "wb") as f:
                f.write(data)
        except (OSError, ValueError) as e:
            return {"error": str(e)}
        log(f"shot: kept as {path}")
        self.saved_path = path
        return {"path": path, "name": os.path.basename(path)}

    def copy(self, data_url: str) -> dict:
        try:
            data = self._decode(data_url)
            # wl-copy stays to hand the picture over; it is not waited on.
            proc = subprocess.Popen(["wl-copy", "--type", "image/png"], stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
            proc.stdin.write(data)
            proc.stdin.close()
        except (OSError, ValueError) as e:
            return {"error": str(e)}
        log("shot: copied")
        return {"ok": True}

    def discard(self) -> None:
        """Closed, kept or not: the shot let go of, and the next Print a new one."""
        self.shot = None
        self.state = "choose"
        self.file_away()

    def show_folder(self) -> None:
        path = getattr(self, "saved_path", "") or pictures_dir()
        try:
            subprocess.Popen(["xdg-open", os.path.dirname(path) if os.path.isfile(path) else path], start_new_session=True,
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except OSError:
            pass

    def closed(self) -> None:
        # Put away while choosing (Escape, a press on the dim): nothing to keep.
        if self.state == "choose":
            self.shot = None
