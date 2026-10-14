// The in-browser devnet proof of a game's economy, end to end, without a human wallet. Core's real dev server serves
// the studio and the game; Chrome (playwright-core) gets a Wallet Standard wallet injected into each page, backed by
// a launchpad test key that stays in Node (tests/web3/inject-wallet.mjs). It replaced the Token-and-Shop-tab proof
// when the Economy tab replaced those tabs (git history keeps the old one and its result.json).
//
//   1. The creator (test-creator's key stands in for the creator's approval) opens the studio's Economy tab and puts
//      the coin-flip arena live through the real economy flow; the tab reads the status back.
//   2. A player (test-buyer-1) opens the game in its own tab, hosted by builder/studio/play.html: the host bridge offers the
//      game the economy's buttons and lines (gf:host → economy, gf:economy). The player clicks Flip in the game's own
//      menu, the bridge signs through gf-web3, and the HUD line shows what the flip came to; anything claimable is
//      claimed from the results card.
//   3. `gamesfun economy check --devnet` runs on the live game, paid for by test-buyer-2's key file.
//
// The game: until the kit carries gf-three's side of the protocol (kit/net/host.js with gf:econ-action), it is
// the stand-in game page of tests/web3/stand-in/ (the same protocol, drawn plainly). Seeds in SOL go in at 1/100 (the
// house's 5 SOL as 0.05), and the arena's own token is the ARENA the K1 devnet run launched on the curve
// (economies-result.json), so this run launches nothing.
//
// Devnet only (genesis checked). Keys are read from the launchpad's key folder (LAUNCHPAD_KEY_DIR, default
// ~/.config/gamesfun-launchpad/devnet), never printed or copied.
//   node tests/web3/devnet/proof.mjs [--fresh] [--flips 2]
// The record goes to tests/web3/devnet/proof-economy-result.json; screenshots to .gamesfun/devnet/host-proof/shots/.
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { chromium } from 'playwright-core';
import { findChrome } from '../../../builder/lib/chrome.mjs';
import { startDevServer } from '../../../builder/server/index.mjs';
import { explorerUrl, networkConfig } from '../../../builder/web3/gf-web3/network.js';
import { rpcClient } from '../../../builder/web3/gf-web3/rpc.js';
import { DEVNET_GENESIS, readKeyFile } from '../../../builder/web3/node/economy-check.mjs';
import { injectWallet } from '../inject-wallet.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const kitRoot = path.resolve(here, '..', '..', '..');
const work = path.join(kitRoot, '.gamesfun', 'devnet', 'host-proof');
const gameDir = path.join(work, 'coin-flip');
const shots = path.join(work, 'shots');
const keyDir = process.env.LAUNCHPAD_KEY_DIR ?? path.join(homedir(), '.config', 'gamesfun-launchpad', 'devnet');
const keyFile = (role) => path.join(keyDir, `${role}.keypair.json`);
const ARENA = 'BHGDrgbNtaVPS2VP4fDffK27gG6Z5VDX5kMQqSmcPugU';
const args = process.argv.slice(2);
const flips = Number(args[args.indexOf('--flips') + 1] || 2) || 2;
const network = networkConfig('devnet');
const rpc = rpcClient(process.env.GF_DEVNET_RPC ?? network.rpcUrl);
const result = { network: 'devnet', program: network.loot.program, startedAt: new Date().toISOString(), game: 'stand-in (tests/web3/stand-in/)', steps: [], screenshots: [] };
const sol = (l) => Number(l) / 1e9;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function step(name, data = {}) {
  result.steps.push({ name, at: new Date().toISOString(), ok: data.ok !== false, ...data });
  console.log(`${data.ok === false ? '✗' : '✓'} ${name}${data.says ? `: ${data.says}` : ''}`);
}
async function shot(page, name, opts = {}) {
  const file = path.join(shots, `${name}.png`);
  await page.screenshot({ path: file, ...opts });
  result.screenshots.push(path.relative(kitRoot, file));
  return file;
}
async function until(fn, ms, what) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out after ${ms / 1000} s waiting for ${what}`);
    await sleep(500);
  }
}

/** The coin-flip arena as this run puts it live: seeds in SOL at 1/100, ARENA the token already on the curve. */
async function economy() {
  const e = JSON.parse(await readFile(path.join(kitRoot, 'builder/web3/economy/fixtures/coin-flip-arena.json'), 'utf8'));
  for (const p of e.pools) if (p.seed) p.seed = Number((p.seed / 100).toFixed(9));
  e.tokens = e.tokens.map((t) => (t.key === 'arena' ? { key: 'arena', source: 'existing', mint: ARENA, name: 'Arena', symbol: 'ARENA', decimals: 6 } : t));
  return e;
}

async function main() {
  if ((await rpc.call('getGenesisHash')) !== DEVNET_GENESIS) throw new Error('The RPC is not devnet.');
  const creator = await readKeyFile(keyFile('test-creator'));
  const player = await readKeyFile(keyFile('test-buyer-1'));
  const funder = await readKeyFile(keyFile('test-buyer-2'));
  const start = { creator: await rpc.balance(creator.address), player: await rpc.balance(player.address), funder: await rpc.balance(funder.address) };
  Object.assign(result, { creator: creator.address, player: player.address, funder: funder.address });
  step('keys on devnet', { lamports: start, ok: start.creator > 300_000_000n && start.player > 250_000_000n && start.funder > 400_000_000n });
  if (result.steps.at(-1).ok === false) throw new Error('A key runs low: stopping before anything is spent.');

  await mkdir(shots, { recursive: true });
  await mkdir(gameDir, { recursive: true });
  await copyFile(path.join(kitRoot, 'tests', 'web3', 'stand-in', 'index.html'), path.join(gameDir, 'index.html'));
  let config = null;
  try {
    config = JSON.parse(await readFile(path.join(gameDir, 'gamesfun.json'), 'utf8'));
  } catch {}
  if (!config || args.includes('--fresh')) {
    config = { version: 1, network: 'devnet', economy: await economy() };
    await writeFile(path.join(gameDir, 'gamesfun.json'), `${JSON.stringify(config, null, 2)}\n`);
  }

  process.env.GAMESFUN_WEB3 = '1';
  const server = await startDevServer({ gameDir, port: 0, log: () => {}, watch: false });
  const chrome = findChrome();
  const browser = await chromium.launch({ headless: true, ...(chrome ? { executablePath: chrome.path } : {}) });
  try {
    // ---- 1. the creator puts it live from the Economy tab
    if (!config.economy.live?.game) {
      const signed = [];
      const studio = await browser.newPage({ viewport: { width: 1400, height: 950 } });
      studio.on('pageerror', (e) => console.error('studio page error:', e.message));
      await injectWallet(studio, creator, { log: signed, name: 'Creator Test Wallet' });
      await studio.goto(`${server.url}studio/?gamesfun_mock=0#economy`);
      const tab = studio.locator('.panel:not([hidden]) [data-testid="tab-economy"]');
      const go = tab.getByTestId('econ-go-live');
      await until(async () => !(await go.isDisabled()), 60_000, '"Put it live"');
      await go.click();
      await tab.getByTestId('approve').click();
      await until(async () => (await tab.getByTestId('econ-status').count()) > 0 || /error|failed/i.test(await tab.locator('[data-testid="approval"]').innerText().catch(() => '')), 240_000, 'the economy to go live');
      config = JSON.parse(await readFile(path.join(gameDir, 'gamesfun.json'), 'utf8'));
      const live = config.economy.live ?? {};
      const status = await studio.evaluate(async () => (await fetch('/api/web3/economy/status', { cache: 'no-store' })).json());
      await shot(studio, '1-economy-tab-live', { fullPage: true });
      step('the Economy tab put the coin-flip arena live through the real flow (test-creator approving)', {
        ok: Boolean(live.game) && status.live && status.parts.every((p) => p.onChain && !p.differs),
        game: live.game, collection: live.collection, approvals: signed.map((s) => s.kind), transactions: live.transactions, explorer: explorerUrl(network, 'address', live.game ?? ''),
        status: { live: status.live, parts: status.parts.map((p) => `${p.part}:${p.key} ${p.onChain ? (p.differs ? 'differs' : 'on chain') : 'missing'}`), pools: status.pools },
        creatorSpent: sol(start.creator - (await rpc.balance(creator.address))),
      });
      await studio.close();
      if (!live.game) throw new Error('The economy did not go live.');
    } else step('the economy is already live from an earlier run (pass --fresh for a new one)', { game: config.economy.live.game, explorer: explorerUrl(network, 'address', config.economy.live.game) });

    // ---- 2. a player plays it, hosted by builder/studio/play.html
    const ctx = await browser.newContext({ viewport: { width: 1100, height: 800 } });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => console.error('play page error:', e.message));
    const logs = [];
    page.on('console', (m) => /host bridge/.test(m.text()) && logs.push(m.text()));
    const signed = [];
    await injectWallet(page, player, { log: signed, name: 'Player Test Wallet' });
    await page.goto(`${server.url}studio/play.html?gamesfun_mock=0`);
    const game = page.frameLocator('#game');
    const g = () => page.frame({ url: /\/game\/$/ });
    await game.locator('[data-where="menu"] [data-econ="box:flip:open"]').waitFor({ timeout: 60_000 });
    const offered = await g().evaluate(() => window.__seen.host.economy.actions.map((a) => `${a.where} ${a.id}: ${a.label}${a.price ? ` · ${a.price.amount} ${a.price.currency}` : ''}`));
    await shot(page, '2-game-menu-economy-buttons');
    step('the game is offered the economy’s buttons by its host page', { offered });

    await sleep(4000);     // the bridge's first read of the state (and of any order left unclaimed)
    const before = await rpc.balance(player.address);
    for (let i = 1; i <= flips; i++) {
      const lineBefore = await game.locator('[data-econ="hud:box:flip"] b').innerText().catch(() => '');
      const done = logs.filter((t) => t.includes('box:flip:open:')).length;
      const balanceBefore = await game.locator('[data-econ="hud:balance:sol"] b').innerText().catch(() => '');
      await game.locator('[data-econ="box:flip:open"]').click();
      await until(async () => logs.filter((t) => t.includes('box:flip:open:')).length > done, 300_000, `flip ${i} to finish`);
      await until(async () => (await game.locator('[data-econ="hud:balance:sol"] b').innerText()) !== balanceBefore, 30_000, 'the balance line to follow').catch(() => {});
      const s = await g().evaluate(() => window.__seen.economy);
      const line = await game.locator('[data-econ="hud:box:flip"] b').innerText().catch(() => '');
      const balance = await game.locator('[data-econ="hud:balance:sol"] b').innerText().catch(() => '');
      await shot(page, `3-after-flip-${i}`);
      step(`flip ${i}: clicked Flip in the game’s menu; the host page signed (test-buyer-1) and the HUD line followed`, {
        ok: !s.error && Boolean(line), hudBefore: lineBefore, balanceBefore, hud: line, balanceLine: balance, error: s.error || undefined, bridge: logs.slice(-1)[0],
      });
      if (/won/i.test(line)) break;
    }
    const results = await g().evaluate(() => window.__seen.host.economy.actions.filter((a) => a.where === 'results').map((a) => a.id));
    if (results.length) {
      for (const id of results) {
        const done = logs.filter((t) => t.includes(`${id}:`)).length;
        await game.locator(`[data-where="results"] [data-econ="${id}"]`).click();
        await until(async () => logs.filter((t) => t.includes(`${id}:`)).length > done, 300_000, `claim ${id} to finish`);
        step(`claimed ${id} from the results card`, { error: (await g().evaluate(() => window.__seen.economy.error)) || undefined, bridge: logs.slice(-1)[0] });
      }
      await shot(page, '4-after-claim');
    } else step('nothing claimable on the results card (a flip pays its prize with the flip itself; the lottery draws in 7 days)', {});
    step('the player’s wallet', { signed: signed.map((s) => s.kind), spentSol: sol(before - (await rpc.balance(player.address))), bridgeLog: logs });
    await ctx.close();
  } finally {
    await browser.close();
    await server.close();
  }

  // ---- 3. the economy check, as a creator runs it
  const out = path.join(here, 'proof-economy-check.json');
  const run = await promisify(execFile)(process.execPath, [path.join(kitRoot, 'bin', 'gamesfun.mjs'), 'economy', 'check', '--devnet', gameDir, '--tries', '3', '--out', out], { env: { ...process.env, GAMESFUN_DEVNET_KEY: keyFile('test-buyer-2') }, maxBuffer: 1 << 24, timeout: 1_200_000 }).catch((e) => e);
  console.log(run.stdout ?? '');
  const record = JSON.parse(await readFile(out, 'utf8').catch(() => 'null'));
  step('gamesfun economy check --devnet (test-buyer-2 funds the synthetic player)', { ok: run.code === undefined || run.code === 0, verdict: record?.verdict, won: record?.won, spentSol: record?.spent ? sol(record.spent) : null, record: path.relative(kitRoot, out), stderr: run.stderr?.slice(-2000) || undefined });
  result.end = { creator: await rpc.balance(creator.address), player: await rpc.balance(player.address), funder: await rpc.balance(funder.address) };
}

// earlier runs stay in the record (each run's own result, newest last)
try {
  const before = JSON.parse(await readFile(path.join(here, 'proof-economy-result.json'), 'utf8'));
  result.earlierRuns = [...(before.earlierRuns ?? []), { ...before, earlierRuns: undefined }];
} catch {}
try {
  await main();
} catch (e) {
  step('stopped', { ok: false, error: e.message });
} finally {
  result.finishedAt = new Date().toISOString();
  result.ok = result.steps.every((s) => s.ok);
  await writeFile(path.join(here, 'proof-economy-result.json'), `${JSON.stringify(result, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2)}\n`);
  console.log(`wrote tests/web3/devnet/proof-economy-result.json (${result.ok ? 'ok' : 'problems'})`);
}
