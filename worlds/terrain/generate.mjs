// gf-three smooth terrain: the generators. Each fills a TerrainField (field.mjs) from a seed and a few numbers a look
// target or a world chooser can set, and is deterministic forever: a play host keeps only the edits, so the same seed and
// GENERATOR must give the same ground. A change to the output is a new GENERATOR number (the old one kept beside it).
//
//   const { field, info } = generateTerrain(params)        params: DEFAULTS below (every field optional)
//   spawnsOn(field, n, seed, opts)                          n standing places on open, flat-enough ground, spread apart
//
// Shapes (params.shape):
//   islands   islands in a sea: `islands.count` of them along the box's long side (or `islands.list` placed by hand),
//             rounded hills on top, cliffs round the edge (`land.cliff`), lumpy faces and overhangs (`land.overhang`),
//             tunnels through the rock (`land.tunnels`)
//   cliffs    one shore of land along a side of the box (`cliffs.coast`) falling to the sea in steps (`cliffs.terraces`)
import { TerrainField, BAND } from './field.mjs';
import { perlin, fbm2, mulberry32 } from '../voxel/noise.mjs';
import { composeTerrain } from './compose.mjs';
import { connectTerrain } from './connect.mjs';
import { reachConfig } from '../connect.mjs';

export const GENERATOR = 1;
export const DEFAULTS = {
  generator: GENERATOR, seed: 1, shape: 'islands',
  size: [112, 34, 80],          // the box in metres: x (long side), y (up), z
  cell: 0.5,                    // metres between samples
  floor: -6,                    // the box's bottom (the sea is at y = 0)
  land: { height: 14, rim: 0.5, hills: 3, hillSize: 22, cliff: 0.75, overhang: 0.5, tunnels: 0.35, terraces: 0, roughness: 0.5 },
  islands: { count: 3, radius: [13, 18], spread: 0.92, list: null },
  cliffs: { coast: 'z+', depth: 0.6, terraces: 3 },
  // level pads cut into the ground for the seats (a look target asks for them: worlds/scenery.js and builder/look/world.mjs):
  // `count` places on the gentlest ground, each a flat disc `radius` m across its middle, blended into the land over
  // `blend` m. Off (count 0) by default, so a world without them is the same ground it always was.
  pads: { count: 0, radius: 3.2, blend: 3, slope: 0.3 },
  // level sites for set pieces (a castle, a domed tower, a mesa: worlds/scenery.js stands the look's landmarks on them):
  // `count` flat discs `radius` m across their middle on open ground, at least `clear` m from every seat pad's middle and
  // apart from each other. Off (count 0) by default, so a world without them is the same ground it always was.
  sites: { count: 0, radius: 4.5, blend: 3, slope: 0.45, clear: 10 },
  // the level's composition (looks wave 4: worlds/terrain/compose.mjs): landmarks and bridges made ground, the seats in
  // pairs round them. Null by default (and with no pieces' shapes given), so a world without it is the same ground it
  // always was. {landmarks: [prop id], bridges: [prop id], playOn, share, verticality, bridgeCount, camera, seats}
  compose: null,
};

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const merge = (a, b) => { const o = { ...a }; for (const [k, v] of Object.entries(b ?? {})) o[k] = v && typeof v === 'object' && !Array.isArray(v) && a?.[k] && typeof a[k] === 'object' ? merge(a[k], v) : v; return o; };

/** Params with every default filled (what a world keeps in config/world.json → terrain). */
export function paramsOf(p = {}) { return merge(DEFAULTS, p); }

/** The islands of an `islands` shape: [{x, z, r, height}], from the list or placed along the long side. */
export function islandsOf(P) {
  const [sx, , sz] = P.size, I = P.islands, rnd = mulberry32((P.seed * 7919 + 13) >>> 0);
  if (Array.isArray(I.list) && I.list.length) return I.list.map(i => ({ x: i.at[0], z: i.at[1], r: i.r ?? I.radius[1], height: i.height ?? P.land.height }));
  const n = Math.max(1, I.count | 0), out = [];
  const usable = sx * clamp(I.spread, 0.2, 1) - 2 * I.radius[0];
  for (let k = 0; k < n; k++) {
    const t = n === 1 ? 0.5 : k / (n - 1);
    const r = I.radius[0] + (I.radius[1] - I.radius[0]) * rnd();
    const x = (t - 0.5) * usable + (rnd() - 0.5) * 6;
    const z = (rnd() - 0.5) * Math.max(0, sz - 2 * r - 12) * 0.6;
    out.push({ x, z, r: Math.min(r, sz / 2 - 6), height: P.land.height * (0.8 + 0.4 * rnd()) });
  }
  return out;
}

