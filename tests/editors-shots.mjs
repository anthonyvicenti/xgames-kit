// Screenshots and recording frames of the editors (Map, Skins, Items), in real Chrome on real dev servers, with real
// clicks and drags. A scripted session (tests/stubs/session-driver.mjs: the bridge's real routes, no model) stands in for
// the person's own agent where a request needs answering; what it writes is said in the notes.
// Run through the graphics-card gate (the preview is the game, which needs WebGL):
//   gpu-run.sh node tests/editors-shots.mjs <out dir> [first port]
// Writes <out>/*.png, <out>/frames/<seq>-NN.png (the recordings, one frame a step) and <out>/shots.json.
import { readFileSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createGame } from '../builder/lib/create.mjs';
import { ensureBrowser } from '../builder/lib/chrome.mjs';
import { BIN } from '../builder/lib/paths.mjs';
import { startDevServer } from '../builder/server/index.mjs';
import { sessionDriver } from './stubs/session-driver.mjs';

const out = path.resolve(process.argv[2] ?? 'editor-shots'), basePort = Number(process.argv[3] ?? 6004);
await mkdir(path.join(out, 'frames'), { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const root = path.join(os.tmpdir(), `gf-editors-shots-${process.pid}`);
const notes = [];
const note = (file, what) => { notes.push({ file, what }); console.log(`${file}\t${what}`); };
const problems = [];

// ---- the games: a side-on flat game, a melee party game, the soak example ----
const ROWS = ['B............................B', 'B............................B', 'B............o..o............B', 'B............................B', 'B..o........======........o..B', 'B............................B', 'B.===..====..o..o..====..===.B', 'B............................B', 'B....====..========..====....B', 'B..o......................o..B', 'B.1...BB..1...BB...1..BB...1.B', '##############################'];
const FLAT = { specVersion: 2, runtime: 'three', profile: 'flat-2d', loop: 'round', kind: 'drawn', title: 'Coin Hop', hook: 'A side-on scramble: jump the ledges and grab more coins than your friends.', prompt: 'a 2D side-on platformer coin grab with friends, drawn cartoon art',
  players: { min: 1, max: 4, bots: true }, multiplayer: { mode: 'live', together: 'versus' }, devices: { targets: ['desktop', 'phone'] }, round: { seconds: 60, winBy: 'most coins when the time runs out', replay: true }, camera: 'side', controls: { interact: 'grab a coin', jump: 'jump (hold Down on a ledge to drop through it)' },
  world: { template: 'stage', size: 'small', props: [{ name: 'coin', describe: 'a shiny gold coin', count: 12, role: 'collected by players', kind: 'gameplay' }], map: { legend: { o: 'mark:coin' }, rows: ROWS } },
  mechanics: [{ id: 'pickup', as: 'coins to collect', params: { prop: 'coin', count: 0, effect: 'score', value: 1, respawnSeconds: 4, size: 0.8, collect: 'both' } }],
  rules: { summary: 'Run and jump into a coin to take it. Most coins wins.', scoring: '+1 per coin', params: { coinPoints: 1 } },
  characters: [{ role: 'player', describe: 'a round kid in a cap, seen from the side', body: { from: 'kind' } }], look: { preset: 'drawn-day' }, sounds: [{ id: 'coin', describe: 'a bright coin chime' }], build: [], content: { rating: 'E' }, accept: ['coins'] };
const PILLOW = JSON.parse(readFileSync(new URL('./fixtures/pillow-brawl.spec.json', import.meta.url), 'utf8'));

async function make(name, spec, from) {
  const dir = path.join(root, name);
  if (spec) { const f = path.join(root, `${name}.spec.json`); await mkdir(root, { recursive: true }); await writeFile(f, JSON.stringify(spec)); await createGame(dir, { spec: f }); }
  else await createGame(dir, { from });
  return dir;
}
const games = { flat: await make('coin-hop', FLAT), pillow: await make('pillow', PILLOW), soak: await make('soak', null, 'soak-squad') };
// the flat example's own rules (a coin is a point): the stub create writes is enough for the editors, which never read rules.js
const servers = {};
let port = basePort;
for (const [k, dir] of Object.entries(games)) servers[k] = await startDevServer({ gameDir: dir, port: port++, log: () => {} });
const url = k => `http://127.0.0.1:${servers[k].port}/studio/`;

const b = await ensureBrowser({});
const { chromium } = await import('playwright-core');
const browser = await chromium.launch({ executablePath: b.path, headless: true, args: ['--enable-gpu', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required', ...(process.env.CHROME_ARGS ?? '').split(/\s+/).filter(Boolean)] });
async function page(k, w = 1280, h = 800) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
  const p = await ctx.newPage();
  p.errors = [];
  p.on('pageerror', e => p.errors.push(e.message));
  p.on('console', m => { if (m.type() === 'error' && !/favicon/.test(m.text())) p.errors.push(m.text()); });
  await p.goto(url(k), { waitUntil: 'load' });
  await sleep(1500);
  return p;
}
const tab = async (p, id) => { await p.click(`#tabs button[data-id="${id}"]`); await sleep(1200); };
const shot = async (p, name, what) => { await sleep(300); await p.screenshot({ path: path.join(out, `${name}.png`) }); note(`${name}.png`, what); };
const frames = {};
const frame = async (p, seq, what) => { frames[seq] = (frames[seq] ?? 0) + 1; const f = `frames/${seq}-${String(frames[seq]).padStart(2, '0')}.png`; await sleep(250); await p.screenshot({ path: path.join(out, f) }); note(f, what); };
const noSideScroll = async (p, name) => { const [sw, iw] = await p.evaluate(() => [document.documentElement.scrollWidth, innerWidth]); if (sw > iw) problems.push(`${name}: sideways scroll ${sw} > ${iw}`); };
const errorsOf = (p, name) => { const e = p.errors.filter(x => !/WebGL|gpu/i.test(x)); if (e.length) problems.push(`${name}: ${e.join(' | ')}`); };
async function cellXY(p, c, r) {
  const geo = JSON.parse(await p.getAttribute('.paint-view canvas', 'data-geo')), box = await p.locator('.paint-view canvas').boundingBox();
  return [box.x + geo.ox + (c + 0.5) * geo.cell, box.y + geo.oy + (r + 0.5) * geo.cell];
}
async function stroke(p, cells) {
  let [x, y] = await cellXY(p, cells[0].c, cells[0].r);
  await p.mouse.move(x, y); await p.mouse.down();
  for (const q of cells.slice(1)) { [x, y] = await cellXY(p, q.c, q.r); await p.mouse.move(x, y, { steps: 3 }); }
  await p.mouse.up();
}
const pickPaint = (p, label) => p.click(`.palette .swatch-item:has-text("${label}")`);

try {
  // ================= A. the map painter (flat) =================
  {
    const p = await page('flat');
    await tab(p, 'map');
    await shot(p, 'map-flat-1-open', 'Map tab on a side-on flat game: the painter laid over the preview, tools, the palette from the tile slots, start spots and coins, the kit\'s checks green');
    await frame(p, 'a-map', 'the painter opens over the game');
    await pickPaint(p, 'Ledge');
    await stroke(p, [3, 4, 5, 6, 7, 8].map(c => ({ c, r: 1 })));
    let [x, y] = await cellXY(p, 12, 9); await p.mouse.move(x, y);
    await shot(p, 'map-flat-2-red', 'A ledge painted too high: it and the place above it turn red, the checks say why in words, Save & play is off; the blue shade is where a jump from the floor under the cursor lands');
    await frame(p, 'a-map', 'a ledge too high: red, and the words say why');
    await p.click('button:has-text("Undo")');
    await frame(p, 'a-map', 'Undo');
    await stroke(p, [20, 21, 22, 23].map(c => ({ c, r: 2 })));
    await pickPaint(p, 'Coin');
    for (const c of [21, 22]) { [x, y] = await cellXY(p, c, 1); await p.mouse.click(x, y); }
    [x, y] = await cellXY(p, 24, 3); await p.mouse.move(x, y);
    await shot(p, 'map-flat-3-fixed', 'A new ledge a jump above the top one, with two coins: every ledge, coin and start spot can be reached (green), Save & play is on');
    await frame(p, 'a-map', 'a ledge in reach, two coins: green');
    await p.click('button:has-text("Save & play")');
    await sleep(6000);
    await shot(p, 'map-flat-4-playing', 'After Save & play: the slot world.map is written and the game reloads on its home menu with the new map behind it (the new ledge top right is out of this view: the camera starts on the player)');
    await frame(p, 'a-map', 'Save & play: the game reloads with the map');
    const world = JSON.parse(await readFile(path.join(games.flat, 'config/world.json'), 'utf8'));
    if (world.map.rows[2].slice(20, 24) !== '====') problems.push(`map save: row 3 is ${world.map.rows[2]}`);
    await noSideScroll(p, 'map-flat'); errorsOf(p, 'map-flat');
    await p.context().close();
  }
  // ================= B. the layout (3D) =================
  {
    const p = await page('soak');
    await tab(p, 'map');
    const v = JSON.parse(await p.getAttribute('.paint-view canvas', 'data-view')), box = await p.locator('.paint-view canvas').boundingBox();
    const at = (x, z) => [box.x + v.origin[0] + x * v.k, box.y + v.origin[1] + z * v.k];
    let [x, y] = at(9.5, -6.8); await p.mouse.move(x, y); await p.mouse.down();
    for (const [a, c] of [[8, -6], [6, -4.5], [4, -3]]) { [x, y] = at(a, c); await p.mouse.move(x, y, { steps: 4 }); }
    await p.mouse.up(); await p.keyboard.press('r');
    await shot(p, 'map-layout-1', 'Map tab on a 3D party world: the props from above at their measured size, start spots numbered; the slide picked, dragged nearer the middle and turned (R); its card on the right');
    await p.click('button:has-text("Save & play")');
    await sleep(6000);
    await shot(p, 'map-layout-2-playing', 'After Save & play: the layout slot written (world.backyard.layout), the game reloads');
    errorsOf(p, 'map-layout');
    await p.context().close();
  }
  // ================= C. skins (3D) =================
  {
    const p = await page('pillow');
    await tab(p, 'skins');
    await sleep(4000);
    await shot(p, 'skins-3d-1-open', 'Skins tab on a party game: seat colours, the small palette, the library bodies with pictures; the preview shows the player turning (?gf-show=character.player)');
    await frame(p, 'b-skin', 'Skins: the player turning in the preview');
    await p.click('.swatch[title="#6d8bff"]');
    await sleep(2500);
    await shot(p, 'skins-3d-2-tryon', 'Player 1 set to blue: handed to the turning player as a message (gf:loadout), which wears it in place with no reload; nothing saved yet ("Trying it on")');
    await frame(p, 'b-skin', 'pick blue: tried on before saving');
    await p.click('button:has-text("Save the look")');
    await sleep(800);
    await frame(p, 'b-skin', 'Save the look: written through character.tint.player');
    await p.click('.body-pick:has-text("Tall bean")');
    await sleep(5000);
    await shot(p, 'skins-3d-3-body', 'A library body picked (Tall bean): swapped into character.body.player and its height set, the preview reloads with it; "Put the last body back" undoes it');
    await frame(p, 'b-skin', 'a new body from the library');
    const chars = JSON.parse(await readFile(path.join(games.pillow, 'config/characters.json'), 'utf8'));
    if (chars.palette[0] !== '#6d8bff') problems.push(`skins save: palette[0] is ${chars.palette[0]}`);
    errorsOf(p, 'skins-3d');
    await p.context().close();
  }
  // ================= D. skins (2D) with a stand-in session =================
  {
    const p = await page('flat');
    const s = await sessionDriver(`http://127.0.0.1:${servers.flat.port}`, { id: 'shots-flat', cwd: games.flat });
    await s.start();
    await tab(p, 'skins');
    await p.click('.swatch[title="#4be0a8"]');
    await sleep(5000);                        // the preview reloads the turning player wearing the colour
    await shot(p, 'skins-2d-1', 'Skins on a flat game: the six frames and the walk tinted with player 1\'s new colour (light parts take it), the kit\'s picture judge passes the sheet');
    // the editor's "Ask my session" hands the conversation's one box its context; the person types there
    await p.click('.ask-box button:has-text("Ask my session to draw it")');
    await p.fill('#chat-input', 'a small knight in blue armour with a feather on the helmet');
    await p.click('#chat-send');
    await sleep(800);
    const got = await s.collect();
    // the stand-in session answers with the kit's PIXEL stand-in sheet through the slot route (a real session would draw
    // through the art tool, gamesfun_art_request then gamesfun_art_take, which writes the same slot)
    const standin = path.join(path.dirname(BIN), '..', 'builder', 'tools', 'lib', 'standin-assets', 'flat', 'pixel', 'body-side.png');
    const bytes = await readFile(standin);
    await fetch(`http://127.0.0.1:${servers.flat.port}/api/game/slots/file?id=character.body.player&name=body.png`, { method: 'POST', body: bytes, headers: { 'content-type': 'application/octet-stream' } });
    const rid = got.body?.requests?.at(-1)?.id; if (rid) await s.done(rid, 'drew it (stand-in: the kit\'s pixel sheet)');
    await sleep(2500);
    await shot(p, 'skins-2d-2-offer', 'After "Ask my session to draw it": the session\'s picture (here a stand-in: the kit\'s own pixel sheet) shown beside the old one, judged, with Keep or Put the old one back');
    errorsOf(p, 'skins-2d');
    s.closeAll();
    await p.context().close();
  }
  // ================= E. items: a number, then one added like another from the page itself =================
  {
    const p = await page('pillow');
    await tab(p, 'items');
    await shot(p, 'items-1-open', 'Items tab on a melee party game: a card per weapon from the game\'s own table and the crate pickup, plain words, the slot\'s own limits, the other pillow\'s value under each number, live or reload beside each');
    await frame(p, 'c-item', 'Items: a card per item');
    // drag the pillow's reach from 2.2 to about 3.4 (0.5 to 8 m) and let go
    const r = p.locator('.card:has(h4:text-is("Pillow")) .field:has-text("Swing 1: reach") input[type=range]').first();
    await r.scrollIntoViewIfNeeded();
    const bb = await r.boundingBox(), x = v => bb.x + 8 + (bb.width - 16) * ((v - 0.5) / 7.5);
    await p.mouse.move(x(2.2), bb.y + bb.height / 2); await p.mouse.down();
    await p.mouse.move(x(3.4), bb.y + bb.height / 2, { steps: 6 }); await p.mouse.up();
    await sleep(2000);
    const reach = JSON.parse(await readFile(path.join(games.pillow, 'config/game.json'), 'utf8')).mechanics[0].params.weapons[0].combo[0].reach;
    if (!(reach > 3 && reach < 3.8)) problems.push(`items: the pillow's reach is ${reach} after the drag`);
    await frame(p, 'c-item', `drag the pillow's reach and let go: saved through its slot and sent to the running game (now ${reach} m)`);
    await p.locator('.add-box').scrollIntoViewIfNeeded();
    await p.selectOption('.add-box select[aria-label="Like which one"]', 'pillow');
    await p.fill('.add-box input[type=text]', 'Feather duster');
    await shot(p, 'items-2-add', 'Add an item: a weapon like Pillow, named Feather duster');
    await frame(p, 'c-item', 'add one like Pillow');
    await p.click('.add-box button:has-text("Add it")');
    await p.locator('.card:has(h4:text-is("Feather duster"))').waitFor({ timeout: 30000 }).catch(() => problems.push('items: no Feather duster card'));
    await sleep(2500);
    await p.locator('.card:has(h4:text-is("Feather duster"))').scrollIntoViewIfNeeded().catch(() => {});
    await shot(p, 'items-3-added', 'Add it: the table slot written with the kit\'s own addLike; Feather duster has its own card, numbers, slots and model file, and the game reloads');
    await frame(p, 'c-item', 'added: its card appears');
    await p.locator('.card:has(h4:text-is("Crate")) button:has-text("See it")').click();
    await sleep(5000);
    await shot(p, 'items-4-see', '"See it" on the crate: the preview shows the prop (?gf-show=prop.crate)');
    errorsOf(p, 'items');
    await p.context().close();
  }
  // ================= phone width =================
  for (const [k, id, name] of [['flat', 'map', 'phone-map'], ['flat', 'skins', 'phone-skins-2d'], ['pillow', 'items', 'phone-items'], ['pillow', 'skins', 'phone-skins-3d']]) {
    const p = await page(k, 390, 844);
    await tab(p, id);
    await sleep(2500);
    await shot(p, name, `${id} at phone width (390 x 844)`);
    if (id !== 'map') { await p.locator('.panel:not([hidden])').evaluate(e => e.scrollIntoView()); await p.evaluate(() => scrollBy(0, 420)); await shot(p, `${name}-lower`, `${id} at phone width, scrolled to the tab`); }
    await noSideScroll(p, name); errorsOf(p, name);
    await p.context().close();
  }
} catch (e) { problems.push(`stopped: ${e.stack ?? e.message}`); }
finally {
  await browser.close();
  for (const s of Object.values(servers)) await s.close().catch(() => {});
  await writeFile(path.join(out, 'shots.json'), JSON.stringify({ when: new Date().toISOString(), chrome: b.path, chromeArgs: process.env.CHROME_ARGS ?? '', shots: notes, problems }, null, 1));
  await rm(root, { recursive: true, force: true });
  console.log(problems.length ? `PROBLEMS:\n${problems.join('\n')}` : 'no problems');
}
