# SPDX-License-Identifier: GPL-3.0-only
# Copyright (c) 2026 Jeff Moore
#
# Talaris' own sounds, made here rather than borrowed from a sound theme: one
# that is too loud or sounds like 2004 is changed by changing this, and
#   python3 sounds/make.py
# writes the .wav files beside it. Standard library only.

import math
import random
import struct
import wave
from pathlib import Path

RATE = 48000


def write(name: str, samples: list[float]) -> None:
    with wave.open(str(Path(__file__).with_name(name)), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(b"".join(struct.pack("<h", int(max(-1.0, min(1.0, s)) * 32767)) for s in samples))


def _two(notes: list[float]) -> list[float]:
    """Two low, round notes, a soft fourth apart, each eased in: nothing high, nothing sudden, no glide, no noise."""
    n = int(RATE * 0.55)
    out = [0.0] * n
    for (at, gain), f in zip(((0.0, 1.0), (0.12, 0.8)), notes):
        start = int(RATE * at)
        for i in range(n - start):
            t = i / RATE
            # A slow swell in (40 ms) and a gentle fall: no edge to it.
            attack = math.sin(min(1.0, t / 0.04) * math.pi / 2) ** 2
            decay = math.exp(-t * 7.0)
            # Round, like a soft mallet on wood: the note, a little of its octave, nothing above.
            v = math.sin(2 * math.pi * f * t) + 0.18 * math.sin(2 * math.pi * 2 * f * t) * math.exp(-t * 12)
            out[start + i] += gain * attack * decay * v
    # Quiet: well under the system's volume.
    peak = max(abs(s) for s in out) or 1.0
    fade = int(RATE * 0.08)
    return [s / peak * 0.22 * (min(1.0, (n - i) / fade)) for i, s in enumerate(out)]


def plug() -> list[float]:
    """
    Power connected: up a fourth, D4 to G4. The first, a bright glide to 1260 Hz with a sharp attack, set the dogs off
    (2026-11-16).
    """
    return _two([293.66, 392.0])


def unplug() -> list[float]:
    """Power taken away, on the battery now: the same two notes coming down, G4 to D4."""
    return _two([392.0, 293.66])


def _run_of(scale: list[float], every: float, seconds: float, level: float) -> list[float]:
    """Warm bells in turn, each swelling in and ringing on, so the run blooms into a chord as it ends."""
    n = int(RATE * seconds)
    out = [0.0] * n
    for k, f in enumerate(scale):
        start = int(RATE * every * k)
        gain = 0.85 - 0.07 * k
        for i in range(n - start):
            t = i / RATE
            attack = min(1.0, t / 0.025) ** 2
            decay = math.exp(-t * 1.9)
            s = (math.sin(2 * math.pi * f * t) + 0.6 * math.sin(2 * math.pi * f * 1.0015 * t)) * 0.6
            s += 0.16 * math.sin(2 * math.pi * f * 2 * t) * math.exp(-t * 5)
            s += 0.04 * math.sin(2 * math.pi * f * 3.01 * t) * math.exp(-t * 9)
            out[start + i] += gain * attack * decay * s
    for delay, g in ((int(RATE * 0.11), 0.18), (int(RATE * 0.23), 0.09)):
        for i in range(n - 1, delay - 1, -1):
            out[i] += g * out[i - delay]
    peak = max(abs(s) for s in out) or 1.0
    fade = int(RATE * 0.5)
    return [s / peak * level * min(1.0, (n - i) / fade) for i, s in enumerate(out)]


def opening() -> list[float]:
    """
    Talaris come up: a soft run up the A major pentatonic (A4 B4 C#5 E5 F#5 A5), a note every 70 ms, each a warm
    bell that swells in and rings on — so the run blooms into a chord as it ends.
    """
    # Soft: a greeting, not a notice.
    return _run_of([440.0, 493.9, 554.4, 659.3, 740.0, 880.0], 0.07, 2.6, 0.18)


def closing() -> list[float]:
    """Talaris going (log out, restart, shut down): the opening's run coming down (A5 to A4), settling low."""
    return _run_of([880.0, 740.0, 659.3, 554.4, 493.9, 440.0], 0.07, 2.2, 0.18)


if __name__ == "__main__":
    write("plug.wav", plug())
    write("unplug.wav", unplug())
    write("open.wav", opening())
    write("close.wav", closing())
