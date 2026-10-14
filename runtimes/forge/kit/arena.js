// gf-forge's arena (track A; the world and its art: wave 2, track L2; a cooler place under trees and cloud: wave 3,
// track A2), vendored into a game as gf/forge/arena.js (never
// edited there): the `ruins-arena` world, a moonlit ruined courtyard generated from a seed out of the library
// (research/gf-forge/library catalog.json roles ruins.* and world.*), and the forge world lint behind verify checks 11
// (set dressing) and 17 (the world is complete). Pure: no DOM, no files; create runs it in Node, verify reads
// config/world.json with it.
//
//   generateArena({ seed, size, players, catalog })   → the layout: the ground, pieces (each a slot's model), colliders,
//                                                        fire lights, player spawns, emerge mounds, cover, lanes, zones,
//                                                        the nav grid's bounds, the pictures that tile over the pieces
//   lintWorld(world, { players, enemies, casters })   → { ok, errors, warnings, problems: [{check, rule, severity,
//                                                        message, fix}], stats }
//
// Wave 5 (track T): the lint also holds the town street (gf/forge/town.js, which takes its sizes, STREET_SIZES, and
// its helpers from here). A street's play area is not a box: a world may carry a floor plan (`floor`), and a piece may
// say another piece carries it (`carried`: an upper storey, a roof, a window on its wall). A world with neither is
// linted exactly as before.
//
// The layout (a square of 3 m tiles: small 8, medium 10, large 12 a side):
//   the ground    one picture of dark grass tiled far past the walls (its scale in metres is a slot), earth only where the
//                 dead have broken out of it, ferns and weeds along the walls, by the graves and in the open, and a
//                 path of loose flagstones from the spawns through the plaza to the gate, with spurs east and west
//   the edge      ruined block walls on the 3 m grid (ragged, windowed, broken down: the backdrop shows through), corner
//                 piers, a closed gatehouse with its grille in the north wall, and an invisible boundary just outside
//                 (nobody leaves through a broken wall)
//   fires         few, and small in the view (wave 3: the place is the moon's, blue-green; a fire is a far, warm point):
//                 two tall braziers at the gate, one low brazier by the plaza where the goal stands, a torch on each
//                 side wall (two on a large arena's), each a flickering light with a flame (six frames of one loop,
//                 the world shows one at a time)
//   spawns        the south side, 2 m apart, facing north (2-4 players)
//   the skyline   a huge dead oak, gibbets, banners by the gate and the side walls: tall things inside the walls
//   mounds        emerge points on two rings, none near the spawns (the director raises enemies 7-10 m from a player)
//   cover         broken columns, graves, lengths of broken wall, a coffin, a statue, between the plaza and the walls, spaced
//                 so lanes stay open for ranged enemies (lanes: clear lines from the mounds to the plaza and the spawns)
//   decor         loose bones by the graves and the statue (grouped, never loose in the open)
//   backdrop      three rings past the walls, no colliders, drawn in the renderer's backdrop layer (no shadow, the moon
//                 and the ambient light only): great yews in leaf close behind the wall, their broad tiers reaching over
//                 it, cedars between and behind them, a few pines and dead trees, broken towers and walls, then tall
//                 cedars as far shapes in the fog; so broad crowns cross the top of the view on every side
//   the sky       a sheet of cloud high over it all (two layers of one piece), the moon in a gap of it
export const ARENA_SIZES = { small: 8, medium: 10, large: 12 };
export const TILE = 3;
/**
 * The town street's tiles by size class (wave 5, track T: gf/forge/town.js lays the street out; the lint below holds a
 * street to them). `long`: the street's tiles from its north end to its south; `square`: the tiles [across, along] of
 * the square it opens into at its middle. The street is STREET_W tiles wide, and an alley ALLEY tiles deep runs off
 * each side of the square, so the box round the play area is square[0] + 2 × ALLEY tiles across and `long` deep.
 */
export const STREET_SIZES = { small: { long: 10, square: [7, 4] }, medium: { long: 12, square: [9, 6] }, large: { long: 14, square: [11, 6] } };
export const STREET_W = 3, ALLEY = 2;
/** The metres [across, along] of the box round a world's play area, by template and size class (null: not an outdoor world). */
export function footprint(template, sizeClass) {
  if (template === 'town-street') { const s = STREET_SIZES[sizeClass]; return s ? [(s.square[0] + 2 * ALLEY) * TILE, s.long * TILE] : null; }
  const n = ARENA_SIZES[sizeClass];
  return n ? [n * TILE, n * TILE] : null;
}
const WALL_T = 0.75;

