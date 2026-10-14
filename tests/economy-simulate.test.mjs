// The quick simulation against numbers worked out by hand from each fixture (the working is in each test).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cost } from '../builder/web3/economy/cost.mjs';
import { explain, simulate } from '../builder/web3/economy/simulate.mjs';
import { NOW, fixture, fixtureNames } from './economy/helpers.mjs';

const near = (actual, expected, what, tolerance = 1e-6) => assert.ok(Math.abs(actual - expected) <= tolerance, `${what}: ${actual}, expected ${expected}`);
const pool = (sim, key) => sim.pools.find((p) => p.key === key);

test('coin-flip arena, worked by hand', () => {
  const sim = simulate(fixture('coin-flip-arena'), { now: NOW });
  const [flip] = sim.boxes;
  // Win half the time, 0.176 SOL: 0.088 back per 0.1 SOL flip. The box alone keeps 12% (10% feeds the lottery, 2% the stakers).
  near(flip.expectedBack, 0.088, 'expected back');
  near(flip.returnPercent, 88, 'return');
  near(flip.houseEdgePercent, 12, 'house edge');
  // 1,000 flips a day: 88% of 100 SOL in (88), half win 0.176 (88) out; 2% (2 SOL) to the stakers; 10 SOL + 100 tickets × 0.01 to the pot.
  near(pool(sim, 'house').inPerDay, 88, 'house in');
  near(pool(sim, 'house').outPerDay, 88, 'house out');
  assert.equal(pool(sim, 'house').lasts, 'holds');
  near(sim.stakes[0].rewardsPerDay, 2, 'stake rewards');
  near(sim.stakes[0].perThousandStakedPerDay, 0.002, 'per 1,000 staked (1,000,000 staked)');
  near(pool(sim, 'pot').inPerDay, 11, 'pot in');
  // A week: 700 tickets, a pot of 77 SOL paid 50/30/20: 38.5, 23.1, 15.4; 77/700 = 0.11 SOL a ticket.
  const [draw] = sim.lotteries;
  near(draw.ticketsPerRound, 700, 'tickets a round');
  near(draw.potBeforeDraw, 77, 'pot');
  assert.deepEqual(draw.prizes, [38.5, 23.1, 15.4]);
  near(draw.expectedPerTicket, 0.11, 'per ticket');
  // Player fees: (1,000 flips + 100 ticket purchases + 10 stake actions) × 0.002 SOL = 2.22 SOL a day.
  near(sim.perDay.platform.playerFeesSol, 2.22, 'player fees');
  // The house swings by √(1000 × (0.5 × 0.176² − 0.088²)) = √7.744 ≈ 2.7828 SOL a day; a seed of 5 is under three weeks' swing.
  near(pool(sim, 'house').swingPerDay, Math.sqrt(7.744), 'swing', 1e-5);
  assert.ok(sim.notes.some((n) => n.includes('skips that prize')));
  // MagicBlock's oracle takes 0.0005 SOL a roll from the player: a flip really costs 0.1 + 0.002 + 0.0005 + 2 × 0.000005
  // (two signatures: the open and the claim, both the player's in gf-web3's openBox; the full simulation measured
  // 0.10251 SOL a flip) = 0.10251 SOL, and gives back 0.088 of it. 1,000 flips: 0.5 SOL a day to the oracle.
  assert.equal(flip.oracleFee, 0.0005);
  assert.deepEqual(flip.realCost, { price: 0.1, token: 'sol', playerFeeSol: 0.002, oracleSol: 0.0005, networkSol: 0.00001, extrasSol: 0.00251, totalSol: 0.10251 });
  near(flip.returnOfRealCostPercent, (0.088 / 0.10251) * 100, 'return of the real cost', 1e-4);
  near(sim.perDay.players.oracleFeesSol, 0.5, 'oracle, players');
  // The weekly draw asks the oracle once a week, paid by whoever sends it: 0.0005 / 7 a day.
  near(sim.perDay.creator.oracleFeesSol, 0.0005 / 7, 'oracle, the draw');
  near(sim.perDay.oracle.totalSol, 0.5 + 0.0005 / 7, 'oracle in all');
  assert.equal(sim.fees.oracleSol, 0.0005);
  assert.match(explain(sim, fixture('coin-flip-arena')), /\+0\.0005 SOL to MagicBlock’s oracle for the roll; 0\.10251 SOL in all/);
});

