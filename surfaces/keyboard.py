# SPDX-License-Identifier: GPL-3.0-only
# Copyright (c) 2026 Jeff Moore
"""
The on-screen keyboard, for a machine with a touchscreen.

**Borrowed, not built**: Squeekboard draws and types (it is what a Linux phone
uses), started by Talaris where it is installed and there is a touchscreen.

**Only when asked.** Squeekboard would come up by itself whenever a text field
has focus; on a machine that is also a laptop that is a keyboard over half the
screen for every search box. Talaris turns that off and asks for it instead:
a field with focus wears a small keyboard button (surface.js), and a press on
it is `show(True)`; leaving the field puts it away.

**Above everything.** Squeekboard is a layer on the `top` level, under
Talaris's panels (`overlay`), which cover the screen: a tap on the keyboard
landed on the panel — outside its box — and put the panel away. While the
keyboard is up, every panel is placed clear of it (layershell.set_keyboard),
so the keyboard is the panel's neighbor rather than under it.
"""

from __future__ import annotations

import json
import os
import shutil
import signal
import subprocess

from PySide6.QtCore import QObject, QPointF, QTimer

import hypr
import layershell
from views import log

#: The one keyboard, for the bridge's slot every page has (core.Bridge.keyboard).
current: "Keyboard | None" = None

#: Where the bar's keyboard button is on the screen (x, y, w, h, Qt's pixels), as the bar last said; None if hidden.
bar_button: tuple[float, float, float, float] | None = None


def pressed_on_button(widget, x: float, y: float) -> bool:
    """
    A press on `widget` at (x, y), its own pixels, that is really on the bar's keyboard button — under a panel, a
    drawer or the dim, which lie over the bar while they are out and took it as a press off themselves, putting
    themselves away (2026-11-14). Taken here, the keyboard is brought (or put away) and the press goes no further.
    """
    if bar_button is None or current is None:
        return False
    # The surface it is part of (the press may be on the engine's own widget, inside the view), and where that is.
    w, at = widget, None
    while w is not None and at is None:
        at = layershell.origin_of(w)
        if at is None:
            pos = w.mapToParent(QPointF(x, y).toPoint()) if w.parentWidget() is not None else None
            if pos is not None:
                x, y = pos.x(), pos.y()
            w = w.parentWidget()
    if at is None:
        return False
    bx, by, bw, bh = bar_button
    sx, sy = at[0] + x, at[1] + y
    if not (bx <= sx <= bx + bw and by <= sy <= by + bh):
        return False
    current.show(not current.up)
    return True

#: Talaris's grays (ui/tokens.css), and a raised one for the keys that change what the keyboard shows.
DARK = {"desk": "#16181a", "surface": "#222528", "raised": "#2b2f33", "line": "#3a3f44", "text": "#d5d9dc", "muted": "#868c92"}
LIGHT = {"desk": "#d9dcdf", "surface": "#eceef0", "raised": "#e1e4e7", "line": "#c3c8cd", "text": "#25292d", "muted": "#6c7277"}
BEGIN = "/* >>> Talaris: the on-screen keyboard's look (keyboard.py) — written from Settings, Look; replaced whole */"
END = "/* <<< Talaris */"

OSK = ["gdbus", "call", "--session", "--dest", "sm.puri.OSK0", "--object-path", "/sm/puri/OSK0", "--method", "sm.puri.OSK0.SetVisible"]


def _touchscreen() -> bool:
    try:
        return bool(json.loads(hypr.ask("j/devices") or "{}").get("touch"))
    except ValueError:
        return False


def available() -> bool:
    """Whether this machine has what it takes: Squeekboard installed, and a touchscreen."""
    return bool(shutil.which("squeekboard")) and _touchscreen()


