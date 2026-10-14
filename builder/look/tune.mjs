#!/usr/bin/env node
// The look tuning loop (builder/look/README.md): move the cheap levers of a game's look (light, sky, fog, the colour
// grade, post effects, outlines, material parameters) toward its style target, live, until the score stops rising.
// It never changes play and never swaps assets: when the plateau is below the bar, it names the findings the levers
// cannot reach, for the ladder (a library swap first, then generation).
//
//   node builder/look/tune.mjs <game-dir> [--refs <manifest.json>] [--target <target.json>] [--out <dir>]
//                              [--rounds 6] [--evals 400] [--no-vision] [--write] [--json]
//
// The search is coordinate descent over LEVERS: each lever a step either way, kept when the measured score (judge.mjs's
// measured parts, every reference against our frame at the framing paired with it at the start) rises by MIN_GAIN; a
// round with no gain halves the steps; it stops at a plateau (a round that gains less than PLATEAU) or after --rounds.
// Colours move along a line toward the reference's own (its sky, its shadows, its highlights), one number a colour.
// The vision judge marks the look before and after (not each step: a step is a re-render and a measure, under a
// second). Writes <out>/look.json ({ values }: the spec's look.values), <out>/tune.json (every kept step, the scores,
// the ladder) and <out>/before-after.jpg (our frames only); --write also sets them in the game (spec.json look.values
// and config/look.json, over every time of day) when the whole score (measured and judged) rose. With no --target or
// --refs it reads the game's own: the locked spec's look.target and the frames measure 23 finds.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { score, readManifest, prepareFrames, pairUp, privateDir, BAR, confidenceOf, judgeStats, timeWeights, spread } from './judge.mjs';
import { judgeBeforeAfter as judgeBA } from './vision.mjs';
import { settingsOf } from './settings.mjs';
import { openGame, framingsOf } from './render.mjs';
import { openPixels } from './pixels.mjs';
import { compareStats, measuredMark, hexToOklab, oklabToHex } from './stats.mjs';
import { isMain } from '../tools/lib/main.mjs';

export const MIN_GAIN = 0.25, PLATEAU = 0.5;

/** The cheap levers of the three runtime's look (kit/look: presets' values). Numbers: [path, min, max, step]. */
export const NUMBER_LEVERS = [
  ['renderer.exposure', 0.4, 2.2, 0.15],
  ['sun.intensity', 0.3, 7, 0.5], ['sun.elevation', 8, 85, 10], ['sun.shadowStrength', 0, 1, 0.15], ['sun.shadowSoftness', 0.3, 5, 0.6],
  ['ambient.intensity', 0.05, 2, 0.15], ['ambient.envIntensity', 0, 2, 0.15],
  ['fog.near', 2, 400, 0.35, 'log'], ['fog.far', 15, 900, 0.35, 'log'],
  ['sky.brightness', 0.3, 1.8, 0.12],
  ['post.grade.contrast', 0.6, 1.6, 0.08], ['post.grade.saturation', 0.3, 2, 0.1], ['post.grade.vibrance', -0.4, 0.8, 0.1],
  ['post.grade.temperature', -0.5, 0.5, 0.08], ['post.grade.vignette', 0, 0.6, 0.08],
  ['post.outline.strength', 0, 1.6, 0.2], ['post.outline.thickness', 0.4, 3.2, 0.4],
  ['post.bloom.intensity', 0, 2.5, 0.2], ['post.bloom.threshold', 0.4, 2, 0.15],
  ['post.ao.intensity', 0, 4, 0.4],
  ['materials.character.saturation', 0.4, 1.8, 0.1], ['materials.prop.saturation', 0.4, 1.8, 0.1], ['materials.ground.saturation', 0.4, 1.8, 0.1],
  ['materials.character.rim', 0, 1, 0.12], ['materials.prop.shadowFloor', 0, 0.8, 0.1], ['materials.ground.shadowFloor', 0, 0.8, 0.1],
  ['materials.character.bands', 0, 4, 1, 'int'], ['materials.prop.bands', 0, 4, 1, 'int'],
];
/**
 * Colours: [name, [[path, anchor], …]] — each moves on a line from the game's colours toward the reference's anchors
 * (0 → 1), one number for the group: a sky is its dome, its haze and its fog together (one of them alone barely moves a
 * frame, and the search would never take it).
 */
export const COLOUR_LEVERS = [
  ['sky', [['sky.top', 'skyTop'], ['sky.horizon', 'skyHorizon'], ['sky.bottom', 'skyHorizon'], ['fog.color', 'skyHorizon']]],
  ['sky.top', [['sky.top', 'skyTop']]], ['fog.color', [['fog.color', 'skyHorizon']]],
  ['ambient', [['ambient.sky', 'skyTop'], ['ambient.ground', 'shadowLift']]],
  ['sun.color', [['sun.color', 'highlight']]],
  ['shade', [['post.outline.color', 'shadow'], ['post.ao.color', 'shadow']]],
];

