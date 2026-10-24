'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

const cfg = require('./config');
const { FrameSplitter, loadPlatform } = require('./platform');

const platform = loadPlatform();
const sessions = new Map();

class Session extends EventEmitter {
  constructor(game) {
    super();
    this.id = crypto.randomBytes(6).toString('hex');
    this.game = game;
    this.state = 'starting';
    this.createdAt = Date.now();
    this.lastInputAt = Date.now();
    this.lastFrameAt = Date.now();
    this.homeDir = path.join(cfg.sessionsDir, this.id, 'home');
    this.splitter = new FrameSplitter();
    this.frameSubscribers = new Set();
    this.frameCount = 0;
    this.lastFrame = null;
    this.error = null;
    this.docked = true;
    this.crankAngle = 0;
    this.buttonsDown = new Set();
    this.impl = null;
  }

  pushFrame(frame) {
    this.frameCount += 1;
    this.lastFrameAt = Date.now();
    this.lastFrame = frame;
    this.emit('frame', frame);
    for (const sub of this.frameSubscribers) {
      try { sub(frame); } catch { /* broken subscriber */ }
    }
  }

  async start() {
    try {
      fs.mkdirSync(this.homeDir, { recursive: true });
      this.impl = process.platform === 'darwin'
        ? new platform.DarwinSession(this)
        : new platform.LinuxSession(this);
      await this.impl.start();
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
    if (this.state !== 'running' || !this.impl) {
      throw new Error('Session is not running');
    }
    this.lastInputAt = Date.now();

    if (command.type === 'button') {
      const button = command.button;
      if (!['A', 'B', 'up', 'down', 'left', 'right'].includes(button)) {
        throw new Error(`Unknown button: ${button}`);
      }
      if (command.action === 'down') {
        await this.impl.sendButton(button, 'down');
        this.buttonsDown.add(button);
      } else {
        await this.impl.sendButton(button, 'up');
        this.buttonsDown.delete(button);
      }
      return { buttons: [...this.buttonsDown] };
    }

    if (command.type === 'crank') {
      await this.impl.crank(command.delta);
      this.crankAngle += Number(command.delta) || 0;
      this.docked = false;
      return { crank: this.crankAngle, docked: this.docked };
    }

    if (command.type === 'dock') {
      const desired = command.docked === undefined ? !this.docked : Boolean(command.docked);
      if (desired !== this.docked) {
        await this.impl.setDocked(desired);
        this.docked = desired;
      }
      return { docked: this.docked };
    }

    if (command.type === 'menu') {
      await this.impl.menu();
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
    try { if (this.impl) await this.impl.stop(); } catch { /* ignore */ }
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

async function startSession(game) {
  if (sessions.size >= cfg.maxConcurrentSessions) {
    throw new Error(`Too many running sessions (max ${cfg.maxConcurrentSessions})`);
  }
  const s = new Session(game);
  sessions.set(s.id, s);
  await new Promise((resolve, reject) => {
    const onReady = () => { cleanup(); resolve(); };
    const onFailed = (msg) => { cleanup(); reject(new Error(msg)); };
    const cleanup = () => { s.off('ready', onReady); s.off('failed', onFailed); };
    s.on('ready', onReady);
    s.on('failed', onFailed);
    s.start();
    setTimeout(() => {
      if (s.state === 'starting') {
        cleanup();
        s.fail('Session startup timed out');
        reject(new Error('Session startup timed out'));
      }
    }, 30000);
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
};
