// Two players and a boss: it comes on both copies with its bar; a joiner's swing hurts it on the host; its phases
// change on both copies at the thresholds; it goes down on both.
export default async function scenario({ H, J, ev, check, until, sleep }) {
  const info = P => ev(P, () => window.__fx.info());
  const both = async f => { const [a, b] = [await info(H), await info(J)]; return f(a) && f(b) ? [a, b] : null; };
  await until(() => both(x => x.active && x.state === 'chase'), 15000, 'the boss').then(([a, b]) => check('the-boss-comes-on-both-with-its-bar', !!(a.bar?.shown && b.bar?.shown), `"${a.bar?.text}" ${a.hp}/${a.max}; joiner bar ${b.bar?.shown}`), () => check('the-boss-comes-on-both-with-its-bar', false, 'no boss'));
  await ev(H, () => window.__fx.hurt(15));                       // 40 → 25: just above 60% (24)
  const s0 = await info(H);
  await ev(J, () => window.__fx.standBy()); await sleep(500);
  await ev(J, () => window.__fx.swingAt()); await sleep(250); await ev(J, () => window.__fx.aim());
  await until(() => both(x => x.hp < s0.hp), 6000, 'the joiner\'s hit').then(([a, b]) => check('a-joiners-swing-hurts-the-boss-on-the-host', a.hp === b.hp, `${s0.hp} → ${a.hp} (host) / ${b.hp} (joiner)`), () => check('a-joiners-swing-hurts-the-boss-on-the-host', false, 'no damage'));
  await until(() => both(x => x.phase === 1), 6000, 'phase 2').then(([a, b]) => check('phase-2-on-both-copies', true, `hp ${a.hp}; ${a.state} / ${b.state}`), async () => check('phase-2-on-both-copies', false, JSON.stringify(await info(J))));
  await sleep(1600);                                               // the roar takes no hits
  await ev(H, () => window.__fx.hurt(12));
  await until(() => both(x => x.phase === 2), 6000, 'phase 3').then(() => check('phase-3-on-both-copies', true), () => check('phase-3-on-both-copies', false));
  await sleep(1600);
  await ev(H, () => window.__fx.hurt(99));
  await until(() => both(x => x.dead), 6000, 'down').then(([a, b]) => check('it-goes-down-on-both-and-its-bar-goes', !a.bar?.shown && !b.bar?.shown), () => check('it-goes-down-on-both-and-its-bar-goes', false));
}
