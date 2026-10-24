'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const cfg = require('./config');

function parsePdxinfo(text) {
  const info = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    info[key] = value;
  }
  return info;
}

function readPdxinfo(pdxDir) {
  const file = path.join(pdxDir, 'pdxinfo');
  if (!fs.existsSync(file)) return {};
  return parsePdxinfo(fs.readFileSync(file, 'utf8'));
}

function slugify(name) {
  return String(name || 'game')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'game';
}

function dirSize(dir) {
  let total = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) total += fs.statSync(p).size;
    }
  };
  walk(dir);
  return total;
}

function listFiles(dir, base = dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) listFiles(p, base, out);
    else if (e.isFile()) out.push(path.relative(base, p));
  }
  return out;
}

function gameDirFor(id) {
  return path.join(cfg.gamesDir, id);
}

/**
 * Reads all registered games from storage. Each game directory has:
 *   meta.json  (id, title, author, description, version, bundleID, createdAt, files, sizeBytes)
 *   game.pdx/  (the actual bundle)
 */
function listGames() {
  const games = [];
  for (const entry of fs.readdirSync(cfg.gamesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(cfg.gamesDir, entry.name);
    const metaFile = path.join(dir, 'meta.json');
    const pdxDir = path.join(dir, 'game.pdx');
    if (!fs.existsSync(metaFile) || !fs.existsSync(pdxDir)) continue;
    let meta;
    try {
      meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
    } catch {
      continue;
    }
    games.push({
      ...meta,
      sizeBytes: meta.sizeBytes || dirSize(pdxDir),
      fileCount: meta.fileCount || listFiles(pdxDir).length,
    });
  }
  games.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  return games;
}

function getGame(id) {
  const dir = gameDirFor(id);
  const metaFile = path.join(dir, 'meta.json');
  const pdxDir = path.join(dir, 'game.pdx');
  if (!fs.existsSync(metaFile) || !fs.existsSync(pdxDir)) return null;
  const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
  return { ...meta, dir, pdxDir };
}

/**
 * Registers a game by copying an existing .pdx directory into storage.
 */
function registerGame(pdxDir, extra = {}) {
  const info = readPdxinfo(pdxDir);
  const title = info.name || extra.title || path.basename(pdxDir).replace(/\.pdx$/i, '') || 'Untitled Game';
  const id = `${slugify(title)}-${crypto.randomBytes(4).toString('hex')}`;
  const dir = gameDirFor(id);
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, 'game.pdx');
  fs.cpSync(pdxDir, dest, { recursive: true });

  const meta = {
    id,
    title,
    author: info.author || extra.author || 'Unknown',
    description: info.description || '',
    version: info.version || '',
    bundleID: info.bundleID || '',
    createdAt: new Date().toISOString(),
    sizeBytes: dirSize(dest),
    fileCount: listFiles(dest).length,
    source: extra.source || 'upload',
    pdxinfo: info,
  };
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2));
  return meta;
}

function deleteGame(id) {
  const dir = gameDirFor(id);
  if (!path.resolve(dir).startsWith(path.resolve(cfg.gamesDir))) return false;
  if (!fs.existsSync(dir)) return false;
  fs.rmSync(dir, { recursive: true, force: true });
  return true;
}

module.exports = {
  parsePdxinfo,
  readPdxinfo,
  slugify,
  dirSize,
  listFiles,
  gameDirFor,
  listGames,
  getGame,
  registerGame,
  deleteGame,
};
