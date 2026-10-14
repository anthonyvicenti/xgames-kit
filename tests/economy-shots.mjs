// Screenshots of the studio's Economy tab, in real Chrome on real dev servers: three example games, each given an
// economy from builder/web3/economy/fixtures (coin-flip-arena, blind-forge, duel-arena), at desktop width (1440) and phone
// width (390), in the light and the dark theme (chosen the way the studio shell chooses it: ?theme=light|dark wins for
// the visit, then localStorage gamesfun.theme, else dark; the OS setting no longer decides it). The chain is not read:
// the live state (GET /economy/status, built by the economy publish work) is stubbed in the page for the "live" shots,
// and the notes say so.
// Run through the graphics-card gate (the preview is the game):  gpu-run.sh node tests/economy-shots.mjs <out dir> [first port]
// Writes <out>/*.png and <out>/shots.json.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createGame } from '../builder/lib/create.mjs';
import { ensureBrowser } from '../builder/lib/chrome.mjs';
import { startDevServer } from '../builder/server/index.mjs';

const out = path.resolve(process.argv[2] ?? 'economy-shots');
const basePort = Number(process.argv[3] ?? 6104);
await mkdir(out, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const root = path.join(os.tmpdir(), `gf-economy-shots-${process.pid}`);
const notes = [];
const problems = [];
const note = (file, what) => (notes.push({ file, what }), console.log(`${file}\t${what}`));
const fixture = async (name) => JSON.parse(await readFile(new URL(`../builder/web3/economy/fixtures/${name}.json`, import.meta.url), 'utf8'));

process.env.GAMESFUN_WEB3 = '1';
const GAMES = [
  { id: 'arena', example: 'coin-hop', economy: 'coin-flip-arena' },
  { id: 'forge', example: 'soak-squad', economy: 'blind-forge' },
  { id: 'duel', example: 'giant-four', economy: 'duel-arena' },
];
const servers = {};
let port = basePort;
for (const g of GAMES) {
  const dir = path.join(root, g.id);
  await createGame(dir, { from: g.example });
  await writeFile(path.join(dir, 'gamesfun.json'), `${JSON.stringify({ version: 1, network: 'devnet', economy: await fixture(g.economy) }, null, 2)}\n`);
  servers[g.id] = { dir, srv: await startDevServer({ gameDir: dir, port: port++, log: () => {}, watch: false }) };
}

const b = await ensureBrowser({});
const { chromium } = await import('playwright-core');
const browser = await chromium.launch({ executablePath: b.path, headless: true, args: ['--enable-gpu', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required', ...(process.env.CHROME_ARGS ?? '').split(/\s+/).filter(Boolean)] });

const LIVE = {
  live: true,
  program: '88Labq6tdVnBQsjHSfic6qqgvo5b9NGmy99AYj7KVXqM',
  game: 'GmeXcV3pC8tbA2nXwJ7kJ6s1h2T9hJ3tQ1aZ7vXk4pQe',
  parts: [
    { part: 'pool', key: 'house', onChain: true, differs: false },
    { part: 'pool', key: 'backers', onChain: true, differs: false },
    { part: 'pool', key: 'pot', onChain: true, differs: false },
    { part: 'box', key: 'flip', onChain: true, differs: true },
    { part: 'lottery', key: 'weekly', onChain: true, differs: false },
    { part: 'stake', key: 'backers', onChain: true, differs: false },
  ],
  pools: [{ index: 0, key: 'house', balance: 5.412 }, { index: 1, key: 'backers', balance: 0.18 }, { index: 2, key: 'pot', balance: 3.05 }],
  receipts: [
    { says: 'Put the economy live (2 transactions)', signature: '5u3YgKk2y7a9w3C6Rz8bWf3pE8w9Qq7d1JcX2vQ4mB8tK1n6Hc3sR2aP9fL5eD7gT4xY6zN8vM1qW3eR5tY7uI9o', at: '2026-10-11T18:02:00Z' },
    { says: 'A player opened “Coin flip”: paid 0.176 SOL from house', signature: '3jK9mN2bV5cX8zA1sD4fG7hJ0kL3pO6iU9yT2rE5wQ8aZ1xC4vB7nM0lK3jH6gF9dS2aP5oI8uY1tR4eW7qZ0xC3v', at: '2026-10-11T18:05:41Z' },
  ],
};

async function page(id, w, h, scheme, { live = false, hash = '' } = {}) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1, colorScheme: scheme });
  const p = await ctx.newPage();
  p.errors = [];
  p.on('pageerror', (e) => p.errors.push(e.message));
  p.on('console', (m) => {
    if (m.type() === 'error' && !/favicon|404|status of 4/.test(m.text())) p.errors.push(m.text());
  });
  // the economy's live state is econ-publish's route; until it is merged the page reads this stub, or a 404
  await p.route('**/api/web3/economy/status', (route) => (live ? route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(LIVE) }) : route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"no route"}' })));
  await p.addInitScript(() => {
    try {
      localStorage.setItem('gamesfun.tab', 'economy');
    } catch {}
  });
  // the shell's theme: ?theme= for this visit (builder/studio/index.html reads it before the first paint)
  await p.goto(`http://127.0.0.1:${servers[id].srv.port}/studio/?theme=${scheme}${hash}`, { waitUntil: 'load' });
  await p.locator('.panel:not([hidden]) [data-testid="econ-flow"]').waitFor({ timeout: 20_000 });
  const theme = await p.evaluate(() => document.documentElement.dataset.theme);
  if (theme !== scheme) problems.push(`${id} ${w}: asked for the ${scheme} theme, the page shows ${theme}`);
  await sleep(1500);
  return p;
}
const shot = async (p, name, what, opts = {}) => {
  await sleep(300);
  await p.screenshot({ path: path.join(out, `${name}.png`), ...opts });
  note(`${name}.png`, what);
};
/** The whole tab: a desktop panel scrolls inside itself, so the window is made as tall as the panel. */
async function wholeTab(p, name, what) {
  const tall = await p.evaluate(() => {
    const panels = document.querySelector('.panels');
    return Math.ceil(panels.scrollHeight + panels.getBoundingClientRect().top + 8);
  });
  const vp = p.viewportSize();
  await p.setViewportSize({ width: vp.width, height: Math.min(tall, 9000) });
  await sleep(600);
  await shot(p, name, what);
  await p.setViewportSize(vp);
}
const check = async (p, name) => {
  const [sw, iw] = await p.evaluate(() => [document.documentElement.scrollWidth, innerWidth]);
  if (sw > iw) problems.push(`${name}: sideways scroll ${sw} > ${iw}`);
  const svg = await p.evaluate(() => {
    const s = document.querySelector('.panel:not([hidden]) [data-testid="econ-flow"]');
    const box = s?.closest('[data-testid="econ-flow-box"]');
    return s && box ? [s.getBoundingClientRect().width, box.getBoundingClientRect().width] : [0, 0];
  });
  if (svg[0] > svg[1] + 1) problems.push(`${name}: the flow picture is wider than its card (${svg[0]} > ${svg[1]})`);
  const errs = p.errors.filter((x) => !/WebGL|gpu|GPU/.test(x));
  if (errs.length) problems.push(`${name}: ${errs.join(' | ')}`);
};

