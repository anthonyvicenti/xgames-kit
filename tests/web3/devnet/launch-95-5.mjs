// The devnet proof of a token launch as games.fun's launchpad makes them since 2026-10-12: a DBC config of the launch's
// own, paired with SOL, games.fun's partner wallet as fee claimer, 95 / 5. From the kit's own code only:
//   1. `gamesfun web3 launch … --pair SOL --buy 0.001` (web3Action, what the CLI and the MCP tool call) checks the pair,
//      the curve and the buy, and leaves a request;
//   2. the launch flow on the flow engine (what the studio's Economy tab drives): two uploads to Irys devnet (a
//      signMessage each), then the launch's transactions in one approval, signed here by a test key that stands in
//      for the creator's wallet;
//   3. read back from chain with the kit's own reader: the config's fee claimer, leftover receiver, quote mint and
//      split, the pool, the metadata, and the tokens the first buy got against the offline quote.
// games.fun's own read-only check (launchpad/launch/official.mjs checkOfficialToken) is run on the result separately
// (tests/web3/devnet/launch-95-5-result.json records it under `officialCheck`).
//
// Devnet only (checks devnet's genesis hash). The key is the launchpad's test-creator (LAUNCHPAD_KEY_DIR, default
// ~/.config/gamesfun-launchpad/devnet), read, never printed or copied. GF_DEVNET_RPC names another devnet RPC (never
// written to the result). The result goes to tests/web3/devnet/launch-95-5-result.json; an existing one is never
// overwritten (pass --out for another file).
//   node tests/web3/devnet/launch-95-5.mjs [--buy 0.001] [--out <file>]
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPoolConfig, readVirtualPool } from '../../../builder/web3/gf-web3/chain/dbc.js';
import { curveParams, quoteFirstBuy, targetsForPair } from '../../../builder/web3/gf-web3/chain/dbc-curve.js';
import { parseMetaplexMetadata } from '../../../builder/web3/gf-web3/chain/mint.js';
import { associatedTokenAddress, metadataAddress } from '../../../builder/web3/gf-web3/chain/pda.js';
import { readTransaction, wireTransaction } from '../../../builder/web3/gf-web3/chain/tx.js';
import { explorerUrl, networkConfig } from '../../../builder/web3/gf-web3/network.js';
import { rpcClient } from '../../../builder/web3/gf-web3/rpc.js';
import { web3Action } from '../../../builder/web3/node/actions.mjs';
import { keypairFromSecret } from '../../../builder/web3/node/ed25519.mjs';
import { createFlowEngine } from '../../../builder/web3/node/flow-engine.mjs';
import { launchFlow } from '../../../builder/web3/node/flows.mjs';
import { listRequests, removeRequest } from '../../../builder/web3/node/requests.mjs';
import { png } from '../helpers.mjs';

const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const here = path.dirname(fileURLToPath(import.meta.url));
const kitRoot = path.resolve(here, '..', '..', '..');
const args = process.argv.slice(2);
const flag = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const BUY = flag('--buy', '0.001');
const out = path.resolve(flag('--out', path.join(here, 'launch-95-5-result.json')));
if (existsSync(out)) throw new Error(`${path.relative(kitRoot, out)} exists; results are never overwritten (pass --out <new file>).`);
const keyDir = process.env.LAUNCHPAD_KEY_DIR ?? path.join(homedir(), '.config', 'gamesfun-launchpad', 'devnet');
const network = networkConfig('devnet');
const custom = Boolean(process.env.GF_DEVNET_RPC);
const rpc = rpcClient(process.env.GF_DEVNET_RPC ?? network.rpcUrl);
const env = { ...process.env, ...(custom ? { GAMESFUN_RPC_URL: process.env.GF_DEVNET_RPC } : {}) };
const result = { network: 'devnet', rpc: custom ? 'a private devnet RPC (not recorded)' : network.rpcUrl, startedAt: new Date().toISOString(), wallet: 'test-creator (games.fun launchpad devnet test wallet)', steps: [] };
const tx = (signature) => explorerUrl(network, 'tx', signature);

