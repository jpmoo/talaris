# SPDX-License-Identifier: GPL-3.0-only
# Copyright (c) 2026 Jeff Moore
"""
What carries the sync folder, where Syncthing does (docs/SYNC.md, *Transport*): the devices the folder is shared
with, whether each is reachable now, when it was last seen, and how much of the folder it has. For Settings, Sync,
so the whole community can be seen — Talaris's machines, and the carriers between them (home-server holds the
share and is no Talaris machine).

Read from this machine's own Syncthing, on its local address with the key in its own configuration; nothing is
changed. Where the folder is not a Syncthing share, or Syncthing is not running, there is nothing to say.
"""

from __future__ import annotations

import json
import os
import re
import urllib.request

CONFIGS = ("~/.local/state/syncthing/config.xml", "~/.config/syncthing/config.xml")


def _local() -> tuple[str, str] | None:
    """This machine's Syncthing: its GUI address and API key, from its configuration."""
    for path in CONFIGS:
        try:
            with open(os.path.expanduser(path), encoding="utf-8") as f:
                text = f.read()
        except OSError:
            continue
        key = re.search(r"<apikey>([^<]+)</apikey>", text)
        gui = re.search(r"<gui[^>]*>.*?<address>([^<]+)</address>", text, re.S)
        if key:
            return (gui.group(1) if gui else "127.0.0.1:8384"), key.group(1)
    return None


def _get(base: str, key: str, path: str):
    req = urllib.request.Request(f"http://{base}{path}", headers={"X-API-Key": key})
    with urllib.request.urlopen(req, timeout=2) as r:
        return json.loads(r.read() or b"null")


def share(folder: str) -> dict:
    """
    The Syncthing share at `folder`: {devices: [{name, me, connected, address, seen, have}]}, or {} where it is not
    one. `have` is the share's percentage that device has (100 when it is up to date), or None where not known.
    """
    local = _local()
    if not local or not folder:
        return {}
    base, key = local
    want = os.path.realpath(os.path.expanduser(folder))
    try:
        found = next((f for f in _get(base, key, "/rest/config/folders")
                      if os.path.realpath(os.path.expanduser(f.get("path", ""))) == want), None)
        if not found:
            return {}
        me = _get(base, key, "/rest/system/status").get("myID", "")
        names = {d["deviceID"]: d.get("name") or d["deviceID"][:7] for d in _get(base, key, "/rest/config/devices")}
        connections = _get(base, key, "/rest/system/connections").get("connections", {})
        stats = _get(base, key, "/rest/stats/device") or {}
    except (OSError, ValueError, KeyError):
        return {"error": "Syncthing is not answering"}
    out = []
    for d in found.get("devices", []):
        dev = d["deviceID"]
        c = connections.get(dev, {})
        have = None
        if dev != me:
            try:
                have = round(_get(base, key, f"/rest/db/completion?folder={found['id']}&device={dev}").get("completion", 0))
            except (OSError, ValueError):
                pass
        out.append({"name": names.get(dev, dev[:7]), "me": dev == me, "connected": dev == me or bool(c.get("connected")),
                    "address": c.get("address", ""), "seen": (stats.get(dev) or {}).get("lastSeen", ""), "have": have})
    out.sort(key=lambda x: (not x["me"], x["name"].lower()))
    return {"folder": found.get("label") or found["id"], "type": found.get("type", ""), "devices": out}
