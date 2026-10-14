// The host hurts the joiner: the same hit points on both screens, the joiner's copy hears it (onHurt), the host's says
// how much (onDamage); a heal agrees on both; left alone, regen fills the joiner on both. At zero with the host standing
// the joiner is down on both; with nobody standing both are out, and come back after respawnSeconds on both.
export default async function scenario({ H, J, ev, check, until, sleep, shot }) {
  const info = P => ev(P, () => window.__fx.info());
  const near = (a, b) => Math.abs(a - b) < 0.6;
  const max = (await info(H)).max;
  check('both-start-full', near((await info(H)).other, max) && near((await info(J)).mine, max), `max ${max}`);
  await ev(H, () => window.__fx.hurtOther(30));
  await until(async () => near((await info(H)).other, max - 30) && near((await info(J)).mine, max - 30), 3000, 'the hit on both').then(
    () => check('damage-agrees-on-both', true, `${max} → ${max - 30} on both screens`), async () => check('damage-agrees-on-both', false, `host sees ${(await info(H)).other}, joiner ${(await info(J)).mine}`));
  const [a, b] = [await info(H), await info(J)];
  check('joiner-copy-hears-the-hurt', b.seen.hurt >= 1, `onHurt on the joiner's copy: ${b.seen.hurt}`);
  check('host-hears-how-much', a.seen.damage.includes(30), `onDamage on the host: ${JSON.stringify(a.seen.damage)}`);
  await ev(H, () => window.__fx.healOther(10));
  await until(async () => near((await info(H)).other, max - 20) && near((await info(J)).mine, max - 20), 1500, 'the heal on both').then(
    () => check('heal-agrees-on-both', true, `${max - 30} → ${max - 20}`), async () => check('heal-agrees-on-both', false, `host ${(await info(H)).other}, joiner ${(await info(J)).mine}`));
  await until(async () => near((await info(H)).other, max) && near((await info(J)).mine, max), 6000, 'regen').then(
    () => check('regen-fills-on-both', true, 'regen 20/s after 2 s alone'), async () => check('regen-fills-on-both', false, `host ${(await info(H)).other}, joiner ${(await info(J)).mine}`));
  await ev(H, () => window.__fx.hurtOther(999));
  await until(async () => (await info(H)).otherDown && (await info(J)).meDown, 4000, 'down on both').then(
    () => check('zero-is-down-on-both', true, 'with the host standing the joiner is down'), async () => check('zero-is-down-on-both', false, JSON.stringify([await info(H), await info(J)])));
  check('host-hears-the-fall', (await info(H)).seen.down >= 1);
  await shot(J, 'joiner-down');
  await ev(H, () => window.__fx.hurtMe(999));
  await until(async () => { const [x, y] = [await info(H), await info(J)]; return !x.meAlive && !y.meAlive ? true : null; }, 5000, 'out on both').then(
    () => check('nobody-standing-is-out-on-both', true), async () => check('nobody-standing-is-out-on-both', false, JSON.stringify([await info(H), await info(J)])));
  await until(async () => { const [x, y] = [await info(H), await info(J)]; return x.meAlive && y.meAlive && near(x.mine, max) && near(y.mine, max) && near(x.other, max) ? true : null; }, 9000, 'respawn').then(
    () => check('respawn-on-both', true, `both back at ${max} after respawnSeconds 3`), async () => check('respawn-on-both', false, JSON.stringify([await info(H), await info(J)])));
  check('respawns-heard', (await info(H)).seen.respawn >= 2, `onRespawn ${(await info(H)).seen.respawn}`);
}
