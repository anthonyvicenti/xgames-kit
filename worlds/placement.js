// World placement (the gameplay layer, reach): one API every world implements, so nothing that puts a thing in play
// assumes a flat floor at y = 0 or the old yard's bounds. The creator, 2026-10-14: "We were supposed to collect berries,
// but there were no berries anywhere. I think in the ocean I saw some boxes but those are impossible to get." (the
// pickup mechanic put its spots at y = 0, which on island terrain is sea level).
//
//   attachPlacement(world, source)   gives a world the API below, built from `source` (each world says where its ground,
//                                    water and seats are; rapierSource() reads any world built on Rapier colliders)
//   world.groundAt(x, z, below?)     the top of the ground at (x, z): the highest surface a body could stand on at or
//                                    under `below` (+ a step), or null where there is none (the void, past the edge).
//                                    Under water it is the bed; waterAt says where the surface is
//   world.waterAt(x, z)              the water's surface over (x, z), or null where there is none
//   world.isWalkable(x, z, y?)       a body can stand there: ground under it, not under water (unless the game swims),
//                                    room for the whole body, a slope it can stand on
//   world.reach(from, to, opts)      → {ok, why, at, ground, water}: can a body get from `from` (a point, or a seat's
//                                    index) to within opts.radius (1 m) of `to` by walking, stepping, dropping and
//                                    jumping? why: 'outside the world' | 'over the void' | 'in water' | 'under the ground'
//                                    | 'floating' | 'inside something solid' | 'walled off' | 'the start has no ground'
//   world.place(kind, n, opts)       → [{x, y, z}]: n points on dry ground every seat reaches, clear of colliders and
//                                    cliff edges, spread out (and away from the seats). opts: {zone (a world zone's name
//                                    or {at, r} / {at, size}), clear (metres of open ground round each; 0.6), gap
//                                    (metres between them), away (from the seats; 1.5), rng, near ({at, r}),
//                                    exclude ([{x, z, r}]), prefer ({x, z}: the nearest places to it first, in order),
//                                    from ({x, y, z}: places a body standing there gets to, in place of the seats')}. y is where a body's feet are. Fewer than n when the ground
//                                    has no more room (never an unreachable point instead)
//   world.route(from, to)            → the next point to walk to on the way to `to` ({x, y, z, jump?}), or null when
//                                    `to` is straight ahead or there is no way (bots and enemies steer by it)
//   world.walk                       the walk grid: {stats(), ready(), invalidate(box?), relink(), seats(), audit(list),
//                                    regions({things, rims, backdrop})} (walk.mjs; regions: the ground the seats cannot get to
//                                    and the traps they cannot leave, connect.mjs joins them)
//
// The model: a grid of columns (0.5 m, coarser on a big world); each column holds the surfaces facing up that a body
// fits on (its whole height free above, nothing solid within its radius). Walking joins a column's surface to a
// neighbour's highest one at most a step up (or a ramp's rise), or any way down; a jump joins an edge (a place next to a
// drop or a wall) to one up to the jump's rise and across(rise) away with the arc clear. It takes REACH_MARGIN (82%) of
// the jump the physics gives, as reach.js and the flat part do. Water is not walkable unless the movement numbers say
// the body swims. Links (a launch pad's throw: pads.js) join places as a jump does. Not modelled: moving pieces, doors
// that open, the space under an overhang within one collider (a ray meets each collider once).
// (no import of reach.js or the flat part's tilemap.js: a 3D game does not carry gf/three/flat; their numbers are the
// same, tests/placement.test.mjs holds them equal)
import { physicsOf } from '../core/util.js';
import { CAPSULE_DEFAULTS } from '../controller/capsule.mjs';
import { createWalk, jumpReach, REACH_MARGIN, hyp, cellFor, boxSurfaces, NUDGES, PROBES } from './walk.mjs';
import { joinWithPads } from './pads.js';
import { reachConfig } from './connect.mjs';
export { createWalk, jumpReach, REACH_MARGIN, hyp, cellFor, boxSurfaces };

/** config/game.json → the movement numbers, as worlds/reach.js movementOf (step: the highest ledge walked onto). */
export function movementOf(game = {}) {
  const C = CAPSULE_DEFAULTS, c = game?.controller ?? {};
  const body = 2 * C.capsule.halfHeight + 2 * C.capsule.radius + C.capsule.floatHeight;
  return { speed: c.speed ?? C.move.runSpeed, jump: c.jump ?? C.jump.velocity, gravity: game?.gravity ?? 20, fallScale: C.jump.fallingGravityScale, radius: C.capsule.radius, body: +body.toFixed(3), step: 0.45, slopeMaxDeg: C.move.slopeMaxDeg };
}


