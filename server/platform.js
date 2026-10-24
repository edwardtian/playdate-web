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
  loadPlatform,
  cfg,
};
