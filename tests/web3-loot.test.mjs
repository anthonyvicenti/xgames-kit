// The kit's loot 0.3 client agrees byte for byte with games.fun's own 0.3 tooling: every instruction's data and
// account list, the i64 encoding, the contest terms hash, real devnet accounts and receipts from games.fun's 0.3
// end-to-end run, and a transfer hook's extra accounts as @solana/spl-token resolves them. The fixture
// (tests/web3/fixtures/loot-0.3.json) was made from games.fun launchpad/loot at 5cf40df40 (0.3.2) (client/codec.mjs, the
// IDL, the account walk of devnet-e2e-0.3.mjs) with @solana/web3.js and @solana/spl-token; the kit depends on none.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { encodeBorsh } from '../builder/web3/gf-web3/chain/borsh.js';
import { addressBytes } from '../builder/web3/gf-web3/chain/base58.js';
import { concat, fromBase64, fromHex, toHex, uintLE } from '../builder/web3/gf-web3/chain/bytes.js';
import { createCollectionInstruction } from '../builder/web3/gf-web3/chain/core.js';
import * as L from '../builder/web3/gf-web3/chain/loot.js';
import { TOKEN_2022_PROGRAM } from '../builder/web3/gf-web3/chain/pda.js';
import { meta } from '../builder/web3/gf-web3/chain/programs.js';
import { MEMO_PROGRAM, transferExtras } from '../builder/web3/gf-web3/chain/token2022.js';
import { networkConfig } from '../builder/web3/gf-web3/network.js';

const F = JSON.parse(readFileSync(new URL('./web3/fixtures/loot-0.3.json', import.meta.url), 'utf8'));
const I = F.inputs;
const plain = (ix) => ({ programId: ix.programId, keys: ix.keys, data: toHex(ix.data) });
const normalize = (v) =>
  typeof v === 'bigint' ? v.toString() : v instanceof Uint8Array ? toHex(v) : Array.isArray(v) ? v.map(normalize) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, normalize(x)])) : v;

const { game } = I;
const T22 = TOKEN_2022_PROGRAM;
const nonce = BigInt(I.nonce);
const slot = BigInt(I.slot);
const reference = fromHex(I.reference);
const clientSeed = fromHex(I.clientSeed);
const treasury = L.ata(I.owner, I.mint);
const order = L.lootPda.order(game, I.player, nonce);
const w = (a) => meta(a, false, true);
const r = (a) => meta(a, false, false);
const memo = [r(MEMO_PROGRAM)];
const shares = [{ to: { Pool: [0] }, bps: 2000 }, { to: { Account: [I.partner] }, bps: 500 }, { to: { Holder: [I.stud] }, bps: 300 }, { to: 'Burn', bps: 100 }];
const shareTargets = L.shareAccounts(game, shares, { [I.stud]: L.ata(I.to, I.mint) });
const entries = [
  { outcome: { Item: [7] }, weight: 60 },
  { outcome: { Pay: { pool: 1, amount: 5000n } }, weight: 20 },
  { outcome: { Share: { pool: 2, bps: 1000 } }, weight: 10 },
  { outcome: 'Burn', weight: 5 },
  { outcome: 'Nothing', weight: 5 },
];
const contestArgs = { sides: 2, closes_at: 1760000000n, result_by: 1760003600n, shares: [{ to: 'Burn', bps: 200 }] };
const staking = { player: I.player, game, id: 4, mint: I.mint, rewardsMint: I.mint22, rewardsPool: 2, rewardsTokenProgram: T22 };
const contest = { game, id: 6, mint: I.mint };