/** Piece name → the library role (catalog.json roles). Every distinct piece is one model slot. */
export const PIECES = {
  ground: 'world.ground', dirt: 'world.ground.dirt', 'flag-a': 'world.flagstone.a', 'flag-b': 'world.flagstone.b', 'flag-c': 'world.flagstone.c',
  'wall-a': 'world.wall.a', 'wall-b': 'world.wall.b', 'wall-c': 'world.wall.c', 'wall-broken-a': 'world.wall.broken.a', 'wall-broken-b': 'world.wall.broken.b',
  corner: 'world.wall.corner', gate: 'world.gate', grille: 'world.gate.grille',
  brazier: 'ruins.brazier.tall', 'brazier-low': 'ruins.brazier', 'wall-torch': 'ruins.torch.wall',
  'flame-a': 'world.flame.a', 'flame-b': 'world.flame.b', 'flame-c': 'world.flame.c', 'flame-d': 'world.flame.d', 'flame-e': 'world.flame.e', 'flame-f': 'world.flame.f',
  fern: 'world.plant.fern', weeds: 'world.plant.weeds', yew: 'ruins.tree.yew', 'cedar-a': 'world.cedar.a', 'cedar-b': 'world.cedar.b', 'cedar-c': 'world.cedar.c', clouds: 'world.sky.clouds',
  oak: 'ruins.tree.oak', gibbet: 'ruins.gibbet', banner: 'ruins.banner', statue: 'ruins.statue', column: 'ruins.column',
  gravestone: 'ruins.grave', 'grave-cross': 'ruins.grave.cross', 'grave-broken': 'ruins.grave.broken', coffin: 'ruins.coffin',
  'bone-pile': 'ruins.bones.pile',
  skull: 'ruins.skull', bones: 'ruins.bones', ribcage: 'ruins.ribcage',
  mound: 'ruins.mound',
  'tree-large': 'ruins.tree.dead.large', 'pine-a': 'world.pine.a', 'pine-b': 'world.pine.b', 'ruin-tower': 'world.ruin.tower', 'ruin-wall': 'world.ruin.wall',
};
export const LABELS = {
  ground: 'Ground', dirt: 'Patch of earth', 'flag-a': 'Flagstone', 'flag-b': 'Small flagstone', 'flag-c': 'Large flagstone',
  'wall-a': 'Wall', 'wall-b': 'Wall (another top)', 'wall-c': 'Wall with a window', 'wall-broken-a': 'Broken wall', 'wall-broken-b': 'Broken wall (low side)',
  corner: 'Corner pier', gate: 'Gatehouse', grille: 'Gate grille',
  brazier: 'Tall brazier', 'brazier-low': 'Low brazier', 'wall-torch': 'Wall torch',
  'flame-a': 'Flame (frame 1)', 'flame-b': 'Flame (frame 2)', 'flame-c': 'Flame (frame 3)', 'flame-d': 'Flame (frame 4)', 'flame-e': 'Flame (frame 5)', 'flame-f': 'Flame (frame 6)',
  fern: 'Fern', weeds: 'Tall weeds', yew: 'Great yew', 'cedar-a': 'Cedar', 'cedar-b': 'Cedar (smaller)', 'cedar-c': 'Tall cedar', clouds: 'Clouds',
  oak: 'Great dead oak', gibbet: 'Gibbet', banner: 'Banner', statue: 'Weeping statue', column: 'Broken column',
  gravestone: 'Gravestone', 'grave-cross': 'Grave with a cross', 'grave-broken': 'Broken grave', coffin: 'Coffin',
  'bone-pile': 'Heap of bones', skull: 'Skull', bones: 'Bone', ribcage: 'Ribcage', mound: 'Emerge mound',
  'tree-large': 'Dead tree', 'pine-a': 'Pine', 'pine-b': 'Pine (smaller)', 'ruin-tower': 'Ruined tower', 'ruin-wall': 'Ruined far wall',
};
/** The pictures that tile over pieces (catalog textureFiles → a texture slot's name and label), first the ground's. */
export const SURFACES = [
  ['grass', 'world/night-grass.png', 'Ground texture', 'The picture the ground is tiled with (dark grass; square texels show up close)'],
  ['blocks', 'world/night-blocks.png', 'Wall texture', 'The picture every wall, pier, the gatehouse and the far ruins are built from (0.5 m blocks; 3 m a repeat)'],
  ['paving', 'world/night-flagstone.png', 'Flagstone texture', 'The picture of one flagstone\'s face: every slab of the path maps its top from the picture\'s middle out to its worn rim'],
  ['earth', 'world/night-dirt.png', 'Earth patch picture', 'The picture of a patch of earth (its alpha is the patch\'s ragged shape)'],
];
/** What a body walks over or through: no collider. */
/** A fire's flame: the frames of one loop, in order (the world shows one a fire at a time). */
export const FLAMES = ['flame-a', 'flame-b', 'flame-c', 'flame-d', 'flame-e', 'flame-f'];
const NO_COLLIDER = new Set(['ground', 'dirt', 'flag-a', 'flag-b', 'flag-c', 'grille', ...FLAMES, 'wall-torch', 'banner', 'mound', 'skull', 'bones', 'ribcage', 'bone-pile', 'fern', 'weeds', 'clouds']);
const COVER = [['column', 0.18], ['grave-cross', 0.16], ['gravestone', 0.14], ['grave-broken', 0.14], ['wall-broken-a', 0.13], ['wall-broken-b', 0.08], ['coffin', 0.12], ['statue', 0.05]];
const MOUNDS = { small: 6, medium: 8, large: 10 };
const COVERS = { small: 7, medium: 10, large: 14 };

const r3 = v => Math.round(v * 1000) / 1000;
const DEG = Math.PI / 180;

