// Projectile fixture rules: the whole game. Exposes window.__fx for the scenario (research/gf-three/tests/k2-fixture.mjs).
export default {
  setup(ctx) {
    const prj = ctx.mechanics.get('projectile');
    let streamOn = false;
    prj.onHit(h => { if (h.shooter && h.target && h.kind === 'discrete') h.shooter.score += 1; });
    const other = () => ctx.players.list().find(p => p.id !== ctx.me.id);
    window.__fx = {
      fireAtOther: () => { const o = other(), me = ctx.me; const d = [o.position.x - me.position.x, 0.1, o.position.z - me.position.z]; return prj.fire(me, d); },
      // the stream goes to the aim point (kit/core/aim.js): hold the aim on the other player's chest while spraying
      streamAtOther: on => { streamOn = on; const o = other(), me = ctx.me; me.controller.aimAt(on ? { x: o.position.x, y: o.position.y + 1.0, z: o.position.z } : null); },
      info: () => { const o = other(), me = ctx.me, hp = ctx.mechanics.get('health'); return { me: { x: me.position.x, z: me.position.z, anim: me.anim, hp: hp.hpOf(me), score: me.score }, other: { id: o.id, x: o.position.x, z: o.position.z, anim: o.anim, hp: hp.hpOf(o), score: o.score, streaming: prj.streaming(o) }, lastFx: prj.lastFx, active: prj.active(), end: prj.pathEnd(o) ?? prj.pathEnd(me) }; },
      setKind: k => { prj.params.kind = k; },
    };
    ctx.onFrame.push(() => { if (ctx.me) prj.stream(ctx.me, streamOn); });
  },
  digest(ctx) { return ''; },
};
