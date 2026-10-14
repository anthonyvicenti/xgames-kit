// K1's devnet proof: the fixture economies (builder/web3/economy/fixtures: ten from ECONOMIES-100 and the coin-flip arena)
// go live on devnet, each through the same economy flow the studio page drives (builder/web3/node/flows.mjs economyFlow on the
// flow engine: the server prepares, the wallet approves, the server checks and sends), then read back with
// economyStatus: every part on chain and as the spec says. Then one change to one live economy publishes only the
// difference. A local test key stands in for the creator's wallet; in the product the creator's own wallet approves.
//
//   GF_DEVNET_CREATOR_KEY=<path to the creator's keypair JSON> node tests/web3/devnet/economies.mjs [--only a,b] [--seed-scale 0.01]
//   GF_DEVNET_CREATOR_KEY=… node tests/web3/devnet/economies.mjs --make-fixtures
//
// --make-fixtures makes the devnet accounts the fixtures name (a pump.fun-style mint, the stud's and the arena deed's
// collectibles, the partners' token accounts) and writes their public addresses into the result; the fixtures carry
// them from then on. The duel arena's authority is the launchpad's keeper wallet (public address only).
//
// Seeds: the creator's devnet wallet cannot cover the fixtures' seeds in SOL (8 SOL) and holds no USDC-dev, so a run
// puts seeds in SOL in at --seed-scale (default 0.01: the arena's 5 SOL house goes in as 0.05) and seeds in USDC at 0,
// with 10% of the first sale in that currency filling the pool instead (the duel arena's mission rewards). Everything
// else is the fixture as written. The result records each seed as it went in.
// --only a,b runs those economies and keeps the other economies' steps from the last result (each step has its time).
//
// Devnet only (checks devnet's genesis hash). The key is read from the file the environment variable names, never
// printed or written. Results: tests/web3/devnet/economies-result.json.
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { addressBytes } from '../../../builder/web3/gf-web3/chain/base58.js';
import { concat, uintLE, utf8 } from '../../../builder/web3/gf-web3/chain/bytes.js';
import { MPL_CORE_PROGRAM, parseCoreAsset } from '../../../builder/web3/gf-web3/chain/core.js';
import { parseMint } from '../../../builder/web3/gf-web3/chain/mint.js';
import { associatedTokenAddress, metadataAddress, NATIVE_MINT, SYSTEM_PROGRAM, TOKEN_PROGRAM } from '../../../builder/web3/gf-web3/chain/pda.js';
import { createAssociatedTokenAccountIdempotent, meta } from '../../../builder/web3/gf-web3/chain/programs.js';
import { compileMessage, readTransaction, signersOf, wireTransaction } from '../../../builder/web3/gf-web3/chain/tx.js';
import { explorerUrl, networkConfig } from '../../../builder/web3/gf-web3/network.js';
import { rpcClient } from '../../../builder/web3/gf-web3/rpc.js';
import { createAccountIx, createMetadataIx, economyStatus, initializeMint2Ix, setAuthorityIx } from '../../../builder/web3/node/economy.mjs';
import { freshKeypair, keypairFromSecret } from '../../../builder/web3/node/ed25519.mjs';
import { createFlowEngine } from '../../../builder/web3/node/flow-engine.mjs';
import { economyFlow } from '../../../builder/web3/node/flows.mjs';
import { png } from '../helpers.mjs';

