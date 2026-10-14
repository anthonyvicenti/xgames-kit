// The economy checker: every fixture checks clean with the warnings it should have, and each bad spec is refused
// with the right code, in words, with a fix.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { check, craftSize, findSecrets } from '../builder/web3/economy/check.mjs';
import { model } from '../builder/web3/economy/model.mjs';
import { NOW, fixture, fixtureNames } from './economy/helpers.mjs';

const EXPECTED_WARNINGS = {
  'blind-forge': ['W-CHANCE-PRIZE', 'W-MINT-POWERS'],
  'coin-flip-arena': ['W-CHANCE-PRIZE', 'W-FEE'],
  'duel-arena': ['W-AUTHORITY', 'W-CHANCE-PRIZE', 'W-MINT-POWERS'],
  'falling-drop': ['W-FEE', 'W-MINT-POWERS'],
  'halving-seasons': ['W-FEE'],
  'level-ladder': ['W-AUTHORITY', 'W-FEE'],
  'merge-2048': [],
  'sacrifice-raffle': ['W-CHANCE-PRIZE', 'W-FEE'],
  'scorched-treasury': ['W-AUTHORITY', 'W-MINT-POWERS'],
  'spark-pity': ['W-CHANCE-PRIZE', 'W-FEE'],
  starforce: ['W-CHANCE-PRIZE', 'W-FEE'],
  'stud-farm': ['W-MINT-POWERS'],
};

for (const name of fixtureNames())
  test(`${name} checks clean, with the warnings it should have`, () => {
    const r = check(fixture(name), { now: NOW });
    assert.deepEqual(r.refusals, []);
    assert.equal(r.ok, true);
    assert.deepEqual([...new Set(r.warnings.map((w) => w.code))].sort(), EXPECTED_WARNINGS[name]);
    for (const w of r.warnings) assert.ok(w.message.length > 20 && !w.message.includes('undefined'), w.message);
  });

/** A small valid economy to break one thing at a time. */
const base = () => ({
  version: 1,
  network: 'devnet',
  currency: 'coin',
  tokens: [
    { key: 'sol', source: 'sol' },
    { key: 'coin', source: 'game', symbol: 'COIN', decimals: 2 },
  ],
  items: [{ key: 'sword', name: 'Sword', price: 5 }],
  pools: [{ key: 'prizes', currency: 'coin', seed: 100 }],
  boxes: [{ key: 'crate', name: 'Crate', price: 1, outcomes: [{ gives: 'item', item: 'sword', chance: 50 }, { gives: 'pay', pool: 'prizes', amount: 1, chance: 50 }] }],
});

test('the base economy is clean', () => assert.deepEqual(check(base(), { now: NOW }).refusals, []));

