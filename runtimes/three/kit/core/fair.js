// gf-three fair play (kit-owned, on by default): ctx.fair. The rules are in fair-logic.js (F1–F8 there); this file
// runs them in a game. CONTRACT §6c.
//
// The host referees: it watches every player's control (an owned player's controller and character; a friend's pose
// word) and decides whether a hit counts. Mechanics ask it before they damage, knock or report a hit (health,
// projectile, waves); p.knock() refuses a knock on a player who is down or protected. Every copy shows protection
// (a shimmer on the body, in the fair.protect-color slot) from the host's list in ctx.shared ('_fair').
//
//   ctx.fair.on                         fair play is on (config/game.json → fair.on)
//   ctx.fair.params                     {downSeconds, protectSeconds, startGrace, botSkill, botsPerTarget, respawnFar, protectColor}
//   ctx.fair.split                      {total, ragdoll, getup}: how one knock spends downSeconds
//   ctx.fair.canHit(target, {from})     host: does a hit on target count now → bool
//   ctx.fair.blocked(target, {from})    host: null, or why not ('out' | 'down' | 'protected' | 'grace' | 'busy')
//   ctx.fair.state(p)                   'control' | 'down' | 'protected' | 'out' (every copy; the host's view is the truth)
//   ctx.fair.isDown(p), isProtected(p), grace (bool), protect(p, seconds)
import { fairConfig, knockSplit, createReferee, inControl } from './fair-logic.js';

