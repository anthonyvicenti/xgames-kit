// gf-three voxel world: the generated land. Deterministic from config/world.json → voxel.terrain (the same seed and
// generator always give the same land, so the world store only keeps the cells players changed). Pure (no three.js, no
// DOM): the main thread, the mesh workers (the land past the edge) and Node tests run it.
//
//   voxel.terrain {
//     generator: 2 (the only one: a change to this file's output is a new number),
//     kind: 'land' (land to every edge, and on past it as scenery) | 'island' (land in the middle of a sea),
//     seed, water (the sea's surface), ground (the lowlands' height), hills (how far hills rise and fall),
//     mountains (0-1: how much of the land is mountains), scale (feature size; 1 = the default),
//     radius, coast (an island's size and how much its coast wobbles), beach (blocks of sand above the water),
//     biomes (the ones allowed: plains, forest, birch, taiga, snowy, desert, mountains),
//     trees, plants, caves, ores (densities: 0 none, 1 the default, 2 twice as many),
//     far (cells of scenery drawn round the play area: the same land, never edited, no caves),
//     plaza { at: [x, z], half, floor, edge, sign, signText }   (the spawn square: level, paved, a welcome sign),
//     blocks { <role>: '<block id>' }   (the block each role uses; ROLES below)
//   }
//
// terrainModel(table, cfg, size) → the land as functions of world x, z (columns past the grid included):
//   heightAt(x, z) (the top of the land: cells below it are solid), biomeAt(x, z), plaza, water
// generateTerrain(grid, table, cfg) fills the play grid → { heights, spawns, plaza, sign, water, trees, model, biome }
// fillRegion(grid, model, ox, oz, { caves, ores }) fills any grid whose cell (0, y, 0) is world (ox, y, oz).
//
// The ideas are Minecraft's (temperature and rainfall pick the biome, noise carves the caves) as Divine Voxel Engine's
// generators use them (DVE, MIT, LICENSE-dve); the code is this kit's own.
import { blockN } from './blocks.mjs';
import { perlin, fbm2, ridged2, hash, mulberry32 } from './noise.mjs';
export { mulberry32 } from './noise.mjs';

export const GENERATOR = 2;
export const BIOMES = ['plains', 'forest', 'birch', 'taiga', 'snowy', 'desert', 'mountains'];
export const TERRAIN_DEFAULTS = {
  generator: GENERATOR, kind: 'land', seed: 361, water: 22, ground: 26, hills: 9, mountains: 0.45, scale: 1,
  radius: 60, coast: 0.25, beach: 2, biomes: BIOMES, trees: 1, plants: 1, caves: 1, ores: 1, far: 48,
  plaza: { at: null, half: 6, floor: 'cobble', edge: 'stone-brick', sign: true },
};
// the block each role uses (terrain.blocks overrides); a role whose block is not in the table is left out
export const ROLES = {
  grass: 'grass', dirt: 'dirt', stone: 'stone', sand: 'sand', seabed: 'seabed', bedrock: 'bedrock', gravel: 'gravel',
  clay: 'clay', sandstone: 'sandstone', water: 'water', snow: 'snow', snowGrass: 'snow-grass', ice: 'ice',
  log: 'log', leaves: 'leaves', birchLog: 'birch-log', birchLeaves: 'birch-leaves', spruceLog: 'spruce-log', spruceLeaves: 'spruce-leaves',
  cactus: 'cactus', coal: 'coal-ore', iron: 'iron-ore', gold: 'gold-ore', crystal: 'crystal', shard: 'amber-shard', glowcap: 'glowcap',
  tallGrass: 'tuft-a', fern: 'fern', deadBush: 'dead-bush', reeds: 'tuft-c',
  flowers: ['flower-red', 'flower-yellow', 'flower-blue', 'flower-white'], mushrooms: ['mushroom-red', 'mushroom-brown'],
};

const smooth = (x, a, b) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const lerp = (a, b, t) => a + (b - a) * t;