/** The land's height function h(x, z) (y of the top, before the 3D detail) and how much land is there (m > 0). */
function heightModel(P) {
  const N = perlin(P.seed | 0), W = perlin((P.seed * 31 + 7) | 0);
  const L = P.land, [sx, , sz] = P.size, floor = P.floor;
  const edge = 0.04 + 0.4 * (1 - clamp(L.cliff, 0, 1));         // how far in from the shore the land reaches its top
  const sink = floor - 3;                                           // where there is no land: below the box
  const isl = P.shape === 'islands' ? islandsOf(P) : [];
  // land share m at (x, z): > 0 on land, 1 deep inland
  const shareOf = (x, z) => {
    const wx = x + fbm2(W, x / 18, z / 18, 3) * 6, wz = z + fbm2(W, x / 18 + 40, z / 18 - 40, 3) * 6;
    let m = -1, top = L.height;
    if (P.shape === 'cliffs') {
      const C = P.cliffs, along = C.coast === 'x+' || C.coast === 'x-';
      const s = along ? sx : sz, v = (along ? wx : wz) * (C.coast.endsWith('-') ? -1 : 1);
      // land from the coast side in: a share `depth` of the box, its shore line wandering
      m = ((v + s / 2) - s * (1 - C.depth)) / (s * C.depth);
      m = (m - 0.0) / 0.9;
    } else {
      for (const i of isl) {
        const d = Math.hypot(wx - i.x, wz - i.z) / i.r;
        const mi = 1 - d;
        if (mi > m) { m = mi; top = i.height; }
      }
    }
    // the box's edges are always sea (the ground closes inside the box)
    const ex = sx / 2 - Math.abs(x), ez = sz / 2 - Math.abs(z);
    m = Math.min(m, (Math.min(ex, ez) - 3) / 10);
    return { m, top };
  };
  const h = (x, z) => {
    const { m, top } = shareOf(x, z);
    if (m <= -0.02) return sink;
    const hill = fbm2(N, x / L.hillSize, z / L.hillSize, 4) * L.hills + fbm2(N, x / 5 + 50, z / 5, 2) * L.roughness * 0.6;
    // a dome over the cliff: the rim at `rim` of the top's height, rising to the full height inland
    const dome = smooth(edge * 0.5, 0.95, m);
    let t = top * (L.rim + (1 - L.rim) * dome) + hill * smooth(0, 0.6, m);
    if (P.shape === 'cliffs') {
      const steps = Math.max(0, P.cliffs.terraces | 0);
      if (steps > 0) { const q = m * (steps + 1) * 0.999; const f = q - Math.floor(q); t *= (Math.floor(q) + smooth(0.75, 1, f)) / (steps + 1) * 0.6 + 0.4; }
    }
    if (L.terraces > 0) { const st = L.terraces, q = t / st, f = q - Math.floor(q); t = (Math.floor(q) + smooth(0.7, 1, f)) * st; }
    const rise = smooth(0, edge, m);
    return sink + (t - sink) * rise;
  };
  return { h, shareOf, islands: isl };
}

/**
 * Fill a field from params. → { field, params, info: { islands, sea: 0, top: Float32Array (the ground's top per sample
 * column before any edit: for the soil's depth), seconds } }
 * opts.pieces: {id: {tris}} the set pieces' shapes (their models' triangles) for params.compose; with a composition and
 * its pieces, info also has landmarks, own (the owner mask: which samples are a piece's), compose (the composer's
 * report), and pads are the composed seats ({x, y, z, yaw}, in pairs).
 */
