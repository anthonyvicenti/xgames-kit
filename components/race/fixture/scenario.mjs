// The host drives through the gates out of order, then in order; both copies agree on progress and the finish.
export default async function scenario({ H, J, ev, check, until, sleep }) {
  const info = P => ev(P, () => window.__fx.info());
  await ev(H, () => window.__fx.goTo(2)); await sleep(500);
  const a0 = await info(H); check('out-of-order-gate-does-not-count', a0.progress[a0.me].cp === 0, `cp ${a0.progress[a0.me].cp}`);
  for (const i of [0, 1]) { await ev(H, i2 => window.__fx.goTo(i2), i); await sleep(500); }
  await until(async () => { const [a, b] = [await info(H), await info(J)]; return a.progress[a.me].cp === 2 && b.progress[a.me].cp === 2 ? true : null; }, 5000, 'progress').then(() => check('progress-agrees-on-both', true), () => check('progress-agrees-on-both', false, 'differs'));
  await ev(H, () => window.__fx.goTo(2));
  await until(async () => { const [a, b] = [await info(H), await info(J)]; return a.order.length === 1 && b.order.length === 1 && a.order[0] === a.me && b.order[0] === a.me ? [a, b] : null; }, 6000, 'the finish').then(([a, b]) => check('finish-order-agrees-on-both', true, `order ${a.order}`), () => check('finish-order-agrees-on-both', false, 'no finish'));
  const [c, d] = [await info(H), await info(J)];
  check('place-points-and-check', c.score === 3 && c.check?.winners?.[0] === c.me && d.progress[c.me].done, `score ${c.score}, check ${JSON.stringify(c.check)}`);
}
