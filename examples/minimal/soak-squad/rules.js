// Soak Squad: grab buckets, spray to claim the lawn, soak friends to steal points.
// Score = patches you hold (paint coverage) + points stolen. The water tank is this game's own meter; every number it
// uses is a rules.* slot (config/game.json → rules.params), so it can be tuned without touching this file.
// Adapted from games.fun's delivered Studio v2 game "Bladder Brawl" (THIRD_PARTY.md), re-themed as a water fight.
export default {
  setup(ctx) {
    const R = ctx.config.rules?.params ?? {};
    ctx.soak = {
      prj: ctx.mechanics.get('projectile'), paint: ctx.mechanics.get('paint'), pk: ctx.mechanics.get('pickup'),
      last: new Map(), meter: null, t: 0,
      full: R.tankSeconds ?? 16, fill: R.bucketFill ?? 0.6, steal: R.stealPoints ?? 2, cool: R.stealCooldown ?? 1.5,
    };
    ctx.soak.meter = ctx.ui.meter('tank', { label: 'Water', value: 1, max: 1, color: '#4ab8ff' });
    const refill = p => {
      p.data.tank = Math.min(1, (p.data.tank ?? 0) + ctx.soak.fill);
      if (p.local) { ctx.ui.toast('Tank refilled!'); ctx.audio.play('slosh', { optional: true }); }
    };
    ctx.soak.refill = refill;
    if (ctx.host) {
      // a bucket taken by a player another copy simulates: tell that copy (events are edges, never per frame)
      ctx.soak.pk.onCollect(({ player }) => { if (player.owned) refill(player); else ctx.net.send('soak:refill', {}, player.id); });
      // only hits fair play counted reach onHit (CONTRACT §6c): nobody farms a player who is down
      ctx.soak.prj.onHit(h => {
        if (h.kind !== 'stream' || !h.target || !h.shooter) return;
        const key = h.shooter.id + '>' + h.target.id, last = ctx.soak.last.get(key) ?? -99;
        if (ctx.time.now - last < ctx.soak.cool) return;
        const amt = Math.min(ctx.soak.steal, Math.max(0, h.target.score));
        if (amt <= 0) return;
        ctx.soak.last.set(key, ctx.time.now);
        h.shooter.data.stolen = (h.shooter.data.stolen ?? 0) + amt;
        h.target.data.stolen = (h.target.data.stolen ?? 0) - amt;
        ctx.audio.play('bonk', { optional: true });
      });
    }
  },
  roundStart(ctx) {
    ctx.soak.last.clear();
    for (const p of ctx.players.owned()) { p.data.tank = 1; p.data.stolen = 0; }
  },
  update(ctx, dt) {
    const S = ctx.soak;
    for (const p of ctx.players.owned()) {
      const tank = p.data.tank ?? 1;
      const want = ctx.round.phase === 'playing' && p.actions.primary.down && tank > 0.001;
      const on = S.prj.stream(p, want);          // no direction: the stream lands under the crosshair (CONTRACT §6d)
      if (on && !p.data.spraying) ctx.audio.play('spray', { at: p.position, optional: true });
      p.data.spraying = on;
      if (on) p.data.tank = Math.max(0, tank - dt / S.full);
    }
    if (ctx.me) S.meter.set(ctx.me.data.tank ?? 1);
    S.t += dt;
    if (ctx.host && ctx.round.phase === 'playing' && S.t >= 1) {   // the host owns the score, once a second
      S.t = 0;
      const cov = new Map(S.paint.coverage().map(c => [c.owner, c.cells]));
      for (const p of ctx.players.list()) p.score = Math.max(0, (cov.get(p.id) ?? 0) + (p.data.stolen ?? 0));
    }
  },
  event(ctx, name) {
    if (name === 'soak:refill' && ctx.me) ctx.soak.refill(ctx.me);
  },
  check() { return null; },   // the round ends on time
  results(ctx) {
    return ctx.players.list().map(p => ({ id: p.id, name: p.name, value: p.score })).sort((a, b) => b.value - a.value);
  },
  bot(ctx, p) {
    const S = ctx.soak;
    if ((p.data.tank ?? 1) < 0.25) {
      const n = S.pk.nearest(p.position);
      if (n) { p.bot.seek(n.pos ?? n.position ?? n, { stop: 0.2 }); return; }
    }
    const t = ctx.bots.target(p, { range: 8 });   // fair play picks a target that can be hit, spread across bots
    if (t) { ctx.bots.attack(p, t, { stop: 5 }); return; }
    if ((p.data.tank ?? 1) > 0.02 && p.bot.rng() < 0.02) p.bot.hold('primary', 0.8);
    p.bot.wander();
  },
};