/** [what is broken, the code it must get, a change to the base]. */
const BAD = [
  ['a seed phrase', 'E-SECRET', (e) => (e.name = 'abandon ability able about above absent absorb abstract absurd abuse access accident')],
  ['a 64-byte key in base58', 'E-SECRET', (e) => (e.prompt = `my key ${'5'.repeat(88)}`)],
  ['a keypair file', 'E-SECRET', (e) => (e.items[0].look = { values: { k: Array.from({ length: 64 }, (_, i) => i) } })],
  ['mainnet', 'E-NETWORK', (e) => (e.network = 'mainnet')],
  ['a field the schema does not have', 'E-SCHEMA', (e) => (e.boxes[0].odds = 3)],
  ['two items with one key', 'E-KEY-DUP', (e) => e.items.push({ key: 'sword', name: 'Other' })],
  ['two pools with one index', 'E-KEY-DUP', (e) => ((e.pools[0].index = 1), e.pools.push({ key: 'other', currency: 'coin', index: 1, seed: 1 }))],
  ['a box prize from a pool that does not exist', 'E-REF', (e) => (e.boxes[0].outcomes[1].pool = 'nowhere')],
  ['no currency', 'E-CURRENCY', (e) => delete e.currency],
  ['an existing token with no mint', 'E-TOKEN', (e) => e.tokens.push({ key: 'usdc', source: 'existing', decimals: 6 })],
  ['a game token on Token-2022', 'E-NOT-YET', (e) => (e.tokens[1].program = 'token-2022')],
  ['a percent finer than the program counts', 'E-PERCENT', (e) => (e.boxes[0].split = [{ to: 'pool:prizes', percent: 2.555 }])],
  ['shares over 100%', 'E-SPLIT', (e) => (e.boxes[0].split = [{ to: 'pool:prizes', percent: 60 }, { to: 'burn', percent: 50 }])],
  ['five shares (the schema caps a split at four)', 'E-SCHEMA', (e) => (e.items[0].split = Array.from({ length: 5 }, () => ({ to: 'burn', percent: 1 })))],
  ['a box in SOL whose split leaves some over', 'E-SPLIT-ALL', (e) => ((e.pools.push({ key: 'sol-pot', currency: 'sol', seed: 1 }), (e.boxes[0].currency = 'sol')), (e.boxes[0].split = [{ to: 'pool:sol-pot', percent: 50 }]))],
  ['a box in SOL whose roll burns', 'E-WSOL-BURN', (e) => ((e.currency = 'sol'), (e.items[0].price = 0.1), (e.pools[0].currency = 'sol'), e.boxes[0].outcomes.push({ gives: 'burn', chance: 0 }), (e.boxes[0].outcomes = [{ gives: 'item', item: 'sword', chance: 50 }, { gives: 'burn', chance: 50 }]))],
  ['a SOL sale with a burn share', 'E-WSOL-BURN', (e) => ((e.currency = 'sol'), (e.pools[0].currency = 'sol'), (e.items[0].split = [{ to: 'burn', percent: 10 }]))],
  ['a schedule that burns SOL', 'E-WSOL-BURN', (e) => ((e.pools[0].currency = 'sol'), (e.boxes[0].outcomes[1].amount = 0.01), (e.schedules = [{ key: 'scorch', does: 'burn', pool: 'prizes', percent: 1, every: '1d' }]))],
  ['chances that add up to 90', 'E-ODDS', (e) => (e.boxes[0].outcomes[0].chance = 40)],
  ['chances mixed with weights', 'E-ODDS', (e) => (delete e.boxes[0].outcomes[0].chance, (e.boxes[0].outcomes[0].weight = 5))],
  ['a prize of 0', 'E-ODDS', (e) => (e.boxes[0].outcomes[1].amount = 0)],
  ['a pool paid out of that nothing fills', 'E-POOL-DRY', (e) => delete e.pools[0].seed],
  ['a stake whose rewards pool is a lottery pot', 'E-POOL-SHARED', (e) => ((e.lotteries = [{ key: 'draw', name: 'Draw', pot: 'prizes', price: 1, every: '7d' }]), (e.stakes = [{ key: 'vault', name: 'Vault', stakes: 'coin', rewards: 'prizes', lock: '7d' }]))],
  ['a sale split into a pool of another token', 'E-POOL-MINT', (e) => (e.pools.push({ key: 'sol-pot', currency: 'sol', seed: 1 }), (e.items[0].split = [{ to: 'pool:sol-pot', percent: 10 }]))],
  ['a schedule that mints a token the game does not control', 'E-MINT-NOT-OURS', (e) => (e.pools.push({ key: 'sol-pot', currency: 'sol' }), (e.schedules = [{ key: 'emit', does: 'issue', pool: 'sol-pot', amount: 1, every: '1d' }]))],
  ['a recipe that burns a soulbound item', 'E-RECIPE', (e) => ((e.items[0].soulbound = true), (e.recipes = [{ key: 'melt', name: 'Melt', in: [{ takes: 'burn', item: 'sword' }], out: [{ gives: 'tokens', amount: 1, currency: 'coin', from: 'mint' }] }]))],
  ['a recipe that takes nine collectibles', 'E-RECIPE', (e) => (e.recipes = [{ key: 'big', name: 'Big', in: [{ takes: 'burn', item: 'sword', count: 8 }, { takes: 'use', item: 'sword' }], out: [] }])],
  ['a recipe that carries a number the program writes', 'E-RECIPE', (e) => (e.recipes = [{ key: 'copy', name: 'Copy', in: [{ takes: 'burn', item: 'sword' }], out: [{ gives: 'item', item: 'sword' }], keeps: [{ key: 'serial', from: 0, to: 0 }] }])],
  ['a recipe too big to send in one transaction', 'E-TX-SIZE', (e) => {
    e.items.push(...Array.from({ length: 8 }, (_, i) => ({ key: `part-${i}`, name: `Part ${i}` })));
    e.recipes = [{ key: 'colossus', name: 'Colossus', in: Array.from({ length: 8 }, (_, i) => ({ takes: 'use', item: `part-${i}` })), out: Array.from({ length: 8 }, (_, i) => ({ gives: 'item', item: `part-${i}` })) }];
  }],
  ['a box that costs nothing', 'E-PRICE', (e) => (e.boxes[0].price = 0)],
  ['a fall that never falls', 'E-PRICE', (e) => (e.items[0].fall = { step: 0, every: '1m' })],
  ['a lottery that cuts burned tickets', 'E-LOTTERY', (e) => (e.tokens.push({ key: 'ticket', source: 'game', symbol: 'TIX' }), (e.lotteries = [{ key: 'draw', name: 'Draw', pot: 'prizes', price: 1, ticketCurrency: 'ticket', cutPercent: 5, every: '7d' }]))],
  ['a lottery whose places add up to more than the pot', 'E-LOTTERY', (e) => (e.lotteries = [{ key: 'draw', name: 'Draw', pot: 'prizes', price: 1, places: [60, 50], every: '7d' }])],
  ['a contest whose entries close after its result', 'E-CONTEST', (e) => (e.contests = [{ key: 'duel', name: 'Duel', sides: 2, entriesClose: '2h', resultDue: '1h' }])],
  ['a hold of a soulbound item', 'E-HOLD', (e) => ((e.items[0].soulbound = true), (e.holds = [{ key: 'raid', name: 'Raid', item: 'sword' }]))],
  ['a decision that burns an item that is not burnable', 'E-DECISION', (e) => (e.decisions = [{ key: 'smash', when: 'a sword breaks', does: 'unmake', item: 'sword' }])],
  ['an amount finer than its token', 'E-AMOUNT', (e) => (e.items[0].price = 0.001)],
  ['a duration that is not one', 'E-SCHEMA', (e) => (e.schedules = [{ key: 's', does: 'burn', pool: 'prizes', percent: 1, every: 'weekly' }])],
];

