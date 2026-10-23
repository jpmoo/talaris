# SPDX-License-Identifier: GPL-3.0-only
# Copyright (c) 2026 Jeff Moore
"""
Talaris's settings, as a file: `~/.config/talaris/config.json`.

What is not in the file is the default below, so the file holds only what was
chosen and a new default reaches everyone who never chose otherwise. Settings
(`settings.py`) writes it; the process reads it at start and applies a change
the moment it is made.
"""

from __future__ import annotations

import json
import os
import tempfile

CONFIG = os.path.join(
    (os.environ.get("XDG_CONFIG_HOME") or "").strip() or os.path.expanduser("~/.config"), "talaris", "config.json"
)

DEFAULTS = {
    "theme": {"mode": "dark", "accent": "#c98a5b", "font": "Barlow Semi Condensed", "motion": "slide"},
    "bar": {"edge": "top"},
    # Super+Space while Noctalia holds it; Talaris takes it when Noctalia goes.
    "launcher": {"keys": "SUPER ALT, SPACE"},
    "dock": {"edge": "bottom"},
    # The space between the windows and whatever is round them — the bar, the
    # dock, the screen's edge — the same on every side.
    "windows": {"gap": 10},
    "drawers": {
        # 0.58 + 0.40 leaves a gap: both pulled at once never overlap.
        "canvas": {"edge": "left", "size": 0.58, "outWhenEmpty": False},
        "writing": {"edge": "right", "size": 0.4, "outWhenEmpty": False},
    },
    # A pulled drawer files itself after this long with no input. Idle, not a
    # deadline: a fixed timeout fired mid-scroll in the spike.
    "idleSeconds": 45,
}


def load_config() -> dict:
    config = json.loads(json.dumps(DEFAULTS))
    try:
        with open(CONFIG, encoding="utf-8") as f:
            mine = json.load(f)
    except (OSError, ValueError):
        return config
    for key, value in mine.items():
        if isinstance(value, dict) and isinstance(config.get(key), dict):
            for k, v in value.items():
                if isinstance(v, dict) and isinstance(config[key].get(k), dict):
                    config[key][k].update(v)
                else:
                    config[key][k] = v
        else:
            config[key] = value
    return config


def _differences(mine: dict, base: dict) -> dict:
    """What `mine` says that `base` does not — what the file needs to hold."""
    out = {}
    for key, value in mine.items():
        if isinstance(value, dict) and isinstance(base.get(key), dict):
            inner = _differences(value, base[key])
            if inner:
                out[key] = inner
        elif base.get(key) != value:
            out[key] = value
    return out


def save_config(config: dict) -> None:
    """Write what differs from the defaults, atomically: a crash leaves the old file or the new one."""
    os.makedirs(os.path.dirname(CONFIG), exist_ok=True)
    text = json.dumps(_differences(config, DEFAULTS), indent=2) + "\n"
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(CONFIG), prefix=".config.")
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(text)
    os.replace(tmp, CONFIG)
