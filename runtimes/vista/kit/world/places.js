// A place of its own for every vista game (research/super-scenic/WAVE3_PLACES.md, track P). The creator, 2026-10-12:
// "We kept the exact same setting as the demo, we should work on unique setting every time."
//
//   placeRecipe(seed, words = {}) → a plain JSON recipe: everything the core reads for its island's layout
//   REFERENCE                     → the recipe of the core's own island (upstream's, exactly)
//
// The core builds from a recipe through core/src/vista-io.js setPlace(recipe) before the app starts (core patch #6,
// core/PATCHES.md; kit/host.js createVista({ place })). Same seed and words → the same recipe, always (no Math.random,
// no clock). Words, all optional (left out: chosen from the seed):
//   size       small | medium | large             the island (large ≈ the reference, 1.3 km across)
//   peaks      low | high                         how high it rises
//   shape      single | twin | ridge | cliffs | atoll | archipelago | plateau | volcano
//                                                 one summit (a rounded dome or a crown of crags), two, a long ridge,
//                                                 sheer cliffs on one side, a low ring of land round a lagoon, a small
//                                                 island among bigger islets, a flat-topped table mountain, or a
//                                                 volcano with a rock spire on its summit
//   islets     0 | 1 | 2 | 3                      islets offshore
//   coast      smooth | rugged | coves            long even shores, a ragged rocky coast, or one cut by sandy coves
//   bays       0 | 1 | 2 | 3                      coves round the island besides the harbour's bay
//   river      none | yes                         a river mouth: the sea runs up a valley between sandy banks
//   cliffs     none | some | sheer                sea cliffs away from the harbour
//   bay        n | e | s | w | <degrees>          the side of the island the harbour faces (the sun stays the real one)
//   beach      wide | narrow                      the sand round the harbour
//   pier       pier | dock | jetty                a long timber pier, a short timber dock, or a stone / concrete jetty
//   village    none | hamlet | town
//   houses     pastel | whitewash | timber | bright | terracotta   the village's colours and roofs
//   reef       none | small | large
//   water      lagoon | deep | flat               turquoise shallows, deep blue drop-offs, or a wide reef flat
//   sand       white | golden | dark              coral sand, golden sand, dark volcanic sand
//   rock       basalt | limestone                 dark or pale rock
//   vegetation palms | jungle | scrub | cliffs     palm groves, broadleaf jungle, dry scrub and grass, or windswept
//                                                 cliff-top grass with few trees (the core has no conifers)
//   plants     sparse | normal | lush
//   time       dawn | morning | noon | golden | sunset | night     the hour the place is seen at (placeLook)
//   weather    clear | fair | overcast | storm                     the sky and the sea (placeLook)
// time and weather change the look only (kit/look.js values), never the ground; left out, the game's look decides.
//
// Frames. The island is designed in the world (the core's scans cover x ±640, z -880..330, north is -z). The harbour
// sits where the place puts it on the island's coast: recipe.harbour = { x, z, heading } is where upstream's pier foot
// (55, -64) lands and how far its frame is turned (heading 0: the pier runs toward +z, the reference). Everything round
// the harbour (pier, beach zone, valley, village, stalls, boats, start) is designed in that harbour frame, in upstream's
// coordinates, and written into the recipe in world coordinates (the pier, the beach zone and the valley stay in the
// harbour frame: the core reads them there).
//
// Every shape is the core's own generator fed new inputs (its terrain shader, erosion, sand, reef, plants, village
// kit, debris, breakers and shore waves all run on the generated layout); tools/place-check.mjs checks a recipe
// against the heightmap it gives.
import { TerrainData } from '../../core/src/world/TerrainData.js';
import { layoutFromRecipe, activeLayout } from '../../core/src/world/Place.js';
import { mulberry32 } from '../../core/src/util/Noise.js';

export const SCHEMA = 'gf-vista-place/2';

export const WORDS = {
  size: ['small', 'medium', 'large'],
  peaks: ['low', 'high'],
  shape: ['single', 'twin', 'ridge', 'cliffs', 'atoll', 'archipelago', 'plateau', 'volcano'],
  islets: ['0', '1', '2', '3'],
  coast: ['smooth', 'rugged', 'coves'],
  bays: ['0', '1', '2', '3'],
  river: ['none', 'yes'],
  cliffs: ['none', 'some', 'sheer'],
  bay: ['n', 'e', 's', 'w'],
  beach: ['wide', 'narrow'],
  pier: ['pier', 'dock', 'jetty'],
  village: ['none', 'hamlet', 'town'],
  houses: ['pastel', 'whitewash', 'timber', 'bright', 'terracotta'],
  reef: ['none', 'small', 'large'],
  water: ['lagoon', 'deep', 'flat'],
  sand: ['white', 'golden', 'dark'],
  rock: ['basalt', 'limestone'],
  vegetation: ['palms', 'jungle', 'scrub', 'cliffs'],
  plants: ['sparse', 'normal', 'lush'],
  time: ['dawn', 'morning', 'noon', 'golden', 'sunset', 'night'],
  weather: ['clear', 'fair', 'overcast', 'storm'],
};
/** Other words a person may use for the same thing (normalizeWords reads them). */
export const ALIASES = {
  shape: { mesa: 'plateau', table: 'plateau', volcanic: 'volcano', islands: 'archipelago', chain: 'archipelago', lagoon: 'atoll', peak: 'single', dome: 'single' },
  coast: { even: 'smooth', calm: 'smooth', rocky: 'rugged', jagged: 'rugged', ragged: 'rugged', cove: 'coves', inlets: 'coves' },
  river: { no: 'none', false: 'none', '0': 'none', true: 'yes', river: 'yes', estuary: 'yes', creek: 'yes', 'river mouth': 'yes', delta: 'yes' },
  cliffs: { no: 'none', few: 'some', high: 'sheer', tall: 'sheer' },
  time: { sunrise: 'dawn', midday: 'noon', day: 'noon', afternoon: 'golden', evening: 'sunset', dusk: 'sunset', 'golden hour': 'golden', moonlit: 'night' },
  weather: { sunny: 'clear', cloudy: 'overcast', grey: 'overcast', gray: 'overcast', rain: 'overcast', stormy: 'storm', windy: 'storm', calm: 'clear' },
  village: { no: 'none', village: 'hamlet', city: 'town', harbour: 'town', port: 'town' },
};
/** A word the generator knows, or null: the value as given, then its alias (lower case, trimmed). */
export function knownWord(k, v) {
  if (v == null) return null;
  const x = String(v).toLowerCase().trim();
  if (WORDS[k]?.includes(x)) return x;
  const a = ALIASES[k]?.[x];
  return a && WORDS[k].includes(a) ? a : null;
}
const BEARING = { n: 0, ne: 45, e: 90, se: 135, s: 180, sw: 225, w: 270, nw: 315 };

// ------------------------------------------------------------------------------------------------ the reference

// The core's island, exactly (core/src/world/WorldLayout.js, terrain/IslandShape.js, TerrainData.js at upstream
// 4811ba48): applying it changes nothing (tests/places.test.mjs compares it with the core's own defaults, and
// tools/place-identity.mjs the rendered frames).
export const REFERENCE = deepFreeze({
  schema: SCHEMA, name: 'reference', seed: null,
  words: { size: 'large', peaks: 'high', shape: 'single', islets: '0', bay: 's', beach: 'wide', pier: 'pier', village: 'town', houses: 'pastel', reef: 'large', water: 'lagoon', sand: 'white', rock: 'basalt', vegetation: 'palms', plants: 'normal' },
  terrain: { seed: 7 },
  facing: 180, sunTurn: 0,
  coast: { body: [0, -442, 565, 400], lobes: [[-272, -25, 92, 205], [288, -12, 108, 228]], kLobes: 40, kBody: 75, warp: 34, fine: 7 },
  massif: [[0, -442, 640, 470], [-272, -25, 160, 280], [288, -12, 170, 300]],
  headlands: [[-272, -25, 0.9, 0.45, 60, 140], [288, -12, 0.9, 0.45, 60, 150]],
  beachZone: { x: 10, w0: 120, w1: 205, z: -40, s0: 40, s1: 140, l0: -260, l1: -120 },
  valley: { x: 22, z: -100, slant: 0.08, w0: 120, w1: 230, e0: 70, e1: 340 },
  ridges: [
    [[-480, -360, 40], [-380, -410, 110], [-250, -460, 150], [-120, -495, 178], [-35, -510, 215], [50, -495, 176], [150, -470, 168], [270, -430, 124], [400, -360, 60], [470, -320, 25]],
    [[-250, -460, 140], [-262, -340, 100], [-272, -200, 66], [-278, -70, 48, 120], [-274, 60, 36, 100], [-264, 165, 20, 70]],
    [[150, -470, 155], [240, -340, 108], [284, -190, 70], [294, -50, 50, 125], [294, 80, 36, 105], [290, 190, 18, 70]],
    [[-35, -505, 195], [-15, -410, 138], [8, -330, 80, 180], [22, -275, 38, 110]],
    [[-150, -485, 160], [-135, -370, 104], [-118, -280, 44, 120]],
    [[105, -485, 162], [140, -370, 110], [162, -275, 42, 120]],
    [[-110, -500, 170], [-160, -640, 110], [-200, -770, 38]],
    [[50, -495, 168], [115, -630, 112], [165, -765, 38]],
    [[-380, -410, 100], [-440, -560, 56]],
    [[270, -430, 115], [390, -550, 52]],
  ],
  plugs: [[-42, -505, 72, 62], [152, -466, 46, 38], [-238, -458, 40, 26]],
  stacks: [
    [-272, 216, 9, 17], [-300, 196, 6, 11], [-244, 240, 5.5, 8], [-316, 152, 7, 13], [-286, 238, 4, 6],
    [298, 252, 10, 19], [262, 246, 6, 10], [328, 228, 7, 12], [322, 186, 5, 9], [280, 272, 4.5, 7],
  ],
  paths: [
    { w: 1.1, pts: [[21, -56], [20, -68], [18.5, -80], [16.5, -92], [15.5, -100], [20, -102.5], [28, -104.5], [35.5, -108.5]] },
    { w: 0.6, pts: [[42, -116.5], [45.5, -126], [48, -138], [49, -150], [49.5, -162], [47, -175], [41, -188], [36, -199], [31, -212], [33, -224], [26, -236], [20, -247], [24, -258], [16, -270], [11, -283], [15, -296], [8, -309], [4, -322]] },
    { w: 0.9, pts: [[88, -62], [80, -72], [70, -80], [60, -86], [54.5, -90]] },
    { w: 0.8, pts: [[18, -62], [5, -68], [-12, -73], [-30, -77], [-50, -80], [-72, -84]] },
  ],
  beach: { xMin: -150, xMax: 170 },
  pier: { x: 55, zStart: -64, zEnd: 40, deckHeight: 2.3, width: 2.6, headWidth: 14, headDepth: 7, heading: 0 },
  boatDock: { x: 64.5, z: 36.5, heading: 0 },
  village: { center: [40, -118], radius: 95, size: 'town', plan: 'reference' },
  reef: { center: [-78, 58], radius: 58 },
  spawn: { x: 18, z: -60, yaw: Math.PI },
  start: { x: 53.6, z: -77, yaw: Math.PI },
  swellDir: [-0.12, -1],
  plants: 1,
});



// upstream's harbour pieces, in its (and every place's harbour) frame: the reference keeps them where they are
export const HARBOUR = {
  boardwalk: [[55, -65], [54.6, -72], [52.4, -82], [48.4, -92], [44.8, -100.5], [42.6, -107.2]],
  plaza: { x: 41.5, z: -111, r: 6 },
  stall: { x: 40.2, z: -113.2 },
  boathouse: { x: 92.5, z: -57.5, r: 6 },
  fishStand: { x: 49.9, z: -74.6, yaw: 1.45, r: 3 },
  chandlery: { x: 85.5, z: -60.5, yaw: -1.9, r: 2.5 },
};

// ------------------------------------------------------------------------------------------------ helpers

function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); for (const v of Object.values(o)) deepFreeze(v); }
  return o;
}
const clone = o => JSON.parse(JSON.stringify(o));
const r1 = v => Math.round(v * 10) / 10 + 0, r2 = v => Math.round(v * 100) / 100 + 0, r3 = v => Math.round(v * 1000) / 1000 + 0;   // + 0: never -0 (JSON drops its sign)
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const wrapA = a => Math.atan2(Math.sin(a), Math.cos(a));

/** 32-bit hash of a seed (number or text) and the words: the recipe's random stream. */
export function seedHash(seed, salt = '') {
  const s = `${typeof seed === 'number' ? seed : String(seed ?? '')}|${salt}`;
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  h ^= h >>> 15; h = Math.imul(h, 2246822507) >>> 0; h ^= h >>> 13; h = Math.imul(h, 3266489909) >>> 0; h ^= h >>> 16;
  return h >>> 0;
}

function rng(seed) {
  const r = mulberry32(seed);
  const R = () => r();
  R.range = (a, b) => a + (b - a) * r();
  R.int = (a, b) => Math.floor(a + (b - a + 1) * r());
  R.pick = a => a[Math.floor(r() * a.length)];
  R.chance = p => r() < p;
  R.shuffle = a => { const o = a.slice(); for (let i = o.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [o[i], o[j]] = [o[j], o[i]]; } return o; };
  return R;
}

function segDist(px, pz, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz || 1;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / l2));
  return Math.hypot(px - ax - dx * t, pz - az - dz * t);
}
export function polyDist(pts, x, z) {
  let d = Infinity;
  for (let i = 0; i < pts.length - 1; i++) d = Math.min(d, segDist(x, z, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]));
  return pts.length === 1 ? Math.hypot(x - pts[0][0], z - pts[0][1]) : d;
}

/** The harbour frame of a recipe: tw(lx, lz) → world [x, z], tl(wx, wz) → harbour frame (upstream's coordinates). */
export function harbourFrame(recipe) {
  const H = recipe.harbour ?? { x: 55, z: -64, heading: 0 }, c = Math.cos(H.heading), s = Math.sin(H.heading);
  return {
    heading: H.heading,
    tw: (lx, lz) => { const dx = lx - 55, dz = lz + 64; return [H.x + dx * c + dz * s, H.z - dx * s + dz * c]; },
    tl: (wx, wz) => { const dx = wx - H.x, dz = wz - H.z; return [55 + dx * c - dz * s, -64 + dx * s + dz * c]; },
  };
}

