// One player starts as it (the host picks); it runs into the other; the role passes, and both copies agree.
export default async function scenario({ H, J, ev, check, until, sleep }) {
  const info = P => ev(P, () => window.__fx.info());
  const start = await until(async () => { const [a, b] = [await info(H), await info(J)]; return a.its.length === 1 && b.its.length === 1 && a.its[0] === b.its[0] ? [a, b] : null; }, 8000, 'an it').then(r => { check('both-agree-who-starts-as-it', true, `it: ${r[0].its[0]}`); return r; }, () => { check('both-agree-who-starts-as-it', false, 'no agreement'); return null; });
  if (!start) return;
  const itId = start[0].its[0], P = itId === start[0].me ? H : J, Q = P === H ? J : H;
  await sleep(1200);
  await ev(P, () => window.__fx.chaseOther());
  await until(async () => { const [a, b] = [await info(H), await info(J)]; return a.its.length === 1 && b.its.length === 1 && a.its[0] !== itId && b.its[0] === a.its[0] ? true : null; }, 6000, 'the tag').then(() => check('role-passes-on-both-copies', true), () => check('role-passes-on-both-copies', false, 'still the same it'));
  await sleep(2600);
  const [a, b] = [await info(H), await info(J)];
  check('time-as-it-is-counted', (a.itTime[itId] ?? 0) > 0.5 && Math.abs((a.itTime[itId] ?? 0) - (b.itTime[itId] ?? 0)) < 1.5, `host ${a.itTime[itId]}, joiner ${b.itTime[itId]}`);
  check('no-tag-back-inside-the-cooldown', a.its.length === 1 && a.its[0] !== itId, `it: ${a.its}`);
}
