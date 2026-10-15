#!/usr/bin/env node
// The vfx part's stand-in sprites for the effect styles (runtimes/three/kit/vfx/styles.js), made here so they can be
// made again: the procedural ones are drawn from SVG (ours, MIT), two come from the asset library and keep their
// licence (library/packs/<pack>/LICENSE.txt; the kit's vfx/NOTICE-styles says which file is which).
//
//   node scripts/make-vfx-standins.mjs            writes runtimes/three/kit/vfx/standin/*.png
//
// Each sprite is white (or white and grey) on transparent: a preset's colour tints it (index.js multiplies), so dark
// ink drawn into a sprite stays ink whatever the colour.
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'runtimes/three/kit/vfx/standin');
const { sharp } = await import(pathToFileURL(path.join(ROOT, 'builder/tools/lib/char-deps.mjs')).href);

const svg = (size, body) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${body}</svg>`);
// a ball lit from above: white over most of it, a soft grey shade on the lower edge, a small highlight (rim: the ink)
const ball = (rim, rimW) => svg(128, `
  <defs><radialGradient id="g" cx="0.42" cy="0.32" r="0.74" fx="0.4" fy="0.28"><stop offset="0" stop-color="#ffffff"/><stop offset="0.5" stop-color="#fbfbfd"/><stop offset="0.78" stop-color="#e2e3ea"/><stop offset="1" stop-color="#a6a8b8"/></radialGradient></defs>
  <circle cx="64" cy="64" r="${61 - rimW / 2}" fill="url(#g)"${rimW ? ` stroke="${rim}" stroke-width="${rimW}"` : ''}/>
  <ellipse cx="47" cy="38" rx="13" ry="8" fill="#ffffff" transform="rotate(-30 47 38)"/>`);
const star = () => {
  const pts = []; for (let i = 0; i < 10; i++) { const a = -Math.PI / 2 + i * Math.PI / 5, r = i % 2 ? 24 : 54; pts.push(`${(64 + Math.cos(a) * r).toFixed(1)},${(66 + Math.sin(a) * r).toFixed(1)}`); }
  return svg(128, `<defs><linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#d9d9d9"/></linearGradient></defs>
  <polygon points="${pts.join(' ')}" fill="url(#s)" stroke="#17171c" stroke-width="7" stroke-linejoin="round"/>`);
};
const ring = () => svg(128, `<circle cx="64" cy="64" r="50" fill="none" stroke="#17171c" stroke-width="16"/><circle cx="64" cy="64" r="50" fill="none" stroke="#ffffff" stroke-width="9"/>`);
const square = () => svg(32, `<rect x="0" y="0" width="32" height="32" fill="#ffffff"/><rect x="0" y="26" width="32" height="6" fill="#c8c8d0"/><rect x="26" y="0" width="6" height="32" fill="#c8c8d0"/>`);

const made = [];
async function put(name, buf, { size } = {}) {
  let img = sharp(buf);
  if (size) img = img.resize(size, size, { fit: 'fill' });
  await writeFile(path.join(OUT, `${name}.png`), await img.png({ compressionLevel: 9, palette: false }).toBuffer());
  made.push(name);
}
await put('puff-toon', ball('#9799ab', 0));
await put('puff-ink', ball('#17171c', 9));
await put('star', star());
await put('ring', ring());
await put('square', square());

// from the asset library's store (~/.xgames/store or XGAMES_STORE), by the manifests' sha256
const STORE = process.env.XGAMES_STORE ?? path.join(os.homedir(), '.xgames', 'store');
async function fromLibrary(pack, id) {
  const m = JSON.parse(await readFile(path.join(ROOT, 'library/packs', pack, 'assets', `${id}.json`), 'utf8'));
  for (const f of [path.join(ROOT, 'library/defaults/sha256', m.sha256.slice(0, 2), m.sha256), path.join(STORE, 'sha256', m.sha256.slice(0, 2), m.sha256)]) if (existsSync(f)) return readFile(f);
  throw new Error(`${pack}/${id}: not on this machine (gamesfun art fetch ${pack}/${id})`);
}
await put('smoke-wisp', await fromLibrary('kenney-particle-pack', 'smoke-04'), { size: 128 });
await put('fireball', await fromLibrary('quiver-outpost-fx', 'explosion-flipbook'), { size: 640 });
console.log(`wrote ${made.map(n => `${n}.png`).join(', ')} in ${path.relative(ROOT, OUT)}`);
