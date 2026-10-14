// A style target on a runtime's cheap levers: target (gf-look-target/1) → the runtime's look values, and (looks wave 2)
// the camera rig's numbers and the look values the place sets (the sea's colours, the ground's patch scale: world.mjs).
// The world itself (which template, its parameters) is the spec's: the look step's options show the world the target
// reads as (world.mjs worldPlan), and the person's pick goes into the spec. No rule of play is touched, players can
// still move the camera, and the spec's own answers win: its preset, palette and time stay, and its `look.values` go
// over everything the target set.
//
//   const values = lookValues(target, { runtime: 'three', profile: 'standard-3d', base });   // pure; base = the look as it stands
//   const { notes } = applyTarget(C, spec, { place });     // create's seam, right after the kind's (kinds/apply.mjs)
//
// The order a game's look is folded in: the preset < the kind's values < the target's values < spec.look.values,
// with spec.look.preset, palette and time answered before any of them.
//
// Three (standard-3d), the levers and how each is read from the target:
//   sky       top / horizon / bottom from the sky region (or the palette colour the judge called sky), the top deeper
//             and the bottom paler, as the presets' skies are
//   fog       the sky's horizon colour (a fog unlike the horizon draws a seam), else the target's fog colour; near and
//             far from fog.density against the look's own distances (0.3 keeps them)
//   sun       key colour, intensity by keyStrength, shadowStrength by contrast, shadowSoftness (the PCF radius) by softness
//   ambient   the fill colour, the ground colour, intensity by contrast (a hard look has less fill)
//   materials toon bands and band softness by shading, roughness, rim and a toon highlight by gloss, on characters,
//             props and the ground
//   post      the ink outline by edges.outline (its colour too), the grade's saturation by the lit pixels' chroma, its
//             temperature by warmth
//   renderer  exposure by the lit pixels' lightness
//   lamps     the colour of local light pools (lighting.local)
//   palette   the HUD accent from ui.accent (the players' colours stay: they tell friends apart)
import { over } from '../../kinds/apply.mjs';
import { hexToOklab, oklabToHex } from './stats.mjs';
import { cameraOf, rankWorlds, worldLookValues } from './world.mjs';
import { levelValues } from './looks.mjs';
import { harmonizeLook } from './harmonize.mjs';

const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const r2 = x => Math.round(x * 100) / 100;
const LEVEL = { none: 0, low: 1, mid: 2, high: 3 };
export const LIT_C = 0.05, LIT_L = 0.6;
/**
 * The levers that scale are set from these, never from the look as it stands, so a target applied twice (create, then
 * a look option over the made game) lands in the same place: what the kit's standard-3d presets hold, in the middle.
 */
export const REF = { sun: 3.2, ambient: 0.55, exposure: 1.1, saturation: 1.12, fogNear: 70, fogFar: 240 };

/** What is mapped per runtime and profile, and what is not yet (said, never silent). */
export const LEVERS = {
  'three/standard-3d': { mapped: ['sky', 'fog', 'sun', 'ambient', 'materials', 'post.outline', 'post.grade', 'renderer.exposure', 'lamps.color', 'palette.accent'] },
  'three/scenic-3d': { mapped: [], skipped: 'the scenic profile keeps its own look shape (profiles/scenic-3d/kit/look/presets.js); not mapped yet' },
  'three/flat-2d': { mapped: [], skipped: 'flat pictures take their look from their art; a palette lever is not mapped yet' },
  forge: { mapped: [], skipped: 'forge looks are its own presets (moonlit-ruins …); not mapped yet' },
  vista: { mapped: [], skipped: 'vista\'s light is the core\'s physical sky; not mapped yet' },
  godot: { mapped: [], skipped: 'not mapped yet' },
};
export const placeKey = ({ runtime, profile = null }) => (runtime === 'three' ? `three/${profile ?? 'standard-3d'}` : runtime);

/** A colour moved in OKLab: dL lightness, k chroma factor. */
export function shade(hex, dL = 0, k = 1) {
  const [L, a, b] = hexToOklab(hex);
  return oklabToHex([clamp(L + dL, 0, 1), a * k, b * k]);
}
/** A colour as a light's colour: its hue and chroma kept, its lightness lifted to `L`. */
export const asLight = (hex, L = 0.8) => { const [, a, b] = hexToOklab(hex); return oklabToHex([L, a, b]); };
const mix = (h1, h2, t) => { const p = hexToOklab(h1), q = hexToOklab(h2); return oklabToHex(p.map((v, i) => v + (q[i] - v) * t)); };
const role = (t, re) => t.palette?.colors?.find(c => re.test(c.role ?? ''))?.hex ?? null;

/**
 * The sky colour a target holds: the judge's open-world sky, else of the measured sky band's big colours, the one nearest the band's mean lightness
 * (frames whose levels swing between skies pool into a band of several), else the colour the judge called sky.
 */
