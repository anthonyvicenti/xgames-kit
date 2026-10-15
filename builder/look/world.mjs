// The world and the camera from a style target (looks wave 2, 2026-10-14). Wave 1 showed that the cheap levers (light,
// grade, outline) barely move a look while the place and the camera dominate it: a fenced yard seen from high and wide
// never reads as islands in a sea seen from low under a big sky. The target says what kind of place its references
// show (`world`: setting, land, horizon, water, relief, sky and clouds, set dressing, the ground's texture scale) and
// how they are framed (`camera`: horizon line, eye height, pitch, fov, distance); this module turns those facts into
// the runtime's own answers, for any game:
//
//   rankWorlds(target, place, {loop})       the runtime's worlds (runtimes/<id>/runtime.json worlds[].reads), best first
//   worldPlan(target, place, opts)          → {template, params, score, ranked, why, notes}: the closest world, shaped by
//                                             the target (a sea-islands world's relief, cliffs, beaches, islands, clouds,
//                                             dressing and ground/cliff pictures); a world with no parameters is chosen
//   cameraOf(target, rig, {framing})        → the rig's numbers (distance, height, pitchDeg, fov): the camera the frames
//                                             were taken from, which players can still move
//   worldLookValues(target)                 → look values the place sets (the sea's colours, the ground's patch scale)
//   dressingOf(words)                       → library prop ids for the target's set dressing, and the words with none
//   specWithWorld(spec, plan)               → the spec with the plan's world (create makes the game from it)
//
// A world the runtime lacks is never refused: the plan names the closest and says what is missing (a build item).
// The legal line holds: the place is described in our own words and built from our own parts and packs.
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { KIT_ROOT } from '../lib/paths.mjs';
import { hexToOklab, oklabToHex } from './stats.mjs';

/** The fog distances the scaling is from (apply.mjs REF: the kit's standard-3d looks in the middle). */
const REF_FOG = { near: 70, far: 240 };

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const r2 = x => Math.round(x * 100) / 100;
const LEVEL = { none: 0, low: 1, mid: 2, high: 3 };
const shade = (hex, dL = 0, k = 1) => { const [L, a, b] = hexToOklab(hex); return oklabToHex([clamp(L + dL, 0, 1), a * k, b * k]); };
const lightOf = hex => hexToOklab(hex)[0];
const okDist = (h1, h2) => { const p = hexToOklab(h1), q = hexToOklab(h2); return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]); };

/** How much each world fact weighs when a target is held against a world's reads. */
export const WEIGHTS = { setting: 3, also: 1, land: 2, horizon: 2, water: 1.5, traits: 1.5, sky: 0.5 };
/** The target's traits (what the place does beyond its shape), in the words a world's reads use. */
export const traitsOf = W => [...(W?.destructible ? ['destructible'] : []), ...(W?.ground?.crossSection ? ['cross-section'] : []), ...(W?.land === 'blocky' ? ['blocky'] : [])];

/** A runtime's worlds with what each reads as (runtimes/<id>/runtime.json), in the place's profile and loop. */
export function worldsOf({ runtime, profile = null } = {}, { loop = null } = {}) {
  const file = path.join(KIT_ROOT, 'runtimes', runtime ?? 'three', 'runtime.json');
  if (!existsSync(file)) return [];
  const R = JSON.parse(readFileSync(file, 'utf8'));
  return (R.worlds ?? []).filter(w => (!w.profiles || !profile || w.profiles.includes(profile)) && (!w.loops || !loop || w.loops.includes(loop)));
}

