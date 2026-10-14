// The joiner walks into a spot (the host's core moves them there): it goes on both screens, the joiner scores on both,
// the other spot stays, and once the joiner is away the spot comes back on both.
export default async function scenario({ H, J, ev, check, until, sleep, shot }) {
  const info = P => ev(P, () => window.__fx.info());
  await until(async () => (await info(H)).spots.length === 2 && (await info(J)).spots.length === 2, 8000, 'the spots on both');
  const [a0, b0] = [await info(H), await info(J)];
  check('both-see-the-same-spots', a0.spots.every((s, k) => Math.hypot(s.x - b0.spots[k].x, s.z - b0.spots[k].z) < 0.02 && s.present && b0.spots[k].present), JSON.stringify(a0.spots.map(s => [s.x, s.z])));
  await until(async () => (await info(H)).drawn.drawn === 2 && (await info(J)).drawn.drawn === 2, 10000, 'the spots drawn').then(
    () => check('both-draw-the-spots', true, 'two instances of the spot model on each screen'),
    async () => check('both-draw-the-spots', false, `host ${JSON.stringify((await info(H)).drawn)}, joiner ${JSON.stringify((await info(J)).drawn)}`));
  await ev(H, () => window.__fx.face(1)); await ev(J, () => window.__fx.face(1)); await sleep(500);
  await shot(H, 'host-sees-spots'); await shot(J, 'joiner-sees-spots');
  const jid = (await info(J)).me;
  await ev(H, () => window.__fx.putOther(0));
  await until(async () => { const [a, b] = [await info(H), await info(J)]; return !a.spots[0].present && !b.spots[0].present; }, 6000, 'the spot to go').then(
    () => check('taken-spot-goes-on-both', true), () => check('taken-spot-goes-on-both', false, 'still there'));
  await until(async () => (await info(H)).scores[jid] === 1 && (await info(J)).scores[jid] === 1, 4000, 'the score').then(
    () => check('joiner-scores-on-both', true, 'joiner 1 point on both screens'), async () => check('joiner-scores-on-both', false, `host sees ${(await info(H)).scores[jid]}, joiner ${(await info(J)).scores[jid]}`));
  const [a1, b1] = [await info(H), await info(J)];
  check('the-other-spot-stays', a1.spots[1].present && b1.spots[1].present);
  await ev(H, () => window.__fx.otherAway());
  await until(async () => { const [a, b] = [await info(H), await info(J)]; return a.spots[0].present && b.spots[0].present; }, 9000, 'the spot to come back').then(
    () => check('spot-comes-back-on-both', true, 'after respawnSeconds 3'), () => check('spot-comes-back-on-both', false, 'never came back'));
  check('scored-once', (await info(H)).scores[jid] === 1, `joiner ${(await info(H)).scores[jid]}`);
}
