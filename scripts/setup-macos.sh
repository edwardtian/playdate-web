#!/usr/bin/env bash
# macOS setup for the Playdate Web Simulator.
# Verifies prerequisites and prints the manual steps that require a GUI.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WEBAPP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
WORKSPACE_DIR="$(cd "$WEBAPP_DIR/.." && pwd)"

# Same resolution as server/config.js: explicit env first, then the SDK root.
SDK_PATH="${PLAYDATE_SDK_PATH:-$WORKSPACE_DIR}"
SIM_APP_ENV="${PLAYDATE_SIM_APP:-}"

echo "=== Playdate Web Simulator — macOS setup ==="
echo

MISSING=0

check() {
  local name="$1" cmd="$2" hint="${3:-brew install $2}"
  if command -v "$cmd" >/dev/null 2>&1; then
    printf '  [ok]      %s (%s)\n' "$name" "$(command -v "$cmd")"
  else
    printf '  [MISSING] %s — %s\n' "$name" "$hint"
    MISSING=1
  fi
}

echo "1. Required tools"
check node node
check osascript osascript "macOS built-in; check your PATH"
check screencapture screencapture "macOS built-in; check your PATH"
check sips sips "macOS built-in; check your PATH"
check cliclick cliclick
echo

echo "2. Playdate SDK and Simulator"
printf '  SDK path: %s\n' "$SDK_PATH"
if [ ! -d "$SDK_PATH" ]; then
  echo "  [MISSING] PLAYDATE_SDK_PATH is not a directory: $SDK_PATH"
  MISSING=1
fi

# The same precedence the server uses:
#   PLAYDATE_SIM_APP > $PLAYDATE_SDK_PATH/bin/Playdate Simulator.app
# then common install locations.
APP=""
if [ -n "$SIM_APP_ENV" ]; then
  if [ -d "$SIM_APP_ENV" ]; then
    APP="$SIM_APP_ENV"
  else
    echo "  [warn]    PLAYDATE_SIM_APP is not a directory: $SIM_APP_ENV"
  fi
fi

if [ -z "$APP" ] && [ -d "$SDK_PATH/bin/Playdate Simulator.app" ]; then
  APP="$SDK_PATH/bin/Playdate Simulator.app"
fi

if [ -z "$APP" ] && [ -d "/Applications/Playdate Simulator.app" ]; then
  APP="/Applications/Playdate Simulator.app"
fi

if [ -z "$APP" ]; then
  shopt -s nullglob
  for candidate in \
    "$HOME"/Downloads/PlaydateSDK*/bin/"Playdate Simulator.app" \
    "$HOME"/Applications/"Playdate Simulator.app"; do
    if [ -d "$candidate" ]; then APP="$candidate"; break; fi
  done
  shopt -u nullglob
fi

if [ -n "$APP" ]; then
  printf '  [ok]      %s\n' "$APP"
  # Current SDK bundles use "Contents/MacOS/Playdate Simulator" (with a
  # space), not "PlaydateSimulator".  Detect the executable, then fall back to
  # any executable in Contents/MacOS.
  MACOS_DIR="$APP/Contents/MacOS"
  BIN=""
  for candidate in "$MACOS_DIR/Playdate Simulator" "$MACOS_DIR/PlaydateSimulator"; do
    if [ -f "$candidate" ]; then BIN="$candidate"; break; fi
  done
  if [ -z "$BIN" ]; then
    shopt -s nullglob
    for candidate in "$MACOS_DIR"/*; do
      if [ -f "$candidate" ] && [ -x "$candidate" ]; then BIN="$candidate"; break; fi
    done
    shopt -u nullglob
  fi
  if [ -n "$BIN" ]; then
    ARCH=$(file "$BIN" | grep -Eo 'arm64|x86_64' | head -1 || true)
    printf '  [ok]      %s%s\n' "$BIN" "${ARCH:+ ($ARCH)}"
  else
    echo "  [MISSING] simulator executable under $MACOS_DIR"
    MISSING=1
  fi
else
  echo "  [MISSING] Playdate Simulator.app"
  echo "            Download the Playdate SDK: https://play.date/dev/"
  echo "            Checked:"
  echo "              PLAYDATE_SIM_APP=${SIM_APP_ENV:-<unset>}"
  echo "              $SDK_PATH/bin/Playdate Simulator.app"
  echo "              /Applications/Playdate Simulator.app"
  echo "              ~/Downloads/PlaydateSDK*/bin/Playdate Simulator.app"
  echo "            Set PLAYDATE_SDK_PATH to the extracted SDK folder (or"
  echo "            PLAYDATE_SIM_APP directly to the .app bundle)."
  MISSING=1
fi

if [ -x "$SDK_PATH/bin/pdc" ]; then
  printf '  [ok]      pdc (%s)\n' "$SDK_PATH/bin/pdc"
else
  printf '  [warn]    pdc not found at %s/bin/pdc (only needed for npm run seed)\n' "$SDK_PATH"
fi
echo

echo "3. Node version"
if command -v node >/dev/null 2>&1; then
  NODE_MAJOR=$(node -e 'console.log(process.versions.node.split(".")[0])')
  if [ "$NODE_MAJOR" -ge 18 ]; then
    printf '  [ok]      node %s\n' "$(node -v)"
  else
    printf '  [MISSING] node >= 18 required (found v%s)\n' "$(node -v)"
    MISSING=1
  fi
else
  echo "  [MISSING] node (install with: brew install node)"
  MISSING=1
fi
echo

echo "4. Manual steps (require a GUI, one-time)"
cat <<'EOF'
  a. Log in to the Mac mini and STAY logged in (the simulator needs a GUI session).
     System Settings > Users & Groups > Automatic login (optional but recommended).

  b. Prevent sleep:
     sudo pmset -a sleep 0 displaysleep 0

  c. Grant permissions the FIRST time you run a session:
     - "Screen Recording" (for screencapture)
     - "Accessibility"    (for cliclick / osascript input)
     System Settings > Privacy & Security > Screen Recording / Accessibility.
     Add "Terminal" (or your terminal app) and enable it.

  d. Install Homebrew if needed: https://brew.sh
EOF
echo

if [ "$MISSING" -eq 0 ]; then
  echo "All set. Start the server with:  npm run start"
else
  echo "Install the missing items above, then re-run this script."
fi