export function generateTerrain(params = {}, { pieces = null, numbers = {}, seats = null, players = 0, reach = null } = {}) {
  const t0 = typeof performance !== 'undefined' ? performance.now() : 0;
  const P = paramsOf(params);
  const h = P.cell, [sx, sy, sz] = P.size;
  const nx = Math.round(sx / h) + 1, ny = Math.round(sy / h) + 1, nz = Math.round(sz / h) + 1;
  const origin = [-(nx - 1) * h / 2, P.floor, -(nz - 1) * h / 2];
  const field = new TerrainField({ size: [nx, ny, nz], cell: h, origin });
  const M = heightModel(P), L = P.land;
  const N3 = perlin((P.seed * 131 + 3) | 0), T1 = perlin((P.seed * 17 + 11) | 0), T2 = perlin((P.seed * 23 + 5) | 0);
  // per column: the height, its slope (for the distance scale) and the land share
  const H = new Float32Array(nx * nz), G = new Float32Array(nx * nz), S = new Float32Array(nx * nz);
  for (let k = 0; k < nz; k++) for (let i = 0; i < nx; i++) {
    const x = origin[0] + i * h, z = origin[2] + k * h;
    const c = M.h(x, z), dx = (M.h(x + h, z) - M.h(x - h, z)) / (2 * h), dz = (M.h(x, z + h) - M.h(x, z - h)) / (2 * h);
    H[k * nx + i] = c; G[k * nx + i] = Math.sqrt(1 + dx * dx + dz * dz); S[k * nx + i] = M.shareOf(x, z).m;
  }
  const d = field.d, tunnelR = 0.06 + 0.1 * clamp(L.tunnels, 0, 1);
  for (let j = 0; j < ny; j++) {
    const y = origin[1] + j * h;
    for (let k = 0; k < nz; k++) for (let i = 0; i < nx; i++) {
      const c = k * nx + i, x = origin[0] + i * h, z = origin[2] + k * h, top = H[c], g = G[c];
      let v = (y - top) / g;
      if (v > BAND + 3 || v < -(BAND + 3) - 2 * L.overhang) { d[(j * nz + k) * nx + i] = Math.fround(clamp(v, -BAND, BAND)); continue; }
      // lumps and overhangs on the steep faces: the surface pushed in and out sideways, never above the top (no
      // floating lumps) and fading in a little under it (the top edge stays a clean rounded lip)
      const steep = clamp(g - 1.3, 0, 1), under = smooth(0.4, 2.5, top - y);
      if (L.overhang > 0 && steep > 0 && under > 0) v += N3.n3(x / 4.5, y / 3.2, z / 4.5) * 1.8 * L.overhang * steep * under;
      // tunnels: where two noises are both near zero, a tube; only well inside the land and above the sea
      if (L.tunnels > 0 && S[c] > 0.15 && y > 0.8 && y < top - 2.2) {
        const a = T1.n3(x / 16, y / 10, z / 16), b = T2.n3(x / 16, y / 10, z / 16);
        const tube = Math.sqrt(a * a + b * b);
        if (tube < tunnelR) v = Math.max(v, (tunnelR - tube) * 14);
      }
      d[(j * nz + k) * nx + i] = Math.fround(clamp(v, -BAND, BAND));
    }
  }
  field.sealEdges();
  // a lump the noise left in the air (or under the sea) touching no other ground: gone, so nothing floats
  for (const a of floatingOf(field).list) field.d[a] = Math.max(field.d[a], Math.fround(h * 0.5));
  // a composed level (its pieces' shapes given): the landmarks and bridges made ground, the seats in pairs round them
  const composed = P.compose && pieces ? (() => {
    const own = new Uint8Array(d.length);
    const c = composeTerrain(field, P, M.islands, pieces, { own, levelDisc });
    // the placed pieces with their triangles (the connectors add bridges of the level's model to them)
    c.landmarksFull = c.landmarks.map(m => ({ ...m, tris: c.tris.get(m.owner) }));
    // a chasm or a plaza can leave a lump of land touching nothing: gone, as at generation (a piece is left as made)
    for (const a of floatingOf(field).list) if (!own[a]) field.d[a] = Math.max(field.d[a], Math.fround(h * 0.5));
    return { ...c, own };
  })() : null;
  // level pads for the seats: a flat terrace cut (or filled) into the land at each, so a body and its camera stand level
  const pads = composed ? composed.seats : P.pads?.count > 0 ? padsOn(field, P) : [];
  // level sites for the look's set pieces, away from the seats
  const sites = !composed && P.sites?.count > 0 ? sitesOn(field, P, pads) : [];
  // every region of ground worth going to joined to the seats (connect.mjs: bridges, shallows, ramps, launch pads), unless
  // the world says otherwise (config/world.json reach: connect false, or regions kept apart with a reason)
  const R = reachConfig(reach ?? P.reach ?? {});
  const joined = R.connect ? connectTerrain(field, P, {
    pieces, own: composed?.own ?? null, landmarks: composed ? composed.landmarksFull : [], numbers, seaLevel: 0, levelDisc,
    // the seats in play (the game's players.max of them; a composed level makes spare ones)
    seats: (l => (l && players > 0 ? l.slice(0, players) : l))(seats ?? (pads.length ? pads : null)), reach: reach ?? P.reach ?? {},
  }) : null;
  if (joined && composed) {
    // a bridge model the connectors stood is a landmark like the composer's (drawn, clipped, leaned toward)
    for (const m of composed.landmarksFull.slice(composed.landmarks.length)) { const { tris, facts, ...rest } = m; composed.landmarks.push(rest); composed.tris.set(m.owner, tris); }
  }
  // the ground's top per column before any edit (the soil's depth below it colours the cut faces): the land's, not a
  // piece's (a castle's roof is not the top of the soil under it)
  const own = composed?.own ?? null;
  const top = new Float32Array(nx * nz);
  for (let k = 0; k < nz; k++) for (let i = 0; i < nx; i++) {
    let t = origin[1] - 1;
    for (let j = ny - 2; j >= 1; j--) {
      const ia = (j * nz + k) * nx + i, ib = ((j + 1) * nz + k) * nx + i;
      if (own && own[ia]) continue;
      const a = d[ia], b = own && own[ib] ? Math.max(0, d[ib]) : d[ib];
      if (a < 0 && b >= 0) { t = origin[1] + (j + (b === a ? 0 : a / (a - b))) * h; break; }
    }
    top[k * nx + i] = t;
  }
  const seconds = typeof performance !== 'undefined' ? (performance.now() - t0) / 1000 : 0;
  return { field, params: P, info: { islands: M.islands, sea: 0, top, seconds, pads, sites, ...(joined ? { connect: { list: joined.connectors, kept: joined.kept, left: joined.left, small: joined.small, links: joined.links, report: joined.report }, reached: joined.reached } : {}), ...(composed ? { landmarks: composed.landmarks, own, compose: composed.report, pieceTris: composed.tris } : {}) } };
}

