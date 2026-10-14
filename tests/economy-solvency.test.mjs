// The pools' invariant, offline: for every fixture, at the rates its scenario expects, the quick simulation's pools
// never owe more than they hold over the scenario's days (no pool runs dry while it is still paying out), every
// lottery pays out at most its pot, and every box's split hands out at most what it took. The devnet side of the same
// question is `gamesfun economy check --devnet` (builder/web3/node/economy-check.mjs), whose obligations() is tested here on
// the offline fake chain.
//
// Every fixture must pass; none is excused. (duel-arena failed until 2026-10-12: "mission-rewards" paid 40 USDC a day
// with nothing coming in. 90% of each ship sold now fills it. An earlier devnet run of tests/web3/devnet/economies.mjs
// put the earlier version live, without that share.) The checker says the same to a creator: W-POOL-RUNS-DRY.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { encodeAccount } from '../builder/web3/gf-web3/chain/borsh.js';
import { LOOT_IDL, LOOT_PROGRAM, lootPda } from '../builder/web3/gf-web3/chain/loot.js';
import { NATIVE_MINT, TOKEN_PROGRAM } from '../builder/web3/gf-web3/chain/pda.js';
import { concat, uintLE } from '../builder/web3/gf-web3/chain/bytes.js';
import { addressBytes } from '../builder/web3/gf-web3/chain/base58.js';
import { rpcClient } from '../builder/web3/gf-web3/rpc.js';
import { check } from '../builder/web3/economy/check.mjs';
import { simulate } from '../builder/web3/economy/simulate.mjs';
import { obligations } from '../builder/web3/node/economy-check.mjs';
import { freshKeypair } from '../builder/web3/node/ed25519.mjs';
import { fixture, fixtureNames, NOW } from './economy/helpers.mjs';
import { fakeChain } from './web3/fake-chain.mjs';

/** What fails the invariant for one economy: [] when it holds. */
export function solvency(economy) {
  const sim = simulate(economy, { now: NOW });
  const days = sim.scenario.days;
  const problems = [];
  for (const p of sim.pools) {
    if (p.lasts === 'runs dry' && !(p.lastsDays >= days)) problems.push(`pool "${p.key}" pays ${p.outPerDay} a day against ${p.inPerDay} coming in: its seed of ${p.seed} runs dry on day ${p.lastsDays} of ${days}`);
    if (!(p.after >= 0)) problems.push(`pool "${p.key}" ends below zero (${p.after})`);
  }
  for (const l of economy.lotteries ?? []) {
    const total = (l.places ?? [100]).reduce((a, b) => a + Number(b), 0);
    if (total > 100) problems.push(`lottery "${l.key}" pays ${total}% of its pot`);
  }
  for (const b of economy.boxes ?? []) {
    const total = (b.split ?? []).reduce((a, s) => a + Number(s.percent), 0);
    if (total > 100) problems.push(`box "${b.key}" splits ${total}% of its price`);
  }
  return problems;
}

describe('every fixture: the pools never owe more than they hold at the expected rates', () => {
  for (const name of fixtureNames()) {
    it(name, () => {
      const problems = solvency(fixture(name));
      assert.deepEqual(problems, [], `${name}: ${problems.join('; ')}`);
    });
  }

  it('the invariant catches a pool that pays more than comes in', () => {
    const e = structuredClone(fixture('coin-flip-arena'));
    e.boxes[0].outcomes[0].amount = 0.25;           // 50% × 0.25 = 0.125 out of every flip, 0.088 in
    assert.match(solvency(e).join(), /pool "house" pays .* runs dry on day/);
    assert.deepEqual(solvency(fixture('coin-flip-arena')), []);
  });

  it('the old duel arena (no share into "mission-rewards") is caught by the invariant and by the checker', () => {
    const e = structuredClone(fixture('duel-arena'));
    delete e.items.find((i) => i.key === 'ship').split;
    assert.match(solvency(e).join(), /pool "mission-rewards" pays 40 a day against 0 coming in: its seed of 100 runs dry on day 2\.5 of 30/);
    const w = check(e, { now: NOW }).warnings.find((x) => x.code === 'W-POOL-RUNS-DRY');
    assert.ok(w, 'the checker warns');
    assert.equal(w.where, 'economy.pools.mission-rewards');
    assert.match(w.message, /day 2\.5 of 30/);
    assert.match(w.fix, /at least 1200 USDC/);
    assert.match(w.fix, /pool:mission-rewards/);
    assert.ok(!check(fixture('duel-arena'), { now: NOW }).warnings.some((x) => x.code === 'W-POOL-RUNS-DRY'));
  });
});

describe('obligations(): what each pool, stake and contest pot owes, read from the chain (fake chain)', () => {
  it('a rolled prize is owed by its pool, a pending roll may be, and a pool short of what it owes says so', async () => {
    const chain = fakeChain();
    const rpc = rpcClient('https://api.devnet.solana.com', { fetchImpl: chain.fetchImpl });
    const economy = structuredClone(fixture('coin-flip-arena'));
    economy.stakes = [];
    economy.lotteries = [];
    const collection = freshKeypair().address;
    const game = lootPda.game(collection);
    economy.live = { game, collection };
    const player = freshKeypair().address;
    const tokenData = (amount) => concat(addressBytes(NATIVE_MINT), addressBytes(game), uintLE(amount, 8), new Uint8Array(165 - 72));
    chain.put(lootPda.pool(game, 0), TOKEN_PROGRAM, tokenData(100_000_000n));     // house: 0.1 SOL
    chain.put(lootPda.pool(game, 1), TOKEN_PROGRAM, tokenData(0n));
    chain.put(lootPda.pool(game, 2), TOKEN_PROGRAM, tokenData(5_000_000n));
    const order = (nonce, status, outcome) => chain.put(lootPda.order(game, player, nonce), LOOT_PROGRAM, encodeAccount(LOOT_IDL, 'Order', {
      game, player, nonce, mint: NATIVE_MINT, loot_box: lootPda.box(game, 1), box_version: 0, status, outcome, serial: 0, paid: 100_000_000n, fee: 2_000_000n, shares: [], requested_slot: 1n, bump: 255,
    }));
    order(1n, 'Rolled', { Pay: { pool: 0, amount: 176_000_000n } });
    order(2n, 'Pending', 'Nothing');
    const rows = await obligations(rpc, economy);
    const house = rows.find((r) => r.key === 'house');
    assert.equal(house.holds, 100_000_000n);
    assert.equal(house.owed, 176_000_000n);
    assert.equal(house.covers, false, 'the house holds 0.1 SOL and owes a rolled 0.176');
    assert.equal(house.mayOwed, 176_000_000n, 'the pending roll may win the flip’s prize');
    assert.ok(rows.filter((r) => r.key !== 'house').every((r) => r.covers));
  });
});
