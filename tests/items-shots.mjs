// The Items tab in real Chrome on a real dev server, with real clicks, drags and typing: a number changed live (no
// reload), a typed number the kit refuses (its words on the card), "Foam sword" added like Pillow, everyone starting
// with it, a rename and a removal undone, the Skins try-on handed to the running preview, and the new weapon in play.
// Run through the graphics-card gate (the preview is the game, which needs WebGL):
//   gpu-run.sh node tests/items-shots.mjs <game dir> <out dir> [port]
// The game is changed by the page (it is the proof): use a fresh copy. Writes <out>/*.png and <out>/items-shots.json.
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ensureBrowser } from '../builder/lib/chrome.mjs';
import { startDevServer } from '../builder/server/index.mjs';

const [gameArg, outArg, portArg] = process.argv.slice(2);
if (!gameArg || !outArg) { console.error('usage: node tests/items-shots.mjs <game dir> <out dir> [port]'); process.exit(2); }
const game = path.resolve(gameArg), out = path.resolve(outArg);
await mkdir(out, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const notes = [], problems = [], facts = {};
const note = (file, what) => { notes.push({ file, what }); console.log(`${file}\t${what}`); };
const fact = (k, v) => { facts[k] = v; console.log(`${k}: ${JSON.stringify(v)}`); };
const gameJson = async () => JSON.parse(await readFile(path.join(game, 'config/game.json'), 'utf8'));
const melee = async () => (await gameJson()).mechanics.find(m => m.id === 'melee').params;

const srv = await startDevServer({ gameDir: game, port: Number(portArg ?? 6023), log: () => {} });
const b = await ensureBrowser({});
const { chromium } = await import('playwright-core');
const browser = await chromium.launch({ executablePath: b.path, headless: true, args: ['--enable-gpu', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required', ...(process.env.CHROME_ARGS ?? '').split(/\s+/).filter(Boolean)] });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
const p = await ctx.newPage();
const errors = [];
p.on('pageerror', e => errors.push(e.message));
p.on('console', m => { if (m.type() === 'error' && !/favicon/.test(m.text())) errors.push(m.text()); });
const shot = async (name, what, sel = null) => { await sleep(300); await (sel ? p.locator(sel) : p).screenshot({ path: path.join(out, `${name}.png`) }); note(`${name}.png`, what); };
const preview = () => p.frameLocator('#preview');
const frame = () => p.frame({ url: /\/game\// });
// a mark in the preview's document: still there after a change means the game did not reload
const markPreview = async () => { await frame()?.evaluate(() => { window.__itemsMark = (window.__itemsMark ?? 0) + 1; }); };
const previewKept = async () => !!(await frame()?.evaluate(() => window.__itemsMark ?? 0).catch(() => 0));
const statusText = () => p.locator('.live-note').innerText().catch(() => '');
const cardOf = name => p.locator(`.card:has(h4:text-is("${name}"))`);
const waitPreviewReady = () => p.waitForFunction(() => { try { const w = document.querySelector('#preview').contentWindow; return !!w.__game && (w.__game.phase === 'lobby' || w.__game.ready === true || w.__game.phase === 'play'); } catch { return false; } }, null, { timeout: 90000 }).catch(() => problems.push('the preview did not get ready in 90 s'));

try {
  await p.goto(`http://127.0.0.1:${srv.port}/studio/`, { waitUntil: 'load' });
  await waitPreviewReady();
  fact('renderer', await frame().evaluate(() => { const c = document.createElement('canvas').getContext('webgl2'); const d = c?.getExtension('WEBGL_debug_renderer_info'); return d ? c.getParameter(d.UNMASKED_RENDERER_WEBGL) : null; }));
  await p.click('#tabs button[data-id="items"]');
  await sleep(1500);
  await shot('items-1-open', 'Items tab on Pillow Brawl: the weapons from the game\'s own table (each with the numbers its mechanic puts on the front, live or reload said beside each), the crate pickup, the add form');

  // ---- 1. a number, live: drag the Pillow's reach and let go ----
  await markPreview();
  const reach = cardOf('Pillow').locator('.field:has-text("Swing 1: reach") input[type=range]').first();
  await reach.scrollIntoViewIfNeeded();
  const bb = await reach.boundingBox();
  const at = v => bb.x + 8 + (bb.width - 16) * ((v - 0.5) / 7.5);
  await p.mouse.move(at(2.2), bb.y + bb.height / 2); await p.mouse.down();
  await p.mouse.move(at(3.4), bb.y + bb.height / 2, { steps: 8 }); await p.mouse.up();
  await sleep(2500);
  fact('live: Pillow reach in config', (await melee()).weapons[0].combo[0].reach);
  fact('live: status words', await statusText());
  fact('live: the preview kept its document (no reload)', await previewKept());
  if (!(await previewKept())) problems.push('a live number reloaded the preview');
  await shot('items-2-live', 'The Pillow\'s reach dragged to about 3.4 m and let go: saved through its slot, then sent to the running game (gf:slot); the note says it is playing now with no reload');

  // ---- 2. a typed number the kit refuses: its words on the card ----
  const dmgBox = cardOf('Pillow').locator('.field:has-text("Swing 1: damage") input[type=number]').first();
  await dmgBox.scrollIntoViewIfNeeded();
  await dmgBox.fill('500'); await dmgBox.press('Enter');
  await sleep(1200);
  fact('refused: words on the card', await cardOf('Pillow').locator('.refused').innerText().catch(() => null));
  fact('refused: Pillow damage in config (unchanged)', (await melee()).weapons[0].combo[0].damage);
  await cardOf('Pillow').scrollIntoViewIfNeeded();
  await shot('items-3-refused', '500 typed as the Pillow\'s damage: the kit refuses it in its own words, shown on the card, and nothing is written');

  // ---- 3. add "Foam sword" like Pillow ----
  await p.locator('.add-box').scrollIntoViewIfNeeded();
  await p.selectOption('.add-box select[aria-label="Like which one"]', 'pillow');
  await p.fill('.add-box input[type=text]', 'Foam sword');
  await shot('items-4-add-form', 'The add form: a weapon like Pillow, named Foam sword');
  await p.click('.add-box button:has-text("Add it")');
  await p.locator('.card:has(h4:text-is("Foam sword"))').waitFor({ timeout: 30000 }).catch(() => problems.push('no Foam sword card after Add'));
  await sleep(2500);
  const afterAdd = await melee();
  fact('added: weapons', afterAdd.weapons.map(w => `${w.id} ${w.name} ${w.model ?? '(drawn by the kit)'}`));
  try { fact('added: its own model file bytes', (await stat(path.join(game, 'assets/models/melee-foam-sword.glb'))).size); } catch { problems.push('no assets/models/melee-foam-sword.glb'); }
  const assets = JSON.parse(await readFile(path.join(game, 'assets.json'), 'utf8'));
  fact('added: its own slots', assets.slots.filter(s => s.id.startsWith('mechanic.melee.foam-sword.')).map(s => s.id));
  await cardOf('Foam sword').scrollIntoViewIfNeeded();
  await shot('items-5-added', 'Add it: the table slot written with the kit\'s own addLike; Foam sword gets its own card, numbers, slots and model file (the library\'s KayKit sword, CC0), and the game reloads');

  // ---- 4. everyone starts with it ----
  await cardOf('Foam sword').locator('button:has-text("Start with this one")').click();
  await sleep(2500);
  fact('start weapon', (await melee()).weapon);

  // ---- 5. rename Big pillow, then undo ----
  await cardOf('Big pillow').locator('button:has-text("Rename")').click();
  await p.fill('.rename input', 'Huge pillow');
  await p.click('.rename button:has-text("Save")');
  await p.locator('.card:has(h4:text-is("Huge pillow"))').waitFor({ timeout: 20000 }).catch(() => problems.push('no Huge pillow card after rename'));
  await sleep(1500);
  fact('renamed', (await melee()).weapons.map(w => w.name));
  await cardOf('Huge pillow').scrollIntoViewIfNeeded();
  await shot('items-6-renamed', 'Rename: Big pillow is now Huge pillow (its id, slots and numbers stay); Foam sword is the one everyone starts with');
  await p.click('button:has-text("Undo")');
  await sleep(2500);
  fact('rename undone', (await melee()).weapons.map(w => w.name));

  // ---- 6. remove Big pillow, then undo ----
  await cardOf('Big pillow').locator('button:has-text("Remove")').click();
  await sleep(2500);
  fact('removed', (await melee()).weapons.map(w => w.id));
  await shot('items-7-removed', 'Remove: Big pillow taken out of the table (Undo puts it back)');
  await p.click('button:has-text("Undo")');
  await sleep(2500);
  fact('remove undone', (await melee()).weapons.map(w => w.id));

  // ---- 7. a live number on the new weapon ----
  await markPreview();
  const fsReach = cardOf('Foam sword').locator('.field:has-text("Swing 1: reach") input[type=number]').first();
  await fsReach.scrollIntoViewIfNeeded();
  await fsReach.fill('3.6'); await fsReach.press('Enter');
  await sleep(2500);
  fact('live on Foam sword: status', await statusText());
  fact('live on Foam sword: preview kept', await previewKept());
  fact('live on Foam sword: reach in config', (await melee()).weapons.find(w => w.id === 'foam-sword')?.combo?.[0]?.reach);

  // ---- 8. Skins: the try-on handed to the running preview ----
  await p.click('#tabs button[data-id="skins"]');
  await p.waitForFunction(() => { try { return document.querySelector('#preview').contentWindow.__game?.snapshot?.().phase === 'show' && document.querySelector('#preview').contentWindow.__game.ready; } catch { return false; } }, null, { timeout: 90000 }).catch(() => problems.push('the turning player did not show'));
  await sleep(1500);
  await markPreview();
  const look0 = await frame().evaluate(() => window.__game.snapshot().look);
  await p.click('.swatch[title="#6d8bff"]');
  await p.waitForFunction(n => { try { return document.querySelector('#preview').contentWindow.__game.snapshot().look.restyled > n; } catch { return false; } }, look0.restyled, { timeout: 20000 }).catch(() => problems.push('the try-on did not restyle the subject'));
  await sleep(1200);
  const look1 = await frame().evaluate(() => window.__game.snapshot().look).catch(() => null);
  fact('skins try-on', { before: look0, after: look1, sameDocument: await previewKept() });
  await shot('skins-tryon-live', 'Skins: player 1 tried on in blue. The look is handed to the turning player as a message (gf:loadout) and it is made again in place, with no reload; nothing is saved yet');

  // ---- 9. the new weapon in play ----
  await p.click('#tabs button[data-id="items"]');
  await sleep(500);
  await cardOf('Foam sword').locator('button:has-text("Play with it")').click();
  await p.waitForFunction(() => { try { return document.querySelector('#preview').contentWindow.__game?.phase === 'lobby'; } catch { return false; } }, null, { timeout: 90000 }).catch(() => problems.push('the game did not reach its home menu'));
  await sleep(1000);
  await preview().locator('#gf-play').click();
  await sleep(6000);
  const stats = async () => (await frame().evaluate(() => window.__game.controls())).mechanics.find(m => m.id === 'melee')?.stats;
  fact('in play: the weapon in hand', (await stats())?.weapon);
  fact('in play: HUD names it', await frame().evaluate(() => /Foam sword/.test(document.body.innerText)));
  await shot('play-1-foam-sword', 'Play with it: the round starts with Foam sword in everyone\'s hand (the HUD names it)');
  const fb = await p.locator('#preview').boundingBox();
  await p.mouse.move(fb.x + fb.width / 2, fb.y + fb.height / 2);
  await p.mouse.down(); await sleep(120); await p.mouse.up(); await sleep(220);
  await shot('play-2-swing', 'A swing of the Foam sword in play');
  await sleep(900);
  fact('in play: the last swing', (await stats())?.lastSwing ?? null);
  await shot('play-3-preview-only', 'The preview alone, a moment later', '#preview');
} catch (e) { problems.push(`stopped: ${e.stack ?? e.message}`); }
finally {
  const errs = errors.filter(x => !/WebGL|gpu|GPU stall/i.test(x) && !/status of 400/.test(x));   // a 400: the refusal the script asks for
  if (errs.length) problems.push(`page errors: ${errs.join(' | ')}`);
  await writeFile(path.join(out, 'items-shots.json'), JSON.stringify({ when: new Date().toISOString(), game, chrome: b.path, chromeArgs: process.env.CHROME_ARGS ?? '', facts, shots: notes, problems }, null, 1));
  await browser.close();
  await srv.close().catch(() => {});
  console.log(problems.length ? `PROBLEMS:\n${problems.join('\n')}` : 'no problems');
}
process.exit(0);
