// gf-web3's economy: playerActions and economyState from the spec alone, every action in mock mode with no network,
// and each call against the fake chain, read back from the transactions it sent: the loot instruction, its
// arguments, its named accounts and what follows them (split targets, a box's entries, a recipe's lines, the Memo
// program of a Token-2022 coin), with a Wallet Standard wallet object that signs like a browser wallet. Fixtures:
// coin-flip-arena, blind-forge (Token-2022), sacrifice-raffle, stud-farm and duel-arena.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { addressBytes } from '../builder/web3/gf-web3/chain/base58.js';
import { decodeBorsh, encodeAccount } from '../builder/web3/gf-web3/chain/borsh.js';
import { concat, uintLE, utf8 } from '../builder/web3/gf-web3/chain/bytes.js';
import { MPL_CORE_PROGRAM } from '../builder/web3/gf-web3/chain/core.js';
import { ata, contestTerms, LOOT_IDL, LOOT_PROGRAM, lootPda, NO_ADDRESS } from '../builder/web3/gf-web3/chain/loot.js';
import { NATIVE_MINT, TOKEN_2022_PROGRAM, TOKEN_PROGRAM } from '../builder/web3/gf-web3/chain/pda.js';
import { MEMO_PROGRAM } from '../builder/web3/gf-web3/chain/token2022.js';
import { readMessage, readTransaction, withSignature } from '../builder/web3/gf-web3/chain/tx.js';
import { readEconomy } from '../builder/web3/gf-web3/econ/spec.js';
import { createGfWeb3 } from '../builder/web3/gf-web3/index.js';
import { economyState, parseActionId, playerActions } from '../builder/web3/economy/actions.mjs';
import { migrateShop } from '../builder/web3/economy/migrate.mjs';
import { economyFromShop, migrateShop as migrateShopInKit } from '../builder/web3/gf-web3/econ/shop.js';
import { freshKeypair } from '../builder/web3/node/ed25519.mjs';
import { fakeChain } from './web3/fake-chain.mjs';

const fixture = (name) => JSON.parse(readFileSync(new URL(`../builder/web3/economy/fixtures/${name}.json`, import.meta.url), 'utf8'));
const FIXTURES = ['coin-flip-arena', 'blind-forge', 'sacrifice-raffle', 'stud-farm', 'duel-arena', 'falling-drop', 'spark-pity', 'starforce', 'halving-seasons', 'merge-2048', 'scorched-treasury'];
const at = (search) => ({ search, href: `http://127.0.0.1:5200/${search}`, host: '127.0.0.1:5200', origin: 'http://127.0.0.1:5200', pathname: '/' });
const noFetch = () => {
  throw new Error('the mock must not touch the network');
};
const fees = { player: 2_000_000n, project: 10_000n };

// ---------------------------------------------------------------- a chain with an economy on it

const mintData = (decimals) => {
  const d = new Uint8Array(82);
  d[44] = decimals;
  d[45] = 1;
  return d;
};
const tokenData = (mint, owner, amount) => {
  const d = new Uint8Array(165);
  d.set(addressBytes(mint), 0);
  d.set(addressBytes(owner), 32);
  d.set(uintLE(amount, 8), 64);
  d[108] = 1;
  return d;
};
const str = (s) => concat(uintLE(utf8(s).length, 4), utf8(s));
/** A Core asset of `collection` owned by `owner`, with these attributes. */
function coreAsset(owner, collection, name, attributes) {
  const head = concat(Uint8Array.of(1), addressBytes(owner), Uint8Array.of(2), addressBytes(collection), str(name), str('https://x'), Uint8Array.of(0));
  const pluginAt = head.length + 9;
  const entries = Object.entries(attributes);
  const plugin = concat(Uint8Array.of(6), uintLE(entries.length, 4), ...entries.flatMap(([k, v]) => [str(k), str(String(v))]));
  const registryAt = pluginAt + plugin.length;
  const registry = concat(Uint8Array.of(4), uintLE(1, 4), Uint8Array.of(6, 2), uintLE(pluginAt, 8), uintLE(0, 4));
  return concat(head, Uint8Array.of(3), uintLE(registryAt, 8), plugin, registry);
}

