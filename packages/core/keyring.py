#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-only
# Copyright (c) 2026 Jeff Moore
"""
Talaris's keys in the login keyring, for the core (which has no libsecret of
its own). One line out, or a reason on stderr and a non-zero exit.

    keyring.py get <name>            the key, or exit 1 if the open keyring has none
    keyring.py make <name>           a new 32-byte key, only if the open keyring has none
    keyring.py set <name>            store the line read from stdin (a key put back)
    keyring.py forget <name>         remove it

A keyring that is locked, or not running yet (the core can start before it at
login), exits 2: a failure to try again later, never "no key". A new key made
in that moment would leave everything already sealed unreadable — Morgan lost
its history exactly that way on 21 October 2026.
"""
import base64
import os
import sys

import gi

gi.require_version("Secret", "1")
from gi.repository import GLib, Secret  # noqa: E402

SCHEMA = Secret.Schema.new(
    "dev.talaris.Key",
    Secret.SchemaFlags.NONE,
    {"service": Secret.SchemaAttributeType.STRING, "kind": Secret.SchemaAttributeType.STRING},
)


def attributes(name):
    return {"service": "talaris", "kind": name}


def stored(name):
    """The key, or None when the open keyring certainly has none."""
    try:
        service = Secret.Service.get_sync(Secret.ServiceFlags.OPEN_SESSION | Secret.ServiceFlags.LOAD_COLLECTIONS, None)
        default = Secret.Collection.for_alias_sync(service, Secret.COLLECTION_DEFAULT, Secret.CollectionFlags.NONE, None)
        items = service.search_sync(SCHEMA, attributes(name),
                                    Secret.SearchFlags.ALL | Secret.SearchFlags.UNLOCK | Secret.SearchFlags.LOAD_SECRETS, None)
    except GLib.Error as error:
        print(f"the login keyring is not available yet: {error.message}", file=sys.stderr)
        sys.exit(2)
    for item in items:
        secret = None if item.get_locked() else item.get_secret()
        if secret is not None:
            return secret.get_text()
    if items or default is None or default.get_locked():
        print("the login keyring is locked", file=sys.stderr)
        sys.exit(2)
    return None


def store(name, value):
    Secret.password_store_sync(SCHEMA, attributes(name), Secret.COLLECTION_DEFAULT, f"Talaris {name}", value, None)


if len(sys.argv) != 3:
    sys.exit("usage: keyring.py get|make|set|forget <name>")
verb, name = sys.argv[1], sys.argv[2]

if verb == "get":
    key = stored(name)
    if key is None:
        sys.exit(1)
    print(key)
elif verb == "make":
    if stored(name) is not None:
        print("the keyring already has that key", file=sys.stderr)
        sys.exit(3)
    key = base64.b64encode(os.urandom(32)).decode()
    store(name, key)
    print(key)
elif verb == "set":
    store(name, sys.stdin.readline().strip())
elif verb == "forget":
    Secret.password_clear_sync(SCHEMA, attributes(name), None)
else:
    sys.exit("usage: keyring.py get|make|set|forget <name>")
