// A gallery of generated places: each place built by the core in a headless WebGPU Chrome (sandbox/core-view
// ?seed=N&words=…, core patch #6) and filmed from the same five shots, plus the reference island through its recipe;
// then a contact sheet per place, an index.html and record.json (the words, the generation time in Node, the core's
// terrain timings, the page's heap and GPU memory, the village's and the plants' counts per place).
//
//   gpu-run.sh node runtimes/vista/tools/places-gallery.mjs --out <dir> [--places ref,101:size=small;bay=w,…]
//        [--size 1920x1080] [--frames 48] [--raw <scratch dir for the PNGs>]
//
// The five shots (sandbox/core-view): start (the player's first view, eye height), sea (the harbour from the water 350 m
// off the pier head), aerial (the whole island from high over the sea in front of its harbour), back (the far side,
// low over the water) and village (from the slope above the harbour, down over the houses to the pier and the bay).
// Every shot is taken at the place's own hour and sea (its time and weather words: kit/world/places.js placeLook), so a
// place asked for at night is filmed at night. Bench mode (seeded random, the clock held): the same place and code give
// the same pictures. The gallery keeps JPEGs; the lossless captures stay in --raw.
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { capture } from './capture.mjs';
import { readPng, writePng, shrink } from './img.mjs';
import { serve } from './serve.mjs';
import { launchChrome } from '../../../builder/qa/browser.mjs';
import { placeRecipe, REFERENCE, describePlace, placeLook } from '../kit/world/places.js';

const VISTA = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i < 0 ? d : (process.argv[i + 1] ?? true); };
const OUT = resolve(String(arg('out', join(tmpdir(), 'vista-places-gallery'))));
const [W, H] = String(arg('size', '1920x1080')).split('x').map(Number);
const RAW = resolve(String(arg('raw', join(tmpdir(), 'vista-places-gallery-raw'))));
const FRAMES = Number(arg('frames', 48));
export const SHOTS = [
  { name: 'start', view: 'placeStart', says: 'the first view (the start)' },
  { name: 'sea', view: 'placeSea', says: 'the harbour from the sea' },
  { name: 'aerial', view: 'placeAerial', says: 'the whole island from the air' },
  { name: 'back', view: 'placeBack', says: 'the far side, from the water' },
  { name: 'village', view: 'placeVillage', says: 'down over the harbour' },
];
// The 24: every word in play at least twice, four places left to the seed alone (what a spec with no words gets);
// the reference first.
export const DEFAULT = [
  'ref',
  '201',
  '202:size=small;peaks=low;beach=narrow;village=hamlet;time=morning',
  '203:size=medium;bay=w;plants=lush;reef=small;coast=rugged',
  '204:size=large;shape=plateau;peaks=high;beach=wide;village=hamlet;time=noon',
  '205:size=small;peaks=high;bay=e;reef=none;weather=storm',
  '206',
  '207:size=large;bay=n;beach=narrow;reef=large;river=yes',
  '208:size=medium;peaks=high;village=hamlet;plants=lush;time=sunset',
  '209:shape=archipelago;village=hamlet;water=lagoon',
  '210',
  '211:size=large;peaks=high;beach=narrow;village=hamlet;plants=lush;river=yes;time=golden',
  '212:size=medium;shape=volcano;peaks=high;bay=e;village=none;reef=small;coast=smooth',
  '213:shape=atoll;pier=jetty;houses=bright;time=noon',
  '214:shape=twin;sand=dark;rock=basalt;vegetation=jungle;water=deep;weather=overcast',
  '215:shape=cliffs;rock=limestone;vegetation=cliffs;houses=whitewash;coast=rugged',
  '216',
  '217:size=small;islets=3;water=flat;pier=pier;houses=timber;time=night',
  '218:shape=ridge;pier=jetty;village=town;houses=pastel;bay=w',
  '219:shape=archipelago;sand=golden;vegetation=scrub;village=none;time=morning',
  '220:shape=cliffs;peaks=high;vegetation=cliffs;village=none;weather=storm;coast=rugged',
  '221:size=large;shape=single;river=yes;village=town;houses=whitewash;coast=coves',
  '222:size=medium;shape=twin;sand=white;vegetation=palms;water=lagoon;time=sunset',
  '223:shape=ridge;rock=limestone;vegetation=scrub;sand=golden;coast=smooth;weather=overcast;houses=terracotta;pier=dock',
  '224:size=small;shape=atoll;islets=2;village=none;time=night',
].join(',');
const PLACES = String(arg('places', DEFAULT)).split(',').filter(Boolean);