export function rngOf(seed) {
  let a = (Number(seed) >>> 0) || 1;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const pick = (rng, list) => { let r = rng() * list.reduce((s, x) => s + x[1], 0); for (const [v, w] of list) { r -= w; if (r <= 0) return v; } return list[0][0]; };
/** A model-space offset turned `rot` degrees about Y (three.js's yaw, as host.js transform): x' = x cos + z sin. */
const turned = ([x, y, z], rot) => { const c = Math.cos(rot * DEG), s = Math.sin(rot * DEG); return [x * c + z * s, y, -x * s + z * c]; };

/** The axis-aligned box (x, z and height) a catalog collider takes at `at`, turned `rot` degrees about Y, scaled. */
export function boxOf(collider, at, rot = 0, scale = 1) {
  if (!collider || collider === 'none' || !Array.isArray(collider.size)) return null;
  const [sx, sy, sz] = collider.size.map(v => v * scale), [ox, oy, oz] = (collider.offset ?? [0, 0, 0]).map(v => v * scale);
  const c = Math.cos(rot * DEG), s = Math.sin(rot * DEG);
  // three.js's yaw (as host.js transform): x' = x cos + z sin, z' = −x sin + z cos
  const cx = at[0] + ox * c + oz * s, cz = at[2] - ox * s + oz * c;
  const hx = Math.abs(sx / 2 * c) + Math.abs(sz / 2 * s), hz = Math.abs(sx / 2 * s) + Math.abs(sz / 2 * c);
  return { min: [r3(cx - hx), r3(at[1] + oy - sy / 2), r3(cz - hz)], max: [r3(cx + hx), r3(at[1] + oy + sy / 2), r3(cz + hz)] };
}

const roleFile = (catalog, piece) => { const r = catalog?.roles?.[PIECES[piece]]; return r?.file ?? null; };
/** A piece's catalog entry (its size, collider, sockets, the picture it is tiled with), whichever section holds it. */
export const entryOf = (catalog, piece) => { const f = roleFile(catalog, piece); if (!f) return null; for (const sec of Object.values(catalog.sections ?? {})) if (sec[f]) return sec[f]; return null; };

/**
 * The ruins arena's layout. `catalog`: research/gf-forge/library/catalog.json (sizes, colliders, sockets). Pure and
 * seeded: the same seed, size and players give the same arena.
 */
export function generateArena({ seed = 1, size = 'medium', players = 4, catalog } = {}) {
  if (!catalog?.roles) throw new Error('generateArena needs the forge library catalog (research/gf-forge/library/catalog.json)');
  const rng = rngOf(seed);
  const sizeClass = ARENA_SIZES[size] ? size : 'medium';
  const n = ARENA_SIZES[sizeClass], half = (n * TILE) / 2;
  const pieces = [], colliders = [], lights = [];
  const solids = [];   // [{min, max, kind}] for spacing tests while placing
  const place = (piece, at, rot = 0, kind = 'decor', scale = 1, extra = null) => {
    const e = entryOf(catalog, piece);
    if (!e) throw new Error(`the forge library has no ${PIECES[piece]} (${piece})`);
    const p = { piece, slot: `world.ruins-arena.${piece}`, at: at.map(r3), rot, scale: r3(scale), kind, height: r3((e.size?.[1] ?? 1) * scale), ...(extra ?? {}) };
    pieces.push(p);
    if (!NO_COLLIDER.has(piece) && kind !== 'backdrop') {
      const b = boxOf(e.collider, at, rot, scale);
      if (b) { colliders.push({ ...b, kind, piece }); solids.push({ ...b, kind }); }
    }
    return p;
  };
  const clearOf = (x, z, pad, kinds = null) => solids.every(b => (kinds && !kinds.includes(b.kind)) || x < b.min[0] - pad || x > b.max[0] + pad || z < b.min[2] - pad || z > b.max[2] + pad);

  // ---- the ground: sheets of one picture laid edge to edge far past the walls (world.js lays them: a sheet is `span`
  // metres with the picture repeated every `tile` metres, and `metres`, the repeat a game wants, a slot, scales it);
  // the ground every body stands on; the invisible boundary past the walls
  const groundEntry = entryOf(catalog, 'ground'), groundTile = groundEntry?.tile ?? 8;
  const ground = { piece: 'ground', slot: 'world.ruins-arena.ground', metres: groundTile, tile: groundTile, span: groundEntry?.span ?? groundTile, reach: r3(half + 42), y: 0 };
  colliders.push({ min: [-half - 9, -1, -half - 9], max: [half + 9, 0, half + 9], kind: 'ground' });
  for (const [min, max] of [[[-half - 2, 0, -half - 2], [half + 2, 6, -half - 1]], [[-half - 2, 0, half + 1], [half + 2, 6, half + 2]], [[-half - 2, 0, -half - 1], [-half - 1, 6, half + 1]], [[half + 1, 0, -half - 1], [half + 2, 6, half + 1]]]) colliders.push({ min, max, kind: 'boundary', invisible: true });

  // ---- the edge: ruined block walls on the grid, corner piers, the gatehouse in the north wall; where a torch hangs
  // the wall is a whole one ----
  const wz = half + WALL_T / 2;
  const gateK = Math.floor(n / 2) - (n % 2 ? 0 : 1);
  const gateX = -half + TILE / 2 + gateK * TILE;
  // a torch on each side wall, in the north half (the spawns' end stays the moon's); a large arena has a second, south
  const torchK = new Set([Math.round(n * 0.3), ...(n >= 12 ? [n - 1 - Math.round(n * 0.25)] : [])]);
  const torches = [];
  let prev = '';
  for (const [side, rot] of [['n', 0], ['s', 180], ['w', 90], ['e', -90]]) {
    for (let k = 0; k < n; k++) {
      const along = -half + TILE / 2 + k * TILE;
      const at = side === 'n' ? [along, 0, -wz] : side === 's' ? [along, 0, wz] : side === 'w' ? [-wz, 0, along] : [wz, 0, along];
      if (side === 'n' && k === gateK) { place('gate', [along, 0, -half - 0.5], 0, 'edge'); place('grille', [along, 0, -half - 0.5], 0, 'edge'); prev = 'gate'; continue; }
      const lit = (side === 'w' || side === 'e') && torchK.has(k);
      let piece = lit ? (rng() < 0.5 ? 'wall-a' : 'wall-b') : pick(rng, [['wall-a', 0.24], ['wall-b', 0.2], ['wall-c', 0.16], ['wall-broken-a', 0.22], ['wall-broken-b', 0.18]]);
      if (piece.startsWith('wall-broken') && prev.startsWith('wall-broken')) piece = rng() < 0.5 ? 'wall-a' : 'wall-b';
      place(piece, at, rot, 'edge');
      // the torch on the wall's inner face (the piece's own origin is on the ground under it)
      if (lit) torches.push([side === 'n' ? [along, 0, -half] : side === 's' ? [along, 0, half] : side === 'w' ? [-half, 0, along] : [half, 0, along], rot]);
      prev = piece;
    }
  }
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) place('corner', [sx * (half + 0.5), 0, sz * (half + 0.5)], sx * sz > 0 ? 0 : 90, 'edge');

  // ---- fire: few and far (wave 3). Two tall braziers at the gate, one low brazier at the plaza's south edge beside where
  // the goal stands, the wall torches. Each is a light at its socket_flame with the flame's frames standing in it (one
  // shown at a time: kit/world.js) ----
  const flame = piece => entryOf(catalog, piece)?.sockets?.flame?.position ?? [0, 1, 0];
  const lit = (piece, at, rot = 0, size = 1) => {
    place(piece, at, rot, 'light');
    const f = turned(flame(piece), rot), p = [r3(at[0] + f[0]), r3(at[1] + f[1]), r3(at[2] + f[2])];
    const li = lights.length, turn = Math.floor(rng() * 360);
    lights.push({ at: [p[0], r3(p[1] + 0.26 * size), p[2]], seed: li + 1, kind: piece });
    FLAMES.forEach((fl, k) => place(fl, [p[0], r3(p[1] - 0.05), p[2]], turn, 'flame', size, { light: li, frame: k }));
  };
  const plazaR = n >= 12 ? 7.0 : 5.0;
  lit('brazier', [gateX - 2.6, 0, -half + 1.6], 0, 0.85);
  lit('brazier', [gateX + 2.6, 0, -half + 1.6], 0, 0.85);
  lit('brazier-low', [(rng() < 0.5 ? -1 : 1) * 2.7, 0, plazaR - 0.4], Math.floor(rng() * 4) * 90, 0.8);
  for (const [at, rot] of torches) lit('wall-torch', at, rot, 0.55);

  // ---- spawns: the south side, facing north ----
  const P = Math.max(2, Math.min(4, players));
  const spawns = [];
  for (let i = 0; i < P; i++) spawns.push([r3((i - (P - 1) / 2) * 2.0), 0.05, r3(half - 3.2), r3(Math.PI)]);
  const nearSpawn = (x, z, d) => spawns.some(s => Math.hypot(s[0] - x, s[2] - z) < d);
  // the path's middle at z: from the spawns straight to the plaza, then over to the gate
  const pathX = z => (z < 0 ? gateX * Math.min(1, -z / (half - 2)) : 0);
  const onPath = (x, z, w = 2.4) => Math.abs(x - pathX(z)) < w;

  // ---- the skyline inside the walls: a great oak, gibbets, banners, a statue ----
  const cover = [];
  {
    // the oak: off the path, in the north half, clear of the plaza
    const sx = rng() < 0.5 ? -1 : 1, x = sx * half * (0.5 + rng() * 0.12), z = -half * (0.2 + rng() * 0.25);
    cover.push(place('oak', [x, 0, z], Math.floor(rng() * 360), 'cover', 0.9 + rng() * 0.15));
    // gibbets: one in the other north corner, one by the south wall on the oak's side
    cover.push(place('gibbet', [-sx * (half - 3.2), 0, -half + 3.4], sx > 0 ? 200 : -20, 'cover'));
    cover.push(place('gibbet', [sx * (half - 2.6), 0, half - 4.2 - rng() * 2], sx > 0 ? 60 : 120, 'cover'));
    // banners: either side of the gate, and one at the middle of each side wall
    place('banner', [gateX - 1.85, 0, -half + 0.45], 0, 'decor');
    place('banner', [gateX + 1.85, 0, -half + 0.45], 0, 'decor');
    place('banner', [-half + 0.5, 0, (rng() - 0.5) * 3], 90, 'decor');
    place('banner', [half - 0.5, 0, (rng() - 0.5) * 3], -90, 'decor');
  }

  // ---- emerge mounds: two rings, none near the spawns or a solid ----
  const mounds = [];
  const cands = [];
  for (const [r, off] of [[0.5, 0], [0.8, 22.5]]) for (let k = 0; k < 8; k++) {
    const a = (off + k * 45 + (rng() - 0.5) * 16) * DEG, rr = half * (r + (rng() - 0.5) * 0.08);
    cands.push([Math.sin(a) * rr, Math.cos(a) * rr]);
  }
  for (let i = cands.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [cands[i], cands[j]] = [cands[j], cands[i]]; }
  // two rings first, then anywhere free, until the size's count
  for (let k = 0; k < 40; k++) cands.push([(rng() * 2 - 1) * (half - 2.5), (rng() * 2 - 1) * (half - 2.5)]);
  for (const [x, z] of cands) {
    if (mounds.length >= MOUNDS[sizeClass]) break;
    if (Math.abs(x) > half - 2 || Math.abs(z) > half - 2 || nearSpawn(x, z, 6) || !clearOf(x, z, 1.2) || mounds.some(m => Math.hypot(m[0] - x, m[2] - z) < 4)) continue;
    mounds.push([r3(x), 0, r3(z)]);
    place('mound', [x, 0, z], Math.floor(rng() * 360), 'mound');
  }

  // ---- cover: spaced between the plaza and the walls, clear of the path, spawns and mounds ----
  const cover0 = cover.length;
  for (let tries = 0; tries < 900 && cover.length - cover0 < COVERS[sizeClass]; tries++) {
    const x = (rng() * 2 - 1) * (half - 2.8), z = (rng() * 2 - 1) * (half - 2.8);
    // never in the plaza, on the path, on the spawns, on a mound, or in the approach from the spawns (the first look)
    const approach = Math.abs(x) < 5.5 && z > plazaR - 0.5;
    if (Math.hypot(x, z) < plazaR + 0.6 || approach || onPath(x, z, 2.6) || nearSpawn(x, z, 3.6) || mounds.some(m => Math.hypot(m[0] - x, m[2] - z) < 2.6)) continue;
    if (cover.some(c => Math.hypot(c.at[0] - x, c.at[2] - z) < 3.8)) continue;
    const piece = pick(rng, COVER), long = piece.startsWith('wall-broken') || piece === 'coffin' || piece === 'column';
    if (!clearOf(x, z, long ? 2.4 : 1.6)) continue;
    cover.push(place(piece, [x, 0, z], piece === 'column' ? Math.floor(rng() * 4) * 90 : 90 * Math.floor(rng() * 4) + (piece.startsWith('grave') || piece === 'statue' ? Math.round((rng() - 0.5) * 30) : 0), 'cover'));
  }

  // ---- decor, grouped: loose bones by the graves and the coffin; a heap of bones by the west wall ----
  const loose = [];
  for (const c of cover.filter(c => c.piece.startsWith('grave') || c.piece === 'coffin' || c.piece === 'statue')) {
    for (let k = 0; k < 2; k++) {
      if (rng() > 0.62) continue;
      const a = rng() * Math.PI * 2, d = 1.0 + rng() * 0.45;
      const at = [c.at[0] + Math.cos(a) * d, 0, c.at[2] + Math.sin(a) * d];
      const piece = rng() < 0.4 ? 'skull' : rng() < 0.6 ? 'bones' : 'ribcage';
      // a loose bone lies on the ground, a little sunk: its centre (the file's origin) most of half its height up
      const h = (entryOf(catalog, piece)?.size?.[1] ?? 0.1) / 2;
      if (clearOf(at[0], at[2], 0.2) && Math.abs(at[0]) < half - 1 && Math.abs(at[2]) < half - 1 && !loose.some(q => Math.hypot(q[0] - at[0], q[1] - at[2]) < 0.45)) { loose.push([at[0], at[2]]); place(piece, [at[0], h * 0.8, at[2]], Math.floor(rng() * 360), 'decor', 1, { lie: r3(h) }); }
    }
  }
  {
    const z = half * (0.25 + rng() * 0.35) * (rng() < 0.5 ? -1 : 1);
    if (clearOf(-half + 1.3, z, 0.9) && !mounds.some(m => Math.hypot(m[0] + half - 1.3, m[2] - z) < 2.2)) place('bone-pile', [r3(-half + 1.3), 0, r3(z)], Math.floor(rng() * 360), 'decor');
  }

  // ---- the ground's dressing: earth where the dead have broken out (under each mound) and in a few small patches
  // (wave 3: the ground is grass, not bare earth), the flagstone path ----
  for (const m of mounds) place('dirt', [m[0], 0, m[2]], Math.floor(rng() * 360), 'floor', 0.72 + rng() * 0.2);
  for (let k = 0; k < Math.round(n * 0.4); k++) {
    const x = (rng() * 2 - 1) * (half - 1.5), z = (rng() * 2 - 1) * (half - 1.5);
    if (Math.hypot(x, z) < plazaR + 0.5 || onPath(x, z, 2.2)) continue;
    place('dirt', [x, 0, z], Math.floor(rng() * 360), 'floor', 0.45 + rng() * 0.35);
  }
  // a slab never overlaps another (two tops at one height would shimmer): each keeps its reach clear
  const slabs = [], reachOf = Object.fromEntries(['flag-a', 'flag-b', 'flag-c'].map(f => { const s = entryOf(catalog, f)?.size ?? [1, 0, 1]; return [f, Math.max(s[0], s[2]) / 2]; }));
  const slab = (x, z, big = 0) => {
    if (Math.abs(x) > half - 0.7 || Math.abs(z) > half - 0.3 || mounds.some(m => Math.hypot(m[0] - x, m[2] - z) < 1.5) || !clearOf(x, z, 0.3)) return;
    const q = rng(), piece = q < 0.34 + big ? 'flag-c' : q < 0.72 ? 'flag-a' : 'flag-b', scale = 0.85 + rng() * 0.3, reach = reachOf[piece] * scale;
    if (slabs.some(s => Math.hypot(s[0] - x, s[1] - z) < (s[2] + reach) * 0.94)) return;
    slabs.push([x, z, reach]);
    // some lie a little sunk
    place(piece, [x, -rng() * 0.022, z], Math.floor(rng() * 360), 'floor', scale);
  };
  // from the south wall to the gate, three slabs wide, worn (some missing)
  for (let z = half - 0.9; z > -half + 0.4; z -= 1.12) for (const dx of [-1.2, 0, 1.2]) { if (rng() < 0.12) continue; slab(pathX(z) + dx + (rng() - 0.5) * 0.3, z + (rng() - 0.5) * 0.3); }
  // the plaza: rings of slabs
  for (const rr of [1.25, 2.5, 3.7, ...(plazaR > 6 ? [4.9, 6.0] : [])]) { const cnt = Math.round((2 * Math.PI * rr) / 1.2), a0 = rng() * 6.28; for (let k = 0; k < cnt; k++) { if (rng() < 0.1) continue; const a = a0 + (k / cnt) * Math.PI * 2; slab(Math.cos(a) * rr + (rng() - 0.5) * 0.2, Math.sin(a) * rr + (rng() - 0.5) * 0.2, 0.15); } }
  // spurs east and west from the plaza, thinner and more worn
  for (const sx of [-1, 1]) for (let x = plazaR - 0.4; x < half - 1.4; x += 1.15) for (const dz of [-0.62, 0.62]) { if (rng() < 0.35) continue; slab(sx * x + (rng() - 0.5) * 0.3, dz + (rng() - 0.5) * 0.3); }

  // ---- small plants (wave 3): ferns and weeds at the walls' feet, by the graves and the columns, and tufts in the open
  // (never on a slab, the plaza or a spawn); no colliders ----
  {
    const offSlab = (x, z) => !slabs.some(sl => Math.hypot(sl[0] - x, sl[1] - z) < sl[2] + 0.25);
    let plants = 0;
    const plant = (x, z, tall = 0.5) => {
      if (Math.abs(x) > half - 0.25 || Math.abs(z) > half - 0.25 || !offSlab(x, z) || nearSpawn(x, z, 1.2) || Math.hypot(x, z) < plazaR - 0.6) return;
      // (drawn in the backdrop layer: a clump of crossed cards casts no shadow and asks for none)
      place(rng() < tall ? 'weeds' : 'fern', [x, 0, z], Math.floor(rng() * 360), 'floor', 0.8 + rng() * 0.7, { layer: 'backdrop', thin: plants++ % 2 === 1 });
    };
    // along each wall's inner face (not across the gate)
    for (let t = -half + 0.6; t < half - 0.4; t += 0.9 + rng() * 1.3) for (const side of [0, 1, 2, 3]) {
      if (rng() < 0.3) continue;
      const d = half - 0.3 - rng() * 0.5, j = t + (rng() - 0.5) * 0.6;
      if (side === 0 && Math.abs(j - gateX) < 1.7) continue;
      plant(side === 0 ? j : side === 1 ? j : side === 2 ? -d : d, side === 0 ? -d : side === 1 ? d : j, 0.55);
    }
    // by the cover: a tuft or two at the foot of each grave, statue and column
    for (const c of cover) for (let k = 0; k < 2; k++) { if (rng() < 0.35) continue; const a = rng() * Math.PI * 2, d = 0.75 + rng() * 0.6; plant(c.at[0] + Math.cos(a) * d, c.at[2] + Math.sin(a) * d, 0.6); }
    // in the open: clumps of two to four
    for (let k = 0; k < Math.round(n * n * 0.16); k++) {
      const x = (rng() * 2 - 1) * (half - 1), z = (rng() * 2 - 1) * (half - 1);
      if (onPath(x, z, 1.9)) continue;
      for (let q = 0, m = 2 + Math.floor(rng() * 3); q < m; q++) plant(x + (rng() - 0.5) * 1.5, z + (rng() - 0.5) * 1.5, 0.35);
    }
  }

  // ---- the backdrop past the walls, three rings (no colliders; the renderer's backdrop layer). Wave 3: broad crowns,
  // close together. Great yews in leaf close behind the wall, their wide side to the arena so their tiers reach over it,
  // cedars between them, a few dead trees and pines; cedars, pines and ruins behind; tall cedars as far shapes ----
  const ringAt = (a, d) => { const cx = Math.cos(a), cz = Math.sin(a), m = Math.max(Math.abs(cx), Math.abs(cz)); return [cx / m * d, cz / m * d]; };
  const facing = a => Math.round((-a / DEG + 90) / 90) * 90;
  const stood = [];   // where a backdrop piece already stands: two trunks never share a spot
  const ring = (count, d0, d1, table, scaleOf, rotOf = null) => {
    const a0 = rng() * 6.28;
    for (let k = 0; k < count; k++) {
      const a = a0 + (k / count) * Math.PI * 2 + (rng() - 0.5) * (4.2 / count), [x, z] = ringAt(a, half + d0 + rng() * (d1 - d0));
      const piece = pick(rng, table), rot = rotOf?.(piece, a) ?? Math.floor(rng() * 360), scale = scaleOf(piece);
      if (stood.some(q => Math.hypot(q[0] - x, q[1] - z) < 1.4)) continue;
      stood.push([x, z]);
      place(piece, [x, 0, z], rot, 'backdrop', scale);
    }
  };
  // the yews: evenly round, 5 to 8 m past the wall (their crowns are 16 m and more across, so they reach over it)
  ring(Math.round(n * 1.2), 5.4, 8.4, [['yew', 1]], () => 0.95 + rng() * 0.4, (p, a) => facing(a) + Math.round((rng() - 0.5) * 50));
  ring(Math.round(n * 2.2), 4.4, 8, [['cedar-a', 0.34], ['cedar-b', 0.4], ['tree-large', 0.16], ['pine-b', 0.1]], p => (p === 'tree-large' ? 1.5 + rng() * 0.8 : 0.85 + rng() * 0.4));
  // the far ruins: lengths of wall facing the arena and tower stumps, at seeded bearings
  { const a0 = rng() * 6.28; for (let k = 0; k < 5; k++) { const a = a0 + (k / 5) * Math.PI * 2 + (rng() - 0.5) * 0.5, [x, z] = ringAt(a, half + 8 + rng() * 5); if (k % 2) place('ruin-tower', [x, 0, z], Math.floor(rng() * 4) * 90, 'backdrop', 1 + rng() * 0.25); else place('ruin-wall', [x, 0, z], facing(a), 'backdrop', 1 + rng() * 0.3); } }
  ring(Math.round(n * 3.4), 7.5, 15.5, [['cedar-a', 0.36], ['cedar-c', 0.3], ['cedar-b', 0.16], ['pine-a', 0.12], ['yew', 0.06]], p => (p === 'yew' ? 1.3 + rng() * 0.4 : 1.0 + rng() * 0.5), (p, a) => (p === 'yew' ? facing(a) + Math.round((rng() - 0.5) * 50) : null));
  ring(Math.round(n * 3.4), 16, 32, [['cedar-c', 0.5], ['cedar-a', 0.3], ['pine-a', 0.2]], () => 1.4 + rng() * 0.9);

  // ---- the sky: one sheet of cloud high over the arena, laid twice (kit/world.js hangs the layers and puts the
  // sheet's gap where the moon stands) ----
  const cloudEntry = entryOf(catalog, 'clouds');
  const sky = cloudEntry ? { piece: 'clouds', slot: 'world.ruins-arena.clouds', height: 64, layers: 2, tile: cloudEntry.tile ?? 192, span: cloudEntry.span ?? 768, gap: cloudEntry.gap ?? [0.5, 0.5] } : null;

  // ---- lanes: clear straight lines from each mound to the plaza and to the spawns (ranged enemies use them) ----
  const lanes = [];
  const blockers = colliders.filter(c => ['cover', 'light', 'edge', 'decor'].includes(c.kind) && c.max[1] > 1.0);
  for (const m of mounds) for (const to of [[0, 0], ...spawns.map(s => [s[0], s[2]])]) {
    const len = Math.hypot(to[0] - m[0], to[1] - m[2]);
    if (len >= 6 && segmentClear([m[0], m[2]], to, blockers, 0.2)) lanes.push({ from: [m[0], m[2]], to: to.map(r3), length: r3(len) });
  }

  // ---- the pictures that tile over pieces: each a texture slot over the pieces built from it ----
  const textureGroups = {};
  for (const [group, file] of SURFACES) {
    const on = new Set();
    for (const p of [ground, ...pieces]) if ((entryOf(catalog, p.piece)?.textureFiles ?? []).includes(file)) on.add(p.slot);
    if (on.size) textureGroups[group] = { file, on: [...on], metres: catalog.sections?.world?.[file]?.metres ?? null };
  }
  return {
    template: 'ruins-arena', kind: 'forge-arena', seed, sizeClass, size: [n * TILE, n * TILE], half,
    ground, ...(sky ? { sky } : {}), pieces, colliders, lights, spawns, mounds, lanes,
    cover: cover.map(c => ({ piece: c.piece, at: c.at })),
    zones: { centre: { shape: 'circle', at: [0, 0, 0], size: [3] }, plaza: { shape: 'circle', at: [0, 0, 0], size: [plazaR] } },
    textureGroups,
    nav: { min: [-half, -half], max: [half, half], cell: 0.5 },
    floorLimit: -10,
  };
}

