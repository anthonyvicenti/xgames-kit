// mechanic pickup, the forge runtime's implementation (vendored as gf/three/mechanics/pickup/impl/forge/index.js; the
// boot loads it through gf/forge/mechanics.js). The same behaviour as the three runtime's (components/pickup/README.md):
// spots in the world, walk into one and it is yours, it comes back after a while; it heals, scores or only calls the
// rules. Played with what forge has:
//
//   the spots       laid by the host round the middle of the arena, clear of the walls (config/world.json colliders),
//                   held in ctx.shared 'pk' ({p: [[x, y, z, state]]}: 1 there, 0 waiting to come back)
//   who takes one   the host, from every player's place in the core (its own and each joiner's, which the host's core
//                   simulates): walking into a spot within `radius`, the swept path between two frames
//   heal            the core's health on the host (SET_HEALTH: never past the player's full health); the joiner's copy
//                   gets it in the host's next snapshot, as every hit
//   score           the round's score of whoever took it (the session sends scores)
//   drawn           every copy, from the shared rows: the `prop` slot's model (prop.<name>), else the kit's coin
//                   (fight.coin) tinted to `color`, turning and bobbing at waist height; the collect sound on every copy
//
//   const pk = ctx.mechanics.get('pickup');
//   pk.onCollect(({ player, index, effect, value, point, how }) => …)     // host only, as on three
//   pk.list() → [{index, present, x, y, z}]; pk.nearest(p) → spot or null; pk.spawnAt({x, z}) (host) → index
//
// Not on forge (said in observe().notOnForge): a press of E to take one (forge's E raises a fallen friend; collect
// 'press' takes a spot by walking into it, as 'touch'), the carry effect (no carry mechanic on forge), zones.
import { touches, createSpots } from '../../logic.js';
import { createWalk, boxSurfaces } from '../../../../world/placement.js';

export const id = 'pickup';
const D = { prop: '', count: -1, zone: '', size: 0.5, color: '#ffd23f', effect: 'auto', value: 1, radius: 1.0, collect: 'both', reach: 2.0, action: 'interact', prompt: true, respawnSeconds: 8, bob: true, spin: true, maxSpots: 24, soundCollect: 'coin', marker: 'auto' };
/** Spots placed when count is -1 (the three runtime takes the game prop's count; forge's props are the world's). */
export const DEFAULT_COUNT = 4;

/**
 * Where `count` spots go on a forge world (its config/world.json: `size`, the box `colliders`, its ground a box too, and
 * the `spawns`): open floor every seat reaches, clear of every box a walker meets and spread out (the shared placement,
 * kit/world/placement.js, over the boxes). rng: the round's seeded draw. Pure. → [{x, y, z}]
 */
export function placeSpots(count, { world = {}, rng = Math.random, numbers = {} } = {}) {
  const [w, d] = Array.isArray(world.size) ? world.size : [18, 18];
  const walk = createWalk({
    area: () => [-w / 2, -d / 2, w / 2, d / 2], cell: 0.5, numbers,
    surfaces: boxSurfaces({ boxes: world.colliders ?? [], numbers }),
    seats: () => (world.spawns ?? []).map(s => ({ x: s[0] ?? s.x, y: s[1] ?? s.y ?? 0, z: s[2] ?? s.z })),
  });
  return walk.place('pickup', count, { rng, clear: 0.6, gap: 1.6, away: 1.5 });
}

