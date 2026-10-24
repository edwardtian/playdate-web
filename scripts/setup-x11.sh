#!/usr/bin/env bash
# Extracts Xvfb + xdotool into vendor/x11 without needing root.
# The Playdate Simulator is a GTK/WebKit app, so we run it on a virtual X
# display and capture its 400x240 framebuffer.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
VENDOR="$ROOT/vendor/x11"
DEBS="$ROOT/webapp/storage/tmp/debs"

mkdir -p "$DEBS" "$VENDOR"

cd "$DEBS"
apt-get download \
  xvfb \
  xserver-common \
  xkb-data \
  xdotool \
  libxdo3 \
  x11-utils

for deb in *.deb; do
  dpkg-deb -x "$deb" "$VENDOR"
done

rm -rf "$DEBS"
echo "X11 tools installed under $VENDOR"
echo "Verify: $VENDOR/usr/bin/Xvfb --help"
