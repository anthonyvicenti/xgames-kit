#!/usr/bin/env node
// The reference look judge (builder/look/README.md): how close a game's look is to its style target and its reference
// frames, 0–100, by part, with plain findings a repair round (or the tuning loop) can act on.
//
//   node builder/look/judge.mjs <game-dir> [--refs <manifest.json>] [--target <target.json>] [--out <dir>] [--no-vision] [--json <file>]
//   node builder/look/judge.mjs --frames <frames.json> --refs <manifest.json> [--out <dir>] [--no-vision]
//
// A manifest (refs or frames) is { "frames": [{ "file", "framing"?, "crop"?: [x, y, w, h], "sha256"? }] }, files
// relative to the manifest. Reference frames stay local: the judge copies nothing of them into a game or a record but
// their names, hashes and numbers, and the side-by-side sheet (which shows them) is written to the local looks folder
// (GF_LOOK_PRIVATE, default ~/.xgames/looks/<game>), never into the game.
//
//   score(game, target, refs, opts) → { score, bar, pass, advisory, confidence, parts, framings, findings, change, sheet }
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { frameStats, compareStats, measuredMark, proportionMark, hexToOklab, colourWords, trimBars, poolStats, surfacesOf, SURFACES, toOklab } from './stats.mjs';
import { measureFrame } from './measure.mjs';
import { settingsOf, SETTING_WORDS } from './settings.mjs';
import { openPixels } from './pixels.mjs';
import { judgePairs, judgeOptions, judgedMark, partWeights, PARTS, VISION_MODEL } from './vision.mjs';
import { isMain } from '../tools/lib/main.mjs';

/**
 * The bar a game's score must reach, by how sure its target is: frames on file (`refs`) or words only (`words`, never
 * failing: there is nothing to hold the look to but a description). Calibrated on Hollow Reach (calibrate.mjs; the
 * record in evidence/): the blocky world the parent sent back (caves too dark) scored 49–56 over four runs, the one it
 * accepted 57–62; 55 sits between them. A run's judge varies by about ±3.
 */
export const BAR = { refs: 55, words: null };
/**
 * The judged half's run-to-run spread on an unchanged game (one standard deviation, in points; builder/look/noise.mjs,
 * evidence/noise-*), and how many standard errors the interval spans (Z = 2: about 95 %).
 */
export const NOISE = { judgedSd: 6 };
// Z = 3, not 2 (2026-10-14): at two standard errors a game near the bar (block-valley against Hollow Reach, three-pass
// scores 50–56) came out "fail" in 1 of 10 verify runs and "unsure" in 9; at three none of its runs can reach "fail",
// and a game must sit about 7 points from the bar to pass or fail
export const Z = 3;
/** Measure 23's own settings (look-check.mjs): k judge passes, and the blend the gate holds (set from the noise). */
export const GATE = { passes: 3, blend: { measured: 0.3, judged: 0.7 } };
/**
 * How a pair's mark is made: measured and judged, when the judge ran. The judged part weighs more: on the artillery
 * proving case the measured parts (colour, light and edges) ranked the look options against the eye, which reads the
 * characters, the ground and the props first, and only the judge sees those (evidence/calibration-*).
 */
export const BLEND = { measured: 0.3, judged: 0.7 };
/** Which findings the cheap levers can reach (tune.mjs) and which need new art (the ladder: a library swap, then
 *  generation). Measured parts are all light and colour; of the judged, palette and lighting are the levers'. */
export const LEVER_PARTS = new Set(['palette', 'value', 'saturation', 'sky', 'edges', 'lighting']);   // ground and characters are art: their colour is the slots'
export const reachOf = part => (LEVER_PARTS.has(part) ? 'levers' : 'art');

export const privateDir = name => resolve(process.env.GF_LOOK_PRIVATE ?? join(homedir(), '.xgames', 'looks'), name);
const sha = b => createHash('sha256').update(b).digest('hex');

/**
 * A frame's numbers for the judge: stats.mjs's, and its surfaces (surfacesOf: the sky band, the ground band, the
 * characters), so it compares surface to surface. Which of a reference's bands are surfaces is decided as target.mjs
 * decides it (measure.mjs measureFrame: a band is the sky or the ground only when one colour family holds it), so a
 * flying shot's sea is not taken for ground; ours are kept whatever they hold, so a painted ground of many greens is
 * still the ground. Both sides' colours come from the same bands, so a frame against itself is 100.
 */
export function judgeStats(img, { ref = false } = {}) {
  const s = frameStats(img);
  s.lit = litOf(img);
  const bands = surfacesOf(img);
  if (!ref) { s.surfaces = bands; return s; }
  const regions = measureFrame(img).regions ?? {};
  s.surfaces = Object.fromEntries(Object.entries(bands).filter(([k]) => regions[k]));
  return s;
}