export function create(ctx, params = {}, K) {
  const P = { ...D, ...params };
  const V = k => K.valueOf(ctx, 'pickup', P, k, D[k]);
  const collected = K.listeners('pickup.onCollect');
  const pool = createSpots(Math.max(1, Math.min(40, Number(V('maxSpots')) || 24)));
  const effectOf = () => { const e = V('effect'); return e === 'auto' || e === 'carry' ? 'score' : e; };
  const prop = String(V('prop') || '');
  const marks = K.createMarks(ctx, { slot: prop && ctx.assets?.has?.(`prop.${prop}`) ? `prop.${prop}` : 'fight.coin', size: Number(V('size')) || 0.5, tint: prop ? null : V('color'), mix: prop ? 0 : 0.55, spin: V('spin') ? 1.6 : 0, bob: V('bob') ? 0.08 : 0 });
  const last = new Map();         // player id → their place last frame (the swept touch)
  const seen = [];                // every copy: each spot's state as last drawn (the collect sound on a change)
  const stats = { touch: 0, sounds: 0 };
  let S = null, placed = false;

  /** The host: lay the spots for a round. */
  function lay() {
    const W = ctx.assets?.config?.('world') ?? {};
    const n = Number(V('count'));
    const count = Math.max(0, Math.min(pool.spots.length ? 40 : 40, n < 0 ? DEFAULT_COUNT : n));
    let q = ((ctx.seed ?? 1) % 2147483646) + 1; const rng = () => ((q = (q * 16807) % 2147483647) / 2147483647);
    const at = placeSpots(count, { world: W, rng });
    pool.spots.length = 0;
    for (const a of at) pool.add(a.x, a.y, a.z, Math.max(0, Number(V('respawnSeconds')) || 0));
    placed = true;
  }
  const rows = () => pool.spots.map(s => [s.x, s.y, s.z, s.state === 1 ? 1 : 0]);

  function collect(player, i, how) {
    const s = pool.spots[i];
    if (!s || !pool.take(i, ctx.time.now)) return false;
    const effect = effectOf(), value = Number(V('value')) || 0;
    if (effect === 'score') player.score = (player.score ?? 0) + value;
    else if (effect === 'heal') {
      const n = K.coreIdOf(ctx, player), h = player.health;
      if (n != null && h && h.max > 0) ctx.forge.cmd.setHealth(n, Math.min(h.max, h.hp + value), h.max, h.armor ?? 0);
    }
    stats[how] = (stats[how] ?? 0) + 1;
    S.p = rows();
    collected.emit({ player, index: i, effect, value, point: { x: s.x, y: s.y, z: s.z }, how });
    return true;
  }

  return {
    setup(c) {
      S = c.shared.register('pk', { p: [] });
      if (c.host) { lay(); S.p = rows(); }
    },
    update(dt) {
      if (!S) return;
      const phase = ctx.round?.phase;
      if (ctx.host) {
        if (phase === 'countdown' && !placed) { lay(); S.p = rows(); }
        if (phase === 'results' || phase === 'lobby') placed = false;
        if (pool.tick(ctx.time.now).length) S.p = rows();
        if (phase === 'playing') {
          const r = Number(V('radius')) || 1;
          for (const p of ctx.players.list()) {
            if (p.ghost || p.alive === false || p.down) { last.delete(p.id); continue; }
            const cur = { x: p.position.x, y: p.position.y, z: p.position.z }, prev = last.get(p.id) ?? cur;
            last.set(p.id, cur);
            pool.spots.forEach((s, i) => { if (s.state === 1 && touches(s, prev, cur, r)) collect(p, i, 'touch'); });
          }
        }
      }
      // every copy: draw the host's rows; a spot that went is heard where it was
      const p = S.p ?? [];
      p.forEach((row, i) => {
        const on = row[3] === 1;
        if (seen[i] === true && !on) { stats.sounds++; const snd = V('soundCollect'); if (snd) ctx.audio?.play(snd, { optional: true, at: { x: row[0], y: row[1] + 0.9, z: row[2] } }); }
        seen[i] = on;
        marks.set(i, { x: row[0], y: row[1], z: row[2], on });
      });
      for (let i = p.length; i < seen.length; i++) { marks.drop(i); seen[i] = false; }
      marks.tick(dt);
    },
    /** Host: a callback each time a spot is taken. → unsubscribe */
    onCollect: fn => collected.on(fn),
    /** Every copy: the spots as the host last sent them. */
    list: () => (S?.p ?? []).map((r, i) => ({ index: i, present: r[3] === 1, x: r[0], y: r[1], z: r[2] })),
    nearest(p) {
      let best = null, bd = Infinity;
      for (const s of (S?.p ?? []).map((r, i) => ({ index: i, present: r[3] === 1, x: r[0], y: r[1], z: r[2] }))) { if (!s.present) continue; const d = Math.hypot(s.x - p.position.x, s.z - p.position.z); if (d < bd) { bd = d; best = s; } }
      return best;
    },
    /** Host: a new spot at {x, z} (the rules' own). → its index, or -1 when every spot is in use */
    spawnAt({ x, y = 0, z }, respawn = Number(V('respawnSeconds')) || 0) { if (!ctx.host || !S) return -1; const i = pool.add(x, y, z, respawn); S.p = rows(); return i; },
    /** Host: take spot i for `player` as if they walked into it (the rules' own; QA). */
    take: (player, i) => (ctx.host && S ? collect(player, i, 'rules') : false),
    observe: () => ({ spots: (S?.p ?? []).length, present: (S?.p ?? []).filter(r => r[3] === 1).length, effect: effectOf(), stats: { ...stats }, marks: marks.observe(), notOnForge: ['collect by a press of E (forge\'s E raises a fallen friend): a spot is taken by walking into it', 'the carry effect (no carry mechanic on forge): auto and carry score', 'zones'] }),
  };
}