/** The target's world facts against one world's reads → {score 0–1, parts, why}. */
export function matchWorld(W, reads) {
  if (!W || !reads) return { score: 0, parts: {}, why: 'no facts' };
  const parts = {}, has = (k, v) => v && (reads[k] ?? []).includes(v);
  // a world whose main setting it is fits better than one that also reads as it (a yard: the backyard, then the arena)
  const at = (reads.setting ?? []).indexOf(W.setting);
  parts.setting = at === 0 ? 1 : at > 0 ? 0.85 : (W.also ?? []).some(s => (reads.setting ?? []).includes(s)) ? 0.4 : 0;
  parts.also = (W.also ?? []).length ? (W.also.filter(s => (reads.setting ?? []).includes(s)).length / W.also.length) : 0;
  parts.land = has('land', W.land) ? 1 : 0;
  parts.horizon = has('horizon', W.horizon) ? 1 : 0;
  parts.water = has('water', W.water ?? 'none') ? 1 : 0;
  const tr = traitsOf(W);
  parts.traits = tr.length ? tr.filter(x => (reads.traits ?? []).includes(x)).length / tr.length : (reads.traits ?? []).includes('destructible') ? 0.5 : 1;
  parts.sky = W.sky?.kind && (reads.sky ?? []).length ? ((reads.sky ?? []).includes(W.sky.kind) ? 1 : 0) : 0.5;
  const total = Object.values(WEIGHTS).reduce((a, b) => a + b, 0);
  const score = r2(Object.entries(WEIGHTS).reduce((s, [k, w]) => s + w * (parts[k] ?? 0), 0) / total);
  const why = Object.entries(parts).filter(([k, v]) => v >= 0.85 && k !== 'sky').map(([k]) => `${k} ${k === 'also' ? (W.also ?? []).join('/') : k === 'traits' ? tr.join('/') || 'none' : W[k]}`).join(', ');
  return { score, parts, why: why || 'nothing in common' };
}

/** The runtime's worlds ranked against a target, best first. A tie keeps `current` (the spec's) first. */
export function rankWorlds(target, place, { loop = null, current = null } = {}) {
  const W = target?.world;
  return worldsOf(place, { loop }).map(w => ({ id: w.id, describe: w.describe ?? null, ...matchWorld(W, w.reads) }))
    .sort((a, b) => b.score - a.score || (b.id === current) - (a.id === current));
}

// ---------------------------------------------------------------- colours a place takes from the target's palette
const roleOf = (t, re) => (t.palette?.colors ?? []).filter(c => re.test(c.role ?? ''));
/**
 * The sea's colours: the colour the judge called sea (or water), else the sky's. A colour shared with the sky ("day sky
 * / sea") is the sky's lightness: a painted sea runs deeper and more saturated than the sky over it, so it is deepened.
 */
export function seaColours(t) {
  // the sky stands in only for an open sea (a lake or a pool keeps the look's own water unless the judge named its colour)
  const c = roleOf(t, /\b(sea|water|ocean)\b/i)[0] ?? null, sea = c?.hex ?? (t.world?.water === 'sea' ? t.lighting?.sky?.[0] : null) ?? null;
  if (!sea) return null;
  const shared = !c || /sky/i.test(c.role ?? '');
  return shared ? { deep: shade(sea, -0.1, 1.6), shallow: shade(sea, 0.03, 1.45) } : { deep: shade(sea, -0.08, 1.2), shallow: shade(sea, 0.06, 1.05) };
}
/** The cliffs' strata: the rock, soil and sand colours, light and dark alternating; null when the palette has none. */
export function strataOf(t) {
  const list = roleOf(t, /rock|cliff|soil|canyon|sand|stone|earth|dirt|strata/i).map(c => c.hex);
  if (!list.length) return null;
  const by = [...list].sort((a, b) => lightOf(b) - lightOf(a));
  const out = [];
  for (let i = 0; i < by.length; i++) out.push(i % 2 ? by[by.length - 1 - (i >> 1)] : by[i >> 1]);
  return [...new Set(out)].slice(0, 4);
}
const grassOf = t => roleOf(t, /grass|turf|lawn|meadow/i).map(c => c.hex);
const sandOf = t => roleOf(t, /\b(sand|beach)\b/i)[0]?.hex ?? null;