async function step(name, run) {
  const at = new Date().toISOString();
  try {
    const value = (await run()) ?? {};
    result.steps.push({ name, at, ok: value.ok !== false, ...value });
    console.log(`${value.ok === false ? '✗' : '✓'} ${name}`);
    return value;
  } catch (error) {
    result.steps.push({ name, at, ok: false, error: error.message, logs: error.logs?.slice(-14) });
    console.log(`✗ ${name}: ${error.message}`);
    return null;
  }
}

/** Answers every step of a flow with `wallet`, as the studio page does with the person's wallet. */
async function approveAll(engine, flow, wallet) {
  let view = flow;
  const prompts = [];
  while (!view.done) {
    const p = await engine.prepare(view.id, wallet.address);
    prompts.push({ kind: p.kind, title: p.title, details: p.details, transactions: p.transactions?.length });
    if (p.kind === 'message') view = await engine.complete(view.id, { prepareId: p.prepareId, signature: Buffer.from(wallet.sign(new TextEncoder().encode(p.text))).toString('base64') });
    else {
      const signed = p.transactions.map((b64) => {
        const { message, signers, signatures: slots } = readTransaction(new Uint8Array(Buffer.from(b64, 'base64')));
        return Buffer.from(wireTransaction(message, signers.map((s, i) => (s === wallet.address ? wallet.sign(message) : slots[i])))).toString('base64');
      });
      view = await engine.complete(view.id, { prepareId: p.prepareId, signed });
    }
  }
  return { view, prompts };
}

