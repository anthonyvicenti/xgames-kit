// mechanic: knockback, its pure parts (no three.js, no DOM, no Rapier): the push a blast gives a body, a body's whole
// flight (gravity, bounces off the world, rest, the sea, out of bounds), the bodies a flying one knocks on its way, a path
// packed for the wire and read back at any moment. Node tests: tests/knockback.test.mjs.
//
// A flight is simulated once, on the host, and sent whole; every copy plays the same path (index.js), so every screen
// sees the same flight and the same landing whatever its frame rate. Points are plain {x, y, z}; a path's positions are
// the body's FEET (the kit's player.position), its centre is `radius` above them.

export const KEY_HZ = 15;           // keys per second on the wire (a flight is drawn between them, smoothly)
const STEP = 1 / 120;               // the simulation's step
const REST_SPEED = 1.1;             // m/s: slower than this on the ground counts as resting
export const MAX_FLIGHT = 6;        // s: the longest flight simulated
export const MAX_SPEED = 32;        // m/s: the fastest a blast throws anything

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const len = (x, y, z) => Math.sqrt(x * x + y * y + z * z);

/** How much of a blast is left at `q` (1 at the centre, 0 at the edge): 'linear', 'smooth' (eased) or 'flat'. */
export function falloffAt(q, kind = 'smooth') {
  const k = clamp(q, 0, 1);
  if (kind === 'flat') return k > 0 ? 1 : 0;
  if (kind === 'linear') return k;
  return k * k * (3 - 2 * k);
}

/**
 * The push a blast at `at` gives a body whose centre is `c`, in m/s: away from the blast, tipped up by `up` (0 straight
 * out, 1 about 45° up), `force` m/s at the centre for a body of mass 1, less toward the edge (falloff), less for a heavier
 * body. → {x, y, z, k (0..1 how much of the blast reached it), d (m)} or null outside the radius.
 */
export function radialImpulse(at, c, { radius = 4, force = 14, up = 0.6, falloff = 'smooth', mass = 1, minUp = 2 } = {}) {
  let dx = c.x - at.x, dy = c.y - at.y, dz = c.z - at.z;
  const d = len(dx, dy, dz);
  if (!(d <= radius) || !(radius > 0)) return null;
  const k = falloffAt(1 - d / radius, falloff);
  if (k <= 0) return null;
  if (d < 0.15) { dx = 0; dy = 1; dz = 0; } else { dx /= d; dy /= d; dz /= d; }
  // tip the way up: a blast under or beside a body throws it into the air, never into the ground
  dy = Math.max(dy, 0) + up;
  const l = len(dx, dy, dz) || 1;
  const s = Math.min(MAX_SPEED, force * k / Math.max(0.1, mass));
  const v = { x: dx / l * s, y: dy / l * s, z: dz / l * s, k, d };
  if (v.y < minUp * k) v.y = minUp * k;
  return v;
}

/**
 * A body's flight from `start` (feet) at velocity `v`, until it rests, sinks or leaves the play.
 * opts: radius (m, the body's ball), gravity (m/s²), bounce (speed kept off a surface, 0..1), friction (sliding speed kept
 * per bounce), settle (s at rest before the flight ends), spin (rad/s to start with), sea (y, or null), bounds
 * ([x0, z0, x1, z1], or null), floor (y below which it is out), maxTime, calmAfter (s: from then the next landing rests it
 * at once, no more bounces: a flight held to a time budget, fair play's),
 * hit(a, b, radius) → {t (0..1 along a→b), normal [x, y, z]} | null: the world between two centres (a sphere cast).
 * → {keys: [[t, x, y, z, a]] (feet; a: how far it has turned, rad), events: [{t, kind: 'bounce' | 'land' | 'water' | 'out'
 *    | 'rest', at: {x, y, z}, speed}], end: {x, y, z}, duration, landSpeed (the hardest it hit anything), into: 'rest' |
 *    'water' | 'out' | 'time'}
 */
