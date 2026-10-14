// tag: the pure logic (no three.js, no DOM): who is "it", how roles pass on contact, and the contact test.
// Node tests: research/gf-three/tests/k2-tag.test.mjs.

/** Closest approach, in the ground plane, of two walkers over one step (a0→a1, b0→b1). → min distance */
export function closestApproach(a0, a1, b0, b1) {
  const px = a0.x - b0.x, pz = a0.z - b0.z, dx = (a1.x - a0.x) - (b1.x - b0.x), dz = (a1.z - a0.z) - (b1.z - b0.z);
  const A = dx * dx + dz * dz;
  const t = A < 1e-12 ? 0 : Math.max(0, Math.min(1, -(px * dx + pz * dz) / A));
  return Math.hypot(px + dx * t, pz + dz * t);
}

/**
 * Roles. mode 'swap': a tag makes the victim "it" and the tagger not; 'infect': the victim becomes "it" as well and
 * the tagger stays. After a tag the old "it" (swap) cannot tag back for `cooldown` seconds, and the victim cannot be
 * tagged again for `cooldown` either.
 */
export function createRoles({ mode = 'swap', cooldown = 1.5 } = {}) {
  const its = new Set(), immune = new Map(), time = new Map();
  return {
    its, time,
    isIt: id => its.has(id),
    make(id) { its.add(id); },
    clear(id) { its.delete(id); },
    immuneUntil: id => immune.get(id) ?? 0,
    /** Is a tag from `from` to `to` allowed at time `now`? */
    canTag(from, to, now) { return its.has(from) && !its.has(to) && now >= (immune.get(from) ?? 0) && now >= (immune.get(to) ?? 0); },
    /** Do it. → true when it happened. */
    tag(from, to, now) {
      if (!this.canTag(from, to, now)) return false;
      its.add(to); immune.set(to, now + cooldown);
      if (mode === 'swap') { its.delete(from); immune.set(from, now + cooldown); }
      return true;
    },
    /** Pick `n` "it"s at random from ids. rng() → 0..1. */
    pick(ids, n, rng) {
      const pool = ids.slice(); its.clear();
      for (let i = 0; i < n && pool.length; i++) its.add(pool.splice(Math.floor(rng() * pool.length) % pool.length, 1)[0]);
      return [...its];
    },
    /** Add `dt` seconds to everyone who is "it" (the score: least time as it wins). */
    tick(dt) { for (const id of its) time.set(id, (time.get(id) ?? 0) + dt); },
    survivors: ids => ids.filter(id => !its.has(id)),
    reset() { its.clear(); immune.clear(); time.clear(); },
  };
}

/** Who the host should send a bot toward: the nearest non-it when it is "it", else away from the nearest it. */
export function botGoal(me, others, isIt) {
  const mine = isIt(me.id);
  let best = null, bd = Infinity;
  for (const o of others) { if (o.id === me.id || (mine ? isIt(o.id) : !isIt(o.id))) continue; const d = Math.hypot(o.x - me.x, o.z - me.z); if (d < bd) { best = o; bd = d; } }
  return best ? { mode: mine ? 'seek' : 'flee', target: best, dist: bd } : null;
}
