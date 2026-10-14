// The host hurts the joiner: hit points agree on both copies, 0 hp puts the joiner down on both, then they respawn.
// Fair play (CONTRACT §6c) is on: no hit counts in the start grace, and a player who just got up is protected.
export default async function scenario({ H, J, ev, game, check, until, sleep }) {
  const info = P => ev(P, () => window.__fx.info());
  const joiner = async () => (await game(H))?.players.find(p => !p.local && !p.bot) ?? null;
  await until(async () => (await game(H))?.fair?.grace === false, 8000, 'the start grace to end');
  await ev(H, () => window.__fx.hurtOther(1));
  await sleep(500);
  const [a, b] = [await info(H), await info(J)];
  check('hp-agrees-on-both', a.other.hp === 2 && b.me.hp === 2, `host sees ${a.other.hp}, joiner sees ${b.me.hp}`);
  await until(async () => (await info(J)).me.anim === 'knockdown', 4000, 'the knock').then(() => check('hit-knocks-the-joiner-over', true), () => check('hit-knocks-the-joiner-over', false, 'no knockdown'));
  // up again within fair.downSeconds, then protected: a hit does nothing (the host's referee, the joiner's own hit points)
  await until(async () => (await joiner())?.protected === true, 4000, 'the joiner up and protected').then(() => check('up-and-protected', true), () => check('up-and-protected', false, 'the host never saw the joiner protected'));
  const refused = await ev(H, () => window.__fx.hurtOther(1));
  await sleep(300);
  check('protected-takes-nothing', refused === false && (await info(J)).me.hp === 2, `damage() → ${refused}, joiner hp ${(await info(J)).me.hp}`);
  await until(async () => { const j = await joiner(); return j && !j.protected && !j.down; }, 4000, 'protection to end');
  await ev(H, () => window.__fx.hurtOther(2));
  await until(async () => { const [x, y] = [await info(H), await info(J)]; return x.other.alive === false && y.me.alive === false; }, 5000, 'down on both').then(() => check('zero-hp-puts-the-joiner-down-on-both', true), () => check('zero-hp-puts-the-joiner-down-on-both', false, 'not down on both'));
  await until(async () => { const [x, y] = [await info(H), await info(J)]; return x.other.alive && y.me.alive && x.other.hp === 3 && y.me.hp === 3; }, 8000, 'respawn').then(() => check('respawn-restores-hp-on-both', true), () => check('respawn-restores-hp-on-both', false, 'no respawn'));
}
