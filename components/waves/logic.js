// waves: the pure logic (no three.js, no DOM): the wave director, enemy stats per wave, steering and targeting.
// Node tests: research/gf-three/tests/k2-waves.test.mjs.

/** Stats of wave n (1-based): how many, how tough, how fast. */
export function waveStats(n, { startCount = 3, growth = 2, maxAlive = 16, hp = 2, hpGrowth = 0.5, speed = 2.6, speedGrowth = 0.12, maxSpeed = 6 } = {}) {
  const k = Math.max(0, n - 1);
  return { count: Math.max(1, Math.round(startCount + growth * k)), hp: Math.max(1, Math.round(hp + hpGrowth * k)), speed: Math.min(maxSpeed, speed * (1 + speedGrowth * k)), maxAlive };
}

/**
 * The wave director. Phases: 'wait' (before the first wave) → 'spawn' (enemies come out `spawnEvery` s apart, up to
 * maxAlive at once) → 'fight' (all out, until all dead, or `interval` s after the wave began when mode is 'timer') →
 * 'rest' (restSeconds) → the next wave. Call update(dt, alive) each host frame; it returns how many to spawn now.
 */
export function createDirector(opts = {}) {
  const o = { firstDelay: 3, restSeconds: 4, interval: 15, mode: 'clear', spawnEvery: 0.6, maxWaves: 0, ...opts };
  const d = { wave: 0, phase: 'wait', t: o.firstDelay, left: 0, spawnT: 0, waveT: 0, done: false, stats: null };
  const begin = () => { d.wave++; d.stats = waveStats(d.wave, o.stats ?? {}); d.left = d.stats.count; d.phase = 'spawn'; d.spawnT = 0; d.waveT = 0; };
  d.update = (dt, alive) => {
    let spawn = 0;
    if (d.done) return 0;
    if (d.phase === 'wait' || d.phase === 'rest') { d.t -= dt; if (d.t <= 0) { if (o.maxWaves && d.wave >= o.maxWaves) { d.done = true; d.phase = 'done'; return 0; } begin(); } }
    if (d.phase === 'spawn' || d.phase === 'fight') d.waveT += dt;
    if (d.phase === 'spawn') {
      d.spawnT -= dt;
      while (d.left > 0 && d.spawnT <= 0 && alive + spawn < d.stats.maxAlive) { spawn++; d.left--; d.spawnT += o.spawnEvery; }
      if (d.spawnT < 0) d.spawnT = 0;
      if (d.left <= 0) d.phase = 'fight';
    }
    if (d.phase === 'fight') {
      const timeUp = o.mode === 'timer' && d.waveT >= o.interval;
      if ((alive + spawn === 0) || timeUp) { d.phase = 'rest'; d.t = timeUp && alive > 0 ? 0 : o.restSeconds; }
    }
    return spawn;
  };
  d.reset = () => Object.assign(d, { wave: 0, phase: 'wait', t: o.firstDelay, left: 0, spawnT: 0, waveT: 0, done: false, stats: null });
  return d;
}

/** Points on a ring just inside the area's edge, evenly spread with a random start. rng() → 0..1 */
export function edgePoint(area, rng, inset = 1.5) {
  const hx = Math.max(1, area.hx - inset), hz = Math.max(1, area.hz - inset);
  const side = Math.floor(rng() * 4), u = rng() * 2 - 1;
  return side === 0 ? { x: area.cx + u * hx, z: area.cz - hz } : side === 1 ? { x: area.cx + u * hx, z: area.cz + hz } : side === 2 ? { x: area.cx - hx, z: area.cz + u * hz } : { x: area.cx + hx, z: area.cz + u * hz };
}

/** The nearest candidate {x, z, ...} to (x, z), or null. */
export function nearestOf(x, z, list) {
  let best = null, bd = Infinity;
  for (const c of list) { const d = Math.hypot(c.x - x, c.z - z); if (d < bd) { best = c; bd = d; } }
  return best ? { target: best, dist: bd } : null;
}

