// Pickup fixture rules. Exposes window.__fx for the scenario.
export default {
  setup(ctx) {
    const pk = ctx.mechanics.get('pickup');
    window.__fx = {
      stepOn: i => { const s = pk.list()[i]; ctx.me.teleport({ x: s.x, y: 0, z: s.z }, 0); },
      info: () => ({ spots: pk.list().map(s => ({ i: s.index, present: s.present, x: s.x, z: s.z })), scores: Object.fromEntries(ctx.players.list().map(p => [p.id, p.score])), me: ctx.me.id }),
    };
  },
};