/** The land as functions of world (x, z). size: the play grid's [sx, sy, sz]. */
export function terrainModel(table, cfg = {}, size) {
  const T = { ...TERRAIN_DEFAULTS, ...cfg, plaza: { ...TERRAIN_DEFAULTS.plaza, ...(cfg.plaza ?? {}) } };
  if (T.generator !== GENERATOR) throw new Error(`gf-three voxel: terrain.generator ${T.generator} is not this kit's (${GENERATOR}); a world is made again from a new spec, never upgraded`);
  const [sx, sy, sz] = size;
  const roles = { ...ROLES, ...(cfg.blocks ?? {}) };
  const id = name => (table.byId.has(name) ? blockN(table, name) : 0);
  const B = Object.fromEntries(Object.entries(roles).map(([k, v]) => [k, Array.isArray(v) ? v.map(id).filter(Boolean) : id(v)]));
  for (const need of ['grass', 'dirt', 'stone', 'sand', 'bedrock']) if (!B[need]) throw new Error(`gf-three voxel: terrain needs a "${roles[need]}" block (terrain.blocks.${need})`);
  B.water = id(roles.water ?? 'water');
  B.seabed ||= B.sand; B.snowGrass ||= B.grass; B.snow ||= B.snowGrass; B.sandstone ||= B.sand; B.gravel ||= B.stone;
  B.birchLog ||= B.log; B.birchLeaves ||= B.leaves; B.spruceLog ||= B.log; B.spruceLeaves ||= B.leaves;
  const allowed = new Set(T.biomes ?? BIOMES);
  const seed = T.seed | 0, S = 1 / (T.scale || 1);
  const nT = perlin(seed * 3 + 1), nM = perlin(seed * 5 + 2), nC = perlin(seed * 7 + 3), nH = perlin(seed * 11 + 4);
  const nR = perlin(seed * 13 + 5), nD = perlin(seed * 17 + 6), nCoast = perlin(seed * 19 + 7);
  const water = T.water, top = sy - 14;
  const cx = sx / 2, cz = sz / 2;
  const plazaAt = T.plaza.at ?? [Math.floor(cx), Math.floor(cz)], half = T.plaza.half;

  // climate: temperature and rainfall, 0-1, wide and slow; mountains where a third field rises
  const climate = (x, z) => ({ t: 0.5 + 0.62 * fbm2(nT, x * S / 230, z * S / 230, 3), m: 0.5 + 0.62 * fbm2(nM, x * S / 190 + 40, z * S / 190, 3) });
  const mountainsAt = (x, z) => (allowed.has('mountains') ? smooth(fbm2(nR, x * S / 210, z * S / 210, 2), 0.32 - T.mountains * 0.5, 0.62 - T.mountains * 0.5) : 0);
  function pick(t, m, mtn) {
    const want = [];
    if (mtn > 0.55) want.push('mountains');
    if (t < 0.3) want.push('snowy', 'taiga');
    else if (t < 0.42) want.push('taiga', 'forest');
    else if (t > 0.64 && m < 0.46) want.push('desert', 'plains');
    else if (m > 0.6) want.push(t < 0.52 ? 'birch' : 'forest', 'forest');
    else if (m > 0.47) want.push('forest', 'plains');
    want.push('plains', 'forest', 'taiga', 'birch', 'desert', 'snowy');
    return want.find(b => allowed.has(b)) ?? 'plains';
  }
  function rawHeight(x, z) {
    const { t, m } = climate(x, z), mtn = mountainsAt(x, z);
    const dry = smooth(t, 0.6, 0.72) * (1 - smooth(m, 0.38, 0.5));
    const cont = fbm2(nC, x * S / 320, z * S / 320, 3) * 11;
    const A = T.hills * (0.55 + 0.9 * smooth(fbm2(nC, x * S / 140 + 90, z * S / 140, 2), -0.3, 0.5)) * (1 - 0.55 * dry);
    const hill = fbm2(nH, x * S / 64, z * S / 64, 4) * A;
    const detail = fbm2(nH, x * S / 13 + 51, z * S / 13 - 7, 2) * 1.3;
    const peak = ridged2(nD, x * S / 95, z * S / 95, 4) ** 1.5 * 46 * mtn + mtn * 6;
    let h = T.ground + cont + hill + detail + peak;
    if (T.kind === 'island') {
      const dx = x + 0.5 - cx, dz = z + 0.5 - cz, ang = Math.atan2(dz, dx);
      const wob = 1 + T.coast * fbm2(nCoast, Math.cos(ang) * 1.6 + 3, Math.sin(ang) * 1.6 + 3, 3) * 1.6;
      const d = Math.hypot(dx, dz) / (T.radius * wob);
      h = lerp(h, water - 6 - Math.min(6, Math.max(0, d - 1) * 20), smooth(d, 0.72, 1.02));
    }
    return h;
  }
  // the spawn square: level ground at its own height, the land round it eased toward it over four cells
  let plazaY = 0, n = 0;
  for (let z = plazaAt[1] - half; z <= plazaAt[1] + half; z++) for (let x = plazaAt[0] - half; x <= plazaAt[0] + half; x++) { plazaY += rawHeight(x, z); n++; }
  plazaY = Math.max(water + 2, Math.min(top - 6, Math.round(plazaY / n)));
  const heightCache = new Map();
  function heightAt(x, z) {
    const key = x * 65536 + z;
    let h = heightCache.get(key);
    if (h !== undefined) return h;
    let v = rawHeight(x, z);
    const ring = Math.max(Math.abs(x - plazaAt[0]), Math.abs(z - plazaAt[1])) - half;
    if (ring <= 0) v = plazaY; else if (ring < 6) v = plazaY + (v - plazaY) * smooth(ring, 0, 6);
    h = Math.max(2, Math.min(top, Math.round(v)));
    if (heightCache.size > 400000) heightCache.clear();
    heightCache.set(key, h);
    return h;
  }
  function biomeAt(x, z) {
    const { t, m } = climate(x, z);
    return pick(t, m, mountainsAt(x, z));
  }
  const snowline = water + 30 + Math.round(T.ground - water);
  const plaza = { at: plazaAt, half, y: plazaY, floor: T.plaza.floor, edge: T.plaza.edge, sign: T.plaza.sign, signText: T.plaza.signText };
  const inPlaza = (x, z, m = 0) => Math.abs(x - plazaAt[0]) <= half + m && Math.abs(z - plazaAt[1]) <= half + m;
  return { T, B, water, plaza, plazaY, heightAt, biomeAt, climate, mountainsAt, snowline, inPlaza, size, seed };
}

