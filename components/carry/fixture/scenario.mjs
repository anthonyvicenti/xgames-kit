// The joiner walks to a ball and grabs it (the host decides), carries it, throws it; both copies agree where it ends.
export default async function scenario({ H, J, ev, check, until, sleep }) {
  const info = P => ev(P, () => window.__fx.info());
  const [a0, b0] = [await info(H), await info(J)];
  check('both-list-the-same-items', a0.items.length === 2 && b0.items.length === 2 && a0.items.every(i => b0.items.some(j => j.id === i.id && Math.hypot(i.x - j.x, i.z - j.z) < 0.3)), `${a0.items.length} / ${b0.items.length} items`);
  await ev(J, () => window.__fx.toNearestItem());
  await sleep(700);
  await ev(J, () => window.__fx.grab());
  await until(async () => { const [a, b] = [await info(H), await info(J)]; return a.otherHeld && b.meHeld ? true : null; }, 5000, 'the grab').then(() => check('grab-granted-and-seen-on-both', true), () => check('grab-granted-and-seen-on-both', false, 'the joiner never held it'));
  const [a1, b1] = [await info(H), await info(J)];
  check('held-item-leaves-the-ground-list', a1.items.length === 1 && b1.items.length === 1, `${a1.items.length} / ${b1.items.length} free items`);
  await ev(J, () => window.__fx.throwForward());
  await until(async () => { const [a, b] = [await info(H), await info(J)]; return !a.otherHeld && !b.meHeld && a.items.length === 2 && b.items.length === 2 ? true : null; }, 5000, 'the throw').then(() => check('throw-releases-it-on-both', true), () => check('throw-releases-it-on-both', false, 'still held'));
  await sleep(3500);
  const [a2, b2] = [await info(H), await info(J)];
  const same = a2.items.every(i => b2.items.some(j => j.id === i.id && Math.hypot(i.x - j.x, i.z - j.z) < 0.6));
  check('thrown-item-rests-in-the-same-place', same, JSON.stringify(a2.items) + ' vs ' + JSON.stringify(b2.items));
}
