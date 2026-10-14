#!/usr/bin/env node
// Calibrate the look judge on a pair whose answer is known: reference frames, and our game at several states that a
// person has already ranked against them. The judge must rank the states as the person did, and its per-framing
// verdicts must agree with the person's read.
//
//   node builder/look/calibrate.mjs <calibration.json> [--no-vision] [--record <file.json>]
//
// calibration.json (local, beside its frames; the frames never enter a repository):
//   { "name", "refs": "<manifest>", "states": [{ "name", "frames": "<manifest>", "note" }],
//     "expect": { "order": ["before", …, "after"],                       // worst to best, by score
//                 "said": "<the person's words>", "claims": [ … ] } }        // checkCalibration below
// The record keeps names, hashes and numbers only (no frames, no paths outside the calibration's own folder).
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve, basename } from 'node:path';
import { score, compare, readManifest, prepareFrames, privateDir } from './judge.mjs';
import { openPixels } from './pixels.mjs';
import { SCALES } from './stats.mjs';
import { isMain } from '../tools/lib/main.mjs';

/** The judge's "vs" for a framing, by majority over the parts it marked. */
export function majorityVs(parts) {
  const n = { worse: 0, par: 0, better: 0 };
  for (const p of Object.values(parts ?? {})) if (p?.vs) n[p.vs]++;
  const top = Object.entries(n).sort((a, b) => b[1] - a[1])[0];
  return top[1] ? { vs: top[0], counts: n } : { vs: null, counts: n };
}

/**
 * The checks (pure): the order holds, and each claim of the person's read holds. A claim is one of
 *   { state, framing, vs: ['par', 'better'] }          the judge's majority "vs" at that framing is one of these
 *   { state, framing, part, vs: 'worse', words? }     that part is marked so (and its finding says the words, a pattern)
 *   { framing, above: ['mid', 'after'] }               the second state's framing scores above the first's
 *   { above: ['C', 'B'] }                              the second state scores above the first, whole
 */
export function checkCalibration(results, expect) {
  const out = [];
  const order = expect?.order ?? [];
  for (let i = 1; i < order.length; i++) {
    const a = results[order[i - 1]], b = results[order[i]];
    out.push({ check: `${order[i]} scores above ${order[i - 1]}`, ok: !!a && !!b && b.score > a.score, detail: `${b?.score} against ${a?.score}` });
  }
  const said = expect?.said ? ` ("${expect.said}")` : '';
  for (const c of expect?.claims ?? []) {
    if (c.above && !c.framing) {
      const [lo, hi] = c.above.map(st => results[st]);
      out.push({ check: `${c.above[1]} above ${c.above[0]}${said}`, ok: !!lo && !!hi && hi.score > lo.score, detail: `${hi?.score} against ${lo?.score}` });
      continue;
    }
    if (c.above) {
      const [lo, hi] = c.above.map(st => results[st]?.framings.find(f => f.framing === c.framing));
      out.push({ check: `${c.framing}: ${c.above[1]} above ${c.above[0]}${said}`, ok: !!lo && !!hi && hi.score > lo.score, detail: `${hi?.score} against ${lo?.score}` });
      continue;
    }
    const f = results[c.state]?.framings.find(x => x.framing === c.framing);
    if (!f?.judgedParts) { out.push({ check: `${c.state} ${c.framing}: the judge's read`, ok: null, detail: 'not judged (no vision run)' }); continue; }
    if (c.part) {
      const p = f.judgedParts[c.part];
      const ok = p?.vs === c.vs && (!c.words || new RegExp(c.words, 'i').test(p.finding));
      out.push({ check: `${c.state} ${c.framing} ${c.part}: ${c.vs}${c.words ? ` (/${c.words}/)` : ''}${said}`, ok, detail: p ? `${p.match}/4 ${p.vs}: ${p.finding}` : 'not marked' });
      continue;
    }
    const m = majorityVs(f.judgedParts);
    out.push({ check: `${c.state} ${c.framing}: ${c.vs.join(' or ')}${said}`, ok: c.vs.includes(m.vs), detail: `the judge: ${m.vs} (${Object.entries(m.counts).map(([k, v]) => `${k} ${v}`).join(', ')}); score ${f.score}` });
  }
  return out;
}

