// Pickup fixture on forge: two players, two spots. Exposes window.__fx for the scenario (QA only).
const other = ctx => ctx.players.list().find(p => !p.local && !p.ghost) ?? null;
const put = (ctx, p, x, z) => ctx.forge.cmd.teleport(ctx.players.nid(p.id), { x, y: 0.05, z }, 0, 0);
export default {
  setup(ctx) {
    const pk = ctx.mechanics.get('pickup');
    window.__fx = {
      info: () => ({ me: ctx.me.id, host: ctx.host, spots: pk.list(), scores: Object.fromEntries(ctx.players.list().map(p => [p.id, p.score])), drawn: pk.observe().marks }),
      // the host's core moves the joiner (it simulates the joiner's player); the joiner's copy gets there by the snapshot
      putOther: i => { const s = pk.list()[i], o = other(ctx); put(ctx, o, s.x, s.z); return o.id; },
      otherAway: () => { const o = other(ctx), at = ctx.world.spawn(o.seat ?? 1); put(ctx, o, at.x, at.z); },
      face: i => { const s = pk.list()[i]; window.__game.forge.face?.(s.x, 1.2, s.z); },
    };
  },
  results(ctx) { return ctx.players.list().map(p => ({ id: p.id, name: p.name, value: p.score })); },
};
