'use strict';

const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.resolve(__dirname, '..');
const WORKSPACE = path.resolve(ROOT, '..');

const cfg = {
  root: ROOT,
  workspace: WORKSPACE,
  sdkPath: process.env.PLAYDATE_SDK_PATH || WORKSPACE,
  port: Number(process.env.PORT || 4173),
  host: process.env.HOST || '127.0.0.1',

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

  // Display / capture geometry
  displayWidth: 1280,
  displayHeight: 900,
  windowX: 399,
  windowY: 96,
  windowWidth: 482,
  windowHeight: 708,
  // Framebuffer offset within the simulator window
  fbOffsetX: 18,
  fbOffsetY: 45,
  fbWidth: 400,
  fbHeight: 240,
  captureFps: 30,
};

cfg.xvfbPath = path.join(cfg.vendorX11Dir, 'usr', 'bin', 'Xvfb');
cfg.xdotoolPath = path.join(cfg.vendorX11Dir, 'usr', 'bin', 'xdotool');
cfg.x11LibDir = path.join(cfg.vendorX11Dir, 'usr', 'lib', 'x86_64-linux-gnu');
cfg.simulatorPath = path.join(cfg.sdkPath, 'bin', 'PlaydateSimulator');
cfg.pdcPath = path.join(cfg.sdkPath, 'bin', 'pdc');

for (const dir of [cfg.storageDir, cfg.gamesDir, cfg.sessionsDir, cfg.tmpDir]) {
  fs.mkdirSync(dir, { recursive: true });
}

module.exports = cfg;
