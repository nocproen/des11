#!/usr/bin/env bash
# Native dependencies used by nocproen/des11 (Debian/Ubuntu).
set -euo pipefail
sudo -n apt-get update -qq
sudo -n env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends \
  -o DPkg::Lock::Timeout=180 \
  tigervnc-standalone-server openbox dbus-x11 x11-utils x11-xserver-utils \
  xfonts-base xterm fonts-dejavu-core xdg-utils xclip \
  chromium chromium-l10n fonts-noto-cjk fonts-noto-color-emoji
npx playwright-core install chromium
