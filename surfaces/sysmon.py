# SPDX-License-Identifier: GPL-3.0-only
# Copyright (c) 2026 Jeff Moore

"""
How the machine is doing, for the power menu's graphs: the processor's use
since the last reading, memory and swap, the load, and what is using most —
by program, so a browser's many processes are one browser. Read from /proc
alone, nothing run, and only while the menu asks (once a second while it is
open); a few milliseconds a reading.
"""

import os

CLK = os.sysconf("SC_CLK_TCK")
PAGE = os.sysconf("SC_PAGE_SIZE")
CORES = os.cpu_count() or 1


def _cpu() -> tuple[int, int]:
    """All the processor's time, and the idle part of it (waiting on disk counts as idle), in ticks."""
    with open("/proc/stat") as f:
        parts = [int(x) for x in f.readline().split()[1:]]
    idle = parts[3] + (parts[4] if len(parts) > 4 else 0)
    return sum(parts[:8]), idle


def _meminfo() -> dict:
    out = {}
    with open("/proc/meminfo") as f:
        for line in f:
            k, _, v = line.partition(":")
            out[k] = int(v.split()[0]) * 1024
    return out


def _programs() -> dict[str, tuple[int, int, str]]:
    """Each process: its ticks of work so far, its memory in use, and its program's name."""
    out = {}
    for pid in os.listdir("/proc"):
        if not pid.isdigit():
            continue
        try:
            with open(f"/proc/{pid}/stat") as f:
                raw = f.read()
        except OSError:
            continue
        # The name is in parentheses and may hold spaces; what follows is split by them.
        name = raw[raw.find("(") + 1:raw.rfind(")")]
        rest = raw[raw.rfind(")") + 2:].split()
        out[pid] = (int(rest[11]) + int(rest[12]), int(rest[21]) * PAGE, name)
    return out


class SysMon:
    def __init__(self) -> None:
        self._cpu: tuple[int, int] | None = None
        self._procs: dict[str, tuple[int, int, str]] = {}

    def read(self) -> dict:
        total, idle = _cpu()
        procs = _programs()
        cpu = 0.0
        by_name: dict[str, list[float]] = {}
        if self._cpu:
            dt, di = total - self._cpu[0], idle - self._cpu[1]
            cpu = 100.0 * (1 - di / dt) if dt > 0 else 0.0
            # A program's share of the whole machine, as the CPU line is: all its processes' work since the last reading.
            for pid, (ticks, rss, name) in procs.items():
                before = self._procs.get(pid)
                work = ticks - before[0] if before and before[2] == name else 0
                cur = by_name.setdefault(name, [0.0, 0.0])
                cur[0] += 100.0 * work / dt if dt > 0 else 0.0
                cur[1] += rss
        else:
            for _pid, (_t, rss, name) in procs.items():
                by_name.setdefault(name, [0.0, 0.0])[1] += rss
        self._cpu, self._procs = (total, idle), procs
        m = _meminfo()
        mem_total, mem_free = m.get("MemTotal", 0), m.get("MemAvailable", 0)
        swap_total, swap_free = m.get("SwapTotal", 0), m.get("SwapFree", 0)
        top = sorted(by_name.items(), key=lambda kv: (kv[1][0], kv[1][1]), reverse=True)[:5]
        return {
            "cpu": round(max(0.0, min(100.0, cpu)), 1),
            "cores": CORES,
            "load": [round(x, 2) for x in os.getloadavg()],
            "mem": {"used": mem_total - mem_free, "total": mem_total},
            "swap": {"used": swap_total - swap_free, "total": swap_total},
            "top": [{"name": n, "cpu": round(c, 1), "mem": int(r)} for n, (c, r) in top],
        }


#: One for the bar's pages: readings a second apart are compared with the one before.
monitor = SysMon()
