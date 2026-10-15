// gf-three bots: players that fill seats and drive QA. The host owns every bot; other copies draw them from the
// host's world. Each bot has a brain (player.bot) that steers its controller through player.input and presses its
// actions through player.actions, exactly the fields the local player's input fills, so rules treat both alike.
//
// Every frame on the host: brain.begin() → rules.bot(ctx, player, dt) if the rules have one, else the default
// (fight with the game's projectile when it has one, else wander) → brain.finish(dt). In rules.bot, steer with:
//   player.bot.seek(pos, {stop})   player.bot.flee(pos)   player.bot.wander()   player.bot.stop()
//   player.bot.aimAt(pos)          player.bot.face(yaw)   player.bot.press('primary' | 'secondary' | 'interact' | 'jump')
//   player.bot.hold(action, secs)  player.bot.mode / .target (read)   player.bot.rng() (the bots' own seeded stream)
// and pick who to attack with the kit's fair target helper (CONTRACT §6c, F7):
//   const t = ctx.bots.target(player, { range: 8 });    // a player that can be hit, spread across bots, or null
//   if (t) ctx.bots.attack(player, t, { stop: 4 });      // seek to `stop` m, aim (human error), hold primary once ready
//   ctx.bots.aim(player, t)   ctx.bots.ready(player)     // the parts of attack()
// Fair play holds every bot's fire (primary and secondary) during the round's start grace and while it aims at a
// player who can't be hit (down, protected, or already fought by enough bots), whatever rules.bot asks.
import { ACTIONS } from '../core/input.js';
import { areaOf } from '../core/util.js';
import { pickTarget, botTraits } from '../core/fair-logic.js';

const FIRE = new Set(['primary', 'secondary']);