/** The words a recipe is made from: defaults from the seed for the ones left out, aliases resolved. */
export function normalizeWords(words = {}, R) {
  const w = {}, pick = (k, opts) => knownWord(k, words[k]) ?? R.pick(opts);
  const given = k => knownWord(k, words[k]) != null;
  w.size = pick('size', WORDS.size);
  w.peaks = pick('peaks', WORDS.peaks);
  w.shape = pick('shape', ['single', 'single', 'twin', 'ridge', 'cliffs', 'atoll', 'archipelago', 'plateau']);
  w.islets = pick('islets', ['0', '0', '1', '1', '2', '3']);
  const b = words.bay ?? words.facing;
  if (typeof b === 'number' && Number.isFinite(b)) w.bay = ((Math.round(b) % 360) + 360) % 360;
  else if (b != null && BEARING[String(b).toLowerCase().trim()] !== undefined) w.bay = String(b).toLowerCase().trim();
  else if (b != null && /^-?\d+(\.\d+)?$/.test(String(b).trim())) w.bay = ((Math.round(Number(b)) % 360) + 360) % 360;
  else w.bay = Math.round(R.range(0, 360));
  w.beach = pick('beach', WORDS.beach);
  w.pier = pick('pier', WORDS.pier);
  w.village = pick('village', ['none', 'hamlet', 'hamlet', 'town', 'town']);
  w.houses = pick('houses', WORDS.houses);
  w.reef = pick('reef', ['none', 'small', 'small', 'large', 'large']);
  w.water = pick('water', WORDS.water);
  w.sand = pick('sand', WORDS.sand);
  w.rock = pick('rock', WORDS.rock);
  w.vegetation = pick('vegetation', WORDS.vegetation);
  w.plants = pick('plants', WORDS.plants);
  // the coast, its coves, a river, cliffs: drawn after the words above so a seed keeps the choices it made before
  w.coast = pick('coast', ['smooth', 'rugged', 'rugged', 'coves']);
  w.bays = given('bays') ? knownWord('bays', words.bays) : w.coast === 'coves' ? R.pick(['2', '3']) : R.pick(['0', '0', '1']);
  if (w.coast === 'coves' && !given('bays') && w.bays === '0') w.bays = '2';
  w.river = pick('river', ['none', 'none', 'yes']);
  w.cliffs = given('cliffs') ? knownWord('cliffs', words.cliffs) : w.shape === 'cliffs' || w.vegetation === 'cliffs' ? 'sheer' : R.pick(['none', 'none', 'some']);
  // the look words are never drawn from the seed: the game's look decides unless the words ask
  for (const k of ['time', 'weather']) { const v = knownWord(k, words[k]); if (v) w[k] = v; }
  // an atoll is low, palm-covered, white-sanded, on a reef flat, unless the words say otherwise
  if (w.shape === 'atoll') {
    if (!given('peaks')) w.peaks = 'low';
    if (!given('water')) w.water = 'lagoon';
    if (!given('sand')) w.sand = 'white';
    if (!given('vegetation')) w.vegetation = 'palms';
    if (!given('reef')) w.reef = 'large';
    if (!given('river')) w.river = 'none';
    if (!given('cliffs')) w.cliffs = 'none';
  }
  if (w.shape === 'archipelago' && !given('size')) w.size = R.pick(['small', 'medium']);
  // dark sand comes from dark rock
  if (w.sand === 'dark' && !given('rock')) w.rock = 'basalt';
  return w;
}

// ------------------------------------------------------------------------------------------------ the place's nature

const SAND = { white: [1, 1, 1], golden: [1.03, 0.86, 0.6], dark: [0.2, 0.19, 0.19] };
const SEABED = { white: [1, 1, 1], golden: [0.98, 0.9, 0.74], dark: [0.34, 0.33, 0.33] };
const ROCK = { basalt: [0.72, 0.72, 0.76], limestone: [2.2, 2.05, 1.8] };
const VEG = {
  palms: { mix: { trees: 0.3, palms: 1.9, shrubs: 0.8, understory: 0.5 }, dry: 0.03, plants: 1 },
  jungle: { mix: { trees: 1, palms: 0.55, shrubs: 1, understory: 1 }, dry: -0.14, plants: 1.4 },
  scrub: { mix: { trees: 0.08, palms: 0.22, shrubs: 0.85, understory: 0.1 }, dry: 0.42, plants: 1 },
  cliffs: { mix: { trees: 0.22, palms: 0.1, shrubs: 0.6, understory: 0.12 }, dry: 0.26, plants: 1 },
};
const SHELF = { lagoon: 1, deep: 2.3, flat: 0.55 };

function nature(W) {
  const v = VEG[W.vegetation];
  return {
    sand: SAND[W.sand], wetSand: SEABED[W.sand], rock: ROCK[W.rock], dry: v.dry, vegMix: v.mix, shelf: SHELF[W.water],
  };
}

// ------------------------------------------------------------------------------------------------ the generator

/**
 * The recipe for an island from a seed and a few words. Pure and deterministic: the same seed and words give the same
 * JSON on any machine (only Math's elementary functions and the core's seeded noise).
 */
export function placeRecipe(seed, words = {}) {
  const R = rng(seedHash(seed, 'place'));
  const W = normalizeWords(words, R);
  const bearing = typeof W.bay === 'number' ? W.bay : BEARING[W.bay];
  const r = {
    schema: SCHEMA, name: `place-${seed}`, seed, words: W,
    terrain: { seed: 11 + Math.floor(R() * 4_000_000) },
    facing: bearing, sunTurn: 0,
    plants: { sparse: 0.55, normal: 1, lush: 1.4 }[W.plants] * VEG[W.vegetation].plants,
    nature: nature(W),
  };
  const D = { R, W };   // the design: what is laid out in the harbour frame, written to the world at the end
  // a harbour whose pier cannot reach water deep enough for the boat (an enclosed, shallow bay) moves a little round the
  // coast and the island is drawn again
  for (let attempt = 0; attempt < 5; attempt++) {
    const b = (bearing + [0, 35, -35, 70, -70][attempt] + 360) % 360;
    r.facing = b;
    island(r, R, W, D, b);
    inBox(r, D);
    r.reef = { center: [0, 2000], radius: 0 };   // until reef() places it: no reef in the probes before then
    fitHarbour(r, D);
    valley(r, R, W, D);
    ridges(r, R, W, D);
    river(r, R, W, D);
    stacks(r, R, W, D);
    pier(r, R, W, D);
    if (D.pierOk || attempt === 4) break;
  }
  reef(r, R, W, D);
  village(r, R, W, D);
  harbourScene(r, R, W, D);
  paths(r, R, W, D);
  finish(r, R, W, D);
  return r;
}

const probeOf = r => TerrainData.probe(layoutFromRecipe(r));
const SIZE = { small: { rx: [270, 330], rz: [215, 255], h: 0.74 }, medium: { rx: [380, 440], rz: [300, 340], h: 0.88 }, large: { rx: [460, 510], rz: [370, 405], h: 1 } };
const BOX = { x0: -600, x1: 600, z0: -850, z1: 300 };   // inside the core's scans, with a margin

// the island: a body somewhere in the box, the harbour on its coast facing the bay's bearing, two capes framing the
// harbour's bay (designed in the harbour frame), more lobes round the rest, islets offshore
function island(r, R, W, D, bearing) {
  const S = SIZE[W.size];
  let rx = R.range(...S.rx), rz = R.range(...S.rz);
  if (R.chance(0.5)) [rx, rz] = [rz * R.range(1, 1.15), rx * R.range(0.85, 1)];   // long either way
  const atoll = W.shape === 'atoll';
  if (atoll) { rx *= 0.72; rz *= 0.72; }
  const arch = W.shape === 'archipelago';
  if (arch) { rx *= 0.6; rz *= 0.6; }   // a small main island among bigger islets
  rx = Math.min(rx, 520); rz = Math.min(rz, 430);   // the scans are 1.2 km across and 1.15 km deep
  // the harbour faces the bay's bearing (north: -z, east: +x); the pier points that way
  const b = bearing * Math.PI / 180, dir = [Math.sin(b), -Math.cos(b)];
  let heading = Math.atan2(dir[0], dir[1]);
  // room on the harbour's side for the capes, the reef and the boat's way out
  const along = Math.abs(dir[0]) * rx + Math.abs(dir[1]) * rz, room = atoll ? 360 : 300;
  const span = Math.abs(dir[0]) * (BOX.x1 - BOX.x0) + Math.abs(dir[1]) * (BOX.z1 - BOX.z0);
  if (2 * along + room > span) { const k = (span - room) / (2 * along); rx *= k; rz *= k; }
  let cx = R.range(-40, 40), cz = -275 + R.range(-40, 40);
  const shoreAt = () => { const t = Math.atan2(dir[1] * rz, dir[0] * rx); return [cx + rx * Math.cos(t), cz + rz * Math.sin(t)]; };
  for (let k = 0; k < 10; k++) {
    const [px, pz] = shoreAt(), fx = px + dir[0] * room, fz = pz + dir[1] * room;
    cx -= Math.max(0, fx - BOX.x1) + Math.min(0, fx - BOX.x0);
    cz -= Math.max(0, fz - BOX.z1) + Math.min(0, fz - BOX.z0);
    cx = clamp(cx, BOX.x0 + rx, BOX.x1 - rx); cz = clamp(cz, BOX.z0 + rz, BOX.z1 - rz);
  }
  r.scale = S.h;
  const body = [r1(cx), r1(cz), r1(rx), r1(rz)];
  // the harbour: upstream's pier foot (55, -64) 21.5 m inland of the shore point, the pier square to the coast
  // (give or take a few degrees: piers are seldom quite square)
  heading = r3(wrapA(heading + R.range(-0.08, 0.08)));
  const [sx, sz] = shoreAt();
  r.harbour = { x: r1(sx - Math.sin(heading) * 21.5), z: r1(sz - Math.cos(heading) * 21.5), heading };
  const F = harbourFrame(r);
  D.F = F; D.dir = dir; D.body = { cx, cz, rx, rz };

  // the beach round the harbour, in the harbour frame (the pier at x 55; upstream's beach runs x -110 .. 130)
  const narrow = W.beach === 'narrow';
  const w0 = narrow ? R.range(52, 78) : R.range(105, 140), w1 = w0 + (narrow ? R.range(50, 70) : R.range(75, 95));
  // the pier sits anywhere along its beach: near one end, or in the middle
  const off = R.range(-0.85, 0.85) * Math.max(0, w0 - 28);
  const bx = clamp(55 - off, -195 + w1, 225 - w1);
  r.beachZone = { x: r1(bx), w0: r1(w0), w1: r1(w1), z: -40, s0: 40, s1: 140, l0: -260, l1: -120 };
  r.beach = { xMin: Math.round(bx - w0 - 10) + 0, xMax: Math.round(bx + w0 + 30) + 0 };

  // two capes beyond the beach (an atoll: long arms curling round a lagoon, their tips nearly meeting)
  const lobes = [], headlands = [], massif = [[body[0], body[1], r1(rx + 75), r1(rz + 70)]];
  const short = !atoll && R.chance(0.3) ? R.pick([-1, 1]) : 0;
  for (const side of [-1, 1]) {
    const broad = !atoll && R.chance(0.35);
    let crx = (broad ? R.range(115, 160) : R.range(65, 112)) * (W.size === 'small' ? 0.75 : 1);
    let crz = (broad ? R.range(105, 160) : R.range(140, 235)) * (W.size === 'small' ? 0.7 : W.size === 'medium' ? 0.85 : 1);
    if (side === short) crz *= R.range(0.45, 0.6);
    let ang = side * R.range(-0.18, 0.5);
    if (atoll) { crx = R.range(45, 70); crz = R.range(250, 330); ang = side * R.range(0.75, 0.95); }
    const rAlong = 1 / Math.hypot(Math.cos(heading) / rx, Math.sin(heading) / rz);   // the body's radius along the coast
    const reach = atoll ? R.range(150, 190) : Math.min(R.range(170, 230), rAlong * R.range(0.45, 0.6));
    const edge = side < 0 ? Math.min(bx - w1, 55 - reach) : Math.max(bx + w1, 55 + reach);
    const ccx = edge + side * (crx * R.range(0.55, 0.95) + R.range(10, 55));
    // the cape grows out of the body: its inland end reaches into the body's shore at its x (an islet otherwise)
    const shoreLz = (() => { for (let m = 150; m > -500; m -= 4) { const [wx, wz] = F.tw(ccx, m); if (((wx - cx) / rx) ** 2 + ((wz - cz) / rz) ** 2 < 1) return m; } return -150; })();
    // from inside the body's shore out to its tip at sea: its length follows where the body's shore is on its line
    const tipZ = side === short ? R.range(-10, 60) : atoll ? R.range(180, 260) : R.range(70, 215);
    const base = Math.max(shoreLz - 40, -360);
    crz = clamp((tipZ - base) / 2, 70, 340);
    const ccz = Math.min((tipZ + base) / 2, 300 - crz);
    // the tip stays out of the boat's way (a curling arm may not cross the pier's line)
    for (let q = 0; q < 8 && Math.abs(ccx - Math.sin(ang) * crz - 55) < 90 + crx; q++) ang *= 0.75;
    const [wx, wz] = F.tw(ccx, ccz);
    lobes.push([r1(wx), r1(wz), r1(crx), r1(crz), r3(wrapA(ang - heading))]);
    headlands.push([r1(wx), r1(wz), 0.6, 0.6, r1(R.range(55, 70)), r1(R.range(140, 165))]);
    const m = Math.max(crx, crz);
    massif.push([r1(wx), r1(wz), r1(m + 70), r1(m + 75)]);
  }
  D.capes = lobes.length;
  // more lobes round the rest of the coast, away from the harbour
  const tH = Math.atan2(dir[1] * rz, dir[0] * rx);
  const n = atoll ? 0 : W.size === 'small' ? R.int(1, 2) : R.int(2, 3);
  const used = [];
  for (let i = 0; i < n * 6 && used.length < n; i++) {
    const a = tH + Math.PI + R.range(-1.9, 1.9);
    if (used.some(u => Math.abs(wrapA(u - a)) < 0.55)) continue;
    const px = cx + Math.cos(a) * rx * 0.86, pz = cz + Math.sin(a) * rz * 0.86;
    const la = R.range(0.26, 0.45) * Math.min(rx, rz), lr = la * R.range(0.55, 0.95);
    const ox = px + Math.cos(a) * la * 0.3, oz = pz + Math.sin(a) * la * 0.3;
    if (ox - la < BOX.x0 || ox + la > BOX.x1 || oz - la < BOX.z0 || oz + la > BOX.z1) continue;
    used.push(a);
    lobes.push([r1(ox), r1(oz), r1(lr), r1(la), r3(a - Math.PI / 2)]);
    massif.push([r1(ox), r1(oz), r1(la + 70), r1(la + 70)]);
  }
  // the coast's character: long even shores, a ragged rocky coast, or the usual mix
  const C = W.coast === 'smooth' ? { kLobes: R.range(55, 75), kBody: R.range(85, 110), warp: R.range(14, 22), fine: R.range(2.5, 4) }
    : W.coast === 'rugged' ? { kLobes: R.range(20, 30), kBody: R.range(40, 55), warp: R.range(55, 72), fine: R.range(9, 12.5) }
      : { kLobes: R.range(32, 48), kBody: R.range(60, 85), warp: R.range(30, 50), fine: R.range(5.5, 8) };
  r.coast = { body, lobes, kLobes: r1(C.kLobes), kBody: r1(C.kBody), warp: r1(C.warp), fine: r1(C.fine) };
  // coves: bays bitten into the coast away from the harbour, each with a sandy shore (core patch #8)
  const coves = [];
  for (let t = 0; t < 60 && coves.length < Number(W.bays); t++) {
    const a = tH + Math.PI + R.range(-2.4, 2.4);
    if (Math.abs(wrapA(a - tH)) < 1.0) continue;   // the harbour's own bay
    if (coves.some(c => Math.abs(wrapA(c.a - a)) < 0.8)) continue;
    const ex = cx + Math.cos(a) * rx, ez = cz + Math.sin(a) * rz;
    const crx = R.range(45, 85) * (W.size === 'small' ? 0.75 : 1), crz = crx * R.range(1.1, 1.6);
    const bite = R.range(0.45, 0.75) * crz;   // how far the cove reaches inland
    coves.push({ a, c: [r1(ex - Math.cos(a) * bite + Math.cos(a) * crz * 0.5), r1(ez - Math.sin(a) * bite + Math.sin(a) * crz * 0.5), r1(crx), r1(crz), r3(a - Math.PI / 2)] });
  }
  if (coves.length) r.coast.coves = coves.map(c => c.c);
  r.massif = massif;
  r.headlands = headlands;
  // islets offshore: small rocks with a crown of plants, clear of the harbour's water and inside the scans
  // (each islet brings its own ring of shallows, which the core's seabed pass pays for: the budget allows fewer round a
  // big island)
  const want = arch ? R.int(3, 5) : Math.min(Number(W.islets), { small: 3, medium: 2, large: 1 }[W.size]) + (atoll ? R.int(2, 4) : 0);
  D.islets = [];
  for (let t = 0; t < 400 && D.islets.length < want; t++) {
    let x, z;
    if (atoll && D.islets.length < want - Number(W.islets)) {   // motus across the lagoon's mouth
      [x, z] = F.tw(55 + R.range(-220, 220), R.range(170, 260));
    } else {
      const a = R.range(0, Math.PI * 2), d = arch ? R.range(1.35, 2.1) : R.range(1.12, 1.55);
      x = cx + Math.cos(a) * rx * d; z = cz + Math.sin(a) * rz * d;
    }
    const rad = atoll ? R.range(18, 36) : arch ? R.range(70, 135) : R.range(24, 58);
    if (x - rad < BOX.x0 + 20 || x + rad > BOX.x1 - 20 || z - rad < BOX.z0 + 20 || z + rad > BOX.z1 - 20) continue;
    const [lx, lz] = F.tl(x, z);
    if (Math.abs(lx - 55) < 70 + rad && lz > -60 && lz < 330) continue;   // the boat's way out
    if (Math.abs(lx - r.beachZone.x) < r.beachZone.w1 + 40 && lz > -80 && lz < 110) continue;   // the bay's water
    if (D.islets.some(q => Math.hypot(q[0] - x, q[1] - z) < q[2] + rad + 40)) continue;
    if (lobes.some(l => Math.hypot(l[0] - x, l[1] - z) < Math.max(l[2], l[3]) + rad + 30)) continue;
    D.islets.push([r1(x), r1(z), r1(rad)]);
    const ang = R.range(-1, 1);
    lobes.push([r1(x), r1(z), r1(rad * R.range(0.7, 1)), r1(rad), r3(ang)]);
    massif.push([r1(x), r1(z), r1(rad + 60), r1(rad + 60)]);
    headlands.push([r1(x), r1(z), 1, 1, r1(rad * 0.5), r1(rad * 1.6)]);
  }
}