class Keyboard(QObject):
    def __init__(self, desktop) -> None:
        super().__init__(desktop)
        global current
        current = self
        self.desktop = desktop
        self.up = False
        self._room = QTimer(self)
        self._room.setSingleShot(True)
        self._room.timeout.connect(self._measure)
        # While it is up, measured again now and then: it changes size with the screen turned (283 high in landscape,
        # 466 in portrait), and nothing says so. Kept clear of the landscape height in portrait, the panels lay over
        # its top rows and took their taps as a press off the panel (2026-11-14).
        self._again = QTimer(self)
        self._again.setInterval(1000)
        self._again.timeout.connect(self._measure)
        #: Folded back into a tablet (rotation.py): the keyboard comes up by itself in a field, as there is no other.
        self.auto = False
        # However it came up — asked by a button, or by itself in a tablet — panels keep clear of it.
        desktop.events.layer.connect(self._layer)
        if available():
            self._start()
            self.theme()

    def set_auto(self, on: bool) -> None:
        """A tablet (the keyboard by itself in any field), or a laptop again (only from a field's button)."""
        if not available() or on == self.auto:
            return
        self.auto = on
        subprocess.run(["gsettings", "set", "org.gnome.desktop.a11y.applications", "screen-keyboard-enabled", "true" if on else "false"],
                       capture_output=True, timeout=3, check=False)
        if not on and self.up:
            self.show(False)
        log(f"keyboard: {'up by itself in a field (a tablet)' if on else 'only from a field’s button'}")

    def _layer(self, namespace: str, opened: bool) -> None:
        if namespace != "osk":
            return
        # Up or away however it went — asked here, or by itself in a tablet — as the bar's button shows it.
        if opened != self.up:
            self.up = opened
            self._tell_bar()
        if opened:
            self._room.start(150)
        else:
            self._room.stop()
            self._again.stop()
            layershell.set_keyboard(0)

    def theme(self) -> None:
        """
        The keyboard in Talaris's look: its grays, accent and font, dark or light, as Settings, Look has them.
        Squeekboard is a GTK 3 program drawn as `sq_view` and `sq_button`, names no other program uses, so a
        block for them in the user's GTK stylesheet dresses it and nothing else. Talaris owns only its marked
        block; the rest of the file is left as it is. Squeekboard reads it as it starts, so it is started again.
        """
        if not available():
            return
        t = self.desktop.config.get("theme", {})
        light = t.get("mode") == "light"
        accent = (t.get("accentLight") if light else t.get("accentDark")) or t.get("accent") or "#c98a5b"
        c = LIGHT if light else DARK
        font = t.get("font") or "Barlow Semi Condensed"
        block = f"""{BEGIN}
sq_view {{ background-color: {c['desk']}; box-shadow: inset 0 1px 0 0 {c['line']}; font-family: '{font}', sans-serif; }}
sq_button {{ color: {c['text']}; background: {c['surface']}; border: 1px solid {c['line']}; border-radius: 8px; box-shadow: none; }}
sq_button:active, sq_button.locked, sq_button.latched {{ background: {accent}; color: {c['desk']}; border-color: {accent}; }}
sq_button.subtle-highlight, sq_button.subtle-highlight-2, sq_button.change-view, sq_button.change-view-2,
sq_button.change-view-3, sq_button.emoji-group, sq_button.character-group {{ background: {c['raised']}; color: {c['muted']}; border: 1px solid {c['line']}; }}
{END}
"""
        path = os.path.expanduser("~/.config/gtk-3.0/gtk.css")
        try:
            text = open(path, encoding="utf-8").read()
        except OSError:
            text = ""
        if BEGIN in text and END in text:
            head, _, rest = text.partition(BEGIN)
            _, _, tail = rest.partition(END)
            new = head + block.rstrip("\n") + tail
        else:
            new = (text.rstrip("\n") + "\n\n" if text.strip() else "") + block
        if new == text:
            return
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            f.write(new)
        self._restart()

    def _restart(self) -> None:
        """Squeekboard started again, to read its look: signalled by its pid, then started by Hyprland."""
        out = subprocess.run(["pgrep", "-x", "squeekboard"], capture_output=True, text=True).stdout.split()
        for pid in out:
            try:
                os.kill(int(pid), signal.SIGTERM)
            except (OSError, ValueError):
                pass
        QTimer.singleShot(600, lambda: hypr.ask("/dispatch exec squeekboard"))
        self.up = False
        layershell.set_keyboard(0)
        log("keyboard: dressed in Talaris's look")

    def _start(self) -> None:
        # Never by itself: only when a field's button asks (see above).
        subprocess.run(["gsettings", "set", "org.gnome.desktop.a11y.applications", "screen-keyboard-enabled", "false"],
                       capture_output=True, timeout=3, check=False)
        if subprocess.run(["pgrep", "-x", "squeekboard"], capture_output=True).returncode != 0:
            # Started by Hyprland, not as a child of this process: a restart of Talaris leaves it running.
            hypr.ask("/dispatch exec squeekboard")
            log("keyboard: Squeekboard started")

    def show(self, on: bool) -> None:
        """The keyboard up (a field's button) or away (the field left)."""
        log(f"keyboard: asked {'up' if on else 'away'}{'' if available() else ' — none here'}{' (already)' if on == self.up else ''}")
        if not available() or on == self.up:
            return
        self.up = on
        self._tell_bar()
        subprocess.Popen([*OSK, "true" if on else "false"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
        if on:
            # Its height, once it is on screen: what the panels keep clear of.
            self._room.start(250)
        else:
            self._room.stop()
            layershell.set_keyboard(0)

    def _tell_bar(self) -> None:
        bar = getattr(self.desktop, "bar", None)
        if bar is not None:
            bar.bridge.state.emit(json.dumps(bar.describe()))

    def _measure(self) -> None:
        try:
            layers = json.loads(hypr.ask("j/layers") or "{}")
        except ValueError:
            return
        for monitor in layers.values():
            for level in monitor.get("levels", {}).values():
                for layer in level:
                    if layer.get("namespace") == "osk":
                        layershell.set_keyboard(int(layer.get("h", 0)))
                        self._again.start()
                        return
        if self.up:
            self._room.start(250)
        else:
            # Gone without a word (its layer's closing missed): nothing kept clear of it any more.
            self._again.stop()
            layershell.set_keyboard(0)
