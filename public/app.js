'use strict';

// ---- App state --------------------------------------------------------------

const state = {
  games: [],
  session: null,
  frameUrl: null,
  frameMode: null,
  frameAbort: null,
  frameToken: 0,
  canvasCtx: null,
  decoding: false,
  pendingFrame: null,
  dialAngle: 0,
  crankVisual: 0,
  crankPending: 0,
  crankInFlight: 0,
  crankFlushTimer: null,
  dragging: false,
  lastPointerAngle: 0,
  docked: true,
  buttonDown: new Set(),
  pollTimer: null,
  lastFrameAt: 0,
};

const el = (id) => document.getElementById(id);
const SCREEN_W = 400;
const SCREEN_H = 240;
const CRANK_TICK_DEGREES = 4;
const AUDIO_SAMPLE_RATE = 48000;
const AUDIO_LEAD_SECONDS = 0.15;
const AUDIO_MAX_LEAD_SECONDS = 0.4;

// Low-latency game audio.  The server sends raw interleaved s16le PCM; we
// schedule small AudioBuffers directly in the Web Audio graph.  A media
// element (<audio>) adds seconds of startup buffering to a live stream, which
// made short effects such as the MENU pop arrive several seconds late.
const audio = {
  ctx: null,
  gain: null,
  abort: null,
  url: null,
  token: 0,
  started: false,
  available: false,
  muted: false,
  nextTime: 0,
  sources: new Set(),
};

// ---- API helpers ------------------------------------------------------------

async function api(path, opts = {}) {
  const res = await fetch(path, opts);
  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
    return body;
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res;
}

async function loadGames() {
  const data = await api('/api/games');
  state.games = data.games || [];
  renderGames();
}

function formatBytes(n) {
  if (!n) return '0 B';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function renderGames() {
  const list = el('gameList');
  list.innerHTML = '';
  if (!state.games.length) {
    el('libraryEmpty').style.display = 'block';
    return;
  }
  el('libraryEmpty').style.display = 'none';
  for (const g of state.games) {
    const li = document.createElement('li');
    li.className = 'game-card';
    li.innerHTML = `
      <div class="game-main">
        <div class="game-title">${escapeHtml(g.title)}</div>
        <div class="game-sub">${escapeHtml(g.author)} · v${escapeHtml(g.version || '—')}</div>
        ${g.description ? `<div class="game-desc">${escapeHtml(g.description)}</div>` : ''}
        <div class="game-meta">${formatBytes(g.sizeBytes)} · ${g.fileCount} files</div>
      </div>
      <div class="game-actions">
        <button class="btn btn-primary play-btn" data-id="${g.id}">Play</button>
      </div>
    `;
    li.querySelector('.play-btn').addEventListener('click', () => playGame(g.id));
    list.appendChild(li);
  }
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ---- Session lifecycle ------------------------------------------------------

async function playGame(gameId) {
  // This runs from a click, so it is the right place to create/resume the
  // AudioContext before the asynchronous session startup loses the gesture.
  ensureAudioContext();
  await stopSession();
  el('sessionState').textContent = 'starting…';
  el('sessionState').className = 'pill pill-warn';
  el('btnStop').disabled = true;
  el('screenPlaceholder').style.display = 'flex';
  el('screenImg').style.display = 'none';
  el('screenCanvas').style.display = 'none';
  el('logOutput').textContent = '';
  resetCrank();

  try {
    const data = await api('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ gameId }),
    });
    state.session = data.session;
    el('playerTitle').textContent = data.session.title;
    el('sessionState').textContent = 'running';
    el('sessionState').className = 'pill pill-ok';
    el('btnStop').disabled = false;
    el('btnShare').disabled = false;
    startFrameStream(data.session.framesUrl);
    setupAudio(data.session);
    startStatusPolling(data.session.id);
  } catch (err) {
    el('sessionState').textContent = 'failed';
    el('sessionState').className = 'pill pill-bad';
    el('logOutput').textContent = String(err.message || err);
  }
}

// ---- Frame stream -----------------------------------------------------------

function setScreenVisible(which) {
  el('screenPlaceholder').style.display = 'none';
  el('screenImg').style.display = which === 'img' ? 'block' : 'none';
  el('screenCanvas').style.display = which === 'canvas' ? 'block' : 'none';
}

function startFrameStream(url) {
  stopFrameStream();
  state.frameUrl = url;
  state.frameToken += 1;
  const token = state.frameToken;

  if (supportsStreamingCanvas()) {
    state.frameMode = 'canvas';
    setScreenVisible('canvas');
    const canvas = el('screenCanvas');
    canvas.width = SCREEN_W;
    canvas.height = SCREEN_H;
    const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
    if (!ctx) {
      startImgFrames(url);
      return;
    }
    ctx.imageSmoothingEnabled = false;
    state.canvasCtx = ctx;
    startFetchFrames(url, token).catch(() => {
      if (token !== state.frameToken) return;
      // Canvas streaming failed; fall back to a plain MJPEG <img>, which is
      // slower but supported by every browser that can play the game.
      startImgFrames(url);
    });
  } else {
    startImgFrames(url);
  }
}

function startImgFrames(url) {
  state.frameMode = 'img';
  setScreenVisible('img');
  el('screenImg').src = `${url}?t=${Date.now()}`;
}

function stopFrameStream() {
  state.frameToken += 1;
  if (state.frameAbort) {
    try { state.frameAbort.abort(); } catch { /* ignore */ }
    state.frameAbort = null;
  }
  const img = el('screenImg');
  img.removeAttribute('src');
  img.style.display = 'none';
  el('screenCanvas').style.display = 'none';
  el('screenPlaceholder').style.display = 'flex';
  state.canvasCtx = null;
  state.pendingFrame = null;
  state.frameUrl = null;
  state.frameMode = null;
}

function supportsStreamingCanvas() {
  return typeof fetch === 'function'
    && typeof ReadableStream !== 'undefined'
    && typeof Blob !== 'undefined'
    && !!(el('screenCanvas').getContext);
}

async function startFetchFrames(url, token) {
  const controller = new AbortController();
  state.frameAbort = controller;
  const res = await fetch(`${url}?t=${Date.now()}`, {
    cache: 'no-store',
    signal: controller.signal,
  });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  const reader = res.body.getReader();
  let gotFrame = false;
  const parser = createJpegParser((frame) => {
    gotFrame = true;
    presentFrame(frame, token);
  });
  // If the browser cannot consume the MJPEG stream incrementally, fall back
  // to an <img> instead of waiting forever on a silent connection.
  const watchdog = setTimeout(() => {
    if (!gotFrame) controller.abort();
  }, 4000);
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (token !== state.frameToken) return;
      if (value && value.length) parser(value);
    }
  } finally {
    clearTimeout(watchdog);
  }
  if (token === state.frameToken) throw new Error('frame stream ended');
}

