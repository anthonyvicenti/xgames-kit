// Two players and loot: a coin the joiner walks over is theirs on both copies and gone for both; a weapon the joiner
// takes with E is theirs on both (the old one lies where it was); a chest opens on both and spills coins; an upgrade
// offer shows on both screens and the joiner's pick is recorded by the host.
export default async function scenario({ H, J, ev, check, until, sleep }) {
  const info = P => ev(P, () => window.__fx.info());
  const both = async f => { const [a, b] = [await info(H), await info(J)]; return f(a) && f(b) ? [a, b] : null; };
  const jid = await ev(J, () => window.__fx.me());
  await sleep(2600);
  await ev(J, () => window.__fx.stand(4, 4)); await ev(H, () => window.__fx.stand(-4, -4)); await sleep(500);
  const coin = await ev(H, () => window.__fx.drop('coin', 4.3, 4.2));
  await until(() => both(x => x.coins[jid] === 1 && !x.drops.some(d => d.id === coin)), 6000, 'the coin')
    .then(([a, b]) => check('a-coin-walked-over-is-theirs-on-both', true, `coins ${a.coins[jid]} / ${b.coins[jid]}; HUD "${b.hud}"`), async () => check('a-coin-walked-over-is-theirs-on-both', false, JSON.stringify(await info(H))));
  const axe = await ev(H, () => window.__fx.drop('weapon', 5.2, 4, { weapon: 1, rarity: 2 }));
  await sleep(600); await ev(J, () => window.__fx.pressE());
  await until(() => both(x => x.weapon[jid] === 'axe' && x.rarity[jid] === 2 && !x.drops.some(d => d.id === axe)), 6000, 'the axe')
    .then(([a]) => check('a-weapon-taken-with-E-is-theirs-on-both', a.drops.some(d => d.kind === 'weapon'), `joiner holds an epic axe on both; the sword lies on the ground: ${a.drops.some(d => d.kind === 'weapon')}`), async () => check('a-weapon-taken-with-E-is-theirs-on-both', false, JSON.stringify(await info(J))));
  await ev(J, () => window.__fx.stand(-6, 6)); await sleep(400);
  const chest = await ev(H, () => window.__fx.drop('chest', -6, 7.2));
  await sleep(600); await ev(J, () => window.__fx.pressE());
  await until(() => both(x => x.drops.find(d => d.id === chest)?.kind === 'open' && x.drops.filter(d => d.kind === 'coin').length >= 3), 6000, 'the chest')
    .then(() => check('a-chest-opens-on-both-and-spills', true), async () => check('a-chest-opens-on-both-and-spills', false, JSON.stringify((await info(J)).drops)));
  await ev(H, () => window.__fx.offer());
  await until(() => both(x => x.cards), 5000, 'the cards').then(() => check('the-upgrade-cards-show-on-both', true), () => check('the-upgrade-cards-show-on-both', false));
  await ev(J, () => window.__fx.pickCard(2));
  await until(() => both(x => x.upgrades[jid]?.length === 1), 5000, 'the pick').then(([a, b]) => check('the-joiners-pick-is-recorded-on-both', a.upgrades[jid][0] === b.upgrades[jid][0], `${a.upgrades[jid]}`), () => check('the-joiners-pick-is-recorded-on-both', false));
  const j = await info(J);
  check('the-joiners-cards-go-once-picked', !j.cards, `cards ${j.cards}`);
}
