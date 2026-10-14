// waves: enemy types (gf-scenic wave 1, track M). Pure logic: no three.js, no DOM. Node tests:
// research/gf-three/tests/k2-waves-types.test.mjs.
//
// A game whose waves params carry `types` gets enemies that fight like an action game's: each type has a body role,
// hit points, speed, damage, reach, a behaviour, a telegraph and a score. A spec with no `types` plays exactly as
// before (contact attacks every attackInterval, kit/mechanics/waves/index.js's untyped path).
//
// Behaviours:
//   chaser    walks up and swings in an arc in front of it after a readable windup
//   lunger    stops at a distance, winds up (a lane on the ground shows where), then dashes through that lane
//   ranged    keeps its distance and shoots slow bolts a player can walk out of the way of
//   brute     slow and heavy: a long windup with a wide ring, a swing that knocks a player down; light hits do not
//             interrupt it (poise)
//   shielded  a chaser that blocks hits from the front while its guard is up (heavy attacks break guards; behind it,
//             or while it swings, it is open)
// Attack tokens (games.fun's own Knuckle Row, research/foundations/trials/brawler/source/src/model.mjs canGrant): at
// most `attackTokens` enemies (plus half a token for each extra player) wind up or swing at once; the rest circle at a
// waiting distance. That keeps a crowd readable: the player always sees who is about to hit them.

export const BEHAVIOURS = ['chaser', 'lunger', 'ranged', 'brute', 'shielded'];
/** Enemy states on the wire: 0 moving, 1 winding up (telegraph), 2 attacking, 3 recovering. */
export const ST = { move: 0, windup: 1, attack: 2, recover: 3 };

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const wrap = a => Math.atan2(Math.sin(a), Math.cos(a));

/** Each behaviour's defaults. Times in seconds, distances in metres, speeds in m/s, arcs in degrees. */
export const TYPE_DEFAULTS = Object.freeze({
  chaser: { hp: 4, speed: 2.8, damage: 1, reach: 1.5, arc: 110, windup: 0.6, active: 0.15, recover: 0.65, cooldown: 1.1, knock: 4, telegraph: 'sector', score: 10, height: 1.7, poise: false, knockRes: 0 },
  lunger: { hp: 3, speed: 3.2, damage: 1, reach: 0.9, arc: 60, windup: 0.75, active: 0.38, recover: 0.9, cooldown: 1.4, knock: 6, telegraph: 'lane', score: 12, height: 1.6, lungeSpeed: 11, lungeRange: 6, poise: false, knockRes: 0 },
  ranged: { hp: 3, speed: 2.4, damage: 1, reach: 11, arc: 30, windup: 0.85, active: 0.1, recover: 0.7, cooldown: 1.6, knock: 3, telegraph: 'line', score: 12, height: 1.65, keepMin: 5, keepMax: 9, boltSpeed: 7, boltRadius: 0.28, poise: false, knockRes: 0 },
  brute: { hp: 10, speed: 1.9, damage: 2, reach: 2.2, arc: 150, windup: 1.05, active: 0.2, recover: 1.0, cooldown: 1.6, knock: 9, telegraph: 'ring', score: 25, height: 2.3, knockdown: true, poise: true, knockRes: 0.6 },
  shielded: { hp: 5, speed: 2.4, damage: 1, reach: 1.5, arc: 100, windup: 0.65, active: 0.15, recover: 0.7, cooldown: 1.2, knock: 4, telegraph: 'sector', score: 15, height: 1.75, blockArc: 130, poise: false, knockRes: 0.2 },
});

/**
 * The game's types (params.types), each filled from its behaviour's defaults: [{id, role, behaviour, ...}].
 * Unknown behaviours fall back to chaser. `from`: the first level (1-based) a type appears on; `weight`: how often.
 */
