// Coin Hop on runtime godot: what makes it this game. The Godot project draws the stage, the coins and the players and
// says when this player touches a coin (GF.event("coin", {i})); this file decides what that means. The host owns the
// coins and the scores: a touch on another copy is asked of the host, which takes the coin for everyone (ctx.shared →
// GF.shared in the game) and gives the point to whoever touched it first.
export default {
  setup(ctx) {
    const n = ctx.world.marks('coin').length;
    // t[i]: the round clock when coin i comes back (0: it is there)
    ctx.coins = ctx.shared.register('coins', { t: new Array(n).fill(0) });
  },
  roundStart(ctx) { if (ctx.host) ctx.coins.t = ctx.coins.t.map(() => 0); },
  // from: 'godot' when this copy's game sent it, else the id of the player whose copy sent it over the net, or of the bot
  // that touched it (alone: GF.event_as in the game)
  event(ctx, name, data, from) {
    if (name === 'coin' && from === 'godot') { if (ctx.host) take(ctx, data?.i, ctx.me.id); else ctx.net.send('coin', { i: data?.i }, 'host'); }
    else if (name === 'coin') take(ctx, data?.i, from);
    else if (name === 'coin-got') ctx.audio.play('coin');
  },
  update(ctx) {
    if (!ctx.host) return;
    const now = ctx.time.round;
    ctx.coins.t.forEach((t, i) => { if (t && now >= t) ctx.coins.t[i] = 0; });
  },
  check() { return null; },
  results(ctx) { return ctx.players.list().map(p => ({ id: p.id, name: p.name, value: p.score })); },
  observe(ctx) { return { coinsUp: ctx.coins.t.filter(t => !t).length, coins: ctx.coins.t.length }; },
  digest(ctx) { return ctx.coins.t.map(t => (t ? 0 : 1)).join(''); },
};

// the host: coin i goes to the player who touched it, if it is still there
function take(ctx, i, who) {
  if (!ctx.host || ctx.round.phase !== 'playing' || !Number.isInteger(i) || i < 0 || i >= ctx.coins.t.length || ctx.coins.t[i]) return;
  const p = ctx.players.get(who); if (!p) return;
  const R = ctx.config.rules?.params ?? {};
  ctx.coins.t[i] = ctx.time.round + (R.respawnSeconds ?? 4);
  p.score += R.coinPoints ?? 1;
  if (who === ctx.me.id) ctx.audio.play('coin'); else if (!p.isBot) ctx.net.send('coin-got', { i }, who);
}
