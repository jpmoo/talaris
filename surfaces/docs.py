# SPDX-License-Identifier: GPL-3.0-only
# Copyright (c) 2026 Jeff Moore
"""
Which document a window holds — for the dock, which can keep one as a pin of
its own (a spreadsheet, a page in the browser) beside the application it
opens in.

Hyprland knows a window only by its class and its title, and a title is a
name, not a place. So the place is looked for where the system keeps it:

- **A web page**, in Firefox's own record of its open tabs (the session file
  it keeps against a crash, `sessionstore-backups/recovery.jsonlz4`): the tab
  whose title the window shows, and its address.
- **A file**, among those the application has open (`/proc/<pid>/fd`), then
  those recently opened (the desktop's `recently-used.xbel`, and LibreOffice's
  own list, which it keeps apart): the one whose name the title carries.

Where neither says, nothing is guessed: no document, and the dock offers none
to pin.
"""

from __future__ import annotations

import configparser
import hashlib
import json
import os
import re
import shutil
import sqlite3
import subprocess
import tempfile
import xml.etree.ElementTree as ET
from urllib.parse import unquote, urlsplit

HOME = os.path.expanduser("~")
CACHE = os.path.join(os.environ.get("XDG_CACHE_HOME") or os.path.join(HOME, ".cache"), "talaris", "doc-icons")

_cached: dict[str, tuple[float, object]] = {}


def _by_mtime(path: str, read):
    """What `read(path)` answered, again while the file has not changed."""
    try:
        mtime = os.path.getmtime(path)
    except OSError:
        return None
    hit = _cached.get(path)
    if hit and hit[0] == mtime:
        return hit[1]
    try:
        value = read(path)
    except Exception:  # noqa: BLE001 — a file mid-write, or a format changed: no answer, not a crash
        value = None
    _cached[path] = (mtime, value)
    return value


# ---------------------------------------------------------------- Firefox

def _lz4_block(src: bytes, size: int) -> bytes:
    """An LZ4 block, decompressed: the format Firefox's `mozLz4` files hold after their header."""
    out = bytearray()
    i = 0
    while i < len(src):
        token = src[i]
        i += 1
        n = token >> 4
        if n == 15:
            while True:
                b = src[i]
                i += 1
                n += b
                if b != 255:
                    break
        out += src[i:i + n]
        i += n
        if i >= len(src):
            break
        offset = src[i] | (src[i + 1] << 8)
        i += 2
        m = token & 15
        if m == 15:
            while True:
                b = src[i]
                i += 1
                m += b
                if b != 255:
                    break
        m += 4
        start = len(out) - offset
        for k in range(m):  # may overlap itself, so byte by byte
            out.append(out[start + k])
    return bytes(out[:size])


def _mozlz4(path: str) -> bytes:
    with open(path, "rb") as f:
        data = f.read()
    if data[:8] != b"mozLz40\0":
        raise ValueError("not a mozLz4 file")
    return _lz4_block(data[12:], int.from_bytes(data[8:12], "little"))


def firefox_profile() -> str | None:
    """The profile Firefox opens by default: the install's own, else the one marked default."""
    for root in (os.path.join(HOME, ".config", "mozilla", "firefox"), os.path.join(HOME, ".mozilla", "firefox"),
                 os.path.join(HOME, "snap", "firefox", "common", ".mozilla", "firefox")):
        ini = configparser.ConfigParser(interpolation=None)
        try:
            if not ini.read(os.path.join(root, "profiles.ini")):
                continue
        except configparser.Error:
            continue
        chosen = next((ini[s]["Default"] for s in ini.sections() if s.startswith("Install") and ini[s].get("Default")), None)
        if not chosen:
            chosen = next((ini[s]["Path"] for s in ini.sections() if s.startswith("Profile") and ini[s].get("Default") == "1"), None)
        if chosen:
            path = chosen if os.path.isabs(chosen) else os.path.join(root, chosen)
            if os.path.isdir(path):
                return path
    return None


def _tabs(path: str) -> list[dict]:
    session = json.loads(_mozlz4(path))
    tabs = []
    for w in session.get("windows", []):
        chosen = w.get("selected", 1) - 1
        for i, t in enumerate(w.get("tabs", [])):
            entries = t.get("entries") or []
            if not entries:
                continue
            e = entries[max(0, min(len(entries), t.get("index", len(entries))) - 1)]
            if e.get("url", "").startswith(("http://", "https://")):
                tabs.append({"url": e["url"], "title": e.get("title") or e["url"], "selected": i == chosen})
    return tabs