export function simulateFlight(start, v, opts = {}) {
  const { radius = 0.4, gravity = 18, bounce = 0.38, friction = 0.72, settle = 0.45, spin = 0, sea = null, bounds = null, floor = -30, maxTime = MAX_FLIGHT, calmAfter = Infinity, hit = () => null } = opts;
  let x = start.x, y = start.y + radius, z = start.z, vx = v.x, vy = v.y, vz = v.z, a = 0, w = spin || Math.min(14, len(v.x, 0, v.z) * 0.9 + 2);
  const sp = len(vx, vy, vz);
  if (sp > MAX_SPEED) { vx *= MAX_SPEED / sp; vy *= MAX_SPEED / sp; vz *= MAX_SPEED / sp; }
  const keys = [[0, x, y - radius, z, 0]], events = [];
  const every = 1 / KEY_HZ;
  let t = 0, nextKey = every, rest = 0, landSpeed = 0, into = 'time', sinking = -1, groundAt = -1, landed = false;
  const ev = (kind, speed = 0) => events.push({ t: round3(t), kind, at: { x: r2(x), y: r2(y - radius), z: r2(z) }, speed: r2(speed) });
  while (t < maxTime) {
    t += STEP;
    if (sinking >= 0) {
      // in the sea: slowed hard, drifting down, then gone
      vx *= 0.9; vz *= 0.9; vy = vy * 0.85 - 2.5 * STEP * 10; w *= 0.95;
      x += vx * STEP; y += vy * STEP; z += vz * STEP; a += w * STEP;
      if (t - sinking > 0.7) { into = 'water'; break; }
    } else {
      vy -= gravity * STEP;
      const nx = x + vx * STEP, ny = y + vy * STEP, nz = z + vz * STEP;
      const h = hit({ x, y, z }, { x: nx, y: ny, z: nz }, radius);
      if (h) {
        const n = h.normal, tt = clamp(h.t, 0, 1);
        x += (nx - x) * tt; y += (ny - y) * tt; z += (nz - z) * tt;
        const vn = vx * n[0] + vy * n[1] + vz * n[2];
        if (vn < 0) {
          const impact = -vn;
          landSpeed = Math.max(landSpeed, impact);
          // the normal part goes (and comes back as a bounce when the hit was hard); the sliding part keeps `friction` of
          // itself on a bounce, and drags a little each step while it slides or rolls
          vx -= vn * n[0]; vy -= vn * n[1]; vz -= vn * n[2];
          if (impact > 2.2 && t >= calmAfter && n[1] > 0.55) {
            // past its budget: this landing is the last (a thud, no bounce), and it rests at once
            ev(landed ? 'bounce' : 'land', impact); landed = true; vx = vy = vz = 0; w = 0; groundAt = t; into = 'rest'; ev('rest'); break;
          } else if (impact > 2.2) {
            vx *= friction; vy *= friction; vz *= friction;
            vx -= vn * bounce * n[0]; vy -= vn * bounce * n[1]; vz -= vn * bounce * n[2];
            w *= 0.65;
            ev(landed ? 'bounce' : 'land', impact);
            landed = true;
          } else { const drag = 1 - 3.5 * STEP; vx *= drag; vy *= drag; vz *= drag; }
        }
        if (n[1] > 0.55) groundAt = t;
        // the rest of the step along the new velocity, when it is clear (sliding down a slope, rolling on)
        const r = (1 - tt) * STEP, mx = x + n[0] * 0.002 + vx * r, my = y + n[1] * 0.002 + vy * r, mz = z + n[2] * 0.002 + vz * r;
        if (!hit({ x, y, z }, { x: mx, y: my, z: mz }, radius)) { x = mx; y = my; z = mz; }
      } else { x = nx; y = ny; z = nz; }
      a += w * STEP;
      const s = len(vx, vy, vz);
      // on the ground: touched it within the last few steps (a resting ball sits a hair over it every other step)
      if (t - groundAt < 0.05 && s < REST_SPEED) { vx *= 0.8; vz *= 0.8; if (vy > 0) vy = 0; rest += STEP; w *= 0.85; } else rest = 0;
      if (rest >= settle) { into = 'rest'; ev('rest'); break; }
      if (sea !== null && y - radius * 0.3 < sea) { ev('water', s); sinking = t; vy = Math.min(vy, 0) * 0.3; }
      else if (y < floor || (bounds && (x < bounds[0] - 2 || x > bounds[2] + 2 || z < bounds[1] - 2 || z > bounds[3] + 2) && y < (sea ?? floor) + 6)) { into = 'out'; ev('out', s); break; }
    }
    if (t >= nextKey) { keys.push([round3(t), r2(x), r2(y - radius), r2(z), r2(a)]); nextKey += every; }
  }
  const last = keys[keys.length - 1];
  if (last[0] < t - 1e-6) keys.push([round3(t), r2(x), r2(y - radius), r2(z), r2(a)]);
  return { keys, events, end: { x: r2(x), y: r2(y - radius), z: r2(z) }, duration: round3(t), landSpeed: r2(landSpeed), into };
}
const r2 = v => Math.round(v * 100) / 100;
const round3 = v => Math.round(v * 1000) / 1000;

