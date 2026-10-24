'use strict';

// Compiles selected SDK example games with pdc and registers them in the
// web app's game library, so the app has playable content out of the box.
//
// Usage: node scripts/seed.js [--force]

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

const cfg = require('../server/config');
const games = require('../server/games');

const EXAMPLES = [
  'FlippyFish',
  'SpriteCollisionMasks',
  'Hammer Down',
  'Level 1-1',
  'Pathfinder',
  'Mode7Driver',
  'DrumMachine',
  'Game Template',
];

function compile(exampleName) {
  const srcDir = path.join(cfg.sdkPath, 'Examples', exampleName, 'Source');
  if (!fs.existsSync(path.join(srcDir, 'main.lua'))) return null;
  const outDir = path.join(cfg.tmpDir, `seed-${exampleName.replace(/\s+/g, '-')}.pdx`);
  fs.rmSync(outDir, { recursive: true, force: true });
  return new Promise((resolve) => {
    execFile(cfg.pdcPath, ['-sdkpath', cfg.sdkPath, srcDir, outDir], { maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        console.warn(`skip ${exampleName}: ${stderr || err.message}`);
        return resolve(null);
      }
      resolve(outDir);
    });
  });
}

async function main() {
  const force = process.argv.includes('--force');
  const existing = games.listGames();
  const titles = new Set(existing.map((g) => g.title));

  let added = 0;
  for (const name of EXAMPLES) {
    const pdxDir = await compile(name);
    if (!pdxDir) continue;
    const info = games.readPdxinfo(pdxDir);
    const title = info.name || name;
    if (!force && titles.has(title)) {
      console.log(`already registered: ${title}`);
      fs.rmSync(pdxDir, { recursive: true, force: true });
      continue;
    }
    const meta = games.registerGame(pdxDir, { source: 'sdk-example', title: name });
    titles.add(meta.title);
    added += 1;
    console.log(`registered: ${meta.title} (${meta.id})`);
    fs.rmSync(pdxDir, { recursive: true, force: true });
  }
  console.log(`Done. ${added} example game(s) registered.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
