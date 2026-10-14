// Two players with swords: a swing shows on the other copy; each target is hit once a swing (the host's own swing, and
// the joiner's through `melee:hit`); a dash's invulnerable frames are seen by the host; a swing hurts a typed enemy on
// both copies.
export default async function scenario({ H, J, ev, check, until, sleep }) {
  const info = P => ev(P, () => window.__fx.info());
  await sleep(2600);                                       // fair play's start grace (no hit counts)
  await ev(H, () => window.__fx.stand(0, 0)); await ev(J, () => window.__fx.stand(0, 1.3));
  await sleep(700);
  const [h0, j0] = [await info(H), await info(J)];
  const hid = h0.me, jid = j0.me;
  // the host swings at the joiner: one hit, the same hit points on both copies, and the joiner sees the swing
  await ev(H, () => window.__fx.aimAtOther()); await ev(H, () => window.__fx.swing('light'));
  await until(async () => { const [a, b] = [await info(H), await info(J)]; return a.hp[jid] <= j0.hp[jid] - 1 && b.hp[jid] <= j0.hp[jid] - 1 ? [a, b] : null; }, 5000, 'the host\'s hit')
    .then(([a, b]) => check('a-swing-hits-the-other-player-on-both-copies', true, `${jid} ${j0.hp[jid]} → ${a.hp[jid]} (host) / ${b.hp[jid]} (joiner)`), () => check('a-swing-hits-the-other-player-on-both-copies', false, 'no hit'));
  await sleep(900);
  const [h1, j1] = [await info(H), await info(J)];
  check('each-target-once-a-swing', j0.hp[jid] - h1.hp[jid] === 1, `${j0.hp[jid] - h1.hp[jid]} hit points for one light swing (damage 1)`);
  check('the-joiner-saw-the-host-swing', j1.swingsSeen >= 1, `joiner's copy saw ${j1.swingsSeen} swing(s) from poses`);
  // the joiner swings at the host: its copy finds the hit, the host applies it
  await ev(J, () => window.__fx.aimAtOther()); await ev(J, () => window.__fx.swing('light'));
  await until(async () => { const [a, b] = [await info(H), await info(J)]; return a.hp[hid] <= h1.hp[hid] - 1 && b.hp[hid] <= h1.hp[hid] - 1 ? [a, b] : null; }, 5000, 'the joiner\'s hit')
    .then(([a, b]) => check('the-joiners-hit-counts-on-the-host', true, `${hid} ${h1.hp[hid]} → ${a.hp[hid]} / ${b.hp[hid]}`), async () => check('the-joiners-hit-counts-on-the-host', false, `no hit; the joiner's last swing: ${JSON.stringify((await info(J)).lastSwing)}; host saw ${(await info(H)).swingsSeen} swings`));
  await sleep(900);
  const h2 = await info(H);
  check('the-joiners-swing-hits-once', h1.hp[hid] - h2.hp[hid] === 1, `${h1.hp[hid] - h2.hp[hid]} hit points`);
  // a dash: the host sees the joiner's invulnerable frames
  await ev(J, () => window.__fx.dash());
  let seen = false; for (let i = 0; i < 20 && !seen; i++) { seen = await ev(H, () => window.__fx.dodging()); await sleep(20); }
  check('the-host-sees-the-joiners-dash-frames', seen, seen ? 'dodging (pose extra dg)' : 'never seen');
  // a typed enemy: the joiner hits it, both copies see its hit points drop
  await until(async () => (await info(H)).enemies.length === 1 && (await info(J)).enemies.length === 1, 8000, 'the warrior').catch(() => {});
  const e0 = (await info(J)).enemies[0];
  if (!e0) { check('a-swing-hurts-an-enemy-on-both-copies', false, 'no enemy came'); return; }
  await ev(J, () => window.__fx.enemyNear()); await sleep(500);
  await ev(J, () => window.__fx.enemyNear()); await ev(J, () => window.__fx.swing('light'));
  await until(async () => { const [a, b] = [await info(H), await info(J)]; const x = a.enemies.find(e => e.id === e0.id), y = b.enemies.find(e => e.id === e0.id); return x && y && x.hp < e0.hp && y.hp < e0.hp ? [x, y] : null; }, 5000, 'the enemy hit')
    .then(([x, y]) => check('a-swing-hurts-an-enemy-on-both-copies', x.hp === y.hp, `enemy ${e0.id}: ${e0.hp} → ${x.hp} (host) / ${y.hp} (joiner)`), () => check('a-swing-hurts-an-enemy-on-both-copies', false, 'its hit points never dropped'));
}
