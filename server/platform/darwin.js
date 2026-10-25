'use strict';

// macOS (darwin) platform: run the simulator in the user's GUI session via
// `open -na`, capture the window with `screencapture -l<winid> -x`, crop to
// the framebuffer, and send input with `cliclick` (precise coords) with an
// osascript keystroke fallback.
//
// IMPORTANT: unlike Linux, there is no virtual display. The simulator window
// appears on the logged-in user's screen. The Mac mini must be logged in and
// not asleep for this to work. Use a dedicated user account and disable
// display sleep / screen saver for a headless-ish deployment.
//
// One-time setup on the Mac:
//   brew install cliclick
//   # Grant Terminal/your app "Screen Recording" and "Accessibility" in
//   # System Settings > Privacy & Security.

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { exec, sleep, seedSimulatorConfig, cfg } = require('../platform');

const SIM_APP = cfg.simulatorAppPath;
const SIM_BINARY = cfg.simulatorPath;

// On macOS, keyboard: arrows = D-pad, a = B, s = A. Crank: [ = forward, ] = back.
const KEY_NAME = {
  up: 'up', down: 'down', left: 'left', right: 'right',
  A: 's', B: 'a',
};

// cliclick key names differ; map to its syntax.
function cliclickKey(key) {
  const map = {
    up: 'up', down: 'down', left: 'left', right: 'right',
    s: 's', a: 'a', '[': '[', ']': ']',
  };
  return map[key] || key;
}

async function haveCliclick() {
  try { await exec('cliclick', ['-V']); return true; } catch { return false; }
}

// Find the simulator's window ID via a small AppleScript.
async function findWindowId(timeoutMs = 25000) {
  const script = `
    tell application "System Events"
      set procs to every process whose name is "PlaydateSimulator"
      if (count of procs) is 0 then return ""
      set proc to item 1 of procs
      set wins to every window of proc
      repeat with w in wins
        if name of w is "Playdate Simulator" then
          return id of w as string
        end if
      end repeat
      return ""
    end tell`;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const out = (await exec('osascript', ['-e', script])).trim();
      if (out) return out;
    } catch { /* retry */ }
    await sleep(300);
  }
  throw new Error('Timed out waiting for the Playdate Simulator window (macOS)');
}

// Get window position and size via AppleScript.
async function windowGeometry(winId) {
  const script = `
    tell application "System Events"
      set proc to first process whose name is "PlaydateSimulator"
      set w to first window of proc whose id is ${winId}
      set pos to position of w
      set sz to size of w
      return (item 1 of pos as string) & "," & (item 2 of pos as string) & "," & (item 1 of sz as string) & "," & (item 2 of sz as string)
    end tell`;
  const out = (await exec('osascript', ['-e', script])).trim();
  const [x, y, w, h] = out.split(',').map(Number);
  return { x, y, w, h };
}

// Move the window to a deterministic position.
async function positionWindow(winId, x, y) {
  const script = `
    tell application "System Events"
      set proc to first process whose name is "PlaydateSimulator"
      set w to first window of proc whose id is ${winId}
      set position of w to {${x}, ${y}}
    end tell`;
  await exec('osascript', ['-e', script]);
}

// Bring the window to the front and activate it.
async function activateWindow(winId) {
  const script = `
    tell application "System Events"
      set proc to first process whose name is "PlaydateSimulator"
      set frontmost of proc to true
      try
        set w to first window of proc whose id is ${winId}
        perform action "AXRaise" of w
      end try
    end tell`;
  await exec('osascript', ['-e', script]);
}

// Capture the framebuffer region as JPEG. Uses screencapture to grab the
// window, then crops with `sips` if available; falls back to capturing a
// screen rect directly.
class Capture {
  constructor(session) {
    this.s = session;
    this.winId = null;
    this.geom = null;
    this.useSips = null;
    this.interval = null;
    this.tmpFile = null;
  }

  async init(winId) {
    this.winId = winId;
    this.geom = await windowGeometry(winId);
    try { await exec('sips', ['-h']); this.useSips = true; } catch { this.useSips = false; }
    this.tmpFile = path.join(this.s.homeDir, 'capture.jpg');
  }

