'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, execFile } = require('node:child_process');
const { EventEmitter } = require('node:events');

const cfg = require('./config');

const sessions = new Map();

function libPathEnv() {
  const existing = process.env.LD_LIBRARY_PATH;
  return cfg.x11LibDir + (existing ? `:${existing}` : '');
}

function exec(cmd, args, env) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { env: env || process.env, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`${cmd} failed: ${stderr || err.message}`));
      resolve(stdout);
    });
  });
}

function pickDisplay() {
  // Displays 95..130; skip ones already in use by our sessions.
  const used = new Set();
  for (const s of sessions.values()) used.add(s.displayNum);
  for (let n = 95; n <= 130; n++) {
    if (!used.has(n)) return n;
  }
  throw new Error('No free display numbers available');
}

function seedSimulatorConfig(homeDir, pdxDir) {
  const confDir = path.join(homeDir, '.config', 'Playdate Simulator');
  fs.mkdirSync(confDir, { recursive: true });
  const confPath = path.join(confDir, 'Playdate Simulator.ini');
  const content = [
    `file1=${pdxDir}`,
    'file2=', 'file3=', 'file4=', 'file5=', 'file6=',
    'ShowPerfWarning=0',
    'ShowElist=0',
    '[LastUsed]',
    `PDXDirectory=${pdxDir}/`,
    'Release=3.1.2',
    '',
  ].join('\n');
  fs.writeFileSync(confPath, content);
  return confPath;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function findWindow(displayEnv, timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const out = await exec(cfg.xdotoolPath, ['search', '--name', '^Playdate Simulator$'], displayEnv);
      const ids = out.split('\n').map((s) => s.trim()).filter(Boolean);
      if (ids.length) return ids[ids.length - 1];
    } catch {
      // ignore, retry
    }
    await sleep(250);
  }
  throw new Error('Timed out waiting for the Playdate Simulator window');
}

/**
 * Splits a raw MJPEG byte stream into JPEG frames.
 */
class FrameSplitter {
  constructor() {
    this.buf = Buffer.alloc(0);
  }

  push(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    const frames = [];
    while (true) {
      const start = this.buf.indexOf(Buffer.from([0xff, 0xd8]));
      if (start < 0) {
        // keep tail (could be partial marker)
        this.buf = this.buf.subarray(Math.max(0, this.buf.length - 1));
        break;
      }
      if (start > 0) this.buf = this.buf.subarray(start);
      const end = this.buf.indexOf(Buffer.from([0xff, 0xd9]), 2);
      if (end < 0) break;
      frames.push(this.buf.subarray(0, end + 2));
      this.buf = this.buf.subarray(end + 2);
    }
    return frames;
  }
}

class Session extends EventEmitter {
  constructor(game, opts = {}) {
    super();
    this.id = crypto.randomBytes(6).toString('hex');
    this.game = game;
    this.displayNum = opts.displayNum;
    this.state = 'starting';
    this.createdAt = Date.now();
    this.lastInputAt = Date.now();
    this.lastFrameAt = Date.now();
    this.windowId = null;
    this.display = `127.0.0.1:${this.displayNum}.0`;
    this.homeDir = path.join(cfg.sessionsDir, this.id, 'home');
    this.captureProc = null;
    this.simulatorProc = null;
    this.xvfbProc = null;
    this.frameSubscribers = new Set();
    this.splitter = new FrameSplitter();
    this.frameCount = 0;
    this.lastFrame = null;
    this.error = null;
    this.docked = true;
    this.crankAngle = 0;
    this.buttonsDown = new Set();
    this.displayEnv = null;
    this.cleanupTimer = null;
  }

  baseEnv() {
    return {
      ...process.env,
      HOME: this.homeDir,
      DISPLAY: this.display,
      GDK_BACKEND: 'x11',
      WEBKIT_DISABLE_COMPOSITING_MODE: '1',
      XDG_CONFIG_HOME: path.join(this.homeDir, '.config'),
      XDG_CACHE_HOME: path.join(this.homeDir, '.cache'),
      XDG_DATA_HOME: path.join(this.homeDir, '.local', 'share'),
      LD_LIBRARY_PATH: libPathEnv(),
    };
  }

