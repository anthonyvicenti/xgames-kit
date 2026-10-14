// Places from a vocabulary (open builder wave 10, track H; HANDOFF M4-H; the places spike's §6 step 1). Pure: no
// three.js, no DOM, no files; the browser and Node expand a recipe the same way.
//
// A place is a recipe: a list of steps run in order over one seeded random stream. Each step is a word of one small
// vocabulary, in five kinds (GameFactory-3A's gen_3d_scene keeps terrain, layout, sizing and materials apart the same
// way; Apache-2.0, ideas only, nothing ported):
//   ground      rect (rect.js), island (island.js)
//   features    zones, spawns, gates; plaza, portal, paths, spawn-line, arena-zones, water
//   structures  edge, rows, backdrop-ring, climb; islets, floaters
//   sizing      stretch, grow
//   dressing    place, put, pick, scatter (dress.js)
// A number may be per size or an expression over the place's named quantities (values.js); the character's jump
// (jumpUp, jumpAcross: kit/world/reach.js reachNumbers) is one of them, so a climb can be sized by it.
//
//   buildPlace(recipe, {size, seed, players, preset, reach, random})  → the layout (a party place: config/world.json)
//   placeContext({...}) and runSteps(P, steps)                           → for a generator that lays out several levels
//                                                                         over one stream (gf-scenic's generate)
// Who builds through it: kit/world/generate.js (the standard-3d profile's outdoor templates, through from-yard.js) and
// research/gf-scenic/kit/world/generate.js (each island level, from its recipes.js). Each recipe takes its random draws
// in the order the code it replaced took them, so the worlds are the same, byte for byte (tests/d-places.test.mjs).
import { rng as partyRng } from '../layout.js';
import { mulberry32, hashString } from '../../core/rng.js';
import { SIZES } from './values.js';
import { CORE_TESTS, CORE_SPOTS, DRESS_STEPS } from './dress.js';
import { RECT_STEPS } from './rect.js';
import { ISLAND_STEPS, ISLAND_TESTS, ISLAND_SPOTS, ISLAND_DRAWS } from './island.js';

export { val, SIZES } from './values.js';
export * as shapes from './shapes.js';

/** Every word: steps, keep-clear tests, spot sources and random spot drawers. */
export const WORDS = Object.freeze({
  steps: { ...RECT_STEPS, ...ISLAND_STEPS, ...DRESS_STEPS },
  tests: { ...CORE_TESTS, ...ISLAND_TESTS },
  spots: { ...CORE_SPOTS, ...ISLAND_SPOTS },
  draws: { ...ISLAND_DRAWS },
});
export const VOCABULARY = Object.keys(WORDS.steps);

/** The random streams a recipe may name: the party layouts' (kit/world/layout.js rng) and the scenic one (mulberry32). */
export const STREAMS = { party: partyRng, scenic: mulberry32 };

/** A place being laid out. `R` (a random stream) may be given, to share one stream across levels. */
export function placeContext({ recipe = { place: 'place', steps: [] }, size = 'small', seed = 1, players = 4, preset = null, reach = null, R = null, out = {} } = {}) {
  if (!SIZES.includes(size)) throw new Error(`places: unknown size "${size}" (${SIZES.join(', ')})`);
  const stream = STREAMS[recipe.rng ?? 'party'];
  if (!R && !stream) throw new Error(`places: no random stream "${recipe.rng}" (${Object.keys(STREAMS).join(', ')})`);
  return { recipe, size, seed, players, preset, R: R ?? stream(seed), vars: { ...(reach ?? {}) }, out, level: null, taken: [], k: 0, words: WORDS };
}

/** Run steps in order on a place. */
export function runSteps(P, steps) {
  for (const step of steps ?? []) {
    const f = P.words.steps[step.do];
    if (!f) throw new Error(`places: no step "${step.do}" (${VOCABULARY.join(', ')})`);
    if (step.only && !step.only.includes(P.size)) continue;   // a step for some size classes only
    f(P, step);
  }
  return P;
}

/** recipe + size + seed → the layout. The seed defaults to one per place and size. */
export function buildPlace(recipe, { size = 'small', seed = null, players = 4, preset = null, reach = null, R = null } = {}) {
  const s = Number.isFinite(seed) ? seed >>> 0 : hashString(`${recipe.place}|${size}`);
  const P = placeContext({ recipe, size, seed: s, players, preset: preset ?? recipe.preset ?? null, reach, R });
  return runSteps(P, recipe.steps).out;
}
