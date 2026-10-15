// The knockback mechanic's pure parts (components/knockback/logic.js): a blast's push (falloff, upward tip, mass), a
// body's whole flight (bounces, rest, the sea, out of bounds), the path read back at any moment the same everywhere, the
// bodies a flying body knocks on its way, and a path packed for the wire.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { radialImpulse, falloffAt, simulateFlight, sampleFlight, chainHits, packKeys, unpackKeys, MAX_SPEED } from '../components/knockback/logic.js';

// the world for these tests: flat ground at y = 0 over x < 20 (a cliff edge), the sea at y = -1 past it
const ground = (a, b, r) => {
  const over = p => p.x < 20;
  if (!over(b) && !over(a)) return null;
  const ya = a.y - r, yb = b.y - r;
  if (yb >= 0 || ya < 0) return null;
  return { t: ya / (ya - yb), normal: [0, 1, 0] };
};

test('a blast pushes away from its centre, tipped up, less toward the edge and for a heavier body', () => {
  const at = { x: 0, y: 0, z: 0 };
  const near = radialImpulse(at, { x: 1, y: 0.5, z: 0 }, { radius: 4, force: 14, up: 0.6 });
  const far = radialImpulse(at, { x: 3, y: 0.5, z: 0 }, { radius: 4, force: 14, up: 0.6 });
  assert.ok(near.x > 0 && near.y > 0 && Math.abs(near.z) < 1e-9, 'away from the blast and up');
  assert.ok(Math.hypot(near.x, near.y) > Math.hypot(far.x, far.y), 'stronger near the centre');
  const heavy = radialImpulse(at, { x: 1, y: 0.5, z: 0 }, { radius: 4, force: 14, up: 0.6, mass: 2 });
  assert.ok(Math.abs(Math.hypot(heavy.x, heavy.y) * 2 - Math.hypot(near.x, near.y)) < 1e-6, 'twice the mass, half the speed');
  assert.equal(radialImpulse(at, { x: 5, y: 0, z: 0 }, { radius: 4 }), null, 'outside the radius: nothing');
  const under = radialImpulse(at, { x: 0, y: -0.5, z: 0.5 }, { radius: 4, up: 0.2 });
  assert.ok(under.y > 0, 'a blast above a body still throws it up, never into the ground');
  const centre = radialImpulse(at, { x: 0, y: 0.05, z: 0 }, { radius: 4, force: 100 });
  assert.ok(Math.hypot(centre.x, centre.y, centre.z) <= MAX_SPEED + 1e-6, 'capped');
  assert.equal(falloffAt(0.5, 'linear'), 0.5);
  assert.equal(falloffAt(0.5, 'flat'), 1);
  assert.ok(falloffAt(0.25, 'smooth') < 0.25 && falloffAt(0.75, 'smooth') > 0.75);
});

test('a flight arcs, lands, bounces lower each time, rests, and its path is the same every time', () => {
  const f = simulateFlight({ x: 0, y: 0, z: 0 }, { x: 3, y: 9, z: 0 }, { radius: 0.4, gravity: 18, hit: ground });
  assert.equal(f.into, 'rest');
  const bounces = f.events.filter(e => e.kind === 'land' || e.kind === 'bounce');
  assert.ok(bounces.length >= 2, `it bounces (${bounces.length})`);
  assert.equal(bounces[0].kind, 'land');
  for (let i = 1; i < bounces.length; i++) assert.ok(bounces[i].speed < bounces[i - 1].speed, 'each bounce softer than the last');
  const top = Math.max(...f.keys.map(k => k[2]));
  assert.ok(top > 1.8 && top < 2.6, `peak ${top} m (9 m/s up under 18 m/s²: about 2.25 m)`);
  assert.ok(f.end.x > 2 && Math.abs(f.end.y) < 0.05, 'rests on the ground, downrange');
  assert.ok(f.landSpeed > 8, 'the hardest hit is the first landing');
  assert.deepEqual(simulateFlight({ x: 0, y: 0, z: 0 }, { x: 3, y: 9, z: 0 }, { radius: 0.4, gravity: 18, hit: ground }), f, 'deterministic');
  // read back: the start, a moment between keys (on the arc), the end
  const s0 = sampleFlight(f.keys, 0), mid = sampleFlight(f.keys, 0.31), end = sampleFlight(f.keys, f.duration + 1);
  assert.ok(Math.abs(s0.x) < 1e-9 && Math.abs(s0.y) < 1e-9);
  assert.ok(mid.y > 1 && mid.vx > 0, 'between keys it is up in the air, moving downrange');
  assert.ok(end.done && Math.abs(end.x - f.end.x) < 0.02);
});