// ---------------------------------------------------------------- set dressing: words → the library's props
const NOUN = w => w.replace(/ies$/, 'y').replace(/(ch|sh|x)es$/, '$1').replace(/([^s])s$/, '$1');
/**
 * The target's set dressing (plain words, most seen first) → library prop ids (the runtime's packs, by id part and
 * tag), and the words no prop answers (what the art ladder makes: a library swap, then generation).
 * `props`: [{id, tags, fit?}] (default: the library props of `packs` (a look's own) and of the three runtime on this
 * machine, each with its style fit to `target`). A match whose fit is under FIT_FLOOR goes with the missing (`offStyle` says which and why),
 * unless it is from the look's own packs (made from the look's anchor and judged against it).
 */
export async function dressingOf(words = [], { props = null, target = null, minFit = FIT_FLOOR, packs = [], prefer = [] } = {}) {
  if (!props) {
    const [{ assetsIn, localFile, scopePacks }, { styleFit }] = await Promise.all([import('../art/views.mjs'), import('../art/coverage.mjs')]);
    // the look's own packs first (a wave made for it), then the runtime's
    props = assetsIn([...packs, ...scopePacks('three')], { category: 'prop' }).filter(a => localFile(a) && /\.glb$/i.test(a.file))
      .map(a => ({ id: a.id, tags: a.tags ?? [], fit: target ? styleFit(a, target)?.fit ?? null : null, own: packs.includes(a.pack) }));
  }
  const found = [], missing = [], offStyle = [];
  for (const phrase of words) {
    const ws = String(phrase).toLowerCase().split(/[^a-z]+/).filter(w => w.length > 2).map(NOUN);
    // the phrase's head noun is its last word; a match on it beats one on an adjective; among equals the best style fit.
    // `prefer` (ids: a level's own set dressing) is searched first, the rest only when none of it answers
    let best = null, bestScore = 0;
    const first = prefer.length ? props.filter(p => prefer.includes(p.id)) : [];
    for (const p of [...first, ...(first.length ? ['|'] : []), ...props]) {
      if (p === '|') { if (best && bestScore >= 3) break; continue; }
      const parts = p.id.split('-'), tags = p.tags.map(String);
      let s = 0;
      ws.forEach((w, i) => { const head = i === ws.length - 1 ? 3 : 1; if (parts.includes(w)) s += 2 * head; else if (tags.includes(w)) s += head; });
      if (/cloud/.test(p.id)) s = 0;
      const better = s > bestScore || (s === bestScore && s && ((p.fit ?? 0) > (best.fit ?? 0) || ((p.fit ?? 0) === (best.fit ?? 0) && p.id.length < best.id.length)));
      if (better) { best = p; bestScore = s; }
    }
    if (!best || bestScore < 3) { missing.push(phrase); continue; }
    // a match that does not fit the look (a city tower for "onion-dome towers") is left to the art ladder, not placed. A
    // prop of the look's own packs was made from the look's anchor and judged against it there (builder/art/anchor.mjs):
    // the scene-palette measure here reads one object's colours against a whole frame's sky and sea, so it is not held
    // to that floor
    if (best.fit != null && best.fit < minFit && !best.own) { offStyle.push({ phrase, id: best.id, fit: Math.round(best.fit * 100) / 100 }); missing.push(phrase); continue; }
    if (!found.includes(best.id)) found.push(best.id);
  }
  return { ids: found, missing, offStyle };
}
/** The style fit (builder/art/coverage.mjs styleFit) below which a library prop is not placed as a look's set dressing. */
export const FIT_FLOOR = 0.6;

