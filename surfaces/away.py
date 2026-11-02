# SPDX-License-Identifier: GPL-3.0-only
# Copyright (c) 2026 Jeff Moore
"""
A click anywhere else, for the things that come up unasked and go with one.

Heard by a pass-through bind on the left button (bindn: the click still
reaches what was clicked — what came up unasked must not cost the next click).
One bind for everyone who listens, held while anyone does: Hyprland has one
bind per key, so two holding it each would take it from one another. The
click comes back as `talaris-surfaces --away`, and the desktop asks each
listener whether it was off them (Toasts.clicked, Voice.clicked).
"""
from __future__ import annotations

import json
import os

import hypr

LAUNCHER = os.path.join(os.path.dirname(os.path.abspath(__file__)), "talaris-surfaces")
KEYS = ", mouse:272"

_holding: set[str] = set()


def hold(who: str, on: bool) -> None:
    """`who` listening for a click away, or not; the bind is there while anyone is."""
    was = bool(_holding)
    (_holding.add if on else _holding.discard)(who)
    if bool(_holding) != was:
        if _holding:
            hypr.bind(KEYS, f"{LAUNCHER} --away", "n")
        else:
            hypr.unbind(KEYS)


def rebind() -> None:
    """After a config reload, which drops runtime binds."""
    if _holding:
        hypr.bind(KEYS, f"{LAUNCHER} --away", "n")


def over(namespace: str, across: tuple[float, float] = (0.0, 1.0)) -> bool | None:
    """
    Whether the pointer is on a layer surface of `namespace`, within the shares
    of its width `across` (a surface wider than what it draws); None if Hyprland
    couldn't say.
    """
    try:
        at = json.loads(hypr.ask("j/cursorpos") or "{}")
        layers = json.loads(hypr.ask("j/layers") or "{}")
    except (OSError, ValueError):
        return None
    for monitor in layers.values():
        for level in monitor.get("levels", {}).values():
            for layer in level:
                if layer.get("namespace") == namespace:
                    x, y, w, h = layer.get("x", 0), layer.get("y", 0), layer.get("w", 0), layer.get("h", 0)
                    if x + across[0] * w <= at.get("x", -1) < x + across[1] * w and y <= at.get("y", -1) < y + h:
                        return True
    return False
