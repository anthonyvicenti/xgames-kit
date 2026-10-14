// Two players, real WebRTC: the host throws a ball at the joiner (discrete), then sprays the joiner (continuous).
// Fair play (CONTRACT §6c) is on: no hit counts in the start grace, and the joiner is protected for a moment after
// getting up, so each attack waits until the joiner can be hit.
export default async function scenario({ H, J, ev, game, check, until, sleep }) {
  const info = P => ev(P, () => window.__fx.info());
  const hittable = async () => { const s = await game(H); const j = s?.players.find(p => !p.local && !p.bot); return s?.fair?.grace === false && j && !j.down && !j.protected; };
  await until(hittable, 8000, 'the start grace to end');
  // ---- discrete: one throw, a hit on the joiner, the same place on both screens ----
  const fired = await ev(H, () => window.__fx.fireAtOther());
  check('host-fires', fired === true, `fire() returned ${fired}`);
  const hit = await until(async () => { const [a, b] = [await info(H), await info(J)]; return a.lastFx?.k === 'h' && b.lastFx?.k === 'h' ? [a, b] : null; }, 8000, 'both copies to show the hit');
  const [a, b] = hit;
  const d = Math.hypot(a.lastFx.p[0] - b.lastFx.p[0], a.lastFx.p[1] - b.lastFx.p[1], a.lastFx.p[2] - b.lastFx.p[2]);
  check('hit-same-place-on-both', d < 0.05, `host ${a.lastFx.p.join(',')} joiner ${b.lastFx.p.join(',')}`);
  const near = Math.hypot(a.lastFx.p[0] - a.other.x, a.lastFx.p[2] - a.other.z);
  check('hit-is-at-the-target', near < 1.2, `${near.toFixed(2)} m from where the host draws the joiner`);
  await until(async () => (await info(J)).me.anim === 'knockdown', 6000, 'the joiner to be knocked down').then(() => check('target-is-knocked-down', true), () => check('target-is-knocked-down', false, 'the joiner never played knockdown'));
  await sleep(500);
  const [a2, b2] = [await info(H), await info(J)];
  check('hit-lowers-hp-on-both', a2.other.hp < 5 && Math.abs(a2.other.hp - b2.me.hp) < 0.01, `host sees ${a2.other.hp}, joiner sees ${b2.me.hp}`);
  check('score-reaches-the-joiner', b2.other.score === 1 && a2.me.score === 1, `host score on joiner's screen: ${b2.other.score}`);
  // ---- continuous: the host holds a stream on the joiner (once it is up and no longer protected) ----
  await until(hittable, 6000, 'the joiner to be up and unprotected');
  const hp0 = (await info(H)).other.hp;
  await ev(H, () => window.__fx.streamAtOther(true));
  await until(async () => (await info(J)).other.streaming === true, 6000, 'the joiner to see the stream').then(() => check('stream-visible-to-other-copy', true), () => check('stream-visible-to-other-copy', false, 'the joiner never saw the host streaming'));
  await sleep(1800);
  const [a3, b3] = [await info(H), await info(J)];
  const e = a3.end && b3.end ? Math.hypot(a3.end.x - b3.end.x, a3.end.z - b3.end.z) : 99;
  check('stream-ends-in-the-same-place', e < 2.5, `ends differ by ${e.toFixed(2)} m`);
  check('stream-damages-the-target', a3.other.hp < hp0 && Math.abs(a3.other.hp - b3.me.hp) < 0.6, `hp ${hp0} -> ${a3.other.hp} (joiner shows ${b3.me.hp})`);
  await ev(H, () => window.__fx.streamAtOther(false));
  await until(async () => (await info(J)).other.streaming === false, 5000, 'the stream to stop').then(() => check('stream-stops-everywhere', true), () => check('stream-stops-everywhere', false, 'still streaming'));
}