export function normalizeTypes(list, { enemyRole = 'enemy', color = '#7a5cff' } = {}) {
  if (!Array.isArray(list)) return [];
  const out = [], seen = new Set();
  for (const [i, t0] of list.entries()) {
    if (!t0 || typeof t0 !== 'object') continue;
    const b = BEHAVIOURS.includes(t0.behaviour) ? t0.behaviour : 'chaser', d = TYPE_DEFAULTS[b];
    let id = String(t0.id ?? `${b}-${i + 1}`).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').slice(0, 24) || `type-${i + 1}`;
    while (seen.has(id)) id = `${id}-${i + 1}`;
    seen.add(id);
    const o = { ...d, ...t0 };
    out.push({
      id, behaviour: b, role: typeof t0.role === 'string' && t0.role ? t0.role : enemyRole, name: String(t0.name ?? id).slice(0, 32),
      color: typeof t0.color === 'string' ? t0.color : color,
      hp: clamp(num(o.hp, d.hp), 1, 500), speed: clamp(num(o.speed, d.speed), 0.3, 10), damage: clamp(num(o.damage, d.damage), 0, 50),
      reach: clamp(num(o.reach, d.reach), 0.4, 30), arc: clamp(num(o.arc, d.arc), 10, 360),
      windup: clamp(num(o.windup, d.windup), 0.15, 3), active: clamp(num(o.active, d.active), 0.05, 2), recover: clamp(num(o.recover, d.recover), 0.1, 4),
      cooldown: clamp(num(o.cooldown, d.cooldown), 0, 10), knock: clamp(num(o.knock, d.knock), 0, 30), telegraph: ['sector', 'ring', 'lane', 'line'].includes(o.telegraph) ? o.telegraph : d.telegraph,
      score: clamp(num(o.score, d.score), 0, 1000), height: clamp(num(o.height, d.height), 0.4, 6), knockdown: !!o.knockdown, poise: !!o.poise,
      knockRes: clamp(num(o.knockRes, d.knockRes ?? 0), 0, 1), lungeSpeed: clamp(num(o.lungeSpeed, d.lungeSpeed ?? 10), 2, 30), lungeRange: clamp(num(o.lungeRange, d.lungeRange ?? 6), 1, 20),
      keepMin: clamp(num(o.keepMin, d.keepMin ?? 4), 1, 30), keepMax: clamp(num(o.keepMax, d.keepMax ?? 9), 2, 40), boltSpeed: clamp(num(o.boltSpeed, d.boltSpeed ?? 7), 1, 30), boltRadius: clamp(num(o.boltRadius, d.boltRadius ?? 0.28), 0.05, 2),
      blockArc: clamp(num(o.blockArc, d.blockArc ?? 0), 0, 360), weight: clamp(num(t0.weight, 1), 0, 100), from: clamp(Math.round(num(t0.from, 1)), 1, 99),
      weapon: typeof t0.weapon === 'string' ? t0.weapon : '', weaponGrip: t0.weaponGrip ?? null, shield: typeof t0.shield === 'string' ? t0.shield : '', shieldGrip: t0.shieldGrip ?? null,
    });
  }
  return out;
}

/** A type for an enemy of `level` (1-based): weighted among the types that appear by then (rng() → 0..1). → index */
export function pickType(types, level, rng, mix = null) {
  const ok = types.map((t, i) => ({ i, w: (t.from <= level ? (mix?.[t.id] ?? t.weight) : 0) })).filter(x => x.w > 0);
  if (!ok.length) return 0;
  let r = rng() * ok.reduce((s, x) => s + x.w, 0);
  for (const x of ok) { r -= x.w; if (r <= 0) return x.i; }
  return ok[ok.length - 1].i;
}

/** How many enemies may wind up or swing at once (Knuckle Row: + half a token per extra player). */
export const tokenCap = (base, players) => Math.max(1, Math.round(base + Math.max(0, players - 1) * 0.5));