export function createBrain(ctx, player, rng) {
  const presses = new Set(), holds = new Map();
  let wanderAt = null, wanderT = 0, stuckT = 0, side = 1, faceYaw = null, aimDir = null, aimPoint = null;
  /** F5/F7: hold fire during the start grace, and at a player who can't be hit (the one nearest the aim point). */
  function hushed() {
    const F = ctx.fair; if (!F?.on) return false;
    if (F.grace) return true;
    if (!aimPoint) return false;
    let near = null, nd = 1.3;
    for (const o of ctx.players.list()) {
      if (o === player) continue;
      const d = Math.hypot(o.position.x - aimPoint.x, o.position.z - aimPoint.z);
      if (d < nd && Math.abs((o.position.y + 0.9) - (aimPoint.y ?? o.position.y + 0.9)) < 2.4) { nd = d; near = o; }
    }
    return !!near && !F.canHit(near, { from: player });
  }
  const b = {
    mode: 'wander', target: null, stopAt: 0.6, rng,
    seek(pos, { stop = 0.6 } = {}) { b.mode = 'seek'; b.target = pos; b.stopAt = stop; },
    flee(pos) { b.mode = 'flee'; b.target = pos; },
    wander() { b.mode = 'wander'; },
    stop() { b.mode = 'idle'; b.target = null; },
    face(yaw) { faceYaw = yaw; },
    aimAt(pos) {
      const p = player.position, dx = pos.x - p.x, dy = (pos.y ?? p.y) + 1 - (p.y + 1.2), dz = pos.z - p.z, l = Math.hypot(dx, dy, dz) || 1;
      aimDir = [dx / l, dy / l, dz / l]; faceYaw = Math.atan2(dx, dz); aimPoint = { x: pos.x, y: pos.y, z: pos.z };
    },
    press(action) { if (ACTIONS.includes(action)) presses.add(action); },
    hold(action, seconds = 0.3) { if (ACTIONS.includes(action)) { if (!holds.has(action)) presses.add(action); holds.set(action, seconds); } },
    /** Is this bot's fire held this frame by fair play (read after rules.bot; for tests and QA). */
    get hushed() { return hushed(); },

    /** Start of a frame: last frame's edges end; this frame's presses become edges. */
    begin() { faceYaw = null; aimDir = null; aimPoint = null; },
    /** End of a frame: turn the mode into movement input and the presses into action edges. */
    finish(dt) {
      const hush = hushed();
      for (const a of ACTIONS) {
        const s = player.actions[a], wasDown = s.down;
        const held = holds.has(a);
        if (held) { const t = holds.get(a) - dt; if (t <= 0) holds.delete(a); else holds.set(a, t); }
        const down = (presses.has(a) || held) && !(hush && FIRE.has(a));
        s.pressed = down && !wasDown;
        s.released = wasDown && !down;
        s.down = down;
      }
      presses.clear();
      const p = player.position, inp = player.input;
      let x = 0, z = 0;
      const A = areaOf(ctx.world);
      if (b.mode === 'wander') {
        wanderT -= dt;
        if (!wanderAt || wanderT <= 0 || Math.hypot(wanderAt.x - p.x, wanderAt.z - p.z) < 1) {
          // somewhere this bot can walk to from where it stands (the world's own ground: never out to sea or onto an
          // island with no way across), else anywhere in the play area
          wanderAt = ctx.world?.place?.('wander', 1, { rng, clear: 0.3, away: 0, from: p })?.[0] ?? { x: A.cx + (rng() * 2 - 1) * A.hx * 0.8, z: A.cz + (rng() * 2 - 1) * A.hz * 0.8 }; wanderT = 3 + rng() * 4;
        }
        const w = ctx.world?.via?.(p, wanderAt) ?? wanderAt;     // through the doors to another room, round a wall, up a ledge
        if (w.jump) b.press('jump');
        x = w.x - p.x; z = w.z - p.z;
      } else if (b.mode === 'seek' && b.target) {
        const w = ctx.world?.via?.(p, b.target) ?? b.target;
        if (w.jump) b.press('jump');
        x = w.x - p.x; z = w.z - p.z;
        if (Math.hypot(b.target.x - p.x, b.target.z - p.z) < b.stopAt) x = z = 0;
      } else if (b.mode === 'flee' && b.target) {
        x = p.x - b.target.x; z = p.z - b.target.z;
        // keep inside the play area: steer back in near the edge
        if (Math.abs(p.x - A.cx) > A.hx * 0.85) x = -Math.sign(p.x - A.cx) * 2; if (Math.abs(p.z - A.cz) > A.hz * 0.85) z = -Math.sign(p.z - A.cz) * 2;
      }
      const l = Math.hypot(x, z);
      if (l > 1e-3) { x /= l; z /= l; }
      // stuck against something: slide sideways for a moment
      const speed = player.controller?.state.speed ?? 1;
      if (l > 1e-3 && speed < 0.4) stuckT += dt; else stuckT = Math.max(0, stuckT - dt);
      // a world with placement (worlds/placement.js) routes round what is in the way; stuck anyway, a bot steps aside
      // only where it can stand, so it never walks off a ledge
      const W = ctx.world;
      if (stuckT > 0.6 && W?.isWalkable) {
        // a side step only onto ground a body can stand on (never off a ledge), else a hop; a wanderer picks elsewhere
        const sx = -z * side, sz = x * side;
        if (W.isWalkable(p.x + sx * 0.8, p.z + sz * 0.8, (p.y ?? 0) + 0.5)) { x = sx; z = sz; }
        if (stuckT > 1.4) { stuckT = 0; side = -side; b.press('jump'); if (b.mode === 'wander') wanderT = 0; }
      } else if (stuckT > 0.6) { const sx = -z * side, sz = x * side; x = sx; z = sz; if (stuckT > 1.4) { stuckT = 0; side = -side; b.press('jump'); } }
      inp.x = x; inp.z = z;
      inp.face = faceYaw ?? undefined;
      inp.aim = aimDir ?? undefined;
    },
  };
  return b;
}

/**
 * ctx.bots (host): the fair target helper (F7). One per game; every bot's memory of its target lives here, so bots
 * spread across targets: no two bots on one target while another target is in range.
 */