export function skyOf(t) {
  if (t.lighting?.sky?.length) return t.lighting.sky[0];
  const R = t.regions?.sky, big = (R?.colors ?? []).filter(c => c.share >= 0.15);
  if (big.length) return (R.value == null ? big[0] : big.reduce((a, c) => (Math.abs(hexToOklab(c.hex)[0] - R.value) < Math.abs(hexToOklab(a.hex)[0] - R.value) ? c : a))).hex;
  return R?.colors?.[0]?.hex ?? role(t, /\bsky\b|haze/i);
}
const groundOf = t => t.regions?.ground?.colors?.[0]?.hex ?? role(t, /grass|ground|soil|sand|dirt|earth/i);

/**
 * target → look values for the three runtime (standard-3d), over `base` (the look as it stands: the preset at its time
 * with the kind's values). Only what the target holds is set. → {values, levers: [what was set], suggest: {time?}}
 */
export function threeValues(t, base = {}) {
  const v = {}, set = [];
  const sky = skyOf(t);
  if (sky) {
    v.sky = { top: shade(sky, -0.08, 1.15), horizon: shade(sky, 0.07, 0.7), bottom: shade(sky, 0.13, 0.45) };
    set.push('sky');
  }
  const L = t.lighting ?? {};
  if (L.fog || sky) {
    const d = L.fog?.density ?? 0.3, f = 2 ** ((0.3 - d) * 3);
    v.fog = { color: sky ? v.sky.horizon : L.fog.color, near: Math.round(REF.fogNear * f), far: Math.round(REF.fogFar * f) };
    set.push('fog');
  }
  if (L.key || L.keyStrength || L.contrast != null || L.shadowSoftness != null) {
    v.sun = {};
    if (L.key) v.sun.color = L.key;
    if (L.keyStrength) v.sun.intensity = r2(REF.sun * [0.45, 0.75, 1, 1.25][LEVEL[L.keyStrength]]);
    if (L.contrast != null) v.sun.shadowStrength = r2(0.35 + 0.6 * L.contrast);
    if (L.shadowSoftness != null) v.sun.shadowSoftness = r2(0.8 + 3.2 * L.shadowSoftness);
    set.push('sun');
  }
  const ground = groundOf(t);
  if (L.fill || ground || L.contrast != null) {
    v.ambient = {};
    // the fill is read as the shadow side's colour; as a light it keeps its hue at a light's lightness (intensity is its own lever)
    if (L.fill) v.ambient.sky = asLight(sky ? mix(L.fill, sky, 0.35) : L.fill);
    if (ground) { v.ambient.ground = shade(ground, -0.05, 0.8); v.ambient.envGround = shade(ground, 0, 0.7); }
    if (L.contrast != null) v.ambient.intensity = r2(REF.ambient * (1.3 - 0.6 * L.contrast));
    set.push('ambient');
  }
  const M = t.materials ?? {};
  if (Object.keys(M).length) {
    const toon = ['toon', 'soft-toon'].includes(M.shading), flat = ['flat', 'pixel', 'unlit'].includes(M.shading);
    const one = (kind, rimScale) => ({
      ...(M.shading ? { bands: toon ? clamp(M.bands ?? 3, 2, 5) : flat ? clamp(M.bands ?? 0, 0, 2) : 0, bandSoftness: M.shading === 'soft-toon' ? 0.12 : M.shading === 'toon' ? 0.03 : 0.08 } : {}),
      ...(M.roughness != null ? { roughness: r2(M.roughness) } : {}),
      ...(M.rim ? { rim: r2([0, 0.12, 0.3, 0.5][LEVEL[M.rim]] * rimScale) } : {}),
      ...(kind === 'character' && M.gloss ? { toonSpecular: [0, 0.2, 0.45, 0.7][LEVEL[M.gloss]] } : {}),
    });
    v.materials = { character: one('character', 1), prop: one('prop', 0.5), ground: one('ground', 0) };
    set.push('materials');
  }
  const E = t.edges ?? {};
  if (E.outline) {
    v.post = { outline: { strength: [0, 0.35, 0.65, 0.95][LEVEL[E.outline]], thickness: [1, 1, 1.3, 1.8][LEVEL[E.outline]], ...(E.outlineColor ? { color: E.outlineColor } : {}) } };
    set.push('post.outline');
  }
  // the grade and the exposure from the lit pixels (a dark cave frame says how much is dark, not how its light looks):
  // LIT_C and LIT_L are what the kit's standard-3d looks give at their own grade (the blocky kind's renders, 2026-10-14:
  // lit chroma about 0.05, lit lightness about 0.6), so the levers move by the target's ratio to them
  const P = t.palette ?? {}, m = P.mean ?? {};
  if (m.litC != null || P.warmth != null) {
    v.post ??= {};
    v.post.grade = {
      ...(m.litC != null ? { saturation: r2(clamp(REF.saturation * (m.litC / LIT_C) ** 0.7, 0.6, 1.8)) } : {}),
      ...(P.warmth != null ? { temperature: r2(clamp(P.warmth * 0.15, -0.15, 0.15)) } : {}),
    };
    set.push('post.grade');
  }
  if (m.litL != null) { v.renderer = { exposure: r2(REF.exposure * clamp(1 + (m.litL - LIT_L) * 1.2, 0.75, 1.3)) }; set.push('renderer.exposure'); }
  if (L.local?.length) { v.lamps = { color: L.local[0] }; set.push('lamps.color'); }
  if (t.ui?.accent?.[0]) { v.palette = { accent: t.ui.accent[0] }; set.push('palette.accent'); }
  return { values: v, levers: set, suggest: L.time ? { time: L.time } : {} };
}

