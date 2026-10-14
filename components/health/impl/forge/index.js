// mechanic health, the forge runtime's implementation (vendored as gf/three/mechanics/health/impl/forge/index.js; the
// boot loads it through gf/forge/mechanics.js). The same behaviour as the three runtime's (components/health/README.md)
// where forge has it, on the core's own health:
//
//   hit points      the core's (forge-core Health: spec.tables.player.health and armour; enemies' hits; on a joiner the
//                   host's in each snapshot). So the hit points are the tables' scale (100 by default), not the `hp`
//                   param's (three's pips): `hp` is not read on forge
//   damage, heal    the host's commands to the core (DAMAGE, SET_HEALTH); on another copy they go nowhere and return -1,
//                   as a guest's call does on three
//   down            forge's own: with a friend standing a player at zero is down until a friend raises them (E held
//                   beside them); alone, or with nobody standing, they are out
//   respawn         `respawnSeconds` after a player is out (not down), the host brings them back at their spawn with full
//                   health (0: they stay out this round). A rule that ends the round when everyone is out ends it first
//   regen           `regen` hit points a second once a player has not been hurt for `regenDelay` seconds (the host)
//   hurt            onHurt on every copy (the HUD's red edge, a sound), onDamage on the host with who did it
//   shared          ctx.shared 'hp' ({h: {playerId: hit points}}), as on three: what the gates read of it
//
//   const hp = ctx.mechanics.get('health');
//   hp.onDamage(d => { if (d.from) d.from.score += 1; });   // host only: {player, amount, from, hp}
//   hp.damage(target, 20, { from: shooter });  hp.heal(target, 25);  hp.hpOf(p);  hp.maxHp();  hp.isDown(p)
//
// Not on forge (observe().notOnForge): `hp` (the tables' health is the meter), the ragdoll and get-up knock (forge's hits
// flinch and stagger in the core), protection after a respawn (respawnInvuln), killY (the core's floor limit), zones.

export const id = 'health';
const D = { hp: 3, regen: 0, regenDelay: 3, respawnSeconds: 3, respawnInvuln: 1.5, label: 'Health', color: '#ff5e6c', soundHurt: '', soundDown: '' };

