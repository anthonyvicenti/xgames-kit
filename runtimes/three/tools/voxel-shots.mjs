#!/usr/bin/env node
// voxel-shots: the voxel world's bench (voxel-bench/) on the real graphics card. Pictures at framings found in the world
// (a view over the land, a lit cave, a dug pit, a small build, the spawn square from above) and frame-cost runs that fly
// the camera over the land with the frame cap off. Run it through the machine's GPU slots:
//
//   .claude/scripts/gpu-run.sh node runtimes/three/tools/voxel-shots.mjs [--kind blocky] [--out dir] [--size 1920x1080]
//       [--shots horizon,cave,pit,build,third] [--perf 3840x2160@high,1280x720@high,1170x2532@low] [--seconds 6]
//       [--query seed=9] [--software]
// Writes <out>/<shot>.png and <out>/record.json (load timings, renderer stats, frame times). Frame cost wants
// CHROME_ARGS="--use-gl=angle --use-angle=gl-egl --disable-gpu-vsync --disable-frame-rate-limit".
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { KIT, VENDOR, repoFileOf, libraryRoute } from '../../../builder/look-judge/lib/roots.mjs';
import { startServer } from '../../../builder/look-judge/lib/server.mjs';
import { launchChrome } from '../../../builder/qa/browser.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2), opt = (k, d = null) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const KIND = opt('--kind', 'blocky'), OUT = resolve(opt('--out', 'voxel-shots'));
const [W, H] = opt('--size', '1920x1080').split('x').map(Number);
const SHOTS = opt('--shots', 'horizon,cave,friends,pit,build,third').split(',').filter(Boolean);
const PERF = (opt('--perf', '') ?? '').split(',').filter(Boolean).map(s => { const [wh, q = 'high'] = s.split('@'); const [w, h] = wh.split('x').map(Number); return { w, h, quality: q }; });
const SECONDS = Number(opt('--seconds', 6)), QUERY = opt('--query', '') ? `&${opt('--query')}` : '';
const sleep = ms => new Promise(r => setTimeout(r, ms));
mkdirSync(OUT, { recursive: true });

const server = await startServer({
  '/kit/': rel => repoFileOf(`gf/three/${rel}`), '/lib3/': libraryRoute(join(KIT, '.cache/sheet-library')), '/xk/': KIT, '/bench/': join(HERE, 'voxel-bench'),
  '/vendor/three/': VENDOR.threeBuild, '/vendor/postprocessing/': VENDOR.postprocessing, '/vendor/n8ao/': VENDOR.n8ao, '/vendor/rapier/': VENDOR.rapier,
});
// --software: SwiftShader on the processor (a quick check that the page runs; never for pictures or frame cost)
const browser = await launchChrome(argv.includes('--software') ? { args: ['--enable-unsafe-swiftshader'] } : { gpu: 'webgl' });
const record = { kind: KIND, chrome: browser.version(), shots: [], perf: [], args: process.env.CHROME_ARGS ?? '' };

async function open(w, h, query) {
  const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message.slice(0, 400)));
  page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`${m.type()}: ${m.text().slice(0, 400)}`); });
  await page.goto(`${server.url}/bench/index.html?kind=${KIND}${query}${QUERY}`);
  const t0 = Date.now();
  for (;;) {
    const s = await page.evaluate(() => window.__bench && { ready: window.__bench.ready, errors: window.__bench.errors }).catch(() => null);
    if (s?.ready) break;
    if (s?.errors?.length) { errors.push(...s.errors); break; }
    if (Date.now() - t0 > 180000) { errors.push('not ready in 180 s'); break; }
    await sleep(250);
  }
  return { page, errors };
}

try {
  // SwiftShader loses the first page's context to the kit's quality probe: a throwaway page first
  if (argv.includes('--software')) { const w = await open(320, 180, '&shot=third'); await w.page.close(); }
  for (const shot of SHOTS) {
    const { page, errors } = await open(W, H, `&shot=${shot}`);
    await sleep(400);
    const file = join(OUT, `${shot}.png`);
    await page.screenshot({ path: file });
    const info = await page.evaluate(() => window.__bench?.info).catch(() => null);
    record.shots.push({ shot, file, info, errors });
    console.log(`${shot}: ${errors.length ? errors.join(' | ').slice(0, 300) : 'ok'} ${JSON.stringify(info?.frame ?? {})} load ${info?.loadMs} ms`);
    await page.close();
  }
  for (const p of PERF) {
    const { page, errors } = await open(p.w, p.h, `&shot=third&quality=${p.quality}`);
    const r = await page.evaluate(ms => window.__bench.perf(ms), SECONDS * 1000).catch(e => ({ error: e.message }));
    const info = await page.evaluate(() => window.__bench?.info).catch(() => null);
    record.perf.push({ ...p, ...r, loadMs: info?.loadMs, world: info?.world?.timings, errors });
    console.log(`perf ${p.w}x${p.h} ${p.quality}: ${JSON.stringify(r)} load ${info?.loadMs} ms ${JSON.stringify(info?.world?.timings)}`);
    await page.close();
  }
} finally {
  writeFileSync(join(OUT, 'record.json'), JSON.stringify(record, null, 1));
  await browser.close(); await server.close();
}
