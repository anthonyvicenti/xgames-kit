// Tower Isles (Crater Isles' rules): lob bombs across the islands and at the tower. The projectile mechanic throws
// them and knocks whoever is near a blast; the carve mechanic bites a crater out of the ground (or the tower) where each
// lands, the same on every screen. Score: a friend your blast knocks (+knockPoints), and a friend who falls into the
// sea within creditSeconds of your blast (+seaPoints); they come back on their island. Every number is a rules.* slot
// (config/game.json → rules.params).
export default {
  setup(ctx) {
    const R = ctx.config.rules?.params ?? {};
    const S = ctx.isles = { prj: ctx.mechanics.get('projectile'), knock: R.knockPoints ?? 1, sea: R.seaPoints ?? 3, credit: R.creditSeconds ?? 6, by: new Map() };
    // the host: a player fell into the sea; whoever knocked them in within the credit window scores
    S.fell = id => {
      const k = S.by.get(id);
      if (k && ctx.time.now - k.at <= S.credit) { const who = ctx.players.get(k.who); if (who) who.score += S.sea; }
      S.by.delete(id);
    };
    if (ctx.host) {
      // only hits fair play counted reach onHit (CONTRACT §6c)
      ctx.isles.prj.onHit(h => {
        if (!h.target || !h.shooter || h.target === h.shooter) return;
        ctx.isles.by.set(h.target.id, { who: h.shooter.id, at: ctx.time.now });
        if (h.kind === 'splash' || h.kind === 'discrete') h.shooter.score += ctx.isles.knock;
      });
    }
  },
  roundStart(ctx) { ctx.isles.by.clear(); },
  update(ctx) {
    const S = ctx.isles, sea = ctx.world.seaLevel ?? 0;
    for (const p of ctx.players.owned()) {
      if (ctx.round.phase === 'playing' && p.actions.primary.pressed) S.prj.fire(p);   // lands under the crosshair
      // into the sea: back on a spawn of their own; the host credits whoever knocked them in
      if (p.controller && p.position.y < sea - 0.8) {
        const s = ctx.world.spawn(p.seat ?? 0);
        p.controller.teleport(s, s.yaw);
        if (p.local) { ctx.ui.toast('Splash! Back to your island'); ctx.audio.play('splash', { optional: true }); }
        if (ctx.host) S.fell(p.id); else ctx.net.send('isles:fell', { id: p.id }, 'host');
      }
    }
  },
  event(ctx, name, d, from) {
    if (name === 'isles:fell' && ctx.host && d?.id === from) ctx.isles.fell(d.id);
  },
  check() { return null; },   // the round ends on time
  results(ctx) {
    return ctx.players.list().map(p => ({ id: p.id, name: p.name, value: p.score })).sort((a, b) => b.value - a.value);
  },
  bot(ctx, p) {
    // stand on the island and lob at whoever fair play picks (bombs cross the water; bots never wade in): aim with a
    // human error, wait for the reaction time and a hit that would count, then a bomb now and then
    const t = ctx.bots.target(p, { range: 40 });
    if (t) { ctx.bots.aim(p, t); if (ctx.bots.ready(p) && p.bot.rng() < 0.012) p.bot.press('primary'); return; }
    p.bot.wander();
  },
};