const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const here = path.dirname(fileURLToPath(import.meta.url));
const kitRoot = path.resolve(here, '..', '..', '..');
const fixturesDir = path.join(kitRoot, 'builder/web3/economy/fixtures');
const scratch = path.join(kitRoot, '.gamesfun', 'devnet', 'economies');
const network = networkConfig('devnet');
const rpc = rpcClient(process.env.GF_DEVNET_RPC ?? network.rpcUrl);
const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i < 0 ? null : (args[i + 1] ?? '');
};
const SEED_SCALE = Number(flag('--seed-scale') ?? 0.01);
/** Public addresses of the launchpad's own devnet wallets (games.fun launchpad/lib/env.mjs roles), no keys. */
// The partner's wrapped-SOL account is the launchpad's partner wallet's: a player's wrapped-SOL account is closed after
// every purchase (gf-web3 withSolWrap), and test-buyer-1's was, between two runs on 2026-10-12.
const WALLETS = { friendA: '43QBMgKHHkPuPZsN4KUwUkbxJkHfv4gZF1d7xNMP66gc', friendB: 'ACJCKRg7AVn6mE4vyggRKDrc3y1FiuTm6VqPqJEChfXF', keeper: 'Hby5BFRb3qfaDyY2Fza4UtjfRn4aFmvdnMAouigMurAs', partner: '8yPDcNeKHwfSmyx9MPNpgqU8o1W4xiCHxzYty7w3rnNV' };
const MAIN_DEV = '4ikj24Byduo7WZGhnxNYkqstpm9xUVeZH7eLQbjGDL7N';
const MIN_CREATOR_LAMPORTS = 150_000_000n;
const resultFile = path.join(here, 'economies-result.json');
const result = { network: 'devnet', program: network.loot.program, platform: network.loot.platform, startedAt: new Date().toISOString(), seedScale: SEED_SCALE, steps: [] };
const tx = (signature) => explorerUrl(network, 'tx', signature);

async function step(name, run) {
  const at = new Date().toISOString();
  try {
    const out = (await run()) ?? {};
    result.steps.push({ name, at, ok: out.ok !== false, ...out });
    console.log(`${out.ok === false ? '✗' : '✓'} ${name}`);
    return out;
  } catch (error) {
    result.steps.push({ name, at, ok: false, error: error.message, logs: error.logs?.slice(-14) });
    console.log(`✗ ${name}: ${error.message}`);
    return null;
  }
}

async function key(variable) {
  const file = process.env[variable];
  if (!file) throw new Error(`Set ${variable} to the path of a devnet keypair file.`);
  return keypairFromSecret(Uint8Array.from(JSON.parse(await readFile(file, 'utf8'))));
}

/** A transaction signed here by test keys, sent and confirmed (only for the fixture accounts, outside any flow). */
async function send(instructions, signers) {
  const { blockhash, lastValidBlockHeight } = await rpc.latestBlockhash();
  const message = compileMessage({ payer: signers[0].address, blockhash, instructions });
  const signatures = signersOf(message).map((a) => signers.find((s) => s.address === a).sign(message));
  const signature = await rpc.send(wireTransaction(message, signatures));
  await rpc.confirm(signature, { lastValidBlockHeight });
  return signature;
}

/** Answers every step of a flow with `wallet`, as the studio page does with the person's wallet. */
async function approveAll(engine, flow, wallet) {
  let view = flow;
  const approvals = { messages: 0, transactions: 0, wires: 0 };
  while (!view.done) {
    const p = await engine.prepare(view.id, wallet.address);
    if (p.kind === 'transactions' && /^Create \$/.test(p.title)) approvals.launch = (approvals.launch ?? 0) + 1;
    if (p.kind === 'message') {
      approvals.messages += 1;
      view = await engine.complete(view.id, { prepareId: p.prepareId, signature: Buffer.from(wallet.sign(new TextEncoder().encode(p.text))).toString('base64') });
    } else {
      approvals.transactions += 1;
      approvals.wires += p.transactions.length;
      const signed = p.transactions.map((b64) => {
        const { message, signers, signatures: slots } = readTransaction(new Uint8Array(Buffer.from(b64, 'base64')));
        return Buffer.from(wireTransaction(message, signers.map((s, i) => (s === wallet.address ? wallet.sign(message) : slots[i])))).toString('base64');
      });
      view = await engine.complete(view.id, { prepareId: p.prepareId, signed });
    }
  }
  return { view, approvals };
}

// ---------------------------------------------------------------- the fixtures' own devnet accounts