const get = (o, path) => path.split('.').reduce((x, k) => (x == null ? undefined : x[k]), o);
function set(o, path, v) { const ks = path.split('.'); let x = o; for (const k of ks.slice(0, -1)) x = x[k] ??= {}; x[ks.at(-1)] = v; return o; }
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
// the medoid: the one colour closest to all the others (a mean of blue, violet and orange skies is grey; the medoid of
// mostly blue skies is a blue one)
const medoid = list => {
  if (!list.length) return null;
  let best = null, bd = Infinity;
  for (const a of list) { const d = list.reduce((s, b) => s + Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]), 0); if (d < bd) { bd = d; best = a; } }
  return [...best];
};

/** The colours the reference frames point at: their sky (frames whose upper third is light), shadows and highlights. */
export function anchorsOf(refsPrepared, target) {
  const st = refsPrepared.map(r => r.stats).filter(Boolean);
  const skies = st.map(s => s.regions?.top).filter(t => t?.lab && t.L > 0.45).map(t => t.lab);
  const shadows = st.map(s => s.tones?.shadow).filter(Boolean), highs = st.map(s => s.tones?.highlight).filter(Boolean);
  const out = {};
  let sky = medoid(skies);
  if (!sky && target?.regions?.sky?.colors?.[0]?.hex) sky = hexToOklab(target.regions.sky.colors[0].hex);
  if (sky) { out.skyTop = [Math.max(0.35, sky[0] - 0.06), sky[1] * 1.15, sky[2] * 1.15]; out.skyHorizon = [Math.min(0.97, sky[0] + 0.08), sky[1] * 0.8, sky[2] * 0.8]; }
  const sh = medoid(shadows);
  if (sh) { out.shadow = [Math.min(sh[0], 0.3), sh[1], sh[2]]; out.shadowLift = [0.62, sh[1] * 1.4, sh[2] * 1.4]; }
  const hi = medoid(highs);
  if (hi) out.highlight = [0.97, hi[1] * 0.6, hi[2] * 0.6];
  return out;
}

/**
 * The world's own light, where the runtime has it per setting (the voxel world: the cave's fill, lamps, spread, its
 * cool glow and its fog: worlds/voxel world.voxel.setLight). Tuned with the cave in view against cave references only.
 */
export const WORLD_LEVERS = {
  cave: {
    numbers: [['world.cave', 0, 0.5, 0.03], ['world.block', 0.4, 3, 0.2], ['world.spread', 0.8, 2.6, 0.2], ['world.caveLight.strength', 0, 0.8, 0.05]],
    colours: [['caveLight', [['world.caveLight.color', 'caveMid']]], ['caveFog', [['world.caveFog', 'caveShadow']]]],
  },
};
/** The cave references' own colours: their mid tones (the walls in their light) and their shadows. */
export function caveAnchorsOf(refs) {
  const mids = refs.map(r => r.stats?.regions?.rest?.lab).filter(Boolean), sh = refs.map(r => r.stats?.tones?.shadow).filter(Boolean);
  const m = medoid(mids), d = medoid(sh);
  return { ...(m ? { caveMid: [0.55, m[1] * 1.6, m[2] * 1.6] } : {}), ...(d ? { caveShadow: [Math.min(0.12, d[0]), d[1], d[2]] } : {}) };
}