// the whole island (body, lobes, islets, the harbour) moved back inside the core's scans if a cape or an islet sticks out
function inBox(r, D) {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  const grow = (x, z, rr) => { x0 = Math.min(x0, x - rr); x1 = Math.max(x1, x + rr); z0 = Math.min(z0, z - rr); z1 = Math.max(z1, z + rr); };
  const [bx, bz, brx, brz] = r.coast.body;
  x0 = bx - brx; x1 = bx + brx; z0 = bz - brz; z1 = bz + brz;
  for (const l of r.coast.lobes) grow(l[0], l[1], Math.max(l[2], l[3]) + 30);
  // (a margin for the coast's noise: more for a rugged coast)
  const pad = Math.max(0, (r.coast.warp ?? 34) - 30) * 2.5;
  const lim = { x0: -590 + pad, x1: 590 - pad, z0: -830 + pad, z1: 280 - pad };
  // too big: everything drawn in toward the body's centre (the harbour stays on the body's shore)
  const k = Math.min(1, (lim.x1 - lim.x0) / (x1 - x0), (lim.z1 - lim.z0) / (z1 - z0));
  if (k < 1) {
    const sc = a => { a[0] = r1(bx + (a[0] - bx) * k); a[1] = r1(bz + (a[1] - bz) * k); };
    r.coast.body[2] = r1(brx * k); r.coast.body[3] = r1(brz * k);
    for (const l of r.coast.lobes) { sc(l); l[2] = r1(l[2] * k); l[3] = r1(l[3] * k); }
    for (const m of r.massif.slice(1)) { sc(m); m[2] = r1(m[2] * k); m[3] = r1(m[3] * k); }
    r.massif[0][2] = r1(r.massif[0][2] * k); r.massif[0][3] = r1(r.massif[0][3] * k);
    r.headlands.forEach(sc); D.islets.forEach(q => { sc(q); q[2] = r1(q[2] * k); });
    const hp = [r.harbour.x, r.harbour.z]; sc(hp); r.harbour.x = hp[0]; r.harbour.z = hp[1];
    D.body.rx *= k; D.body.rz *= k;
    x0 = bx + (x0 - bx) * k; x1 = bx + (x1 - bx) * k; z0 = bz + (z0 - bz) * k; z1 = bz + (z1 - bz) * k;
  }
  const dx = (x0 < lim.x0 ? lim.x0 - x0 : 0) + (x1 > lim.x1 ? lim.x1 - x1 : 0), dz = (z0 < lim.z0 ? lim.z0 - z0 : 0) + (z1 > lim.z1 ? lim.z1 - z1 : 0);
  if (dx || dz) {
    const mv = a => { a[0] = r1(a[0] + dx); a[1] = r1(a[1] + dz); };
    mv(r.coast.body); r.coast.lobes.forEach(mv); r.massif.forEach(mv); r.headlands.forEach(mv); D.islets.forEach(mv);
    r.harbour.x = r1(r.harbour.x + dx); r.harbour.z = r1(r.harbour.z + dz);
    D.body.cx += dx; D.body.cz += dz;
  }
  D.F = harbourFrame(r);
}

// the waterline on the pier's line, moved to upstream's (z -43.5 in the harbour frame) by sliding the harbour along
// its heading: the harbour pieces stand where they were made to stand
function fitHarbour(r, D) {
  for (let k = 0; k < 6; k++) {
    const probe = probeOf(r), F = harbourFrame(r);
    let lo = -160, hi = 140;
    for (let i = 0; i < 40; i++) { const m = (lo + hi) / 2; if (probe.coastDistance(...F.tw(55, m)).d < 0) lo = m; else hi = m; }
    const shore = (lo + hi) / 2, shift = shore + 43.5;
    if (Math.abs(shift) < 1.2) break;
    r.harbour.x = r1(r.harbour.x + Math.sin(r.harbour.heading) * shift);
    r.harbour.z = r1(r.harbour.z + Math.cos(r.harbour.heading) * shift);
  }
  D.F = harbourFrame(r);
}

// the valley the village sits in (the core keeps it free of the massif), and which way the village lies: west of the
// pier, east of it, up the valley behind, spread, or a row along the shore
function valley(r, R, W, D) {
  const lean = W.village === 'none' ? 'none' : R.pick(['west', 'east', 'up', 'spread', 'shore', 'shore']);
  const cxT = { none: 41.5, west: R.range(0, 25), east: R.range(55, 85), up: R.range(30, 55), spread: R.range(30, 55), shore: 55 + R.range(-30, 30) }[lean];
  const czT = { none: -100, west: R.range(-130, -112), east: R.range(-130, -112), up: R.range(-155, -132), spread: R.range(-132, -118), shore: R.range(-108, -100) }[lean];
  r.valley = { x: r1(cxT - 18 + R.range(-10, 10)), z: -100, slant: r2(R.range(-0.1, 0.14)), w0: r1(R.range(110, 135)), w1: 0, e0: 70, e1: r1(R.range(290, 360)) };
  r.valley.w1 = r1(r.valley.w0 + 110);
  D.lean = { lean, cxT, czT };
}

