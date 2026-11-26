#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-only
# Copyright (c) 2026 Jeff Moore
#
# Build Talaris and install its user services. Everything that can fail is
# checked or built first, so a failure leaves the installed services as they
# were rather than pointing at something half-made.
#
#   ./install.sh            check what Talaris needs, offer to install what is missing, then install Talaris
#   ./install.sh --check    only say what is missing; change nothing
#   ./install.sh --yes      install what is required without asking (the optional, only if asked for too)
#   ./install.sh --optional install the optional packages as well
#   ./install.sh --no-deps  skip the check (another distribution, or you have seen to it)
#   ./install.sh --one-desktop / --own-desktops
#                           projects on one desktop, or each on its own (asked, the first time, if not said)
set -euo pipefail
ROOT="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"

CHECK_ONLY=0 YES=0 OPTIONAL=0 DEPS=1 DESKTOPS=""
for arg in "$@"; do
  case "$arg" in
    --check) CHECK_ONLY=1 ;;
    --yes|-y) YES=1 ;;
    --optional) OPTIONAL=1 ;;
    --no-deps) DEPS=0 ;;
    --one-desktop) DESKTOPS=one ;;
    --own-desktops) DESKTOPS=own ;;
    *) echo "install: unknown option $arg (--check, --yes, --optional, --no-deps, --one-desktop, --own-desktops)" >&2; exit 2 ;;
  esac
done

# ---------------------------------------------------------------- what Talaris needs
#
# Each package with what it is for, as the code uses it: the surfaces (Python,
# Qt and its web engine, layer-shell), the core's helpers, and what Talaris
# borrows rather than builds (DESIGN.md) — the calendar's Evolution Data
# Server and GNOME Online Accounts, PipeWire's volume, NetworkManager, grim,
# Hyprland's idle, wallpaper and polkit helpers. The optional ones add a
# feature each; without them that feature is quietly not there.
REQUIRED=(
  "python3-gi|Python's GLib bindings (the calendar, the tray)"
  "python3-pil|pictures: screenshots, thumbnails"
  "python3-pyside6.qtcore|Qt for Python"
  "python3-pyside6.qtgui|Qt for Python"
  "python3-pyside6.qtwidgets|Qt for Python"
  "python3-pyside6.qtnetwork|Qt for Python"
  "python3-pyside6.qtwebchannel|Qt for Python: pages talking to Talaris"
  "python3-pyside6.qtwebenginecore|Qt's web engine: every panel"
  "python3-pyside6.qtwebenginewidgets|Qt's web engine: every panel"
  "liblayershellqtinterface6|the bar, the dock and the panels as layer surfaces"
  "gir1.2-ecal-2.0|the calendar (Evolution Data Server)"
  "gir1.2-edataserver-1.2|the calendar (Evolution Data Server)"
  "gir1.2-ebook-1.2|contacts (Evolution Data Server)"
  "gir1.2-ebookcontacts-1.2|contacts (Evolution Data Server)"
  "gir1.2-goa-1.0|accounts (GNOME Online Accounts)"
  "gnome-online-accounts-gtk|adding Google, Microsoft and other accounts"
  "evolution-ews|Microsoft 365 calendars"
  "libglib2.0-bin|gdbus, gio, gsettings: notifications, trash, settings"
  "libnotify-bin|notify-send"
  "xdg-utils|opening files and links"
  "xdg-user-dirs|where Pictures and the rest are"
  "xdg-desktop-portal-hyprland|file choosers and screen sharing"
  "wl-clipboard|the clipboard and its history"
  "grim|screenshots, and thumbnails of windows"
  "wireplumber|volume (wpctl)"
  "network-manager|Wi-Fi (nmcli)"
  "upower|the battery"
  "brightnessctl|screen brightness"
  "procps|pgrep"
  "zenity|file choosers (attachments, backups, settings)"
  "curl|asking the core"
  "jq|moving windows by Super+Shift and the arrows (bin/move-or-split)"
  "hypridle|locking and screens off when idle"
  "hyprlock|the lock screen"
  "hyprpaper|the wallpaper"
  "hyprpolkitagent|password prompts"
  "mako-notifier|notifications until Talaris holds them"
)
OPTIONALS=(
  "bluez|Bluetooth"
  "gammastep|the night light"
  "power-profiles-daemon|power profiles (Settings, Power)"
  "poppler-utils|reading PDFs, for search by meaning"
  "tesseract-ocr|reading the words in pictures and scans"
  "libreoffice-common|reading office documents (large)"
  "fprintd|fingerprints"
  "pkexec|setting where you are for the whole system (Location)"
  "hyprland-plugin-hyprscrolling|Carousel tiling (Settings, Windows), the windows in a sliding strip"
  "resources/gnome-system-monitor/mission-center|a task manager, opened from the power menu (any one of these)"
)

