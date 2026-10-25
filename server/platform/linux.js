'use strict';

// Linux platform: run the simulator under a virtual X display (Xvfb),
// capture its 400x240 framebuffer with ffmpeg x11grab, send input with
// xdotool (XTEST), and capture the session's audio through a private
// PulseAudio null sink.

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { exec, sleep, seedSimulatorConfig, cfg } = require('../platform');

const DISPLAY_MIN = 95;
const DISPLAY_MAX = 150;
const usedDisplays = new Set();

function libPathEnv() {
  const existing = process.env.LD_LIBRARY_PATH;
  return cfg.x11LibDir + (existing ? `:${existing}` : '');
}

function displayAddress(n) {
  return `127.0.0.1:${n}.0`;
}

async function displayResponds(n) {
  try {
    await exec(cfg.xdpyinfoPath, ['-display', displayAddress(n)], {
      ...process.env,
      LD_LIBRARY_PATH: libPathEnv(),
    }, 1500);
    return true;
  } catch {
    return false;
  }
}

async function pickDisplay() {
  for (let n = DISPLAY_MIN; n <= DISPLAY_MAX; n++) {
    if (usedDisplays.has(n)) continue;
    // Never attach to another server's display (including a stale session
    // from a previous server process): grab a genuinely free number.
    if (await displayResponds(n)) continue;
    usedDisplays.add(n);
    return n;
  }
  throw new Error('No free display numbers available');
}

async function waitForDisplay(n, xvfbProc, timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (xvfbProc && xvfbProc.exitCode !== null) {
      throw new Error(`Xvfb exited with code ${xvfbProc.exitCode}`);
    }
    if (await displayResponds(n)) return;
    await sleep(120);
  }
  throw new Error('Timed out waiting for Xvfb to start');
}

async function getWindowGeometry(windowId, env) {
  const out = await exec(cfg.xdotoolPath, ['getwindowgeometry', '--shell', windowId], env);
  const values = {};
  for (const line of out.split(/\r?\n/)) {
    const m = line.match(/^(X|Y|WIDTH|HEIGHT)=(-?\d+)$/);
    if (m) values[m[1]] = Number(m[2]);
  }
  if (![values.X, values.Y, values.WIDTH, values.HEIGHT].every(Number.isFinite)) {
    throw new Error(`Could not parse window geometry: ${out.trim()}`);
  }
  return { x: values.X, y: values.Y, w: values.WIDTH, h: values.HEIGHT };
}

async function findWindow(displayEnv, timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const out = await exec(cfg.xdotoolPath, ['search', '--name', '^Playdate Simulator$'], displayEnv);
      const ids = out.split('\n').map((s) => s.trim()).filter(Boolean);
      // The tool also creates tiny 10x10 helper windows; pick the real one.
      for (const id of ids.reverse()) {
        try {
          const geo = await getWindowGeometry(id, displayEnv);
          if (geo.w >= 400 && geo.h >= 600) return id;
        } catch { /* not this one */ }
      }
    } catch { /* retry */ }
    await sleep(250);
  }
  throw new Error('Timed out waiting for the Playdate Simulator window');
}

class LinuxSession {
  constructor(session) {
    this.s = session;
    this.displayNum = null;
    this.display = null;
    this.xvfbProc = null;
    this.simulatorProc = null;
    this.captureProc = null;
    this.audioProc = null;
    this.windowId = null;
    this.displayEnv = null;
    this.winX = cfg.windowX;
    this.winY = cfg.windowY;
    this.fbRect = null;
    this.stopping = false;
    this.xvfbStarting = false;

    this.audioSink = null;
    this.audioModuleId = null;
    this.crankRemainder = 0;
  }

