#!/usr/bin/env node
// runtime godot's own measures, played in headless Chrome with real input (run it under the GPU slot script):
//
//   node runtimes/godot/tools/measure.mjs <game-dir> --out <evidence-dir> [--legs boot,round,live,swap] [--json]
//
//   boot   (gate B, and C's controls) the page boots alone to the kit's menu with no console error; window.__game
//          answers every name the gates read; Play starts a round; D runs right, Space jumps
//   live   (gate E) two browser contexts join one room through the friends page (gf/mp, real WebRTC): each game draws
//          the other player where that player really is, in view, with their name; the shared world agrees; the
//          host ends the round and both see the results with their own score
//   swap   (gate A's slot half) a value slot changed while the game runs shows on screen (the studio page's message);
//          a picture slot replaced the way Studio replaces it (window.__GF_ASSET_OVERRIDES) is the one the game draws
//
// Writes <out>/measures.json and screenshots beside it. Exit 0 when every check passed.
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isMain, SHARED, VERSION } from './lib.mjs';
import { touchActions } from '../kit/touch.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms, label) {
  const t0 = Date.now();
  for (;;) { const v = await fn().catch(() => null); if (v) return v; if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${label}`); await sleep(150); }
}
const dist = (a, b) => Math.hypot((a.x ?? 0) - (b.x ?? 0), (a.y ?? 0) - (b.y ?? 0), (a.z ?? 0) - (b.z ?? 0));
const r2 = v => Math.round(v * 100) / 100;

/** The names the gates and the play-tester read from window.__game, and whether this game answers each. */
/** runtimes/CONTRACT.md §6.1: the names every runtime's window.__game answers. */
export const OBSERVATION = ['kit', 'runtime', 'profile', 'version', 'seed', 'quality', 'phase', 'ready', 'players', 'snapshot', 'coverage', 'slots', 'sight', 'project', 'camera', 'controls', 'screen', 'menu', 'hud', 'looks', 'events', 'sounds', 'panels'];
export const SNAPSHOT = ['kit', 'runtime', 'profile', 'version', 'phase', 'round', 'seed', 'quality', 'time', 'me', 'host', 'live', 'backdrop', 'view', 'paused', 'players', 'fair', 'refusals', 'winners', 'reason', 'results', 'shared', 'rules', 'modules', 'net', 'watch', 'world', 'godot'];

/** The HUD and touch boxes a phone layout must keep apart and on the screen: [name, CSS selector]. */
export const PHONE_BOXES = [['menu button', '#gf-menu-button'], ['clock', '#gf-ui .gf-top'], ['scores', '#gf-ui .gf-scores'], ['goal line', '#gf-goal'], ['player card', '#gf-hud'], ['move stick', '#gf-ui [data-gf-rest="stick"]'], ['Jump', '#gf-ui .gf-touch button[data-action="jump"]'], ['Action', '#gf-ui .gf-touch button[data-action="primary"]'], ['Use', '#gf-ui .gf-touch button[data-action="interact"]'], ['Other', '#gf-ui .gf-touch button[data-action="secondary"]']];
/** Two boxes overlap by more than a sliver ([l, t, r, b] in CSS px). */
export const boxesOverlap = (a, b, slack = 2) => Math.min(a[2], b[2]) - Math.max(a[0], b[0]) > slack && Math.min(a[3], b[3]) - Math.max(a[1], b[1]) > slack;
/** Which boxes leave the screen and which pairs overlap: {off: [name], overlaps: [[name, name]]}. */
export function phoneFit(boxes, w, h) {
  const off = boxes.filter(x => x.r[0] < 0 || x.r[1] < 0 || x.r[2] > w || x.r[3] > h).map(x => x.name), overlaps = [];
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) if (boxesOverlap(boxes[i].r, boxes[j].r)) overlaps.push([boxes[i].name, boxes[j].name]);
  return { off, overlaps };
}

export const LEGS = ['boot', 'round', 'bots', 'live', 'swap', 'panels', 'watch'];
/** Devices beyond the desktop Chrome every build runs: a phone emulated in Chrome, Firefox and WebKit (a release's). */
export const DEVICE_LEGS = ['phone', 'browsers'];
export async function measure(gameDir, { out, legs = LEGS, log = () => {} } = {}) {
  const dir = resolve(gameDir);
  await mkdir(out, { recursive: true });
  const { launchChrome } = await import(pathToFileURL(SHARED.browser).href);
  const { startParty } = await import(pathToFileURL(join(SHARED.party, 'lib.mjs')).href);
  const checks = [], shots = [], rec = { schema: 'xgames-godot-measures/1', runtime: VERSION, game: dir.split(/[\\/]/).pop(), at: new Date().toISOString(), legs, checks, shots };
  const check = (gate, name, ok, detail) => { checks.push({ gate, name, ok: !!ok, detail }); log(`${ok ? 'pass' : 'FAIL'} ${gate} ${name}: ${detail}`); return !!ok; };
  const shot = async (page, name) => { const f = `${name}.png`; await page.screenshot({ path: join(out, f) }); shots.push(f); return f; };
  const srv = await startParty({ dir, port: 0 });
  const browser = await launchChrome({ gpu: 'webgl' });
  rec.chrome = browser.version();
  const errorsOf = page => {
    const errs = [];
    page.on('console', m => { if (m.type() === 'error') errs.push(m.text().slice(0, 300)); });
    page.on('pageerror', e => errs.push(`pageerror: ${e.message}`.slice(0, 300)));
    page.on('response', r => { if (r.status() >= 400 && !/favicon/.test(r.url())) errs.push(`HTTP ${r.status()} ${r.url()}`); });
    return errs;
  };
  const game = page => page.evaluate(() => window.__game?.snapshot() ?? null);
  // a helper page that counts pixels of a screenshot (PNG) inside a box: {n, red, magenta, blueish}
  const helper = await (await browser.newContext()).newPage();
  const pixels = (png, box) => helper.evaluate(async ({ b64, box }) => {
    const img = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
    const c = new OffscreenCanvas(img.width, img.height), g = c.getContext('2d'); g.drawImage(img, 0, 0);
    const x0 = Math.max(0, Math.round(box.x0)), y0 = Math.max(0, Math.round(box.y0)), w = Math.max(1, Math.min(img.width - x0, Math.round(box.x1 - box.x0))), h = Math.max(1, Math.min(img.height - y0, Math.round(box.y1 - box.y0)));
    const d = g.getImageData(x0, y0, w, h).data; let red = 0, magenta = 0, blueish = 0;
    for (let i = 0; i < d.length; i += 4) { const [r, gg, b] = [d[i], d[i + 1], d[i + 2]]; if (r > 90 && r > 2 * gg && r > 2 * b) red++; if (r > 200 && b > 200 && gg < 60) magenta++; if (b > 120 && b > r + 30) blueish++; }
    return { n: w * h, red, magenta, blueish };
  }, { b64: png.toString('base64'), box });
  // where this game draws its own player on the screen (CSS pixels), from the observation's view and pose
  const meBox = (s, page) => {
    const v = s.godot?.view, m = s.godot?.me;
    if (s.profile === '3d') return page && m ? page.evaluate(([x, y, z]) => { const a = window.__game.project(x, y + 1.7, z), b = window.__game.project(x, y, z); if (!a.front || !b.front) return null; const h = Math.abs(b.y - a.y); return { x0: a.x - h * 0.3, x1: a.x + h * 0.3, y0: a.y, y1: b.y }; }, [m.x, m.y, m.z]) : null;
    if (!v || !m || !Number.isFinite(v.cx)) return null;
    const ppm = (s.godot.ppm ?? 16) * (v.zoom ?? 1);
    const sx = v.w / 2 + (m.x - v.cx) * ppm, sy = v.h / 2 - (m.y - v.cy) * ppm;
    return { x0: sx - 0.5 * ppm, x1: sx + 0.5 * ppm, y0: sy - 1.7 * ppm, y1: sy };
  };
  const bootAlone = async (context, name) => {
    const page = await context.newPage(); const errs = errorsOf(page);
    await page.goto(srv.url, { waitUntil: 'load' });
    await until(async () => (await page.evaluate(() => window.__game?.ready && window.__game.phase === 'lobby')), 60000, `${name}: the menu`);
    return { page, errs };
  };
  const play = async page => {
    await page.click('#gf-play');
    await until(async () => (await game(page))?.phase === 'playing', 15000, 'the round to start');
    await sleep(500);
  };

  try {
    // ---- boot: alone, to the menu, then a round with real keys ----
    if (legs.includes('boot')) {
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
      const t0 = Date.now();
      const { page, errs } = await bootAlone(ctx, 'boot');
      const bootMs = Date.now() - t0;
      await sleep(400);
      await shot(page, 'boot-home');
      const s = await game(page);
      const answers = await page.evaluate(names => Object.fromEntries(names.map(n => { const v = window.__game[n]; let a; try { a = typeof v === 'function' ? v() : v; } catch (e) { a = { error: e.message }; } return [n, a === undefined ? 'missing' : typeof v === 'function' ? 'function' : typeof a]; })), OBSERVATION);
      const missing = OBSERVATION.filter(n => answers[n] === 'missing'), snapMissing = SNAPSHOT.filter(k => !(k in (s ?? {})));
      rec.observation = { answers, snapshotKeys: Object.keys(s ?? {}), godotKeys: Object.keys(s?.godot ?? {}), bootMs };
      check('B', 'boots-to-the-menu', s?.phase === 'lobby' && s.godot?.frames > 0, `the kit's menu is up over the Godot canvas in ${bootMs} ms (Godot ${s?.godot?.godot}, addon ${s?.godot?.addon?.addon}, ${s?.godot?.frames} game frames)`);
      const engineKey = await page.evaluate(() => 'engine' in window.__game || 'engine' in window.__game.snapshot());
      if (engineKey) missing.push('(an engine field, which the contract retires)');
      check('B', 'observation-answers', !missing.length && !snapMissing.length, missing.length || snapMissing.length ? `missing: ${[...missing, ...snapMissing.map(k => `snapshot().${k}`)].join(', ')}` : `window.__game answers all ${OBSERVATION.length} names; snapshot() has ${Object.keys(s).length} keys, godot: ${Object.keys(s.godot).join(', ')}`);
      const read = Object.keys(await page.evaluate(() => window.__game.slots()));
      rec.read = read;
      check('A', 'pictures-read-through-slots', read.includes('character.body.player') && read.some(id => id.startsWith('world.tiles.')), `the game read ${read.length} picture slots through gf-assets: ${read.join(', ')}`);
      await play(page);
      const a = await game(page);
      const is3d = a.profile === '3d';
      const top = a.world?.plane === 'top' && !is3d;
      rec.plane = a.world?.plane ?? null; rec.profile = a.profile;
      if (top) {
        // seen from above the field fills the view, so the look honoured is look.view: the camera shows that many metres
        // top to bottom (pixel art at a whole number of screen pixels a texel)
        const v = a.godot.view, view = await page.evaluate(() => window.__game.snapshot().godot);
        const want = (await page.evaluate(() => fetch('config/look.json').then(r => r.json()))).values?.view ?? 12;
        const z = v.h / (want * view.ppm), zz = view.style === 'pixel' ? Math.max(1, Math.round(z)) : z;
        check('F', 'look-view-honoured', Math.abs(v.zoom - zz) < 0.01, `look.view is ${want} m; the camera's zoom is ${v.zoom} (the view's rule gives ${r2(zz)}): it shows ${r2(v.h / (v.zoom * view.ppm))} m top to bottom`);
      }
      const want = String(a.godot?.background ?? '').replace('#', ''), png = await page.screenshot();
      const bg = await helper.evaluate(async ({ b64, at }) => {
        const img = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
        const c = new OffscreenCanvas(img.width, img.height), g = c.getContext('2d'); g.drawImage(img, 0, 0);
        const d = g.getImageData(at.x, at.y, 1, 1).data; return [d[0], d[1], d[2]];
      }, { b64: png.toString('base64'), at: is3d ? { x: 250, y: 14 } : { x: 640, y: 110 } });
      const wantRgb = want.length === 6 ? [0, 2, 4].map(i => parseInt(want.slice(i, i + 2), 16)) : null;
      if (!top) check('F', 'look-background-honoured', wantRgb && bg.every((v, i) => Math.abs(v - wantRgb[i]) <= 3), `look.background is #${want}; the sky on screen is rgb(${bg.join(', ')})${is3d ? ' (above the arena\'s far wall)' : ''}`);
      await page.keyboard.down('KeyD'); await sleep(900); await page.keyboard.up('KeyD');
      const b = await game(page);
      check('C', 'D-runs-right', b.godot.me.x - a.godot.me.x > 1 && (!is3d || Math.abs(b.godot.me.z - a.godot.me.z) < 0.3), `holding D for 0.9 s moved the player ${r2(b.godot.me.x - a.godot.me.x)} m (x ${r2(a.godot.me.x)} → ${r2(b.godot.me.x)})`);
      if (top) {
        await page.keyboard.down('KeyW'); await sleep(700); await page.keyboard.up('KeyW');
        const c = await game(page);
        check('C', 'W-walks-up', c.godot.me.y - b.godot.me.y > 1 && c.godot.me.look === 'up', `holding W for 0.7 s moved the player ${r2(c.godot.me.y - b.godot.me.y)} m north, facing "${c.godot.me.look}"`);
      } else if (is3d) {
        // 3D: W walks north (away from the camera, -z) and turns the body to face where it goes; Space jumps
        await page.keyboard.down('KeyW'); await sleep(700); await page.keyboard.up('KeyW');
        const c = await game(page);
        const facing = Math.abs(Math.atan2(Math.sin(c.godot.me.yaw - Math.PI), Math.cos(c.godot.me.yaw - Math.PI)));
        check('C', 'W-walks-north', b.godot.me.z - c.godot.me.z > 1 && facing < 0.5, `holding W for 0.7 s moved the player ${r2(b.godot.me.z - c.godot.me.z)} m north (-z); the body faces yaw ${r2(c.godot.me.yaw)} (north is ±3.14)`);
        let high = c.godot.me.y;
        await page.keyboard.press('Space');
        for (let i = 0; i < 8; i++) { await sleep(60); high = Math.max(high, (await game(page)).godot.me.y); }
        check('C', 'Space-jumps', high - c.godot.me.y > 0.6, `Space lifted the player ${r2(high - c.godot.me.y)} m`);
      } else {
        let high = b.godot.me.y;
        await page.keyboard.press('Space');
        for (let i = 0; i < 8; i++) { await sleep(70); high = Math.max(high, (await game(page)).godot.me.y); }
        check('C', 'Space-jumps', high - b.godot.me.y > 1, `Space lifted the player ${r2(high - b.godot.me.y)} m`);
      }
      await shot(page, 'boot-playing');
      // the menu holds input: Esc pauses, and D does nothing under the pause menu
      await page.keyboard.press('Escape'); await sleep(300);
      const p0 = await game(page);
      await page.keyboard.down('KeyD'); await sleep(600); await page.keyboard.up('KeyD');
      const p1 = await game(page);
      check('C', 'menu-holds-input', p0.view === 'pause' && Math.abs(p1.godot.me.x - p0.godot.me.x) < 0.05, `Esc opened "${p0.view}"; D under it moved the player ${r2(Math.abs(p1.godot.me.x - p0.godot.me.x))} m`);
      await shot(page, 'boot-paused');
      await page.keyboard.press('Escape'); await sleep(300);
      const q0 = await game(page);
      await page.keyboard.down('KeyA'); await sleep(500); await page.keyboard.up('KeyA');
      const q1 = await game(page);
      check('C', 'esc-resumes', !q0.view && q0.godot.input && q0.godot.me.x - q1.godot.me.x > 0.5, `a second Esc left the pause menu (view ${q0.view}, input ${q0.godot.input}); A then moved the player ${r2(q0.godot.me.x - q1.godot.me.x)} m left`);
      check('B', 'no-console-errors', errs.length === 0, errs.length ? errs.slice(0, 4).join(' | ') : 'no console error, page error or failed request');
      await ctx.close();
    }

    // ---- round: alone, a short round reaches the results and plays again (gate D, measure 6) ----
    if (legs.includes('round')) {
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
      // a 20-second round, set the way Studio sets a value (a patch over config/game.json before the boot)
      await ctx.addInitScript(() => { window.__GF_ASSET_OVERRIDES = { patches: [{ file: 'config/game.json', pointer: '/round/seconds', value: 20 }] }; });
      const { page, errs } = await bootAlone(ctx, 'round');
      await play(page);
      await page.keyboard.down('KeyD'); await sleep(500); await page.keyboard.up('KeyD');
      const res = await until(async () => { const s = await game(page); return s?.phase === 'results' ? s : null; }, 40000, 'the round to end').catch(() => null);
      await sleep(600);
      if (res) await shot(page, 'round-results');
      const seats = 1 + (res?.players ?? []).filter(p => p.bot).length;
      check('D', 'round-reaches-results', !!res && Array.isArray(res.results) && res.results.length === seats, res ? `the 20 s round ended (${res.reason}); the results list ${res.results.map(r => `${r.name} ${r.value}`).join(', ')}` : 'no results within 40 s');
      const again = await page.$('#gf-again');
      if (again) await again.click();
      const replay = await until(async () => { const s = await game(page); return ['countdown', 'playing'].includes(s?.phase) ? s : null; }, 10000, 'the replay').catch(() => null);
      check('D', 'plays-again', !!replay && replay.round === (res?.round ?? 0) + 1, replay ? `Play again started round ${replay.round} (${replay.phase})` : 'Play again did not start a round');
      check('B', 'no-console-errors-round', errs.length === 0, errs.length ? errs.slice(0, 3).join(' | ') : 'none');
      await ctx.close();
    }

    // ---- bots: alone with two bots (?bots=2): seated, drawn, moving, still under the pause menu, in the results ----
    if (legs.includes('bots')) {
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
      await ctx.addInitScript(() => { window.__GF_ASSET_OVERRIDES = { patches: [{ file: 'config/game.json', pointer: '/round/seconds', value: 14 }] }; });
      const page = await ctx.newPage(); const errs = errorsOf(page);
      const u = new URL(srv.url); u.searchParams.set('bots', '2');
      await page.goto(u.href, { waitUntil: 'load' });
      await until(async () => (await page.evaluate(() => window.__game?.ready && window.__game.phase === 'lobby')), 60000, 'bots: the menu');
      await play(page);
      const bots0 = (await game(page)).players.filter(p => p.bot);
      await sleep(3500);
      const s1 = await game(page), bots1 = s1.players.filter(p => p.bot);
      await shot(page, 'bots-playing');
      const moved = bots1.map(b => { const a = bots0.find(x => x.id === b.id); return a ? Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) : 0; });
      check('D', 'bots-fill-the-seats', bots1.length === 2 && bots1.every(b => b.drawn) && s1.players.length === 3, `alone with ?bots=2: ${s1.players.length} players, bots ${bots1.map(b => `${b.name} (drawn ${b.drawn})`).join(', ') || 'none'}`);
      check('D', 'bots-move', moved.length === 2 && moved.every(m => m > 1), `in 3.5 s the bots moved ${moved.map(r2).join(' m and ')} m`);
      await page.keyboard.press('Escape'); await sleep(300);
      const h0 = (await game(page)).players.filter(p => p.bot);
      await sleep(1200);
      const h1 = (await game(page)).players.filter(p => p.bot);
      const still = h1.map(b => { const a = h0.find(x => x.id === b.id); return a ? Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) : 99; });
      check('C', 'bots-hold-under-the-menu', still.every(m => m < 0.3), `under the pause menu for 1.2 s the bots moved ${still.map(r2).join(' m and ')} m`);
      await page.keyboard.press('Escape');
      const res = await until(async () => { const x = await game(page); return x?.phase === 'results' ? x : null; }, 30000, 'the round with bots to end').catch(() => null);
      if (res) { await sleep(500); await shot(page, 'bots-results'); }
      rec.bots = { scores: res?.results ?? null };
      check('D', 'bots-in-the-results', !!res && res.results.length === 3 && bots1.every(b => res.results.some(r => r.id === b.id)), res ? `the results list ${res.results.map(r => `${r.name} ${r.value}`).join(', ')}` : 'no results within 30 s');
      check('B', 'no-console-errors-bots', errs.length === 0, errs.length ? errs.slice(0, 3).join(' | ') : 'none');
      await ctx.close();
    }

    // ---- panels: the kit's choice cards over the game, opened through the bridge as GF.panel opens them ----
    if (legs.includes('panels')) {
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
      const { page, errs } = await bootAlone(ctx, 'panels');
      await play(page);
      // exactly the call addons/gf/gf.gd makes for GF.panel("choice", {...}) through JavaScriptBridge
      await page.evaluate(() => window.gfGodot.panel(9001, 'choice', JSON.stringify({ title: 'Pick a boost', cards: [{ id: 'fast', name: 'Fast', text: 'Run faster' }, { id: 'high', name: 'High', text: 'Jump higher' }] })));
      await sleep(500);
      const o = await page.evaluate(() => window.__game.panels());
      const p0 = await game(page);
      await page.keyboard.down('KeyD'); await sleep(500); await page.keyboard.up('KeyD');
      const p1 = await game(page);
      await shot(page, 'panel-choice-open');
      check('B', 'panel-covers-the-game', o.open.some(x => x.kind === 'choice' && x.count === 2) && o.covered && !p0.godot.input && Math.abs(p1.godot.me.x - p0.godot.me.x) < 0.05, `open: ${o.open.map(x => `${x.kind} "${x.title}" (${x.count} cards, modal ${x.modal})`).join(', ') || 'nothing'}; the game's input ${p0.godot.input ? 'still on' : 'held'}; D under it moved the player ${r2(Math.abs(p1.godot.me.x - p0.godot.me.x))} m`);
      const card = page.locator('.gfp-choice [data-i="1"]').first();
      if (await card.count()) await card.click(); else await page.keyboard.press('Digit2');
      const got = await until(async () => (await game(page))?.godot?.panel ?? null, 5000, 'the panel\'s answer in the game').catch(() => null);
      await sleep(400);
      const p2 = await game(page), o2 = await page.evaluate(() => window.__game.panels());
      check('B', 'panel-answer-reaches-the-game', got?.req === 9001 && got?.result?.id === 'high' && got.result.index === 1 && !o2.open.length && p2.godot.input, `a click on the second card: Godot got ${JSON.stringify(got)}; panels open after: ${o2.open.length}; the game's input ${p2.godot.input ? 'back' : 'still held'}`);
      check('B', 'no-console-errors-panels', errs.length === 0, errs.length ? errs.slice(0, 3).join(' | ') : 'none');
      await ctx.close();
    }

    // ---- live: two players through the friends page ----
    if (legs.includes('live')) {
      const H = await browser.newContext({ viewport: { width: 1280, height: 720 } }), J = await browser.newContext({ viewport: { width: 1280, height: 720 } });
      const hp = await H.newPage(), jp = await J.newPage();
      const herr = errorsOf(hp), jerr = errorsOf(jp);
      const party = p => p.evaluate(() => window.__party?.snapshot() ?? null).catch(() => null);
      const frame = p => p.frames().find(f => f.parentFrame() === p.mainFrame());
      const g = p => frame(p)?.evaluate(() => window.__game?.snapshot() ?? null).catch(() => null) ?? null;
      await hp.goto(`${srv.partyUrl}?max=60`, { waitUntil: 'load' });
      await until(async () => (await party(hp))?.phase === 'home', 30000, 'the host lobby');
      await hp.fill('#gfp-name', 'Hosta'); await hp.click('#gfp-host');
      await until(async () => { const s = await party(hp); return s?.phase === 'room' && s.code; }, 30000, 'the host to open a room');
      const invite = await hp.inputValue('#mp-invite');
      await jp.goto(invite, { waitUntil: 'load' });
      await until(async () => (await party(jp))?.phase === 'home', 30000, 'the joiner lobby');
      await jp.fill('#gfp-name', 'Joan'); await jp.click('#gfp-join');
      await until(async () => (await party(hp))?.racers?.length === 2 && (await party(jp))?.racers?.length === 2, 40000, 'both players in the room');
      check('E', 'joiner-joins', true, `room ${(await party(hp)).code}: Hosta hosts, Joan joined by the invite link over WebRTC`);
      await shot(hp, 'live-lobby-host');
      await hp.click('#mp-start');
      await until(async () => (await g(hp))?.net?.started && (await g(jp))?.net?.started, 90000, 'both games to start');
      const [h0, j0] = [await g(hp), await g(jp)];
      check('E', 'one-host', h0.net.host === true && j0.net.host === false && h0.net.you !== j0.net.you, `host copy ${h0.net.you}, joiner copy ${j0.net.you}`);
      for (const p of [hp, jp]) { const box = await p.locator('#game').boundingBox(); await p.mouse.click(box.x + box.width / 2, box.y + box.height / 2); }
      await sleep(800);
      // each player moves with real keys, then stands still; the other copy must draw them where they are
      const settle = async (mover, moverKey, ms, label) => {
        await mover.keyboard.down(moverKey); await sleep(ms); await mover.keyboard.up(moverKey);
        await sleep(1400);
        const [a, b] = [await g(hp), await g(jp)];
        const hostSeen = b.net.peers.find(p => p.id === a.net.you), joinSeen = a.net.peers.find(p => p.id === b.net.you);
        return { label, host: a.net.me, joiner: b.net.me, hostOnJoiner: hostSeen, joinerOnHost: joinSeen, dHost: hostSeen?.x == null ? null : dist(hostSeen, a.net.me), dJoin: joinSeen?.x == null ? null : dist(joinSeen, b.net.me), names: { onJoiner: hostSeen?.name, onHost: joinSeen?.name } };
      };
      const s1 = await settle(hp, 'KeyD', 900, 'the host ran right');
      const s2 = await settle(jp, 'KeyA', 700, 'the joiner ran left');
      rec.live = { samples: [s1, s2] };
      const ok = s => s.dHost != null && s.dJoin != null && s.dHost < 0.15 && s.dJoin < 0.15;
      check('E', 'each-draws-the-other-where-they-are', ok(s1) && ok(s2), [s1, s2].map(s => `${s.label}: the joiner draws the host ${s.dHost == null ? 'nowhere' : `${r2(s.dHost)} m`} from where the host is (${r2(s.host.x)}, ${r2(s.host.y)}); the host draws the joiner ${s.dJoin == null ? 'nowhere' : `${r2(s.dJoin)} m`} off (${r2(s.joiner.x)}, ${r2(s.joiner.y)})`).join('; '));
      check('E', 'each-sees-the-other-on-screen', s2.hostOnJoiner?.onScreen && s2.joinerOnHost?.onScreen, `in view: the host on the joiner's screen ${!!s2.hostOnJoiner?.onScreen}, the joiner on the host's ${!!s2.joinerOnHost?.onScreen}`);
      check('E', 'names-are-the-players-own', s2.names.onJoiner === 'Hosta' && s2.names.onHost === 'Joan', `the joiner's copy calls the host "${s2.names.onJoiner}", the host's calls the joiner "${s2.names.onHost}"`);
      const drawnTag = await frame(jp).evaluate(() => [...document.querySelectorAll('.gf-godot-tag')].filter(e => e.style.display !== 'none').map(e => e.textContent));
      check('E', 'name-tag-over-the-friend', drawnTag.includes('Hosta'), `tags shown on the joiner's screen: ${JSON.stringify(drawnTag)}`);
      await shot(hp, 'live-host-sees-joiner'); await shot(jp, 'live-joiner-sees-host');
      // the game's own tests (measure 35): tests/*.play.mjs, each given both players
      const own = existsSync(join(dir, 'tests')) ? (await readdir(join(dir, 'tests'))).filter(f => f.endsWith('.play.mjs')).sort() : [];
      for (const f of own) {
        try { await (await import(pathToFileURL(join(dir, 'tests', f)).href)).default({ host: hp, joiner: jp, game: g, sleep, check: (name, ok, detail) => check('F', name, ok, detail) }); }
        catch (e) { check('F', `own:${f}`, false, e.message); }
      }
      if (own.length) { rec.own = own; await shot(jp, 'live-own-tests-joiner'); }
      const [a2, b2] = [await g(hp), await g(jp)];
      check('E', 'shared-world-agrees', a2.net.shared === b2.net.shared, `host "${a2.net.shared}" / joiner "${b2.net.shared}"`);
      check('E', 'shared-clock-runs', b2.net.clock > 1, `the joiner's shared clock reads ${b2.net.clock} s (the host's ${a2.net.clock} s)`);
      // the host ends the round from the pause menu: both see the results
      await hp.keyboard.press('Escape'); await sleep(300);
      const end = frame(hp).locator('#gf-end-round');
      if (await end.count()) await end.click(); else await hp.evaluate(() => document.querySelector('#mp-end')?.click());
      const done = await until(async () => (await g(hp))?.phase === 'results' && (await g(jp))?.phase === 'results', 20000, 'both to reach the results').then(() => true).catch(() => false);
      check('E', 'both-reach-the-results', done, done ? 'the host ended the round; both copies show the results' : `phases: host ${(await g(hp))?.phase}, joiner ${(await g(jp))?.phase}`);
      await sleep(1200);
      await shot(hp, 'live-results-host'); await shot(jp, 'live-results-joiner');
      const kitErr = [...herr.map(e => `host: ${e}`), ...jerr.map(e => `joiner: ${e}`)];
      check('B', 'no-console-errors-live', kitErr.length === 0, kitErr.length ? kitErr.slice(0, 4).join(' | ') : 'no console error on either player\'s page');
      await H.close(); await J.close();
    }

    // ---- phone: Chrome emulating a phone (390x844 CSS px, 3x, touch, a coarse pointer): the menu fits, Play by a tap,
    // the kit's stick moves the player and its Jump button jumps (side-on) ----
    if (legs.includes('phone')) await phoneLeg({ browser, srv, out, check, shots, rec, game, until });
    // ---- other browsers: Playwright's Firefox and WebKit builds, headless: boots to the menu and plays with real keys ----
    if (legs.includes('browsers')) await browsersLeg({ srv, out, check, shots, rec });

    // ---- watch: Go live from the game's pause menu, a viewer watches through the friends page (gf/mp), voice ----
    if (legs.includes('watch')) await watchLeg({ dir, srv, out, check, shots, rec, log });

    // ---- swap: a value slot live, a picture slot as Studio replaces it ----
    if (legs.includes('swap')) {
      const c1 = await browser.newContext({ viewport: { width: 1280, height: 720 } });
      const { page } = await bootAlone(c1, 'swap');
      await play(page);
      const before = await page.screenshot();
      const g0 = await game(page);
      const plane = g0.profile === '3d' ? '3d' : g0.world?.plane;
      const sky = plane === '3d' ? { x0: 200, y0: 6, x1: 300, y1: 26 } : { x0: 600, y0: 120, x1: 680, y1: 160 };
      const setSlot = (id, value) => page.evaluate(([id, value]) => new Promise(res => {
        addEventListener('message', e => { if (e.data?.type === 'gf:slot-applied' && e.data.id === id) res(e.data); });
        postMessage({ type: 'gf:slot', id, value }, '*');
        setTimeout(() => res(null), 3000);
      }), [id, value]);
      if (plane === 'top') {
        // seen from above: look.view changed live, the camera shows half as many metres at once
        const z0 = (await game(page)).godot.view.zoom;
        const answer = await setSlot('look.view', 6);
        await sleep(600);
        const z1 = (await game(page)).godot.view.zoom;
        await shot(page, 'swap-view-live');
        check('A', 'value-slot-shows-live', answer?.ok && z1 >= z0 * 1.9, `the page set look.view to 6 m (${answer ? `ok ${answer.ok}, ${answer.live}` : 'no answer'}); the camera's zoom went ${z0} → ${z1}`);
        await setSlot('look.view', 12); await sleep(600);
      } else {
        const answer = await setSlot('look.background', '#ff00ff');
        await sleep(500);
        const after = await page.screenshot();
        const [pb, pa] = [await pixels(before, sky), await pixels(after, sky)];
        await shot(page, 'swap-background-live');
        check('A', 'value-slot-shows-live', answer?.ok && pa.magenta / pa.n > 0.9 && pb.magenta === 0, `the page set look.background to #ff00ff (${answer ? `ok ${answer.ok}, ${answer.live}` : 'no answer'}); the sky went from ${pb.magenta}/${pb.n} to ${pa.magenta}/${pa.n} magenta pixels`);
      }
      const after = await page.screenshot();
      const base = await game(page);
      // a picture slot replaced the way Studio replaces it: a red copy of the body sheet (2D), or of the ground's tile (3D:
      // the body is a model), made in the page from the game's own file
      const pic = plane === '3d'
        ? await page.evaluate(() => fetch('config/world.json').then(r => r.json()).then(w => ({ id: `world.tiles.${w.map.base}`, file: w.tiles[w.map.base], what: 'the ground under the player' })))
        : { id: 'character.body.player', file: 'assets/sprites/body-player.png', what: 'where the player stands' };
      const boxOf = async (s, p) => {
        if (plane !== '3d') return meBox(s);
        const m = s.godot?.me; if (!m) return null;
        const f = await p.evaluate(([x, y, z]) => window.__game.project(x, y, z), [m.x, m.y, m.z]);
        return f.front ? { x0: f.x - 70, x1: f.x + 70, y0: f.y + 8, y1: f.y + 40 } : null;
      };
      const baseBox = await boxOf(base, page), baseHash = (await page.evaluate(() => window.__game.slots()))[pic.id]?.hash;
      const basePx = baseBox ? await pixels(after, baseBox) : null;
      const red = await page.evaluate(async file => {
        const img = await createImageBitmap(await (await fetch(file)).blob());
        const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
        const g = c.getContext('2d'); g.drawImage(img, 0, 0);
        const d = g.getImageData(0, 0, c.width, c.height);
        for (let i = 0; i < d.data.length; i += 4) if (d.data[i + 3] > 0) { d.data[i] = 235; d.data[i + 1] = 20; d.data[i + 2] = 20; }
        g.putImageData(d, 0, 0);
        return c.toDataURL('image/png');
      }, pic.file);
      await c1.close();
      const c2 = await browser.newContext({ viewport: { width: 1280, height: 720 } });
      await c2.addInitScript(([f, u]) => { window.__GF_ASSET_OVERRIDES = { files: { [f]: u } }; }, [pic.file, red]);
      const { page: p2, errs: e2 } = await bootAlone(c2, 'swap (replaced picture)');
      await play(p2);
      const s2 = await game(p2), box2 = await boxOf(s2, p2), hash2 = (await p2.evaluate(() => window.__game.slots()))[pic.id]?.hash;
      const shot2 = await p2.screenshot();
      const px2 = box2 ? await pixels(shot2, box2) : null;
      await shot(p2, plane === '3d' ? 'swap-ground-replaced' : 'swap-body-replaced');
      rec.swap = { slot: pic.id, baseHash, hash2, basePx, px2, baseBox, box2 };
      // (the body's own picture keeps its skin and hair since the seat colour goes onto its greys only: a few reddish
      // texels before are the picture's own; the replaced one must be red many times over)
      check('A', 'picture-slot-replaced', hash2 && hash2 !== baseHash && px2 && px2.red > 40 && px2.red >= 8 * (basePx?.red ?? 0), `the game was handed ${hash2} for ${pic.id} (its own file is ${baseHash}); red pixels ${pic.what}: ${basePx?.red ?? '?'} before, ${px2?.red ?? '?'} with the replaced picture (of ${px2?.n ?? '?'})`);
      check('B', 'no-console-errors-swap', e2.length === 0, e2.length ? e2.slice(0, 3).join(' | ') : 'none');
      await c2.close();
    }
  } catch (e) {
    check('B', 'ran', false, e.stack?.split('\n').slice(0, 3).join(' ') ?? String(e));
  } finally {
    await browser.close().catch(() => {});
    await srv.close().catch(() => {});
  }
  rec.ok = checks.every(c => c.ok);
  rec.gates = Object.fromEntries([...new Set(checks.map(c => c.gate))].sort().map(gt => [gt, { ok: checks.filter(c => c.gate === gt).every(c => c.ok), checks: checks.filter(c => c.gate === gt).map(c => c.name) }]));
  await writeFile(join(out, 'measures.json'), JSON.stringify(rec, null, 2) + '\n');
  return rec;
}

