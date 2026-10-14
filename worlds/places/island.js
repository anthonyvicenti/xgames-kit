// The places vocabulary's words for an island level (open builder wave 10, track H): the scenic-3d profile's island, isles
// and ruins (research/gf-scenic/kit/world/recipes.js) lay out each level with these, in the order its old code drew
// its random numbers. Pure: no three.js, no DOM.
//
//   ground      island (a superellipse with a seeded wobble, and the play box that fits inside its walkable rim)
//   features    plaza (a rounded square in the middle), portal (toward the next level), paths (from the rim behind into
//               the plaza, and on to the portal), spawn-line (a line across the back, facing on), arena-zones (arena,
//               portal, plaza), water (a spring pond in a side band and a stream that falls off the edge)
//   structures  islets, floaters (what hangs round a floating island)
// Spots: corners (of the plaza), round (random angles round it), along (beside the paths), flip (one side drawn at
// random), beside (either side of a zone). Tests: sdf, plaza, path, water, spawn, box, runes. Drawer: disc (random
// points in the level's circle, the first that passes).
// The level being laid out is P.level ({id, at, radius, last}); P.next is where the next level is (or null), P.index
// its number; P.vars.depth how deep its rock goes; P.out.void whether it floats.
import { val, r2, clamp } from './values.js';
import { padOf, passes } from './dress.js';
import { outlineRadius, islandSdf, roundRectSdf, polylineDistance, walkRadius, playHalf } from './shapes.js';

export const ISLAND_TESTS = {
  sdf(P, [, a, b], x, z) { const d = islandSdf(P.level, x, z); return a === '<' ? d < padOf(P, b) : d > padOf(P, b); },
  plaza(P, [, a], x, z) { return !(roundRectSdf(P.level.plaza, x, z) < padOf(P, a)); },
  path(P, [, a], x, z) { return !P.level.paths.some(p => polylineDistance(p.points, x, z) < p.width / 2 + padOf(P, a)); },
  water(P, [, a], x, z) { const m = padOf(P, a); return !P.level.water.some(w => Math.hypot(x - w.pond.at[0], z - w.pond.at[1]) < w.pond.radius + m || polylineDistance(w.stream.points, x, z) < w.stream.width / 2 + m); },
  spawn(P, [, a], x, z) { const L = P.level, m = padOf(P, a); return !(L.spawns.some(s => Math.hypot(s[0] - x, s[2] - z) < m) || Math.hypot(L.zones.portal.at[0] - x, L.zones.portal.at[2] - z) < m + 1.5); },
  box(P, [, a, b], x, z) { const L = P.level, m = padOf(P, a), [cx, , cz] = L.at, h = L.half; const inside = Math.abs(x - cx) < h - m && Math.abs(z - cz) < h - m; return b === 'out' ? !inside : inside; },
  runes(P) { return !!P.out.runes; },   // the look carries glowing rune lines
};

export const ISLAND_SPOTS = {
  /** The plaza's corners, `out` from its middle, in the order given. */
  corners(P, s) { const [cx, , cz] = P.level.at, e = val(P, s.corners.out); return s.corners.order.map(([sx, sz]) => ({ x: cx + sx * e, z: cz + sz * e })); },
  /** Random angles round the plaza's middle, at a distance (drawn now, in order). */
  round(P, s) { const [cx, , cz] = P.level.at, r = val(P, s.round.out); return Array.from({ length: s.round.count }, () => { const a = P.R() * Math.PI * 2; return { x: cx + Math.cos(a) * r, z: cz + Math.sin(a) * r, a }; }); },
  /** Beside every path, at fractions of its length, a step out from its side. */
  along(P, s) {
    const out = [];
    for (const p of P.level.paths) {
      const [a, b] = [p.points[0], p.points.at(-1)], len = Math.hypot(b[0] - a[0], b[1] - a[1]), nx = -(b[1] - a[1]) / (len || 1), nz = (b[0] - a[0]) / (len || 1);
      for (let t = s.along.from; t < s.along.to; t += s.along.every) out.push({ x: a[0] + (b[0] - a[0]) * t + nx * (p.width / 2 + s.along.out), z: a[1] + (b[1] - a[1]) * t + nz * (p.width / 2 + s.along.out) });
    }
    return out;
  },
  /** One spot off the middle, on a side drawn at random: (sign * x, -sign * z). */
  flip(P, s) { const [cx, , cz] = P.level.at, sg = P.R() < 0.5 ? 1 : -1; return [{ x: cx + sg * val(P, s.flip.x), z: cz - sg * val(P, s.flip.z) }]; },
  /** Either side of a zone, across the line from the level's middle to it. */
  beside(P, s) {
    const L = P.level, z0 = L.zones[s.beside.zone].at, [cx, , cz] = L.at, dx = z0[0] - cx, dz = z0[2] - cz, d = Math.hypot(dx, dz) || 1, sx = -dz / d, sz = dx / d;
    return s.beside.sides.map(k => ({ x: z0[0] + sx * k * s.beside.out, z: z0[2] + sz * k * s.beside.out, side: k }));
  },
};

