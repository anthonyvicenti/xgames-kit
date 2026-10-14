// The host bridge (builder/studio/host-bridge.js): the page that hosts a game offers it the economy's buttons and lines
// (gf-three kit/net/host.js, CONTRACT §6g W2) and signs what the player clicks with the kit's gf-web3.
//   - econMessages, the one adapter from gf-web3's economyState to gf:host / gf:economy, in Node.
//   - End to end in Chrome, with nothing stubbed: the studio's real Economy tab puts the coin-flip arena live through
//     the dev server's real economy flow on the offline fake chain (tests/web3/fake-chain.mjs), signed by a Wallet
//     Standard wallet injected into the page; the tab reads the status back; then the preview's game (a stand-in for a
//     gf-three game's side of the protocol, tests/web3/stand-in/) is offered the economy's buttons, a click on Flip
//     opens the box on the fake chain and the HUD line shows what it came to, and a ticket purchase asks how many.
//   - A game with no live economy hears nothing new.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fromBase64 } from '../builder/web3/gf-web3/chain/bytes.js';
import { encodeAccount } from '../builder/web3/gf-web3/chain/borsh.js';
import { LOOT_IDL, LOOT_PROGRAM, lootPda } from '../builder/web3/gf-web3/chain/loot.js';
import { TOKEN_PROGRAM } from '../builder/web3/gf-web3/chain/pda.js';
import { economyState, playerActions } from '../builder/web3/gf-web3/econ/actions.js';
import { freshKeypair } from '../builder/web3/node/ed25519.mjs';
import { startDevServer } from '../builder/server/index.mjs';
import { findChrome } from '../builder/lib/chrome.mjs';
import { econMessages, inside, plainError, walletMessage } from '../builder/studio/host-bridge.js';
import { fakeChain } from './web3/fake-chain.mjs';
import { injectWallet } from './web3/inject-wallet.mjs';
import { makeGame } from './web3/helpers.mjs';

const FIXTURE = JSON.parse(await readFile(new URL('../builder/web3/economy/fixtures/coin-flip-arena.json', import.meta.url), 'utf8'));
const STAND_IN = await readFile(new URL('./web3/stand-in/index.html', import.meta.url), 'utf8');
const F = JSON.parse(await readFile(new URL('./web3/fixtures/chain.json', import.meta.url), 'utf8'));
const ID = /^[A-Za-z0-9_.:-]{1,64}$/;
const KINDS = ['buy', 'openBox', 'craft', 'buyTickets', 'stake', 'unstake', 'hold', 'enter', 'claim'];

