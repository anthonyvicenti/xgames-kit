// Putting an economy live: every step of every fixture's plan maps onto the kit's real instruction builders (and,
// for a few, byte for byte what a hand-written builder call gives), what lands is written back so a later change
// publishes only the difference, and the whole economy flow runs offline against the fake chain, then reads back
// with economyStatus.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fromBase64, toBase64, utf8 } from '../builder/web3/gf-web3/chain/bytes.js';
import { createCollectionInstruction } from '../builder/web3/gf-web3/chain/core.js';
import { boxArgs, createGameIx, depositIx, lootPda, openPoolIx, openStakeIx, upsertBoxIx, upsertItemIx, upsertLotteryIx, upsertRecipeIx, upsertScheduleIx } from '../builder/web3/gf-web3/chain/loot.js';
import { associatedTokenAddress, NATIVE_MINT, TOKEN_2022_PROGRAM, TOKEN_PROGRAM } from '../builder/web3/gf-web3/chain/pda.js';
import { createAssociatedTokenAccountIdempotent } from '../builder/web3/gf-web3/chain/programs.js';
import { MEMO_PROGRAM } from '../builder/web3/gf-web3/chain/token2022.js';
import { compileMessage, MAX_TRANSACTION_BYTES, readTransaction, wireTransaction, withSignature } from '../builder/web3/gf-web3/chain/tx.js';
import { compile } from '../builder/web3/economy/compile.mjs';
import { economyStatus, planToInstructions, publishPlan, recordLanded, resolver, toCodec } from '../builder/web3/node/economy.mjs';
import { freshKeypair } from '../builder/web3/node/ed25519.mjs';
import { fixture, fixtureNames, NOW } from './economy/helpers.mjs';
import { fakeChain } from './web3/fake-chain.mjs';
import { makeGame, post, request, serve } from './web3/helpers.mjs';

const OWNER = freshKeypair().address;

/** Fresh keys for every "new:" signer of a plan, and stand-in mints for tokens still to launch on the curve. */
function contextFor(spec, plan, extra = {}) {
  const keys = {};
  for (const tx of plan.transactions) for (const s of tx.signers) if (s.startsWith('new:')) keys[s] ??= freshKeypair().address;
  const mints = Object.fromEntries((spec.tokens ?? []).filter((t) => t.source === 'curve' && !t.mint).map((t) => [t.key, freshKeypair().address]));
  // A Token-2022 mint with no hook: its extras are the Memo program only.
  const rpc = { accounts: async (list) => list.map(() => ({ owner: TOKEN_2022_PROGRAM, data: new Uint8Array(82) })) };
  return { economy: spec, owner: OWNER, keys, mints, rpc, ...extra };
}

const stepsOf = (plan) => plan.transactions.flatMap((t) => t.steps);
const same = (a, b) => {
  assert.equal(a.programId, b.programId);
  assert.deepEqual(a.keys, b.keys);
  assert.equal(toBase64(a.data), toBase64(b.data));
};

