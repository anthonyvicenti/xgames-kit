// race: the pure logic (no three.js, no DOM): checkpoints, laps and the finish order.
// Node tests: research/gf-three/tests/k2-race.test.mjs.

/** `n` checkpoints on a ring of `radius` around (cx, cz), the first at angle `start`. → [{x, z}] */
export function ringCheckpoints(n, cx, cz, radius, start = 0) {
  return Array.from({ length: n }, (_, i) => { const a = start + i / n * Math.PI * 2; return { x: cx + Math.cos(a) * radius, z: cz + Math.sin(a) * radius }; });
}

/** Distance in the ground plane from (px, pz) to the segment a→b. */
export function segDist2(a, b, px, pz) {
  const dx = b.x - a.x, dz = b.z - a.z, l2 = dx * dx + dz * dz;
  const t = l2 < 1e-12 ? 0 : Math.max(0, Math.min(1, ((px - a.x) * dx + (pz - a.z) * dz) / l2));
  return Math.hypot(a.x + dx * t - px, a.z + dz * t - pz);
}

/**
 * The race. cps: [{x, z}] in order; a lap is passing all of them in order. Progress per id: {lap, cp, place, time}.
 * `pass(id, prev, cur, now)` is the swept test: crossing the next checkpoint's radius between two samples counts.
 */
export function createRace({ cps, laps = 3, radius = 2.4, dy = 3 }) {
  const prog = new Map(), order = [];
  const get = id => { let p = prog.get(id); if (!p) prog.set(id, p = { lap: 0, cp: 0, place: 0, time: 0 }); return p; };
  const r = {
    cps, laps, order, get,
    /** → events: 'checkpoint', 'lap', 'finish' (possibly several when one step crosses two gates) */
    pass(id, prev, cur, now, y = 0) {
      const p = get(id), ev = [];
      if (p.place) return ev;
      for (let k = 0; k < 2; k++) {
        const c = cps[p.cp];
        if (!c || Math.abs(y - (c.y ?? y)) > dy || segDist2(prev, cur, c.x, c.z) > radius) break;
        p.cp++; ev.push('checkpoint');
        if (p.cp >= cps.length) { p.cp = 0; p.lap++; ev.push('lap'); if (p.lap >= laps) { order.push(id); p.place = order.length; p.time = now; ev.push('finish'); break; } }
      }
      return ev;
    },
    fraction(id) { const p = get(id); return p.place ? 1 : (p.lap * cps.length + p.cp) / (laps * cps.length); },
    /** Everyone best first: finished by place, then by progress, then by distance to their next gate. pos: {id: {x, z}} */
    standings(ids, pos = {}) {
      const dist = id => { const c = cps[get(id).cp], q = pos[id]; return c && q ? Math.hypot(c.x - q.x, c.z - q.z) : 0; };
      return ids.slice().sort((a, b) => { const A = get(a), B = get(b); if (A.place || B.place) return (A.place || 1e9) - (B.place || 1e9); return (B.lap * cps.length + B.cp) - (A.lap * cps.length + A.cp) || dist(a) - dist(b); });
    },
    allFinished: ids => ids.length > 0 && ids.every(id => get(id).place > 0),
    reset() { prog.clear(); order.length = 0; },
  };
  return r;
}
