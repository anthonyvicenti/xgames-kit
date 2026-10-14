// Levels fixture rules. Exposes window.__fx for the scenario.
export default {
  setup(ctx) {
    const lv = ctx.mechanics.get('levels'), waves = ctx.mechanics.get('waves');
    window.__fx = {
      // host: bring down every enemy of this level (as kills: the level is cleared, not skipped)
      killAll: () => { let n = 0; for (const e of waves.enemies()) { waves.damageEnemy(e.id, 999, { from: ctx.me }); n++; } return n; },
      // this copy's own player steps into (or out of) the portal
      intoPortal: () => { const p = lv.state().portal; if (!p) return false; ctx.me.teleport({ x: p.x, y: 0, z: p.z }, 0); return true; },
      awayFromPortal: () => { const p = lv.state().portal; if (!p) return false; ctx.me.teleport({ x: p.x - 7, y: 0, z: p.z }, 0); return true; },
      info: () => {
        const s = lv.state(), L = ctx.world.levels?.[ctx.world.level];
        return { level: s.level, phase: s.phase, open: s.portal?.open ?? false, portal: s.portal, worldLevel: ctx.world.level, enemies: waves.enemies().length,
          me: { x: ctx.me.position.x, z: ctx.me.position.z }, onLevel: L ? Math.hypot(ctx.me.position.x - L.at[0], ctx.me.position.z - L.at[2]) <= L.radius + 1 : null,
          hud: window.__game.hud().widgets.find(w => w.id === 'level')?.shows?.text ?? null, round: window.__game.phase };
      },
    };
  },
};