async function main() {
  const genesis = await rpc.call('getGenesisHash');
  if (genesis !== DEVNET_GENESIS) throw new Error(`This RPC is not devnet (genesis ${genesis}).`);
  const creator = keypairFromSecret(Uint8Array.from(JSON.parse(await readFile(path.join(keyDir, 'test-creator.keypair.json'), 'utf8'))));
  result.creator = creator.address;
  const before = await rpc.balance(creator.address);
  result.creatorLamportsBefore = String(before);
  if (before < 100_000_000n) throw new Error(`test-creator holds ${before} lamports; this run needs about 0.06 SOL. Fund it from the devnet faucet (no other wallet is drained).`);

  const dir = path.join(kitRoot, '.gamesfun', 'devnet', 'launch-95-5', 'game');
  await rm(dir, { recursive: true, force: true });
  await mkdir(path.join(dir, 'assets'), { recursive: true });
  await writeFile(path.join(dir, 'index.html'), '<!doctype html><title>Five Lights</title>');
  await writeFile(path.join(dir, 'gamesfun.json'), `${JSON.stringify({ version: 1, network: 'devnet' }, null, 2)}\n`);
  await writeFile(path.join(dir, 'assets', 'icon.png'), png(250, 200, 40, 32, 32));

  const asked = await step('gamesfun web3 launch --pair SOL --buy (the CLI action): the pair, curve and buy are checked, a request is left', async () => {
    const r = await web3Action('launch', null, { game: dir, name: 'Five Lights', symbol: 'FIVE', picture: 'assets/icon.png', description: 'gamesfun-kit devnet proof: a launch with its own 95/5 config', pair: 'SOL', buy: BUY }, { kitRoot, env, from: 'cli' });
    return { says: r.text.split('\n')[0] };
  });
  if (!asked) return;
  const request = (await listRequests(kitRoot, dir)).find((r) => r.kind === 'launch');

  const engine = createFlowEngine();
  let launched = null;
  await step('the launch flow (two uploads, then the launch in one approval), signed by test-creator', async () => {
    const flow = engine.start(await launchFlow({ gameDir: dir, rpc, network }, request.input, creator.address));
    const { view, prompts } = await approveAll(engine, flow, creator);
    await removeRequest(kitRoot, request.id);
    if (view.error) throw new Error(view.error);
    launched = JSON.parse(await readFile(path.join(dir, 'gamesfun.json'), 'utf8')).token;
    return { lines: flow.lines, prompts, results: view.results, token: launched };
  });
  if (!launched) return;

  const signatures = launched.signatures ?? [launched.signature];
  result.launch = { mint: launched.mint, pool: launched.pool, config: launched.config, quoteMint: launched.quoteMint, signatures, explorer: signatures.map(tx) };

  await step('read back from chain with the kit’s reader: the config, the pool, the metadata', async () => {
    const [cfgAcc, poolAcc, metaAcc] = await rpc.accounts([launched.config, launched.pool, metadataAddress(launched.mint)]);
    const cfg = readPoolConfig(cfgAcc.data);
    const pool = readVirtualPool(poolAcc.data);
    const readBack = {
      configOwner: cfgAcc.owner,
      feeClaimer: cfg.feeClaimer,
      leftoverReceiver: cfg.leftoverReceiver,
      quoteMint: cfg.quoteMint,
      creatorTradingFeePercentage: cfg.creatorTradingFeePercentage,
      partnerPermanentLockedLiquidityPercentage: cfg.partnerPermanentLockedLiquidityPercentage,
      creatorPermanentLockedLiquidityPercentage: cfg.creatorPermanentLockedLiquidityPercentage,
      partnerLiquidityPercentage: cfg.partnerLiquidityPercentage,
      creatorLiquidityPercentage: cfg.creatorLiquidityPercentage,
      creatorMigrationFeePercentage: cfg.creatorMigrationFeePercentage,
      migratedCompoundingFeeBps: cfg.migratedCompoundingFeeBps,
      migrationQuoteThreshold: String(cfg.migrationQuoteThreshold),
      poolConfig: pool.config,
      poolCreator: pool.creator,
      poolBaseMint: pool.baseMint,
      metadataUri: parseMetaplexMetadata(metaAcc.data).uri,
    };
    const checks = {
      feeClaimerIsPartner: readBack.feeClaimer === network.launchpad.partner,
      leftoverReceiverIsPartner: readBack.leftoverReceiver === network.launchpad.partner,
      creatorTradingFeePercentageIs95: readBack.creatorTradingFeePercentage === 95,
      partnerPermanentLockedLiquidityPercentageIs5: readBack.partnerPermanentLockedLiquidityPercentage === 5,
      creatorPermanentLockedLiquidityPercentageIs95: readBack.creatorPermanentLockedLiquidityPercentage === 95,
      noMigrationFeeShareNoCompounding: readBack.creatorMigrationFeePercentage === 0 && readBack.migratedCompoundingFeeBps === 0,
      quoteIsSol: readBack.quoteMint === 'So11111111111111111111111111111111111111112',
      poolOnThisConfig: readBack.poolConfig === launched.config,
      poolCreatorIsTheWallet: readBack.poolCreator === creator.address,
      poolBaseMintIsTheToken: readBack.poolBaseMint === launched.mint,
      metadataIsTheUpload: readBack.metadataUri === launched.metadataUri,
    };
    result.readBack = readBack;
    return { checks, ok: Object.values(checks).every(Boolean) };
  });

  await step('the first buy got what the offline quote said, to the base unit', async () => {
    const params = curveParams(targetsForPair({ decimals: 9, usd: network.launchpad.pairPrices.So11111111111111111111111111111111111111112 }));
    const quote = quoteFirstBuy(params, BigInt(Math.round(Number(BUY) * 1e9)));
    const got = await rpc.tokenBalance(associatedTokenAddress(creator.address, launched.mint));
    return { quotedOut: String(quote.expectedOut), minimumOut: String(quote.minimumAmountOut), received: String(got), ok: got === quote.expectedOut };
  });

  result.creatorLamportsAfter = String(await rpc.balance(creator.address));
  result.spentLamports = String(before - BigInt(result.creatorLamportsAfter));
}

try {
  await main();
} catch (error) {
  result.steps.push({ name: 'run', ok: false, error: error.message });
  console.log(`✗ ${error.message}`);
}
result.finishedAt = new Date().toISOString();
result.ok = result.steps.length > 0 && result.steps.every((s) => s.ok);
await writeFile(out, `${JSON.stringify(result, (k, v) => (typeof v === 'bigint' ? v.toString() : v), 2)}\n`);
console.log(`${result.ok ? 'PASS' : 'FAIL'}: ${path.relative(kitRoot, out)}`);