if (isMain(import.meta)) {
  const a = process.argv.slice(2), opt = k => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : null; };
  const dir = a.find((x, i) => !x.startsWith('--') && !['--out', '--legs'].includes(a[i - 1]));
  if (!dir || !opt('--out')) { console.error(`usage: measure.mjs <game-dir> --out <evidence-dir> [--legs ${LEGS.join(',')}] [--json]`); process.exit(2); }
  const rec = await measure(dir, { out: resolve(opt('--out')), legs: (opt('--legs') ?? LEGS.join(',')).split(','), log: m => { if (!a.includes('--json')) console.log(m); } });
  if (a.includes('--json')) console.log(JSON.stringify(rec, null, 2));
  else console.log(`${rec.ok ? 'all passed' : 'FAILED'}: ${rec.checks.filter(c => c.ok).length}/${rec.checks.length} checks → ${opt('--out')}/measures.json`);
  process.exit(rec.ok ? 0 : 1);
}

/**
 * Watch then play on runtime godot (measure 34), the shared check's steps that do not assume a 3D game
 * (builder/tools/lib/friends-watch-check.mjs) plus its voice steps unchanged (voiceSteps): H hosts and J joins; J goes
 * live from the game's own pause menu; LIVE shows for H; V opens the link and tunes in, following J; the viewer hears J
 * (a fake microphone); J runs and V draws J where J really is, with V's camera on J and no player of V's own; V keeps
 * the clock and the scores but no menu; J's name tag sits over J on V's screen; J sees "1 watching". Its own browser
 * (Chrome with a fake microphone).
 */
