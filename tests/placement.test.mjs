// World placement (the gameplay layer, reach): the walk grid every world builds from its own colliders, where things
// may be put (world.place), what a seat can get to (world.reach) and why not, and the route a bot walks. No browser:
// Rapier in Node, a world made of boxes. The creator, 2026-10-14: "We were supposed to collect berries, but there were
// no berries anywhere. I think in the ocean I saw some boxes but those are impossible to get."
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { KIT_ROOT } from '../builder/lib/paths.mjs';
import { importLayer } from '../builder/tools/lib/kit-import.mjs';
import { VENDOR } from '../builder/tools/lib/paths.mjs';

const P = await importLayer(join(KIT_ROOT, 'worlds/placement.js'));
const R = (await import(pathToFileURL(join(VENDOR.rapier, 'rapier.mjs')).href)).default;
{ const w = console.warn; console.warn = () => {}; await R.init(); console.warn = w; }

/**
 * A 30 x 30 m world: a floor at y = 0 on the west half and a sea (floor at -2, water at 0) on the east; a pen of walls
 * 3 m high round (-8, -8); a box 0.9 m high (a jump up) at (-8, 6); a tower 4 m high at (-2, 8) (out of a jump); seats
 * at (-10, 0) and (-4, 0); invisible walls round it all (tagged bounds).
 */
function boxWorld() {
  const W = new R.World({ x: 0, y: -20, z: 0 }), body = W.createRigidBody(R.RigidBodyDesc.fixed());
  const box = (hx, hy, hz, x, y, z, tag = null) => { const c = W.createCollider(R.ColliderDesc.cuboid(hx, hy, hz).setTranslation(x, y, z), body); if (tag) c.__gf = { tag }; return c; };
  box(7.5, 0.5, 15, -7.5, -0.5, 0);          // land, west half: top at 0
  box(7.5, 0.5, 15, 7.5, -2.5, 0);           // sea bed, east half: top at -2
  for (const [x, z, hx, hz] of [[-8, -11, 3, 0.15], [-8, -5, 3, 0.15], [-11, -8, 0.15, 3], [-5, -8, 0.15, 3]]) box(hx, 1.5, hz, x, 1.5, z);   // the pen
  box(1, 0.45, 1, -8, 0.45, 6);              // a jump up
  box(1, 2, 1, -2, 2, 8);                    // too high
  for (const [x, z, hx, hz] of [[15.5, 0, 0.5, 16], [-15.5, 0, 0.5, 16], [0, 15.5, 16, 0.5], [0, -15.5, 16, 0.5]]) box(hx, 3, hz, x, 3, z, 'bounds');
  W.step();                                  // the colliders join the queries
  const bounds = { min: { x: -15, y: -3, z: -15 }, max: { x: 15, y: 6, z: 15 } };
  const world = { bounds, spawns: [{ x: -10, y: 0, z: 0 }, { x: -4, y: 0, z: 0 }], zone: name => (name === 'sea' ? { contains: p => p.x > 1 } : null) };
  P.placeOnColliders(world, { physics: W, RAPIER: R, config: {} }, { water: (x) => (x > 0 ? 0 : null) });
  return world;
}

test('the ground is the world\'s own: groundAt, waterAt and isWalkable read the colliders', () => {
  const w = boxWorld();
  assert.equal(w.groundAt(-10, 0), 0);
  assert.equal(w.groundAt(5, 0), -2, 'under the sea the ground is its bed');
  assert.equal(w.waterAt(5, 0), 0);
  assert.equal(w.waterAt(-5, 2), null);
  assert.ok(w.isWalkable(-10, 0));
  assert.ok(!w.isWalkable(5, 0), 'water is not walkable');
  assert.ok(Math.abs(w.groundAt(-8, 6) - 0.9) < 0.01, 'the box\'s top');
  assert.equal(w.groundAt(-8, 6, 0.2), 0, 'the ground under a point below the box\'s top is the floor');
  assert.ok(w.walk.ready());
  const s = w.walk.stats();
  assert.ok(s.nodes > 1000 && s.buildMs < 3000, JSON.stringify(s));
});

test('reach names what is wrong with a place: the sea, under the ground, walled off, floating, out of a jump', () => {
  const w = boxWorld();
  assert.equal(w.reach(0, { x: -12, y: 0, z: 10 }).ok, true);
  assert.equal(w.reach(0, { x: -8, y: 0.9, z: 6 }).ok, true, 'a box a jump high is reached');
  assert.equal(w.reach(0, { x: 6, y: 0, z: 3 }).why, 'in water', 'a berry at sea level over the sea');
  assert.equal(w.reach(0, { x: -12, y: -1.5, z: 10 }).why, 'under the ground');
  assert.equal(w.reach(0, { x: -8, y: 0, z: -8 }).why, 'walled off', 'inside the pen');
  assert.equal(w.reach(0, { x: -12, y: 6, z: 10 }).why, 'floating');
  assert.equal(w.reach(0, { x: -2, y: 4, z: 8 }).why, 'walled off', 'a tower top out of a jump');
  assert.equal(w.reach({ x: -10, y: 0, z: 0 }, { x: -4, y: 0, z: 0 }).ok, true, 'from a point');
});

