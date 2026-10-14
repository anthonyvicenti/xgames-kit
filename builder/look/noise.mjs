#!/usr/bin/env node
// How much the look judge's score moves when nothing changes (the parent, 2026-10-14: a bar at 55 inside ±8 of
// run-to-run noise passes or fails the same game at random). Scores one unchanged game N times and reports the
// distribution of the measured part (stats.mjs: deterministic on the same frames) and the judged part (the vision
// model's) separately, and of the whole.
//
//   node builder/look/noise.mjs <game-dir> --refs <manifest.json> [--target <target.json>] [--n 10] [--out <file.json>]
//        [--render-each]   render the game again for every score (the frames' own variation, measured part only;
//                          with --with-vision, the judge too: the whole run-to-run variation, as verify sees it)
//
// Default: the game is rendered once and the same frames are scored N times (the judge's variation alone).
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve, basename } from 'node:path';
import { score, readManifest, prepareFrames, privateDir } from './judge.mjs';
import { openPixels } from './pixels.mjs';
import { isMain } from '../tools/lib/main.mjs';

/** mean, standard deviation (n − 1), min, max, and the standard error of the mean. */
export function spreadOf(xs) {
  const v = xs.filter(x => typeof x === 'number');
  if (!v.length) return null;
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  const sd = v.length > 1 ? Math.sqrt(v.reduce((a, x) => a + (x - mean) ** 2, 0) / (v.length - 1)) : 0;
  const r = x => Math.round(x * 100) / 100;
  return { n: v.length, mean: r(mean), sd: r(sd), min: r(Math.min(...v)), max: r(Math.max(...v)), range: r(Math.max(...v) - Math.min(...v)), se: r(sd / Math.sqrt(v.length)) };
}

export async function noise(dir, target, refs, { n = 10, renderEach = false, vision = true, visionEach = false, log = console.log, scoreOpts = {} } = {}) {
  dir = resolve(dir);
  const px = await openPixels();
  const { openGame } = await import('./render.mjs');
  const g = await openGame(dir, { log });
  const runs = [];
  try {
    const refsPrepared = await prepareFrames(refs, px, join(privateDir(basename(dir)), 'noise-refs'), { ref: true });
    let fixed = null;
    if (!renderEach) {
      // render once (not counted): every run then scores these very frames, so what moves is the judge alone
      // the frames as the live judge takes them (the target's frame kinds and the placed settings kept, so the pairing is
      // the live one's)
      const { framingsOf } = await import('./render.mjs');
      const { settingsOf } = await import('./settings.mjs');
      const settings = [...new Set((await settingsOf(refsPrepared)).map(r => r.setting))];
      const shot = await g.frames(framingsOf(target, { settings }), join(dir, '.verify', 'look-noise', 'frames-run'));
      fixed = shot.map(f => ({ file: f.file, framing: f.framing, frame: f.frame, where: f.where, placed: f.placed, bodies: f.bodies }));
    }
    for (let i = 0; i < n; i++) {
      const t0 = Date.now();
      const opts = { px, session: g, refsPrepared, sheet: false, name: `${basename(dir)}-noise`, outDir: join(dir, '.verify', 'look-noise', String(i + 1)), log: () => {}, ...scoreOpts };
      const r = await score(renderEach ? dir : { frames: fixed }, target, refs, { ...opts, vision: renderEach ? visionEach : vision });
      runs.push({ i: i + 1, score: r.score, exact: r.halves ? r.score : null, measured: r.halves?.measured ?? null, judged: r.halves?.judged ?? null, bySetting: Object.fromEntries(Object.entries(r.settings ?? {}).map(([k, v]) => [k, v.score])), seconds: Math.round((Date.now() - t0) / 100) / 10, cost: r.vision?.cost ?? null });
      log(`  ${i + 1}/${n}: ${r.score} (measured ${runs.at(-1).measured?.toFixed(1)}, judged ${runs.at(-1).judged?.toFixed(1) ?? '—'}) ${runs.at(-1).seconds} s`);
    }
  } finally { await g.close(); await px.close(); }
  return { game: basename(dir), n, renderEach, visionEach, runs, score: spreadOf(runs.map(r => r.score)), measured: spreadOf(runs.map(r => r.measured)), judged: spreadOf(runs.map(r => r.judged)),
    seconds: spreadOf(runs.map(r => r.seconds)), cost: spreadOf(runs.map(r => r.cost)) };
}

if (isMain(import.meta)) {
  const a = process.argv.slice(2), opt = k => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : null; };
  const VALUED = new Set(['--refs', '--target', '--n', '--out']);
  const dir = a.find((x, i) => !x.startsWith('--') && !VALUED.has(a[i - 1]));
  if (!dir || !opt('--refs')) { console.error('usage: noise.mjs <game-dir> --refs <manifest.json> [--target <target.json>] [--n 10] [--render-each] [--out <file.json>]'); process.exit(2); }
  const target = opt('--target') ? JSON.parse(await readFile(opt('--target'), 'utf8')) : null;
  const r = await noise(dir, target, await readManifest(opt('--refs')), { n: Number(opt('--n') ?? 10), renderEach: a.includes('--render-each'), visionEach: a.includes('--with-vision') });
  console.log(JSON.stringify({ score: r.score, measured: r.measured, judged: r.judged, seconds: r.seconds, cost: r.cost }));
  if (opt('--out')) { await mkdir(dirname(resolve(opt('--out'))), { recursive: true }); await writeFile(opt('--out'), JSON.stringify(r, null, 1) + '\n'); }
}