// grass and leaf colours by climate (0-255 sRGB): cold blue-green, warm yellow-green, dry olive (Minecraft's idea)
const GRASS = { cold: [96, 160, 120], warm: [120, 190, 70], wet: [80, 170, 60], dry: [180, 175, 90] };
const LEAF = { cold: [70, 128, 96], warm: [80, 160, 48], wet: [56, 140, 40], dry: [150, 150, 64] };
function climateColour(P, t, m) {
  const a = t < 0.5 ? P.cold.map((c, i) => lerp(c, P.warm[i], smooth(t, 0.2, 0.5))) : P.warm.map((c, i) => lerp(c, P.dry[i], smooth(t, 0.55, 0.85) * (1 - m)));
  return a.map((c, i) => Math.round(lerp(c, P.wet[i], smooth(m, 0.5, 0.9) * 0.5 * (1 - smooth(t, 0.3, 0.2)))));
}

/** Fill a grid with the land: its cell (0, y, 0) is world (ox, y, oz). opts: caves, ores, plants (default true), caveEdge
 *  (no cave within this many columns of the grid's side; the play grid keeps 6), and
 *  biome (true: write grid.biome, the colours the mesher reads). → { heights (Int16Array sx*sz), trees } */
export function fillRegion(grid, model, ox = 0, oz = 0, opts = {}) {
  const { T, B, water } = model, [sx, sy, sz] = grid.size, put = (x, y, z, v) => grid.put(x, y, z, v);
  const caves = opts.caves ?? true, ores = opts.ores ?? true, plants = opts.plants ?? true;
  const heights = new Int16Array(sx * sz), biomes = new Uint8Array(sx * sz);
  const H = (x, z) => (x >= 0 && z >= 0 && x < sx && z < sz ? heights[z * sx + x] : model.heightAt(x + ox, z + oz));
  for (let z = 0; z < sz; z++) for (let x = 0; x < sx; x++) { heights[z * sx + x] = model.heightAt(x + ox, z + oz); biomes[z * sx + x] = BIOMES.indexOf(model.biomeAt(x + ox, z + oz)); }
  if (opts.biome !== false) {
    const bio = new Uint8Array(sx * sz * 6);
    for (let z = 0; z < sz; z++) for (let x = 0; x < sx; x++) {
      const { t, m } = model.climate(x + ox, z + oz), k = (z * sx + x) * 6;
      const g = climateColour(GRASS, t, m), l = climateColour(LEAF, t, m);
      bio[k] = g[0]; bio[k + 1] = g[1]; bio[k + 2] = g[2]; bio[k + 3] = l[0]; bio[k + 4] = l[1]; bio[k + 5] = l[2];
    }
    grid.biome = bio;
  }
  const rv = (x, z, salt) => hash(model.seed + salt, x + ox, z + oz);
  const nearWater = (x, z) => { for (let dz = -3; dz <= 3; dz++) for (let dx = -3; dx <= 3; dx++) if (dx * dx + dz * dz <= 10 && H(x + dx, z + dz) < water) return true; return false; };
  // ---- columns: stone under soil, sand at the shore and in the desert, snow up high ----
  for (let z = 0; z < sz; z++) for (let x = 0; x < sx; x++) {
    const h = heights[z * sx + x], bi = BIOMES[biomes[z * sx + x]];
    const slope = Math.max(Math.abs(H(x + 1, z) - h), Math.abs(H(x - 1, z) - h), Math.abs(H(x, z + 1) - h), Math.abs(H(x, z - 1) - h));
    // a beach: low land that touches water within three columns (not every low field)
    const shore = h <= water + T.beach && bi !== 'snowy' && nearWater(x, z);
    const soil = 3 + (rv(x, z, 1) < 0.5 ? 1 : 0);
    for (let y = 0; y < h && y < sy; y++) {
      const depth = h - 1 - y;
      let b;
      if (y === 0) b = B.bedrock;
      else if (y === 1 && rv(x, z, 2) < 0.5) b = B.bedrock;
      else if (h < water - 1 && depth < 3) b = depth === 0 && B.clay && rv(x, z, 3) < 0.12 ? B.clay : depth === 0 && rv(x, z, 4) < 0.3 ? B.gravel : B.seabed;
      else if (shore && depth < 3) b = B.sand;
      else if (bi === 'desert' && depth < 4) b = B.sand;
      else if (bi === 'desert' && depth < 9) b = B.sandstone;
      else if (h > model.snowline + Math.round(rv(x, z, 5) * 3) && depth < 2) b = B.snow;
      else if ((bi === 'mountains' && (slope >= 3 || h > model.snowline - 10)) && depth < soil) b = depth === 0 && slope < 3 && h <= model.snowline ? B.grass : depth === 0 && rv(x, z, 6) < 0.15 ? B.gravel : B.stone;
      else if (depth === 0) b = bi === 'snowy' ? B.snowGrass : B.grass;
      else if (depth < soil) b = B.dirt;
      else b = B.stone;
      put(x, y, z, b);
    }
    // the sea and the lakes: water from the ground up to the water line (still water; caves never reach it)
    if (B.water) for (let y = Math.max(1, h); y < water && y < sy; y++) put(x, y, z, B.water);
  }
  // ---- caves: two noise sheets crossing make tunnels, a third makes caverns (sampled every 4 cells, blended) ----
  if (caves && T.caves > 0) carveCaves(grid, model, ox, oz, heights, opts.caveEdge ?? 0);
  if (ores && T.ores > 0) placeOres(grid, model, ox, oz, heights);
  // ---- trees and plants ----
  const trees = growTrees(grid, model, ox, oz, heights, biomes);
  if (plants && T.plants > 0) placePlants(grid, model, ox, oz, heights, biomes);
  return { heights, biomes, trees };
}

