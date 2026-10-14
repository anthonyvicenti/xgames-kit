// Market Day: a coin grab around a town seen from above. The kit runs the round, the scores, the bots and the pickups;
// the flat part runs the town (its houses, trees, fences and pond are the map's set pieces and edges). This file is
// what makes it this game: the coins sit where the town's map marks them.
export default {
  setup(ctx) {
    ctx.coins = ctx.mechanics.get('pickup');
  },
  // the host owns the coins (a spot added on the host shows on every screen); the pickup mechanic has cleared the last
  // round's by now
  roundStart(ctx) {
    if (ctx.host) for (const m of ctx.world.marks('coin')) ctx.coins.spawnAt(m);
  },
  // a bot walks to the nearest coin still there, else wanders
  bot(ctx, p) {
    const here = p.position, near = (a, b) => Math.hypot(a.x - here.x, a.z - here.z) - Math.hypot(b.x - here.x, b.z - here.z);
    const pick = ctx.coins.list().filter(s => s.present).sort(near)[0];
    if (pick) p.bot.seek({ x: pick.x, y: 0, z: pick.z }, { stop: 0.2 }); else p.bot.wander();
  },
  check() { return null; },
  results(ctx) { return ctx.players.list().map(p => ({ id: p.id, name: p.name, value: p.score })); },
};