export function createBots(ctx) {
  const memo = new Map();   // bot id → { id (target), since, at, err: {x, z}, errAt }
  const traits = () => botTraits(ctx.fair?.params?.botSkill);
  const now = () => ctx.time.now;
  const teamOf = p => ctx.mechanics?.get?.('teams')?.teamOf?.(p) ?? -1;
  const friendly = (a, b) => { const tm = ctx.mechanics?.get?.('teams'); if (!tm?.teamOf || tm.friendlyFire !== false) return false; const x = teamOf(a); return x >= 0 && x === teamOf(b); };
  const hittable = (bot, o) => o !== bot && o.alive !== false && !friendly(bot, o) && (!ctx.fair?.on || ctx.fair.state(o) === 'control');
  const api = {
    /**
     * A target for this bot: a player that can be hit now (not down, protected or out; not a teammate when friendly
     * fire is off) within `range` m. Fewest other bots on it first, then the nearest, with a small pull toward the score
     * leader. prefer: 'spread' (default) | 'nearest' | 'leader'. During the round's start grace: null.
     */
    target(bot, { range = 10, prefer = 'spread' } = {}) {
      if (!bot) return null;
      if (ctx.fair?.grace) { memo.delete(bot.id); return null; }
      const t = now();
      const claims = new Map();
      for (const [id, m] of memo) if (id !== bot.id && t - m.at < 1) claims.set(m.id, (claims.get(m.id) ?? 0) + 1);
      const cands = ctx.players.list().filter(o => o !== bot).map(o => ({ id: o.id, x: o.position.x, z: o.position.z, score: o.score ?? 0, ok: hittable(bot, o), claims: claims.get(o.id) ?? 0, p: o }));
      const c = pickTarget(bot.position, cands, { range, prefer });
      if (!c) { memo.delete(bot.id); return null; }
      const m = memo.get(bot.id);
      if (!m || m.id !== c.id) memo.set(bot.id, { id: c.id, since: t, at: t, err: null, errAt: -9 });
      else m.at = t;
      return c.p;
    },
    /** Aim at the target's chest with a human error that shrinks with botSkill and changes now and then. */
    aim(bot, target) {
      if (!bot?.bot || !target) return;
      const m = memo.get(bot.id), d = Math.hypot(target.position.x - bot.position.x, target.position.z - bot.position.z);
      let e = { x: 0, z: 0 };
      if (m) {
        if (!m.err || now() - m.errAt > 0.6) { const a = bot.bot.rng() * Math.PI * 2, r = traits().aimError * d * (0.4 + bot.bot.rng() * 0.6); m.err = { x: Math.cos(a) * r, z: Math.sin(a) * r }; m.errAt = now(); }
        e = m.err;
      }
      bot.bot.aimAt({ x: target.position.x + e.x, y: target.position.y + 0.9, z: target.position.z + e.z });
    },
    /** May this bot fire at its target now: it has looked at it for its reaction time, and the hit would count. */
    ready(bot) {
      const m = memo.get(bot?.id); if (!m) return false;
      const t = ctx.players.get(m.id); if (!t) return false;
      if (now() - m.since < traits().reaction) return false;
      return !ctx.fair?.on || ctx.fair.canHit(t, { from: bot });
    },
    /** Seek to `stop` m from the target, aim, and hold `action` while ready (bursts: fire about `duty` of the time). */
    attack(bot, target, { stop = 4, action = 'primary', hold = 0.25 } = {}) {
      if (!bot?.bot || !target) return false;
      bot.bot.seek(target.position, { stop });
      api.aim(bot, target);
      if (!api.ready(bot)) return false;
      if (bot.bot.rng() < traits().duty * Math.min(1, (ctx.time.dt || 0.016) * 8)) bot.bot.hold(action, hold);
      return true;
    },
    /** This bot's current target id (or null). */
    targetOf: bot => memo.get(bot?.id)?.id ?? null,
    get traits() { return traits(); },
    reset() { memo.clear(); },
  };
  return api;
}

/**
 * Melee steering (track M, gf-scenic wave 1): a bot with the melee mechanic walks into the portal when a level's portal
 * is open; else goes for the nearest enemy (the waves mechanic's, or the boss), stops at its weapon's reach, faces it
 * and swings (holding the button runs the combo), sometimes a heavy attack, and dashes away from an enemy winding up
 * next to it as often as its skill allows (fair.botSkill); with nothing to fight it picks up loot nearby or opens a
 * chest; in a versus game it fights players fairly through ctx.bots.attack. → true when it found something to do
 */
