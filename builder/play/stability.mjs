#!/usr/bin/env node
// Does the play judge's verdict depend on the game, not on its luck? (builder/play/JUDGE.md; the look judge learnt it:
// an unchanged game's score moved across the bar from call to call.) Judges one unchanged game N times, each time from
// a fresh play (the bots, the scripted player and the friends round) and fresh vision passes, as verify's measure 6
// does, and reports how often the verdict agreed, and the spread of the measured half, the judged half and the whole.
//
//   node builder/play/stability.mjs <game> [--n 10] [--out <file.json>] [--no-vision]
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { score } from './judge.mjs';
import { isMain } from '../tools/lib/main.mjs';

export function spreadOf(xs) {
  const v = xs.filter(x => typeof x === 'number' && Number.isFinite(x));
  if (!v.length) return null;
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  const sd = v.length > 1 ? Math.sqrt(v.reduce((a, x) => a + (x - mean) ** 2, 0) / (v.length - 1)) : 0;
  const r = x => Math.round(x * 100) / 100;
  return { n: v.length, mean: r(mean), sd: r(sd), min: r(Math.min(...v)), max: r(Math.max(...v)) };
}

/** The verdicts' agreement: the most common verdict and how many runs gave it. */
export function agreementOf(verdicts) {
  const n = new Map(); for (const v of verdicts) n.set(v, (n.get(v) ?? 0) + 1);
  const [verdict, count] = [...n].sort((a, b) => b[1] - a[1])[0] ?? [null, 0];
  return { verdict, agree: count, of: verdicts.length, all: Object.fromEntries(n) };
}

export async function stability(dir, { n = 10, vision = true, log = console.log, scoreOpts = {} } = {}) {
  dir = resolve(dir);
  const runs = [];
  for (let i = 0; i < n; i++) {
    const t0 = Date.now();
    const r = await score(dir, undefined, { vision, outDir: join(tmpdir(), `gf-play-stability-${basename(dir)}-${process.pid}`, String(i + 1)), ...scoreOpts });
    runs.push({ i: i + 1, verdict: r.verdict, score: r.score, interval: r.interval, measured: r.parts.measured?.score ?? null, judged: r.parts.judged?.score ?? null, judgedPasses: r.parts.judged ? r.vision?.passes ?? null : null,
      hard: r.hard.map(h => h.line), events: r.numbers.eventsPerMinute, objectives: r.numbers.objectives, seconds: Math.round((Date.now() - t0) / 1000), cost: r.vision?.cost ?? null });
    log(`  ${basename(dir)} ${i + 1}/${n}: ${r.verdict} ${r.score} (measured ${runs.at(-1).measured}, judged ${runs.at(-1).judged ?? '—'}) ${runs.at(-1).seconds} s${r.hard.length ? ` · ${r.hard[0].line.slice(0, 90)}` : ''}`);
  }
  return { game: basename(dir), n, vision, agreement: agreementOf(runs.map(r => r.verdict)), score: spreadOf(runs.map(r => r.score)), measured: spreadOf(runs.map(r => r.measured)), judged: spreadOf(runs.map(r => r.judged)),
    seconds: spreadOf(runs.map(r => r.seconds)), cost: spreadOf(runs.map(r => r.cost)), runs };
}

if (isMain(import.meta)) {
  const a = process.argv.slice(2), opt = k => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : null; };
  const game = a.find((x, i) => !x.startsWith('--') && !['--n', '--out'].includes(a[i - 1]));
  if (!game) { console.error('usage: node builder/play/stability.mjs <game> [--n 10] [--out file.json] [--no-vision]'); process.exit(2); }
  const r = await stability(game, { n: Number(opt('--n') ?? 10), vision: !a.includes('--no-vision') });
  const out = opt('--out');
  if (out) { await mkdir(dirname(resolve(out)), { recursive: true }); await writeFile(resolve(out), JSON.stringify(r, null, 1) + '\n'); }
  console.log(`${r.game}: ${r.agreement.verdict} in ${r.agreement.agree} of ${r.agreement.of}; score ${r.score?.mean} ± ${r.score?.sd} (${r.score?.min}–${r.score?.max}); measured sd ${r.measured?.sd}, judged sd ${r.judged?.sd}`);
}
