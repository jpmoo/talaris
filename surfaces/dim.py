# SPDX-License-Identifier: GPL-3.0-only
# Copyright (c) 2026 Jeff Moore
"""
The dim behind whatever has come out over the screen — one, for all of them.

Every panel from the bar, the launcher, the drawers and Settings sit the rest
of the screen back the same way: a clear layer over the windows and the bar,
put up as the panel opens, darkened as the panel has drawn and begins to
arrive (its page's `drawn`), lightened as it goes, and taken away once it is
clear. A press on it puts away whatever holds it.

It was not always one. Each panel's page drew a dim of its own, shown the
moment it was called and faded again when its arrival began; Settings had a
layer of its own, which was told to darken before its page could hear. Four
ways of doing one thing looked like four things (2026-10-27).

One holder at a time: a panel opened while another holds it takes it over,
and only the holder's going lightens it.
"""

from __future__ import annotations

from PySide6.QtCore import QObject, QTimer
from PySide6.QtWebEngineCore import QWebEngineProfile

from sensor import Catcher

#: As long as the page's fade (ui/catch.html), then the layer goes.
FADE_MS = 280


class Dim(QObject):
    def __init__(self, profile: QWebEngineProfile, parent: QObject) -> None:
        super().__init__(parent)
        self.owner = None
        self.layer = Catcher(profile, self._caught, self, name="dim")
        self._going = QTimer(self)
        self._going.setSingleShot(True)
        self._going.timeout.connect(self._gone)

    def hold(self, owner) -> None:
        """Up, and clear: `owner` has opened, and has not yet drawn."""
        self.owner = owner
        self._going.stop()
        self.layer.show(dim=False)

    def deepen(self, owner) -> None:
        """`owner` has drawn and is arriving: the screen behind it darkened as it comes."""
        if owner is self.owner and self.layer.up:
            self.layer.dim(True)

    def release(self, owner) -> None:
        """`owner` is going: lightened as it goes, then taken away. Another's going changes nothing."""
        if owner is not self.owner:
            return
        self.owner = None
        if self.layer.up:
            self.layer.dim(False)
            self._going.start(FADE_MS)

    def _gone(self) -> None:
        if self.owner is None:
            self.layer.hide()

    def _caught(self) -> None:
        """A press on the dim: whatever holds it, put away."""
        if self.owner is not None and hasattr(self.owner, "file_away"):
            self.owner.file_away()