/** The kit's call for each fixture case: the same accounts and arguments games.fun's tooling was given. */
const KIT = {
  init_platform: () => L.initPlatformIx({ admin: I.admin, fees: { player: 2000000n, project: 10000n }, partner: I.partner }),
  set_platform: () => L.setPlatformIx({ admin: I.admin, fees: { player: 3000000n, project: 10000n }, newAdmin: I.owner }),
  collect_fees: () => L.collectFeesIx({ admin: I.admin, to: I.to, games: [game] }),
  set_suspended: () => L.setSuspendedIx({ admin: I.admin, game, suspended: true }),
  create_game: () => L.createGameIx({ owner: I.owner, authority: I.authority, collection: I.collection, mint: I.mint, treasury }),
  update_game: () => L.updateGameIx({ owner: I.owner, game, treasury, update: { authority: I.to, paused: true } }),
  update_game_new_owner: () => L.updateGameIx({ owner: I.owner, game, treasury, newOwner: I.newKey }),
  open_pool: () => L.openPoolIx({ owner: I.owner, game, index: 3, mint: I.mint22 }),
  close_pool: () => L.closePoolIx({ owner: I.owner, game, index: 3, mint: I.mint22 }),
  upsert_item: () =>
    L.upsertItemIx({
      owner: I.owner, game, itemId: 7,
      args: { rarity: 3, soulbound: true, name: 'Golden Hat', uri: 'https://devnet.irys.xyz/abc', max_supply: 100, price: 2500000n, rise: { step: 10n, growth_bps: 500 }, fall: { step: 1n, every: 60, floor: 5n, since: 1760000000n }, life: { ready_after: 1, lasts: 2, uses: 3, cooldown: 4 }, shares },
    }),
  upsert_box: () => L.upsertBoxIx({ owner: I.owner, game, boxId: 3, args: { price: 1000000n, currency: I.mint22, stock_odds: true, shares: [{ to: { Pool: [3] }, bps: 10000 }], entries } }),
  upsert_schedule: () => L.upsertScheduleIx({ owner: I.owner, game, id: 2, args: { action: { Issue: { mint: I.mint, pool: 1, amount: 100n, halve_every: 52 } }, every: 86400n, next_at: 1760000000n } }),
  upsert_schedule_move: () => L.upsertScheduleIx({ owner: I.owner, game, id: 5, args: { active: false, action: { Move: { from: 1, to: 2, bps: 250 } }, every: 3600n, next_at: 0n, max_runs: 9 } }),
  upsert_lottery: () => L.upsertLotteryIx({ owner: I.owner, game, id: 3, args: { price: 1000000n, pot: 1, cut_bps: 100, places: [7000, 3000], every: 120n, draws_at: 1760000075n } }),
  upsert_recipe: () =>
    L.upsertRecipeIx({
      owner: I.owner, game, id: 8,
      args: {
        inputs: [{ Burn: { item: 1, count: 2 } }, { Use: { item: 2 } }, { Renew: { item: 3 } }, { Pay: { mint: I.mint, amount: 5n, to: { Pool: [1] } } }],
        outputs: [{ Item: [4] }, { Tokens: { mint: I.mint, amount: 9n, from: 'Issue' } }, { Tokens: { mint: I.mint, amount: 1n, from: { Pool: [2] } } }, { Share: { mint: I.mint, pool: 2, bps: 100 } }],
        needs: [{ place: 1, key: 'level', at_least: 10 }],
        keeps: [{ key: 'coat', from: 0, to: 0 }],
      },
    }),
  open_stake: () => L.openStakeIx({ owner: I.owner, game, id: 4, mint: I.mint, rewardsMint: I.mint22, rewardsPool: 2, lock: 3600n }),
  pay: () => L.payIx({ player: I.player, game, mint: I.mint, treasury, amount: 1000n, shares, reference, remaining: [...shareTargets, ...memo] }),
  deposit: () => L.depositIx({ depositor: I.owner, game, index: 1, mint: I.mint, from: treasury, amount: 20n }),
  buy_item: () => L.buyItemIxs({ player: I.player, game, mint: I.mint, itemId: 7, maxPrice: 2500000n, nonce }).instructions[1],
  open_box_2022: () => L.openBoxIxs({ player: I.player, game, mint: I.mint22, boxId: 3, box: { price: 1000000n, entries }, nonce, clientSeed, tokenProgram: T22, extras: memo }).instructions[1],
  settle: () =>
    L.settleOrderIxs({
      signer: I.player, order, holderAccount: { [I.stud]: L.ata(I.to, I.mint) },
      orderAccount: { game, player: I.player, mint: I.mint, outcome: { Item: [7] }, requested_slot: slot, shares },
      gameAccount: { treasury, collection: I.collection },
    })[1],
  settle_prize_pay: () =>
    L.settleOrderIxs({
      signer: I.authority, order, tokenProgram: T22, prizeTo: L.ata(I.player, I.mint), prizeMint: I.mint, extras: memo,
      orderAccount: { game, player: I.player, mint: I.mint22, outcome: { Pay: { pool: 1, amount: 5000n } }, requested_slot: slot, shares: [{ to: { Pool: [3] }, bps: 10000 }] },
      gameAccount: { treasury, collection: I.collection },
    })[1],
  settle_prize_nothing: () =>
    L.settleOrderIxs({ signer: I.authority, order, orderAccount: { game, player: I.player, mint: I.mint, outcome: 'Nothing', requested_slot: slot, shares: [] }, gameAccount: { treasury, collection: I.collection } })[1],
  refund_rolled: () => L.refundOrderIx({ signer: I.player, order, orderAccount: { game, player: I.player, mint: I.mint, status: 'Rolled', outcome: { Item: [7] } } }),
  refund_2022: () => L.refundOrderIx({ signer: I.player, order, tokenProgram: T22, extras: memo, orderAccount: { game, player: I.player, mint: I.mint22, status: 'Failed', outcome: 'Nothing' } }),
  payout: () => L.payoutIx({ authority: I.authority, game, index: 1, mint: I.mint, to: L.ata(I.to, I.mint), amount: 77n, reference }),
  burn: () => L.burnIx({ authority: I.authority, game, index: 2, mint: I.mint, amount: 5n, reference }),
  issue: () => L.issueIx({ authority: I.authority, game, mint: I.mint, to: L.ata(I.to, I.mint), amount: 1000n, reference }),
  make: () => L.makeIx({ authority: I.authority, game, itemId: 7, collection: I.collection, asset: I.newKey, owner: I.player, reference }),
  unmake: () => L.unmakeIx({ authority: I.authority, game, asset: I.asset, collection: I.collection, reference }),
  set: () => L.setIx({ authority: I.authority, game, asset: I.asset, collection: I.collection, attributes: [{ key: 'level', value: '10' }], reference }),
  roll: () => L.rollIx({ authority: I.authority, game, reference }),
  run_schedule: () => L.runScheduleIx({ game, id: 2, remaining: [w(I.mint), w(L.lootPda.pool(game, 1))] }),
  buy_tickets: () => L.buyTicketsIx({ player: I.player, game, id: 3, pot: 1, mint: I.mint, treasury, count: 3n, maxPrice: 1000000n }),
  draw_lottery: () => L.drawLotteryIx({ payer: I.owner, game, id: 3 }),
  pay_lottery: () => L.payLotteryIx({ game, id: 3, place: 1, firstPlace: I.player, pot: 1, to: L.ata(I.to, I.mint), mint: I.mint }),
  stake: () => L.stakeIx({ ...staking, amount: 50n }),
  unstake: () => L.unstakeIx({ ...staking, amount: 0n }),
  craft: () => L.craftIx({ player: I.player, game, id: 8, collection: I.collection, version: 2, times: 500n }),
  hold: () => L.holdIx({ player: I.player, game, asset: I.asset, collection: I.collection, seconds: 600n, reference }),
  award: () => L.awardIx({ signer: I.authority, game, asset: I.asset, player: I.player, to: I.to, collection: I.collection, reference }),
  take_back: () => L.takeBackIx({ signer: I.owner, game, asset: I.asset, player: I.player, collection: I.collection }),
  open_contest: () => L.openContestIx({ authority: I.authority, ...contest, args: contestArgs }),
  enter: () => L.enterIx({ player: I.player, ...contest, side: 1, amount: 40n, terms: reference }),
  decide: () => L.decideIx({ authority: I.authority, ...contest, side: 1, reference }),
  call_off: () => L.callOffIx({ signer: I.owner, game, id: 6 }),
  claim: () => L.claimIx({ ...contest, player: I.player, side: 1 }),
  close_contest: () => L.closeContestIx({ ...contest, opener: I.authority }),
  attach_token: () => L.attachTokenIx({ owner: I.owner, launcher: I.launcher, game, venue: 'Meteora', mint: I.mint, venueA: I.venueA, venueB: I.venueB }),
  recheck_token: () => L.recheckTokenIx({ game, venueA: I.venueA, venueB: I.venueB }),
};