def firefox_tabs() -> list[dict]:
    """Every open tab's address and title, the ones shown in their windows marked."""
    profile = firefox_profile()
    if not profile:
        return []
    return _by_mtime(os.path.join(profile, "sessionstore-backups", "recovery.jsonlz4"), _tabs) or []


def page_title(window_title: str) -> str:
    """A browser window's title without the browser's name after it."""
    return re.sub(r"\s+[—–-]\s+(Mozilla\s+)?Firefox(\s+Private Browsing)?$", "", window_title).strip()


def same_page(a: str, b: str) -> bool:
    """Two addresses for one page: the part after # and a closing slash aside."""
    def norm(u: str) -> str:
        p = urlsplit(u)
        return f"{p.scheme}://{p.netloc.lower()}{p.path.rstrip('/')}{'?' + p.query if p.query else ''}"
    return norm(a) == norm(b)


def is_browser(app: dict, wm_class: str) -> bool:
    return "firefox" in (app.get("id", "") + " " + wm_class).lower()


def _browser_page(title: str) -> dict | None:
    want = page_title(title)
    if not want:
        return None
    hits = [t for t in firefox_tabs() if t["title"] == want]
    # The tab a window shows first; any tab of that title after.
    hits.sort(key=lambda t: not t["selected"])
    return {"kind": "url", "target": hits[0]["url"], "name": want} if hits else None


# ---------------------------------------------------------------- files

def _xbel(path: str) -> list[tuple[str, str]]:
    out = []
    for b in ET.parse(path).getroot().iter("bookmark"):
        href = b.get("href", "")
        if href.startswith("file://"):
            out.append((unquote(href[7:]), b.get("visited") or b.get("modified") or ""))
    return out


def _picklist(path: str) -> list[tuple[str, str]]:
    with open(path, encoding="utf-8", errors="replace") as f:
        text = f.read()
    found = re.findall(r"HistoryInfo\['PickList'\]/ItemList\"><node oor:name=\"file://([^\"]+)\"", text)
    # Its own order is most recent first; given as a rank that sorts the same way as a time.
    return [(unquote(p.replace("&amp;", "&")), f"~{9999 - i:04d}") for i, p in enumerate(found)]


def recent_files() -> list[str]:
    """Files opened lately, most recent first: the desktop's list, then LibreOffice's own."""
    xbel = _by_mtime(os.path.join(HOME, ".local", "share", "recently-used.xbel"), _xbel) or []
    lo = _by_mtime(os.path.join(HOME, ".config", "libreoffice", "4", "user", "registrymodifications.xcu"), _picklist) or []
    return [p for p, _ in sorted(xbel, key=lambda x: x[1], reverse=True)] + [p for p, _ in lo]


def open_files(pid: int) -> list[str]:
    """Files a process has open in the home folder, leaving out what is hidden (settings, caches, locks)."""
    out = []
    try:
        fds = os.listdir(f"/proc/{pid}/fd")
    except OSError:
        return out
    for fd in fds:
        try:
            p = os.readlink(f"/proc/{pid}/fd/{fd}")
        except OSError:
            continue
        if p.startswith(HOME + "/") and "/." not in p[len(HOME):] and os.path.isfile(p):
            out.append(p)
    return out


def _file_in(title: str, pid: int) -> dict | None:
    if not title:
        return None
    named = lambda p: os.path.basename(p) in title or (os.path.splitext(os.path.basename(p))[0] in title and len(os.path.splitext(os.path.basename(p))[0]) >= 3)
    seen = set()
    for source in (open_files(pid) if pid else [], recent_files()):
        hits = [p for p in source if p not in seen and named(p) and os.path.isfile(p)]
        seen.update(source)
        if hits:
            # The fullest name the title carries: "Budget 2027.ods" over "Budget.ods".
            best = max(hits, key=lambda p: len(os.path.basename(p)) if os.path.basename(p) in title else len(os.path.splitext(os.path.basename(p))[0]))
            return {"kind": "file", "target": best, "name": os.path.basename(best)}
    return None


def document_of(window: dict, app: dict) -> dict | None:
    """The document a window shows — `{kind: "file"|"url", target, name}` — or None where it cannot be told."""
    if is_browser(app, window.get("class", "")):
        return _browser_page(window.get("title", ""))
    return _file_in(window.get("title", ""), int(window.get("pid") or 0))