// Incremental multipart/JPEG parser.  Multipart boundaries are ignored; the
// JPEG markers are enough and avoid coupling the client to the server's
// boundary string.
function createJpegParser(onFrame) {
  let buf = new Uint8Array(0);
  return (chunk) => {
    const merged = new Uint8Array(buf.length + chunk.length);
    merged.set(buf, 0);
    merged.set(chunk, buf.length);
    buf = merged;

    while (buf.length >= 2) {
      const start = findMarker(buf, 0xd8, 0);
      if (start < 0) {
        if (buf.length > 1) buf = buf.slice(buf.length - 1);
        return;
      }
      if (start > 0) buf = buf.slice(start);
      const end = findMarker(buf, 0xd9, 2);
      if (end < 0) {
        // A malformed stream should not grow without bound.
        if (buf.length > 4 * 1024 * 1024) buf = new Uint8Array(0);
        return;
      }
      const frame = buf.slice(0, end + 2);
      buf = buf.slice(end + 2);
      onFrame(frame);
    }
  };
}

function findMarker(buf, second, from) {
  for (let i = from; i < buf.length - 1; i++) {
    if (buf[i] === 0xff && buf[i + 1] === second) return i;
  }
  return -1;
}

async function decodeJpeg(frame) {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(new Blob([frame], { type: 'image/jpeg' }));
    } catch { /* fall back to an Image element below */ }
  }
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(new Blob([frame], { type: 'image/jpeg' }));
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('bad jpeg')); };
    img.src = url;
  });
}