missing() {  # the packages of a list not installed, one a line: name|what for. a/b/c: any one of them will do
  local entry pkg have names
  for entry in "$@"; do
    have=0 names="${entry%%|*}"
    for pkg in ${names//\// }; do
      dpkg-query -W -f='${Status}' "$pkg" 2>/dev/null | grep -q "install ok installed" && have=1
    done
    [ "$have" = 1 ] || echo "$entry"
  done
}
ask() {  # yes or no, Enter giving the default
  local prompt="$1" default="$2" reply
  [ -t 0 ] || { [ "$default" = y ]; return; }
  read -r -p "$prompt " reply || reply=""
  reply="${reply:-$default}"
  [[ "$reply" =~ ^[Yy] ]]
}
# Projects on their own desktops, or all on one (docs/DESIGN.md, *One desktop*): asked the first time only —
# afterwards it is Settings, Look and feel, "Projects". One desktop is always the carousel, so its plugin is required.
CONFIG_FILE="${TALARIS_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/talaris}/config.json"
if [ -z "$DESKTOPS" ] && [ "$CHECK_ONLY" = 0 ] && [ -t 0 ] && ! grep -qs '"desktops"' "$CONFIG_FILE"; then
  echo "==> Projects: each on its own desktop, or all on one?"
  echo "    Own desktops: going to a project goes to its desktop, its windows waiting there."
  echo "    One desktop:  every window stays in one place; choosing a project changes what the panels show."
  read -r -p "    Own or one? [own] " reply || reply=""
  [[ "${reply:-own}" =~ ^[Oo][Nn][Ee] ]] && DESKTOPS=one || DESKTOPS=own
fi
if [ "$DESKTOPS" = one ]; then
  REQUIRED+=("hyprland-plugin-hyprscrolling|One desktop: its windows in a sliding strip, the carousel")
  KEEP=(); for entry in "${OPTIONALS[@]}"; do [[ "$entry" == hyprland-plugin-hyprscrolling\|* ]] || KEEP+=("$entry"); done
  OPTIONALS=("${KEEP[@]}")
fi
show() { local entry; for entry in "$@"; do printf '    %-38s %s\n' "${entry%%|*}" "${entry#*|}"; done; }

# The screen's brightness: brightnessctl writes the backlight's file, which
# belongs to the `video` group. A user outside it gets the brightness keys'
# level shown but never changed (a new machine's account often is not in it).
backlight_group() {
  local f g
  f="$(ls /sys/class/backlight/*/brightness 2>/dev/null | head -n1)"
  [ -n "$f" ] && [ ! -w "$f" ] || return 1
  g="$(stat -c %G "$f")"
  [ "$g" != root ] && ! id -nG | tr ' ' '\n' | grep -qx "$g" && echo "$g"
}

if [ "$DEPS" = 1 ]; then
  echo "==> Checking what Talaris needs"
  if ! command -v dpkg-query >/dev/null || ! command -v apt-get >/dev/null; then
    echo "    Not a Debian or Ubuntu system: install these yourself, then run with --no-deps."
    show "${REQUIRED[@]}"
    [ "$CHECK_ONLY" = 1 ] && exit 0
    exit 1
  fi
  mapfile -t NEED < <(missing "${REQUIRED[@]}")
  mapfile -t COULD < <(missing "${OPTIONALS[@]}")
  if [ ${#NEED[@]} -eq 0 ]; then echo "    Everything required is installed."; else
    echo "    Required, not installed:"; show "${NEED[@]}"; fi
  if [ ${#COULD[@]} -gt 0 ]; then echo "    Optional, not installed (each adds what it says):"; show "${COULD[@]}"; fi
  if [ "$CHECK_ONLY" = 1 ]; then
    command -v node >/dev/null || echo "    node 22 or later: not on PATH"
    command -v pnpm >/dev/null || echo "    pnpm: not on PATH"
    g="$(backlight_group || true)"; [ -n "$g" ] && echo "    brightness keys: you are not in the $g group (sudo usermod -aG $g $USER, then log in again)"
    exit 0
  fi
  TO=()
  if [ ${#NEED[@]} -gt 0 ]; then
    if [ "$YES" = 1 ] || ask "    Install the required packages now (sudo apt install)? [Y/n]" y; then
      for entry in "${NEED[@]}"; do TO+=("${entry%%|*}"); done
    else
      echo "install: Talaris needs them; run again when they are installed." >&2; exit 1
    fi
  fi
  if [ ${#COULD[@]} -gt 0 ]; then
    if [ "$OPTIONAL" = 1 ] || { [ "$YES" = 0 ] && ask "    Install the optional ones too? [y/N]" n; }; then
      # Of alternatives (a/b/c), the first.
      for entry in "${COULD[@]}"; do names="${entry%%|*}"; TO+=("${names%%/*}"); done
    fi
  fi
  if [ ${#TO[@]} -gt 0 ]; then
    echo "==> sudo apt-get install ${TO[*]}"
    sudo apt-get update -qq
    sudo apt-get install -y "${TO[@]}"
  fi
  # A convertible (an accelerometer, and Intel's HID driver): the firmware says when it is folded back into a
  # tablet, but Linux reports it only when told to, and the switch is readable only by root. Talaris needs both —
  # to follow the screen's turning only as a tablet, and to know which it is after a sleep (rotation.py).
  if ls /sys/bus/acpi/devices/ 2>/dev/null | grep -q '^INTC1070' && ls /sys/bus/iio/devices/*/in_accel_x_raw >/dev/null 2>&1 \
     && [ ! -e /etc/udev/rules.d/70-talaris-tablet.rules ]; then
    echo "    This machine folds into a tablet. Talaris can tell which it is, given two system settings:"
    echo "      /etc/modprobe.d/intel-hid-tablet.conf     the firmware's tablet switch reported"
    echo "      /etc/udev/rules.d/70-talaris-tablet.rules  that switch readable by whoever is at the screen"
    if [ "$YES" = 1 ] || ask "    Set them now (sudo)? [Y/n]" y; then
      echo "options intel_hid enable_sw_tablet_mode=1" | sudo tee /etc/modprobe.d/intel-hid-tablet.conf >/dev/null
      printf '%s\n' 'SUBSYSTEM=="input", KERNEL=="event*", ATTRS{name}=="Intel HID switches", TAG+="uaccess"' \
        | sudo tee /etc/udev/rules.d/70-talaris-tablet.rules >/dev/null
      sudo udevadm control --reload && sudo udevadm trigger --subsystem-match=input
      echo "    Set. In effect after the next restart of the machine (or reload intel_hid now)."
    fi
  fi
  # A touchscreen: three fingers across it slide the Carousel (gestures.py). Its events are readable only by the
  # input group, which reads every keyboard too; this rule gives whoever is at the screen the touchscreens alone.
  if grep -q 'ID_INPUT_TOUCHSCREEN=1' /run/udev/data/c13:* 2>/dev/null && [ ! -e /etc/udev/rules.d/70-talaris-touch.rules ]; then
    echo "    This machine has a touchscreen. For swiping the Carousel, Talaris reads it, given one system setting:"
    echo "      /etc/udev/rules.d/70-talaris-touch.rules  touchscreens readable by whoever is at the screen"
    if [ "$YES" = 1 ] || ask "    Set it now (sudo)? [Y/n]" y; then
      printf '%s\n' 'SUBSYSTEM=="input", KERNEL=="event*", ENV{ID_INPUT_TOUCHSCREEN}=="1", TAG+="uaccess"' \
        | sudo tee /etc/udev/rules.d/70-talaris-touch.rules >/dev/null
      sudo udevadm control --reload && sudo udevadm trigger --subsystem-match=input
      echo "    Set."
    fi
  fi
  # A screen pen whose quick taps were lost: it says it is near and touching at once, and Hyprland drops the touch.
  # setup/pen/talaris-pen holds such a touch back until the coming near has been said.
  if [ ! -e /etc/systemd/system/talaris-pen.service ] && python3 -I -c "
import runpy, sys
sys.exit(0 if runpy.run_path('$ROOT/setup/pen/talaris-pen', run_name='talaris_pen')['find']() else 1)" 2>/dev/null; then
    echo "    This machine has a screen pen. Talaris has a helper so its quick taps register (a system service):"
    echo "      setup/pen/install.sh  copies it to /usr/local/lib/talaris and runs it as talaris-pen.service"
    if [ "$YES" = 1 ] || ask "    Put it in now (sudo)? [Y/n]" y; then
      sudo "$ROOT/setup/pen/install.sh"
    fi
  fi
  BL="$(backlight_group || true)"
  if [ -n "$BL" ]; then
    echo "    The brightness keys need you in the $BL group, which owns the screen's backlight."
    if [ "$YES" = 1 ] || ask "    Add $USER to $BL now (sudo usermod -aG $BL $USER)? [Y/n]" y; then
      sudo usermod -aG "$BL" "$USER"
      echo "    Added: log out and in again for it to take effect."
    fi
  fi
fi

# Node and pnpm are not taken from apt: Ubuntu's own node is often older than the 22 the core needs.
NODE="$(command -v node || true)"
[ -n "$NODE" ] || { echo "install: node 22 or later is needed and is not on PATH (https://nodejs.org, or nvm)" >&2; exit 1; }
major="$("$NODE" -p 'process.versions.node.split(".")[0]')"
[ "$major" -ge 22 ] || { echo "install: node 22 or later is needed (found $major)" >&2; exit 1; }
command -v pnpm >/dev/null || { echo "install: pnpm is not on PATH (corepack enable pnpm, or npm install -g pnpm)" >&2; exit 1; }

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
cp "$ROOT/systemd/talaris-session.target" "$UNITS/talaris-session.target"
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
# Then what is set to start at login (~/.config/autostart: Nextcloud,
# 1Password), through talaris-session.target: a desktop session starts
# those, and Hyprland alone does not.
# Restarted, not started, after their failures are cleared: the user manager
# outlives a session, and at the next login it may already have started them
# with the last session's display — hyprpaper crashes on a display that is
# gone, and after a few tries systemd refuses to start it at all.
exec-once = systemctl --user import-environment WAYLAND_DISPLAY HYPRLAND_INSTANCE_SIGNATURE XDG_CURRENT_DESKTOP QT_SCALE_FACTOR && systemctl --user reset-failed talaris-surfaces.service hyprpolkitagent.service hyprpaper.service; systemctl --user restart talaris-surfaces.service hyprpolkitagent.service hyprpaper.service; systemctl --user stop talaris-session.target; systemctl --user start talaris-session.target
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
    echo "    What to leave out of it, because Talaris does it: $ROOT/examples/hyprland.conf"
  fi
fi

# The choice of desktops, kept in Talaris's settings beside what is there (config.py reads it).
if [ -n "$DESKTOPS" ] && [ "$CHECK_ONLY" = 0 ]; then
  mkdir -p "$(dirname "$CONFIG_FILE")"
  python3 - "$CONFIG_FILE" "$DESKTOPS" <<'PY'
import json, os, sys
path, mode = sys.argv[1], sys.argv[2]
try:
    with open(path, encoding="utf-8") as f:
        config = json.load(f)
except (OSError, ValueError):
    config = {}
config.setdefault("projects", {})["desktops"] = mode
tmp = path + ".tmp"
with open(tmp, "w", encoding="utf-8") as f:
    json.dump(config, f, indent=2)
    f.write("\n")
os.replace(tmp, path)
PY
  echo "==> Projects: $([ "$DESKTOPS" = one ] && echo "one desktop" || echo "each its own desktop") (Settings, Look and feel, to change)"
fi

# Talaris's own desktop file: its windows (a panel made a window) are known by
# it in the dock, and the desktop portal knows the app id "talaris" by it.
APPS="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
mkdir -p "$APPS"
cat > "$APPS/talaris.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=Talaris
Comment=The desktop: bar, dock, projects, canvas and writing
Exec=$ROOT/surfaces/talaris-surfaces
Icon=$ROOT/surfaces/ui/talaria.svg
StartupWMClass=talaris
NoDisplay=true
DESKTOP

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
