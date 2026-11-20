# SPDX-License-Identifier: GPL-3.0-only
# Copyright (c) 2026 Jeff Moore
"""
What the surfaces' own process is holding, for finding a leak — asked on the
control socket, never on by itself:

    mem start    a baseline: Python's allocations traced from now, every live object counted by type
    mem report   what has grown since, written to $XDG_RUNTIME_DIR/talaris-mem.txt
    mem stop     tracing off again (it slows every allocation while on)

Python's allocations are only part of the process: Qt's and Chromium's are
not traced, so the report also says what the C allocator has handed out
(mallinfo2) — a growth there with none in Python's is in Qt or Chromium.
"""

from __future__ import annotations

import collections
import ctypes
import gc
import os
import tracemalloc

REPORT = os.path.join(os.environ.get("XDG_RUNTIME_DIR", f"/run/user/{os.getuid()}"), "talaris-mem.txt")

_base: dict = {}


class _MallInfo2(ctypes.Structure):
    _fields_ = [(n, ctypes.c_size_t) for n in ("arena", "ordblks", "smblks", "hblks", "hblkhd", "usmblks", "fsmblks", "uordblks", "fordblks", "keepcost")]


def _malloc() -> dict:
    try:
        libc = ctypes.CDLL("libc.so.6")
        libc.mallinfo2.restype = _MallInfo2
        m = libc.mallinfo2()
        return {"in use (heap)": m.uordblks, "free in heap": m.fordblks, "mmapped": m.hblkhd, "heap arenas": m.arena}
    except (OSError, AttributeError):
        return {}


def _types() -> collections.Counter:
    gc.collect()
    return collections.Counter(type(o).__module__ + "." + type(o).__qualname__ for o in gc.get_objects())


def _rss() -> dict:
    out = {}
    with open("/proc/self/smaps_rollup") as f:
        for line in f:
            k, _, v = line.partition(":")
            if k in ("Rss", "Pss_Anon"):
                out[k] = int(v.split()[0]) * 1024
    return out


def start() -> None:
    if not tracemalloc.is_tracing():
        tracemalloc.start(12)
    _base.update(snapshot=tracemalloc.take_snapshot(), types=_types(), malloc=_malloc(), rss=_rss())


def stop() -> None:
    tracemalloc.stop()
    _base.clear()


def report() -> str:
    if not _base:
        start()
        return "baseline taken; ask again for a report"
    mb = lambda b: f"{b / 1048576:+.1f} MB"  # noqa: E731
    lines = []
    rss = _rss()
    lines.append("Process: " + ", ".join(f"{k} {rss[k] / 1048576:.0f} MB ({mb(rss[k] - _base['rss'].get(k, 0))})" for k in rss))
    now = _malloc()
    lines.append("C allocator: " + ", ".join(f"{k} {now[k] / 1048576:.0f} MB ({mb(now[k] - _base['malloc'].get(k, 0))})" for k in now))
    snap = tracemalloc.take_snapshot()
    stats = snap.compare_to(_base["snapshot"], "traceback")
    lines.append(f"\nPython's allocations, grown since the baseline: {mb(sum(s.size_diff for s in stats))}")
    for s in sorted(stats, key=lambda s: -s.size_diff)[:12]:
        if s.size_diff <= 0:
            break
        lines.append(f"\n{mb(s.size_diff)} in {s.count_diff:+d} blocks:")
        lines.extend("    " + str(fr) for fr in s.traceback.format(limit=6))
    types = _types()
    grown = sorted(((n, types[n] - _base["types"].get(n, 0)) for n in types), key=lambda x: -x[1])[:20]
    lines.append("\nLive objects, grown since the baseline:")
    lines.extend(f"  {d:+6d}  {n}" for n, d in grown if d > 0)
    text = "\n".join(lines) + "\n"
    with open(REPORT, "w") as f:
        f.write(text)
    return text