/** Metaplex Core CreateV1: a lone collectible (no collection) owned by `owner`, its fresh key signing. */
const coreCreateV1 = ({ asset, payer, owner, name }) => ({
  programId: MPL_CORE_PROGRAM,
  keys: [meta(asset, true, true), meta(MPL_CORE_PROGRAM, false, false), meta(MPL_CORE_PROGRAM, false, false), meta(payer, true, true), meta(owner, false, false), meta(MPL_CORE_PROGRAM, false, false), meta(SYSTEM_PROGRAM, false, false), meta(MPL_CORE_PROGRAM, false, false)],
  data: concat(Uint8Array.of(0, 0), uintLE(utf8(name).length, 4), utf8(name), uintLE(0, 4), Uint8Array.of(0)),
});
const mintToIx = ({ mint, to, authority, amount }) => ({ programId: TOKEN_PROGRAM, keys: [meta(mint, false, true), meta(to, false, true), meta(authority, true, false)], data: concat(Uint8Array.of(7), uintLE(amount, 8)) });

async function makeFixtureAccounts(creator) {
  const made = {};
  const parts = flag('--parts')?.split(',') ?? ['tile', 'assets', 'partners'];
  if (parts.includes('tile')) await step('a pump.fun-style mint for merge-2048 (classic SPL, 6 decimals, named, 1,000,000 TILE each to the creator and a friend, then no mint authority)', async () => {
    const mint = freshKeypair();
    const rent = BigInt(await rpc.call('getMinimumBalanceForRentExemption', [82]));
    const supply = 1_000_000n * 1_000_000n;
    const first = await send([
      createAccountIx({ from: creator.address, to: mint.address, lamports: rent, space: 82, owner: TOKEN_PROGRAM }),
      initializeMint2Ix({ mint: mint.address, decimals: 6, mintAuthority: creator.address }),
      createMetadataIx({ metadata: metadataAddress(mint.address), mint: mint.address, mintAuthority: creator.address, payer: creator.address, updateAuthority: creator.address, name: 'Tile', symbol: 'TILE', uri: '' }),
    ], [creator, mint]);
    const second = await send([
      createAssociatedTokenAccountIdempotent(creator.address, creator.address, mint.address),
      createAssociatedTokenAccountIdempotent(creator.address, WALLETS.friendA, mint.address),
      mintToIx({ mint: mint.address, to: associatedTokenAddress(creator.address, mint.address), authority: creator.address, amount: supply }),
      mintToIx({ mint: mint.address, to: associatedTokenAddress(WALLETS.friendA, mint.address), authority: creator.address, amount: supply }),
      setAuthorityIx({ account: mint.address, current: creator.address, newAuthority: null }),
    ], [creator]);
    mint.drop();
    made.tile = mint.address;
    return { mint: mint.address, signatures: [first, second], explorer: [tx(first), tx(second)] };
  });
  if (parts.includes('assets')) for (const [name, label, owner] of [['stud', 'Stud (Stud Farm fixture)', WALLETS.friendA], ['arenaDeed', 'Arena Deed (Duel Arena fixture)', WALLETS.friendB]]) {
    await step(`a Core collectible for the ${label}, held by a friend`, async () => {
      const asset = freshKeypair();
      const signature = await send([coreCreateV1({ asset: asset.address, payer: creator.address, owner, name: label })], [creator, asset]);
      asset.drop();
      made[name] = asset.address;
      return { asset: asset.address, owner, signature, explorer: tx(signature) };
    });
  }
  if (parts.includes('partners')) await step('the partners’ token accounts: the partner wallet’s wrapped-SOL account (falling-drop’s entry cut) and a friend’s MAIN-dev account (its cursed tips)', async () => {
    const wsol = associatedTokenAddress(WALLETS.partner, NATIVE_MINT);
    const main = associatedTokenAddress(WALLETS.friendB, MAIN_DEV);
    const signature = await send([createAssociatedTokenAccountIdempotent(creator.address, WALLETS.partner, NATIVE_MINT), createAssociatedTokenAccountIdempotent(creator.address, WALLETS.friendB, MAIN_DEV)], [creator]);
    made.partnerSol = wsol;
    made.partnerMain = main;
    return { wsol, main, signature, explorer: tx(signature) };
  });
  made.duelAuthority = WALLETS.keeper;
  result.fixtureAccounts = made;
  return made;
}

