'use strict';

// ---- App state --------------------------------------------------------------

const state = {
  games: [],
  session: null,
  frameUrl: null,
  frameSource: null,
  dialAngle: 0,
  docked: true,
  buttonDown: new Set(),
  pollTimer: null,
  lastFrameAt: 0,
};

const el = (id) => document.getElementById(id);

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
  await stopSession();
  el('sessionState').textContent = 'starting…';
  el('sessionState').className = 'pill pill-warn';
  el('btnStop').disabled = true;
  el('screenPlaceholder').style.display = 'flex';
  el('screenImg').style.display = 'none';
  el('logOutput').textContent = '';

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
    startStatusPolling(data.session.id);
  } catch (err) {
    el('sessionState').textContent = 'failed';
    el('sessionState').className = 'pill pill-bad';
    el('logOutput').textContent = String(err.message || err);
  }
}

function startFrameStream(url) {
  stopFrameStream();
  state.frameUrl = url;
  const img = el('screenImg');
  img.src = `${url}?t=${Date.now()}`;
  img.style.display = 'block';
  el('screenPlaceholder').style.display = 'none';
}

function stopFrameStream() {
  const img = el('screenImg');
  img.removeAttribute('src');
  img.style.display = 'none';
  el('screenPlaceholder').style.display = 'flex';
  state.frameUrl = null;
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
      if (s.docked) {
        state.dialAngle = 0;
        el('dialAngle').value = 0;
        el('dialValue').textContent = '0°';
        lastDialAngle = 0;
      }
    } catch {
      clearInterval(state.pollTimer);
      state.pollTimer = null;
      state.session = null;
      stopFrameStream();
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
  el('btnStop').disabled = true;
  el('btnShare').disabled = true;
  el('sessionState').textContent = 'idle';
  el('sessionState').className = 'pill';
  el('playerTitle').textContent = 'Player';
  el('logOutput').textContent = '';
  state.buttonDown.clear();
}

// ---- Input ------------------------------------------------------------------

async function sendInput(payload) {
  if (!state.session) return;
  try {
    await api(`/api/sessions/${state.session.id}/input`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    el('logOutput').textContent = String(err.message || err);
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

document.addEventListener('keydown', (e) => {
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
  const button = buttonForKey(e.key);
  if (button) {
    e.preventDefault();
    if (state.buttonDown.has(button)) {
      state.buttonDown.delete(button);
      sendInput({ type: 'button', button, action: 'up' });
    }
  }
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

// Crank via mouse wheel over the screen
el('screenImg').addEventListener('wheel', (e) => {
  e.preventDefault();
  if (!state.session) return;
  const delta = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
  const degrees = delta < 0 ? 4 : -4;
  state.dialAngle = (state.dialAngle + degrees + 360) % 360;
  el('dialAngle').value = state.dialAngle;
  el('dialValue').textContent = `${state.dialAngle}°`;
  sendInput({ type: 'crank', delta: degrees });
}, { passive: false });

// Crank dial drag → send angular deltas
let lastDialAngle = 0;
el('dialAngle').addEventListener('input', () => {
  const angle = Number(el('dialAngle').value);
  let delta = angle - lastDialAngle;
  if (delta > 180) delta -= 360;
  if (delta < -180) delta += 360;
  lastDialAngle = angle;
  el('dialValue').textContent = `${angle}°`;
  if (delta !== 0) sendInput({ type: 'crank', delta });
});
el('dialAngle').addEventListener('pointerdown', () => { lastDialAngle = Number(el('dialAngle').value); });

// Dock toggle
el('dockToggle').addEventListener('change', () => {
  sendInput({ type: 'dock', docked: el('dockToggle').checked });
});

// Menu button
el('btnMenu').addEventListener('click', () => sendInput({ type: 'menu' }));

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
  // Determine the common top-level directory name (webkitdirectory gives e.g. Game/Source/main.lua)
  const parts = files.map((f) => f.webkitRelativePath || f.name);
  const top = parts[0].split('/')[0];
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const rel = f.webkitRelativePath || f.name;
    // Strip the top folder so the zip root is the folder contents.
    const name = rel.split('/').slice(1).join('/') || f.name;
    const data = new Uint8Array(await f.arrayBuffer());
    entries.push({ name, data });
  }
  // If the folder itself is a .pdx bundle, keep its contents at zip root.
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

loadGames().catch((err) => {
  el('logOutput').textContent = `Failed to load library: ${err.message}`;
});

// Shareable links: /?game=<gameId> auto-starts that game for any visitor.
const bootGameId = new URLSearchParams(location.search).get('game');
if (bootGameId) {
  loadGames().then(() => {
    if (state.games.some((g) => g.id === bootGameId)) playGame(bootGameId);
  }).catch(() => {});
}
