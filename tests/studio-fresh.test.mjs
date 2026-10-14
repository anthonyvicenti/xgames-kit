// Nothing is shown before the person's first prompt (an example game as the preview before it is confusing). In real Chrome on the dev server, with
// every request the page makes recorded: a fresh start page, a start page with two games in games/, and the page right
// after a first idea is sent (no session connected) load no game page and no example, and the preview frame stays
// empty. While the build loop makes the game the preview says so, even after create wrote the folder; the person's own
// game loads only when its first build is delivered (which also shows this test sees a game frame when there is one).
// FRESH_SHOTS=<dir> saves a screenshot of each state at 1440x900 and 390x844.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { findChrome } from '../builder/lib/chrome.mjs';
import { createGame } from '../builder/lib/create.mjs';
import { startDevServer } from '../builder/server/index.mjs';
import { tempDir } from './helpers.mjs';

let chromium = null;
try { ({ chromium } = await import('playwright-core')); } catch {}

// what a page that shows no game may still fetch: the studio's own files, its API, live reload and the favicon
const STUDIO_ONLY = /^\/(studio\/|api\/|__gamesfun\/events$|favicon\.ico$)/;

describe('the studio shows no game before the first prompt', { skip: !chromium && 'playwright-core is not installed' }, () => {
  let browser, root, server;
  const shots = process.env.FRESH_SHOTS ? path.resolve(process.env.FRESH_SHOTS) : null;

  before(async () => {
    const found = findChrome();
    for (const o of [found ? { executablePath: found.path } : null, {}].filter(Boolean)) { try { browser = await chromium.launch({ headless: true, ...o }); break; } catch {} }
    root = await tempDir('gamesfun-fresh-');
    await mkdir(path.join(root.dir, 'games'), { recursive: true });
    server = await startDevServer({ gamesRoot: path.join(root.dir, 'games'), port: 0, log: () => {}, watch: false });
    if (shots) await mkdir(shots, { recursive: true });
  });
  after(async () => { await browser?.close(); await server?.close(); await root?.cleanup(); });

  /** A page that records every request and every frame it loads. */
  async function open(width = 1440, height = 900) {
    const page = await browser.newPage({ viewport: { width, height } });
    const seen = [];
    page.on('request', r => { const u = new URL(r.url()); if (u.protocol.startsWith('http')) seen.push(u.pathname); });
    await page.goto(`${server.url}studio/`);
    return { page, seen, frames: () => page.frames().filter(f => f !== page.mainFrame()).map(f => f.url()) };
  }
  async function noGame({ page, seen, frames }, what) {
    await page.waitForTimeout(1500);                          // the page's own polls and any late frame have had their turn
    const stray = seen.filter(p => !STUDIO_ONLY.test(p));
    assert.deepEqual(stray, [], `${what}: the page loaded something that is not the studio: ${stray.join(', ')}`);
    assert.ok(!seen.some(p => p.startsWith('/game/')), `${what}: a game page was requested`);
    assert.deepEqual(frames().filter(u => u !== 'about:blank'), [], `${what}: a frame loaded ${frames().join(', ')}`);
    assert.equal(await page.locator('#preview').getAttribute('src'), 'about:blank', `${what}: the preview frame is empty`);
  }
  async function shot(name, state) {
    if (!shots) return;
    for (const [w, h] of [[1440, 900], [390, 844]]) {
      const v = await open(w, h);
      await state?.(v.page);
      await v.page.waitForTimeout(1200);
      await v.page.screenshot({ path: path.join(shots, `${name}-${w}x${h}.png`) });
      await v.page.close();
    }
  }

  it('a fresh start page: no game, no example, an empty preview', async t => {
    if (!browser) return t.skip('no browser');
    const v = await open();
    await v.page.locator('#start-input').waitFor();
    assert.equal(await v.page.evaluate(() => document.documentElement.dataset.view), 'start');
    assert.equal(await v.page.locator('.product').isVisible(), false, 'the game side is not on the page');
    assert.equal(await v.page.locator('.start-games .empty').textContent(), 'No games yet. Describe one above, or start from an example below.');
    // the examples are a choice the person makes, never a preview
    assert.ok(await v.page.locator('[data-example="soak-squad"]').count());
    await noGame(v, 'fresh start page');
    await v.page.close();
    await shot('1-fresh-start');
  });

  it('two games in games/: listed as choices, none opened, none remembered', async t => {
    if (!browser) return t.skip('no browser');
    await createGame(path.join(root.dir, 'games', 'water-fight'), { from: 'soak-squad' });
    await createGame(path.join(root.dir, 'games', 'four-up'), { from: 'giant-four' });
    const v = await open();
    await v.page.locator('.game-card[data-game]').nth(1).waitFor();
    assert.deepEqual((await v.page.locator('.game-card[data-game]').evaluateAll(cs => cs.map(c => c.dataset.game))).sort(), ['four-up', 'water-fight']);
    await noGame(v, 'start page with two games');
    // a reload is still the start page: nothing was opened for the person
    await v.page.reload();
    await v.page.locator('.game-card[data-game]').nth(1).waitFor();
    assert.equal(await v.page.evaluate(() => document.documentElement.dataset.view), 'start');
    await noGame(v, 'start page with two games, reloaded');
    await v.page.close();
    await shot('2-two-games');
  });

  it('right after the first idea is sent (no session connected): "Waiting for your session", no frame; "Making your game" once the loop acts', async t => {
    if (!browser) return t.skip('no browser');
    const v = await open();
    await v.page.locator('#start-input').fill('Bumper boats in a pool, last one floating wins');
    await v.page.locator('#start-go').click();
    await v.page.waitForFunction(() => document.documentElement.dataset.view === 'making');
    const empty = v.page.locator('#product-empty');
    await empty.waitFor({ state: 'visible', timeout: 10000 });     // the view switches before the conversation is mounted
    await empty.locator('h2').waitFor();
    assert.equal(await empty.locator('h2').textContent(), 'Waiting for your session', 'no session: nothing is being made, and the page says so');
    assert.match(await empty.locator('p').textContent(), /nothing is being made yet.*session wait/);
    assert.equal(await v.page.locator('.frame-wrap').isVisible(), false, 'no game frame on the page');
    await noGame(v, 'after the first idea');
    const name = (await v.page.evaluate(() => fetch('/api/studio/project').then(r => r.json()))).project.name;
    assert.equal(name, 'bumper-boats-pool-last');
    await shot('3-first-idea');

    // the build loop's first build: create wrote the folder, and it is still not shown while the loop works
    const dir = path.join(root.dir, 'games', name);
    await mkdir(path.join(dir, '.gf-loop'), { recursive: true });
    const state = status => writeFile(path.join(dir, '.gf-loop', 'state.json'), JSON.stringify({ schema: 'gf-loop/1', kind: 'build', status, step: status === 'delivered' ? 'done' : 'verify', history: [] }));
    await state('building');
    await v.page.waitForFunction(() => document.querySelector('#product-empty h2')?.textContent === 'Making your game', null, { timeout: 60000 });
    await createGame(dir, { from: 'soak-squad', force: true });     // stands in for create --spec: the folder is a game on disk
    await v.page.waitForTimeout(4500);                                // two of the conversation's polls of the loop
    assert.equal(await v.page.evaluate(() => document.documentElement.dataset.view), 'making');
    assert.equal(await empty.locator('h2').textContent(), 'Making your game', 'the loop acts: now it is being made');
    await noGame(v, 'during the first build');
    assert.equal((await fetch(`${server.url}game/`)).status, 404, 'the game page is not served during the first build');

    // delivered: the person's own game opens, and this test does see a game frame when one loads
    await state('delivered');
    await v.page.waitForFunction(() => document.documentElement.dataset.view === 'game', null, { timeout: 60000 });
    await v.page.waitForFunction(() => document.querySelector('#preview').getAttribute('src') !== 'about:blank');
    await v.page.waitForTimeout(500);
    assert.ok(v.seen.some(p => p.startsWith('/game/')), 'the game page loads once its first build is done');
    await v.page.close();
  });
});
