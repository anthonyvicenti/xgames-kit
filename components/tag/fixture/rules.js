// Tag fixture rules. Exposes window.__fx for the scenario.
export default {
  setup(ctx) {
    const tag = ctx.mechanics.get('tag');
    const other = () => ctx.players.list().find(p => p.id !== ctx.me.id);
    window.__fx = {
      chaseOther: () => { const o = other(); ctx.me.teleport({ x: o.position.x + 0.5, y: 0, z: o.position.z }, 0); },
      info: () => ({ me: ctx.me.id, its: tag.its().map(p => p.id), itTime: Object.fromEntries(ctx.players.list().map(p => [p.id, tag.itTime(p)])) }),
    };
  },
};
