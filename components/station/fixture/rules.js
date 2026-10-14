// Station fixture rules. Exposes window.__fx for the scenario.
export default {
  setup(ctx) {
    const st = ctx.mechanics.get('station');
    window.__fx = {
      goToDesk: dx => ctx.me.teleport({ x: dx, y: 0, z: 3.8 }, Math.PI),
      use: on => st.use(ctx.me, 0, on),
      info: () => ({ s: st.state(0), q: st.quota(), score: ctx.me.score, me: ctx.me.id }),
    };
  },
};