def shows(doc: dict, window: dict, app: dict) -> bool:
    """Whether a window is showing a pinned document now."""
    if doc.get("kind") == "url":
        if not is_browser(app, window.get("class", "")):
            return False
        page = _browser_page(window.get("title", ""))
        return bool(page and same_page(page["target"], doc["target"]))
    base = os.path.basename(doc.get("target", ""))
    return bool(base) and base in window.get("title", "")


# ---------------------------------------------------------------- pinning one

def default_app(target: str) -> str:
    """The desktop id that opens a file or an address by default, `.desktop` dropped; empty if none says."""
    try:
        if target.startswith(("http://", "https://")):
            out = subprocess.run(["xdg-settings", "get", "default-web-browser"], capture_output=True, text=True, timeout=3).stdout
        else:
            mime = subprocess.run(["xdg-mime", "query", "filetype", target], capture_output=True, text=True, timeout=3).stdout.strip()
            out = subprocess.run(["xdg-mime", "query", "default", mime], capture_output=True, text=True, timeout=3).stdout if mime else ""
    except (OSError, subprocess.SubprocessError):
        return ""
    return out.strip().removesuffix(".desktop")


def doc_id(target: str) -> str:
    return hashlib.sha1(target.encode()).hexdigest()[:12]


def _places_copy(profile: str, name: str, work: str) -> str | None:
    """A database of Firefox's, copied with its journal: it is locked while Firefox runs."""
    src = os.path.join(profile, name)
    if not os.path.isfile(src):
        return None
    for suffix in ("", "-wal"):
        if os.path.isfile(src + suffix):
            shutil.copy(src + suffix, os.path.join(work, name + suffix))
    return os.path.join(work, name)


def page_icon(url: str) -> str:
    """The page's icon as Firefox keeps it, saved where the dock can draw it; empty if it has none to give."""
    profile = firefox_profile()
    if not profile:
        return ""
    os.makedirs(CACHE, exist_ok=True)
    with tempfile.TemporaryDirectory() as work:
        db = _places_copy(profile, "favicons.sqlite", work)
        if not db:
            return ""
        origin = "{0.scheme}://{0.netloc}".format(urlsplit(url))
        try:
            con = sqlite3.connect(db)
            rows = con.execute(
                """SELECT i.data, i.width, p.page_url FROM moz_icons i
                   JOIN moz_icons_to_pages ip ON ip.icon_id = i.id JOIN moz_pages_w_icons p ON p.id = ip.page_id
                   WHERE (p.page_url = ? OR p.page_url LIKE ?) AND i.data IS NOT NULL""",
                (url, origin + "/%")).fetchall()
            con.close()
        except sqlite3.Error:
            return ""
    if not rows:
        return ""
    # The nearest page's — two apps on one site have icons of their own — then the size nearest the dock's.
    near = lambda page: len(os.path.commonprefix([page, url]))
    data = sorted(rows, key=lambda r: (-near(r[2]), abs((r[1] or 32) - 64)))[0][0]
    ext = "png" if data[:4] == b"\x89PNG" else "ico" if data[:4] == b"\0\0\1\0" else "svg" if b"<svg" in data[:300] else "img"
    path = os.path.join(CACHE, f"{doc_id(url)}.{ext}")
    with open(path, "wb") as f:
        f.write(data)
    return path


ICON_TYPES = {"png": "image/png", "ico": "image/x-icon", "svg": "image/svg+xml", "img": "application/octet-stream"}


def saved_icon(name: str) -> tuple[bytes, str] | None:
    """A page icon saved by `page_icon`, by its file name alone — nothing outside that folder."""
    if not re.fullmatch(r"[0-9a-f]{12}\.(png|ico|svg|img)", name or ""):
        return None
    try:
        with open(os.path.join(CACHE, name), "rb") as f:
            return f.read(), ICON_TYPES[name.rsplit(".", 1)[1]]
    except OSError:
        return None


def page_name(url: str) -> str:
    """A page's title as Firefox last saw it; its address, shortened, where it has none."""
    profile = firefox_profile()
    if profile:
        with tempfile.TemporaryDirectory() as work:
            db = _places_copy(profile, "places.sqlite", work)
            if db:
                try:
                    con = sqlite3.connect(db)
                    row = con.execute("SELECT title FROM moz_places WHERE url = ?", (url,)).fetchone()
                    con.close()
                    if row and row[0]:
                        return row[0]
                except sqlite3.Error:
                    pass
    p = urlsplit(url)
    return (p.netloc + p.path).rstrip("/")