function presentFrame(frame, token) {
  if (token !== state.frameToken) return;
  state.lastFrameAt = Date.now();
  state.pendingFrame = frame;
  if (state.decoding) return;
  state.decoding = true;

  (async () => {
    while (state.pendingFrame && token === state.frameToken) {
      const current = state.pendingFrame;
      state.pendingFrame = null;
      try {
        const image = await decodeJpeg(current);
        if (token !== state.frameToken || !state.canvasCtx) {
          image.close?.();
          break;
        }
        state.canvasCtx.drawImage(image, 0, 0, SCREEN_W, SCREEN_H);
        image.close?.();
      } catch { /* drop this frame */ }
    }
    state.decoding = false;
    // A frame can arrive while the last draw is completing; drain it now.
    if (state.pendingFrame && token === state.frameToken) presentFrame(state.pendingFrame, token);
  })();
}

function startStatusPolling(id) {
  clearInterval(state.pollTimer);
  state.pollTimer = setInterval(async () => {
    try {
      const data = await api(`/api/sessions/${id}`);
      const s = data.session;
      el('sessionState').textContent = s.state;
      el('sessionState').className = 'pill ' + (s.state === 'running' ? 'pill-ok' : s.state === 'failed' ? 'pill-bad' : 'pill-warn');
      if (s.error) el('logOutput').textContent = s.error;
      state.docked = s.docked;
      el('dockToggle').checked = s.docked;
      if (s.audio === false && audio.available) {
        stopAudio();
        setSoundButton('Sound: n/a', false);
      }
      // Keep the local crank in sync after a reload, but never while the
      // player is actively dragging or has unsent ticks.
      if (!state.dragging && !state.crankPending && !state.crankInFlight && Number.isFinite(s.crank)) {
        state.dialAngle = s.crank;
        state.crankVisual = s.crank;
        updateCrankUi();
      }
    } catch {
      clearInterval(state.pollTimer);
      state.pollTimer = null;
      state.session = null;
      stopFrameStream();
      stopAudio();
      el('sessionState').textContent = 'stopped';
      el('sessionState').className = 'pill pill-warn';
      el('btnStop').disabled = true;
      el('btnShare').disabled = true;
    }
  }, 2000);
}

async function stopSession() {
  clearInterval(state.pollTimer);
  state.pollTimer = null;
  const id = state.session?.id;
  state.session = null;
  if (id) {
    try { await api(`/api/sessions/${id}`, { method: 'DELETE' }); } catch { /* ignore */ }
  }
  stopFrameStream();
  stopAudio();
  el('btnStop').disabled = true;
  el('btnShare').disabled = true;
  el('btnSound').disabled = true;
  el('sessionState').textContent = 'idle';
  el('sessionState').className = 'pill';
  el('playerTitle').textContent = 'Player';
  el('logOutput').textContent = '';
  state.buttonDown.clear();
}

// ---- Audio ------------------------------------------------------------------

function setSoundButton(label, on) {
  const b = el('btnSound');
  b.textContent = label;
  b.dataset.on = on ? 'true' : 'false';
}

function disarmAudioEnable() {
  if (state.audioEnableHandler) {
    document.removeEventListener('pointerdown', state.audioEnableHandler, true);
    state.audioEnableHandler = null;
  }
  if (state.audioEnableKeyHandler) {
    document.removeEventListener('keydown', state.audioEnableKeyHandler, true);
    state.audioEnableKeyHandler = null;
  }
}

function stopAudio() {
  disarmAudioEnable();
  const audio = el('gameAudio');
  try {
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
  } catch { /* ignore */ }
  audio.muted = false;
  state.audioEnabled = false;
  state.audioBlocked = false;
  state.audioJustEnabled = false;
  el('btnSound').disabled = true;
  setSoundButton('Sound: off', false);
}

function setupAudio(session) {
  stopAudio();
  const audio = el('gameAudio');
  if (!session?.audioUrl) {
    el('btnSound').disabled = true;
    setSoundButton('Sound: n/a', false);
    return;
  }

  el('btnSound').disabled = false;
  state.audioEnabled = true;
  state.audioBlocked = false;
  audio.src = `${session.audioUrl}?t=${Date.now()}`;
  audio.load();
  setSoundButton('Sound: on', true);

  const started = audio.play();
  if (started && typeof started.catch === 'function') {
    started.catch(() => {
      // Browsers often block audible autoplay.  Start muted (which is
      // allowed) and unmute on the next user gesture.
      state.audioBlocked = true;
      audio.muted = true;
      audio.play().catch(() => { /* give up until the button is pressed */ });
      setSoundButton('Enable sound', false);
      armAudioEnable();
    });
  }
}

