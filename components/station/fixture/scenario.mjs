// The joiner works the desk (hold), the host sees it busy with the joiner and the progress rise; completion and quota count on both.
export default async function scenario({ H, J, ev, check, until, sleep }) {
  const info = P => ev(P, () => window.__fx.info());
  await ev(J, () => window.__fx.goToDesk(-0.5)); await ev(H, () => window.__fx.goToDesk(0.5));
  await sleep(800);
  await ev(J, () => window.__fx.use(true));
  await until(async () => { const [a, b] = [await info(H), await info(J)]; return a.s.state === 'busy' && b.s.state === 'busy' && a.s.who === b.me ? true : null; }, 5000, 'busy').then(() => check('busy-with-the-joiner-on-both', true), () => check('busy-with-the-joiner-on-both', false, 'not busy'));
  await ev(H, () => window.__fx.use(true));
  const a = await info(H); check('a-second-worker-is-refused', a.s.who !== a.me, `worker ${a.s.who}`);
  await sleep(500);
  const mid = await info(H); check('progress-rises-on-the-host', mid.s.progress > 0.1 && mid.s.progress < 1, `progress ${mid.s.progress}`);
  await until(async () => { const [x, y] = [await info(H), await info(J)]; return x.q.done === 1 && y.q.done === 1 ? true : null; }, 6000, 'completion').then(() => check('completion-counts-on-both', true), () => check('completion-counts-on-both', false, 'no completion'));
  const [c, d] = [await info(H), await info(J)];
  check('score-and-cooldown-agree', c.s.state === 'cool' && d.s.state === 'cool' && c.score === 0 && d.score === 1, `${c.s.state}/${d.s.state}, joiner score ${d.score}`);
  await ev(J, () => window.__fx.use(false));
  await until(async () => (await info(J)).s.state === 'idle', 6000, 'ready').then(() => check('station-is-ready-again', true), () => check('station-is-ready-again', false, 'stuck'));
  await ev(H, () => window.__fx.use(true));
  await until(async () => { const [x, y] = [await info(H), await info(J)]; return x.q.done === 2 && y.q.done === 2 && x.q.met && y.q.met ? true : null; }, 8000, 'the quota').then(() => check('quota-met-on-both', true), () => check('quota-met-on-both', false, 'quota not met'));
}