/** Does the segment a→b (x, z) stay clear of every box (grown by `pad`)? */
export function segmentClear(a, b, boxes, pad = 0) {
  const n = Math.max(2, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 0.2));
  for (let k = 1; k < n; k++) {
    const x = a[0] + (b[0] - a[0]) * (k / n), z = a[1] + (b[1] - a[1]) * (k / n);
    for (const c of boxes) if (x >= c.min[0] - pad && x <= c.max[0] + pad && z >= c.min[2] - pad && z <= c.max[2] + pad) return false;
  }
  return true;
}

// ---------- the lint (verify checks 11 and 17 on forge) ----------

export const RULES = {
  11: {
    'unknown-piece': 'a piece names no model slot or file',
    overlap: 'two solid pieces interpenetrate',
    duplicate: 'the same piece twice in one spot',
    floating: 'a piece hangs in the air or sinks into the ground (a flame at its fire and a loose bone lying on the ground do not, nor does a piece that says it is carried when another piece stands under or beside it: an upper storey, a roof, a window on its wall)',
    'spawn-count': 'fewer spawns than players',
    'spawn-blocked': 'a spawn is inside or against a solid piece',
    'spawn-edge': 'a spawn is at or past the edge',
    'spawn-close': 'two spawns are almost on top of each other',
    'mound-blocked': 'an emerge mound is inside or against a solid piece',
    'crowded-centre': 'the middle of the arena is crowded',
    cramped: 'too little open floor to fight on',
    loose: 'small decor loose in the open, away from anything (reads as litter)',
  },
  17: {
    size: 'the play area does not match its size class, or (a world with a floor plan) its floor reaches outside it',
    walls: 'the edge has gaps a player can leave through, or is not visible where it stops them (the edge of a world with a floor plan is the outline of its floor: a street\'s house fronts, its closed ends, its alleys\' backs; there no 1.5 m of it may be closed by an invisible boundary alone)',
    continues: 'nothing shows past the walls (a void over the top of the wall)',
    entries: 'enemies come, but the world has too few emerge points for its size',
    reachable: 'a spawn or an emerge point is cut off from the rest of the floor',
    cover: 'too little cover for a fight (ranged enemies, flanking a shield-bearer)',
    lanes: 'too few clear lanes for ranged enemies',
    lights: 'too few fire lights (feel targets: at least 4 flickering fires)',
  },
};

