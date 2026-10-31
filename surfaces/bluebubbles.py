# SPDX-License-Identifier: GPL-3.0-only
# Copyright (c) 2026 Jeff Moore
"""
Sign-in codes from BlueBubbles, onto the clipboard as they arrive (from
Talaria's, which did the same).

Switched on in Settings, Clipboard (`clipboard.codes`), and off until it is.
When a text comes in that `otp.find_code` says carries a code, the code goes
onto the clipboard — **not into its history**: a code is a secret for a
minute, then rubbish — and a toast says so.

**The server and its password come from the BlueBubbles client**, read from
its own settings each time they are needed rather than copied into Talaris's.
The client already has to know both, a copy would go stale the day the
password changes, and somebody who has BlueBubbles set up has nothing to type.

**Polled, not pushed.** The server's push channel is Socket.IO, which neither
PySide6 nor the standard library speaks — a new dependency for a feature a
sentence long. Asking every few seconds for messages newer than the last one
seen costs the server one indexed query, and a code three seconds late is
still a code.

**Nothing old is handed over.** The cursor starts at "now", and after a sleep
the first answer can hold an hour of messages: anything older than
`FRESH_SECONDS` is skipped, because a code from before the laptop was closed
has expired, and putting it on the clipboard would overwrite something that
had not.

Message text is never logged or kept. Only the code leaves this module, and
only to the clipboard and the toast.
"""

from __future__ import annotations

import json
import os
import threading
import time
import urllib.parse
import urllib.request

from PySide6.QtCore import QObject, Signal

import otp
from views import log

CLIENT_PREFS = os.path.expanduser("~/.var/app/app.bluebubbles.BlueBubbles/data/bluebubbles/shared_preferences.json")
POLL_SECONDS = 3
FRESH_SECONDS = 120


def server() -> tuple[str, str] | None:
    """The BlueBubbles server's address and password, as its client has them; None without the client signed in."""
    try:
        with open(CLIENT_PREFS, encoding="utf8") as handle:
            prefs = json.load(handle)
    except (OSError, ValueError):
        return None
    address, password = prefs.get("serverAddress"), prefs.get("guidAuthKey")
    if not isinstance(address, str) or not address or not isinstance(password, str):
        return None
    return address.rstrip("/"), password


def _since(address: str, password: str, after_ms: int) -> list[dict]:
    query = urllib.parse.urlencode({"guid": password})
    body = json.dumps({"after": after_ms, "sort": "ASC", "limit": 50, "with": ["handle"]}).encode()
    request = urllib.request.Request(f"{address}/api/v1/message/query?{query}", data=body,
                                     headers={"content-type": "application/json"})
    with urllib.request.urlopen(request, timeout=10) as reply:
        return json.load(reply).get("data") or []


class Codes(QObject):
    """A thread asking the server; each code found said on the screen's thread (`found`)."""

    #: A code, and who sent it (their number or address; "" if the server did not say).
    found = Signal(str, str)

    def __init__(self, desktop) -> None:
        super().__init__(desktop)
        self.desktop = desktop
        self._seen: set[str] = set()
        threading.Thread(target=self._run, name="bluebubbles", daemon=True).start()

    def on(self) -> bool:
        return bool(self.desktop.config.get("clipboard", {}).get("codes", False))

    def _run(self) -> None:
        cursor = int(time.time() * 1000)
        failing = False
        while True:
            time.sleep(POLL_SECONDS)
            if not self.on() or (where := server()) is None:
                # Off now means nothing that arrived meanwhile is handed over when it is switched back on.
                cursor = int(time.time() * 1000)
                continue
            try:
                messages = _since(*where, cursor)
            except Exception as err:  # noqa: BLE001 — asleep, offline, server down: try again
                if not failing:
                    log(f"bluebubbles: not reachable ({type(err).__name__})")
                failing = True
                continue
            if failing:
                log("bluebubbles: reachable again")
                failing = False
            for message in messages:
                created = message.get("dateCreated") or 0
                cursor = max(cursor, created)
                guid = message.get("guid")
                if guid in self._seen or message.get("isFromMe"):
                    continue
                self._seen.add(guid)
                if time.time() * 1000 - created > FRESH_SECONDS * 1000:
                    continue
                if code := otp.find_code(message.get("text")):
                    self.found.emit(code, (message.get("handle") or {}).get("address") or "")
            # `after` may include the cursor's own millisecond, so the guids are what stop the last
            # message being read twice — and only the ones at the cursor can come back.
            self._seen = {m.get("guid") for m in messages if (m.get("dateCreated") or 0) >= cursor} | (
                self._seen if not messages else set())