async function watchLeg({ dir, srv, out, check, shots, rec, log }) {
  const { launchChrome, GPU_TROUBLE } = await import(pathToFileURL(SHARED.browser).href);
  const { voiceSteps, voiceArgs } = await import(pathToFileURL(join(SHARED.toolsLib, 'friends-watch-check.mjs')).href);
  const browser = await launchChrome({ gpu: 'webgl', args: voiceArgs(), disableFeatures: ['WebRtcHideLocalIpsWithMdns'] });
  const errors = [], steps = [];
  const step = (name, ok, detail = '') => { steps.push({ name, ok: !!ok, detail }); check('E', `watch: ${name}`, ok, detail); return !!ok; };
  const open = async who => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await ctx.newPage();
    page.on('pageerror', e => errors.push(`${who}: ${e.message}`));
    page.on('console', m => { if (m.type() === 'error' && !GPU_TROUBLE.test(m.text()) && !/Failed to load resource/.test(m.text())) errors.push(`${who}: ${m.text().slice(0, 240)}`); });
    return { who, ctx, page };
  };
  const frameOf = P => P.page.frames().find(f => f.parentFrame() === P.page.mainFrame());
  const game = P => frameOf(P)?.evaluate(() => window.__game?.snapshot?.() ?? null).catch(() => null) ?? null;
  const cam = P => frameOf(P)?.evaluate(() => window.__game?.camera?.() ?? null).catch(() => null) ?? null;
  const party = P => P.page.evaluate(() => window.__party?.snapshot?.() ?? null).catch(() => null);
  const clickGame = async P => { const b = await P.page.locator('#game').boundingBox(); await P.page.mouse.click(b.x + b.width / 2, b.y + b.height / 2); };
  const shot = async (P, name) => { const f = `watch-${name}.png`; await P.page.screenshot({ path: join(out, f) }).catch(() => {}); shots.push(f); };
  try {
    const H = await open('host'), J = await open('joiner');
    await H.page.goto(`${srv.partyUrl}?max=600`, { waitUntil: 'load' });
    await until(async () => (await party(H))?.phase === 'home', 30000, 'the Host / Join screen');
    await H.page.fill('#gfp-name', 'Hosta'); await H.page.click('#gfp-host');
    await until(async () => { const s = await party(H); return s?.phase === 'room' && s.code ? s : null; }, 30000, 'the room');
    await J.page.goto(await H.page.inputValue('#mp-invite'), { waitUntil: 'load' });
    await until(async () => (await party(J))?.phase === 'home', 30000, "the joiner's Host / Join screen");
    await J.page.fill('#gfp-name', 'Jules'); await J.page.click('#gfp-join');
    await until(async () => (await party(H))?.racers?.length === 2 && (await party(J))?.phase === 'room', 30000, 'both in the room');
    await sleep(500);
    await H.page.click('#mp-start');
    await until(async () => (await game(H))?.net?.started && (await game(J))?.net?.started, 120000, 'both games to start');
    await sleep(1500);
    const jid = (await game(J)).net.you;
    // ---- J goes live from the game's own pause menu ----
    await clickGame(J); await sleep(200);
    await J.page.keyboard.press('Escape'); await sleep(500);
    const offered = await frameOf(J).evaluate(() => !!document.querySelector('#gf-live')).catch(() => false);
    step('the pause menu offers Go live in a round with friends', offered, offered ? '#gf-live in the kit\'s pause menu over the Godot canvas' : 'no #gf-live');
    if (offered) await frameOf(J).click('#gf-live');
    const live = await until(async () => { const x = (await party(J))?.live; return x?.state === 'on' ? x : null; }, 10000, 'J live').catch(() => null);
    const hBadge = await until(async () => H.page.evaluate(() => document.querySelector('#mp-live:not([hidden])')?.textContent ?? null), 8000, 'LIVE on H').catch(() => null);
    step('Go live: LIVE for everyone in the room', !!live && /LIVE/.test(hBadge ?? '') && /Jules/.test(hBadge ?? ''), `link ${live?.link ?? 'none'}; H sees "${hBadge}"`);
    await shot(J, 'streamer-live');
    await J.page.click('#mp-live-close').catch(() => {});
    if (!live) return;
    // ---- V watches J ----
    const V = await open('viewer');
    await V.page.goto(live.link, { waitUntil: 'load' });
    const keyed = await until(async () => { const w = (await party(V))?.watch; return w?.keyed ? w : null; }, 60000, 'V tuned in').catch(() => null);
    step('a viewer tunes in: this round\'s game page, the streamer followed', !!keyed && keyed.follow?.id === jid, keyed ? `following ${keyed.follow?.name} (${keyed.follow?.id}); ${keyed.roster} in the stream` : JSON.stringify((await party(V))?.watch));
    const voice = await voiceSteps({ streamer: J.page, streamerGame: frameOf(J), viewer: V.page, step: (n, ok, d) => step(`voice: ${n}`, ok, d) });
    if (voice.skipped) { rec.watchNotes = [voice.skipped]; log(`watch: ${voice.skipped}`); }
    // J runs right; V draws J where J is
    await clickGame(J); await sleep(300);
    const j0 = (await game(J))?.godot?.me;
    await J.page.keyboard.down('KeyD'); await sleep(1200); await J.page.keyboard.up('KeyD'); await sleep(1500);
    const jMe = (await game(J))?.godot?.me;
    const moved = j0 && jMe ? dist(jMe, j0) : 0;
    const seen = await until(async () => { const g = await game(V); const p = g?.players?.find(x => x.id === jid); return p && jMe && dist(p, jMe) < 0.5 ? g : null; }, 6000, 'J on V').catch(() => null);
    const gv = seen ?? await game(V);
    step('the viewer draws the streamer where they really are (after a run)', !!seen && moved >= 1, `J ran ${moved.toFixed(2)} m to ${jMe?.x}, ${jMe?.y}, ${jMe?.z ?? 0}; V draws ${JSON.stringify((gv?.players ?? []).map(p => [p.name, p.x, p.y, p.z]))}`);
    step('the viewer has no player of its own, and its game follows the streamer', !(gv?.players ?? []).some(p => p.local) && gv?.watch?.target === jid && (gv?.players ?? []).length === 2, `players ${JSON.stringify((gv?.players ?? []).map(p => p.name))}; the game follows ${gv?.watch?.target}`);
    const [cj, cv] = [await cam(J), await cam(V)];
    const gap = cj && cv ? Math.hypot(cj.eye[0] - cv.eye[0], cj.eye[1] - cv.eye[1], (cj.eye[2] ?? 0) - (cv.eye[2] ?? 0)) : 999;
    step('the viewer sees what the streamer sees', cj?.mode === cv?.mode && gap < 1.5, `${cj?.mode} cameras ${gap.toFixed(2)} m apart (J at ${cj?.eye?.slice(0, 2)}, V at ${cv?.eye?.slice(0, 2)})`);
    const vHud = await frameOf(V).evaluate(() => { const shown = s => { const e = document.querySelector(s); return !!e && getComputedStyle(e).display !== 'none' && e.getBoundingClientRect().width > 0; }; return { timer: shown('.gf-timer'), scores: shown('.gf-scores'), card: shown('#gf-hud'), menu: shown('#gf-menu-button') }; }).catch(() => null);
    step('the viewer sees the round\'s clock and scores, not a player\'s own card or menu', !!vHud && vHud.timer && vHud.scores && !vHud.card && !vHud.menu, JSON.stringify(vHud));
    const tags = await frameOf(V).evaluate(() => {
      const s = window.__game.snapshot(), out = [];
      for (const e of document.querySelectorAll('.gf-godot-tag')) {
        if (e.style.display === 'none') continue;
        const p = s.players.find(x => x.name === e.textContent); if (!p) continue;
        const r = e.getBoundingClientRect(), at = window.__game.project(p.x, p.y + 1.7, p.z ?? 0);
        out.push({ name: p.name, dx: Math.round(r.left + r.width / 2 - at.x), dy: Math.round(r.bottom - at.y) });
      }
      return out;
    }).catch(() => []);
    step('a viewer\'s name tags sit over the characters', tags.some(t => t.name === 'Jules') && tags.every(t => Math.abs(t.dx) <= 40 && Math.abs(t.dy) <= 60), JSON.stringify(tags));
    const count = await until(async () => { const x = await J.page.evaluate(() => document.querySelector('#mp-live')?.textContent ?? ''); return /1 watching/.test(x) ? x : null; }, 6000, 'the count').catch(() => null);
    step('the streamer sees how many watch', !!count, count ?? 'no count');
    await shot(V, 'viewer'); await shot(J, 'streamer');
    step('no page error or console error on any screen', errors.length === 0, errors.slice(0, 4).join(' | ') || 'none');
  } catch (e) {
    step('ran', false, e.stack?.split('\n').slice(0, 3).join(' ') ?? String(e));
  } finally {
    rec.watch = steps;
    await browser.close().catch(() => {});
  }
}

