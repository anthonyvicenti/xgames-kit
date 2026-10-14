// Waves fixture rules. Exposes window.__fx for the scenario.
export default {
  setup(ctx) {
    const waves = ctx.mechanics.get('waves');
    window.__fx = {
      killFirst: id => { const e = id != null ? waves.enemies().find(x => x.id === id) : waves.enemies()[0]; return e ? waves.damageEnemy(e.id, 5, { from: ctx.me }) : false; },
      // a hit that does not kill (hp 2): every copy shows its health bar at the same fill
      hurtFirst: () => { const e = waves.enemies()[0]; return e && waves.damageEnemy(e.id, 1, { from: ctx.me, impulse: { x: 0, z: 4 } }) ? e.id : null; },
      bar: id => { const b = document.querySelector(`#gf-ui .gf-hbar[data-key="waves:${id}"]`); return b ? { frac: Number(b.dataset.frac), shown: getComputedStyle(b).display !== 'none' } : null; },
      info: () => ({ state: waves.state(), enemies: waves.enemies().map(e => ({ id: e.id, x: e.x, z: e.z, hp: e.hp })), score: ctx.me.score, dying: waves.stats?.dying ?? 0 }),
    };
  },
};
