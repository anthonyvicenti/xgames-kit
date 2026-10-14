#!/usr/bin/env node
// kind-sheet.mjs: the look judge's contact sheet for a kind (kinds/<name>.json), its only check. Renders the kind on
// the runtime it is proven on, headless on the real graphics card, into one PNG: the world (ground, sky, light), a
// body up close, the body set, the kind's props, the HUD over the world, and a card of what the preset says (palette,
// camera, audio character, packs). A person (or the look judge) reads it against the kind's reference games.
//
//   node builder/look-judge/kind-sheet.mjs <kind>... | all  [--out kinds/sheets] [--size 1280x720] [--only world,hero] [--fetch] [--software]
//
// Runtimes (the kind's sheet.runtime and sheet.profile):
//   three/standard-3d   pages/three.js on WebGL (the look, the world family, the bodies, the props, the kind's pass)
//   three/flat-2d       pages/flat.js on WebGL (the flat runtime's picture rules: an orthographic view, pixel or drawn
//           filtering, whole-texel snapping; the kind's packs and the runtime's stand-ins)
//   three/scenic-3d     a bench game made by create in the kind's preset, shot through WebGPU (the runtime's capture API)
//   forge               the forge lookdev scene in the kind's preset (the runtime's own shot tool), WebGPU
//   vista               the vista core view in the kind's preset, WebGPU
// GPU work goes through the machine's GPU slots when GF_GPU_RUN names the slot script (two slots, first come first
// served). Writes <out>/<kind>.png, <out>/<kind>.json (tiles, timings, errors) and the tiles in <out>/tiles/<kind>/.
// --fetch downloads the sheet packs a kind needs (sheet-packs.json; hash-checked). Exit 1 when a kind's sheet failed.
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve, dirname, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { KIT, ROOTS, VENDOR, repoFileOf, libraryRoute } from './lib/roots.mjs';
import { startServer } from './lib/server.mjs';
import { ensurePacks, CACHE, fontFile } from './lib/packs.mjs';
import { bakeBodies, judgeLibraryBodies } from './lib/bake-flat.mjs';
import { launchChrome } from '../qa/browser.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const KINDS_DIR = join(KIT, 'kinds');
const argv = process.argv.slice(2);
const opt = (k, d = null) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const VALUED = new Set(['--out', '--size', '--only', '--query', '--game']);
const names = argv.filter((a, i) => !a.startsWith('--') && !VALUED.has(argv[i - 1]));
const ALL = readdirSync(KINDS_DIR).filter(f => f.endsWith('.json')).map(f => f.replace(/\.json$/, '')).sort();
// --game <dir>: one game's sheet (verify's check 9, the advisory look judge): its kind (spec.json → kind) drawn with the
// game's own look, world values and bodies where the runtime's sheet page reads a game (three standard-3d), else the
// kind's own sheet, said so in the record
const GAME_DIR = opt('--game') ? resolve(opt('--game')) : null;
const GAME_SPEC = GAME_DIR ? JSON.parse(readFileSync(join(GAME_DIR, 'spec.json'), 'utf8')) : null;
if (GAME_DIR && !GAME_SPEC.kind) { console.error(`${GAME_DIR}: spec.json names no kind`); process.exit(2); }
const kinds = GAME_SPEC ? [GAME_SPEC.kind] : names.includes('all') || !names.length ? ALL : names;
const OUT = resolve(opt('--out', GAME_DIR ? join(GAME_DIR, '.verify/sheet') : join(KINDS_DIR, 'sheets')));
const [TW, TH] = opt('--size', '1280x720').split('x').map(Number);
const ONLY = opt('--only')?.split(',') ?? null;
const QUERY = opt('--query') ? `&${opt('--query').replace(/^([^=]+)=(.*)$/s, (_, k, v) => `${k}=${encodeURIComponent(v)}`)}` : '';   // extra page parameters (e.g. set={json}: look values, a tuning run)
const sleep = ms => new Promise(r => setTimeout(r, ms));
const t0 = Date.now(), log = (...a) => console.log(`[${String(Math.round((Date.now() - t0) / 1000)).padStart(4)}s]`, ...a);

/** What every page server serves: the three runtime's kit as a game sees it (/kit/ is a game's gf/three/, assembled
 *  from its layers), the asset library (lib/roots.mjs libraryRoute), this repository, the pinned vendor copies the pages' import maps name, the sheet
 *  packs, the HUD fonts (/font/<family>: the asset library's font pack) and the forge HUD's own fonts. */