  // The macOS simulator window layout: the framebuffer sits at a fixed offset.
  // We calibrate once by finding the bezel (a large light-gray rectangle) inside
  // the captured window. Falls back to a hardcoded offset if calibration fails.
  framebufferRect() {
    if (this._rect) return this._rect;
    // Hardcoded default (title bar ~28px + bezel offsets measured on macOS).
    return {
      x: this.geom.x + 17,
      y: this.geom.y + 28 + 45,
      w: cfg.fbWidth,
      h: cfg.fbHeight,
    };
  }

  async calibrate() {
    // Capture the full window and find the Playdate screen bezel: a large
    // near-uniform light-gray rectangle. Then derive the inner framebuffer.
    try {
      const full = path.join(this.s.homeDir, 'calibrate.png');
      await exec('screencapture', ['-x', '-l', this.winId, full]);
      const img = fs.readFileSync(full);
      // Find the bounding box of "bezel gray" pixels (roughly 215-230 in all channels).
      // We do a simple scan using `sips` to get raw pixels via a PPM conversion.
      const ppm = path.join(this.s.homeDir, 'calibrate.ppm');
      await exec('sips', ['-s', 'format', 'ppm', full, '--out', ppm]);
      const raw = fs.readFileSync(ppm);
      // Parse binary PPM (P6).
      const header = raw.toString('latin1', 0, 256);
      const m = header.match(/P6\s+(\d+)\s+(\d+)\s+255\s/);
      if (!m) throw new Error('bad ppm');
      const [w, h] = [Number(m[1]), Number(m[2])];
      const headerLen = m[0].length;
      const pix = raw.subarray(headerLen);
      let minX = w, minY = h, maxX = -1, maxY = -1;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = (y * w + x) * 3;
          const r = pix[i], g = pix[i + 1], b = pix[i + 2];
          // bezel gray ~ (216, 212, 200) with tolerance
          if (Math.abs(r - g) < 14 && Math.abs(g - b) < 14 && r >= 195 && r <= 235) {
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
        }
      }
      if (maxX < 0 || (maxX - minX) < 300 || (maxY - minY) < 200) throw new Error('no bezel');
      // The inner screen is inset by the bezel border (~17px left, ~45px top in
      // the Linux layout; on macOS it's roughly proportional).
      const bezelW = maxX - minX + 1;
      const bezelH = maxY - minY + 1;
      const insetX = Math.round(bezelW * (17 / 434));
      const insetY = Math.round(bezelH * (45 / 257));
      this._rect = {
        x: this.geom.x + minX + insetX,
        y: this.geom.y + minY + insetY,
        w: cfg.fbWidth,
        h: cfg.fbHeight,
      };
      try { fs.unlinkSync(full); fs.unlinkSync(ppm); } catch {}
    } catch {
      // keep hardcoded default
      this._rect = null;
    }
  }

  async grabOnce() {
    const r = this.framebufferRect();
    // screencapture -R<x,y,w,h> captures a screen region directly (fast).
    await exec('screencapture', [
      '-x',               // no sound
      '-t', 'jpg',
      '-R', `${r.x},${r.y},${r.w},${r.h}`,
      this.tmpFile,
    ]);
    return fs.readFileSync(this.tmpFile);
  }

  start(onFrame, fps) {
    const intervalMs = Math.max(33, Math.round(1000 / fps));
    this.interval = setInterval(async () => {
      try {
        const frame = await this.grabOnce();
        onFrame(frame);
      } catch { /* a missed frame is fine */ }
    }, intervalMs);
  }

  stop() {
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
  }
}

class DarwinSession {
  constructor(session) {
    this.s = session;
    this.simulatorProc = null;
    this.winId = null;
    this.capture = new Capture(session);
    this.homeDir = session.homeDir;
    this._cliclick = null;
    this.crankRemainder = 0;
  }

  baseEnv() {
    return {
      ...process.env,
      HOME: this.homeDir,
    };
  }

