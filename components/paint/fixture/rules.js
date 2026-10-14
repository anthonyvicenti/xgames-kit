// Paint fixture rules. Exposes window.__fx for the scenario.
export default {
  setup(ctx) {
    const paint = ctx.mechanics.get('paint');
    const other = () => ctx.players.list().find(p => p.id !== ctx.me.id);
    window.__fx = {
      splatFor: (who, x, z) => paint.splat(who === 'me' ? ctx.me : other(), { x, z }),
      info: () => ({ coverage: paint.coverage().map(c => ({ owner: c.owner, cells: c.cells })), painted: paint.painted(), me: ctx.me.id, cells: paint.grid.owners.length }),
    };
  },
};
