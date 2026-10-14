// The approval flows, offline: a fake chain and Irys node (tests/web3/fake-chain.mjs) and a wallet made of a fresh
// test key that signs exactly like a Wallet Standard wallet (signMessage on the text; signTransaction filling its
// own slot). Covers the engine's replay protection and signature checks, then a whole shop publish and a whole
// token launch through the HTTP routes, down to what lands in gamesfun.json.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fromBase64, toBase64, utf8 } from '../builder/web3/gf-web3/chain/bytes.js';
import { decodeLoot, lootPda } from '../builder/web3/gf-web3/chain/loot.js';
import { associatedTokenAddress, TOKEN_2022_PROGRAM } from '../builder/web3/gf-web3/chain/pda.js';
import { compileMessage, readMessage, readTransaction, wireTransaction, withSignature } from '../builder/web3/gf-web3/chain/tx.js';
import { transferLamports } from '../builder/web3/gf-web3/chain/programs.js';
import { freshKeypair } from '../builder/web3/node/ed25519.mjs';
import { createFlowEngine } from '../builder/web3/node/flow-engine.mjs';
import { queueRequest } from '../builder/web3/node/requests.mjs';
import { fakeChain } from './web3/fake-chain.mjs';
import { makeGame, post, request, serve } from './web3/helpers.mjs';

const F = JSON.parse(await readFile(new URL('./web3/fixtures/chain.json', import.meta.url), 'utf8'));

/** A test wallet that signs the way a Wallet Standard wallet does. */
function testWallet() {
  const key = freshKeypair();
  return {
    address: key.address,
    signMessage: (text) => toBase64(key.sign(utf8(text))),
    signTransactions: (b64s) => b64s.map((b64) => {
      const wire = fromBase64(b64);
      return toBase64(withSignature(wire, key.address, key.sign(readTransaction(wire).message)));
    }),
  };
}

/** Run a started flow to the end through the routes, approving every step. Returns the final view. */
async function approveAll(port, flow, wallet, { tamper } = {}) {
  let view = flow;
  for (let guard = 0; !view.done && guard < 40; guard++) {
    const prepared = await post(port, '/flow/prepare', { flowId: view.id, wallet: wallet.address });
    assert.equal(prepared.status, 200, prepared.text);
    const p = prepared.json;
    const answer = p.kind === 'message' ? { signature: wallet.signMessage(p.text) } : { signed: wallet.signTransactions(tamper ? tamper(p.transactions) : p.transactions) };
    const done = await post(port, '/flow/complete', { flowId: view.id, prepareId: p.prepareId, ...answer });
    assert.equal(done.status, 200, done.text);
    view = done.json;
  }
  return view;
}

