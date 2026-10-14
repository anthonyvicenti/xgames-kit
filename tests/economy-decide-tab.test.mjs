// The Economy tab's decisions in the real studio, in Chrome, on the offline fake chain (no stubs: the routes, the flow
// engine and the decision builder are the real ones). A live level ladder; a player paid an attempt; the link
// economy_decide returns opens the decision card with its checks; "Sign in my wallet" pays the prize through the
// injected wallet; the same attempt again is refused on the card; "Let my keeper decide" hands the decisions to a key.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from '../builder/web3/gf-web3/chain/bytes.js';
import { decodeLoot, LootAccount, lootPda, payIx, shareAccounts } from '../builder/web3/gf-web3/chain/loot.js';
import { associatedTokenAddress, NATIVE_MINT, TOKEN_PROGRAM } from '../builder/web3/gf-web3/chain/pda.js';
import { compileMessage, readTransaction, signersOf, wireTransaction, withSignature } from '../builder/web3/gf-web3/chain/tx.js';
import { fromBase64, toBase64, utf8 } from '../builder/web3/gf-web3/chain/bytes.js';
import { sharesFor } from '../builder/web3/gf-web3/econ/play.js';
import { readEconomy as readSpec } from '../builder/web3/gf-web3/econ/spec.js';
import { rpcClient } from '../builder/web3/gf-web3/rpc.js';
import { freshKeypair } from '../builder/web3/node/ed25519.mjs';
import { startDevServer } from '../builder/server/index.mjs';
import { findChrome } from '../builder/lib/chrome.mjs';
import { fixture } from './economy/helpers.mjs';
import { fakeChain } from './web3/fake-chain.mjs';
import { injectWallet } from './web3/inject-wallet.mjs';
import { makeGame, post } from './web3/helpers.mjs';

let chromium = null;
try {
  ({ chromium } = await import('playwright-core'));
} catch {}

async function launch() {
  const found = findChrome();
  for (const options of [found ? { executablePath: found.path } : null, {}].filter(Boolean)) {
    try {
      return await chromium.launch({ headless: true, ...options });
    } catch {}
  }
  return null;
}

function useFakeChain(chain) {
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url instanceof Request ? url.url : url);
    if (u.startsWith('https://devnet.irys.xyz')) return chain.fetchImpl(u, init);
    if (init?.method === 'POST' && typeof init.body === 'string' && init.body.includes('"jsonrpc"')) return chain.fetchImpl(u, init);
    return real(url, init);
  };
  return () => (globalThis.fetch = real);
}

