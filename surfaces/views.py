# SPDX-License-Identifier: GPL-3.0-only
# Copyright (c) 2026 Jeff Moore
"""
A page on a layer surface: one way of making the web view every surface uses.

The drawers came first and made theirs inline; the bar and its popup are the
same thing, so it lives here once — transparent, no browser menus, a bridge on
a channel, and the page's complaints in the journal.
"""

from __future__ import annotations

import sys

from PySide6.QtCore import QObject, QUrl, Qt
from PySide6.QtGui import QColor, QDesktopServices
from PySide6.QtWebChannel import QWebChannel
from PySide6.QtWebEngineCore import QWebEnginePage, QWebEngineProfile, QWebEngineSettings
from PySide6.QtWebEngineWidgets import QWebEngineView


def log(*parts: object) -> None:
    print("talaris-surfaces:", *parts, file=sys.stderr, flush=True)


class Page(QWebEnginePage):
    """A page whose warnings and errors reach the journal — no other way to see them on a layer surface."""

    def __init__(self, profile: QWebEngineProfile, parent: QObject, name: str) -> None:
        super().__init__(profile, parent)
        self.name = name

    def acceptNavigationRequest(self, url, kind, is_main_frame: bool) -> bool:  # noqa: N802 — Qt's name
        """A link out — in an answer, a page — opens in the browser, never in place of a surface."""
        if url.scheme() in ("http", "https", "mailto"):
            QDesktopServices.openUrl(url)
            return False
        return True

    def javaScriptConsoleMessage(self, level, message, line, source):  # noqa: N802 — Qt's name
        if level != QWebEnginePage.JavaScriptConsoleMessageLevel.InfoMessageLevel:
            log(f"{self.name} page: {message} ({source.rsplit('/', 1)[-1]}:{line})")


#: Settings' text size, as a zoom on every page; fixed surface sizes are
#: scaled by the same (`zoom`), so a larger page is not cut off.
ZOOMS = {"small": 0.9, "medium": 1.0, "large": 1.12}
_zoom = {"z": 1.0}
_views: list[QWebEngineView] = []


def zoom(px: float) -> int:
    """A fixed size in Qt's units, at the text size Settings gives."""
    return round(px * _zoom["z"])


def set_zoom(size: str) -> bool:
    """Every page at this text size. True if it changed."""
    z = ZOOMS.get(size, 1.0)
    if z == _zoom["z"]:
        return False
    _zoom["z"] = z
    for view in _views:
        view.setZoomFactor(z)
    return True


def make_view(profile: QWebEngineProfile, name: str, url: str, bridge: QObject, owner: QObject) -> QWebEngineView:
    view = QWebEngineView()
    _views.append(view)
    view.setZoomFactor(_zoom["z"])
    view.setWindowTitle(f"talaris-{name}")
    view.setAttribute(Qt.WidgetAttribute.WA_TranslucentBackground)
    # The engine's own right-click menu — Back, Reload, View source — is a
    # browser showing through. Pages draw their own menus instead.
    view.setContextMenuPolicy(Qt.ContextMenuPolicy.NoContextMenu)
    page = Page(profile, view, name)
    page.setBackgroundColor(QColor(0, 0, 0, 0))
    # So a page's own Cut / Copy / Paste can reach the clipboard.
    for attr in ("JavascriptCanAccessClipboard", "JavascriptCanPaste"):
        flag = getattr(QWebEngineSettings.WebAttribute, attr, None)
        if flag is not None:
            page.settings().setAttribute(flag, True)
    view.setPage(page)
    channel = QWebChannel(owner)
    channel.registerObject("bridge", bridge)
    page.setWebChannel(channel)
    page.loadFinished.connect(lambda ok: log(f"{name} page: {'loaded' if ok else 'FAILED to load'}"))
    view.setUrl(QUrl(url))
    return view
