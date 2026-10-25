'use strict';

// End-to-end smoke test: compile an SDK example, package it with the browser
// zip builder, upload it, start a session, read frames, send input, stop.
//
// Usage: node scripts/smoke-test.js [baseUrl]

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const cfg = require('../server/config');
const { buildZip } = require('../public/zip.js');

const BASE = process.argv[2] || `http://${cfg.host}:${cfg.port}`;

function compileExample() {
  const src = path.join(cfg.sdkPath, 'Examples', 'Game Template', 'Source');
  const out = path.join(cfg.tmpDir, 'smoke-template.pdx');
  fs.rmSync(out, { recursive: true, force: true });
  return new Promise((resolve, reject) => {
    execFile(cfg.pdcPath, ['-sdkpath', cfg.sdkPath, src, out], (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      resolve(out);
    });
  });
}

function zipDir(dir) {
  const files = [];
  const walk = (d, rel = '') => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(p, r);
      else files.push({ name: r, data: new Uint8Array(fs.readFileSync(p)) });
    }
  };
  walk(dir);
  return buildZip(files);
}

async function readFrames(url, ms = 2500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  const res = await fetch(url, { signal: controller.signal });
  const reader = res.body.getReader();
  const chunks = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
  } catch { /* aborted */ }
  clearTimeout(timer);
  const buf = Buffer.concat(chunks.map((c) => Buffer.from(c)));
  const frames = [];
  let i = 0;
  while (true) {
    const s = buf.indexOf(Buffer.from([0xff, 0xd8]), i);
    if (s < 0) break;
    const e = buf.indexOf(Buffer.from([0xff, 0xd9]), s + 2);
    if (e < 0) break;
    frames.push(buf.subarray(s, e + 2));
    i = e + 2;
  }
  return { bytes: buf.length, frames };
}

async function readBytes(url, ms = 1500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  const chunks = [];
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const reader = res.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value));
    }
  } catch { /* aborted, that's expected for a live stream */ }
  clearTimeout(timer);
  return Buffer.concat(chunks);
}

async function main() {
  const step = (msg) => console.log(`• ${msg}`);

  step('Compiling SDK example "Game Template"');
  const pdxDir = await compileExample();
  step('Packaging bundle with browser zip builder');
  const zip = zipDir(pdxDir);

  step('Uploading bundle');
  const uploadRes = await fetch(`${BASE}/api/games?name=smoke.zip`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: zip,
  });
  const uploadBody = await uploadRes.json();
  if (!uploadRes.ok) throw new Error(`upload failed: ${uploadBody.error}`);
  const gameId = uploadBody.game.id;
  step(`Registered game ${uploadBody.game.title} (${gameId})`);

  step('Starting simulator session');
  const sessRes = await fetch(`${BASE}/api/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ gameId }),
  });
  const sessBody = await sessRes.json();
  if (!sessRes.ok) throw new Error(`session failed: ${sessBody.error}`);
  const sessionId = sessBody.session.id;
  step(`Session ${sessionId} is ${sessBody.session.state}`);

  step('Reading frames');
  const frames1 = await readFrames(`${BASE}/api/sessions/${sessionId}/frames`);
  step(`Received ${frames1.frames.length} frames (${frames1.bytes} bytes)`);
  if (!frames1.frames.length) throw new Error('no frames received');

  if (sessBody.session.audioUrl) {
    step('Reading audio stream');
    const audio = await readBytes(`${BASE}${sessBody.session.audioUrl}`, 1500);
    step(`Received ${audio.length} bytes of PCM audio`);
    if (audio.length < 256) throw new Error('no audio received');
  } else {
    step('Audio stream unavailable on this platform (skipped)');
  }

  step('Sending button + crank + dock input');
  for (const payload of [
    { type: 'button', button: 'A', action: 'down' },
    { type: 'button', button: 'A', action: 'up' },
    { type: 'crank', delta: 8 },
    { type: 'dock', docked: false },
    { type: 'menu' },
  ]) {
    const r = await fetch(`${BASE}/api/sessions/${sessionId}/input`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!r.ok) throw new Error(`input failed: ${(await r.json()).error}`);
  }
  step('Input accepted');

  const statusRes = await fetch(`${BASE}/api/sessions/${sessionId}`);
  const statusBody = await statusRes.json();
  if (!statusRes.ok) throw new Error(`status failed: ${statusBody.error}`);
  if (statusBody.session.crank !== 8) {
    throw new Error(`crank state mismatch: ${statusBody.session.crank}`);
  }

  step('Reading frames after input');
  const frames2 = await readFrames(`${BASE}/api/sessions/${sessionId}/frames`);
  step(`Received ${frames2.frames.length} frames`);

  step('Stopping session');
  const del = await fetch(`${BASE}/api/sessions/${sessionId}`, { method: 'DELETE' });
  if (!del.ok) throw new Error('stop failed');

  step('Removing the smoke-test game from the library');
  const delGame = await fetch(`${BASE}/api/games/${gameId}`, { method: 'DELETE' });
  if (!delGame.ok) throw new Error('game cleanup failed');

  fs.rmSync(pdxDir, { recursive: true, force: true });
  console.log('\nSMOKE TEST PASSED');
}

main().catch((err) => {
  console.error('\nSMOKE TEST FAILED:', err.message);
  process.exit(1);
});