describe('the approval engine', () => {
  const wallet = testWallet();
  const message = { title: 'Sign', prepare: async () => ({ kind: 'message', text: 'hello' }), complete: async () => 'ok' };
  const blockhash = F.messages.blockhash;
  const tx = () => ({
    title: 'Pay',
    prepare: async () => ({ kind: 'transactions', transactions: [wireTransaction(compileMessage({ payer: wallet.address, blockhash, instructions: [transferLamports(wallet.address, F.loot.inputs.creator, 5n)] }))] }),
    complete: async (flow, answer) => `sent ${answer.transactions.length}`,
  });

  it('a prepared answer is used once: a replay is refused', async () => {
    const engine = createFlowEngine();
    const flow = engine.start({ kind: 't', title: 't', wallet: wallet.address, steps: [message, message] });
    const p = await engine.prepare(flow.id, wallet.address);
    const answer = { prepareId: p.prepareId, signature: wallet.signMessage(p.text) };
    assert.equal((await engine.complete(flow.id, answer)).next, 1);
    await assert.rejects(engine.complete(flow.id, answer), (e) => e.status === 409);
  });

  it('an answer for another prepare, an expired one, or from another wallet completes nothing', async () => {
    let clock = 1_000;
    const engine = createFlowEngine({ now: () => clock });
    const flow = engine.start({ kind: 't', title: 't', wallet: wallet.address, steps: [message] });
    const p = await engine.prepare(flow.id, wallet.address);
    await assert.rejects(engine.complete(flow.id, { prepareId: 'nope', signature: wallet.signMessage(p.text) }), (e) => e.status === 409);
    const q = await engine.prepare(flow.id, wallet.address);
    await assert.rejects(engine.complete(flow.id, { prepareId: q.prepareId, signature: testWallet().signMessage(q.text) }), (e) => e.status === 400);
    const r = await engine.prepare(flow.id, wallet.address);
    clock += 91_000;
    await assert.rejects(engine.complete(flow.id, { prepareId: r.prepareId, signature: wallet.signMessage(r.text) }), (e) => e.status === 410);
    await assert.rejects(engine.prepare(flow.id, testWallet().address), (e) => e.status === 409);
    assert.equal(engine.get(flow.id).next, 0);
  });

  it('refuses a transaction the wallet changed, one signed by another key, and a missing signature', async () => {
    const engine = createFlowEngine();
    const flow = engine.start({ kind: 't', title: 't', wallet: wallet.address, steps: [tx()] });
    const p1 = await engine.prepare(flow.id, wallet.address);
    const changed = wireTransaction(compileMessage({ payer: wallet.address, blockhash, instructions: [transferLamports(wallet.address, F.loot.inputs.player, 5_000_000_000n)] }));
    await assert.rejects(engine.complete(flow.id, { prepareId: p1.prepareId, signed: wallet.signTransactions([toBase64(changed)]) }), /changed the transaction/);
    const p2 = await engine.prepare(flow.id, wallet.address);
    const other = testWallet();
    const forged = p2.transactions.map((b64) => {
      const wire = fromBase64(b64);
      return toBase64(withSignature(wire, wallet.address, fromBase64(other.signMessage('x')).slice(0, 64)));
    });
    await assert.rejects(engine.complete(flow.id, { prepareId: p2.prepareId, signed: forged }), /signature/);
    const p3 = await engine.prepare(flow.id, wallet.address);
    await assert.rejects(engine.complete(flow.id, { prepareId: p3.prepareId, signed: p3.transactions }), /signature/);
    const p4 = await engine.prepare(flow.id, wallet.address);
    await assert.rejects(engine.complete(flow.id, { prepareId: p4.prepareId, signed: [] }), /does not match/);
    const p5 = await engine.prepare(flow.id, wallet.address);
    assert.equal((await engine.complete(flow.id, { prepareId: p5.prepareId, signed: wallet.signTransactions(p5.transactions) })).done, true);
  });

  it('caps how many flows wait at once, and nothing starts without a wallet or a step', () => {
    const engine = createFlowEngine({ maxFlows: 2 });
    engine.start({ kind: 't', title: 't', wallet: wallet.address, steps: [message] });
    engine.start({ kind: 't', title: 't', wallet: wallet.address, steps: [message] });
    assert.throws(() => engine.start({ kind: 't', title: 't', wallet: wallet.address, steps: [message] }), (e) => e.status === 429);
    assert.throws(() => createFlowEngine().start({ kind: 't', title: 't', wallet: 'nope', steps: [message] }), (e) => e.status === 400);
    assert.throws(() => createFlowEngine().start({ kind: 't', title: 't', wallet: wallet.address, steps: [] }), (e) => e.status === 409);
  });
});

