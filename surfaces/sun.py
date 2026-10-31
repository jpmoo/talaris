# SPDX-License-Identifier: GPL-3.0-only
# Copyright (c) 2026 Jeff Moore
"""
When the sun rises and sets, for a day and a place: NOAA's sunrise equation,
worked here rather than asked of anyone — the light-and-dark theme and the
night light need only a rough place (location.py) and no network.

Pure: numbers in, times out. Good to a minute or two, which is all a theme
changing at sunset asks.
"""

from __future__ import annotations

import math
from datetime import date, datetime, timedelta, timezone

#: The sun's centre this far below the horizon, with the air's bending: "risen" and "set".
ZENITH = 90.833


def _times(day: date, lat: float, lon: float) -> tuple[datetime | None, datetime | None, str]:
    """Sunrise and sunset in UTC; ("", …) normal, "day" or "night" when the sun neither rises nor sets."""
    n = day.timetuple().tm_yday
    out = []
    for rising in (True, False):
        lng_hour = lon / 15
        t = n + ((6 if rising else 18) - lng_hour) / 24
        m = 0.9856 * t - 3.289
        sun_lon = (m + 1.916 * math.sin(math.radians(m)) + 0.020 * math.sin(math.radians(2 * m)) + 282.634) % 360
        ra = math.degrees(math.atan(0.91764 * math.tan(math.radians(sun_lon)))) % 360
        ra += (math.floor(sun_lon / 90) * 90) - (math.floor(ra / 90) * 90)
        ra /= 15
        sin_dec = 0.39782 * math.sin(math.radians(sun_lon))
        cos_dec = math.cos(math.asin(sin_dec))
        cos_h = (math.cos(math.radians(ZENITH)) - sin_dec * math.sin(math.radians(lat))) / (cos_dec * math.cos(math.radians(lat)))
        if cos_h > 1:
            return None, None, "night"  # the sun never rises today
        if cos_h < -1:
            return None, None, "day"  # the sun never sets today
        h = (360 - math.degrees(math.acos(cos_h))) if rising else math.degrees(math.acos(cos_h))
        local_mean = h / 15 + ra - 0.06571 * t - 6.622
        utc_hours = (local_mean - lng_hour) % 24
        out.append(datetime(day.year, day.month, day.day, tzinfo=timezone.utc) + timedelta(hours=utc_hours))
    rise, set_ = out
    return rise, set_, ""


def sun_times(day: date, lat: float, lon: float) -> tuple[datetime | None, datetime | None, str]:
    """
    Sunrise and sunset for the local `day` at a place, as aware datetimes in
    UTC, with sunset after sunrise (on the following UTC day if need be). In
    a polar day or night, (None, None, "day"|"night").
    """
    rise, set_, polar = _times(day, lat, lon)
    if polar:
        return None, None, polar
    # Far west, the UTC hours can wrap: sunrise and sunset kept within the same local day, set after rise.
    if set_ <= rise:
        set_ += timedelta(days=1)
    return rise, set_, ""


def is_day(now: datetime, lat: float, lon: float) -> bool:
    """Whether the sun is up, at `now` (aware), at a place."""
    local = now.astimezone()
    for d in (local.date() - timedelta(days=1), local.date(), local.date() + timedelta(days=1)):
        rise, set_, polar = sun_times(d, lat, lon)
        if polar:
            if d == local.date():
                return polar == "day"
            continue
        if rise <= now < set_:
            return True
    return False


def next_change(now: datetime, lat: float, lon: float) -> datetime | None:
    """The next sunrise or sunset after `now`; None in a polar day or night with none in the next two days."""
    local = now.astimezone()
    ahead = []
    for i in range(-1, 3):
        rise, set_, _ = sun_times(local.date() + timedelta(days=i), lat, lon)
        ahead += [t for t in (rise, set_) if t and t > now]
    return min(ahead) if ahead else None
