// Lights Race: a lights out puzzle, everyone on a board of their own at once (the board mechanic's boards "own"). The
// mechanic deals the one opening, takes your presses, draws your board and ends the round on the first board cleared;
// the kit shows each friend's board live beside yours (gf/mp/presence.js: boards). This file is what makes it lights out.
const lcg = seed => { let x = (seed >>> 0) || 1; return () => (x = (Math.imul(x, 1664525) + 1013904223) >>> 0) / 4294967296; };
// a press switches the light and its four neighbours
function press(s, c, r) {
  for (const [x, y] of [[c, r], ...s.neighbours(c, r)]) s.set(x, y, s.empty(x, y) ? { seat: 0 } : null);
}
export default {
  setup(ctx) {
    const board = ctx.mechanics.get('board');
    const presses = ctx.config.rules?.params?.presses ?? 7;     // the rules.presses slot: how many lights a board starts with, roughly
    board.rules({
      // the one opening: presses from an empty board, so every board can be cleared (s.data.seed is the round's, the same everywhere)
      start(s) { const rnd = lcg(s.data.seed); for (let i = 0; i < presses; i++) press(s, Math.floor(rnd() * s.cols), Math.floor(rnd() * s.rows)); if (!s.count(0)) press(s, 2, 2); },
      legal: () => true,                                         // any light may be pressed
      apply(m, s) { press(s, ...m.to); },
      winner: s => (s.moves > 0 && s.count(0) === 0 ? { seat: 0, cells: [], reason: 'every light off' } : null),
      // a bot chases the lights down the board, then tries a top-row light when only the last row is left
      bot(s, seat, rng) {
        for (let r = 0; r < s.rows - 1; r++) for (let c = 0; c < s.cols; c++) if (!s.empty(c, r)) return { type: 'place', to: [c, r + 1] };
        return { type: 'place', to: [Math.floor(rng() * s.cols), 0] };
      },
    });
    // the score is the lights you have switched off, counted on the host from each move on your own board
    board.onMove(({ player, state }) => { player.score = state.cols * state.rows - state.count(0); });
  },
  observe(ctx) { return ctx.mechanics.get('board').observe(); },      // QA: what a test and a play-tester read
  results(ctx) { return ctx.players.list().map(p => ({ id: p.id, name: p.name, value: p.score })); },
};
