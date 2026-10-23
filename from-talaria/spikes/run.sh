#!/usr/bin/env bash
# Start the layer-canvas spike the way the desktop starts things, and bind its
# swap key for this session only. See layer_canvas.py for why each line is here.
#
#   run.sh        start it (bottom layer), bind Super+Alt+C to swap
#   run.sh stop   stop it and remove the bind
#   run.sh swap | bottom   what the bind does, and the forced way back
set -euo pipefail
HERE="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
DIR="${XDG_CACHE_HOME:-$HOME/.cache}/talaria-spike"
LIB="$DIR/lsq/usr/lib/x86_64-linux-gnu"

if [ "${1:-}" = stop ]; then
  hyprctl keyword unbind "SUPER ALT, C" >/dev/null || true
  systemctl --user stop talaria-canvas-spike.scope 2>/dev/null || true
  exit 0
fi

if [ "${1:-}" = swap ]; then kill -USR1 "$(cat "$DIR/pid")"; exit; fi
if [ "${1:-}" = bottom ]; then kill -USR2 "$(cat "$DIR/pid")"; exit; fi

if [ "${1:-}" = inner ]; then
  export SPIKE_DIR="$DIR" SPIKE_LSQ="$LIB/libLayerShellQtInterface.so.6"
  export LD_LIBRARY_PATH="$LIB" QT_PLUGIN_PATH="$LIB/qt6/plugins"
  export QT_QPA_PLATFORM=wayland QT_WAYLAND_SHELL_INTEGRATION=layer-shell
  exec python3 "$HERE/layer_canvas.py" >>"$DIR/log.txt" 2>&1
fi

[ -e "$LIB/libLayerShellQtInterface.so.6" ] || {
  echo "LayerShellQt is not unpacked in $DIR/lsq" >&2; exit 1; }
# A compositor bind, so the way back works whatever is covering the screen.
# Runtime only: a config reload drops it, and so does `run.sh stop`.
hyprctl keyword bind "SUPER ALT, C, exec, kill -USR1 \$(cat $DIR/pid)" >/dev/null
hyprctl dispatch exec "systemd-run --user --scope --unit=talaria-canvas-spike -- $HERE/run.sh inner" >/dev/null