/** Unit steering vector toward a goal with separation from neighbours (so a crowd spreads). → {x, z, dist} */
export function steer(e, goal, others, { separation = 1.0, strength = 1.4 } = {}) {
  let dx = goal.x - e.x, dz = goal.z - e.z; const dist = Math.hypot(dx, dz) || 1; dx /= dist; dz /= dist;
  let sx = 0, sz = 0;
  for (const o of others) {
    if (o === e) continue;
    const ox = e.x - o.x, oz = e.z - o.z, d = Math.hypot(ox, oz);
    if (d > 1e-4 && d < separation) { const k = (separation - d) / separation; sx += ox / d * k; sz += oz / d * k; }
  }
  let x = dx + sx * strength, z = dz + sz * strength; const l = Math.hypot(x, z) || 1;
  return { x: x / l, z: z / l, dist };
}

/** Rotate a heading (unit x, z) by `a` radians. */
export const rotate = (h, a) => ({ x: h.x * Math.cos(a) - h.z * Math.sin(a), z: h.x * Math.sin(a) + h.z * Math.cos(a) });

/** Keep (x, z) inside the area. */
export const clampTo = (area, x, z, inset = 0.6) => ({ x: Math.max(area.minX + inset, Math.min(area.maxX - inset, x)), z: Math.max(area.minZ + inset, Math.min(area.maxZ - inset, z)) });

/**
 * Hurt an enemy {hp}. → {dead, hp, hit}. opts.now: the frame's clock; damage in one frame is one hit (a shot and the
 * rules' own damage on it count once), so e.hits counts the hits it took. opts.oneHit: any damage kills (the spec's
 * `oneHitKills`, only when the creator asked for it).
 */
export function hurtEnemy(e, amount, { now = null, oneHit = false } = {}) {
  const a = Math.max(0, amount);
  let hit = false;
  if (a > 0 && (now === null || e.lastHitAt !== now)) { e.hits = (e.hits ?? 0) + 1; e.lastHitAt = now; hit = true; }
  e.hp = oneHit && a > 0 ? 0 : Math.max(0, e.hp - a);
  return { dead: e.hp <= 0, hp: e.hp, hit };
}

/** How many hits of `damage` an enemy with `hp` takes to go down (oneHit: 1). Infinity when damage is 0. */
export const hitsToKill = (hp, damage, oneHit = false) => (oneHit ? 1 : damage > 0 ? Math.max(1, Math.ceil(hp / damage - 1e-9)) : Infinity);

/** The middle value of a list of numbers (null for none). */
export function median(list) {
  const a = list.filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

/**
 * Where a hit pushes an enemy (a flinch you can see): `dist` metres along the impulse's direction on the ground, or
 * farther for a bigger impulse (impulse × 0.05, the old rule). → {x, z}
 */
export function knockOf(impulse, dist) {
  const x = impulse?.x ?? 0, z = impulse?.z ?? 0, l = Math.hypot(x, z);
  if (l < 1e-6) return { x: 0, z: 0 };
  const d = Math.max(dist, l * 0.05) / l;
  return { x: x * d, z: z * d };
}

/** A hit's flash: 1 at the hit, easing to 0 over `secs`. */
export const flashAt = (t, secs = 0.18) => (t < 0 || t >= secs ? 0 : 1 - t / secs);

/**
 * A death that reads: the body falls for the first `fallShare` of `seconds` (the knockdown clip, or a stand-in tipping
 * over), then sinks into the floor. → {fall 0..1, sink 0..1, done}
 */
export function deathPose(t, seconds = 1.6, fallShare = 0.55) {
  const fallT = seconds * fallShare, sinkT = Math.max(0.05, seconds - fallT);
  const fall = Math.min(1, Math.max(0, t / fallT)), sink = Math.min(1, Math.max(0, (t - fallT) / sinkT));
  return { fall, sink, done: t >= seconds };
}

/**
 * QA's staged moment (`?gf-demo=waves.hit`): the spot `dist` metres ahead of a player along `heading` ({x, z}), kept
 * inside the area. → {x, z}
 */
export function demoSpot(p, heading, area, dist = 6) {
  const l = Math.hypot(heading?.x ?? 0, heading?.z ?? 0), hx = l > 1e-6 ? heading.x / l : 0, hz = l > 1e-6 ? heading.z / l : 1;
  return clampTo(area, p.x + hx * dist, p.z + hz * dist, 1.2);
}
