// A kill in the joiner's name: its coins reach a player and both copies count them the same; a potion lies in the same
// place on both screens and a weapon on both; the joiner (hurt first) walks onto the potion: gone on both, healed on
// both; then onto the weapon: gone on both.
export default async function scenario({ H, J, ev, check, until, sleep, shot }) {
  const info = P => ev(P, () => window.__fx.info());
  await until(async () => (await info(H)).enemies >= 1 && (await info(J)).enemies >= 1, 15000, 'the enemy on both');
  await sleep(600);
  await ev(H, () => window.__fx.fellAll());
  await until(async () => { const [a, b] = [await info(H), await info(J)]; return a.drops.length === 1 && b.drops.length === 1; }, 6000, 'the potion on both').then(
    async () => { const [a, b] = [await info(H), await info(J)]; check('potion-lies-in-the-same-place-on-both', Math.hypot(a.drops[0].x - b.drops[0].x, a.drops[0].z - b.drops[0].z) < 0.02, JSON.stringify([a.drops[0], b.drops[0]])); },
    async () => check('potion-lies-in-the-same-place-on-both', false, JSON.stringify([(await info(H)).drops, (await info(J)).drops])));
  await until(async () => { const [a, b] = [await info(H), await info(J)]; const s = o => Object.values(o.coins).reduce((n, v) => n + v, 0); return s(a) >= 2 && JSON.stringify(a.coins) === JSON.stringify(b.coins) ? [a, b] : null; }, 8000, 'the coins').then(
    ([a]) => check('coins-counted-the-same-on-both', true, JSON.stringify(a.coins)), async () => check('coins-counted-the-same-on-both', false, JSON.stringify([(await info(H)).coins, (await info(J)).coins])));
  await until(async () => (await info(H)).weapons === 1 && (await info(J)).weapons === 1, 6000, 'the weapon on both').then(
    () => check('weapon-lies-on-both', true), async () => check('weapon-lies-on-both', false, `host ${(await info(H)).weapons}, joiner ${(await info(J)).weapons}`));
  await until(async () => (await info(H)).drawn.drawn === 1 && (await info(J)).drawn.drawn === 1, 8000, 'the potion drawn').then(
    () => check('both-draw-the-potion', true), async () => check('both-draw-the-potion', false, JSON.stringify([(await info(H)).drawn, (await info(J)).drawn])));
  const p = (await info(H)).drops[0];
  await ev(H, d => window.__fx.flank(d.x, d.z), p); await sleep(700);
  await ev(H, d => window.__fx.face(d.x, d.z), p); await ev(J, d => window.__fx.face(d.x, d.z), p); await sleep(500);
  await shot(H, 'host-sees-the-drop'); await shot(J, 'joiner-sees-the-drop');
  await ev(H, () => window.__fx.hurtOther(40));
  await until(async () => { const [a, b] = [await info(H), await info(J)]; return a.other <= 60.5 && b.mine <= 60.5 ? true : null; }, 3000, 'the hurt');
  const before = (await info(H)).other;
  await ev(H, d => window.__fx.putOther(d.x, d.z), p);
  await until(async () => { const [a, b] = [await info(H), await info(J)]; return !a.drops.length && !b.drops.length; }, 5000, 'the potion taken').then(
    () => check('potion-taken-goes-on-both', true), () => check('potion-taken-goes-on-both', false));
  await until(async () => { const [a, b] = [await info(H), await info(J)]; return Math.abs(a.other - Math.min(100, before + 25)) < 0.6 && Math.abs(b.mine - a.other) < 0.6 ? [a, b] : null; }, 3000, 'the heal').then(
    ([a, b]) => check('potion-heals-on-both', true, `${before} → ${a.other} (host) / ${b.mine} (joiner)`), async () => check('potion-heals-on-both', false, JSON.stringify([(await info(H)).other, (await info(J)).mine])));
  const w = await ev(H, () => window.__fx.weaponAt());
  if (w) {
    await ev(H, d => window.__fx.putOther(d.x, d.z), w);
    await until(async () => (await info(H)).weapons === 0 && (await info(J)).weapons === 0, 5000, 'the weapon taken').then(
      () => check('weapon-taken-goes-on-both', true), () => check('weapon-taken-goes-on-both', false));
  } else check('weapon-taken-goes-on-both', false, 'no weapon to take');
  check('the-host-hears-the-take', (await info(H)).heard.took.includes('potion'), JSON.stringify((await info(H)).heard));
}