describe('planToInstructions', () => {
  for (const name of fixtureNames()) {
    it(`${name}: every step maps to an instruction, and every transaction fits`, async () => {
      const spec = fixture(name);
      const plan = compile(spec, { now: NOW });
      assert.equal(plan.ok, true, JSON.stringify(plan.refusals));
      const ctx = contextFor(spec, plan);
      const built = await planToInstructions(plan, ctx);
      assert.equal(built.transactions.length, plan.transactions.length);
      for (const [i, tx] of built.transactions.entries()) {
        assert.equal(tx.instructions.length, plan.transactions[i].steps.length);
        const wire = wireTransaction(compileMessage({ payer: OWNER, blockhash: OWNER, instructions: tx.instructions }));
        assert.ok(wire.length <= MAX_TRANSACTION_BYTES, `${name} transaction ${i + 1} is ${wire.length} bytes`);
        assert.ok(wire.length <= plan.transactions[i].bytes, `${name} transaction ${i + 1}: the plan said ${plan.transactions[i].bytes} bytes, it is ${wire.length}`);
      }
    });
  }

  it('the coin-flip arena: bytes equal the hand-written builder calls', async () => {
    const spec = fixture('coin-flip-arena');
    const plan = compile(spec, { now: NOW });
    const ctx = contextFor(spec, plan);
    const built = await planToInstructions(plan, ctx);
    const ixs = new Map(built.transactions.flatMap((t) => t.steps.map((id, i) => [`${id}#${t.stepList[i].ix}`, t.instructions[i]])));
    const collection = ctx.keys['new:collection'];
    const game = lootPda.game(collection);
    const treasury = associatedTokenAddress(OWNER, NATIVE_MINT);
    same(ixs.get('collection#create_collection_v2'), createCollectionInstruction({ collection, creator: OWNER, name: 'Coin-flip arena', uri: '', royaltyBps: 500 }));
    same(ixs.get('treasury#create_idempotent'), createAssociatedTokenAccountIdempotent(OWNER, OWNER, NATIVE_MINT));
    same(ixs.get('game#create_game'), createGameIx({ owner: OWNER, collection, mint: NATIVE_MINT, treasury }));
    same(ixs.get('pool:house#open_pool'), openPoolIx({ owner: OWNER, game, index: 0, mint: NATIVE_MINT }));
    const box = {
      price: 100_000_000n,
      shares: [{ to: { Pool: [0] }, bps: 8800 }, { to: { Pool: [2] }, bps: 1000 }, { to: { Pool: [1] }, bps: 200 }],
      entries: [{ outcome: { Pay: { pool: 0, amount: 176_000_000n } }, weight: 1 }, { outcome: 'Nothing', weight: 1 }],
    };
    same(ixs.get('box:flip#upsert_box'), upsertBoxIx({ owner: OWNER, game, boxId: 1, args: boxArgs(box) }));
    same(ixs.get('lottery:weekly#upsert_lottery'), upsertLotteryIx({ owner: OWNER, game, id: 1, args: { price: 10_000_000n, pot: 2, places: [5000, 3000, 2000], every: 604_800n, draws_at: BigInt(NOW + 604_800) } }));
    same(ixs.get('stake:backers#open_stake'), openStakeIx({ owner: OWNER, game, id: 1, mint: ctx.mints.arena, rewardsMint: NATIVE_MINT, rewardsPool: 1, lock: 86_400n }));
    same(ixs.get('seed:house#deposit'), depositIx({ depositor: OWNER, game, index: 0, mint: NATIVE_MINT, amount: 5_000_000_000n }));
  });

  it('recipes, schedules and items with a life, a rise and a fall: bytes equal the builders', async () => {
    const halving = fixture('halving-seasons');
    let plan = compile(halving, { now: NOW });
    let ctx = contextFor(halving, plan);
    let built = await planToInstructions(plan, ctx);
    let ixs = new Map(built.transactions.flatMap((t) => t.steps.map((id, i) => [`${id}#${t.stepList[i].ix}`, t.instructions[i]])));
    let game = lootPda.game(ctx.keys['new:collection']);
    const play = ctx.keys['new:mint/play'];
    same(ixs.get('schedule:season-mint#upsert_schedule'), upsertScheduleIx({ owner: OWNER, game, id: 1, args: { active: true, action: { Issue: { mint: play, pool: 0, amount: 1_000_000_000n, halve_every: 30 } }, every: 86_400n, next_at: BigInt(NOW + 86_400), max_runs: 360 } }));
    same(ixs.get('recipe:daily-claim#upsert_recipe'), upsertRecipeIx({ owner: OWNER, game, id: 1, args: { inputs: [{ Use: { item: 1 } }], outputs: [{ Tokens: { mint: play, amount: 10_000_000n, from: { Pool: [0] } } }] } }));
    same(ixs.get('item:season-pass#upsert_item'), upsertItemIx({ owner: OWNER, game, itemId: 1, args: { kind: 'Collectible', soulbound: true, name: 'Season Pass', uri: '', price: 50_000_000n, life: { ready_after: 0n, lasts: 0n, uses: 0, cooldown: 86_400n } } }));

    const drop = fixture('falling-drop');
    plan = compile(drop, { now: NOW });
    ctx = contextFor(drop, plan);
    built = await planToInstructions(plan, ctx);
    ixs = new Map(built.transactions.flatMap((t) => t.steps.map((id, i) => [`${id}#${t.stepList[i].ix}`, t.instructions[i]])));
    game = lootPda.game(ctx.keys['new:collection']);
    same(ixs.get('item:drop-hero#upsert_item'), upsertItemIx({ owner: OWNER, game, itemId: 1, args: { name: 'Drop Hero', uri: '', max_supply: 100, price: 2_000_000_000n, fall: { step: 50_000_000n, every: 60n, floor: 200_000_000n, since: BigInt(NOW) } } }));
    same(ixs.get('item:clone#upsert_item'), upsertItemIx({ owner: OWNER, game, itemId: 2, args: { name: 'Clone', uri: '', price: 100_000_000n, rise: { step: 0n, growth_bps: 500 } } }));
  });

  it('a Token-2022 seed carries the Memo program after its named accounts', async () => {
    const spec = fixture('blind-forge');
    spec.pools[0].seed = 5;
    const plan = compile(spec, { now: NOW });
    const ctx = contextFor(spec, plan);
    const deposit = (await planToInstructions(plan, ctx)).transactions.flatMap((t) => t.instructions.map((ix, i) => [t.stepList[i], ix])).find(([s]) => s.ix === 'deposit')[1];
    const mint = spec.tokens[0].mint;
    const game = lootPda.game(ctx.keys['new:collection']);
    same(deposit, depositIx({ depositor: OWNER, game, index: 0, mint, amount: 5_000_000n, tokenProgram: TOKEN_2022_PROGRAM, remaining: [{ pubkey: MEMO_PROGRAM, isSigner: false, isWritable: false }] }));
  });

  it('turns plan values into the codec’s: u64 text, names, enums with and without fields, hex references', () => {
    const resolve = resolver({ economy: fixture('coin-flip-arena'), owner: OWNER, collection: OWNER, mints: { arena: OWNER } });
    assert.deepEqual(toCodec({ defined: { name: 'To' } }, { Pool: 3 }, resolve), { Pool: [3] });
    assert.equal(toCodec({ defined: { name: 'To' } }, { Burn: {} }, resolve), 'Burn');
    assert.equal(toCodec('u64', '18446744073709551615', resolve), 18_446_744_073_709_551_615n);
    assert.equal(toCodec('pubkey', '@mint:sol', resolve), NATIVE_MINT);
    assert.equal(toCodec('pubkey', '@wallet:owner', resolve), OWNER);
    assert.equal(toCodec('pubkey', '@pda:game', resolve), lootPda.game(OWNER));
    assert.deepEqual(Array.from(toCodec({ array: ['u8', 32] }, '20'.repeat(32), resolve)), Array(32).fill(32));
    assert.throws(() => resolver({ economy: fixture('coin-flip-arena'), owner: OWNER, collection: OWNER })('mint:arena'), /not launched yet/);
  });
});