function armAudioEnable() {
  disarmAudioEnable();
  const enable = () => {
    const audio = el('gameAudio');
    if (!state.audioBlocked || !audio.src) return;
    state.audioBlocked = false;
    state.audioJustEnabled = true;
    setTimeout(() => { state.audioJustEnabled = false; }, 400);
    audio.muted = false;
    audio.play().then(() => {
      setSoundButton('Sound: on', true);
    }).catch(() => {
      state.audioBlocked = true;
      setSoundButton('Enable sound', false);
    });
    disarmAudioEnable();
  };
  state.audioEnableHandler = enable;
  state.audioEnableKeyHandler = enable;
  document.addEventListener('pointerdown', enable, true);
  document.addEventListener('keydown', enable, true);
}

el('btnSound').addEventListener('click', () => {
  // The document-level autoplay unlock runs on pointerdown, before this
  // click.  Do not immediately toggle the stream back off.
  if (state.audioJustEnabled) {
    state.audioJustEnabled = false;
    return;
  }
  const audio = el('gameAudio');
  if (!audio.src) return;
  if (!state.audioEnabled || audio.muted || state.audioBlocked) {
    state.audioEnabled = true;
    state.audioBlocked = false;
    audio.muted = false;
    audio.play().then(() => setSoundButton('Sound: on', true)).catch(() => {
      state.audioBlocked = true;
      setSoundButton('Enable sound', false);
      armAudioEnable();
    });
  } else {
    state.audioEnabled = false;
    audio.muted = true;
    setSoundButton('Sound: off', false);
  }
});

// ---- Input ------------------------------------------------------------------

