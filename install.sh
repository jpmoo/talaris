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
