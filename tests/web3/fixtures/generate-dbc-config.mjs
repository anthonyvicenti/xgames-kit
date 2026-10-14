// Maintainers only: regenerates tests/web3/fixtures/dbc-config.json, which tests/web3-dbc-config.test.mjs holds the
// kit's launch builders to (builder/web3/gf-web3/chain/dbc.js createConfigInstruction, dbc-curve.js). The expected bytes come
// from games.fun's launchpad itself: launch/own-config.mjs prepareOwnConfig (with curve/params.mjs targetsForPair and
// curveParams, launch/first-buy.mjs quoteFirstBuy and @meteora-ag/dynamic-bonding-curve-sdk 1.5.12's
// createConfigAndPool / createConfigAndPoolWithFirstBuy), run against a stand-in connection (no network: a fixed
// blockhash, simulations that pass, the pair's mint as the only account that exists), with keys from fixed seeds.
// Recorded per case: the instructions as the SDK built them (`built`: each with its own account flags, before a
// transaction merges them), and the transactions prepareOwnConfig returned, decoded (`transactions`: flags as the
// compiled message carries them). Nothing is sent and no secret is read; the launchpad is only read (its own
// node_modules, never the kit's).
//
//   node tests/web3/fixtures/generate-dbc-config.mjs --launchpad <games.fun>/launchpad
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), []));
if (!args.launchpad) throw new Error('usage: --launchpad <games.fun>/launchpad');
const LP = path.resolve(args.launchpad);
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'dbc-config.json');
const require = createRequire(path.join(LP, 'package.json'));
const { Keypair, PublicKey, Transaction, VersionedTransaction, TransactionMessage, ComputeBudgetProgram } = require('@solana/web3.js');
const { TOKEN_PROGRAM_ID } = require('@solana/spl-token');
const { DynamicBondingCurveClient } = require('@meteora-ag/dynamic-bonding-curve-sdk');
const { prepareOwnConfig } = await import(pathToFileURL(path.join(LP, 'launch', 'own-config.mjs')).href);
const sdkVersion = JSON.parse(readFileSync(path.join(LP, 'node_modules', '@meteora-ag', 'dynamic-bonding-curve-sdk', 'package.json'), 'utf8')).version;

const PARTNER = '8yPDcNeKHwfSmyx9MPNpgqU8o1W4xiCHxzYty7w3rnNV';
const WSOL = 'So11111111111111111111111111111111111111112';
const USDC_DEV = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const BLOCKHASH = 'EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N';
const seeded = (label) => Keypair.fromSeed(createHash('sha256').update(`gamesfun-kit dbc-config fixture ${label}`).digest());
const hex = (b) => Buffer.from(b).toString('hex');
const ixJson = (ix) => ({ programId: ix.programId.toBase58(), keys: ix.keys.map((k) => ({ pubkey: k.pubkey.toBase58(), isSigner: k.isSigner, isWritable: k.isWritable })), data: hex(ix.data) });
const isBudget = (ix) => ix.programId.equals(ComputeBudgetProgram.programId);

/** A connection with nothing on it but the pair's mint (a classic SPL mint). */
function standIn(quoteMint) {
  return {
    async getLatestBlockhash() {
      return { blockhash: BLOCKHASH, lastValidBlockHeight: 1000 };
    },
    async simulateTransaction() {
      return { value: { err: null, logs: [], unitsConsumed: 0 } };
    },
    async getAccountInfo(key) {
      if (key.toBase58() !== quoteMint) return null;
      const data = Buffer.alloc(82);
      data[44] = 9;
      data[45] = 1;
      return { owner: TOKEN_PROGRAM_ID, data, lamports: 1_461_600, executable: false, rentEpoch: 0 };
    },
  };
}

/** The SDK client, with what its partner service builds recorded as built (before prepareOwnConfig compiles it). */
function recording(client, into) {
  const partner = client.partner;
  const keep = (tx) => into.push(...tx.instructions);
  return {
    ...client,
    partner: {
      createConfigAndPool: async (p) => {
        const tx = await partner.createConfigAndPool(p);
        keep(tx);
        return tx;
      },
      createConfigAndPoolWithFirstBuy: async (p) => {
        const r = await partner.createConfigAndPoolWithFirstBuy(p);
        keep(r.createConfigTx);
        keep(r.createPoolWithFirstBuyTx);
        return r;
      },
    },
  };
}

