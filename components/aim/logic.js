// mechanic: aim, its pure parts (no three.js, no DOM, no Rapier): the launch from a heading, an elevation and a power;
// a shell's step under gravity and wind; the predicted path (the trajectory preview); the charge; a round's or a turn's
// wind; the shot a bot solves for (with the wind in it). Node tests: tests/aim.test.mjs.

const DEG = Math.PI / 180;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/** A unit launch direction from a heading (yaw: forward = (sin yaw, 0, cos yaw)) and an elevation (degrees above level). */
export function launchDir(yaw, elevationDeg) {
  const e = elevationDeg * DEG, c = Math.cos(e);
  return [Math.sin(yaw) * c, Math.sin(e), Math.cos(yaw) * c];
}

/** One step of a shell b = {x, y, z, vx, vy, vz}: wind (m/s², {x, z}) pushes it sideways, gravity pulls it down. Mutates b. */
export function shellStep(b, dt, gravity, wind = null) {
  if (wind) { b.vx += (wind.x ?? 0) * dt; b.vz += (wind.z ?? 0) * dt; }
  b.vy -= gravity * dt;
  b.x += b.vx * dt; b.y += b.vy * dt; b.z += b.vz * dt;
  return b;
}

/**
 * Where a shot goes: points every `dt` from `o` at velocity v, under gravity and wind, until `hit(a, b)` → {t} says it
 * met something, it falls below `floor`, or `seconds` run out. → {points: [{x, y, z}], end: {x, y, z}, time, hit: bool}
 */
export function predictPath(o, v, { gravity = 18, wind = null, dt = 1 / 30, seconds = 6, floor = -30, hit = null } = {}) {
  const b = { x: o.x, y: o.y, z: o.z, vx: v[0], vy: v[1], vz: v[2] };
  const points = [{ x: b.x, y: b.y, z: b.z }];
  let t = 0;
  while (t < seconds) {
    const a = { x: b.x, y: b.y, z: b.z };
    shellStep(b, dt, gravity, wind); t += dt;
    const h = hit ? hit(a, { x: b.x, y: b.y, z: b.z }) : null;
    if (h) { const k = clamp(h.t, 0, 1), e = { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, z: a.z + (b.z - a.z) * k }; points.push(e); return { points, end: e, time: t - dt + dt * k, hit: true }; }
    points.push({ x: b.x, y: b.y, z: b.z });
    if (b.y < floor) break;
  }
  return { points, end: points[points.length - 1], time: t, hit: false };
}

/** Power 0..1 after holding for `held` seconds: it fills over `seconds`, then holds full ('clamp') or swings back ('swing'). */
export function chargeAt(held, seconds = 1.4, mode = 'clamp', min = 0.12) {
  const f = held / Math.max(0.05, seconds);
  const p = mode === 'swing' ? 1 - Math.abs(((f % 2) + 2) % 2 - 1) : clamp(f, 0, 1);
  return min + (1 - min) * p;
}

/** A wind (m/s², {x, z}) from a random number source, at most `max` strong. Calm about one time in six. */
export function windFor(rng, max = 6) {
  if (!(max > 0)) return { x: 0, z: 0 };
  const calm = rng() < 1 / 6, a = rng() * Math.PI * 2, s = calm ? 0 : (0.25 + 0.75 * rng()) * max;
  return { x: Math.round(Math.cos(a) * s * 100) / 100, z: Math.round(Math.sin(a) * s * 100) / 100 };
}
/** The wind along a heading: the HUD's strip, -1 (in your face) .. 1 (at your back). */
export function windAlong(wind, yaw, max = 6) {
  if (!(max > 0) || !wind) return 0;
  return clamp(((wind.x ?? 0) * Math.sin(yaw) + (wind.z ?? 0) * Math.cos(yaw)) / max, -1, 1);
}

/**
 * The shot that lands nearest `to` from muzzle `o`: a search over headings round the straight line, elevations and
 * powers, flying each with the wind (no world: it lands where it comes down through the target's height). For bots.
 * → {yaw, elevation, power, miss (m)}
 */
export function solveShot(o, to, { speed = 26, gravity = 18, wind = null, minPower = 0.12, elevations = [25, 35, 45, 55, 65] } = {}) {
  const base = Math.atan2(to.x - o.x, to.z - o.z);
  let best = null;
  const land = (yaw, el, pw) => {
    const d = launchDir(yaw, el), s = speed * pw, b = { x: o.x, y: o.y, z: o.z, vx: d[0] * s, vy: d[1] * s, vz: d[2] * s };
    for (let t = 0; t < 8; t += 1 / 30) {
      const py = b.y;
      shellStep(b, 1 / 30, gravity, wind);
      if (b.vy < 0 && b.y <= to.y && py > to.y) return Math.hypot(b.x - to.x, b.z - to.z);
    }
    return Infinity;
  };
  for (const el of elevations) for (let dy = -0.5; dy <= 0.5001; dy += 0.0625) for (let pw = minPower; pw <= 1.0001; pw += 0.04) {
    const miss = land(base + dy, el, pw);
    if (!best || miss < best.miss) best = { yaw: base + dy, elevation: el, power: Math.min(1, pw), miss };
  }
  // a finer pass round the best
  if (best && Number.isFinite(best.miss)) {
    const b0 = { ...best };
    for (let dy = -0.06; dy <= 0.0601; dy += 0.01) for (let dp = -0.04; dp <= 0.0401; dp += 0.005) for (let de = -4; de <= 4; de += 2) {
      const pw = clamp(b0.power + dp, minPower, 1), miss = land(b0.yaw + dy, b0.elevation + de, pw);
      if (miss < best.miss) best = { yaw: b0.yaw + dy, elevation: b0.elevation + de, power: pw, miss };
    }
  }
  return best;
}

/** The weapons a game names, each with every field filled (a weapon is data: speed, gravity, wind, fuse, blast, ...). */
export const WEAPON_DEFAULTS = { label: 'Shot', icon: '', speed: 30, gravity: 1, wind: 1, fuse: 0, bounces: 0, restitution: 0.45, radius: 3, force: 16, damage: 25, crater: 1, ammo: -1, size: 0.22, color: '#3a3a44', prop: '' };
export function weaponsOf(list) {
  const out = [];
  for (const w of Array.isArray(list) ? list : []) {
    if (!w || typeof w.id !== 'string' || !/^[a-z0-9-]{1,32}$/.test(w.id) || out.some(x => x.id === w.id)) continue;
    const f = { ...WEAPON_DEFAULTS, ...w };
    f.speed = clamp(Number(f.speed) || 30, 4, 60); f.gravity = clamp(Number(f.gravity) || 0, 0, 4); f.wind = clamp(Number(f.wind) || 0, 0, 3);
    f.fuse = clamp(Number(f.fuse) || 0, 0, 10); f.bounces = clamp(Math.round(Number(f.bounces) || 0), 0, 20); f.restitution = clamp(Number(f.restitution) || 0, 0, 0.95);
    f.radius = clamp(Number(f.radius) || 0, 0, 12); f.force = clamp(Number(f.force) || 0, 0, 32); f.damage = clamp(Number(f.damage) || 0, 0, 1000);
    f.crater = clamp(Number(f.crater) || 0, 0, 3); f.ammo = Number.isInteger(f.ammo) ? f.ammo : -1; f.size = clamp(Number(f.size) || 0.22, 0.05, 1);
    out.push(f);
  }
  return out;
}
