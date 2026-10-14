// Loot fixture rules. Exposes window.__fx for the scenario.
export default {
  setup(ctx) {
    const loot = ctx.mechanics.get('loot'), melee = ctx.mechanics.get('melee');
    const other = () => ctx.players.list().find(p => p !== ctx.me);
    window.__fx = {
      me: () => ctx.me.id,
      stand: (x, z) => { ctx.me.teleport({ x, y: 0, z }, 0); return true; },
      // host: a drop at a point
      drop: (kind, x, z, extra) => loot.drop(kind, x, z, extra ?? {}),
      offer: () => { loot.offerUpgrades(); return true; },
      // this copy's player presses interact through the input (as the touch button does)
      pressE: () => { ctx.input.press('interact', true); setTimeout(() => ctx.input.press('interact', false), 150); return true; },
      pickCard: n => { dispatchEvent(new KeyboardEvent('keydown', { key: String(n) })); return true; },
      info: () => ({ me: ctx.me.id, coins: Object.fromEntries(ctx.players.list().map(p => [p.id, loot.coinsOf(p)])), drops: loot.drops(), weapon: Object.fromEntries(ctx.players.list().map(p => [p.id, melee.weaponOf(p).id])),
        rarity: Object.fromEntries(ctx.players.list().map(p => [p.id, melee.weaponOf(p).rarity])), upgrades: Object.fromEntries(ctx.players.list().map(p => [p.id, loot.upgradesOf(p)])), cards: !!document.getElementById('gf-loot-cards'),
        hud: window.__game.hud().widgets.find(w => w.id === 'coins')?.shows?.text ?? null }),
    };
  },
};