/**
 * Why a frame of ours cannot stand for its setting, or null: almost no edges and almost no contrast (the camera is in
 * the haze or the fog, or the frame is blank), or a "day" frame with hardly any lit pixels (underground, or in shade).
 */
export function unusableWhy(s, setting = null) {
  if (!s) return null;
  if ((s.edges?.density ?? 1) < 0.02 && (s.mean?.contrast ?? 1) < 0.06) return 'mostly haze or blank: no edges and no contrast';
  if ((s.mean?.L ?? 0) > 0.9 && (s.mean?.contrast ?? 1) < 0.06) return 'a white-out';
  if (setting === 'day' && s.lit && s.lit.share < 0.15) return `called daylight with only ${Math.round(s.lit.share * 100)} % of it lit`;
  return null;
}

/** The lit pixels (OKLab L over 0.45, as measure.mjs reads a target): how much of the frame is lit, and how light and
 *  how coloured its lit surfaces are, so a cave is judged on its light and not on how much of it is dark. */
export function litOf(img) {
  let n = 0, L = 0, C = 0; const d = img.data, all = d.length / 4;
  for (let i = 0; i < d.length; i += 8) { const [l, a, b] = toOklab(d[i], d[i + 1], d[i + 2]); if (l > 0.45) { n++; L += l; C += Math.hypot(a, b); } }
  const r3 = v => Math.round(v * 1000) / 1000;
  return { share: r3(n / (all / 2)), L: n ? r3(L / n) : null, C: n ? r3(C / n) : null };
}

/** A manifest file → frames with absolute paths. */
export async function readManifest(file) {
  const m = JSON.parse(await readFile(file, 'utf8'));
  const base = dirname(resolve(file));
  return (m.frames ?? m.refs ?? m).map(f => ({ ...f, file: resolve(base, f.file) }));
}

/**
 * Frames → measured and ready to judge: each { file, framing, crop?, label? } gets its stats and, when cropped, a file
 * of its own (the vision judge reads files). px: openPixels(); tmp: a folder for the crops.
 */
export async function prepareFrames(list, px, tmp, { ref = false } = {}) {
  const out = [];
  for (const [i, f] of list.entries()) {
    if (!existsSync(f.file)) throw new Error(`no frame at ${f.file}`);
    let file = f.file;
    if (f.crop) { await mkdir(tmp, { recursive: true }); file = join(tmp, `${f.label ?? f.framing ?? 'frame'}-${i + 1}.jpg`.replace(/[^\w.-]+/g, '-')); await writeFile(file, await px.extract(f.file, { crop: f.crop })); }
    const img = trimBars(await px.read(f.file, { crop: f.crop ?? null }));
    out.push({ ...f, file, source: f.file, stats: judgeStats(img, { ref }), sha256: f.sha256 ?? sha(await readFile(f.file)) });
  }
  return out;
}

/** Is the target held to frames on file? gf-look-target/1 says `from`: 'refs', 'words' or 'refs+words'. */
// A target made from frames still holds its measured numbers when the frames are not on this machine (a Studio job,
// a regression): it is held to them, measured only.
export function confidenceOf(target, refs) {
  if (target?.from && !/refs/.test(target.from)) return 'words';
  if (refs.length) return 'refs';
  const t = targetStats(target);
  return /refs/.test(target?.from ?? '') && t?.palette?.length && t?.value ? 'refs' : 'words';
}
const headToBodyOf = target => target?.shapes?.headToBody ?? target?.shape?.headToBody ?? null;

/**
 * The target's own numbers as a reference with no frame (a target from words, or refs measured elsewhere): whatever
 * of stats.mjs's shape the target carries (palette.colors, palette.value.hist, palette.chroma.hist, edges, the sky
 * region), so only those parts are compared.
 */