function baseMap() {
  return {
    '/kit/': rel => repoFileOf(`gf/three/${rel}`), '/lib3/': libraryRoute(join(KIT, '.cache/sheet-library')), '/xk/': KIT, '/pages/': join(HERE, 'pages'),
    '/vendor/three/': VENDOR.threeBuild, '/vendor/postprocessing/': VENDOR.postprocessing, '/vendor/n8ao/': VENDOR.n8ao, '/vendor/rapier/': VENDOR.rapier,
    '/packs/': CACHE, '/forge-fonts/': join(ROOTS.forge, 'hud/fonts'), '/vista/': ROOTS.vista,
    '/font/': rel => fontFile(decodeURIComponent(rel)).file ?? null,
  };
}

async function waitReady(page, what, timeout = 120000) {
  const start = Date.now();
  for (;;) {
    const s = await page.evaluate(() => window.__sheet && { ready: window.__sheet.ready, errors: window.__sheet.errors }).catch(() => null);
    if (s?.ready) return s;
    if (s?.errors?.length && Date.now() - start > 4000) throw new Error(`${what}: ${s.errors.join(' | ').slice(0, 600)}`);
    if (Date.now() - start > timeout) throw new Error(`${what}: not ready in ${timeout / 1000} s${s?.errors?.length ? ': ' + s.errors.join(' | ') : ''}`);
    await sleep(250);
  }
}

// ------------------------------------------------------------------ runners: one per runtime, each → tiles
const TILE_LABEL = { world: 'World: ground, sky, light', hero: 'A body up close', bodies: 'The body set', props: 'Props', hud: 'HUD over the world' };

async function runPage(pageName, kind, dir, { url, browser }) {
  const tiles = [];
  for (const shot of ['world', 'hero', 'bodies', 'props']) {
    if (ONLY && !ONLY.includes(shot)) continue;
    const page = await browser.newPage({ viewport: { width: TW, height: TH }, deviceScaleFactor: 1 });
    const console_ = []; page.on('console', m => { if (m.type() === 'error') console_.push(m.text().slice(0, 300)); });
    page.on('pageerror', e => console_.push(e.message.slice(0, 300)));
    await page.goto(`${url}/pages/${pageName}.html?kind=${kind.id}&shot=${shot}${GAME_DIR && GAME_PAGES.has(pageName) ? '&game=1' : ''}${QUERY}`);
    const s = await waitReady(page, `${kind.id} ${shot}`).catch(e => ({ error: e.message }));
    await sleep(300);
    const file = join(dir, `${shot}.png`);
    await page.screenshot({ path: file });
    const info = await page.evaluate(() => window.__sheet?.info).catch(() => null);
    tiles.push({ name: shot, label: TILE_LABEL[shot], file, info, note: info?.captions?.join(' · ') ?? null, errors: [...(s.error ? [s.error] : []), ...console_].slice(0, 6) });
    await page.close();
  }
  return tiles;
}

async function runFlat(kind, dir, ctx) {
  // the drawn kind's bodies: the pack's poses baked to gf-flat-1 sheets and judged by the flat runtime's judge
  const bakes = [];
  for (const pack of kind.sheet.packs ?? []) bakes.push(...await bakeBodies(pack, join(CACHE, 'baked')));
  // a kind whose body set is its own sheets in the library (pixel): each judged as it is
  if (!bakes.length && kind.bodies?.three?.some(r => r.includes('/'))) bakes.push(...(await judgeLibraryBodies(kind.bodies.three, { style: kind.look.three.style })).map(b => ({ id: b.id, judge: { ok: b.ok, errors: new Array(b.errors) } })));
  const tiles = await runPage('flat', kind, dir, ctx);
  const bodies = tiles.find(t => t.name === 'bodies');
  if (bodies && bakes.length) {
    bodies.info = { ...bodies.info, judged: bakes.map(b => ({ id: b.id, ok: b.judge.ok, errors: b.judge.errors.length })) };
    bodies.note = `${bodies.note ? `${bodies.note} · ` : ''}flat judge: ${bakes.filter(b => b.judge.ok).length} of ${bakes.length} sheets pass gf-flat-1`;
  }
  return tiles;
}