/**
 * Phone (emulated in Chrome), held upright (390x844) and sideways (844x390): the menu fits, a tap plays, the move stick
 * is in sight before any touch and moves the player, the buttons are the game's own actions and no others, Jump jumps
 * (when the game has it), and every HUD box and touch control is on the screen with none over another.
 */
async function phoneLeg({ browser, srv, out, check, shots, rec, game, until }) {
  rec.phone = { emulated: 'Chrome (Playwright) at 390x844 and 844x390 CSS px, device scale 3, isMobile, hasTouch, an Android user agent: no real phone', layouts: {} };
  for (const [W, H, tag] of [[390, 844, ''], [844, 390, '-landscape']]) {
    const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Mobile Safari/537.36' });
    const page = await ctx.newPage(), errs = [];
    page.on('pageerror', e => errs.push(`pageerror: ${e.message}`));
    page.on('console', m => { if (m.type() === 'error') errs.push(m.text().slice(0, 200)); });
    const shot = async name => { const f = `${name}.png`; await page.screenshot({ path: join(out, f) }); shots.push(f); };
    const size = `${W}x${H}`;
    try {
      await page.goto(srv.url, { waitUntil: 'load' });
      await until(async () => (await page.evaluate(() => window.__game?.ready && window.__game.phase === 'lobby')), 90000, `phone ${size}: the menu`);
      await sleep(500);
      await shot(`phone${tag}-home`);
      const fit = await page.evaluate(() => { const b = document.querySelector('#gf-play')?.getBoundingClientRect(); return { sw: document.documentElement.scrollWidth, w: innerWidth, h: innerHeight, play: b ? [b.left, b.top, b.right, b.bottom].map(Math.round) : null, buffer: [document.querySelector('#gf-canvas')?.width, document.querySelector('#gf-canvas')?.height] }; });
      check('B', `phone-menu-fits${tag}`, fit.sw <= fit.w && fit.play && fit.play[0] >= 0 && fit.play[2] <= fit.w && fit.play[1] >= 0 && fit.play[3] <= fit.h, `${size} at 3x (emulated): page ${fit.sw} px wide; Play at ${JSON.stringify(fit.play)}; Godot's canvas ${fit.buffer.join('x')} device px`);
      const pb = await page.locator('#gf-play').boundingBox();
      await page.touchscreen.tap(pb.x + pb.width / 2, pb.y + pb.height / 2);
      await until(async () => (await game(page))?.phase === 'playing', 15000, `phone ${size}: the round`);
      await sleep(900);
      const a = await game(page);
      // what is on the screen before any finger moves: the HUD and the touch controls, as drawn
      const drawn = await page.evaluate(boxes => {
        const out = [];
        for (const [name, sel] of boxes) for (const el of document.querySelectorAll(sel)) {
          const cs = getComputedStyle(el), r = el.getBoundingClientRect();
          if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) < 0.05 || r.width < 2 || r.height < 2) continue;
          out.push({ name, r: [r.left, r.top, r.right, r.bottom].map(Math.round) });
        }
        return { boxes: out, controls: window.__game.controls().controls ?? {}, buttons: [...document.querySelectorAll('#gf-ui .gf-touch.on button[data-action]')].map(b => b.dataset.action) };
      }, PHONE_BOXES);
      const placed = phoneFit(drawn.boxes, W, H);
      rec.phone.layouts[size] = drawn.boxes;
      check('B', `phone-hud-fits${tag}`, drawn.boxes.length > 0 && !placed.off.length && !placed.overlaps.length, `${size}: ${drawn.boxes.map(b => b.name).join(', ')}; off the screen: ${placed.off.join(', ') || 'none'}; overlapping: ${placed.overlaps.map(p => p.join(' / ')).join(', ') || 'none'}`);
      const want = touchActions(drawn.controls), stickShown = drawn.boxes.some(b => b.name === 'move stick');
      const same = want.length === drawn.buttons.length && want.every(x => drawn.buttons.includes(x));
      check('C', `phone-controls-match${tag}`, stickShown && same, `${size}: the move stick ${stickShown ? 'is in sight before a touch' : 'is NOT in sight'}; buttons ${JSON.stringify(drawn.buttons)}, the game's actions ${JSON.stringify(want)} (controls ${JSON.stringify(Object.keys(drawn.controls))})`);
      await shot(`phone${tag}-playing`);
      // the stick: a finger down on the left half, over the resting ring, dragged right and held
      const cdp = await ctx.newCDPSession(page);
      const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1 }] });
      const sx = 84, sy = H - 84;
      await touch('touchStart', sx, sy); await sleep(60);
      for (let i = 1; i <= 6; i++) { await touch('touchMove', sx + i * 10, sy); await sleep(30); }
      await sleep(900);
      await touch('touchEnd', sx + 60, sy); await sleep(300);
      const b = await game(page);
      const is3d = a.profile === '3d';
      check('C', `phone-stick-moves${tag}`, b.godot.me.x - a.godot.me.x > 1, `${size}: the stick held right for 0.9 s moved the player ${r2(b.godot.me.x - a.godot.me.x)} m`);
      if (want.includes('jump')) {
        const jb = await page.locator('#gf-ui .gf-touch button[data-action="jump"]').boundingBox();
        let high = b.godot.me.y;
        await touch('touchStart', jb.x + jb.width / 2, jb.y + jb.height / 2);
        for (let i = 0; i < 8; i++) { await sleep(60); high = Math.max(high, (await game(page)).godot.me.y); }
        await touch('touchEnd', 0, 0);
        check('C', `phone-jump-button-jumps${tag}`, high - b.godot.me.y > (is3d ? 0.6 : 1), `${size}: the Jump button lifted the player ${r2(high - b.godot.me.y)} m`);
      }
      check('B', `no-console-errors-phone${tag}`, errs.length === 0, errs.slice(0, 3).join(' | ') || 'none');
    } catch (e) {
      check('B', `phone-ran${tag}`, false, `${size}: ${e.message}`);
    } finally { await ctx.close(); }
  }
}

