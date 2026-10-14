#!/usr/bin/env node
// What a generated place costs to draw and to make: for each place, the core's own bench (core/src/core/Bench.js run():
// per view, wall ms per frame back to back and the GPU's timestamp span) at 3840x2160 from the gallery's five place
// shots, the time to generate the recipe in Node, the core's terrain timings and the page's heap. The reference island
// (its recipe) is the yardstick.
//
//   gpu-run.sh node runtimes/vista/tools/frame-cost.mjs --out <dir> [--places ref,204:shape=plateau,…] [--size 3840x2160]
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { capture } from './capture.mjs';
import { serve } from './serve.mjs';
import { placeRecipe, REFERENCE, placeLook } from '../kit/world/places.js';

const VISTA = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i < 0 ? d : (process.argv[i + 1] ?? true); };
const OUT = resolve(String(arg('out', join(tmpdir(), 'vista-frame-cost'))));
const SIZE = String(arg('size', '3840x2160'));
const PLACES = String(arg('places', 'ref,211:size=large;peaks=high;village=town;river=yes,209:shape=archipelago;village=hamlet,204:size=large;shape=plateau;peaks=high;village=hamlet')).split(',');
const VIEWS = ['placeStart', 'placeSea', 'placeAerial', 'placeBack', 'placeVillage'];
const parse = s => {
  if (s === 'ref') return { id: 'reference', seed: null, words: {}, query: 'place=reference' };
  const [seed, w = ''] = s.split(':');
  const words = Object.fromEntries(w.split(';').filter(Boolean).map(kv => kv.split('=')));
  return { id: `seed-${seed}`, seed: Number(seed), words, query: `seed=${seed}&words=${Object.entries(words).map(([k, v]) => `${k}:${v}`).join(',')}` };
};

await mkdir(OUT, { recursive: true });
const server = await serve(VISTA, 0);
const url = `http://127.0.0.1:${server.address().port}/sandbox/core-view/`;
const rows = [];
try {
  for (const p of PLACES.map(parse)) {
    const g0 = performance.now();
    const recipe = p.seed == null ? REFERENCE : placeRecipe(p.seed, p.words);
    const generateMs = Math.round(performance.now() - g0);
    const lk = placeLook(p.seed == null ? null : recipe, { hour: 15.5, sea: 'breezy' });
    const onLoaded = page => page.evaluate(() => ({ readyMs: window.__vista.readyMs, terrainMs: window.__vista.app.terrainData.timings, heapMB: Math.round((performance.memory?.usedJSHeapSize ?? 0) / 1048576) }));
    const rec = await capture({ url: `${url}?noui&${p.query}`, out: join(OUT, p.id), width: 1280, height: 720, frames: 8, dt: 0, shots: [], bench: true, benchSize: SIZE, lookApi: true, log: () => {}, onLoaded, benchViews: VIEWS });
    rows.push({ id: p.id, words: recipe.words, look: lk, generateMs, load: rec.extra, frame: rec.bench });
    console.log(`${p.id}: generated in ${generateMs} ms, ready in ${rec.extra?.readyMs} ms, terrain ${JSON.stringify(rec.extra?.terrainMs)}, heap ${rec.extra?.heapMB} MB; frames at ${SIZE}: ${JSON.stringify(rec.bench)}`);
  }
} finally { server.close(); }
await writeFile(join(OUT, 'record.json'), JSON.stringify({ schema: 'vista-frame-cost/1', at: new Date().toISOString(), tool: 'runtimes/vista/tools/frame-cost.mjs', size: SIZE, views: VIEWS, places: rows }, null, 2) + '\n');
console.log(`→ ${join(OUT, 'record.json')}`);
process.exit(0);
