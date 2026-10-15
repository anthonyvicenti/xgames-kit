// mechanic: health (track K2). Hit points (or none: hits only knock), knockback with ragdoll and get-up, death and
// respawn, invulnerability after respawn. The local player's hit points are on the kit's HUD (kit/ui/hud.js, CONTRACT §6g).
// README.md has ownership and API.
//
//   const hp = ctx.mechanics.get('health');
//   hp.onDamage(d => { if (d.from && d.knocked) d.from.score += 1; });   // host only
//   hp.damage(target, 1, { from: shooter, impulse: { x: 4, y: 3, z: 0 } });
//
// Fair play (kit/core/fair.js, CONTRACT §6c, on unless config/game.json → fair.on is false): damage() on a player who is
// down, out or protected, during the round's start grace, or from a bot when enough bots are already on that human, does
// nothing and returns false, and onDamage does not fire (F2, F3, F5, F7, F8); a knock lasts fair.downSeconds (F1); a
// hit with `push: true` (a stream tick, contact damage) shoves and never knocks over (F6); a respawn goes to the spawn
// farthest from the other live players, and protection counts from when the player can move (F4).
import { createPool } from './logic.js';
import { spawnOf } from '../../core/util.js';
import { farthestSpawn } from '../../core/fair-logic.js';

export const id = 'health';
export const examples = ['bonked: knocked over, gets up', 'three hearts, respawn after 3 s', 'water balloon hits'];

const D = { hp: 3, regen: 0, regenDelay: 3, ragdollOnHit: true, getUpSeconds: 1.5, respawnSeconds: 3, respawnInvuln: 1.5, respawnZone: '', killY: -8, meter: true, label: 'Health', color: '#ff5e6c', soundHurt: '', soundDown: '' };
const kebab = s => s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
const num = (description, minimum, maximum) => ({ type: 'number', description, minimum, maximum });
export const params = {
  type: 'object', additionalProperties: true,
  properties: {
    hp: { ...num('Hit points (0: no meter, a hit only knocks the player over)', 0, 100), default: D.hp },
    regen: { ...num('Hit points regained per second once left alone', 0, 20), default: D.regen },
    regenDelay: { ...num('Seconds without a hit before regeneration starts', 0, 30), default: D.regenDelay },
    ragdollOnHit: { type: 'boolean', default: D.ragdollOnHit, description: 'A hit with an impulse knocks the body over (ragdoll / knockdown animation)' },
    getUpSeconds: { ...num('Seconds a knocked player stays down when fair play is off (with it on, fair.downSeconds rules)', 0, 8), default: D.getUpSeconds },
    respawnSeconds: { ...num('Seconds a player at 0 hp stays out (0: never returns this round)', 0, 60), default: D.respawnSeconds },
    respawnInvuln: { ...num('Seconds of protection after respawning', 0, 10), default: D.respawnInvuln },
    respawnZone: { type: 'string', default: D.respawnZone, description: 'World zone to respawn in ("": the player\'s own spawn point)' },
    killY: { ...num('Falling below this height (m) counts as falling out of the world', -200, 0), default: D.killY },
    meter: { type: 'boolean', default: D.meter, description: 'Kept for old configs; the kit HUD always shows hit points when hp > 0 (CONTRACT §6g)' },
    label: { type: 'string', default: D.label, description: 'Meter label' },
    color: { type: 'string', default: D.color, description: 'Meter colour' },
    soundHurt: { type: 'string', default: D.soundHurt, description: 'Sound id when someone loses hit points ("": none)' },
    soundDown: { type: 'string', default: D.soundDown, description: 'Sound id when someone is knocked out ("": none)' },
  },
};
const vs = (name, label, type, extra = {}) => ({ id: `mechanic.health.${kebab(name)}`, label, group: 'mechanics', type, source: { pointer: `{base}/${name}` }, tier: 'advanced', facet: type === 'color' ? 'look' : 'gameplay', ...extra });
export const slots = [
  vs('hp', 'Hit points', 'integer', { tier: 'main', rank: 68, constraints: { min: 0, max: 100 } }),
  vs('getUpSeconds', 'Seconds down after a knock (fair play off)', 'number', { rank: 24, constraints: { min: 0, max: 8, unit: 's' } }),
  vs('respawnSeconds', 'Respawn time', 'number', { tier: 'main', rank: 58, constraints: { min: 0, max: 60, unit: 's' } }),
  vs('color', 'Health meter colour', 'color', { rank: 40 }),
  vs('label', 'Health meter label', 'text', { constraints: { maxLength: 24 } }),
  vs('regen', 'Regeneration per second', 'number', { constraints: { min: 0, max: 20 } }),
  vs('regenDelay', 'Regeneration delay', 'number', { constraints: { min: 0, max: 30, unit: 's' } }),
  vs('respawnInvuln', 'Protection after respawn', 'number', { constraints: { min: 0, max: 10, unit: 's' } }),
  vs('ragdollOnHit', 'Hits knock the body over', 'boolean'),
  vs('killY', 'Fall-out height', 'number', { constraints: { min: -200, max: 0, unit: 'm' } }),
  vs('soundHurt', 'Hurt sound id', 'text', { constraints: { maxLength: 40 } }),
  vs('soundDown', 'Knocked-out sound id', 'text', { constraints: { maxLength: 40 } }),
];

