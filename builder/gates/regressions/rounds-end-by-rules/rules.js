// Critter Lob: round critters (blob bodies, runtimes/three/kit/character/CREATURES.md) lob seeds and grab berries.
// The mechanics do the work: projectile (seeds that knock a friend over), pickup (berries that score), health (a knock
// is a tumble and a get-up). This file adds what makes it this game: the taker of a berry and the thrower of a seed
// that lands celebrate, and bots play.
// The regression rounds-end-by-rules: a duel, the first seed that bowls a player over ends the round (as a knock-out
// or a last side standing ends a match by the game's own rules, whenever it happens).
export default {
  setup(ctx) {
    const R = ctx.config.rules?.params ?? {};
    ctx.lob = { prj: ctx.mechanics.get('projectile'), pk: ctx.mechanics.get('pickup'), cheer: R.cheerSeconds ?? 1.2 };
    // a berry taken or a friend bowled over: the player celebrates on its own copy (the pose carries the word to
    // everyone); the host hears every one, so a player another copy simulates is told (an edge, never per frame)
    const cheer = player => { if (player.owned) player.act('emote_cheer', ctx.lob.cheer); else ctx.net.send('lob:cheer', {}, player.id); };
    if (ctx.host) {
      ctx.lob.pk.onCollect(({ player }) => cheer(player));
      // a seed that bowls a friend over: the thrower celebrates too (only hits fair play counted arrive here)
      ctx.lob.prj.onHit(h => { if (h.shooter && h.target && h.target !== h.shooter) { cheer(h.shooter); ctx.lob.ko ??= h.shooter.id; } });
    }
  },
  update(ctx) {
    const me = ctx.me;
    // held, it lobs again as soon as the seed bag is ready (the projectile's cooldown)
    if (me && ctx.round.phase === 'playing' && me.actions.primary.down) ctx.lob.prj.fire(me);
  },
  event(ctx, name) {
    if (name === 'lob:cheer' && ctx.me) ctx.me.act('emote_cheer', ctx.lob.cheer);
  },
  // the round ends on time, or at the first knock-over: the one who landed it wins
  check(ctx) { return ctx.lob.ko ? { winners: [ctx.lob.ko], reason: 'a knock-over' } : null; },
  roundStart(ctx) { ctx.lob.ko = null; },
  results(ctx) {
    return ctx.players.list().map(p => ({ id: p.id, name: p.name, value: p.score })).sort((a, b) => b.value - a.value);
  },
  // a bot goes for the nearest berry, and lobs at a friend it can hit on the way
  bot(ctx, p) {
    const t = ctx.bots.target(p, { range: 9 });
    if (t && p.bot.rng() < 0.03) { ctx.bots.attack(p, t, { stop: 6 }); ctx.lob.prj.fire(p, [t.position.x - p.position.x, 0.6, t.position.z - p.position.z]); return; }
    const n = ctx.lob.pk.nearest(p.position);
    if (n) { p.bot.seek(n.pos ?? n.position ?? n, { stop: 0.2 }); return; }
    p.bot.wander();
  },
};