const solidKinds = new Set(['edge', 'cover', 'light', 'decor', 'prop']);
/** A world's pieces and colliders with kinds (the crypt room's pieces carry names only). */
function normalise(world) {
  const pieceKind = p => p.kind ?? (['wall', 'pillar'].includes(p.piece) ? 'edge' : p.piece === 'floor' ? 'floor' : p.piece === 'torch' ? 'light' : 'decor');
  const pieces = [...(world.pieces ?? []).map(p => ({ ...p, kind: pieceKind(p) })), ...(world.props ?? []).map(p => ({ ...p, piece: p.prop, slot: `prop.${p.prop}`, kind: 'prop' }))];
  // a collider no higher than 0.2 m is floor (the room's tiles); a tall one with no kind is the room's walls
  const colliders = (world.colliders ?? []).map(c => ({ ...c, kind: c.kind ?? (c.max[1] <= 0.2 ? 'ground' : c.max[1] - c.min[1] > 2.5 ? 'edge' : 'decor') }));
  return { pieces, colliders };
}

/**
 * The forge world lint: check 11's rules and check 17's on a world.json (ruins-arena, town-street or crypt-room).
 * `players`: the most players; `enemies`: the game has enemies (waves), `casters`: some throw.
 *
 * The play area is the box `size` round the origin, or, where a world has a floor plan (`floor`: [[x0, z0, x1, z1]]
 * rectangles in metres, as a street with a square and alleys has), their union inside that box: open floor is counted
 * on it, spawns stand on it, its outline is the edge that must be closed and seen, and what is reached is reached
 * over it.
 */