function carveCaves(grid, model, ox, oz, heights, edge = 0) {
  const { T, water, B } = model, [sx, sy, sz] = grid.size, step = 4, seed = model.seed;
  const a = perlin(seed * 23 + 8), b = perlin(seed * 29 + 9), c = perlin(seed * 31 + 10), mouth = perlin(seed * 37 + 11);
  const gx = Math.ceil(sx / step) + 1, gy = Math.ceil(sy / step) + 1, gz = Math.ceil(sz / step) + 1;
  const A = new Float32Array(gx * gy * gz), Bn = new Float32Array(gx * gy * gz), Cn = new Float32Array(gx * gy * gz);
  for (let k = 0; k < gz; k++) for (let j = 0; j < gy; j++) for (let i = 0; i < gx; i++) {
    const X = i * step + ox, Y = j * step, Z = k * step + oz, n = (k * gy + j) * gx + i;
    A[n] = a.n3(X / 38, Y / 22, Z / 38); Bn[n] = b.n3(X / 38 + 31, Y / 22, Z / 38 - 17); Cn[n] = c.n3(X / 56, Y / 26, Z / 56);
  }
  const tri = (F, x, y, z) => {
    const fx = x / step, fy = y / step, fz = z / step, i = Math.floor(fx), j = Math.floor(fy), k = Math.floor(fz), u = fx - i, v = fy - j, w = fz - k;
    const at = (di, dj, dk) => F[((k + dk) * gy + (j + dj)) * gx + (i + di)];
    const x00 = at(0, 0, 0) + (at(1, 0, 0) - at(0, 0, 0)) * u, x10 = at(0, 1, 0) + (at(1, 1, 0) - at(0, 1, 0)) * u;
    const x01 = at(0, 0, 1) + (at(1, 0, 1) - at(0, 0, 1)) * u, x11 = at(0, 1, 1) + (at(1, 1, 1) - at(0, 1, 1)) * u;
    return (x00 + (x10 - x00) * v) + ((x01 + (x11 - x01) * v) - (x00 + (x10 - x00) * v)) * w;
  };
  const width = 0.0085 * T.caves, cheese = 0.62 - 0.06 * T.caves;
  // no cave within two columns of open water (it would open a wall of standing water into the cave)
  const wet = (x, z) => { for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) { const X = x + dx, Z = z + dz; const h = X >= 0 && Z >= 0 && X < sx && Z < sz ? heights[Z * sx + X] : model.heightAt(X + ox, Z + oz); if (h <= water) return true; } return false; };
  for (let z = 0; z < sz; z++) for (let x = 0; x < sx; x++) {
    const h = heights[z * sx + x];
    // (and none within `edge` columns of the grid's side: the land past it has no caves, so a cave there would open
    // onto nothing)
    if (x < edge || z < edge || x >= sx - edge || z >= sz - edge || h <= water + 1 || model.inPlaza(x + ox, z + oz, 4) || wet(x, z)) continue;
    const open = mouth.n2((x + ox) / 40, (z + oz) / 40) > 0.42;       // where a tunnel may break out into daylight
    const roof = open ? h : h - 4;
    for (let y = 3; y < roof && y < sy; y++) {
      const p = tri(A, x, y, z), q = tri(Bn, x, y, z);
      const wide = width * (1 + Math.max(0, (water - y) / 30));
      if (p * p + q * q < wide || (y < h - 9 && tri(Cn, x, y, z) > cheese)) {
        const i = grid.index(x, y, z), was = grid.data[i] & 255;
        if (was && was !== B.bedrock) grid.data[i] = 0;
      }
    }
  }
}