/** The fixtures name these devnet accounts: each must be there and be what the fixture says it is. */
async function checkFixtureAccounts() {
  const fx = Object.fromEntries(await Promise.all(['merge-2048', 'stud-farm', 'duel-arena', 'falling-drop'].map(async (n) => [n, JSON.parse(await readFile(path.join(fixturesDir, `${n}.json`), 'utf8'))])));
  const want = {
    tile: fx['merge-2048'].tokens[0].mint,
    stud: fx['stud-farm'].recipes[0].in.find((l) => l.to?.startsWith('holder:')).to.slice(7),
    arenaDeed: fx['duel-arena'].contests[0].split.find((s) => s.to.startsWith('holder:')).to.slice(7),
    partnerSol: fx['falling-drop'].payments[0].split[0].to.slice(8),
    partnerMain: fx['falling-drop'].payments[1].split[1].to.slice(8),
    duelAuthority: fx['duel-arena'].keys.authority,
  };
  const accounts = await rpc.accounts(Object.values(want));
  const of = Object.fromEntries(Object.keys(want).map((k, i) => [k, accounts[i]]));
  const tile = of.tile && parseMint(want.tile, of.tile.owner, of.tile.data);
  const checks = {
    tile: Boolean(tile) && tile.program === 'spl-token' && tile.decimals === 6 && !tile.mintAuthority && !tile.freezeAuthority,
    stud: of.stud?.owner === MPL_CORE_PROGRAM && parseCoreAsset(of.stud.data).owner === WALLETS.friendA,
    arenaDeed: of.arenaDeed?.owner === MPL_CORE_PROGRAM && parseCoreAsset(of.arenaDeed.data).owner === WALLETS.friendB,
    partnerSol: of.partnerSol?.owner === TOKEN_PROGRAM,
    partnerMain: of.partnerMain?.owner === TOKEN_PROGRAM,
    duelAuthority: Boolean(of.duelAuthority) && of.duelAuthority.owner === SYSTEM_PROGRAM,
  };
  return { addresses: want, checks, ok: Object.values(checks).every(Boolean) };
}

// ---------------------------------------------------------------- an economy, live

/** The fixture as this run puts it live: seeds scaled to the budget, nothing else changed. */
function forDevnet(spec) {
  const e = structuredClone(spec);
  const seeds = [];
  for (const p of e.pools ?? []) {
    if (!(Number(p.seed ?? 0) > 0)) continue;
    const t = e.tokens.find((x) => x.key === p.currency);
    const was = p.seed;
    if (t.source === 'sol') p.seed = Number((Number(p.seed) * SEED_SCALE).toFixed(9));
    else if (t.mint === '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU') p.seed = 0;
    if (!p.seed) delete p.seed;
    seeds.push({ pool: p.key, fixture: was, wentIn: p.seed ?? 0, symbol: t.symbol ?? t.key.toUpperCase() });
    // A pool left with no seed must still be filled from somewhere, or the checker refuses it (E-POOL-DRY): 10% of
    // the first sale in its currency goes there instead.
    const sale = !p.seed && (e.items ?? []).find((i) => Number(i.price ?? 0) > 0 && !i.split?.length && (i.currency ?? e.currency) === p.currency);
    if (sale) {
      sale.split = [{ to: `pool:${p.key}`, percent: 10 }];
      seeds.at(-1).instead = `10% of every “${sale.name}” sale goes to “${p.key}”`;
    }
  }
  return { economy: e, seeds };
}