// the ridge skeleton (world): a divide behind the harbour across the island, its profile by the shape (one summit, two,
// a long even ridge, a low atoll), spurs into the capes and lobes, spurs framing the valley, rock plugs on the summits,
// sheer cliffs on one side
function ridges(r, R, W, D) {
  const { cx, cz, rx, rz } = D.body, F = D.F, dir = D.dir;
  const atoll = W.shape === 'atoll';
  const H = atoll ? R.range(14, 24) : (W.peaks === 'high' ? R.range(185, 260) : R.range(95, 140)) * r.scale;
  let probe = probeOf(r);
  const inside = (x, z, m) => probe.coastDistance(x, z).d < -m;
  const pullIn = (x, z, m) => { for (let k = 0; k < 30 && !inside(x, z, m); k++) { x += (cx - x) * 0.08; z += (cz - z) * 0.08; } return [x, z]; };
  const radiusAlong = (ux, uz) => 1 / Math.hypot(ux / rx, uz / rz);
  const out = [];
  // the divide: across the body, parallel to the harbour's coast, set back from it
  const ux = -dir[1], uz = dir[0];   // along the coast
  const half = radiusAlong(ux, uz) * 0.84, back = radiusAlong(dir[0], dir[1]) * R.range(0.05, 0.22);
  const ox = cx - dir[0] * back, oz = cz - dir[1] * back;
  // the summit sits to one side (a centred cone is the reference's own picture), its crown a dome or crags
  const n = 9, sumAt = R.chance(0.5) ? R.range(0.2, 0.38) : R.range(0.62, 0.8), wob = R.range(10, 35) * r.scale, tilt = R.range(-0.15, 0.15);
  const crown = W.shape === 'volcano' ? 'spire' : W.shape === 'plateau' ? 'table' : R.pick(['dome', 'crags', 'crags']);
  D.crown = crown;
  const profile = t => {
    if (W.shape === 'plateau') return 0.3 + 0.7 * Math.min(1, Math.max(0, 1 - Math.abs(t - 0.5) * 2) * 2.6);
    if (crown === 'dome' && W.shape !== 'twin' && W.shape !== 'ridge') { const k = Math.max(0, 1 - Math.abs(t - sumAt) / Math.max(sumAt, 1 - sumAt)); return 0.18 + 0.82 * (1 - (1 - k) ** 2.2); }
    if (W.shape === 'twin') { const a = Math.exp(-((t - 0.28) ** 2) / 0.012), b = Math.exp(-((t - 0.72) ** 2) / 0.012); return 0.2 + 0.8 * Math.max(a, b * R.range(0.85, 1)); }
    if (W.shape === 'ridge') return 0.2 + 0.8 * Math.min(1, Math.max(0, 1 - Math.abs(t - 0.5) * 2.2) * 2.2);
    const k = 1 - Math.abs(t - sumAt) / Math.max(sumAt, 1 - sumAt);
    return 0.18 + 0.82 * Math.pow(Math.max(0, k), 0.8);
  };
  const div = [];
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1), a = (t - 0.5) * 2 * half;
    const x = ox + ux * a - dir[0] * (Math.sin(t * 7.1 + R() * 2) * wob + a * tilt), z = oz + uz * a - dir[1] * (Math.sin(t * 7.1 + R() * 2) * wob + a * tilt);
    let h = H * profile(t) * R.range(0.88, 1.06);
    if (i === 0 || i === n - 1) h = Math.min(h, H * 0.22);
    const [px, pz] = pullIn(x, z, 30 + h * 0.4);
    div.push([r1(px), r1(pz), r1(h)]);
  }
  out.push(div);
  const near = (x, z) => div.reduce((a, b) => (Math.hypot(b[0] - x, b[1] - z) < Math.hypot(a[0] - x, a[1] - z) ? b : a));
  // the harbour's bay stays open: crests near it keep a narrow foot
  const bz = r.beachZone;
  const nearBay = (x, z) => { const [lx, lz] = F.tl(x, z); return lz > -170 && Math.abs(lx - bz.x) < bz.w1 + 120; };
  r.coast.lobes.forEach(([lx, lz, lrx, lrz, la = 0], li) => {
    if (D.islets.some(q => q[0] === lx && q[1] === lz)) return;
    const s = near(lx, lz), tipx = lx - Math.sin(la) * lrz * 0.78, tipz = lz + Math.cos(la) * lrz * 0.78;
    const hx = s[2] * R.range(0.62, 0.85), pts = [[s[0], s[1], r1(hx)]];
    // a lobe's own tip: on the side away from the body
    const out1 = Math.hypot(tipx - cx, tipz - cz) > Math.hypot(lx - cx, lz - cz) ? [tipx, tipz] : [lx + Math.sin(la) * lrz * 0.78, lz - Math.cos(la) * lrz * 0.78];
    const via = [[(s[0] + lx) / 2 + R.range(-25, 25), (s[1] + lz) / 2], [lx, lz], [(lx + out1[0]) / 2, (lz + out1[1]) / 2], out1];
    via.forEach(([x, z], i) => {
      const t = (i + 1) / via.length;
      const h = Math.max(li < D.capes ? (atoll ? 6 : 16) : 22, hx * (1 - t * 0.82) * R.range(0.88, 1.1));
      const [px, pz] = pullIn(x, z, 10 + h * 0.25);
      const p = [r1(px), r1(pz), r1(h)];
      if (nearBay(px, pz)) p.push(r1(Math.min(2.5 * h + 50, Math.max(70, lrx * 1.15))));
      pts.push(p);
    });
    out.push(pts);
  });
  // behind the village: a central spur and two framing the valley, ending well inland of the houses
  const V = r.valley, [, divLz] = F.tl(ox, oz);
  const endZ = Math.min(-245, divLz + 140);
  if (!atoll && endZ > divLz + 60) {
    for (const [o, hEnd, wEnd] of [[R.range(-15, 15), R.range(34, 42), 110], [-R.range(130, 175), R.range(38, 46), 120], [R.range(130, 175), R.range(38, 46), 120]]) {
      const [ex, ez] = F.tw(V.x + o, endZ + R.range(-25, 0));
      if (!inside(ex, ez, 40)) continue;
      const s = near(ex, ez);
      const mh = Math.max(hEnd * 1.6, s[2] * 0.6);
      out.push([[s[0], s[1], r1(s[2] * 0.9)], [r1((s[0] + ex) / 2 + R.range(-20, 20)), r1((s[1] + ez) / 2), r1(mh), r1(1.4 * mh + 50)], [r1(ex), r1(ez), r1(hEnd), wEnd]]);
    }
  }
  // spurs to the far coast
  for (let i = 0, k = R.int(2, 3); i < k; i++) {
    const s = div[R.int(1, n - 2)], a = Math.atan2(-dir[1], -dir[0]) + R.range(-1.1, 1.1);
    const [px, pz] = pullIn(cx + Math.cos(a) * rx * 0.8, cz + Math.sin(a) * rz * 0.8, 25);
    out.push([[s[0], s[1], r1(s[2] * 0.85)], [r1((s[0] + px) / 2 + R.range(-30, 30)), r1((s[1] + pz) / 2), r1(s[2] * 0.55)], [r1(px), r1(pz), r1(Math.max(atoll ? 8 : 25, s[2] * 0.2))]]);
  }
  // islets: a small crest each
  for (const [x, z, rad] of D.islets) {
    if (W.shape === 'archipelago') {   // islands of their own: a crest across each, as high as its size allows
      const a = R.range(0, Math.PI), hh = Math.min(rad * R.range(0.55, 0.95), H * 0.8), ex = Math.cos(a) * rad * 0.45, ez = Math.sin(a) * rad * 0.45;
      out.push([[r1(x - ex), r1(z - ez), r1(hh * R.range(0.4, 0.7)), r1(rad * 0.9)], [r1(x + ex * R.range(-0.3, 0.3)), r1(z + ez * R.range(-0.3, 0.3)), r1(hh), r1(rad * 1.05)], [r1(x + ex), r1(z + ez), r1(hh * R.range(0.3, 0.6)), r1(rad * 0.9)]]);
      continue;
    }
    out.push([[r1(x - rad * 0.3), r1(z), r1(atoll ? R.range(5, 9) : R.range(14, 34))], [r1(x + rad * 0.3), r1(z + rad * 0.2), r1(atoll ? 5 : R.range(10, 22)), r1(rad * 1.1)]]);
  }
  // cover the rest: land the crests' feet do not reach would stay a smooth slope
  r.ridges = out;
  for (let pass = 0; pass < 10 && !atoll; pass++) {
    const pr = probeOf(r);
    let worst = null, bare = 0, land = 0;
    for (let z = BOX.z0; z < BOX.z1 + 30; z += 32) for (let x = BOX.x0; x < BOX.x1; x += 32) {
      if (nearBay(x, z)) continue;
      if (D.islets.some(q => Math.hypot(q[0] - x, q[1] - z) < q[2] + 60)) continue;
      const d = pr.coastDistance(x, z).d;
      if (d > -20) continue;
      land++;
      if (pr.envelope(x, z) > (d > -170 ? 34 : 8)) continue;
      bare++;
      let gap = Infinity;
      for (const pl of out) for (const p of pl) gap = Math.min(gap, Math.hypot(p[0] - x, p[1] - z));
      if (!worst || gap > worst.gap) worst = { x, z, gap };
    }
    if (!worst || bare / Math.max(1, land) < 0.02) break;
    const s = near(worst.x, worst.z);
    const [px, pz] = pullIn(worst.x, worst.z, 30);
    out.push([[s[0], s[1], r1(s[2] * 0.8)], [r1((s[0] + px) / 2 + R.range(-25, 25)), r1((s[1] + pz) / 2 + R.range(-25, 25)), r1(Math.max(40, s[2] * 0.5))], [r1(px), r1(pz), r1(Math.max(30, s[2] * 0.28))]]);
  }
  r.ridges = out;
  // the crown: a volcano's rock spire on its summit (twin: both), a crown of small crags along the top of the divide,
  // a rounded dome with none, or a table mountain's flat top (the massif clipped, core patch #8)
  const plugs = [];
  if (crown === 'table') r.tableTop = r1(H * R.range(0.4, 0.5));
  if (crown === 'crags' && !atoll) {
    const top = div.filter(p => p[2] > H * 0.5);
    for (const p of R.shuffle(top).slice(0, R.int(2, 4))) plugs.push([r1(p[0] + R.range(-20, 20)), r1(p[1] + R.range(-20, 20)), r1(R.range(13, 24) * Math.max(0.75, r.scale)), r1(R.range(9, 20) * r.scale)]);
  }
  if (crown === 'spire' && !atoll) {
    const big = W.peaks === 'high';
    const tops = W.shape === 'twin' ? div.slice().sort((a, b) => b[2] - a[2]).filter((p, i, a) => i === 0 || Math.hypot(p[0] - a[0][0], p[1] - a[0][1]) > half * 0.5).slice(0, 2) : [div.reduce((a, b) => (b[2] > a[2] ? b : a))];
    for (const p of tops) plugs.push([p[0], p[1], r1(R.range(big ? 52 : 34, big ? 76 : 48) * Math.max(0.75, r.scale)), r1(R.range(big ? 40 : 18, big ? 66 : 30) * r.scale * (W.shape === 'ridge' ? 0.5 : 1))]);
    const others = R.shuffle(div.filter(p => !tops.includes(p) && p[2] > H * 0.55)).slice(0, big ? R.int(0, 2) : R.int(0, 1));
    for (const p of others) plugs.push([p[0], p[1], r1(R.range(32, 50) * Math.max(0.75, r.scale)), r1(R.range(18, 38) * r.scale)]);
  }
  r.plugs = plugs;
  // sheer cliffs on one side, away from the harbour
  r.cliffs = [];
  if (W.cliffs !== 'none') {
    const sheer = W.cliffs === 'sheer';
    const t0 = Math.atan2(dir[1] * rz, dir[0] * rx) + Math.PI + R.range(-1.3, 1.3), spanA = sheer ? R.range(0.6, 1.0) : R.range(0.3, 0.5);
    for (let i = 0, m = sheer ? R.int(3, 5) : R.int(2, 3); i < m; i++) {
      const t = t0 + (i / (m - 1) - 0.5) * spanA;
      const x = cx + Math.cos(t) * rx, z = cz + Math.sin(t) * rz;
      const [lx, lz] = F.tl(x, z);
      if (lz > -200 && Math.abs(lx - 55) < 260) continue;   // never round the harbour
      if (Math.abs(x) > 540 || z < -800 || z > 250) continue;   // clear of the scans' edge (a wall's rubble spreads)
      r.cliffs.push([r1(x), r1(z), r1(R.range(90, 140)), r1(R.range(45, 95) * (W.peaks === 'low' ? 0.7 : 1) * (sheer ? 1 : 0.55))]);
    }
  }
}

// a river mouth (core patch #8): from the coast beyond one end of the harbour's beach up the gentlest ground inland,
// carved below the sea so the sea runs up it between sandy banks. In the harbour frame; written to the world. A place
// whose ground gives no room for one says so in its words (river: none)
function river(r, R, W, D) {
  r.rivers = [];
  D.river = null;
  if (W.river !== 'yes') return;
  const probe = probeOf(r), F = D.F, bz = r.beachZone;
  const hL = (x, z) => probe.heightFn(...F.tw(x, z)).h;
  let best = null;
  for (const side of R.shuffle([-1, 1])) {
    for (let t = 0; t < 6 && !best; t++) {
      const mx = bz.x + side * (bz.w0 + R.range(10, 70));
      if (Math.abs(mx - 55) < 75) continue;   // never the pier's water
      // the waterline on this line, then a little out to sea
      let mz = null;
      for (let z = 60; z > -220; z -= 2) if (hL(mx, z) > 0.4) { mz = z + 30; break; }
      if (mz == null || mz < -200) continue;
      const pts = [[mx, mz]];
      let x = mx, z = mz - 30, a = 0;   // a: the heading off inland (-z), radians
      pts.push([x, z]);
      const len = R.range(260, 460);
      for (let s = 0; s < len; s += 22) {
        let pick = null;
        for (const da of [0, -0.35, 0.35, -0.7, 0.7]) {
          const na = clamp(a + da + R.range(-0.12, 0.12), -1.1, 1.1);
          const nx = x + Math.sin(na) * 22, nz = z - Math.cos(na) * 22, h = hL(nx, nz);
          if (Math.hypot(nx - 55, nz + 64) < 80) continue;   // never near the pier's foot
          if (!pick || h < pick.h - 1) pick = { nx, nz, na, h };
        }
        if (!pick || pick.h > 30) break;
        x = pick.nx; z = pick.nz; a = pick.na * 0.85;
        pts.push([x, z]);
      }
      if (pts.length >= 8) best = { pts, side };
    }
    if (best) break;
  }
  if (!best) { r.words.river = 'none'; return; }
  const w0 = R.range(15, 24), w1 = R.range(5, 8.5);
  D.river = { pts: best.pts, w0, w1, side: best.side };
  r.rivers = [{ pts: best.pts.map(([x, z]) => F.tw(x, z).map(r1)), w0: r1(w0), w1: r1(w1) }];
}

// sea stacks off the capes' and lobes' tips, in water, clear of the boat's way out
function stacks(r, R, W, D) {
  const probe = probeOf(r), F = D.F, out = [];
  r.coast.lobes.forEach(([lx, lz, lrx, lrz, la = 0], i) => {
    const isle = D.islets.some(q => q[0] === lx && q[1] === lz);
    const cape = i < D.capes, count = W.shape === 'atoll' ? R.int(0, 1) : cape ? R.int(3, 6) : isle ? R.int(0, 2) : R.int(0, 3);
    for (const sgn of [1, -1]) {
      const tipx = lx - sgn * Math.sin(la) * lrz, tipz = lz + sgn * Math.cos(la) * lrz;
      if (Math.hypot(tipx - D.body.cx, tipz - D.body.cz) < Math.hypot(lx - D.body.cx, lz - D.body.cz) && !isle) continue;
      for (let k = 0, tries = 0; k < count && tries < 60; tries++) {
        const a = R.range(0, Math.PI * 2), d = R.range(15, 75);
        const x = tipx + Math.cos(a) * d, z = tipz + Math.sin(a) * d;
        const c = probe.coastDistance(x, z).d;
        if (c < 6 || c > 70) continue;
        const [hx, hz] = F.tl(x, z);
        if (Math.abs(hx - 55) < 60 && hz > -60) continue;   // the boat's lane out of the bay
        if (out.some(s => Math.hypot(s[0] - x, s[1] - z) < s[2] + 12)) continue;
        if (x < -640 || x > 640 || z > 330 || z < -880) continue;
        const rad = R.range(4, 10), h = rad * R.range(1.3, 2) * (W.peaks === 'low' ? 0.8 : 1);
        out.push([r1(x), r1(z), r1(rad), r1(h)]);
        k++;
      }
      break;
    }
  });
  r.stacks = out;
}

// the pier: its kind and its length from the water's depth (in the harbour frame)
function pier(r, R, W, D) {
  const probe = probeOf(r), F = D.F;
  const depth = (lx, lz) => -probe.heightFn(...F.tw(lx, lz)).h;
  const kind = W.pier;
  const spec = kind === 'jetty' ? { width: R.range(3.6, 4.6), headWidth: R.range(11, 16), headDepth: R.range(7, 10), deckHeight: r2(R.range(1.8, 2.2)) }
    : kind === 'dock' ? { width: R.range(2.2, 2.6), headWidth: 14, headDepth: 7, deckHeight: 2.3 }
      : { width: 2.6, headWidth: 14, headDepth: 7, deckHeight: 2.3 };
  const [d0, d1] = W.water === 'flat' ? [2.6, 3.6] : kind === 'dock' ? [2.9, 3.8] : [3.6, 5.0];
  let want = d0 + (seedHash(r.seed, 'pier') % 1000) / 1000 * (d1 - d0), zHead = -43.5 + 80;
  const headSpan = zh => {
    let lo = Infinity, hi = -Infinity;
    for (let dx = -spec.headWidth / 2; dx <= spec.headWidth / 2; dx += spec.headWidth / 4) for (let dz = -spec.headDepth / 2; dz <= spec.headDepth / 2; dz += spec.headDepth / 2) { const d = depth(55 + dx, zh + dz); lo = Math.min(lo, d); hi = Math.max(hi, d); }
    // and the boat's berth beside the head
    for (let dx = -2; dx <= 2; dx += 2) for (let dz = -5; dz <= 5; dz += 2.5) lo = Math.min(lo, depth(55 + spec.headWidth / 2 + 2.5 + dx, zh + dz) + 0.1);
    return [lo, hi];
  };
  for (let tries = 0; tries < 5; tries++, want -= 0.3) {
    let z = -43.5 + 20, deepest = [z, -1];
    while (z < -43.5 + 330 && depth(55, z) < want) { const d = depth(55, z); if (d > deepest[1]) deepest = [z, d]; z += 0.5; }
    if (z >= -43.5 + 330) z = deepest[0];   // a reef flat: the deepest water the pier can reach
    zHead = z;
    const [lo, hi] = headSpan(z);
    if (lo >= (kind === 'dock' ? 2.4 : 2.8) && hi <= 6.2) break;
  }
  { const [lo] = headSpan(zHead); D.pierOk = lo >= (W.water === 'flat' ? 1.5 : 2.1); }
  const zEnd = r1(zHead + spec.headDepth / 2);
  r.pier = { x: 55, zStart: -64, zEnd, deckHeight: spec.deckHeight, width: r2(spec.width), headWidth: r2(spec.headWidth), headDepth: r2(spec.headDepth), heading: 0, kind };
  // the draw stays so every other choice keeps its seed; the gate-and-sign arch is the reference's own picture, so a
  // generated pier never carries it (a player who saw the reference first would know it at once)
  if (kind === 'pier') R.chance(0.4);
  D.pier = { kind, arch: false, style: R.pick(['stone', 'stone', 'concrete']) };
  // the boat moored on the head's east side
  D.dockL = [55 + spec.headWidth / 2 + 2.5, zEnd - spec.headDepth / 2];
}