/**
 * A source over Rapier: the surfaces in a column are where a ray down meets a collider's face turned up; a body fits on
 * one when a cylinder its size, a step up from it, meets nothing solid. opts: {
 *   RAPIER, physics (the Rapier World), numbers, top, bottom (the column's heights to look between),
 *   solid(c) → is it in the way (default: on a fixed body), stand(c) → can it be stood on (default: solid and not the
 *   invisible walls round the play area), pass(c) → a one-way ledge (a body jumps up through it) }
 */
/** Collider tags that are things standing on the ground, not the ground (colliders.js tags; flat-2d's walls). */
const THING = /^(prop:|tree:|wall$|pillar$|crystal$)/;

export function rapierSurfaces({ RAPIER, physics, numbers = {}, top = 60, bottom = -40, solid = null, stand = null, pass = null }) {
  const n = { step: 0.45, body: 1.6, radius: 0.3, ...numbers };
  const isFixed = c => { const b = c.parent?.(); return !b || b.isFixed(); };
  const S = solid ?? isFixed, P = pass ?? (() => false);
  const ST = stand ?? (c => S(c) && c.__gf?.tag !== 'bounds');
  const half = Math.max(0.05, (n.body - n.step) / 2 - 0.03);
  const cyl = new RAPIER.Cylinder(half, Math.max(0.1, n.radius * 0.9)), disc = new RAPIER.Cylinder(0.05, Math.max(0.1, n.radius * 0.9)), rot = { x: 0, y: 0, z: 0, w: 1 };
  const blocks = c => S(c) && !P(c);
  const sample = (x, z) => {
    const hits = [];
    const t = typeof top === 'function' ? top(x, z) : top, b = typeof bottom === 'function' ? bottom(x, z) : bottom;
    physics.intersectionsWithRay(new RAPIER.Ray({ x, y: t, z }, { x: 0, y: -1, z: 0 }), t - b, true, h => {
      if (h.normal.y > 0.2 && ST(h.collider)) hits.push({ y: t - h.timeOfImpact, ny: h.normal.y, pass: P(h.collider), thing: THING.test(h.collider.__gf?.tag ?? '') });
      return true;
    }, undefined, undefined, undefined, undefined, c => S(c) || P(c));
    for (const s of hits) {
      const at = (dx, dz) => !physics.intersectionWithShape({ x: x + dx, y: s.y + n.step + half + 0.03, z: z + dz }, rot, cyl, undefined, undefined, undefined, undefined, blocks);
      s.fits = at(0, 0);
      // off the column's middle: a body fits in a corridor one tile wide whose middle no column centre falls on
      if (!s.fits && NUDGES.some(([dx, dz]) => at(dx, dz))) { s.fits = true; s.nudged = true; }
      // something pokes up beside it (a wall, perhaps thinner than a column): how high, so a jump's arc must clear it
      // (none of the probes meets it: a thin thing the body still meets, so a jump is not taken over it)
      if (!s.fits || s.nudged) { s.block = s.y + n.body + 0.3; let hit = false; for (const h of PROBES) if (physics.intersectionWithShape({ x, y: s.y + h, z }, rot, disc, undefined, undefined, undefined, undefined, blocks)) { s.block = s.y + h + 0.3; hit = true; } if (hit) s.block = Math.max(s.block, s.y + 1.0); }
    }
    return hits;
  };
  // the straight step between two places is clear of anything solid, at the knees and at the chest (both ways)
  const ray = (a, b) => { const d = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z }, len = Math.hypot(d.x, d.y, d.z); if (len < 1e-3) return true; d.x /= len; d.y /= len; d.z /= len; return !physics.castRay(new RAPIER.Ray(a, d), len, true, undefined, undefined, undefined, undefined, blocks); };
  const ball = new RAPIER.Ball(0.15);
  // open air: nothing within a ball, and not inside a mesh's volume (a ray up from inside one meets a face turned up)
  const up = { x: 0, y: 1, z: 0 };
  sample.open = (x, y, z) => {
    if (physics.intersectionWithShape({ x, y, z }, rot, ball, undefined, undefined, undefined, undefined, blocks)) return false;
    const h = physics.castRayAndGetNormal(new RAPIER.Ray({ x, y, z }, up), 40, false, undefined, undefined, undefined, undefined, blocks);
    return !(h && h.normal.y > 0.2);
  };
  // something over a place within 12 m (a cave's roof, the rock of a hill over a hollow): a region under it is covered
  sample.roof = (x, y, z) => !!physics.castRay(new RAPIER.Ray({ x, y: y + 0.3, z }, up), 12, false, undefined, undefined, undefined, undefined, blocks);
  sample.clear = (xa, ya, za, xb, yb, zb) => [n.step + 0.1, n.body * 0.7].every(h => ray({ x: xa, y: ya + h, z: za }, { x: xb, y: yb + h, z: zb }) && ray({ x: xb, y: yb + h, z: zb }, { x: xa, y: ya + h, z: za }));
  return sample;
}