// ---------------------------------------------------------------- the level's composition: its landmarks as pieces
const LANDMARK_KINDS = new Set(['building', 'fortress', 'tower', 'ruin', 'bridge', 'statue', 'ship', 'other']);
// a landmark's words up to its first preposition ("a castle keep with cone-roofed towers" → "a castle keep")
const HEAD_OF = /\b(with|between|on|over|by|of|in|from|under|across|atop|beside|near|along)\b/;
const wordsOf = s => String(s).toLowerCase().split(/[^a-z]+/).filter(w => w.length > 2).map(NOUN);
const meets = (w, part) => w === part || (w.length >= 4 && part.length >= 4 && (w.startsWith(part) || part.startsWith(w)));
/** How well a piece answers a landmark's words: its head (the last word before a preposition, and the kind) counts thrice. */
function landmarkScore(p, words, heads) {
  const parts = p.id.split('-'), tags = (p.tags ?? []).map(String);
  let s = 0;
  for (const w of new Set([...words, ...heads])) {
    const k = heads.includes(w) ? 3 : 1;
    if (parts.some(x => meets(w, x))) s += 2 * k; else if (tags.some(x => meets(w, x))) s += k;
  }
  return s;
}
/**
 * The pieces a target's composition (world.composition: what the play happens on) names: the level's own set dressing
 * first (`dressing`: its ids, already found for this level and its style), then the look's packs and the runtime's for
 * a building or a bridge; trees, crates and the land's own rock (the ground makes those) are never composed. Each piece
 * once. → {landmarks: [id], bridges: [id], missing: [words]} (landmarks in the order the target ranks them)
 */
export async function compositionPieces(t, { dressing = [], packs = [], props = null } = {}) {
  const C = t?.world?.composition;
  const out = { landmarks: [], bridges: [], missing: [] };
  if (!C?.landmarks?.length || C.playOn === 'open') return out;
  if (!props) {
    const { assetsIn, localFile, scopePacks } = await import('../art/views.mjs');
    props = assetsIn([...packs, ...scopePacks('three')], { category: 'prop' }).filter(a => localFile(a) && /\.glb$/i.test(a.file)).map(a => ({ id: a.id, tags: a.tags ?? [] }));
  }
  const NOT = /tree|palm|pine|crate|drum|barrel|cloud/;
  for (const L of C.landmarks) {
    if (L.play === 'far') continue;
    const bridge = L.kind === 'bridge' || /\bbridge/.test(L.what);
    // the heads: the nouns before the first preposition that are plural ("sandstone mesas split"), else its last word,
    // and the kind; the rest of the words count once (the cone roofs tell one castle from another)
    const trimmed = L.what.split(HEAD_OF)[0], toks = String(trimmed).toLowerCase().split(/[^a-z]+/).filter(w => w.length > 2);
    const plural = toks.filter(w => /[^s]s$/.test(w) && w.length > 3).map(NOUN), words = wordsOf(L.what);
    const heads = [...(plural.length ? plural : toks.slice(-1).map(NOUN)), ...(L.kind && L.kind !== 'other' ? [NOUN(L.kind)] : [])];
    const fits = p => !NOT.test(p.id) && (bridge ? /bridge/.test(p.id) : !/bridge/.test(p.id)) && !out.landmarks.includes(p.id) && !out.bridges.includes(p.id);
    const best = list => list.filter(fits).map(p => ({ p, s: landmarkScore(p, words, heads) })).sort((a, b) => b.s - a.s || a.p.id.length - b.p.id.length)[0] ?? null;
    // the level's own pieces answer on any shared word; the rest of the library only on the head (a building or a bridge)
    let got = best(props.filter(p => dressing.includes(p.id)));
    if (!(got?.s >= 3)) got = LANDMARK_KINDS.has(L.kind ?? 'other') ? best(props) : null;
    if (!got || got.s < (dressing.includes(got.p.id) ? 3 : 6)) { out.missing.push(L.what); continue; }
    (bridge ? out.bridges : out.landmarks).push(got.p.id);
  }
  return out;
}

/**
 * terrain.compose from a target and its pieces (worlds/terrain/compose.mjs): what the play happens on, how many bridges,
 * the share of the frame the main landmark takes, and the play camera the seats are framed for. null when the target
 * has no composition or none of its landmarks is in the library.
 */
