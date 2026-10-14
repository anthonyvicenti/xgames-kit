#!/usr/bin/env node
// Track C exit gate on the character bench (real GPU): node runtimes/three/character-bench/qa.mjs [--bodies a,b,c] [--swiftshader]
//   1. swap: three bodies replace the player slot's file through a Studio-style override (window.__GF_ASSET_OVERRIDES
//      set before the page loads), and each plays the same clips (walk moves its legs, no NaN)
//   2. clips: every clip of the shared file plays on each swapped body
//   3. knock: a knock ragdolls the body onto the floor and it gets up
//   4. line-up: four different bodies side by side on the same clip
//   5. coverage: every visible mesh is a slot or exempt
// Writes evidence/run-N/ (verdict.json, screenshots, contact sheet). Evidence is append-only: a new run each time.
import { mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChrome } from '../../../builder/qa/browser.mjs';
import { benchLibrary, serve } from './serve.mjs';
import { sharp } from '../../../builder/tools/lib/char-deps.mjs';
import { findAsset, localFile } from '../../../builder/art/views.mjs';

const here = dirname(fileURLToPath(import.meta.url));
// BENCH_PORT: another port when 5792 is taken (a bench server from another checkout would serve its own library)
const PORT = +(process.env.BENCH_PORT ?? 5792), URL0 = `http://127.0.0.1:${PORT}/character-bench/`;
const args = process.argv.slice(2);
const lib = await benchLibrary();
const want = args.includes('--bodies') ? args[args.indexOf('--bodies') + 1].split(',')
  : ['bean-chunky', 'quaternius-astronaut', lib.bodies.find(b => b.ref.startsWith('generated-bodies/'))?.id ?? 'ual-mannequin'];
const ev = join(here, 'evidence');
mkdirSync(ev, { recursive: true });
const n = Math.max(0, ...readdirSync(ev).map(d => +(d.match(/^run-(\d+)$/)?.[1] ?? 0))) + 1;
const out = join(ev, `run-${n}`);
mkdirSync(out);

