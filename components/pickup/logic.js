// pickup: the pure logic (no three.js, no DOM): the spots, who touches one (swept between the last two positions) and
// when each comes back. A spot is {x, y, z, state: 1 present | 0 waiting to respawn | 2 removed, back: time, respawn}.
// Node tests: research/gf-three/tests/k2-pickup.test.mjs.

/** Distance in the ground plane from point (px, pz) to the segment a→b ({x, z}). */
export function segDist2(a, b, px, pz) {
  const dx = b.x - a.x, dz = b.z - a.z, l2 = dx * dx + dz * dz;
  const t = l2 < 1e-12 ? 0 : Math.max(0, Math.min(1, ((px - a.x) * dx + (pz - a.z) * dz) / l2));
  return Math.hypot(a.x + dx * t - px, a.z + dz * t - pz);
}

/** Did a walker moving prev→cur touch the spot within `radius`, and within `dy` of its height? */
export function touches(spot, prev, cur, radius, dy = 1.8) {
  if (Math.abs(cur.y - spot.y) > dy + 1) return false;
  return segDist2(prev, cur, spot.x, spot.z) <= radius;
}

/** A set of spots with respawn timers. */
export function createSpots(max = 24) {
  const spots = [];
  return {
    spots,
    /** Add a spot (reusing a removed slot). → index or -1 when full. */
    add(x, y, z, respawn) {
      let i = spots.findIndex(s => s.state === 2);
      if (i < 0) { if (spots.length >= max) return -1; i = spots.length; spots.push({}); }
      spots[i] = { x, y, z, state: 1, back: 0, respawn };
      return i;
    },
    /** Take spot i at time `now`. → false when it was not there. A respawn of 0 removes it for good. */
    take(i, now) {
      const s = spots[i]; if (!s || s.state !== 1) return false;
      if (s.respawn > 0) { s.state = 0; s.back = now + s.respawn; } else s.state = 2;
      return true;
    },
    /** Spots whose time has come → indices (they are present again). */
    tick(now) { const out = []; spots.forEach((s, i) => { if (s.state === 0 && now >= s.back) { s.state = 1; out.push(i); } }); return out; },
    remove(i) { if (spots[i]) spots[i].state = 2; },
    set(i, present) { if (spots[i] && spots[i].state !== 2) spots[i].state = present ? 1 : 0; if (spots[i] && present === false) spots[i].back = Infinity; },
    present: () => spots.filter(s => s.state === 1).length,
    clear() { spots.length = 0; },
    /** Wire form: [[x, y, z, state]] */
    encode: () => spots.map(s => [Math.round(s.x * 100) / 100, Math.round(s.y * 100) / 100, Math.round(s.z * 100) / 100, s.state]),
  };
}

/**
 * `n` points in a circle or box zone ({shape, cx, cz, rx, rz}) at least `gap` apart. rng() → 0..1.
 * free(x, z) → false rejects a point (inside a prop); a point that never fits falls back to the free-est try.
 */
export function pointsIn(zone, n, rng, gap = 1.0, free = null) {
  const out = [];
  for (let i = 0; i < n; i++) {
    let p = null, spare = null;
    for (let t = 0; t < 80 && !p; t++) {
      let x, z;
      if (zone.shape === 'box') { x = zone.cx + (rng() - 0.5) * zone.rx * 2; z = zone.cz + (rng() - 0.5) * zone.rz * 2; }
      else { const a = rng() * Math.PI * 2, d = Math.sqrt(rng()) * zone.rx; x = zone.cx + Math.cos(a) * d; z = zone.cz + Math.sin(a) * d; }
      const open = !free || free(x, z);
      if (open && !spare) spare = { x, z };
      if (open && out.every(q => Math.hypot(q.x - x, q.z - z) >= gap)) p = { x, z };
    }
    out.push(p ?? spare ?? { x: zone.cx, z: zone.cz });
  }
  return out;
}

/**
 * free(x, z) for pointsIn: false within `pad` metres of a world collider (world.shapes: {shape, position, size |
 * radius, rotationY}; the ground and the invisible walls, '#…', are skipped). Pure: no three.js.
 */
export function clearOfShapes(shapes, pad = 0.5) {
  const solid = (shapes ?? []).filter(s => !String(s.prop ?? '').startsWith('#'));
  return (x, z) => solid.every(s => {
    const [cx, , cz] = s.position ?? [0, 0, 0];
    if (s.shape === 'cylinder' || s.shape === 'sphere') return Math.hypot(x - cx, z - cz) > (s.radius ?? 0.5) + pad;
    const a = -(s.rotationY ?? 0) * Math.PI / 180, dx = x - cx, dz = z - cz;
    const lx = dx * Math.cos(a) + dz * Math.sin(a), lz = -dx * Math.sin(a) + dz * Math.cos(a);
    return Math.abs(lx) > (s.size?.[0] ?? 1) / 2 + pad || Math.abs(lz) > (s.size?.[2] ?? 1) / 2 + pad;
  });
}
