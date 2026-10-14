// Islands in an open sea (the sea-islands template; looks wave 2, 2026-10-14). Pure: no three.js, no DOM; create, the
// look's world step (builder/look/world.mjs), the colliders and the browser expand a recipe the same way.
//
//   seaLayout(recipe, { size, seed })   → a layout (config/world.json): the play island and the islands round it, the
//                                          sea, the clouds, the dressing (placed at the ground's height), spawns, zones
//   heightAt(layout, x, z)              → the ground's height at (x, z): an island's top, else the sea floor (null)
//   islandOf(layout, x, z)              → the island whose top holds (x, z), or null
//   SEA_PARAMS                          → the parameters a look target sets (builder/look/world.mjs seaParams)
//
// The play island holds the play area (the template's size class) in its flat middle, inside invisible walls; its
// hills rise round it, its edge rounds over into cut cliffs (the soil's cross-section, a texture slot) down to the sea,
// with a beach where the target has sand. The other islands stand out in the sea toward the horizon, the clouds in a
// ring above it. The terrain stream's destructible ground (an SDF) takes the islands in this form when it lands: it
// owns the ground's mesh, this file owns where the land is and how high.
import { rng as makeRng } from './layout.js';
import { outlineRadius } from './places/shapes.js';

const r2 = v => Math.round(v * 100) / 100;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/** What a look target sets (builder/look/world.mjs), with the recipe's own values as the defaults. */
export const SEA_PARAMS = {
  relief: 0.5,          // 0 flat … 1 steep: the hills round the play area (and how far they lean into it)
  cliff: 4,             // metres from the play island's top down to the sea
  terraces: 1,          // ledges in a cliff (0: a single face)
  beach: 0.5,           // 0 none … 1 wide sand round every island
  islands: 4,           // the other islands toward the horizon
  clouds: 0.45,         // cloud cover 0–1
  cloudStyle: 'puff',   // puff (rounded masses) | card (flat painted cut-outs) | none
  cloudColor: '#f4f7ff',
  density: 0.5,         // how dressed the land is, 0–1
  dressing: [],         // prop ids the target's dressing found in the library, most seen first
  // ground: {color, color2, beach, pattern: {file, size}} and cliffs: {color, strata, pattern}: over the recipe's
};

/** The island's outline radius at angle a, from its shape. */
export const edgeOf = (isl, a) => outlineRadius(isl.shape, a);

/** The island whose top holds (x, z), or null. */
export function islandOf(layout, x, z) {
  for (const isl of layout.islands ?? []) {
    const dx = x - isl.at[0], dz = z - isl.at[2], d = Math.hypot(dx, dz);
    if (d <= edgeOf(isl, Math.atan2(dz, dx))) return isl;
  }
  return null;
}

/** The top's height of one island at (x, z) (it may be off the island: the lip keeps falling past the edge). */
export function topOf(isl, x, z) {
  const dx = x - isl.at[0], dz = z - isl.at[2], d = Math.hypot(dx, dz);
  const R = edgeOf(isl, Math.atan2(dz, dx)), inside = R - d;
  let y = isl.at[1];
  // the edge rounds over: the last `lip` metres fall `lipDrop`, eased, so the cliff starts below the grass
  if (inside < isl.lip) { const t = clamp(1 - inside / isl.lip, 0, 1.6); y -= isl.lipDrop * t * t; }
  // the play island's shore: between its hill groups the land past the play area falls toward the sea (the lower
  // shore and the water show past the play area; the cliffs stay tall behind the hills)
  if (isl.fall && isl.play && isl.falls?.length) {
    const a = Math.atan2(dz, dx), half = isl.half ?? [0, 0];
    const out = Math.hypot(Math.max(0, Math.abs(dx) - half[0]), Math.max(0, Math.abs(dz) - half[1]));
    const band = Math.max(1, R - Math.hypot(half[0], half[1]) * 0.75);
    let k = 0;
    for (const f of isl.falls) { const da = Math.abs(Math.atan2(Math.sin(a - f.a), Math.cos(a - f.a))); k = Math.max(k, clamp(1 - da / f.w, 0, 1)); }
    const t = clamp(out / band, 0, 1);
    y -= isl.fall * (k * k * (3 - 2 * k)) * (t * t * (3 - 2 * t));
  }
  for (const h of isl.hills ?? []) {
    const q = Math.hypot(x - h.at[0], z - h.at[1]) / h.r;
    if (q < 1) { const k = 1 - q * q; y += h.h * k * k; }
  }
  return y;
}

