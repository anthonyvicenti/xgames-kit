#!/usr/bin/env node
// gf-forge lookdev: one or more lookdev pictures by their query, each measured (track L1, wave 2).
//
//   node runtimes/forge/lookdev/shot.mjs --out <dir> [--wasm <dev build dir>] [--size 1280x720] [--wait 2200]
//        [--fire N]  (fire once, then keep N frames, one a frame: the flash, the tracer, the hit, the kill's burst)
//        [--box x0,y0,x1,y1]  (where the detail measure is taken; default the ground: the lower right of the frame)
//        [--sheet name.jpg] [--cols 3]
//        "preset=moonlit-ruins&shot=hero" "preset=moonlit-ruins&shot=ground&retro=0" …
//
// Per picture: luma (mean, median, 99th percentile, the share over 200) against the look targets, and the
// pixel-to-pixel detail of a box of it (lookdev/measure.mjs `detailOf`: the mean absolute luma step between
// neighbouring pixels, across and down, at the picture's own resolution). Writes <out>/<n>-<name>.png, <out>/shots.json
// and, with --sheet, a contact sheet. Not judged on a software GPU.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startLookdev } from './serve.mjs';
import { lumaOf, detailOf, sheetOf, verdictOf, LOOK_TARGET } from './measure.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../../..');
const { launchChrome } = await import(join(REPO, 'builder/qa/browser.mjs'));
const sleep = ms => new Promise(r => setTimeout(r, ms));

const a = process.argv.slice(2);
const flags = new Set(['--out', '--wasm', '--size', '--wait', '--fire', '--box', '--sheet', '--cols', '--throttle']);
const opt = (k, d = null) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : d; };
const queries = a.filter((x, i) => !x.startsWith('--') && !flags.has(a[i - 1]));
if (!queries.length || !opt('--out')) { console.error('usage: shot.mjs --out <dir> [--wasm <dir>] [--size WxH] [--wait ms] [--fire N] [--box x0,y0,x1,y1] [--sheet name.jpg] "<query>" …'); process.exit(2); }
const out = resolve(opt('--out'));
const [W, H] = (opt('--size', '1280x720')).split('x').map(Number);
const wait = Number(opt('--wait', 2200)), fire = Number(opt('--fire', 0));
const box = opt('--box') ? opt('--box').split(',').map(Number) : [Math.round(W * 0.5), Math.round(H * 0.667), Math.round(W * 0.86), Math.round(H * 0.972)];
mkdirSync(out, { recursive: true });

const srv = await startLookdev({ port: 0, wasm: opt('--wasm') });
const browser = await launchChrome({ gpu: 'webgpu' });
const record = { tool: 'runtimes/forge/lookdev/shot.mjs', chrome: browser.version(), size: [W, H], detailBox: box, lookTarget: LOOK_TARGET, shots: [] };
const rows = [];
let problems = 0;
try {
  for (const [n, query] of queries.entries()) {
    const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message)); page.on('console', m => { if (m.type() === 'error') errors.push(m.text().slice(0, 300)); });
    await page.goto(`${srv.url}?${query}&hud=0${fire ? '&fx=0' : ''}`, { waitUntil: 'load' });
    const t0 = Date.now();
    for (;;) { const s = await page.evaluate(() => ({ ready: window.__lookdev?.ready, error: window.__lookdev?.error })).catch(() => ({})); if (s.ready || s.error) { if (s.error) errors.push(s.error); break; } if (Date.now() - t0 > 90000) { errors.push('not ready in 90 s'); break; } await sleep(200); }
    await sleep(wait);
    const name = query.replace(/preset=/, '').replace(/[&=]/g, '-').replace(/[^a-z0-9.-]/gi, '').slice(0, 70);
    const frames = [];
    if (fire) {
      // the shot and the frames after it, one screenshot a frame (a screenshot takes longer than a frame: each is
      // the picture some frames on, so the page is asked to fire again for every later one and waits k frames)
      for (let k = 0; k < fire; k++) {
        await sleep(900);
        await page.evaluate(k => new Promise(done => { window.__lookdev.fire(); let left = k; const step = () => (left-- <= 0 ? done() : requestAnimationFrame(step)); requestAnimationFrame(step); }), k);
        frames.push({ png: await page.screenshot({ type: 'png' }), tag: `f${k}` });
      }
    } else frames.push({ png: await page.screenshot({ type: 'png' }), tag: '' });
    for (const f of frames) {
      const file = join(out, `${String(n + 1).padStart(2, '0')}-${name}${f.tag ? `-${f.tag}` : ''}.png`);
      writeFileSync(file, f.png);
      const luma = await lumaOf(page, f.png), detail = await detailOf(page, f.png, box);
      const stats = await page.evaluate(() => window.__lookdev.stats()).catch(() => null);
      const row = { query, frame: f.tag || null, file: file.slice(out.length + 1), luma, inTarget: verdictOf(luma), detail, stats, errors: errors.slice(0, 3) };
      record.shots.push(row);
      rows.push({ file, caption: `${name.slice(0, 44)}${f.tag ? ` ${f.tag}` : ''} · luma ${luma.mean}/${luma.median}/${luma.p99} · detail ${detail.across}` });
      console.log(`${query}${f.tag ? ` ${f.tag}` : ''}: luma mean ${luma.mean} median ${luma.median} p99 ${luma.p99} >200 ${(luma.over200 * 100).toFixed(1)}% · detail across ${detail.across} down ${detail.down} (box mean luma ${detail.mean}) · ${stats ? `${stats.draws} draws, ${stats.instances} instances, ${stats.culled} culled, ${stats.casters} casters, ${stats.tracersDrawn} tracers, ${stats.pieces} pieces` : 'no stats'}${errors.length ? ` · ERRORS ${errors.slice(0, 2).join(' | ')}` : ''}`);
    }
    problems += errors.length;
    await ctx.close();
  }
  if (opt('--sheet')) await sheetOf(browser, rows, `gf-forge lookdev · ${record.chrome} · WebGPU · ${W}×${H}`, join(out, opt('--sheet')), Number(opt('--cols', 3)));
} finally { await browser.close(); await srv.close(); }
writeFileSync(join(out, 'shots.json'), JSON.stringify(record, null, 2) + '\n');
process.exitCode = problems ? 1 : 0;
