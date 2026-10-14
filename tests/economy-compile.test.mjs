// The compiler: every fixture compiles to a plan whose loot steps name only instructions, arguments and accounts the
// deployed 0.3 IDL has (read independently here), whose transactions fit, and whose diff carries only what changed.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compile, diff } from '../builder/web3/economy/compile.mjs';
import { BUDGET, MAX_TRANSACTION_BYTES } from '../builder/web3/economy/txsize.mjs';
import { NOW, fixture, fixtureNames, idlAccounts, idlInstruction, idlSize } from './economy/helpers.mjs';

const loot = (plan) => plan.transactions.flatMap((t) => t.steps).filter((s) => s.program === 'loot');

for (const name of fixtureNames())
  test(`${name} compiles to loot 0.3 instructions, arguments and accounts exactly as its IDL names them`, () => {
    const plan = compile(fixture(name), { now: NOW });
    assert.equal(plan.ok, true, JSON.stringify(plan.refusals));
    assert.equal(plan.program, 'GVzbAquLbqGxWzzjEAYvGyj1a3SHEcBr3gM9fseTg73o');
    const steps = loot(plan);
    assert.ok(steps.some((s) => s.ix === 'create_game'));
    for (const step of steps) {
      const ix = idlInstruction(step.ix);
      assert.ok(ix, `no instruction ${step.ix}`);
      assert.deepEqual(Object.keys(step.args).sort(), ix.args.map((a) => a.name).sort(), `${step.id} ${step.ix} args`);
      // Every argument, deep, is a value of the IDL's type; its Borsh size is the step's data size.
      const size = 8 + ix.args.reduce((n, a) => n + idlSize(a.type, step.args[a.name], `${step.id}.${a.name}`), 0);
      assert.equal(step.data, size, `${step.id} data size`);
      const accounts = idlAccounts(step.ix);
      assert.deepEqual(Object.keys(step.accounts).sort(), accounts.filter((a) => !a.optional || a.name in step.accounts).map((a) => a.name).sort(), `${step.id} accounts`);
      for (const a of accounts) if (a.signer) assert.ok(step.signers.includes(step.accounts[a.name]), `${step.id}: ${a.name} signs`);
    }
    for (const t of plan.transactions) {
      assert.ok(t.bytes <= MAX_TRANSACTION_BYTES, `${t.bytes} bytes`);
      if (t.steps.length > 1) assert.ok(t.bytes <= BUDGET, `a packed transaction leaves room for the wallet: ${t.bytes}`);
    }
    for (const row of plan.play) assert.ok(idlInstruction(row.ix), `play step ${row.ix}`);
  });

test('the arena’s plan, in order', () => {
  const plan = compile(fixture('coin-flip-arena'), { now: NOW });
  assert.deepEqual(plan.before.map((s) => s.id), ['token:arena']);
  const order = plan.transactions.flatMap((t) => t.steps).map((s) => `${s.program}.${s.ix}`);
  assert.deepEqual(order, [
    'mpl-core.create_collection_v2',
    'associated-token.create_idempotent',
    'loot.create_game',
    'loot.open_pool',
    'loot.open_pool',
    'loot.open_pool',
    'loot.upsert_box',
    'loot.upsert_lottery',
    'loot.open_stake',
    'system.transfer',
    'spl-token.sync_native',
    'loot.deposit',
  ]);
  const box = plan.transactions.flatMap((t) => t.steps).find((s) => s.ix === 'upsert_box');
  // 0.1 SOL; 88/10/2 to pools 0, 2, 1; win 50 (0.176 SOL from pool 0) or nothing.
  assert.equal(box.args.args.price, '100000000');
  assert.deepEqual(box.args.args.shares, [{ to: { Pool: 0 }, bps: 8800 }, { to: { Pool: 2 }, bps: 1000 }, { to: { Pool: 1 }, bps: 200 }]);
  assert.deepEqual(box.args.args.entries, [{ outcome: { Pay: { pool: 0, amount: '176000000' } }, weight: 1 }, { outcome: { Nothing: {} }, weight: 1 }]);
  const lottery = plan.transactions.flatMap((t) => t.steps).find((s) => s.ix === 'upsert_lottery');
  assert.deepEqual(lottery.args.args.places, [5000, 3000, 2000]);
  assert.equal(lottery.args.args.draws_at, NOW + 7 * 86400);
});