export function lintWorld(world, { players = 4, enemies = false, casters = false } = {}) {
  const problems = [];
  const add = (check, rule, severity, message, fix) => problems.push({ check, rule, severity, message, fix });
  const { pieces, colliders } = normalise(world);
  const arena = world.kind === 'forge-arena';
  const [W, D] = world.size ?? [9, 9];
  const hx = W / 2, hz = D / 2;
  // the floor plan: its rectangles, or the whole box
  const plan = Array.isArray(world.floor) && world.floor.length ? world.floor.filter(r => Array.isArray(r) && r.length === 4 && r.every(Number.isFinite)) : null;
  const floor = plan?.length ? plan : [[-hx, -hz, hx, hz]];
  const onFloor = (x, z) => floor.some(r => x >= r[0] && x <= r[2] && z >= r[1] && z <= r[3]);
  const solid = colliders.filter(c => solidKinds.has(c.kind) && !c.invisible);
  const near = (x, z, c, pad) => x >= c.min[0] - pad && x <= c.max[0] + pad && z >= c.min[2] - pad && z <= c.max[2] + pad;

  // ---- 11: set dressing ----
  for (const p of pieces) if (!p.slot || !(p.piece || p.prop)) add(11, 'unknown-piece', 'error', `a piece at ${p.at} has no slot`, 'every piece names its model slot (world.<template>.<piece>)');
  const inner = solid.filter(c => c.kind !== 'edge');
  for (let i = 0; i < inner.length; i++) for (let j = i + 1; j < inner.length; j++) {
    const a = inner[i], b = inner[j];
    const ox = Math.min(a.max[0], b.max[0]) - Math.max(a.min[0], b.min[0]), oz = Math.min(a.max[2], b.max[2]) - Math.max(a.min[2], b.min[2]), oy = Math.min(a.max[1], b.max[1]) - Math.max(a.min[1], b.min[1]);
    if (ox > 0.08 && oz > 0.08 && oy > 0.08) add(11, 'overlap', 'error', `${a.piece ?? a.kind} and ${b.piece ?? b.kind} interpenetrate (${ox.toFixed(2)} × ${oz.toFixed(2)} m)`, 'move one of them in config/world.json');
  }
  const seen = new Map();
  for (const p of pieces) {
    const k = `${p.slot}@${p.at.map(v => Math.round(v * 20)).join(',')}`;
    if (seen.has(k) && p.kind !== 'floor' && p.kind !== 'flame') add(11, 'duplicate', 'error', `${p.piece} twice at ${p.at}`, 'remove one');
    seen.set(k, true);
    const y = p.at[1];
    // a piece that says it is carried is, when another piece stands under or beside it and reaches its height (a
    // storey on the one below, a roof on the top one, a window or a sign on its wall, a far house's window)
    const reach = p.kind === 'backdrop' ? 6 : 2.2;
    const carried = p.carried === true && y > 0 && pieces.some(q => q !== p && q.kind !== 'floor' && q.kind !== 'flame' && Number.isFinite(q.height) && Math.abs(q.at[0] - p.at[0]) <= reach && Math.abs(q.at[2] - p.at[2]) <= reach && q.at[1] < y + 0.01 && q.at[1] + q.height > y - 0.11);
    const hangs = p.kind === 'flame' ? false : p.kind === 'floor' ? Math.abs(y) > 0.12 : p.kind === 'light' && p.piece === 'torch' && !arena ? false : carried ? false : y > 0.05 + (p.lie ?? 0) || y < -0.06;
    if (hangs) add(11, 'floating', 'error', `${p.piece} at height ${y}${p.carried === true ? ': it says it is carried, and no piece stands under or beside it at that height' : ''}`, p.carried === true ? 'put back the piece that carried it, or take this one out' : 'stand it on the ground (y 0)');
  }
  const spawns = world.spawns ?? [];
  if (spawns.length < Math.min(players, 4)) add(11, 'spawn-count', 'error', `${spawns.length} spawns for ${players} players`, 'one spawn per seat');
  spawns.forEach((s, i) => {
    if (solid.some(c => near(s[0], s[2], c, 0.6))) add(11, 'spawn-blocked', 'error', `spawn ${i + 1} at ${s[0]}, ${s[2]} is against a solid piece`, 'move it or the piece');
    if (![[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]].every(([dx, dz]) => onFloor(s[0] + dx, s[2] + dz))) add(11, 'spawn-edge', 'error', `spawn ${i + 1} is at the edge`, 'move it 1 m or more inside');
    spawns.forEach((t, j) => { if (j > i && Math.hypot(s[0] - t[0], s[2] - t[2]) < 1.5) add(11, 'spawn-close', 'error', `spawns ${i + 1} and ${j + 1} are ${Math.hypot(s[0] - t[0], s[2] - t[2]).toFixed(2)} m apart`, 'at least 1.5 m apart'); });
  });
  for (const [i, m] of (world.mounds ?? []).entries()) if (solid.some(c => near(m[0], m[2], c, 0.8))) add(11, 'mound-blocked', 'error', `emerge mound ${i + 1} at ${m[0]}, ${m[2]} is against a solid piece`, 'enemies would rise into it: move it');
  // floor cover: a 0.5 m sample of the play area
  let cells = 0, open = 0, centre = 0, centreBlocked = 0;
  const cr = Math.min(W, D) * 0.3 * (arena ? 0.5 : 1);
  for (let x = -hx + 0.25; x < hx; x += 0.5) for (let z = -hz + 0.25; z < hz; z += 0.5) {
    if (plan && !onFloor(x, z)) continue;
    cells++;
    const blocked = solid.some(c => c.max[1] > 0.35 && near(x, z, c, 0));
    if (!blocked) open++;
    if (Math.hypot(x, z) < cr) { centre++; if (blocked) centreBlocked++; }
  }
  const openShare = cells ? open / cells : 0, centreShare = centre ? centreBlocked / centre : 0;
  if (centreShare > 0.25) add(11, 'crowded-centre', 'error', `${(centreShare * 100).toFixed(0)}% of the middle is solid`, 'keep the middle open');
  if (openShare < 0.65) add(11, 'cramped', 'error', `${(openShare * 100).toFixed(0)}% of the floor is open`, 'remove cover (at least 65% open)');
  const small = pieces.filter(p => ['skull', 'bones', 'ribcage', 'candles'].includes(p.piece));
  const anchors = pieces.filter(p => ['cover', 'edge', 'decor', 'light'].includes(p.kind) && !small.includes(p));
  for (const p of small) if (!anchors.some(a => Math.hypot(a.at[0] - p.at[0], a.at[2] - p.at[2]) < 2.0)) add(11, 'loose', 'warning', `${p.piece} at ${p.at[0]}, ${p.at[2]} is alone in the open`, 'put it by a grave, a wall or the shrine');

  // ---- 17: the world is complete ----
  if (arena) {
    const street = world.template === 'town-street', fp = footprint(world.template, world.sizeClass);
    if (street ? !fp || Math.abs(W - fp[0]) > 0.01 || Math.abs(D - fp[1]) > 0.01 : !fp || Math.abs(W - fp[0]) > 0.01) add(17, 'size', 'error', street ? `the street's play area is ${W} by ${D} m for size class ${world.sizeClass}` : `the arena is ${W} m for size class ${world.sizeClass}`, street ? `a ${world.sizeClass} street is ${fp ? fp.join(' by ') : '?'} m` : `a ${world.sizeClass} arena is ${ARENA_SIZES[world.sizeClass] * TILE} m`);
    const out = plan ? floor.filter(r => r[0] < -hx - 0.01 || r[2] > hx + 0.01 || r[1] < -hz - 0.01 || r[3] > hz + 0.01).length : 0;
    if (out) add(17, 'size', 'error', `${out} of the floor plan's ${floor.length} rectangles reach outside the play area's ${W} by ${D} m`, 'keep the floor inside the size (config/world.json → floor, size)');
  }
  // the edge: every 0.5 m along it is stopped (any collider), and stopped by something visible over 90% of it
  const stops = colliders.filter(c => c.max[1] > 1.2 && c.kind !== 'ground');
  const visible = stops.filter(c => !c.invisible);
  // (the play area's outline: every side of each rectangle of the floor, where the next half metre out is not floor too)
  const sides = [];
  for (const [x0, z0, x1, z1] of floor) {
    const n = [], s = [], w = [], e = [];
    for (let t = x0 + 0.25; t < x1; t += 0.5) { n.push([t, z0 - 0.5]); s.push([t, z1 + 0.5]); }
    for (let t = z0 + 0.25; t < z1; t += 0.5) { w.push([x0 - 0.5, t]); e.push([x1 + 0.5, t]); }
    sides.push(n, s, w, e);
  }
  // (a world with a floor plan: no stretch of 1.5 m or more may be closed by an invisible boundary alone. A street's
  // end or an alley's back with nothing standing in it reads as a way out, however solid the boundary behind it)
  let samples = 0, stopped = 0, seenEdge = 0, unseen = null;
  for (const side of sides) { let run = 0; for (const [x, z] of side) {
    if (plan && onFloor(x, z)) { run = 0; continue; }
    samples++;
    if (stops.some(c => near(x, z, c, 0.3)) || stops.some(c => near(x * 1.08, z * 1.08, c, 0.3))) stopped++;
    if (visible.some(c => near(x, z, c, 0.35))) { seenEdge++; run = 0; }
    else if (++run >= 3 && plan && (!unseen || run > unseen.run)) unseen = { run, x, z };
  } }
  if (stopped < samples) add(17, 'walls', 'error', `${samples - stopped} of ${samples} points along the edge let a player out`, 'close the edge (walls, or an invisible boundary behind ruins)');
  if (unseen) add(17, 'walls', 'error', `${unseen.run * 0.5} m of the edge by ${unseen.x}, ${unseen.z} has nothing a player can see closing it`, 'stand something there that reads as closed: a house front, a fence, a barricade, railings (an invisible boundary alone looks like a way out)');
  if (seenEdge / samples < 0.9) add(17, 'walls', 'error', `only ${((seenEdge / samples) * 100).toFixed(0)}% of the edge is a wall you can see`, 'a wall, fence or ruin along the whole edge');
  // the view over the walls goes on: tall things past the edge in most directions
  if (arena) {
    const tall = pieces.filter(p => p.kind === 'backdrop' && (p.height ?? 0) >= 2.0 && (Math.abs(p.at[0]) > hx || Math.abs(p.at[2]) > hz));
    let dirs = 0;
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * Math.PI * 2;
      if (tall.some(p => { const ang = Math.atan2(p.at[2], p.at[0]); let d = Math.abs(ang - a); d = Math.min(d, Math.PI * 2 - d); return d < Math.PI / 16 * 1.6; })) dirs++;
    }
    if (dirs / 16 < 0.75) add(17, 'continues', 'error', `${dirs} of 16 directions show something past the walls`, 'trees, ruins or rocks past the walls all round');
  }
  const mounds = world.mounds ?? [];
  const needMounds = arena ? ({ small: 6, medium: 8, large: 10 }[world.sizeClass] ?? 8) : 2;
  if (enemies && mounds.length < needMounds) add(17, 'entries', 'error', `${mounds.length} emerge points for enemies (a ${world.sizeClass ?? 'room'} needs ${needMounds})`, 'add emerge mounds (world.json mounds)');
  // reachable: one connected floor from the first spawn reaches every spawn and mound
  {
    const cell = 0.5, gx = Math.ceil(W / cell), gz = Math.ceil(D / cell);
    const free = new Uint8Array(gx * gz);
    for (let i = 0; i < gx; i++) for (let k = 0; k < gz; k++) {
      const x = -hx + (i + 0.5) * cell, z = -hz + (k + 0.5) * cell;
      free[k * gx + i] = (plan && !onFloor(x, z)) || solid.some(c => c.max[1] > 0.35 && near(x, z, c, 0.3)) ? 0 : 1;
    }
    const idx = (x, z) => { const i = Math.floor((x + hx) / cell), k = Math.floor((z + hz) / cell); return i >= 0 && k >= 0 && i < gx && k < gz ? k * gx + i : -1; };
    const start = spawns.length ? idx(spawns[0][0], spawns[0][2]) : -1;
    const reach = new Uint8Array(gx * gz);
    if (start >= 0 && free[start]) {
      const q = [start]; reach[start] = 1;
      while (q.length) { const c = q.pop(), i = c % gx, k = (c / gx) | 0; for (const [di, dk] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const ni = i + di, nk = k + dk; if (ni < 0 || nk < 0 || ni >= gx || nk >= gz) continue; const nc = nk * gx + ni; if (free[nc] && !reach[nc]) { reach[nc] = 1; q.push(nc); } } }
    }
    const cut = [...spawns.map((s, i) => [`spawn ${i + 1}`, s[0], s[2]]), ...mounds.map((m, i) => [`mound ${i + 1}`, m[0], m[2]])].filter(([, x, z]) => { const c = idx(x, z); return c < 0 || !reach[c]; });
    if (cut.length) add(17, 'reachable', 'error', `cut off from the floor: ${cut.map(c => c[0]).join(', ')}`, 'open a way to them');
  }
  if (arena) {
    const cover = (world.cover ?? []).length, needCover = { small: 6, medium: 8, large: 10 }[world.sizeClass] ?? 8;
    if (cover < needCover) add(17, 'cover', 'error', `${cover} pieces of cover (a ${world.sizeClass} arena needs ${needCover})`, 'add pillars, graves, rocks between the plaza and the walls');
    const lanes = (world.lanes ?? []).length;
    if ((casters || enemies) && lanes < 3) add(17, 'lanes', 'error', `${lanes} clear lanes from the emerge points`, 'move cover off the lines from the mounds to the plaza and the spawns');
  }
  const fires = (world.lights ?? []).length;
  if (arena && fires < 4) add(17, 'lights', 'error', `${fires} fire lights`, 'at least 4 braziers or torches');
  else if (!arena && fires < 2) add(17, 'lights', 'warning', `${fires} fire lights`, 'light the room');
  const errors = problems.filter(p => p.severity === 'error'), warnings = problems.filter(p => p.severity === 'warning');
  const stats = { pieces: pieces.length, colliders: colliders.length, lights: fires, spawns: spawns.length, mounds: mounds.length, cover: (world.cover ?? []).length, lanes: (world.lanes ?? []).length, openFloor: Math.round(openShare * 1000) / 1000, centreSolid: Math.round(centreShare * 1000) / 1000, edgeStopped: samples ? Math.round(stopped / samples * 1000) / 1000 : 0 };
  return { ok: errors.length === 0, errors: errors.length, warnings: warnings.length, problems, stats, kind: world.kind ?? 'forge-room' };
}
