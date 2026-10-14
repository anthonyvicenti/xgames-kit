// Race fixture rules. Exposes window.__fx for the scenario.
export default {
  setup(ctx) {
    const race = ctx.mechanics.get('race');
    window.__fx = {
      gates: () => race.checkpoints,
      goTo: i => { const g = race.checkpoints[i]; ctx.me.teleport({ x: g.x, y: 0, z: g.z }, 0); },
      info: () => ({ me: ctx.me.id, progress: Object.fromEntries(ctx.players.list().map(p => [p.id, race.progress(p)])), order: race.finishOrder(), check: race.check(), score: ctx.me.score }),
    };
  },
};