/** target → look values on a runtime. A runtime with no mapping gives no values and says why. */
export function lookValues(target, { runtime, profile = null, base = {} } = {}) {
  const key = placeKey({ runtime, profile });
  if (key === 'three/standard-3d') return { ...threeValues(target, base), key };
  return { values: {}, levers: [], key, skipped: LEVERS[key]?.skipped ?? 'not mapped' };
}

/** The look as it stands at a time: the base with its time block over it (what applyLook resolves). */
export const resolved = (look, time) => (isObj(look?.times?.[time]) ? over(look, look.times[time]) : look);

/**
 * create's seam (after kinds/apply.mjs applyKind): the spec's look.target, then its look.values, folded into the
 * game's look config (C.look, and its time of day, so a time block never shadows them). The spec's palette stays its
 * own. Changes C in place → {notes, levers}.
 */
export function applyTarget(C, spec, { place }) {
  const notes = [];
  const t = spec?.look?.target, own = spec?.look?.values;
  if (!C?.look || (!t && !own && spec?.look?.harmonize == null)) return { notes, levers: [] };
  const time = C.look.time ?? spec.look?.time ?? 'day';
  const fold = vals => { C.look = over(C.look, vals); if (isObj(C.look.times) && time) C.look.times[time] = over(C.look.times[time] ?? {}, vals); };
  let levers = [];
  if (t) {
    const r = lookValues(t, { ...place, base: resolved(C.look, time) });
    if (r.skipped) notes.push(`look target: ${r.key} ${r.skipped}; the kind's look stands`);
    else {
      if (Array.isArray(spec.look.palette) && spec.look.palette.length) delete r.values.palette;
      fold(r.values); levers = r.levers;
      notes.push(`look target (${t.from}, confidence ${t.confidence}): ${r.levers.join(', ')} set from it${r.suggest.time && r.suggest.time !== time ? `; it reads as ${r.suggest.time}, the spec's time ${time} stands` : ''}`);
    }
  }
  if (t && !LEVERS[placeKey(place)]?.skipped) {
    // the place's look values (the sea, the ground's patch scale) and the camera rig's numbers, after the kind's
    const wv = worldLookValues(t);
    if (Object.keys(wv).length) { fold(wv); levers.push('world.look'); }
    const rig = C.game?.camera, cam = rig ? cameraOf(t, rig) : null;
    if (cam && C.game?.controller) {
      C.game.controller.camera = { ...(C.game.controller.camera ?? {}), [rig]: { ...(C.game.controller.camera?.[rig] ?? {}), ...cam.settings } };
      levers.push('camera'); notes.push(`look target camera (${rig}): ${Object.entries(cam.settings).map(([k, v]) => `${k} ${v}`).join(', ')}${cam.notes.length ? ` (${cam.notes.join('; ')})` : ''}`);
    }
    // the references' looks (levels): each look's values, for a game that switches look per level or round
    // (config/look.json levels and level; the three runtime's look.level(id) restyles to one live)
    const lv = levelValues(t, x => { const r = lookValues(x, { ...place, base: resolved(C.look, time) }); return over(r.values ?? {}, worldLookValues(x)); });
    if (lv) { C.look.levels = lv.levels; C.look.level = lv.level; levers.push('levels'); notes.push(`look target: ${Object.keys(lv.levels).length} looks (${Object.keys(lv.levels).join(', ')}), the game starts in ${lv.level}; look.level(id) switches`); }
    // the world stays the spec's; when the target reads as another of the runtime's worlds, say so (the look step's
    // options show it)
    if (t.world) {
      const best = rankWorlds(t, place, { loop: spec.loop, current: spec.world?.template })[0];
      if (best && best.id !== spec.world?.template) notes.push(`look target: its place reads as ${best.id} (${best.why}); the spec's ${spec.world?.template} stands (the look step's options show ${best.id})`);
    }
  }
  // the style pass (harmonize.mjs): mixed packs' models and pictures moved toward the target's colours and materials at
  // load time, each level its own; on every three profile (a flat game's pictures too), whatever the levers map
  // three's standard-3d and flat-2d carry the pass (gf/three/look); scenic-3d's look is its own (gf/scenic/look) and has
  // no style pass yet, so it is said, never written
  if (place?.runtime === 'three' && place?.profile !== 'scenic-3d') { const h = harmonizeLook(C, spec, { place }); notes.push(...h.notes); if (h.on) levers.push('harmonize'); }
  else if (place?.runtime === 'three') notes.push('the style pass is not in the scenic-3d look yet: mixed packs keep their own colours here');
  if (isObj(own) && Object.keys(own).length) { fold(own); notes.push(`look values from the spec: ${Object.keys(own).join(', ')} (over the kind and the target)`); }
  return { notes, levers };
}
