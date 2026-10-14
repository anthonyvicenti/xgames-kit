// The in-game kit gf-web3: mock mode (no network at all, deterministic, so gf-three verify stays deterministic),
// the switch between mock and real, owned items → a gf-three loadout, and real purchases against the fake chain with
// a Wallet Standard wallet object that signs like a browser wallet.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { addressBytes } from '../builder/web3/gf-web3/chain/base58.js';
import { concat, uintLE, utf8 } from '../builder/web3/gf-web3/chain/bytes.js';
import { MPL_CORE_PROGRAM } from '../builder/web3/gf-web3/chain/core.js';
import { encodeAccount } from '../builder/web3/gf-web3/chain/borsh.js';
import { LOOT_IDL, lootPda } from '../builder/web3/gf-web3/chain/loot.js';
import { readMessage, readTransaction, withSignature } from '../builder/web3/gf-web3/chain/tx.js';
import { createGfWeb3 } from '../builder/web3/gf-web3/index.js';
import { loadoutOf } from '../builder/web3/gf-web3/looks.js';
import { freshKeypair } from '../builder/web3/node/ed25519.mjs';
import { fakeChain } from './web3/fake-chain.mjs';

const collection = 'BT3Po8rB7Deq7HxWkFNbXQmc3mnBPfij7M89UEfuKGLx';
const game = lootPda.game(collection);
const CONFIG = {
  version: 1,
  network: 'devnet',
  shop: {
    name: 'Bean Brawl Items',
    collection,
    game,
    currency: { mint: 'So11111111111111111111111111111111111111112', symbol: 'SOL', decimals: 9, native: true },
    items: [
      { id: 1, name: 'Golden Hat', rarity: 'Rare', price: '50000000', maxSupply: 0, soulbound: false, listed: true, look: { values: { 'character.tint.player': '#ffcc00' } } },
      { id: 2, name: 'Ice Skin', rarity: 'Epic', price: '0', maxSupply: 0, soulbound: false, listed: true, look: { values: { 'character.tint.player': '#66ccff', 'mechanic.projectile.color': '#0000ff' } } },
      { id: 3, name: 'Draft Thing', rarity: 'Common', price: '1', maxSupply: 0, soulbound: false, listed: false },
    ],
    boxes: [{ id: 1, name: 'Mystery Box', price: '10000000', entries: [{ item: 1, weight: 60 }, { item: 2, weight: 40 }], listed: true }],
  },
};
const at = (search) => ({ search, href: `http://127.0.0.1:5200/${search}`, host: '127.0.0.1:5200', origin: 'http://127.0.0.1:5200', pathname: '/' });
const noFetch = () => {
  throw new Error('the mock must not touch the network');
};

