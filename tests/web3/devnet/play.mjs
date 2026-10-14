// K2's devnet proof: two players play a small economy on the loot program 0.3 through gf-web3's economy calls only.
// The economy is set up here directly with chain/loot.js's builders (the creator's key as the game's owner, the
// keeper's as its authority), not through the publish flow. Then test-buyer-1 and test-buyer-2 each play through
// `gfWeb3.economy` with a Wallet Standard wallet object backed by their key (the same interface a browser wallet
// gives the page), the authority decides the contest and awards the hold, and every balance is checked against
// what the spec says should move.
//
//   the economy: SOL is the game's currency; GOLD (a classic coin made here, 6 decimals) is everything else
//   - item "relic" (0.001 SOL), item "blade" (recipe only)
//   - box "flip": 0.01 SOL, 90% into pool "house" (seeded 0.05 SOL); 50% win 0.015 SOL from "house", 50% nothing
//   - recipe "forge": burn a relic and pay 1 GOLD into pool "fees" → a blade
//   - lottery "draw": 1 GOLD a ticket into pool "pot", places 70% / 30%, drawn by MagicBlock's oracle on devnet
//   - stake "back": stake GOLD, earn what arrives in pool "rewards" (the creator deposits 8 GOLD)
//   - contest "duel": the authority opens it, players back Red or Blue in GOLD, 10% of the pot to "fees"
//   - hold "quest": a player hands a blade to the game for an hour; the authority awards it to the other player
//
// Devnet only (checked by genesis hash). Keys come from files named by environment variables, never printed:
//   GF_DEVNET_CREATOR_KEY GF_DEVNET_AUTHORITY_KEY GF_DEVNET_PLAYER_KEY GF_DEVNET_PLAYER2_KEY (keypair JSON paths)
//   node tests/web3/devnet/play.mjs
// The record (each step, its signatures and the balances it checked) goes to tests/web3/devnet/play-0.3.2-result.json (play-0.3.1-result.json: the run on 0.3.1, play-result.json: the run on 0.3, 2026-10-11).
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { addressBytes } from '../../../builder/web3/gf-web3/chain/base58.js';
import { concat, readUintLE, uintLE } from '../../../builder/web3/gf-web3/chain/bytes.js';
import { createCollectionInstruction, parseCoreAsset } from '../../../builder/web3/gf-web3/chain/core.js';
import {
  ata, awardIx, boxArgs, createGameIx, decideIx, decodeLoot, depositIx, itemArgs, LootAccount, lootEvents, lootPda, NO_ADDRESS, openContestIx,
  openPoolIx, openStakeIx, upsertBoxIx, upsertItemIx, upsertLotteryIx, upsertRecipeIx,
} from '../../../builder/web3/gf-web3/chain/loot.js';
import { NATIVE_MINT, SYSTEM_PROGRAM, TOKEN_PROGRAM } from '../../../builder/web3/gf-web3/chain/pda.js';
import { createAssociatedTokenAccountIdempotent, meta, syncNative, transferLamports } from '../../../builder/web3/gf-web3/chain/programs.js';
import { compileMessage, readTransaction, signersOf, wireTransaction } from '../../../builder/web3/gf-web3/chain/tx.js';
import { createGfWeb3 } from '../../../builder/web3/gf-web3/index.js';
import { explorerUrl, networkConfig } from '../../../builder/web3/gf-web3/network.js';
import { rpcClient } from '../../../builder/web3/gf-web3/rpc.js';
import { check } from '../../../builder/web3/economy/check.mjs';
import { freshKeypair, keypairFromSecret } from '../../../builder/web3/node/ed25519.mjs';

const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const GOLD = 1_000_000n;
const LOTTERY_WAIT = 240;
const here = path.dirname(fileURLToPath(import.meta.url));
const network = networkConfig('devnet');
const rpc = rpcClient(process.env.GF_DEVNET_RPC ?? network.rpcUrl);
const result = { network: 'devnet', program: network.loot.program, startedAt: new Date().toISOString(), steps: [], checks: {} };
const tx = (signature) => explorerUrl(network, 'tx', signature);
const json = (value) => JSON.parse(JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? v.toString() : v)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowSeconds = () => Math.floor(Date.now() / 1000);