describe('econMessages: economyState → gf:host and gf:economy', () => {
  const economy = { ...structuredClone(FIXTURE), live: { game: 'G1111111111111111111111111111111111111111111' } };
  const player = 'P1111111111111111111111111111111111111111111';

  it('offers the coin-flip arena’s buttons in the shapes gf-three keeps, and its HUD lines', () => {
    const { host, economy: msg } = econMessages({ economy, actions: playerActions(economy), state: null });
    assert.equal(host.type, 'gf:host');
    assert.equal(host.v, 1);
    assert.equal(host.wallet, true);
    const acts = host.economy.actions;
    assert.ok(acts.length <= 32);
    for (const a of acts) {
      assert.match(a.id, ID);
      assert.ok(KINDS.includes(a.kind), a.kind);
      assert.ok(['menu', 'pause', 'results', 'hud'].includes(a.where), a.where);
      assert.ok(a.label.length <= 60 && (a.says ?? '').length <= 140);
      assert.equal(a.asks, undefined, 'asks stay with the page');
    }
    const by = (where) => acts.filter((a) => a.where === where).map((a) => a.id);
    assert.deepEqual(by('menu'), ['box:flip:open', 'lottery:weekly:tickets', 'stake:backers:stake', 'stake:backers:unstake']);
    assert.deepEqual(by('results'), [], 'nothing to claim yet: no claim buttons');
    assert.deepEqual(by('hud'), ['hud:balance:sol', 'hud:box:flip', 'hud:lottery:weekly', 'hud:stake:backers']);
    assert.deepEqual(acts.find((a) => a.id === 'box:flip:open').price, { amount: '0.1', currency: 'SOL' });
    assert.deepEqual(msg, { type: 'gf:economy', v: 1, balances: [], tickets: [], stakes: [], claimable: [], pending: [], error: '' });
  });

  it('every HUD line has its entry by id once the state has it, and claims appear on the results card while claimable', () => {
    const now = 1_800_000_000;
    const reads = {
      now, balances: { sol: '1234000000' }, pools: { house: '5000000000' },
      lotteries: { weekly: { price: '10000000', pot: '300000000', status: 'Open', drawsAt: now - 5, sold: 3, mine: 2, places: [50, 30, 20], winners: [], paid: 0 } },
      stakes: { backers: { staked: '1500000', pending: '1000', since: now - 10, lock: 86_400 } },
    };
    const state = economyState(economy, reads, player);
    const m = econMessages({ economy, actions: playerActions(economy), state, last: { 'box:flip': 'You won 0.176 SOL!' }, pending: ['box:flip:open'], error: 'x'.repeat(300) });
    const hud = m.host.economy.actions.filter((a) => a.where === 'hud');
    const entries = [...m.economy.balances, ...m.economy.tickets, ...m.economy.stakes];
    for (const a of hud) assert.ok(entries.some((e) => e.id === a.id), `${a.id} has its entry`);
    assert.equal(entries.find((e) => e.id === 'hud:balance:sol').text, '1.234 SOL');
    assert.equal(entries.find((e) => e.id === 'hud:box:flip').text, 'You won 0.176 SOL!');
    assert.match(entries.find((e) => e.id === 'hud:lottery:weekly').text, /^2 tickets · pot 0\.3 SOL · draw due now$/);
    assert.match(entries.find((e) => e.id === 'hud:stake:backers').text, /^1\.5 ARENA staked · <0\.0001 SOL earned · locked$/, 'dust is never shown as 0');
    const results = m.host.economy.actions.filter((a) => a.where === 'results');
    assert.deepEqual(results.map((a) => a.id).sort(), ['lottery:weekly:claim', 'stake:backers:claim']);
    assert.ok(results.every((a) => a.kind === 'claim'));
    assert.deepEqual(m.economy.claimable.map((c) => c.id).sort(), ['lottery:weekly:claim', 'stake:backers:claim']);
    assert.ok(m.economy.claimable.every((c) => c.text.length <= 60));
    assert.deepEqual(m.economy.pending, ['box:flip:open']);
    assert.ok(m.economy.error.length <= 200);
    assert.ok(m.offered.find((a) => a.id === 'lottery:weekly:tickets').asks.count, 'the page keeps what an action asks');
  });

  it('the HUD lines keep their labels short: a lottery’s is its name, and its line counts the tickets (devnet real-game proof, 2026-10-12)', () => {
    const reads = { now: 1_800_000_000, lotteries: { weekly: { price: '10000000', pot: '20000000', status: 'Open', drawsAt: 1_800_604_800, sold: 1, mine: 1, places: [50, 30, 20], winners: [], paid: 0 } } };
    const m = econMessages({ economy, actions: playerActions(economy), state: economyState(economy, reads, player) });
    assert.equal(m.host.economy.actions.find((a) => a.id === 'hud:lottery:weekly').label, 'Weekly draw');
    assert.match(m.economy.tickets.find((e) => e.id === 'hud:lottery:weekly').text, /^1 ticket · pot 0\.02 SOL · draw /);
  });

  it('a lottery’s and a stake’s HUD lines wait until the player has something in them (no card of zeros over the player)', () => {
    const reads = { now: 1_800_000_000, balances: { sol: '500000000' }, lotteries: { weekly: { price: '10000000', pot: '20000000', status: 'Open', drawsAt: 1_800_604_800, sold: 4, mine: 0, places: [50, 30, 20], winners: [], paid: 0 } }, stakes: { backers: { staked: '0', pending: '0', since: 0, lock: 0 } } };
    const m = econMessages({ economy, actions: playerActions(economy), state: economyState(economy, reads, player) });
    assert.deepEqual(m.host.economy.actions.filter((a) => a.where === 'hud').map((a) => a.id), ['hud:balance:sol', 'hud:box:flip', 'hud:lottery:weekly', 'hud:stake:backers'], 'the lines are still offered');
    assert.deepEqual([...m.economy.balances, ...m.economy.tickets, ...m.economy.stakes].map((e) => e.id), ['hud:balance:sol'], 'only the balance has something to say');
    const earning = econMessages({ economy, actions: playerActions(economy), state: economyState(economy, { ...reads, stakes: { backers: { staked: '0', pending: '1000', since: 0, lock: 0 } } }, player) });
    assert.match(earning.economy.stakes.find((e) => e.id === 'hud:stake:backers').text, /^0 ARENA staked · <0\.0001 SOL earned$/, 'something left to collect still shows');
  });

  it('gf:wallet: a connected wallet in a game with no items says [] (not null, which the kit’s menu reads as “Reading your items…” forever)', () => {
    const address = '43QBMgKHHkPuPZsN4KUwUkbxJkHfv4gZF1d7xNMP66gc';
    assert.equal(walletMessage({}).items, null, 'no wallet: no items to speak of');
    assert.equal(walletMessage({}).status, 'none');
    const none = walletMessage({ address, shop: false, items: null });
    assert.equal(none.status, 'connected');
    assert.equal(none.short, '43QB…66gc');
    assert.deepEqual(none.items, []);
    assert.equal(walletMessage({ address, shop: true, items: null }).items, null, 'a shop’s items still being read');
    assert.equal(walletMessage({ connecting: true }).status, 'connecting');
    assert.equal(walletMessage({ error: 'You declined' }).status, 'error');
  });

  it('amounts in the HUD are rounded for people: four decimals at most, never 0 for dust', () => {
    const reads = { now: 1_800_000_000, balances: { sol: '368812502' }, stakes: { backers: { staked: '1500000', pending: '0', since: 0, lock: 0 } } };
    const state = economyState(economy, reads, player);
    assert.equal(state.balances.sol.amount, '0.368812502 SOL', 'gf-web3 keeps it exact');
    const m = econMessages({ economy, actions: playerActions(economy), state, last: { 'box:flip': 'You won 0.176000001 SOL!' }, unclaimed: ['box:flip'] });
    const entries = [...m.economy.balances, ...m.economy.stakes];
    assert.equal(entries.find((e) => e.id === 'hud:balance:sol').text, '0.3688 SOL');
    assert.equal(entries.find((e) => e.id === 'hud:box:flip').text, 'You won 0.176 SOL!');
    assert.equal(entries.find((e) => e.id === 'hud:stake:backers').text, '1.5 ARENA staked · 0 SOL earned');
  });

  it('a box whose roll came late is claimable; a payment is a purchase; nothing past 32 actions', () => {
    const m = econMessages({ economy, actions: playerActions(economy), unclaimed: ['box:flip'] });
    assert.deepEqual(m.host.economy.actions.filter((a) => a.where === 'results').map((a) => a.id), ['box:flip:claim']);
    const many = Array.from({ length: 40 }, (_, i) => ({ id: `payment:p${i}:pay`, kind: 'pay', label: `Pay ${i}`, where: 'menu', says: '' }));
    const big = econMessages({ economy: { currency: 'sol' }, actions: many });
    assert.equal(big.host.economy.actions.length, 32);
    assert.ok(big.host.economy.actions.every((a) => a.kind === 'buy'));
    assert.equal(plainError(new Error('User rejected the request.')), 'You declined in your wallet. Nothing was spent.');
  });

  it('a spec payment (playerActions kind "pay") is offered as kind "buy", with its id, label, price and says unchanged', async () => {
    const falling = JSON.parse(await readFile(new URL('../builder/web3/economy/fixtures/falling-drop.json', import.meta.url), 'utf8'));
    const actions = playerActions(falling);
    const pay = actions.find((a) => a.id === 'payment:entry:pay');
    assert.equal(pay.kind, 'pay');
    const offered = econMessages({ economy: falling, actions }).host.economy.actions.find((a) => a.id === pay.id);
    assert.ok(offered, 'the payment is offered: gf-three would drop kind "pay"');
    assert.equal(offered.kind, 'buy');
    assert.equal(offered.label, pay.label);
    assert.equal(offered.says, pay.says);
    assert.deepEqual(offered.price, pay.price);
    assert.equal(offered.where, 'menu');
  });

  it('a window inside the preview frame is accepted, any other is not', () => {
    const top = {}; top.parent = top;
    const frame = { parent: top };
    const game = { parent: frame };
    const other = { parent: top };
    assert.equal(inside(frame, frame), true);
    assert.equal(inside(frame, game), true);
    assert.equal(inside(frame, other), false);
    assert.equal(inside(frame, null), false);
  });
});

