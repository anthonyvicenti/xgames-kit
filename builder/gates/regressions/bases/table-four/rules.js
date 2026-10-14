// Table Four: four in a row played from the seats. The board mechanic does the grid, the turns, the pointers, the
// refusals, the discs, the bots and the end of the round, and the kit shows each friend by a seat card, an avatar
// that reacts, their pointer and their moves (gf/mp/presence.js: seats). This file is what makes it four in a row.
export default {
  setup(ctx) {
    const board = ctx.mechanics.get('board');
    const need = ctx.config.rules?.params?.need ?? 4;     // the rules.need slot (config/game.json → rules.params)
    board.rules({
      // input "drop" already sends a disc to the free cell nearest row 0 and refuses a full column: no legal() needed
      winner(s) {
        const line = s.last && s.line(...s.last, need);
        if (line) return { seat: s.owner(...s.last), cells: line, reason: `${need} in a row` };
        return s.full() ? { draw: true, reason: 'the board is full' } : null;
      },
    });
  },
  // a bot steps its pointer to its column before it drops
  bot(ctx, p, dt) { ctx.mechanics.get('board').bot(p, dt); },
  observe(ctx) { return ctx.mechanics.get('board').observe(); },      // QA: what a test and a play-tester read
  results(ctx) { return ctx.players.list().map(p => ({ id: p.id, name: p.name, value: p.score })); },
};