describe('putting a shop on sale, end to end (offline): the shop is part of the economy now', () => {
  let game;
  let chain;
  let server;
  const wallet = testWallet();
  const saved = async () => JSON.parse(await readFile(path.join(game.gameDir, 'gamesfun.json'), 'utf8'));
  before(async () => {
    game = await makeGame();
    chain = fakeChain();
    server = await serve({ gameDir: game.gameDir, kitRoot: game.kitRoot, fetchImpl: chain.fetchImpl, env: {}, log: () => {} });
  });
  after(() => server.close());

  it('drafts items and a box, then one approval for every transaction', async () => {
    assert.equal((await post(server.port, '/item/save', { name: 'Golden Hat', picture: 'assets/hat.png', rarity: 'Rare', price: '0.05', look: { values: { 'character.tint.player': '#ffcc00' } } })).status, 200);
    assert.equal((await post(server.port, '/item/save', { name: 'Ice Skin', picture: 'assets/skin.png', rarity: 'Epic' })).status, 200);
    assert.equal((await post(server.port, '/item/save', { name: 'No Picture Yet' })).status, 200);
    const box = await post(server.port, '/box/save', { name: 'Mystery Box', price: '0.01', odds: '1:60,2:40' });
    assert.equal(box.status, 200, box.text);
    const state = await request(server.port, { path: '/api/web3/state' });
    assert.equal(state.json.chain.shop.items[1].state, 'draft');

    const started = await post(server.port, '/flow/start', { kind: 'publish', wallet: wallet.address });
    assert.equal(started.status, 200, started.text);
    assert.equal(started.json.kind, 'economy', 'the shop goes live as the economy it moves into');
    // 2 pictures + 2 item details + collection details + one transactions approval; the item with no picture goes live without one.
    assert.equal(started.json.steps.length, 6);
    assert.match(started.json.lines.join(' '), /No Picture Yet has no picture/);
    const done = await approveAll(server.port, started.json, wallet);
    assert.equal(done.done, true);
    assert.equal(chain.uploads.length, 5);
    assert.ok(chain.sent.length >= 1 && chain.sent.length <= 3, `sent ${chain.sent.length}`);

    const config = await saved();
    assert.equal(config.creator, wallet.address);
    assert.equal(config.shop, undefined);
    const e = config.economy;
    assert.equal(e.currency, 'sol');
    assert.equal(e.live.game, lootPda.game(e.live.collection));
    assert.deepEqual(e.items.map((i) => i.id), [1, 2, 3]);
    assert.match(e.items[0].uri, /^https:\/\/devnet\.irys\.xyz\/[1-9A-HJ-NP-Za-km-z]{43,44}$/);
    const item = decodeLoot('Item', chain.accounts.get(lootPda.item(e.live.game, 1)).data);
    assert.equal(item.price, 50_000_000n);
    assert.equal(item.uri, e.items[0].uri);
    // The item details uploaded are real Metaplex JSON with the look under properties.gameLook.
    // A data item (ANS-104, no target): 2 + 64 + 32 + 1 + 1 + 32 + 8 bytes, then the tags' length (u64), the tags, the data.
    const dataItem = chain.uploads.find((u) => u.id === e.items[0].uri.split('/').pop()).bytes;
    const tagsLength = Number(new DataView(dataItem.buffer, dataItem.byteOffset).getBigUint64(140, true));
    const meta = JSON.parse(new TextDecoder().decode(dataItem.subarray(148 + tagsLength)));
    assert.deepEqual(meta.properties.gameLook, { values: { 'character.tint.player': '#ffcc00' }, files: {} });

    const status = await request(server.port, { path: '/api/web3/economy/status' });
    assert.deepEqual(status.json.parts.filter((p) => !p.onChain || p.differs), []);
  });

  it('a later change is one more approval, with no new upload when only the price changed', async () => {
    const uploads = chain.uploads.length;
    const config = await saved();
    config.economy.items[1].price = '0.2';
    await writeFile(path.join(game.gameDir, 'gamesfun.json'), JSON.stringify(config, null, 2));
    const started = await post(server.port, '/flow/start', { kind: 'economy', wallet: wallet.address });
    assert.equal(started.json.steps.length, 1, started.text);
    await approveAll(server.port, started.json, wallet);
    assert.equal(chain.uploads.length, uploads);
    assert.equal(decodeLoot('Item', chain.accounts.get(lootPda.item(config.economy.live.game, 2)).data).price, 200_000_000n);
  });

  it('the loot game is the creator’s: its owner and its authority, the whole sale to the treasury', async () => {
    const { economy: e } = await saved();
    const g = decodeLoot('Game', chain.accounts.get(e.live.game).data);
    assert.deepEqual([g.owner, g.authority, g.treasury, g.mint], [wallet.address, wallet.address, e.live.treasury, 'So11111111111111111111111111111111111111112']);
    const box = decodeLoot('LootBox', chain.accounts.get(lootPda.box(e.live.game, 1)).data);
    assert.deepEqual(box.entries, [{ outcome: { Item: [1] }, weight: 60 }, { outcome: { Item: [2] }, weight: 40 }]);
    assert.deepEqual([box.currency, box.shares], [null, []]);
  });

  it('only the economy’s wallet can change it', async () => {
    const r = await post(server.port, '/flow/start', { kind: 'economy', wallet: testWallet().address });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /belongs to the wallet/);
  });
});