  async start() {
    try {
      for (const [label, bin] of [
        ['Xvfb', cfg.xvfbPath],
        ['xdotool', cfg.xdotoolPath],
        ['PlaydateSimulator', cfg.simulatorPath],
      ]) {
        if (!fs.existsSync(bin)) {
          throw new Error(`${label} not found at ${bin}. Run scripts/setup-x11.sh (or set X11_VENDOR_DIR).`);
        }
      }
      fs.mkdirSync(this.homeDir, { recursive: true });
      seedSimulatorConfig(this.homeDir, this.game.pdxDir);
      this.displayEnv = this.baseEnv();

      // 1. Start Xvfb on a TCP display (avoids needing root-owned /tmp/.X11-unix).
      this.xvfbProc = spawn(cfg.xvfbPath, [
        `:${this.displayNum}`,
        '-screen', '0', `${cfg.displayWidth}x${cfg.displayHeight}x24`,
        '-listen', 'tcp',
        '-extension', 'GLX',
        '-xkbdir', path.join(cfg.vendorX11Dir, 'usr', 'share', 'X11', 'xkb'),
        '-nolisten', 'unix',
      ], { env: this.baseEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
      this.xvfbProc.stdout.on('data', () => {});
      this.xvfbProc.stderr.on('data', () => {});
      this.xvfbProc.on('error', (err) => this.fail(`Xvfb spawn error: ${err.message}`));
      this.xvfbProc.on('exit', (code) => {
        if (this.state !== 'stopped') this.fail(`Xvfb exited with code ${code}`);
      });

      await sleep(900);

      // 2. Start the official Playdate Simulator with the game bundle.
      this.simulatorProc = spawn(cfg.simulatorPath, [this.game.pdxDir], {
        env: this.baseEnv(),
        cwd: cfg.workspace,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      this.simulatorProc.stdout.on('data', (d) => {
        const text = d.toString();
        if (text.trim()) this.emit('log', text.trim());
      });
      this.simulatorProc.stderr.on('data', () => {});
      this.simulatorProc.on('error', (err) => this.fail(`Simulator spawn error: ${err.message}`));
      this.simulatorProc.on('exit', (code) => {
        if (this.state !== 'stopped') this.fail(`Simulator exited with code ${code}`);
      });

      // 3. Locate the window and pin it to a deterministic position.
      this.windowId = await findWindow(this.displayEnv);
      await exec(cfg.xdotoolPath, ['windowmove', this.windowId, String(cfg.windowX), String(cfg.windowY)], this.displayEnv);
      await exec(cfg.xdotoolPath, ['windowfocus', '--sync', this.windowId], this.displayEnv).catch(() => {});

      // 4. Start continuous MJPEG capture of just the 400x240 framebuffer.
      const captureArgs = [
        '-hide_banner', '-loglevel', 'error',
        '-f', 'x11grab',
        '-draw_mouse', '0',
        '-video_size', `${cfg.fbWidth}x${cfg.fbHeight}`,
        '-i', `${this.display}+${cfg.windowX + cfg.fbOffsetX},${cfg.windowY + cfg.fbOffsetY}`,
        '-r', String(cfg.captureFps),
        '-f', 'mjpeg', '-q:v', '6',
        '-pix_fmt', 'yuvj420p',
        'pipe:1',
      ];
      this.captureProc = spawn('ffmpeg', captureArgs, { env: this.baseEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
      this.captureProc.stdout.on('data', (chunk) => {
        const frames = this.splitter.push(chunk);
        for (const frame of frames) {
          this.frameCount += 1;
          this.lastFrameAt = Date.now();
          this.lastFrame = frame;
          this.emit('frame', frame);
          for (const sub of this.frameSubscribers) {
            try { sub(frame); } catch { /* ignore broken subscriber */ }
          }
        }
      });
      this.captureProc.stderr.on('data', () => {});
      this.captureProc.on('error', (err) => this.fail(`Capture spawn error: ${err.message}`));
      this.captureProc.on('exit', (code) => {
        if (this.state !== 'stopped') this.fail(`Capture exited with code ${code}`);
      });

      this.state = 'running';
      this.emit('ready');
    } catch (err) {
      this.fail(err.message);
    }
  }

  fail(message) {
    this.error = message;
    this.state = 'failed';
    this.emit('failed', message);
    this.stop();
  }

  async input(command) {
    if (!this.windowId || this.state !== 'running') {
      throw new Error('Session is not running');
    }
    this.lastInputAt = Date.now();
    const env = this.displayEnv;
    const absX = cfg.windowX;
    const absY = cfg.windowY;

    if (command.type === 'button') {
      const key = buttonKey(command.button);
      if (!key) throw new Error(`Unknown button: ${command.button}`);
      // Refocus before key events so the game view receives them.
      await exec(cfg.xdotoolPath, ['windowfocus', '--sync', this.windowId], env).catch(() => {});
      if (command.action === 'down') {
        await exec(cfg.xdotoolPath, ['keydown', '--clearmodifiers', key], env);
        this.buttonsDown.add(command.button);
      } else {
        await exec(cfg.xdotoolPath, ['keyup', '--clearmodifiers', key], env);
        this.buttonsDown.delete(command.button);
      }
      return { buttons: [...this.buttonsDown] };
    }

    if (command.type === 'crank') {
      // One wheel click = 4 degrees.
      const clicks = Math.max(1, Math.min(90, Math.round(Math.abs(Number(command.delta) || 4) / 4)));
      const button = Number(command.delta) >= 0 ? '4' : '5';
      await exec(cfg.xdotoolPath, ['windowfocus', '--sync', this.windowId], env).catch(() => {});
      for (let i = 0; i < clicks; i++) {
        await exec(cfg.xdotoolPath, ['mousemove', String(absX + 200), String(absY + 150), 'click', button], env);
        await sleep(40);
      }
      this.crankAngle += Number(command.delta) || 0;
      // Moving the crank undocks it in the simulator.
      this.docked = false;
      return { crank: this.crankAngle, docked: this.docked };
    }

    if (command.type === 'dock') {
      // Click the "Docked" checkbox only when the requested state differs
      // from the state we last observed; clicking toggles the checkbox.
      const desired = command.docked === undefined ? !this.docked : Boolean(command.docked);
      if (desired !== this.docked) {
        await exec(cfg.xdotoolPath, ['windowfocus', '--sync', this.windowId], env).catch(() => {});
        await exec(cfg.xdotoolPath, ['mousemove', String(absX + 259), String(absY + 513), 'click', '1'], env);
        this.docked = desired;
      }
      return { docked: this.docked };
    }

    if (command.type === 'menu') {
      await exec(cfg.xdotoolPath, ['windowfocus', '--sync', this.windowId], env).catch(() => {});
      await exec(cfg.xdotoolPath, ['mousemove', String(absX + 454), String(absY + 97), 'click', '1'], env);
      return { menu: true };
    }

    throw new Error(`Unknown command type: ${command.type}`);
  }

  subscribeFrame(fn) {
    this.frameSubscribers.add(fn);
    if (this.lastFrame) fn(this.lastFrame);
    return () => this.frameSubscribers.delete(fn);
  }

  async stop() {
    if (this.state === 'stopped') return;
    this.state = 'stopped';
    const procs = [this.captureProc, this.simulatorProc, this.xvfbProc];
    for (const p of procs) {
      if (p && p.exitCode === null) {
        try { p.kill('SIGTERM'); } catch { /* ignore */ }
      }
    }
    await sleep(300);
    for (const p of procs) {
      if (p && p.exitCode === null) {
        try { p.kill('SIGKILL'); } catch { /* ignore */ }
      }
    }
    sessions.delete(this.id);
    try {
      const dir = path.join(cfg.sessionsDir, this.id);
      if (path.resolve(dir).startsWith(path.resolve(cfg.sessionsDir))) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    } catch { /* ignore */ }
    this.emit('stopped');
  }
}

const BUTTON_KEYS = {
  // Playdate A button maps to the simulator's "S" key.
  A: 's',
  // Playdate B button maps to the simulator's "A" key.
  B: 'a',
  up: 'Up',
  down: 'Down',
  left: 'Left',
  right: 'Right',
};

function buttonKey(name) {
  if (!name) return null;
  return BUTTON_KEYS[name] || BUTTON_KEYS[name.toLowerCase()] || null;
}

async function startSession(game) {
  if (sessions.size >= cfg.maxConcurrentSessions) {
    throw new Error(`Too many running sessions (max ${cfg.maxConcurrentSessions})`);
  }
  const s = new Session(game, { displayNum: pickDisplay() });
  sessions.set(s.id, s);
  await new Promise((resolve, reject) => {
    const onReady = () => { cleanup(); resolve(); };
    const onFailed = (msg) => { cleanup(); reject(new Error(msg)); };
    const cleanup = () => {
      s.off('ready', onReady);
      s.off('failed', onFailed);
    };
    s.on('ready', onReady);
    s.on('failed', onFailed);
    s.start();
    setTimeout(() => {
      if (s.state === 'starting') {
        cleanup();
        s.fail('Session startup timed out');
        reject(new Error('Session startup timed out'));
      }
    }, 25000);
  });
  return s;
}

function getSession(id) {
  return sessions.get(id) || null;
}

function listSessions() {
  return [...sessions.values()].map((s) => ({
    id: s.id,
    gameId: s.game.id,
    title: s.game.title,
    state: s.state,
    createdAt: s.createdAt,
    frameCount: s.frameCount,
    error: s.error,
    docked: s.docked,
    crank: s.crankAngle,
  }));
}

function reapIdleSessions() {
  const now = Date.now();
  for (const s of sessions.values()) {
    if (s.state === 'running' && now - s.lastInputAt > cfg.sessionIdleTimeoutMs) {
      s.stop().catch(() => {});
    }
  }
}

setInterval(reapIdleSessions, 60 * 1000).unref();

module.exports = {
  Session,
  startSession,
  getSession,
  listSessions,
  sessions,
  buttonKey,
};