/**
 * Level pads: `P.pads.count` places chosen on the gentlest open ground (spawnsOn with the pads' slope limit), each made a
 * flat disc at its own height: inside `radius` every sample within 6 m of the pad's height becomes the plane's distance
 * (ground below, air above: a terrace cut into a slope, or filled under it), blended into the land over `blend` m. Only
 * + - * / on Float32 storage, so every copy cuts the same pads. → [{x, y, z}] (the pads' tops: where seats stand)
 */
export function padsOn(field, P) {
  const { radius = 3.2, blend = 3, slope = 0.3, count } = P.pads;
  const at = spawnsOn(field, count, P.seed, { slope, clear: 2.4 });
  for (const p of at) levelDisc(field, p, radius, blend);
  return at.map(p => ({ x: p.x, y: Math.round((p.y) * 100) / 100, z: p.z }));
}

/**
 * Level sites for set pieces: `P.sites.count` places on open, gentle ground with clear sky over them, at least
 * `clear` m from every seat pad and twice their radius apart (the ones a seat sees first), each levelled like a pad. → [{x, y, z, r}] (r: the flat
 * disc's radius, the most a piece's footprint should cover)
 */
export function sitesOn(field, P, pads = []) {
  const { radius = 4.5, blend = 3, slope = 0.45, clear = 10, count } = P.sites;
  // a landmark is there to be seen: the places a seat looks at across open ground (clear to 2.5 times that) come first
  const seen = c => pads.some(p => { const d = Math.hypot(p.x - c.x, p.z - c.z); return d <= clear * 2.5 && inSight(field, p, { ...c, y: c.y + 2 }); });
  const cand = spawnsOn(field, count * 8, (P.seed ^ 0x5173) >>> 0, { slope, clear: 6 })
    .filter(c => pads.every(p => Math.hypot(p.x - c.x, p.z - c.z) >= clear))
    .map(c => ({ c, seen: seen(c) })).sort((a, b) => b.seen - a.seen).map(x => x.c);
  const out = [];
  for (const c of cand) {
    if (out.length >= count) break;
    if (out.some(o => Math.hypot(o.x - c.x, o.z - c.z) < radius * 2 + 2)) continue;
    out.push(c);
  }
  for (const p of out) levelDisc(field, p, radius, blend);
  return out.map(p => ({ x: p.x, y: Math.round(p.y * 100) / 100, z: p.z, r: radius }));
}

