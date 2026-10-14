// Loot fixture on forge: one kill drops coins, a potion and a weapon; the joiner takes them. Exposes window.__fx (QA only).
const other = ctx => ctx.players.list().find(p => !p.local && !p.ghost) ?? null;
const put = (ctx, p, x, z) => ctx.forge.cmd.teleport(ctx.players.nid(p.id), { x, y: 0.05, z }, 0, 0);
export default {
  setup(ctx) {
    const loot = ctx.mechanics.get('loot');
    const heard = { coins: 0, took: [] };
    loot.onCoin(d => { heard.coins += d.value; }); loot.onTake(d => heard.took.push(d.kind));
    window.__fx = {
      info: () => { const o = other(ctx); return { me: ctx.me.id, coins: Object.fromEntries(ctx.players.list().map(p => [p.id, loot.coinsOf(p)])), drops: loot.drops(), weapons: ctx.forge.entities(5).length, enemies: ctx.forge.entities(2).filter(e => !(e.flags & 1)).length, mine: ctx.me.health?.hp ?? null, other: o?.health?.hp ?? null, heard: JSON.parse(JSON.stringify(heard)), drawn: loot.observe().marks }; },
      fellAll: () => { const o = other(ctx), by = ctx.players.nid(o.id); let n = 0; for (const e of ctx.forge.entities(2)) { if (e.flags & 1) continue; ctx.forge.cmd.damage(e.net, 9999, by, [0, 0, 1]); n++; } return n; },
      hurtOther: n => ctx.forge.cmd.damage(ctx.players.nid(other(ctx).id), n, 0, [0, 0, 1]),
      putOther: (x, z) => put(ctx, other(ctx), x, z),
      otherAway: () => { const o = other(ctx), at = ctx.world.spawn(o.seat ?? 1); put(ctx, o, at.x, at.z); },
      weaponAt: () => { const e = ctx.forge.entities(5)[0]; return e ? { x: e.x, z: e.z } : null; },
      // QA for the pictures: the host 3 m on one side of a drop and the joiner 3 m on the other
      flank: (x, z) => { put(ctx, ctx.me, x, z - 3); put(ctx, other(ctx), x, z + 3); },
      face: (x, z) => window.__game.forge.face?.(x, 0.8, z),
    };
  },
  results(ctx) { return ctx.players.list().map(p => ({ id: p.id, name: p.name, value: p.score })); },
};
