// The joiner steps on a spot: it disappears on both copies, the joiner scores, it comes back.
export default async function scenario({ H, J, ev, check, until, sleep }) {
  const info = P => ev(P, () => window.__fx.info());
  const [a0, b0] = [await info(H), await info(J)];
  check('both-see-the-same-spots', a0.spots.length === 2 && b0.spots.length === 2 && a0.spots.every((s, k) => Math.hypot(s.x - b0.spots[k].x, s.z - b0.spots[k].z) < 0.02 && s.present && b0.spots[k].present), JSON.stringify(a0.spots));
  await ev(J, () => window.__fx.stepOn(0));
  await until(async () => { const [a, b] = [await info(H), await info(J)]; return !a.spots[0].present && !b.spots[0].present ? true : null; }, 5000, 'the spot to go').then(() => check('collected-spot-vanishes-on-both', true), () => check('collected-spot-vanishes-on-both', false, 'still there'));
  const [a1, b1] = [await info(H), await info(J)];
  check('score-agrees-on-both', a1.scores[b1.me] === 1 && b1.scores[b1.me] === 1, `joiner score: host sees ${a1.scores[b1.me]}, joiner ${b1.scores[b1.me]}`);
  check('the-other-spot-is-untouched', a1.spots[1].present && b1.spots[1].present);
  await ev(J, () => { const s = window.__fx.info().spots[1]; });   // walk away is implicit: the spot returns while nobody stands on it
  await ev(J, () => window.__fx.stepOn(1)); await sleep(100); await ev(J, () => window.__fx.stepOn(1));
  await until(async () => { const [a, b] = [await info(H), await info(J)]; return a.spots[0].present && b.spots[0].present ? true : null; }, 8000, 'the spot to return').then(() => check('spot-returns-on-both-after-the-delay', true), () => check('spot-returns-on-both-after-the-delay', false, 'never came back'));
}