export function targetStats(target) {
  const P = target?.palette ?? {};
  const pal = (Array.isArray(P) ? P : P.colors ?? []).map(p => (typeof p === 'string' ? { hex: p } : p)).filter(p => /^#[0-9a-f]{6}$/i.test(p.hex ?? ''));
  const total = pal.reduce((s, p) => s + (p.share ?? 1), 0);
  const hist16 = h => (Array.isArray(h) && h.length === 16 ? h : null);
  const sky = target?.regions?.sky;
  const stats = {
    palette: pal.map(p => { const lab = hexToOklab(p.hex); return { lab, hex: p.hex, share: (p.share ?? 1) / total, words: colourWords(lab) }; }),
    value: hist16(P.value?.hist), chroma: hist16(P.chroma?.hist),
    edges: typeof target?.edges?.density === 'number' && typeof target?.edges?.dark === 'number' ? { density: target.edges.density, dark: target.edges.dark } : null,
    regions: { top: sky && typeof sky.value === 'number' && typeof sky.chroma === 'number' ? { L: sky.value, C: sky.chroma, ...(skyLab(sky) ? { lab: skyLab(sky) } : {}) } : null },
    mean: { L: P.value?.mean ?? null, C: P.chroma?.mean ?? null, contrast: null },
    surfaces: Object.fromEntries(SURFACES.map(k => [k, target?.regions?.[k]]).filter(([, r]) => r?.colors?.length)
      .map(([k, r]) => [k, { clusters: r.colors.filter(c => /^#[0-9a-f]{6}$/i.test(c.hex ?? '')).map(c => ({ lab: hexToOklab(c.hex), share: c.share ?? 1 })) }])),
  };
  return stats.palette.length || stats.value || stats.chroma ? stats : null;
}
// the sky band's colour: its swatches' OKLab, weighted by share
function skyLab(sky) {
  const cs = (sky.colors ?? []).filter(c => /^#[0-9a-f]{6}$/i.test(c.hex ?? ''));
  const w = cs.reduce((s, c) => s + (c.share ?? 1), 0);
  return cs.length && w ? [0, 1, 2].map(i => cs.reduce((s, c) => s + hexToOklab(c.hex)[i] * (c.share ?? 1), 0) / w) : null;
}
function wordsReference(target) {
  const stats = targetStats(target);
  return stats ? { framing: null, file: null, words: true, stats } : null;
}

/** A reference's frame kind (gf-look-refs/1 `frame`: gameplay, character, terrain, scene, ui, vfx) → the framings of
 *  ours it is held to first. */
export const FRAME_HINT = { character: ['hero'], terrain: ['wide'], scene: ['wide'], ui: ['hud'], vfx: ['props', 'hud'], gameplay: ['hud', 'props'] };

/** How many pairs the vision judge reads in one score (two pictures each). More references are measured, all of them. */
export const MAX_JUDGED = 8;
/** At most n pairs, taken round-robin over the references' frame kinds so every kind is judged. */
export function spread(pairs, n) {
  if (pairs.length <= n) return pairs;
  const by = new Map();
  for (const p of pairs) { const k = p.ref.frame ?? p.ref.framing ?? ''; if (!by.has(k)) by.set(k, []); by.get(k).push(p); }
  const out = [];
  while (out.length < n) for (const list of by.values()) { if (list.length && out.length < n) out.push(list.shift()); }
  return out.sort((a, b) => Number(a.id) - Number(b.id));
}

/** For each reference, the frame of ours closest to it: the same framing when one is named alike, else the best measured. */
export function pairUp(refs, ours, { bySetting = false } = {}) {
  return refs.map(r => {
    if (!bySetting || !r.setting) return pairOne(r, ours);
    const mine = ours.filter(o => o.setting === r.setting);
    return mine.length ? pairOne(r, mine) : { ref: r, ours: null, compare: null, mark: null };
  });
}
function pairOne(r, ours) {
  const same = ours.filter(o => r.framing && o.framing === r.framing);
  // the target's own cameras say which frame kind they are for (camera.framings[].frame), the sheet's by FRAME_HINT
  const hinted = r.frame ? ours.filter(o => o.frame === r.frame || (FRAME_HINT[r.frame] ?? []).includes(o.framing)) : [];
  const pool = same.length ? same : hinted.length ? hinted : ours;
  let best = null;
  for (const o of pool) {
    const c = compareStats(o.stats, r.stats);
    const m = measuredMark(c.parts) ?? 0;
    if (!best || m > best.mark) best = { ref: r, ours: o, compare: c, mark: m };
  }
  return best;
}

/**
 * How much game time each setting gets, as weights: the setting of the player's own view (the HUD framing, else the
 * first framing) twice the others. A game that spends its time in daylight is judged first on daylight.
 */
export function timeWeights(ours) {
  const own = (ours.find(o => o.framing === 'hud') ?? ours[0])?.setting ?? null;
  return Object.fromEntries([...new Set(ours.map(o => o.setting ?? 'all'))].map(k => [k, k === own ? 2 : 1]));
}

/** The settings the references show and no frame of ours does: findings for the world and the cameras, never a score. */
export function settingGaps(missing) {
  const by = {};
  for (const m of missing) (by[m.setting ?? 'all'] ??= []).push(m);
  return Object.entries(by).map(([k, list]) => ({ framing: null, setting: k, part: 'setting', source: 'settings', reach: k === 'ui' ? 'art' : 'world',
    line: `${list.length} reference frame${list.length === 1 ? '' : 's'} show${list.length === 1 ? 's' : ''} ${SETTING_WORDS[k] ?? k}; no frame of ours does, so ${list.length === 1 ? 'it was' : 'they were'} not scored (${k === 'ui' ? 'the menus and title screens are the UI\'s' : 'a place in the world that shows it, or a camera there'})` }));
}

/** One pair's measured parts (with proportion when bodies are visible and the target says) and findings. */
function measurePair(p, target) {
  const parts = { ...p.compare.parts };
  const want = headToBodyOf(target);
  const heads = (p.ours.bodies ?? []).map(b => b.head).filter(h => typeof h === 'number');
  const findings = [...p.compare.findings];
  if (heads.length && typeof want === 'number') {
    const mean = heads.reduce((s, h) => s + h, 0) / heads.length;
    parts.proportion = proportionMark(mean, want);
    if (Math.abs(mean - want) > 0.06) findings.push(`bodies' heads are ${Math.round(mean * 100)}% of their height; the target's are ${Math.round(want * 100)}% (${mean < want ? 'bigger heads' : 'smaller heads'} wanted)`);
  }
  return { parts, findings };
}

/**
 * Score a game's look. game: a folder (rendered live, render.mjs) or { frames: [{ file, framing, crop?, bodies? }] }.
 * target: the spec's look.target (or null). refs: [{ file, framing?, crop?, sha256? }]. opts: { vision (true), judge
 * (judgePairs, replaced in tests), outDir (the record, no reference frames), sheetDir (the local side-by-side), px,
 * name, log }.
 */
export async function score(game, target, refs = [], opts = {}) {
  const { vision = true, judge = judgePairs, log = () => {} } = opts;
  const blend = opts.blend ?? BLEND;
  const name = opts.name ?? (typeof game === 'string' ? basename(resolve(game)) : 'frames');
  const sheetDir = opts.sheetDir ?? privateDir(name);
  const px = opts.px ?? await openPixels();
  const t0 = Date.now();
  let session = null;
  try {
    // ---- the references, each with its setting (day, cave, night, close, ui: settings.mjs) ----
    const bySetting = opts.bySetting !== false;
    const classifyOpts = { vision: opts.classify !== null && process.env.GF_LOOK_SETTINGS !== '0', ...(opts.classify ? { classifyFn: opts.classify } : {}), log };
    let refsP = opts.refsPrepared ?? await prepareFrames(refs, px, join(sheetDir, 'tmp-refs'), { ref: true });
    if (bySetting && refsP.length && refsP.some(r => !r.setting)) refsP = await settingsOf(refsP, classifyOpts);
    const refSettings = [...new Set(refsP.map(r => r.setting).filter(Boolean))];
    // ---- our frames: the target's cameras, a place for each setting the references show (a cave shot in a cave), the
    // sheet's framings; each classified the same way ----
    let ours = game?.frames ?? null, rendered = null;
    if (!ours) {
      const { openGame, framingsOf } = await import('./render.mjs');
      session = opts.session ?? await openGame(game, { log });
      rendered = await session.frames(framingsOf(target, { settings: bySetting ? refSettings : [] }), join(opts.outDir ?? join(resolve(game), '.verify', 'look'), 'frames'));
      ours = rendered.map(r => ({ file: r.file, framing: r.framing, frame: r.frame, where: r.where, placed: r.placed, bodies: r.bodies }));
    }
    let oursP = opts.oursPrepared ?? await prepareFrames(ours, px, join(sheetDir, 'tmp-ours'));
    if (bySetting && refsP.length && oursP.some(o => !o.setting)) oursP = await settingsOf(oursP, classifyOpts);
    // a frame of ours that shows nothing (a camera in the haze, a blank or a white-out) is never judged, and one that is
    // not lit like daylight is never held to daylight references
    const unusable = [];
    oursP = oursP.filter(o => { const why = unusableWhy(o.stats, o.setting); if (why) unusable.push({ framing: o.framing, why }); return !why; });
    if (unusable.length) log(`  look judge: left out ${unusable.map(u => `${u.framing} (${u.why})`).join(', ')}`);
    const confidence = confidenceOf(target, refsP);
    const against = refsP.length ? refsP : [wordsReference(target)].filter(Boolean);
    if (!against.length) return { score: null, bar: null, pass: true, advisory: true, confidence, parts: {}, framings: [], findings: [], change: [], why: 'no reference frames and no target palette: nothing to hold the look to' };

    // ---- pairs, measured ----
    // against the target's own numbers (no frames), our framings count as one look: their stats pooled
    const oursFor = refsP.length ? oursP : [{ framing: 'pooled', file: oursP[0]?.file, stats: poolStats(oursP.map(o => o.stats)), bodies: oursP.flatMap(o => o.bodies ?? []) }];
    // like with like: a reference is paired only with a frame of ours in its own setting; a setting no frame of ours
    // shows is a finding (the game, its world or its cameras do not show it), never scored against another setting
    const paired = pairUp(against, oursFor, { bySetting: bySetting && refsP.length > 0 });
    const missing = paired.filter(p => !p.ours).map(p => p.ref);
    const pairs = paired.filter(p => p.ours).map((p, i) => ({ ...p, id: String(i + 1), ...measurePair(p, target) }));
    if (!pairs.length) return { score: null, bar: null, pass: true, advisory: true, confidence, parts: {}, framings: [], findings: settingGaps(missing), settings: {}, change: [], why: `no frame of ours shows a setting the references show (${[...new Set(missing.map(m => m.setting))].join(', ')})` };
    // ---- judged: k passes over the same pairs, the pairs' order reversed on every other pass, the marks averaged ----
    // (the vision model varies from call to call and its CLI takes no temperature or seed: noise.mjs measured it)
    let verdict = null, passes = [];
    const judgeable = spread(pairs.filter(p => p.ref.file), opts.maxJudged ?? MAX_JUDGED);
    const k = Math.max(1, opts.passes ?? 1);
    if (vision && judgeable.length) {
      const asked = judgeable.map(p => ({ id: p.id, ours: p.ours.file, ref: p.ref.file, framing: p.ref.framing ?? p.ours.framing }));
      const got = await Promise.all(Array.from({ length: k }, (_, i) => judge(i % 2 ? [...asked].reverse() : asked, { reads: target?.reads ?? [] })
        .catch(e => ({ error: String(e.message).slice(0, 400) }))));
      passes = got.filter(v => v?.pairs);
      const errors = got.filter(v => v?.error);
      if (errors.length) log(`  look judge: ${errors.length} of ${k} vision passes could not run: ${errors[0].error}`);
      verdict = passes.length ? { ...passes[0], cost: passes.reduce((a, v) => a + (v.cost ?? 0), 0), seconds: Math.max(...passes.map(v => v.seconds ?? 0)), passes: passes.length } : { error: errors[0]?.error ?? 'no pass' };
    }
    const weights = partWeights(target?.reads ?? []);
    // a pair's judged mark: each pass's, and their mean; its parts: the first pass's words, the passes' mean marks
    const judgedOf = id => {
      const each = passes.map(v => v.pairs.find(x => x.id === id)).filter(Boolean);
      if (!each.length) return null;
      const marks = each.map(j => judgedMark(j.parts, weights)).filter(m => m !== null);
      const parts = Object.fromEntries(PARTS.map(k2 => { const ms = each.map(j => j.parts[k2]?.match).filter(m => typeof m === 'number'); return [k2, { ...each[0].parts[k2], match: ms.length ? ms.reduce((a, b) => a + b, 0) / ms.length : null }]; }));
      return { marks, mean: marks.length ? marks.reduce((a, b) => a + b, 0) / marks.length : null, parts };
    };
    const framings = pairs.map(p => {
      const measured = measuredMark(p.parts);
      const jo = judgedOf(p.id);
      const j = jo ? { parts: jo.parts } : null;
      const judged = jo?.mean ?? null;
      const exactMark = judged === null ? measured : blend.measured * measured + blend.judged * judged;
      const mark = Math.round(exactMark);
      return { framing: p.ref.framing ?? p.ours.framing ?? null, setting: p.ref.setting ?? p.ours.setting ?? null, ours: { file: basename(p.ours.file), framing: p.ours.framing ?? null, setting: p.ours.setting ?? null, placed: !!p.ours.placed }, ref: p.ref.file ? { file: basename(p.ref.source ?? p.ref.file), sha256: p.ref.sha256, label: p.ref.label ?? null } : { words: true },
        measured, measuredParts: p.parts, judged: judged === null ? null : Math.round(judged), judgedPasses: jo?.marks ?? null, judgedParts: j?.parts ?? null, score: mark, exact: exactMark, measuredFindings: p.findings };
    });
    // ---- by setting: each setting's score against its own references; the whole, weighed by game time ----
    const settings = {};
    for (const f of framings) { const k = f.setting ?? 'all'; (settings[k] ??= { scores: [], exacts: [], refs: 0 }).scores.push(f.score); settings[k].exacts.push(f.exact); settings[k].refs++; }
    const timeW = opts.settingWeights ?? timeWeights(oursP);
    for (const [k, v] of Object.entries(settings)) { settings[k] = { exact: v.exacts.reduce((a, b) => a + b, 0) / v.exacts.length, score: Math.round(v.scores.reduce((a, b) => a + b, 0) / v.scores.length), refs: v.refs, ours: oursP.filter(o => (o.setting ?? 'all') === k).map(o => o.framing), weight: timeW[k] ?? 1 }; }
    const wsum = Object.values(settings).reduce((a, v) => a + v.weight, 0);
    const total = Math.round(Object.values(settings).reduce((a, v) => a + v.score * v.weight, 0) / wsum);
    // the two halves on their own, unrounded, weighed the same way: the measured part (deterministic) and the judged
    // part (the vision model's, which varies from call to call; noise.mjs measures by how much)
    const half = key => { let s = 0, w = 0; for (const [k, v] of Object.entries(settings)) { const xs = framings.filter(f => (f.setting ?? 'all') === k && typeof f[key] === 'number').map(f => f[key]); if (xs.length) { s += v.weight * xs.reduce((a, b) => a + b, 0) / xs.length; w += v.weight; } } return w ? s / w : null; };
    const halves = { measured: half('measured'), judged: half('judged') };
    // ---- how sure: the judged half of each pass, its spread, and the interval the whole lies in ----
    const perPass = passes.map((_, i) => { let s = 0, w = 0; for (const [k2, v] of Object.entries(settings)) { const xs = framings.filter(f => (f.setting ?? 'all') === k2 && f.judgedPasses?.[i] !== undefined).map(f => f.judgedPasses[i]); if (xs.length) { s += v.weight * xs.reduce((a, b) => a + b, 0) / xs.length; w += v.weight; } } return w ? s / w : null; }).filter(x => x !== null);
    // the interval sits on the score itself (unrounded: each framing's mark, measured where no pass judged it)
    const exact = Object.values(settings).reduce((a, v) => a + v.exact * v.weight, 0) / wsum;
    const sdSample = perPass.length > 1 ? Math.sqrt(perPass.reduce((a, x) => a + (x - halves.judged) ** 2, 0) / (perPass.length - 1)) : 0;
    // the judged half's spread: the larger of this run's and the one measured on unchanged games (NOISE), so a run of
    // two passes that happen to agree is not taken as certain
    const sdJudged = halves.judged === null ? 0 : Math.max(sdSample, NOISE.judgedSd);
    const half95 = Z * blend.judged * sdJudged / Math.sqrt(Math.max(1, perPass.length));
    const interval = [exact - half95, exact + half95].map(x => Math.round(x * 10) / 10);
    // ---- the parts over all framings ----
    const parts = { measured: {}, judged: {} };
    for (const k of ['palette', 'value', 'saturation', 'sky', 'ground', 'characters', 'edges', 'proportion']) { const v = framings.map(f => f.measuredParts[k]).filter(x => typeof x === 'number'); if (v.length) parts.measured[k] = Math.round(v.reduce((s, x) => s + x, 0) / v.length); }
    for (const k of PARTS) {
      const shown = framings.map(f => f.judgedParts?.[k]).filter(x => typeof x?.match === 'number');
      if (shown.length) parts.judged[k] = { mark: Math.round((shown.reduce((s, x) => s + x.match, 0) / shown.length / 4) * 100), vs: tally(shown.map(x => x.vs)) };
    }
    // ---- findings: the judge's weak parts first, then the measured ones, each with whether the levers can reach it ----
    const findings = [];
    for (const f of framings) for (const k of PARTS) {
      const x = f.judgedParts?.[k];
      if (x && typeof x.match === 'number' && x.match <= 2 && x.finding && !/^matches\.?$/i.test(x.finding)) findings.push({ framing: f.framing, part: k, source: 'judged', match: x.match, line: x.finding, reach: reachOf(k) });
    }
    for (const f of framings) for (const line of f.measuredFindings.slice(0, 4)) findings.push({ framing: f.framing, part: partOfLine(line), source: 'measured', line, reach: reachOf(partOfLine(line)) });
    findings.sort((a, b) => (a.source === b.source ? (a.match ?? 9) - (b.match ?? 9) : a.source === 'judged' ? -1 : 1));
    findings.push(...settingGaps(missing));
    const bar = BAR[confidence] ?? null;
    const result = {
      tool: 'builder/look/judge.mjs', game: name, at: new Date().toISOString(), seconds: Math.round((Date.now() - t0) / 1000),
      score: total, exact: Math.round(exact * 10) / 10, interval, judgedSpread: { passes: perPass.map(x => Math.round(x * 10) / 10), sd: Math.round(sdSample * 10) / 10, sdUsed: Math.round(sdJudged * 10) / 10 },
      bar, advisory: bar === null, verdict: bar === null ? 'advisory' : interval[0] >= bar ? 'pass' : interval[1] < bar ? 'fail' : 'unsure',
      pass: bar === null ? true : interval[1] >= bar, confidence, targetConfidence: typeof target?.confidence === 'number' ? target.confidence : null,
      blend: verdict?.pairs ? blend : { measured: 1, judged: 0 }, passes: perPass.length, partWeights: weights, vision: verdict ? (verdict.error ? { error: verdict.error } : { model: verdict.model ?? VISION_MODEL, rubric: verdict.rubric, seconds: verdict.seconds, cost: verdict.cost }) : null,
      unusable, halves, settings: Object.fromEntries(Object.entries(settings).map(([k, v]) => [k, { ...v, exact: Math.round(v.exact * 10) / 10 }])), missingSettings: [...new Set(missing.map(m => m.setting))], parts, framings: framings.map(({ measuredFindings, ...f }) => f), findings, change: verdict?.change ?? [], summary: verdict?.summary ?? null,
    };
    if (opts.sheet !== false) result.sheet = await sideBySide(px, pairs, framings, result, sheetDir).catch(e => { log(`  look judge: no sheet (${e.message})`); return null; });
    if (opts.outDir) { await mkdir(opts.outDir, { recursive: true }); await writeFile(join(opts.outDir, 'look-judge.json'), JSON.stringify(result, null, 1) + '\n'); }
    return result;
  } finally {
    if (session && !opts.session) await session.close();
    if (!opts.px) await px.close();
  }
}

/**
 * Several looks of one game, ranked side by side (the pitch's options, a calibration's states, a tuning's before and
 * after). Each is measured alone (score, no vision); the vision judge then sees them together against the references
 * (vision.mjs judgeOptions), since a judge marking each alone gives close looks the same marks.
 * looks: [{ id, game }] (a folder or { frames }). → { looks: { id: { score, measured, judged, parts, findings } },
 * ranking (by score), judgeRanking, summary, vision }
 */
export async function compare(looks, target, refs = [], opts = {}) {
  const { vision = true, judgeLooks = judgeOptions, log = () => {} } = opts;
  const px = opts.px ?? await openPixels();
  try {
    const refsP = opts.refsPrepared ?? await prepareFrames(refs, px, join(privateDir('compare'), 'tmp-refs'), { ref: true });
    const each = {};
    for (const l of looks) each[l.id] = await score(l.game, target, refs, { ...opts, vision: false, px, refsPrepared: refsP, sheet: false, name: l.id });
    const weights = partWeights(target?.reads ?? []);
    let verdict = null;
    if (vision && refsP.length) {
      const shown = spread(refsP.map((r, i) => ({ id: String(i + 1), ref: r })), opts.maxRefs ?? MAX_JUDGED).map(p => p.ref.file);
      const files = l => (l.game?.frames ?? each[l.id].framings.map(f => ({ file: f.ours.path }))).map(f => f.file).filter(Boolean).slice(0, 6);
      try { verdict = await judgeLooks(shown, looks.map(l => ({ id: l.id, files: files(l) })), { reads: target?.reads ?? [] }); }
      catch (e) { verdict = { error: String(e.message).slice(0, 400) }; log(`  compare: the vision judge could not run: ${verdict.error}`); }
    }
    const out = {};
    for (const l of looks) {
      const r = each[l.id], measured = Math.round(r.framings.reduce((a, f) => a + f.measured, 0) / Math.max(1, r.framings.length));
      const parts = verdict?.options?.[l.id]?.parts ?? null;
      const judged = parts ? judgedMark(parts, weights) : null;
      out[l.id] = { score: judged === null ? measured : Math.round(BLEND.measured * measured + BLEND.judged * judged), measured, judged, parts: { measured: r.parts.measured, judged: parts }, findings: r.findings.slice(0, 8) };
    }
    const ranking = Object.keys(out).sort((a, b) => out[b].score - out[a].score);
    return { looks: out, ranking, judgeRanking: verdict?.ranking ?? null, summary: verdict?.summary ?? null, partWeights: weights,
      vision: verdict ? (verdict.error ? { error: verdict.error } : { model: verdict.model, seconds: verdict.seconds, cost: verdict.cost }) : null };
  } finally { if (!opts.px) await px.close(); }
}

const tally = list => list.reduce((o, v) => (v ? { ...o, [v]: (o[v] ?? 0) + 1 } : o), {});
function partOfLine(line) {
  if (/outline|edge|busier|plainer/.test(line)) return 'edges';
  const surf = line.match(/^(sky|ground|characters):/);
  if (surf) return surf[1];
  if (/\(sky\)/.test(line)) return 'sky';
  if (/saturat|chroma/.test(line)) return 'saturation';
  if (/dark|bright|light|contrast/.test(line)) return 'value';
  if (/head/.test(line)) return 'proportion';
  return 'palette';
}

/** The side-by-side (reference | ours | marks), one row a framing. It shows the reference frames: local only. */
async function sideBySide(px, pairs, framings, result, dir) {
  await mkdir(dir, { recursive: true });
  const img = async f => (f ? `data:image/jpeg;base64,${(await px.extract(f, { maxWidth: 640, quality: 0.85 })).toString('base64')}` : '');
  const esc = v => String(v ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const rows = [];
  for (const [i, p] of pairs.entries()) {
    const f = framings[i];
    const jp = f.judgedParts ? PARTS.filter(k => typeof f.judgedParts[k]?.match === 'number').map(k => `<div>${k} <b>${f.judgedParts[k].match}/4</b> <i>${esc(f.judgedParts[k].vs)}</i><br><small>${esc(f.judgedParts[k].finding)}</small></div>`).join('') : '';
    const mp = Object.entries(f.measuredParts).map(([k, v]) => `${k} ${v}`).join(' · ');
    rows.push(`<div class=r><div class=c><img src="${await img(p.ref.file)}"><span>reference${p.ref.framing ? ` · ${esc(p.ref.framing)}` : ''}</span></div><div class=c><img src="${await img(p.ours.file)}"><span>ours · ${esc(p.ours.framing)}</span></div>
      <div class=m><h3>${f.score}<small> / 100</small></h3><div>measured ${f.measured}: ${mp}</div>${f.judged !== null ? `<div>judged ${f.judged}</div>${jp}` : ''}</div></div>`);
  }
  const html = `<!doctype html><meta charset=utf-8><style>body{margin:0;background:#15131a;color:#eee;font:13px/1.3 system-ui,sans-serif;padding:14px;width:1640px}
    h1{font-size:20px;margin:0 0 8px}.r{display:grid;grid-template-columns:600px 600px 400px;gap:10px;margin-bottom:10px}.c img{width:600px;display:block;border-radius:4px}
    .c span{opacity:.7}.m h3{font-size:26px;margin:0}.m div{margin:3px 0}.m small{opacity:.75}</style>
    <h1>${esc(result.game)} · look ${result.score}/100 · bar ${result.bar ?? 'advisory'} · ${esc(result.confidence)}</h1>${rows.join('')}`;
  const page = await px.browser.newPage({ viewport: { width: 1670, height: 400 }, deviceScaleFactor: 1 });
  try { await page.setContent(html, { waitUntil: 'load' }); const file = join(dir, 'look-sheet.jpg'); await page.screenshot({ path: file, type: 'jpeg', quality: 85, fullPage: true }); return file; }
  finally { await page.close().catch(() => {}); }
}

/** One line for verify and the repair brief. */
export function lookLine(r) {
  if (r.score === null) return `look: ${r.why}`;
  const top = r.findings.slice(0, 4).map(f => `${f.framing ? `${f.framing}: ` : ''}${f.line}`).join('; ');
  return `${r.score}/100 like its target (${r.confidence}${r.bar ? `; the bar is ${r.bar}` : '; advisory: a target from words'})${top ? `. ${top}` : ''}`;
}

if (isMain(import.meta)) {
  const a = process.argv.slice(2), opt = k => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : null; };
  const VALUED = new Set(['--refs', '--target', '--out', '--frames', '--name', '--json']);
  const dir = a.find((x, i) => !x.startsWith('--') && !VALUED.has(a[i - 1]));
  const framesFile = opt('--frames');
  if (!dir && !framesFile) { console.error('usage: judge.mjs <game-dir> | --frames <frames.json>  [--refs <manifest.json>] [--target <target.json>] [--out <dir>] [--no-vision]'); process.exit(2); }
  let target = opt('--target') ? JSON.parse(await readFile(opt('--target'), 'utf8')) : null;
  if (!target && dir && existsSync(join(dir, 'spec.json'))) target = JSON.parse(await readFile(join(dir, 'spec.json'), 'utf8')).look?.target ?? null;
  const refs = opt('--refs') ? await readManifest(opt('--refs')) : [];
  const game = framesFile ? { frames: await readManifest(framesFile) } : dir;
  const r = await score(game, target, refs, { vision: !a.includes('--no-vision'), outDir: opt('--out') ?? (dir ? join(dir, '.verify', 'look') : null), name: opt('--name') ?? undefined, log: console.log });
  console.log(lookLine(r));
  // the whole record for a caller that ran the judge as its own process (builder/loop/kit.mjs judgeUnder)
  if (opt('--json')) await writeFile(opt('--json'), JSON.stringify(r) + '\n');
  if (r.sheet) console.log(`sheet (local, shows the references): ${r.sheet}`);
  process.exit(r.pass ? 0 : 1);
}
