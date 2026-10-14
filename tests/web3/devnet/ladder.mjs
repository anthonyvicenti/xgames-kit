// K4's devnet proof: the level ladder (builder/web3/economy/fixtures/level-ladder.json: pay per attempt into a pool, the prize
// on the last level paid from the pool by the authority), decided by the local keeper.
//
//   1. Put live through the economy flow on the dev server's routes, test-creator approving (seeds at 1/100).
//   2. A fresh keeper key made with newKeeperKey (`gamesfun economy keeper --new-key`) in a temp folder outside the
//      repo, funded with a little SOL by test-creator; "Let my keeper decide" (flow kind "authority", test-creator).
//   3. The keeper runs (createKeeper + its loopback listener, as `gamesfun economy keeper` runs it).
//   4. test-buyer-1 pays three attempts through gf-web3's economy.pay, as the page that hosts the game does.
//   5. A stand-in for the game's host copy posts claims to POST /api/web3/economy/decide-request: one too early, the
//      real one (paid), the same attempt again (refused), one over the spec's limit (refused), one for a player who
//      never paid (refused), one with an invented attempt (refused).
//   6. "Take it back" (flow kind "authority", test-creator): the owner decides again, and the keeper is refused.
//   7. The keeper's leftover SOL goes back to test-creator; the temp key folder is deleted.
// Devnet only (genesis checked). Keys: the launchpad's key folder (LAUNCHPAD_KEY_DIR, default
// ~/.config/gamesfun-launchpad/devnet), read, never printed or copied. Result: tests/web3/devnet/ladder-result.json (LADDER_RESULT names another file in that folder).
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { addressBytes, encodeBase58 } from '../../../builder/web3/gf-web3/chain/base58.js';
import { fromBase64, randomBytes, toBase64, utf8 } from '../../../builder/web3/gf-web3/chain/bytes.js';
import { decodeLoot, LootAccount, lootPda } from '../../../builder/web3/gf-web3/chain/loot.js';
import { associatedTokenAddress, NATIVE_MINT } from '../../../builder/web3/gf-web3/chain/pda.js';
import { closeTokenAccount, transferLamports } from '../../../builder/web3/gf-web3/chain/programs.js';
import { compileMessage, readTransaction, signersOf, wireTransaction, withSignature } from '../../../builder/web3/gf-web3/chain/tx.js';
import { createGfWeb3 } from '../../../builder/web3/gf-web3/index.js';
import { explorerUrl, networkConfig } from '../../../builder/web3/gf-web3/network.js';
import { rpcClient } from '../../../builder/web3/gf-web3/rpc.js';
import { ledgerFile, readLedger } from '../../../builder/web3/node/decide.mjs';
import { DEVNET_GENESIS, readKeyFile } from '../../../builder/web3/node/economy-check.mjs';
import { createKeeper, newKeeperKey, readKeeperKey } from '../../../builder/web3/node/keeper.mjs';
import { post, request, serve } from '../helpers.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const kitRoot = path.resolve(here, '..', '..', '..');
const work = path.join(kitRoot, '.gamesfun', 'devnet', 'ladder');
const keyDir = process.env.LAUNCHPAD_KEY_DIR ?? path.join(homedir(), '.config', 'gamesfun-launchpad', 'devnet');
const keyFile = (role) => path.join(keyDir, `${role}.keypair.json`);
const network = networkConfig('devnet');
const rpcUrl = process.env.GF_DEVNET_RPC ?? network.rpcUrl;
const rpc = rpcClient(rpcUrl);
const LOW = 100_000_000n;
const KEEPER_FUND = 10_000_000n;
const resultFile = path.join(here, process.env.LADDER_RESULT ?? 'ladder-result.json');
const result = { network: 'devnet', program: network.loot.program, startedAt: new Date().toISOString(), fixture: 'builder/web3/economy/fixtures/level-ladder.json (seeds at 1/100)', steps: [] };
const tx = (s) => explorerUrl(network, 'tx', s);
const sol = (l) => Number(l) / 1e9;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function step(name, data = {}) {
  result.steps.push({ name, at: new Date().toISOString(), ok: data.ok !== false, ...data });
  console.log(`${data.ok === false ? '✗' : '✓'} ${name}${data.says ? `: ${data.says}` : ''}`);
  return data;
}

/** A Wallet Standard wallet backed by a key in this process (as economy-check.mjs's synthetic player). */
function memoryWallet(k, name) {
  const account = { address: k.address, publicKey: addressBytes(k.address), chains: ['solana:devnet'], features: [] };
  const sign = (wire) => {
    const { message, signers, signatures } = readTransaction(wire);
    return wireTransaction(message, signers.map((s, i) => (s === k.address ? k.sign(message) : signatures[i])));
  };
  return {
    version: '1.0.0', name, icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"/>', chains: ['solana:devnet'], accounts: [account],
    features: {
      'standard:connect': { version: '1.0.0', connect: async () => ({ accounts: [account] }) },
      'solana:signTransaction': { version: '1.0.0', supportedTransactionVersions: ['legacy', 0], signTransaction: async (...inputs) => inputs.map((i) => ({ signedTransaction: sign(i.transaction) })) },
    },
  };
}

