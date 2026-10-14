// rules.js: THE GAME AGENT'S FILE. Bone Vigil: gf-forge's first playable (wave 2; research/rust-engine/PLAN.md §4):
// one moonlit ruin, three waves of the risen dead, one relic from three, then the bone lord.
//
// The kit runs everything a forge game shares: the menu, the HUD, the round, live co-op for 2-4, the first-person
// controller and weapons, the enemies and the wave director, the reward screen with its inspector, down and revive.
// The tables in spec.json say what the weapons, enemies, waves and cards are. This file says what a run is:
//
//   start     every hunter starts over: full health, the sidearm in hand, no relic
//   score     each kill's points to whoever landed it, and a point a coin to whoever it reaches
//   mend      a cleared wave gives every standing hunter some health back (rules.params.mend) and their armour
//   reward    the third wave asks for one: the kit's three-card reward opens by itself (ctx.cards), and the lord's
//             wave starts when everyone has picked or passed
//   win       every wave cleared (the lord's is the last): whoever still stands wins
//   lose      every hunter is at zero health (with friends a fallen hunter is down until a friend brings them back;
//             when the last one falls the run is lost)
//
// Test hooks, never on for a player: ?qa=1 gives window.__vigil (hurt or raise a hunter, give a card, jump to a wave);
// ?room=1 gives the hooks gf-forge/tools/measure.mjs --crowd drives (raise enemies by hand, heal).
// (Kept in runtimes/forge/specs/vigil.rules.js and copied in after create.)
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

function hooks(ctx) {
  const q = new URLSearchParams(location.search);
  if (q.get('qa') === '1') {
    window.__vigil = {
      ctx,
      /** Hurt a hunter (a kit player id, or none: this copy's own) by `amount`; the host's word. */
      hurt: (amount = 1000, id = ctx.me.id) => { const n = ctx.players.nid(id); if (ctx.host && n) ctx.forge.cmd.damage(n, amount, 0, [0, 0, -1]); return !!(ctx.host && n); },
      raise: (id = ctx.me.id) => ctx.cards?.revive(id) ?? false,
      give: (card, id = ctx.me.id) => ctx.cards?.give(id, card) ?? false,
      heal: () => { if (ctx.host) mend(ctx, 1e6); return ctx.host; },
      /** This copy's own hunter stands beside another (a kit player id), `d` metres away. */
      beside: (id, d = 1.1) => { const p = ctx.players.get(id); if (!p) return false; ctx.me.teleport({ x: p.position.x + d, y: p.position.y, z: p.position.z }, ctx.me.yaw); return true; },
      /** Jump to a wave (0: the first), clearing what stands. */
      wave: i => { if (ctx.host) ctx.ai.director.skip(i); return ctx.host; },
      /** Break every enemy standing (the fight itself is driven by a real mouse elsewhere). */
      sweep: () => { if (!ctx.host) return 0; let n = 0; for (const e of ctx.forge.entities(2)) if (!(e.flags & 1)) { ctx.forge.cmd.damage(e.net, 1e6, ctx.players.nid(ctx.me.id), [0, 0, -1]); n++; } return n; },
    };
  }
  if (q.get('room') === '1') {
    window.__room = ctx;
    window.__crowd = type => ctx.ai.spawn(type);
    window.__heal = () => { if (ctx.host) mend(ctx, 1e6); };
  }
}

export default {
  setup(ctx) {
    ctx.ui.goal?.(ctx.config.text?.goal ?? 'Hold the ruin');
    hooks(ctx);
  },
  roundStart(ctx) {
    for (const p of ctx.players.list()) p.score = 0;
    if (!ctx.host) return;
    // every hunter starts over: health, armour and ammunition from the tables, the cards of the run before gone
    for (const p of ctx.players.list()) { const n = coreId(ctx, p); if (n != null) ctx.forge.cmd.raw(FEEL_OP.RESET, [n]); }
    ctx.forge.cmd.raw(FEEL_OP.CLEAR, []);
    // the measuring hook (?room=1, tools/measure.mjs --crowd): the weapon that fires while held, in hand from the start
    if (window.__room) for (const p of ctx.players.list()) ctx.cards?.give(p.id, 'repeater');
  },
  event(ctx, name, d) {
    const host = ctx.host && ctx.round.phase === 'playing';
    if (name === 'enemy-down') { const p = byCore(ctx, d.d); if (p && host) p.score += Math.max(1, Math.round(d.b || 1)); }
    else if (name === 'coin') { const p = byCore(ctx, d.entity); if (p && host) p.score += Math.max(0, Math.round(d.a || 0)); }
    else if (name === 'wave-start') ctx.ui.banner?.(d.d ? 'The bone lord rises' : `Wave ${d.a} of ${d.b}`, d.d ? 2.2 : 1.4);
    else if (name === 'wave-clear') { if (host) mend(ctx, Number(ctx.config.rules?.params?.mend) || 0); }
    else if (name === 'boss-phase') ctx.ui.banner?.(d.a >= 3 ? 'The lord is enraged' : 'The lord calls the dead', 1.6);
    // a friend's fall and return are said to everyone else (the kit tells the hunter themselves: gf/forge/down.js)
    else if (name === 'player-down') { if (!byCore(ctx, d.entity)?.local) ctx.ui.banner?.(`${nameOf(ctx, d.entity)} is down`, 1.6); }
    else if (name === 'player-revived') ctx.ui.banner?.(byCore(ctx, d.entity)?.local ? 'You are back up' : `${nameOf(ctx, d.entity)} is back up`, 1.2);
    else if (name === 'waves-done' && host) ctx.round.end('cleared', ctx.players.list().filter(p => p.alive !== false).map(p => p.id));
  },
  update(ctx) {
    if (!ctx.host || ctx.round.phase !== 'playing') return;
    // nobody stands: the run is lost
    const all = ctx.players.list();
    if (all.length && all.every(p => p.alive === false)) ctx.round.end('lost', []);
    // the clock: a vigil the clock ends is not won (left to itself the kit would name the top scorer the winner)
    else if (ctx.time.left <= 0.5) ctx.round.end('time', []);
  },
  check() { return null; },
  results(ctx) { return ctx.players.list().map(p => ({ id: p.id, name: p.name, value: p.score })); },
  // QA (CONTRACT §6b): the director, the run and what the fight drew
  observe(ctx) {
    const v = ctx.feel?.view?.() ?? null;
    return { ai: ctx.ai?.observe?.() ?? null, feel: v && { weapon: v.weapon, ammo: v.ammo, kills: v.kills, hits: v.hits, combo: v.combo, tint: v.tint, down: v.down, downed: v.downed, cards: v.cards, debris: v.debris, resting: v.resting }, fight: ctx.fight?.observe?.() ?? null };
  },
};
