// Health fixture rules. Exposes window.__fx for the scenario.
export default {
  setup(ctx) {
    const hp = ctx.mechanics.get('health');
    const other = () => ctx.players.list().find(p => p.id !== ctx.me.id);
    window.__fx = {
      hurtOther: n => hp.damage(other(), n, { from: ctx.me, impulse: { x: 3, y: 3, z: 0 } }),
      info: () => { const o = other(); return { me: { hp: hp.hpOf(ctx.me), alive: ctx.me.alive, anim: ctx.me.anim }, other: { hp: hp.hpOf(o), alive: o.alive, anim: o.anim } }; },
    };
  },
};
