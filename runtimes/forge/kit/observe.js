// gf-forge's part of window.__game (runtimes/CONTRACT.md §6), vendored into a game as gf/forge/observe.js. The forge
// boot (gf/three/core/boot-forge.js) builds the observation from the shared kit's pieces; what only forge knows is here:
//
//   const part = forgePart(host, { playerOf, eye });   // the core's events as the kit's event log reads a part's
//   createEventLog(ctx, { list: [part], modules: new Map([['forge', { manifest: part.manifest }]]) })
//   const fm = frameMeter();  fm.frame(rawSeconds)       // every frame; fm.observe() → {fps, frameMs}
//
// The event log (gf/three/core/events.js) subscribes to a part's events by their names; a forge game has no mechanic
// modules, so the core is its part: each event a player takes part in reaches the log as `forge.<name>`, with `who`
// naming the players (from, target, player) and `at` where it happened. Gate C's measure 38 holds each to an answer on
// that player's own screen, and gate D's measure 12 traces each score to one of them.
//
//   forge.onHit      a hit a player landed or took (the core's HIT: attacker, target, point)
//   forge.onKill     a kill a player made or suffered (the core's KILL)
//   forge.<rule>     a rule event that names a player (its entity, or the player in its last field: enemy-down names
//                    the killer, coin the player who took it, player-down the one who fell, …): RULES below

/** The core's rule events that may name a player (forge-core, forge-ai, forge-feel, forge-play: `sim.rule` / fx.rules). */
export const RULES = ['enemy-down', 'boss-down', 'coin', 'pickup', 'kill', 'lap', 'player-down', 'player-revived', 'player-out', 'player-dead',
  'card-picked', 'card-passed', 'card', 'bought', 'buy-refused', 'shop-card', 'set-bonus', 'burning', 'guard-down', 'shield-break'];

const r2 = v => Math.round(v * 100) / 100;
const pt = v => (Array.isArray(v) && v.length >= 3 && v.every(Number.isFinite) ? { x: r2(v[0]), y: r2(v[1]), z: r2(v[2]) } : null);

/**
 * The core as a part of the event log. host: gf/forge/host.js; playerOf(coreId) → the session's player object (it
 * has id, score and position) or null. → {id, standin, manifest: {events}, on<Name>(fn)…}
 */
export function forgePart(host, { playerOf }) {
  const names = ['onHit', 'onKill', ...RULES];
  const subs = new Map(names.map(n => [n, []]));
  const emit = (name, a) => { for (const fn of subs.get(name) ?? []) { try { fn(a); } catch { /* the log's own */ } } };
  const part = { id: 'forge', standin: false, manifest: { id: 'forge', events: names.map(name => ({ name })) } };
  for (const n of names) part[n] = fn => { subs.get(n).push(fn); };
  const both = (e, name) => {
    const from = playerOf(e.attacker), target = playerOf(e.target);
    if (!from && !target) return;
    emit(name, { ...(from ? { from } : {}), ...(target ? { target } : {}), point: pt(e.point) });
  };
  host.on('hit', e => both(e, 'onHit'));
  host.on('kill', e => both(e, 'onKill'));
  const rules = new Set(RULES);
  host.on('rule', e => {
    if (!rules.has(e.name)) return;
    const player = playerOf(e.entity) ?? (Number.isInteger(e.d) && e.d > 0 ? playerOf(e.d) : null);
    if (player) emit(e.name, { player, at: player.position ? { x: r2(player.position.x), y: r2(player.position.y), z: r2(player.position.z) } : null });
  });
  return part;
}

/** The frame cost as the screen sees it: frames a second and the median frame in milliseconds, over the last 2 s. */
export function frameMeter({ keep = 120 } = {}) {
  const ms = [];
  return {
    frame(raw) { if (raw > 0 && raw < 1) { ms.push(raw * 1000); if (ms.length > keep) ms.shift(); } },
    observe() {
      if (!ms.length) return { fps: null, frameMs: null };
      const s = [...ms].sort((a, b) => a - b), med = s[Math.floor(s.length / 2)], mean = ms.reduce((a, b) => a + b, 0) / ms.length;
      return { fps: Math.round(10000 / mean) / 10, frameMs: Math.round(med * 10) / 10 };
    },
  };
}

/**
 * What is under the crosshair, along the view from the eye (the core has no ray query; this reads what it holds): the
 * nearest of an enemy (an upright capsule of `radius` round its feet to `height`), a world collider box
 * (config/world.json colliders) and the ground (y 0), within `far` metres. eye, dir: [x, y, z]; enemies: [{net, at:
 * [x, y, z], dead}]; colliders: [{min, max}]. → {dist, point: {x, y, z}, hit: 'enemy' | 'world' | 'ground' | null, net?}
 */
export function aimOf(eye, dir, { enemies = [], colliders = [], far = 60, radius = 0.45, height = 1.9 } = {}) {
  const [ox, oy, oz] = eye, [dx, dy, dz] = dir;
  let best = { t: far, hit: null, net: null };
  // the ground
  if (dy < -1e-6) { const t = -oy / dy; if (t > 0 && t < best.t) best = { t, hit: 'ground', net: null }; }
  // the world's boxes (slabs)
  for (const b of colliders) {
    let t0 = 0, t1 = best.t, ok = true;
    for (let a = 0; a < 3 && ok; a++) {
      const o = eye[a], d = dir[a], lo = b.min[a], hi = b.max[a];
      if (Math.abs(d) < 1e-9) { if (o < lo || o > hi) ok = false; continue; }
      let ta = (lo - o) / d, tb = (hi - o) / d; if (ta > tb) [ta, tb] = [tb, ta];
      t0 = Math.max(t0, ta); t1 = Math.min(t1, tb); if (t0 > t1) ok = false;
    }
    if (ok && t0 > 0.05 && t0 < best.t) best = { t: t0, hit: 'world', net: null };
  }
  // the enemies: the ray against each one's vertical capsule, read as a cylinder
  const h2 = dx * dx + dz * dz;
  for (const e of enemies) {
    if (e.dead || !Array.isArray(e.at)) continue;
    const cx = e.at[0], cy = e.at[1], cz = e.at[2], px = ox - cx, pz = oz - cz;
    if (h2 < 1e-9) continue;
    const b = px * dx + pz * dz, c = px * px + pz * pz - radius * radius, disc = b * b - h2 * c;
    if (disc < 0) continue;
    const t = (-b - Math.sqrt(disc)) / h2;
    if (t <= 0.05 || t >= best.t) continue;
    const y = oy + dy * t;
    if (y >= cy && y <= cy + height * (e.scale ?? 1)) best = { t, hit: 'enemy', net: e.net };
  }
  const t = best.t;
  return { dist: r2(t), point: { x: r2(ox + dx * t), y: r2(oy + dy * t), z: r2(oz + dz * t) }, hit: best.hit, ...(best.net != null ? { net: best.net } : {}) };
}
