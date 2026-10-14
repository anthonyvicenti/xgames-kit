// Health fixture on forge: the host hurts and heals the joiner through the mechanic. Exposes window.__fx (QA only).
const other = ctx => ctx.players.list().find(p => !p.local && !p.ghost) ?? null;
export default {
  setup(ctx) {
    const hp = ctx.mechanics.get('health');
    const seen = { hurt: 0, damage: [], down: 0, respawn: 0 };
    hp.onHurt(d => { if (d.player === ctx.me) seen.hurt++; });
    hp.onDamage(d => seen.damage.push(Math.round(d.amount)));
    hp.onDown(() => seen.down++);
    hp.onRespawn(() => seen.respawn++);
    window.__fx = {
      info: () => { const o = other(ctx); return { me: ctx.me.id, mine: hp.hpOf(ctx.me), max: hp.maxHp(), other: o ? hp.hpOf(o) : null, meDown: hp.isDown(ctx.me), otherDown: o ? hp.isDown(o) : null, meAlive: ctx.me.alive !== false, otherAlive: o ? o.alive !== false : null, seen: JSON.parse(JSON.stringify(seen)) }; },
      hurtOther: n => hp.damage(other(ctx), n, { from: ctx.me }),
      healOther: n => hp.heal(other(ctx), n),
      hurtMe: n => hp.damage(ctx.me, n),
    };
  },
  results(ctx) { return ctx.players.list().map(p => ({ id: p.id, name: p.name, value: p.score })); },
};