async function sendInput(payload) {
  if (!state.session) return null;
  try {
    return await api(`/api/sessions/${state.session.id}/input`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    el('logOutput').textContent = String(err.message || err);
    return null;
  }
}

function buttonForKey(key) {
  switch (key) {
    case 'ArrowUp': return 'up';
    case 'ArrowDown': return 'down';
    case 'ArrowLeft': return 'left';
    case 'ArrowRight': return 'right';
    default: {
      // Playdate A maps to the simulator's S key; Playdate B maps to A.
      const lower = key.toLowerCase();
      if (lower === 's') return 'A';
      if (lower === 'a') return 'B';
      return null;
    }
  }
}

function isTypingTarget(target) {
  return target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
}

document.addEventListener('keydown', (e) => {
  if (isTypingTarget(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === ',' || e.key === '.') {
    e.preventDefault();
    addCrankDelta(e.key === ',' ? -CRANK_TICK_DEGREES : CRANK_TICK_DEGREES);
    return;
  }
  const button = buttonForKey(e.key);
  if (button) {
    e.preventDefault();
    if (!state.buttonDown.has(button)) {
      state.buttonDown.add(button);
      sendInput({ type: 'button', button, action: 'down' });
    }
  }
});

document.addEventListener('keyup', (e) => {
  if (isTypingTarget(e.target)) return;
  const button = buttonForKey(e.key);
  if (button) {
    e.preventDefault();
    if (state.buttonDown.has(button)) {
      state.buttonDown.delete(button);
      sendInput({ type: 'button', button, action: 'up' });
    }
  }
});

window.addEventListener('blur', () => {
  for (const button of state.buttonDown) {
    sendInput({ type: 'button', button, action: 'up' });
  }
  state.buttonDown.clear();
});

// On-screen controller buttons
document.querySelectorAll('[data-button]').forEach((btn) => {
  const button = btn.dataset.button;
  const press = (e) => {
    e.preventDefault();
    if (!state.buttonDown.has(button)) {
      state.buttonDown.add(button);
      btn.classList.add('pressed');
      sendInput({ type: 'button', button, action: 'down' });
    }
  };
  const release = (e) => {
    e.preventDefault();
    if (state.buttonDown.has(button)) {
      state.buttonDown.delete(button);
      btn.classList.remove('pressed');
      sendInput({ type: 'button', button, action: 'up' });
    }
  };
  btn.addEventListener('pointerdown', press);
  btn.addEventListener('pointerup', release);
  btn.addEventListener('pointerleave', release);
  btn.addEventListener('pointercancel', release);
  btn.addEventListener('contextmenu', (e) => e.preventDefault());
});

// ---- Crank ------------------------------------------------------------------
//
// The dial behaves like a real crank: grabbing anywhere on the circle and
// moving around its centre turns it, and the angle is unbounded (spinning
// past 360 degrees keeps going).  Deltas are batched into ~16 ms updates and
// the server accumulates 4-degree wheel notches, so slow and fast drags both
// feel smooth.

function updateCrankUi() {
  const dial = el('crankDial');
  const pointer = el('crankPointer');
  const degrees = Math.round(state.dialAngle);
  pointer.style.transform = `rotate(${state.crankVisual}deg)`;
  el('dialValue').textContent = `${degrees}°`;
  const normalized = ((degrees % 360) + 360) % 360;
  dial.setAttribute('aria-valuenow', String(normalized));
  dial.setAttribute('aria-valuetext', `${degrees} degrees`);
}

function resetCrank() {
  if (state.crankFlushTimer) {
    clearTimeout(state.crankFlushTimer);
    state.crankFlushTimer = null;
  }
  state.dialAngle = 0;
  state.crankVisual = 0;
  state.crankPending = 0;
  state.crankInFlight = 0;
  state.dragging = false;
  updateCrankUi();
}

function addCrankDelta(delta) {
  if (!Number.isFinite(delta) || delta === 0) return;
  state.dialAngle += delta;
  state.crankVisual += delta;
  state.crankPending += delta;
  updateCrankUi();
  scheduleCrankFlush(false);
}

function scheduleCrankFlush(immediate) {
  if (immediate) {
    flushCrank();
    return;
  }
  if (state.crankFlushTimer) return;
  state.crankFlushTimer = setTimeout(() => {
    state.crankFlushTimer = null;
    flushCrank();
  }, 16);
}

function flushCrank() {
  const delta = state.crankPending;
  if (!delta || !state.session) return;
  state.crankPending = 0;
  state.crankInFlight += 1;
  sendInput({ type: 'crank', delta }).then((result) => {
    state.crankInFlight = Math.max(0, state.crankInFlight - 1);
    if (result && result.docked === false) {
      state.docked = false;
      el('dockToggle').checked = false;
    }
    if (result && Number.isFinite(result.crank) && !state.dragging && !state.crankPending) {
      // The server is authoritative over the session's absolute angle.
      state.dialAngle = result.crank;
      state.crankVisual = result.crank;
      updateCrankUi();
    }
  }, () => {
    state.crankInFlight = Math.max(0, state.crankInFlight - 1);
  });
}

function pointerAngle(e) {
  const dial = el('crankDial');
  const rect = dial.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  // 0 degrees at 12 o'clock, increasing clockwise.
  return (Math.atan2(e.clientY - cy, e.clientX - cx) * 180 / Math.PI + 90 + 360) % 360;
}

const dial = el('crankDial');
dial.addEventListener('pointerdown', (e) => {
  if (!state.session) return;
  e.preventDefault();
  state.dragging = true;
  state.lastPointerAngle = pointerAngle(e);
  dial.classList.add('dragging');
  try { dial.setPointerCapture(e.pointerId); } catch { /* ignore */ }
});

dial.addEventListener('pointermove', (e) => {
  if (!state.dragging) return;
  e.preventDefault();
  const angle = pointerAngle(e);
  let delta = angle - state.lastPointerAngle;
  // Take the shortest path across the 0/360 boundary so a drag past the top
  // does not jump a whole turn.
  if (delta > 180) delta -= 360;
  if (delta < -180) delta += 360;
  state.lastPointerAngle = angle;
  addCrankDelta(delta);
});

function endCrankDrag(e) {
  if (!state.dragging) return;
  state.dragging = false;
  dial.classList.remove('dragging');
  if (e && e.pointerId !== undefined) {
    try { dial.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
  }
  scheduleCrankFlush(true);
}
dial.addEventListener('pointerup', endCrankDrag);
dial.addEventListener('pointercancel', endCrankDrag);
dial.addEventListener('lostpointercapture', endCrankDrag);

function wheelToCrank(e) {
  if (!state.session) return;
  e.preventDefault();
  const raw = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
  if (!raw) return;
  const steps = Math.max(1, Math.min(3, Math.round(Math.abs(raw) / 100)));
  addCrankDelta((raw < 0 ? 1 : -1) * CRANK_TICK_DEGREES * steps);
}

el('screenImg').addEventListener('wheel', wheelToCrank, { passive: false });
el('screenCanvas').addEventListener('wheel', wheelToCrank, { passive: false });
dial.addEventListener('wheel', wheelToCrank, { passive: false });

// Dock toggle
el('dockToggle').addEventListener('change', () => {
  sendInput({ type: 'dock', docked: el('dockToggle').checked });
});

// Menu button.  The server holds the simulated MENU button down briefly,
// which is required for the wxWidgets control to register it.
el('btnMenu').addEventListener('click', () => {
  if (!state.session) return;
  el('btnMenu').classList.add('active');
  setTimeout(() => el('btnMenu').classList.remove('active'), 180);
  sendInput({ type: 'menu' });
});

// ---- Upload dialog ----------------------------------------------------------

let pendingUpload = null;

function openUpload() {
  pendingUpload = null;
  el('uploadStatus').textContent = '';
  el('btnDoUpload').disabled = true;
  el('zipFileInput').value = '';
  el('folderInput').value = '';
  el('uploadDialog').showModal();
}

el('btnUpload').addEventListener('click', openUpload);
el('btnCancelUpload').addEventListener('click', () => el('uploadDialog').close());
el('btnRefresh').addEventListener('click', loadGames);
el('btnStop').addEventListener('click', stopSession);

el('btnShare').addEventListener('click', async () => {
  const id = state.session?.id ? state.session.gameId : null;
  const link = id ? `${location.origin}/?game=${encodeURIComponent(id)}` : location.origin;
  try {
    await navigator.clipboard.writeText(link);
    el('logOutput').textContent = `Share link copied: ${link}`;
  } catch {
    el('logOutput').textContent = `Share link: ${link}`;
  }
});

function setStatus(msg) { el('uploadStatus').textContent = msg; }

el('zipFileInput').addEventListener('change', () => {
  const file = el('zipFileInput').files[0];
  pendingUpload = file ? { kind: 'zip', file } : null;
  el('btnDoUpload').disabled = !pendingUpload;
  setStatus(file ? `Selected ${file.name} (${formatBytes(file.size)})` : '');
});

el('folderInput').addEventListener('change', () => {
  const files = [...el('folderInput').files];
  pendingUpload = files.length ? { kind: 'folder', files } : null;
  el('btnDoUpload').disabled = !pendingUpload;
  setStatus(files.length ? `Selected ${files.length} files from a folder` : '');
});

async function uploadZip(file) {
  setStatus('Uploading…');
  const res = await fetch(`/api/games?name=${encodeURIComponent(file.name)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: file,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data.game;
}

async function uploadFolder(files) {
  setStatus('Packaging folder into a zip…');
  const entries = [];
  const parts = files.map((f) => f.webkitRelativePath || f.name);
  const top = parts[0].split('/')[0];
  for (const f of files) {
    const rel = f.webkitRelativePath || f.name;
    // Strip the top folder so the zip root is the folder contents.
    const name = rel.split('/').slice(1).join('/') || f.name;
    const data = new Uint8Array(await f.arrayBuffer());
    entries.push({ name, data });
  }
  const zipBytes = buildZip(entries);
  setStatus(`Uploading packaged bundle (${formatBytes(zipBytes.length)})…`);
  const res = await fetch(`/api/games?name=${encodeURIComponent(top)}.zip`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: zipBytes,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data.game;
}

el('btnDoUpload').addEventListener('click', async () => {
  if (!pendingUpload) return;
  el('btnDoUpload').disabled = true;
  try {
    const game = pendingUpload.kind === 'zip'
      ? await uploadZip(pendingUpload.file)
      : await uploadFolder(pendingUpload.files);
    setStatus(`Registered “${game.title}”.`);
    el('uploadDialog').close();
    await loadGames();
    await playGame(game.id);
  } catch (err) {
    setStatus(`Upload failed: ${err.message}`);
    el('btnDoUpload').disabled = false;
  }
});

// ---- Boot -------------------------------------------------------------------

updateCrankUi();

(async () => {
  try {
    await loadGames();
  } catch (err) {
    el('logOutput').textContent = `Failed to load library: ${err.message}`;
  }
  // Shareable links: /?game=<gameId> auto-starts that game for any visitor.
  const bootGameId = new URLSearchParams(location.search).get('game');
  if (bootGameId && state.games.some((g) => g.id === bootGameId)) {
    playGame(bootGameId);
  }
})();