/**
 * Make the ground a flat disc at p's height: a terrace cut into a slope, or filled under it, blended over `blend` m. With
 * an owner mask, a set piece's samples (own > 0) are never touched (a seat's pad beside a castle leaves the castle);
 * cutOnly: only cut, never fill.
 */
export function levelDisc(field, p, radius, blend, own = null, { cutOnly = false } = {}) {
  const { nx, ny, nz, d, cell: h, origin } = field, reach = radius + blend;
  const py = p.y - 0.05;
  const i0 = Math.max(1, Math.floor((p.x - reach - origin[0]) / h)), i1 = Math.min(nx - 2, Math.ceil((p.x + reach - origin[0]) / h));
  const k0 = Math.max(1, Math.floor((p.z - reach - origin[2]) / h)), k1 = Math.min(nz - 2, Math.ceil((p.z + reach - origin[2]) / h));
  const j0 = Math.max(1, Math.floor((py - 6 - origin[1]) / h)), j1 = Math.min(ny - 2, Math.ceil((py + 6 - origin[1]) / h));
  for (let k = k0; k <= k1; k++) for (let i = i0; i <= i1; i++) {
    const x = origin[0] + i * h, z = origin[2] + k * h, q = Math.sqrt((x - p.x) * (x - p.x) + (z - p.z) * (z - p.z));
    if (q >= reach) continue;
    const t = q <= radius ? 1 : 1 - (q - radius) / blend, w = t * t * (3 - 2 * t);
    for (let j = j0; j <= j1; j++) {
      const y = origin[1] + j * h, a = (j * nz + k) * nx + i;
      if (own && own[a]) continue;
      const plane = clamp(y - py, -BAND, BAND);
      // cut only: never ground where there was air (a bridge's end never fills the gap it spans)
      if (cutOnly && plane < d[a]) continue;
      d[a] = Math.fround(d[a] + (plane - d[a]) * w);
    }
  }
}

/**
 * Ground that touches nothing: solid samples not joined (6-way) to a solid sample on the box's lowest open layer.
 * → {samples, at: [x, y, z] of the first (or null), list: [sample index]}
 */
export function floatingOf(field) {
  const { nx, ny, nz, d } = field, seen = new Uint8Array(d.length), stack = [], up = nx * nz;
  const push = b => { if (!seen[b] && d[b] < 0) { seen[b] = 1; stack.push(b); } };
  for (let k = 1; k < nz - 1; k++) for (let i = 1; i < nx - 1; i++) push((1 * nz + k) * nx + i);
  while (stack.length) {
    const a = stack.pop(), i = a % nx, k = Math.floor(a / nx) % nz, j = Math.floor(a / up);
    if (i > 0) push(a - 1); if (i < nx - 1) push(a + 1);
    if (k > 0) push(a - nx); if (k < nz - 1) push(a + nx);
    if (j > 0) push(a - up); if (j < ny - 1) push(a + up);
  }
  const list = [];
  for (let a = 0; a < d.length; a++) if (d[a] < 0 && !seen[a]) list.push(a);
  const at = list.length ? [field.origin[0] + (list[0] % nx) * field.cell, field.origin[1] + Math.floor(list[0] / up) * field.cell, field.origin[2] + (Math.floor(list[0] / nx) % nz) * field.cell] : null;
  return { samples: list.length, at, list };
}

/**
 * The ground's original top over (x, z) from a `top` array: the highest of the columns within a cell round the point, so
 * a point on a cliff face reads the land's top above it, never the sea's beside it.
 */
