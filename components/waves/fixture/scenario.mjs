// Wave 1 comes out on the host; both copies list the same enemies near the same places; a hit that does not kill shows
// the same health bar on both; a kill removes the enemy on both, and both draw it going down.
export default async function scenario({ H, J, ev, check, until, sleep }) {
  const info = P => ev(P, () => window.__fx.info());
  await until(async () => { const [a, b] = [await info(H), await info(J)]; return a.state.wave === 1 && a.enemies.length === 2 && b.enemies.length === 2 ? [a, b] : null; }, 15000, 'wave 1').then(([a, b]) => check('both-see-wave-1-with-two-enemies', b.state.wave === 1, `ids ${a.enemies.map(e => e.id)} / ${b.enemies.map(e => e.id)}`), () => check('both-see-wave-1-with-two-enemies', false, 'no wave'));
  await sleep(1500);
  const [a, b] = [await info(H), await info(J)];
  const d = Math.max(0, ...a.enemies.map(e => { const o = b.enemies.find(x => x.id === e.id); return o ? Math.hypot(e.x - o.x, e.z - o.z) : 99; }));
  check('same-enemies-near-the-same-places', a.enemies.length > 0 && d < 1.5, `largest difference ${d.toFixed(2)} m`);
  // a hit that does not kill: the kit's health bar over that enemy, at the same fill on both copies
  const hurt = await ev(H, () => window.__fx.hurtFirst());
  await until(async () => { const [x, y] = [await ev(H, id => window.__fx.bar(id), hurt), await ev(J, id => window.__fx.bar(id), hurt)]; return x && y && Math.abs(x.frac - 0.5) < 0.01 && Math.abs(y.frac - 0.5) < 0.01 ? [x, y] : null; }, 5000, 'the bar')
    .then(([x, y]) => check('a-hit-shows-the-same-bar-on-both', true, `enemy ${hurt}: ${x.frac} / ${y.frac}`), () => check('a-hit-shows-the-same-bar-on-both', false, `enemy ${hurt}: no bar at 0.5 on both copies`));
  const id0 = hurt ?? a.enemies[0].id;
  await ev(H, id => window.__fx.killFirst(id), id0);
  await until(async () => { const [x, y] = [await info(H), await info(J)]; return !x.enemies.some(e => e.id === id0) && !y.enemies.some(e => e.id === id0) ? [x, y] : null; }, 5000, 'the kill')
    .then(([x, y]) => { check('kill-removes-the-enemy-on-both', true); check('both-draw-it-going-down', x.dying > 0 && y.dying > 0, `dying ${x.dying} / ${y.dying}`); }, () => check('kill-removes-the-enemy-on-both', false, 'still listed'));
  const [c, e] = [await info(H), await info(J)];
  check('kill-counts-and-scores', c.state.kills === 1 && e.state.kills === 1 && c.score === 1, `kills ${c.state.kills}/${e.state.kills}, score ${c.score}`);
  check('the-bar-goes-with-it', !(await ev(H, id => window.__fx.bar(id), id0)) && !(await ev(J, id => window.__fx.bar(id), id0)), 'a dead enemy keeps no bar');
}