function placeOres(grid, model, ox, oz, heights) {
  const { T, B, water } = model, [sx, sy, sz] = grid.size, L = 8;
  const kinds = [
    { b: B.coal, p: 0.75, size: 7, below: 3 },
    { b: B.iron, p: 0.45, size: 5, below: 8, maxY: water + 4 },
    { b: B.gold, p: 0.16, size: 4, below: 16, maxY: water - 8 },
    { b: B.crystal, p: 0.38, size: 5, below: 10, maxY: water - 2 },
  ].filter(k => k.b);
  const lx0 = Math.floor((ox - L) / L), lx1 = Math.floor((ox + sx + L) / L), lz0 = Math.floor((oz - L) / L), lz1 = Math.floor((oz + sz + L) / L);
  for (let lz = lz0; lz <= lz1; lz++) for (let ly = 0; ly < Math.ceil(sy / L); ly++) for (let lx = lx0; lx <= lx1; lx++) {
    const r = mulberry32(Math.floor(hash(model.seed + 41, lx, ly, lz) * 4294967296));
    for (const k of kinds) {
      if (r() > k.p * T.ores) continue;
      let x = lx * L + Math.floor(r() * L), y = ly * L + Math.floor(r() * L), z = lz * L + Math.floor(r() * L);
      if (k.maxY !== undefined && y > k.maxY) continue;
      for (let s = 0; s < k.size; s++) {
        const gx = x - ox, gz = z - oz;
        if (gx >= 0 && gz >= 0 && gx < sx && gz < sz && y > 0 && y < sy && y < heights[gz * sx + gx] - k.below && (grid.data[grid.index(gx, y, gz)] & 255) === B.stone) grid.put(gx, y, gz, k.b);
        const d = Math.floor(r() * 6);
        if (d === 0) x++; else if (d === 1) x--; else if (d === 2) y++; else if (d === 3) y--; else if (d === 4) z++; else z--;
      }
    }
  }
  // the cave floors' own light: glowcaps in patches (a patch in about a quarter of the 8 × 4 × 8 blocks of cave), amber
  // shards on the crystal veins. Each gives off light, so a cavern has pools of colour with the dark between them.
  const crystal = B.crystal, shard = B.shard;
  for (let z = 0; z < sz; z++) for (let x = 0; x < sx; x++) {
    const h = heights[z * sx + x];
    for (let y = 3; y < h - 5 && y < sy - 1; y++) {
      if (grid.data[grid.index(x, y, z)]) continue;
      const below = grid.data[grid.index(x, y - 1, z)] & 255;
      if (below !== B.stone && below !== crystal) continue;
      // (from the cell below only: a neighbour may lie past this grid's edge, and every grid must agree)
      const r = hash(model.seed + 43, x + ox, y, z + oz);
      if (shard && below === crystal && r < 0.85) { grid.put(x, y, z, shard); continue; }
      // amber outcrops: in some stretches of cave the floor itself breaks into crystal, shards on top
      if (crystal && shard && hash(model.seed + 45, (x + ox) >> 4, y >> 3, (z + oz) >> 4) < 0.3 * T.ores && r > 0.975) { grid.put(x, y - 1, z, crystal); grid.put(x, y, z, shard); continue; }
      if (B.glowcap && hash(model.seed + 44, (x + ox) >> 3, y >> 2, (z + oz) >> 3) < 0.25 * T.ores && r < 0.16) grid.put(x, y, z, B.glowcap);
    }
  }
}

