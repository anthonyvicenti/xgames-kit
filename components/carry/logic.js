// carry: the pure logic (no three.js, no DOM): who can grab what, and how a thrown item flies and comes to rest.
// Items are plain {id, x, y, z, vx, vy, vz, holder: '' | playerId, mode: 'rest'|'fly'|'held'}.
// Node tests: research/gf-three/tests/k2-carry.test.mjs.

/** The nearest free (mode 'rest') item to `pos` within `reach` metres (horizontal, plus 2 m up/down). → item | null */
export function nearestFree(items, pos, reach) {
  let best = null, bd = Infinity;
  for (const it of items) {
    if (it.mode !== 'rest' || it.holder) continue;
    if (Math.abs(it.y - pos.y) > 2.2) continue;
    const d = Math.hypot(it.x - pos.x, it.z - pos.z);
    if (d <= reach && d < bd) { best = it; bd = d; }
  }
  return best;
}

/** How many items a player holds. */
export const heldBy = (items, id) => items.filter(i => i.holder === id && i.mode === 'held');

/** Can this player take one more? → {ok, reason} */
export function canGrab(items, id, maxHeld) {
  if (heldBy(items, id).length >= maxHeld) return { ok: false, reason: 'full' };
  return { ok: true, reason: '' };
}

/** Launch velocity for a throw: unit dir + upward `arc`, scaled to speed. */
export function throwVelocity(dir, speed, arc) {
  const x = dir[0], y = dir[1] + arc, z = dir[2], l = Math.hypot(x, y, z) || 1;
  return [x / l * speed, y / l * speed, z / l * speed];
}

/**
 * One physics step for a free item (mode 'fly'): gravity, a bounce on the ground plane (y = radius + groundY), ground
 * friction, and rest once slow. `hit` (optional) is a wall contact {n: [x, y, z], t} found by the caller for this step.
 * Mutates the item. → 'fly' | 'rest'
 */
export function stepItem(it, dt, { gravity = 16, radius = 0.2, groundY = 0, restitution = 0.45, friction = 0.8 } = {}) {
  if (it.mode === 'rest') return 'rest';
  it.vy -= gravity * dt;
  it.x += it.vx * dt; it.y += it.vy * dt; it.z += it.vz * dt;
  const floor = groundY + radius;
  if (it.y <= floor) {
    it.y = floor;
    if (Math.abs(it.vy) > 1.2) it.vy = -it.vy * restitution; else it.vy = 0;
    const k = Math.pow(friction, dt * 60 / 4);
    it.vx *= k; it.vz *= k;
    if (it.vy === 0 && Math.hypot(it.vx, it.vz) < 0.6) { it.vx = it.vy = it.vz = 0; it.mode = 'rest'; return 'rest'; }
  }
  return 'fly';
}

/** Bounce a velocity off a wall with unit normal n. */
export function wallBounce(it, n, restitution = 0.45) {
  const d = it.vx * n[0] + it.vy * n[1] + it.vz * n[2];
  it.vx -= (1 + restitution) * d * n[0]; it.vy -= (1 + restitution) * d * n[1]; it.vz -= (1 + restitution) * d * n[2];
}