export function meleeBot(ctx, player) {
  const M = id => { const m = ctx.mechanics?.get?.(id); return m && !m.standin ? m : null; };
  const melee = M('melee'), levels = M('levels'), waves = M('waves'), boss = M('boss'), loot = M('loot');
  if (!melee) return false;
  const b = player.bot, p = player.position, rng = b.rng;
  const act = k => melee.params?.[k] ?? { action: 'primary', heavyAction: 'secondary', dashAction: 'jump' }[k];
  const traits = ctx.bots?.traits ?? { reaction: 0.4, aimError: 0.1, duty: 0.6 };
  const dist = (x, z) => Math.hypot(x - p.x, z - p.z);
  // the portal is open: everyone in
  const ls = levels?.state?.();
  if (ls && (ls.phase === 'open' || ls.phase === 'travel') && ls.portal) { b.seek({ x: ls.portal.x, z: ls.portal.z }, { stop: 0.3 }); return true; }
  // the nearest enemy, or the boss
  const W = melee.weaponOf?.(player), reach = (W?.combo?.[0]?.reach ?? 2) * 0.9;
  let t = null, d = Infinity, danger = false;
  for (const e of waves?.enemies?.() ?? []) {
    const dd = dist(e.x, e.z);
    if (dd < d) { d = dd; t = { x: e.x, z: e.z, r: 0.45 }; }
    if (e.st === 1 && dd < 2.6) danger = true;            // winding up beside this bot
  }
  const bs = boss?.state?.();
  if (bs?.active && !bs.dead) { const dd = dist(bs.x, bs.z) - 1; if (dd < d) { d = dd; t = { x: bs.x, z: bs.z, r: 1.1, boss: true }; } if (bs.attack && dd < 5) danger = true; }
  if (t && d < 24) {
    if (danger && rng() < (1 - traits.reaction) * 0.08) { b.flee(t); if (act('dashAction')) b.press(act('dashAction')); return true; }
    b.seek(t, { stop: Math.max(0.6, reach * 0.65 + t.r) });
    b.aimAt({ x: t.x, y: (p.y ?? 0) + 0.9, z: t.z });
    if (d <= reach + t.r + 0.25 && rng() < traits.duty * Math.min(1, (ctx.time.dt || 0.016) * 9)) {
      if (act('heavyAction') && rng() < 0.12) b.press(act('heavyAction')); else b.hold(act('action') || 'primary', 0.18);
    }
    return true;
  }
  // nothing to fight: loot nearby (walk over coins and potions; open a chest)
  const drops = loot?.drops?.() ?? [];
  let best = null, bd = 12;
  for (const x of drops) { if (x.kind === 'open' || x.kind === 'weapon') continue; const dd = dist(x.x, x.z); if (dd < bd) { bd = dd; best = x; } }
  if (best) { b.seek(best, { stop: best.kind === 'chest' ? 1.1 : 0.2 }); if (best.kind === 'chest' && bd < 1.6) b.press('interact'); return true; }
  // a versus game: fight the players, fairly
  const hits = melee.params?.hitPlayers;
  if ((hits === true || (hits !== false && (ctx.config?.players?.mode ?? '') !== 'coop')) && ctx.bots) {
    const tp = ctx.bots.target(player, { range: 12 });
    if (tp) { ctx.bots.attack(player, tp, { stop: Math.max(0.8, reach * 0.65), action: act('action') || 'primary', hold: 0.18 }); return true; }
  }
  return false;
}

/**
 * Default behaviour when the rules have no bot(): with the melee mechanic, meleeBot; with a projectile mechanic, fight
 * fairly through ctx.bots (a target that can be hit, spread across bots, human reaction and aim) when one is nearer
 * than the nearest pickup; go for the nearest pickup (the world routes the way: round walls, over bridges, up ledges);
 * otherwise wander, and now and then jump.
 */
export function defaultBot(ctx, player) {
  if (player.alive === false) { player.bot.stop(); return; }
  const mel = ctx.mechanics?.get?.('melee');
  if (mel && !mel.standin && meleeBot(ctx, player)) return;
  // a pickup out in the world (the pickup part's spots, where every seat can get to them): the nearest is worth going
  // for, unless a player to fight is closer than it
  const pk = ctx.mechanics?.get?.('pickup');
  const spot = pk && !pk.standin ? pk.nearest?.(player.position) : null;
  const toSpot = spot ? Math.hypot(spot.x - player.position.x, spot.z - player.position.z) : Infinity;
  const prj = ctx.mechanics?.get?.('projectile');
  if (prj && !prj.standin && ctx.bots) {
    const stream = prj.params?.kind === 'continuous';
    const range = stream ? (prj.params?.streamReach ?? 9) * 0.85 : 12;
    // with pickups out, a bot fights in spells (a third of the time, each bot at its own moment), else it collects
    const spell = !spot || Math.floor(((ctx.time?.now ?? 0) + (player.seat ?? 0) * 2.3) / 5) % 3 === 0;
    const t = spell ? ctx.bots.target(player, { range: Math.min(range, toSpot + 2) }) : null;
    if (t) { ctx.bots.attack(player, t, { stop: stream ? range * 0.6 : 5, hold: stream ? 0.3 : 0.12 }); return; }
  }
  if (spot) { player.bot.seek(spot, { stop: 0.2 }); return; }
  player.bot.wander();
  if (player.bot.rng() < 0.004) player.bot.press('jump');
}