for (const [what, code, change] of BAD)
  test(`refuses ${what} (${code})`, () => {
    const e = base();
    change(e);
    const r = check(e, { now: NOW });
    assert.equal(r.ok, false);
    const hit = r.refusals.find((x) => x.code === code);
    assert.ok(hit, `${code} not in ${r.refusals.map((x) => `${x.code}: ${x.message}`).join(' | ')}`);
    assert.ok(hit.message.length > 20 && hit.fix.length > 5, 'a refusal says what it means and the fix');
    assert.ok(!/undefined|NaN|\[object/.test(hit.message + hit.fix), hit.message);
  });

test('a network other than devnet in gamesfun.json is refused', () => {
  assert.ok(check(base(), { network: 'mainnet-beta' }).refusals.some((r) => r.code === 'E-NETWORK'));
});

test('a secret is found wherever it is, even under a credential-like name', () => {
  assert.deepEqual(findSecrets({ a: { b: ['fine', { privateKey: 'x' }] } }), ['economy.a.b[1].privateKey']);
  assert.deepEqual(findSecrets({ when: 'a player clears the last level of the tower before the timer runs out' }), []);
});

test('the warnings: a stake with no lock, a pot shared with a box, a token whose mint is unknown', () => {
  const e = base();
  e.tokens.push({ key: 'usdc', source: 'existing', mint: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU', decimals: 6 });
  e.lotteries = [{ key: 'draw', name: 'Draw', pot: 'prizes', price: 1, every: '7d' }];
  e.pools.push({ key: 'rewards', currency: 'coin' });
  e.items[0].split = [{ to: 'pool:rewards', percent: 10 }];
  e.stakes = [{ key: 'vault', name: 'Vault', stakes: 'coin', rewards: 'rewards' }];
  const codes = check(e, { now: NOW }).warnings.map((w) => w.code);
  for (const code of ['W-STAKE-LOCK', 'W-POOL-SHARED', 'W-MINT-POWERS', 'W-CHANCE-PRIZE']) assert.ok(codes.includes(code), `${code} in ${codes}`);
});

test('a craft’s size estimate is never below what the program’s own test measured', () => {
  // launchpad/loot/programs/loot/tests/blocks.rs the_largest_recipes_fit_in_one_transaction: 954 and 1,220 bytes in
  // 0.3.1 (888 and 1,154 before the audit's fee box). The program's test sends no account creation; the estimate adds
  // the one that opens the player's ore account, about 43 bytes, which takes the wide recipe past 1,232: refused.
  const e = {
    version: 1,
    currency: 'coin',
    tokens: [{ key: 'coin', source: 'game' }, { key: 'ore', source: 'game' }],
    items: [{ key: 'shard', name: 'Shard' }, { key: 'rune', name: 'Rune', life: { uses: 9 } }, { key: 'relic', name: 'Relic' }],
    recipes: [
      { key: 'eight', name: 'Eight for one', in: [{ takes: 'burn', item: 'shard', count: 8 }], out: [{ gives: 'item', item: 'relic' }] },
      {
        key: 'wide',
        name: 'Wide',
        in: [{ takes: 'burn', item: 'shard', count: 4 }, ...Array.from({ length: 4 }, () => ({ takes: 'use', item: 'rune' })), { takes: 'pay', amount: 5, currency: 'coin', to: 'burn' }],
        out: [{ gives: 'item', item: 'relic' }, { gives: 'item', item: 'relic' }, { gives: 'tokens', amount: 1, currency: 'ore', from: 'mint' }],
        keeps: [{ key: 'made_by', from: 0, to: 0 }],
      },
    ],
  };
  const m = model(e);
  const [eight, wide] = m.recipes.map((r) => craftSize(r, m));
  assert.ok(eight >= 954 && eight <= 954 + 80, `eight for one: ${eight}`);
  assert.ok(wide >= 1220 + 43 - 5 && wide <= 1220 + 43 + 5, `wide: ${wide}`);
  assert.ok(check(e, { now: NOW }).refusals.some((r) => r.code === 'E-TX-SIZE' && r.where === 'economy.recipes.wide'));
});

test('a prize bigger than its pool’s seed warns, naming the seed it needs; the open’s own share counts', () => {
  const e = structuredClone(fixture('coin-flip-arena'));
  const house = e.pools.find((p) => p.key === 'house');
  house.seed = 0.05;
  // 0.05 + 88% of the 0.1 flip = 0.138 at the first roll, short of the 0.176 win.
  const w = check(e, { now: NOW }).warnings.find((x) => x.code === 'W-PRIZE-SEED');
  assert.ok(w, 'warns');
  assert.equal(w.where, 'economy.pools.house.seed');
  assert.match(w.message, /starts with 0\.05 SOL \(and 0\.088 more from each open\), but a win in “Coin flip” pays 0\.176 SOL: the first winner gets nothing until the pool fills/);
  assert.match(w.fix, /Seed “house” with at least 0\.088 SOL/);
  house.seed = 0.088; // 0.088 + 0.088 = 0.176: the first win is paid
  assert.ok(!check(e, { now: NOW }).warnings.some((x) => x.code === 'W-PRIZE-SEED'));
  // A prize pool nothing feeds from the box: the seed alone has to cover it.
  e.boxes[0].split = e.boxes[0].split.filter((s) => s.to !== 'pool:house');
  house.seed = 0.1;
  assert.match(check(e, { now: NOW }).warnings.find((x) => x.code === 'W-PRIZE-SEED').fix, /at least 0\.176 SOL/);
});

test('a pool that empties within the scenario’s days warns with the day and the fixes', () => {
  const e = structuredClone(fixture('coin-flip-arena'));
  e.boxes[0].outcomes[0].amount = 0.25; // 500 wins × 0.25 = 125 out, 88 in: 37 a day short of a seed of 5
  const w = check(e, { now: NOW }).warnings.find((x) => x.code === 'W-POOL-RUNS-DRY');
  assert.ok(w);
  assert.equal(w.where, 'economy.pools.house');
  assert.match(w.message, /“house” pays out 125 SOL a day \(box:flip\) and takes in 88: its seed of 5 SOL is gone on day 0\.14 of 30/);
  assert.match(w.fix, /at least 1110 SOL \(30 days at that rate\)/);
  assert.match(w.fix, /a split to "pool:house"/);
  assert.match(w.fix, /pay less from it/);
  assert.equal(check(e, { now: NOW }).ok, true, 'a warning, not a refusal: the program pays until the pool is empty');
});
