# SPDX-License-Identifier: GPL-3.0-only
# Copyright (c) 2026 Jeff Moore
"""The code in a text, or none (otp.py): run with `python3 surfaces/test_otp.py`, and by `pnpm test`."""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from otp import find_code  # noqa: E402

CASES = [
    # A code, said as one.
    ("Your verification code is 482913. Don't share it.", "482913"),
    ("G-583920 is your Google verification code.", "583920"),
    ("Your Apple ID code is: 739104\n\n@apple.com #739104 %apple.com", "739104"),
    ("Use code 123 456 to sign in to Example.", "123456"),
    ("Chase: 70412953 is your one-time passcode. It expires in 10 minutes.", "70412953"),
    ("Your login code: AB3D9F", "AB3D9F"),
    ("Tu código de verificación es 551204", "551204"),
    # Not a code: no word saying so, a promotion, a link, a year, or two to choose between.
    ("See you at 1530 by the garden gate", None),
    ("Use promo code SAVE20 for 20% off this weekend!", None),
    ("Your order 88213 has shipped: https://example.com/t/AB12CD34", None),
    ("Your code will arrive in 2026", None),
    ("Your code is 482913 or maybe 551204, try both", "482913"),
    ("Security alert: codes 4821 and 9930 were used", None),
    ("", None),
    (None, None),
]


def main() -> int:
    failed = 0
    for text, want in CASES:
        got = find_code(text)
        if got != want:
            failed += 1
            print(f"not ok: {text!r} → {got!r}, wanted {want!r}")
    print(f"otp: {len(CASES) - failed} of {len(CASES)} right")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