export function composeOf(t, pieces) {
  const C = t?.world?.composition;
  if (!C || C.playOn === 'open' || !(pieces?.landmarks?.length || pieces?.bridges?.length)) return null;
  const cam = cameraOf(t, 'third')?.settings ?? null;
  return {
    landmarks: pieces.landmarks, bridges: pieces.bridges,
    playOn: C.playOn ?? 'around', share: r2(clamp(C.share ?? 0.25, 0.05, 0.6)), verticality: r2(C.verticality ?? 0.5),
    bridgeCount: pieces.bridges.length ? Math.max(1, Math.min(3, C.bridges ?? 1)) : 0,
    ...(cam ? { camera: { distance: cam.distance, pitchDeg: cam.pitchDeg, fov: cam.fov, ...(cam.height != null ? { height: cam.height } : {}) } } : {}),
    seats: 8,
  };
}

// ---------------------------------------------------------------- world parameters per template
/**
 * A sea-islands world's parameters from a target (worlds/sea.js SEA_PARAMS). art: {ground, soil} pictures the look
 * brings ({ref, tint?} each: library refs, copied into the game by create), dressing: library prop ids.
 */
export function seaParams(t, { art = {}, dressing = [], push = 0, compose = null } = {}) {
  // a composed level (looks wave 4: worlds/sea-compose.mjs): its landmark is the play area's ground, not dressing
  if (compose) dressing = dressing.filter(id => !compose.landmarks.includes(id) && !compose.bridges.includes(id));
  const W = t.world ?? {};
  const land = W.land ?? 'islands';
  const cliff = { floating: 6, cliffs: 5, canyon: 5.5, terraces: 4.5, islands: 4, hills: 2.6, flat: 1.6 }[land] ?? 4;
  const relief = clamp((W.relief ?? (land === 'hills' ? 0.6 : land === 'flat' ? 0.15 : 0.45)) + 0.2 * push, 0, 1);
  const P = {
    relief: r2(relief), cliff, terraces: land === 'terraces' ? 2 : ['cliffs', 'canyon', 'islands'].includes(land) ? 1 : 0,
    beach: sandOf(t) || /beach|sand/i.test((W.words ?? []).join(' ')) ? 0.6 : 0.25,
    islands: Math.round(clamp((W.setting === 'islands' ? 5 : W.setting === 'coast' ? 2 : 3) + 2 * push, 0, 9)),
    clouds: r2(clamp((W.sky?.clouds ?? 0.35) + 0.15 * push, 0, 1)),
    cloudStyle: W.sky?.cloudStyle && W.sky.cloudStyle !== 'layer' && W.sky.cloudStyle !== 'wisp' ? W.sky.cloudStyle : (W.sky?.clouds ?? 0) > 0.05 ? 'puff' : 'none',
    ...(W.sky?.cloudColor ? { cloudColor: W.sky.cloudColor } : {}),
    density: r2(clamp((W.props?.density ?? 0.5) + 0.15 * push, 0, 1)),
    dressing,
    ...(compose ? { compose } : {}),
  };
  // the ground: the picture the look brings over white (its own colours read), else the target's grass colours
  const grass = grassOf(t), tile = groundTileOf(t) * (1 + 0.25 * push);
  const sand = sandOf(t);
  // a calm ground (low detail) takes its picture at part strength over the target's grass colour, so the picture's own
  // busy marks (flowers, blades) soften into the colour the references paint their ground
  const strength = [0.35, 0.55, 0.8, 1][LEVEL[W.ground?.detail ?? 'mid']];
  P.ground = art.ground
    ? { color: grass.length && strength < 1 ? shade(grass[0], 0.1, 0.9) : '#ffffff', color2: grass.length && strength < 1 ? shade(grass[1] ?? grass[0], 0.06, 0.9) : '#f0f0f0', pattern: { file: `library:${art.ground.ref}`, size: r2(tile), ...(strength < 1 ? { strength } : {}) } }
    : grass.length ? { color: grass[0], color2: grass[1] ?? shade(grass[0], -0.06) } : {};
  if (sand) P.ground.beach = shade(sand, 0.12, 0.8);
  // the cliffs: the soil's cross-section picture over the strata the palette holds (or the picture's own colours)
  const strata = strataOf(t);
  P.cliffs = {
    ...(strata ? { strata, color: strata[0] } : {}),
    ...(art.soil ? { pattern: { file: `library:${art.soil.ref}`, size: r2(clamp(cliff * 1.2, 3, 8)) }, ...(strata ? { strata: strata.map(h => shade(h, 0.25, 0.35)) } : {}) } : {}),
  };
  return P;
}