/** The studio page's wallet, for the flow routes: signs what the server prepared. */
const pageWallet = (key) => ({
  address: key.address,
  signMessage: (text) => toBase64(key.sign(utf8(text))),
  signTransactions: (b64s) => b64s.map((b64) => toBase64(withSignature(fromBase64(b64), key.address, key.sign(readTransaction(fromBase64(b64)).message)))),
});

async function approveAll(port, flow, wallet) {
  let view = flow;
  const signatures = [];
  for (let guard = 0; !view.done && guard < 20; guard++) {
    const prepared = await post(port, '/flow/prepare', { flowId: view.id, wallet: wallet.address });
    if (prepared.status !== 200) throw new Error(`prepare: ${prepared.text}`);
    const p = prepared.json;
    const answer = p.kind === 'message' ? { signature: wallet.signMessage(p.text) } : { signed: wallet.signTransactions(p.transactions) };
    if (p.kind === 'transactions') for (const w of answer.signed) signatures.push(encodeBase58(readTransaction(fromBase64(w)).signatures[0]));
    const done = await post(port, '/flow/complete', { flowId: view.id, prepareId: p.prepareId, ...answer });
    if (done.status !== 200) throw new Error(`complete: ${done.text}`);
    view = done.json;
  }
  return { view, signatures };
}

async function sendAs(signer, instructions) {
  const { blockhash, lastValidBlockHeight } = await rpc.latestBlockhash();
  const message = compileMessage({ payer: signer.address, blockhash, instructions });
  const signature = await rpc.send(wireTransaction(message, signersOf(message).map(() => signer.sign(message))));
  await rpc.confirm(signature, { lastValidBlockHeight });
  return signature;
}

const tokenAmount = async (account) => rpc.tokenBalance(account);