// the reef: offshore beside the pier (in the harbour frame), in 3 to 8 m of water, clear of the pier's channel
function reef(r, R, W, D) {
  const F = D.F;
  if (W.reef === 'none') {
    // no reef: radius 0 (the core raises no platform, grows no corals and tints no seabed; its reef fish keep a spot
    // of sandy bay to school over)
    r.reef = { center: F.tw(55 + R.pick([-1, 1]) * R.range(80, 120), R.range(50, 80)).map(r1), radius: 0, none: true };
    return;
  }
  const probe = probeOf(r);
  const cL = (x, z) => probe.coastDistance(...F.tw(x, z)).d, dL = (x, z) => -probe.heightFn(...F.tw(x, z)).h;
  const rad0 = (W.reef === 'large' ? R.range(52, 68) : R.range(34, 44)) * (W.water === 'flat' ? 1.25 : 1);
  const sides = R.shuffle([-1, 1]);
  const deepMax = W.water === 'deep' ? 17 : 13.5;   // on a drop-off the reef's seaward slope goes deeper
  let best = null;
  for (const [k, w0, w1] of [[1, 4, 6.5], [0.85, 4, 6.5], [0.72, 4, 6.5], [1, 2.6, 4], [0.8, 2.6, 4], [0.6, 2.6, 4], [0.5, 2.4, 4.5], [0.42, 2.4, 4.5]]) {
    const rad = rad0 * k;
    for (const side of sides) {
      for (let t = 0; t < 70 && !best; t++) {
        const x = 55 + side * (rad + R.range(20, 170));
        const want = R.range(w0, w1);
        let z = null;
        for (let zz = -30; zz < 260; zz += 2) { if (dL(x, zz) >= want && cL(x, zz) > 20) { z = zz; break; } }
        if (z == null || z < 0 || z > 255) continue;
        let ok = dL(x, z) <= 8;
        for (let q = 0; q < 16 && ok; q++) {
          const a = q / 16 * Math.PI * 2;
          for (const f of [0.55, 1]) {
            const px = x + Math.cos(a) * rad * f, pz = z + Math.sin(a) * rad * f;
            const d = dL(px, pz);
            if (cL(px, pz) < 10 || d > deepMax || d < 1.5) ok = false;
          }
        }
        if (ok) {
          // and with its own platform raised (the core lifts the seabed 1.2 - 4 m under a reef): still under water
          const withReef = TerrainData.probe(layoutFromRecipe({ ...r, reef: { center: F.tw(x, z), radius: rad } }));
          for (let q = 0; q < 12 && ok; q++) {
            const a = q / 12 * Math.PI * 2;
            for (const f of [0, 0.3, 0.6]) { const d = -withReef.heightFn(...F.tw(x + Math.cos(a) * rad * f, z + Math.sin(a) * rad * f)).h; if (d < 2.2 || d > deepMax) ok = false; }
          }
        }
        if (ok) best = [x, z, rad];
      }
    }
    if (best) break;
  }
  if (!best) { r.reef = { center: F.tw(-45, 60).map(r1), radius: 0, none: true }; r.words.reef = 'none'; return; }
  r.reef = { center: F.tw(best[0], best[1]).map(r1), radius: r1(best[2]) };
  if (W.reef === 'large' && best[2] < 46) r.words.reef = 'small';   // what fitted the bay (said, not hidden)
}

// ------------------------------------------------------------------------------------------------ the village

// house styles: the core's own fourteen houses (world/Village.js), without their place; colours are 0xRRGGBB (sRGB)
const P = { turquoise: 0x5dbcb0, coral: 0xec8b76, cream: 0xefe2c2, sky: 0x8cc2e0, yellow: 0xf0cf7c, mint: 0xa9dcbf, pink: 0xf2b3aa, white: 0xf1ede2, lavender: 0xbdb3da, sea: 0x6aa6b8 };
const T = { white: 0xf3efe6, cream: 0xe9dfc6, navy: 0x2e4f73, teal: 0x2d7f7a, red: 0xa8463a, green: 0x4c7d4c, yellow: 0xe0b545, blue: 0x3f79ae };
const RF = { red: 0xa64a35, green: 0x5f8a6a, blue: 0x4f7898, teal: 0x3f8a86, rust: 0x8a5a40, grey: 0x8c9296 };
const HOUSES = [
  { w: 6.2, d: 5.0, roof: 'gable', roofMat: 'metal', siding: 1, porch: { depth: 2.1, rail: 'balusters' }, paint: 0.62, stovepipe: true, buoys: -1, porchPaint: 0x8a9aa0 },
  { w: 5.2, d: 4.5, roof: 'hip', roofMat: 'thatch', siding: 2, shutters: 'bahama', paint: 0.55, thatchAge: 0.35, annex: { w: 3.0, d: 2.0, wall: 0xefe2c2 } },
  { w: 7.0, d: 5.8, stories: 2, roof: 'gableFront', roofMat: 'metal', galv: true, rust: 0.55, siding: 1, porch: { depth: 2.2, rail: 'x' }, paint: 0.7, antenna: true, tank: 1, doorGlass: true },
  { w: 6.0, d: 5.0, roof: 'gable', roofMat: 'metal', siding: 2, porch: { depth: 1.9, width: 4.4, offset: -0.6, rail: 'balusters' }, doorX: -0.6, paint: 0.66, gutter: true, woodpile: 1 },
  { w: 5.4, d: 4.6, roof: 'hip', roofMat: 'metal', siding: 1, shutters: 'louver', paint: 0.58, buoys: 1, annex: { w: 3.2, d: 2.0 } },
  { w: 5.6, d: 5.0, roof: 'gableFront', roofMat: 'thatch', siding: 2, porch: { depth: 1.9, rail: 'x' }, paint: 0.5, thatchAge: 0.55, shutters: 'board' },
  { w: 6.6, d: 5.6, stories: 2, roof: 'gable', roofMat: 'metal', siding: 1, porch: { depth: 2.2, rail: 'balusters' }, paint: 0.72, chimney: -1, doorGlass: true },
  { w: 6.0, d: 5.2, roof: 'gableFront', roofMat: 'thatch', siding: 2, porch: { depth: 2.0, rail: 'x' }, paint: 0.55, thatchAge: 0.3, shutters: 'board', woodpile: -1, annex: { w: 3.4, d: 2.2, x: 0.6, wall: 0x8cc2e0 } },
  { w: 5.4, d: 4.6, roof: 'gable', roofMat: 'metal', rust: 0.6, siding: 1, paint: 0.6, tank: -1, stovepipe: true },
  { w: 6.2, d: 5.0, roof: 'hip', roofMat: 'metal', galv: true, rust: 0.7, siding: 2, porch: { depth: 1.9, rail: 'balusters' }, paint: 0.6, annex: { w: 3.6, d: 2.0, x: -0.8 } },
  { w: 6.0, d: 5.2, roof: 'gable', roofMat: 'metal', siding: 1, porch: { depth: 2.0, rail: 'x' }, paint: 0.64, gutter: true },
  { w: 7.4, d: 5.6, stories: 2, roof: 'hip', roofMat: 'metal', siding: 1, porch: { depth: 2.3, rail: 'balusters' }, paint: 0.78, antenna: true, chimney: 1, doorGlass: true },
  { w: 5.2, d: 4.8, roof: 'gableFront', roofMat: 'thatch', siding: 1, paint: 0.52, thatchAge: 0.45, shutters: 'bahama', annex: { w: 3.0, d: 1.8 } },
  { w: 6.0, d: 5.0, roof: 'gable', roofMat: 'metal', siding: 2, porch: { depth: 1.9, rail: 'balusters' }, paint: 0.62, tank: 1 },
];
// the stilt huts' styles (upstream's three), placed per place on its beach
const HUTS = [
  { w: 4.0, d: 4.2, floorY: 3.0, roof: 'gableFront', roofMat: 'metal', rust: 0.8, siding: 2, paint: 0.52, weather: 0.85, porch: { depth: 1.6, rail: 'x' }, shutters: 'board', closedChance: 0.3, fewWindows: true, rimRaw: true, buoys: 1, porchBench: false, railNet: 0x3f6f5f },
  { w: 4.4, d: 4.0, floorY: 3.05, roof: 'gableFront', roofMat: 'thatch', thatchAge: 0.6, siding: 2, paint: 0.48, weather: 0.9, porch: { depth: 1.6, rail: 'x' }, shutters: 'board', closedChance: 0.25, fewWindows: true, rimRaw: true, porchBench: false, railNet: 0x9a4a38 },
  { w: 4.0, d: 4.0, floorY: 3.15, roof: 'gable', roofMat: 'thatch', thatchAge: 0.5, siding: 2, paint: 0.5, weather: 0.85, porch: { depth: 1.6, rail: 'x' }, shutters: 'board', closedChance: 0.2, fewWindows: true, rimRaw: true, buoys: -1, porchBench: false },
];
const SHED_WALLS = [0xb9c9b0, 0xd8b8a0, 0xa8c4d4, 0xe8d8a8, 0xc8b8d8, 0xd0c8b0];
// a village's colours: walls, trims, accents, metal roofs, how many thatch roofs, how much paint shows over the wood
const PALETTES = {
  pastel: { walls: Object.values(P), trims: [T.white, T.white, T.cream], accents: [T.navy, T.teal, T.red, T.green, T.yellow, T.blue], roofs: Object.values(RF), thatch: 0.35, paint: [0.5, 0.75] },
  whitewash: { walls: [0xf4f1ea, 0xeeeae0, 0xf6f4ee, 0xe8e4d8], trims: [0x2f5f9a, 0x3a7ab8, 0x2e4f73], accents: [0x2f5f9a, 0x3a7ab8, 0x2e4f73], roofs: [0x4f7898, 0x3f6f9a, 0x8c9296], thatch: 0, paint: [0.72, 0.82] },
  timber: { walls: [0x8f7458, 0x7d6248, 0x9e8466, 0x6f5a44, 0xa89070], trims: [0xd8cfc0, 0x4a3a2c], accents: [0x4a3a2c, 0x2d7f7a, 0x6a3a2a], roofs: [0x8a5a40, 0x8c9296, 0x6a4a3a], thatch: 0.6, paint: [0.1, 0.28] },
  bright: { walls: [0xe8442e, 0x2f9fd8, 0xf2c230, 0x3cb371, 0xe0619a, 0x8e5bd0, 0xf28c28], trims: [0xf3efe6], accents: [0xf3efe6, 0x2e4f73, 0xf2c230], roofs: [0xa64a35, 0x4f7898, 0x5f8a6a, 0x3f8a86], thatch: 0.1, paint: [0.62, 0.8] },
  terracotta: { walls: [0xe9dcc2, 0xd9c09a, 0xf0e2c8, 0xd8b48a, 0xc89a72], trims: [0x6a4a32, 0xf3efe6], accents: [0x6a4a32, 0x4c7d4c, 0x7a3a2a], roofs: [0xa0482e, 0x8a5a40, 0xb4583a], thatch: 0, paint: [0.62, 0.8] },
};
const HULLS = [[0x2f8f9a, 0xa0402e], [0xe9e4d6, 0x2e5f86], [0xd8c35a, 0x3e6f5a], [0xd0e4ea, 0xb04a30], [0xc9463a, 0x2d2d2d], [0x5d8fb8, 0xe8e0d0], [0xf0e6d0, 0x3f7a4a]];
const NET_TINTS = [0x3f6f5f, 0x2f5f8a, 0xb0553a, 0x6a5a8a, 0x8a6a3a];

/** A house's footprint radius, as the core's Buildings.js computes it (+0.8 m margin). */
export const houseRadius = h => Math.hypot(h.w, h.d + Math.max(h.porch?.depth ?? 1.0, h.annex?.d ?? 0) * 2) / 2 + 0.8;

// the harbour frame's ground: heights, coast distance and a flat-and-dry test, through the place's probe
function ground(r, D) {
  const probe = probeOf(r), F = D.F;
  const hL = (x, z) => probe.heightFn(...F.tw(x, z)).h, cL = (x, z) => probe.coastDistance(...F.tw(x, z)).d;
  const nearRiver = (x, z, pad) => D.river && polyDist(D.river.pts, x, z) < D.river.w0 + pad;
  const flat = (x, z, rad, min = 2.6, range = 1.6) => {
    if (cL(x, z) > -50 && min > 2) return false;
    if (nearRiver(x, z, rad + 14)) return false;
    let lo = Infinity, hi = -Infinity;
    for (const [dx, dz] of [[0, 0], [rad, 0], [-rad, 0], [0, rad], [0, -rad], [rad * 0.7, rad * 0.7], [-rad * 0.7, -rad * 0.7], [rad * 0.7, -rad * 0.7], [-rad * 0.7, rad * 0.7]]) {
      const h = hL(x + dx, z + dz);
      lo = Math.min(lo, h); hi = Math.max(hi, h);
    }
    return lo > min && hi < 24 && hi - lo < range;
  };
  return { hL, cL, flat, nearRiver };
}