async function gameFolder(name, economy) {
  const dir = path.join(scratch, name);
  await rm(dir, { recursive: true, force: true });
  await mkdir(path.join(dir, 'assets'), { recursive: true });
  await writeFile(path.join(dir, 'index.html'), `<!doctype html><title>${economy.name}</title>`);
  await writeFile(path.join(dir, 'assets', 'icon.png'), png(240, 180, 40, 16, 16));
  await writeFile(path.join(dir, 'gamesfun.json'), `${JSON.stringify({ version: 1, network: 'devnet', economy }, null, 2)}\n`);
  return dir;
}

const readJson = async (file) => JSON.parse(await readFile(file, 'utf8'));
const summary = (status) => ({
  parts: status.parts.length,
  onChain: status.parts.filter((p) => p.onChain).length,
  differs: status.parts.filter((p) => p.differs).map((p) => `${p.part}:${p.key}`),
  missing: status.parts.filter((p) => !p.onChain).map((p) => `${p.part}:${p.key}`),
  pools: status.pools.map((p) => ({ key: p.key, amount: p.amount, symbol: p.symbol })),
});

async function goLive(name, creator) {
  const { economy, seeds } = forDevnet(await readJson(path.join(fixturesDir, `${name}.json`)));
  const dir = await gameFolder(name, economy);
  const before = await rpc.balance(creator.address);
  const engine = createFlowEngine();
  const ctx = { gameDir: dir, rpc, network };
  const flow = engine.start(await economyFlow(ctx, creator.address, { picture: 'assets/icon.png', description: `${economy.name}: a games.fun kit devnet test` }));
  const { view, approvals } = await approveAll(engine, flow, creator);
  const config = await readJson(path.join(dir, 'gamesfun.json'));
  const live = config.economy.live;
  const status = await economyStatus(dir, { rpc, network, receipts: 0 });
  const s = summary(status);
  // Every seed went in: each seeded pool holds at least its seed (nothing has been played yet).
  const poolsSeeded = seeds.every((x) => !x.wentIn || Number(status.pools.find((p) => p.key === x.pool)?.amount ?? 0) >= Number(x.wentIn));
  const spent = before - (await rpc.balance(creator.address));
  return {
    dir,
    game: live.game,
    collection: live.collection,
    treasury: live.treasury,
    tokens: config.economy.tokens.filter((t) => t.mint).map((t) => ({ key: t.key, mint: t.mint })),
    approvals,
    signatures: live.transactions.map((t) => t.signature),
    explorer: explorerUrl(network, 'address', live.game),
    results: view.results,
    seeds,
    status: s,
    lamportsSpent: String(spent),
    // One approval for the economy's transactions; a token launched on the curve with it has its own.
    ok: status.live && s.onChain === s.parts && !s.differs.length && poolsSeeded && approvals.transactions - (approvals.launch ?? 0) === 1,
  };
}

// ---------------------------------------------------------------- the run