describe('what landed, and the difference a change publishes', () => {
  it('after every transaction lands nothing is left; one price change publishes one step', () => {
    const spec = fixture('starforce');
    const collection = freshKeypair().address;
    const mint = freshKeypair().address;
    let config = { version: 1, network: 'devnet', economy: structuredClone(spec) };
    const { plan, next } = publishPlan(config.economy, { now: NOW });
    for (const tx of plan.transactions) config = recordLanded(config, { signature: '5'.repeat(88), steps: tx.steps, next, owner: OWNER, collection, treasury: OWNER, authority: OWNER, mints: { attempt: mint }, at: new Date(NOW * 1000).toISOString() });
    const e = config.economy;
    assert.equal(e.live.game, lootPda.game(collection));
    assert.equal(e.live.at, new Date(NOW * 1000).toISOString());
    assert.equal(e.tokens.find((t) => t.key === 'attempt').mint, mint, 'the token the game made has its mint now');
    assert.deepEqual(e.items.map((i) => i.id), [1, 2], 'parts have their program ids');
    assert.equal(e.pools[0].index, 0);
    assert.equal(config.creator, OWNER);
    assert.ok(e.live.transactions.every((t) => t.parts.length));
    const after = publishPlan(e);
    assert.equal(after.plan.ok, true);
    assert.equal(after.plan.transactions.length, 0, JSON.stringify(after.plan.transactions.map((t) => t.steps.map((s) => s.id))));

    e.boxes[0].price = 2;
    const changed = publishPlan(e).plan;
    assert.deepEqual(changed.transactions.flatMap((t) => t.steps.map((s) => s.id)), ['box:star-1']);
    e.recipes.pop();
    const removed = publishPlan(e).plan;
    assert.deepEqual(removed.transactions.flatMap((t) => t.steps.map((s) => `${s.id}:${s.args.args?.active}`)).sort(), ['box:star-1:true', 'recipe:try:false']);
    // Once the switch-off lands, the recipe stays in what is live, off, and nothing more is sent for it.
    const off = recordLanded(config, { signature: '6'.repeat(88), steps: removed.transactions.flatMap((t) => t.steps), next: publishPlan(e).next, owner: OWNER, collection, mints: {}, at: e.live.at });
    assert.equal(off.economy.live.published.recipes.find((r) => r.key === 'try').active, false);
    assert.equal(publishPlan(off.economy).plan.transactions.length, 0);
  });
});