test('a refused spec gives refusals, not a plan', () => {
  const spec = fixture('coin-flip-arena');
  spec.boxes[0].outcomes[0].chance = 60;
  const plan = compile(spec, { now: NOW });
  assert.equal(plan.ok, false);
  assert.ok(plan.refusals.some((r) => r.code === 'E-ODDS'));
});

/** The arena as it would be once live: ids written and addresses known. */
const live = () => {
  const spec = fixture('coin-flip-arena');
  spec.tokens[1].mint = '9wSxRXn4MhsqQrdJe6qbJXtMwJh6CvuX4HFvsL8U3AHw';
  spec.live = { game: '34xcU4NyeaZvYvHU2RsN3GvCTavZKyFTph72mEKDMum7', collection: 'GKUdqtQem1UiG3us5xZkg7cRYpwxUwyUt2ebpPQbX84Y' };
  return spec;
};
const ids = (plan) => plan.transactions.flatMap((t) => t.steps).map((s) => `${s.id}#${s.ix}`);

test('diff: nothing changed, nothing to do', () => {
  const d = diff(live(), live(), { now: NOW });
  assert.equal(d.ok, true);
  assert.deepEqual(ids(d), []);
});

test('diff: a new price is one upsert_box; a new pool one open_pool; a bigger seed one deposit of the difference', () => {
  const next = live();
  next.boxes[0].price = 0.2;
  next.boxes[0].outcomes[0].amount = 0.352;
  next.pools.push({ key: 'jackpot', currency: 'sol' });
  next.boxes[0].split[0].percent = 87;
  next.boxes[0].split.push({ to: 'pool:jackpot', percent: 1 });
  next.boxes[0].outcomes = [{ gives: 'pay', chance: 49.9, pool: 'house', amount: 0.352 }, { gives: 'share', chance: 0.1, pool: 'jackpot', percent: 100 }, { gives: 'nothing', chance: 50 }];
  next.pools[0].seed = 25;
  const d = diff(live(), next, { now: NOW });
  assert.equal(d.ok, true, JSON.stringify(d.refusals));
  // Seeding SOL wraps it first; opening the owner's wrapped SOL account again is idempotent.
  assert.deepEqual(ids(d), ['pool:jackpot#open_pool', 'box:flip#upsert_box', 'wrap#create_idempotent', 'wrap#transfer', 'wrap#sync_native', 'seed:house#deposit']);
  const deposit = d.transactions.flatMap((t) => t.steps).find((s) => s.ix === 'deposit');
  assert.equal(deposit.args.amount, '20000000000', '20 SOL more');
  assert.equal(deposit.args.index, 0);
  assert.equal(d.spec.pools.find((p) => p.key === 'jackpot').index, 3, 'the new pool takes the next free index');
});

test('diff: a removed box is switched off; a stake cannot be edited; the currency cannot change', () => {
  const two = live();
  two.boxes.push({ ...structuredClone(two.boxes[0]), key: 'double', name: 'Double flip', price: 0.2 });
  const next = structuredClone(two);
  next.boxes = next.boxes.filter((b) => b.key !== 'double');
  const off = diff(two, next, { now: NOW });
  assert.equal(off.ok, true, JSON.stringify(off.refusals));
  assert.deepEqual(ids(off), ['box:double#upsert_box']);
  const step = off.transactions[0].steps[0];
  assert.equal(step.args.box_id, 2);
  assert.equal(step.args.args.active, false);
  // Removing the only box leaves the stakers' pool with nothing to fill it: refused.
  const none = live();
  none.boxes = [];
  assert.ok(diff(live(), none, { now: NOW }).refusals.some((r) => r.code === 'E-POOL-DRY'));
  const stake = live();
  stake.stakes[0].lock = '7d';
  assert.ok(diff(live(), stake, { now: NOW }).refusals.some((r) => r.code === 'E-STAKE-FIXED'));
  const currency = live();
  currency.currency = 'arena';
  assert.ok(diff(live(), currency, { now: NOW }).refusals?.some((r) => r.code === 'E-CURRENCY-FIXED'));
});

test('diff before anything is live is the whole setup', () => {
  const d = diff(fixture('coin-flip-arena'), fixture('coin-flip-arena'), { now: NOW });
  assert.deepEqual(ids(d), ids(compile(fixture('coin-flip-arena'), { now: NOW })));
});