export function topAt(field, top, x, z) {
  const h = field.cell, nx = field.nx;
  const i0 = clamp(Math.floor((x - field.origin[0]) / h) - 1, 0, nx - 1), i1 = clamp(i0 + 3, 0, nx - 1);
  const k0 = clamp(Math.floor((z - field.origin[2]) / h) - 1, 0, field.nz - 1), k1 = clamp(k0 + 3, 0, field.nz - 1);
  let t = -Infinity;
  for (let k = k0; k <= k1; k++) for (let i = i0; i <= i1; i++) if (top[k * nx + i] > t) t = top[k * nx + i];
  return t;
}

/**
 * n standing places on the ground: above the sea by `above` m, the ground there no steeper than `slope` (rise per metre),
 * with `clear` m of open air above, spread as far apart as they go (farthest-point from seeded candidates). → [{x, y, z}]
 */
export function spawnsOn(field, n, seed = 1, { above = 1.2, slope = 0.55, clear = 2.4, tries = 900 } = {}) {
  const rnd = mulberry32((seed * 2654435761) >>> 0), b = field.bounds, cand = [];
  for (let t = 0; t < tries; t++) {
    const x = b.min[0] + 4 + rnd() * (b.max[0] - b.min[0] - 8), z = b.min[2] + 4 + rnd() * (b.max[2] - b.min[2] - 8);
    const y = field.heightAt(x, z);
    if (y == null || y < above) continue;
    const nrm = field.normal(x, y, z);
    if (nrm[1] < 1 / Math.sqrt(1 + slope * slope)) continue;
    if (field.sample(x, y + clear, z) < 0.3) continue;
    // not on a ledge: the ground a metre round is near the same height
    let ok = true;
    for (const [ox, oz] of [[1.2, 0], [-1.2, 0], [0, 1.2], [0, -1.2]]) { const q = field.heightAt(x + ox, z + oz); if (q == null || Math.abs(q - y) > 1) { ok = false; break; } }
    if (ok) cand.push({ x, y, z });
  }
  if (!cand.length) return [];
  const out = [cand[0]];
  while (out.length < n && out.length < cand.length) {
    let best = null, bd = -1;
    for (const c of cand) { const m = Math.min(...out.map(o => Math.hypot(o.x - c.x, o.z - c.z))); if (m > bd) { bd = m; best = c; } }
    if (!best || bd < 0.5) break;
    out.push(best);
  }
  return out.map(p => ({ x: Math.round(p.x * 100) / 100, y: Math.round((p.y + 0.05) * 100) / 100, z: Math.round(p.z * 100) / 100 }));
}

/** Can a body standing at p see one standing at q (eye to chest, over the ground)? */
export function inSight(field, p, q) {
  const a = [p.x, p.y + 1.5, p.z], b = [q.x, q.y + 1.0, q.z], dir = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], d = Math.hypot(...dir);
  const hit = field.raycast(a, dir, d);
  return !hit || hit.distance > d - 0.4;
}

/**
 * Spawns in seat order, each with a yaw: seats in pairs (0 and 1, 2 and 3, ...) that can see each other across open
 * ground or water at a fighting distance (`near` to `far` m), each facing its partner, so friends see each other from
 * the first second; a spawn left over faces the middle of them all. Give it more places than seats (`count`): it pairs
 * the ones that see each other. → [{x, y, z, yaw}]
 */
export function seatSpawns(field, spawns, { near = 10, far = 45, count = spawns.length } = {}) {
  const left = spawns.slice(), out = [];
  const mid = { x: spawns.reduce((a, s) => a + s.x, 0) / Math.max(1, spawns.length), z: spawns.reduce((a, s) => a + s.z, 0) / Math.max(1, spawns.length) };
  const face = (p, q) => Math.atan2(q.x - p.x, q.z - p.z);
  while (left.length) {
    const a = left.shift();
    let best = -1, bs = -Infinity;
    left.forEach((b, i) => {
      const d = Math.hypot(a.x - b.x, a.z - b.z);
      const score = (inSight(field, a, b) && inSight(field, b, a) ? 100 : 0) - Math.max(0, near - d) - Math.max(0, d - far);
      if (score > bs) { bs = score; best = i; }
    });
    if (best < 0) { out.push({ ...a, yaw: face(a, mid) }); break; }
    const b = left.splice(best, 1)[0];
    out.push({ ...a, yaw: face(a, b) }, { ...b, yaw: face(b, a) });
    if (out.length >= count) break;
  }
  return out.slice(0, count);
}
