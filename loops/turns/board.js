// How the turns flow and the board mechanic (kit/mechanics/board) join, through the board's public interface only.
// The board keeps everything about the grid: who sits where, legal moves, refusals, pieces, the win, its bots' choice of
// move and the turn line it draws. Of the three things its author left as inputs, the flow takes two, and nothing else:
//
//   whose turn is next    board.rules({ next }) answers with the flow's next player, and board.setTurn(seat) follows
//                         the flow when the turn changes for the flow's own reasons (the clock, a seat that left or is
//                         away, a player with no move)
//   the turn clock        the flow's (round.params.turnSeconds, on the HUD's clock); the board's own must be off
//                         (board params turnSeconds 0: create refuses the pair otherwise, manifest.refuse)
//
// and the board tells the flow when a move was played (board.onMove) or refused (board.onRefuse), so the count of
// moves, turns and refusals is one count on every screen. The game writes nothing for this: the flow joins a board it
// finds when play first starts.
export function boardAdapter(ctx, board, turns) {
  const seatOf = p => (p ? board.seatOf(p) : -1);
  board.rules({ next: () => { const p = turns.next(); const k = seatOf(p); return k >= 0 ? k : undefined; } });
  return {
    /** The board has seated this round's players (it does so in the frame play starts) and is not decided. */
    ready: () => !!board.turn(),
    over: () => !!board.result(),
    seated: p => seatOf(p) >= 0,
    canAct: p => board.moves(seatOf(p)).length > 0,
    turnOf: () => board.turn()?.player ?? null,
    setTurn: p => board.setTurn(seatOf(p)),
    onMove: fn => board.onMove(e => fn({ player: e.player, move: e.move, auto: e.auto })),
    onRefuse: fn => board.onRefuse(e => fn({ player: e.player, why: e.why })),
    /** The turn clock ran out: a legal move is played for that player, as the board's own clock did. */
    timeout(p) {
      const list = board.moves(seatOf(p)); if (!list.length) return false;
      const m = list[Math.floor((ctx.rng?.() ?? Math.random()) * list.length) % list.length];
      return board.play(p, m) === null;
    },
    bots: true,       // the board thinks and plays for its bots (rules.bot → board.bot(p, dt) only walks them there)
    shows: true,      // the board says whose turn it is on the board and the goal line
  };
}
