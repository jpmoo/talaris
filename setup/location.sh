#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-only
# Copyright (c) 2026 Jeff Moore
#
# Talaris's Location (Settings, Location), set up once on this machine. Needs
# sudo, so it is yours to run; it says what it writes, and --undo takes it away.
#
#   1. GeoClue lets Talaris be its agent — the desktop that asks you before an
#      application learns where you are. Without it, apps asking are refused:
#      /etc/geoclue/conf.d/90-talaris.conf, adding "talaris" to the agents
#      GeoClue already allows.
#   2. You may set the time zone without a password, so Talaris can keep it
#      where you are as you travel: /etc/polkit-1/rules.d/50-talaris-timezone.rules
#      — that one action only, for a member of sudo (or wheel) at this machine.
#
#   setup/location.sh          set up
#   setup/location.sh --undo   both files removed
set -euo pipefail

AGENTS=/etc/geoclue/conf.d/90-talaris.conf
ZONE=/etc/polkit-1/rules.d/50-talaris-timezone.rules

if [ "${1:-}" = "--undo" ]; then
  sudo rm -f "$AGENTS" "$ZONE"
  sudo systemctl try-restart geoclue.service 2>/dev/null || true
  echo "Removed $AGENTS and $ZONE."
  exit 0
fi

# GeoClue's agents are one list, replaced whole by a file here: the ones it allows already, and Talaris.
allowed=$(sed -n '/^\[agent\]/,/^\[/{s/^whitelist=//p}' /etc/geoclue/geoclue.conf | head -1)
case ";$allowed;" in *";talaris;"*) list="$allowed" ;; *) list="${allowed:+$allowed;}talaris" ;; esac

echo "==> $AGENTS"
sudo install -d -m 755 /etc/geoclue/conf.d
printf '# Talaris (setup/location.sh): GeoClue'"'"'s agent on this desktop.\n[agent]\nwhitelist=%s\n' "$list" | sudo tee "$AGENTS" >/dev/null
sudo chmod 644 "$AGENTS"

echo "==> $ZONE"
sudo install -d -m 755 /etc/polkit-1/rules.d
sudo tee "$ZONE" >/dev/null <<'EOF'
// Talaris (setup/location.sh): the time zone kept where you are, without a password each time.
// Setting the time zone only, by a member of sudo or wheel at this machine.
polkit.addRule(function (action, subject) {
  if (action.id == "org.freedesktop.timedate1.set-timezone" && subject.local && subject.active &&
      (subject.isInGroup("sudo") || subject.isInGroup("wheel"))) {
    return polkit.Result.YES;
  }
});
EOF
sudo chmod 644 "$ZONE"

# GeoClue reads its configuration as it starts.
sudo systemctl try-restart geoclue.service 2>/dev/null || true
echo "Done. Turn Location on in Talaris Settings; Talaris becomes GeoClue's agent as it next starts (or now, if it is running: it tries again)."