/** Firefox and WebKit (Playwright's own builds, headless, software or the system's GL): the game boots and plays. */
async function browsersLeg({ srv, out, check, shots, rec }) {
  const { firefox, webkit } = await import('playwright-core');
  rec.browsers = {};
  for (const [name, type] of [['firefox', firefox], ['webkit', webkit]]) {
    let b = null;
    try { b = await type.launch({ headless: true }); }
    catch (e) {
      // a browser this machine cannot start (a missing system library) is this machine's gap, not the game's: recorded
      // as not run, with why, never as passed
      const why = e.message.replace(/[╔╗╚╝║═<3]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 240);
      rec.browsers[name] = { launched: false, why }; (rec.notRun ??= []).push(`${name}: did not launch on this machine (${why})`); continue;
    }
    const page = await (await b.newContext({ viewport: { width: 1280, height: 720 } })).newPage(), errs = [];
    page.on('pageerror', e => errs.push(`pageerror: ${e.message}`));
    page.on('console', m => { if (m.type() === 'error') errs.push(m.text().slice(0, 200)); });
    try {
      await page.goto(srv.url, { waitUntil: 'load' });
      const t0 = Date.now();
      const ready = await until(async () => (await page.evaluate(() => (window.__game?.ready && window.__game.phase === 'lobby') || window.__game?.phase === 'unsupported' ? window.__game.phase : null)), 120000, `${name}: the menu`).catch(() => null);
      const info = await page.evaluate(() => ({ phase: window.__game?.phase ?? null, ua: navigator.userAgent, gl: (() => { const c = document.createElement('canvas').getContext('webgl2'); if (!c) return null; const d = c.getExtension('WEBGL_debug_renderer_info'); return d ? c.getParameter(d.UNMASKED_RENDERER_WEBGL) : c.getParameter(c.RENDERER); })() }));
      rec.browsers[name] = { launched: true, version: b.version(), ...info, bootMs: Date.now() - t0 };
      if (ready !== 'lobby') { check('B', `${name}-boots`, false, `${name} ${b.version()}: phase ${info.phase} (WebGL2 renderer: ${info.gl ?? 'none'})`); continue; }
      await page.click('#gf-play');
      await until(async () => (await page.evaluate(() => window.__game.phase)) === 'playing', 20000, `${name}: the round`);
      await sleep(600);
      const a = await page.evaluate(() => window.__game.snapshot().godot.me);
      await page.keyboard.down('KeyD'); await sleep(900); await page.keyboard.up('KeyD');
      const c = await page.evaluate(() => window.__game.snapshot().godot.me);
      const f = `browser-${name}.png`; await page.screenshot({ path: join(out, f) }); shots.push(f);
      check('B', `${name}-boots`, true, `${name} ${b.version()} (headless, Playwright's build; WebGL2 renderer: ${info.gl ?? 'none'}): the menu in ${rec.browsers[name].bootMs} ms`);
      check('C', `${name}-D-runs-right`, c.x - a.x > 1, `${name}: holding D for 0.9 s moved the player ${r2(c.x - a.x)} m`);
      check('B', `no-console-errors-${name}`, errs.length === 0, errs.slice(0, 3).join(' | ') || 'none');
    } catch (e) {
      check('B', `${name}-boots`, false, e.message);
    } finally { await b.close().catch(() => {}); }
  }
}
