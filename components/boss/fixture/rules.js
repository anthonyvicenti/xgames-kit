// Boss fixture rules. Exposes window.__fx for the scenario.
export default {
  setup(ctx) {
    const boss = ctx.mechanics.get('boss'), melee = ctx.mechanics.get('melee');
    window.__fx = {
      hurt: n => boss.damage(n, { from: ctx.me }),
      // this copy's own player stands beside the boss, aims at it and swings
      // (the host checks a reported hit against where it has the attacker: step up first, let the pose arrive, then swing)
      standBy: () => { const s = boss.state(); ctx.me.teleport({ x: s.x, y: 0, z: s.z - 1.9 }, 0); return true; },
      swingAt: () => { const s = boss.state(); ctx.me.controller.aimAt({ x: s.x, y: 1.5, z: s.z }); melee.swing(ctx.me, 'light'); return true; },
      aim: () => { const s = boss.state(); ctx.me.controller.aimAt({ x: s.x, y: 1.5, z: s.z }); return true; },
      info: () => { const s = boss.state(), h = window.__game.hud().widgets.find(w => w.id === 'boss'); return { ...s, bar: h ? { shown: h.shown, value: h.shows.value, text: h.shows.text } : null, round: window.__game.phase }; },
    };
  },
};