/** A fixture put live on the fake chain: mints, the game, its pools (seeded), and a player with a wallet. */
function world(name, { chain = fakeChain() } = {}) {
  const spec = structuredClone(fixture(name));
  const owner = freshKeypair().address;
  const collection = freshKeypair().address;
  const game = lootPda.game(collection);
  const programOf = {};
  for (const t of spec.tokens) {
    if (t.source === 'sol') continue;
    t.mint ??= freshKeypair().address;
    programOf[t.key] = t.program === 'token-2022' ? TOKEN_2022_PROGRAM : TOKEN_PROGRAM;
    chain.put(t.mint, programOf[t.key], mintData(t.decimals ?? (t.source === 'game' ? 0 : 6)));
  }
  const e0 = readEconomy(spec);
  const mintOf = (key) => e0.token(key).mint ?? spec.tokens.find((t) => t.key === key).mint;
  const programFor = (key) => programOf[key] ?? TOKEN_PROGRAM;
  const currency = mintOf(spec.currency);
  const treasury = ata(owner, currency, programFor(spec.currency));
  spec.live = { game, collection, treasury };
  const loot = (address, type, value) => chain.put(address, LOOT_PROGRAM, encodeAccount(LOOT_IDL, type, value));
  loot(game, 'Game', { owner, authority: owner, collection, mint: currency, treasury, bump: 255, fees_bump: 255, paused: false, suspended: false, official: null });
  loot(lootPda.platform(), 'Platform', { admin: owner, partner: owner, fees, pending: fees, pending_at: 0n, bump: 255 });
  const e = readEconomy(spec);
  for (const p of e.pools) {
    const t = e.token(p.currency);
    chain.put(lootPda.pool(game, p.index), programFor(p.currency), tokenData(mintOf(p.currency), game, p.seed ? BigInt(Math.round(Number(p.seed) * 10 ** t.decimals)) : 0n));
  }
  const player = freshKeypair();
  const kit = createGfWeb3({ config: { version: 1, network: 'devnet', economy: spec }, location: at('?gamesfun_mock=0'), fetchImpl: chain.fetchImpl, wallets: [standardWallet(player)], rollPollMs: 1, now: () => chain.now });
  const give = (key, amount, to = player.address) => chain.put(ata(to, mintOf(key), programFor(key)), programFor(key), tokenData(mintOf(key), to, amount));
  return { chain, spec, e, owner, collection, game, treasury, player, kit, loot, mintOf, programFor, give };
}

/** A Wallet Standard wallet object backed by a test key. */
function standardWallet(key) {
  const account = { address: key.address, publicKey: addressBytes(key.address), chains: ['solana:devnet'], features: [] };
  return {
    version: '1.0.0', name: 'Test Wallet', icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"/>', chains: ['solana:devnet'], accounts: [account],
    features: {
      'standard:connect': { version: '1.0.0', connect: async () => ({ accounts: [account] }) },
      'solana:signTransaction': {
        version: '1.0.0', supportedTransactionVersions: ['legacy', 0],
        signTransaction: async (...inputs) => inputs.map((i) => ({ signedTransaction: withSignature(i.transaction, key.address, key.sign(readTransaction(i.transaction).message)) })),
      },
    },
  };
}

/** The loot instructions of a sent message: [{ name, args, accounts: { idlName: address }, remaining: [{ pubkey, isSigner, isWritable }] }]. */
function lootCalls(m) {
  return m.instructions.filter((ix) => m.keys[ix.programIndex] === LOOT_PROGRAM).map((ix) => {
    const def = LOOT_IDL.instructions.find((i) => i.discriminator.every((b, j) => ix.data[j] === b));
    let offset = 8;
    const args = {};
    for (const a of def.args) [args[a.name], offset] = decodeBorsh(LOOT_IDL, a.type, ix.data, offset);
    const names = [];
    const walk = (list) => list.forEach((a) => (a.accounts ? walk(a.accounts) : names.push(a.name)));
    walk(def.accounts);
    const keys = ix.accountIndexes.map((i) => m.keys[i]);
    return { name: def.name, args, accounts: Object.fromEntries(names.map((n, i) => [n, keys[i]])), remaining: keys.slice(names.length) };
  });
}
const programs = (m) => m.instructions.map((ix) => m.keys[ix.programIndex]);
const signers = (m) => m.keys.slice(0, m.header.numRequiredSignatures);
const lastSent = (chain, n = 1) => chain.simulated.slice(-n);

// ---------------------------------------------------------------- the spec alone