test('the settle of a box and the claim of a collectible are the player’s signatures (found by the full simulation)', () => {
  // gf-web3's openBox and buy sign twice from the player's wallet: pay (and roll), then claim. The full simulation
  // (builder/web3/economy/sim) measured 2 signatures a flip; the quick one once counted the claim as the creator's.
  const flips = simulate(fixture('coin-flip-arena'), { now: NOW });
  // 1,000 flips × 2 + 100 ticket purchases + 10 stake actions, each 0.000005 SOL.
  near(flips.perDay.players.networkFeesSol, (2000 + 100 + 10) * 0.000005, 'players’ network fees');
  // The creator's side: the weekly draw and its three payments, nothing for the flips.
  near(flips.perDay.creator.networkFeesSol, (4 * 0.000005) / 7, 'creator’s network fees');
  const shop = simulate(
    { ...fixture('sacrifice-raffle'), items: [{ key: 'blade', name: 'Blade', price: 0.01 }, { key: 'scroll', name: 'Scroll', kind: 'normal', price: 0.01 }], recipes: [], lotteries: [], scenario: { days: 30, perDay: { 'item:blade': 10, 'item:scroll': 10 } } },
    { now: NOW },
  );
  // A collectible: pay and claim, both the player's. A normal item: the player pays, the game settles.
  near(shop.perDay.players.networkFeesSol, (10 * 2 + 10) * 0.000005, 'players, shop');
  near(shop.perDay.creator.networkFeesSol, 10 * 0.000005, 'creator, shop');
});

test('halving seasons, worked by hand', () => {
  const sim = simulate(fixture('halving-seasons'), { now: NOW });
  // The season pool: 1,000 PLAY minted a day, 50 claims × 10 = 500 a day out, 10% a day drips to interest:
  // it settles where 1,000 − 500 = 0.1 × B, at B = 5,000, and after 30 days from 0 holds 5,000 (1 − e^−3).
  const season = pool(sim, 'season');
  near(season.settlesAt, 5000, 'season settles at');
  near(season.after, 5000 * (1 - Math.exp(-3)), 'season after 30 days', 1e-3);
  // Interest gets 10% of 5,000 a day: 500 PLAY to stakers; 100,000 staked: 5 per 1,000 a day, 182.5% a year.
  near(sim.stakes[0].rewardsPerDay, 500, 'rewards a day');
  near(sim.stakes[0].perThousandStakedPerDay, 5, 'per 1,000 staked');
  near(sim.stakes[0].yearlyPercent, 182.5, 'yearly');
  // The mint halves every 30 runs: 1,000 × 30 × (1 + ½ + ¼ + …) = 60,000 PLAY in all.
  near(sim.schedules.find((s) => s.key === 'season-mint').mintsInAll, 60000, 'minted in all');
});

test('blind forge, worked by hand', () => {
  const sim = simulate(fixture('blind-forge'), { now: NOW });
  // 0.6 × 2 + 0.25 × 5 + 0.1 × 20 + 0.04 × 60 + 0.01 × 200 = 8.85 FORGE back per box.
  near(sim.boxes[0].expectedBack, 8.85, 'expected back');
  // The price rises 0.5% a sale from 10: 200 a day for 30 days is 6,000 sales, which pay on average
  // 10 × (1.005^6000 − 1) / (0.005 × 6000) FORGE (found by the full simulation: this was counted at 10 each, and
  // 400 sales in two days had already paid three times that).
  const average = (10 * (1.005 ** 6000 - 1)) / (0.005 * 6000);
  near(sim.boxes[0].averagePrice / average, 1, 'average price', 1e-9);
  assert.equal(sim.boxes[0].price, 10);
  near(sim.boxes[0].houseEdgePercent, (1 - 8.85 / average) * 100, 'house edge');
  // 200 boxes × the average × 5% a day to the pot, plus 50 tickets × 1 × 95% = 47.5.
  near(pool(sim, 'pot').inPerDay / (200 * average * 0.05 + 47.5), 1, 'pot in', 1e-9);
  assert.ok(sim.notes.some((n) => n.startsWith('“Forge box”’s price rises with each sale: over the scenario’s 6000 sales')));
  assert.ok(sim.notes.some((n) => n.includes('players stop buying long before that')));
  assert.ok(sim.notes.some((n) => n.includes('keeps 1% of every transfer')));
});

test('a price that falls with time or rises with each sale is counted at what the sales pay (found by the full simulation)', () => {
  const sim = simulate(fixture('falling-drop'), { now: NOW });
  // The drop hero starts at 2 SOL and falls 0.05 a minute to 0.2. Three sales a day, eight hours apart, the first
  // four hours in: by then it has fallen 12 SOL, so it sells at its floor, and starts again from what was paid.
  const hero = sim.items.find((i) => i.key === 'drop-hero');
  near(hero.averagePrice, 0.2, 'drop hero');
  // The clone rises 5% a sale from 0.1: 20 a day for 30 days is 600 sales.
  const clone = sim.items.find((i) => i.key === 'clone');
  near(clone.averagePrice / ((0.1 * (1.05 ** 600 - 1)) / (0.05 * 600)), 1, 'clone', 1e-9);
  // A price without rise or fall is its price.
  const flat = simulate(fixture('coin-flip-arena'), { now: NOW });
  assert.equal(flat.boxes[0].averagePrice, undefined);
});

