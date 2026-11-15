#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-only
# Copyright (c) 2026 Jeff Moore
#
# The pen helper (talaris-pen), for a screen pen whose quick taps are lost: copied to a root-owned place — never run
# as root from a folder of yours, which anything of yours could change — and run as a system service.
#
#   sudo setup/pen/install.sh            put it in, and start it
#   sudo setup/pen/install.sh --remove   take it out
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "run with sudo"; exit 1; }
here="$(cd "$(dirname "$0")" && pwd)"
if [ "${1:-}" = "--remove" ]; then
  systemctl disable --now talaris-pen.service 2>/dev/null || true
  rm -f /etc/systemd/system/talaris-pen.service /usr/local/lib/talaris/talaris-pen
  systemctl daemon-reload
  echo "The pen helper is gone; the pen is as the system gives it."
  exit 0
fi
install -D -m 0755 -o root -g root "$here/talaris-pen" /usr/local/lib/talaris/talaris-pen
install -D -m 0644 -o root -g root "$here/talaris-pen.service" /etc/systemd/system/talaris-pen.service
systemctl daemon-reload
systemctl enable --now talaris-pen.service
sleep 1
systemctl --no-pager --lines=3 status talaris-pen.service | sed -n '1,3p;/talaris-pen:/p'