/** The levers this game's look has (a path missing from its values is left alone). → [{ path, kind, … }] */
export function leversOf(values, anchors, { numbers = NUMBER_LEVERS, colours = COLOUR_LEVERS, group = 'look' } = {}) {
  const out = [];
  for (const [path, min, max, step, mode] of numbers) { const v = get(values, path); if (typeof v === 'number') out.push({ path, group, kind: 'number', min, max, step, mode: mode ?? 'lin', start: v }); }
  for (const [name, members] of colours) {
    const paths = members.map(([path, anchor]) => ({ path, anchor, v: get(values, path) })).filter(m => typeof m.v === 'string' && /^#[0-9a-f]{6}$/i.test(m.v) && anchors[m.anchor])
      .map(m => ({ path: m.path, from: hexToOklab(m.v), to: anchors[m.anchor] }));
    if (paths.length) out.push({ path: `colour:${name}`, group, kind: 'colour', paths, start: 0, min: 0, max: 1, step: 0.34 });
  }
  return out;
}

/** A lever's setting → the value it writes. */
export function leverValue(l, x) {
  if (l.kind === 'colour') return Math.round(x * 100) / 100;
  return l.mode === 'int' ? Math.round(x) : Math.round(x * 1000) / 1000;
}
/** One step of a lever from x, either way (dir ±1, scale: how far the steps were halved). */
export function stepLever(l, x, dir, scale = 1) {
  if (l.mode === 'log') return clamp(x * Math.exp(dir * l.step * scale), l.min, l.max);
  const s = l.mode === 'int' ? Math.max(1, Math.round(l.step * scale)) : l.step * scale;
  return clamp(x + dir * s, l.min, l.max);
}
/** The settings → the look values over the game's (only the levers that moved). */
export function overlayOf(levers, xs) {
  const o = {};
  for (const l of levers) {
    if (xs[l.path] === l.start) continue;
    if (l.kind === 'colour') for (const m of l.paths) set(o, m.path, oklabToHex(mix(m.from, m.to, xs[l.path])));
    else set(o, l.path, leverValue(l, xs[l.path]));
  }
  return o;
}

/**
 * Coordinate descent (pure over `evaluate`): evaluate(overlay) → a number (higher is better). → { best, xs, steps, evals }
 */
export async function descend(levers, evaluate, { rounds = 6, maxEvals = 400, generations = 4, brood = 12, log = () => {} } = {}) {
  const xs = Object.fromEntries(levers.map(l => [l.path, l.start]));
  let best = await evaluate({}), evals = 1, scale = 1;
  const steps = [{ round: 0, score: best }];
  for (let round = 1; round <= rounds && evals < maxEvals; round++) {
    const before = best;
    for (const l of levers) {
      if (evals >= maxEvals) break;
      for (const dir of [1, -1]) {
        let moved = false;
        for (let k = 0; k < 4 && evals < maxEvals; k++) {   // keep going the way that helps, a few steps
          const x = stepLever(l, xs[l.path], dir, scale);
          if (x === xs[l.path]) break;
          const trial = { ...xs, [l.path]: x };
          const s = await evaluate(overlayOf(levers, trial)); evals++;
          if (s > best + MIN_GAIN) { best = s; xs[l.path] = x; moved = true; steps.push({ round, lever: l.path, value: leverValue(l, x), score: Math.round(s * 10) / 10 }); }
          else break;
        }
        if (moved) break;
      }
    }
    log(`  tune round ${round}: ${Math.round(before * 10) / 10} → ${Math.round(best * 10) / 10} (${evals} renders${scale < 1 ? `, steps ×${scale}` : ''})`);
    if (best - before < PLATEAU) { if (scale <= 0.25) break; scale /= 2; }
  }
  // a small evolutionary search past the plateau: moves of several levers at once, which one lever at a time misses
  const rand = seeded(11);
  for (let gen = 1; gen <= generations && evals < maxEvals; gen++) {
    let improved = false;
    for (let k = 0; k < brood && evals < maxEvals; k++) {
      const trial = { ...xs };
      for (const l of pick(levers, 3, rand)) trial[l.path] = stepLever(l, trial[l.path], rand() < 0.5 ? -1 : 1, 0.5 + rand());
      const s = await evaluate(overlayOf(levers, trial)); evals++;
      if (s > best + MIN_GAIN) {
        const moved = levers.filter(l => trial[l.path] !== xs[l.path]);
        best = s; Object.assign(xs, trial); improved = true;
        steps.push({ round: `evolve ${gen}`, levers: Object.fromEntries(moved.map(l => [l.path, leverValue(l, trial[l.path])])), score: Math.round(s * 10) / 10 });
      }
    }
    log(`  tune evolve ${gen}: ${Math.round(best * 10) / 10} (${evals} renders)`);
    if (!improved) break;
  }
  return { best, xs, steps, evals };
}
const seeded = (seed) => { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
const pick = (list, n, rand) => { const a = [...list]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a.slice(0, n); };

/** The findings the levers cannot reach (the ladder's): new art, a library swap first, then generation. */
export function ladderOf(result, bar) {
  const art = result.findings.filter(f => f.reach === 'art');
  const left = result.findings.filter(f => f.reach === 'levers');
  const below = bar !== null && result.score < bar;
  return { needed: below, score: result.score, bar,
    art: art.map(f => ({ framing: f.framing, part: f.part, line: f.line })),
    leversLeft: left.slice(0, 6).map(f => ({ framing: f.framing, part: f.part, line: f.line })),
    next: below ? (art.length ? ['swap: the asset library first (gamesfun art coverage, by the target)', 'generate: then made art, from concept art written from the style target'] : ['the levers plateaued with only light and colour findings left: a specialist look round']) : [] };
}

/** Before and after, ours only (no reference frames, so it may live with the game). */
async function beforeAfter(px, pairs, beforeFiles, afterFiles, out, title) {
  const img = async f => `data:image/jpeg;base64,${(await px.extract(f, { maxWidth: 640, quality: 0.85 })).toString('base64')}`;
  const esc = v => String(v ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const rows = [];
  for (const [i, f] of beforeFiles.entries()) rows.push(`<div class=r><div><img src="${await img(f)}"><span>before · ${esc(pairs[i])}</span></div><div><img src="${await img(afterFiles[i])}"><span>after · ${esc(pairs[i])}</span></div></div>`);
  const html = `<!doctype html><meta charset=utf-8><style>body{margin:0;background:#15131a;color:#eee;font:14px system-ui,sans-serif;padding:14px;width:1300px}h1{font-size:19px;margin:0 0 10px}.r{display:grid;grid-template-columns:640px 640px;gap:10px;margin-bottom:10px}img{width:640px;display:block;border-radius:4px}span{opacity:.75}</style><h1>${esc(title)}</h1>${rows.join('')}`;
  const page = await px.browser.newPage({ viewport: { width: 1330, height: 400 }, deviceScaleFactor: 1 });
  try { await page.setContent(html, { waitUntil: 'load' }); await page.screenshot({ path: out, type: 'jpeg', quality: 85, fullPage: true }); return out; }
  finally { await page.close().catch(() => {}); }
}

/** Lay values over a config/look.json, over every time block too (as __gfLook.restyle does). */
export function overLook(look, values) {
  const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
  const over = (a, b) => { const o = { ...a }; for (const [k, v] of Object.entries(b)) o[k] = isObj(v) && isObj(o[k]) ? over(o[k], v) : v; return o; };
  const out = over(look, values);
  if (isObj(look.times)) out.times = Object.fromEntries(Object.entries(look.times).map(([t, b]) => [t, over(b ?? {}, values)]));
  return out;
}

/** Overlay → its look part and its world part ({ world: {...} } holds the world's light). */
const splitOverlay = o => { const { world = null, ...look } = o ?? {}; return { look, world }; };

/**
 * Tune like with like (the parent, 2026-10-14: a tuner scored against every reference at once pulled a daylight
 * overworld toward the cave frames Hollow Reach mostly has). Each reference and each of our frames has its setting
 * (settings.mjs: day, cave, night, close, ui); a setting is scored against its own references only.
 *  1. The look's levers (sky, sun, fog, grade, materials: they reach every setting) are tuned for the setting with the
 *     most game time (the player's own view), and a step is refused when any other setting's measured score falls.
 *  2. A setting's own levers (the voxel world's cave light) are tuned for that setting, under the same guard.
 *  3. The pairwise judge then looks at each setting before and after, side by side (judge.mjs compare), and vetoes the
 *     lever group that made a setting lose.
 * It never changes play or swaps assets. Writes look.json ({ values, world }), tune.json and before-after.jpg.
 */
export async function tune(dir, target, refs, { outDir, rounds = 6, maxEvals = 400, vision = true, write = false, guard = 1, classify = undefined, log = console.log } = {}) {
  dir = resolve(dir);
  const name = basename(dir);
  outDir = resolve(outDir ?? join(dir, '.verify', 'look-tune'));
  const priv = privateDir(name);
  await mkdir(outDir, { recursive: true });
  const px = await openPixels();
  const g = await openGame(dir, { log });
  const classifyOpts = { vision: classify !== null && process.env.GF_LOOK_SETTINGS !== '0', ...(classify ? { classifyFn: classify } : {}), log };
  try {
    let refsP = await prepareFrames(refs, px, join(priv, 'tmp-refs'), { ref: true });
    if (!refsP.length) throw new Error('tune compares like with like: it needs reference frames (a target from words alone has no settings to hold each to)');
    refsP = await settingsOf(refsP, classifyOpts);
    const refSettings = [...new Set(refsP.map(r => r.setting))];
    // ---- our frames: the sheet's and a place per setting the references show; each classified the same way ----
    const all = framingsOf(target, { settings: refSettings });
    const first = await g.frames(all, join(outDir, 'frames'), { prefix: 'start-' });
    let start = await prepareFrames(first.map(f => ({ file: f.file, framing: f.framing, frame: f.frame, where: f.where, placed: f.placed, bodies: f.bodies })), px, join(outDir, 'tmp'));
    start = await settingsOf(start, classifyOpts);
    const settingOf = Object.fromEntries(start.map(o => [o.framing, o.setting]));
    const paired = pairUp(refsP, start, { bySetting: true });
    const pairs = paired.filter(p => p.ours), missing = [...new Set(paired.filter(p => !p.ours).map(p => p.ref.setting))];
    const settings = [...new Set(pairs.map(p => p.ref.setting))];
    if (!settings.length) throw new Error(`no frame of ours shows a setting the references show (${refSettings.join(', ')})`);
    const weights = timeWeights(start);
    const main = settings.slice().sort((a, b) => (weights[b] ?? 1) - (weights[a] ?? 1) || pairs.filter(p => p.ref.setting === b).length - pairs.filter(p => p.ref.setting === a).length)[0];
    const used = [...new Set(pairs.map(p => p.ours.framing))];
    const framings = all.filter(f => used.includes(f.name));
    log(`  tune: settings ${settings.map(k => `${k} (${pairs.filter(p => p.ref.setting === k).length} refs, ours ${[...new Set(pairs.filter(p => p.ref.setting === k).map(p => p.ours.framing))].join('/')})`).join(', ')}; the most game time: ${main}${missing.length ? `; not shown by ours: ${missing.join(', ')}` : ''}`);
    // ---- the measured objective, per setting ----
    const worldStart = await g.page.evaluate(() => window.__gfLook.worldLight?.(null) ?? null);
    const apply = async overlay => {
      const { look, world } = splitOverlay(overlay);
      await g.restyle(Object.keys(look).length ? look : null);
      if (worldStart) await g.page.evaluate(w => window.__gfLook.worldLight(w), { ...worldStart, ...(world ?? {}), caveLight: { ...worldStart.caveLight, ...(world?.caveLight ?? {}) } });
    };
    const cache = new Map();
    const evaluate = async overlay => {
      const key = JSON.stringify(overlay);
      if (cache.has(key)) return cache.get(key);
      await apply(overlay);
      const fr = await g.frames(framings, join(outDir, 'frames'), { prefix: 'try-' });
      const stats = {};
      for (const f of fr) stats[f.framing] = judgeStats(await px.read(f.file));
      const per = {}, tone = {};
      for (const k of settings) {
        const ps = pairs.filter(p => p.ref.setting === k); per[k] = ps.reduce((a, p) => a + (measuredMark(compareStats(stats[p.ours.framing], p.ref.stats).parts) ?? 0), 0) / ps.length;
        tone[k] = toneOf(fr.filter(f => settingOf[f.framing] === k).map(f => stats[f.framing]));
      }
      const r = { per, tone };
      cache.set(key, r);
      return r;
    };
    const values = await g.values();
    // the look's levers move toward the main setting's own references (a daylight sky from daylight frames)
    const anchors = anchorsOf(refsP.filter(r => r.setting === main), target);
    const lookLevers = leversOf(values, anchors, { group: 'look' });
    const groups = [{ id: 'look', setting: main, levers: lookLevers }];
    for (const k of settings) if (WORLD_LEVERS[k] && worldStart) groups.push({ id: `world-${k}`, setting: k, levers: leversOf({ world: worldStart }, caveAnchorsOf(refsP.filter(r => r.setting === k)), { ...WORLD_LEVERS[k], group: `world-${k}` }) });
    const t0 = Date.now();
    const shoot = async (ov, tag) => { await apply(ov); return g.frames(framings, join(outDir, tag, 'frames')); };
    /** One setting's frames under two overlays, before against after, both orders (vision.mjs judgeBeforeAfter). */
    const judgeSetting = async (k, ovBefore, ovAfter, tag = 'check') => {
      const mine = framings.filter(f => settingOf[f.name] === k).map(f => f.name);
      const b = await shoot(ovBefore, `${tag}-before`), a = await shoot(ovAfter, `${tag}-after`);
      const files = list => list.filter(f => mine.includes(f.framing)).map(f => f.file);
      const refFiles = spread(refsP.filter(r => r.setting === k).map((r, i) => ({ id: String(i + 1), ref: r })), 6).map(p => p.ref.file);
      const verdicts = [];
      for (const seed of [1, 2]) {
        try { verdicts.push(await judgeBA(refFiles, files(b), files(a), { setting: k, reads: target?.reads ?? [], seed })); }
        catch (e) { log(`  tune: the before/after judge could not run for ${k}: ${e.message}`); }
      }
      // a preference counts when both orders hold it (the judge reads two near-identical looks differently from one call
      // to the next: seen on Hollow Reach, 2026-10-14); a judge that could not run counts as a loss
      const both = q => verdicts.length === 2 && verdicts.every(v => v[q] === 'before');
      const lost = !verdicts.length || both('closer') || both('better') || (verdicts.length === 1 && (verdicts[0].closer === 'before' || verdicts[0].better === 'before'));
      return { verdicts: verdicts.map(v => ({ closer: v.closer, better: v.better, darker: v.darker, why: v.why })), lost, closer: verdicts.some(v => v.closer === 'after') };
    };
    const start0 = await evaluate({}), startPer = start0.per;
    // the tone guard: no setting's frames may come out darker or greyer than both where they started and their own
    // references (moving toward darker references is allowed, past them or past where we were is not), its lit
    // surfaces included (a cave keeps the light it has)
    const refTone = Object.fromEntries(settings.map(k => [k, toneOf(refsP.filter(r => r.setting === k).map(r => r.stats))]));
    // the shadows too (the darkest 15 %): a step that crushes the soil sides or a cave wall to black hides the place
    // (the before/after judge's reason for every veto on Hollow Reach, 2026-10-14); down to the references' own shadows
    // and no further
    // A setting moves darker or greyer only toward references that are clearly darker or greyer than it (by CLEARLY):
    // Hollow Reach's daylight frames are a shade darker and greyer than our land, and a tuner that followed them made
    // the overworld duller by eye while its score rose (the parent, 2026-10-14)
    const floorTone = Object.fromEntries(settings.map(k => [k, Object.fromEntries(['L', 'C', 'litL', 'litC', 'shadowL'].map(t => {
      const own = start0.tone[k][t] ?? 1, ref = refTone[k][t] ?? 1;
      return [t, (ref < own - CLEARLY[t] ? ref : own) - TONE_SLACK[t]];
    }))]));
    const toneOk = tone => settings.every(k => ['L', 'C', 'litL', 'litC', 'shadowL'].every(t => tone[k][t] === null || tone[k][t] >= floorTone[k][t]));
    // every lever at its start (a lever missing here would write an empty value into the overlay)
    let xs = Object.fromEntries(groups.flatMap(x => x.levers).map(l => [l.path, l.start])), evals = 0;
    const walks = [];
    const steps = [];
    for (const G of groups) {
      if (!G.levers.length) continue;
      const fixed = overlayOf(groups.flatMap(x => x.levers).filter(l => !G.levers.includes(l)), xs);
      const floor = (await evaluate(fixed)).per;
      // the guards: a step that lowers any other setting's measured score by more than `guard`, or makes any setting
      // darker or greyer than the tone guard allows, is refused
      const objective = async ov => {
        const { per, tone } = await evaluate(mergeDeep(fixed, ov));
        if (!toneOk(tone)) return -Infinity;
        for (const k of settings) if (k !== G.setting && per[k] < floor[k] - guard) return -Infinity;
        return per[G.setting];
      };
      const d = await descend(G.levers, objective, { rounds, maxEvals: Math.max(40, Math.round(maxEvals / groups.length)), log: line => log(`${line} [${G.id} for ${G.setting}]`) });
      let chosen = d.xs;
      // the judge walks back along the search's path: the furthest point it finds closer to the setting's references
      // and no worse to play in (a measured gain the eye refuses is not taken; Hollow Reach's day: outlines up, closer,
      // and noisier)
      const path = d.steps.slice(1);
      if (vision && path.length) {
        chosen = null;
        for (const frac of [1, 0.6, 0.3]) {
          const n = Math.max(1, Math.round(path.length * frac));
          const cand = replay(G.levers, path.slice(0, n));
          const v = await judgeSetting(G.setting, fixed, mergeDeep(fixed, overlayOf(G.levers, cand)), `walk-${G.id}`);
          walks.push({ group: G.id, setting: G.setting, steps: n, of: path.length, ...v });
          if (!v.lost && v.closer) { chosen = cand; break; }
          if (n === 1) break;
        }
        chosen ??= Object.fromEntries(G.levers.map(l => [l.path, l.start]));
        log(`  tune: ${G.id} for ${G.setting}: the judge took ${walks.filter(w => w.group === G.id && !w.lost && w.closer).map(w => `${w.steps} of ${w.of} steps`).join('') || 'none of the path'}`);
      }
      for (const l of G.levers) xs[l.path] = chosen[l.path];
      evals += d.evals;
      steps.push(...d.steps.map(st => ({ ...st, group: G.id })));
    }
    const allLevers = groups.flatMap(x => x.levers);
    let overlay = overlayOf(allLevers, xs);
    const endPer = (await evaluate(overlay)).per;
    log(`  tune: measured by setting ${settings.map(k => `${k} ${Math.round(startPer[k])} → ${Math.round(endPer[k])}`).join(', ')} in ${evals} renders, ${Math.round((Date.now() - t0) / 1000)} s`);
    // ---- the veto: each setting before and after, side by side, against its own references ----
    const vetoes = [];
    // the veto: every setting, before against after, with every group's choice in place
    const sideBySide = async ov => {
      const out = {};
      for (const k of settings) {
        if (!vision) { const m = (await evaluate(ov)).per[k]; out[k] = { lost: m < startPer[k], measured: { before: startPer[k], after: m } }; continue; }
        out[k] = await judgeSetting(k, {}, ov, 'veto');
      }
      return out;
    };
    let judged = Object.keys(overlay).length ? await sideBySide(overlay) : null;
    if (judged && settings.some(k => judged[k].lost)) {
      // revert the group aimed at a setting that lost, and the look's group when a setting with no group of its own lost
      for (const k of settings.filter(k => judged[k].lost)) {
        const own = groups.find(x => x.setting === k && x.levers.some(l => xs[l.path] !== l.start));
        const culprit = own ?? groups.find(x => x.id === 'look');
        if (culprit && !vetoes.some(v => v.group === culprit.id)) { vetoes.push({ group: culprit.id, setting: k, why: judged[k].verdicts?.map(v => `closer ${v.closer}, better ${v.better}: ${v.why}`).join(' / ') ?? 'measured lower' }); for (const l of culprit.levers) xs[l.path] = l.start; }
      }
      overlay = overlayOf(allLevers, xs);
      judged = Object.keys(overlay).length ? await sideBySide(overlay) : null;
      if (judged && settings.some(k => judged[k].lost)) { vetoes.push({ group: 'all', why: `still loses in ${settings.filter(k => judged[k].lost).join(', ')}` }); for (const l of allLevers) xs[l.path] = l.start; overlay = {}; judged = null; }
      log(`  tune: vetoed ${vetoes.map(v => `${v.group} (${v.setting ?? ''}: ${v.why})`).join('; ')}`);
    }
    // ---- before and after, judged whole (the per-setting score) ----
    const judgeAt = async (ov, tag) => { await apply(ov); return score(dir, target, refs, { vision, px, session: g, refsPrepared: refsP, name: `${name}-${tag}`, outDir: join(outDir, `${tag}-score`), sheetDir: join(priv, tag), log, ...(classify !== undefined ? { classify } : {}) }); };
    const before = await judgeAt({}, 'before');
    const after = await judgeAt(overlay, 'after');
    const shotB = await shoot({}, 'before'), shotA = await shoot(overlay, 'after');
    const names = framings.map(f => f.name);
    // how light and how coloured each setting is before and after, on our own frames (a daylight frame must not come
    // out darker or greyer because cave references pulled it)
    const tones = {};
    for (const k of settings) {
      const mine = names.filter(n => settingOf[n] === k);
      const mean = async list => toneOf(await Promise.all(list.filter(f => mine.includes(f.framing)).map(async f => judgeStats(await px.read(f.file)))));
      tones[k] = { before: await mean(shotB), after: await mean(shotA) };
    }
    const sheet = await beforeAfter(px, names.map(n => `${n} (${settingOf[n]})`), names.map(f => join(outDir, 'before', 'frames', `${f}.jpg`)), names.map(f => join(outDir, 'after', 'frames', `${f}.jpg`)), join(outDir, 'before-after.jpg'),
      `${name}: look ${before.score} → ${after.score}; ${settings.map(k => `${k} ${before.settings?.[k]?.score ?? '–'} → ${after.settings?.[k]?.score ?? '–'}`).join(', ')}${vetoes.length ? `; vetoed: ${vetoes.map(v => v.group).join(', ')}` : ''}`);
    const bar = BAR[confidenceOf(target, refsP)] ?? null;
    const { look: lookValues, world: worldValues } = splitOverlay(overlay);
    const record = {
      tool: 'builder/look/tune.mjs', game: name, at: new Date().toISOString(), seconds: Math.round((Date.now() - t0) / 1000),
      refs: refsP.map(r => ({ file: basename(r.source), sha256: r.sha256, setting: r.setting, settingBy: r.settingBy })),
      ours: start.map(o => ({ framing: o.framing, setting: o.setting, settingBy: o.settingBy, placed: !!o.placed })),
      settings, main, missing, weights, guard,
      paired: pairs.map(p => ({ ref: basename(p.ref.source), setting: p.ref.setting, ours: p.ours.framing })),
      groups: groups.map(x => ({ id: x.id, setting: x.setting, levers: x.levers.map(l => l.path) })),
      measured: { before: roundAll(startPer), after: roundAll((await evaluate(overlay)).per), renders: evals },
      judged, walks, toneFloor: floorTone, refTone,
      tones, vetoes, score: { before: before.score, after: after.score, bar, bySetting: Object.fromEntries(settings.map(k => [k, { before: before.settings?.[k]?.score ?? null, after: after.settings?.[k]?.score ?? null }])) },
      parts: { before: before.parts, after: after.parts }, steps, values: lookValues, world: worldValues, ladder: ladderOf(after, bar), findings: after.findings.slice(0, 14), change: after.change,
      sheets: { beforeAfter: basename(sheet), withReferences: [before.sheet, after.sheet].filter(Boolean).map(s => `${basename(resolve(s, '..'))}/${basename(s)} (local: ${privateDir(name)})`) },
    };
    await writeFile(join(outDir, 'look.json'), JSON.stringify({ values: lookValues, ...(worldValues ? { world: { voxel: { light: worldValues } } } : {}) }, null, 1) + '\n');
    record.wrote = !!(write && Object.keys(lookValues).length && !vetoes.some(v => v.group === 'all') && after.score > before.score);
    if (record.wrote) await writeGame(dir, lookValues);
    await writeFile(join(outDir, 'tune.json'), JSON.stringify(record, null, 1) + '\n');
    return record;
  } finally { await g.close(); await px.close(); }
}
/** A setting's tone over its frames: mean lightness and chroma, and its lit surfaces' (judge.mjs litOf). */
export function toneOf(stats) {
  const avg = get => { const v = stats.map(get).filter(x => typeof x === 'number'); return v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length * 1000) / 1000 : null; };
  return { L: avg(s => s.mean?.L), C: avg(s => s.mean?.C), litL: avg(s => s.lit?.L), litC: avg(s => s.lit?.C), shadowL: avg(s => s.tones?.shadow?.[0]) };
}
/** How far below the tone floor a step may go (a rounding's worth). */
export const TONE_SLACK = { L: 0.01, C: 0.005, litL: 0.01, litC: 0.005, shadowL: 0.008 };
/** How much darker or greyer a setting's references must be before the tune may follow them there. */
export const CLEARLY = { L: 0.05, C: 0.03, litL: 0.05, litC: 0.03, shadowL: 0.05 };
/** The lever settings after the first steps of a search's path (descend's kept steps, in order). */
export function replay(levers, steps) {
  const xs = Object.fromEntries(levers.map(l => [l.path, l.start]));
  for (const st of steps) {
    if (st.lever && st.lever in xs) xs[st.lever] = st.value;
    for (const [p, v] of Object.entries(st.levers ?? {})) if (p in xs) xs[p] = v;
  }
  return xs;
}
const roundAll = o => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Math.round(v * 10) / 10]));
function mergeDeep(a, b) { const out = structuredClone(a); for (const [k, v] of Object.entries(b)) out[k] = v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object' ? mergeDeep(out[k], v) : v; return out; }

/** --write: the tuned values into the game: spec.json look.values (over what it had) and config/look.json. */
export async function writeGame(dir, overlay) {
  const specFile = join(dir, 'spec.json'), lookFile = join(dir, 'config', 'look.json');
  const spec = JSON.parse(await readFile(specFile, 'utf8'));
  spec.look = { ...(spec.look ?? {}), values: overLook(spec.look?.values ?? {}, overlay) };
  delete spec.look.values.times;
  await writeFile(specFile, JSON.stringify(spec, null, 2) + '\n');
  if (existsSync(lookFile)) await writeFile(lookFile, JSON.stringify(overLook(JSON.parse(await readFile(lookFile, 'utf8')), overlay), null, 2) + '\n');
}

if (isMain(import.meta)) {
  const a = process.argv.slice(2), opt = k => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : null; };
  const VALUED = new Set(['--refs', '--target', '--out', '--rounds', '--evals']);
  const dir = a.find((x, i) => !x.startsWith('--') && !VALUED.has(a[i - 1]));
  if (!dir) { console.error('usage: tune.mjs <game-dir> [--refs <manifest.json>] [--target <target.json>] [--out <dir>] [--rounds 6] [--evals 400] [--no-vision] [--write] [--json]'); process.exit(2); }
  // the target and the frames: given, else the game's own (the locked spec's look.target and the frames measure 23 finds)
  const { lookInputs } = await import('../tools/lib/look-check.mjs');
  const own = await lookInputs(dir);
  const target = opt('--target') ? JSON.parse(await readFile(opt('--target'), 'utf8')) : own.target;
  const refs = opt('--refs') ? await readManifest(opt('--refs')) : own.refs;
  const r = await tune(dir, target, refs, { outDir: opt('--out') ?? undefined, rounds: Number(opt('--rounds') ?? 6), maxEvals: Number(opt('--evals') ?? 400), vision: !a.includes('--no-vision'), write: a.includes('--write') });
  if (a.includes('--json')) console.log(JSON.stringify({ score: r.score, measured: r.measured, values: r.values, ladder: r.ladder, wrote: r.wrote }));
  console.log(`look ${r.score.before} → ${r.score.after}; by setting ${Object.entries(r.score.bySetting ?? {}).map(([k, v]) => `${k} ${v.before} → ${v.after}`).join(', ')}; bar ${r.score.bar ?? 'advisory'}${r.vetoes?.length ? `; vetoed ${r.vetoes.map(v => v.group).join(', ')}` : ''}`);
  if (r.ladder.needed) console.log(`below the bar after the levers: ${r.ladder.art.length} findings need new art; next: ${r.ladder.next.join('; ')}`);
}