// ---------------------------------------------------------------------------------------------------- in Chrome
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
/** This process's Solana JSON-RPC (the dev server's flow) goes to the fake chain. */
function useFakeChain(chain) {
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    if (init?.method === 'POST' && typeof init.body === 'string' && init.body.includes('"jsonrpc"')) return chain.fetchImpl(String(url), init);
    return real(url, init);
  };
  return () => (globalThis.fetch = real);
}
/** The page's JSON-RPC (gf-web3 in the studio page) goes to the same fake chain. */
async function routeRpc(page, chain) {
  await page.route(/^https:\/\/api\.devnet\.solana\.com\/?$/, async (route) => {
    const req = route.request();
    const r = await chain.fetchImpl(req.url(), { method: 'POST', body: req.postData(), headers: { 'content-type': 'application/json' } });
    await route.fulfill({ status: r.status, contentType: 'application/json', body: await r.text() });
  });
}
const until = async (fn, ms = 15_000, what = 'it') => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 200));
  }
};

describe('the host bridge in the studio, end to end on the fake chain (Chrome)', { skip: !chromium && 'playwright-core is not installed' }, () => {
  let browser, server, game, chain, page, restore;
  const wallet = freshKeypair();
  const signed = [];
  const frame = () => page.frameLocator('#preview');

  before(async () => {
    browser = await launch();
    if (!browser) return;
    // the arena's own token is already out (the curve launch is its own approval, tested with the token launch)
    const economy = structuredClone(FIXTURE);
    economy.tokens[1] = { ...economy.tokens[1], source: 'existing', mint: freshKeypair().address };
    game = await makeGame({ config: { version: 1, network: 'devnet', economy } });
    await writeFile(path.join(game.gameDir, 'index.html'), STAND_IN);
    chain = fakeChain();
    chain.put(F.accounts.poolConfig.address, F.accounts.poolConfig.owner, fromBase64(F.accounts.poolConfig.data));
    const mint = new Uint8Array(82);
    mint[44] = 6;
    mint[45] = 1;
    chain.put(economy.tokens[1].mint, TOKEN_PROGRAM, mint);
    // the program's Platform account, there on devnet since the program went live (its fees: 0.002 SOL a player action)
    const fees = { player: 2_000_000n, project: 10_000n };
    chain.put(lootPda.platform(), LOOT_PROGRAM, encodeAccount(LOOT_IDL, 'Platform', { admin: wallet.address, partner: wallet.address, fees, pending: fees, pending_at: 0n, bump: 255 }));
    restore = useFakeChain(chain);
    process.env.GAMESFUN_WEB3 = '1';
    server = await startDevServer({ gameDir: game.gameDir, port: 0, log: () => {}, watch: false });
    page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    page.on('pageerror', (e) => console.error('page error:', e.message));
    if (process.env.GF_DEBUG) page.on('console', (m) => console.error('page:', m.text()));
    await injectWallet(page, wallet, { log: signed });
    await routeRpc(page, chain);
  });
  after(async () => {
    await browser?.close();
    await server?.close();
    restore?.();
    delete process.env.GAMESFUN_WEB3;
  });

  it('before the economy is live the game hears nothing new', async (t) => {
    if (!browser) return t.skip('no browser');
    await page.goto(`${server.url}studio/?gamesfun_mock=0#economy`);
    await frame().locator('h1').waitFor();
    await new Promise((r) => setTimeout(r, 2500));
    const seen = await page.frame({ url: /\/game\/$/ }).evaluate(() => window.__seen);
    assert.equal(seen.hosts, 0);
    assert.equal(seen.economy, null);
  });

  it('the Economy tab puts the coin-flip arena live through the real flow, and the status reads back', async (t) => {
    if (!browser) return t.skip('no browser');
    const tab = page.locator('.panel:not([hidden]) [data-testid="tab-economy"]');
    const go = tab.getByTestId('econ-go-live');
    await until(async () => !(await go.isDisabled()), 20_000, 'Put it live');
    await go.click();
    await tab.getByTestId('approve').click();
    await tab.getByTestId('econ-status').waitFor({ timeout: 60_000 });
    assert.ok(signed.some((s) => s.kind === 'transaction'), 'the wallet signed the setup');
    assert.match(await page.locator('#wallet-btn').innerText(), /Wallet /, 'Put it live connected the studio’s one wallet, shown in the header');
    assert.equal(await tab.getByTestId('econ-wallet-note').count(), 0);
    const config = JSON.parse(await readFile(path.join(game.gameDir, 'gamesfun.json'), 'utf8'));
    assert.equal(config.economy.live.game, lootPda.game(config.economy.live.collection));
    const status = await page.evaluate(async () => (await fetch('/api/web3/economy/status', { cache: 'no-store' })).json());
    assert.equal(status.live, true);
    assert.deepEqual(status.parts.filter((p) => !p.onChain || p.differs), []);
  });

  it('the preview’s game is offered the economy’s buttons, and a click on Flip opens the box on the fake chain', async (t) => {
    if (!browser) return t.skip('no browser');
    const sentBefore = chain.sent.length;
    await page.click('#preview-reload');
    const flip = frame().locator('[data-where="menu"] [data-econ="box:flip:open"]');
    await flip.waitFor({ timeout: 60_000 });
    const g = () => page.frame({ url: /\/game\/$/ });
    const seen = await g().evaluate(() => window.__seen);
    assert.equal(seen.from, new URL(server.url).origin, 'gf:host comes from the studio page');
    assert.deepEqual(seen.host.economy.actions.filter((a) => a.where === 'menu').map((a) => a.id), ['box:flip:open', 'lottery:weekly:tickets', 'stake:backers:stake', 'stake:backers:unstake']);
    assert.ok(!JSON.stringify(seen).match(/secret|private/i));
    await flip.click();
    await until(async () => (await frame().locator('[data-econ="hud:box:flip"]').count()) > 0, 30_000, 'the flip’s HUD line');
    const line = await frame().locator('[data-econ="hud:box:flip"]').innerText();
    assert.match(line, /Coin flip\s*(You won 0\.176 SOL!|Nothing this time\.)/);
    assert.ok(chain.sent.length >= sentBefore + 2, 'pay-and-roll, then the claim');
    await until(async () => /SOL/.test(await frame().locator('[data-econ="hud:balance:sol"]').innerText()), 10_000, 'the balance line');
    const s = await g().evaluate(() => window.__seen);
    assert.deepEqual(s.sent, ['box:flip:open']);
    assert.deepEqual(s.economy.pending, []);
    assert.equal(s.economy.error, '');
  });

  it('buying tickets asks how many in the page, and the HUD line counts them', async (t) => {
    if (!browser) return t.skip('no browser');
    await frame().locator('[data-econ="lottery:weekly:tickets"]').click();
    await page.getByTestId('econ-ask-value').fill('2');
    await page.getByTestId('econ-ask-ok').click();
    await until(async () => /^2 tickets ·/.test(await frame().locator('[data-econ="hud:lottery:weekly"] b').innerText()), 30_000, 'two tickets');
    await page.screenshot({ path: path.join(game.root, 'host-bridge.png') });
  });
});