/** Runs one step, records what it returned or how it failed, and carries on. */
async function step(name, run) {
  const at = new Date().toISOString();
  try {
    const out = (await run()) ?? {};
    result.steps.push(json({ name, at, ok: out.ok !== false, ...out }));
    console.log(`${out.ok === false ? '✗' : '✓'} ${name}`);
    return out;
  } catch (error) {
    result.steps.push({ name, at, ok: false, error: error.message, logs: error.logs?.slice(-12) ?? error.cause?.logs?.slice(-12) });
    console.log(`✗ ${name}: ${error.message}`);
    return null;
  }
}

async function key(variable) {
  const file = process.env[variable];
  if (!file) throw new Error(`Set ${variable} to the path of a devnet keypair file.`);
  return keypairFromSecret(Uint8Array.from(JSON.parse(await readFile(file, 'utf8'))));
}

/** A transaction signed by the test keys (the creator's and the authority's side: in the product their wallet signs). */
async function send(instructions, signers) {
  const { blockhash, lastValidBlockHeight } = await rpc.latestBlockhash();
  const message = compileMessage({ payer: signers[0].address, blockhash, instructions });
  const signatures = signersOf(message).map((a) => signers.find((s) => s.address === a).sign(message));
  const signature = await rpc.send(wireTransaction(message, signatures));
  await rpc.confirm(signature, { lastValidBlockHeight });
  return signature;
}

/** The receipts a landed transaction wrote. */
async function receipts(signature) {
  const t = await rpc.call('getTransaction', [signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 }]);
  return lootEvents(t?.meta?.logMessages ?? []).map((e) => json(e));
}

/** A Wallet Standard wallet object backed by a test key (what a browser wallet extension registers). */
function standardWallet(k) {
  const account = { address: k.address, publicKey: addressBytes(k.address), chains: ['solana:devnet'], features: [] };
  const sign = (wire) => {
    const { message, signers, signatures } = readTransaction(wire);
    return wireTransaction(message, signers.map((s, i) => (s === k.address ? k.sign(message) : signatures[i])));
  };
  return {
    version: '1.0.0', name: 'Proof Wallet', icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"/>', chains: ['solana:devnet'], accounts: [account],
    features: {
      'standard:connect': { version: '1.0.0', connect: async () => ({ accounts: [account] }) },
      'solana:signTransaction': { version: '1.0.0', supportedTransactionVersions: ['legacy', 0], signTransaction: async (...inputs) => inputs.map((i) => ({ signedTransaction: sign(i.transaction) })) },
    },
  };
}

const tokens = async (address) => {
  const [a] = await rpc.accounts([address]);
  return a ? readUintLE(a.data, 64, 8) : 0n;
};
const ownerOf = async (asset) => {
  const [a] = await rpc.accounts([asset]);
  return a ? parseCoreAsset(a.data).owner : null;
};

// ---------------------------------------------------------------- a classic coin made for the run

/** Create a 6-decimal classic SPL mint with `authority` as its mint authority. */
async function mintInstructions(payer, mint) {
  const rent = BigInt(await rpc.call('getMinimumBalanceForRentExemption', [82]));
  return [
    { programId: SYSTEM_PROGRAM, keys: [meta(payer, true, true), meta(mint, true, true)], data: concat(uintLE(0, 4), uintLE(rent, 8), uintLE(82, 8), addressBytes(TOKEN_PROGRAM)) },
    { programId: TOKEN_PROGRAM, keys: [meta(mint, false, true)], data: concat(Uint8Array.of(20, 6), addressBytes(payer), Uint8Array.of(0), new Uint8Array(32)) },
  ];
}
const mintTo = (mint, to, authority, amount) => ({ programId: TOKEN_PROGRAM, keys: [meta(mint, false, true), meta(to, false, true), meta(authority, true, false)], data: concat(Uint8Array.of(7), uintLE(amount, 8)) });