try {
  for (const scheme of ['light', 'dark']) {
    // ---- desktop, 1440 wide ----
    for (const g of GAMES) {
      const p = await page(g.id, 1440, 900, scheme, { live: g.id === 'arena' });
      await shot(p, `desktop-${scheme}-${g.id}-1-top`, `${g.economy} at 1440×900 (${scheme}): the cost and "Put it live", the money flow${g.id === 'arena' ? '; live state stubbed: green dots are live parts, amber is a part changed since' : ''}`);
      await wholeTab(p, `desktop-${scheme}-${g.id}-2-whole`, `${g.economy} (${scheme}): the whole tab, top to bottom (window made as tall as the panel)`);
      await check(p, `desktop-${scheme}-${g.id}`);
      await p.context().close();
    }
    // ---- phone, 390 wide ----
    for (const g of GAMES) {
      const p = await page(g.id, 390, 844, scheme, { live: g.id === 'arena' });
      await p.evaluate(() => document.querySelector('.side').scrollIntoView());
      await shot(p, `phone-${scheme}-${g.id}-1-top`, `${g.economy} at 390×844 (${scheme}), scrolled to the tab`);
      await shot(p, `phone-${scheme}-${g.id}-2-whole`, `${g.economy} at 390 wide (${scheme}): the whole page`, { fullPage: true });
      await check(p, `phone-${scheme}-${g.id}`);
      await p.context().close();
    }
  }

  // ---- interactions on the arena, desktop light: a click on the flow, a typed price, a bad number, a new lottery ----
  {
    const p = await page('arena', 1440, 900, 'light');
    const tab = p.locator('.panel:not([hidden])');
    await tab.locator('[data-part="pools:pot"]').click();
    await sleep(900);
    await shot(p, 'desktop-light-arena-3-picked', 'A click on the pool "pot" in the picture opens its card (flash ring), with its numbers: in and out a day, how long it lasts');
    const price = tab.locator('[data-path="boxes:flip|price"]');
    await price.scrollIntoViewIfNeeded();
    await price.fill('0.2');
    await sleep(1600);
    await shot(p, 'desktop-light-arena-4-typed', 'The flip\'s price typed as 0.2: the numbers beside it follow (a roll gives back 0.088 now, 44%) and the picture\'s label reads 0.2');
    const chance = tab.locator('[data-path="boxes:flip|outcomes.0.odds"]');
    await chance.fill('70');
    await sleep(1600);
    await shot(p, 'desktop-light-arena-5-refusal', 'A chance of 70% (with 50% for nothing): the checker\'s refusal sits in the box\'s card with its fix, and "Put it live" is off with the reason');
    await tab.locator('[data-testid="econ-go"]').scrollIntoViewIfNeeded();
    await shot(p, 'desktop-light-arena-6-go-blocked', '"Put it live" off: "Fix the 1 note marked ✗ first", with Show me');
    await chance.fill('50');
    await sleep(1400);
    await tab.locator('[data-testid="econ-add-lottery"]').click();
    await sleep(1800);
    await shot(p, 'desktop-light-arena-7-added', 'Add a lottery: a new "Weekly draw" with a pot of its own, scrolled to and opened; the picture gains it');
    await check(p, 'interactions');
    const saved = JSON.parse(await readFile(path.join(servers.arena.dir, 'gamesfun.json'), 'utf8'));
    if (saved.economy.boxes[0].price !== 0.2) problems.push(`the typed price was not saved: ${saved.economy.boxes[0].price}`);
    if ((saved.economy.lotteries ?? []).length !== 2) problems.push('the new lottery was not saved');
    await p.context().close();
  }
  // ---- links from the agent's tools: "Put it live" offered (not started), and a decision shown for K4 ----
  {
    const p = await page('forge', 390, 844, 'dark', { hash: '#economy?flow=economy' });
    await p.evaluate(() => document.querySelector('.side').scrollIntoView());
    await shot(p, 'phone-dark-forge-3-link-publish', 'Opened from economy_publish\'s link (#economy?flow=economy): the Economy tab is selected and "Put it live" is offered at once; nothing starts until the click');
    await p.context().close();
    const q = await page('duel', 1440, 900, 'light', { hash: '#economy?decide=duel-result&side=2' });
    await shot(q, 'desktop-light-duel-3-link-decide', 'Opened from a decision link (#economy?decide=…): the "Decision (coming in K4)" note with the link\'s values; nothing is signed');
    await check(q, 'decide');
    await q.context().close();
  }
  // ---- a game with a shop and no economy yet: shown migrated, at phone width ----
  {
    const dir = path.join(root, 'shop');
    await createGame(dir, { from: 'coin-hop' });
    await writeFile(path.join(dir, 'gamesfun.json'), `${JSON.stringify({ version: 1, network: 'devnet', shop: { name: 'Coin Hop Shop', royaltyBps: 500, items: [{ id: 1, name: 'Golden Cap', rarity: 'Rare', price: '50000000', maxSupply: 100 }, { id: 2, name: 'Ice Boots', rarity: 'Common', price: '0', maxSupply: 0 }], boxes: [{ id: 1, name: 'Mystery Box', price: '10000000', entries: [{ item: 1, weight: 1 }, { item: 2, weight: 9 }] }] } }, null, 2)}\n`);
    servers.shop = { dir, srv: await startDevServer({ gameDir: dir, port: port++, log: () => {}, watch: false }) };
    const p = await page('shop', 390, 844, 'light');
    await p.evaluate(() => document.querySelector('.side').scrollIntoView());
    await shot(p, 'phone-light-shop-1-migrated', 'A game with only a shop: shown as an economy (two items, a box of them), saved as one at the first change');
    await shot(p, 'phone-light-shop-2-whole', 'The migrated shop, the whole page at 390 wide', { fullPage: true });
    await check(p, 'shop');
    await p.context().close();
  }
} finally {
  await browser.close();
  for (const { srv } of Object.values(servers)) await srv.close();
  await writeFile(path.join(out, 'shots.json'), `${JSON.stringify({ notes, problems }, null, 2)}\n`);
  console.log(problems.length ? `PROBLEMS:\n${problems.join('\n')}` : 'no problems found');
}
