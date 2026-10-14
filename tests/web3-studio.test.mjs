// The Economy tab (it replaced the Token and Shop tabs) in the real studio, in Chrome: core's dev server serves builder/studio/
// and mounts builder/server/routes/web3.mjs; the tab uses core's ctx.api and ctx.wallet; a Wallet Standard wallet is injected
// into the page (its key stays in Node). The chain and the Irys node are the offline fake (tests/web3/fake-chain.mjs),
// reached through this process's fetch, so the run is deterministic. Clicks launch the game's token from its part (the
// old Token tab's launch, kept as it was), add a lottery and change its numbers, meet a checker refusal next to the
// part, and put the economy live. The economy flow and GET /economy/status are the economy publish work's, built in
// parallel: here they are stubbed in the page (page.route) to the agreed contract. Skipped when no browser is available.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fromBase64 } from '../builder/web3/gf-web3/chain/bytes.js';
import { freshKeypair } from '../builder/web3/node/ed25519.mjs';
import { startDevServer } from '../builder/server/index.mjs';
import { findChrome } from '../builder/lib/chrome.mjs';
import { fakeChain } from './web3/fake-chain.mjs';
import { injectWallet } from './web3/inject-wallet.mjs';
import { makeGame } from './web3/helpers.mjs';

const F = JSON.parse(await readFile(new URL('./web3/fixtures/chain.json', import.meta.url), 'utf8'));
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

/** Route this process's Solana JSON-RPC and Irys calls to the fake chain; everything else goes out as usual. */
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

