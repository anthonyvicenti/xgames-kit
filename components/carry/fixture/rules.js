// Carry fixture rules. Exposes window.__fx for the scenario.
export default {
  setup(ctx) {
    const carry = ctx.mechanics.get('carry');
    const other = () => ctx.players.list().find(p => p.id !== ctx.me.id);
    window.__fx = {
      toNearestItem: () => { const me = ctx.me, it = carry.nearest(me.position); me.teleport({ x: it.x + 0.6, y: 0, z: it.z }, 0); return it; },
      grab: () => carry.grab(ctx.me),
      throwForward: () => carry.throw(ctx.me, [0, 0, 1]),
      info: () => { const me = ctx.me, o = other(); return { items: carry.items().map(i => ({ id: i.id, x: Math.round(i.x * 10) / 10, z: Math.round(i.z * 10) / 10 })), meHeld: carry.held(me), otherHeld: carry.held(o), me: { x: me.position.x, z: me.position.z } }; },
    };
  },
};
