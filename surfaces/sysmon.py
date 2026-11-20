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
            # Temperature, thrashing, and what is a concern now: the menu's rows marked by it.
            "health": health(),
        }


#: One for the bar's pages: readings a second apart are compared with the one before.
monitor = SysMon()


def temperature() -> tuple[float, float] | None:
    """
    The processor's temperature and the point it is cut back at, in °C: its package sensor (coretemp, k10temp, zenpower
    — whichever the kernel has for it), else its hottest. None where there is none to read.
    """
    base = "/sys/class/hwmon"
    try:
        hwmons = os.listdir(base)
    except OSError:
        return None
    best = None
    for h in hwmons:
        d = os.path.join(base, h)
        try:
            with open(os.path.join(d, "name")) as f:
                if f.read().strip() not in ("coretemp", "k10temp", "zenpower", "cpu_thermal"):
                    continue
            inputs = [n for n in os.listdir(d) if n.startswith("temp") and n.endswith("_input")]
        except OSError:
            continue
        for n in inputs:
            b = n[: -len("_input")]
            try:
                with open(os.path.join(d, n)) as f:
                    t = int(f.read()) / 1000
                label = ""
                if os.path.exists(os.path.join(d, b + "_label")):
                    with open(os.path.join(d, b + "_label")) as f:
                        label = f.read().strip()
                crit = 100.0
                for k in ("_crit", "_max"):
                    if os.path.exists(os.path.join(d, b + k)):
                        with open(os.path.join(d, b + k)) as f:
                            crit = int(f.read()) / 1000 or crit
                        break
            except (OSError, ValueError):
                continue
            package = label.startswith(("Package", "Tctl", "Tdie"))
            if best is None or package > best[2] or (package == best[2] and t > best[0]):
                best = (t, crit, package)
    return (best[0], best[1]) if best else None


def _pressure() -> float | None:
    """How much of the last ten seconds work stalled waiting for memory (%), the kernel's own measure of thrashing."""
    try:
        with open("/proc/pressure/memory") as f:
            for line in f:
                if line.startswith("some"):
                    return float(line.split("avg10=")[1].split()[0])
    except (OSError, ValueError, IndexError):
        pass
    return None


#: Each reading's line: concern (1, yellow) and trouble (2, red).
LIMITS = {
    # Memory left for programs, % of all of it.
    "memory": (12, 6),
    # Swap in use, % of it.
    "swap": (50, 85),
    # Work stalled on memory, % of the last ten seconds (thrashing).
    "pressure": (10, 30),
    # Degrees short of the point the processor cuts itself back at.
    "temperature": (15, 5),
    # The 1-minute load, in processors' worth.
    "load": (2, 4),
}


def health() -> dict:
    """
    Whether anything the power menu shows is a concern (1) or trouble (2), and what: cheap — /proc and /sys, no
    process list — for reading every few seconds whether or not the menu is open.
    """
    m = _meminfo()
    issues: list[dict] = []

    def judge(what: str, value: float, lo_is_bad: bool, text: str) -> None:
        concern, trouble = LIMITS[what]
        bad = (lambda line: value <= line) if lo_is_bad else (lambda line: value >= line)
        level = 2 if bad(trouble) else 1 if bad(concern) else 0
        if level:
            issues.append({"what": what, "level": level, "text": text})

    total, avail = m.get("MemTotal", 0), m.get("MemAvailable", 0)
    if total:
        judge("memory", 100 * avail / total, True, f"Memory low: {avail / 1073741824:.1f} GB left")
    st, sf = m.get("SwapTotal", 0), m.get("SwapFree", 0)
    if st:
        judge("swap", 100 * (st - sf) / st, False, f"Swap {100 * (st - sf) / st:.0f}% used")
    p = _pressure()
    if p is not None:
        judge("pressure", p, False, f"Memory thrashing: {p:.0f}% of the time stalled")
    t = temperature()
    if t:
        judge("temperature", t[1] - t[0], True, f"Processor hot: {t[0]:.0f}°C")
    load = os.getloadavg()[0] / CORES
    judge("load", load, False, f"Overloaded: {os.getloadavg()[0]:.1f} load on {CORES} cores")
    return {"level": max((i["level"] for i in issues), default=0), "issues": issues,
            "temperature": t[0] if t else None, "pressure": p}