function decode(b64, version) {
  const bytes = Buffer.from(b64, 'base64');
  if (version === 'v0') {
    const tx = VersionedTransaction.deserialize(bytes);
    return TransactionMessage.decompile(tx.message).instructions;
  }
  return Transaction.from(bytes).instructions;
}

// Each case as the launchpad's prepare.mjs calls prepareOwnConfig: a pair from lib/pairs.mjs describePair, the
// creator's caps or none, and a parsed first buy (amountIn in the pair's base units) or none.
const CASES = [
  { id: 'sol-no-buy', pair: { mint: WSOL, symbol: 'SOL', decimals: 9, program: 'spl-token', native: true, usd: 100 }, caps: null, buy: null },
  { id: 'sol-first-buy', pair: { mint: WSOL, symbol: 'SOL', decimals: 9, program: 'spl-token', native: true, usd: 100 }, caps: null, buy: 10_000_000n },
  { id: 'usdc-first-buy', pair: { mint: USDC_DEV, symbol: 'USDC-dev', decimals: 6, program: 'spl-token', native: false, usd: 1 }, caps: null, buy: 25_000_000n },
  { id: 'unpriced-own-caps', pair: { mint: seeded('unpriced pair mint').publicKey.toBase58(), symbol: 'PAIR', decimals: 9, program: 'spl-token', native: false, usd: null }, caps: { initialMarketCap: 2_000_000, migrationMarketCap: 30_000_000 }, buy: null },
];

const commit = execFileSync('git', ['-C', LP, 'log', '-1', '--format=%h', '--', 'launch/own-config.mjs', 'curve/params.mjs', 'launch/first-buy.mjs', 'launch/split.mjs'], { encoding: 'utf8' }).trim();
const out = { source: { what: 'games.fun launchpad launch/own-config.mjs prepareOwnConfig (curve/params.mjs, launch/first-buy.mjs) with @meteora-ag/dynamic-bonding-curve-sdk', lastCommitOfThoseFiles: commit, sdkVersion, made: new Date().toISOString() }, partner: PARTNER, cases: [] };
for (const c of CASES) {
  const creator = seeded(`${c.id} creator`).publicKey;
  const configKeypair = seeded(`${c.id} config`);
  const mintKeypair = seeded(`${c.id} mint`);
  const connection = standIn(c.pair.mint);
  const input = { creatorWallet: creator.toBase58(), name: 'Five Lights', symbol: 'FIVE' };
  const uri = 'https://gateway.irys.xyz/FixtureMetadataId0000000000000000000000000';
  const built = [];
  const result = await prepareOwnConfig(
    { input, pair: { ...c.pair, meteora: { ok: true, reason: null } }, caps: c.caps, fb: c.buy ? { amountIn: c.buy, inputMint: null, slippageBps: 100 } : null, metadataUri: uri, mintKeypair },
    {
      connection,
      client: recording(new DynamicBondingCurveClient(connection, 'confirmed'), built),
      partner: PARTNER,
      launchTable: null,
      generateKeypair: () => configKeypair,
      checkBalance: async () => {},
      checkInputBalance: async () => {},
      now: () => 1_800_000_000,
    },
  );
  out.cases.push({
    id: c.id,
    input: { pair: c.pair, caps: c.caps, firstBuy: c.buy?.toString() ?? null, creator: creator.toBase58(), config: configKeypair.publicKey.toBase58(), mint: mintKeypair.publicKey.toBase58(), name: input.name, symbol: input.symbol, uri },
    launchpad: { config: result.config, pool: result.pool, quoteMint: result.quoteMint, targets: result.targets, threshold: result.curve.threshold, firstBuy: result.firstBuy, txVersion: result.txVersion, txCount: result.transactions.length },
    built: built.filter((ix) => !isBudget(ix)).map(ixJson),
    transactions: result.transactions.map((b64) => ({ instructions: decode(b64, result.txVersion).filter((ix) => !isBudget(ix)).map(ixJson), budget: decode(b64, result.txVersion).filter(isBudget).length })),
  });
  console.log(`${c.id}: ${result.transactions.length} transaction(s), ${result.txVersion}`);
}
writeFileSync(OUT, `${JSON.stringify(out, null, 1)}\n`);
console.log(`wrote ${path.relative(process.cwd(), OUT)}`);
