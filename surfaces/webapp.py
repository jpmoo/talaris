# SPDX-License-Identifier: GPL-3.0-only
# Copyright (c) 2026 Jeff Moore
"""
A web app in a window of its own — what a plugin offers as `[[apps]]`
(webapps.py starts it): Hermes Notes, say, as an application rather than a
browser tab.

Its own process, so it has its own app id (`talaris-app-<plugin>-<app>`):
the dock and the launcher know it by its desktop entry, and its key finds
this window rather than any of Talaris's. Its own profile, kept, so it is
signed in once. Links to anywhere else open in the browser; downloads go to
Downloads.

    python3 webapp.py --id hermes-sync-hermes --name "Hermes Notes" --url https://… [--icon /path]
"""

from __future__ import annotations

import argparse
import os
import sys

from PySide6.QtCore import QStandardPaths, QUrl
from PySide6.QtGui import QDesktopServices, QIcon, QKeySequence, QShortcut
from PySide6.QtWebEngineCore import QWebEnginePage, QWebEngineProfile
from PySide6.QtWebEngineWidgets import QWebEngineView
from PySide6.QtWidgets import QApplication


def same_site(a: QUrl, b: QUrl) -> bool:
    return a.scheme() == b.scheme() and a.host() == b.host() and a.port() == b.port()


class Page(QWebEnginePage):
    """Its own site stays in the window; anywhere else opens in the browser."""

    def __init__(self, profile: QWebEngineProfile, home: QUrl, parent=None) -> None:
        super().__init__(profile, parent)
        self.home = home

    def acceptNavigationRequest(self, url: QUrl, kind, is_main_frame: bool) -> bool:  # noqa: N802 — Qt's name
        if not is_main_frame or same_site(url, self.home) or url.scheme() not in ("http", "https", "mailto"):
            return True
        QDesktopServices.openUrl(url)
        return False

    def createWindow(self, kind):  # noqa: N802 — Qt's name
        # A link meant for a new window: somewhere to land, which hands it to the browser (or back here, if it is home).
        return Outside(self)


class Outside(QWebEnginePage):
    """A page asked for by `window.open` or a target=_blank link: its address goes where it belongs, and it is gone."""

    def __init__(self, opener: Page) -> None:
        super().__init__(opener.profile(), opener)
        self.opener = opener

    def acceptNavigationRequest(self, url: QUrl, kind, is_main_frame: bool) -> bool:  # noqa: N802 — Qt's name
        if same_site(url, self.opener.home):
            self.opener.setUrl(url)
        elif url.scheme() in ("http", "https", "mailto"):
            QDesktopServices.openUrl(url)
        self.deleteLater()
        return False


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--id", required=True)
    ap.add_argument("--name", required=True)
    ap.add_argument("--url", required=True)
    ap.add_argument("--icon", default="")
    a = ap.parse_args()

    os.environ.setdefault("QT_QPA_PLATFORM", "wayland")
    app = QApplication(sys.argv[:1])
    app.setApplicationName(a.name)
    # Its app id, which its desktop entry is named for (webapps.py): the dock's icon and name, and the key's way back to it.
    app.setDesktopFileName(f"talaris-app-{a.id}")
    if a.icon and os.path.exists(a.icon):
        app.setWindowIcon(QIcon(a.icon))

    # Kept, so it is signed in once: its own, apart from Talaris's pages and from the browser.
    data = os.path.join(QStandardPaths.writableLocation(QStandardPaths.StandardLocation.GenericDataLocation), "talaris", "apps", a.id)
    profile = QWebEngineProfile(f"talaris-app-{a.id}", app)
    profile.setPersistentStoragePath(os.path.join(data, "storage"))
    profile.setCachePath(os.path.join(data, "cache"))
    profile.setPersistentCookiesPolicy(QWebEngineProfile.PersistentCookiesPolicy.ForcePersistentCookies)

    downloads = QStandardPaths.writableLocation(QStandardPaths.StandardLocation.DownloadLocation)

    def download(item) -> None:
        item.setDownloadDirectory(downloads)
        item.accept()
    profile.downloadRequested.connect(download)

    home = QUrl(a.url)
    view = QWebEngineView()
    page = Page(profile, home, view)
    view.setPage(page)
    view.setWindowTitle(a.name)
    # The page's own title when it has one, its own name always first.
    view.titleChanged.connect(lambda t: view.setWindowTitle(f"{a.name} — {t}" if t and t != a.name else a.name))
    if not (a.icon and os.path.exists(a.icon)):
        view.iconChanged.connect(lambda icon: app.setWindowIcon(icon) if not icon.isNull() else None)
    # A browser's reload keys: Ctrl+R (and F5) again, Ctrl+Shift+R past the cache.
    for keys, action in (("Ctrl+R", QWebEnginePage.WebAction.Reload), ("F5", QWebEnginePage.WebAction.Reload),
                         ("Ctrl+Shift+R", QWebEnginePage.WebAction.ReloadAndBypassCache)):
        QShortcut(QKeySequence(keys), view, activated=lambda action=action: view.triggerPageAction(action))
    view.resize(1280, 860)
    view.setUrl(home)
    view.show()
    return app.exec()


if __name__ == "__main__":
    sys.exit(main())