// the village, in the harbour frame: a plaza, the route up to it from the pier (a boardwalk of its own shape, or none),
// lanes, houses in the place's palette, sheds and yard props
function village(r, R, W, D) {
  const size = W.village, { lean, cxT, czT } = D.lean;
  const G = ground(r, D);
  D.G = G;
  const pal = PALETTES[W.houses];
  D.pal = pal;
  // the plaza: on flat dry ground near where the village leans (none: no plaza)
  let plaza = null;
  if (size !== 'none') {
    for (let t = 0; t < 120 && !plaza; t++) {
      const x = clamp(cxT + R.range(-28, 28), -40, 150), z = lean === 'shore' ? R.range(-112, -102) : R.range(-122, -100);
      if (Math.abs(x - 55) < 10) continue;
      if (D.river && [0.25, 0.5, 0.75, 1].some(t => G.nearRiver(55 + (x - 55) * t, -66 + (z + 66) * t, 6))) continue;   // the way up never fords the river
      if (G.flat(x, z, 6, 2.4, 1.8)) plaza = { x: r2(x), z: r2(z), yaw: r3(R.range(-0.5, 0.5)), r: 6 };
    }
    if (!plaza) plaza = { x: 41.5, z: -111, yaw: 0, r: 6 };
  }
  D.plaza = plaza;
  // the route up from the pier foot: a boardwalk straight, curving, wandering through the dunes, or only a sandy path
  const foot = [55, -66.5];
  const to = plaza ? [plaza.x + Math.sin(plaza.yaw) * 6.5, plaza.z + Math.cos(plaza.yaw) * 6.5] : [55 + R.range(-20, 20), R.range(-92, -84)];
  const kind = R.pick(plaza ? ['straight', 'curve', 'curve', 'dunes', 'none'] : ['dunes', 'none', 'none']);
  let walk = null;
  if (kind !== 'none') {
    const pts = [foot];
    const nMid = kind === 'straight' ? 1 : kind === 'curve' ? 2 : 3, bend = kind === 'straight' ? R.range(-3, 3) : kind === 'curve' ? R.range(6, 14) * R.pick([-1, 1]) : R.range(8, 18);
    const dx = to[0] - foot[0], dz = to[1] - foot[1], L = Math.hypot(dx, dz), nx = -dz / L, nz = dx / L;
    for (let i = 1; i <= nMid; i++) {
      const t = i / (nMid + 1), side = kind === 'dunes' ? (i % 2 ? 1 : -1) : 1;
      // the first stretch runs straight off the steps
      const b = bend * side * Math.sin(Math.PI * t) * (t < 0.2 ? 0.3 : 1);
      pts.push([r1(foot[0] + dx * t + nx * b), r1(foot[1] + dz * t + nz * b)]);
    }
    pts.push([r1(to[0]), r1(to[1])]);
    // a boardwalk does not climb walls: keep it where the ground rises gently
    let ok = true;
    for (let i = 0; i < pts.length - 1 && ok; i++) if (Math.abs(G.hL(...pts[i + 1]) - G.hL(...pts[i])) / Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]) > 0.28) ok = false;
    for (let i = 0; i < pts.length - 1 && ok; i++) for (let t = 0; t <= 1; t += 0.2) if (G.nearRiver(pts[i][0] + (pts[i + 1][0] - pts[i][0]) * t, pts[i][1] + (pts[i + 1][1] - pts[i][1]) * t, 4)) ok = false;
    if (ok) walk = { kind, pts, width: kind === 'dunes' ? r2(R.range(1.4, 1.7)) : r2(R.range(1.6, 1.9)) };
  }
  D.walk = walk;
  D.route = walk ? walk.pts : [foot, to];   // what the houses keep clear of

  if (size === 'none') {
    D.plan = { houses: [], huts: [], sheds: [], plaza: false, sidePaths: [], props: [], lanes: [] };
    D.center = [55, -95]; D.radius = 45;
    return;
  }
  const town = size === 'town';
  const spread = town ? R.range(62, 82) : R.range(40, 52);
  const PZ = plaza;

  // lanes out of the plaza: worn footpaths the houses line (a shore village: one long lane behind the beach)
  const lanes = [];
  if (lean === 'shore') {
    const z0 = PZ.z - R.range(2, 6), half = town ? R.range(70, 100) : R.range(40, 60);
    const pts = [];
    for (let x = PZ.x - half; x <= PZ.x + half + 0.1; x += 12) {
      const z = z0 + Math.sin(x / 37 + R() * 0.4) * 3;
      const steep = pts.length && Math.abs(G.hL(x, z) - G.hL(...pts.at(-1))) / 12 > 0.15;
      if (G.hL(x, z) < 2.6 || G.hL(x, z) > 18 || steep) { if (pts.length >= 3 || (pts.length && polyDist(pts, PZ.x, PZ.z) < 14)) break; pts.length = 0; continue; }
      pts.push([r1(x), r1(z)]);
    }
    if (pts.length >= 3 && polyDist(pts, PZ.x, PZ.z) < 14) lanes.push({ w: r2(R.range(0.8, 1)), pts });
  } else {
    const dirs = town ? R.shuffle([-1, 1, 0]).slice(0, R.int(2, 3)) : [lean === 'east' ? 1 : lean === 'west' ? -1 : R.pick([-1, 1, 0])];
    for (const dir of dirs) {
      const pts = [[r1(PZ.x + (dir === 0 ? 2 : dir * 6.5)), r1(PZ.z - (dir === 0 ? 6.5 : 1.5))]];
      let x = pts[0][0], z = pts[0][1];
      let a = dir === 0 ? -Math.PI / 2 + R.range(-0.3, 0.3) : (dir < 0 ? Math.PI : 0) + dir * R.range(-0.35, -0.05);
      const len = (town ? R.range(55, 85) : R.range(35, 55)) * (dir === 0 ? 0.8 : 1);
      for (let s = 0; s < len; s += 9) {
        a += R.range(-0.18, 0.18);
        const tx = cxT + dir * spread * 0.8, tz = czT - (dir === 0 ? 35 : R.range(0, 12));
        const want = Math.atan2(tz - z, tx - x);
        a += Math.atan2(Math.sin(want - a), Math.cos(want - a)) * 0.25;
        const nx = x + Math.cos(a) * 9, nz = Math.min(z + Math.sin(a) * 9, -100);
        if (G.hL(nx, nz) < 2.6) break;
        if (Math.abs(G.hL(nx, nz) - G.hL(x, z)) / 9 > 0.2) break;
        x = nx; z = nz;
        pts.push([r1(x), r1(z)]);
      }
      if (pts.length >= 3) lanes.push({ w: r2(R.range(0.75, 0.95)), pts });
    }
  }
  D.lanes = lanes;

  const houses = [], taken = [];
  const blockedBy = (x, z, rad, pad = 2.5) => {
    if (z > -96) return true;   // the beach front and the harbour pieces
    if (Math.hypot(x - PZ.x, z - PZ.z) < rad + PZ.r + 4) return true;
    if (polyDist(D.route, x, z) < rad + 3) return true;
    for (const p of lanes) if (polyDist(p.pts, x, z) < rad + p.w + pad) return true;
    for (const t of taken) if (Math.hypot(x - t.x, z - t.z) < rad + t.r + 3) return true;
    return false;
  };
  const styles = R.shuffle(HOUSES.map((h, i) => i));
  const walls = R.shuffle(pal.walls).slice(0, R.int(3, Math.min(6, pal.walls.length)));
  const want = town ? R.int(10, 14) : R.int(4, 7);
  const styleFor = k => {
    const base = clone(HOUSES[styles[k % styles.length]]);
    base.wall = R.pick(walls);
    base.trim = R.pick(pal.trims);
    base.accent = R.pick(pal.accents);
    base.roofMat = R.chance(pal.thatch) ? 'thatch' : 'metal';
    if (base.roofMat === 'metal') { base.roofColor = R.pick(pal.roofs); delete base.thatchAge; if (W.houses !== 'pastel') delete base.galv; }
    else { delete base.roofColor; delete base.galv; base.thatchAge = r2(R.range(0.25, 0.65)); }
    if (base.annex) { base.annex.wall = R.chance(0.5) ? R.pick(walls) : base.wall; }
    base.paint = r2(R.range(...pal.paint));
    if (W.houses === 'whitewash') base.shutters = R.pick(['louver', 'board', 'bahama']);
    return base;
  };
  const place = (x, z, yaw, h) => {
    houses.push({ name: `H${houses.length + 1}`, x: r2(x), z: r2(z), yaw: r3(yaw), ...h });
    taken.push({ x, z, r: houseRadius(h) });
  };
  for (const lane of lanes) {
    let acc = 0;
    const sides = lean === 'shore' ? [-1] : [-1, 1];
    for (let i = 0; i < lane.pts.length - 1 && houses.length < want; i++) {
      const [ax, az] = lane.pts[i], [bx, bz] = lane.pts[i + 1];
      const L = Math.hypot(bx - ax, bz - az), tx = (bx - ax) / L, tz = (bz - az) / L;
      for (let s = 0; s < L && houses.length < want; s += 1.5) {
        acc += 1.5;
        if (acc < (lean === 'shore' ? R.range(11, 16) : town ? 13 : 16)) continue;
        for (const side0 of R.shuffle(sides)) {
          // shore: the row on the landward side of the lane, facing the sea
          const side = lean === 'shore' ? (tx > 0 ? 1 : -1) : side0;
          const h = styleFor(houses.length);
          const rad = houseRadius(h), off = rad + lane.w + R.range(1.2, 3.2);
          const x = ax + tx * s - tz * side * off, z = az + tz * s + tx * side * off;
          if (blockedBy(x, z, rad, 0.4) || !G.flat(x, z, rad)) continue;
          const yaw = lean === 'shore' ? R.range(-0.12, 0.12) : Math.atan2(tz * side, -tx * side) + R.range(-0.12, 0.12);
          place(x, z, yaw, h);
          acc = 0;
          break;
        }
      }
    }
  }
  for (let tries = 0; tries < 900 && houses.length < want; tries++) {
    const h = styleFor(houses.length), rad = houseRadius(h);
    const x = cxT + R.range(-1, 1) * spread * 1.15, z = czT + R.range(-1, 1) * spread * 0.55 - (lean === 'shore' ? 14 : 0);
    if (blockedBy(x, z, rad) || !G.flat(x, z, rad)) continue;
    const toPlaza = Math.atan2(PZ.x - x, PZ.z - z);
    place(x, z, clamp(toPlaza * 0.25, -0.45, 0.45) + R.range(-0.15, 0.15), h);
  }
  const sheds = [];
  for (const hs of R.shuffle(houses).slice(0, town ? R.int(3, 4) : R.int(1, 2))) {
    for (let t = 0; t < 8; t++) {
      const a = hs.yaw + Math.PI + R.range(-1.2, 1.2), d = houseRadius(hs) + R.range(3.5, 6);
      const x = hs.x + Math.sin(a) * d, z = hs.z + Math.cos(a) * d;
      if (blockedBy(x, z, 2.6, 1.2) || !G.flat(x, z, 2.6)) continue;
      sheds.push({ name: `shed${sheds.length + 1}`, x: r2(x), z: r2(z), yaw: r3(hs.yaw + R.range(-0.3, 0.3)), wall: W.houses === 'pastel' ? R.pick(SHED_WALLS) : R.pick(walls), door: R.pick(pal.accents), ...(R.chance(0.3) ? { galv: true } : {}) });
      taken.push({ x, z, r: 2.6 });
      break;
    }
  }
  // plank side paths from the route or the plaza to the two nearest houses
  const sidePaths = [];
  const front = h => { const d = h.d / 2 + (h.porch?.depth ?? 0.6) + 0.9; return [h.x + Math.sin(h.yaw) * d, h.z + Math.cos(h.yaw) * d]; };
  const anchors = [...(walk ? walk.pts.slice(1) : []), [PZ.x - 4.5, PZ.z + 0.4], [PZ.x + 5.3, PZ.z + 0.6]];
  const near = houses.map(h => { const f = front(h); const a = anchors.reduce((b, p) => (Math.hypot(p[0] - f[0], p[1] - f[1]) < Math.hypot(b[0] - f[0], b[1] - f[1]) ? p : b)); return { h, f, a, d: Math.hypot(a[0] - f[0], a[1] - f[1]) }; })
    .filter(o => o.d > 4 && o.d < 22).sort((a, b) => a.d - b.d);
  for (const o of near) {
    if (sidePaths.length >= 2) break;
    const mid = [(o.a[0] + o.f[0]) / 2, (o.a[1] + o.f[1]) / 2];
    if (houses.some(h => h !== o.h && segDist(h.x, h.z, o.a[0], o.a[1], o.f[0], o.f[1]) < houseRadius(h) + 0.8)) continue;
    sidePaths.push([[r1(o.a[0]), r1(o.a[1])], [r1(mid[0]), r1(mid[1])], [r1(o.f[0]), r1(o.f[1])]]);
  }
  // yard props: the place's own mix of fences, laundry, gear and racks, lights along the lanes
  const yard = { fence: R.range(0.1, 0.45), laundry: R.range(0.1, 0.4), gear: R.range(0.2, 0.5) };
  const props = [];
  const clear = (x, z, rad) => !blockedBy(x, z, rad, 0.6) && G.flat(x, z, Math.max(rad, 1.2)) && !sidePaths.some(sp => polyDist(sp, x, z) < rad + 1.2);
  const local = (h, lx, lz) => { const c = Math.cos(h.yaw), s = Math.sin(h.yaw); return [h.x + lx * c + lz * s, h.z - lx * s + lz * c]; };
  for (const h of R.shuffle(houses)) {
    const roll = R();
    if (roll < yard.fence) {
      const side = R.pick([-1, 1]), lx = side * (h.w / 2 + 1.6);
      const pts = [local(h, lx, h.d / 2 + 1.2), local(h, lx, -h.d / 2 - 0.4), local(h, lx - side * 2.6, -h.d / 2 - (h.annex?.d ?? 0) - 1.4)];
      if (pts.every(([x, z]) => !houses.some(o => o !== h && Math.hypot(o.x - x, o.z - z) < houseRadius(o) + 0.6) && !lanes.some(p => polyDist(p.pts, x, z) < p.w + 1) && polyDist(D.route, x, z) > 2.5 && !sidePaths.some(sp => polyDist(sp, x, z) < 1.4)))
        props.push({ kind: 'fence', pts: pts.map(([x, z]) => [r2(x), r2(z)]), style: R.pick(['picket', 'rail']), tint: R.pick(pal.trims) });
    } else if (roll < yard.fence + yard.laundry) {
      const a = local(h, -2.3, -h.d / 2 - (h.annex?.d ?? 0) - 1.9), b = local(h, 2.3, -h.d / 2 - (h.annex?.d ?? 0) - 2.5);
      if ([a, b].every(([x, z]) => clear(x, z, 0.5))) props.push({ kind: 'laundry', a: a.map(r2), b: b.map(r2) });
    } else if (roll < yard.fence + yard.laundry + yard.gear) {
      const [x, z] = local(h, R.pick([-1, 1]) * (h.w / 2 + 1.3), R.range(-1, 1));
      if (clear(x, z, 1.0)) {
        const t = R.pick(['barrel', 'crate', 'trap']), ry = r2(R.range(0, 3));
        props.push({ kind: 'clutter', items: [[t, r2(x), r2(z), ry], [R.pick(['barrel', 'crate']), r2(x + 0.75), r2(z + 0.5), r2(R.range(0, 3))], ...(t !== 'barrel' ? [[t, r2(x + 0.04), r2(z - 0.04), r2(ry + 0.3), t === 'trap' ? 0.31 : 0.4]] : [])] });
      }
    }
  }
  for (let k = 0, n = town ? R.int(1, 3) : R.int(0, 2); k < n; k++) {
    for (let t = 0; t < 40; t++) {
      const x = cxT + R.range(-1, 1) * spread, z = czT + R.range(-1, 1) * spread * 0.5 - (lean === 'shore' ? 12 : 0);
      if (!clear(x, z, 2.2)) continue;
      props.push({ kind: R.chance(0.5) ? 'fishRack' : 'netRack', x: r2(x), z: r2(z), ry: r2(R.range(-0.4, 0.4)), tint: R.pick(NET_TINTS) });
      taken.push({ x, z, r: 2.2 });
      break;
    }
  }
  for (const lane of lanes) {
    for (let i = 2; i < lane.pts.length; i += R.int(2, 4)) {
      const [x, z] = lane.pts[i], [px, pz] = lane.pts[i - 1];
      const L = Math.hypot(x - px, z - pz) || 1, ox = -(z - pz) / L * (lane.w + 0.9), oz = (x - px) / L * (lane.w + 0.9);
      if (clear(x + ox, z + oz, 0.4)) props.push({ kind: 'pathLight', x: r2(x + ox), z: r2(z + oz) });
    }
  }
  const pts = [...houses, ...sheds, { x: PZ.x, z: PZ.z }];
  const mx = pts.reduce((s, p) => s + p.x, 0) / pts.length, mz = pts.reduce((s, p) => s + p.z, 0) / pts.length;
  D.center = [mx, mz];
  D.radius = Math.round(Math.max(55, Math.max(...pts.map(p => Math.hypot(p.x - mx, p.z - mz) + (p.w ? houseRadius(p) : 3))) + 18));
  D.plan = { houses, huts: [], sheds, plaza: true, sidePaths, props, lean, lanes };
}

