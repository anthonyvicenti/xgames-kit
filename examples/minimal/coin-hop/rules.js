// Coin Hop: a side-on coin grab. The kit runs the round, the scores, the bots and the pickups; the flat part runs the
// stage, the ledges and the jump. This file is what makes it this game: the coins sit where the level's map marks them.
export default {
  setup(ctx) {
    ctx.coins = ctx.mechanics.get('pickup');
  },
  // every copy hears each round start; the host owns the coins (a spot added on the host shows on every screen), and
  // the pickup mechanic has cleared the last round's by now
  roundStart(ctx) {
    if (ctx.host) for (const m of ctx.world.marks('coin')) ctx.coins.spawnAt(m);
  },
  // a bot goes for the nearest coin it could take from where it is or with one jump (the flat controller makes it
  // jump when the coin is just above it); with none in reach it runs along the stage to the nearest one
  bot(ctx, p) {
    const here = p.position, coins = ctx.coins.list().filter(s => s.present), byX = (a, b) => Math.abs(a.x - here.x) - Math.abs(b.x - here.x);
    const pick = coins.filter(s => s.y - here.y < 2.2).sort(byX)[0] ?? coins.sort(byX)[0];
    if (pick) p.bot.seek({ x: pick.x, y: pick.y, z: 0 }, { stop: 0.2 }); else p.bot.wander();
  },
  check() { return null; },
  results(ctx) { return ctx.players.list().map(p => ({ id: p.id, name: p.name, value: p.score })); },
};
