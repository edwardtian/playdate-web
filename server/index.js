'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { URL } = require('node:url');

const cfg = require('./config');
const { isZip, extractZip, findPdxRoot } = require('./ziputil');
const games = require('./games');
const sessions = require('./sessions');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
    'Cache-Control': 'no-store',
  });
  res.end(data);
}

function text(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(body);
}

function safeId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(id);
}

function readBody(req, limitBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > limitBytes) {
        reject(new Error(`Upload exceeds ${limitBytes} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function handleUpload(req, res, url) {
  const filename = url.searchParams.get('name') || req.headers['x-filename'] || '';
  let body;
  try {
    body = await readBody(req, cfg.maxUploadBytes);
  } catch (err) {
    return json(res, 413, { error: err.message });
  }
  if (!body.length) return json(res, 400, { error: 'Empty upload' });

  const workId = crypto.randomBytes(8).toString('hex');
  const workDir = path.join(cfg.tmpDir, workId);
  fs.mkdirSync(workDir, { recursive: true });

  try {
    let pdxRoot = null;

    if (isZip(body)) {
      const zipPath = path.join(workDir, 'upload.zip');
      fs.writeFileSync(zipPath, body);
      const extractDir = path.join(workDir, 'extracted');
      await extractZip(zipPath, extractDir);
      pdxRoot = findPdxRoot(extractDir);
      if (!pdxRoot) {
        return json(res, 400, {
          error: 'Uploaded zip does not contain a Playdate bundle (expected pdxinfo and main.pdz).',
        });
      }
    } else {
      // Not a zip: reject with a helpful message.
      return json(res, 400, {
        error: 'Upload must be a .zip containing a compiled Playdate .pdx bundle (pdxinfo + main.pdz).',
      });
    }

    const meta = games.registerGame(pdxRoot, { source: 'upload' });
    return json(res, 201, { game: meta });
  } catch (err) {
    return json(res, 400, { error: err.message });
  } finally {
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

function streamFrames(req, res, session) {
  res.writeHead(200, {
    'Content-Type': 'multipart/x-mixed-replace; boundary=frame',
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    'Pragma': 'no-cache',
    'Connection': 'close',
    'X-Accel-Buffering': 'no',
  });
  res.socket?.setNoDelay?.(true);
  res.flushHeaders?.();

  // One write per frame keeps the TCP stream from being split into three
  // small chunks.  Slow clients get frames dropped rather than growing an
  // unbounded latency queue.
  const writeFrame = (frame) => {
    if (res.writableEnded) return;
    if (res.writableLength > 256 * 1024) return;
    const header = Buffer.from(
      `--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.length}\r\n\r\n`,
    );
    res.write(Buffer.concat([header, frame, Buffer.from('\r\n')]));
  };

  const unsubscribe = session.subscribeFrame(writeFrame);
  const finish = () => {
    unsubscribe();
    session.off('frameEnd', finish);
    if (!res.writableEnded) res.end();
  };
  session.once('frameEnd', finish);
  req.on('close', finish);
  // No keep-alive parts: only image frames are written, so browsers never
  // see a non-image multipart part.
}

function streamAudio(req, res, session) {
  if (!session.audioAvailable) {
    return json(res, 404, { error: 'Audio is not available for this session' });
  }
  res.writeHead(200, {
    'Content-Type': 'audio/L16;rate=48000;channels=2',
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    'Pragma': 'no-cache',
    'Connection': 'close',
    'X-Accel-Buffering': 'no',
    'Accept-Ranges': 'none',
  });
  res.socket?.setNoDelay?.(true);
  res.flushHeaders?.();

  const writeAudio = (chunk) => {
    if (res.writableEnded) return;
    // Do not let a stalled client build seconds of PCM latency.  Dropping a
    // chunk is audible, but the alternative is sound that lags behind input.
    if (res.writableLength > 256 * 1024) return;
    res.write(chunk);
  };

  const unsubscribe = session.subscribeAudio(writeAudio);
  const finish = () => {
    unsubscribe();
    session.off('audioEnd', finish);
    if (!res.writableEnded) res.end();
  };
  session.once('audioEnd', finish);
  req.on('close', finish);
}

function serveStatic(req, res, urlPath) {
  const rel = urlPath === '/' ? '/index.html' : urlPath;
  const filePath = path.join(cfg.publicDir, rel);
  const normalized = path.resolve(filePath);
  if (!normalized.startsWith(path.resolve(cfg.publicDir))) {
    return text(res, 403, 'Forbidden');
  }
  if (!fs.existsSync(normalized) || !fs.statSync(normalized).isFile()) {
    return text(res, 404, 'Not found');
  }
  const ext = path.extname(normalized).toLowerCase();
  const data = fs.readFileSync(normalized);
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': data.length,
    'Cache-Control': 'no-cache',
  });
  res.end(data);
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  // CORS not needed (same origin), but allow simple OPTIONS for tooling.
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  if (pathname === '/api/health') {
    return json(res, 200, { ok: true, sessions: sessions.listSessions() });
  }

  if (pathname === '/api/games') {
    if (req.method === 'GET') return json(res, 200, { games: games.listGames() });
    if (req.method === 'POST') return handleUpload(req, res, url);
    return json(res, 405, { error: 'Method not allowed' });
  }

  if (pathname === '/api/sessions') {
    if (req.method === 'GET') return json(res, 200, { sessions: sessions.listSessions() });
    if (req.method === 'POST') {
      const body = await readBody(req, 64 * 1024).catch(() => Buffer.from('{}'));
      let payload = {};
      try { payload = JSON.parse(body.toString() || '{}'); } catch { /* ignore */ }
      if (!safeId(payload.gameId)) return json(res, 400, { error: 'gameId is required' });
      const game = games.getGame(payload.gameId);
      if (!game) return json(res, 404, { error: 'Game not found' });
      try {
        const s = await sessions.startSession(game);
        return json(res, 201, {
          session: {
            id: s.id,
            gameId: s.game.id,
            title: s.game.title,
            state: s.state,
            framesUrl: `/api/sessions/${s.id}/frames`,
            inputUrl: `/api/sessions/${s.id}/input`,
            audioUrl: s.audioAvailable ? `/api/sessions/${s.id}/audio` : null,
            audio: s.audioAvailable,
          },
        });
      } catch (err) {
        return json(res, 503, { error: err.message });
      }
    }
    return json(res, 405, { error: 'Method not allowed' });
  }

  const gm = pathname.match(/^\/api\/games\/([A-Za-z0-9_-]{1,64})$/);
  if (gm) {
    const id = gm[1];
    if (!safeId(id)) return json(res, 400, { error: 'Bad game id' });
    if (req.method === 'DELETE') {
      const ok = games.deleteGame(id);
      if (!ok) return json(res, 404, { error: 'Game not found' });
      return json(res, 200, { deleted: true });
    }
    if (req.method === 'GET') {
      const game = games.getGame(id);
      if (!game) return json(res, 404, { error: 'Game not found' });
      return json(res, 200, { game });
    }
    return json(res, 405, { error: 'Method not allowed' });
  }

  const m = pathname.match(/^\/api\/sessions\/([A-Za-z0-9_-]{1,64})(?:\/(frames|input|audio|stop))?$/);
  if (m) {
    const id = m[1];
    const sub = m[2];
    if (!safeId(id)) return json(res, 400, { error: 'Bad session id' });
    const session = sessions.getSession(id);
    if (!session) return json(res, 404, { error: 'Session not found' });

    if (!sub && req.method === 'DELETE') {
      await session.stop();
      return json(res, 200, { stopped: true });
    }
    if (!sub && req.method === 'GET') {
      return json(res, 200, {
        session: {
          id: session.id,
          gameId: session.game.id,
          title: session.game.title,
          state: session.state,
          frameCount: session.frameCount,
          docked: session.docked,
          crank: session.crankAngle,
          audio: session.audioAvailable,
          audioBytes: session.audioBytes,
          error: session.error,
        },
      });
    }
    if (sub === 'frames' && req.method === 'GET') {
      return streamFrames(req, res, session);
    }
    if (sub === 'audio' && req.method === 'GET') {
      return streamAudio(req, res, session);
    }
    // navigator.sendBeacon() can only POST.  Used by the pagehide handler so
    // closing the tab does not leave a simulator running.
    if (sub === 'stop' && req.method === 'POST') {
      await session.stop();
      return json(res, 200, { stopped: true });
    }
    if (sub === 'input' && req.method === 'POST') {
      let payload;
      try {
        const body = await readBody(req, 64 * 1024);
        payload = JSON.parse(body.toString() || '{}');
      } catch {
        return json(res, 400, { error: 'Invalid JSON body' });
      }
      try {
        const result = await session.input(payload);
        return json(res, 200, { ok: true, ...result });
      } catch (err) {
        return json(res, 400, { error: err.message });
      }
    }
    return json(res, 405, { error: 'Method not allowed' });
  }

  // Static files
  if (req.method === 'GET') return serveStatic(req, res, pathname);
  return text(res, 405, 'Method not allowed');
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    if (!res.headersSent) json(res, 500, { error: err.message });
    else if (!res.writableEnded) res.end();
  });
});

server.listen(cfg.port, cfg.host, () => {
  console.log(`Playdate Web Simulator running at http://${cfg.host}:${cfg.port}`);
  console.log(`SDK: ${cfg.sdkPath}`);
});

// On a normal server stop, take the simulator/ffmpeg/Xvfb children and the
// per-session PulseAudio sinks with us instead of leaving orphans behind.
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${signal}; stopping ${sessions.sessions.size} session(s)…`);
  await Promise.all([...sessions.sessions.values()].map((s) => s.stop().catch(() => {})));
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', () => { shutdown('SIGINT'); });
process.on('SIGTERM', () => { shutdown('SIGTERM'); });

module.exports = server;