/** A runtime that has its own scene or capture page: open each URL on its own server and screenshot it once ready.
 *  shots: [{ name, url, ready (a page expression that is true when it is ready), wait (ms after ready), init (a script run
 *  before the page's own), note }] */
async function runUrls(shots, dir, { browser, all = false }) {
  const tiles = [];
  for (const sh of shots) {
    if (ONLY && !all && !ONLY.includes(sh.name)) continue;
    const ctx = await browser.newContext({ viewport: { width: TW, height: TH }, deviceScaleFactor: 1 });
    if (sh.init) await ctx.addInitScript(sh.init);
    const page = await ctx.newPage();
    const errors = []; page.on('pageerror', e => errors.push(e.message.slice(0, 300))); page.on('console', m => { if (m.type() === 'error') errors.push(m.text().slice(0, 300)); });
    await page.goto(sh.url, { waitUntil: 'load' });
    const start = Date.now();
    for (;;) {
      const ok = await page.evaluate(sh.ready).catch(() => false);
      if (ok) break;
      if (Date.now() - start > 120000) { errors.push(`not ready in 120 s`); break; }
      await sleep(250);
    }
    if (sh.before) await page.evaluate(sh.before).catch(e => errors.push(`before: ${e.message}`));
    await sleep(sh.wait ?? 2000);
    const file = join(dir, `${sh.name}.png`);
    await page.screenshot({ path: file });
    tiles.push({ name: sh.name, label: TILE_LABEL[sh.name], file, note: sh.note ?? null, info: { url: sh.url.replace(/^https?:\/\/[^/]+/, '') }, errors: errors.slice(0, 6) });
    await ctx.close();
  }
  return tiles;
}

// dark: the forge lookdev scene (runtimes/forge/lookdev), drawn by the forge renderer as a game draws it
async function runForge(kind, dir, ctx) {
  const { startLookdev } = await import(pathToFileURL(join(ROOTS.forge, 'lookdev/serve.mjs')).href);
  const srv = await startLookdev({ port: 0, extra: { '/sheet/': join(HERE, 'pages'), '/sheet-kinds/': KINDS_DIR } });
  try {
    const q = (shot, extra = '') => `${srv.url}?preset=${kind.sheet.preset}&shot=${shot}&hud=0${extra}`;
    const ready = () => window.__lookdev?.ready === true;
    return await runUrls([
      { name: 'world', url: q('wide'), ready, wait: 2500, note: 'lookdev wide' },
      { name: 'hero', url: q('close'), ready, wait: 2500, note: 'lookdev close' },
      { name: 'bodies', url: q('bodies'), ready, wait: 2500, note: 'lookdev bodies' },
      { name: 'props', url: `${srv.url}sheet/forge-props.html?kind=${kind.id}&preset=${kind.sheet.preset}`, ready: () => window.__sheet?.ready === true, wait: 2500, note: 'the kind\'s props in two rows, torchlit' },
    ], dir, ctx);
  } finally { await srv.close?.(); }
}

// calm: the vista core (runtimes/vista), the kind's island (a generated place) in its preset and gf-humanoid-1 bodies on its pier
// (pages/vista.js; the bodies from the asset library)
async function runVista(kind, dir, ctx) {
  const preset = kind.sheet.preset, bodies = kind.bodies?.vista ?? [];
  // the kind's place (kind.sheet.place: a seed and words, generated like any game's island); none: the reference island
  const pl = kind.sheet.place, where = pl ? `&seed=${pl.seed}&words=${encodeURIComponent(Object.entries(pl.words ?? {}).map(([k, v]) => `${k}:${v}`).join(','))}` : '';
  const page = (body, also = null) => `${ctx.url}/pages/vista.html?preset=${encodeURIComponent(preset)}${where}&body=${body}${also ? `&also=${also}` : ''}`;
  const ready = () => window.__sheet?.ready === true;
  const pose = (hold, look) => `__sheet.look.hold(${JSON.stringify(hold)}); __sheet.look.look(${JSON.stringify(look)})`;
  return runUrls([
    { name: 'world', url: page(bodies[3] ?? bodies[0]), ready, before: pose({ clip: 'idle', t: 0.3 }, { dist: 34, height: 9, angle: 3.5, at: 0.5 }), wait: 8000, note: 'the island from the sea' },
    { name: 'hero', url: page(bodies[4] ?? bodies[0]), ready, before: pose({ clip: 'idle', t: 0.6 }, { dist: 2.4, height: 1.25, angle: 0.55, at: 0.6 }), wait: 7000 },
    { name: 'bodies', url: page(bodies[0], bodies[1]), ready, before: pose({ clip: 'idle', t: 0.4 }, { dist: 3.6, height: 1.2, angle: 0.4, at: 0.55 }), wait: 7000, note: `${bodies[0]} and ${bodies[1]} of ${bodies.length}` },
    { name: 'props', url: page(bodies[2] ?? bodies[0]), ready, before: pose({ clip: 'idle', t: 0.2 }, { dist: 16, height: 5, angle: 2.4, at: 0.5 }), wait: 7000, note: 'the pier, the harbour and the hills of the kind\'s own island' },
  ], dir, ctx);
}

