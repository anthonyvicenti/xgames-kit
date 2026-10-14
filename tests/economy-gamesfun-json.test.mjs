// A game with no gamesfun.json stays quiet. The studio's host bridge (builder/studio/host-bridge.js) and a game's own gf/web3
// read /game/gamesfun.json; without the file the dev server answers 204 (no web3 settings, no body) instead of a 404
// that Chrome prints as a console error on every hello. A real gamesfun.json still loads as before.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createGfWeb3 } from '../builder/web3/gf-web3/index.js';
import { startDevServer } from '../builder/server/index.mjs';
import { findChrome } from '../builder/lib/chrome.mjs';
import { makeGame } from './web3/helpers.mjs';

const FIXTURE = JSON.parse(await readFile(new URL('../builder/web3/economy/fixtures/coin-flip-arena.json', import.meta.url), 'utf8'));
const STAND_IN = await readFile(new URL('./web3/stand-in/index.html', import.meta.url), 'utf8');

describe('/game/gamesfun.json on the dev server', () => {
  let game, server;
  const file = () => path.join(game.gameDir, 'gamesfun.json');
  before(async () => {
    game = await makeGame();
    server = await startDevServer({ gameDir: game.gameDir, port: 0, log: () => {}, watch: false });
  });
  after(async () => {
    await server?.close();
    await rm(game.root, { recursive: true, force: true });
  });

  it('a game without one: 204 and no body, which gf-web3 reads as no economy, without a warning', async () => {
    const r = await fetch(`${server.url}game/gamesfun.json`);
    assert.equal(r.status, 204);
    assert.equal(await r.text(), '');
    const warned = [];
    const warn = console.warn;
    console.warn = (...a) => warned.push(a.join(' '));
    try {
      const gf = createGfWeb3({ configUrl: `${server.url}game/gamesfun.json`, mock: true });
      const config = await gf.ready();
      assert.equal(config.economy ?? null, null);
    } finally {
      console.warn = warn;
    }
    assert.deepEqual(warned, []);
  });

  it('a real one still loads, whole, and other missing files are still 404', async () => {
    const config = { version: 1, network: 'devnet', economy: FIXTURE };
    await writeFile(file(), JSON.stringify(config, null, 2));
    try {
      const r = await fetch(`${server.url}game/gamesfun.json`);
      assert.equal(r.status, 200);
      assert.deepEqual(await r.json(), config);
      const gf = createGfWeb3({ configUrl: `${server.url}game/gamesfun.json`, mock: true });
      assert.equal((await gf.ready()).economy?.name, FIXTURE.name);
    } finally {
      await rm(file(), { force: true });
    }
    assert.equal((await fetch(`${server.url}game/nothing-here.json`)).status, 404);
    assert.equal((await fetch(`${server.url}game/gamesfun.json`)).status, 204, 'and 204 again once the file is gone');
  });
});

// ---------------------------------------------------------------------------------------------------- in Chrome
let chromium = null;
try {
  ({ chromium } = await import('playwright-core'));
} catch {}

describe('the studio with a game that has no gamesfun.json (Chrome)', { skip: !chromium && 'playwright-core is not installed' }, () => {
  let browser, server, game;
  before(async () => {
    const found = findChrome();
    for (const options of [found ? { executablePath: found.path } : null, {}].filter(Boolean)) {
      browser = await chromium.launch({ headless: true, ...options }).catch(() => null);
      if (browser) break;
    }
    if (!browser) return;
    game = await makeGame();
    await writeFile(path.join(game.gameDir, 'index.html'), STAND_IN); // says gf:host-ready every second, like a gf-three game
    process.env.GAMESFUN_WEB3 = '1';
    server = await startDevServer({ gameDir: game.gameDir, port: 0, log: () => {}, watch: false });
  });
  after(async () => {
    await browser?.close();
    await server?.close();
    if (game) await rm(game.root, { recursive: true, force: true });
    delete process.env.GAMESFUN_WEB3;
  });

  for (const page of ['studio/', 'studio/play.html']) {
    it(`${page}: the host bridge asks for it and the console stays clean`, async (t) => {
      if (!browser) return t.skip('no browser');
      const p = await browser.newPage();
      const errors = [];
      const asked = [];
      p.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
      p.on('pageerror', (e) => errors.push(e.message));
      p.on('response', (r) => r.url().endsWith('/game/gamesfun.json') && asked.push(r.status()));
      await p.goto(`${server.url}${page}`);
      await p.frameLocator('iframe').first().locator('h1').waitFor();
      await p.waitForTimeout(4500); // the game says hello every second; the bridge reads the file at most every 3 s
      await p.close();
      assert.ok(asked.length >= 1, 'the bridge read gamesfun.json');
      assert.deepEqual([...new Set(asked)], [204]);
      assert.deepEqual(errors.filter((e) => !/WebGL|GPU|favicon/i.test(e)), []);
    });
  }
});
