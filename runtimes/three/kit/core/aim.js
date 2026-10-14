// gf-three core: aim at the crosshair (CONTRACT §6d). Pure maths plus one world query; no three.js, no DOM, so Node
// tests import it (research/gf-three/tests/k3-controls.test.mjs).
//
// Creator, T1 run 5 (2026-10-07): "I cant seem to fire pee or drink". The stream left along the camera's forward
// vector, which looks down at the player, so it landed about 2 m ahead, hidden behind the player's own body, and the
// crosshair sat on that body. Now the kit aims every aimed mechanic at the point under the crosshair:
//
//   crosshairPoint(ctx, from, dir, {self, exclude})   a ray from the camera through the middle of the screen into the
//                                world (the ground, props, other players, ctx.aimBodies: waves' enemies). It starts where the player stands along it, so
//                                nothing between the camera and the player counts. → {x, y, z, t, hit, onSelf}
//   p.aim       the unit direction from the aim origin (feet + AIM_HEIGHT) to that point (still a direction: bots, the
//               character's upper-body pitch and older rules read it as before)
//   p.aimDist   the distance from the aim origin to that point; null when the player has no crosshair (bots, the top
//               camera). It rides the pose as `ad`, so every copy knows the point: aimTarget(p).
//   solveLaunch(o, T, speed, gravity, {maxTime})      the low arc from o that lands on T, or, out of reach, the farthest
//               landing toward it. Projectile shots and streams and carry's throw leave the player this way, so a
//               shooter sees the shot land where the crosshair is, and so does every friend (same position + aim).
import { physicsOf, SOLID_QUERY } from './util.js';

export const AIM_HEIGHT = 1.2;       // the aim origin above the feet (the projectile muzzle height)
export const AIM_MAX = 80;           // the longest crosshair ray (m)
export const BODY_RADIUS = 0.42;     // a player's body for the crosshair ray (a vertical cylinder)
export const SELF_RADIUS = 0.55;     // the player's own drawn body for onSelf: arms and the reticle's own size included
const DEG = Math.PI / 180;

/** The aim origin of a player: {x, y, z} (feet + AIM_HEIGHT). */
export function aimOrigin(p) { const q = p?.position ?? p; return { x: q.x, y: (q.y ?? 0) + AIM_HEIGHT, z: q.z }; }

/** The point a player aims at (from aim + aimDist), or null when the player has no crosshair point. */
export function aimTarget(p) {
  const a = p?.aim, d = p?.aimDist;
  if (!Array.isArray(a) || !Number.isFinite(d) || d <= 0) return null;
  const l = Math.hypot(a[0], a[1], a[2]) || 1, o = aimOrigin(p);
  return { x: o.x + a[0] / l * d, y: o.y + a[1] / l * d, z: o.z + a[2] / l * d };
}

/** aim + aimDist from an origin to a point → {aim: [x, y, z], dist}. */
export function aimFrom(o, P) {
  const dx = P.x - o.x, dy = P.y - o.y, dz = P.z - o.z, d = Math.hypot(dx, dy, dz);
  if (d < 1e-6) return { aim: [0, 0, 1], dist: 0 };
  return { aim: [dx / d, dy / d, dz / d], dist: d };
}

/**
 * The launch direction from `o` that lands on `T` at `speed` under `gravity` (m/s²), within `maxTime` seconds.
 * → {dir: [x, y, z] (unit), t (seconds to arrive, or the flight time used), reach (true: it lands on T), angle (rad)}
 * In reach: the low arc. Out of reach: the angle whose arc comes down to T's height farthest toward T in time; when no
 * arc comes down to that height at all (T far above): straight at T.
 */
export function solveLaunch(o, T, speed, gravity, { maxTime = Infinity } = {}) {
  const dx = T.x - o.x, dz = T.z - o.z, R = Math.hypot(dx, dz), h = T.y - o.y, v = Math.max(0.01, speed), g = Math.max(0, gravity);
  const hx = R > 1e-6 ? dx / R : 0, hz = R > 1e-6 ? dz / R : 1;
  const mk = th => [hx * Math.cos(th), Math.sin(th), hz * Math.cos(th)];
  const straight = () => { const d = Math.hypot(R, h) || 1; return { dir: [dx / d, h / d, dz / d], t: d / v, angle: Math.atan2(h, R) }; };
  if (g < 1e-6 || R < 0.05) { const s = straight(); return { ...s, reach: s.t <= maxTime + 1e-6 }; }
  const v2 = v * v, disc = v2 * v2 - g * (g * R * R + 2 * h * v2);
  if (disc >= 0) {
    const th = Math.atan2(v2 - Math.sqrt(disc), g * R), t = R / (v * Math.cos(th));
    if (t <= maxTime + 1e-6) return { dir: mk(th), t, reach: true, angle: th };
  }
  // out of reach (too far, or the time runs out first): land as far toward T as the arc can
  let best = null;
  for (let deg = -60; deg <= 75; deg += 0.5) {
    const th = deg * DEG, vy = v * Math.sin(th), vh = v * Math.cos(th), q = vy * vy - 2 * g * h;
    if (q < 0) continue;                                   // this arc never comes down to T's height
    const t = (vy + Math.sqrt(q)) / g;                     // coming down through T's height
    if (!(t <= maxTime + 1e-6)) continue;
    const x = vh * t;
    if (x <= R + 1e-6 && (!best || x > best.x)) best = { x, th, t };
  }
  if (best) return { dir: mk(best.th), t: best.t, reach: false, angle: best.th };
  const s = straight();
  return { ...s, t: Math.min(s.t, maxTime), reach: false };
}