export async function calibrate(file, { vision = true, log = console.log } = {}) {
  const cal = JSON.parse(await readFile(file, 'utf8'));
  const base = dirname(resolve(file));
  const px = await openPixels();
  try {
    const refsList = await readManifest(join(base, cal.refs));
    const tmp = privateDir(`calibration-${cal.name}`);
    const refsPrepared = await prepareFrames(refsList, px, join(tmp, 'refs'), { ref: true });
    // the target: inline, or a file beside the calibration (its reads weigh the judged parts)
    const target = typeof cal.target === 'string' ? JSON.parse(await readFile(join(base, cal.target), 'utf8')) : cal.target ?? null;
    const results = {};
    // looks of one game (options): judged side by side (judge.mjs compare), each also scored alone for its framings
    let side = null;
    if (cal.compare) {
      const looks = [];
      for (const st of cal.states) looks.push({ id: st.name, game: { frames: await readManifest(join(base, st.frames)) } });
      side = await compare(looks, target, refsList, { vision, px, refsPrepared, log });
      log(`  side by side: ${side.ranking.map(id => `${id} ${side.looks[id].score} (measured ${side.looks[id].measured}, judged ${side.looks[id].judged})`).join(', ')}; the judge's own ranking ${side.judgeRanking?.join(' > ') ?? '—'}`);
    }
    for (const st of cal.states) {
      const frames = await readManifest(join(base, st.frames));
      log(`  ${st.name}: ${frames.length} frames`);
      results[st.name] = await score({ frames }, target, refsList, { vision: vision && !side, px, refsPrepared, name: `${cal.name}-${st.name}`, sheetDir: join(tmp, st.name), log });
      if (side) Object.assign(results[st.name], { score: side.looks[st.name].score, alone: results[st.name].score, side: side.looks[st.name] });
      log(`  ${st.name}: ${results[st.name].score}/100 (${results[st.name].framings.map(f => `${f.framing} ${f.score}`).join(', ')})`);
    }
    const checks = checkCalibration(results, cal.expect);
    const record = {
      tool: 'builder/look/calibrate.mjs', name: cal.name, at: new Date().toISOString(), vision, scales: SCALES,
      refs: refsPrepared.map(r => ({ file: basename(r.source), framing: r.framing ?? null, sha256: r.sha256, crop: r.crop ?? null })),
      states: Object.fromEntries(cal.states.map(st => [st.name, { note: st.note ?? null, score: results[st.name].score, parts: results[st.name].parts, vision: results[st.name].vision,
        framings: results[st.name].framings.map(f => ({ framing: f.framing, ours: f.ours.framing, score: f.score, measured: f.measured, judged: f.judged, measuredParts: f.measuredParts, judgedParts: f.judgedParts ?? null, vs: f.judgedParts ? majorityVs(f.judgedParts) : null,
          findings: f.judgedParts ? Object.fromEntries(Object.entries(f.judgedParts).filter(([, p]) => p.match !== null).map(([k, p]) => [k, `${p.match}/4 ${p.vs}: ${p.finding}`])) : null })),
        findings: results[st.name].findings.slice(0, 8).map(f => `${f.framing}: ${f.line}`), sheet: results[st.name].sheet ? basename(results[st.name].sheet) : null }])),
      ...(side ? { sideBySide: { ranking: side.ranking, judgeRanking: side.judgeRanking, summary: side.summary, partWeights: side.partWeights, vision: side.vision,
        looks: Object.fromEntries(Object.entries(side.looks).map(([id, l]) => [id, { score: l.score, measured: l.measured, judged: l.judged, judgedParts: l.parts.judged }])) } } : {}),
      expect: cal.expect, checks, ok: checks.every(c => c.ok !== false),
    };
    return { record, results };
  } finally { await px.close(); }
}

if (isMain(import.meta)) {
  const a = process.argv.slice(2), opt = k => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : null; };
  const file = a.find((x, i) => !x.startsWith('--') && a[i - 1] !== '--record');
  if (!file) { console.error('usage: calibrate.mjs <calibration.json> [--no-vision] [--record <file.json>]'); process.exit(2); }
  const { record } = await calibrate(file, { vision: !a.includes('--no-vision') });
  for (const c of record.checks) console.log(`${c.ok === true ? 'ok  ' : c.ok === false ? 'FAIL' : 'skip'} ${c.check}: ${c.detail}`);
  if (opt('--record')) { await mkdir(dirname(resolve(opt('--record'))), { recursive: true }); await writeFile(opt('--record'), JSON.stringify(record, null, 1) + '\n'); console.log(`record: ${opt('--record')}`); }
  process.exit(record.ok ? 0 : 1);
}