// trees on a coarse lattice (one chance per 4 × 4 columns), so a tree is the same whichever grid draws it
const TREES = { forest: 0.5, birch: 0.45, taiga: 0.42, snowy: 0.16, plains: 0.035, desert: 0.06, mountains: 0.08 };
function growTrees(grid, model, ox, oz, heights, biomes) {
  const { T, B, water } = model, [sx, sy, sz] = grid.size, G = 4;
  let count = 0;
  const air = (x, y, z) => { const v = grid.get(x, y, z); return !v || v === B.tallGrass; };
  const leaf = (x, y, z, b) => { if (grid.inBounds(x, y, z) && air(x, y, z)) grid.put(x, y, z, b); };
  const trunk = (x, y, z, b) => { if (grid.inBounds(x, y, z)) grid.put(x, y, z, b); };
  const lx0 = Math.floor((ox - 6) / G), lx1 = Math.floor((ox + sx + 6) / G), lz0 = Math.floor((oz - 6) / G), lz1 = Math.floor((oz + sz + 6) / G);
  for (let lz = lz0; lz <= lz1; lz++) for (let lx = lx0; lx <= lx1; lx++) {
    const r = mulberry32(Math.floor(hash(model.seed + 51, lx, lz) * 4294967296));
    const wx = lx * G + Math.floor(r() * G), wz = lz * G + Math.floor(r() * G);
    const bi = model.biomeAt(wx, wz), h = model.heightAt(wx, wz);
    if (r() > (TREES[bi] ?? 0) * T.trees || h <= water + 1 || model.inPlaza(wx, wz, 3)) continue;
    // a clearing now and then in the forest, so it is not one wall of trees
    if ((bi === 'forest' || bi === 'birch') && hash(model.seed + 53, wx >> 4, wz >> 4) < 0.18) continue;
    if (bi !== 'desert' && h > model.snowline + 2) continue;
    const x = wx - ox, z = wz - oz, y = h;
    const inside = x >= -4 && z >= -4 && x < sx + 4 && z < sz + 4;
    if (!inside) continue;
    const ground = grid.inBounds(x, y - 1, z) ? grid.data[grid.index(x, y - 1, z)] & 255 : -1;
    if (ground !== -1 && ground !== B.grass && ground !== B.snowGrass && ground !== B.dirt && ground !== B.sand) continue;
    if (grid.inBounds(x, y, z) && x >= 0 && z >= 0 && x < sx && z < sz) count++;
    if (bi === 'desert') {
      if (ground !== -1 && ground !== B.sand || !B.cactus) continue;
      const t = 2 + Math.floor(r() * 3);
      for (let k = 0; k < t; k++) trunk(x, y + k, z, B.cactus);
      continue;
    }
    const kind = bi === 'taiga' || bi === 'snowy' || bi === 'mountains' ? 'spruce' : bi === 'birch' ? (r() < 0.8 ? 'birch' : 'oak') : bi === 'forest' && r() < 0.25 ? 'birch' : 'oak';
    if (kind === 'spruce') {
      const t = 7 + Math.floor(r() * 5);
      for (let k = 0; k < t; k++) trunk(x, y + k, z, B.spruceLog);
      // a cone of rings, wider every other step down, a point on top
      let rad = 0;
      for (let k = t; k >= 3; k--) {
        const R = rad;
        for (let dx = -R; dx <= R; dx++) for (let dz = -R; dz <= R; dz++) {
          if (Math.abs(dx) + Math.abs(dz) > R + (R > 1 ? 1 : 0)) continue;
          if (dx || dz || k >= t) leaf(x + dx, y + k, z + dz, B.spruceLeaves);
        }
        rad = k === t ? 1 : (t - k) % 2 === 0 ? Math.min(3, rad + 1) : Math.max(1, rad - 1);
      }
      leaf(x, y + t, z, B.spruceLeaves); leaf(x, y + t + 1, z, B.spruceLeaves);
      continue;
    }
    const big = kind === 'oak' && r() < 0.12;
    const t = kind === 'birch' ? 5 + Math.floor(r() * 3) : big ? 6 + Math.floor(r() * 3) : 4 + Math.floor(r() * 3);
    const logB = kind === 'birch' ? B.birchLog : B.log, leafB = kind === 'birch' ? B.birchLeaves : B.leaves;
    for (let k = 0; k < t; k++) trunk(x, y + k, z, logB);
    const R = big ? 3 : 2, top = y + t;
    for (let dy = -R; dy <= 1; dy++) {
      const rr = dy >= 1 ? R - 1 : dy === -R ? R - 1 : R;
      for (let dx = -rr; dx <= rr; dx++) for (let dz = -rr; dz <= rr; dz++) {
        const d = dx * dx + dz * dz + (dy > 0 ? dy * dy * 1.5 : 0);
        if (d > rr * rr + 1 || (Math.abs(dx) === rr && Math.abs(dz) === rr && r() < 0.6)) continue;
        if (dx === 0 && dz === 0 && dy < 0) continue;
        leaf(x + dx, top + dy, z + dz, leafB);
      }
    }
  }
  return count;
}