describe('loot 0.3 instructions match games.fun’s 0.3 tooling byte for byte', () => {
  it('covers every instruction a client sends (the three callbacks are the oracle’s own)', () => {
    const covered = new Set(Object.keys(F.cases).map((c) => F.cases[c].data.slice(0, 16)));
    const missing = L.LOOT_IDL.instructions.filter((i) => !covered.has(toHex(Uint8Array.from(i.discriminator)))).map((i) => i.name);
    assert.deepEqual(missing.sort(), ['callback_lottery', 'callback_random', 'callback_roll']);
    assert.deepEqual(Object.keys(KIT).sort(), Object.keys(F.cases).sort());
  });
  for (const name of Object.keys(F.cases)) {
    it(name, () => assert.deepEqual(plain(KIT[name]()), F.cases[name]));
  }
  it('i64 values, negative ones included', () => {
    for (const { value, hex } of F.i64) assert.equal(toHex(encodeBorsh(L.LOOT_IDL, 'i64', BigInt(value))), hex, value);
  });
  it('the Core collection names the 0.3 game as update delegate', () => {
    const ix = createCollectionInstruction({ collection: I.collection, creator: I.owner, name: 'Bean Brawl Items', uri: 'https://devnet.irys.xyz/col', royaltyBps: 500 });
    assert.deepEqual(plain(ix), F.createCollection);
  });
  it('the hash of a contest’s terms', () => {
    assert.equal(toHex(L.contestTerms(I.mint, contestArgs)), F.contestTerms);
  });
  it('the program’s addresses on devnet', () => {
    assert.equal(L.LOOT_PROGRAM, 'GVzbAquLbqGxWzzjEAYvGyj1a3SHEcBr3gM9fseTg73o');
    assert.equal(L.lootPda.platform(), '3ASM4DQfuvjL2J6ZXLZ9dBrF8c3kbxibutgJjy2mFkCt');
    assert.equal(F.accounts.game.address, L.lootPda.game(F.accounts.game.expect.collection));
    const { loot } = networkConfig('devnet');
    assert.deepEqual([loot.program, loot.platform], [L.LOOT_PROGRAM, L.lootPda.platform()]);
    // The fees the platform on devnet holds are the ones the network config names, and the program's own constants.
    const fees = F.accounts.platform.expect.fees;
    assert.deepEqual([fees.player, fees.project], [String(loot.playerFeeLamports), String(loot.projectFeeLamports)]);
    assert.deepEqual([L.PLAYER_FEE_LAMPORTS, L.PROJECT_FEE_LAMPORTS], [BigInt(loot.playerFeeLamports), BigInt(loot.projectFeeLamports)]);
    assert.throws(() => networkConfig('mainnet-beta'), /devnet only/);
  });
});