describe('the Economy tab’s decisions, in Chrome (fake chain)', { skip: !chromium && 'playwright-core is not installed' }, () => {
  let browser;
  let server;
  let game;
  let chain;
  let page;
  let restore;
  let port;
  const owner = freshKeypair();
  const player = freshKeypair();
  const paid = [];
  const signed = [];
  let gameAddress;
  const tab = () => page.locator('.panel:not([hidden]) [data-testid="tab-economy"]');
  const rpc = () => rpcClient('http://fake.rpc/', { fetchImpl: chain.fetchImpl });
  const pageWallet = { address: owner.address, signMessage: (t) => toBase64(owner.sign(utf8(t))), signTransactions: (b64s) => b64s.map((b) => toBase64(withSignature(fromBase64(b), owner.address, owner.sign(readTransaction(fromBase64(b)).message)))) };

  before(async () => {
    browser = await launch();
    if (!browser) return;
    game = await makeGame({ config: { version: 1, network: 'devnet', economy: fixture('level-ladder') } });
    chain = fakeChain();
    restore = useFakeChain(chain);
    process.env.GAMESFUN_WEB3 = '1';
    server = await startDevServer({ gameDir: game.gameDir, port: 0, log: () => {}, watch: false });
    port = Number(new URL(server.url).port);
    // live, through the real flow; the prize pool is given 0.05 SOL (the fake chain does not move deposits)
    let view = (await post(port, '/flow/start', { kind: 'economy', wallet: owner.address })).json;
    while (!view.done) {
      const p = (await post(port, '/flow/prepare', { flowId: view.id, wallet: owner.address })).json;
      view = (await post(port, '/flow/complete', { flowId: view.id, prepareId: p.prepareId, signed: pageWallet.signTransactions(p.transactions) })).json;
    }
    const economy = JSON.parse(await readFile(path.join(game.gameDir, 'gamesfun.json'), 'utf8')).economy;
    gameAddress = economy.live.game;
    chain.setTokenAmount(lootPda.pool(gameAddress, 0), 50_000_000n, NATIVE_MINT);
    // the player paid two attempts two minutes ago
    chain.now = Math.floor(Date.now() / 1000) - 120;
    const e = readSpec(economy);
    const shares = sharesFor(e.part('payment', 'attempt').split, e);
    const treasury = decodeLoot(LootAccount.Game, (await rpc().account(gameAddress)).data).treasury;
    for (let i = 0; i < 2; i++) {
      const { blockhash } = await rpc().latestBlockhash();
      const message = compileMessage({ payer: player.address, blockhash, instructions: [payIx({ player: player.address, game: gameAddress, mint: NATIVE_MINT, treasury, amount: 10_000_000n, shares, reference: randomBytes(32), tokenProgram: TOKEN_PROGRAM, remaining: shareAccounts(gameAddress, shares) })] });
      paid.push(await rpc().send(wireTransaction(message, signersOf(message).map(() => player.sign(message)))));
    }
    page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await injectWallet(page, owner, { log: signed });
  });
  after(async () => {
    await browser?.close();
    await server?.close();
    restore?.();
    delete process.env.GAMESFUN_WEB3;
    await import('node:fs/promises').then((fs) => game && fs.rm(game.root, { recursive: true, force: true }));
  });

  const link = (q) => `${server.url}studio/#economy?${new URLSearchParams(q)}`;

  it('opens the decision card from economy_decide’s link with what is decided, its numbers and the checks', async (t) => {
    if (!browser) return t.skip('no browser');
    await page.goto(link({ decide: 'ladder-prize', to: player.address, attempt: paid[0], id: 'run-1' }));
    const card = tab().getByTestId('econ-decision');
    await card.waitFor();
    const check = card.getByTestId('econ-decide-check');
    await check.waitFor({ timeout: 15_000 });
    const text = await check.innerText();
    assert.match(text, /Pay 0\.02 SOL from the pool “prize” to /);
    assert.match(text, /Attempt: .* paid \d+ seconds ago/);
    assert.match(text, /Caps \(the keeper’s and the page’s, not the program’s\): 0\.02 each, 0\.04 a player a day, 0\.2 a day/);
    assert.equal(await card.getByTestId('econ-decide-to').inputValue(), player.address);
    assert.equal(await tab().getByTestId('econ-decide-sign').isDisabled(), false);
    if (process.env.GF_DECIDE_SHOTS) await card.screenshot({ path: path.join(process.env.GF_DECIDE_SHOTS, 'decision-card.png') });
  });

  it('"Sign in my wallet" runs flow kind "decide" in the wallet and the prize lands', async (t) => {
    if (!browser) return t.skip('no browser');
    await tab().getByTestId('econ-decide-sign').click();
    await tab().getByTestId('approval').waitFor();
    await tab().getByTestId('approve').click();
    const wsol = associatedTokenAddress(player.address, NATIVE_MINT);
    const end = Date.now() + 15_000;
    while (chain.tokenAmount(wsol) !== 20_000_000n && Date.now() < end) await new Promise((r) => setTimeout(r, 150));
    assert.equal(chain.tokenAmount(wsol), 20_000_000n);
    assert.deepEqual(signed.map((s) => s.kind), ['transaction']);
    const recent = tab().getByTestId('econ-decide-recent');
    await recent.waitFor({ timeout: 15_000 });
    assert.match(await recent.innerText(), /✓ Pay 0\.02 SOL .* page/);
  });

  it('refuses the same attempt again on the card, with the fix, and the button waits', async (t) => {
    if (!browser) return t.skip('no browser');
    await page.goto(link({ decide: 'ladder-prize', to: player.address, attempt: paid[0], id: 'run-1b' }));
    const refusal = tab().locator('[data-code="D-PROOF-USED"]');
    await refusal.waitFor({ timeout: 15_000 });
    assert.match(await refusal.innerText(), /already paid for.*Fix: One attempt, one claim/s);
    assert.equal(await tab().getByTestId('econ-decide-sign').isDisabled(), true);
  });

  it('"Let my keeper decide" hands the decisions to the keeper’s key in one approval', async (t) => {
    if (!browser) return t.skip('no browser');
    const keeper = freshKeypair().address;
    await page.goto(`${server.url}studio/#economy`);
    const input = tab().getByTestId('econ-keeper-address');
    await input.waitFor({ timeout: 15_000 });
    await input.fill(keeper);
    await tab().getByTestId('econ-keeper-give').click();
    await tab().getByTestId('approval').waitFor();
    await tab().getByTestId('approve').click();
    await tab().getByTestId('econ-keeper-take').waitFor({ timeout: 15_000 });
    assert.equal(decodeLoot(LootAccount.Game, (await rpc().account(gameAddress)).data).authority, keeper);
    const config = JSON.parse(await readFile(path.join(game.gameDir, 'gamesfun.json'), 'utf8'));
    assert.equal(config.economy.keys.authority, keeper);
    assert.match(await tab().getByTestId('econ-decide-who').innerText(), /Who decides: the key/);
    if (process.env.GF_DECIDE_SHOTS) await tab().getByTestId('econ-decide').screenshot({ path: path.join(process.env.GF_DECIDE_SHOTS, 'decide-section.png') });
  });
});