test('place puts n points on dry ground every seat reaches, spread out, never in the pen, the sea or on a tower', () => {
  const w = boxWorld();
  let s = 7; const rng = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const pts = w.place('pickup', 12, { rng, clear: 0.6, gap: 1.2 });
  assert.equal(pts.length, 12);
  for (const p of pts) {
    assert.ok(p.x < 0, `on land: ${JSON.stringify(p)}`);
    assert.ok(!(Math.abs(p.x + 8) < 3.2 && Math.abs(p.z + 8) < 3.2), `not in the pen: ${JSON.stringify(p)}`);
    assert.ok(Math.abs(p.y) < 0.01 || Math.abs(p.y - 0.9) < 0.01, `on the floor or the low box: ${JSON.stringify(p)}`);
    assert.equal(w.reach(0, p).ok, true); assert.equal(w.reach(1, p).ok, true);
  }
  for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) assert.ok(Math.hypot(pts[i].x - pts[j].x, pts[i].z - pts[j].z) >= 1.2);
  // a zone with no reachable ground in it gives none, and says so
  const sea = w.place('pickup', 3, { zone: 'sea', rng });
  assert.equal(sea.length, 0); assert.match(sea.why, /no open ground/);
  // the same rng gives the same points (the host decides, but a replay is the same)
  s = 7; const again = w.place('pickup', 12, { rng, clear: 0.6, gap: 1.2 });
  assert.deepEqual(again, pts);
});

test('audit: each objective against every seat, with where and why', () => {
  const w = boxWorld();
  const r = w.walk.audit([{ kind: 'pickup', id: 'berry:0', x: -12, y: 0, z: 10 }, { kind: 'pickup', id: 'berry:1', x: 6, y: 0, z: 3 }, { kind: 'pickup', id: 'berry:2', x: -8, y: 0, z: -8 }]);
  assert.deepEqual(r.map(o => o.ok), [true, false, false]);
  assert.equal(r[1].why, 'in water'); assert.equal(r[1].ground, -2); assert.equal(r[1].water, 0);
  assert.equal(r[2].why, 'walled off'); assert.equal(r[2].from.length, 2);
  assert.deepEqual(w.walk.seats().map(s => s.ok), [true, true]);
});

test('route: the next point toward a goal goes round the pen, and says when to jump', () => {
  const w = boxWorld();
  // from west of the pen to east of it, along z = -8: the straight line is through the walls
  let at = { x: -13, y: 0, z: -8 }, steps = 0;
  while (Math.hypot(at.x + 3, at.z + 8) > 0.8 && steps < 200) { const n = w.route(at, { x: -3, y: 0, z: -8 }); if (!n) break; at = n; steps++; }
  assert.ok(Math.hypot(at.x + 3, at.z + 8) <= 0.8, `got there: ${JSON.stringify(at)} in ${steps}`);
  // onto the low box: the step on asks for a jump
  let jumped = false; at = { x: -12, y: 0, z: 6 };
  for (let i = 0; i < 40; i++) { const n = w.route(at, { x: -8, y: 0.9, z: 6 }); if (!n) break; if (n.jump) jumped = true; at = n; }
  assert.ok(jumped && Math.abs(at.y - 0.9) < 0.01, JSON.stringify(at));
  assert.equal(w.route({ x: -10, y: 0, z: 0 }, { x: -8, y: 0, z: -8 }), null, 'no way into the pen');
});

test('a changed world is sampled again where it changed', () => {
  const W = new R.World({ x: 0, y: -20, z: 0 }), body = W.createRigidBody(R.RigidBodyDesc.fixed());
  W.createCollider(R.ColliderDesc.cuboid(10, 0.5, 10).setTranslation(0, -0.5, 0), body);
  W.step();
  let v = 0;
  const world = { bounds: { min: { x: -10, y: -2, z: -10 }, max: { x: 10, y: 4, z: 10 } }, spawns: [{ x: 0, y: 0, z: 0 }], zone: () => null };
  P.placeOnColliders(world, { physics: W, RAPIER: R, config: {} }, { version: () => v });
  assert.equal(world.reach(0, { x: 5, y: 0, z: 5 }).ok, true);
  W.createCollider(R.ColliderDesc.cuboid(1, 1.5, 1).setTranslation(5, 1.5, 5), body); W.step();
  world.walk.invalidate([3, 3, 7, 7]);
  assert.equal(world.reach(0, { x: 5, y: 0, z: 5 }).why, 'under the ground', 'a block now stands there');
  v++;
  assert.equal(world.reach(0, { x: 5, y: 3, z: 5 }).why, 'walled off', 'its top is out of a jump');
});

