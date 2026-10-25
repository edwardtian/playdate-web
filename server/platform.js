'use strict';

// Platform abstraction: how to run the Playdate Simulator, capture its screen,
// and send input. Two implementations: linux.js (Xvfb + xdotool) and
// darwin.js (native GUI session + screencapture + cliclick).

const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const cfg = require('./config');

function exec(cmd, args, env, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { env: env || process.env, maxBuffer: 8 * 1024 * 1024, timeout: timeoutMs },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(`${cmd} failed: ${stderr || err.message}`));
        resolve(stdout);
      });
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Splits a raw MJPEG byte stream into JPEG frames (SOI..EOI).
class FrameSplitter {
  constructor() { this.buf = Buffer.alloc(0); }
  push(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    const frames = [];
    while (true) {
      const start = this.buf.indexOf(Buffer.from([0xff, 0xd8]));
      if (start < 0) { this.buf = this.buf.subarray(Math.max(0, this.buf.length - 1)); break; }
      if (start > 0) this.buf = this.buf.subarray(start);
      const end = this.buf.indexOf(Buffer.from([0xff, 0xd9]), 2);
      if (end < 0) break;
      frames.push(this.buf.subarray(0, end + 2));
      this.buf = this.buf.subarray(end + 2);
    }
    return frames;
  }
}

function seedSimulatorConfig(homeDir, pdxDir) {
  const confDir = path.join(homeDir, '.config', 'Playdate Simulator');
  fs.mkdirSync(confDir, { recursive: true });
  const confPath = path.join(confDir, 'Playdate Simulator.ini');
  const content = [
    `file1=${pdxDir}`, 'file2=', 'file3=', 'file4=', 'file5=', 'file6=',
    'ShowPerfWarning=0', 'ShowElist=0', '[LastUsed]', `PDXDirectory=${pdxDir}/`,
    'Release=3.1.2', '',
  ].join('\n');
  fs.writeFileSync(confPath, content);
  seedGlobalSettings();
}

// The Playdate OS keeps the device volume in Disk/System/Data/global.settings.
// The simulator starts with volume 0 when that key is missing, which makes
// every game silent.  Seed a sensible volume once; afterwards respect an
// explicit non-zero user setting.
function seedGlobalSettings(volume = cfg.defaultSystemVolume) {
  if (cfg.isMac) return;
  const level = Number.isFinite(Number(volume))
    ? Math.max(0, Math.min(255, Math.round(Number(volume))))
    : 200;
  const file = path.join(cfg.workspace, 'Disk', 'System', 'Data', 'global.settings');
  fs.mkdirSync(path.dirname(file), { recursive: true });

  let lines = [];
  try {
    lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  } catch { /* file doesn't exist yet */ }
  while (lines.length && lines[lines.length - 1] === '') lines.pop();

  let found = false;
  let current = NaN;
  lines = lines.map((line) => {
    const m = line.match(/^volume=(\d+)\s*$/);
    if (!m) return line;
    found = true;
    current = Number(m[1]);
    return line;
  });

  if (!found) {
    lines.push(`volume=${level}`);
  } else if (!Number.isFinite(current) || current <= 0) {
    lines = lines.map((line) => (line.startsWith('volume=') ? `volume=${level}` : line));
  } else {
    return; // Respect an explicit non-zero volume chosen in the simulator UI.
  }
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
}

// Detect the host platform and return its module.
function loadPlatform() {
  if (process.platform === 'darwin') {
    return require('./platform/darwin');
  }
  return require('./platform/linux');
}

module.exports = {
  exec,
  sleep,
  FrameSplitter,
  seedSimulatorConfig,
  seedGlobalSettings,
  loadPlatform,
  cfg,
};