/**
 * Give a world the placement API (see the head of this file). src: {surfaces, area?, water?, seats?, version?, numbers,
 * cell?}; area defaults to the world's bounds, seats to world.spawns, zones to world.zone. → the world
 */
export function attachPlacement(world, src) {
  // the links the walk knows: the world's own (a terrain's pads) and the pads joined as it plays (pads.js joinWithPads)
  const extra = [];
  const walk = createWalk({
    area: () => { const b = world.bounds; return [b.min.x, b.min.z, b.max.x, b.max.z]; },
    seats: () => world.spawns ?? [],
    zone: name => world.zone?.(name) ?? null,
    ...src,
    links: () => [...(src.links?.() ?? []), ...extra],
  });
  // the first time the grid is ready (the colliders are in the physics' queries), what the world's own connectors left
  // out of reach is joined with launch pads, before any part places a thing (they all ask ready() first)
  const ready = walk.walk.ready;
  let joined = !src.ctx;
  walk.walk.ready = () => {
    const ok = ready();
    if (ok && !joined) {
      joined = true;
      try {
        const j = joinWithPads(world, src.ctx, walk, extra, { reach: world.layout?.reach ?? {}, kinds: src.kinds ?? ['pad'] });
        world.joined = j ? { made: j.list.length, left: j.left?.length ?? 0, tries: j.tries ?? [] } : { made: 0, skipped: true };
        if (j?.list?.length) {
          const C = world.connectors ??= { list: [], kept: [], left: [], apart: reachConfig(world.layout?.reach).apart, backdrop: [] };
          C.list = [...(C.list ?? []), ...j.list]; C.left = j.left; C.kept = j.kept;
          const up = world.update;
          world.update = dt => { up?.(dt); j.pads.update(dt); };
          const obs = C.pads; C.pads = () => [...(obs?.() ?? []), ...j.pads.observe()];
        }
      } catch (e) { console.warn(`gf-three placement: joining the world's areas with pads failed: ${e.message}`); }
    }
    return ok;
  };
  // a world whose parts never ask (nothing placed by the grid): asked on its first frames, until the grid is ready
  if (!joined) { const up0 = world.update?.bind(world); world.update = dt => { up0?.(dt); if (!joined) walk.walk.ready(); }; }
  world.groundAt = walk.groundAt;
  world.waterAt = walk.waterAt;
  world.isWalkable = walk.isWalkable;
  world.reach = walk.reach;
  world.place = walk.place;
  world.route = walk.route;
  world.walk = walk.walk;
  // a world with rooms routes through its doors (layout.js createRouter); every other world routes over the walk grid
  const doors = world.via;
  world.via = (from, to) => doors?.(from, to) ?? walk.route(from, to);
  return world;
}

/**
 * The usual case: a world built on Rapier colliders (party, terrain, voxel, scenic, flat seen from above, the stand-in).
 * The movement numbers are the game's (config/game.json controller, gravity; controller.swim lets bodies cross water).
 * hints: {water(x, z), version(), seats(), pass(c), stand(c), solid(c), top, bottom, cell, area(), numbers (over the
 * game's)}. → the world (unchanged when it
 * has no physics: a bench outside a game)
 */
export function placeOnColliders(world, ctx, hints = {}) {
  const { RAPIER, world: physics } = physicsOf(ctx);
  if (!RAPIER || !physics) return world;
  const numbers = { ...movementOf(ctx.config ?? {}), swim: !!ctx.config?.controller?.swim, ...(hints.numbers ?? {}) };
  const b = world.bounds;
  const surfaces = rapierSurfaces({ RAPIER, physics, numbers, top: hints.top ?? (b ? b.max.y + 40 : 60), bottom: hints.bottom ?? (b ? b.min.y - 30 : -40), solid: hints.solid, stand: hints.stand, pass: hints.pass });
  // the seats in play: as many as the game seats players (config/game.json players.max), from the world's spawns
  const max = ctx.config?.players?.max ?? 0, seatsOf = hints.seats ?? (() => world.spawns ?? []);
  const pick = ['water', 'version', 'area', 'cell', 'links'].filter(k => hints[k] != null);
  return attachPlacement(world, { surfaces, clear: surfaces.clear, open: surfaces.open, roof: surfaces.roof, numbers, ctx, seats: () => { const l = seatsOf(); return max > 0 ? l.slice(0, max) : l; }, ...Object.fromEntries(pick.map(k => [k, hints[k]])) });
}