const r1 = v => Math.round(v * 10) / 10;
const unsub = (arr, fn) => () => { const i = arr.indexOf(fn); if (i >= 0) arr.splice(i, 1); };

export function create(ctx, params = {}) {
  const P = { ...D, ...params };
  const V = k => { const sid = `mechanic.health.${kebab(k)}`; try { return ctx.assets?.has(sid) ? ctx.assets.value(sid, P[k]) : P[k]; } catch { return P[k]; } };
  const pool = createPool({ hp: V('hp'), regen: V('regen'), regenDelay: V('regenDelay'), respawnSeconds: V('respawnSeconds'), respawnInvuln: V('respawnInvuln'), getUpSeconds: ctx.fair?.on ? ctx.fair.params.downSeconds : V('getUpSeconds') });
  const L = { damage: [], down: [], respawn: [], hurt: [] };
  const lastSeen = new Map();       // every copy: the hp last seen per id (the edge for onHurt)
  // the game's effect style (config/game.json → fx, kit/vfx/styles.js) shows each hurt as a damage number over the body,
  // in the HUD's number style; the vfx module is loaded only by a game with a style that has numbers
  let vfx = null;
  if (ctx.config?.fx && ctx.config.fx.numbers !== 'none') import('../../vfx/index.js').then(m => { vfx = m.vfxOf(ctx); }).catch(e => console.warn(`gf-three health: damage numbers need the vfx module (${e.message})`));
  let S = null, demoAt = 0;
  const demoHurt = (() => { try { return new URLSearchParams(globalThis.location?.search ?? '').get('gf-demo') === 'health.hurt'; } catch { return false; } })();
  const now = () => ctx.time.now;
  const player = idOrP => (typeof idOrP === 'string' ? ctx.players.get(idOrP) : idOrP);

  // F4: the spawn farthest from the other live players (fair play), else the player's own seat
  function spawnFor(p) {
    const F = ctx.fair, n = ctx.world?.spawns?.length ?? 0;
    if (F?.on && F.params.respawnFar && n > 1) {
      const pts = Array.from({ length: n }, (_, i) => spawnOf(ctx.world, i));
      const others = ctx.players.list().filter(o => o !== p && o.alive !== false).map(o => ({ x: o.position.x, z: o.position.z }));
      return pts[farthestSpawn(pts, others)];
    }
    return spawnOf(ctx.world, p.seat);
  }
  function respawn(p) {
    let pos = null, yaw = p.yaw;
    const zone = V('respawnZone') && ctx.world?.zone?.(V('respawnZone'));
    // in the zone on open ground every seat reaches (worlds/placement.js), never a random point in the sea or a wall
    if (zone) { pos = ctx.world.place?.('respawn', 1, { zone: V('respawnZone'), rng: () => ctx.rng(), clear: 0.5, away: 0 })?.[0] ?? zone.random(ctx.rng); yaw = Math.atan2(-pos.x, -pos.z); } else { const s = spawnFor(p); pos = s; yaw = s.yaw; }
    pool.revive(p.id, now()); p.alive = true;
    p.teleport({ x: pos.x, y: pos.y ?? 0, z: pos.z }, yaw);
    for (const fn of L.respawn.slice()) try { fn({ player: p }); } catch (e) { console.error(e); }
  }

  const api = {
    id, params: P,
    /** Host (a non-host copy forwards to the host). Hurt `target` by `amount`. opts: {from, impulse {x,y,z} m/s, knockSeconds, push, point, source}.
     *  push: a continuous attack (a stream tick, contact damage): it shoves and never knocks over (fair play F6).
     *  → true when it counted (false: dead, protected, or refused by fair play: down, grace, too many bots on one human). */
    damage(target, amount, opts = {}) {
      const t = player(target); if (!t) return false;
      if (!ctx.host) {
        const i = opts.impulse;
        ctx.net.send('health:dmg', { t: t.id, a: amount, ...(opts.from ? { f: opts.from.id } : {}), ...(i ? { i: [i.x, i.y, i.z].map(n => Math.round(n * 100) / 100) } : {}), ...(opts.knockSeconds !== undefined ? { s: opts.knockSeconds } : {}), ...(opts.push ? { p: 1 } : {}) }, 'host');
        return true;
      }
      if (!S) return false;
      const F = ctx.fair?.on ? ctx.fair : null;
      if (F) { const why = F.blocked(t, { from: opts.from ?? null }); if (why) { F.refuse(why); return false; } }
      const shove = !!opts.push && !!F;
      const wantKnock = !!opts.impulse && V('ragdollOnHit') && !shove && (!F || F.canKnock(t));
      const r = pool.damage(t.id, amount, now(), { knock: wantKnock });
      if (!r.applied) return false;
      F?.noteHit(t, opts.from ?? null);
      if (r.knocked && wantKnock) { if (!t.knock(opts.impulse, opts.knockSeconds ?? V('getUpSeconds'))) r.knocked = false; }
      else if (F && opts.impulse && !r.lethal && (shove || !V('ragdollOnHit'))) t.push?.(opts.impulse);
      const info = { target: t, from: opts.from ?? null, amount, hp: r.hp, max: V('hp'), lethal: r.lethal, knocked: r.knocked, source: opts.source ?? null, point: opts.point ?? null };
      for (const fn of L.damage.slice()) try { fn(info); } catch (e) { console.error(e); }
      if (r.lethal) api.down(t, opts.from ?? null, opts.impulse);
      return true;
    },
    /** Host: take a player out (0 hp, or falling out). They respawn after respawnSeconds unless that is 0. */
    down(target, from = null, impulse = null) {
      const t = player(target); if (!t || !ctx.host) return;
      pool.kill(t.id, now()); t.alive = false;
      t.knock?.(impulse ?? { x: 0, y: 4, z: 0 }, Math.max(0.6, V('respawnSeconds')), { out: true });
      for (const fn of L.down.slice()) try { fn({ target: t, from }); } catch (e) { console.error(e); }
    },
    heal(target, amount) { const t = player(target); if (!t) return 0; if (!ctx.host) { ctx.net.send('health:heal', { t: t.id, a: amount }, 'host'); return -1; } return pool.heal(t.id, amount); },
    /** Host: bring a downed player back now. */
    revive(target) { const t = player(target); if (t && ctx.host) respawn(t); },
    /** Hit points of a player (every copy, from the host's snapshot). hp:0 games answer 0. */
    hpOf(target) { const t = player(target); if (!t || !S) return 0; return ctx.host ? pool.hp(t.id) : (S.h?.[t.id] ?? V('hp')); },
    maxHp: () => V('hp'),
    /** Seconds until an out player respawns (the host's copy; other copies answer null). */
    respawnIn: target => { const t = player(target); if (!t || !ctx.host) return null; const s = pool.deadLeft(t.id, now()); return s === null ? null : s; },
    /** Is this body down right now (knocked, ragdolled, getting up, or out): fair play's view when it is on (every copy), else the pool's (host). */
    isDown: target => { const t = player(target); if (!t) return false; return ctx.fair?.on ? ctx.fair.isDown(t) : pool.isDown(t.id, now()); },
    /** Protected (after getting up or respawning). */
    isProtected: target => { const t = player(target); if (!t) return false; return (ctx.fair?.on && ctx.fair.isProtected(t)) || (ctx.host && pool.invulnerable(t.id, now())); },
    /** Host: protect a player for `seconds`. */
    protect(target, seconds) { const t = player(target); if (t) pool.makeInvulnerable(t.id, now(), seconds); },
    /** Host: damage {target, from, amount, hp, lethal, knocked, source, point}. → unsubscribe */
    onDamage(fn) { L.damage.push(fn); return unsub(L.damage, fn); },
    /** Host: a player went down {target, from}. */
    onDown(fn) { L.down.push(fn); return unsub(L.down, fn); },
    /** Host: a player respawned {player}. */
    onRespawn(fn) { L.respawn.push(fn); return unsub(L.respawn, fn); },
    /** Every copy, on the edge when someone's hit points drop {player, hp, delta}. */
    onHurt(fn) { L.hurt.push(fn); return unsub(L.hurt, fn); },
    reset() { pool.reset(); lastSeen.clear(); },
    update(dt) {
      if (!S) { if (!(ctx.shared && ctx.players && ctx.me)) return; S = ctx.shared.register('hp', { h: {} }); }
      const hp0 = V('hp');
      if (ctx.host && ctx.round?.phase === 'playing') {
        // QA's staged moment (?gf-demo=health.hurt, verify check 21): the local player loses 1 hit point every 2.5 s from
        // 3 s into the round (a push: it never knocks over), so the HUD's health has something to follow
        if (demoHurt && hp0 > 0 && ctx.me && (ctx.round?.clock ?? ctx.time?.round ?? 0) > 3 && (demoAt += dt) >= 2.5) { demoAt = 0; api.damage(ctx.me, 1, { push: true, source: 'demo' }); }
        for (const p of ctx.players.list()) {
          if (!pool.has(p.id)) pool.hp(p.id);                              // everyone has a record from the start
          if (p.position.y < V('killY')) { if (hp0 > 0 && p.alive !== false) { api.down(p, null, null); } else if (hp0 <= 0) { const s = spawnOf(ctx.world, p.seat); p.teleport(s, s.yaw); } }
        }
        for (const id of pool.due(now())) { const p = ctx.players.get(id); if (p) respawn(p); else pool.remove(id); }
        pool.regen(dt, now());
        if (hp0 > 0) { const snap = {}; for (const p of ctx.players.list()) snap[p.id] = r1(pool.hp(p.id)); S.h = snap; }
      }
      // every copy: edges for onHurt and the sound
      if (hp0 > 0) {
        const h = S.h ?? {};
        for (const p of ctx.players.list()) {
          const v = h[p.id]; if (v === undefined) continue;
          const was = lastSeen.get(p.id);
          if (was !== undefined && v < was - 1e-6) {
            // a hit on a player reads on every screen: the body flinches (gf-humanoid-1 `hit`) with its hurt face, and
            // the kit HUD flashes for the local player (kit/ui/hud.js listens to onHurt)
            if (v > 0) { p.character?.play?.('hit', { fade: 0.05 }); p.character?.express?.('hurt', 0.6); }
            if (V('soundHurt')) ctx.audio?.play(V('soundHurt'), { at: p.position, optional: true });
            if (v <= 0 && V('soundDown')) ctx.audio?.play(V('soundDown'), { at: p.position, optional: true });
            if (vfx && p.position) vfx.damage({ x: p.position.x, y: p.position.y + (p.character?.height ?? 1.7) + 0.35, z: p.position.z }, v - was, { color: p.color ?? null });
            for (const fn of L.hurt.slice()) try { fn({ player: p, hp: v, delta: v - was }); } catch (e) { console.error(e); }
          }
          lastSeen.set(p.id, v);
        }
      }
    },
    /** `health:dmg` and `health:heal` from a player's copy, to the host. */
    event(name, d, from) {
      if (!ctx.host || !S) return;
      const t = ctx.players.get(d?.t); if (!t || !Number.isFinite(d.a)) return;
      if (name === 'dmg') api.damage(t, Math.min(Math.max(0, d.a), 1000), { from: ctx.players.get(d.f) ?? null, impulse: Array.isArray(d.i) ? { x: d.i[0], y: d.i[1], z: d.i[2] } : null, knockSeconds: d.s, push: !!d.p, source: 'remote' });
      else if (name === 'heal') pool.heal(t.id, Math.min(Math.max(0, d.a), 1000));
    },
    dispose() {},
  };
  return api;
}

