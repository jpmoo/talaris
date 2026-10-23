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


#: Settings' text sizes, one per area, each a zoom on that area's pages; the
#: fixed surface sizes of an area are scaled by the same (`zoom`), so a larger
#: page is not cut off. The areas: the interface (bar, its popups, Settings,
#: the indicator, the edges), the dock, the launcher, Morgan (conversation and
#: voice popup), and the two drawers, writing and canvas.
AREAS = ("interface", "dock", "launcher", "morgan", "writing", "canvas")
ZOOMS = {"small": 0.9, "medium": 1.0, "large": 1.12}
_zoom = {area: 1.0 for area in AREAS}
_views: list[tuple[QWebEngineView, str]] = []


def zoom(px: float, area: str = "interface") -> int:
    """A fixed size in Qt's units, at the text size Settings gives the area."""
    return round(px * _zoom.get(area, 1.0))


def zoom_of(area: str) -> float:
    """An area's zoom: how many Qt units one of its page's pixels is."""
    return _zoom.get(area, 1.0)


def set_zoom(sizes: dict) -> set[str]:
    """Each area's pages at its text size. Answers the areas that changed."""
    changed = set()
    for area in AREAS:
        z = ZOOMS.get(sizes.get(area, "medium"), 1.0)
        if z != _zoom[area]:
            _zoom[area] = z
            changed.add(area)
    for view, area in _views:
        if area in changed:
            view.setZoomFactor(_zoom[area])
    return changed


def make_view(profile: QWebEngineProfile, name: str, url: str, bridge: QObject, owner: QObject,
              area: str = "interface") -> QWebEngineView:
    view = QWebEngineView()
    _views.append((view, area))
    view.setZoomFactor(_zoom.get(area, 1.0))
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
