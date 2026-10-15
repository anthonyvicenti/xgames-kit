// Critter Lob: round critters (blob bodies, runtimes/three/kit/character/CREATURES.md) lob seeds and grab berries.
// The mechanics do the work: projectile (seeds that knock a friend over), pickup (berries that score), health (a knock
// is a tumble and a get-up). This file adds what makes it this game: the taker of a berry and the thrower of a seed
// that lands celebrate, and bots play.
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
  update(ctx) {
    // THE MISTAKE (the kit's pickup part before 2026-10-14, re-enacted here): spots scattered over the play box at y = 0,
    // the old yard's floor; on island terrain y = 0 is sea level, so they stand in the sea or inside the ground
    if (ctx.host && ctx.round.phase === 'playing' && ctx.lobSea !== ctx.round.number) {
      ctx.lobSea = ctx.round.number;
      const b = ctx.world.bounds; let s = 11; const r = () => ((s = (s * 16807) % 2147483647) / 2147483647);
      for (let i = 0; i < 10; i++) ctx.lob.pk.spawnAt({ x: b.min.x + 3 + r() * (b.max.x - b.min.x - 6), y: 0, z: b.min.z + 3 + r() * (b.max.z - b.min.z - 6) });
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