/**
 * A terrain world's parameters (worlds/terrain: smooth ground that blasts carve; spec world.params: the generator's
 * keys, `materials`, `sea` and the look's `scenery`, worlds/scenery.js) from a target: islands or a cliff shore, how
 * high and hilly the land, its top, cliff and soil pictures (the look's art, else the target's colours), an open sea to
 * the horizon, and round it the clouds, the islands out at sea and the set dressing.
 */
export function terrainParams(t, { art = {}, dressing = [], push = 0, compose = null } = {}) {
  const W = t.world ?? {}, land = W.land ?? 'islands';
  const relief = clamp((W.relief ?? 0.5) + 0.2 * push, 0, 1);
  const shape = W.setting === 'coast' || (['cliffs', 'canyon'].includes(land) && W.setting !== 'islands') ? 'cliffs' : 'islands';
  const height = ({ floating: 14, cliffs: 15, canyon: 17, terraces: 13, islands: 11, hills: 9, flat: 5 }[land] ?? 11) * (1 + 0.1 * push);
  const P = {
    shape,
    land: { height: r2(height), hills: Math.round(1 + relief * 5 + push), terraces: land === 'terraces' ? 3 : 0, cliff: ['cliffs', 'canyon'].includes(land) ? 0.85 : 0.7 },
    ...(shape === 'islands' ? { islands: { count: W.setting === 'islands' ? 3 : 2 } } : {}),
    // the seats stand on level pads cut into the land: a body and its camera never stand on a slope
    pads: { count: 8 },
    // level sites for the look's landmarks (worlds/terrain sites): only when it has set dressing to stand on them
    ...(dressing.length ? { sites: { count: 4 } } : {}),
  };
  // a composed level (looks wave 4): its landmarks and bridges are the playfield, made ground by the composer, which
  // seats the players round them; a taller box so a castle has its whole height as ground
  if (compose) {
    P.compose = compose; P.size = [112, 44, 80];
    delete P.pads; delete P.sites;
    dressing = dressing.filter(id => !compose.landmarks.includes(id) && !compose.bridges.includes(id));
  }
  const grass = grassOf(t), strata = strataOf(t), sand = sandOf(t), tile = groundTileOf(t) * (1 + 0.25 * push);
  const M = {};
  if (art.ground) M.top = { from: `library:${art.ground.ref}`, size: r2(tile * 1.5), ...(grass.length ? { color: grass[0] } : {}) };
  else if (grass.length) M.top = { color: grass[0] };
  if (art.soil) M.cliff = { from: `library:${art.soil.ref}`, size: 9, ...(strata ? { color: strata[0] } : {}) };
  else if (strata) M.cliff = { color: strata[0] };
  if (sand) M.sand = { color: shade(sand, 0.12, 0.8) };
  if (Object.keys(M).length) P.materials = M;
  if ((W.horizon ?? 'sea') === 'sea' || W.water === 'sea') P.sea = { size: 1800 };
  P.scenery = {
    clouds: r2(clamp((W.sky?.clouds ?? 0.35) + 0.15 * push, 0, 1)),
    cloudStyle: W.sky?.cloudStyle && !['layer', 'wisp'].includes(W.sky.cloudStyle) ? W.sky.cloudStyle : (W.sky?.clouds ?? 0) > 0.05 ? 'puff' : 'none',
    ...(W.sky?.cloudColor ? { cloudColor: W.sky.cloudColor } : {}),
    islands: W.horizon === 'sea' || W.water === 'sea' ? Math.round(clamp((W.setting === 'islands' ? 5 : 3) + 2 * push, 0, 9)) : 0,
    beach: sand ? 0.6 : 0.25, cliff: r2(height * 0.35), relief: r2(relief), ...(strata ? { strata } : {}),
    props: dressing, density: r2(clamp((W.props?.density ?? 0.5) + 0.15 * push, 0, 1)),
  };
  return P;
}

