// Two players, three in a row. A move shows on both copies; a move out of turn, onto a taken cell, or sent in another
// player's name is refused by the host and changes nothing; the win, the score and the end of the round agree.
export default async function scenario({ H, J, ev, check, until, sleep }) {
  const info = P => ev(P, () => window.__fx.info());
  const play = (P, c, r) => ev(P, ([c, r]) => window.__fx.play(c, r), [c, r]);
  const send = (P, c, r, as) => ev(P, ([c, r, as]) => window.__fx.send(c, r, as), [c, r, as]);
  const both = async (n, label) => until(async () => { const [a, b] = [await info(H), await info(J)]; return a.obs.moves === n && b.obs.moves === n && a.obs.grid === b.obs.grid && a.turn === b.turn ? true : null; }, 6000, label)
    .then(() => check(label, true), async () => { const [a, b] = [await info(H), await info(J)]; check(label, false, `host ${a.obs.moves} ${a.obs.grid} turn ${a.turn} | joiner ${b.obs.moves} ${b.obs.grid} turn ${b.turn}`); });
  await until(async () => { const [a, b] = [await info(H), await info(J)]; return a.seat >= 0 && b.seat >= 0 && a.turn !== null && a.turn === b.turn ? true : null; }, 8000, 'both seated');
  const [a0, b0] = [await info(H), await info(J)];
  check('seats-and-the-first-turn-agree', a0.seat !== b0.seat && a0.turn === b0.turn && a0.obs.grid === '.........', `host seat ${a0.seat}, joiner seat ${b0.seat}, turn ${a0.turn}`);
  const [first, second] = a0.turn === a0.seat ? [H, J] : [J, H];
  // out of turn, through the player's own way in: told why at once, nothing sent
  const why = await play(second, 1, 1);
  check('out-of-turn-is-refused-on-the-players-own-copy', why === 'Not your turn' && (await info(second)).obs.lastRefusal?.why === 'Not your turn', `answer "${why}"`);
  // out of turn, from a copy that skips its own check: the host refuses and says why
  const refusedBefore = (await info(H)).obs.refused;
  if (second === J) {
    await send(J, 0, 0);
    await until(async () => (await info(H)).obs.refused > refusedBefore, 4000, 'the host to refuse').then(() => check('the-host-refuses-a-move-out-of-turn', true), () => check('the-host-refuses-a-move-out-of-turn', false, 'the host never counted a refusal'));
    await sleep(300);
    const j = await info(J);
    check('the-refused-player-is-told-why', j.obs.lastRefusal?.why === 'Not your turn' && j.obs.moves === 0, `joiner heard "${j.obs.lastRefusal?.why}", moves ${j.obs.moves}`);
    // in the host's name: ignored (a move is its sender's)
    await send(J, 2, 2, (await info(H)).me); await sleep(500);
    check('a-move-in-another-players-name-is-ignored', (await info(H)).obs.moves === 0, `moves ${(await info(H)).obs.moves}`);
  }
  check('the-first-move-is-played', (await play(first, 1, 1)) === null);
  await both(1, 'a-move-shows-on-both');
  const taken = await play(second, 1, 1);
  check('a-taken-cell-is-refused-with-the-reason', taken === 'That cell is taken', `answer "${taken}"`);
  await play(second, 0, 0); await both(2, 'the-turn-passes-and-comes-back');
  await play(first, 0, 1); await both(3, 'move-3-on-both');
  await play(second, 2, 2); await both(4, 'move-4-on-both');
  await play(first, 2, 1);
  await until(async () => { const [a, b] = [await info(H), await info(J)]; return a.result && b.result ? true : null; }, 6000, 'the result');
  const [a, b] = [await info(H), await info(J)];
  check('the-win-line-is-the-same-on-both', JSON.stringify(a.result) === JSON.stringify(b.result) && a.result.cells.length === 3 && a.result.reason === 'three in a row', JSON.stringify(a.result));
  const late = await play(second, 2, 0);
  check('nothing-moves-after-the-win', late === 'The game is over' && (await info(H)).obs.moves === 5, `answer "${late}"`);
  await until(async () => { const [x, y] = [await info(H), await info(J)]; return x.phase === 'results' && y.phase === 'results' ? true : null; }, 8000, 'the round to end').then(() => check('the-board-ends-the-round-on-both', true), () => check('the-board-ends-the-round-on-both', false, 'still playing'));
  const [fa, fb] = [await info(first), await info(second)];
  check('the-winner-scores-on-both', fa.score === 1 && fb.score === 0, `winner ${fa.score}, other ${fb.score}`);
}