/** The ground's height at (x, z): the top of the island there, else null (the sea). */
export function heightAt(layout, x, z) {
  const isl = islandOf(layout, x, z);
  return isl ? r2(topOf(isl, x, z)) : null;
}

/** A seeded island shape: a superellipse with a wobble, roundish for small islands. */
function shapeOf(R, radius, n) {
  const wobble = Array.from({ length: 3 }, (_, k) => [2 + k * 2 + Math.floor(R() * 2), r2((0.03 + R() * 0.04) / (1 + k * 0.6)), r2(R() * 6.28)]);
  return { radius: r2(radius), n: r2(n), rot: r2(R() * 6.28), wobble };
}

/**
 * Islands in a ring out at sea, toward the horizon (scenery: no play on them): `P.islands` of them past `inner` metres
 * from the middle, their tops up to the cliff height (and the relief's hills) over the sea at `sea`. Drawn by
 * islands.js; a terrain world takes them too (worlds/scenery.js).
 */
export function ringIslands(P, R, { inner, sea, cliff, relief }) {
  const out = [], nIsles = Math.round(clamp(P.islands ?? 0, 0, 10));
  for (let k = 0; k < nIsles; k++) {
    const a = (k / Math.max(1, nIsles)) * Math.PI * 2 + (R() - 0.5) * 1.1;
    const dist = inner + 30 + R() * 140 + k * 12;
    const rad = 8 + R() * 22, top = r2(sea + 1.5 + R() * (cliff + relief * 6));
    const isl = { id: `isle-${k + 1}`, at: [r2(Math.cos(a) * dist), top, r2(Math.sin(a) * dist)], shape: shapeOf(R, rad, 2 + R() * 1.2), lip: 2.5, lipDrop: 0.8, cliff: r2(top - sea), terraces: R() < 0.5 ? 1 : 0, beach: r2((P.beach ?? 0.5) * (2 + R() * 4)), hills: [] };
    const nh = 1 + Math.floor(R() * 3 + relief * 2);
    for (let j = 0; j < nh; j++) { const b = R() * Math.PI * 2, d = R() * rad * 0.5; isl.hills.push({ at: [r2(isl.at[0] + Math.cos(b) * d), r2(isl.at[2] + Math.sin(b) * d)], r: r2(rad * (0.35 + R() * 0.4)), h: r2((1 + R() * 3) * (0.4 + relief * 1.6)) }); }
    out.push(isl);
  }
  return out;
}

/**
 * The clouds: big masses low over the horizon, as a painted sky has them (the further, the bigger and the lower in the
 * view), `P.clouds` cover (0–1) in a ring round the middle, `base` metres over the sea.
 */
export function cloudsOf(P, R, { base = 0 } = {}) {
  const clouds = [], nClouds = P.cloudStyle === 'none' ? 0 : Math.round(clamp(P.clouds ?? 0, 0, 1) * 40);
  for (let k = 0; k < nClouds; k++) {
    const a = (k / Math.max(1, nClouds)) * Math.PI * 2 + R() * 0.6, dist = 150 + R() * 170, s = r2(16 + R() * 22 + dist * 0.06);
    clouds.push({ at: [r2(Math.cos(a) * dist), r2(base + 14 + R() * 30 + s * 0.25), r2(Math.sin(a) * dist)], size: s, flat: r2(0.45 + R() * 0.25), puffs: 5 + Math.floor(R() * 7), seed: Math.floor(R() * 1e6) });
  }
  return clouds;
}

