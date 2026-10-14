// The in-browser devnet proof of an economy in a real kit game (proof.mjs's sibling: that one plays the stand-in page).
// A fresh game made the normal way (`gamesfun create --from coin-hop`) gets the coin-flip arena; the creator puts it live
// from the studio's Economy tab; a player plays it in headless Chrome through the game's own gf-three menu, pause menu,
// HUD and results card (CONTRACT §6g W2), hosted by the studio preview and by builder/studio/play.html; verify checks the game
// still passes; `gamesfun economy check --devnet` reads it against devnet and its oracle fee is compared with the cost
// model's constant.
//
//   1. create: `gamesfun create .gamesfun/devnet/real-game/coin-hop --from coin-hop`, and the coin-flip arena (seeds in
//      SOL at 1/100, ARENA the token the K1 run already launched) written into its gamesfun.json.
//   2. The creator (test-creator's key stands in for the creator's approval, tests/web3/inject-wallet.mjs) opens the
//      Economy tab and presses Put it live; the tab reads the status back.
//   3. The player (test-buyer-1), in the studio preview: home menu → wallet view, the economy's buttons are there; the
//      player connects with a real click and clicks Coin flip; then Play, and the HUD player card shows the result.
//   4. The player, in builder/studio/play.html: Play, Esc (what the pause menu shows), the pause menu's wallet view, Coin flip,
//      Resume, the HUD line; the round runs out and the results card shows what is claimable (Claim if anything is).
//      The same page at a phone's width (390×844): the wallet view and the HUD.
//   5. `gamesfun verify <game> --check 20,21,22` (or `--verify quick`: the whole quick run, then check 22, which --quick leaves out).
//   6. `gamesfun economy check --devnet` on the game, paid by test-buyer-2; its measured oracle fee against ORACLE_FEE.
//
// Every click and key is real input (Playwright's mouse and keyboard through CDP, trusted events). Spending is kept small:
// at most one flip per page and none once the player's key is under 0.21 SOL, and the run stops before anything is
// spent when a key is under 0.1 SOL. Devnet only (genesis checked). Keys are read from the launchpad's key folder
// (LAUNCHPAD_KEY_DIR, default ~/.config/gamesfun-launchpad/devnet), never printed or copied. WebGL on a headless box:
// CHROME_ARGS="--use-gl=angle --use-angle=gl-egl" (and the GPU's EGL vendor file) are passed to Chrome and to verify.
//   node tests/web3/devnet/proof-real-game.mjs [--fresh] [--verify 20,21,22|quick|none] [--no-check]
// The record goes to tests/web3/devnet/proof-real-game-result.json (the check's to proof-real-game-check.json);
// screenshots to tests/web3/devnet/shots-real-game/ (jpg).
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { chromium } from 'playwright-core';
import { findChrome } from '../../../builder/lib/chrome.mjs';
import { startDevServer } from '../../../builder/server/index.mjs';
import { ORACLE_FEE } from '../../../builder/web3/economy/model.mjs';
import { explorerUrl, networkConfig } from '../../../builder/web3/gf-web3/network.js';
import { rpcClient } from '../../../builder/web3/gf-web3/rpc.js';
import { DEVNET_GENESIS, readKeyFile } from '../../../builder/web3/node/economy-check.mjs';
import { injectWallet } from '../inject-wallet.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const kitRoot = path.resolve(here, '..', '..', '..');
const cli = path.join(kitRoot, 'bin', 'gamesfun.mjs');
const work = path.join(kitRoot, '.gamesfun', 'devnet', 'real-game');
const gameDir = path.join(work, 'coin-hop');
const shots = path.join(here, 'shots-real-game');
const keyDir = process.env.LAUNCHPAD_KEY_DIR ?? path.join(homedir(), '.config', 'gamesfun-launchpad', 'devnet');
const keyFile = (role) => path.join(keyDir, `${role}.keypair.json`);
const ARENA = 'BHGDrgbNtaVPS2VP4fDffK27gG6Z5VDX5kMQqSmcPugU';
const args = process.argv.slice(2);
const opt = (name, dflt) => (args.includes(name) ? args[args.indexOf(name) + 1] : dflt);
const verifyChecks = opt('--verify', '20,21,22');
const LOW = 100_000_000n;                 // stop when any key is under 0.1 SOL
const FLIP_FLOOR = 210_000_000n;          // no flip once the player is under 0.21 SOL (a flip takes up to 0.1025)
const network = networkConfig('devnet');
const rpc = rpcClient(process.env.GF_DEVNET_RPC ?? network.rpcUrl);
const chromeArgs = (process.env.CHROME_ARGS ?? '').split(/\s+/).filter(Boolean);
const result = { network: 'devnet', program: network.loot.program, startedAt: new Date().toISOString(), game: 'coin-hop (gamesfun create --from coin-hop)', chromeArgs, steps: [], screenshots: [], owedByGfThree: [] };
const sol = (l) => Number(l) / 1e9;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const run = promisify(execFile);

