// Coin Hop's own test (measure 35), played by runtime godot's measure tool in its live leg with two real players:
// the host runs along the floor through a coin; the point is the host's on both screens, and the coin is gone from
// the joiner's screen as the host's copy says (the host owns the coins).
export default async function coins({ host, joiner, game, sleep, check }) {
  const before = await game(host);
  const scoreOf = (s, id) => s.players.find(p => p.id === id)?.score ?? 0;
  const me = before.net.you;
  // the floor's coins sit at x = ±11.5, 1.5 m up: a body standing under one touches it. Run back to the left one.
  await host.keyboard.down('KeyA'); await sleep(1300); await host.keyboard.up('KeyA');
  await sleep(250);
  const [h, j] = [await game(host), await game(joiner)];
  const got = scoreOf(h, me) - scoreOf(before, me);
  check('own:coin-scores-for-the-host', got >= 1 && scoreOf(j, me) === scoreOf(h, me), `the host's score went ${scoreOf(before, me)} → ${scoreOf(h, me)} on the host's copy; the joiner's copy shows ${scoreOf(j, me)}`);
  const up = h.rules?.coinsUp, drawnJ = j.godot?.game?.coinsDrawn;
  check('own:a-taken-coin-is-gone-for-everyone', up < h.rules?.coins && j.rules?.coinsUp === up && drawnJ === up, `coins up on the host's copy ${up} of ${h.rules?.coins}; on the joiner's ${j.rules?.coinsUp}; drawn by the joiner's game ${drawnJ}`);
}