describe('playerActions and economyState', () => {
  it('lists every fixture’s buttons with an id gf-web3 can perform, a label, words, a place and a price', () => {
    for (const name of FIXTURES) {
      const actions = playerActions(fixture(name));
      assert.ok(actions.length > 0, name);
      for (const a of actions) {
        assert.ok(['buy', 'openBox', 'pay', 'craft', 'buyTickets', 'stake', 'unstake', 'hold', 'enter', 'claim'].includes(a.kind), `${name}: ${a.kind}`);
        assert.ok(['menu', 'pause', 'results', 'hud'].includes(a.where));
        assert.equal(a.where, a.kind === 'claim' ? 'results' : 'menu');
        assert.ok(a.label && a.says && !/undefined|NaN/.test(`${a.label} ${a.says}`), `${name}: ${a.id} ${a.says}`);
        const { kind, key } = parseActionId(a.id);
        assert.equal(`${kind}:${key}`, a.part);
        if (a.price) assert.match(a.price.amount, /^\d+(\.\d+)?$/);
      }
    }
    const flip = playerActions(fixture('coin-flip-arena'));
    assert.deepEqual(flip.map((a) => a.id), ['box:flip:open', 'lottery:weekly:tickets', 'lottery:weekly:claim', 'stake:backers:stake', 'stake:backers:unstake', 'stake:backers:claim']);
    assert.deepEqual(flip[0].price, { amount: '0.1', currency: 'SOL' });
    assert.equal(flip[0].says, '50% win 0.176 SOL, 50% nothing.', 'the price is in `price`; says never repeats it');
    assert.deepEqual(flip[1].asks, { count: { default: 1, min: 1, says: 'How many tickets?' } });
    const duel = playerActions(fixture('duel-arena')).filter((a) => a.kind === 'enter');
    assert.deepEqual(duel.map((a) => [a.id, a.label]), [['contest:duel:enter:0', 'Back Red'], ['contest:duel:enter:1', 'Back Blue']]);
  });

  it('turns reads into the state the page sends the game, with what the player can claim', () => {
    const spec = fixture('coin-flip-arena');
    const me = 'Me1111111111111111111111111111111111111111';
    const s = economyState(spec, {
      now: 1000,
      balances: { sol: '2500000000', arena: '5000000' },
      pools: { house: '5000000000', pot: '30000000' },
      lotteries: { weekly: { pot: '30000000', status: 'Drawn', drawsAt: 900, sold: 3, mine: 2, winners: ['Other', me], paid: 1 } },
      stakes: { backers: { staked: '5000000', pending: '1500000', since: 500, lock: 86400 } },
    }, me);
    assert.deepEqual(s.balances, { sol: { amount: '2.5 SOL', symbol: 'SOL' }, arena: { amount: '5 ARENA', symbol: 'ARENA' } });
    assert.equal(s.pools.house.amount, '5 SOL');
    assert.deepEqual(s.tickets.weekly, { mine: 2, sold: 3, pot: '0.03 SOL', status: 'drawn', drawsAt: 900, nextDraw: 'drawing' });
    assert.deepEqual(s.stakes.backers, { staked: '5 ARENA', pending: '0.0015 SOL', locked: true, unlocksAt: 86900 });
    assert.deepEqual(s.claimable.map((c) => c.id), ['lottery:weekly:claim', 'stake:backers:claim']);
    assert.match(s.claimable[0].says, /You won place 2/);
  });
});

describe('a game that still has a shop', () => {
  const collection = 'BT3Po8rB7Deq7HxWkFNbXQmc3mnBPfij7M89UEfuKGLx';
  const shop = {
    name: 'Bean Brawl Items', royaltyBps: 500, collection, game: lootPda.game(collection), treasury: collection,
    currency: { mint: NATIVE_MINT, symbol: 'SOL', decimals: 9, native: true },
    items: [{ id: 1, name: 'Golden Hat', rarity: 'Rare', price: '50000000', maxSupply: 0, soulbound: false, listed: true }, { id: 2, name: 'Ice Skin', rarity: 'Epic', price: '0', maxSupply: 0, soulbound: false, listed: true }],
    boxes: [{ id: 1, name: 'Mystery Box', price: '10000000', entries: [{ item: 1, weight: 60 }, { item: 2, weight: 40 }], listed: true }],
  };
  it('reads through the one migration: live where gf-web3 2.0.0 put it live on 0.3, previous for 0.1/0.2', () => {
    const config = { version: 1, network: 'devnet', shop };
    assert.equal(migrateShop, migrateShopInKit, 'migrate.mjs re-exports the in-game kit’s function: one migration, no copy');
    const { live, ...mine } = economyFromShop(config);
    const { previous, ...theirs } = migrateShop(config).config.economy;
    assert.deepEqual(mine, theirs, 'the page and the file migration make the same parts');
    assert.deepEqual(live, { game: shop.game, collection, treasury: collection });
    assert.equal(previous.game, shop.game, 'the file migration keeps it as previous; the kit plays it where it is');
    assert.deepEqual(migrateShop(config, { keepLive: true }).config.economy.live, live, 'keepLive is the page’s reading');
    const old = economyFromShop({ version: 1, network: 'devnet', shop: { ...shop, game: 'FWVap91111111111111111111111111111111111111' } });
    assert.equal(old.live, undefined, 'a 0.1/0.2 shop is not live on 0.3');
    assert.equal(old.previous.game, 'FWVap91111111111111111111111111111111111111');
    assert.equal(economyFromShop({ version: 1, network: 'devnet', shop, economy: { name: 'x' } }), null, 'an economy wins');
    assert.equal(economyFromShop({ version: 1, network: 'devnet' }), null, 'no shop, nothing');
  });
  it('keeps a Token-2022 shop currency on token-2022', () => {
    const mint = '7MJWx2uYB3D7VrUKZ7xQ5n3qeaJ2uGmCcAm1L8ZnXrfX';
    const t22 = { ...shop, currency: { mint, symbol: 'FEE', decimals: 6, native: false, program: 'token-2022' } };
    const e = economyFromShop({ version: 1, network: 'devnet', shop: t22 });
    assert.deepEqual(e.tokens, [{ key: 'fee', source: 'existing', mint, symbol: 'FEE', decimals: 6, program: 'token-2022' }]);
    assert.equal(e.items[0].price, '50', 'prices in the coin’s own decimals');
    const classic = economyFromShop({ version: 1, network: 'devnet', shop: { ...t22, currency: { ...t22.currency, program: undefined } } });
    assert.equal(classic.tokens[0].program, 'spl-token');
  });
});