function step(name, data = {}) {
  result.steps.push({ name, at: new Date().toISOString(), ok: data.ok !== false, ...data });
  console.log(`${data.ok === false ? '✗' : '✓'} ${name}${data.says ? `: ${data.says}` : ''}`);
}
/** The mouse off the buttons (the kit's buttons slide on hover) before a picture. */
async function rest(page) {
  const v = page.viewportSize();
  await page.mouse.move(v.width - 4, Math.round(v.height * 0.45));
  await sleep(300);
}
async function shot(target, name, opts = {}) {
  const file = path.join(shots, `${name}.jpg`);
  const page = typeof target.page === 'function' ? target.page() : target;
  if (opts.rest !== false) await rest(page);
  delete opts.rest;
  await target.screenshot({ path: file, type: 'jpeg', quality: 80, ...opts });
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
async function balances(keys) {
  const out = {};
  for (const [k, v] of Object.entries(keys)) out[k] = await rpc.balance(v.address);
  return out;
}
function lowKey(b) {
  const low = Object.entries(b).filter(([, v]) => v < LOW).map(([k, v]) => `${k} ${sol(v)} SOL`);
  return low.length ? low.join(', ') : null;
}

/** The coin-flip arena as this run puts it live: seeds in SOL at 1/100, ARENA the token already on the curve. */
async function economy() {
  const e = JSON.parse(await readFile(path.join(kitRoot, 'builder/web3/economy/fixtures/coin-flip-arena.json'), 'utf8'));
  for (const p of e.pools) if (p.seed) p.seed = Number((p.seed / 100).toFixed(9));
  e.tokens = e.tokens.map((t) => (t.key === 'arena' ? { key: 'arena', source: 'existing', mint: ARENA, name: 'Arena', symbol: 'ARENA', decimals: 6 } : t));
  return e;
}

/** What the game's kit saw: the menu's and the HUD's economy (CONTRACT §6g observation). */
const seen = (frame) => frame.evaluate(() => ({ menu: window.__game?.menu?.()?.economy ?? null, hud: window.__game?.hud?.()?.economy ?? null, view: window.__game?.menu?.()?.view ?? null }));
const menuButtons = (frame, where) => frame.evaluate((w) => [...document.querySelectorAll(`.gf-econ[data-where="${w}"] [data-econ]`)].map((b) => ({ id: b.dataset.econ, text: b.innerText.replace(/\s+/g, ' ').trim(), disabled: b.disabled })), where);
const hudLine = (frame, id) => frame.evaluate((i) => document.querySelector(`[data-where="hud"] [data-econ="${i}"] b`)?.textContent ?? '', id);

/** Nothing on top of any economy button or line: the element at its centre is the button (or inside it). The HUD lets
 *  clicks through (pointer-events: none), so each line and its ancestors take hits for the test alone. */
const overlaps = (frame) => frame.evaluate(() => {
  const out = [];
  for (const b of document.querySelectorAll('.gf-econ [data-econ]')) {
    const r = b.getBoundingClientRect();
    if (!r.width || !r.height || getComputedStyle(b).visibility === 'hidden') continue;
    const chain = [];
    for (let e = b; e && e !== document.documentElement; e = e.parentElement) chain.push([e, e.style.pointerEvents]);
    for (const [e] of chain) e.style.pointerEvents = 'auto';
    const at = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    for (const [e, v] of chain) e.style.pointerEvents = v;
    const off = r.right > innerWidth + 1 || r.bottom > innerHeight + 1 || r.x < -1 || r.y < -1;
    if ((at && !b.contains(at) && !at.contains(b)) || off) out.push({ id: b.dataset.econ, covered: at && !b.contains(at) ? (at.id || at.className || at.tagName) : null, offScreen: off });
  }
  return out;
});

/** A flip from the wallet view the frame shows: a real click, then the bridge's log line for it. */
async function flip(page, frame, logs, player, label) {
  const bal = await rpc.balance(player.address);
  if (bal < FLIP_FLOOR) {
    step(`${label}: no flip (the player has ${sol(bal)} SOL, under the 0.21 floor)`, { ok: true });
    return null;
  }
  const done = logs.filter((t) => t.includes('box:flip:open:')).length;
  await frame.locator('.gf-econ[data-where="menu"] [data-econ="box:flip:open"]').click();
  const pend = await until(async () => (await frame.evaluate(() => window.__game.menu().economy.state?.pending ?? [])).includes('box:flip:open') || logs.filter((t) => t.includes('box:flip:open:')).length > done, 20_000, 'the button to wait for the wallet').catch(() => false);
  await until(async () => logs.filter((t) => t.includes('box:flip:open:')).length > done, 300_000, `${label} to finish`);
  const bridge = logs.filter((t) => t.includes('box:flip:open:')).at(-1);
  const signatures = (bridge.match(/\(([^)]+)\)$/)?.[1] ?? '').split(', ').filter(Boolean);
  return { bridge, signatures, waited: Boolean(pend), spentSol: sol(bal - (await rpc.balance(player.address))) };
}