export const ISLAND_DRAWS = {
  /** Random points in the level's circle: the first of `tries` that passes the tests. */
  disc(P, tests, tries = 60) {
    const L = P.level, [cx, , cz] = L.at;
    for (let k = 0; k < tries; k++) { const a = P.R() * Math.PI * 2, d = Math.sqrt(P.R()) * L.radius; const x = cx + Math.cos(a) * d, z = cz + Math.sin(a) * d; if (passes(P, tests, x, z)) return [x, z]; }
    return null;
  },
};

const DIAG = [Math.SQRT1_2, Math.SQRT1_2];   // the follow camera looks along +x+z: "up the screen"

export const ISLAND_STEPS = {
  /** The level's island: a superellipse (`n`) with `wobble` seeded waves; the play box inside its walkable rim. */
  island(P, s) {
    const L = P.level, R = L.radius;
    const wobble = Array.from({ length: s.wobble }, (_, k) => [2 + k * 2 + Math.floor(P.R() * 2), r2((0.025 + P.R() * 0.03) / (1 + k * 0.5)), r2(P.R() * 6.28)]);
    Object.assign(L, { shape: { radius: R, n: s.n, rot: 0, wobble }, rimInset: s.rimInset });
    L.half = r2(playHalf(L));
    P.vars.half = L.half;
    // which way is on (toward the next level, else up the screen) and back (where everyone arrives)
    let on = DIAG;
    if (P.next) { const dx = P.next[0] - L.at[0], dz = P.next[2] - L.at[2], d = Math.hypot(dx, dz) || 1; on = [dx / d, dz / d]; }
    P.dir = { on, back: [-on[0], -on[1]], side: [-on[1], on[0]] };
  },
  plaza(P, s) {
    const L = P.level, [cx, , cz] = L.at, h = r2(val(P, s.half));
    P.vars.plazaHalf = h;
    L.plaza = { at: [cx, cz], half: [h, h], corner: r2(val(P, s.corner)) };
  },
  portal(P, s) {
    const L = P.level, [cx, , cz] = L.at, d = val(P, s.distance), on = P.dir.on;
    P.portal = [r2(cx + on[0] * d), 0, r2(cz + on[1] * d)];
  },
  /** Paths: `rim-back` (the rim behind, where everyone arrives), `plaza-back`, `plaza-on`, `portal`. */
  paths(P, s) {
    const L = P.level, [cx, , cz] = L.at, { back, on } = P.dir, ph = P.vars.plazaHalf;
    const wr = walkRadius(L, Math.atan2(back[1], back[0]));
    const end = w => (w === 'rim-back' ? [r2(cx + back[0] * (wr + 0.6)), r2(cz + back[1] * (wr + 0.6))] : w === 'plaza-back' ? [r2(cx + back[0] * ph * 0.6), r2(cz + back[1] * ph * 0.6)] : w === 'plaza-on' ? [r2(cx + on[0] * ph * 0.6), r2(cz + on[1] * ph * 0.6)] : w === 'portal' ? [P.portal[0], P.portal[2]] : w);
    L.paths = s.list.map(p => ({ width: p.width, points: [end(p.from), end(p.to)] }));
  },
  /** One spawn a player, in a line across the back of the level, `spacing` apart, `distance` behind the middle. */
  'spawn-line'(P, s) {
    const L = P.level, [cx, , cz] = L.at, d = val(P, s.distance), { back, side } = P.dir, n0 = P.players;
    L.spawns = Array.from({ length: n0 }, (_, k) => { const t = (k - (n0 - 1) / 2) * s.spacing; return [r2(cx + back[0] * d + side[0] * t), 0, r2(cz + back[1] * d + side[1] * t)]; });
  },
  /** The level's zones: its arena (radius), its portal (radius) and its plaza (the stone square). */
  'arena-zones'(P, s) {
    const L = P.level, [cx, , cz] = L.at, ph = P.vars.plazaHalf;
    L.zones = {
      arena: { shape: 'circle', at: [cx, 0, cz], size: [r2(val(P, s.arena))] },
      portal: { shape: 'circle', at: P.portal, size: [s.portal] },
      plaza: { shape: 'box', at: [cx, 0, cz], size: [ph * 2, 1, ph * 2] },
    };
  },
  /** A spring pond in a side band and a stream from it that turns toward the camera's side and falls off the edge.
   *  `when: "even-levels"`: only on the first, third, ... level (the others get their rock and no water). */
  water(P, s) {
    const L = P.level, [cx, , cz] = L.at, { side, back } = P.dir, half = L.half, R = P.R;
    L.water = []; L.falls = [];
    if (s.when === 'even-levels' && P.index % 2 !== 0) { L.cliff = { depth: P.vars.depth, kind: P.out.void ? 'float' : 'shore' }; return; }
    const sgn = R() < 0.5 ? 1 : -1;
    const a = Math.atan2(side[1] * sgn, side[0] * sgn) + (R() - 0.5) * 0.5;
    const edge = outlineRadius(L.shape, a);
    const pondR = clamp((edge - half) * 0.45, 1.6, 3.2);
    const pondD = Math.max(half + pondR * 0.4, edge - pondR - 2.4);
    const pond = [r2(cx + Math.cos(a) * pondD), r2(cz + Math.sin(a) * pondD)];
    // the stream turns toward the camera's side of the island, so its waterfall faces the follow camera
    const back0 = Math.atan2(back[1], back[0]), toBack = Math.atan2(Math.sin(back0 - a), Math.cos(back0 - a));
    const b = a + Math.sign(toBack) * (0.55 + R() * 0.25);
    const lip = outlineRadius(L.shape, b);
    const mid = [r2(cx + Math.cos((a + b) / 2) * (pondD + lip) / 2 + (R() - 0.5)), r2(cz + Math.sin((a + b) / 2) * (pondD + lip) / 2 + (R() - 0.5))];
    const out = [r2(cx + Math.cos(b) * (lip + 1.5)), r2(cz + Math.sin(b) * (lip + 1.5))];
    L.water.push({ pond: { at: pond, radius: r2(pondR) }, stream: { width: 2.3, points: [pond, mid, out] } });
    if (P.out.void) L.falls.push({ at: [r2(cx + Math.cos(b) * (lip - 0.15)), -0.12, r2(cz + Math.sin(b) * (lip - 0.15))], angle: r2(b), width: 3.4, drop: r2(P.vars.depth * 0.95 + 6) });
    L.cliff = { depth: P.vars.depth, kind: P.out.void ? 'float' : 'shore' };
  },
  /** Small floating islands round a floating level, some with a tree or a crystal: count[0] + up to count[1] more. */
  islets(P, s) {
    const L = P.level, [cx, , cz] = L.at, R = P.R;
    const nI = s.count[0] + Math.floor(R() * s.count[1]);
    for (let k = 0; k < nI; k++) {
      const a = (k / nI) * Math.PI * 2 + R() * 0.8, d = outlineRadius(L.shape, a) + 5 + R() * 9;
      const r = r2(1.2 + R() * 2.2), y = r2(-3 + R() * 6);
      const isl = { at: [r2(cx + Math.cos(a) * d), y, r2(cz + Math.sin(a) * d)], radius: r, depth: r2(r * (2.4 + R() * 1.6)), seed: Math.floor(R() * 1e6), level: L.id };
      const what = R();
      if (what < 0.35) isl.crystal = R() < 0.5 ? 'crystal' : 'rune';
      else if (what < 0.7 && r > 1.8) isl.tree = R() < 0.5 ? 'pine' : 'oak';
      P.out.islets.push(isl);
    }
  },
  /** Loose rocks hanging under and round a floating level. */
  floaters(P, s) {
    const L = P.level, [cx, , cz] = L.at, R = P.R, depth = P.vars.depth;
    for (let k = 0; k < s.count; k++) {
      const a = R() * Math.PI * 2, d = outlineRadius(L.shape, a) * (0.2 + R() * 1.1);
      P.out.floaters.push({ at: [r2(cx + Math.cos(a) * d), r2(-depth * (0.4 + R() * 0.9)), r2(cz + Math.sin(a) * d)], scale: r2(0.4 + R() * 1.1), rot: Math.round(R() * 360), level: L.id });
    }
  },
};
