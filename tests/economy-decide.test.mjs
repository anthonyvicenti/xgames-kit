// K4's decisions, offline on the fake chain: the decision builder (decide.mjs) and its checks, the page's flows
// ("decide", "authority": Let my keeper decide / Take it back), the local keeper (its key file, its rules, its ledger,
// its loopback listener behind the dev server's POST /economy/decide-request), the level ladder fixture, the CLI's
// decide and the Economy tab's link. A request is a claim: the keeper pays only a real, unclaimed, old-enough attempt by
// the receiver, within the spec's caps; a forged claim, a duplicate and an over-limit one are refused in plain words.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { encodeBase58 } from '../builder/web3/gf-web3/chain/base58.js';
import { fromBase64, randomBytes, toBase64, utf8 } from '../builder/web3/gf-web3/chain/bytes.js';
import { decodeLoot, LootAccount, lootPda, payIx, shareAccounts } from '../builder/web3/gf-web3/chain/loot.js';
import { associatedTokenAddress, NATIVE_MINT, TOKEN_PROGRAM } from '../builder/web3/gf-web3/chain/pda.js';
import { compileMessage, readTransaction, signersOf, wireTransaction, withSignature } from '../builder/web3/gf-web3/chain/tx.js';
import { sharesFor } from '../builder/web3/gf-web3/econ/play.js';
import { readEconomy as readSpec } from '../builder/web3/gf-web3/econ/spec.js';
import { networkConfig } from '../builder/web3/gf-web3/network.js';
import { rpcClient } from '../builder/web3/gf-web3/rpc.js';
import { check } from '../builder/web3/economy/check.mjs';
import { compile } from '../builder/web3/economy/compile.mjs';
import { simulate } from '../builder/web3/economy/simulate.mjs';
import { decisionsOf, ledgerFile, linkParams, readLedger, readRequest } from '../builder/web3/node/decide.mjs';
import { publishPlan } from '../builder/web3/node/economy.mjs';
import { freshKeypair } from '../builder/web3/node/ed25519.mjs';
import { createKeeper, keyPlaceProblem, newKeeperKey, readKeeperKey } from '../builder/web3/node/keeper.mjs';
import { linkAsks } from '../builder/studio/tabs/economy.js';
import { fixture, NOW } from './economy/helpers.mjs';
import { fakeChain } from './web3/fake-chain.mjs';
import { makeGame, post, request, serve } from './web3/helpers.mjs';

const SOL = 1_000_000_000n;
const network = networkConfig('devnet');

function testWallet(key = freshKeypair()) {
  return {
    key,
    address: key.address,
    signMessage: (text) => toBase64(key.sign(utf8(text))),
    signTransactions: (b64s) => b64s.map((b64) => toBase64(withSignature(fromBase64(b64), key.address, key.sign(readTransaction(fromBase64(b64)).message)))),
  };
}

