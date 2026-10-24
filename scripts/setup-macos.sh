#!/usr/bin/env bash
# macOS setup for the Playdate Web Simulator.
# Verifies prerequisites and prints the manual steps that require a GUI.
set -euo pipefail

echo "=== Playdate Web Simulator — macOS setup ==="
echo

MISSING=0

check() {
  local name="$1" cmd="$2"
  if command -v "$cmd" >/dev/null 2>&1; then
    printf '  [ok]      %s (%s)\n' "$name" "$(command -v "$cmd")"
  else
    printf '  [MISSING] %s — install with: brew install %s\n' "$name" "$cmd"
    MISSING=1
  fi
}

echo "1. Required tools"
check node node
check osascript osascript
check screencapture screencapture
check sips sips
check cliclick cliclick
echo

# Locate the simulator app
APP=""
for candidate in \
  "/Applications/Playdate Simulator.app" \
  "$HOME/Downloads/PlaydateSDK"*/bin/"Playdate Simulator.app" \
  "$PWD"/bin/"Playdate Simulator.app"; do
  if [ -d "$candidate" ]; then APP="$candidate"; break; fi
done

echo "2. Playdate Simulator"
if [ -n "$APP" ]; then
  printf '  [ok]      %s\n' "$APP"
  BIN="$APP/Contents/MacOS/PlaydateSimulator"
  if [ -f "$BIN" ]; then
    ARCH=$(file "$BIN" | grep -o 'arm64\|x86_64' | head -1)
    printf '  [ok]      binary (%s)\n' "$ARCH"
  fi
else
  echo "  [MISSING] Playdate Simulator.app"
  echo "            Download the Playdate SDK: https://play.date/dev/"
  echo "            Then set PLAYDATE_SDK_PATH to the extracted folder."
  MISSING=1
fi
echo

echo "3. Node version"
NODE_MAJOR=$(node -e 'console.log(process.versions.node.split(".")[0])')
if [ "$NODE_MAJOR" -ge 18 ]; then
  printf '  [ok]      node v%s\n' "$(node -v)"
else
  printf '  [MISSING] node >= 18 required (found v%s)\n' "$(node -v)"
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