describe('mock mode', () => {
  it('runs with no network call: a pretend wallet, the shop, buys and box opens', async () => {
    const win = {};
    const kit = createGfWeb3({ config: CONFIG, location: at('?gamesfun_mock=1'), fetchImpl: noFetch, win });
    assert.equal(kit.mock, true);
    assert.equal((await kit.shop.list()).length, 3);
    assert.equal(await kit.owns(1), false);
    const address = await kit.connect();
    assert.equal(kit.isAddress(address), true);
    const bought = await kit.shop.buy('Golden Hat');
    assert.equal(bought.mock, true);
    assert.equal(await kit.owns(1), true);
    await assert.rejects(kit.shop.buy(2), /loot boxes/);
    const opened = await kit.openBox(1);
    assert.ok([1, 2].includes(opened.item.id));
    const signed = await kit.signIn();
    assert.match(signed.message, /wants you to sign in with your Solana account/);
  });

  it('rolls the same way every run, so verify stays deterministic', async () => {
    const run = async () => {
      const kit = createGfWeb3({ config: CONFIG, location: at('?gamesfun_mock=1'), fetchImpl: noFetch });
      const out = [];
      for (let i = 0; i < 6; i++) out.push((await kit.openBox(1)).item.id);
      return out;
    };
    assert.deepEqual(await run(), await run());
  });

  it('is on when the page is automated or headless, and ?gamesfun_mock=0 forces the real chain', () => {
    assert.equal(createGfWeb3({ config: CONFIG, location: at(''), navigator: { webdriver: true, userAgent: 'x' } }).mock, true);
    assert.equal(createGfWeb3({ config: CONFIG, location: at(''), navigator: { webdriver: false, userAgent: 'Mozilla/5.0 HeadlessChrome/140' } }).mock, true);
    assert.equal(createGfWeb3({ config: CONFIG, location: at('?gamesfun_mock=0'), navigator: { webdriver: true } }).mock, false);
    assert.equal(createGfWeb3({ config: CONFIG, location: at(''), navigator: { webdriver: false, userAgent: 'Mozilla/5.0 Chrome/140' } }).mock, false);
  });

  it('seeds owned items from ?gamesfun_owned and wears them as a gf-three loadout', async () => {
    const win = {};
    const kit = createGfWeb3({ config: CONFIG, location: at('?gamesfun_mock=1&gamesfun_owned=1,2'), fetchImpl: noFetch, win, storage: null });
    await kit.connect();
    const { loadout, worn } = await kit.wearOwned();
    // Rarest first: the Epic Ice Skin wins the body colour; the Golden Hat has nothing left to set.
    assert.deepEqual(loadout, { values: { 'character.tint.player': '#66ccff', 'mechanic.projectile.color': '#0000ff' }, files: {} });
    assert.deepEqual(worn, [2]);
    assert.deepEqual(win.__GF_LOADOUT, loadout);
    const chosen = await kit.wear([1]);
    assert.deepEqual(chosen.loadout.values, { 'character.tint.player': '#ffcc00' });
  });

  it('guests have no items and nothing asks for a wallet until it is needed', async () => {
    const kit = createGfWeb3({ config: CONFIG, location: at('?gamesfun_mock=1'), fetchImpl: noFetch });
    assert.deepEqual(await kit.ownedItems(), []);
    assert.equal(kit.address, null);
  });
});

describe('looks', () => {
  it('one item per slot, the player’s order wins, junk is dropped', () => {
    const items = [
      { id: 1, rarity: 'Common', look: { values: { 'character.tint.player': '#f00', bad: { x: 1 } }, files: { 'character.hat.player': 'https://cdn.example/hat.glb' } } },
      { id: 2, rarity: 'Legendary', look: { values: { 'character.tint.player': '#00ff00' }, files: { 'character.body.player': 'data:abc' } } },
    ];
    assert.deepEqual(loadoutOf(items), { loadout: { values: { 'character.tint.player': '#ff0000' }, files: { 'character.hat.player': 'https://cdn.example/hat.glb' } }, worn: [1] });
    assert.deepEqual(loadoutOf(items, { byRarity: true }).loadout.values, { 'character.tint.player': '#00ff00' });
  });

  it('refuses a keyed RPC URL in a game', () => {
    const kit = createGfWeb3({ config: CONFIG, location: at('?gamesfun_mock=1') });
    assert.throws(() => kit.configure({ rpc: 'https://devnet.helius-rpc.com/?api-key=abc' }), /keyless/);
    assert.throws(() => kit.configure({ rpc: 'http://example.com' }), /keyless/);
    kit.configure({ rpc: 'https://api.devnet.solana.com' });
  });
});

/** A Wallet Standard wallet object backed by a test key (what the devnet proof injects into Chrome). */
function standardWallet(key) {
  const account = { address: key.address, publicKey: addressBytes(key.address), chains: ['solana:devnet'], features: [] };
  return {
    version: '1.0.0',
    name: 'Test Wallet',
    icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"/>',
    chains: ['solana:devnet'],
    accounts: [account],
    features: {
      'standard:connect': { version: '1.0.0', connect: async () => ({ accounts: [account] }) },
      'solana:signTransaction': {
        version: '1.0.0',
        supportedTransactionVersions: ['legacy', 0],
        signTransaction: async (...inputs) => inputs.map((i) => ({ signedTransaction: withSignature(i.transaction, key.address, key.sign(readTransaction(i.transaction).message)) })),
      },
      'solana:signMessage': { version: '1.0.0', signMessage: async (...inputs) => inputs.map((i) => ({ signedMessage: i.message, signature: key.sign(i.message) })) },
    },
  };
}

