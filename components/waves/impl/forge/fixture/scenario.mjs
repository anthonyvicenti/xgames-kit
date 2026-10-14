// The params' plan is the core's on both copies; wave 1 comes with its two enemies on both screens; kills in the
// joiner's name count and score on both; wave 2 comes and is cleared, and both copies say the waves are done.
export default async function scenario({ H, J, ev, check, until, sleep, shot }) {
  const info = P => ev(P, () => window.__fx.info());
  const [a0, b0] = [await info(H), await info(J)];
  check('the-plan-is-the-params', JSON.stringify(a0.plan) === '[2,3]' && JSON.stringify(b0.plan) === '[2,3]', `host ${JSON.stringify(a0.plan)}, joiner ${JSON.stringify(b0.plan)} (startCount 2, growth 1, maxWaves 2)`);
  await until(async () => { const [a, b] = [await info(H), await info(J)]; return a.state.wave === 1 && b.state.wave === 1 && a.state.alive === 2 && b.state.alive === 2; }, 15000, 'wave 1').then(
    () => check('wave-1-with-two-on-both', true), async () => check('wave-1-with-two-on-both', false, JSON.stringify([(await info(H)).state, (await info(J)).state])));
  await sleep(800);
  await ev(H, () => window.__fx.faceEnemy()); await ev(J, () => window.__fx.faceEnemy()); await sleep(400);
  await shot(H, 'host-wave-1'); await shot(J, 'joiner-wave-1');
  const jid = (await info(J)).me;
  await ev(H, () => window.__fx.fellAll());
  await until(async () => { const [a, b] = [await info(H), await info(J)]; return a.state.kills === 2 && b.state.kills === 2 && a.state.alive === 0 && b.state.alive === 0; }, 6000, 'the kills').then(
    () => check('kills-count-on-both', true, '2 kills, none standing, on both'), async () => check('kills-count-on-both', false, JSON.stringify([(await info(H)).state, (await info(J)).state])));
  await until(async () => (await info(H)).scores[jid] === 2 && (await info(J)).scores[jid] === 2, 3000, 'the score').then(
    () => check('kills-score-for-the-killer-on-both', true, 'killPoints 1 a kill to the joiner'), async () => check('kills-score-for-the-killer-on-both', false, JSON.stringify([(await info(H)).scores, (await info(J)).scores])));
  await until(async () => { const [a, b] = [await info(H), await info(J)]; return a.state.wave === 2 && b.state.wave === 2 && a.state.alive >= 1 && b.state.alive >= 1; }, 15000, 'wave 2').then(
    () => check('wave-2-comes-on-both', true), async () => check('wave-2-comes-on-both', false, JSON.stringify([(await info(H)).state, (await info(J)).state])));
  await until(async () => { await ev(H, () => window.__fx.fellAll()); const [a, b] = [await info(H), await info(J)]; return a.state.cleared && b.state.cleared; }, 20000, 'all clear').then(
    () => check('all-cleared-on-both', true), async () => check('all-cleared-on-both', false, JSON.stringify([(await info(H)).state, (await info(J)).state])));
  const a = await info(H);
  check('the-host-hears-each-wave', JSON.stringify(a.heard.start) === '[1,2]' && a.heard.all === 1 && a.heard.kills === 5, JSON.stringify(a.heard));
}