describe('a shop priced in a Token-2022 token (offline)', () => {
  it('prices in it, opens the treasury under Token-2022, and the game takes that mint', async () => {
    const game = await makeGame();
    const chain = fakeChain();
    const mint = testWallet().address;
    const data = new Uint8Array(82);
    data[44] = 6;
    data[45] = 1;
    chain.put(mint, TOKEN_2022_PROGRAM, data);
    const server = await serve({ gameDir: game.gameDir, kitRoot: game.kitRoot, fetchImpl: chain.fetchImpl, env: {}, log: () => {} });
    const wallet = testWallet();
    try {
      const priced = await post(server.port, '/shop/currency', { currency: mint });
      assert.equal(priced.status, 200, priced.text);
      assert.equal((await post(server.port, '/item/save', { name: 'Golden Hat', picture: 'assets/hat.png', price: '2.5' })).status, 200);
      const started = await post(server.port, '/flow/start', { kind: 'publish', wallet: wallet.address });
      assert.equal(started.status, 200, started.text);
      assert.equal((await approveAll(server.port, started.json, wallet)).done, true);
      const { economy: e } = JSON.parse(await readFile(path.join(game.gameDir, 'gamesfun.json'), 'utf8'));
      assert.equal(e.tokens[0].program, 'token-2022');
      assert.equal(e.live.treasury, associatedTokenAddress(wallet.address, mint, TOKEN_2022_PROGRAM));
      const g = decodeLoot('Game', chain.accounts.get(e.live.game).data);
      assert.deepEqual([g.mint, g.treasury], [mint, e.live.treasury]);
      assert.equal(decodeLoot('Item', chain.accounts.get(lootPda.item(e.live.game, 1)).data).price, 2_500_000n);
    } finally {
      await server.close();
    }
  });
});

