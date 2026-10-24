'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

function isZip(buf) {
  return buf.length >= 4 && buf.subarray(0, 4).equals(ZIP_MAGIC);
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 10 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      if (err) {
        const e = new Error(`Command failed: ${cmd} ${args.join(' ')}\n${stderr || ''}`);
        e.stderr = stderr;
        e.stdout = stdout;
        return reject(e);
      }
      resolve({ stdout, stderr });
    });
  });
}

/**
 * Lists entries of a zip and rejects any unsafe paths (absolute, traversal).
 * Returns { entries: [{ name }], unsafe: [names] }.
 */
async function listZipEntries(zipPath) {
  const { stdout } = await run('unzip', ['-Z1', zipPath]);
  const entries = stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  const unsafe = [];
  for (const name of entries) {
    const normalized = name.replace(/\\/g, '/');
    if (
      normalized.startsWith('/') ||
      /^[A-Za-z]:/.test(normalized) ||
      normalized.split('/').some((seg) => seg === '..') ||
      normalized.includes('\0')
    ) {
      unsafe.push(name);
    }
  }
  return { entries, unsafe };
}

/**
 * Extracts a zip into destDir. Throws on unsafe entries.
 */
async function extractZip(zipPath, destDir) {
  const { entries, unsafe } = await listZipEntries(zipPath);
  if (unsafe.length) {
    throw new Error(`Unsafe zip entries rejected: ${unsafe.slice(0, 5).join(', ')}`);
  }
  fs.mkdirSync(destDir, { recursive: true });
  await run('unzip', ['-o', '-q', zipPath, '-d', destDir]);
  return entries;
}

/**
 * Finds the actual .pdx root inside an extracted zip tree.
 * Accepts either:
 *  - root itself contains pdxinfo + main.pdz
 *  - exactly one top-level directory contains pdxinfo + main.pdz
 * Returns the path to the .pdx directory, or null.
 */
function findPdxRoot(dir) {
  const hasPdx = (d) =>
    fs.existsSync(path.join(d, 'pdxinfo')) &&
    fs.existsSync(path.join(d, 'main.pdz'));

  if (hasPdx(dir)) return dir;

  const entries = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory());
  const candidates = entries.filter((e) => hasPdx(path.join(dir, e.name)));
  if (candidates.length === 1) return path.join(dir, candidates[0].name);

  // Nested deeper (e.g. zip contains "Game/Source/..."): search up to depth 3
  const found = [];
  const walk = (d, depth) => {
    if (depth > 3) return;
    if (hasPdx(d)) {
      found.push(d);
      return;
    }
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(d, e.name), depth + 1);
    }
  };
  walk(dir, 0);
  if (found.length === 1) return found[0];
  return null;
}

module.exports = { isZip, run, listZipEntries, extractZip, findPdxRoot };
