// verify measure 23 (gate F, "matches the spec"): the game looks like its style target. The reference look judge
// (builder/look/judge.mjs) scores the game against the locked spec's look.target and its reference frames, measured
// (palette, value, saturation, edges, proportions) and judged (a pairwise vision judge on a fixed rubric), 0–100.
//
//   const r = await checkLook('<game>', { shots, refs });   // → { ok, skipped, detail, record, notes }
//
// Why here and not a gate of its own (builder/GATES.md): a target that rests on reference frames is a promise the
// locked spec makes about the look, so "does the game look like it" is gate F's question, as world size or hits per kill
// are. It replaced the old reference-likeness judge (23 in the judges' row, advisory: the roguelike miss, 2026-10-08,
// "The game also doesn't have the right vibe at all"), with no new number and no new gate.
//
// When it holds: the target rests on frames (`look.target.from` 'refs' or 'refs+words', with frames on this machine or
// the measured numbers the target carries). It fails below the bar (judge.mjs BAR, 55 of 100: calibrated on a known pair,
// builder/look/evidence/calibration-hollow-reach-2026-10-14.json) and its detail names the findings to fix. A target
// from words only is advisory: it is scored and its findings recorded, and it never fails. No target and no reference
// frames: it passes as "no look target".
//
// Where the frames are (the legal line: reference frames stay local, never in a game): look.refs by sha256 through
// builder/look/refs.mjs when this checkout has it, the creator's attached style pictures (spec.references with use
// "style", their files in refs.json beside the game: a Studio job), or --refs (a folder with refs.json, or a
// gf-look-refs/1 manifest). A three standard-3d game is rendered live at the target's framings and the sheet's; any
// other runtime is judged from the shots verify took of it.
import { existsSync } from 'node:fs';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { walk, below } from './paths.mjs';

const readJson = async p => JSON.parse(await readFile(p, 'utf8'));
const readJsonMaybe = async p => { try { return await readJson(p); } catch { return null; } };
const sha = b => createHash('sha256').update(b).digest('hex');
const IMAGE = /\.(png|jpe?g|webp)$/i;

/**
 * The target and its frames. → { target, refs: [{ file, frame?, framing?, sha256? }], from: [where they came from], why }
 */
export async function lookInputs(gameDir, { refs = null } = {}) {
  const dir = resolve(gameDir);
  const spec = (await readJsonMaybe(join(dir, 'spec.json'))) ?? {};
  const target = spec.look?.target ?? null;
  const out = [], from = [];
  // (1) look.refs by sha256 (builder/look/refs.mjs: the machine's local reference folders)
  if (Array.isArray(spec.look?.refs) && spec.look.refs.length) {
    const mod = await import('../../look/refs.mjs').catch(() => null);
    if (mod?.findRefs) {
      const found = (await mod.findRefs(spec.look.refs).catch(() => [])) ?? [];
      const frames = Array.isArray(found) ? found : found.frames ?? [];
      for (const f of frames) if (f?.file && existsSync(f.file)) out.push({ file: f.file, frame: f.frame ?? null, sha256: f.sha256 ?? null });
      if (frames.length) from.push(`look.refs (${frames.length} of ${spec.look.refs.length} on this machine)`);
    }
  }
  // (2) the creator's attached style pictures (a Studio job: refs.json beside the game, or --refs <folder>)
  const style = (spec.references ?? []).filter(r => r && r.revisionId && (r.kind ?? 'image') === 'image' && r.use === 'style');
  const refsDir = refs ? resolve(refs) : dirname(dir);
  if (style.length) {
    const record = await readJsonMaybe(join(refsDir, 'refs.json'));
    const files = [...(record?.files ?? []), ...(record?.fromSpec ?? [])];
    let n = 0;
    for (const w of style) {
      const f = files.find(x => x.revisionId === w.revisionId && (x.kind ?? 'image') === 'image');
      const abs = f?.file ? resolve(refsDir, f.file) : null;
      if (abs && below(refsDir, abs) && existsSync(abs) && IMAGE.test(abs)) { out.push({ file: abs, frame: null, label: f.label ?? null }); n++; }
    }
    if (n) from.push(`the creator's ${n} style picture${n === 1 ? '' : 's'}`);
  }
  // (3) --refs as a gf-look-refs/1 manifest (a file, or a folder holding manifest.json)
  if (refs) {
    const manifest = refs.endsWith('.json') && !refs.endsWith('refs.json') ? resolve(refs) : join(refsDir, 'manifest.json');
    const m = await readJsonMaybe(manifest);
    if (Array.isArray(m?.frames)) {
      for (const f of m.frames) { const abs = resolve(dirname(manifest), f.file); if (existsSync(abs) && IMAGE.test(abs)) out.push({ file: abs, frame: f.frame ?? null, framing: f.framing ?? null, crop: f.crop ?? null, sha256: f.sha256 ?? null }); }
      from.push(`--refs ${basename(manifest)} (${m.frames.length})`);
    }
  }
  const why = !target && !out.length ? 'the locked spec has no look target and the game has no reference frames' : null;
  return { target, refs: out, from, why };
}

/** The key a judged verdict is kept under: the game's files (its evidence and .verify aside), the frames, the target. */
export async function lookKey(gameDir, inputs, extra = '') {
  const dir = resolve(gameDir), lines = [];
  for (const rel of await walk(dir, { skip: rel => /^(evidence|\.verify)(\/|$)/.test(rel) })) lines.push(`${sha(await readFile(join(dir, rel)))} ${rel}`);
  for (const r of inputs.refs) lines.push(`${r.sha256 ?? sha(await readFile(r.file))} ref ${JSON.stringify(r.crop ?? null)}`);
  lines.push(`target ${JSON.stringify(inputs.target ?? null)}`, extra);
  return sha(Buffer.from(lines.join('\n')));
}