test('the movement numbers and the jump are the reach model\'s and the flat part\'s', async () => {
  const reach = await importLayer(join(KIT_ROOT, 'worlds/reach.js'));
  const flat = await importLayer(join(KIT_ROOT, 'runtimes/three/profiles/flat-2d/tilemap.js'));
  for (const game of [{}, { controller: { jump: 9, speed: 4 }, gravity: 25 }]) {
    const a = P.movementOf(game), b = reach.movementOf(game);
    assert.deepEqual(a, b);
    const ja = P.jumpReach(a), jb = flat.jumpReach(a);
    assert.equal(ja.up, jb.up); for (const r of [-3, 0, 0.5]) assert.equal(ja.across(r), jb.across(r));
  }
  assert.equal(P.REACH_MARGIN, flat.REACH_MARGIN); assert.equal(reach.STEP, 0.45);
});

test('seats on ground that does not join (islands with no way across): things go on any seat\'s ground, and what some seat reaches is fair', () => {
  const W = new R.World({ x: 0, y: -20, z: 0 }), body = W.createRigidBody(R.RigidBodyDesc.fixed());
  W.createCollider(R.ColliderDesc.cuboid(5, 0.5, 5).setTranslation(-10, -0.5, 0), body);   // island A
  W.createCollider(R.ColliderDesc.cuboid(5, 0.5, 5).setTranslation(10, -0.5, 0), body);    // island B, 10 m of sea between
  W.step();
  const world = { bounds: { min: { x: -16, y: -3, z: -6 }, max: { x: 16, y: 4, z: 6 } }, spawns: [{ x: -10, y: 0, z: 0 }, { x: 10, y: 0, z: 0 }], zone: () => null };
  P.placeOnColliders(world, { physics: W, RAPIER: R, config: {} }, { water: () => -0.2 });
  assert.equal(world.walk.split(), true);
  let s = 3; const rng = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const pts = world.place('pickup', 8, { rng, gap: 1 });
  assert.equal(pts.length, 8);
  assert.ok(pts.some(p => p.x < 0) && pts.some(p => p.x > 0), 'on both islands');
  const r = world.walk.audit([{ kind: 'pickup', id: 'a', x: -8, y: 0, z: 0 }, { kind: 'pickup', id: 'sea', x: 0, y: 0, z: 0 }]);
  assert.deepEqual(r.map(o => o.ok), [true, false]);
  assert.equal(r[1].why, 'in water');
});

test('a corridor one body wide whose middle no column centre falls on is walkable, and its walls still hold', () => {
  const W = new R.World({ x: 0, y: -20, z: 0 }), body = W.createRigidBody(R.RigidBodyDesc.fixed());
  W.createCollider(R.ColliderDesc.cuboid(6, 0.5, 6).setTranslation(0, -0.5, 0), body);
  W.createCollider(R.ColliderDesc.cuboid(0.1, 1.5, 4).setTranslation(-0.5, 1.5, 0), body);   // inner faces at x = ±0.4
  W.createCollider(R.ColliderDesc.cuboid(0.1, 1.5, 4).setTranslation(0.5, 1.5, 0), body);
  W.step();
  const world = { bounds: { min: { x: -5, y: -2, z: -5 }, max: { x: 5, y: 4, z: 5 } }, spawns: [{ x: 0, y: 0, z: -3 }], zone: () => null };
  P.placeOnColliders(world, { physics: W, RAPIER: R, config: {} });
  assert.equal(world.walk.seats()[0].ok, true, 'the seat in the corridor stands');
  assert.equal(world.reach(0, { x: 0, y: 0, z: 3 }).ok, true, 'along the corridor');
  assert.equal(world.reach(0, { x: 2, y: 0, z: 4.6 }).ok, true, 'out of its end and round');
  // a seat outside cannot cut through a wall into it: the corridor is reached only by its ends
  let at = { x: -2, y: 0, z: 0 }, through = false;
  for (let i = 0; i < 40; i++) { const nx = world.route(at, { x: 0, y: 0, z: 0 }); if (!nx) break; if (Math.abs(nx.z) < 3.6 && Math.abs(nx.x) < 0.45 && Math.abs(at.x) > 0.6) through = true; at = nx; }
  assert.equal(through, false, 'the route goes round by an end, never through a wall');
});

test('place from a body: only the places it can get to from where it stands', () => {
  const W = new R.World({ x: 0, y: -20, z: 0 }), body = W.createRigidBody(R.RigidBodyDesc.fixed());
  W.createCollider(R.ColliderDesc.cuboid(5, 0.5, 5).setTranslation(-10, -0.5, 0), body);
  W.createCollider(R.ColliderDesc.cuboid(5, 0.5, 5).setTranslation(10, -0.5, 0), body);
  W.step();
  const world = { bounds: { min: { x: -16, y: -3, z: -6 }, max: { x: 16, y: 4, z: 6 } }, spawns: [{ x: -10, y: 0, z: 0 }, { x: 10, y: 0, z: 0 }], zone: () => null };
  P.placeOnColliders(world, { physics: W, RAPIER: R, config: {} }, { water: () => -0.2 });
  let s = 5; const rng = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 6; i++) { const q = world.place('wander', 1, { rng, away: 0, from: { x: 9, y: 0.8, z: 1 } })[0]; assert.ok(q.x > 4, JSON.stringify(q)); }
});