const parse = s => {
  if (s === 'ref') return { id: 'reference', seed: null, words: {}, query: 'place=reference' };
  const [seed, w = ''] = s.split(':');
  const words = Object.fromEntries(w.split(';').filter(Boolean).map(kv => kv.split('=')));
  return { id: `seed-${seed}`, seed: Number(seed), words, query: `seed=${seed}&words=${Object.entries(words).map(([k, v]) => `${k}:${v}`).join(',')}` };
};

export async function gallery({ places = PLACES, out = OUT, raw = RAW, width = W, height = H, frames = FRAMES, log = console.log } = {}) {
  await mkdir(join(out, 'shots'), { recursive: true });
  const server = await serve(VISTA, 0);
  const url = `http://127.0.0.1:${server.address().port}/sandbox/core-view/`;
  const rows = [], toEncode = [];
  try {
    for (const p of places.map(parse)) {
      const g0 = performance.now();
      const recipe = p.seed == null ? REFERENCE : placeRecipe(p.seed, p.words);
      const genMs = Math.round(performance.now() - g0);
      const lk = placeLook(p.seed == null ? null : recipe, { hour: 15.5, sea: 'breezy' });
      const t0 = Date.now();
      const dir = join(raw, p.id);
      const shots = SHOTS.map(s => ({ ...s, hour: lk.hour, sea: lk.sea }));
      // what the place cost the core: its terrain timings, the page's heap, the village's and the plants' counts
      const onLoaded = page => page.evaluate(() => {
        const app = window.__vista.app, v = app.village?.getStats?.(), veg = app.vegetation?.records;
        return {
          readyMs: window.__vista.readyMs, look: window.__vista.look.state, terrainMs: app.terrainData.timings, heapMB: Math.round((performance.memory?.usedJSHeapSize ?? 0) / 1048576),
          village: v && { triangles: Math.round(v.triangles), drawCalls: v.drawCalls, lights: v.lights, buildings: app.village.buildings.length },
          plants: veg && Object.fromEntries(Object.entries(veg).map(([k, a]) => [k, a.length])),
        };
      });
      const look = lk.clouds != null || lk.exposure != null ? lk : null;
      const rec = await capture({ url: `${url}?noui&${p.query}${look ? `&look=${encodeURIComponent(JSON.stringify(look))}` : ''}`, out: dir, width, height, frames, dt: 0, shots, bench: false, lookApi: true, log: () => {}, onLoaded });
      const files = [];
      for (const s of shots) {
        const file = `shots/${p.id}-${s.name}.jpg`;
        toEncode.push({ png: join(dir, s.name + '.png'), file });
        files.push({ view: s.name, file, says: s.says });
      }
      // one strip per place: the five shots side by side at a third of their size (what a reviewer looks at first)
      const strip = SHOTS.map(s => shrink(readPng(join(dir, s.name + '.png')), 3));
      const sw = strip.reduce((a, b) => a + b.width, 0), sh = strip[0].height, data = Buffer.alloc(sw * sh * 4);
      let x0 = 0;
      for (const img of strip) { for (let y = 0; y < sh; y++) img.data.copy(data, (y * sw + x0) * 4, y * img.width * 4, (y + 1) * img.width * 4); x0 += img.width; }
      writePng(join(dir, 'strip.png'), { width: sw, height: sh, data });
      toEncode.push({ png: join(dir, 'strip.png'), file: `shots/${p.id}-strip.jpg` });
      rows.push({ id: p.id, seed: p.seed, asked: p.words, words: recipe.words, look: lk, describe: describePlace(recipe), generateMs: genMs, loadMs: rec.loadMs, gpu: rec.gpu?.architecture, cost: rec.extra, console: rec.console.filter(c => c.type !== 'warning').map(c => c.text), files, strip: `shots/${p.id}-strip.jpg`, ms: Date.now() - t0 });
      log(`${p.id}: ${describePlace(recipe)} (generated in ${genMs} ms, filmed in ${((Date.now() - t0) / 1000).toFixed(1)} s, ${rec.console.length} console messages)`);
    }
  } finally { server.close(); }

  // JPEG through Chrome's own encoder (a screenshot of the picture at 1:1)
  const browser = await launchChrome({ gpu: 'webgl' });
  try {
    for (const e of toEncode) {
      const { width: w, height: h } = readPng(e.png);
      const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
      await page.setContent(`<html><body style="margin:0;background:#000"><img src="data:image/png;base64,${readFileSync(e.png).toString('base64')}" style="display:block;width:${w}px;height:${h}px"></body></html>`);
      await page.waitForFunction(() => document.images[0]?.complete);
      await page.screenshot({ path: join(out, e.file), type: 'jpeg', quality: 86, clip: { x: 0, y: 0, width: w, height: h } });
      await page.close();
    }
  } finally { await browser.close(); }

  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Places gallery</title>
<style>
:root { --bg: #f6f4ef; --fg: #1d2327; --muted: #5c6670; --card: #fff; --line: #e1ddd3; }
@media (prefers-color-scheme: dark) { :root { --bg: #14181b; --fg: #e8ecef; --muted: #9aa5ae; --card: #1d2327; --line: #2c343a; } }
body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.45 system-ui, sans-serif; }
main { max-width: 1600px; margin: 0 auto; padding: 24px 16px 60px; }
h1 { font-size: 22px; margin: 0 0 4px; } p.lede { color: var(--muted); margin: 0 0 20px; }
.place { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 12px; margin: 0 0 16px; }
.place h2 { font-size: 16px; margin: 0 0 2px; } .place .w { color: var(--muted); font-size: 13px; margin: 0 0 10px; }
.shots { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 8px; }
.shots a { display: block; } .shots img { width: 100%; height: auto; border-radius: 6px; display: block; }
.shots span { font-size: 12px; color: var(--muted); }
</style></head><body><main>
<h1>Places gallery</h1>
<p class="lede">Each island generated by <code>runtimes/vista/kit/world/places.js placeRecipe(seed, words)</code> and built by the vista core, filmed headless on WebGPU at ${width}x${height} from the same five shots, at the place's own hour and sea. The first row is the core's own island through its recipe (the reference). Click a picture for the full size.</p>
${rows.map(r => `<section class="place"><h2>${esc(r.id)}</h2><p class="w">${esc(r.describe)} · asked: ${esc(Object.entries(r.asked).map(([k, v]) => `${k}=${v}`).join(', ') || 'nothing (the seed alone)')}</p><div class="shots">${r.files.map(f => `<a href="${f.file}"><img src="${f.file}" alt="${esc(r.id + ' ' + f.view)}" loading="lazy"><span>${esc(f.says)}</span></a>`).join('')}</div></section>`).join('\n')}
</main></body></html>
`;
  await writeFile(join(out, 'index.html'), html);
  const record = { schema: 'vista-places-gallery/2', at: new Date().toISOString(), tool: 'runtimes/vista/tools/places-gallery.mjs', size: [width, height], frames, shots: SHOTS, places: rows };
  await writeFile(join(out, 'record.json'), JSON.stringify(record, null, 2) + '\n');
  log(`${rows.length} places → ${out}/index.html`);
  return record;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) { await gallery(); process.exit(0); }