/** A test wallet that signs the way a Wallet Standard wallet does. */
function testWallet() {
  const key = freshKeypair();
  return {
    address: key.address,
    signMessage: (text) => toBase64(key.sign(utf8(text))),
    signTransactions: (b64s) => b64s.map((b64) => toBase64(withSignature(fromBase64(b64), key.address, key.sign(readTransaction(fromBase64(b64)).message)))),
  };
}

async function approveAll(port, flow, wallet) {
  let view = flow;
  for (let guard = 0; !view.done && guard < 40; guard++) {
    const prepared = await post(port, '/flow/prepare', { flowId: view.id, wallet: wallet.address });
    assert.equal(prepared.status, 200, prepared.text);
    const p = prepared.json;
    const answer = p.kind === 'message' ? { signature: wallet.signMessage(p.text) } : { signed: wallet.signTransactions(p.transactions) };
    const done = await post(port, '/flow/complete', { flowId: view.id, prepareId: p.prepareId, ...answer });
    assert.equal(done.status, 200, done.text);
    view = done.json;
  }
  return view;
}

describe('the economy flow, end to end (offline)', () => {
  it('puts a whole economy live in one approval, writes it to gamesfun.json, reads back on chain, then publishes only a change', async () => {
    const spec = fixture('coin-flip-arena');
    // The curve launch is its own approval (tested with the token launch); here the token is already out.
    spec.tokens[1] = { ...spec.tokens[1], source: 'existing', mint: NATIVE_MINT === OWNER ? OWNER : freshKeypair().address };
    const game = await makeGame({ config: { version: 1, network: 'devnet', economy: spec } });
    const chain = fakeChain();
    const mintData = new Uint8Array(82);
    mintData[44] = 6;
    mintData[45] = 1;
    chain.put(spec.tokens[1].mint, TOKEN_PROGRAM, mintData);
    const server = await serve({ gameDir: game.gameDir, kitRoot: game.kitRoot, fetchImpl: chain.fetchImpl, env: {}, log: () => {} });
    const wallet = testWallet();
    try {
      const started = await post(server.port, '/flow/start', { kind: 'economy', wallet: wallet.address });
      assert.equal(started.status, 200, started.text);
      assert.equal(started.json.kind, 'economy');
      assert.equal(started.json.steps.length, 1, 'no pictures: one approval');
      const done = await approveAll(server.port, started.json, wallet);
      assert.equal(done.done, true, done.error);
      assert.equal(chain.sent.length, 2);
      const config = JSON.parse(await readFile(path.join(game.gameDir, 'gamesfun.json'), 'utf8'));
      const live = config.economy.live;
      assert.equal(live.game, lootPda.game(live.collection));
      assert.equal(live.transactions.length, 2);
      assert.equal(config.creator, wallet.address);
      assert.equal(done.outcome.game, live.game);

      const status = await request(server.port, { path: '/api/web3/economy/status' });
      assert.equal(status.status, 200, status.text);
      assert.equal(status.json.live, true);
      const missing = status.json.parts.filter((p) => !p.onChain || p.differs);
      assert.deepEqual(missing, [], JSON.stringify(missing));
      assert.deepEqual(status.json.parts.map((p) => `${p.part}:${p.key}`).sort(), ['box:flip', 'collection:collection', 'game:game', 'lottery:weekly', 'pool:backers', 'pool:house', 'pool:pot', 'stake:backers'].sort());

      config.economy.boxes[0].price = 0.2;
      await writeFile(path.join(game.gameDir, 'gamesfun.json'), JSON.stringify(config, null, 2));
      const changed = await request(server.port, { path: '/api/web3/economy/status?receipts=0' });
      assert.deepEqual(changed.json.parts.filter((p) => p.differs).map((p) => p.key), ['flip']);
      const again = await post(server.port, '/flow/start', { kind: 'economy', wallet: wallet.address });
      assert.equal(again.status, 200, again.text);
      await approveAll(server.port, again.json, wallet);
      assert.equal(chain.sent.length, 3, 'one transaction for one changed box');
      const fixed = await request(server.port, { path: '/api/web3/economy/status?receipts=0' });
      assert.deepEqual(fixed.json.parts.filter((p) => p.differs), []);
      const nothing = await post(server.port, '/flow/start', { kind: 'economy', wallet: wallet.address });
      assert.equal(nothing.status, 200);
      const p = await post(server.port, '/flow/prepare', { flowId: nothing.json.id, wallet: wallet.address });
      assert.match(p.json.error, /already live/);
    } finally {
      await server.close();
    }
  });

  it('a game that still has a shop: moved into an economy and put live, pictures uploaded first', async () => {
    const game = await makeGame();
    const chain = fakeChain();
    const server = await serve({ gameDir: game.gameDir, kitRoot: game.kitRoot, fetchImpl: chain.fetchImpl, env: {}, log: () => {} });
    const wallet = testWallet();
    try {
      assert.equal((await post(server.port, '/item/save', { name: 'Golden Hat', picture: 'assets/hat.png', rarity: 'Rare', price: '0.05' })).status, 200);
      assert.equal((await post(server.port, '/item/save', { name: 'No Picture Yet' })).status, 200);
      assert.equal((await post(server.port, '/box/save', { name: 'Mystery Box', price: '0.01', odds: '1:60,2:40' })).status, 200);
      const started = await post(server.port, '/flow/start', { kind: 'publish', wallet: wallet.address });
      assert.equal(started.status, 200, started.text);
      assert.equal(started.json.kind, 'economy');
      // the picture, its details, the collection's details, then one approval
      assert.equal(started.json.steps.length, 4);
      assert.match(started.json.lines.join(' '), /No Picture Yet has no picture/);
      const done = await approveAll(server.port, started.json, wallet);
      assert.equal(done.done, true);
      assert.equal(chain.uploads.length, 3);
      const config = JSON.parse(await readFile(path.join(game.gameDir, 'gamesfun.json'), 'utf8'));
      assert.equal(config.shop, undefined, 'the shop is part of the economy now');
      const e = config.economy;
      assert.equal(e.currency, 'sol');
      assert.match(e.items[0].uri, /^https:\/\/devnet\.irys\.xyz\//);
      assert.match(e.collection.uri, /^https:\/\/devnet\.irys\.xyz\//);
      const item = chain.accounts.get(lootPda.item(e.live.game, 1));
      assert.ok(item, 'the item is on chain');
      // As an agent tool calls it: { kitRoot, env, fetchImpl }.
      const status = await economyStatus(game.gameDir, { kitRoot: game.kitRoot, env: {}, fetchImpl: chain.fetchImpl, receipts: 0 });
      assert.equal(status.live, true);
      assert.deepEqual(status.parts.filter((p) => !p.onChain || p.differs), []);
    } finally {
      await server.close();
    }
  });

  it('refuses an economy the checker refuses, naming the fix', async () => {
    const spec = fixture('coin-flip-arena');
    spec.boxes[0].outcomes[0].chance = 70;
    const game = await makeGame({ config: { version: 1, network: 'devnet', economy: spec } });
    const chain = fakeChain();
    const server = await serve({ gameDir: game.gameDir, kitRoot: game.kitRoot, fetchImpl: chain.fetchImpl, env: {}, log: () => {} });
    try {
      const r = await post(server.port, '/flow/start', { kind: 'economy', wallet: testWallet().address });
      assert.equal(r.status, 400);
      assert.match(r.json.error, /not ready to go live.*Fix:/);
    } finally {
      await server.close();
    }
  });
});
