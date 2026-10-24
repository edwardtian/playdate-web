'use strict';

// Linux platform: run the simulator under a virtual X display (Xvfb),
// capture its 400x240 framebuffer with ffmpeg x11grab, send input with
// xdotool (XTEST). See README for the verification details.

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { exec, sleep, FrameSplitter, seedSimulatorConfig, cfg } = require('../platform');

const DISPLAY_MIN = 95;
const DISPLAY_MAX = 130;
const usedDisplays = new Set();

function libPathEnv() {
  const existing = process.env.LD_LIBRARY_PATH;
  return cfg.x11LibDir + (existing ? `:${existing}` : '');
}

function pickDisplay() {
  for (let n = DISPLAY_MIN; n <= DISPLAY_MAX; n++) {
    if (!usedDisplays.has(n)) { usedDisplays.add(n); return n; }
  }
  throw new Error('No free display numbers available');
}

async function findWindow(displayEnv, timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const out = await exec(cfg.xdotoolPath, ['search', '--name', '^Playdate Simulator$'], displayEnv);
      const ids = out.split('\n').map((s) => s.trim()).filter(Boolean);
      if (ids.length) return ids[ids.length - 1];
    } catch { /* retry */ }
    await sleep(250);
  }
  throw new Error('Timed out waiting for the Playdate Simulator window');
}

class LinuxSession {
  constructor(session) {
    this.s = session;
    this.displayNum = pickDisplay();
    this.display = `127.0.0.1:${this.displayNum}.0`;
    this.xvfbProc = null;
    this.simulatorProc = null;
    this.captureProc = null;
    this.windowId = null;
    this.displayEnv = null;
  }

  baseEnv() {
    return {
      ...process.env,
      HOME: this.s.homeDir,
      DISPLAY: this.display,
      GDK_BACKEND: 'x11',
      WEBKIT_DISABLE_COMPOSITING_MODE: '1',
      XDG_CONFIG_HOME: path.join(this.s.homeDir, '.config'),
      XDG_CACHE_HOME: path.join(this.s.homeDir, '.cache'),
      XDG_DATA_HOME: path.join(this.s.homeDir, '.local', 'share'),
      LD_LIBRARY_PATH: libPathEnv(),
    };
  }