  baseEnv() {
    const env = {
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
    if (this.audioSink) env.PULSE_SINK = this.audioSink;
    return env;
  }

  // Audio helpers run on the host; keep the X11 library search path out of
  // their environment so they always use the system PulseAudio/ffmpeg libs.
  audioEnv() {
    const env = { ...this.baseEnv() };
    delete env.LD_LIBRARY_PATH;
    delete env.DISPLAY;
    delete env.GDK_BACKEND;
    delete env.WEBKIT_DISABLE_COMPOSITING_MODE;
    return env;
  }

  async createAudioSink() {
    if (!cfg.audioEnabled) return null;
    const name = `pdweb_${this.s.id}`;
    try {
      const out = await exec('pactl', [
        'load-module', 'module-null-sink',
        `sink_name=${name}`,
        `sink_properties=device.description=Playdate_${this.s.id}`,
      ], this.audioEnv(), 6000);
      const moduleId = out.trim();
      if (!/^\d+$/.test(moduleId)) throw new Error(`unexpected pactl output: ${moduleId}`);
      this.audioSink = name;
      this.audioModuleId = moduleId;
      return name;
    } catch (err) {
      // Audio is optional; the game still runs without it.  Keep a note in
      // the simulator console so deployment problems are diagnosable.
      this.s.emit('log', `Audio output unavailable: ${err.message}`);
      this.audioSink = null;
      return null;
    }
  }

  async startAudioCapture() {
    if (!cfg.audioEnabled) return;
    // Prefer the private sink monitor; fall back to the default monitor for
    // hosts where pactl exists but creating a null sink was not permitted.
    const monitor = this.audioSink ? `${this.audioSink}.monitor` : 'default';
    // Raw PCM for the browser's Web Audio player.  A media element (<audio>)
    // adds several seconds of startup buffering to a live stream, which makes
    // short sounds (the MENU pop, for example) arrive seconds late.  Raw PCM
    // scheduled in small buffers keeps the latency under ~200 ms.
    const args = [
      '-hide_banner', '-loglevel', 'error',
      '-f', 'pulse', '-fragment_size', '4096', '-i', monitor,
      '-ac', '2', '-ar', '48000',
      '-flush_packets', '1',
      '-f', 's16le', 'pipe:1',
    ];
    this.audioProc = spawn('ffmpeg', args, {
      env: this.audioEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.audioProc.stdout.on('data', (chunk) => this.s.pushAudio(chunk));
    this.audioProc.stderr.on('data', (data) => {
      const text = data.toString().trim();
      if (text) this.s.emit('log', `[audio] ${text}`);
    });
    this.audioProc.on('error', (err) => {
      this.s.audioAvailable = false;
      this.s.emit('log', `Audio capture error: ${err.message}`);
    });
    this.audioProc.on('exit', (code) => {
      if (!this.stopping && code !== 0) {
        this.s.audioAvailable = false;
        this.s.emit('log', `Audio capture stopped (exit ${code})`);
      }
    });
    this.s.audioAvailable = true;
  }

  async start() {
    for (const [label, bin] of [
      ['Xvfb', cfg.xvfbPath],
      ['xdotool', cfg.xdotoolPath],
      ['xdpyinfo', cfg.xdpyinfoPath],
      ['PlaydateSimulator', cfg.simulatorPath],
    ]) {
      if (!fs.existsSync(bin)) {
        throw new Error(`${label} not found at ${bin}. Run scripts/setup-x11.sh first.`);
      }
    }

    fs.mkdirSync(this.s.homeDir, { recursive: true });
    await this.createAudioSink();
    seedSimulatorConfig(this.s.homeDir, this.s.game.pdxDir);

    // Allocate a display and start Xvfb.  Retry on the rare race where
    // another process grabs the same display between our probe and spawn.
    let xvfbError = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      this.displayNum = await pickDisplay();
      this.display = displayAddress(this.displayNum);
      this.displayEnv = this.baseEnv();

      this.xvfbProc = spawn(cfg.xvfbPath, [
        `:${this.displayNum}`,
        '-screen', '0', `${cfg.displayWidth}x${cfg.displayHeight}x24`,
        '-listen', 'tcp',
        '-extension', 'GLX',
        '-xkbdir', path.join(cfg.vendorX11Dir, 'usr', 'share', 'X11', 'xkb'),
        '-nolisten', 'unix',
      ], { env: this.baseEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
      this.xvfbStarting = true;
      const xvfb = this.xvfbProc;
      this.xvfbProc.stderr.on('data', (data) => {
        const text = data.toString().trim();
        if (text) this.s.emit('log', `[xvfb] ${text}`);
      });
      this.xvfbProc.on('error', (err) => { xvfbError = err; });
      this.xvfbProc.on('exit', (code) => {
        if (this.xvfbProc !== xvfb) return;
        if (this.stopping || this.xvfbStarting || this.s.state === 'failed' || this.s.state === 'stopped') return;
        this.s.fail(`Xvfb exited with code ${code}`);
      });

      try {
        await waitForDisplay(this.displayNum, this.xvfbProc);
        this.xvfbStarting = false;
        xvfbError = null;
        break;
      } catch (err) {
        this.xvfbStarting = false;
        xvfbError = err;
        const failedProc = this.xvfbProc;
        this.xvfbProc = null;
        try { if (failedProc) failedProc.kill('SIGKILL'); } catch { /* ignore */ }
        usedDisplays.delete(this.displayNum);
        this.displayNum = null;
        if (attempt === 2) throw err;
      }
    }
    if (xvfbError) throw xvfbError;
    if (this.s.state !== 'starting') return;

    // A per-session HOME keeps the simulator's recent-files list and config
    // isolated.  cwd stays at the SDK root because the simulator reads its
    // built-in Disk/System data relative to the working directory.
    this.simulatorProc = spawn(cfg.simulatorPath, [this.s.game.pdxDir], {
      env: this.baseEnv(), cwd: cfg.workspace, stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.simulatorProc.stdout.on('data', (data) => {
      const text = data.toString().trim();
      if (text) this.s.emit('log', text);
    });
    this.simulatorProc.stderr.on('data', (data) => {
      const text = data.toString().trim();
      if (text) this.s.emit('log', text);
    });
    this.simulatorProc.on('error', (err) => this.s.fail(`Simulator spawn error: ${err.message}`));
    this.simulatorProc.on('exit', (code) => {
      if (this.stopping || this.s.state === 'failed' || this.s.state === 'stopped') return;
      this.s.fail(`Simulator exited with code ${code}`);
    });

    this.windowId = await findWindow(this.displayEnv);
    await exec(cfg.xdotoolPath, [
      'windowmove', this.windowId, String(cfg.windowX), String(cfg.windowY),
    ], this.displayEnv).catch(() => {});
    await exec(cfg.xdotoolPath, ['windowfocus', this.windowId], this.displayEnv).catch(() => {});

    // Use the real window origin rather than the requested one; a window
    // manager may adjust it, and a wrong origin shifts the captured picture.
    let geo = await getWindowGeometry(this.windowId, this.displayEnv);
    for (let i = 0; i < 10 && (geo.x !== cfg.windowX || geo.y !== cfg.windowY); i++) {
      await sleep(50);
      geo = await getWindowGeometry(this.windowId, this.displayEnv);
    }
    this.winX = geo.x;
    this.winY = geo.y;
    this.fbRect = {
      x: geo.x + cfg.fbOffsetX,
      y: geo.y + cfg.fbOffsetY,
      w: cfg.fbWidth,
      h: cfg.fbHeight,
    };
    this.s.emit('log', `Framebuffer: ${this.fbRect.w}x${this.fbRect.h} at ${this.fbRect.x},${this.fbRect.y}`);

    const args = [
      '-hide_banner', '-loglevel', 'error',
      '-f', 'x11grab', '-draw_mouse', '0',
      '-video_size', `${this.fbRect.w}x${this.fbRect.h}`,
      '-i', `${this.display}+${this.fbRect.x},${this.fbRect.y}`,
      '-r', String(cfg.captureFps),
      '-f', 'mjpeg', '-q:v', '6', '-pix_fmt', 'yuvj420p',
      'pipe:1',
    ];
    this.captureProc = spawn('ffmpeg', args, {
      env: this.baseEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.captureProc.stdout.on('data', (chunk) => {
      for (const frame of this.s.splitter.push(chunk)) this.s.pushFrame(frame);
    });
    this.captureProc.on('error', (err) => this.s.fail(`Capture spawn error: ${err.message}`));
    this.captureProc.on('exit', (code) => {
      if (this.stopping || this.s.state === 'failed' || this.s.state === 'stopped') return;
      this.s.fail(`Capture exited with code ${code}`);
    });

    // Start audio last so the game's title music is captured as well.
    if (this.s.state !== 'starting') return;
    await this.startAudioCapture();
  }

  // xdotool takes several commands in one invocation.  Focus + action in a
  // single process is much faster than spawning xdotool once per command.
  async xdo(args, timeoutMs = 10000) {
    return exec(cfg.xdotoolPath, ['windowfocus', this.windowId, ...args], this.displayEnv, timeoutMs);
  }

  async sendButton(button, action) {
    const key = { A: 's', B: 'a', up: 'Up', down: 'Down', left: 'Left', right: 'Right' }[button];
    if (!key) throw new Error(`Unknown button: ${button}`);
    await this.xdo([action === 'down' ? 'keydown' : 'keyup', '--clearmodifiers', key]);
  }

  async crank(delta) {
    // The simulator maps one wheel notch to 4 degrees.  Accumulate fractional
    // delta client-side/server-side so a slow drag still produces smooth
    // movement instead of rounding every small event up to a full notch.
    this.crankRemainder += Number(delta) || 0;
    let clicks = Math.trunc(this.crankRemainder / 4);
    if (!clicks) return false;
    this.crankRemainder -= clicks * 4;

    const button = clicks > 0 ? '4' : '5';
    let remaining = Math.abs(clicks);
    while (remaining > 0) {
      const batch = Math.min(90, remaining);
      await this.xdo([
        'mousemove', '--window', this.windowId,
        String(cfg.crankWheelX), String(cfg.crankWheelY),
        'click', '--repeat', String(batch), '--delay', '0', button,
      ], 20000);
      remaining -= batch;
    }
    return true;
  }

  async setDocked() {
    // The checkbox is a small target and needs a brief press; a zero-length
    // synthetic click is regularly missed by the simulator's UI.
    await this.xdo([
      'mousemove', '--window', this.windowId,
      String(cfg.dockX), String(cfg.dockY),
      'mousedown', '1', 'sleep', '0.06', 'mouseup', '1',
    ]);
  }

  async menu() {
    // The MENU control is a wxWidgets button.  xdotool's one-shot `click`
    // sends press and release in the same X event batch, which the simulator
    // does not treat as a button press.  Hold it briefly instead.
    await this.xdo([
      'mousemove', '--window', this.windowId,
      String(cfg.menuX), String(cfg.menuY),
      'mousedown', '1', 'sleep', '0.1', 'mouseup', '1',
    ]);
  }

  async stop() {
    this.stopping = true;
    this.s.audioAvailable = false;

    const procs = [this.audioProc, this.captureProc, this.simulatorProc, this.xvfbProc];
    for (const p of procs) {
      if (p && p.exitCode === null) { try { p.kill('SIGTERM'); } catch { /* ignore */ } }
    }
    await sleep(350);
    for (const p of procs) {
      if (p && p.exitCode === null) { try { p.kill('SIGKILL'); } catch { /* ignore */ } }
    }

    if (this.audioModuleId) {
      try {
        await exec('pactl', ['unload-module', this.audioModuleId], this.audioEnv(), 5000);
      } catch { /* ignore */ }
      this.audioModuleId = null;
    }
    if (this.displayNum !== null) usedDisplays.delete(this.displayNum);
  }
}

module.exports = { LinuxSession };
