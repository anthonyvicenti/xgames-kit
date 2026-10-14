// gf-forge's town street (wave 5, track T: "a street in a town at night"), vendored into a game as gf/forge/town.js
// (never edited there): the `town-street` world, a gaslit old-town street that opens into a small square, generated
// from a seed out of the library (research/gf-forge/library catalog.json roles town.*). Pure: no DOM, no files; create
// runs it in Node. The forge world lint that holds it (verify checks 11 and 17) is gf/forge/arena.js lintWorld.
//
//   generateTown({ seed, size, players, catalog })   → the layout, in the shape generateArena gives a ruin: the ground,
//                                                      pieces (each a slot's model), colliders, lamp lights, player
//                                                      spawns, emerge points, cover, lanes, zones, the nav grid's
//                                                      bounds, the pictures that tile over the pieces, and `floor`:
//                                                      the play area's rectangles (the lint's floor plan)
//
// The layout (3 m tiles; arena.js STREET_SIZES: a street 9 m wide and 30, 36 or 42 m long, north to south, with a square
// 21 × 12, 27 × 18 or 33 × 18 m at its middle, and four alleys 3 m wide and 6 m deep):
//   the ground    wet cobbles tiled far past the houses (their scale in metres is a slot), flagged pavement at every
//                 house's foot
//   the edge      house fronts on the grid round the whole floor: a ground storey of brick or of timber frame, one or
//                 two storeys over it (timber-framed ones jettied over the street), a tiled roof with its eaves or a
//                 gable to the street, chimneys; doors, shop fronts, windows (some lit: they glow and cast no light),
//                 hanging signs. The street's south end is a barricade of crates, barrels and boards, its north end
//                 iron railings with fog past them, and each alley ends in a board fence; an invisible boundary
//                 stands behind each of those
//   lamps         gas lamps on the pavements: five (seven in a large street), each a light at its lantern
//   spawns        the south side of the square, 2 m apart, facing north to the pump (2-4 players)
//   emerge        where the dead come up: an open cellar hatch at the end of each alley, broken street drains in the
//                 square and the north street, cellar hatches at house fronts; none near the spawns
//   cover         carts, barrels, crates, a market stall, a horse trough, round the square and along the street's
//                 sides; the middle of the square (where the game's prop stands: the pump) and the way to it from
//                 the spawns stay clear
//   backdrop      far house fronts under their roofs behind the houses and past the street's ends, a church tower
//                 past the north end; no colliders, drawn in the renderer's backdrop layer, some with a lit window
//   the sky       the ruin's sheet of cloud (two layers), the moon in a gap of it
import { TILE, STREET_SIZES, STREET_W, ALLEY, rngOf, boxOf, segmentClear } from './arena.js';