test('a share of a pool that a schedule burns counts in what is burned a day (found by the full simulation)', () => {
  // Embers burns 1% a day of 100,000 MAIN: 1,000 MAIN a day at its seed, the level the quick simulation counts shares at.
  const sim = simulate(fixture('scorched-treasury'), { now: NOW });
  near(sim.perDay.burned.main, 1000, 'burned a day');
});

test('scorched treasury, starforce and the duel arena, worked by hand', () => {
  // Embers burns 1% a day with nothing coming in: 100,000 × e^−0.3 after 30 days, half gone every ln 2 / 0.01 days.
  const embers = pool(simulate(fixture('scorched-treasury'), { now: NOW }), 'embers');
  assert.equal(embers.lasts, 'shrinks');
  near(embers.after, 100000 * Math.exp(-0.3), 'embers after 30 days', 1e-3);
  near(embers.halfLifeDays, 69.31, 'half life', 0.01);
  // The jackpot: 100 tries × 0.02 SOL in a day; 100 opens × 0.5% × 10% of it out: it settles at 2 / 0.05 = 40 SOL.
  const star = simulate(fixture('starforce'), { now: NOW });
  near(pool(star, 'jackpot').settlesAt, 40, 'jackpot');
  // Each box: 0.4 × 0.15 + 0.45 × 0.05 in swords, and 0.005 × 10% × 40 from the jackpot = 0.1025 SOL.
  near(star.boxes[0].alsoPays.sol, 0.1025, 'starforce box');
  // Mission rewards: 20 successes × 2 USDC a day out; in, 90% of 10 ships × 5 USDC = 45 a day. It grows by 5 a day
  // from its seed of 100: 250 after 30 days. (Before the ships fed it, nothing came in and it lasted 2.5 days.)
  const duel = pool(simulate(fixture('duel-arena'), { now: NOW }), 'mission-rewards');
  near(duel.inPerDay, 45, 'mission rewards in');
  near(duel.outPerDay, 40, 'mission rewards out');
  assert.equal(duel.lasts, 'grows');
  near(duel.after, 250, 'after 30 days');
});

for (const name of fixtureNames())
  test(`${name} simulates and costs, in words with no holes`, () => {
    const spec = fixture(name);
    const words = explain(simulate(spec, { now: NOW }), spec);
    assert.ok(!/NaN|undefined|Infinity|\[object/.test(words), words);
    const c = cost(spec, { now: NOW });
    assert.equal(c.ok, true);
    assert.ok(c.setup.rentSol > 0 && c.setup.totalSol >= c.setup.rentSol);
    for (const a of c.setup.accounts) assert.equal(a.lamports, String((BigInt(a.bytes) + 128n) * 5080n), a.what);
  });

test('the arena costs what its accounts and signatures add up to', () => {
  const c = cost(fixture('coin-flip-arena'), { now: NOW });
  // 12 accounts (the game's fee box among them); two transactions (owner + collection, then owner): 3 signatures × 5,000 lamports.
  assert.equal(c.setup.accounts.length, 12);
  assert.equal(c.setup.accounts.find((a) => a.what.includes('fee box')).lamports, '650240', 'an empty account: 128 × 5,080 lamports');
  assert.equal(c.setup.networkFeesSol, 0.000015);
  // One deposit (the house's seed) at the project fee.
  assert.equal(c.setup.programFeesSol, 0.00001);
  assert.deepEqual(c.setup.seeds, { SOL: 5 });
  // The 102-byte box: (102 + 128) × 5,080 lamports.
  assert.equal(c.setup.accounts.find((a) => a.what.includes('Coin flip')).lamports, '1168400');
  const open = c.actions.find((a) => a.action.startsWith('open'));
  assert.equal(open.feeSol, 0.002);
  assert.equal(open.deposits[0].sol, 0.00230124, 'the 325-byte order');
  // The oracle's 0.0005 SOL a roll: on the open (the player) and on the draw (whoever sends it); not on a ticket.
  assert.equal(open.oracleSol, 0.0005);
  assert.equal(c.actions.find((a) => a.action === 'ask for a draw').oracleSol, 0.0005);
  assert.equal(c.actions.find((a) => a.action.startsWith('buy tickets')).oracleSol, undefined);
  assert.equal(c.fees.oracleSol, 0.0005);
});

test('a roll the authority asks for pays the oracle too', () => {
  const spec = structuredClone(fixture('duel-arena'));
  spec.decisions.push({ key: 'lucky', when: 'a mission picks its loot', does: 'roll', signedBy: 'server', perDay: 10 });
  const row = cost(spec, { now: NOW }).actions.find((a) => a.part === 'decision:lucky');
  assert.equal(row.oracleSol, 0.0005);
  assert.equal(row.feeSol, 0.00001);
  const sim = simulate(spec, { now: NOW });
  near(sim.perDay.creator.oracleFeesSol, 0.005, '10 rolls a day');
  assert.match(explain(sim, spec), /the authority’s rolls/);
});