describe('mock mode', () => {
  it('performs every action of every fixture from its id alone, with no network', async () => {
    for (const name of FIXTURES) {
      const spec = fixture(name);
      const kit = createGfWeb3({ config: { version: 1, network: 'devnet', economy: spec }, location: at('?gamesfun_mock=1'), fetchImpl: noFetch });
      for (const a of await kit.economy.actions()) {
        const out = await kit.economy.act(a.id);
        assert.equal(out.mock, true, `${name} ${a.id}`);
        assert.ok(out.says, `${name} ${a.id}`);
      }
      const state = await kit.economy.state();
      assert.equal(state.player, kit.address);
    }
  });
});

// ---------------------------------------------------------------- against the chain

describe('coin-flip-arena: a box that pays from a pool, a lottery with three places, a stake', () => {
  const w = world('coin-flip-arena');
  const { chain, game, player, kit, loot, mintOf } = w;
  const house = lootPda.pool(game, 0);
  const pot = lootPda.pool(game, 2);
  const flip = { game, box_id: 1, price: 100_000_000n, currency: null, rise: null, fall: null, stock_odds: false, active: true, opened: 0n, version: 0, bump: 255, shares: [{ to: { Pool: [0] }, bps: 8800 }, { to: { Pool: [2] }, bps: 1000 }, { to: { Pool: [1] }, bps: 200 }], entries: [{ outcome: { Pay: { pool: 0, amount: 176_000_000n } }, weight: 1 }, { outcome: 'Nothing', weight: 1 }] };
  loot(lootPda.box(game, 1), 'LootBox', flip);

  it('openBox: open_box with the prize pool after the box, then settle_prize paying the player’s SOL account, unwrapped', async () => {
    await kit.connect();
    const out = await kit.economy.openBox('flip');
    assert.equal(out.outcome.kind, 'prize');
    assert.equal(out.outcome.amount, '0.176 SOL');
    assert.equal(out.says, 'You won 0.176 SOL!');
    const [open, settle] = lastSent(chain, 2);
    const [o] = lootCalls(open);
    assert.equal(o.name, 'open_box');
    assert.equal(o.args.box_id, 1);
    assert.equal(o.args.max_price, 100_000_000n);
    assert.equal(o.accounts.mint, NATIVE_MINT);
    assert.deepEqual(o.remaining, [house]);
    const [s] = lootCalls(settle);
    assert.equal(s.name, 'settle_prize');
    assert.equal(s.accounts.prize_pool, house);
    assert.equal(s.accounts.prize_to, ata(player.address, NATIVE_MINT));
    assert.deepEqual(s.remaining, [house, pot, lootPda.pool(game, 1)], 'the box’s split targets');
    assert.equal(programs(settle).at(-1), TOKEN_PROGRAM, 'the wrapped prize is unwrapped to plain SOL');
  });

  it('refuses a price above the spec’s in plain words, and a short wallet with how much more it needs', async () => {
    loot(lootPda.box(game, 1), 'LootBox', { ...flip, price: 150_000_000n });
    await assert.rejects(kit.economy.openBox('flip'), /The price of Coin flip is now 0\.15 SOL \(you agreed to at most 0\.1 SOL\)/);
    loot(lootPda.box(game, 1), 'LootBox', flip);
    chain.balances.set(player.address, 50_000_000);
    await assert.rejects(kit.economy.openBox('flip'), /^Error: You need 0\.058 SOL more\.$/);
    chain.balances.delete(player.address);
  });

  it('buyTickets: buy_tickets for the count, at most the spec’s price, into the pot, with SOL wrapped around it', async () => {
    loot(lootPda.lottery(game, 1), 'Lottery', { game, id: 1, bump: 255, price: 10_000_000n, pot: 2, cut_bps: 0, places: [5000, 3000, 2000, 0, 0, 0, 0, 0], ticket_mint: NO_ADDRESS, every: 604800n, draws_at: BigInt(chain.now + 3600), round: 0, status: 'Open', sold: 0n, asked_slot: 0n, winner: NO_ADDRESS, first_ticket: 0n, paid: 0, pot_at_payout: 0n });
    const out = await kit.economy.buyTickets('weekly', { count: 3 });
    assert.equal(out.says, 'You have 3 tickets in “Weekly draw”; the draw is in 60 minutes.');
    const [m] = lastSent(chain);
    const [t] = lootCalls(m);
    assert.equal(t.name, 'buy_tickets');
    assert.deepEqual([t.args.count, t.args.max_price], [3n, 10_000_000n]);
    assert.deepEqual([t.accounts.pot, t.accounts.mint, t.accounts.treasury], [pot, NATIVE_MINT, w.treasury]);
    assert.deepEqual(programs(m).slice(0, 3), ['ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL', '11111111111111111111111111111111', TOKEN_PROGRAM]);
    assert.equal((await kit.economy.lottery('weekly')).mine, 3);
  });

  it('claim on a lottery: refuses before the draw is due, then draws and pays each place', async () => {
    await assert.rejects(kit.economy.claim('lottery:weekly'), /The next draw of “Weekly draw” is in 60 minutes\./);
    chain.now += 3700;
    const out = await kit.economy.act('lottery:weekly:claim');
    const [draw, pay] = lastSent(chain, 2);
    assert.equal(lootCalls(draw)[0].name, 'draw_lottery');
    const pays = lootCalls(pay);
    assert.deepEqual(pays.map((p) => p.args.place), [0, 1, 2]);
    for (const p of pays) assert.equal(p.accounts.to, ata(player.address, NATIVE_MINT));
    assert.match(out.says, /You won place 1 and 2 and 3/);
  });

  it('stake and unstake: the stake’s accounts, rewards to the player’s account, the lock in plain words, collect with unstake(0)', async () => {
    const arena = mintOf('arena');
    loot(lootPda.stake(game, 1), 'Stake', { game, id: 1, bump: 255, mint: arena, rewards_pool: 1, rewards_mint: NATIVE_MINT, lock: 86400n, total: 0n, reward_per_token: 0n });
    await assert.rejects(kit.economy.stake('backers'), /You need 5 ARENA more|You have no ARENA to stake/);
    w.give('arena', 5_000_000n);
    const out = await kit.economy.act('stake:backers:stake');
    assert.equal(out.says, 'Staked 5 ARENA in “Back the house”.');
    const [m] = lastSent(chain);
    const [s] = lootCalls(m);
    assert.equal(s.name, 'stake');
    assert.equal(s.args.amount, 5_000_000n);
    assert.deepEqual([s.accounts.mint, s.accounts.rewards_mint, s.accounts.rewards_pool, s.accounts.player_rewards], [arena, NATIVE_MINT, lootPda.pool(game, 1), ata(player.address, NATIVE_MINT)]);
    assert.equal(programs(m)[0], 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL', 'the rewards account is opened first');
    await assert.rejects(kit.economy.unstake('backers'), /Your stake in “Back the house” is locked until .* \(in 24 hours\)/);
    await kit.economy.claim('stake:backers');
    const [c] = lootCalls(lastSent(chain)[0]);
    assert.deepEqual([c.name, c.args.amount], ['unstake', 0n]);
    chain.now += 86_401;
    await kit.economy.unstake('backers');
    assert.equal(lootCalls(lastSent(chain)[0])[0].args.amount, 5_000_000n);
  });
});

describe('blind-forge: a box of items priced in a Token-2022 coin, a lottery with a cut', () => {
  const w = world('blind-forge');
  const { chain, game, player, kit, loot, mintOf } = w;
  const forge = mintOf('forge');
  const items = [1, 2, 3, 4, 5];
  for (const id of items) loot(lootPda.item(game, id), 'Item', { game, item_id: id, kind: 'Collectible', rarity: id - 1, soulbound: false, burnable: false, max_supply: [0, 0, 500, 100, 1][id - 1], issued: 0, voided: 0, price: 0n, active: true, bump: 255, rise: null, fall: null, life: null, shares: [], name: `Blade ${id}`, uri: 'https://x' });
  loot(lootPda.box(game, 1), 'LootBox', { game, box_id: 1, price: 10_000_000n, currency: null, rise: { step: 0n, growth_bps: 50 }, fall: null, stock_odds: true, active: true, opened: 0n, version: 0, bump: 255, shares: [{ to: { Pool: [0] }, bps: 500 }], entries: items.map((id, i) => ({ outcome: { Item: [id] }, weight: [60, 25, 10, 4, 1][i] })) });

  it('openBox: the Token-2022 accounts, each item after the box, then the Memo program; claim passes it too', async () => {
    await kit.connect();
    w.give('forge', 100_000_000n);
    const out = await kit.economy.openBox('forge-box');
    assert.equal(out.outcome.kind, 'item');
    assert.equal(out.outcome.item, 'common-blade');
    const [open, settle] = lastSent(chain, 2);
    const [o] = lootCalls(open);
    assert.equal(o.accounts.player_token, ata(player.address, forge, TOKEN_2022_PROGRAM));
    assert.equal(o.accounts.vault, ata(game, forge, TOKEN_2022_PROGRAM));
    assert.deepEqual(o.remaining, [...items.map((id) => lootPda.item(game, id)), MEMO_PROGRAM]);
    const [s] = lootCalls(settle);
    assert.equal(s.name, 'settle');
    assert.deepEqual(s.remaining, [lootPda.pool(game, 0), MEMO_PROGRAM]);
  });

  it('odds as the program rolls them: a sold-out mythic counts for nothing', async () => {
    loot(lootPda.item(game, 5), 'Item', { game, item_id: 5, kind: 'Collectible', rarity: 4, soulbound: false, burnable: false, max_supply: 1, issued: 1, voided: 0, price: 0n, active: true, bump: 255, rise: null, fall: null, life: null, shares: [], name: 'Blade 5', uri: 'https://x' });
    const odds = await kit.economy.boxOdds('forge-box');
    assert.deepEqual(odds.map((x) => x.available), [true, true, true, true, false]);
    assert.equal(odds[4].chance, 0);
    assert.ok(Math.abs(odds[0].chance - 60 / 99) < 1e-9);
  });

  it('buyTickets in the Token-2022 coin: the cut to the treasury, the Memo program after', async () => {
    loot(lootPda.lottery(game, 1), 'Lottery', { game, id: 1, bump: 255, price: 1_000_000n, pot: 0, cut_bps: 500, places: [7000, 3000, 0, 0, 0, 0, 0, 0], ticket_mint: NO_ADDRESS, every: 604800n, draws_at: BigInt(chain.now + 86400 * 3), round: 0, status: 'Open', sold: 0n, asked_slot: 0n, winner: NO_ADDRESS, first_ticket: 0n, paid: 0, pot_at_payout: 0n });
    await kit.economy.buyTickets('buyers-draw', { count: 2 });
    const [t] = lootCalls(lastSent(chain)[0]);
    assert.deepEqual([t.accounts.mint, t.accounts.player_token, t.remaining], [forge, ata(player.address, forge, TOKEN_2022_PROGRAM), [MEMO_PROGRAM]]);
  });

  it('a closed round, in plain words', async () => {
    const l = { game, id: 1, bump: 255, price: 1_000_000n, pot: 0, cut_bps: 500, places: [7000, 3000, 0, 0, 0, 0, 0, 0], ticket_mint: NO_ADDRESS, every: 604800n, draws_at: BigInt(chain.now - 10), round: 0, status: 'Open', sold: 0n, asked_slot: 0n, winner: NO_ADDRESS, first_ticket: 0n, paid: 0, pot_at_payout: 0n };
    loot(lootPda.lottery(game, 1), 'Lottery', l);
    await assert.rejects(kit.economy.buyTickets('buyers-draw'), /This round of “Buyers' draw” closed; the draw is due now/);
    loot(lootPda.lottery(game, 1), 'Lottery', { ...l, status: 'Drawing' });
    await assert.rejects(kit.economy.buyTickets('buyers-draw'), /The draw of “Buyers' draw” is under way/);
  });
});

describe('sacrifice-raffle: buy an item, burn it for minted tickets, burn tickets in a lottery', () => {
  const w = world('sacrifice-raffle');
  const { chain, game, collection, player, kit, loot, mintOf } = w;
  const ticket = mintOf('ticket');
  loot(lootPda.item(game, 1), 'Item', { game, item_id: 1, kind: 'Collectible', rarity: 0, soulbound: false, burnable: false, max_supply: 0, issued: 0, voided: 0, price: 10_000_000n, active: true, bump: 255, rise: null, fall: null, life: null, shares: [{ to: { Pool: [0] }, bps: 1000 }], name: 'Rusty Sword', uri: 'https://x' });
  loot(lootPda.recipe(game, 1), 'Recipe', { game, id: 1, bump: 255, active: true, version: 3, inputs: [{ Burn: { item: 1, count: 1 } }], outputs: [{ Tokens: { mint: ticket, amount: 1n, from: 'Issue' } }], needs: [], keeps: [] });

  it('buy: buy_item at the spec’s price, then settle with the split’s pool', async () => {
    await kit.connect();
    const out = await kit.economy.act('item:junk-sword:buy');
    assert.equal(out.says, 'Rusty Sword is yours.');
    const [buy, settle] = lastSent(chain, 2);
    const [b] = lootCalls(buy);
    assert.deepEqual([b.name, b.args.item_id, b.args.max_price], ['buy_item', 1, 10_000_000n]);
    const [s] = lootCalls(settle);
    assert.deepEqual([s.name, s.remaining], ['settle', [lootPda.pool(game, 0)]]);
  });

  it('craft: the item, the sword handed in, then the ticket mint and the player’s ticket account (opened first)', async () => {
    await assert.rejects(kit.economy.craft('sacrifice-sword'), /You need a Rusty Sword\./);
    const sword = freshKeypair().address;
    chain.put(sword, MPL_CORE_PROGRAM, coreAsset(player.address, collection, 'Rusty Sword #1', { item_id: 1, serial: 1, made: chain.now - 10 }));
    const out = await kit.economy.act('recipe:sacrifice-sword:craft');
    assert.equal(out.says, 'Made: Sacrifice a sword.');
    const [m] = lastSent(chain);
    const [c] = lootCalls(m);
    assert.deepEqual([c.name, c.args.version, c.args.times], ['craft', 3, 1n]);
    assert.equal(c.accounts.collection, collection);
    assert.deepEqual(c.remaining, [lootPda.item(game, 1), sword, ticket, ata(player.address, ticket)]);
    assert.equal(programs(m)[1], 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
  });

  it('buyTickets with tickets that are burned: the ticket mint, no SOL wrapped', async () => {
    loot(lootPda.lottery(game, 1), 'Lottery', { game, id: 1, bump: 255, price: 1n, pot: 0, cut_bps: 0, places: [5000, 1000, 1000, 1000, 500, 500, 500, 500], ticket_mint: ticket, every: 604800n, draws_at: BigInt(chain.now + 86400 * 2), round: 0, status: 'Open', sold: 0n, asked_slot: 0n, winner: NO_ADDRESS, first_ticket: 0n, paid: 0, pot_at_payout: 0n });
    await assert.rejects(kit.economy.buyTickets('weekly', { count: 2 }), /You need 2 TICKET more\./);
    w.give('ticket', 5n);
    const out = await kit.economy.buyTickets('weekly', { count: 2 });
    assert.match(out.says, /the draw is in 2 days/);
    const [m] = lastSent(chain);
    const [t] = lootCalls(m);
    assert.deepEqual([t.accounts.mint, t.args.max_price], [ticket, 1n]);
    assert.deepEqual(programs(m), [LOOT_PROGRAM]);
  });
});

describe('stud-farm: a recipe that uses a mare, burns hay, pays the stud’s holder and burns a fee, and makes a foal', () => {
  const w = world('stud-farm');
  const { chain, game, collection, player, kit, loot, mintOf } = w;
  const usdc = mintOf('usdc');
  const stud = 'DEiGziPGmE1G9vQPHHLUrUzL9hr3jKiNbYsyLyBGEfJb';
  const studHolder = freshKeypair().address;
  const life = (uses, cooldown, lasts = 0, ready = 0) => ({ ready_after: ready, lasts, uses, cooldown });
  const item = (id, name, l) => loot(lootPda.item(game, id), 'Item', { game, item_id: id, kind: 'Collectible', rarity: 0, soulbound: false, burnable: false, max_supply: 0, issued: 0, voided: 0, price: 1n, active: true, bump: 255, rise: null, fall: null, life: l, shares: [], name, uri: 'https://x' });
  item(1, 'Mare', life(6, 2_592_000));
  item(3, 'Hay bale', life(0, 0, 259_200));
  item(4, 'Foal', life(0, 0, 0, 604_800));
  loot(lootPda.recipe(game, 1), 'Recipe', {
    game, id: 1, bump: 255, active: true, version: 0, needs: [{ place: 0, key: 'age', at_least: 2 }], keeps: [{ key: 'coat', from: 0, to: 0 }],
    inputs: [{ Use: { item: 1 } }, { Burn: { item: 3, count: 1 } }, { Pay: { mint: usdc, amount: 5_000_000n, to: { Holder: [stud] } } }, { Pay: { mint: usdc, amount: 1_000_000n, to: 'Burn' } }],
    outputs: [{ Item: [4] }],
  });
  chain.put(stud, MPL_CORE_PROGRAM, coreAsset(studHolder, collection, 'Stud #1', { item_id: 2, serial: 1 }));
  const mare = freshKeypair().address;
  const hay = freshKeypair().address;

  it('says why it cannot: a resting mare, rotten hay', async () => {
    await kit.connect();
    w.give('usdc', 100_000_000n);
    chain.put(mare, MPL_CORE_PROGRAM, coreAsset(player.address, collection, 'Mare #1', { item_id: 1, serial: 1, made: chain.now - 100, used: 1, used_at: chain.now - 86_400 }));
    await assert.rejects(kit.economy.craft('breed'), /Your Mare is resting: ready again in 29 days\./);
    chain.put(mare, MPL_CORE_PROGRAM, coreAsset(player.address, collection, 'Mare #1', { item_id: 1, serial: 1, made: chain.now - 100, age: 3, coat: 'bay' }));
    chain.put(hay, MPL_CORE_PROGRAM, coreAsset(player.address, collection, 'Hay bale #1', { item_id: 3, serial: 1, made: chain.now - 300_000 }));
    await assert.rejects(kit.economy.craft('breed'), /Your Hay bale has expired\./);
  });

  it('craft: every line’s accounts in order, the stud holder’s account, and a new key for the foal that signs', async () => {
    chain.put(hay, MPL_CORE_PROGRAM, coreAsset(player.address, collection, 'Hay bale #1', { item_id: 3, serial: 1, made: chain.now - 60 }));
    const out = await kit.economy.craft('breed');
    assert.equal(out.outcome.made.length, 1);
    const [m] = lastSent(chain);
    const [c] = lootCalls(m);
    const mine = ata(player.address, usdc);
    assert.deepEqual(c.remaining, [lootPda.item(game, 1), mare, lootPda.item(game, 3), hay, usdc, mine, stud, ata(studHolder, usdc), usdc, mine, lootPda.item(game, 4), out.outcome.made[0]]);
    assert.deepEqual(signers(m), [player.address, out.outcome.made[0]], 'the player pays, the foal’s new address signs');
    assert.ok(chain.sent.length > 0, 'the fake chain checked both signatures');
  });
});

describe('duel-arena: a contest, a hold', () => {
  const w = world('duel-arena');
  const { chain, game, collection, player, kit, loot, mintOf, owner } = w;
  const usdc = mintOf('usdc');
  const contest = lootPda.contest(game, 1);
  const args = { sides: 2, closes_at: BigInt(chain.now + 600), result_by: BigInt(chain.now + 3600), shares: [{ to: 'Burn', bps: 200 }] };
  const terms = contestTerms(usdc, args);

  it('enter: the side by name, the amount, the terms the contest has; closed entries in plain words', async () => {
    await kit.connect();
    await assert.rejects(kit.economy.enter('duel', { side: 'Blue', amount: '2' }), /There is no “Duel” open right now\./);
    loot(contest, 'Contest', { game, id: 1, bump: 255, opener: owner, mint: usdc, closes_at: args.closes_at, result_by: args.result_by, terms, verdict: 'Open', winner: 0, entries: 0, prize: 0n, unclaimed: 0n, shares: args.shares, sides: [0n, 0n] });
    w.give('usdc', 10_000_000n);
    const out = await kit.economy.enter('duel', { side: 'Blue', amount: '2' });
    assert.equal(out.says, 'You put 2 USDC on Blue.');
    const [e] = lootCalls(lastSent(chain)[0]);
    assert.deepEqual([e.name, e.args.side, e.args.amount], ['enter', 1, 2_000_000n]);
    assert.deepEqual(Array.from(e.args.terms), Array.from(terms));
    assert.equal(e.accounts.entry, lootPda.entry(contest, player.address, 1));
    assert.equal(e.accounts.pot, lootPda.pot(contest));
    await assert.rejects(kit.economy.claim('contest:duel'), /“Duel” has no result yet; it is due in 60 minutes\./);
    chain.now += 700;
    await assert.rejects(kit.economy.act('contest:duel:enter:0'), /Entries for “Duel” closed; the result is due in 48 minutes\./);
  });

  it('claim: once decided, each of the player’s entries is claimed to their own account', async () => {
    const c = { game, id: 1, bump: 255, opener: owner, mint: usdc, closes_at: args.closes_at, result_by: args.result_by, terms, verdict: 'Won', winner: 1, entries: 1, prize: 1_960_000n, unclaimed: 2_000_000n, shares: args.shares, sides: [0n, 2_000_000n] };
    loot(contest, 'Contest', c);
    const out = await kit.economy.act('contest:duel:claim');
    assert.match(out.says, /You won “Duel”/);
    const [m] = lastSent(chain);
    const [cl] = lootCalls(m);
    assert.deepEqual([cl.name, cl.accounts.entry, cl.accounts.to], ['claim', lootPda.entry(contest, player.address, 1), ata(player.address, usdc)]);
  });

  it('hold: the player’s ship for the spec’s six hours; brought home once the time is up', async () => {
    await assert.rejects(kit.economy.hold('mission'), /You have no Scout Ship to send\./);
    const ship = freshKeypair().address;
    chain.put(ship, MPL_CORE_PROGRAM, coreAsset(player.address, collection, 'Scout Ship #1', { item_id: 2, serial: 1 }));
    const out = await kit.economy.act('hold:mission:hold');
    assert.match(out.says, /Your Scout Ship is with the game; it comes home in 6 hours at the latest\./);
    const [h] = lootCalls(lastSent(chain)[0]);
    assert.deepEqual([h.name, h.args.seconds, h.accounts.asset, h.accounts.hold], ['hold', 21_600n, ship, lootPda.hold(ship)]);
    // the game holds it meanwhile
    chain.put(ship, MPL_CORE_PROGRAM, coreAsset(game, collection, 'Scout Ship #1', { item_id: 2, serial: 1 }));
    await assert.rejects(kit.economy.claim('hold:mission'), /Your Scout Ship comes home in 6 hours\./);
    chain.now += 21_601;
    await kit.economy.claim('hold:mission');
    const [t] = lootCalls(lastSent(chain)[0]);
    assert.deepEqual([t.name, t.accounts.asset, t.accounts.player], ['take_back', ship, player.address]);
  });

  it('the state the page sends: the contest and the hold', async () => {
    const state = await kit.economy.state();
    assert.equal(state.player, player.address);
    assert.equal(state.contests.duel.winner, 'Blue');
    assert.ok(state.balances.usdc);
  });
});