function placePlants(grid, model, ox, oz, heights, biomes) {
  const { T, B, water } = model, [sx, sy, sz] = grid.size;
  const flowers = B.flowers ?? [], mushrooms = B.mushrooms ?? [];
  const patch = perlin(model.seed * 41 + 12);
  for (let z = 0; z < sz; z++) for (let x = 0; x < sx; x++) {
    const h = heights[z * sx + x];
    if (h <= water || h >= sy || model.inPlaza(x + ox, z + oz, 1)) continue;
    if (grid.data[grid.index(x, h, z)]) continue;
    const under = grid.data[grid.index(x, h - 1, z)] & 255, bi = BIOMES[biomes[z * sx + x]];
    const r = hash(model.seed + 61, x + ox, z + oz), p = patch.n2((x + ox) / 9, (z + oz) / 9);
    let b = 0;
    if (under === B.grass) {
      const dens = (bi === 'plains' ? 0.32 : bi === 'forest' || bi === 'birch' ? 0.2 : 0.14) * T.plants;
      if (bi === 'plains' && p > 0.35 && r < 0.18 * T.plants && flowers.length) b = flowers[Math.floor(hash(model.seed + 62, (x + ox) >> 3, (z + oz) >> 3) * flowers.length)];
      else if ((bi === 'forest' || bi === 'birch') && r < 0.012 * T.plants && mushrooms.length) b = mushrooms[Math.floor(r * 1000) % mushrooms.length];
      else if (r < dens * (0.6 + Math.max(0, p))) b = bi === 'taiga' && B.fern && r < dens * 0.5 ? B.fern : B.tallGrass;
      else if (r > 0.995 && flowers.length) b = flowers[Math.floor(r * 1e5) % flowers.length];
    } else if (under === B.snowGrass && B.fern && r < 0.04 * T.plants) b = B.fern;
    else if (under === B.sand && bi === 'desert' && B.deadBush && r < 0.012 * T.plants) b = B.deadBush;
    else if (under === B.sand && h <= water + 1 && B.reeds && r < 0.08 * T.plants) b = B.reeds;
    if (b) grid.put(x, h, z, b);
  }
}