/** Piece name → the library role (catalog.json roles). Every distinct piece is one model slot. */
export const PIECES = {
  ground: 'town.ground', pavement: 'town.pavement',
  'wall-brick': 'town.wall.brick', 'wall-plaster': 'town.wall.plaster', 'upper-timber': 'town.upper.timber', 'upper-timber-corner': 'town.upper.timber.corner',
  roof: 'town.roof', 'roof-gable': 'town.roof.gable', 'gable-timber': 'town.gable.timber', 'gable-brick': 'town.gable.brick', chimney: 'town.chimney',
  'window-lit': 'town.window.lit', 'window-dark': 'town.window.dark', shopfront: 'town.shopfront', door: 'town.door', 'sign-a': 'town.sign.a', 'sign-b': 'town.sign.b', 'sign-c': 'town.sign.c',
  'barricade-a': 'town.barricade.a', 'barricade-b': 'town.barricade.b', railings: 'town.railings', 'fence-board': 'town.fence.board',
  hatch: 'town.hatch', drain: 'town.drain', lamp: 'town.lamp.gas',
  cart: 'town.cart', barrel: 'town.barrel', barrels: 'town.barrels', crate: 'town.crate', crates: 'town.crates', stall: 'town.stall', trough: 'town.trough',
  'far-house-a': 'town.far.house.a', 'far-house-b': 'town.far.house.b', 'far-house-c': 'town.far.house.c', church: 'town.church', clouds: 'world.sky.clouds',
};
export const LABELS = {
  ground: 'Cobbles', pavement: 'Pavement',
  'wall-brick': 'Brick wall', 'wall-plaster': 'Timber-framed wall', 'upper-timber': 'Jettied upper storey', 'upper-timber-corner': 'Jettied upper storey (corner)',
  roof: 'Roof', 'roof-gable': 'Gabled roof', 'gable-timber': 'Timber gable', 'gable-brick': 'Brick gable', chimney: 'Chimney',
  'window-lit': 'Lit window', 'window-dark': 'Dark window', shopfront: 'Shop front', door: 'House door', 'sign-a': 'Shop sign (boot)', 'sign-b': 'Shop sign (tankard)', 'sign-c': 'Shop sign (key)',
  'barricade-a': 'Barricade', 'barricade-b': 'Barricade (another heap)', railings: 'Iron railings', 'fence-board': 'Board fence',
  hatch: 'Cellar hatch', drain: 'Street drain', lamp: 'Gas lamp',
  cart: 'Cart', barrel: 'Barrel', barrels: 'Barrels', crate: 'Crate', crates: 'Stacked crates', stall: 'Market stall', trough: 'Horse trough',
  'far-house-a': 'Far house', 'far-house-b': 'Far house (tall)', 'far-house-c': 'Far row of houses', church: 'Church tower', clouds: 'Clouds',
};
/** The pictures that tile over pieces (catalog textureFiles → a texture slot's name and label), first the ground's. */
export const SURFACES = [
  ['cobbles', 'town/town-cobbles.png', 'Cobbles texture', 'The picture the street is paved with (wet setts; square texels show up close)'],
  ['brick', 'town/town-brick.png', 'Brick texture', 'The picture every brick wall, brick gable and chimney is built from (3 m a repeat)'],
  ['timber', 'town/town-timber.png', 'Timber frame texture', 'The picture of one storey of a timber-framed front: beams, posts, braces and plaster (3 m across and 3 m up)'],
  ['tiles', 'town/town-roof.png', 'Roof tile texture', 'The picture every roof is tiled with (2 m a repeat)'],
  ['wood', 'town/town-wood.png', 'Plank texture', 'The picture the board fences are built from (upright planks; 2 m a repeat)'],
  ['stone', 'town/town-stone.png', 'Paving stone texture', 'The picture the pavement is flagged with (3 m a repeat)'],
];
/** What a body walks over or through, or what hangs out of reach: no collider of its own. */
const NO_COLLIDER = new Set(['ground', 'pavement', 'upper-timber', 'upper-timber-corner', 'roof', 'roof-gable', 'gable-timber', 'gable-brick', 'chimney', 'window-lit', 'window-dark', 'shopfront', 'door', 'sign-a', 'sign-b', 'sign-c', 'hatch', 'drain', 'clouds']);
const COVER = [['crates', 0.2], ['barrels', 0.17], ['cart', 0.16], ['stall', 0.13], ['crate', 0.12], ['barrel', 0.12], ['trough', 0.1]];
const MOUNDS = { small: 6, medium: 8, large: 10 };
const COVERS = { small: 7, medium: 10, large: 13 };
const JETTY = 0.3;                        // how far a timber-framed upper storey stands out (the library's piece)
export const SPAWN_Z = 8.5;               // the spawns' row, metres south of the pump

const r3 = v => Math.round(v * 1000) / 1000;
const DEG = Math.PI / 180;
const pick = (rng, list) => { let r = rng() * list.reduce((s, x) => s + x[1], 0); for (const [v, w] of list) { r -= w; if (r <= 0) return v; } return list[0][0]; };
const hashOf = s => { let h = 2166136261 >>> 0; for (let q = 0; q < s.length; q++) { h ^= s.charCodeAt(q); h = Math.imul(h, 16777619) >>> 0; } return h; };
/** The four ways a front can face, as [dx, dz] → the turn (degrees about Y) that points a piece's front (+Z) that way. */
const DIRS = [[0, 1], [1, 0], [0, -1], [-1, 0]];
const rotFor = ([dx, dz]) => (dz === 1 ? 0 : dx === 1 ? 90 : dz === -1 ? 180 : 270);
/** A piece's own right (+X) once its front faces `d`. */
const rightOf = ([dx, dz]) => [dz, -dx];

/** A piece's catalog entry (its size, collider, sockets, the pictures it is built from), whichever section holds it. */
export const entryOf = (catalog, piece) => { const f = catalog?.roles?.[PIECES[piece]]?.file; if (!f) return null; for (const sec of Object.values(catalog.sections ?? {})) if (sec[f]) return sec[f]; return null; };