/**
 * One enemy's frame on the host. e: {x, z, st, t, cd, token, facing, atkYaw, stun, hitDone, side, ...}; T: its type;
 * w: {target: {id, x, z} | null, dt, now, grant() → bool, release(), avoid(e, vx, vz) → {x, z} (steering with
 * separation and walls), clamp(x, z) → {x, z}, others: [{x, z}] (players, for the waiting ring)}.
 * Returns what to do: [{type: 'hit', arc, reach, knock, damage, knockdown, yaw} | {type: 'lunge-hit', radius, ...} |
 * {type: 'bolt', from: {x, z}, yaw, speed, radius, damage} | {type: 'windup'} | {type: 'attack'}]
 */
export function stepEnemy(e, T, w) {
  const out = [], dt = w.dt;
  e.t += dt; e.cd = Math.max(0, e.cd - dt);
  const tg = w.target;
  const toTarget = tg ? Math.atan2(tg.x - e.x, tg.z - e.z) : e.facing;
  const d = tg ? Math.hypot(tg.x - e.x, tg.z - e.z) : Infinity;
  const go = (dirYaw, speed) => { const v = w.avoid(e, Math.sin(dirYaw) * speed * dt, Math.cos(dirYaw) * speed * dt); const c = w.clamp(e.x + v.x, e.z + v.z); e.x = c.x; e.z = c.z; };
  const turnTo = (yaw, rate) => { e.facing += wrap(yaw - e.facing) * Math.min(1, dt * rate); };
  const toRecover = () => { e.st = ST.recover; e.t = 0; };
  // staggered: a light hit stops it a moment; it loses its swing unless it has poise
  if (e.stun > 0) {
    e.stun -= dt;
    if ((e.st === ST.windup || e.st === ST.attack) && !(T.poise && !e.broken)) { w.release(); e.token = false; toRecover(); }
    if (!(T.poise && (e.st === ST.windup || e.st === ST.attack))) return out;
  }
  switch (e.st) {
    case ST.move: {
      if (!tg) break;
      turnTo(toTarget, 8);
      if (T.behaviour === 'ranged') {
        if (d < T.keepMin) go(toTarget + Math.PI, T.speed);
        else if (d > T.keepMax) go(toTarget, T.speed);
        else go(toTarget + e.side * Math.PI / 2, T.speed * 0.45);
        if (d <= T.reach && e.cd <= 0 && w.grant()) { e.token = true; e.st = ST.windup; e.t = 0; e.atkYaw = toTarget; out.push({ type: 'windup' }); }
        break;
      }
      const lunger = T.behaviour === 'lunger';
      const strikeAt = lunger ? T.lungeRange : T.reach + 0.15;
      // with a token (Knuckle Row): close in and wind up once in range; a token held too long goes back
      if (e.token) {
        e.tokenT = (e.tokenT ?? 0) + dt;
        if (d <= strikeAt && (!lunger || d >= 1.6)) { e.st = ST.windup; e.t = 0; e.atkYaw = toTarget; e.tokenT = 0; out.push({ type: 'windup' }); break; }
        if (e.tokenT > 2.5) { e.token = false; e.tokenT = 0; w.release(); e.cd = 0.5; break; }
        if (lunger && d < 1.6) go(toTarget + Math.PI, T.speed); else go(toTarget, T.speed * 1.1);
        break;
      }
      if (e.cd <= 0 && d <= strikeAt + 4 && w.grant()) { e.token = true; e.tokenT = 0; break; }
      // without a token: wait on a ring round the target, sidestepping (the crowd stays readable)
      const waitAt = (lunger ? T.lungeRange : T.reach) + 1.4;
      if (d > waitAt) go(toTarget, T.speed);
      else if (d < waitAt - 0.8 && !lunger) go(toTarget + Math.PI, T.speed * 0.6);
      else go(toTarget + e.side * Math.PI / 2, T.speed * 0.4);
      break;
    }
    case ST.windup: {
      // the swing tracks its target for most of the windup, then locks (a player who reads it can step out)
      if (tg && e.t < T.windup * (T.behaviour === 'lunger' ? 0.55 : 0.6)) { e.atkYaw = toTarget; }
      turnTo(e.atkYaw, 14);
      if (e.t >= T.windup) {
        e.st = ST.attack; e.t = 0; e.hitDone = false; e.facing = e.atkYaw; out.push({ type: 'attack' });
        if (T.behaviour === 'ranged') out.push({ type: 'bolt', from: { x: e.x, z: e.z }, yaw: e.atkYaw, speed: T.boltSpeed, radius: T.boltRadius, damage: T.damage });
        else if (T.behaviour !== 'lunger') out.push({ type: 'hit', yaw: e.atkYaw, arc: T.arc, reach: T.reach + 0.35, damage: T.damage, knock: T.knock, knockdown: T.knockdown });
      }
      break;
    }
    case ST.attack: {
      if (T.behaviour === 'lunger') {
        go(e.atkYaw, T.lungeSpeed * Math.max(0.25, 1 - e.t / T.active));
        if (!e.hitDone) out.push({ type: 'lunge-hit', radius: 0.95, yaw: e.atkYaw, damage: T.damage, knock: T.knock, knockdown: T.knockdown });
      }
      if (e.t >= T.active) toRecover();
      break;
    }
    case ST.recover: {
      if (e.t >= T.recover) { e.st = ST.move; e.t = 0; e.cd = T.cooldown * (0.7 + 0.6 * (w.rng?.() ?? 0.5)); if (e.token) { e.token = false; w.release(); } e.broken = false; }
      break;
    }
  }
  return out;
}