async function main() {
  const genesis = await rpc.call('getGenesisHash');
  if (genesis !== DEVNET_GENESIS) throw new Error(`This RPC is not devnet (genesis ${genesis}). The kit runs on devnet only.`);
  const creator = await key('GF_DEVNET_CREATOR_KEY');
  result.creator = creator.address;
  const start = await rpc.balance(creator.address);
  result.creatorLamportsAtStart = String(start);
  if (args.includes('--make-fixtures')) {
    await makeFixtureAccounts(creator);
    result.creatorLamportsSpent = String(start - (await rpc.balance(creator.address)));
    return;
  }
  await step('the fixtures’ devnet accounts are there and are what the fixtures say', checkFixtureAccounts);
  const only = flag('--only')?.split(',').filter(Boolean);
  const names = (await import('node:fs')).readdirSync(fixturesDir).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort().filter((n) => !only || only.includes(n));
  const live = {};
  if (only) {
    // Keep what the last run proved for the economies this run leaves alone.
    const last = await readJson(resultFile).catch(() => null);
    const mine = (step) => names.some((n) => step.name.startsWith(`${n}:`)) || step.name.startsWith('the fixtures’');
    const kept = (last?.steps ?? []).filter((x) => !mine(x) && (!/one change/.test(x.name) || x.ok) && !/^stopped|^run$/.test(x.name));
    result.steps.push(...kept.map((x) => ({ ...x, fromRun: last.startedAt })));
    for (const [n, o] of Object.entries(last?.economies ?? {})) if (!names.includes(n) && kept.some((x) => x.name.startsWith(`${n}:`) && x.ok)) live[n] = { ...o, kept: true };
    result.earlierRuns = [...new Set([...(last?.earlierRuns ?? []), last?.startedAt].filter(Boolean))];
    result.creatorLamportsSpentEarlier = String(BigInt(last?.creatorLamportsSpent ?? 0) + BigInt(last?.creatorLamportsSpentEarlier ?? 0));
  }
  for (const name of names) {
    const balance = await rpc.balance(creator.address);
    if (balance < MIN_CREATOR_LAMPORTS) {
      result.steps.push({ name: `stopped before ${name}`, ok: false, error: `The test-creator wallet holds ${balance} lamports, under ${MIN_CREATOR_LAMPORTS}. Stopped rather than use another key.` });
      console.log(`✗ stopped: the creator wallet is low (${balance} lamports)`);
      break;
    }
    const out = await step(`${name}: put live in one approval through the economy flow, then read back with economyStatus`, () => goLive(name, creator));
    if (out?.ok) live[name] = out;
  }
  const proven = result.steps.some((x) => /one change/.test(x.name) && x.ok);
  const target = proven ? null : ['starforce', ...Object.keys(live)].find((n) => live[n] && !live[n].kept && live[n].dir);
  if (target) {
    await step(`${target}: one change (an item’s price) publishes only that difference`, async () => {
      const dir = live[target].dir;
      const file = path.join(dir, 'gamesfun.json');
      const config = await readJson(file);
      const item = config.economy.items[0];
      const was = item.price;
      item.price = Number((Number(item.price) * 1.2).toFixed(9));
      await writeFile(file, `${JSON.stringify(config, null, 2)}\n`);
      const marked = await economyStatus(dir, { rpc, network, receipts: 0 });
      const engine = createFlowEngine();
      const flow = engine.start(await economyFlow({ gameDir: dir, rpc, network }, creator.address));
      const before = (await readJson(file)).economy.live.transactions.length;
      const { approvals } = await approveAll(engine, flow, creator);
      const after = await readJson(file);
      const landed = after.economy.live.transactions.slice(before);
      const status = await economyStatus(dir, { rpc, network, receipts: 0 });
      return {
        item: item.key,
        price: { was, now: item.price },
        differedBefore: marked.parts.filter((p) => p.differs).map((p) => `${p.part}:${p.key}`),
        approvals,
        landed,
        explorer: landed.map((t) => tx(t.signature)),
        status: summary(status),
        ok: approvals.wires === 1 && landed.length === 1 && landed[0].parts.join() === `item:${item.key}` && !status.parts.some((p) => p.differs || !p.onChain),
      };
    });
  }
  result.economies = Object.fromEntries(Object.entries(live).map(([n, o]) => [n, { game: o.game, collection: o.collection, explorer: o.explorer }]));
  result.creatorLamportsSpent = String(start - (await rpc.balance(creator.address)));
}

try {
  await main();
} catch (error) {
  result.steps.push({ name: 'run', ok: false, error: error.message });
  console.error(error);
}
result.finishedAt = new Date().toISOString();
result.ok = result.steps.length > 0 && result.steps.every((s) => s.ok);
for (const s of result.steps) delete s.dir;
const file = args.includes('--make-fixtures') ? path.join(here, `economies-fixtures-result${flag('--parts') ? `-${flag('--parts').replaceAll(',', '-')}` : ''}.json`) : resultFile;
await writeFile(file, `${JSON.stringify(result, null, 2)}\n`);
console.log(result.ok ? 'K1 devnet proof: every step passed' : 'K1 devnet proof: some steps failed', `→ ${path.relative(kitRoot, file)}`, `(creator spent ${result.creatorLamportsSpent ?? '?'} lamports)`);
process.exitCode = result.ok ? 0 : 1;