async function main() {
  if ((await rpc.call('getGenesisHash')) !== DEVNET_GENESIS) throw new Error('The RPC is not devnet.');
  const keys = { creator: await readKeyFile(keyFile('test-creator')), player: await readKeyFile(keyFile('test-buyer-1')), funder: await readKeyFile(keyFile('test-buyer-2')) };
  const { creator, player } = keys;
  const start = await balances(keys);
  result.start = start;
  Object.assign(result, { creator: creator.address, player: player.address, funder: keys.funder.address });
  step('keys on devnet', { lamports: start, ok: !lowKey(start), says: lowKey(start) ? `under 0.1 SOL: ${lowKey(start)}` : Object.entries(start).map(([k, v]) => `${k} ${sol(v)}`).join(', ') });
  if (lowKey(start)) throw new Error('A key is under 0.1 SOL: stopping before anything is spent.');

  // ---- 1. a game made the normal way, with the coin-flip arena
  if (args.includes('--fresh')) await rm(shots, { recursive: true, force: true });
  await mkdir(shots, { recursive: true });
  let config = null;
  try {
    config = JSON.parse(await readFile(path.join(gameDir, 'gamesfun.json'), 'utf8'));
  } catch {}
  if (!config?.economy || args.includes('--fresh')) {
    await mkdir(work, { recursive: true });
    const made = await run(process.execPath, [cli, 'create', gameDir, '--from', 'coin-hop', ...(existsSync(gameDir) ? ['--force'] : [])], { cwd: kitRoot, maxBuffer: 1 << 24 }).catch((e) => e);
    const out = `${made.stdout ?? ''}${made.stderr ?? ''}`;
    step('gamesfun create --from coin-hop', { ok: !made.code && /create: OK|OK/.test(out), says: out.split('\n').find((l) => /OK|error/i.test(l))?.trim() });
    config = JSON.parse(await readFile(path.join(gameDir, 'gamesfun.json'), 'utf8'));
    config.economy = await economy();
    await writeFile(path.join(gameDir, 'gamesfun.json'), `${JSON.stringify(config, null, 2)}\n`);
    step('the coin-flip arena written into the game’s gamesfun.json (seeds at 1/100, ARENA existing)', { pools: config.economy.pools.map((p) => `${p.key} ${p.seed ?? 0}`) });
  } else step('the game and its economy are kept from an earlier run (pass --fresh for a new one)', { game: config.economy.live?.game });

  process.env.GAMESFUN_WEB3 = '1';
  const server = await startDevServer({ gameDir, port: 0, log: () => {}, watch: false });
  const chrome = findChrome();
  const browser = await chromium.launch({ headless: true, args: chromeArgs, ...(chrome ? { executablePath: chrome.path } : {}) });
  const errors = [];
  try {
    // ---- 2. the creator puts it live from the Economy tab
    if (!config.economy.live?.game) {
      const signed = [];
      const studio = await browser.newPage({ viewport: { width: 1400, height: 950 } });
      studio.on('pageerror', (e) => errors.push(`studio: ${e.message}`));
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
      await shot(studio, '1-economy-tab-live');
      step('the Economy tab put the coin-flip arena live in the coin-hop game through the real flow (test-creator approving)', {
        ok: Boolean(live.game) && status.live && status.parts.every((p) => p.onChain && !p.differs),
        game: live.game, collection: live.collection, treasury: live.treasury, approvals: signed.map((s) => s.kind), transactions: live.transactions, explorer: explorerUrl(network, 'address', live.game ?? ''),
        status: { live: status.live, parts: status.parts.map((p) => `${p.part}:${p.key} ${p.onChain ? (p.differs ? 'differs' : 'on chain') : 'missing'}`), pools: status.pools },
        creatorSpentSol: sol(start.creator - (await rpc.balance(creator.address))),
      });
      await studio.close();
      if (!live.game) throw new Error('The economy did not go live.');
    } else {
      // nothing to sign: the Economy tab reads the live state back
      const studio = await browser.newPage({ viewport: { width: 1400, height: 950 } });
      studio.on('pageerror', (e) => errors.push(`studio: ${e.message}`));
      await injectWallet(studio, creator, { name: 'Creator Test Wallet' });
      await studio.goto(`${server.url}studio/?gamesfun_mock=0#economy`);
      await studio.locator('.panel:not([hidden]) [data-testid="tab-economy"] [data-testid="econ-status"]').waitFor({ timeout: 60_000 }).catch(() => {});
      const status = await studio.evaluate(async () => (await fetch('/api/web3/economy/status', { cache: 'no-store' })).json());
      await shot(studio, '1-economy-tab-live');
      await studio.close();
      step('the economy is already live from an earlier run; the Economy tab reads it back', {
        ok: status.live && status.parts.every((p) => p.onChain && !p.differs), game: config.economy.live.game, explorer: explorerUrl(network, 'address', config.economy.live.game),
        status: { live: status.live, parts: status.parts.map((p) => `${p.part}:${p.key} ${p.onChain ? (p.differs ? 'differs' : 'on chain') : 'missing'}`), pools: status.pools.map((p) => `${p.key} ${p.amount} ${p.symbol}`) },
      });
    }
    result.liveGame = config.economy.live.game;

    // ---- 3. the player in the studio preview
    {
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
      const page = await ctx.newPage();
      page.on('pageerror', (e) => errors.push(`studio preview: ${e.message}`));
      const logs = [];
      page.on('console', (m) => /host bridge/.test(m.text()) && logs.push(m.text()));
      const signed = [];
      await injectWallet(page, player, { log: signed, name: 'Player Test Wallet' });
      await page.goto(`${server.url}studio/?gamesfun_mock=0`);
      const frame = await until(async () => page.frames().find((f) => /\/game\/(\?|$)/.test(f.url()) && f !== page.mainFrame()), 30_000, 'the preview frame');
      await until(() => frame.evaluate(() => window.__game?.menu?.()?.view === 'home'), 60_000, 'the game’s home menu');
      await frame.locator('#gf-wallet').click();
      const buttons = await until(async () => { const b = await menuButtons(frame, 'menu'); return b.length >= 4 ? b : null; }, 60_000, 'the economy’s buttons in the wallet view');
      await sleep(1500);
      const frameEl = page.locator('#preview');
      await shot(frameEl, '2-studio-preview-wallet-view');
      const priceShown = buttons.some((b) => b.id === 'box:flip:open' && /0\.1 SOL/.test(b.text));
      const frameSize = await frame.evaluate(() => `${innerWidth}×${innerHeight}`);
      step('studio preview: the game’s own wallet view shows the economy’s buttons', {
        ok: ['Coin flip', 'Tickets', 'Stake', 'Unstake'].every((w) => buttons.some((b) => b.text.includes(w))),
        buttons, priceShown, frameSize, overlaps: await overlaps(frame),
        says: priceShown ? 'with their prices' : `labels only: the preview frame is ${frameSize}, and gf-three's menu hides a button's price and says line under 660 px of height (owed by gf-three)`,
      });
      if (!priceShown) result.owedByGfThree.push({ what: 'a paid economy button shows no price in a window 660 px tall or less', where: 'builder/ui/menu.js: @media (max-height:660px) { #gf-menu .gf-btn small { display:none } } hides the sub line, and econStrip puts the price only there (the results card puts it in the label)', repro: `the studio preview (${frameSize}) of a game with a live economy: home menu → wallet: "Coin flip" with no "0.1 SOL"`, screenshot: 'tests/web3/devnet/shots-real-game/2-studio-preview-wallet-view.jpg' });
      // connect with the game's own wallet pick (real click), then flip
      const pick = frame.locator('.gf-wallet-pick', { hasText: 'Player Test Wallet' });
      if (await pick.count()) {
        await pick.click();
        await until(() => frame.evaluate(() => window.__game.menu().wallet.status === 'connected'), 60_000, 'the wallet to connect');
      }
      step('studio preview: connected from the game’s wallet view (real click on the wallet pick)', { wallet: await frame.evaluate(() => window.__game.menu().wallet), signed: signed.map((s) => s.kind) });
      await sleep(3000);       // the bridge's first read of the state after connecting
      const f = await flip(page, frame, logs, player, 'studio preview flip');
      if (f) {
        await shot(frameEl, '3-studio-preview-after-flip');
        step('studio preview: clicked Coin flip in the game’s wallet view; the studio page signed (test-buyer-1)', { ...f, error: (await frame.evaluate(() => window.__game.menu().economy.state?.error)) || undefined });
      }
      // Play: the HUD's player card carries the lines
      await frame.locator('#gf-back').click().catch(() => frame.press('body', 'Escape'));
      await frame.locator('#gf-play').click();
      await until(async () => (await hudLine(frame, 'hud:balance:sol')) !== '', 30_000, 'the HUD balance line').catch(() => {});
      await sleep(4500);
      await shot(frameEl, '4-studio-preview-hud');
      const s = await seen(frame);
      step('studio preview: the HUD player card shows the economy’s lines', { ok: s.hud?.some((l) => l.id === 'hud:balance:sol' && l.shown) && (!f || s.hud.some((l) => l.id === 'hud:box:flip' && l.shown && l.text)), hud: s.hud, overlaps: await overlaps(frame) });
      result.studioPreview = { menuEconomy: s.menu, hudEconomy: s.hud, bridgeLog: logs };
      await ctx.close();
    }

    // ---- 4. the player in builder/studio/play.html: play, pause, flip from the pause menu's wallet view, resume, results
    {
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
      const page = await ctx.newPage();
      page.on('pageerror', (e) => errors.push(`play.html: ${e.message}`));
      page.on('console', (m) => {
        if (m.type() !== 'error' || /favicon|404/.test(m.text())) return;
        if (/status of 429/.test(m.text())) result.rpcRateLimited = (result.rpcRateLimited ?? 0) + 1;     // the public devnet RPC
        else errors.push(`play.html console: ${m.text().slice(0, 300)}`);
      });
      const logs = [];
      page.on('console', (m) => /host bridge/.test(m.text()) && logs.push(m.text()));
      const signed = [];
      await injectWallet(page, player, { log: signed, name: 'Player Test Wallet' });
      await page.goto(`${server.url}studio/play.html?gamesfun_mock=0`);
      const frame = await until(async () => page.frames().find((f) => /\/game\/(\?|$)/.test(f.url())), 30_000, 'the game frame');
      await until(() => frame.evaluate(() => window.__game?.menu?.()?.view === 'home'), 60_000, 'the game’s home menu');
      await until(() => frame.evaluate(() => window.__game.menu().economy.offers.length > 0), 60_000, 'the page’s offer');
      await sleep(1500);
      await shot(page, '5-play-home-menu');
      const home = await frame.evaluate(() => ({ buttons: window.__game.menu().buttons.filter((b) => b.shown).map((b) => b.id || b.label), econOnHome: document.querySelectorAll('#gf-menu .gf-econ').length }));
      step('play.html: the home menu (the economy is only in the wallet view, pause menu and results, as offered)', { ...home, ok: home.econOnHome === 0 });
      await frame.locator('#gf-wallet').click();
      const pick = frame.locator('.gf-wallet-pick', { hasText: 'Player Test Wallet' });
      await until(async () => (await pick.count()) > 0 || (await frame.evaluate(() => window.__game.menu().wallet.status)) === 'connected', 20_000, 'the wallet pick');
      if (await pick.count()) {
        await pick.click();
        await until(() => frame.evaluate(() => window.__game.menu().wallet.status === 'connected'), 60_000, 'the wallet to connect');
      }
      const buttons = await until(async () => { const b = await menuButtons(frame, 'menu'); return b.length >= 4 ? b : null; }, 60_000, 'the economy’s buttons');
      await sleep(3000);
      await shot(page, '6-play-wallet-view-connected');
      step('play.html: wallet view, connected with a real click; the economy’s buttons', { buttons, wallet: (await frame.evaluate(() => window.__game.menu().wallet)).short, overlaps: await overlaps(frame), ok: buttons.length >= 4 });

      await frame.locator('#gf-back').click();
      await frame.locator('#gf-play').click();
      await until(() => frame.evaluate(() => window.__game.menu().view === null), 15_000, 'the round to start');
      await sleep(5000);       // the countdown
      const hudBefore = (await seen(frame)).hud;
      await page.keyboard.press('Escape');
      await until(() => frame.evaluate(() => window.__game.menu().view === 'pause'), 10_000, 'the pause menu');
      await sleep(800);
      await shot(page, '7-play-pause-menu');
      const pause = await frame.evaluate(() => ({ buttons: window.__game.menu().buttons.filter((b) => b.shown).map((b) => `${b.id || ''} ${b.label}`.trim()), wallet: document.querySelector('#gf-wallet')?.innerText.replace(/\s+/g, ' ').trim(), econ: [...document.querySelectorAll('.gf-econ[data-where="pause"] [data-econ]')].map((b) => b.dataset.econ), paused: window.__game.menu().pause }));
      step('play.html: Esc opens the pause menu (the round stops; the wallet button says what the wallet holds, never “Reading your items…” in a game with no items)', { ...pause, ok: pause.paused && !/Reading your items/.test(pause.wallet ?? ''), says: `${pause.buttons.length} buttons; wallet "${pause.wallet}"; the economy's 'pause' strip: ${pause.econ.length ? pause.econ.join(', ') : 'none (nothing is offered at pause; the wallet button leads to the buttons)'}` });
      await frame.locator('#gf-wallet').click();
      await until(async () => (await menuButtons(frame, 'menu')).length >= 4, 20_000, 'the buttons in the pause menu’s wallet view');
      await shot(page, '8-play-pause-wallet-view');
      const f = await flip(page, frame, logs, player, 'play.html flip');
      if (f) {
        await sleep(1000);
        await shot(page, '9-play-after-flip');
        step('play.html: clicked Coin flip in the pause menu’s wallet view; the page signed (test-buyer-1)', { ...f, error: (await frame.evaluate(() => window.__game.menu().economy.state?.error)) || undefined });
      }
      await page.keyboard.press('Escape');                 // back to the pause menu
      await until(() => frame.evaluate(() => window.__game.menu().view === 'pause'), 10_000, 'the pause menu again');
      await frame.locator('#gf-resume').click();
      await until(() => frame.evaluate(() => window.__game.menu().view === null), 10_000, 'the round to resume');
      await sleep(2500);
      const after = await seen(frame);
      await shot(page, '10-play-hud-after-flip');
      const flipLine = after.hud?.find((l) => l.id === 'hud:box:flip');
      const balBefore = hudBefore?.find((l) => l.id === 'hud:balance:sol')?.text;
      const balAfter = after.hud?.find((l) => l.id === 'hud:balance:sol')?.text;
      step('play.html: the HUD player card’s lines changed with the flip', { ok: !f || (Boolean(flipLine?.shown && flipLine.text) && balBefore !== balAfter), before: hudBefore, after: after.hud, overlaps: await overlaps(frame) });
      // a crop of the player card, at real pixels
      const card = await frame.evaluate(() => { const r = document.querySelector('#gf-econ-hud')?.parentElement?.getBoundingClientRect(); return r ? { x: r.x, y: r.y, width: r.width, height: r.height } : null; });
      if (card) await shot(page, '11-play-hud-card-crop', { clip: { x: Math.max(0, card.x - 8), y: Math.max(0, card.y - 8), width: Math.min(1280, card.width + 16), height: Math.min(720, card.height + 16) } });

      // the round runs out (60 s; the pause held its clock): the results card
      await until(() => frame.evaluate(() => /results/.test(window.__game?.snapshot?.()?.view ?? '') || !!document.querySelector('#gf-again, #gf-to-menu')), 120_000, 'the results card');
      await sleep(2500);
      await shot(page, '12-play-results');
      const results = await menuButtons(frame, 'results');
      step('play.html: the round ran out; the results card', { results, says: results.length ? results.map((b) => b.text).join(', ') : 'nothing claimable (a flip pays with the flip itself; the lottery draws in 7 days)', overlaps: await overlaps(frame) });
      for (const b of results.filter((x) => /claim/.test(x.id))) {
        const done = logs.filter((t) => t.includes(`${b.id}:`)).length;
        await frame.locator(`.gf-econ[data-where="results"] [data-econ="${b.id}"]`).click();
        await until(async () => logs.filter((t) => t.includes(`${b.id}:`)).length > done, 300_000, `claim ${b.id}`);
        await shot(page, '13-play-after-claim');
        step(`play.html: Claim on the results card (${b.id})`, { bridge: logs.filter((t) => t.includes(`${b.id}:`)).at(-1), error: (await frame.evaluate(() => window.__game.menu().economy.state?.error)) || undefined });
      }

      // a phone's width: the same page at 390×844 (the bridge's state carries over)
      await page.setViewportSize({ width: 390, height: 844 });
      await sleep(1500);
      const toMenu = frame.locator('#gf-to-menu');
      if (await toMenu.count()) await toMenu.click();
      await until(() => frame.evaluate(() => window.__game.menu().view === 'home'), 15_000, 'the home menu').catch(() => {});
      await frame.locator('#gf-wallet').click();
      await until(async () => (await menuButtons(frame, 'menu')).length >= 4, 20_000, 'the buttons at phone width');
      await sleep(800);
      await shot(page, '14-phone-wallet-view');
      const phoneWallet = await overlaps(frame);
      await frame.locator('#gf-back').click();
      await frame.locator('#gf-play').click();
      await sleep(6000);
      await shot(page, '15-phone-hud');
      const pcard = await frame.evaluate(() => { const r = document.querySelector('#gf-econ-hud')?.parentElement?.getBoundingClientRect(); return r ? { x: r.x, y: r.y, width: r.width, height: r.height } : null; });
      if (pcard) await shot(page, '16-phone-hud-card-crop', { clip: { x: Math.max(0, pcard.x - 6), y: Math.max(0, pcard.y - 6), width: Math.min(390, pcard.width + 12), height: pcard.height + 12 } });
      const phone = await seen(frame);
      step('play.html at 390×844: the wallet view’s buttons and the HUD lines', { ok: !phoneWallet.length && (phone.hud ?? []).every((l) => l.shown), walletOverlaps: phoneWallet, hud: phone.hud, hudOverlaps: await overlaps(frame) });

      result.playPage = { menuEconomy: phone.menu, hudEconomy: phone.hud, bridgeLog: logs, signed: signed.map((s) => s.kind) };
      await ctx.close();
    }
    step('page errors (studio, preview, play.html)', { ok: errors.length === 0, errors });
  } finally {
    await browser.close();
    await server.close();
  }

  // ---- 5. the game's verify
  // --quick leaves out the release-only checks (tools/lib/verdict.mjs RELEASE_ONLY), 22 among them: it runs on its own after
  for (const which of verifyChecks === 'none' ? [] : verifyChecks === 'quick' ? ['quick', '22'] : [verifyChecks]) {
    const vargs = [cli, 'verify', gameDir, ...(which === 'quick' ? ['--quick'] : ['--check', which])];
    const v = await run(process.execPath, vargs, { cwd: kitRoot, env: process.env, maxBuffer: 1 << 26, timeout: 1_800_000 }).catch((e) => e);
    const out = `${v.stdout ?? ''}${v.stderr ?? ''}`;
    const line = out.split('\n').find((l) => /^verify .*(PASS|FAIL)/.test(l)) ?? '';
    const file = line.match(/→ (.+verdict\.json)/)?.[1];
    const verdict = file ? JSON.parse(await readFile(path.resolve(kitRoot, file), 'utf8').catch(() => 'null')) : null;
    const checks = (verdict?.checks ?? []).map((c) => `${c.n} ${c.ok === null ? 'skipped' : c.ok ? 'pass' : 'FAIL'}: ${c.name}`);
    step(`gamesfun verify ${which === 'quick' ? '--quick' : `--check ${which}`} on the game with its live economy`, {
      ok: !v.code && /PASS/.test(line), says: line.replace(/^verify \S+: /, ''), checks, verdict: file ? path.relative(kitRoot, path.resolve(kitRoot, file)) : null,
      failed: (verdict?.checks ?? []).filter((c) => c.ok === false).map((c) => ({ n: c.n, name: c.name, detail: c.detail })), tail: line ? undefined : out.slice(-3000),
    });
  }

  // ---- 6. the economy check against devnet, and its oracle fee against the cost model
  if (!args.includes('--no-check')) {
    const mid = await balances(keys);
    if (lowKey(mid)) throw new Error(`A key is under 0.1 SOL (${lowKey(mid)}): the devnet check is not run.`);
    const out = path.join(here, 'proof-real-game-check.json');
    const c = await run(process.execPath, [cli, 'economy', 'check', '--devnet', gameDir, '--tries', '3', '--out', out], { env: { ...process.env, GAMESFUN_DEVNET_KEY: keyFile('test-buyer-2') }, maxBuffer: 1 << 24, timeout: 1_200_000 }).catch((e) => e);
    console.log(c.stdout ?? '');
    const record = JSON.parse(await readFile(out, 'utf8').catch(() => 'null'));
    step('gamesfun economy check --devnet (test-buyer-2 funds the synthetic player)', { ok: !c.code, verdict: record?.verdict, won: record?.won, spentSol: record?.spent ? sol(record.spent) : null, record: path.relative(kitRoot, out), stderr: c.stderr?.slice(-2000) || undefined });
    const fees = (record?.steps ?? []).filter((s) => s.player?.oracleFee !== undefined).map((s) => BigInt(s.player.oracleFee));
    step('the oracle fee the check measured matches the cost model’s constant (model.mjs ORACLE_FEE)', {
      ok: fees.length > 0 && fees.every((f) => f === ORACLE_FEE), constant: `${ORACLE_FEE} lamports (${sol(ORACLE_FEE)} SOL)`, measured: fees.map((f) => `${f}`), says: `${fees.length} open(s), each ${[...new Set(fees.map(String))].join(' / ') || 'none'} lamports vs ${ORACLE_FEE}`,
    });
  }
  result.end = await balances(keys);
  result.spentSol = Object.fromEntries(Object.keys(keys).map((k) => [k, sol(result.start[k] - result.end[k])]));
}

// earlier runs stay in the record (each run's own result, newest last)
try {
  const before = JSON.parse(await readFile(path.join(here, 'proof-real-game-result.json'), 'utf8'));
  result.earlierRuns = [...(before.earlierRuns ?? []), { ...before, earlierRuns: undefined }];
} catch {}
try {
  await main();
} catch (e) {
  step('stopped', { ok: false, error: e.message });
} finally {
  result.finishedAt = new Date().toISOString();
  result.ok = result.steps.every((s) => s.ok);
  await writeFile(path.join(here, 'proof-real-game-result.json'), `${JSON.stringify(result, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2)}\n`);
  console.log(`wrote tests/web3/devnet/proof-real-game-result.json (${result.ok ? 'ok' : 'problems'})`);
}