// the harbour by the pier foot (harbour frame): the boathouse, the fish stand and the chandlery, stilt huts in the
// village's colours, boats, racks, gear and floats on the sand, the respawn point and the start, the player's first view
function harbourScene(r, R, W, D) {
  const G = D.G, plan = D.plan, pal = D.pal, bz = r.beachZone;
  const taken = [{ x: 55, z: -63, r: 4.5 }];   // the pier's steps and its foot
  const route = D.route;
  const xMin = Math.max(-70, bz.x - bz.w0 + 8, 55 - 52), xMax = Math.min(150, bz.x + bz.w0 - 4, 55 + 52);
  const free = (x, z, rad, pad = 1.2) => {
    if (Math.abs(x - 55) < rad + 3 && z > -80) return false;   // the pier and its steps
    if (D.walk && polyDist(D.walk.pts, x, z) < rad + 1.4) return false;
    for (const t of taken) if (Math.hypot(x - t.x, z - t.z) < rad + t.r + pad) return false;
    for (const h of [...plan.houses, ...plan.sheds]) if (Math.hypot(x - h.x, z - h.z) < rad + 4) return false;
    return true;
  };
  const inBeach = x => x >= xMin && x <= xMax;
  const waterline = (x, h0 = 0.35) => { let z = -40; for (; z > -80; z -= 0.5) if (G.hL(x, z) >= h0) break; return z; };
  // the boathouse at the waterline, one side of the pier; the chandlery beside it or across the pier; the fish stand by
  // the route up from the pier foot
  const sideB = R.pick([-1, 1]);
  let boathouse = null;
  for (let t = 0; t < 160 && !boathouse; t++) {   // one side, then the other
    const x = 55 + (t < 80 ? sideB : -sideB) * R.range(24, 50);
    if (!inBeach(x)) continue;
    const z = waterline(x, 0.4) - 3.5;
    if (!free(x, z, 6) || G.hL(x, z - 4) > 3.5 || !G.flat(x, z, 4.5, 0.3, 1.0)) continue;
    boathouse = { x: r2(x), z: r2(z), yaw: r3(R.range(-0.15, 0.15)), wall: R.pick([0x8fb3a8, ...pal.walls]), paint: r2(R.range(0.4, 0.7)), r: 6 };
  }
  if (!boathouse) boathouse = { x: 92.5, z: -57.5, yaw: -0.08, wall: 0x8fb3a8, paint: 0.58, r: 6 };
  taken.push(boathouse);
  const sideC = R.chance(0.5) ? sideB : -sideB;
  let chandlery = null;
  for (let t = 0; t < 200 && !chandlery; t++) {   // beside the boathouse or across the pier, then anywhere by the pier foot
    const x = t < 60 ? (sideC === sideB ? boathouse.x - sideB * R.range(8, 12) : 55 + sideC * R.range(14, 30)) : 55 + R.pick([-1, 1]) * R.range(9, 40);
    const z = t < 60 ? R.range(-66, -59) : R.range(-76, -60);
    if (!inBeach(x) || !free(x, z, 2.6) || !G.flat(x, z, 2.2, 0.8, 1.0)) continue;
    chandlery = { x: r2(x), z: r2(z), yaw: r3(Math.atan2(55 - x, -63 - z) + R.range(-0.2, 0.2)), r: 2.6 };
  }
  if (!chandlery) chandlery = { ...HARBOUR.chandlery };
  taken.push(chandlery);
  let stand = null;
  for (let t = 0; t < 60 && !stand; t++) {
    let x, z, yaw;
    if (D.walk) {   // beside the boardwalk, 8 - 18 m up from its foot, facing it
      const p = D.walk.pts, s = R.range(0.15, 0.45), i = Math.min(p.length - 2, Math.floor(s * (p.length - 1)));
      const ax = p[i][0], az = p[i][1], bx = p[i + 1][0], bz2 = p[i + 1][1], L = Math.hypot(bx - ax, bz2 - az) || 1;
      const side = R.pick([-1, 1]), f = R.range(0.2, 0.8);
      const mx = ax + (bx - ax) * f, mz = az + (bz2 - az) * f;
      x = mx - (bz2 - az) / L * side * 4.3; z = mz + (bx - ax) / L * side * 4.3;
      yaw = Math.atan2(mx - x, mz - z);
    } else {
      x = 55 + R.pick([-1, 1]) * R.range(6, 12); z = R.range(-78, -70); yaw = Math.atan2(55 - x, -66 - z);
    }
    if (!free(x, z, 3) || !G.flat(x, z, 2.5, 1.2, 1.1)) continue;
    stand = { x: r2(x), z: r2(z), yaw: r3(yaw), r: 3 };
  }
  if (!stand) stand = { ...HARBOUR.fishStand };
  taken.push(stand);
  // stilt huts on the back of the beach, facing the sea, in the village's colours
  const nHuts = W.village === 'town' ? 3 : W.village === 'hamlet' ? 2 : 0;
  const huts = [];
  for (let t = 0; t < 300 && huts.length < nHuts; t++) {
    const tpl = clone(HUTS[huts.length % HUTS.length]);
    const x = R.range(xMin, xMax), z = R.range(-76, -63), rad = 3.4;
    if (!free(x, z, rad, 2.5)) continue;
    const g = G.hL(x, z);
    if (g < 1.3 || g > 3.4 || Math.abs(G.hL(x + 3, z) - G.hL(x - 3, z)) > 1.2) continue;
    tpl.name = `S${huts.length + 1}`;
    tpl.x = r2(x); tpl.z = r2(z); tpl.yaw = r3(R.range(-0.22, 0.22));
    tpl.floorY = r2(Math.max(2.7, g + R.range(1.25, 1.6)));
    tpl.wall = R.pick(pal.walls); tpl.trim = R.pick(pal.trims); tpl.accent = R.pick(pal.accents);
    tpl.roofMat = R.chance(Math.max(0.3, pal.thatch)) ? 'thatch' : 'metal';
    if (tpl.roofMat === 'metal') { tpl.roofColor = R.pick(pal.roofs); tpl.rust = r2(R.range(0.4, 0.85)); } else { delete tpl.roofColor; tpl.thatchAge = r2(R.range(0.3, 0.65)); }
    tpl.roof = R.pick(['gableFront', 'gable', 'gableFront']);
    huts.push(tpl);
    taken.push({ x, z, r: rad });
  }
  plan.huts = huts;
  // boats, racks, gear and floats on the sand round the pier foot
  const beach = [];
  const put = (n, zr, rad, make, tries = 80) => {
    for (let k = 0, t = 0; k < n && t < tries; t++) {
      const x = R.range(xMin, xMax), z = R.range(...zr);
      if (!free(x, z, rad)) continue;
      const g = G.hL(x, z);
      if (g < 0.45 || g > 3.2) continue;
      beach.push(make(r2(x), r2(z), g));
      taken.push({ x, z, r: rad });
      k++;
    }
  };
  put(R.int(1, 4), [-60, -53], 2.4, (x, z) => { const [hull, bottom] = R.pick(HULLS), up = R.chance(0.55); return { kind: 'rowboat', x, z, ry: r2(R.range(-0.6, 0.6)), up, hull, bottom, rz: up ? 0 : r2(R.range(-0.16, 0.16)) }; });
  if (R.chance(0.35)) put(1, [-51, -47], 4, (x, z) => ({ kind: 'wreck', x, z, ry: r2(R.range(0.6, 1.2) * R.pick([-1, 1])) }));
  put(R.int(0, 3), [-67, -57], 2.3, (x, z) => ({ kind: 'netRack', x, z, ry: r2(R.range(-0.35, 0.35)), tint: R.pick(NET_TINTS) }));
  if (huts.length && R.chance(0.6)) put(1, [-72, -62], 1.8, (x, z) => ({ kind: 'fishRack', x, z, ry: r2(R.range(-0.3, 0.3)) }));
  beach.push({ kind: 'clutter', items: [['barrel', 57.4, -62.4, 0.4], ['barrel', 58.05, -62.9, 1.9], ['crate', 57.6, -61.2, 0.1], ['crate', 57.65, -61.25, 0.4, 0.4], ['trap', 52.4, -61.0, 0.05], ['trap', 52.35, -61.6, 0.08], ['trap', 52.4, -61.3, 0.2, 0.31], ['crate', 51.6, -62.4, 0.6]].filter(() => R.chance(0.8)) });
  for (const h of huts) {
    for (let t = 0; t < 12; t++) {
      const a = R.range(0, Math.PI * 2), d = R.range(4.2, 5.5), x = h.x + Math.cos(a) * d, z = h.z + Math.sin(a) * d;
      if (!free(x, z, 1.1, 0.3)) continue;
      const k = R.pick(['trap', 'crate', 'barrel']), ry = r2(R.range(0, 3));
      beach.push({ kind: 'clutter', items: [[k, r2(x), r2(z), ry], [R.pick(['barrel', 'crate', 'trap']), r2(x + 0.7), r2(z + 0.45), r2(R.range(0, 3))], ...(k !== 'barrel' ? [[k, r2(x + 0.05), r2(z - 0.05), r2(ry + 0.2), k === 'trap' ? 0.31 : 0.4]] : [])] });
      taken.push({ x, z, r: 1.4 });
      break;
    }
  }
  put(R.int(2, 6), [-63, -54], 0.5, (x, z) => ({ kind: 'buoy', x, z }), 120);
  put(R.int(0, 2), [-62, -55], 0.5, (x, z) => ({ kind: 'rope', x, z }), 60);
  plan.beach = beach;
  plan.boathouse = { x: boathouse.x, z: boathouse.z, yaw: boathouse.yaw, wall: boathouse.wall, paint: boathouse.paint };
  D.stalls = { fish: stand, chandlery };
  // the respawn point: on dry sand beside the pier foot
  let spawn = null;
  for (let t = 0; t < 60 && !spawn; t++) {
    const x = 55 + R.pick([-1, 1]) * R.range(12, 30);
    if (!inBeach(x)) continue;
    let z = -56;
    for (; z > -74; z -= 0.5) if (G.hL(x, z) >= 1.15) break;
    z -= 1;
    if (!free(x, z, 2, 0.5) || !G.flat(x, z, 2, 1.0, 0.7)) continue;
    spawn = { x: r1(x), z: r1(z), yaw: Math.PI };
  }
  D.spawn = spawn ?? { x: 55, z: -75, yaw: Math.PI };
  taken.push({ x: D.spawn.x, z: D.spawn.z, r: 2 });
  // the start: the player's first view, on the harbour, looking at the pier
  const zEnd = r.pier.zEnd, headAt = [55, zEnd - 12];
  const yawTo = (x, z, [tx, tz]) => r3(Math.atan2(-(tx - x), -(tz - z)));   // the core's yaw (π looks along +z)
  const big = [...taken.filter(t => t.r >= 2.4)];
  // nothing big in front, and the ground ahead does not rise into the view (a start facing a bank sees only grass)
  const clearView = (x, z, yaw) => {
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw), g0 = G.hL(x, z);
    if ([3, 6, 10, 16, 24].some(d => G.hL(x + fx * d, z + fz * d) > g0 + 1.0 + d * 0.1)) return false;
    return !big.some(b => { const dx = b.x - x, dz = b.z - z, d = Math.hypot(dx, dz); return d < b.r + 4 || (d < 14 + b.r && (dx * fx + dz * fz) / d > 0.85); });
  };
  let start = null;
  for (const o of R.shuffle(['route', 'beach', 'beach', 'top'])) {
    if (o === 'route' && D.walk) {   // along the boardwalk, looking down it to the pier
      const p = D.walk.pts, i = Math.min(p.length - 2, R.int(0, 1)), f = R.range(0.5, 1);
      const x = p[i][0] + (p[i + 1][0] - p[i][0]) * f, z = p[i][1] + (p[i + 1][1] - p[i][1]) * f;
      if (G.hL(x, z) < 1.4 || !clearView(x, z, yawTo(x, z, [55, zEnd]))) continue;
      start = { x: r2(x), z: r2(z), yaw: yawTo(x, z, [55, zEnd]), from: 'boardwalk' };
      break;
    }
    if (o === 'top' && D.plaza) {   // up by the plaza, the harbour below
      const p = D.plaza, x = p.x + Math.sin(p.yaw) * 8, z = p.z + Math.cos(p.yaw) * 8;
      if (plan.houses.some(h => Math.hypot(h.x - x, h.z - z) < houseRadius(h) + 2.5) || G.hL(x, z) < 2 || !clearView(x, z, yawTo(x, z, [55, -64]))) continue;
      start = { x: r2(x), z: r2(z), yaw: yawTo(x, z, [55, -64]), from: 'top' };
      break;
    }
    for (let t = 0; t < 60 && !start && o === 'beach'; t++) {
      const side = R.pick([-1, 1]), x = 55 + side * R.range(16, 32), z = R.range(-72, -63);
      if (!inBeach(x) || !free(x, z, 1.6, 1.0)) continue;
      const g = G.hL(x, z);
      if (g < 1.4 || g > 3.4 || !G.flat(x, z, 1.5, 1.2, 1.1)) continue;
      const yaw = yawTo(x, z, headAt);
      if (!clearView(x, z, yaw)) continue;
      start = { x: r2(x), z: r2(z), yaw, from: 'beach' };
    }
    if (start) break;
  }
  D.start = start ?? { x: 55, z: -74, yaw: Math.PI, from: 'boardwalk' };
}

