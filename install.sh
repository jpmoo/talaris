#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-only
# Copyright (c) 2026 Jeff Moore
#
# Build Talaris and install its user services. Everything that can fail is
# checked or built first, so a failure leaves the installed services as they
# were rather than pointing at something half-made.
set -euo pipefail
ROOT="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
NODE="$(command -v node || true)"

[ -n "$NODE" ] || { echo "install: node is not on PATH" >&2; exit 1; }
major="$("$NODE" -p 'process.versions.node.split(".")[0]')"
[ "$major" -ge 22 ] || { echo "install: node 22 or later is needed (found $major)" >&2; exit 1; }
command -v pnpm >/dev/null || { echo "install: pnpm is not on PATH" >&2; exit 1; }

echo "==> Building"
(cd "$ROOT" && pnpm install --frozen-lockfile && pnpm -r build)

echo "==> Installing talaris-core.service"
UNITS="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
mkdir -p "$UNITS"
sed -e "s#__NODE__#$NODE#g" -e "s#__ROOT__#$ROOT#g" "$ROOT/systemd/talaris-core.service.in" > "$UNITS/talaris-core.service"
systemctl --user daemon-reload
systemctl --user enable --now talaris-core.service
systemctl --user restart talaris-core.service

echo "==> Installing talaris-surfaces.service and talaris.conf"
sed -e "s#__ROOT__#$ROOT#g" "$ROOT/systemd/talaris-surfaces.service.in" > "$UNITS/talaris-surfaces.service"
systemctl --user daemon-reload
HYPR="${XDG_CONFIG_HOME:-$HOME/.config}/hypr"
if [ -d "$HYPR" ]; then
  # Written, never edited: hyprland.conf is yours. This file is Talaris's,
  # and one `source =` line in hyprland.conf is what turns it on.
  cat > "$HYPR/talaris.conf" <<CONF
# Written by $ROOT/install.sh — changes here are overwritten.
# Talaris's surfaces need the compositor's environment, so it is handed to the
# user manager first, then the service is started — and with it what Talaris
# borrows rather than builds (DESIGN.md, "What Talaris borrows"): the polkit
# agent, without which password prompts quietly never appear, and hyprpaper
# for the wallpaper. Notifications are mako's until Talaris holds the bus;
# mako starts itself the first time something notifies.
exec-once = systemctl --user import-environment WAYLAND_DISPLAY HYPRLAND_INSTANCE_SIGNATURE XDG_CURRENT_DESKTOP QT_SCALE_FACTOR && systemctl --user start talaris-surfaces.service hyprpolkitagent.service hyprpaper.service
CONF
  # hyprpaper's own file, only if there is none and a picture was named
  # (TALARIS_WALLPAPER): the wallpaper is yours, and a file you have is kept.
  if [ ! -e "$HYPR/hyprpaper.conf" ] && [ -n "${TALARIS_WALLPAPER:-}" ]; then
    cat > "$HYPR/hyprpaper.conf" <<CONF
# Written once by $ROOT/install.sh; yours to change.
wallpaper {
    monitor =
    path = $TALARIS_WALLPAPER
    fit_mode = cover
}
splash = false
CONF
  fi
  # mako in Talaris's default look, only if it has no settings of its own.
  MAKO="${XDG_CONFIG_HOME:-$HOME/.config}/mako"
  if [ ! -e "$MAKO/config" ]; then
    mkdir -p "$MAKO"
    cp "$ROOT/systemd/mako.config" "$MAKO/config"
  fi
  if ! grep -qs 'talaris.conf' "$HYPR/hyprland.conf"; then
    echo "    To start Talaris with Hyprland, add this line to the end of $HYPR/hyprland.conf:"
    echo "      source = $HYPR/talaris.conf"
  fi
fi

echo "==> Asking the socket"
SOCK="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/talaris.sock"
for _ in $(seq 1 20); do
  if curl -sf --unix-socket "$SOCK" http://talaris/health >/dev/null 2>&1; then
    curl -s --unix-socket "$SOCK" http://talaris/health; echo
    exit 0
  fi
  sleep 0.25
done
echo "install: talaris-core did not answer on $SOCK — see journalctl --user -u talaris-core" >&2
exit 1