/** recipe (worlds/templates/sea-islands.json, `params` over SEA_PARAMS) + size + seed → the layout. */
export function seaLayout(recipe, { size = 'small', seed = 1 } = {}) {
  const P = { ...SEA_PARAMS, ...(recipe.params ?? {}) };
  const R = makeRng(seed);
  const [W, D] = recipe.sizes?.[size] ?? recipe.size ?? [30, 24];
  const halfDiag = Math.hypot(W, D) / 2;
  const relief = clamp(P.relief, 0, 1), cliff = clamp(P.cliff, 0.8, 14), sea = -cliff;
  const dressing = [...new Set([...(P.dressing ?? []), ...(recipe.dressing?.always ?? [])])];

  // ---- the play island: the play area in its flat middle, hills round it out to the rim ----
  const mainR = halfDiag + 3 + relief * 4;
  const main = { id: 'main', play: true, at: [0, 0, 0], shape: shapeOf(R, mainR, 2.4 + R() * 0.6), lip: 3.2, lipDrop: 0.9, cliff, terraces: P.terraces, beach: r2(P.beach * 4), hills: [] };
  // hills stand in two or three groups round the rim, with low land between them where the island's edge and the sea
  // show past the play area
  const nHills = Math.round(3 + relief * 7), nGroups = 2 + Math.floor(R() * 2);
  const groups = Array.from({ length: nGroups }, (_, g) => (g / nGroups) * Math.PI * 2 + R() * 1.2);
  // the low shores between the groups: most of the cliff's height falls away there, down toward a beach
  main.half = [W / 2, D / 2];
  main.fall = r2(cliff * 0.65);
  main.falls = groups.map((g, i) => { const h = groups[(i + 1) % nGroups] + (i + 1 === nGroups ? Math.PI * 2 : 0); return { a: r2((g + h) / 2), w: r2(Math.max(0.5, (h - g) / 2 - 0.25)) }; });
  for (let k = 0; k < nHills; k++) {
    const a = groups[k % groups.length] + (R() - 0.5) * 1.1;
    const edge = edgeOf(main, a);
    // a hill sits between the play area's edge and the rim; a steeper target leans them in over the play area's edge
    const d = clamp(halfDiag * (0.95 - relief * 0.25) + R() * (edge - halfDiag - 2), halfDiag * 0.6, edge - 3);
    const r = 4 + R() * 5 + relief * 3, h = r2((0.5 + R() * 1.2) * (0.5 + relief * 1.6));
    main.hills.push({ at: [r2(Math.cos(a) * d), r2(Math.sin(a) * d)], r: r2(r), h });
  }
  const islands = [main];

  // ---- the islands round it, toward the horizon; the clouds over the sea ----
  islands.push(...ringIslands(P, R, { inner: mainR, sea, cliff, relief }));
  const clouds = cloudsOf(P, R);

  // ---- the dressing: the target's props first, at the ground's height, never in the play area's open middle ----
  const layout = {
    template: recipe.template, kind: 'outdoor', label: recipe.label, describe: recipe.describe,
    size: [W, D], sizeClass: size,
    ground: { ...(recipe.ground ?? {}), ...(P.ground ?? {}), shape: 'islands' },
    cliffs: { ...(recipe.cliffs ?? {}), ...(P.cliffs ?? {}) },
    sea: { level: r2(sea), radius: recipe.sea?.radius ?? 900 },
    sky: { clouds: { style: P.cloudStyle, color: P.cloudColor, list: clouds } },
    islands,
    bounds: { walls: true, height: 4, ...(recipe.bounds ?? {}) },
    bench: { stage: [0, 0, 3], facing: 0 },
    props: [], spawns: [], zones: {},
  };
  // ---- spawns in a ring round the middle, facing in; the zones ----
  const n0 = recipe.players ?? 8, rr = Math.min(W, D) * 0.32;
  for (let k = 0; k < n0; k++) { const a = (k / n0) * Math.PI * 2 + 0.3; layout.spawns.push([r2(Math.cos(a) * rr * (W / Math.min(W, D))), 0, r2(Math.sin(a) * rr * (D / Math.min(W, D)))]); }
  layout.zones = { centre: { shape: 'circle', at: [0, 0, 0], size: [2.5] }, island: { shape: 'box', at: [0, 0, 0], size: [W, 4, D] } };
  // the play area's own ground is flat: a hill leaning into it is still walkable, so the spawns are lifted to it
  layout.spawns = layout.spawns.map(([x, , z]) => [x, Math.max(0, heightAt(layout, x, z) ?? 0), z]);
  // a placement keeps clear of the others (by its size class) and of every spawn's metre and a half
  const taken = layout.spawns.map(([x, , z]) => ({ x, z, r: 1.4 }));
  const room = id => (/tree|palm|pine|tower/.test(id) ? 1.4 : /rock-large|crate|barrel|drum/.test(id) ? 1 : 0.6);
  const put = (prop, x, z, scale = 1, rot = null) => {
    const r = room(prop) * scale, y = heightAt(layout, x, z);
    if (y === null || taken.some(t => Math.hypot(t.x - x, t.z - z) < t.r + r)) return false;
    taken.push({ x, z, r });
    layout.props.push({ prop, at: [r2(x), r2(y), r2(z)], rot: rot ?? Math.round(R() * 360), scale: r2(scale) });
    return true;
  };
  const pick = (list, k) => list[k % list.length];
  const trees = dressing.filter(id => /tree|palm|pine/.test(id)), rocks = dressing.filter(id => /rock|stone/.test(id));
  const small = dressing.filter(id => /grass|flower|bush|mushroom/.test(id)), things = dressing.filter(id => !/tree|palm|pine|rock|stone|grass|flower|bush|mushroom|cloud/.test(id));
  const dens = clamp(P.density, 0, 1);
  const inPlay = (x, z, pad = 0) => Math.abs(x) < W / 2 + pad && Math.abs(z) < D / 2 + pad;
  // the play island: trees on the hills and the rim band, rocks at the edge, small plants all over, things at the play area's edge
  const ring = (n, from, to, fn) => { for (let k = 0; k < n; k++) { const a = R() * Math.PI * 2, e = edgeOf(main, a), d = from(e) + R() * Math.max(0.5, to(e) - from(e)); fn(Math.cos(a) * d, Math.sin(a) * d); } };
  if (trees.length) ring(Math.round(6 + dens * 22), () => halfDiag * 0.85, e => e - 3.5, (x, z) => { if (!inPlay(x, z, 1)) put(pick(trees, layout.props.length), x, z, 0.8 + R() * 0.7); });
  if (rocks.length) ring(Math.round(4 + dens * 10), e => e - 4, e => e - 1.5, (x, z) => put(pick(rocks, layout.props.length), x, z, 0.7 + R() * 0.9));
  const nearEdge = (x, z) => Math.abs(Math.abs(x) - W / 2) < 1.2 || Math.abs(Math.abs(z) - D / 2) < 1.2;
  if (small.length) for (let k = 0; k < Math.round(10 + dens * 40); k++) { const x = (R() - 0.5) * (W + 14), z = (R() - 0.5) * (D + 14); if (islandOf(layout, x, z) === main && Math.hypot(x, z) > 4 && !nearEdge(x, z)) put(pick(small, k), x, z, 0.7 + R() * 0.6); }
  // things (crates, drums, flags, towers…) stand along the play area's edge, in twos and threes, as cover
  if (things.length) for (let k = 0; k < Math.round(2 + dens * 6); k++) {
    const side = k % 4, t = R() - 0.5, x = side < 2 ? t * W * 0.8 : (side === 2 ? -1 : 1) * (W / 2 - 1.5), z = side < 2 ? (side === 0 ? -1 : 1) * (D / 2 - 1.5) : t * D * 0.8;
    const id = pick(things, k);
    put(id, x, z, 1, Math.round(R() * 4) * 90);
    if (R() < 0.6) put(id, x + (R() - 0.5) * 2.4, z + (R() - 0.5) * 2.4, 0.9);
  }
  // the other islands: a few trees and rocks each, so they read as land with things on it
  for (const isl of islands.slice(1)) {
    const n = Math.round((1 + dens * 4) * (isl.shape.radius / 14));
    for (let k = 0; k < n; k++) {
      const a = R() * Math.PI * 2, d = R() * (edgeOf(isl, a) - 3), x = isl.at[0] + Math.cos(a) * d, z = isl.at[2] + Math.sin(a) * d;
      const id = trees.length && R() < 0.75 ? pick(trees, k) : rocks.length ? pick(rocks, k) : null;
      if (id) put(id, x, z, 1 + R() * 1.4);
    }
  }

  const { ground: _g, cliffs: _c, ...kept } = P;
  layout.params = kept;
  return layout;
}
