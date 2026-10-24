# SPDX-License-Identifier: GPL-3.0-only
# Copyright (c) 2026 Jeff Moore
"""
Accounts: Google, Microsoft 365, Apple and other online accounts, for the
calendar and contacts — GNOME Online Accounts' own.

**Borrowed, not built** (DESIGN.md, "What Talaris borrows"). Signing in is
GNOME Online Accounts': its window (`gnome-online-accounts-gtk`) shows each
provider's own sign-in page, and the tokens stay in the login keyring, never
seen here. Settings, Accounts lists the accounts, turns each one's calendar
and contacts on and off, and removes one — all over the service's D-Bus
interface, read with `busctl --json`, so nothing here needs its bindings.

Apple has no sign-in of this kind: an iCloud account is added as WebDAV, with
the server `https://caldav.icloud.com` and an app-specific password made at
appleid.apple.com.
"""

from __future__ import annotations

import json
import shutil
import subprocess

GOA = "org.gnome.OnlineAccounts"
ACCOUNT = "org.gnome.OnlineAccounts.Account"
#: What Settings may turn on and off for an account: the property, and what it means.
SWITCHES = {"calendar": "CalendarDisabled", "contacts": "ContactsDisabled"}
#: The window that adds an account.
ADDER = "gnome-online-accounts-gtk"


def _busctl(*args: str, timeout: float = 5) -> str:
    try:
        r = subprocess.run(["busctl", "--user", *args], capture_output=True, text=True, timeout=timeout)
    except (OSError, subprocess.TimeoutExpired) as e:
        return json.dumps({"error": str(e)})
    return r.stdout if r.returncode == 0 else json.dumps({"error": (r.stderr or "busctl failed").strip()})


def listing() -> dict:
    """Every account: who, which provider, what it is used for, and whether it needs signing in again."""
    raw = json.loads(_busctl("--json=short", "call", GOA, "/org/gnome/OnlineAccounts",
                             "org.freedesktop.DBus.ObjectManager", "GetManagedObjects") or "{}")
    if "error" in raw:
        return {"present": False, "accounts": [], "canAdd": bool(shutil.which(ADDER)), "error": raw["error"]}
    accounts = []
    for objects in raw.get("data", []):
        for path, ifaces in objects.items():
            a = ifaces.get(ACCOUNT)
            if not a:
                continue
            val = lambda key, default=None: (a.get(key) or {}).get("data", default)  # noqa: E731
            uses = {name: not val(prop, True) for name, prop in SWITCHES.items() if prop in a}
            accounts.append({"path": path, "id": val("Id", ""), "provider": val("ProviderName", ""),
                             "type": val("ProviderType", ""), "who": val("PresentationIdentity", ""),
                             "attention": bool(val("AttentionNeeded", False)), "uses": uses})
    accounts.sort(key=lambda a: (a["provider"], a["who"]))
    return {"present": True, "accounts": accounts, "canAdd": bool(shutil.which(ADDER))}


def _known(path: str) -> bool:
    return any(a["path"] == path for a in listing()["accounts"])


def switch(path: str, what: str, on: bool) -> str:
    """An account's calendar or contacts, on or off. Answers why not, or nothing."""
    if what not in SWITCHES or not _known(path):
        return "Not an account's setting"
    out = _busctl("set-property", GOA, path, ACCOUNT, SWITCHES[what], "b", "false" if on else "true")
    return json.loads(out).get("error", "") if out.startswith("{") else ""


def remove(path: str) -> str:
    """The account gone from this computer — and with it, its calendars and contacts here."""
    if not _known(path):
        return "No such account"
    out = _busctl("call", GOA, path, ACCOUNT, "Remove")
    return json.loads(out).get("error", "") if out.startswith("{") else ""


def sign_in_again(path: str) -> str:
    """An account whose sign-in lapsed: its provider asked to make sure of its credentials."""
    if not _known(path):
        return "No such account"
    out = _busctl("call", GOA, path, ACCOUNT, "EnsureCredentials", timeout=30)
    return json.loads(out).get("error", "") if out.startswith("{") else ""
