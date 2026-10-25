# Deploying to macOS (Apple Mac mini M4)

This app runs the **real** Playdate Simulator and streams its screen to a browser. On macOS the simulator is a native GUI app — there is no Xvfb equivalent — so the Mac must be **logged in to a GUI session**. A Mac mini works well as an always-on "Playdate server" if you configure it correctly.

## What's different on macOS

| Concern | Linux | macOS |
| --- | --- | --- |
| Virtual display | `Xvfb` | **None** — simulator opens in the logged-in user's screen |
| Screen capture | `ffmpeg x11grab` (continuous) | `screencapture -l<winid>` / `-R<x,y,w,h>` (per-frame) |
| Input | `xdotool` (XTEST) | `cliclick` (mouse/keys) or `osascript` (keystrokes) |
| Headless | Fully headless | Requires a logged-in GUI session |
| Concurrency | One X display per session | One simulator instance per session (all share the screen) |

## Prerequisites

```bash
# 1. Install Homebrew (https://brew.sh) if not already present:
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

# 2. Install Node.js (>= 18) and the input tool
brew install node cliclick

# 3. Download the Playdate SDK for macOS
#    https://play.date/dev/  →  PlaydateSDK-<version>.tar.gz
#    Extract somewhere, e.g. ~/PlaydateSDK
```

## One-time setup on the Mac

```bash
cd /path/to/PlaydateSDK-3.1.2/webapp

# Tell both the checker and the server where the extracted SDK lives.
# (If the webapp is inside the SDK, this can be omitted.)
export PLAYDATE_SDK_PATH="$HOME/PlaydateSDK-3.1.2"

# Only if the .app bundle is outside the SDK:
# export PLAYDATE_SIM_APP="/Applications/Playdate Simulator.app"

# Run the checker — it verifies tools and prints the manual steps
bash scripts/setup-macos.sh
```

The script will tell you to:

1. **Stay logged in.** The simulator window must be visible on screen.
   - *System Settings → Users & Groups → Automatic login* (recommended for a server).
2. **Prevent sleep.**
   ```bash
   sudo pmset -a sleep 0 displaysleep 0
   ```
3. **Grant permissions** (first session triggers prompts):
   - **Screen Recording** — required for `screencapture`.
   - **Accessibility** — required for `cliclick` / `osascript` input.
   - Go to *System Settings → Privacy & Security* and enable **Terminal** (or your terminal app) under both categories.

## Persist the SDK path

`PLAYDATE_SDK_PATH` and `PLAYDATE_SIM_APP` are read by **both** `setup-macos.sh`
and the server. The `export` above only lasts for the current shell; add it to
`~/.zshrc` (or your launchd plist) so `npm run start` and the setup checker see
it later:

```bash
export PLAYDATE_SDK_PATH="$HOME/PlaydateSDK-3.1.2"
# Optional if the simulator app is not at $PLAYDATE_SDK_PATH/bin:
export PLAYDATE_SIM_APP="/Applications/Playdate Simulator.app"
```

## Seed example games (optional)

```bash
npm run seed
```

This compiles the SDK's example games with `pdc` and registers them in the library.

## Start the server

```bash
npm run start
# or bind to the LAN so others can reach it:
HOST=0.0.0.0 npm run start
```

Then open `http://<mac-mini-ip>:4173` from any device on the network.

## Run as a background service (launchd)

Create a LaunchAgent so the server starts at login and restarts if it crashes.

Save this to `~/Library/LaunchAgents/com.playdate.websim.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.example.playdate-websim</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string>
    <string>-lc</string>
    <string>cd /path/to/PlaydateSDK-3.1.2/webapp &amp;&amp; exec /opt/homebrew/bin/node server/index.js</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PLAYDATE_SDK_PATH</key>
    <string>/path/to/PlaydateSDK-3.1.2</string>
    <key>HOST</key>
    <string>0.0.0.0</string>
    <key>PORT</key>
    <string>4173</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/tmp/playdate-websim.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/playdate-websim.log</string>
</dict>
</plist>
```

Load it:

```bash
launchctl load ~/Library/LaunchAgents/com.playdate.websim.plist
```

> **Note:** the GUI session must be logged in for the simulator to render. LaunchAgents run at login, so enable automatic login for the user that runs the server.

## Known limitations on macOS

- **One visible simulator window at a time.** Since macOS has no virtual display, every session shares the same screen. `MAX_SESSIONS` defaults to 3, but on macOS consider setting `MAX_SESSIONS=1` for a clean single-user experience.
- **Frame rate.** `screencapture` is called per frame, so it's slower than Linux's continuous `ffmpeg` grab. Expect ~10–15 fps depending on the Mac.
- **Screen Recording permission.** The first capture triggers a macOS permission prompt; grant it once.
- **Crank.** Controlled with `[` / `]` keyboard keys (built into the simulator). The `cliclick` tool provides the most reliable key events; without it the app falls back to `osascript` keystrokes (no hold support).
- **Audio streaming is Linux-only.** macOS does not get a per-session PulseAudio null sink; the simulator's audio plays on the Mac's own output but is not sent to the browser.

## Verifying the deployment

```bash
# On the Mac mini itself
curl http://127.0.0.1:4173/api/health

# From another device on the network
curl http://<mac-mini-ip>:4173/api/health
```

Open `http://<mac-mini-ip>:4173` in a browser, pick a game, and press **Play**. The simulator window will appear on the Mac mini's screen; the browser shows a live 400×240 stream of the game.