// scenic: a real scenic game made by create from the scenic example's spec v2 (examples/minimal/isle-run) in the kind's
// preset, played with bots, shot through the runtime's capture API (window.__gfLook.shot) on WebGPU. The body set is
// the kind's own: the game also carries a role for each of the kind's bodies, and each is shot alone in the look's
// preview (?gf-show=character.<role>, still), four strips side by side.
async function runScenic(kind, dir, ctx) {
  const { create } = await import(pathToFileURL(join(KIT, 'builder/tools/create.mjs')).href);
  const { serve } = await import(pathToFileURL(join(KIT, 'builder/tools/serve.mjs')).href);
  const games = join(KIT, '.cache/sheet-games'); mkdirSync(games, { recursive: true });
  const spec = JSON.parse(readFileSync(join(KIT, 'examples/minimal/isle-run/spec.json'), 'utf8'));
  const look = kind.look.three;
  spec.title = `Kind Sheet ${kind.label}`; spec.kind = kind.id; spec.world.template = kind.sheet.template ?? 'isles';
  spec.look = { preset: kind.sheet.preset ?? look.preset, ...(look.time ? { time: look.time } : {}) };
  // the kind's body set, one role each (the example's archer and boss go, to stay within six roles)
  const set = (kind.sheet.bodies ?? kind.bodies?.three ?? []).slice(0, 4);
  const pack = id => kind.packs.find(p => readdirSync(join(KIT, 'library/packs')).includes(p) && existsSync(join(KIT, 'library/packs', p, 'assets', `${id}.json`))) ?? null;
  const fill = id => (pack(id) ? { from: 'library', asset: `${pack(id)}/${id}` } : { from: 'kind' });
  const roles = set.map((id, i) => (i === 0 ? 'player' : `body${i + 1}`));
  spec.characters = [...set.map((id, i) => ({ role: roles[i], describe: id, body: fill(id) })), ...spec.characters.filter(c => c.role === 'monster')];
  spec.mechanics = spec.mechanics.filter(m => m.id !== 'boss').map(m => (m.id === 'waves' ? { ...m, params: { ...m.params, types: m.params.types.filter(t => t.role === 'monster') } } : m));
  const specFile = join(games, `${kind.id}.spec.json`), game = join(games, kind.id);
  writeFileSync(specFile, JSON.stringify(spec, null, 1));
  const { rmSync } = await import('node:fs'); rmSync(game, { recursive: true, force: true });
  const made = await create(specFile, game, { quiet: true });
  if (!made.ok) throw new Error(`create: ${JSON.stringify(made.problems).slice(0, 400)}`);
  const world = JSON.parse(readFileSync(join(game, 'config/world.json'), 'utf8'));
  // the props shot: the densest cluster of placed props on the first level, seen from the follow camera's side
  const ps = (world.props ?? []).filter(p => (p.level ?? 'level-1') === (world.levels?.[0]?.id ?? 'level-1'));
  const near = p => ps.filter(q => Math.hypot(q.at[0] - p.at[0], q.at[2] - p.at[2]) < 6);
  const best = ps.map(p => ({ p, n: near(p) })).sort((a, b) => b.n.length - a.n.length)[0];
  const c = best ? [0, 2].map(i => best.n.reduce((s, q) => s + q.at[i], 0) / best.n.length) : [0, 0];
  const propsCam = { position: [c[0] - 6.5, 4.2, c[1] - 6.5], target: [c[0], 0.8, c[1]], fov: 42 };
  const lv = world.levels[0], R = lv.radius ?? 19;
  const isle = { position: [lv.at[0] - R * 1.55, R * 1.25, lv.at[2] - R * 1.55], target: [lv.at[0] + R * 0.1, -R * 0.12, lv.at[2] + R * 0.1], fov: 36 };
  const srv = await serve(game, { port: 0 });
  const base = (srv.url ?? `http://127.0.0.1:${srv.port}/`).replace(/\/?$/, '/');
  const url = `${base}?seed=7&bots=3&gf-autoplay=1&gf-ui=0&quality=high`;
  const ready = () => window.__gfLook?.ready === true && window.__game?.phase === 'playing';
  const shoot = a => `window.__gfLook.shot(${JSON.stringify(a)}); await new Promise(r => setTimeout(r, 700)); window.__gfLook.shot(${JSON.stringify(a)}); window.__gfLook.freeze(true)`;
  try {
    const tiles = await runUrls([
      { name: 'world', url, ready, before: `(async () => { ${shoot(isle)} })()`, wait: 3500, note: 'the isle from the reference angle' },
      { name: 'hero', url, ready, before: `(async () => { ${shoot('hero')} })()`, wait: 3500, note: 'in play, bots running' },
      { name: 'props', url, ready, before: `(async () => { ${shoot(propsCam)} })()`, wait: 3500, note: 'props as the world places them' },
    ], dir, ctx);
    if (!ONLY || ONLY.includes('bodies')) {
      const strips = await runUrls(roles.map((r, i) => ({ name: `body-${i}`, url: `${base}?gf-show=character.${r}&quality=high&gf-ui=0`, init: 'window.__GF_STILL = true', ready: () => window.__game?.ready === true, wait: 3000 })), dir, { ...ctx, all: true });
      const file = join(dir, 'bodies.png');
      await stripsTile(strips.map(t => t.file), file);
      tiles.splice(2, 0, { name: 'bodies', label: TILE_LABEL.bodies, file, note: `${set.join(', ')}: each alone in the look's preview`, info: { bodies: set }, errors: strips.flatMap(t => t.errors) });
    }
    return tiles;
  } finally { if (srv.close) await srv.close(); else await new Promise(r => srv.server.close(r)); }
}

