// Two players on floating isles: a cleared isle opens its portal on both copies; one player in it is not enough; both
// in, both move to isle 2 (the world's level and each player's place); clearing the last isle wins the round on both.
export default async function scenario({ H, J, ev, check, until, sleep }) {
  const info = P => ev(P, () => window.__fx.info());
  const both = async f => { const [a, b] = [await info(H), await info(J)]; return f(a) && f(b) ? [a, b] : null; };
  await until(() => both(x => x.enemies >= 1), 15000, 'the first warrior').then(() => check('both-see-isle-1-and-its-enemy', true), () => check('both-see-isle-1-and-its-enemy', false, 'no enemy'));
  await ev(H, () => window.__fx.killAll());
  await until(() => both(x => x.phase === 'open' && x.open), 8000, 'the portal').then(([a]) => check('a-cleared-isle-opens-its-portal-on-both', true, `portal at ${a.portal.x}, ${a.portal.z}`), () => check('a-cleared-isle-opens-its-portal-on-both', false, 'not open'));
  await ev(J, () => window.__fx.intoPortal()); await ev(H, () => window.__fx.awayFromPortal());
  await sleep(1500);
  const one = await info(H);
  check('one-player-in-the-portal-waits', one.phase === 'open' && one.level === 0, `phase ${one.phase}, level ${one.level}`);
  await ev(H, () => window.__fx.intoPortal());
  await until(() => both(x => x.level === 1 && x.worldLevel === 1 && x.phase === 'fight'), 10000, 'isle 2')
    .then(([a, b]) => check('both-move-to-isle-2', a.onLevel && b.onLevel, `host at ${a.me.x.toFixed(1)},${a.me.z.toFixed(1)} on isle 2: ${a.onLevel}; joiner: ${b.onLevel}; HUD "${a.hud}" / "${b.hud}"`), () => check('both-move-to-isle-2', false, 'not moved'));
  await until(() => both(x => x.enemies >= 1), 15000, 'isle 2\'s warrior').catch(() => {});
  await ev(H, () => window.__fx.killAll());
  await until(() => both(x => x.round === 'results'), 10000, 'the end').then(() => check('clearing-the-last-isle-wins-on-both', true), async () => check('clearing-the-last-isle-wins-on-both', false, JSON.stringify(await info(H))));
}
