#!/usr/bin/env node
// The live stage of the economy evals: economies an agent wrote in a run (run.mjs) go live on devnet through the same
// economy flow the studio's Economy tab drives (builder/web3/node/flows.mjs economyFlow on the flow engine: the server
// prepares, the wallet approves, the server checks and sends), then `gamesfun economy status` reads each back from
// the case's own kit copy. A local test key stands in for the creator's wallet, as in tests/web3/devnet/economies.mjs;
// in the product the creator's own wallet approves in the page.
//
//   GF_DEVNET_CREATOR_KEY=<keypair file> node builder/web3/economy/evals/live.mjs --out <run folder> --case <id,id,id>
//        [--seed-scale 0.01] [--result <file>]
//
// Seeds in SOL go in at --seed-scale (default 1/100); the economy is otherwise the agent's, as it saved it. The key
// is read from the file the variable names, never printed or written. Devnet only (checks the genesis hash).
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readTransaction, wireTransaction } from '../../gf-web3/chain/tx.js';
import { explorerUrl, networkConfig } from '../../gf-web3/network.js';
import { rpcClient } from '../../gf-web3/rpc.js';
import { economyStatus } from '../../node/economy.mjs';
import { keypairFromSecret } from '../../node/ed25519.mjs';
import { createFlowEngine } from '../../node/flow-engine.mjs';
import { economyFlow } from '../../node/flows.mjs';

const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const MIN_LAMPORTS = 100_000_000n; // stop under 0.1 SOL rather than use another key
const network = networkConfig('devnet');
const rpc = rpcClient(process.env.GF_DEVNET_RPC ?? network.rpcUrl);
const args = process.argv.slice(2);
const value = (name, d) => (args.includes(name) ? args[args.indexOf(name) + 1] : d);

/** Answers every step of a flow with `wallet`, as the studio page does with the person's wallet. */
async function approveAll(engine, flow, wallet) {
  let view = flow;
  let walletSteps = 0; // each a wallet approval in the page: a message to sign (a picture upload) or transactions
  while (!view.done) {
    const p = await engine.prepare(view.id, wallet.address);
    walletSteps += 1;
    if (p.kind === 'message') {
      view = await engine.complete(view.id, { prepareId: p.prepareId, signature: Buffer.from(wallet.sign(new TextEncoder().encode(p.text))).toString('base64') });
    } else {
      const signed = p.transactions.map((b64) => {
        const { message, signers, signatures } = readTransaction(new Uint8Array(Buffer.from(b64, 'base64')));
        return Buffer.from(wireTransaction(message, signers.map((s, i) => (s === wallet.address ? wallet.sign(message) : signatures[i])))).toString('base64');
      });
      view = await engine.complete(view.id, { prepareId: p.prepareId, signed });
    }
  }
  return { view, walletSteps };
}

/** SOL seeds scaled down; returns what went in. */
function scaleSeeds(economy, scale) {
  const seeds = [];
  for (const p of economy.pools ?? []) {
    if (!(Number(p.seed ?? 0) > 0)) continue;
    const t = economy.tokens.find((x) => x.key === p.currency);
    const was = p.seed;
    if (t?.source === 'sol') p.seed = Number((Number(p.seed) * scale).toFixed(9));
    seeds.push({ pool: p.key, spec: was, wentIn: p.seed });
  }
  return seeds;
}

async function goLive(out, id, creator, scale) {
  const kit = path.join(out, id, 'kit');
  const gameDir = path.join(kit, 'games', id);
  const file = path.join(gameDir, 'gamesfun.json');
  const config = JSON.parse(await readFile(file, 'utf8'));
  if (!config.economy) throw new Error(`${id}: the agent saved no economy`);
  const seeds = scaleSeeds(config.economy, scale);
  await writeFile(file, `${JSON.stringify(config, null, 2)}\n`);
  const before = await rpc.balance(creator.address);
  const engine = createFlowEngine();
  const flow = engine.start(await economyFlow({ gameDir, rpc, network }, creator.address, { picture: 'assets/sprites/coin.png', description: `${config.economy.name ?? id}: a games.fun kit eval (devnet)` }));
  const { view, walletSteps } = await approveAll(engine, flow, creator);
  const after = JSON.parse(await readFile(file, 'utf8'));
  const live = after.economy.live ?? {};
  const status = await economyStatus(gameDir, { rpc, network, receipts: 0 });
  // The kit's own command, as the creator would run it.
  const cli = execFileSync(process.execPath, ['bin/gamesfun.mjs', 'economy', 'status', `games/${id}`], { cwd: kit, encoding: 'utf8', env: { ...process.env, GAMESFUN_NO_UPDATE_CHECK: '1' } });
  const parts = status.parts.length, onChain = status.parts.filter((p) => p.onChain && !p.differs).length;
  return {
    id,
    ok: Boolean(status.live) && parts === onChain,
    game: live.game,
    explorer: live.game ? explorerUrl(network, 'address', live.game) : null,
    walletSteps,
    signatures: (live.transactions ?? []).map((t) => t.signature),
    seeds,
    parts, onChain,
    pools: status.pools.map((p) => ({ key: p.key, amount: p.amount, symbol: p.symbol })),
    lamportsSpent: String(before - (await rpc.balance(creator.address))),
    results: view.results,
    status: cli.trim().split('\n'),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = value('--out') && path.resolve(value('--out'));
  const ids = value('--case')?.split(',').filter(Boolean);
  if (!out || !ids?.length) {
    console.error('Usage: GF_DEVNET_CREATOR_KEY=<file> node web3/economy/evals/live.mjs --out <run folder> --case <id,id> [--seed-scale 0.01] [--result <file>]');
    process.exit(2);
  }
  const genesis = await rpc.call('getGenesisHash');
  if (genesis !== DEVNET_GENESIS) throw new Error(`This RPC is not devnet (genesis ${genesis}).`);
  const keyFile = process.env.GF_DEVNET_CREATOR_KEY;
  if (!keyFile) throw new Error('Set GF_DEVNET_CREATOR_KEY to the path of a devnet keypair file.');
  const creator = keypairFromSecret(Uint8Array.from(JSON.parse(await readFile(keyFile, 'utf8'))));
  const scale = Number(value('--seed-scale', 0.01));
  const result = { network: 'devnet', program: network.loot.program, creator: creator.address, seedScale: scale, startedAt: new Date().toISOString(), cases: [] };
  for (const id of ids) {
    const balance = await rpc.balance(creator.address);
    if (balance < MIN_LAMPORTS) { result.cases.push({ id, ok: false, error: `stopped: the creator wallet holds ${balance} lamports` }); break; }
    try {
      const r = await goLive(out, id, creator, scale);
      result.cases.push(r);
      console.log(`${r.ok ? '✓' : '✗'} ${id}: ${r.onChain}/${r.parts} parts on chain as the spec says, ${r.signatures.length} transactions, ${r.lamportsSpent} lamports`);
    } catch (e) {
      result.cases.push({ id, ok: false, error: e.message, logs: e.logs?.slice(-14) });
      console.log(`✗ ${id}: ${e.message}`);
    }
  }
  result.creatorLamportsLeft = String(await rpc.balance(creator.address));
  const file = path.resolve(value('--result', path.join(out, 'live.json')));
  await writeFile(file, `${JSON.stringify(result, null, 2)}\n`);
  console.log(`written ${file}`);
}
