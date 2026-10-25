'use strict';

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const ROOT = path.resolve(__dirname, '..');
const WORKSPACE = path.resolve(ROOT, '..');
const IS_MAC = process.platform === 'darwin';

const cfg = {
  root: ROOT,
  workspace: WORKSPACE,
  sdkPath: process.env.PLAYDATE_SDK_PATH || WORKSPACE,
  port: Number(process.env.PORT || 4173),
  host: process.env.HOST || '127.0.0.1',
  platform: process.platform,
  isMac: IS_MAC,

  storageDir: path.join(ROOT, 'storage'),
  gamesDir: path.join(ROOT, 'storage', 'games'),
  sessionsDir: path.join(ROOT, 'storage', 'sessions'),
  tmpDir: path.join(ROOT, 'storage', 'tmp'),
  publicDir: path.join(ROOT, 'public'),
  vendorX11Dir: process.env.X11_VENDOR_DIR || path.join(WORKSPACE, 'vendor', 'x11'),

  // Limits
  maxUploadBytes: Number(process.env.MAX_UPLOAD_BYTES || 64 * 1024 * 1024),
  maxConcurrentSessions: Number(process.env.MAX_SESSIONS || 3),
  sessionIdleTimeoutMs: Number(process.env.SESSION_IDLE_MS || 10 * 60 * 1000),
  // When the last frame/audio stream of a viewer disconnects (tab closed,
  // browser crashed, network dropped), give it a short grace period in case
  // the client is reconnecting, then stop the session and its child processes.
  viewerGraceMs: (() => {
    const n = Number(process.env.SESSION_VIEWER_GRACE_MS ?? 15000);
    return Number.isFinite(n) && n >= 0 ? n : 15000;
  })(),
  // A session for which no frame/audio stream ever connects (for example the
  // tab was closed while the simulator was starting) is stopped after this.
  unviewedTimeoutMs: (() => {
    const n = Number(process.env.SESSION_UNVIEWED_MS ?? 60000);
    return Number.isFinite(n) && n >= 0 ? n : 60000;
  })(),

  // Display / capture geometry
  // The simulator window is 482x708 at (399,96).  A 900x820 virtual display
  // is large enough for it and keeps the Xvfb framebuffer substantially
  // smaller than the old 1280x900 screen (less memory traffic and CPU for
  // the X server).
  displayWidth: 900,
  displayHeight: 820,
  windowX: 399,
  windowY: 96,
  windowWidth: 482,
  windowHeight: 708,
  // Framebuffer offset within the simulator window.  The Playdate screen is
  // the 400x240 rectangle inside the simulated device's bezel.  For the Linux
  // simulator at 1x these offsets are 18,45.  A wrong offset leaves a black
  // strip around the captured image, which is very visible for edge-to-edge
  // games.  On macOS the title bar adds ~28px to the top; that platform
  // calibrates at runtime.
  fbOffsetX: 18,
  fbOffsetY: 45,
  fbWidth: 400,
  fbHeight: 240,
  captureFps: 30,

  // Relative coordinates inside the simulator window used for mouse input.
  // The MENU control is a wxWidgets button that needs a real press/hold, and
  // the dock checkbox is a small target; keep both in one place.
  menuX: 453,
  menuY: 95,
  dockX: 264,
  dockY: 515,
  crankWheelX: 200,
  crankWheelY: 150,

  // Audio.  Each Linux session gets its own PulseAudio null sink so games can
  // be streamed to one browser without other sessions bleeding in.
  audioEnabled: process.env.AUDIO_ENABLED !== '0',
  defaultSystemVolume: (() => {
    const n = Number(process.env.PLAYDATE_VOLUME ?? 200);
    return Number.isFinite(n) ? Math.max(0, Math.min(255, Math.round(n))) : 200;
  })(),
};

if (IS_MAC) {
  // macOS paths: SDK ships the app bundle; simulator binary inside it.  Keep
  // this resolution in sync with scripts/setup-macos.sh so the checker and the
  // server agree about which app they found.
  const isDir = (p) => {
    try { return fs.statSync(p).isDirectory(); } catch { return false; }
  };
  const isFile = (p) => {
    try { return fs.statSync(p).isFile(); } catch { return false; }
  };
  // The macOS bundle executable is named "Playdate Simulator" (with a space)
  // in current SDKs, not "PlaydateSimulator".  Detect it instead of assuming
  // the Linux-style name; also fall back to any executable in Contents/MacOS.
  const findSimulatorBinary = (appPath) => {
    const macosDir = path.join(appPath, 'Contents', 'MacOS');
    for (const name of ['Playdate Simulator', 'PlaydateSimulator']) {
      const candidate = path.join(macosDir, name);
      if (isFile(candidate)) return candidate;
    }
    try {
      for (const entry of fs.readdirSync(macosDir)) {
        const candidate = path.join(macosDir, entry);
        try {
          const st = fs.statSync(candidate);
          if (st.isFile() && (st.mode & 0o111)) return candidate;
        } catch { /* skip unreadable entry */ }
      }
    } catch { /* no Contents/MacOS */ }
    return path.join(macosDir, 'Playdate Simulator');
  };
  const home = os.homedir();
  const candidates = [];
  if (process.env.PLAYDATE_SIM_APP) candidates.push(process.env.PLAYDATE_SIM_APP);
  candidates.push(path.join(cfg.sdkPath, 'bin', 'Playdate Simulator.app'));
  candidates.push('/Applications/Playdate Simulator.app');
  try {
    for (const entry of fs.readdirSync(path.join(home, 'Downloads'))) {
      if (entry.startsWith('PlaydateSDK')) {
        candidates.push(path.join(home, 'Downloads', entry, 'bin', 'Playdate Simulator.app'));
      }
    }
  } catch { /* no Downloads directory */ }
  candidates.push(path.join(home, 'Applications', 'Playdate Simulator.app'));

  if (process.env.PLAYDATE_SIM_APP && !isDir(process.env.PLAYDATE_SIM_APP)) {
    console.warn(`PLAYDATE_SIM_APP is not a directory: ${process.env.PLAYDATE_SIM_APP}`);
  }
  cfg.simulatorAppPath = candidates.find(isDir) ||
    path.join(cfg.sdkPath, 'bin', 'Playdate Simulator.app');
  cfg.simulatorPath = findSimulatorBinary(cfg.simulatorAppPath);
  cfg.simulatorProcessName = path.basename(cfg.simulatorPath);
  cfg.pdcPath = path.join(cfg.sdkPath, 'bin', 'pdc');
} else {
  cfg.xvfbPath = path.join(cfg.vendorX11Dir, 'usr', 'bin', 'Xvfb');
  cfg.xdotoolPath = path.join(cfg.vendorX11Dir, 'usr', 'bin', 'xdotool');
  cfg.xdpyinfoPath = path.join(cfg.vendorX11Dir, 'usr', 'bin', 'xdpyinfo');
  cfg.x11LibDir = path.join(cfg.vendorX11Dir, 'usr', 'lib', 'x86_64-linux-gnu');
  cfg.simulatorPath = path.join(cfg.sdkPath, 'bin', 'PlaydateSimulator');
  cfg.pdcPath = path.join(cfg.sdkPath, 'bin', 'pdc');
}

for (const dir of [cfg.storageDir, cfg.gamesDir, cfg.sessionsDir, cfg.tmpDir]) {
  fs.mkdirSync(dir, { recursive: true });
}

module.exports = cfg;