  async start() {
    for (const [label, bin] of [
      ['Xvfb', cfg.xvfbPath],
      ['xdotool', cfg.xdotoolPath],
      ['PlaydateSimulator', cfg.simulatorPath],
      ['ffmpeg', 'ffmpeg'],
    ]) {
      if (bin !== 'ffmpeg' && !fs.existsSync(bin)) {
        throw new Error(`${label} not found at ${bin}. Run scripts/setup-x11.sh first.`);
      }
    }

    seedSimulatorConfig(this.s.homeDir, this.s.game.pdxDir);
    this.displayEnv = this.baseEnv();

    this.xvfbProc = spawn(cfg.xvfbPath, [
      `:${this.displayNum}`,
      '-screen', '0', `${cfg.displayWidth}x${cfg.displayHeight}x24`,
      '-listen', 'tcp',
      '-extension', 'GLX',
      '-xkbdir', path.join(cfg.vendorX11Dir, 'usr', 'share', 'X11', 'xkb'),
      '-nolisten', 'unix',
    ], { env: this.baseEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
    this.xvfbProc.on('error', (err) => this.s.fail(`Xvfb spawn error: ${err.message}`));
    this.xvfbProc.on('exit', (code) => {
      if (this.s.state !== 'stopped') this.s.fail(`Xvfb exited with code ${code}`);
    });

    await sleep(900);

    this.simulatorProc = spawn(cfg.simulatorPath, [this.s.game.pdxDir], {
      env: this.baseEnv(), cwd: cfg.workspace, stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.simulatorProc.stdout.on('data', (d) => {
      const text = d.toString(); if (text.trim()) this.s.emit('log', text.trim());
    });
    this.simulatorProc.on('error', (err) => this.s.fail(`Simulator spawn error: ${err.message}`));
    this.simulatorProc.on('exit', (code) => {
      if (this.s.state !== 'stopped') this.s.fail(`Simulator exited with code ${code}`);
    });

    this.windowId = await findWindow(this.displayEnv);
    await exec(cfg.xdotoolPath, ['windowmove', this.windowId, String(cfg.windowX), String(cfg.windowY)], this.displayEnv);
    await exec(cfg.xdotoolPath, ['windowfocus', '--sync', this.windowId], this.displayEnv).catch(() => {});

    const args = [
      '-hide_banner', '-loglevel', 'error',
      '-f', 'x11grab', '-draw_mouse', '0',
      '-video_size', `${cfg.fbWidth}x${cfg.fbHeight}`,
      '-i', `${this.display}+${cfg.windowX + cfg.fbOffsetX},${cfg.windowY + cfg.fbOffsetY}`,
      '-r', String(cfg.captureFps),
      '-f', 'mjpeg', '-q:v', '6', '-pix_fmt', 'yuvj420p',
      'pipe:1',
    ];
    this.captureProc = spawn('ffmpeg', args, { env: this.baseEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
    this.captureProc.stdout.on('data', (chunk) => {
      for (const frame of this.s.splitter.push(chunk)) this.s.pushFrame(frame);
    });
    this.captureProc.on('error', (err) => this.s.fail(`Capture spawn error: ${err.message}`));
    this.captureProc.on('exit', (code) => {
      if (this.s.state !== 'stopped') this.s.fail(`Capture exited with code ${code}`);
    });

    this.s.frameGrabber = () => { /* streaming via ffmpeg */ };
  }

  async sendButton(button, action) {
    const key = { A: 's', B: 'a', up: 'Up', down: 'Down', left: 'Left', right: 'Right' }[button];
    if (!key) throw new Error(`Unknown button: ${button}`);
    await exec(cfg.xdotoolPath, ['windowfocus', '--sync', this.windowId], this.displayEnv).catch(() => {});
    await exec(cfg.xdotoolPath, [action === 'down' ? 'keydown' : 'keyup', '--clearmodifiers', key], this.displayEnv);
  }

  async crank(delta) {
    const clicks = Math.max(1, Math.min(90, Math.round(Math.abs(Number(delta) || 4) / 4)));
    const btn = Number(delta) >= 0 ? '4' : '5';
    await exec(cfg.xdotoolPath, ['windowfocus', '--sync', this.windowId], this.displayEnv).catch(() => {});
    for (let i = 0; i < clicks; i++) {
      await exec(cfg.xdotoolPath, ['mousemove', String(cfg.windowX + 200), String(cfg.windowY + 150), 'click', btn], this.displayEnv);
      await sleep(40);
    }
  }

  async setDocked(desired) {
    await exec(cfg.xdotoolPath, ['windowfocus', '--sync', this.windowId], this.displayEnv).catch(() => {});
    await exec(cfg.xdotoolPath, ['mousemove', String(cfg.windowX + 259), String(cfg.windowY + 513), 'click', '1'], this.displayEnv);
  }

  async menu() {
    await exec(cfg.xdotoolPath, ['windowfocus', '--sync', this.windowId], this.displayEnv).catch(() => {});
    await exec(cfg.xdotoolPath, ['mousemove', String(cfg.windowX + 454), String(cfg.windowY + 97), 'click', '1'], this.displayEnv);
  }

  async stop() {
    const procs = [this.captureProc, this.simulatorProc, this.xvfbProc];
    for (const p of procs) { if (p && p.exitCode === null) { try { p.kill('SIGTERM'); } catch {} } }
    await sleep(300);
    for (const p of procs) { if (p && p.exitCode === null) { try { p.kill('SIGKILL'); } catch {} } }
    usedDisplays.delete(this.displayNum);
  }
}

module.exports = { LinuxSession };
