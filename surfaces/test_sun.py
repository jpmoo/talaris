# SPDX-License-Identifier: GPL-3.0-only
# Copyright (c) 2026 Jeff Moore
"""Sunrise and sunset (sun.py), against published times: run with `python3 surfaces/test_sun.py`, and by `pnpm test`."""

import os
import sys
from datetime import date, datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from sun import is_day, next_change, sun_times  # noqa: E402

UTC = timezone.utc
failed = 0


def check(name: str, ok: bool, said: str = "") -> None:
    global failed
    if not ok:
        failed += 1
        print(f"not ok: {name} {said}")


def near(a: datetime, b: datetime, minutes: int = 4) -> bool:
    return abs((a - b).total_seconds()) <= minutes * 60


# New York, midsummer: sunrise 09:25 UTC, sunset 00:31 UTC the next day (5:25 am and 8:31 pm EDT).
rise, set_, _ = sun_times(date(2026, 6, 21), 40.71, -74.01)
check("New York sunrise", near(rise, datetime(2026, 6, 21, 9, 25, tzinfo=UTC)), str(rise))
check("New York sunset", near(set_, datetime(2026, 6, 22, 0, 31, tzinfo=UTC)), str(set_))
# London, midwinter: 08:04 and 15:53 UTC.
rise, set_, _ = sun_times(date(2026, 12, 21), 51.51, -0.13)
check("London sunrise", near(rise, datetime(2026, 12, 21, 8, 4, tzinfo=UTC)), str(rise))
check("London sunset", near(set_, datetime(2026, 12, 21, 15, 53, tzinfo=UTC)), str(set_))
# Sydney, its midwinter: up at noon local (02:00 UTC), down at 22:00 local (12:00 UTC); its sunrise is the UTC day before.
check("Sydney day at local noon", is_day(datetime(2026, 6, 21, 2, 0, tzinfo=UTC), -33.87, 151.21))
check("Sydney night at 10pm local", not is_day(datetime(2026, 6, 21, 12, 0, tzinfo=UTC), -33.87, 151.21))
# New York: day at 3 pm EDT, night at 11 pm EDT.
check("New York afternoon", is_day(datetime(2026, 6, 21, 19, 0, tzinfo=UTC), 40.71, -74.01))
check("New York late night", not is_day(datetime(2026, 6, 22, 3, 0, tzinfo=UTC), 40.71, -74.01))
# Tromsø, midsummer: the sun never sets.
check("Tromsø polar day", sun_times(date(2026, 6, 21), 69.65, 18.96)[2] == "day")
check("Tromsø up at midnight", is_day(datetime(2026, 6, 21, 22, 0, tzinfo=UTC), 69.65, 18.96))
# The next change after a New York afternoon is that evening's sunset.
nxt = next_change(datetime(2026, 6, 21, 19, 0, tzinfo=UTC), 40.71, -74.01)
check("next change is sunset", nxt is not None and near(nxt, datetime(2026, 6, 22, 0, 31, tzinfo=UTC)), str(nxt))
check("next change is after now", nxt is not None and nxt - datetime(2026, 6, 21, 19, 0, tzinfo=UTC) < timedelta(hours=6))

print(f"sun: {12 - failed} of 12 right")
sys.exit(1 if failed else 0)
