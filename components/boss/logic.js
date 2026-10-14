// boss: the pure logic (no three.js, no DOM): phases, the attack pattern and each attack's reach. Node tests:
// research/gf-three/tests/k2-boss.test.mjs.
//
// One big enemy with phases at hit-point thresholds. Each phase has its attacks, played in a fixed, learnable order
// (games.fun's Thornwick Keep Cinder Warden and Knuckle Row's boss `pattern`), each telegraphed: slam (a ring on the
// ground that fills), charge (a lane), volley (a fan of slow bolts), summon (minions of the waves mechanic's types).

export const ATTACKS = ['slam', 'charge', 'volley', 'summon'];
/** States and attacks on the wire. */
export const BST = { intro: 0, chase: 1, windup: 2, attack: 3, recover: 4, roar: 5, dead: 6, idle: 7 };
export const ACODE = { slam: 1, charge: 2, volley: 3, summon: 4 };
export const ANAME = { 1: 'slam', 2: 'charge', 3: 'volley', 4: 'summon' };

export const ATTACK_DEFAULTS = Object.freeze({
  slam: { windup: 1.0, radius: 3.3, ahead: 2.0, damage: 2, knock: 9, recover: 0.9 },
  charge: { windup: 0.95, speed: 13, length: 12, width: 2.4, damage: 2, knock: 10, recover: 1.3 },
  volley: { windup: 0.85, count: 7, spread: 70, speed: 7, damage: 1, recover: 0.7 },
  summon: { windup: 1.1, count: 3, types: [], recover: 0.9 },
});

/** The phase for hit points `hp` of `max`: thresholds are shares (descending), e.g. [0.6, 0.3] → phases 0, 1, 2. */
export function phaseFor(hp, max, thresholds = []) {
  const share = max > 0 ? hp / max : 0;
  let ph = 0;
  for (const t of [...thresholds].sort((a, b) => b - a)) if (share <= t) ph++;
  return ph;
}

/** The phase's attack list (the last listed phase's when there are fewer lists than phases). */
export function attacksFor(lists, phase) {
  const L = Array.isArray(lists) && lists.length ? lists : [['slam', 'charge'], ['slam', 'charge', 'volley', 'summon']];
  const a = L[Math.min(phase, L.length - 1)];
  const out = (Array.isArray(a) ? a : []).filter(x => ATTACKS.includes(x));
  return out.length ? out : ['slam'];
}

/** The next attack: the phase's list in order (learnable), skipping a summon while `minions` are still up. */
export function nextAttack(list, index, { minions = 0, maxMinions = 4, distance = 5 } = {}) {
  for (let k = 0; k < list.length; k++) {
    const a = list[(index + k) % list.length];
    if (a === 'summon' && minions >= maxMinions) continue;
    if (a === 'charge' && distance < 3) continue;          // too close to run at
    return { attack: a, index: (index + k + 1) % list.length };
  }
  return { attack: 'slam', index: (index + 1) % list.length };
}

/** Where a slam lands: `ahead` m in front of the boss. */
export const slamPoint = (b, yaw, ahead) => ({ x: b.x + Math.sin(yaw) * ahead, z: b.z + Math.cos(yaw) * ahead });

/** Players inside a slam's ring. targets [{id, x, z}] → ids */
export const slamTargets = (at, radius, targets, pad = 0.35) => targets.filter(t => Math.hypot(t.x - at.x, t.z - at.z) <= radius + pad).map(t => t.id);

/** Players the charging boss runs into this frame: within half the lane's width of its path from a to b. */
export function chargeTargets(a, b, width, targets, pad = 0.35) {
  const dx = b.x - a.x, dz = b.z - a.z, l2 = dx * dx + dz * dz, out = [];
  for (const t of targets) {
    const u = l2 > 1e-9 ? Math.max(0, Math.min(1, ((t.x - a.x) * dx + (t.z - a.z) * dz) / l2)) : 0;
    if (Math.hypot(a.x + dx * u - t.x, a.z + dz * u - t.z) <= width / 2 + pad) out.push(t.id);
  }
  return out;
}

/** The yaws of a volley's bolts: `count` spread over `spread` degrees around `yaw`. */
export function volleyYaws(yaw, count, spread) {
  if (count <= 1) return [yaw];
  const s = (spread * Math.PI) / 180;
  return Array.from({ length: count }, (_, i) => yaw - s / 2 + (s * i) / (count - 1));
}