/** Metres one repeat of the ground's pattern covers: the target's own, else by its detail (busy textures are small). */
export function groundTileOf(t) {
  const g = t.world?.ground ?? {};
  if (g.tile) return clamp(g.tile, 0.5, 40);
  return [8, 6, 4, 2.5][LEVEL[g.detail ?? 'mid']];
}

/** Look values a place sets: the sea's colours, the ground's colour-patch scale and detail. */
export function worldLookValues(t) {
  const v = {}, sea = seaColours(t), g = t.world?.ground ?? {};
  if (sea && (t.world?.water ?? 'none') !== 'none') v.materials = { water: { deep: sea.deep, shallow: sea.shallow } };
  // a sea horizon: a light haze reaches far (islands out at sea stay clear, as a painted sea has them); the distances
  // fall off faster with the haze's density than over land (apply.mjs fog), so a hazy sea still closes in
  if (t.world?.horizon === 'sea') {
    const d = t.lighting?.fog?.density ?? 0.3, f = 2 ** ((0.3 - d) * 7);
    v.fog = { near: Math.round(REF_FOG.near * f), far: Math.round(REF_FOG.far * f) };
  }
  // the ground's patch scale and detail, for painted and flat grounds: a pixel-textured or block world carries its own
  // texels on its faces (the blocky kind keeps its ground plain)
  if (t.world?.ground && t.materials?.texture !== 'pixel' && t.world.land !== 'blocky') {
    v.materials ??= {};
    v.materials.ground = { tile: r2(groundTileOf(t) * 2), ...(g.detail ? { detail: [0.12, 0.25, 0.4, 0.6][LEVEL[g.detail]] } : {}) };
  }
  return v;
}

// ---------------------------------------------------------------- the camera
/** The rigs' defaults (runtimes/three/kit/controller/camera-rig.js RIG_DEFAULTS), what a target's numbers are clamped to. */
const RIG_LIMITS = {
  third: { pitch: [6, 40], distance: [3, 14], height: [1.1, 6], fov: [40, 80] },
  orbit: { pitch: [8, 60], distance: [3, 20], height: [1, 6], fov: [40, 80] },
  top: { pitch: [35, 80], distance: [8, 60], fov: [30, 70] },
  follow: { pitch: [25, 70], distance: [15, 60], fov: [18, 50] },
  first: { fov: [55, 95] },
};
const DIST = { close: 3.5, mid: 6.5, far: 12 };

/** The framing that stands for play: the target's gameplay framing, else the first. */
export function playFraming(t, name = null) {
  const list = t.camera?.framings ?? [];
  return (name && list.find(f => f.name === name)) ?? list.find(f => f.frame === 'gameplay') ?? list[0] ?? null;
}

/**
 * The rig's numbers from a target's camera facts. The pitch comes from where the horizon sits in the frame when the
 * target says (with the fov it fixes the pitch: tan(pitch) = (horizon − 0.5) · 2 · tan(fov / 2)), else from its play
 * framing; the pivot's height from the eye height less what the pitch lifts the camera. Clamped to what the rig plays
 * well at (a third-person rig at less than 6 degrees puts the crosshair at the horizon). → {settings, notes} or null.
 * opts: {framing (a framing's name), eye, distance, pitch (overrides: a reading's camera)}
 */