// ---------------------------------------------------------------------------------------------------------------------
// The part's manifest (tools/catalog.mjs MANIFEST lists the fields): what `create` composes and refuses by, what the
// catalog tells a pitch, the handlers and traps of the rules.js stub, and verify check 15's sign of life. The tools
// read it in Node; nothing in play does.
// ---------------------------------------------------------------------------------------------------------------------
export const manifest = {
  id, examples, params,
  describe: 'Health, knockback, ragdoll and get-up, respawn',
  rank: 40,
  needs: { parts: [], world: [] },
  uses: [],
  owns: () => [],
  state: { key: 'hp', fields: { h: '{ playerId: hit points }' } },
  events: [
    { name: 'onDamage', on: 'host', args: '{ target, from, amount, hp, lethal, knocked, source }', when: 'a hit that counted (fair play let it through)' },
    { name: 'onDown', on: 'host', args: '{ target, from }', when: 'a player ran out of hit points' },
    { name: 'onRespawn', on: 'host', args: '{ player }', when: 'a player came back' },
    { name: 'onHurt', on: 'every copy', args: '{ player, hp, delta }', when: 'a player\'s hit points changed' },
  ],
  sync: { owner: 'host', how: 'the host owns hit points, down and respawn timers and protection' },
  note: [
    'The kit\'s HUD already shows the local player\'s hit points, knocked-down state and protection: never draw them in rules.js.',
    'Projectile, melee, waves and the boss call hp.damage themselves; rules.js calls it only for its own hazards.',
    'hp 0 means no hit points: a hit only knocks over. respawnSeconds 0 means out for the round.',
  ],
  stub: {
    as: 'hp',
    worked: 'hp.onDamage(d => { if (d.from && d.knocked) d.from.score += 1; });',
    traps: [
      'hp.damage returns false and onDamage stays silent when fair play refuses the hit (the target is down or protected, or the round has just begun): do not score outside onDamage',
      'a hit that repeats every frame (a hazard, contact) passes { push: true }, so it shoves and never knocks over',
    ],
  },
  signs: {
    sample: sh => (sh.hp ? { hp: sh.hp.h ?? {} } : null),
    // reported, never failed on its own: a round where nobody is hurt is a round
    judge: v => v.add('hit points', 'note', 'shared.hp.h', v.others.hpFell ? `hit points fell (lowest ${v.others.hpMin})` : 'nobody lost hit points on these pages'),
  },
};