describe('real mode against a chain', () => {
  const chain = fakeChain();
  const player = freshKeypair();
  const owner = freshKeypair().address;
  const loot = (address, type, value) => chain.put(address, LOOT_IDL.address, encodeAccount(LOOT_IDL, type, value));
  const fees = { player: 2_000_000n, project: 10_000n };
  loot(game, 'Game', { owner, authority: owner, collection, mint: 'So11111111111111111111111111111111111111112', treasury: owner, bump: 255, fees_bump: 255, paused: false, suspended: false, official: null });
  loot(lootPda.platform(), 'Platform', { admin: owner, partner: owner, fees, pending: fees, pending_at: 0n, bump: 255 });
  loot(lootPda.item(game, 1), 'Item', { game, item_id: 1, kind: 'Collectible', rarity: 2, soulbound: false, burnable: false, max_supply: 0, issued: 0, voided: 0, price: 50_000_000n, active: true, bump: 255, rise: null, fall: null, life: null, shares: [], name: 'Golden Hat', uri: 'https://x' });
  const str = (s) => concat(uintLE(utf8(s).length, 4), utf8(s));
  const asset = (owner, itemId) => {
    const head = concat(Uint8Array.of(1), addressBytes(owner), Uint8Array.of(2), addressBytes(collection), str('Golden Hat #1'), str('https://x'), Uint8Array.of(0));
    const pluginAt = head.length + 9;
    const plugin = concat(Uint8Array.of(6), uintLE(2, 4), str('item_id'), str(String(itemId)), str('serial'), str('1'));
    const registryAt = pluginAt + plugin.length;
    const registry = concat(Uint8Array.of(4), uintLE(1, 4), Uint8Array.of(6, 2), uintLE(pluginAt, 8), uintLE(0, 4));
    return concat(head, Uint8Array.of(3), uintLE(registryAt, 8), plugin, registry);
  };

  it('buys with two approvals: buy_item with SOL wrapped around it, then the claim that mints the collectible', async () => {
    const kit = createGfWeb3({ config: CONFIG, location: at('?gamesfun_mock=0'), fetchImpl: chain.fetchImpl, wallets: [standardWallet(player)] });
    assert.equal(kit.mock, false);
    const result = await kit.shop.buy(1);
    assert.equal(result.signatures.length, 2);
    assert.deepEqual(chain.sent.slice(-2), result.signatures);
    const programsOf = (m) => m.instructions.map((ix) => m.keys[ix.programIndex]);
    const [buy, settle] = chain.simulated.slice(-2);
    assert.deepEqual(programsOf(buy), [
      'ComputeBudget111111111111111111111111111111',
      'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
      '11111111111111111111111111111111',
      'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
      LOOT_IDL.address,
      'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
    ]);
    assert.deepEqual(programsOf(settle), ['ComputeBudget111111111111111111111111111111', LOOT_IDL.address]);
    // The collectible's address is the one settle minted at: the order and the slot it was paid in.
    assert.equal(result.asset, lootPda.asset(result.order, 1000n));
    assert.equal(chain.accounts.has(result.order), false, 'the order ended');
    assert.deepEqual(await kit.orders(), []);
    // An order the player left open (a claim they declined) is listed, and finish() claims it.
    const nonce = 77n;
    const left = lootPda.order(game, player.address, nonce);
    loot(left, 'Order', { game, player: player.address, nonce, mint: 'So11111111111111111111111111111111111111112', loot_box: '11111111111111111111111111111111', box_version: 0, status: 'Rolled', outcome: { Item: [1] }, serial: 9, paid: 50_000_000n, fee: 2_000_000n, shares: [], requested_slot: 1000n, bump: 255 });
    const open = await kit.orders();
    assert.deepEqual(open.map((o) => [o.order, o.status, o.serial]), [[left, 'Rolled', 9]]);
    const done = await kit.finish(left);
    assert.equal(done.settled, true);
    assert.equal(done.item.asset, lootPda.asset(left, 1000n));
    assert.deepEqual(await kit.orders(), []);
  });

  it('opens a box: pay and roll, then claim what it rolled; a failed roll is refunded', async () => {
    loot(lootPda.box(game, 1), 'LootBox', { game, box_id: 1, price: 10_000_000n, currency: null, rise: null, fall: null, stock_odds: false, active: true, opened: 0n, version: 0, bump: 255, shares: [], entries: [{ outcome: { Item: [1] }, weight: 60 }] });
    const kit = createGfWeb3({ config: CONFIG, location: at('?gamesfun_mock=0'), fetchImpl: chain.fetchImpl, wallets: [standardWallet(player)], rollPollMs: 1 });
    const won = await kit.openBox(1);
    assert.equal(won.item.name, 'Golden Hat');
    assert.equal(won.signatures.length, 2);
    const programsOf = (m) => m.instructions.map((ix) => m.keys[ix.programIndex]);
    assert.ok(programsOf(chain.simulated.at(-1)).includes(LOOT_IDL.address));
    chain.rolls.push('Failed');
    await assert.rejects(kit.openBox(1), /refunded/);
    const refund = chain.simulated.at(-1);
    // refund, then the wrapped SOL it returned is closed back to plain SOL
    assert.deepEqual(programsOf(refund), [LOOT_IDL.address, 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA']);
  });

  it('reads the player’s items from the collection on chain', async () => {
    chain.put('9cSkizhDe5YBANCPhNYq41nnXW9M1ASLNJZB7tfYwVBi', MPL_CORE_PROGRAM, asset(player.address, 1));
    chain.put('GCYGW412CqUAmM3W6VhaFvi8T1TovPPmYSSLc3hLZ5gL', MPL_CORE_PROGRAM, asset(freshKeypair().address, 2));
    const kit = createGfWeb3({ config: CONFIG, location: at('?gamesfun_mock=0'), fetchImpl: chain.fetchImpl, wallets: [standardWallet(player)] });
    await kit.connect();
    const owned = await kit.ownedItems();
    assert.deepEqual(owned.map((o) => [o.id, o.asset, o.serial]), [[1, '9cSkizhDe5YBANCPhNYq41nnXW9M1ASLNJZB7tfYwVBi', 1]]);
    assert.equal(await kit.owns('Golden Hat'), true);
    assert.equal(await kit.owns(2), false);
  });

  it('signs in with the wallet’s real signature', async () => {
    const kit = createGfWeb3({ config: CONFIG, location: at('?gamesfun_mock=0'), fetchImpl: chain.fetchImpl, wallets: [standardWallet(player)] });
    const signed = await kit.signIn();
    assert.equal(signed.mock, false);
    const { verifySignature } = await import('../builder/web3/node/ed25519.mjs');
    const { decodeBase58 } = await import('../builder/web3/gf-web3/chain/base58.js');
    assert.equal(verifySignature(player.address, utf8(signed.message), decodeBase58(signed.signature)), true);
  });

  it('says plainly when the shop is not live yet', async () => {
    const draft = { ...CONFIG, shop: { ...CONFIG.shop, collection: undefined, game: undefined } };
    const kit = createGfWeb3({ config: draft, location: at('?gamesfun_mock=0'), fetchImpl: chain.fetchImpl, wallets: [standardWallet(player)] });
    await assert.rejects(kit.shop.buy(1), /not on sale yet/);
    assert.deepEqual(readMessage, readMessage);
  });
});
