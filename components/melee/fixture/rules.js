// Melee fixture rules. Exposes window.__fx for the scenario.
export default {
  setup(ctx) {
    const melee = ctx.mechanics.get('melee'), hp = ctx.mechanics.get('health'), waves = ctx.mechanics.get('waves');
    const other = () => ctx.players.list().find(p => p !== ctx.me);
    window.__fx = {
      me: () => ctx.me.id,
      // stand somewhere (this copy owns its own player) and hold the aim on a point
      stand: (x, z) => { ctx.me.teleport({ x, y: 0, z }, 0); return true; },
      aimAt: (x, z) => { ctx.me.controller.aimAt({ x, y: 1, z }); return true; },
      aimAtOther: () => { const o = other(); ctx.me.controller.aimAt({ x: o.position.x, y: 1, z: o.position.z }); return true; },
      swing: kind => { melee.swing(ctx.me, kind); return true; },
      dash: () => { melee.dash(ctx.me); return true; },
      dodging: () => melee.dodging(other()),
      enemyNear: () => { const e = waves.enemies()[0]; if (!e) return null; ctx.me.teleport({ x: e.x, y: 0, z: e.z - 1.3 }, 0); ctx.me.controller.aimAt({ x: e.x, y: 1, z: e.z }); return e.id; },
      info: () => {
        const s = melee.stats;
        return { me: ctx.me.id, hp: Object.fromEntries(ctx.players.list().map(p => [p.id, hp.hpOf(p)])), swingsSeen: s.swingsSeen, hitsSeen: s.hitsSeen, lastSwing: s.lastSwing, state: s.state, dashes: s.dashes,
          enemies: waves.enemies().map(e => ({ id: e.id, hp: e.hp, x: e.x, z: e.z })), weapon: s.weapon.id, other: other()?.id };
      },
    };
  },
};