test('thrown off the cliff: it splashes into the sea and the flight ends there; far away: out', () => {
  const f = simulateFlight({ x: 17, y: 0, z: 0 }, { x: 9, y: 7, z: 0 }, { radius: 0.4, gravity: 18, sea: -1, hit: ground });
  assert.equal(f.into, 'water');
  const w = f.events.find(e => e.kind === 'water');
  assert.ok(w && w.at.x > 20, 'the splash is past the cliff edge');
  assert.ok(f.end.y < -1.3, 'it sinks under the sea');
  const out = simulateFlight({ x: 17, y: 0, z: 0 }, { x: 9, y: 7, z: 0 }, { radius: 0.4, gravity: 18, sea: null, floor: -10, hit: ground });
  assert.equal(out.into, 'out');
});

test('a flying body knocks the bodies it passes, in the order it reaches them; a slow one knocks nobody', () => {
  const f = simulateFlight({ x: 0, y: 0, z: 0 }, { x: 12, y: 3, z: 0 }, { radius: 0.4, gravity: 18, hit: ground });
  const hits = chainHits(f, [{ id: 'far', x: 6, y: 0, z: 0, radius: 0.4 }, { id: 'near', x: 2.5, y: 0, z: 0, radius: 0.4 }, { id: 'aside', x: 3, y: 0, z: 5, radius: 0.4 }], { radius: 0.4, minSpeed: 5 });
  assert.deepEqual(hits.map(h => h.id), ['near', 'far'].filter(id => hits.some(h => h.id === id)));
  assert.ok(hits.length >= 1 && hits[0].id === 'near' && hits[0].v.x > 0 && hits[0].v.y > 0);
  assert.ok(!hits.some(h => h.id === 'aside'), 'one off to the side is not knocked');
  const slow = simulateFlight({ x: 0, y: 0, z: 0 }, { x: 2, y: 2, z: 0 }, { radius: 0.4, gravity: 18, hit: ground });
  assert.deepEqual(chainHits(slow, [{ id: 'near', x: 1, y: 0, z: 0, radius: 0.4 }], { radius: 0.4, minSpeed: 5 }), []);
});

test('a path on the wire comes back within a centimetre; a bad one is refused', () => {
  const f = simulateFlight({ x: 1.234, y: 0, z: -5.5 }, { x: 4, y: 8, z: 2 }, { radius: 0.4, gravity: 18, hit: ground });
  const back = unpackKeys(JSON.parse(JSON.stringify(packKeys(f.keys))));
  assert.equal(back.length, f.keys.length);
  for (let i = 0; i < back.length; i++) for (let c = 0; c < 5; c++) assert.ok(Math.abs(back[i][c] - f.keys[i][c]) <= 0.006, `key ${i}.${c}`);
  for (const bad of [null, [1, 2, 3], [0, 0, 0, 0, 'x'], [100, 0, 0, 0, 0, 50, 0, 0, 0, 0], new Array(1005).fill(0)]) assert.equal(unpackKeys(bad), null);
});

test('a flight held to a budget: from calmAfter the next landing is the last, and it rests at once', () => {
  const free = simulateFlight({ x: 0, y: 0, z: 0 }, { x: 3, y: 9, z: 0 }, { radius: 0.4, gravity: 18, hit: ground });
  const held = simulateFlight({ x: 0, y: 0, z: 0 }, { x: 3, y: 9, z: 0 }, { radius: 0.4, gravity: 18, hit: ground, calmAfter: 0.6 });
  assert.ok(free.events.filter(e => e.kind === 'bounce').length >= 1, 'free: it bounces');
  assert.deepEqual(held.events.map(e => e.kind), ['land', 'rest'], 'held: one landing, then rest');
  assert.ok(held.duration < free.duration && held.duration < 1.2, `held ends at ${held.duration} s`);
});