/**
 * The town street's layout. `catalog`: research/gf-forge/library/catalog.json (sizes, colliders, sockets). Pure and
 * seeded: the same seed, size and players give the same street.
 */
export function generateTown({ seed = 1, size = 'medium', players = 4, catalog } = {}) {
  if (!catalog?.roles) throw new Error('generateTown needs the forge library catalog (research/gf-forge/library/catalog.json)');
  const rng = rngOf(seed);
  const sizeClass = STREET_SIZES[size] ? size : 'medium', S = STREET_SIZES[sizeClass];
  const Wt = S.square[0] + 2 * ALLEY, Dt = S.long, hx = (Wt * TILE) / 2, hz = (Dt * TILE) / 2;
  const iS0 = (Wt - STREET_W) / 2, iS1 = iS0 + STREET_W, kQ0 = (Dt - S.square[1]) / 2, kQ1 = kQ0 + S.square[1];
  const cx = i => -hx + TILE / 2 + i * TILE, cz = k => -hz + TILE / 2 + k * TILE;
  const sw = (STREET_W * TILE) / 2, qx = (S.square[0] * TILE) / 2, qz = (S.square[1] * TILE) / 2;      // half the street's width, half the square
  const has = piece => !!entryOf(catalog, piece);
  const pieces = [], colliders = [], lights = [], solids = [];
  /** Place a piece. `o.solid`: [w, h, d] its collider's size in place of the catalog's (a house bay to its eaves);
   *  `o.bare`: no collider (a storey inside that bay's); `o.carried`: it stands on or hangs from another piece. */
  const place = (piece, at, rot = 0, kind = 'decor', o = {}) => {
    const e = entryOf(catalog, piece);
    if (!e) throw new Error(`the forge library has no ${PIECES[piece]} (${piece})`);
    const { solid = null, bare = false, scale = 1, ...extra } = o;
    const p = { piece, slot: `world.town-street.${piece}`, at: at.map(r3), rot, scale: r3(scale), kind, height: r3((e.size?.[1] ?? 1) * scale), ...extra };
    pieces.push(p);
    if (kind !== 'backdrop' && !bare && (solid || !NO_COLLIDER.has(piece))) {
      const b = boxOf(solid ? { shape: 'box', size: solid, offset: [0, solid[1] / 2, 0] } : e.collider, at, rot, scale);
      if (b) { colliders.push({ ...b, kind, piece }); solids.push({ ...b, kind }); }
    }
    return p;
  };
  const clearOf = (x, z, pad) => solids.every(b => x < b.min[0] - pad || x > b.max[0] + pad || z < b.min[2] - pad || z > b.max[2] + pad);

  // ---- the floor: the street, the square at its middle, four alleys (one off each side of the square, one off the
  // north street and one off the south street on opposite sides) ----
  const F = new Set(), A = new Set(), key = (i, k) => `${i},${k}`, isFloor = (i, k) => F.has(key(i, k));
  for (let k = 0; k < Dt; k++) for (let i = iS0; i < iS1; i++) F.add(key(i, k));
  for (let k = kQ0; k < kQ1; k++) for (let i = ALLEY; i < Wt - ALLEY; i++) F.add(key(i, k));
  const side = rng() < 0.5 ? -1 : 1;
  const rowIn = (a, b) => a + Math.floor(rng() * Math.max(1, b - a + 1));
  const alleys = [];
  const alley = (dir, i0, k) => {
    // `dir`: the way it runs from its mouth; its tiles from the mouth out; the tile past its end is its back
    const tiles = []; for (let q = 0; q < ALLEY; q++) tiles.push([i0 + dir[0] * q, k]);
    for (const [i, kk] of tiles) { F.add(key(i, kk)); A.add(key(i, kk)); }
    const end = tiles[ALLEY - 1], mouthX = cx(i0) - dir[0] * TILE / 2, endX = cx(end[0]) + dir[0] * TILE / 2;
    alleys.push({ dir, tiles, back: [end[0] + dir[0], k], mouth: [mouthX, cz(k)], end: [endX, cz(k)], rect: [Math.min(mouthX, endX), cz(k) - TILE / 2, Math.max(mouthX, endX), cz(k) + TILE / 2] });
  };
  alley([-1, 0], ALLEY - 1, rowIn(kQ0 + 1, kQ1 - 2));
  alley([1, 0], Wt - ALLEY, rowIn(kQ0 + 1, kQ1 - 2));
  alley([side, 0], side < 0 ? iS0 - 1 : iS1, rowIn(1, kQ0 - 2));
  alley([-side, 0], side < 0 ? iS1 : iS0 - 1, rowIn(kQ1 + 1, Dt - 1));
  const floor = [[-sw, -hz, sw, hz], [-qx, -qz, qx, qz], ...alleys.map(a => a.rect)].map(r => r.map(r3));
  const onFloor = (x, z, pad = 0) => floor.some(r => x >= r[0] + pad && x <= r[2] - pad && z >= r[1] + pad && z <= r[3] - pad);
  const inAlley = (x, z) => alleys.some(a => x >= a.rect[0] && x <= a.rect[2] && z >= a.rect[1] && z <= a.rect[3]);

  // ---- the ground: sheets of cobbles laid edge to edge far past the houses; the ground every body stands on ----
  const groundEntry = entryOf(catalog, 'ground'), groundTile = groundEntry?.tile ?? 8;
  const ground = { piece: 'ground', slot: 'world.town-street.ground', metres: groundTile, tile: groundTile, span: groundEntry?.span ?? groundTile, reach: r3(Math.max(hx, hz) + 42), y: 0 };
  colliders.push({ min: [-hx - 9, -1, -hz - 9], max: [hx + 9, 0, hz + 9], kind: 'ground' });
  const boundary = (min, max) => colliders.push({ min: min.map(r3), max: max.map(r3), kind: 'boundary', invisible: true });

  // ---- the street's ends and the alleys' backs: what closes the play area where no house does ----
  for (let i = iS0; i < iS1; i++) {
    place('railings', [cx(i), 0, -hz - 0.2], 0, 'edge');
    place(rng() < 0.5 ? 'barricade-a' : 'barricade-b', [cx(i), 0, hz + 0.85], 180, 'edge');
  }
  boundary([-sw - 1, 0, -hz - 1.6], [sw + 1, 6, -hz - 0.6]);
  boundary([-sw - 1, 0, hz + 1.8], [sw + 1, 6, hz + 2.8]);
  for (const a of alleys) {
    place('fence-board', [a.end[0] + a.dir[0] * 0.15, 0, a.end[1]], rotFor([-a.dir[0], 0]), 'edge');
    boundary([Math.min(a.end[0] + a.dir[0] * 0.4, a.end[0] + a.dir[0] * 1.4), 0, a.end[1] - 2], [Math.max(a.end[0] + a.dir[0] * 0.4, a.end[0] + a.dir[0] * 1.4), 6, a.end[1] + 2]);
  }

  // ---- the houses: every tile beside the floor that is not a street's end or an alley's back. A house is two bays
  // along its street (a seeded pairing), in one style: brick, or timber frame over brick, or timber frame throughout ----
  const closed = new Set([...alleys.map(a => key(...a.back))]);
  for (let i = iS0; i < iS1; i++) { closed.add(key(i, -1)); closed.add(key(i, Dt)); }
  const styleOf = id => {
    const r = rngOf(hashOf(`${seed}:${id}`));
    // (how many of its windows are lit: a third of the houses are dark but for a window, the rest have one in six to
    // nearly half of theirs lit)
    return { style: pick(r, [['brick', 0.3], ['timber', 0.44], ['plaster', 0.26]]), storeys: r() < 0.55 ? 2 : 3, gable: r() < 0.38, lit: r() < 0.34 ? 0.05 : 0.16 + r() * 0.28 };
  };
  const houses = [];
  for (let k = -1; k <= Dt; k++) for (let i = -1; i <= Wt; i++) {
    if (isFloor(i, k) || closed.has(key(i, k))) continue;
    let touches = false;
    for (let dk = -1; dk <= 1 && !touches; dk++) for (let di = -1; di <= 1; di++) if (isFloor(i + di, k + dk)) { touches = true; break; }
    if (!touches) continue;
    const faces = DIRS.filter(([dx, dz]) => isFloor(i + dx, k + dz));
    // the front: the one face; a corner's two (front, and the face to its right); with none (a tile that only touches
    // the floor at a corner) it turns to the floor's side
    let front = faces[0] ?? null, corner = false;
    if (faces.length >= 2) for (const f of faces) { const r = rightOf(f); if (faces.some(g => g[0] === r[0] && g[1] === r[1])) { front = f; corner = true; break; } }
    if (!front) front = isFloor(i + 1, k + 1) || isFloor(i - 1, k + 1) ? [0, 1] : [0, -1];
    const along = front[0] ? 'z' : 'x';
    const id = faces.length === 1 ? (along === 'z' ? `${i}|${Math.floor((k + hashOf(`${seed}/${i}`) % 2) / 2)}` : `${Math.floor((i + hashOf(`${seed}\\${k}`) % 2) / 2)}_${k}`) : `${i},${k}`;
    houses.push({ i, k, faces, front, corner, filler: faces.length === 0, ...styleOf(id) });
  }
  for (const h of houses) {
    const x = cx(h.i), z = cz(h.k), rot = rotFor(h.front), n = h.storeys, jettied = h.style !== 'brick' && !h.filler;
    place(h.style === 'plaster' ? 'wall-plaster' : 'wall-brick', [x, 0, z], rot, 'edge', { solid: [TILE, TILE * n, TILE] });
    for (let s = 1; s < n; s++) place(jettied ? (h.corner ? 'upper-timber-corner' : 'upper-timber') : h.style === 'brick' ? 'wall-brick' : 'wall-plaster', [x, TILE * s, z], rot, 'edge', { carried: true, bare: true });
    if (h.gable && h.faces.length === 1) { place('roof-gable', [x, TILE * n, z], rot, 'edge', { carried: true }); place(jettied ? 'gable-timber' : 'gable-brick', [x, TILE * n, z], rot, 'edge', { carried: true }); }
    else place('roof', [x, TILE * n, z], rot, 'edge', { carried: true });
    if (rng() < 0.3) { const r = rightOf(h.front), a = (rng() < 0.5 ? -1 : 1) * 0.8; place('chimney', [x + r[0] * a - h.front[0] * 0.45, TILE * n + 0.5, z + r[1] * a - h.front[1] * 0.45], rot, 'edge', { carried: true }); }
    // what each front carries
    for (const f of h.faces) {
      const fr = rotFor(f), r = rightOf(f), isFront = f === h.front || (h.corner && rightOf(h.front)[0] === f[0] && rightOf(h.front)[1] === f[1]);
      const on = (a, y, out = TILE / 2) => [x + f[0] * out + r[0] * a, y, z + f[1] * out + r[1] * a];
      const toAlley = A.has(key(h.i + f[0], h.k + f[1]));
      const window = (a, y, out, p = h.lit) => place(rng() < p ? 'window-lit' : 'window-dark', on(a, y, out), fr, 'decor', { carried: true });
      // the ground storey: a shop, a door and a window, two windows, or a blank wall (an alley's walls are mostly blank)
      const q = rng();
      if (toAlley) { if (q < 0.3) window(0, 1.05, TILE / 2, 0.15); }
      else if (q < 0.22) { place('shopfront', on(0, 0.55), fr, 'decor', { carried: true }); if (rng() < 0.55) place(pick(rng, [['sign-a', 1], ['sign-b', 1], ['sign-c', 1]]), on(rng() < 0.5 ? -1.25 : 1.25, 2.2), fr, 'decor', { carried: true }); }
      else if (q < 0.62) { const s = rng() < 0.5 ? -1 : 1; place('door', on(-0.78 * s, 0), fr, 'decor'); window(0.72 * s, 1.05); if (rng() < 0.3) place(pick(rng, [['sign-a', 1], ['sign-b', 1], ['sign-c', 1]]), on(1.3 * s, 2.2), fr, 'decor', { carried: true }); }
      else if (q < 0.9) { window(-0.72, 1.05); window(0.72, 1.05); }
      // the storeys over it: a timber frame has one window in its middle bay, a brick wall two
      for (let s = 1; s < n; s++) {
        if (jettied) { if (rng() < 0.85) window(0.06, TILE * s + 1.34, TILE / 2 + (isFront ? JETTY : 0)); }
        else if (h.style === 'brick') for (const a of [-0.72, 0.72]) { if (rng() < 0.75) window(a, TILE * s + 1.0); }
        else if (rng() < 0.85) window(0.06, TILE * s + 1.34);
      }
      // the pavement at its foot (not in an alley)
      if (!toAlley) place('pavement', on(0, 0, TILE / 2 + 0.6), fr, 'floor');
    }
  }

  // ---- gas lamps: this world's fires. On the pavements: two in the square, one at the north street's mouth, one far
  // up it, one in the south street behind the spawns; a large street has two more in its square. Each is a light at
  // its lantern (the piece's socket_flame); its panes glow, and no flame stands in it ----
  const flame = entryOf(catalog, 'lamp')?.sockets?.flame?.position ?? [0, 2.8, 0], mirror = rng() < 0.5 ? -1 : 1;
  const lamps = [[-Math.max(0.46 * qx, 6.3), 0.36 * qz], [0.49 * qx, -0.44 * qz], [sw - 0.8, -qz - 1.6], [-(sw - 0.8), -(qz + hz) / 2 - 2.4], [sw - 0.8, (qz + hz) / 2 + 0.2],
    ...(sizeClass === 'large' ? [[-0.66 * qx, -0.6 * qz], [0.66 * qx, 0.52 * qz]] : [])];
  for (const [lx, z0] of lamps) {
    const x = lx * mirror, rot = Math.floor(rng() * 4) * 90;
    // never in an alley's mouth: a lamp that would stand in one stands 2.8 m along the street from it
    const near = alleys.find(a => Math.hypot(a.mouth[0] - x, a.mouth[1] - z0) < 2.4), lz = near ? near.mouth[1] + (z0 >= near.mouth[1] ? 2.8 : -2.8) : z0;
    place('lamp', [x, 0, lz], rot, 'light');
    lights.push({ at: [r3(x + flame[0]), r3(flame[1] + 0.04), r3(lz + flame[2])], seed: lights.length + 1, kind: 'lamp' });
  }

  // ---- spawns: the south side of the square (the street's mouth in a small one), facing north ----
  const P = Math.max(2, Math.min(4, players));
  const spawns = [];
  for (let i = 0; i < P; i++) spawns.push([r3((i - (P - 1) / 2) * 2.0), 0.05, r3(Math.min(SPAWN_Z, hz - 3.2)), r3(Math.PI)]);
  const nearSpawn = (x, z, d) => spawns.some(s => Math.hypot(s[0] - x, s[2] - z) < d);

  // ---- where the dead come up: a cellar hatch at the end of each alley, a broken drain on each side of the pump, more
  // drains in the square's north quarters and up the north street, cellar hatches at the square's fronts. None near the
  // spawns or a solid, and none behind the spawns' row or out of a new player's sight: the wave director raises
  // enemies 7 to 10 m from a player, and whoever stands at a spawn and looks north must see the first ones come
  // (verify's first-wave check plays that player: it shoots what is within 46° of where it looks, and the first cut
  // of this street, with a hatch in the alley behind the spawns and drains out to the sides, felled it three times
  // of three) ----
  const mounds = [];
  const inSight = (x, z) => spawns.every(s => { const d = Math.hypot(x - s[0], z - s[2]); return d > 10.6 || (s[2] - z > 0 && Math.atan2(Math.abs(x - s[0]), s[2] - z) <= 40 * DEG); });
  const emerge = (piece, x, z, rot) => {
    // (never in the middle of the square: the game's prop stands there)
    if (mounds.length >= MOUNDS[sizeClass] || !onFloor(x, z, 0.9) || Math.hypot(x, z) < 4.6 || z > spawns[0][2] - 1 || nearSpawn(x, z, 6) || !inSight(x, z) || !clearOf(x, z, 0.95) || mounds.some(m => Math.hypot(m[0] - x, m[2] - z) < 4)) return false;
    mounds.push([r3(x), 0, r3(z)]);
    place(piece, [x, 0, z], rot, 'mound');
    return true;
  };
  for (const a of alleys) emerge('hatch', a.end[0] - a.dir[0] * 1.6, a.end[1], rotFor(a.dir));
  const j = () => (rng() - 0.5) * 1.2;
  const drains = [[-4.75 - rng() * 0.5, -0.8 + j() * 0.5], [4.75 + rng() * 0.5, -0.8 + j() * 0.5], [-0.52 * qx + j(), -0.5 * qz + j()], [0.52 * qx + j(), -0.5 * qz + j()], [j() * 0.8, -(qz + hz) / 2 + j()]];
  for (const [x, z] of drains) emerge('drain', x, z, Math.floor(rng() * 4) * 90);
  for (const sx of [-1, 1]) emerge('hatch', sx * (sw + 2.4 + rng() * Math.max(0.5, qx - sw - 5)), -qz + 1.05, 0);
  for (const sx of [-1, 1]) { const z = (rng() - 0.5) * qz; if (!onFloor(sx * (qx + 1), z)) emerge('hatch', sx * (qx - 1.05), z, sx < 0 ? 90 : 270); }
  for (let tries = 0; tries < 80 && mounds.length < MOUNDS[sizeClass]; tries++) emerge('drain', (rng() * 2 - 1) * (qx - 1.5), -hz + 2 + rng() * (hz + qz * 0.4), Math.floor(rng() * 4) * 90);

  // ---- cover: round the square and along the street's sides; the middle of the square (the pump's place), the way to
  // it from the spawns, the alleys and the emerge points stay clear ----
  const cover = [], table = COVER.filter(([p]) => has(p)), count = {}, most = { cart: 2, stall: 2, trough: 1 };
  for (let tries = 0; tries < 1400 && cover.length < COVERS[sizeClass]; tries++) {
    const x = (rng() * 2 - 1) * (qx - 1.4), z = (rng() * 2 - 1) * (hz - 2.2);
    const piece = pick(rng, table), e = entryOf(catalog, piece), reach = Math.max(e.collider?.size?.[0] ?? 1, e.collider?.size?.[2] ?? 1) / 2;
    if ((count[piece] ?? 0) >= (most[piece] ?? 99)) continue;
    if (!onFloor(x, z, reach + 0.25) || inAlley(x, z)) continue;
    const inStreet = Math.abs(z) > qz;
    if (inStreet && Math.abs(x) < 2.3) continue;                                             // the street's middle stays open
    if (piece === 'stall' && inStreet) continue;
    // the pump's place; the first look: the way from the spawns to the pump and to the drains on each side of it
    if (Math.hypot(x, z) < 5.2 || (Math.abs(x) < 6 && z > -2.2 && z < SPAWN_Z + 1.5)) continue;
    if (nearSpawn(x, z, 3.6) || mounds.some(m => Math.hypot(m[0] - x, m[2] - z) < 2.4 + reach)) continue;
    if (alleys.some(a => Math.hypot(a.mouth[0] - x, a.mouth[1] - z) < 3 + reach)) continue;      // an alley's mouth stays open
    if (cover.some(c => Math.hypot(c.at[0] - x, c.at[2] - z) < 3.4)) continue;
    if (!clearOf(x, z, reach + 0.55)) continue;
    const square = ['crate', 'barrel', 'barrels'].includes(piece);
    cover.push(place(piece, [x, 0, z], Math.floor(rng() * 4) * 90 + (square ? Math.round((rng() - 0.5) * 40) : 0), 'cover'));
    count[piece] = (count[piece] ?? 0) + 1;
  }

  // ---- the backdrop: a far house behind many of the houses (so roofs stand over the roofs), two rings of them past
  // the play area, a row on each side of the street past each of its ends, a church tower past the north end; some
  // carry a lit window. No colliders; the renderer's backdrop layer ----
  const far = [], FAR = [['far-house-a', 0.42], ['far-house-b', 0.3], ['far-house-c', 0.28]];
  const farHouse = (x, z, rot, scale, piece = pick(rng, FAR)) => {
    if (far.some(q => Math.hypot(q[0] - x, q[1] - z) < 5.5) || onFloor(x, z, -5.2)) return;
    far.push([x, z]);
    const p = place(piece, [x, 0, z], rot, 'backdrop', { scale });
    // a lit window or two on its front, over the windows its picture has
    const e = entryOf(catalog, piece), w = (e.collider?.size?.[0] ?? 6) * scale, hgt = (e.collider?.size?.[1] ?? 7) * scale, d = (e.collider?.size?.[2] ?? 6) * scale, c = Math.cos(rot * DEG), s = Math.sin(rot * DEG);
    for (let q = 0, lit = (rng() < 0.55 ? 1 : 0) + (rng() < 0.25 ? 1 : 0), first = -1; q < lit; q++) {
      const cell = Math.floor(rng() * 12);
      if (cell === first) continue;
      first = cell;
      const col = cell % 4, row = Math.floor(cell / 4), lx = ((13 + 22 * col) / 96 - 0.5) * w, ly = (1 - (22 + 32 * row) / 96) * hgt, lz = d / 2 + 0.03;
      place('window-lit', [x + lx * c + lz * s, ly, z - lx * s + lz * c], rot, 'backdrop', { scale: r3(scale * 0.9), carried: true });
    }
    return p;
  };
  for (const h of houses) {
    if (rng() > 0.5) continue;
    const out = h.filler ? [0, 0] : [-h.front[0], -h.front[1]];
    if (!out[0] && !out[1]) continue;
    farHouse(cx(h.i) + out[0] * (5.6 + rng() * 1.6), cz(h.k) + out[1] * (5.6 + rng() * 1.6), rotFor(h.front), 1.0 + rng() * 0.3);
  }
  // the street goes on past each end, a row of houses on each side of it
  for (const sz of [-1, 1]) for (const sx of [-1, 1]) for (let q = 0; q < 2; q++) farHouse(sx * (sw + 4.2 + rng() * 0.8), sz * (hz + 7.5 + q * 8.5 + rng()), sx < 0 ? 90 : 270, 1.05 + rng() * 0.3);
  // two rings round the play area's box, each house's front to it (the way up the street past each end is left open)
  const ringAt = (a, d) => { const ca = Math.cos(a), sa = Math.sin(a), m = Math.max(Math.abs(ca) / (hx + d), Math.abs(sa) / (hz + d)); return [ca / m, sa / m]; };
  const facing = a => Math.round((-a / DEG + 90) / 90) * 90 + 180;
  for (const [n, d0, d1, s0, s1] of [[18, 6.5, 9.5, 1.0, 1.3], [22, 15, 24, 1.25, 1.75]]) {
    const a0 = rng() * 6.28;
    for (let q = 0; q < n; q++) { const a = a0 + (q / n) * Math.PI * 2 + (rng() - 0.5) * (3 / n), [x, z] = ringAt(a, d0 + rng() * (d1 - d0)); if (Math.abs(x) < sw + 3.4 && Math.abs(z) > hz) continue; farHouse(x, z, facing(a), s0 + rng() * (s1 - s0)); }
  }
  place('church', [r3((rng() < 0.5 ? -1 : 1) * (2.5 + rng() * 5)), 0, r3(-hz - 27 - rng() * 6)], Math.floor(rng() * 4) * 90, 'backdrop', { scale: r3(1 + rng() * 0.15) });

  // ---- the sky: the ruin's sheet of cloud high over the street, laid twice (kit/world.js hangs the layers and puts
  // the sheet's gap where the moon stands) ----
  const cloudEntry = entryOf(catalog, 'clouds');
  const sky = cloudEntry ? { piece: 'clouds', slot: 'world.town-street.clouds', height: 64, layers: 2, tile: cloudEntry.tile ?? 192, span: cloudEntry.span ?? 768, gap: cloudEntry.gap ?? [0.5, 0.5] } : null;

  // ---- lanes: clear straight lines from each emerge point to the square's middle and to the spawns ----
  const lanes = [];
  const blockers = colliders.filter(c => ['cover', 'light', 'edge', 'decor'].includes(c.kind) && c.max[1] > 1.0);
  for (const m of mounds) for (const to of [[0, 0], ...spawns.map(s => [s[0], s[2]])]) {
    const len = Math.hypot(to[0] - m[0], to[1] - m[2]);
    if (len >= 6 && segmentClear([m[0], m[2]], to, blockers, 0.2)) lanes.push({ from: [m[0], m[2]], to: to.map(r3), length: r3(len) });
  }

  // ---- the pictures that tile over pieces: each a texture slot over the pieces built from that one picture ----
  const textureGroups = {};
  for (const [group, file] of SURFACES) {
    const on = new Set();
    for (const p of [ground, ...pieces]) { const tf = entryOf(catalog, p.piece)?.textureFiles ?? []; if (tf.length === 1 && tf[0] === file) on.add(p.slot); }
    if (on.size) textureGroups[group] = { file, on: [...on], metres: catalog.sections?.town?.[file]?.metres ?? null };
  }
  return {
    template: 'town-street', kind: 'forge-arena', seed, sizeClass, size: [Wt * TILE, Dt * TILE], half: Math.max(hx, hz), floor,
    street: { width: STREET_W * TILE, square: [S.square[0] * TILE, S.square[1] * TILE], ends: { north: [0, 0, r3(-hz)], south: [0, 0, r3(hz)] }, alleys: alleys.map(a => ({ mouth: [r3(a.mouth[0]), 0, r3(a.mouth[1])], end: [r3(a.end[0]), 0, r3(a.end[1])] })) },
    ground, ...(sky ? { sky } : {}), pieces, colliders, lights, spawns, mounds, lanes,
    cover: cover.map(c => ({ piece: c.piece, at: c.at })),
    zones: { centre: { shape: 'circle', at: [0, 0, 0], size: [3] }, plaza: { shape: 'circle', at: [0, 0, 0], size: [r3(Math.min(qx, qz) - 1)] } },
    textureGroups,
    nav: { min: [-hx, -hz], max: [hx, hz], cell: 0.5 },
    floorLimit: -10,
  };
}