/** Four frames → one tile: the middle quarter of each, side by side (bodies shot alone, framed in the middle). */
async function stripsTile(files, out) {
  const { sharp } = await import(pathToFileURL(join(KIT, 'builder/tools/lib/char-deps.mjs')).href);
  const w = Math.floor(TW / files.length);
  const parts = await Promise.all(files.map(async (f, i) => ({ input: await sharp(f).extract({ left: Math.floor((TW - w) / 2), top: 0, width: w, height: TH }).toBuffer(), left: i * w, top: 0 })));
  await sharp({ create: { width: TW, height: TH, channels: 3, background: '#111' } }).composite(parts).png().toFile(out);
}

/** The sheet pages that read a game (?game=1, the game served under /game/). */
const GAME_PAGES = new Set(['three']);

const RUNNERS = {
  'three/scenic-3d': { gpu: 'webgpu', run: runScenic },
  vista: { gpu: 'webgpu', run: runVista },
  forge: { gpu: 'webgpu', run: runForge },
  'three/standard-3d': { gpu: 'webgl', page: 'three', run: (k, d, c) => runPage('three', k, d, c) },
  'three/flat-2d': { gpu: 'webgl', run: runFlat },
};

// ------------------------------------------------------------------ the HUD tile and the sheet itself
async function hudTile(kind, dir, tiles, { url, browser }) {
  const bg = tiles.find(t => t.name === 'world') ?? tiles[0];
  if (!bg) return null;
  const page = await browser.newPage({ viewport: { width: TW, height: TH }, deviceScaleFactor: 1 });
  const errs = []; page.on('pageerror', e => errs.push(e.message));
  const font = kind.hud?.font ? fontFile(kind.hud.font) : null;
  if (font?.missing) errs.push(`font: ${font.missing} (the system font stands in)`);
  await page.goto(`${url}/pages/hud.html?kind=${kind.id}&bg=${encodeURIComponent('/out/' + relative(OUT, bg.file))}${font?.file ? `&font=${encodeURIComponent('/font/' + kind.hud.font)}` : ''}`);
  const s = await waitReady(page, `${kind.id} hud`).catch(e => ({ error: e.message }));
  await sleep(400);
  const file = join(dir, 'hud.png');
  await page.screenshot({ path: file });
  const info = await page.evaluate(() => window.__sheet?.info).catch(() => null);
  await page.close();
  return { name: 'hud', label: TILE_LABEL.hud, file, info, errors: [...(s.error ? [s.error] : []), ...errs] };
}

