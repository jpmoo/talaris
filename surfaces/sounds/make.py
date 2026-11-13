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


def plug() -> list[float]:
    """Power connected: a soft upward glide that settles into a glassy, detuned chime."""
    n = int(RATE * 0.75)
    out = [0.0] * n
    # The glide: 420 → 1260 Hz over 140 ms, eased, with a quick swell in and out.
    phase = 0.0
    glide = int(RATE * 0.14)
    for i in range(glide):
        t = i / glide
        f = 420 * (3 ** (t * t * (3 - 2 * t)))
        phase += 2 * math.pi * f / RATE
        env = math.sin(math.pi * t) ** 2
        out[i] += 0.35 * env * (math.sin(phase) + 0.25 * math.sin(2 * phase))
    # The chime: two slightly detuned partials and a fifth, ringing out.
    start = int(RATE * 0.11)
    for i in range(n - start):
        t = i / RATE
        attack = min(1.0, t / 0.006)
        decay = math.exp(-t * 6.5)
        shimmer = 1 + 0.04 * math.sin(2 * math.pi * 7 * t)
        s = (math.sin(2 * math.pi * 1260 * t) + math.sin(2 * math.pi * 1263.5 * t)) * 0.5
        s += 0.35 * math.sin(2 * math.pi * 1890 * t) * math.exp(-t * 9)
        s += 0.12 * math.sin(2 * math.pi * 2520 * t) * math.exp(-t * 14)
        out[start + i] += 0.42 * attack * decay * shimmer * s
    # A faint echo, a room the sound is in.
    for delay, gain in ((int(RATE * 0.085), 0.22), (int(RATE * 0.17), 0.1)):
        for i in range(n - 1, delay - 1, -1):
            out[i] += gain * out[i - delay]
    # A breath of air on the attack, so it is not a pure test tone.
    rnd = random.Random(7)
    for i in range(int(RATE * 0.05)):
        out[start + i] += 0.02 * (rnd.random() * 2 - 1) * (1 - i / (RATE * 0.05))
    # Quiet on purpose: well under full scale, so the system volume is the loudest it gets.
    peak = max(abs(s) for s in out) or 1.0
    fade = int(RATE * 0.05)
    return [s / peak * 0.3 * (min(1.0, (n - i) / fade)) for i, s in enumerate(out)]


if __name__ == "__main__":
    write("plug.wav", plug())
