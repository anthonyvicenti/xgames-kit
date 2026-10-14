#!/usr/bin/env node
// creature-film: film creature bodies (worm, blob, quadruped, flyer; kit/character/CREATURES.md) through every action
// on the creature bench (runtimes/three/character-bench/creatures.html, real GPU), and lay the frames out as a strip:
// one row a moment (idle, walk, run, jump, act, hit, a knock and the get-up, celebrate), the bodies side by side. Also an
// animated WebP of the whole timeline. A person (or a vision model) looks at it: the creature judge measures, this shows.
//
//   node builder/tools/creature-film.mjs <body.glb> [...] --out <dir> [--every 0.1] [--size 960x420] [--names a,b,c]
//   → <dir>/strip.jpg (the moments), <dir>/film.webp (every frame), <dir>/frames/*.png, <dir>/film.json
import { isMain } from './lib/main.mjs';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { launchChrome } from '../qa/browser.mjs';
import { GF3, importPart } from './lib/paths.mjs';
import { sharp } from './lib/char-deps.mjs';

/** The moments of the film timeline a strip shows: [seconds, what]. */
export const MOMENTS = [[0.8, 'idle'], [1.9, 'walk'], [2.25, 'walk'], [4.2, 'run'], [5.15, 'jump: take-off'], [5.45, 'jump: in the air'], [5.95, 'land'],
  [6.38, 'act: wind-up'], [6.55, 'act: strike'], [7.1, 'hit'], [8.55, 'knocked: tumbling'], [9.6, 'down'], [10.6, 'getting up'], [11.6, 'celebrate'], [12.3, 'celebrate']];
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export async function filmCreatures(files, { out, every = 0.1, size = [960, 420], names = null, seconds = 13 } = {}) {
  mkdirSync(join(out, 'frames'), { recursive: true });
  const { serve } = await importPart(join(GF3, 'character-bench/serve.mjs'), 'the character bench, which serves the creature bench');
  const server = await serve(0), port = server.address().port;
  const browser = await launchChrome({ gpu: 'webgl' });
  const bodies = files.map((f, i) => ({ id: (names?.[i] ?? basename(f, '.glb')).replace(/[^a-z0-9_-]/gi, '-'), name: names?.[i] ?? basename(f, '.glb'), url: `data:model/gltf-binary;base64,${readFileSync(f).toString('base64')}` }));
  const frames = [], strip = [];
  try {
    const page = await browser.newPage({ viewport: { width: size[0], height: size[1] } });
    const logs = [];
    page.on('console', m => { if (m.type() === 'error') logs.push(m.text()); });
    await page.addInitScript(b => { window.__CREATURE_BODIES = b; }, bodies);
    await page.goto(`http://127.0.0.1:${port}/character-bench/creatures.html?script=film&manual&clean`);
    await page.waitForFunction(() => window.__bench?.ready || window.__bench?.errors?.length, null, { timeout: 120000 });
    const errs = await page.evaluate(() => window.__bench.errors);
    if (errs.length) throw new Error(`the bench failed: ${errs.join('; ')}`);
    const info = await page.evaluate(() => window.__bench.info());
    let t = 0, k = 0;
    const want = [...MOMENTS];
    while (t < seconds) {
      const step = Math.min(every, want.length && want[0][0] > t ? want[0][0] - t : every);
      t = await page.evaluate(s => window.__bench.advance(s), step);
      const label = await page.evaluate(() => window.__bench.label);
      const png = await page.screenshot({ type: 'png' });
      const f = join(out, 'frames', `${String(k++).padStart(4, '0')}.png`);
      writeFileSync(f, png); frames.push({ t: +t.toFixed(2), file: f, label });
      if (want.length && Math.abs(want[0][0] - t) < 0.02) { strip.push({ t: +t.toFixed(2), what: want[0][1], png }); want.shift(); }
    }
    // the strip: moments in rows of three, each labelled
    const tw = Math.round(size[0] / 2), th = Math.round(size[1] / 2), cols = 3, rows = Math.ceil(strip.length / cols), pad = 26;
    const tiles = await Promise.all(strip.map(async (s, i) => {
      const img = await sharp(s.png).resize(tw, th).toBuffer();
      const label = Buffer.from(`<svg width="${tw}" height="${pad}"><rect width="100%" height="100%" fill="#1d2230"/><text x="8" y="18" font-family="sans-serif" font-size="14" fill="#fff">${esc(`${s.t.toFixed(2)} s  ${s.what}`)}</text></svg>`);
      return [{ input: label, left: (i % cols) * tw, top: Math.floor(i / cols) * (th + pad) }, { input: img, left: (i % cols) * tw, top: Math.floor(i / cols) * (th + pad) + pad }];
    }));
    await sharp({ create: { width: tw * cols, height: rows * (th + pad), channels: 3, background: '#ffffff' } }).composite(tiles.flat()).jpeg({ quality: 86 }).toFile(join(out, 'strip.jpg'));
    // every frame as one animated WebP (sharp joins pages)
    let webp = null;
    try {
      const small = await Promise.all(frames.map(f => sharp(f.file).resize(Math.round(size[0] * 0.6)).png().toBuffer()));
      await sharp(small, { join: { animated: true } }).webp({ quality: 70, delay: Math.round(every * 1000), loop: 0 }).toFile(join(out, 'film.webp'));
      webp = join(out, 'film.webp');
    } catch (e) { webp = `not made: ${e.message}`; }
    const record = { bodies: info, every, seconds, frames: frames.length, strip: join(out, 'strip.jpg'), webp, moments: strip.map(s => ({ t: s.t, what: s.what })), consoleErrors: logs.slice(0, 10) };
    writeFileSync(join(out, 'film.json'), JSON.stringify(record, null, 1) + '\n');
    return record;
  } finally { await browser.close().catch(() => {}); server.close(); }
}

if (isMain(import.meta)) {
  const args = process.argv.slice(2);
  const opt = n => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
  const files = args.filter((a, i) => !a.startsWith('--') && !['--out', '--every', '--size', '--names'].includes(args[i - 1]));
  if (!files.length || !opt('--out')) { console.error('usage: creature-film.mjs <body.glb> [...] --out <dir> [--every 0.1] [--size 960x420] [--names a,b]'); process.exit(2); }
  const r = await filmCreatures(files.map(f => resolve(f)), { out: resolve(opt('--out')), every: +(opt('--every') ?? 0.1), size: (opt('--size') ?? '960x420').split('x').map(Number), names: opt('--names')?.split(',') ?? null });
  console.log(JSON.stringify({ strip: r.strip, webp: r.webp, frames: r.frames, bodies: r.bodies, consoleErrors: r.consoleErrors }, null, 1));
}
