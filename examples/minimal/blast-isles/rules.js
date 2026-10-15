// Blast Isles: turn-based artillery with physical comedy, from shared parts only. The aim mechanic (charge, angle with
// the view, wind, a trajectory preview, the weapon wheel) plays each turn and follows the shot; the knockback mechanic
// throws every critter near a blast (the same flight on every screen); the carve mechanic bites craters and drops what
// they leave hanging; the hazards mechanic takes a critter that lands in the sea out for a moment and brings it back on
// dry ground. The rules only score: a friend your blast throws (+throwPoints), a friend who lands in the sea after you
// threw them (+seaPoints); first to `target` wins. Every number is a rules.* slot (config/game.json → rules.params).
export default {
  setup(ctx) {
    const R = ctx.config.rules?.params ?? {};
    ctx.blast = { throwPts: R.throwPoints ?? 1, seaPts: R.seaPoints ?? 3, target: R.target ?? 6 };
    if (!ctx.host) return;
    const kb = ctx.mechanics.get('knockback'), hz = ctx.mechanics.get('hazards');
    // the host scores: a throw a friend's blast caused, and a fall into the sea by whoever threw them last
    kb.onFling(e => { if (e.player && e.from && e.from !== e.player) e.from.score += ctx.blast.throwPts; });
    hz.onFall(e => {
      if (e.by && e.by !== e.player) { e.by.score += ctx.blast.seaPts; ctx.net.send('blast:sea', { by: e.by.id, who: e.player.id }); say(ctx, e.by.id, e.player.id); }
    });
  },
  event(ctx, name, d) { if (name === 'blast:sea' && d) say(ctx, d.by, d.who); },
  check(ctx) {
    const top = ctx.players.list().filter(p => p.score >= ctx.blast.target).sort((a, b) => b.score - a.score)[0];
    return top ? { winners: [top.id], reason: `${top.name} reached ${ctx.blast.target}` } : null;
  },
  results(ctx) { return ctx.players.list().map(p => ({ id: p.id, name: p.name, value: p.score })).sort((a, b) => b.value - a.value); },
  // bots aim and fire on their own turns (the aim part solves the shot with the wind and misses a little)
  bot(ctx, p) { ctx.mechanics.get('aim').bot(p); },
};

// every screen: the big words when a friend lands in the sea
function say(ctx, by, who) {
  const a = ctx.players.get(by), b = ctx.players.get(who);
  if (a && b) ctx.ui?.announce?.('Splash!', { sub: `${a.name} sent ${b.name} swimming`, seconds: 1.8, color: a.color });
}