/** What lies past a grid's edge (grid.outside for the mesher): the land's own height, solid below it, so an edge is
 *  culled against the land beyond and never drawn as a wall. ox, oz: the grid's world origin. */
export function landOutside(model, ox = 0, oz = 0, solidN = model.B.stone) {
  return (x, y, z) => (y < model.heightAt(x + ox, z + oz) ? solidN : 0);
}

/** Fill the play grid. → { heights, spawns, plaza, sign, water, trees, model } */
export function generateTerrain(grid, table, cfg = {}) {
  const model = terrainModel(table, cfg, grid.size);
  const { heights, trees } = fillRegion(grid, model, 0, 0, { caveEdge: 6 });
  // the spawn square: a floor of `floor` with an `edge` border, cleared above (no tree or plant ever grows there)
  const P = model.plaza, half = P.half, at = P.at, plazaY = model.plazaY;
  const floor = blockN(table, P.floor), edge = blockN(table, P.edge);
  for (let z = at[1] - half; z <= at[1] + half; z++) for (let x = at[0] - half; x <= at[0] + half; x++) {
    const border = Math.abs(x - at[0]) === half || Math.abs(z - at[1]) === half;
    grid.put(x, plazaY - 1, z, border ? edge : floor);
    for (let y = plazaY; y < grid.size[1]; y++) grid.put(x, y, z, 0);
  }
  const spawns = [];
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 + Math.PI / 8, r = Math.max(1.5, half * 0.45);
    spawns.push({ x: at[0] + 0.5 + Math.cos(a) * r, y: plazaY, z: at[1] + 0.5 + Math.sin(a) * r });
  }
  const plaza = { min: [at[0] - half, 0, at[1] - half], max: [at[0] + half, grid.size[1] - 1, at[1] + half], y: plazaY, at };
  const sign = P.sign ? { cell: [at[0], plazaY, at[1] - half + 1], face: 5 } : null;   // faces +z, into the plaza
  return { heights, spawns, plaza, sign, water: model.water, trees, model };
}
