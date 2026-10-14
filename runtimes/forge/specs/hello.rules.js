// rules.js: THE GAME AGENT'S FILE. Hello Forge: what makes this game this game (builder/CONTRACT.md §3).
// The forge engine's wave-0 room (research/rust-engine/PLAN.md §4): the kit runs the home menu, the HUD, the round and
// replay, the first-person walk (the Rust core) and the room (gf/forge/world.js); this file only says how a round is won.
//
// Win: walk up to the chest the crypt guards (within rules.reach metres of it) before the time runs out.
// Scoring: +1 for reaching the chest, which ends the round as a win.
// (Written for the wave-0 sandbox; kept in runtimes/forge/specs/hello.rules.js and copied in after create.)

const reachOf = ctx => Number(ctx.config.rules?.params?.reach) || 1.6;

export default {
  setup(ctx) {
    ctx.ui.goal?.('Find the chest the crypt guards');
  },
  roundStart(ctx) {
    for (const p of ctx.players.list()) { p.score = 0; p.data.found = false; }
  },
  update(ctx) {
    if (!ctx.host || ctx.round.phase !== 'playing') return;
    const chest = ctx.world.props?.get?.('chest')?.[0];
    if (!chest) return;
    for (const p of ctx.players.list()) {
      if (p.data.found) continue;                 // once a round: the round ends here, but QA's ?gf-gate=1 keeps it running
      const d = Math.hypot(p.position.x - chest.at[0], p.position.z - chest.at[2]);
      if (d > reachOf(ctx)) continue;
      p.data.found = true;
      p.score += 1;
      ctx.ui.banner?.('You found the chest!', 2);
      ctx.round.end('found', [p.id]);
      return;
    }
  },
  // bots (?bots=N): they hold back for 8 s, then walk to the chest (the forge bot's seek goes round the room's walls
  // on forge-ai's grid); in a room this small an eager or wandering bot finds the chest within a second or two
  bot(ctx, p) {
    const chest = ctx.world.props?.get?.('chest')?.[0];
    if (!chest || ctx.time.round < 8) { p.bot.stop(); return; }
    p.bot.seek({ x: chest.at[0], y: 0, z: chest.at[2] }, { stop: 0.6 });
  },
  check() { return null; },
  results(ctx) { return ctx.players.list().map(p => ({ id: p.id, name: p.name, value: p.score })); },
  // QA (CONTRACT §6b): how far the local player is from the chest
  observe(ctx) {
    const chest = ctx.world.props?.get?.('chest')?.[0], me = ctx.me;
    return chest && me ? { chest: chest.at, distance: Math.round(Math.hypot(me.position.x - chest.at[0], me.position.z - chest.at[2]) * 100) / 100 } : null;
  },
};