async function approveAll(port, flow, wallet) {
  let view = flow;
  for (let guard = 0; !view.done && guard < 20; guard++) {
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

const readJsonFile = async (file) => JSON.parse(await readFile(file, 'utf8'));
const codes = (r) => (r.refusals ?? []).map((x) => x.code);

describe('a decision request', () => {
  it('takes the shapes the page, the CLI, the agent and the game send', () => {
    const to = freshKeypair().address;
    const sig = encodeBase58(randomBytes(64));
    assert.deepEqual(readRequest({ decision: 'ladder-prize', to, attempt: sig, id: 'run-1', amount: 0.02, says: 'cleared  level 5' }), { decision: 'ladder-prize', id: 'run-1', to, amount: '0.02', attempt: sig, says: 'cleared level 5' });
    assert.deepEqual(readRequest({ decide: 'contest:duel', side: '1' }), { decision: 'contest:duel', side: 1 });
    assert.deepEqual(readRequest({ decision: 'contest:duel', open: '1' }), { decision: 'contest:duel', open: true });
    assert.throws(() => readRequest({ decision: 'Bad Key' }), /Name the decision/);
    assert.throws(() => readRequest({ decision: 'x', to: 'not-an-address' }), /public address/);
    assert.throws(() => readRequest({ decision: 'x', amount: '-1' }), /whole units/);
    assert.throws(() => readRequest({ decision: 'x', attempt: 'abc' }), /signature of the transaction/);
  });

  it('refuses a private key wherever it is put, the attempt included (a key and a signature are both 64 bytes)', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'gf-key-'));
    try {
      const made = await newKeeperKey(path.join(dir, 'k.json'));
      const secret = Uint8Array.from(await readJsonFile(made.file));
      assert.throws(() => readRequest({ decision: 'x', attempt: encodeBase58(secret) }), /private key, not a transaction/);
      assert.throws(() => readRequest({ decision: 'x', to: encodeBase58(secret) }), /private key/);
      assert.throws(() => readRequest({ decision: 'x', says: JSON.stringify([...secret]) }), /private key/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('links to the Economy tab with every field the card reads back', () => {
    const to = freshKeypair().address;
    const params = linkParams(readRequest({ decision: 'contest:duel', side: 1, open: false, to, id: 'm-3' }));
    const asked = linkAsks(`#economy?${new URLSearchParams(params)}`);
    assert.deepEqual(asked, { kind: 'decide', key: 'contest:duel', values: { to, side: '1', id: 'm-3' } });
    assert.deepEqual(linkAsks('#economy?decide=contest%3Aduel&open=1').values, { open: '1' });
  });
});

describe('the spec’s decision rules (check.mjs)', () => {
  const ladder = () => fixture('level-ladder');
  it('the level ladder checks, simulates and compiles', () => {
    const verdict = check(ladder());
    assert.equal(verdict.ok, true, JSON.stringify(verdict.refusals));
    assert.ok(!verdict.warnings.some((w) => w.code === 'W-KEEPER-PROOF'));
    const sim = simulate(ladder(), { now: NOW });
    const prize = sim.pools.find((p) => p.key === 'prize');
    assert.ok(prize.inPerDay > prize.outPerDay, 'the attempts fill the prize faster than the keeper pays it');
    const plan = compile(ladder(), { now: NOW });
    assert.equal(plan.ok, true);
    assert.ok(plan.play.some((s) => s.ix === 'payout' && s.signer === 'authority'));
  });
  it('a keeper payout needs caps; without proof it is warned that anyone can claim it', () => {
    const noCaps = ladder();
    delete noCaps.decisions[0].caps;
    assert.ok(check(noCaps).refusals.some((r) => r.code === 'E-KEEPER-CAPS'));
    const noProof = ladder();
    delete noProof.decisions[0].proof;
    const v = check(noProof);
    assert.equal(v.ok, true);
    assert.match(v.warnings.find((w) => w.code === 'W-KEEPER-PROOF').message, /browser console/);
    const over = ladder();
    over.decisions[0].caps.each = 0.01;
    assert.ok(check(over).refusals.some((r) => r.code === 'E-CAPS'));
    const wrong = ladder();
    wrong.decisions[0].proof.payment = 'nope';
    assert.ok(check(wrong).refusals.some((r) => r.code === 'E-REF' && /proof/.test(r.field ?? r.path ?? JSON.stringify(r))));
  });
  it('lists what the authority can decide', () => {
    const d = decisionsOf(fixture('duel-arena'));
    assert.deepEqual(d.map((x) => x.key), ['open-duel', 'duel-result', 'mission-end', 'mission-loot', 'contest:duel', 'hold:mission']);
    const l = decisionsOf(ladder())[0];
    assert.equal(l.signedBy, 'keeper');
    assert.deepEqual(l.caps, { each: 0.02, perPlayerPerDay: 0.04, perDay: 0.2 });
  });
});

describe('the keeper’s key file', () => {
  it('is written 0600 outside the game and the kit, never overwritten, and only its address is returned', async () => {
    const game = await makeGame();
    const away = await mkdtemp(path.join(tmpdir(), 'gf-keeper-'));
    try {
      await assert.rejects(() => newKeeperKey(path.join(game.gameDir, 'keeper.json'), { gameDir: game.gameDir, kitRoot: game.kitRoot }), /inside the game’s folder/);
      await assert.rejects(() => newKeeperKey(path.join(game.kitRoot, 'keys', 'k.json'), { gameDir: game.gameDir, kitRoot: game.kitRoot }), /inside the kit’s folder/);
      assert.match(keyPlaceProblem(path.join(process.cwd(), 'x.json'), {}), /git repository/);
      const file = path.join(away, 'keeper.json');
      const made = await newKeeperKey(file, { gameDir: game.gameDir, kitRoot: game.kitRoot });
      assert.deepEqual(Object.keys(made).sort(), ['address', 'file']);
      if (process.platform !== 'win32') assert.equal((await stat(file)).mode & 0o777, 0o600);
      const { key, warnings } = await readKeeperKey(file, { gameDir: game.gameDir, kitRoot: game.kitRoot });
      assert.equal(key.address, made.address);
      assert.deepEqual(warnings, []);
      await assert.rejects(() => newKeeperKey(file), /already exists/);
      await assert.rejects(() => readKeeperKey(path.join(game.gameDir, 'k.json'), { gameDir: game.gameDir, kitRoot: game.kitRoot }), /inside the game’s folder/);
    } finally {
      await rm(away, { recursive: true, force: true });
      await rm(game.root, { recursive: true, force: true });
    }
  });
});

describe('the level ladder, decided (offline)', () => {
  const cleanups = [];
  after(async () => {
    for (const c of cleanups.reverse()) await c();
  });

  it('puts it live, hands it to the keeper, pays one real claim and refuses the rest, then takes it back and signs from the page', async () => {
    const game = await makeGame({ config: { version: 1, network: 'devnet', economy: fixture('level-ladder') } });
    cleanups.push(() => rm(game.root, { recursive: true, force: true }));
    const chain = fakeChain();
    const server = await serve({ gameDir: game.gameDir, kitRoot: game.kitRoot, fetchImpl: chain.fetchImpl, env: {}, log: () => {} });
    cleanups.push(() => server.close());
    const rpc = rpcClient('http://fake.rpc/', { fetchImpl: chain.fetchImpl });
    const owner = testWallet();
    const configFile = path.join(game.gameDir, 'gamesfun.json');

    // 1. Live, through the page's flow; the fake chain does not move a deposit, so the pool is given 0.05 SOL here.
    const live = await post(server.port, '/flow/start', { kind: 'economy', wallet: owner.address });
    assert.equal(live.status, 200, live.text);
    assert.equal((await approveAll(server.port, live.json, owner)).done, true);
    const economy = (await readJsonFile(configFile)).economy;
    const gameAddress = economy.live.game;
    const prizePool = lootPda.pool(gameAddress, 0);
    chain.setTokenAmount(prizePool, 50_000_000n, NATIVE_MINT);

    // 2. A keeper key, made outside the game; "Let my keeper decide" is one owner approval.
    const away = await mkdtemp(path.join(tmpdir(), 'gf-keeper-'));
    cleanups.push(() => rm(away, { recursive: true, force: true }));
    const made = await newKeeperKey(path.join(away, 'keeper.json'), { gameDir: game.gameDir, kitRoot: game.kitRoot });
    const { key } = await readKeeperKey(made.file, { gameDir: game.gameDir, kitRoot: game.kitRoot });
    const notOwner = await post(server.port, '/flow/start', { kind: 'authority', wallet: freshKeypair().address, input: { authority: key.address } });
    assert.equal(notOwner.status, 400);
    assert.match(notOwner.json.error, /Only the game’s owner/);
    const give = await post(server.port, '/flow/start', { kind: 'authority', wallet: owner.address, input: { authority: key.address } });
    assert.equal(give.status, 200, give.text);
    assert.match(give.json.title, /Let .* decide for this game/);
    assert.equal((await approveAll(server.port, give.json, owner)).done, true);
    const gameNow = async () => decodeLoot(LootAccount.Game, (await rpc.account(gameAddress)).data);
    assert.equal((await gameNow()).authority, key.address);
    let config = await readJsonFile(configFile);
    assert.equal(config.economy.keys.authority, key.address, 'the spec says it too');
    assert.equal(config.economy.live.published.keys.authority, key.address);
    assert.equal(publishPlan(config.economy).plan.transactions.length, 0, 'the next publish does not undo it');

    // 3. A player pays three attempts, as gf-web3's economy.pay does.
    const player = freshKeypair();
    const stranger = freshKeypair();
    const e = readSpec(economy);
    const shares = sharesFor(e.part('payment', 'attempt').split, e);
    const treasury = (await gameNow()).treasury;
    const send = async (signer, instructions) => {
      const { blockhash } = await rpc.latestBlockhash();
      const message = compileMessage({ payer: signer.address, blockhash, instructions });
      return rpc.send(wireTransaction(message, signersOf(message).map(() => signer.sign(message))));
    };
    const attempt = (who = player, s = shares, amount = 10_000_000n) => send(who, [payIx({ player: who.address, game: gameAddress, mint: NATIVE_MINT, treasury, amount, shares: s, reference: randomBytes(32), tokenProgram: TOKEN_PROGRAM, remaining: shareAccounts(gameAddress, s) })]);
    // They were paid two minutes ago (the fake chain's clock), so the page's checks, on the real clock, see them as old enough.
    chain.now = Math.floor(Date.now() / 1000) - 120;
    const paidAt = chain.now;
    const paid = [await attempt(), await attempt(), await attempt()];
    assert.equal(chain.tokenAmount(prizePool), 50_000_000n + 3n * 8_000_000n, '80% of each attempt is in the prize pool');
    const selfSplit = await attempt(stranger, [{ to: { Account: [associatedTokenAddress(stranger.address, NATIVE_MINT)] }, bps: 10_000 }]);

    // 4. The keeper, behind the dev server's route. No keeper yet: the route says how to start one.
    const none = await post(server.port, '/economy/decide-request', { decision: 'ladder-prize', to: player.address, attempt: paid[0] });
    assert.equal(none.status, 409);
    assert.match(none.json.error, /No keeper is running/);
    let clock = paidAt;
    const keeper = createKeeper({ gameDir: game.gameDir, kitRoot: game.kitRoot, key, rpc, network, now: () => clock });
    await keeper.listen();
    cleanups.push(() => keeper.close());
    const claim = (body) => post(server.port, '/economy/decide-request', { decision: 'ladder-prize', ...body }).then((r) => (assert.equal(r.status, 200, r.text), r.json));

    const early = await claim({ id: 'run-1', to: player.address, attempt: paid[0], says: 'cleared the last level' });
    assert.deepEqual(codes(early), ['D-PROOF-EARLY'], early.text);
    assert.match(early.text, /no one gets there in under 20 seconds/);
    clock = paidAt + 30;
    const good = await claim({ id: 'run-1', to: player.address, attempt: paid[0], says: 'cleared the last level' });
    assert.equal(good.decided, true, good.text);
    assert.match(good.says, /^Pay 0\.02 SOL from the pool “prize” to /);
    const playerWsol = associatedTokenAddress(player.address, NATIVE_MINT);
    assert.equal(chain.tokenAmount(playerWsol), 20_000_000n);
    const duplicate = await claim({ id: 'run-1-again', to: player.address, attempt: paid[0], says: 'cleared the last level' });
    assert.deepEqual(codes(duplicate), ['D-PROOF-USED'], duplicate.text);
    const sameId = await claim({ id: 'run-1', to: player.address, attempt: paid[0] });
    assert.ok(codes(sameId).includes('D-SAME-ID'));
    const over = await claim({ id: 'run-2', to: player.address, attempt: paid[1], amount: '0.05' });
    assert.ok(codes(over).includes('D-AMOUNT') && codes(over).includes('D-CAP-EACH'), over.text);
    const forged = await claim({ id: 'run-x', to: stranger.address, attempt: paid[1], says: 'cleared the last level' });
    assert.deepEqual(codes(forged), ['D-PROOF-NOT-PAY'], forged.text);
    assert.match(forged.text, /it was paid by .*, not by/);
    const invented = await claim({ id: 'run-y', to: stranger.address, attempt: encodeBase58(randomBytes(64)) });
    assert.deepEqual(codes(invented), ['D-PROOF-NOT-FOUND']);
    const ownSplit = await claim({ id: 'run-z', to: stranger.address, attempt: selfSplit });
    assert.deepEqual(codes(ownSplit), ['D-PROOF-NOT-PAY']);
    assert.match(ownSplit.text, /split its own way/);
    const notKeepers = await keeper.decide({ decision: 'contest:nope' });
    assert.ok(codes(notKeepers).includes('D-UNKNOWN'));
    assert.equal(chain.tokenAmount(playerWsol), 20_000_000n, 'only the one real claim was paid');

    const ledger = await readLedger(ledgerFile(game.kitRoot, gameAddress));
    assert.deepEqual(ledger.map((x) => x.verdict), ['refused', 'done', 'refused', 'refused', 'refused', 'refused', 'refused', 'refused', 'refused']);
    assert.equal(ledger[1].attempt, paid[0]);
    assert.ok(chain.sent.includes(ledger[1].signature), 'the ledger names the payout that landed');
    const ledgerText = await readFile(ledgerFile(game.kitRoot, gameAddress), 'utf8');
    const secret = await readFile(made.file, 'utf8');
    assert.ok(!ledgerText.includes(secret.trim()) && !ledgerText.includes(encodeBase58(Uint8Array.from(JSON.parse(secret)))), 'no key in the ledger');

    // 5. The page lists it: the decisions, who decides, the latest lines.
    const listed = await request(server.port, { path: '/api/web3/economy/decisions' });
    assert.equal(listed.status, 200, listed.text);
    assert.equal(listed.json.authority, key.address);
    assert.equal(listed.json.keeper.running, true);
    assert.equal(listed.json.keeper.token, undefined, 'the keeper’s token never reaches the page');
    assert.equal(listed.json.recent[0].verdict, 'refused');

    // 6. Take it back: the keeper's next request is refused, the page signs again.
    const back = await post(server.port, '/flow/start', { kind: 'authority', wallet: owner.address, input: { authority: 'owner' } });
    assert.equal((await approveAll(server.port, back.json, owner)).done, true);
    assert.equal((await gameNow()).authority, owner.address);
    config = await readJsonFile(configFile);
    assert.equal(config.economy.keys.authority, 'owner');
    clock = Math.floor(Date.now() / 1000);
    const afterBack = await claim({ id: 'run-2', to: player.address, attempt: paid[1] });
    assert.ok(codes(afterBack).includes('D-SIGNER'), afterBack.text);

    const checked = await post(server.port, '/economy/decide/check', { request: { decision: 'ladder-prize', to: player.address, attempt: paid[1], id: 'run-2' }, wallet: owner.address });
    assert.equal(checked.status, 200, checked.text);
    assert.equal(checked.json.ok, true, JSON.stringify(checked.json.refusals));
    assert.ok(checked.json.numbers.some(([k]) => k === 'Amount'));
    const decided = await post(server.port, '/flow/start', { kind: 'decide', wallet: owner.address, input: { decision: 'ladder-prize', to: player.address, attempt: paid[1], id: 'run-2' } });
    assert.equal(decided.status, 200, decided.text);
    assert.equal(decided.json.kind, 'decide');
    const view = await approveAll(server.port, decided.json, owner);
    assert.equal(view.done, true, view.error);
    assert.equal(chain.tokenAmount(playerWsol), 40_000_000n);
    const capped = await post(server.port, '/flow/start', { kind: 'decide', wallet: owner.address, input: { decision: 'ladder-prize', to: player.address, attempt: paid[2], id: 'run-3' } });
    assert.equal(capped.status, 400);
    assert.match(capped.json.error, /already got 0\.04 SOL from it in the last 24 hours/);
    const last = (await readLedger(ledgerFile(game.kitRoot, gameAddress))).at(-1);
    assert.equal(last.by, 'page');
    assert.equal(last.verdict, 'done');
  });
});