// ---------------------------------------------------------------- the run

async function main() {
  const genesis = await rpc.call('getGenesisHash');
  if (genesis !== DEVNET_GENESIS) throw new Error(`This RPC is not devnet (genesis ${genesis}). The kit runs on devnet only.`);
  const creator = await key('GF_DEVNET_CREATOR_KEY');
  const authority = await key('GF_DEVNET_AUTHORITY_KEY');
  const p1 = await key('GF_DEVNET_PLAYER_KEY');
  const p2 = await key('GF_DEVNET_PLAYER2_KEY');
  Object.assign(result, { creator: creator.address, authority: authority.address, player1: p1.address, player2: p2.address });
  const start = Object.fromEntries(await Promise.all([['creator', creator], ['authority', authority], ['player1', p1], ['player2', p2]].map(async ([n, k]) => [n, await rpc.balance(k.address)])));
  await step('wallets on devnet', async () => ({ lamports: start, ok: start.creator > 300_000_000n && start.authority > 50_000_000n && start.player1 > 150_000_000n && start.player2 > 150_000_000n }));

  // ------------------------------------------------ 0. setup, with loot.js's builders
  const gold = freshKeypair();
  const collection = freshKeypair();
  const game = lootPda.game(collection.address);
  const treasury = ata(creator.address, NATIVE_MINT);
  const pool = (i) => lootPda.pool(game, i);
  const setup = await step('setup: GOLD made and handed out (100 each), the collection, the game (authority: keeper), four pools, the house seeded with 0.05 SOL', async () => {
    const s1 = await send([
      ...(await mintInstructions(creator.address, gold.address)),
      ...[creator.address, p1.address, p2.address].flatMap((who) => [createAssociatedTokenAccountIdempotent(creator.address, who, gold.address), mintTo(gold.address, ata(who, gold.address), creator.address, 100n * GOLD)]),
    ], [creator, gold]);
    gold.drop?.();
    const s2 = await send([
      createCollectionInstruction({ collection: collection.address, creator: creator.address, name: 'Play proof', uri: 'https://example.invalid/play-proof.json' }),
      createAssociatedTokenAccountIdempotent(creator.address, creator.address, NATIVE_MINT),
      createGameIx({ owner: creator.address, authority: authority.address, collection: collection.address, mint: NATIVE_MINT, treasury }),
    ], [creator, collection]);
    collection.drop?.();
    const s3 = await send([
      openPoolIx({ owner: creator.address, game, index: 0, mint: NATIVE_MINT }),
      ...[1, 2, 3].map((index) => openPoolIx({ owner: creator.address, game, index, mint: gold.address })),
      transferLamports(creator.address, treasury, 50_000_000n),
      syncNative(treasury),
      depositIx({ depositor: creator.address, game, index: 0, mint: NATIVE_MINT, from: treasury, amount: 50_000_000n }),
    ], [creator]);
    return { gold: gold.address, collection: collection.address, game, treasury, signatures: [s1, s2, s3], house: String(await tokens(pool(0))), ok: (await tokens(pool(0))) === 50_000_000n };
  });
  if (!setup?.ok) return;

  const drawsAt = nowSeconds() + LOTTERY_WAIT;
  const catalog = await step('catalog: items relic and blade, box flip, recipe forge, lottery draw, stake back', async () => {
    const signature = await send([
      upsertItemIx({ owner: creator.address, game, itemId: 1, args: itemArgs({ name: 'Relic', uri: 'https://example.invalid/relic.json', price: 1_000_000n }) }),
      upsertItemIx({ owner: creator.address, game, itemId: 2, args: itemArgs({ name: 'Blade', uri: 'https://example.invalid/blade.json', price: 0n }) }),
      upsertBoxIx({ owner: creator.address, game, boxId: 1, args: boxArgs({ price: 10_000_000n, shares: [{ to: { Pool: [0] }, bps: 9000 }], entries: [{ outcome: { Pay: { pool: 0, amount: 15_000_000n } }, weight: 1 }, { outcome: 'Nothing', weight: 1 }] }) }),
      upsertRecipeIx({ owner: creator.address, game, id: 1, args: { inputs: [{ Burn: { item: 1, count: 1 } }, { Pay: { mint: gold.address, amount: 1n * GOLD, to: { Pool: [3] } } }], outputs: [{ Item: [2] }] } }),
    ], [creator]);
    const signature2 = await send([
      upsertLotteryIx({ owner: creator.address, game, id: 1, args: { price: 1n * GOLD, pot: 1, places: [7000, 3000], ticket_mint: NO_ADDRESS, every: 120n, draws_at: BigInt(drawsAt) } }),
      openStakeIx({ owner: creator.address, game, id: 1, mint: gold.address, rewardsMint: gold.address, rewardsPool: 2, lock: 0n }),
    ], [creator]);
    return { signatures: [signature, signature2], drawsAt };
  });
  if (!catalog) return;

  // The game's gamesfun.json economy section, as a publish would leave it: ids, mints and the live addresses.
  const economy = {
    version: 1, network: 'devnet', name: 'Play proof', currency: 'sol', keys: { authority: authority.address },
    tokens: [{ key: 'sol', source: 'sol' }, { key: 'gold', source: 'existing', name: 'Gold (test)', symbol: 'GOLD', decimals: 6, mint: gold.address, venue: 'other', powers: { mintAuthority: 'someone else', freeze: false } }],
    collection: { name: 'Play proof' },
    items: [{ key: 'relic', id: 1, name: 'Relic', price: 0.001 }, { key: 'blade', id: 2, name: 'Blade' }],
    pools: [{ key: 'house', index: 0, currency: 'sol', seed: 0.05 }, { key: 'pot', index: 1, currency: 'gold' }, { key: 'rewards', index: 2, currency: 'gold', seed: 8, about: 'The creator deposits the 8 GOLD once both players staked, so they share it 10 : 30.' }, { key: 'fees', index: 3, currency: 'gold' }],
    boxes: [{ key: 'flip', id: 1, name: 'Coin flip', price: 0.01, split: [{ to: 'pool:house', percent: 90 }], outcomes: [{ gives: 'pay', chance: 50, pool: 'house', amount: 0.015 }, { gives: 'nothing', chance: 50 }] }],
    recipes: [{ key: 'forge', id: 1, name: 'Forge a blade', in: [{ takes: 'burn', item: 'relic', count: 1 }, { takes: 'pay', amount: 1, currency: 'gold', to: 'pool:fees' }], out: [{ gives: 'item', item: 'blade' }] }],
    lotteries: [{ key: 'draw', id: 1, name: 'Quick draw', pot: 'pot', price: 1, places: [70, 30], every: '120s' }],
    stakes: [{ key: 'back', id: 1, name: 'Back the house', stakes: 'gold', rewards: 'rewards' }],
    contests: [{ key: 'duel', name: 'Duel', currency: 'gold', sides: 2, sideNames: ['Red', 'Blue'], entriesClose: '90s', resultDue: '10m', split: [{ to: 'pool:fees', percent: 10 }], decidedBy: 'the authority, in this script' }],
    holds: [{ key: 'quest', name: 'Quest', item: 'blade', for: '1h', decidedBy: 'the authority, in this script' }],
    live: { program: network.loot.program, game, collection: collection.address, treasury, authority: authority.address, at: new Date().toISOString() },
  };
  const verdict = check(economy);
  result.economy = economy;
  result.specCheck = { ok: verdict.ok, refusals: verdict.refusals?.map((r) => r.code), warnings: verdict.warnings?.map((w) => w.code) };
  const config = { version: 1, network: 'devnet', economy };
  const kitFor = (player) =>
    createGfWeb3({ config, mock: false, location: { search: '', href: 'http://127.0.0.1/', host: '127.0.0.1', origin: 'http://127.0.0.1', pathname: '/' }, navigator: { webdriver: false, userAgent: 'node' }, wallets: [standardWallet(player)], rpc: rpc.url, rollPollMs: 2000 });
  // Connect each right after it is made: wallets register by name, and each kit keeps the one it connected.
  const k1 = kitFor(p1);
  await k1.connect();
  const k2 = kitFor(p2);
  await k2.connect();
  result.actions = (await k1.economy.actions()).map((a) => a.id);
  const goldOf = (who) => tokens(ata(who, gold.address));

  // ------------------------------------------------ 1. the lottery's tickets first (its round closes in four minutes)
  await step('lottery: player 1 buys 3 tickets, player 2 buys 2 (buyTickets), 1 GOLD each into the pot', async () => {
    const [b1, b2] = [await goldOf(p1.address), await goldOf(p2.address)];
    const r1 = await k1.economy.buyTickets('draw', { count: 3 });
    const r2 = await k2.economy.act('lottery:draw:tickets', { count: 2 });
    const pot = await tokens(pool(1));
    const [d1, d2] = [b1 - (await goldOf(p1.address)), b2 - (await goldOf(p2.address))];
    return { says: [r1.says, r2.says], signatures: [...r1.signatures, ...r2.signatures], pot: String(pot), paid: [String(d1), String(d2)], ok: pot === 5n * GOLD && d1 === 3n * GOLD && d2 === 2n * GOLD };
  });

  // ------------------------------------------------ 2. items, the box
  const relics = {};
  await step('buy: each player buys a relic (pay, then claim); the treasury gets 0.001 SOL each', async () => {
    const before = await tokens(treasury);
    const r1 = await k1.economy.buy('relic');
    const r2 = await k2.economy.act('item:relic:buy');
    relics.p1 = r1.asset;
    relics.p2 = r2.asset;
    const got = (await tokens(treasury)) - before;
    const owners = [await ownerOf(r1.asset), await ownerOf(r2.asset)];
    return { assets: [r1.asset, r2.asset], owners, treasuryGot: String(got), signatures: [...r1.signatures, ...r2.signatures], ok: owners[0] === p1.address && owners[1] === p2.address && got === 2_000_000n };
  });
  await step('openBox: each player flips (pay and roll, the oracle rolls on devnet, then claim); the house gets 90%, pays each win 0.015 SOL', async () => {
    const [house, tre] = [await tokens(pool(0)), await tokens(treasury)];
    const r1 = await k1.economy.openBox('flip');
    const r2 = await k2.economy.act('box:flip:open');
    const wins = [r1, r2].filter((r) => r.outcome.kind === 'prize').length;
    const houseDelta = (await tokens(pool(0))) - house;
    const treasuryDelta = (await tokens(treasury)) - tre;
    const expected = 2n * 9_000_000n - BigInt(wins) * 15_000_000n;
    return {
      outcomes: [r1.outcome, r2.outcome], says: [r1.says, r2.says], houseDelta: String(houseDelta), expectedHouseDelta: String(expected), treasuryDelta: String(treasuryDelta),
      signatures: [...r1.signatures, ...r2.signatures], receipts: await Promise.all([...r1.signatures, ...r2.signatures].map(receipts)),
      ok: houseDelta === expected && treasuryDelta === 2_000_000n,
    };
  });

  // ------------------------------------------------ 3. a recipe, a hold
  let blade = null;
  await step('craft: player 1 burns the relic and pays 1 GOLD into fees for a blade (a new key for the blade signs)', async () => {
    const [fees, g] = [await tokens(pool(3)), await goldOf(p1.address)];
    const r = await k1.economy.craft('forge');
    blade = r.outcome.made[0];
    // Metaplex Core leaves a burned asset as a 1-byte tombstone (key 0, Uninitialized), not a closed account.
    const [left] = await rpc.accounts([relics.p1]);
    const relicGone = !left || left.data.length <= 1 || left.data[0] !== 1;
    const feesDelta = (await tokens(pool(3))) - fees;
    const paid = g - (await goldOf(p1.address));
    return { blade, bladeOwner: await ownerOf(blade), relicBurned: relicGone, feesDelta: String(feesDelta), paid: String(paid), signatures: r.signatures, receipts: await receipts(r.signatures[0]), ok: (await ownerOf(blade)) === p1.address && relicGone && feesDelta === GOLD && paid === GOLD };
  });
  await step('hold: player 1 sends the blade on the quest (hold for 1h); the authority awards it to player 2', async () => {
    const r = await k1.economy.hold('quest');
    const heldBy = await ownerOf(blade);
    const state = await k1.economy.state();
    const awarded = await send([awardIx({ signer: authority.address, game, asset: blade, player: p1.address, to: p2.address, collection: collection.address })], [authority]);
    const owner = await ownerOf(blade);
    return { says: r.says, heldBy, holdsInState: state.holds.quest, signatures: [...r.signatures, awarded], receipts: [await receipts(r.signatures[0]), await receipts(awarded)], owner, ok: heldBy === game && owner === p2.address };
  });

  // ------------------------------------------------ 4. a stake
  await step('stake: player 1 stakes 10 GOLD, player 2 stakes 30; the creator deposits 8 GOLD of rewards; each collects their share; both unstake', async () => {
    const [g1, g2] = [await goldOf(p1.address), await goldOf(p2.address)];
    const s1 = await k1.economy.stake('back', { amount: '10' });
    const s2 = await k2.economy.act('stake:back:stake', { amount: '30' });
    const dep = await send([depositIx({ depositor: creator.address, game, index: 2, mint: gold.address, amount: 8n * GOLD })], [creator]);
    const pending = [(await k1.economy.stakePosition('back')).pending, (await k2.economy.stakePosition('back')).pending];
    const c1 = await k1.economy.claim('stake:back');
    const c2 = await k2.economy.act('stake:back:claim');
    const earned = [(await goldOf(p1.address)) - (g1 - 10n * GOLD), (await goldOf(p2.address)) - (g2 - 30n * GOLD)];
    const u1 = await k1.economy.unstake('back');
    const u2 = await k2.economy.act('stake:back:unstake');
    const back = [(await goldOf(p1.address)) - g1, (await goldOf(p2.address)) - g2];
    const vault = await tokens(lootPda.staked(lootPda.stake(game, 1)));
    return {
      pendingBeforeCollecting: pending, earned: earned.map(String), net: back.map(String), stakedVault: String(vault),
      signatures: [...s1.signatures, ...s2.signatures, dep, ...c1.signatures, ...c2.signatures, ...u1.signatures, ...u2.signatures],
      ok: earned[0] === 2n * GOLD && earned[1] === 6n * GOLD && back[0] === 2n * GOLD && back[1] === 6n * GOLD && vault === 0n && pending[0] === String(2n * GOLD) && pending[1] === String(6n * GOLD),
    };
  });

  // ------------------------------------------------ 5. a contest
  await step('contest: the authority opens Duel; player 1 backs Red with 5 GOLD, player 2 Blue with 3; the authority names Red; 10% to fees, player 1 collects the rest', async () => {
    const t = nowSeconds();
    const args = { sides: 2, closes_at: BigInt(t + 90), result_by: BigInt(t + 600), shares: [{ to: { Pool: [3] }, bps: 1000 }] };
    const opened = await send([openContestIx({ authority: authority.address, game, id: 1, mint: gold.address, args })], [authority]);
    const [g1, g2, fees] = [await goldOf(p1.address), await goldOf(p2.address), await tokens(pool(3))];
    const e1 = await k1.economy.enter('duel', { side: 'Red', amount: '5' });
    const e2 = await k2.economy.act('contest:duel:enter:1', { amount: '3' });
    const decided = await send([decideIx({ authority: authority.address, game, id: 1, side: 0, mint: gold.address, remaining: [meta(pool(3), false, true)] })], [authority]);
    const state = await k1.economy.state();
    const c1 = await k1.economy.act('contest:duel:claim');
    const c2 = await k2.economy.claim('contest:duel');
    const net = [(await goldOf(p1.address)) - g1, (await goldOf(p2.address)) - g2];
    const feesDelta = (await tokens(pool(3))) - fees;
    const pot = await tokens(lootPda.pot(lootPda.contest(game, 1)));
    return {
      says: [e1.says, e2.says, c1.says, c2.says], claimableAfterDecide: state.claimable, net: net.map(String), feesDelta: String(feesDelta), potLeft: String(pot),
      signatures: [opened, ...e1.signatures, ...e2.signatures, decided, ...c1.signatures, ...c2.signatures],
      ok: net[0] === 2_200_000n && net[1] === -3n * GOLD && feesDelta === 800_000n && pot === 0n,
    };
  });

  // ------------------------------------------------ 6. the lottery's draw
  await step('lottery: once due, player 1 claims (draw_lottery, MagicBlock’s oracle draws on devnet, then both places paid); 3.5 and 1.5 GOLD to the winners', async () => {
    const wait = drawsAt - nowSeconds() + 5;
    if (wait > 0) await sleep(wait * 1000);
    const before = { [p1.address]: await goldOf(p1.address), [p2.address]: await goldOf(p2.address) };
    let r = null;
    for (let tries = 0; tries < 5 && !r; tries++) {
      try {
        r = await k1.economy.claim('lottery:draw');
      } catch (error) {
        if (!/not due|next draw/i.test(error.message) || tries === 4) throw error;
        await sleep(5000);
      }
    }
    const gained = { [p1.address]: (await goldOf(p1.address)) - before[p1.address], [p2.address]: (await goldOf(p2.address)) - before[p2.address] };
    const expected = { [p1.address]: 0n, [p2.address]: 0n };
    for (const w of r.winners) expected[w.winner] += w.place === 1 ? 3_500_000n : 1_500_000n;
    const l = await k1.economy.lottery('draw');
    return {
      winners: r.winners, says: r.says, gained: json(gained), expected: json(expected), potLeft: l.pot, round: l.round, status: l.status,
      signatures: r.signatures, receipts: await Promise.all(r.signatures.map(receipts)),
      ok: r.winners.length === 2 && gained[p1.address] === expected[p1.address] && gained[p2.address] === expected[p2.address] && l.pot === '0' && l.round === 1 && l.status === 'Open',
    };
  });

  await step('reads: the state the page sends the game, and player 1’s own receipts', async () => {
    const state = await k1.economy.state();
    const mine = await k1.economy.receipts({ limit: 40 });
    return { state, receipts: mine.map((x) => ({ name: x.name, signature: x.signature })), ok: Boolean(state.balances.gold) && mine.length > 0 };
  });

  result.lamportsSpent = Object.fromEntries(await Promise.all([['creator', creator], ['authority', authority], ['player1', p1], ['player2', p2]].map(async ([n, k]) => [n, String(start[n] - (await rpc.balance(k.address)))])));
}

try {
  await main();
} catch (error) {
  result.steps.push({ name: 'run', ok: false, error: error.message });
  console.error(error);
}
result.finishedAt = new Date().toISOString();
result.ok = result.steps.length > 0 && result.steps.every((s) => s.ok);
for (const s of result.steps) if (s.signatures) s.explorer = s.signatures.map(tx);
await writeFile(path.join(here, 'play-0.3.2-result.json'), `${JSON.stringify(json(result), null, 2)}\n`);
console.log(result.ok ? 'K2 devnet play proof: every step passed' : 'K2 devnet play proof: some steps failed', '→ tests/web3/devnet/play-0.3.2-result.json');
process.exitCode = result.ok ? 0 : 1;