// footpaths (harbour frame): from the respawn point up to the plaza, from the boathouse to the pier foot, along the back
// of the beach, the hiking trail up the valley, and the village's lanes
function paths(r, R, W, D) {
  const G = D.G, bz = r.beachZone, V = r.valley, out = [];
  const dry = (ax, az, bx, bz2, min) => { for (let t = 0; t <= 1.001; t += 0.125) if (G.hL(ax + (bx - ax) * t, az + (bz2 - az) * t) < min) return false; return true; };
  const top = D.plaza ? [D.plaza.x, D.plaza.z + 5] : D.route.at(-1);
  // spawn → the route up from the pier (its nearest point), across the sand
  {
    const route = D.route, at = route.reduce((b, p) => (Math.hypot(p[0] - D.spawn.x, p[1] - D.spawn.z) < Math.hypot(b[0] - D.spawn.x, b[1] - D.spawn.z) ? p : b));
    const mid = [r1((D.spawn.x + at[0]) / 2 + R.range(-3, 3)), r1((D.spawn.z + at[1]) / 2 - R.range(1, 4))];
    out.push({ w: 1.1, pts: [[D.spawn.x, D.spawn.z + 2], mid, [r1(at[0]), r1(at[1])]] });
  }
  // the hiking trail: from behind the plaza up the valley, taking the gentlest of a few headings
  const trail = [[r1(top[0]), r1(top[1])]];
  let x = trail[0][0], z = trail[0][1];
  const grade = (ax, az, bx, bz2) => Math.abs(G.hL(bx, bz2) - G.hL(ax, az)) / Math.hypot(bx - ax, bz2 - az);
  for (let i = 0; i < 30; i++) {
    const cx = V.x + (z - V.z) * V.slant, up = Math.atan2(cx - x, 12);
    let best = null;
    for (const da of [0, -0.45, 0.45, -0.8, 0.8, -1.1, 1.1, -1.4, 1.4]) {
      const a = up + da + R.range(-0.1, 0.1), len = R.range(9, 12);
      const nx = x + Math.sin(a) * len, nz = z - Math.cos(a) * len;
      if ((D.lanes || []).some(l => polyDist(l.pts, nx, nz) < 4)) continue;
      if (G.nearRiver(nx, nz, 5) || G.hL(nx, nz) < 1.2) continue;   // the trail keeps to its own bank and to dry land
      if (D.plan.houses.some(h => Math.hypot(h.x - nx, h.z - nz) < houseRadius(h) + 2)) continue;
      const g = grade(x, z, nx, nz);
      if (!best || g < best.g - 0.03) best = { nx, nz, g };
      if (g < 0.24) break;
    }
    if (!best || best.g > 0.3) break;
    x = best.nx; z = best.nz;
    trail.push([r1(x), r1(z)]);
    if (G.hL(x, z) > 80 || z < -400) break;
  }
  if (trail.length >= 3) out.push({ w: 0.6, pts: trail });
  // boathouse → pier foot
  const bh = D.plan.boathouse;
  out.push({ w: 0.9, pts: [[r1(bh.x - Math.sin(bh.yaw) * 6), r1(bh.z - Math.cos(bh.yaw) * 6 - 2)], [r1((bh.x + 55) / 2), r1(Math.min(bh.z - 10, -70))], [55 + Math.sign(bh.x - 55) * 3, -72]] });
  // the back of the beach, away from the boathouse
  const side = -Math.sign(bh.x - 55) || 1, along = [[r1(D.spawn.x), r1(D.spawn.z - 2)]];
  for (let k = 1; k < 6; k++) {
    const nx = D.spawn.x + side * k * 15, nz = D.spawn.z - 2 - k * 3.6 + R.range(-1.5, 1.5);
    if (G.cL(nx, nz) < -60 || G.cL(nx, nz) > -22) break;   // the back of the beach, not the slope behind it
    if (nx < bz.x - bz.w0 + 18 || nx > bz.x + bz.w0 - 18) break;
    const [px, pz] = along.at(-1);
    const mx = (px + nx) / 2, mz = (pz + nz) / 2, L2 = Math.hypot(nx - px, nz - pz) / 2;
    if (!dry(px, pz, nx, nz, 2.6) || Math.max(Math.abs(G.hL(mx, mz) - G.hL(px, pz)), Math.abs(G.hL(nx, nz) - G.hL(mx, mz))) / L2 > 0.12) break;
    along.push([r1(nx), r1(nz)]);
  }
  if (along.length >= 3) out.push({ w: 0.8, pts: along });
  // no boardwalk: a sandy path up from the pier, where the ground is gentle enough to walk
  if (!D.walk) {
    const [[ax, az], [bx, bz2]] = [D.route[0], D.route.at(-1)], L = Math.hypot(bx - ax, bz2 - az) || 1;
    let steep = 0;
    for (let t = 0; t < 1; t += 0.1) steep = Math.max(steep, Math.abs(G.hL(ax + (bx - ax) * (t + 0.1), az + (bz2 - az) * (t + 0.1)) - G.hL(ax + (bx - ax) * t, az + (bz2 - az) * t)) / (L * 0.1));
    if (steep < 0.35) out.push({ w: 1.0, pts: D.route.map(([x, z]) => [r1(x), r1(z)]) });
  }
  for (const l of D.lanes || []) out.push(l);
  // a path never fords the river: one that would is left out
  const fords = p => { for (let i = 0; i < p.pts.length - 1; i++) for (let t = 0; t <= 1; t += 0.1) if (G.nearRiver(p.pts[i][0] + (p.pts[i + 1][0] - p.pts[i][0]) * t, p.pts[i][1] + (p.pts[i + 1][1] - p.pts[i][1]) * t, 1)) return true; return false; };
  D.paths = D.river ? out.filter(p => !fords(p)) : out;
  // a shed or house a path runs into gives way to the path
  const onPath = (b, rad) => D.paths.some(p => polyDist(p.pts, b.x, b.z) < rad + p.w + 0.5);
  D.plan.sheds = D.plan.sheds.filter(b => !onPath(b, 2.6));
  D.plan.houses = D.plan.houses.filter(b => !onPath(b, houseRadius(b)));
  D.plan.sidePaths = D.plan.sidePaths.filter(sp => D.plan.houses.some(h => Math.hypot(sp.at(-1)[0] - h.x, sp.at(-1)[1] - h.z) < houseRadius(h) + 3));
}

// the design written into the recipe in world coordinates
function finish(r, R, W, D) {
  const F = D.F, h = r.harbour.heading;
  const P2 = ([x, z]) => F.tw(x, z).map(r2);
  const at = o => { const [x, z] = F.tw(o.x, o.z); return { ...o, x: r2(x), z: r2(z), ...(o.yaw !== undefined ? { yaw: r3(wrapA(o.yaw + h)) } : {}) }; };
  const plan = D.plan;
  const out = {
    houses: plan.houses.map(at), huts: plan.huts.map(at), sheds: plan.sheds.map(at),
    plaza: D.plaza ? (({ x, z, yaw }) => ({ x, z, yaw }))(at(D.plaza)) : false,
    sidePaths: plan.sidePaths.map(sp => sp.map(P2)),
    props: plan.props.map(p => p.kind === 'fence' ? { ...p, pts: p.pts.map(P2) } : p.kind === 'laundry' ? { ...p, a: P2(p.a), b: P2(p.b) } : p.kind === 'clutter' ? { ...p, items: p.items.map(([t, x, z, ry, st]) => [t, ...P2([x, z]), r2(ry + h), ...(st !== undefined ? [st] : [])]) } : (({ x, z }) => ({ ...p, x, z, ...(p.ry !== undefined ? { ry: r2(p.ry + h) } : {}) }))(at(p))),
    beach: plan.beach.map(it => it.kind === 'clutter' ? { ...it, items: it.items.map(([t, x, z, ry, st]) => [t, ...P2([x, z]), r2(ry + h), ...(st !== undefined ? [st] : [])]) } : { ...at(it), ...(it.ry !== undefined ? { ry: r2(it.ry + h) } : {}) }),
    boathouse: at(plan.boathouse),
    boardwalk: D.walk ? D.walk.pts.slice(1).map(P2) : null,
    pier: { kind: D.pier.kind, arch: D.pier.arch, style: D.pier.style, tint: r.words.rock === 'limestone' ? 0xd8d0c0 : r.words.sand === 'dark' ? 0x8a8580 : undefined },
    lean: plan.lean,
  };
  out.boardwalkWidth = D.walk?.width ?? null;
  r.village = { center: P2(D.center).map(r1), radius: D.radius, size: W.village, plan: out };
  r.stalls = { fish: (({ x, z, yaw }) => ({ x, z, yaw }))(at(D.stalls.fish)), chandlery: (({ x, z, yaw }) => ({ x, z, yaw }))(at(D.stalls.chandlery)) };
  r.spawn = at(D.spawn);
  r.start = at(D.start);
  r.paths = D.paths.map(p => ({ w: p.w, pts: p.pts.map(P2).map(([x, z]) => [r1(x), r1(z)]) }));
  const [dx, dz] = P2(D.dockL);
  r.boatDock = { x: r1(dx), z: r1(dz), heading: r3(h) };
  // the swell runs in toward the harbour's beach (upstream's: -0.12, -1 in its frame), give or take
  const a = R.range(-0.12, 0.12), sx = -0.12 * Math.cos(a) + Math.sin(a), sz = 0.12 * Math.sin(a) - Math.cos(a);
  r.swellDir = [r3(sx * Math.cos(h) + sz * Math.sin(h)), r3(-sx * Math.sin(h) + sz * Math.cos(h))];
  delete r.scale;
}

// ------------------------------------------------------------------------------------------------ for the system

/** Where the players stand at the start places kit/config.js names (pier foot, pier head, beside the boat). */
export function placeSeats(recipe = REFERENCE) {
  const p = recipe.pier, b = recipe.boatDock, s = recipe.start, F = harbourFrame(recipe), h = recipe.harbour?.heading ?? 0;
  const headZ = p.zEnd - p.headDepth / 2;
  // forward and right for the core's yaw (π looks along +z): friends a few steps ahead, facing the first seat
  const fx = -Math.sin(s.yaw), fz = -Math.cos(s.yaw), rx = -fz, rz = fx;
  const ahead = [[2, 5], [-2, 5], [0, 7]].map(([a, c]) => [s.x + rx * a + fx * c, s.z + rz * a + fz * c]);
  const seat = (lx, lz, yaw) => { const [x, z] = F.tw(lx, lz); return { x: r2(x), z: r2(z), yaw: r3(yaw + h) }; };
  return {
    pier: [{ x: s.x, z: s.z, yaw: s.yaw }, ...ahead.map(([x, z]) => ({ x: r2(x), z: r2(z), yaw: r3(Math.atan2(-(s.x - x), -(s.z - z))) }))],
    'pier-head': [[0, -1.8], [0, 1.8], [-1.8, 0], [1.8, 0]].map(([dx, dz]) => seat(p.x + dx, headZ + dz, Math.atan2(dx, dz))),
    boat: [[0, -1.6], [0, 0], [0, 1.6], [-1.6, 0]].map(([dx, dz]) => { const [lx, lz] = F.tl(b.x, b.z); return seat(lx - 3.3 + dx, lz + dz, -Math.PI / 2); }),
  };
}

/** One line about a place, for a pitch card or a log. */
export function describePlace(r) {
  const w = r.words || {};
  const bay = typeof w.bay === 'number' ? `${w.bay}°` : ({ n: 'north', e: 'east', s: 'south', w: 'west' }[w.bay] ?? w.bay);
  const shape = { single: 'one summit', twin: 'twin peaks', ridge: 'a long ridge', cliffs: 'sheer cliffs on one side', atoll: 'a low ring round a lagoon', archipelago: 'among bigger islets', plateau: 'a flat-topped table mountain', volcano: 'a volcano with a rock spire' }[w.shape] ?? '';
  const extra = [w.coast && `a ${w.coast} coast`, Number(w.bays) ? `${w.bays} cove${w.bays === '1' ? '' : 's'}` : '', w.river === 'yes' ? 'a river mouth' : '', w.cliffs && w.cliffs !== 'none' ? `${w.cliffs} cliffs` : ''].filter(Boolean).join(', ');
  const look = [w.time, w.weather].filter(Boolean).join(', ');
  return `a ${w.size} island (${shape}, ${w.peaks} peaks${Number(w.islets) ? `, ${w.islets} islet${w.islets === '1' ? '' : 's'}` : ''}), ${extra ? `${extra}, ` : ''}${w.vegetation ?? ''} on ${w.rock ?? ''}, a ${w.beach} ${w.sand ?? ''} beach facing ${bay}, a ${w.pier ?? 'pier'}, ${w.village === 'none' ? 'no village' : `a ${w.houses ?? ''} ${w.village}`}, ${w.reef === 'none' ? 'no reef' : `a ${w.reef} reef`}, ${w.water ?? ''} water${look ? ` (seen ${look})` : ''}`;
}

/** The hour and the light of each time word (kit/look.js HOURS, the presets' exposure at the dark ends). */
export const TIMES = { dawn: { hour: 6.4, exposure: 0.4 }, morning: { hour: 9.5 }, noon: { hour: 12.5 }, golden: { hour: 17.4 }, sunset: { hour: 17.95, exposure: 0.3 }, night: { hour: 21.5, exposure: 0.8 } };
/** The sky and the sea of each weather word (kit/look.js SEAS; clouds is the core's cover, 0..1). */
export const WEATHERS = { clear: { sea: 'calm', clouds: 0.3 }, fair: { sea: 'breezy', clouds: 0.45 }, overcast: { sea: 'choppy', clouds: 0.9, veil: 1, haze: 2.8, exposure: 0.1 }, storm: { sea: 'storm', clouds: 0.85, veil: 1, haze: 3.6, exposure: -0.3 } };

/**
 * The look a place asks for by its words (time, weather): kit/look.js values ({ hour?, sea?, clouds?, exposure? }), or
 * null when it asks for none (the game's look decides). `fallback` fills what the words leave out (the gallery films a
 * place with no look words at 15.5 h, breezy).
 */
export function placeLook(r, fallback = null) {
  const w = r?.words ?? {}, t = TIMES[w.time], wx = WEATHERS[w.weather];
  if (!t && !wx) return fallback ? { ...fallback } : null;
  const out = { ...(fallback ?? {}), ...(wx ?? {}), ...(t ?? {}) };
  if (t?.exposure !== undefined || wx?.exposure !== undefined) out.exposure = (t?.exposure ?? 0) + (wx?.exposure ?? 0);
  return out;
}

/** A short name for a place's ground (its coast, ridges, harbour and terrain seed): two recipes with one key build the
 *  same island. The core's own island (no recipe) has REFERENCE's key. */
export function placeKey(recipe) {
  const r = recipe ?? REFERENCE;
  return seedHash(JSON.stringify([r.coast, r.ridges, r.harbour ?? null, r.terrain ?? null]), 'place-key').toString(16).padStart(8, '0');
}
export const REFERENCE_KEY = placeKey(REFERENCE);

/** The island the core has built now (core/src/world/Place.js activeLayout): its key, whether it is the reference
 *  island, its name and seed. What the gates read through window.__game (snapshot().world.place). */
export function builtPlace() {
  const r = activeLayout().recipe ?? null, key = placeKey(r);
  return { key, reference: key === REFERENCE_KEY, name: r?.name ?? 'reference', seed: r?.seed ?? null };
}
