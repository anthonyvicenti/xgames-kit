// Critter Lob with its berries where nobody can get to them (regression objective-out-of-reach, gate D · 6): the
// game's own code places the berries past the yard's fence, as the look test's levels had theirs out at sea and inside
// the ground. Everything else is the example's: seeds fly, friends tumble, bots play.
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
      ctx.lob.prj.onHit(h => { if (h.shooter && h.target && h.target !== h.shooter) cheer(h.shooter); });
    }
  },
  roundStart(ctx) { ctx.lob.placed = false; },
  update(ctx) {
    // the host places this round's berries once it plays: ten of them past the fence, all round the yard
    if (ctx.host && ctx.round.phase === 'playing' && !ctx.lob.placed) {
      ctx.lob.placed = true;
      for (let i = 0; i < 10; i++) { const a = (i / 10) * Math.PI * 2; ctx.lob.pk.spawnAt({ x: Math.cos(a) * 27, y: 0, z: Math.sin(a) * 23 }); }
    }
    const me = ctx.me;
    // held, it lobs again as soon as the seed bag is ready (the projectile's cooldown)
    if (me && ctx.round.phase === 'playing' && me.actions.primary.down) ctx.lob.prj.fire(me);
  },
  event(ctx, name) {
    if (name === 'lob:cheer' && ctx.me) ctx.me.act('emote_cheer', ctx.lob.cheer);
  },
  check() { return null; },   // the round ends on time
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