async function main() {
  if ((await rpc.call('getGenesisHash', [])) !== DEVNET_GENESIS) throw new Error('Not devnet: refusing to run.');
  const creator = await readKeyFile(keyFile('test-creator'));
  const buyer = await readKeyFile(keyFile('test-buyer-1'));
  const stranger = (await readKeyFile(keyFile('test-buyer-2'))).address; // never pays in this game
  const before = { creator: await rpc.balance(creator.address), buyer: await rpc.balance(buyer.address) };
  result.wallets = { creator: creator.address, buyer: buyer.address, stranger };
  result.balancesBefore = Object.fromEntries(Object.entries(before).map(([k, v]) => [k, sol(v)]));
  const low = Object.entries(before).filter(([, v]) => v < LOW);
  if (low.length) throw new Error(`Under 0.1 SOL: ${low.map(([k, v]) => `${k} ${sol(v)}`).join(', ')}. Stopping.`);

  // 1. the game folder and the economy, live through the page's flow
  const gameDir = path.join(work, 'level-ladder');
  await rm(gameDir, { recursive: true, force: true });
  await mkdir(gameDir, { recursive: true });
  const economy = JSON.parse(await readFile(path.join(kitRoot, 'builder/web3/economy/fixtures/level-ladder.json'), 'utf8'));
  for (const p of economy.pools) if (p.seed) p.seed = Number((p.seed / 100).toFixed(9));
  await writeFile(path.join(gameDir, 'index.html'), '<!doctype html><title>Level ladder</title>');
  await writeFile(path.join(gameDir, 'gamesfun.json'), `${JSON.stringify({ version: 1, network: 'devnet', economy }, null, 2)}\n`);
  const server = await serve({ gameDir, kitRoot, env: { ...process.env, ...(process.env.GF_DEVNET_RPC ? { GAMESFUN_RPC_URL: process.env.GF_DEVNET_RPC } : {}) }, log: (t) => console.log(t) });
  const owner = pageWallet(creator);
  const configFile = path.join(gameDir, 'gamesfun.json');
  const readConfig = async () => JSON.parse(await readFile(configFile, 'utf8'));
  let keeper = null;
  let keeperKey = null;
  const away = await mkdtemp(path.join(tmpdir(), 'gf-ladder-keeper-'));
  try {
    const started = await post(server.port, '/flow/start', { kind: 'economy', wallet: creator.address });
    if (started.status !== 200) throw new Error(started.text);
    const live = await approveAll(server.port, started.json, owner);
    let config = await readConfig();
    const game = config.economy.live.game;
    step('put the level ladder live through the economy flow (test-creator approving; the prize pool seeded with 0.005 SOL)', { game, explorer: explorerUrl(network, 'address', game), signatures: live.signatures, links: live.signatures.map(tx) });
    const prizePool = lootPda.pool(game, 0);

    // 2. a keeper key outside the repo, funded; Let my keeper decide
    const made = await newKeeperKey(path.join(away, 'keeper.json'), { gameDir, kitRoot });
    keeperKey = (await readKeeperKey(made.file, { gameDir, kitRoot })).key;
    const funded = await sendAs(creator, [transferLamports(creator.address, keeperKey.address, KEEPER_FUND)]);
    step('make a fresh keeper key with newKeeperKey (`gamesfun economy keeper --new-key`) in a temp folder outside the repo, and fund it with 0.01 SOL from test-creator', { keeper: made.address, keyFileOutsideRepo: !made.file.startsWith(kitRoot), signature: funded, explorer: tx(funded) });
    const give = await post(server.port, '/flow/start', { kind: 'authority', wallet: creator.address, input: { authority: keeperKey.address } });
    if (give.status !== 200) throw new Error(give.text);
    const gave = await approveAll(server.port, give.json, owner);
    const gameAfter = decodeLoot(LootAccount.Game, (await rpc.account(game)).data);
    config = await readConfig();
    step('"Let my keeper decide": one update_game approved by test-creator', { ok: gameAfter.authority === keeperKey.address && config.economy.keys.authority === keeperKey.address, authorityOnChain: gameAfter.authority, specAuthority: config.economy.keys.authority, signatures: gave.signatures, links: gave.signatures.map(tx) });

    // 3. the keeper
    keeper = createKeeper({ gameDir, kitRoot, key: keeperKey, rpc, network, log: (t) => console.log(`  keeper: ${t}`) });
    const { url } = await keeper.listen();
    step('the keeper runs (loopback listener, as `gamesfun economy keeper --key` runs it)', { url });

    // 4. three attempts, paid through gf-web3's economy.pay
    const kit = createGfWeb3({
      config: { version: 1, network: 'devnet', economy: config.economy }, mock: false,
      location: { search: '', href: 'http://127.0.0.1/', host: '127.0.0.1', origin: 'http://127.0.0.1', pathname: '/' }, navigator: { webdriver: false, userAgent: 'node' },
      wallets: [memoryWallet(buyer, 'test-buyer-1')], rpc: rpcUrl,
    });
    await kit.connect();
    const poolBefore = await tokenAmount(prizePool);
    const attempts = [];
    for (let i = 0; i < 3; i++) {
      const r = await kit.economy.pay('attempt', { reference: randomBytes(32) });
      attempts.push(r.signatures[0]);
    }
    const poolAfterPays = await tokenAmount(prizePool);
    step('test-buyer-1 pays three attempts (0.01 SOL each, 80% into the prize pool) through gf-web3 economy.pay', { ok: poolAfterPays - poolBefore === 24_000_000n, attempts, links: attempts.map(tx), prizePool: { before: sol(poolBefore), after: sol(poolAfterPays) } });

    // 5. the stand-in game posts claims to the dev server, which hands them to the keeper
    const claim = async (name, body) => {
      const r = await post(server.port, '/economy/decide-request', { decision: 'ladder-prize', ...body });
      const answer = r.json ?? { error: r.text };
      return { name, request: body, decided: answer.decided ?? false, codes: (answer.refusals ?? []).map((x) => x.code), says: answer.says ?? null, text: answer.text ?? answer.error, signature: answer.signature ?? null, explorer: answer.explorer ?? null };
    };
    const claims = [];
    claims.push(await claim('too early: attempt 3, claimed at once (the spec says no one clears the ladder in under 20 s)', { id: 'run-3', to: buyer.address, attempt: attempts[2], says: 'cleared the last level' }));
    const paidTx = await rpc.call('getTransaction', [attempts[0], { commitment: 'confirmed', maxSupportedTransactionVersion: 0 }]);
    const wait = Math.max(0, (paidTx.blockTime + 25) * 1000 - Date.now());
    console.log(`  waiting ${Math.round(wait / 1000)} s for the 20 s floor`);
    await sleep(wait);
    const buyerWsol = associatedTokenAddress(buyer.address, NATIVE_MINT);
    const wsolBefore = await tokenAmount(buyerWsol);
    claims.push(await claim('the real one: test-buyer-1 cleared the last level on attempt 1', { id: 'run-1', to: buyer.address, attempt: attempts[0], says: 'cleared the last level' }));
    const wsolAfter = await tokenAmount(buyerWsol);
    claims.push(await claim('a duplicate: the same attempt reported again under another id', { id: 'run-1b', to: buyer.address, attempt: attempts[0], says: 'cleared the last level' }));
    claims.push(await claim('over the limit: attempt 2 claiming 0.05 SOL (the spec pays 0.02, caps.each 0.02)', { id: 'run-2', to: buyer.address, attempt: attempts[1], amount: '0.05', says: 'cleared the last level' }));
    claims.push(await claim('forged: test-buyer-2, who never paid, claims with test-buyer-1’s attempt 2', { id: 'run-x', to: stranger, attempt: attempts[1], says: 'cleared the last level' }));
    claims.push(await claim('forged: an invented attempt', { id: 'run-y', to: stranger, attempt: encodeBase58(randomBytes(64)), says: 'cleared the last level' }));
    const expect = [['D-PROOF-EARLY'], [], ['D-PROOF-USED'], ['D-AMOUNT', 'D-CAP-EACH'], ['D-PROOF-NOT-PAY'], ['D-PROOF-NOT-FOUND']];
    claims.forEach((c, i) => step(`claim: ${c.name}`, { ok: (i === 1 ? c.decided : !c.decided && expect[i].every((code) => c.codes.includes(code))), ...c, says: c.decided ? c.says : c.text }));
    step('only the real claim moved money: 0.02 SOL into test-buyer-1’s SOL token account', { ok: wsolAfter - wsolBefore === 20_000_000n, received: sol(wsolAfter - wsolBefore), prizePoolNow: sol(await tokenAmount(prizePool)) });
    // the player turns the wrapped SOL back into SOL (their own signature), so the run leaves no token account behind
    const unwrapped = await sendAs(buyer, [closeTokenAccount(buyerWsol, buyer.address, buyer.address)]);
    step('test-buyer-1 closes its SOL token account (the prize arrives as wrapped SOL)', { signature: unwrapped, explorer: tx(unwrapped) });

    // 6. take it back
    const back = await post(server.port, '/flow/start', { kind: 'authority', wallet: creator.address, input: { authority: 'owner' } });
    if (back.status !== 200) throw new Error(back.text);
    const took = await approveAll(server.port, back.json, owner);
    const gameBack = decodeLoot(LootAccount.Game, (await rpc.account(game)).data);
    config = await readConfig();
    step('"Take it back": one update_game approved by test-creator; the owner decides again', { ok: gameBack.authority === creator.address && config.economy.keys.authority === 'owner', authorityOnChain: gameBack.authority, specAuthority: config.economy.keys.authority, signatures: took.signatures, links: took.signatures.map(tx) });
    const refused = await claim('after Take it back: the keeper is refused', { id: 'run-2c', to: buyer.address, attempt: attempts[1] });
    step(`claim: ${refused.name}`, { ok: !refused.decided && refused.codes.includes('D-SIGNER'), ...refused, says: refused.text });
    const listed = await request(server.port, { path: '/api/web3/economy/decisions' });
    step('the Economy tab’s Decide section reads it back (GET /economy/decisions)', { authority: listed.json?.authority, keeperRunning: listed.json?.keeper?.running, recent: listed.json?.recent?.length });
    result.ledger = (await readLedger(ledgerFile(kitRoot, game))).map(({ at, decision, requestId, to, amount, symbol, attempt, verdict, reasons, signature, by }) => ({ at, decision, requestId, to, amount, symbol, attempt, verdict, reasons, signature, by }));
  } finally {
    if (keeper) await keeper.close();
    if (keeperKey) {
      const left = await rpc.balance(keeperKey.address).catch(() => 0n);
      if (left > 5_000n) {
        const back = await sendAs(keeperKey, [transferLamports(keeperKey.address, creator.address, left - 5_000n)]).catch((e) => step('return the keeper’s SOL', { ok: false, error: e.message }));
        if (typeof back === 'string') step('the keeper’s leftover SOL goes back to test-creator', { returned: sol(left - 5_000n), signature: back, explorer: tx(back) });
      }
    }
    await rm(away, { recursive: true, force: true });
    step('the temp folder with the keeper key is deleted', { deleted: true });
    await server.close();
  }
  result.balancesAfter = { creator: sol(await rpc.balance(creator.address)), buyer: sol(await rpc.balance(buyer.address)) };
  result.finishedAt = new Date().toISOString();
  result.verdict = result.steps.every((s) => s.ok) ? 'ok' : 'problems';
}

try {
  await main();
} catch (error) {
  step('run', { ok: false, error: error.message, logs: error.logs?.slice(-12) });
  result.verdict = 'problems';
}
await writeFile(resultFile, `${JSON.stringify(result, (k, v) => (typeof v === 'bigint' ? v.toString() : v), 2)}\n`);
console.log(`${result.verdict}: ${path.relative(process.cwd(), resultFile)}`);
process.exit(result.verdict === 'ok' ? 0 : 1);