describe('launching a token, end to end (offline)', () => {
  it('uploads the picture and details, then creates its own curve config and the pool (paired with SOL), and records what the chain shows', async () => {
    const game = await makeGame();
    const chain = fakeChain();
    const server = await serve({ gameDir: game.gameDir, kitRoot: game.kitRoot, fetchImpl: chain.fetchImpl, env: {}, log: () => {} });
    const wallet = testWallet();
    try {
      const request = await queueRequest(game.kitRoot, { kind: 'launch', gameDir: game.gameDir, input: { name: 'Bean Brawl', symbol: 'BEAN', picture: 'assets/icon.png', description: 'The bean game' }, from: 'test' });
      const started = await post(server.port, '/flow/start', { requestId: request.id, wallet: wallet.address });
      assert.equal(started.status, 200, started.text);
      assert.equal(started.json.steps.length, 3);
      assert.match(started.json.lines.join(' '), /Paired with SOL/);
      assert.match(started.json.lines.join(' '), /you keep 95% of the trading fees/);
      const done = await approveAll(server.port, started.json, wallet);
      assert.equal(done.done, true);
      const saved = JSON.parse(await readFile(path.join(game.gameDir, 'gamesfun.json'), 'utf8'));
      assert.equal(saved.token.symbol, 'BEAN');
      assert.equal(saved.token.source, 'launched');
      assert.equal(saved.token.decimals, 6);
      assert.equal(saved.token.quoteMint, 'So11111111111111111111111111111111111111112');
      assert.equal(saved.token.quoteSymbol, 'SOL');
      assert.deepEqual(saved.token.split, { creatorTradingFeePercentage: 95, partnerLockedLp: 5, creatorLockedLp: 95 });
      assert.equal(saved.creator, wallet.address);
      // The config is the launch's own: games.fun's partner claims fees and gets the leftover.
      const { readPoolConfig } = await import('../builder/web3/gf-web3/chain/dbc.js');
      const cfg = readPoolConfig(chain.accounts.get(saved.token.config).data);
      assert.deepEqual([cfg.feeClaimer, cfg.leftoverReceiver, cfg.quoteMint], ['8yPDcNeKHwfSmyx9MPNpgqU8o1W4xiCHxzYty7w3rnNV', '8yPDcNeKHwfSmyx9MPNpgqU8o1W4xiCHxzYty7w3rnNV', saved.token.quoteMint]);
      // One transaction, signed by the wallet, the fresh config key and the fresh mint key (the fake chain checks all).
      const m = chain.simulated.at(-1);
      assert.equal(m.header.numRequiredSignatures, 3);
      assert.ok(m.keys.includes(saved.token.mint) && m.keys.includes(saved.token.config));
      // The request was used up.
      const state = await (await import('./web3/helpers.mjs')).request(server.port, { path: '/api/web3/state?chain=0' });
      assert.equal(state.json.requests.length, 0);
    } finally {
      await server.close();
    }
  });

  it('with an initial buy in SOL: two transactions in one approval, the buy wrapped in the pool’s, its minimum from the offline quote', async () => {
    const game = await makeGame();
    const chain = fakeChain();
    const wallet = testWallet();
    const server = await serve({ gameDir: game.gameDir, kitRoot: game.kitRoot, fetchImpl: chain.fetchImpl, env: {}, log: () => {} });
    try {
      // At SOL = $100 the curve graduates at about 153.9 SOL: a first buy that large is refused.
      const tooBig = await post(server.port, '/flow/start', { kind: 'launch', wallet: wallet.address, input: { name: 'B', symbol: 'BB', picture: 'assets/icon.png', initialBuy: '200' } });
      assert.match(tooBig.json.error, /graduation/);
      const started = await post(server.port, '/flow/start', { kind: 'launch', wallet: wallet.address, input: { name: 'Bean Brawl', symbol: 'BEAN', picture: 'assets/icon.png', initialBuy: '0.01' } });
      assert.equal(started.status, 200, started.text);
      let view = started.json;
      for (let i = 0; i < 2; i++) {
        const p = (await post(server.port, '/flow/prepare', { flowId: view.id, wallet: wallet.address })).json;
        view = (await post(server.port, '/flow/complete', { flowId: view.id, prepareId: p.prepareId, signature: wallet.signMessage(p.text) })).json;
      }
      const p = (await post(server.port, '/flow/prepare', { flowId: view.id, wallet: wallet.address })).json;
      // tests/web3/fixtures/dbc-config.json, sol-first-buy: the launchpad's own quote for 0.01 SOL at SOL = $100.
      assert.match(p.details.join(' '), /Initial buy: 0\.01 SOL for about 197960\.793098 \$BEAN \(at least 196970\.989132\)/);
      assert.equal(p.transactions.length, 2);
      const second = readMessage(readTransaction(fromBase64(p.transactions[1])).message);
      const swap = second.instructions.find((ix) => second.keys[ix.programIndex] === 'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN' && ix.data[0] === 248).data;
      assert.equal(new DataView(swap.buffer, swap.byteOffset).getBigUint64(8, true), 10_000_000n);
      assert.equal(new DataView(swap.buffer, swap.byteOffset).getBigUint64(16, true), 196_970_989_132n);
      view = (await post(server.port, '/flow/complete', { flowId: view.id, prepareId: p.prepareId, signed: wallet.signTransactions(p.transactions) })).json;
      assert.equal(view.done, true, JSON.stringify(view));
      const saved = JSON.parse(await readFile(path.join(game.gameDir, 'gamesfun.json'), 'utf8'));
      assert.equal(saved.token.signatures.length, 2);
    } finally {
      await server.close();
    }
  });

  it('pairs with USDC-dev or a mint by address, and a pair with no price needs the creator’s market caps', async () => {
    const game = await makeGame();
    const chain = fakeChain();
    const wallet = testWallet();
    const other = testWallet().address;
    const data = new Uint8Array(82);
    data[44] = 9;
    data[45] = 1;
    chain.put(other, 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', data);
    const usdc = new Uint8Array(82);
    usdc[44] = 6;
    usdc[45] = 1;
    chain.put('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU', 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', usdc);
    const server = await serve({ gameDir: game.gameDir, kitRoot: game.kitRoot, fetchImpl: chain.fetchImpl, env: {}, log: () => {} });
    try {
      const base = { name: 'Bean Brawl', symbol: 'BEAN', picture: 'assets/icon.png' };
      const onUsdc = await post(server.port, '/flow/start', { kind: 'launch', wallet: wallet.address, input: { ...base, pair: 'USDC' } });
      assert.equal(onUsdc.status, 200, onUsdc.text);
      assert.match(onUsdc.json.lines.join(' '), /Paired with USDC-dev\..*starts at a 5000 USDC-dev market cap and graduates at 75000 USDC-dev/);
      const unpriced = await post(server.port, '/flow/start', { kind: 'launch', wallet: wallet.address, input: { ...base, pair: other } });
      assert.match(unpriced.json.error, /no price to size the curve/);
      const sized = await post(server.port, '/flow/start', { kind: 'launch', wallet: wallet.address, input: { ...base, pair: other, startCap: '2000000', graduationCap: '30000000' } });
      assert.equal(sized.status, 200, sized.text);
      const main = await post(server.port, '/shop/currency', { currency: 'MAIN' });
      assert.match(main.json.error, /Currency is SOL, USDC, token/);
    } finally {
      await server.close();
    }
  });
});