const placeOf = spec => ({ runtime: spec?.runtime ?? 'three', profile: spec?.profile ?? 'standard-3d' });

/**
 * Measure 23. shots: the game's own screenshots (used when the game is not rendered live). `score` replaces the judge
 * (tests). → { ok, skipped, detail, record, notes }
 */
export async function checkLook(gameDir, { shots = [], refs = null, score = null, vision = process.env.GF_LOOK_VISION !== '0', cache = process.env.GF_LOOK_CACHE !== '0' } = {}) {
  const dir = resolve(gameDir), notes = [];
  const inputs = await lookInputs(dir, { refs });
  if (inputs.why) return { ok: true, skipped: true, detail: `no look target: ${inputs.why}`, record: { judged: false, why: inputs.why }, notes };
  const judge = await import('../../look/judge.mjs');
  const spec = await readJsonMaybe(join(dir, 'spec.json'));
  const place = placeOf(spec);
  const live = place.runtime === 'three' && place.profile === 'standard-3d';
  const usable = shots.filter(s => s && existsSync(s));
  if (!live && !usable.length) return { ok: false, skipped: false, detail: 'the spec has a look target, but verify took no screenshot of the game to hold to it (the round did not start)', record: { judged: false, error: 'no shots' }, notes };
  // the same files, frames and target as a judged verdict kept earlier: that verdict stands (a vision judge's look costs
  // a minute and a little money; nothing it looked at has changed)
  const outDir = join(dir, '.verify', 'look');
  const key = cache ? await lookKey(dir, inputs, `vision ${vision} judge ${judge.BAR.refs} ${JSON.stringify(judge.GATE)} ${JSON.stringify(judge.NOISE)}`) : null;
  const kept = cache ? await readJsonMaybe(join(outDir, 'verdict-cache.json')) : null;
  if (kept?.key === key && kept.result) {
    notes.push('look (measure 23): the game files, frames and target are the same as when it was judged; that verdict is kept');
    return verdictOf(kept.result, inputs, notes, { reused: true });
  }
  const run = score ?? judge.score;
  const game = live ? dir : { frames: usable.map((f, i) => ({ file: f, framing: `shot-${i + 1}` })) };
  let result;
  try { result = await run(game, inputs.target, inputs.refs, { vision, outDir, name: basename(dir), passes: judge.GATE.passes, blend: judge.GATE.blend }); }
  catch (e) { return { ok: false, skipped: false, detail: `the look judge could not run: ${String(e.message).split('\n')[0].slice(0, 300)}`, record: { judged: false, error: String(e.message).slice(0, 500) }, notes }; }
  if (result.vision?.error) notes.push(`look (measure 23): the vision judge could not run (${result.vision.error.slice(0, 160)}); the score is measured only`);
  if (cache) { await mkdir(outDir, { recursive: true }); await writeFile(join(outDir, 'verdict-cache.json'), JSON.stringify({ key, result }, null, 1) + '\n'); }
  return verdictOf(result, inputs, notes);
}

function verdictOf(result, inputs, notes, { reused = false } = {}) {
  const top = result.findings.slice(0, 5).map(f => `${f.framing ? `${f.framing}: ` : ''}${f.line}`);
  const iv = result.interval && result.interval[0] !== result.interval[1] ? `, ${result.interval[0]}–${result.interval[1]} over ${result.passes} judge pass${result.passes === 1 ? '' : 'es'}` : '';
  const head = result.score === null ? `no score: ${result.why}` : `${result.score}/100 like its look target${iv} (${result.confidence === 'refs' ? `held to ${inputs.refs.length ? `${inputs.refs.length} reference frame${inputs.refs.length === 1 ? '' : 's'}` : 'the target\'s measured numbers'}; needs ${result.bar}` : 'a target from words: advisory'})`;
  // fails only when the whole interval is below the bar; a game whose interval holds the bar is unsure: advisory, said,
  // never a fail (the judge's own noise must not decide a gate)
  const ok = result.advisory || result.score === null ? true : result.verdict !== 'fail';
  if (result.verdict === 'unsure') notes.push(`look (measure 23): unsure: ${result.score} with the bar ${result.bar} inside its interval (${result.interval.join('–')}); advisory, not a fail`);
  const detail = ok ? `${result.verdict === 'unsure' ? 'unsure (advisory): ' : ''}${head}${top.length ? `; closer still: ${top.slice(0, 3).join('; ')}` : ''}` : `${head}. ${top.join('; ')}. Tune the look first (node builder/look/tune.mjs <game>: light, sky, fog, grade, outlines, materials), then replace the art the levers cannot reach; node builder/tools/verify.mjs <game> --check 23 runs this alone`;
  return { ok, skipped: false, detail, notes, record: { judged: true, ...(reused ? { reused: true } : {}), score: result.score, verdict: result.verdict ?? null, interval: result.interval ?? null, passes: result.passes ?? null, bar: result.bar, advisory: result.advisory, confidence: result.confidence,
    parts: result.parts, framings: (result.framings ?? []).map(f => ({ framing: f.framing, ours: f.ours?.framing, ref: f.ref?.file ?? 'target', score: f.score, measured: f.measured, judged: f.judged })),
    findings: result.findings.slice(0, 12), change: result.change ?? [], vision: result.vision ?? null, from: inputs.from } };
}