describe('studio Economy tab on core’s dev server, in Chrome (fake chain)', { skip: !chromium && 'playwright-core is not installed' }, () => {
  let browser;
  let server;
  let game;
  let chain;
  let page;
  let restore;
  const wallet = freshKeypair();
  const signed = [];
  const asked = [];
  let live = false;
  const config = async () => JSON.parse(await readFile(path.join(game.gameDir, 'gamesfun.json'), 'utf8'));
  const tab = () => page.locator('.panel:not([hidden]) [data-testid="tab-economy"]');
  const until = async (fn, ms = 8000) => {
    const end = Date.now() + ms;
    for (;;) {
      const v = await fn().catch(() => null);
      if (v) return v;
      if (Date.now() > end) throw new Error('timed out');
      await new Promise((r) => setTimeout(r, 150));
    }
  };

  before(async () => {
    browser = await launch();
    if (!browser) return;
    game = await makeGame();
    chain = fakeChain();
    chain.put(F.accounts.poolConfig.address, F.accounts.poolConfig.owner, fromBase64(F.accounts.poolConfig.data));
    restore = useFakeChain(chain);
    process.env.GAMESFUN_WEB3 = '1';      // the tab is off unless asked for (tests/web3-switch.test.mjs)
    server = await startDevServer({ gameDir: game.gameDir, port: 0, log: () => {}, watch: false });
    page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await injectWallet(page, wallet, { log: signed });
    // the economy publish flow and its status, to the contract (econ-publish builds them); the launch flow stays real
    const flowView = (done) => ({ id: 'econ-1', kind: 'economy', title: 'Put the economy live', lines: ['One approval sets everything up on devnet.'], wallet: wallet.address, steps: ['Set up the economy'], next: done ? 1 : 0, results: done ? ['Live: https://explorer.solana.com/tx/5u3Y?cluster=devnet'] : [], done, error: null });
    await page.route('**/api/web3/flow/start', async (route) => {
      const body = JSON.parse(route.request().postData() ?? '{}');
      asked.push(body);
      if (body.kind !== 'economy') return route.fallback();
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(flowView(false)) });
    });
    await page.route('**/api/web3/flow/prepare', async (route) => {
      const body = JSON.parse(route.request().postData() ?? '{}');
      if (body.flowId !== 'econ-1') return route.fallback();
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ prepareId: 'p1', step: 0, title: 'Set up the economy', details: ['3 pools, a box, a lottery'], kind: 'message', text: 'stub: the economy flow' }) });
    });
    await page.route('**/api/web3/flow/complete', async (route) => {
      const body = JSON.parse(route.request().postData() ?? '{}');
      if (body.flowId !== 'econ-1') return route.fallback();
      live = true;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(flowView(true)) });
    });
    await page.route('**/api/web3/economy/status', (route) =>
      route.fulfill(live
        ? { status: 200, contentType: 'application/json', body: JSON.stringify({ live: true, program: '88Labq6tdVnBQsjHSfic6qqgvo5b9NGmy99AYj7KVXqM', game: wallet.address, parts: [{ part: 'lottery', key: 'weekly', onChain: true, differs: false, address: wallet.address }], pools: [{ index: 0, key: 'pot', balance: 0 }], receipts: [{ says: 'Put the economy live', signature: '5u3YgKk2y7a9w3C6Rz8bWf3pE8w9Qq7d1JcX2vQ4mB8tK1n6Hc3sR2aP9fL5eD7gT4xY6zN8vM1qW3eR5tY7uI9o', at: '2026-10-11T18:02:00Z' }] }) }
        : { status: 404, contentType: 'application/json', body: '{"error":"not live"}' }));
    await page.goto(`${server.url}studio/`);
  });
  after(async () => {
    await browser?.close();
    await server?.close();
    restore?.();
    delete process.env.GAMESFUN_WEB3;
  });

  it('lists the Economy tab after core’s own, and no Token or Shop tab', async (t) => {
    if (!browser) return t.skip('no browser');
    await page.getByRole('tab', { name: 'Economy' }).waitFor();
    const tabs = await page.getByRole('tab').allInnerTexts();
    assert.equal(tabs.at(-1), 'Economy');
    assert.ok(!tabs.includes('Token') && !tabs.includes('Shop'), tabs.join());
  });

  it('has no title or wallet button of its own: it points at the header’s Connect wallet, which connects the wallet it signs with', async (t) => {
    if (!browser) return t.skip('no browser');
    await page.getByRole('tab', { name: 'Economy' }).click();
    await tab().getByTestId('econ-flow').waitFor();
    assert.equal(await tab().locator('h1, h2').count(), 0, 'the rail names the tab');
    assert.equal(await tab().getByRole('button', { name: /connect a wallet/i }).count(), 0, 'one wallet button: the header’s');
    assert.match(await tab().getByTestId('econ-wallet-note').innerText(), /Connect a wallet to put it live: Connect wallet, at the top of the studio/);
    await page.locator('#wallet-btn').click();
    await until(async () => (await tab().getByTestId('econ-wallet-note').count()) === 0);
    assert.match(await page.locator('#wallet-btn').innerText(), /Wallet /);
  });

  it('launches the game’s token from its part, through ctx.wallet, and the economy keeps its mint', async (t) => {
    if (!browser) return t.skip('no browser');
    await page.getByRole('tab', { name: 'Economy' }).click();
    await tab().getByTestId('econ-flow').waitFor();
    await tab().getByTestId('econ-add-token-curve').click();
    const form = tab().getByTestId('launch-form');
    await form.waitFor();
    assert.equal(await form.getByTestId('token-symbol').inputValue(), 'BEAN');
    await form.getByTestId('token-picture').click();
    await page.locator('.pickgrid button', { hasText: 'icon.png' }).click();
    await form.getByTestId('token-launch-go').click();
    await tab().getByTestId('approve').click();
    await tab().getByTestId('token-card').waitFor({ timeout: 60_000 });
    const c = await until(async () => {
      const x = await config();
      return x.economy?.tokens?.some((k) => k.mint) && x;
    });
    assert.equal(c.token.symbol, 'BEAN');
    assert.equal(c.creator, wallet.address);
    assert.equal(c.economy.tokens.find((k) => k.source === 'curve').mint, c.token.mint, 'the launched mint is in the economy');
    assert.deepEqual(signed.map((s) => s.kind), ['message', 'message', 'transaction']);
    assert.match(await page.locator('#wallet-btn').innerText(), /Wallet /);
  });

  it('adds a lottery from the menu, and a typed number is saved, with what it comes to beside it', async (t) => {
    if (!browser) return t.skip('no browser');
    await tab().getByTestId('econ-add-lottery').click();
    const card = tab().locator('[data-part-card="lotteries:weekly"]');
    await card.waitFor();
    await card.locator('[data-path="lotteries:weekly|price"]').fill('0.05');
    const c = await until(async () => {
      const x = await config();
      return x.economy?.lotteries?.[0]?.price === 0.05 && x;
    });
    assert.equal(c.economy.lotteries[0].pot, 'pot');
    assert.deepEqual(c.economy.lotteries[0].places, [50, 30, 20]);
    await until(async () => /a ticket is worth/.test(await card.getByTestId('econ-facts').innerText()));
    assert.match(await card.getByTestId('econ-facts').innerText(), /The pot reaches about 35 SOL a draw/, '100 tickets a day × 7 days × 0.05');
    assert.ok(await tab().locator('[data-part="lotteries:weekly"]').count(), 'the lottery is in the picture');
  });

  it('shows a refusal next to its part with the fix, and "Put it live" waits for the fix', async (t) => {
    if (!browser) return t.skip('no browser');
    const card = tab().locator('[data-part-card="lotteries:weekly"]');
    await card.locator('[data-path="lotteries:weekly|places"]').fill('50, 30, 30');
    await card.getByTestId('econ-refusal').waitFor();
    assert.match(await card.getByTestId('econ-refusal').innerText(), /Fix:/);
    assert.equal(await tab().getByTestId('econ-go-live').isDisabled(), true);
    assert.match(await tab().getByTestId('econ-go-why').innerText(), /Fix the 1 note marked ✗ first/);
    await card.locator('[data-path="lotteries:weekly|places"]').fill('50, 30, 20');
    await until(async () => !(await tab().getByTestId('econ-go-live').isDisabled()));
    assert.equal(await card.getByTestId('econ-refusal').count(), 0);
    await until(async () => (await tab().getByTestId('econ-cost-oracle').count()) > 0);
    assert.match(await tab().getByTestId('econ-cost-oracle').textContent(), /MagicBlock’s oracle 0\.0005 SOL for the random number/, 'what the cost is made of names the oracle’s fee');
  });

  it('a link from the agent (#economy?flow=economy) opens the tab and offers "Put it live", without starting anything', async (t) => {
    if (!browser) return t.skip('no browser');
    await page.getByRole('tab', { name: 'Tune' }).click();   // another tool first (Session is the conversation now, not a tab)
    asked.length = 0;
    await page.goto(`${server.url}studio/#economy?flow=economy`);
    await page.locator('.panel:not([hidden]) [data-testid="econ-asked"]').waitFor();
    assert.equal(await page.getByRole('tab', { name: 'Economy' }).getAttribute('aria-selected'), 'true');
    await page.waitForTimeout(800);
    assert.equal(asked.length, 0, 'opening the link starts no flow');
  });

  it('puts the economy live in one approval (flow kind "economy") and shows what is live and the receipts', async (t) => {
    if (!browser) return t.skip('no browser');
    signed.length = 0;
    await until(async () => !(await tab().getByTestId('econ-asked-go').isDisabled()));
    await tab().getByTestId('econ-asked-go').click();
    await tab().getByTestId('approval').waitFor();
    assert.deepEqual(asked.at(-1), { kind: 'economy', wallet: wallet.address });
    await tab().getByTestId('approve').click();
    await tab().getByTestId('econ-status').waitFor({ timeout: 60_000 });
    assert.deepEqual(signed.map((s) => s.kind), ['message']);
    const receipts = tab().getByTestId('econ-receipts');
    assert.match(await receipts.innerText(), /Put the economy live/);
    assert.match(await receipts.locator('a').first().getAttribute('href'), /explorer\.solana\.com\/tx\/5u3Y.*cluster=devnet/);
    assert.match(await tab().locator('[data-part-card="lotteries:weekly"] .econ-state').innerText(), /Live/);
    await page.screenshot({ path: path.join(game.root, 'studio-economy.png'), fullPage: true });
  });
});
