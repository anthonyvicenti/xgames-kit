// projectile: the pure maths (no three.js, no DOM): launch, ballistics, the swept hit test, splash, the stream's arc.
// Points are plain {x, y, z}. Node tests: research/gf-three/tests/k2-projectile.test.mjs.

export const MAX_SPEED = 45;     // PLAN §2.6: a fast shot against a delayed (smoothed) remote body needs a cap
const len = (x, y, z) => Math.hypot(x, y, z);

/** Unit direction with an upward bias added (`arc`: 0 flat, 0.25 a gentle lob), times speed (capped). → [vx, vy, vz] */
export function launchVelocity(dir, speed, arc = 0) {
  let x = dir[0], y = dir[1] + arc, z = dir[2];
  const l = len(x, y, z) || 1;
  const s = Math.min(Math.max(0, speed), MAX_SPEED);
  return [x / l * s, y / l * s, z / l * s];
}

/** One semi-implicit Euler step of a thrown thing: b = {x,y,z,vx,vy,vz}. Mutates and returns b. */
export function step(b, dt, gravity) {
  b.vy -= gravity * dt;
  b.x += b.vx * dt; b.y += b.vy * dt; b.z += b.vz * dt;
  return b;
}

/** Closed form position at time t of a shot from o with velocity v. */
export const arcAt = (o, v, g, t) => ({ x: o.x + v[0] * t, y: o.y + v[1] * t - 0.5 * g * t * t, z: o.z + v[2] * t });

/**
 * Swept sphere-vs-moving-sphere (PLAN §2.6: sweep between the last two raw samples). The shot goes a0→a1 and the
 * target centre c0→c1 over the same step. Relative motion is linear, so this is the closest approach of a segment
 * to the origin. → the time t in [0, 1] of first contact within `r`, or null.
 */
export function sweepHit(a0, a1, c0, c1, r) {
  const px = a0.x - c0.x, py = a0.y - c0.y, pz = a0.z - c0.z;
  const dx = (a1.x - a0.x) - (c1.x - c0.x), dy = (a1.y - a0.y) - (c1.y - c0.y), dz = (a1.z - a0.z) - (c1.z - c0.z);
  const A = dx * dx + dy * dy + dz * dz, C = px * px + py * py + pz * pz - r * r;
  if (C <= 0) return 0;
  if (A < 1e-12) return null;
  const B = px * dx + py * dy + pz * dz;          // half the linear term
  const disc = B * B - A * C;
  if (disc < 0) return null;
  const t = (-B - Math.sqrt(disc)) / A;
  return t >= 0 && t <= 1 ? t : null;
}

/** The heights (fractions of body height) a player's body is tested at: legs, chest, head. */
export const BODY_LEVELS = [0.25, 0.55, 0.85];

/** Sweep a shot against a player body (three spheres on a vertical line). prev/cur: feet positions. → {t, level} | null */
export function sweepBody(a0, a1, prev, cur, height, r) {
  let best = null;
  for (const f of BODY_LEVELS) {
    const t = sweepHit(a0, a1, { x: prev.x, y: prev.y + f * height, z: prev.z }, { x: cur.x, y: cur.y + f * height, z: cur.z }, r);
    if (t !== null && (best === null || t < best.t)) best = { t, level: f };
  }
  return best;
}

/** Distance from point p to the segment a→b. */
export function segDist(a, b, p) {
  const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z, l2 = dx * dx + dy * dy + dz * dz;
  const t = l2 < 1e-12 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy + (p.z - a.z) * dz) / l2));
  return len(a.x + dx * t - p.x, a.y + dy * t - p.y, a.z + dz * t - p.z);
}

/** The knock a hit gives: along the shot's horizontal heading, `horizontal` m/s, plus `up`. → {x, y, z} */
export function knockImpulse(dir, horizontal, up) {
  const h = Math.hypot(dir[0], dir[2]) || 1;
  return { x: dir[0] / h * horizontal, y: up, z: dir[2] / h * horizontal };
}

/** Splash: who is within `radius` of `point` (their body centre), with a 0..1 falloff. targets: [{id, x, y, z}] */
export function splashTargets(point, radius, targets) {
  const out = [];
  for (const t of targets) {
    const d = len(t.x - point.x, t.y - point.y, t.z - point.z);
    if (d <= radius) out.push({ id: t.id, d, falloff: 1 - d / radius });
  }
  return out;
}

/** A bounce: reflect v about the unit normal n, keeping `restitution` of the speed and `friction` of the sliding. */
export function bounce(v, n, restitution = 0.6, friction = 0.85) {
  const dot = v[0] * n[0] + v[1] * n[1] + v[2] * n[2];
  const nx = dot * n[0], ny = dot * n[1], nz = dot * n[2];
  return [(v[0] - nx) * friction - nx * restitution, (v[1] - ny) * friction - ny * restitution, (v[2] - nz) * friction - nz * restitution];
}

/**
 * The path of a continuous stream: samples of an arc from `origin` along `dir`, at `speed`, under `gravity`, as
 * far as `reach` metres or the ground (y = ground). → {points: [{x,y,z}], duration (s), length (m)}
 */
export function streamPath(origin, dir, speed, gravity, reach, steps = 14, ground = 0) {
  const l = len(dir[0], dir[1], dir[2]) || 1;
  const v = [dir[0] / l * speed, dir[1] / l * speed, dir[2] / l * speed];
  const points = [{ x: origin.x, y: origin.y, z: origin.z }];
  const dt = reach / speed / steps;
  let length = 0, t = 0;
  for (let i = 1; i <= steps; i++) {
    t = i * dt;
    const p = arcAt(origin, v, gravity, t);
    if (p.y <= ground) {          // stop where the arc meets the ground
      const q = points[points.length - 1], k = (q.y - ground) / Math.max(1e-6, q.y - p.y);
      const e = { x: q.x + (p.x - q.x) * k, y: ground, z: q.z + (p.z - q.z) * k };
      length += len(e.x - q.x, e.y - q.y, e.z - q.z); points.push(e); t = (i - 1 + k) * dt;
      return { points, duration: t, length };
    }
    const q = points[points.length - 1]; length += len(p.x - q.x, p.y - q.y, p.z - q.z); points.push(p);
  }
  return { points, duration: t, length };
}

/** A fire-rate gate: `gate.ok(key, now)` is true (and arms the cooldown) when `cooldown` s have passed for that key. */
export function cooldownGate(cooldown) {
  const last = new Map();
  return {
    ok(key, now) { const t = last.get(key); if (t !== undefined && now - t < cooldown - 1e-6) return false; last.set(key, now); return true; },
    reset() { last.clear(); },
  };
}

/** Team rule: a hit counts unless the two are on one team and friendly fire is off. teamOf(p) → index | -1. */
export const canHit = (shooter, target, { friendlyFire = true, selfHit = false, teamOf = () => -1 } = {}) => {
  if (!target) return false;
  if (shooter && shooter.id === target.id) return selfHit;
  if (!friendlyFire && shooter) { const a = teamOf(shooter); if (a >= 0 && a === teamOf(target)) return false; }
  return true;
};
