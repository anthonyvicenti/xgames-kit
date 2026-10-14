// The screenshots docs/TRY-IT.md shows, taken from real runs: a game made from each example on a real dev server, in
// real Chrome. Nothing is staged: no state file is written by hand, the picture swap goes through the page's own Replace… button,
// the friend joins through the lobby in a second page, and the board game is played by its own bots.
//   node tests/try-it-shots.mjs <out dir> [first port]        (two ports are used; needs a graphics card for looks)
// It writes JPEG files named as docs/try-it/ has them (01 to 10); copy the ones the page shows.
// The Session tab's shots in TRY-IT.md (a request, a permission question, a roll-back) need a person's own agent
// session, so they come from the live run in tests/e2e-live/README.md and are not made here.
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ensureBrowser } from '../builder/lib/chrome.mjs';
import { createGame } from '../builder/lib/create.mjs';
import { startDevServer } from '../builder/server/index.mjs';

const out = path.resolve(process.argv[2] ?? 'try-it-shots'), basePort = Number(process.argv[3] ?? 5971);
await mkdir(out, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const root = path.join(os.tmpdir(), `gf-try-it-${process.pid}`);
const b = await ensureBrowser({});
const { chromium } = await import('playwright-core');
const browser = await chromium.launch({ executablePath: b.path, headless: true, args: ['--enable-gpu', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required', ...(process.env.CHROME_ARGS ?? '').split(/\s+/).filter(Boolean)] });
const servers = [];
const note = (file, what) => console.log(`${file}\t${what}`);
async function boot(example, port) {
  const dir = path.join(root, example);
  await createGame(dir, { from: example });
  const srv = await startDevServer({ gameDir: dir, port, log: () => {}, watch: true });
  servers.push(srv);
  return { srv, dir, url: `http://127.0.0.1:${srv.port}/studio/` };
}
async function page(url, w = 1280, h = 800) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
  const p = await ctx.newPage();
  p.on('pageerror', e => console.log(`page error: ${e.message}`));
  await p.goto(url, { waitUntil: 'load' });
  return p;
}
const tab = async (p, id) => { await p.click(`#tabs button[data-id="${id}"]`); await sleep(600); };
const shot = async (p, name, what) => { await sleep(400); await p.screenshot({ path: path.join(out, `${name}.jpg`), type: 'jpeg', quality: 85 }); note(`${name}.jpg`, what); };
const frame = p => p.frames().find(f => f.parentFrame() === p.mainFrame());

try {
  // 1. the studio page as the one line leaves it, and the slots tab
  const party = await boot('soak-squad', basePort);
  const p = await page(party.url);
  await sleep(6000);
  await shot(p, '01-studio', 'the studio page after the one line: the game on the left, the tabs on the right');
  await tab(p, 'assets');
  await shot(p, '02-slots', 'Slots & assets: every colour, number, picture and model of the game');

  // 2. a picture through its slot: a new ground pattern, drawn here in Chrome and saved as a PNG file
  const png = await p.evaluate(() => {
    const c = document.createElement('canvas'); c.width = c.height = 256;
    const g = c.getContext('2d');
    g.fillStyle = '#ffd23f'; g.fillRect(0, 0, 256, 256);
    g.fillStyle = '#e8590c';
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) { g.beginPath(); g.arc(32 + x * 64, 32 + y * 64, 20, 0, Math.PI * 2); g.fill(); }
    return c.toDataURL('image/png').split(',')[1];
  });
  const mine = path.join(root, 'my-dots.png');
  await writeFile(mine, Buffer.from(png, 'base64'));
  // through the page itself: "every slot", the Ground pattern row, its Replace… button (the file picker is given the file)
  await p.locator('input[type=checkbox]').first().check();
  await sleep(1500);
  const row = p.locator('.row', { hasText: 'Ground pattern' }).first();
  await row.scrollIntoViewIfNeeded();
  await shot(p, '03-picture-before', 'before: the lawn with the kit\'s own ground pattern; the Ground pattern row and its Replace… button on the right');
  await row.locator('input[type=file]').setInputFiles(mine);
  await sleep(8000);        // the page reloads the game by itself when a file changes
  await p.locator('.row', { hasText: 'Ground pattern' }).first().scrollIntoViewIfNeeded().catch(() => {});
  await shot(p, '04-picture-after', 'after Replace… with my-dots.png: the same lawn with the new picture, no code changed');
  await p.close();

  // 3. a friend in a second tab
  const host = await page(party.url);
  await tab(host, 'friends');
  await shot(host, '05-friend-tab', 'Play with a friend: the two steps');
  await host.click('text=1. Host a room in the preview');
  await sleep(3000);
  await shot(host, '05b-friend-lobby', 'after step 1: the friends page in the preview, a name and the button to host');
  await frame(host).fill('#gfp-name', 'Ana'); await frame(host).click('#gfp-host');
  await sleep(3500);
  const href = await host.getAttribute('a.button', 'href');
  const joiner = await page(`http://127.0.0.1:${party.srv.port}${href}`);
  await sleep(2500);
  await joiner.fill('#gfp-name', 'Ben'); await joiner.click('#gfp-join');
  await sleep(5000);
  await shot(host, '06-friend-room', 'the host\'s page: the room, its code, both players listed');
  await frame(host).click('#mp-start').catch(e => console.log(`start: ${e.message.split('\n')[0]}`));
  await sleep(14000);
  await shot(host, '07-friend-host-playing', 'the host in the round: the friend is the other character');
  await joiner.screenshot({ path: path.join(out, '08-friend-joiner-playing.jpg'), type: 'jpeg', quality: 85 }); note('08-friend-joiner-playing.jpg', 'the friend\'s tab, the same round');
  await joiner.close(); await host.close();

  // 4. the board game example, played by its own bots (the person's turn is played by the turn clock)
  const board = await boot('giant-four', basePort + 1);
  const bp = await page(board.url);
  await sleep(6000);
  await shot(bp, '09-board-menu', 'Giant Four from the example, in the studio page');
  const g = await page(`http://127.0.0.1:${board.srv.port}/game/?bots=3&seed=4`, 1280, 720);
  await sleep(5000);
  await g.click('text=Play').catch(e => console.log(`play: ${e.message.split('\n')[0]}`));
  await sleep(75000);
  await g.screenshot({ path: path.join(out, '10-board-playing.jpg'), type: 'jpeg', quality: 85 }); note('10-board-playing.jpg', 'Giant Four a minute in: discs on the board, whose turn it is on the HUD');
  console.log('board state', JSON.stringify(await g.evaluate(() => { const s = window.__game?.snapshot?.(); return s ? { phase: s.phase, flow: s.flow, players: (s.players ?? []).length } : null; }).catch(() => null)));
  await g.close(); await bp.close();
} finally {
  await browser.close();
  for (const s of servers) await s.close();
}