/** The path at time t (s from its start): {x, y, z, a, vx, vy, vz, done}; smooth between keys (Catmull-Rom). */
export function sampleFlight(keys, t) {
  const n = keys.length;
  if (!n) return null;
  if (t <= keys[0][0]) return at(keys, 0, 0, t >= 0 ? 0 : 0);
  if (t >= keys[n - 1][0]) { const s = at(keys, n - 1, 0); s.done = true; s.vx = s.vy = s.vz = 0; return s; }
  let i = 0;
  // keys are evenly spaced but for the last: start from the estimate
  i = clamp(Math.floor(t * KEY_HZ), 0, n - 2);
  while (i > 0 && keys[i][0] > t) i--;
  while (i < n - 2 && keys[i + 1][0] <= t) i++;
  const k0 = keys[i], k1 = keys[i + 1], u = (t - k0[0]) / Math.max(1e-6, k1[0] - k0[0]);
  return at(keys, i, u);
}
function at(keys, i, u) {
  const n = keys.length, p0 = keys[Math.max(0, i - 1)], p1 = keys[i], p2 = keys[Math.min(n - 1, i + 1)], p3 = keys[Math.min(n - 1, i + 2)];
  const cr = c => { const a = p0[c], b = p1[c], d = p2[c], e = p3[c]; return 0.5 * ((2 * b) + (-a + d) * u + (2 * a - 5 * b + 4 * d - e) * u * u + (-a + 3 * b - 3 * d + e) * u * u * u); };
  const dt = Math.max(1e-6, p2[0] - p1[0]);
  return { x: cr(1), y: cr(2), z: cr(3), a: p1[4] + (p2[4] - p1[4]) * u, vx: (p2[1] - p1[1]) / dt, vy: (p2[2] - p1[2]) / dt, vz: (p2[3] - p1[3]) / dt, done: false };
}

/**
 * The bodies a flight knocks on its way: the first moment its ball passes within reach of each other body's, while it is
 * still moving fast. others: [{id, x, y, z (feet), radius}] (where they stand now). → [{id, t, v: {x, y, z}}] in time order.
 */
export function chainHits(flight, others, { radius = 0.4, minSpeed = 5, share = 0.6, up = 2.5, upTo = 1.2 } = {}) {
  const out = [], keys = flight.keys;
  for (const o of others) {
    const reach = radius + (o.radius ?? 0.4) + 0.15;
    for (let i = 1; i < keys.length; i++) {
      const k0 = keys[i - 1], k1 = keys[i], dt = k1[0] - k0[0];
      if (dt <= 0) continue;
      const vx = (k1[1] - k0[1]) / dt, vy = (k1[2] - k0[2]) / dt, vz = (k1[3] - k0[3]) / dt, s = len(vx, vy, vz);
      if (s < minSpeed) continue;
      // the closest the segment's centre line comes to the other body's centre
      const ax = k0[1], ay = k0[2] + radius, az = k0[3], bx = k1[1], by = k1[2] + radius, bz = k1[3];
      const cx = o.x, cy = o.y + (o.radius ?? 0.4) * upTo, cz = o.z;
      const ex = bx - ax, ey = by - ay, ez = bz - az, l2 = ex * ex + ey * ey + ez * ez;
      const u = l2 < 1e-9 ? 0 : clamp(((cx - ax) * ex + (cy - ay) * ey + (cz - az) * ez) / l2, 0, 1);
      if (len(ax + ex * u - cx, ay + ey * u - cy, az + ez * u - cz) > reach) continue;
      out.push({ id: o.id, t: round3(k0[0] + dt * u), v: { x: r2(vx * share), y: r2(Math.max(vy * share, 0) + up), z: r2(vz * share) } });
      break;
    }
  }
  return out.sort((a, b) => a.t - b.t);
}

/** A flight for the wire: keys in whole centimetres and milliseconds, flat. → [t, x, y, z, a, t, x, ...] */
export function packKeys(keys) {
  const out = [];
  for (const k of keys) out.push(Math.round(k[0] * 1000), Math.round(k[1] * 100), Math.round(k[2] * 100), Math.round(k[3] * 100), Math.round(k[4] * 100));
  return out;
}
/** Back from the wire (never trusted: numbers only, times rising, at most MAX_FLIGHT s and 200 keys). → keys or null */
export function unpackKeys(flat) {
  if (!Array.isArray(flat) || flat.length % 5 !== 0 || flat.length > 1000 || !flat.length) return null;
  const keys = [];
  for (let i = 0; i < flat.length; i += 5) {
    const k = flat.slice(i, i + 5);
    if (!k.every(Number.isFinite)) return null;
    const t = k[0] / 1000;
    if (keys.length && t < keys[keys.length - 1][0]) return null;
    if (t > MAX_FLIGHT + 1 || Math.abs(k[1]) > 1e6 || Math.abs(k[2]) > 1e6 || Math.abs(k[3]) > 1e6) return null;
    keys.push([t, k[1] / 100, k[2] / 100, k[3] / 100, k[4] / 100]);
  }
  return keys;
}