export function cameraOf(t, rig = 'third', opts = {}) {
  const C = t?.camera;
  if (!C) return null;
  const L = RIG_LIMITS[rig];
  if (!L) return null;
  const f = playFraming(t, opts.framing), notes = [];
  const fov = clamp(f?.fov ?? C.fov ?? 60, ...L.fov);
  if (rig === 'first') return { settings: { fov: Math.round(fov) }, notes: [`fov ${Math.round(fov)}`] };
  let pitch = opts.pitch ?? null;
  if (pitch == null && typeof C.horizon === 'number' && rig !== 'follow' && rig !== 'top' && !opts.framing) {
    pitch = Math.atan((C.horizon - 0.5) * 2 * Math.tan(fov * Math.PI / 360)) * 180 / Math.PI;
    notes.push(`pitch ${pitch.toFixed(1)}° from the horizon at ${Math.round(C.horizon * 100)}% of the frame`);
  }
  pitch ??= f?.pitch ?? C.pitch ?? 16;
  const p = clamp(pitch, ...L.pitch);
  if (p !== pitch) notes.push(`pitch held at ${p}° (the rig's range ${L.pitch.join('–')})`);
  const distance = clamp(opts.distance ?? f?.distance ?? DIST[C.distance] ?? 6, ...L.distance);
  const out = { distance: r2(distance), pitchDeg: r2(p), fov: Math.round(fov) };
  if (L.height) {
    const eye = opts.eye ?? C.eye ?? f?.height ?? null;
    if (eye != null) { out.height = r2(clamp(eye - distance * Math.sin(p * Math.PI / 180), ...L.height)); notes.push(`eye ${eye} m`); }
  }
  return { settings: out, notes };
}

// ---------------------------------------------------------------- the plan
/** Templates that take parameters from a target, and how. */
export const SHAPERS = { 'sea-islands': seaParams, terrain: terrainParams };

/**
 * The world a target asks for on a place: the closest world the runtime has (by the target's world facts), shaped by
 * the target when the world takes parameters. opts: {loop, current (the spec's template), art ({ground, soil}),
 * dressing (library ids), rank (0 the best, 1 the next…), push}. → {template, params, score, ranked, why, notes}
 */
export function worldPlan(target, place, { loop = null, current = null, art = {}, dressing = [], rank = 0, push = 0, compose = null } = {}) {
  const ranked = rankWorlds(target, place, { loop, current });
  if (!target?.world || !ranked.length) return { template: current, params: null, score: null, ranked, why: target?.world ? 'the runtime lists no worlds' : 'the target says nothing about the place', notes: [] };
  const pickd = ranked[Math.min(rank, ranked.length - 1)];
  const notes = [];
  // a world for some loops only (voxel: world) is in the list only when the loop fits; a world of another family is never
  // forced over a better fit: below half the best's score the next one is not worth a pitch
  const shaper = SHAPERS[pickd.id];
  const params = shaper ? shaper(target, { art, dressing, push, compose }) : null;
  if (!shaper) notes.push(`world ${pickd.id} takes no parameters from a target yet: it is chosen as it is`);
  if (pickd.score < 0.5) notes.push(`no world of ${place.runtime}${place.profile ? `/${place.profile}` : ''} reads like the references' place (${target.world.setting ?? '?'}, ${target.world.land ?? '?'} land, a ${target.world.horizon ?? '?'} horizon): ${pickd.id} is the closest (${pickd.score}); build the rest in the game (a build item with closest: ${pickd.id})`);
  return { template: pickd.id, params, score: pickd.score, ranked: ranked.slice(0, 4).map(({ id, score, why }) => ({ id, score, why })), why: `${pickd.id} (${pickd.score}): ${pickd.why}`, notes };
}

/** The spec with a plan's world: its template and params (create makes the game from it); the rest is the spec's. */
export function specWithWorld(spec, plan) {
  if (!plan?.template) return spec;
  const world = { ...(spec.world ?? {}), template: plan.template };
  // a plan with no parameters keeps the spec's own only on the spec's own world (a voxel world's terrain)
  if (plan.params) world.params = plan.params; else if (plan.template !== spec.world?.template) delete world.params;
  return { ...spec, world };
}