/** A ray against a vertical cylinder (feet at c, height h, radius r) → the entry distance along the ray, or null. */
export function rayCylinder(o, d, c, h, r) {
  const ox = o.x - c.x, oz = o.z - c.z, a = d.x * d.x + d.z * d.z;
  let t0 = -Infinity, t1 = Infinity;
  if (a > 1e-12) {
    const b = ox * d.x + oz * d.z, cc = ox * ox + oz * oz - r * r, disc = b * b - a * cc;
    if (disc < 0) return null;
    const s = Math.sqrt(disc); t0 = (-b - s) / a; t1 = (-b + s) / a;
  } else if (ox * ox + oz * oz > r * r) return null;
  // the slab between the feet and the top
  const y0 = c.y, y1 = c.y + h;
  if (Math.abs(d.y) > 1e-12) { let a0 = (y0 - o.y) / d.y, a1 = (y1 - o.y) / d.y; if (a0 > a1) [a0, a1] = [a1, a0]; t0 = Math.max(t0, a0); t1 = Math.min(t1, a1); }
  else if (o.y < y0 || o.y > y1) return null;
  if (t0 > t1 || t1 < 0) return null;
  return Math.max(0, t0);
}

/**
 * The point under the crosshair: a ray from `from` (the camera) along `dir` (unit) into the world (fromCamera: the
 * follow camera's cursor ray, counted from the camera). self: the local
 * player (the ray starts at their depth along it, and onSelf says whether their own body covers the crosshair; pass
 * selfVisible: false in first person, where the body is hidden);
 * exclude: their capsule collider. → {x, y, z, t (m from `from`), hit: 'world'|'player'|'body'|'ground'|null, onSelf, player, body (an aimBodies id)}
 */
export function crosshairPoint(ctx, from, dir, { self = null, selfVisible = true, exclude = null, max = AIM_MAX, players = null, fromCamera = false } = {}) {
  const l = Math.hypot(dir.x, dir.y, dir.z) || 1, d = { x: dir.x / l, y: dir.y / l, z: dir.z / l };
  let start = 0, onSelf = false;
  // fromCamera (the 'follow' camera's cursor ray, CONTRACT §8): the whole ray counts, so a point on the ground between
  // the camera and the player can be aimed at; the player's own body is still never a target
  if (self?.position && !fromCamera) {
    const h = self.character?.height ?? 1.7, c = { x: self.position.x, y: self.position.y + h * 0.6, z: self.position.z };
    start = Math.max(0, (c.x - from.x) * d.x + (c.y - from.y) * d.y + (c.z - from.z) * d.z);
    const t = selfVisible ? rayCylinder(from, d, self.position, h, SELF_RADIUS) : null;
    onSelf = t !== null && t <= start + SELF_RADIUS;
  }
  let best = { t: max, hit: null, player: null };
  // the world: Rapier's solid colliders (the ground, walls, props; never a capsule or a ragdoll)
  const { RAPIER: R, world: W } = physicsOf(ctx);
  if (R && W && max > start) {
    const ray = new R.Ray({ x: from.x + d.x * start, y: from.y + d.y * start, z: from.z + d.z * start }, d);
    try {
      const h = W.castRay(ray, max - start, true, undefined, SOLID_QUERY, exclude ?? undefined);
      const toi = h ? (h.timeOfImpact ?? h.toi) : null;
      if (toi !== null && start + toi < best.t) best = { t: start + toi, hit: 'world', player: null };
    } catch { /* a world without colliders yet */ }
  }
  // the ground plane (y = 0), in case the world has no ground collider under this spot
  if (d.y < -1e-6) { const t = (0 - from.y) / d.y; if (t > start && t < best.t) best = { t, hit: 'ground', player: null }; }
  // other players: where this copy draws them
  for (const p of players ?? ctx.players?.list?.() ?? []) {
    if (p === self || p.alive === false || !(p.owned || p.drawn)) continue;
    const t = rayCylinder(from, d, p.position, p.character?.height ?? 1.7, BODY_RADIUS);
    if (t !== null && t >= start && t < best.t) best = { t, hit: 'player', player: p.id };
  }
  // other bodies a mechanic draws and shots can hit (waves' enemies): ctx.aimBodies, a list of fn() → [{id, x, y?, z,
  // height, radius}] where this copy draws them. The crosshair stops on an enemy, so a shot lands on the one under it
  for (const src of ctx.aimBodies ?? []) {
    let list = []; try { list = src() ?? []; } catch { list = []; }
    for (const b of list) {
      const t = rayCylinder(from, d, { x: b.x, y: b.y ?? 0, z: b.z }, b.height ?? 1.7, b.radius ?? BODY_RADIUS);
      if (t !== null && t >= start && t < best.t) best = { t, hit: 'body', player: null, body: b.id ?? null };
    }
  }
  return { x: from.x + d.x * best.t, y: from.y + d.y * best.t, z: from.z + d.z * best.t, t: best.t, hit: best.hit, player: best.player, ...(best.body != null ? { body: best.body } : {}), onSelf };
}