let server = null;
try { await fetch(URL0); } catch { server = await serve(PORT); }
const browser = await launchChrome(args.includes('--swiftshader') ? {} : { gpu: 'webgl' });
const checks = [], shots = [];
const check = (name, ok, detail) => { checks.push({ name, ok: !!ok, ...detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail?.note ? `  ${detail.note}` : ''}`); };

async function open(query = '', override = null) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error' && !/favicon|404/.test(m.text())) errors.push(m.text()); });
  if (override) {
    const b64 = readFileSync(localFile(findAsset(lib.bodies.find(b => b.id === override).ref))).toString('base64');
    await page.addInitScript(d => { window.__GF_ASSET_OVERRIDES = { files: { 'assets/models/body-player.glb': d }, patches: [] }; }, `data:model/gltf-binary;base64,${b64}`);
  }
  await page.goto(URL0 + query);
  await page.waitForFunction(() => window.__bench?.ready || window.__bench?.errors?.length, null, { timeout: 90000 });
  await page.evaluate(() => { document.getElementById('ui').style.display = 'none'; window.__bench.freeze(true); });
  return { page, errors };
}
async function shot(page, name) { const f = join(out, `${name}.png`); await page.waitForTimeout(120); await page.screenshot({ path: f }); shots.push(f); return f; }

// ---- 0. the default player slot
let base;
{
  const { page, errors } = await open('');
  base = (await page.evaluate(() => window.__bench.describe()))[0];
  check('default player slot loads', base && !base.nan && errors.length === 0, { body: lib.default, materials: base?.materials, verts: base?.verts, errors });
  await page.close();
}
// ---- 1 + 2. swap through the override, same clips
const swapped = [];
for (const id of want) {
  const { page, errors } = await open('', id);
  const d0 = (await page.evaluate(() => window.__bench.describe()))[0];
  const seen = await page.evaluate(() => (window.__GF_ASSETS_SEEN ?? []).slice());
  const libBody = lib.bodies.find(b => b.id === id);
  const differs = d0.verts !== base.verts || d0.materials.join() !== base.materials.join();
  // walk: the legs move, the feet stay near the ground
  await page.evaluate(() => { window.__bench.setSpeed(1.4, { inPlace: true }); window.__bench.advance(0.6); });
  const a = (await page.evaluate(() => window.__bench.describe()))[0];
  await page.evaluate(() => window.__bench.advance(0.33));
  const b = (await page.evaluate(() => window.__bench.describe()))[0];
  const legMoved = Math.abs(a.pose[1][0] - b.pose[1][0]) + Math.abs(a.pose[1][2] - b.pose[1][2]) > 0.02;
  await shot(page, `swap-${id}-walk`);
  // every clip of the shared file
  const bad = await page.evaluate(() => {
    const B = window.__bench, c = B.chars[0], out = [];
    B.setSpeed(0);
    // a broken retarget throws the mesh far off; a tail through the floor while lying down is not that
    for (const n of c.clips) { c.play(n, { loop: c.meta[n]?.loop }); B.advance(0.4); const d = B.describe()[0]; if (d.nan || d.minY < -0.9 * d.height || d.maxY > 2.2 * d.height) out.push(n); c.stop('upper'); c.stop('base'); }
    return out;
  });
  await page.evaluate(() => { const c = window.__bench.chars[0]; c.play('emote_wave'); window.__bench.advance(0.9); });
  await shot(page, `swap-${id}-wave`);
  swapped.push({ id, clips: d0.clips });
  check(`override swaps the player body to ${id}`, differs && seen.includes('assets/models/body-player.glb') && errors.length === 0,
    { verts: d0.verts, materials: d0.materials, height: d0.height, libraryHeight: libBody?.height, seen: seen.filter(s => s.includes('body')), errors });
  check(`${id} walks on the shared clips`, legMoved && !a.nan && !b.nan && Math.abs(a.minY) < 0.1, { minY: a.minY, legMoved });
  check(`${id} plays every clip (${d0.clips.length})`, bad.length === 0, { failed: bad });
}
check('the swapped bodies all have the same clip list', new Set(swapped.map(s => s.clips.join())).size === 1 && swapped[0].clips.length >= 14, { clips: swapped[0]?.clips });

// ---- 3. knock → ragdoll → get up
for (const id of [want[0], want.at(-1)]) {
  const { page, errors } = await open(`?body=${id}`);
  await page.evaluate(() => { window.__bench.advance(0.3); window.__bench.knockAll(Math.PI * 0.85); });
  const track = [];
  for (const [i, t] of [0.35, 0.8, 1.6, 2.6, 3.8, 5.0].entries()) {
    await page.evaluate(d => window.__bench.advance(d), i === 0 ? t : t - [0.35, 0.8, 1.6, 2.6, 3.8, 5.0][i - 1]);
    const d = (await page.evaluate(() => window.__bench.describe()))[0];
    track.push({ t, state: d.state, anim: d.anim, headY: d.head[1], minY: d.minY });
    if (i === 1 || i === 3 || i === 5) await shot(page, `knock-${id}-${t}s`);
  }
  const wentDown = track.some(s => s.state === 'ragdoll' && s.headY < 0.6 * (base.height));
  const gotUp = track.at(-1).state === 'anim' && track.some(s => s.state === 'getup');
  check(`${id}: a knock ragdolls it to the floor and it gets up`, wentDown && gotUp && errors.length === 0, { track, errors });
}

// ---- 4. line-up: four bodies, one clip
{
  const four = ['bean-classic', 'ual-mannequin', 'quaternius-astronaut', lib.bodies.find(b => b.kind === 'meshy')?.id ?? 'bean-tall'];
  const { page, errors } = await open(`?mode=lineup&bodies=${four.join(',')}&clip=emote_cheer`);
  await page.evaluate(() => window.__bench.advance(0.55));
  const d = await page.evaluate(() => window.__bench.describe());
  await shot(page, 'lineup-cheer');
  await page.evaluate(() => { window.__bench.playAll('walk'); window.__bench.setSpeed(1.2); window.__bench.advance(0.7); });
  await shot(page, 'lineup-walk');
  check('four different bodies side by side on the same clip', d.length === 4 && new Set(d.map(x => x.body)).size === 4 && d.every(x => x.anim === 'emote_cheer' && !x.nan) && errors.length === 0,
    { bodies: d.map(x => ({ body: x.body, anim: x.anim, height: x.height })), errors });
  // ---- 5. coverage
  const cov = await page.evaluate(() => window.__bench.coverage());
  check('slot coverage: every visible mesh is tagged or exempt', cov.untagged.length === 0, { meshes: cov.meshes, tagged: cov.tagged, exempt: cov.exempt, untagged: cov.untagged.slice(0, 5) });
}
// ---- the all-bodies shot
{ const { page } = await open('?mode=all&clip=idle'); await page.evaluate(() => window.__bench.advance(0.4)); await shot(page, 'all-bodies-idle'); }

await browser.close();
server?.close();
// contact sheet
const cells = await Promise.all(shots.map(f => sharp(f).resize(640, 400, { fit: 'cover' }).toBuffer()));
const cols = 3, rows = Math.ceil(cells.length / cols);
await sharp({ create: { width: cols * 640, height: rows * 400, channels: 3, background: '#ffffff' } })
  .composite(cells.map((input, i) => ({ input, left: (i % cols) * 640, top: Math.floor(i / cols) * 400 }))).png().toFile(join(out, 'contact-sheet.png'));
const verdict = { ok: checks.every(c => c.ok), run: `run-${n}`, at: new Date().toISOString(), gpu: args.includes('--swiftshader') ? 'swiftshader' : 'webgl (real GPU)', bodies: want, checks, shots: shots.map(f => f.split('/').pop()) };
writeFileSync(join(out, 'verdict.json'), JSON.stringify(verdict, null, 2) + '\n');
console.log(`\n${verdict.ok ? 'PASS' : 'FAIL'}  ${checks.filter(c => c.ok).length}/${checks.length} checks  → ${out}`);
process.exit(verdict.ok ? 0 : 1);