  async start() {
    if (!fs.existsSync(SIM_BINARY)) {
      throw new Error(
        `Playdate Simulator.app not found at ${SIM_APP}. ` +
        `Install the Playdate SDK and set PLAYDATE_SIM_APP if it's elsewhere.`
      );
    }
    this._cliclick = await haveCliclick();

    seedSimulatorConfig(this.homeDir, this.s.game.pdxDir);

    // Launch the simulator binary directly with a per-session HOME so each
    // instance gets its own config (and no dialog). We avoid `open` because
    // it doesn't reliably propagate a custom HOME to the app.
    this.simulatorProc = spawn(SIM_BINARY, [this.s.game.pdxDir], {
      env: this.baseEnv(), stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.simulatorProc.stdout.on('data', (d) => {
      const text = d.toString(); if (text.trim()) this.s.emit('log', text.trim());
    });
    this.simulatorProc.on('error', (err) => this.s.fail(`spawn error: ${err.message}`));
    this.simulatorProc.on('exit', (code) => {
      if (this.s.state !== 'stopped') this.s.fail(`Simulator exited with code ${code}`);
    });

    this.winId = await findWindowId();
    await positionWindow(this.winId, cfg.windowX, cfg.windowY).catch(() => {});
    await activateWindow(this.winId).catch(() => {});

    await this.capture.init(this.winId);
    await this.capture.calibrate();
    this.capture.start((frame) => this.s.pushFrame(frame), cfg.captureFps);
  }

  async sendButton(button, action) {
    const key = KEY_NAME[button];
    if (!key) throw new Error(`Unknown button: ${button}`);
    if (this._cliclick) {
      // cliclick key press: kd:<key> / ku:<key>
      await activateWindow(this.winId).catch(() => {});
      await exec('cliclick', [`${action === 'down' ? 'kd' : 'ku'}:${cliclickKey(key)}`]);
    } else {
      // osascript keystroke fallback (sends discrete key press, not hold).
      if (action !== 'down') return;
      const script = `
        tell application "System Events"
          set proc to first process whose name is "PlaydateSimulator"
          set frontmost of proc to true
          tell application "System Events" to keystroke "${key}"
        end tell`;
      await exec('osascript', ['-e', script]);
    }
  }

  async crank(delta) {
    this.crankRemainder += Number(delta) || 0;
    let steps = Math.trunc(this.crankRemainder / 4);
    if (!steps) return false;
    this.crankRemainder -= steps * 4;
    const key = steps > 0 ? '[' : ']';
    let remaining = Math.abs(steps);
    while (remaining > 0) {
      const n = Math.min(90, remaining);
      if (this._cliclick) {
        await activateWindow(this.winId).catch(() => {});
        // cliclick accepts several space-separated commands in one process.
        const sequence = Array.from({ length: n }, () => `kp:${cliclickKey(key)}`).join(' ');
        await exec('cliclick', [sequence]);
      } else {
        // Fallback: scroll wheel over the screen.
        await activateWindow(this.winId).catch(() => {});
        const r = this.capture.framebufferRect();
        const cx = r.x + r.w / 2;
        const cy = r.y + r.h / 2;
        const dir = steps > 0 ? '+' : '-';
        for (let i = 0; i < n; i++) {
          await exec('cliclick', [`m:${cx},${cy}`, `w:${dir}1`]);
        }
      }
      remaining -= n;
    }
    return true;
  }

  async setDocked(desired) {
    // Click the "Docked" checkbox at its position within the window.
    await activateWindow(this.winId).catch(() => {});
    const g = this.capture.geom;
    // Docked checkbox measured at rel (259, 513) in the 482x708 window.
    await exec('cliclick', [`c:${g.x + 259},${g.y + 513}`]);
  }

  async menu() {
    // macOS simulator: Menu button = Escape key.
    await activateWindow(this.winId).catch(() => {});
    if (this._cliclick) {
      await exec('cliclick', ['kp:esc']);
    } else {
      const script = `tell application "System Events" to key code 53`; // Escape
      await exec('osascript', ['-e', script]);
    }
  }

  async stop() {
    this.capture.stop();
    if (this.simulatorProc && this.simulatorProc.exitCode === null) {
      try { this.simulatorProc.kill('SIGTERM'); } catch {}
    }
    // Also quit the simulator instance via AppleScript so it doesn't linger.
    const script = `
      tell application "System Events"
        set procs to every process whose name is "PlaydateSimulator"
        repeat with p in procs
          try
            tell application "System Events" to keystroke "q" using command down
          end try
        end repeat
      end tell`;
    try { await exec('osascript', ['-e', script]); } catch {}
  }
}

module.exports = { DarwinSession };