export function createFair(ctx) {
  const P = fairConfig(ctx.config?.fair);
  const split = knockSplit(P.downSeconds);
  const ref = createReferee(P);
  const stats = { knocks: 0, refused: 0, blocked: { out: 0, down: 0, protected: 0, grace: 0, busy: 0 } };
  let S = null, lastRound = null, glowT = 0;
  const glowing = new Set();
  const now = () => ctx.time.now;
  const player = idOrP => (typeof idOrP === 'string' ? ctx.players?.get(idOrP) : idOrP);
  const clock = () => (ctx.round?.phase === 'playing' ? ctx.time.round : 0);

  /** In control right now, on this copy: an owned player from its controller and character, any other from its pose. */
  function controlOf(p) {
    if (p.alive === false) return false;
    const c = p.controller;
    if (p.owned && c) { const cs = p.character?.state; return !(c.state?.stun > 0) && (!cs || cs === 'anim'); }
    return inControl(p.anim, p.alive);
  }
  const protectedHere = p => (ctx.host ? ref.isProtected(p.id, now()) : !!S?.pr?.includes(p.id));

  const api = {
    get on() { return P.on; },
    params: P, split, stats,
    /** F5: the start of a round, when no hit counts and bots hold fire. */
    get grace() { return P.on && ctx.round?.phase === 'playing' && (ctx.host ? ctx.time.round < P.startGrace : !!S?.g); },
    controlOf,
    /** Host: null when a hit on `target` counts now, else the reason it does not. */
    blocked(target, { from = null } = {}) {
      const t = player(target); if (!t || !P.on || !ctx.host) return null;
      const f = player(from);
      return ref.canHit(t.id, now(), { from: f?.id ?? null, fromBot: !!f?.isBot, targetBot: !!t.isBot, clock: clock() });
    },
    canHit(target, opts = {}) { return api.blocked(target, opts) === null; },
    /** Host: a hit was refused (counted for QA and the verify detail). */
    refuse(why) { if (why && why in stats.blocked) stats.blocked[why]++; },
    /** Host: a hit on `target` from `from` counted (bots on one human: the gang limit). */
    noteHit(target, from) { const t = player(target), f = player(from); if (t && f) ref.noteHit(t.id, now(), { from: f.id, fromBot: !!f.isBot }); },
    /** Host: may this player be knocked over now (not down, out or protected). */
    canKnock(target) { const t = player(target); return !t || !P.on || !ctx.host || ref.canKnock(t.id, now()); },
    /** Host: a knock was sent to this player. */
    knocked(target) { const t = player(target); if (t && ctx.host) { ref.knocked(t.id, now()); stats.knocks++; } },
    /**
     * p.knock()'s gate (kit/net/players.js): null when refused (the host sees the player down or protected), else
     * {budget}: fair.split with fair play on (the knock lasts downSeconds in all), null for the old way. out: a player
     * taken out (health.down) stays down until revived; force: a game's deliberate knock that skips the refusal.
     */
    knockPlan(target, { out = false, force = false } = {}) {
      const t = player(target), fair = P.on && !out;
      if (fair && !force && ctx.host && t && !ref.canKnock(t.id, now())) { stats.refused++; return null; }
      if (t && ctx.host) { ref.knocked(t.id, now(), { out }); stats.knocks++; }
      return { budget: fair ? split : null };
    },
    /** Host: protect a player for `seconds` (a game's own reason). */
    protect(target, seconds) { const t = player(target); if (t && ctx.host) ref.protect(t.id, now(), seconds); },
    state(target) {
      const t = player(target); if (!t) return 'control';
      if (t.alive === false) return 'out';
      if (ctx.host) return ref.stateOf(t.id, now());
      if (!controlOf(t)) return 'down';
      return protectedHere(t) ? 'protected' : 'control';
    },
    isDown(target) { const s = api.state(target); return s === 'down' || s === 'out'; },
    isProtected(target) { return api.state(target) === 'protected'; },
    protectLeft(target) { const t = player(target); return t && ctx.host ? ref.protectLeft(t.id, now()) : 0; },
    /** For the observation (window.__game.snapshot().players[i]). */
    observe(p) { const s = api.state(p); return { control: controlOf(p), down: s === 'down' || s === 'out', protected: s === 'protected', pl: Math.round(api.protectLeft(p) * 100) / 100 }; },
    summary() { return { on: P.on, downSeconds: P.downSeconds, protectSeconds: P.protectSeconds, startGrace: P.startGrace, botSkill: P.botSkill, botsPerTarget: P.botsPerTarget, grace: api.grace, stats: { knocks: stats.knocks, refused: stats.refused, blocked: { ...stats.blocked } } }; },

    /** After the session exists: the shared key every copy reads protection from. */
    setup() { if (!S && ctx.shared) S = ctx.shared.register('_fair', { pr: [], g: 0 }); },
    /** Every frame, after the controllers moved and before the mechanics: referee (host), then the shimmer (every copy). */
    update(dt) {
      if (!S) api.setup();
      if (!ctx.players) return;
      const rn = ctx.round?.number ?? 1;
      if (rn !== lastRound) { lastRound = rn; ref.reset(); }
      const list = ctx.players.list();
      if (ctx.host) {
        if (ctx.round?.phase === 'playing') for (const p of list) ref.observe(p.id, now(), { control: controlOf(p), alive: p.alive });
        if (S) {
          const pr = P.on ? list.filter(p => ref.isProtected(p.id, now())).map(p => p.id) : [];
          if (pr.join() !== (S.pr ?? []).join()) S.pr = pr;
          const g = api.grace ? 1 : 0; if (S.g !== g) S.g = g;
        }
      }
      // F3: protected bodies shimmer in the protect colour (their own materials, through the character's glow)
      glowT += dt;
      const color = ctx.assets?.has?.('fair.protect-color') ? ctx.assets.value('fair.protect-color', P.protectColor) : P.protectColor;
      for (const p of list) {
        const c = p.character; if (!c?.glow) continue;
        const on = P.on && ctx.round?.phase === 'playing' && p.alive !== false && protectedHere(p);
        if (on) { c.glow(color, 0.32 + 0.22 * Math.sin(glowT * 13 + p.seat)); glowing.add(p.id); }
        else if (glowing.has(p.id)) { c.glow(null, 0); glowing.delete(p.id); }
      }
    },
  };
  return api;
}
