// Board fixture rules: three in a row on a 3 by 3. Exposes window.__fx for the scenario.
export default {
  setup(ctx) {
    const board = ctx.mechanics.get('board');
    board.rules({ winner: s => { const l = s.last && s.line(...s.last, 3); return l ? { seat: s.owner(...s.last), cells: l, reason: 'three in a row' } : s.full() ? { draw: true } : null; } });
    window.__fx = {
      // the player's own way in: checked on this copy first, then by the host
      play: (c, r) => board.play(ctx.me, { type: 'place', to: [c, r] }),
      // a copy that skips its own check (or lies about who it is): only the host's answer counts
      send: (c, r, as = ctx.me.id) => ctx.net.send('board:move', { p: as, m: { type: 'place', to: [c, r] } }, 'host'),
      info: () => ({ me: ctx.me.id, host: ctx.host, seat: board.seatOf(ctx.me), turn: board.turn()?.seat ?? null, score: ctx.me.score, phase: ctx.round.phase, result: board.result(), obs: board.observe() }),
    };
  },
};
