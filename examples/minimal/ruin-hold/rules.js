// rules.js: THE GAME AGENT'S FILE. Ruin Hold: the forge runtime's minimal example. One moonlit ruin, two waves of the
// risen dead, their captain last; live co-op for 1-4 with down and revive.
//
// The kit runs everything a forge game shares: the menu, the HUD, the round, live co-op, the first-person controller
// and weapons, the enemies and the wave director, down and revive. The tables in spec.json say what the weapons,
// enemies and waves are. This file says what a hold is:
//
//   start     every hunter starts over: full health, the sidearm in hand
//   score     each kill's points to whoever landed it, and a point a coin to whoever it reaches
//   mend      a cleared wave gives every standing hunter some health back (rules.params.mend) and their armour
//   win       both waves cleared: whoever still stands wins
//   lose      every hunter is at zero health (with friends a fallen hunter is down until a friend raises them), or the
//             clock runs out first
import { FEEL_OP } from './gf/forge/feel.js';

const coreId = (ctx, p) => ctx.players.nid?.(p.id) ?? null;
const byCore = (ctx, id) => ctx.players.list().find(p => coreId(ctx, p) === id) ?? null;
const nameOf = (ctx, id) => { const p = byCore(ctx, id); return p ? (p.local ? 'You' : p.name) : 'A hunter'; };

/** The host: a standing hunter gets `add` health back (never past their full health) and at least their armour. */
function mend(ctx, add) {
  const armor = Number(ctx.tables.player?.armor) || 0;
  for (const p of ctx.players.list()) {
    const n = coreId(ctx, p), h = p.health;
    if (n == null || !h || p.alive === false) continue;
    ctx.forge.cmd.setHealth(n, Math.min(h.max, h.hp + add), h.max, Math.max(h.armor, armor));
  }
}

export default {
  setup(ctx) {
    ctx.ui.goal?.(ctx.config.text?.goal ?? 'Hold the ruin');
  },
  roundStart(ctx) {
    for (const p of ctx.players.list()) p.score = 0;
    if (!ctx.host) return;
    for (const p of ctx.players.list()) { const n = coreId(ctx, p); if (n != null) ctx.forge.cmd.raw(FEEL_OP.RESET, [n]); }
  },
  event(ctx, name, d) {
    const host = ctx.host && ctx.round.phase === 'playing';
    if (name === 'enemy-down') { const p = byCore(ctx, d.d); if (p && host) p.score += Math.max(1, Math.round(d.b || 1)); }
    else if (name === 'coin') { const p = byCore(ctx, d.entity); if (p && host) p.score += Math.max(0, Math.round(d.a || 0)); }
    else if (name === 'wave-start') ctx.ui.banner?.(`Wave ${d.a} of ${d.b}`, 1.4);
    else if (name === 'wave-clear') { if (host) mend(ctx, Number(ctx.config.rules?.params?.mend) || 0); }
    // a friend's fall and return are said to everyone else (the kit tells the hunter themselves: gf/forge/down.js)
    else if (name === 'player-down') { if (!byCore(ctx, d.entity)?.local) ctx.ui.banner?.(`${nameOf(ctx, d.entity)} is down`, 1.6); }
    else if (name === 'player-revived') ctx.ui.banner?.(byCore(ctx, d.entity)?.local ? 'You are back up' : `${nameOf(ctx, d.entity)} is back up`, 1.2);
    else if (name === 'waves-done' && host) ctx.round.end('cleared', ctx.players.list().filter(p => p.alive !== false).map(p => p.id));
  },
  update(ctx) {
    if (!ctx.host || ctx.round.phase !== 'playing') return;
    const all = ctx.players.list();
    if (all.length && all.every(p => p.alive === false)) ctx.round.end('lost', []);
    // the clock: a hold the clock ends is not won (left to itself the kit would name the top scorer the winner)
    else if (ctx.time.left <= 0.5) ctx.round.end('time', []);
  },
  check() { return null; },
  results(ctx) { return ctx.players.list().map(p => ({ id: p.id, name: p.name, value: p.score })); },
  // QA (CONTRACT §6b): the wave director and what the fight drew
  observe(ctx) {
    const v = ctx.feel?.view?.() ?? null;
    return { ai: ctx.ai?.observe?.() ?? null, feel: v && { weapon: v.weapon, ammo: v.ammo, kills: v.kills, hits: v.hits, down: v.down, downed: v.downed } };
  },
};