/** Players a swing hits: within reach (+ their radius) and the arc in front. targets [{id, x, z}] → ids */
export function swingTargets(e, yaw, arc, reach, targets, radius = 0.45) {
  const half = (arc * Math.PI) / 360, out = [];
  for (const t of targets) {
    const dx = t.x - e.x, dz = t.z - e.z, d = Math.hypot(dx, dz);
    if (d > reach + radius) continue;
    if (d > radius + 0.3 && Math.abs(wrap(Math.atan2(dx, dz) - yaw)) > half + Math.atan2(radius, Math.max(0.1, d))) continue;
    out.push(t.id);
  }
  return out;
}

/** A guard up: a shielded enemy that is not swinging blocks a hit from in front (within blockArc). */
export function guardBlocks(e, T, from, { guardBreak = false } = {}) {
  if (T.behaviour !== 'shielded' || guardBreak || e.st === ST.windup || e.st === ST.attack || !(T.blockArc > 0)) return false;
  return Math.abs(wrap(Math.atan2(from.x - e.x, from.z - e.z) - e.facing)) <= (T.blockArc * Math.PI) / 360;
}

/** A random point in a circle zone's ring (inner..outer share of its radius), at least `away` m from every point in `avoid`. */
export function arenaPoint(zone, rng, { inner = 0.45, outer = 0.9, avoid = [], away = 6, tries = 12 } = {}) {
  const at = zone.at ?? [0, 0, 0], cx = at.x ?? at[0] ?? 0, cz = at.z ?? at[2] ?? 0, R = [].concat(zone.size ?? 10)[0];
  let best = null, bestD = -1;
  for (let i = 0; i < tries; i++) {
    const a = rng() * Math.PI * 2, r = R * (inner + (outer - inner) * Math.sqrt(rng()));
    const p = { x: cx + Math.cos(a) * r, z: cz + Math.sin(a) * r };
    const dmin = avoid.length ? Math.min(...avoid.map(q => Math.hypot(q.x - p.x, q.z - p.z))) : Infinity;
    if (dmin >= away) return p;
    if (dmin > bestD) { bestD = dmin; best = p; }
  }
  return best ?? { x: cx, z: cz };
}