async function compose(kind, tiles, record, { url, browser }) {
  const page = await browser.newPage({ viewport: { width: TW * 2 + 72, height: 900 }, deviceScaleFactor: 1 });
  const data = { kind, tiles: tiles.map(t => ({ name: t.name, label: t.label, src: '/out/' + relative(OUT, t.file), note: t.note ?? null })), record };
  await page.goto(`${url}/pages/compose.html`);
  await page.evaluate(d => window.compose(d), data);
  await page.waitForFunction(() => window.__composed === true, null, { timeout: 30000 });
  const file = join(OUT, `${kind.id}.png`);
  await page.screenshot({ path: file, fullPage: true });
  await page.close();
  return file;
}

// ------------------------------------------------------------------ main
mkdirSync(OUT, { recursive: true });
const server = await startServer({ ...baseMap(), '/out/': OUT, ...(GAME_DIR ? { '/game/': GAME_DIR } : {}) });
const browsers = {};
// --software: a page check on the CPU renderer while the GPU slots are busy (the sheet is marked, never evidence)
const SOFTWARE = argv.includes('--software');
const browserFor = async gpu => (browsers[SOFTWARE ? 'cpu' : gpu] ??= await launchChrome(SOFTWARE ? { args: ['--enable-unsafe-swiftshader'] } : { gpu }));
let failed = 0;
try {
  for (const id of kinds) {
    const kind = JSON.parse(readFileSync(join(KINDS_DIR, `${id}.json`), 'utf8'));
    const where = [kind.sheet?.runtime, kind.sheet?.profile].filter(Boolean).join('/');
    const R = RUNNERS[where];
    if (!R) { console.error(`${id}: no sheet runner for ${where || 'no runtime'} (have ${Object.keys(RUNNERS).join(', ')})`); failed++; continue; }
    const dir = join(OUT, 'tiles', id); mkdirSync(dir, { recursive: true });
    const record = { tool: 'builder/look-judge/kind-sheet.mjs', kind: id, runtime: where, made: new Date().toISOString(), size: [TW, TH], ...(SOFTWARE ? { software: 'CPU renderer: a page check, not a look' } : {}) };
    if (GAME_DIR) {
      const gwhere = [GAME_SPEC.runtime, GAME_SPEC.profile].filter(Boolean).join('/');
      record.game = { title: GAME_SPEC.title, runtime: gwhere, drawn: gwhere === where && GAME_PAGES.has(R?.page) ? 'the game\'s own look, world values and bodies, the kind\'s props' : `the kind's own sheet on ${where} (this sheet does not read a ${gwhere} game yet)` };
    }
    try {
      const packs = kind.sheet.packs ?? [];
      if (packs.length) { const p = await ensurePacks(packs, { fetch: argv.includes('--fetch'), log }); if (p.missing.length) throw new Error(`packs missing: ${p.missing.join(', ')} (run with --fetch)`); }
      log(`${id}: rendering on ${where}`);
      const browser = await browserFor(R.gpu);
      record.chrome = browser.version?.();
      const tiles = await R.run(kind, dir, { url: server.url, browser, log });
      const web = await browserFor('webgl');
      const hud = await hudTile(kind, dir, tiles, { url: server.url, browser: web });
      if (hud) tiles.push(hud);
      record.tiles = tiles.map(t => ({ name: t.name, file: relative(OUT, t.file), info: t.info ?? null, errors: t.errors ?? [] }));
      record.errors = tiles.flatMap(t => (t.errors ?? []).map(e => `${t.name}: ${e}`));
      record.sheet = relative(OUT, await compose(kind, tiles, record, { url: server.url, browser: web }));
      log(`${id}: ${record.sheet}${record.errors.length ? `  (${record.errors.length} notes)` : ''}`);
    } catch (e) {
      failed++; record.failed = String(e.stack ?? e); console.error(`${id}: FAILED ${e.message}`);
    }
    writeFileSync(join(OUT, `${id}.json`), JSON.stringify(record, null, 1) + '\n');
  }
} finally {
  for (const b of Object.values(browsers)) await b.close().catch(() => {});
  await server.close();
}
process.exit(failed ? 1 : 0);