describe('loot 0.3 accounts and receipts from devnet decode like games.fun’s codec', () => {
  for (const [name, a] of Object.entries(F.accounts)) {
    it(`${a.type} (${name})`, () => assert.deepEqual(normalize(L.decodeLoot(a.type, fromBase64(a.data))), a.expect));
  }
  it('a lottery’s purchase lines follow its record', () => {
    assert.deepEqual(L.lotteryLines(fromBase64(F.accounts.lottery.data)), []);
  });
  it('refuses an account of another type', () => {
    assert.throws(() => L.decodeLoot('Game', fromBase64(F.accounts.platform.data)), /Not a Game/);
  });
  for (const tx of F.events) {
    it(`receipts: ${tx.step}`, () => assert.deepEqual(normalize(L.lootEvents(tx.logs)), tx.expect));
  }
});

describe('Token-2022: the accounts a transfer needs', () => {
  const rpcOf = (accounts) => ({ accounts: async (list) => list.map((a) => (accounts[a] ? { owner: accounts[a].owner, data: fromBase64(accounts[a].data) } : null)) });
  const H = F.hook;
  const transfer = { ...H.transfer, amount: BigInt(H.transfer.amount) };

  it('a transfer hook’s accounts resolve as @solana/spl-token resolves them, plus the Memo program', async () => {
    const extras = await transferExtras(rpcOf(H.accounts), H.mint, [transfer]);
    const byKey = (list) => [...list].sort((a, b) => a.pubkey.localeCompare(b.pubkey));
    // spl-token passes the hook program and its list last; the program finds them by address, so order is free.
    assert.deepEqual(byKey(extras.filter((m) => m.pubkey !== MEMO_PROGRAM)), byKey(H.extras));
    assert.equal(extras[0].pubkey, MEMO_PROGRAM);
    assert.ok(extras.every((m) => !m.isSigner), 'a hook never gets a signature');
  });
  it('a hook that depends on the transfer asks for it', async () => {
    await assert.rejects(transferExtras(rpcOf(H.accounts), H.mint, []), /needs to know each transfer/);
  });
  it('a classic mint needs nothing; a Token-2022 mint with no hook needs the Memo program', async () => {
    const classic = { [I.mint]: { owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', data: F.hook.accounts[H.mint].data } };
    assert.deepEqual(await transferExtras(rpcOf(classic), I.mint), []);
    const plain2022 = { [I.mint22]: { owner: T22, data: Buffer.alloc(82).toString('base64') } };
    assert.deepEqual(await transferExtras(rpcOf(plain2022), I.mint22), memo);
  });
});

describe('accounts the IDL does not describe', () => {
  it('a stake position: tag 10, stake, player, bump, amount, since, paid per token', () => {
    const data = concat(Uint8Array.of(10), addressBytes(I.owner), addressBytes(I.player), Uint8Array.of(254), uintLE(50n, 8), uintLE(1760000000n, 8), uintLE(2n ** 70n, 16));
    assert.deepEqual(L.decodePosition(data), { stake: I.owner, player: I.player, bump: 254, amount: 50n, since: 1760000000n, paid_per_token: 2n ** 70n });
    assert.throws(() => L.decodePosition(fromBase64(F.accounts.stake.data)), /Not a Position/);
  });
  it('a lottery’s purchase lines: 40 bytes each after its record', () => {
    const lines = concat(addressBytes(I.player), uintLE(3n, 8), addressBytes(I.to), uintLE(5n, 8));
    assert.deepEqual(L.lotteryLines(concat(fromBase64(F.accounts.lottery.data), lines)), [{ buyer: I.player, end: 3n }, { buyer: I.to, end: 5n }]);
  });
});

describe('order helpers and odds', () => {
  const order0 = { game, player: I.player, mint: I.mint, requested_slot: 1000n, shares: [] };
  it('a refund waits for its condition', () => {
    assert.deepEqual(L.refundable({ ...order0, status: 'Failed' }, 1000), { ok: false, atSlot: 1001n }, 'never in the slot it was opened in');
    assert.deepEqual(L.refundable({ ...order0, status: 'Failed' }, 1001), { ok: true });
    assert.deepEqual(L.refundable({ ...order0, status: 'Pending' }, 2000), { ok: false, atSlot: 2501n });
    assert.deepEqual(L.refundable({ ...order0, status: 'Pending' }, 2501), { ok: true });
    assert.equal(L.refundable({ ...order0, status: 'Rolled' }, 2501).ok, false);
  });
  it('a price falls as Fall::at says, never under its floor', () => {
    const item = { price: 100n, fall: { step: 10n, every: 60, floor: 35n, since: 1000n } };
    assert.equal(L.priceAt(item, 1000), 100n);
    assert.equal(L.priceAt(item, 1119), 90n);
    assert.equal(L.priceAt(item, 1000 + 60 * 9), 35n);
    assert.equal(L.priceAt({ price: 5n, fall: null }, 99), 5n);
  });
  it('odds skip what cannot be won and shrink with stock', () => {
    const box = { stock_odds: true, entries };
    const odds = L.boxOdds(box, { items: { 7: { active: true, max_supply: 4, issued: 3, voided: 0 } }, pools: { 1: 4999n, 2: 10n } });
    assert.deepEqual(odds.map((o) => [o.weight, o.available]), [[15, true], [20, false], [10, true], [5, true], [5, true]]);
    assert.equal(odds[0].chance, 15 / 35);
    assert.equal(odds[1].chance, 0);
  });
  it('a refund’s voided serial counts as back in stock', () => {
    const item = { active: true, max_supply: 4, issued: 4, voided: 1 };
    assert.equal(L.itemOut(item), 3);
    assert.equal(L.soldOut(item), false);
    assert.deepEqual(L.boxOdds({ stock_odds: true, entries }, { items: { 7: item } })[0].weight, 15);
    assert.equal(L.soldOut({ ...item, voided: 0 }), true);
    assert.equal(L.soldOut({ ...item, max_supply: 0 }), false, 'no limit');
  });
});