export function create(ctx, params = {}, K) {
  const P = { ...D, ...params };
  const V = k => K.valueOf(ctx, 'health', P, k, D[k]);
  const L = { hurt: K.listeners('health.onHurt'), damage: K.listeners('health.onDamage'), down: K.listeners('health.onDown'), respawn: K.listeners('health.onRespawn') };
  const lastHp = new Map(), lastHurt = new Map(), outSince = new Map(), lastBy = new Map(), regenOwed = new Map();
  const stats = { hurt: 0, damage: 0, down: 0, respawn: 0, healed: 0 };
  const player = t => (t && typeof t === 'object' ? t : ctx.players?.get?.(t) ?? null);
  const nid = p => K.coreIdOf(ctx, p);
  const now = () => ctx.time.now;
  const hpNow = p => p?.health?.hp ?? 0, maxOf = p => p?.health?.max ?? 0;
  const set = (p, hp) => { const n = nid(p), h = p.health; if (n == null || !h) return false; ctx.forge.cmd.setHealth(n, Math.max(0, Math.min(h.max, hp)), h.max, h.armor ?? 0); h.hp = Math.max(0, Math.min(h.max, hp)); return true; };
  let off = [], S = null, sent = -1;

  return {
    setup(c) {
      S = c.shared.register('hp', { h: {} });
      // who hit whom (the host's core says it as HIT events: attacker and target are core ids)
      off.push(c.forge.on('hit', e => { const p = K.playerOfCore(c, e.target); if (p) lastBy.set(p.id, e.attacker); }));
      // down and out (forge-feel revive.rs, hurt.rs): the host hears them first
      for (const name of ['player-down', 'player-dead']) off.push(c.forge.on('rule', e => {
        if (e.name !== name || !c.host) return;
        const p = K.playerOfCore(c, e.entity); if (!p) return;
        stats.down++; L.down.emit({ player: p, from: K.playerOfCore(c, e.a) ?? null, out: name === 'player-dead' });
        const snd = V('soundDown'); if (snd) c.audio?.play(snd, { optional: true, at: { x: p.position.x, y: p.position.y + 1, z: p.position.z } });
      }));
    },
    update(dt) {
      const playing = ctx.round?.phase === 'playing';
      // the host's hit points in the shared state, a few times a second
      if (ctx.host && S && ctx.time.now - sent >= 0.25) { sent = ctx.time.now; S.h = Object.fromEntries((ctx.players?.list?.() ?? []).filter(p => !p.ghost && p.health).map(p => [p.id, Math.round(hpNow(p) * 10) / 10])); }
      for (const p of ctx.players?.list?.() ?? []) {
        if (p.ghost || !p.health) continue;
        const hp = hpNow(p), was = lastHp.get(p.id);
        lastHp.set(p.id, hp);
        if (was !== undefined && hp < was - 1e-3) {
          lastHurt.set(p.id, now()); stats.hurt++;
          const from = K.playerOfCore(ctx, lastBy.get(p.id) ?? 0);
          L.hurt.emit({ player: p, delta: hp - was, hp });
          if (ctx.host) { stats.damage++; L.damage.emit({ player: p, amount: was - hp, from, hp }); }
          const snd = V('soundHurt'); if (snd && playing) ctx.audio?.play(snd, { optional: true, at: { x: p.position.x, y: p.position.y + 1, z: p.position.z } });
        }
        if (!ctx.host || !playing) { outSince.delete(p.id); continue; }
        // out (not down): back after respawnSeconds at the player's own spawn, full health
        const out = p.alive === false && !p.down;
        if (!out) outSince.delete(p.id);
        else if (!outSince.has(p.id)) outSince.set(p.id, now());
        const wait = Number(V('respawnSeconds')) || 0;
        if (out && wait > 0 && now() - outSince.get(p.id) >= wait) {
          outSince.delete(p.id);
          const n = nid(p), h = p.health, at = ctx.world?.spawn?.(p.seat ?? 0);
          if (n != null && h?.max > 0) {
            ctx.forge.cmd.setHealth(n, h.max, h.max, h.armor ?? 0);
            if (at) ctx.forge.cmd.teleport(n, { x: at.x, y: at.y ?? 0.05, z: at.z }, Number.isFinite(at.yaw) ? at.yaw + Math.PI : 0, 0);
            stats.respawn++; L.respawn.emit({ player: p });
          }
        }
        // regen: once left alone for regenDelay seconds, a few times a second
        const regen = Number(V('regen')) || 0;
        if (regen > 0 && p.alive !== false && !p.down && hp < maxOf(p) && now() - (lastHurt.get(p.id) ?? -1e9) >= (Number(V('regenDelay')) || 0)) {
          const owed = (regenOwed.get(p.id) ?? 0) + regen * dt;
          if (owed >= 1 || hp + owed >= maxOf(p)) { set(p, hp + owed); lastHp.set(p.id, hpNow(p)); regenOwed.set(p.id, 0); stats.healed++; } else regenOwed.set(p.id, owed);
        }
      }
    },
    /** Host: `amount` damage to a player, from `opts.from` (a player). → true, or -1 on another copy (nothing done). */
    damage(target, amount, opts = {}) {
      const t = player(target); if (!t) return false;
      if (!ctx.host) return -1;
      const n = nid(t); if (n == null || t.alive === false) return false;
      ctx.forge.cmd.damage(n, Math.max(0, Number(amount) || 0), nid(player(opts.from)) ?? 0, [0, 0, 0]);
      return true;
    },
    /** Host: `amount` hit points back, never past full. → the hit points now, or -1 on another copy. */
    heal(target, amount) { const t = player(target); if (!t) return 0; if (!ctx.host) return -1; set(t, hpNow(t) + (Number(amount) || 0)); return hpNow(t); },
    /** Host: bring a player who is out back now. */
    revive(target) { const t = player(target); if (t && ctx.host && t.health?.max > 0) set(t, t.health.max); },
    hpOf: target => hpNow(player(target)),
    maxHp: () => maxOf(ctx.me) || (Number(ctx.tables?.player?.health) || 100),
    isDown: target => !!player(target)?.down,
    isOut: target => player(target)?.alive === false && !player(target)?.down,
    respawnIn: target => { const t = player(target); if (!t || !ctx.host || !outSince.has(t.id)) return null; return Math.max(0, (Number(V('respawnSeconds')) || 0) - (now() - outSince.get(t.id))); },
    isProtected: () => false,
    onHurt: fn => L.hurt.on(fn),
    onDamage: fn => L.damage.on(fn),
    onDown: fn => L.down.on(fn),
    onRespawn: fn => L.respawn.on(fn),
    observe: () => ({ stats: { ...stats }, players: (ctx.players?.list?.() ?? []).filter(p => !p.ghost).map(p => ({ id: p.id, hp: hpNow(p), max: maxOf(p), down: !!p.down, alive: p.alive !== false })),
      notOnForge: ['hp (the tables\' player.health is the meter)', 'the ragdoll knock and get-up', 'respawnInvuln', 'killY', 'respawnZone'] }),
    dispose() { for (const f of off) f?.(); off = []; },
  };
}
