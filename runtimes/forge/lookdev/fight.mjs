#!/usr/bin/env node
// gf-forge lookdev: a fight's frames out of a real forge game, each held on its exact frame (track L1, wave 2).
//
//   node runtimes/forge/lookdev/fight.mjs <game> --out <dir> [--port 5824] [--size 1280x720] [--pieces 400]
//
// The game is played alone through its own menu with its test hooks on (?room=1: runtimes/forge/specs/room.rules.js
// gives window.__room, __crowd and __heal; their panel is hidden). What it keeps, as PNGs with what the renderer says
// it drew on that frame (window.__game.forge.drawn(): kit/render.js STATS and STATS_MORE):
//
//   first look      the round's first frame after the wave rises
//   fight           eight or more enemies up and coming
//   shot f0..f3     a shot's frames from the one its muzzle flash shows on: the flash, the tracer, the muzzle light
//   pellets f0..f2  the same for the scattergun (a fan of pellet streaks)
//   hit f0..f3      the frames from the one an enemy's white flash starts on (2–3 frames flat white, the impact light)
//   kill f0..f8     the frames from the one a kill's pieces appear on (the burst into bones, dust and sparks)
//   pieces          N loose pieces at rest (--pieces, default 400: kit/render.js `pieces`, QA), and the frame cost
//                   with and without them
//
// A frame is held by wrapping requestAnimationFrame before the game loads: when the watched count (muzzle flashes
// shown, hit flashes started, rigid models drawn) goes up, the loop is let run k more frames and then not called
// again until the screenshot is taken. Each kept frame is from its own shot (holding the loop skips time).
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lumaOf, sheetOf } from './measure.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../../..');
const { launchChrome } = await import(join(REPO, 'builder/qa/browser.mjs'));
const { startParty } = await import(join(REPO, 'builder/multiplayer/party/lib.mjs'));
const sleep = ms => new Promise(r => setTimeout(r, ms));

const a = process.argv.slice(2);
const opt = (k, d = null) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : d; };
const dir = a.find((x, i) => !x.startsWith('--') && !['--out', '--port', '--size', '--pieces'].includes(a[i - 1]));
if (!dir || !opt('--out')) { console.error('usage: fight.mjs <game> --out <dir> [--port 5824] [--size 1280x720] [--pieces 400]'); process.exit(2); }
const out = resolve(opt('--out'));
const [W, H] = opt('--size', '1280x720').split('x').map(Number);
const NPIECES = Number(opt('--pieces', 400));
mkdirSync(out, { recursive: true });

// the frame holder (before the game's own scripts)
const HOLDER = () => {
  const raf = window.requestAnimationFrame.bind(window);
  const h = (window.__hold = { left: -1, queue: [], watch: null, base: 0, after: 0, held: false, cost: [], at: [] });
  const drawn = () => { try { return window.__game?.forge?.drawn?.() ?? null; } catch { return null; } };
  window.requestAnimationFrame = cb => raf(t => {
    if (h.left === 0) { h.queue.push(cb); h.held = true; return; }
    const s = performance.now();
    cb(t);
    h.cost.push(performance.now() - s); h.at.push(s); if (h.at.length > 3000) { h.cost.splice(0, 1500); h.at.splice(0, 1500); }
    if (h.left > 0) h.left--;
    else if (h.watch) { const d = drawn(); const v = d ? (typeof h.watch === 'function' ? h.watch(d) : d[h.watch]) : 0; if (v > h.base) { h.left = h.after; h.watch = null; } }
  });
  /** Hold the loop `after` frames after `key` of drawn() goes over what it is now (0: on that very frame). */
  window.__holdOn = (key, after, over = 0) => { const d = drawn(); h.base = (d ? d[key] : 0) + over; h.after = after; h.watch = key; h.left = -1; h.held = false; };
  window.__release = () => { h.left = -1; h.watch = null; h.held = false; const q = h.queue.splice(0); for (const cb of q) window.requestAnimationFrame(cb); };
};

const srv = await startParty({ dir: resolve(dir), port: Number(opt('--port', 0)) });
const browser = await launchChrome({ gpu: 'webgpu' });
const rec = { tool: 'runtimes/forge/lookdev/fight.mjs', game: dir, chrome: browser.version(), size: [W, H], frames: [], steps: {}, errors: [] };
const rows = [];
try {
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  page.on('pageerror', e => rec.errors.push(e.message)); page.on('console', m => { if (m.type() === 'error') rec.errors.push(m.text().slice(0, 300)); });
  await page.addInitScript(HOLDER);
  const ev = (fn, arg) => page.evaluate(fn, arg);
  const until = async (fn, ms, what) => { const t0 = Date.now(); for (;;) { const v = await page.evaluate(fn).catch(() => null); if (v) return v; if (Date.now() - t0 > ms) throw new Error(`timed out: ${what}`); await sleep(80); } };
  await page.goto(`${srv.url}?seed=7&room=1`, { waitUntil: 'load' });
  await until(() => window.__game?.menu?.()?.view === 'home', 60000, 'the home menu');
  await page.addStyleTag({ content: '#gf-room{display:none!important}' });
  await page.click('#gf-play');
  await until(() => window.__game?.phase === 'playing', 20000, 'the round');
  await page.mouse.click(W / 2, H / 2);
  const keep = async (name, extra = {}) => {
    const png = await page.screenshot({ type: 'png' });
    const file = join(out, `${String(rec.frames.length + 1).padStart(2, '0')}-${name}.png`);
    writeFileSync(file, png);
    const d = await ev(() => window.__game.forge.drawn());
    const luma = await lumaOf(page, png);
    const row = { name, file: file.slice(out.length + 1), luma: { mean: luma.mean, median: luma.median, p99: luma.p99, over200: luma.over200 }, drawn: { draws: d.draws, actors: d.actors, rigid: d.rigid, pieces: d.pieces, particles: d.particles, lights: d.lights, flashes: d.flashes, fpMuzzle: d.fpMuzzle, flashing: d.flashing, tracersDrawn: d.tracersDrawn, tracers: d.tracers, culled: d.culled, casters: d.casters, fireFaces: d.fireFaces }, ...extra };
    rec.frames.push(row);
    rows.push({ file, caption: `${name} · luma ${luma.mean}/${luma.median}/${luma.p99} · ${d.tracersDrawn} tracers ${d.flashes} flash lights ${d.flashing} flashing ${d.rigid} rigid` });
    console.log(`${name}: luma ${luma.mean}/${luma.median}/${luma.p99} · tracers drawn ${d.tracersDrawn} (begun ${d.tracers}) · flash lights ${d.flashes} · bodies flashing ${d.flashing} · muzzle shown ${d.fpMuzzle} · rigid ${d.rigid} · ${d.draws} draws`);
    return row;
  };
  const heal = () => ev(() => window.__heal?.());
  const enemies = () => ev(() => window.__game.forge.enemies().filter(e => !e.dead));
  const me = () => ev(() => { const c = window.__game.camera(); return c.eye; });
  const nearest = async () => { const [e, es] = [await me(), await enemies()]; return es.map(x => ({ ...x, d: Math.hypot(x.at[0] - e[0], x.at[2] - e[2]) })).sort((p, q) => p.d - q.d)[0] ?? null; };
  const aim = async (height = 1.2) => { const t = await nearest(); if (t) await ev(([x, y, z]) => window.__game.forge.face(x, y, z), [t.at[0], t.at[1] + height, t.at[2]]); return t; };
  // the weapon of a table row in hand (forge-feel's EQUIP: the player's core id, the row)
  const equip = async id => { await ev(id => { const c = window.__room, row = c.tables.weapons.findIndex(w => w.id === id), p = c.players.list().find(p => p.local); c.forge.cmd.raw(67, [c.players.nid(p.id), row]); }, id); await sleep(650); };
  // where the round put the player and which way they looked (the open middle of the arena is ahead of that)
  const home = await ev(() => { const c = window.__room, p = c.players.list().find(p => p.local), id = c.players.nid(p.id), v = c.forge.players().find(x => x.id === id), cam = c.forge.drawnCamera(); return { id, x: v.x, y: v.y, z: v.z, yaw: cam.yaw }; });
  rec.steps.home = home;
  // the stage: every enemy gone, the player back where the round put them, then these types stood `dist` metres
  // ahead (an arc when several)
  const stage = async (types, { dist = 6, arc = 0, emerge = false } = {}) => {
    // (and nothing lying or flying from the stage before: forge-feel's CLEAR)
    await ev(() => { window.__room.ai.clear(); window.__room.forge.cmd.raw(73, [], []); });
    await ev(h => window.__room.forge.cmd.teleport(h.id, { x: h.x, y: h.y, z: h.z }, h.yaw, 0), home);
    await sleep(150);
    await ev(([types, dist, arc, emerge, h]) => {
      const c = window.__room, fx = -Math.sin(h.yaw), fz = -Math.cos(h.yaw);
      types.forEach((t, i) => {
        const a = types.length > 1 ? (i / (types.length - 1) - 0.5) * arc : 0, d = dist + (i % 3) * 1.3;
        const dx = fx * Math.cos(a) - fz * Math.sin(a), dz = fx * Math.sin(a) + fz * Math.cos(a);
        c.ai.spawn(t, { at: [h.x + dx * d, 0.05, h.z + dz * d], emerge });
      });
    }, [types, dist, arc, emerge, home]);
    await until(() => window.__game.forge.enemies().filter(e => !e.dead).length > 0, 4000, 'the staged enemies');
  };
  /** One press with the loop held `k` frames after `watch` goes up; → the kept row, or null when it never did. */
  const held = async (name, watch, k, { over = 0, press = 70, wait = 2500, height = 1.2, before = null } = {}) => {
    await heal();
    const t = await aim(height);
    if (before) await before(t);
    await sleep(350);
    await aim(height);
    await sleep(60);
    await ev(([w, k, over]) => window.__holdOn(w, k, over), [watch, k, over]);
    // (the F key fires: under the emulated pointer lock a synthetic mouse press arrives with a stray look jump)
    await page.keyboard.down('KeyF'); await sleep(press); await page.keyboard.up('KeyF');
    const t0 = Date.now();
    let ok = false;
    while (Date.now() - t0 < wait) { if (await ev(() => window.__hold.held)) { ok = true; break; } await sleep(15); }
    const row = ok ? await keep(name, { target: t ? { type: t.type, distance: Math.round(t.d * 10) / 10 } : null }) : null;
    await ev(() => window.__release());
    await sleep(500);
    return row;
  };

  // ---- the first look: the round's own first wave rising ----
  await until(() => (window.__game.forge.enemies()?.length ?? 0) >= 3, 20000, 'the first wave');
  await sleep(700);
  await aim(); await heal();
  await sleep(1500);
  await keep('first-look');
  // ---- a fight: the director stopped, nine of the game's own enemies staged ahead and coming ----
  await ev(() => window.__room.ai.director.stop());
  await sleep(400); await heal();
  const types = await ev(() => window.__room.tables.enemies.map(e => e.id));
  const crowd = [0, 1, 0, 2, 0, 3, 1, 0, 4].map(i => types[i % types.length]).filter(t => t !== 'lord');
  await stage(crowd, { dist: 6, arc: 1.5, emerge: true });
  await sleep(1500); await heal();
  await sleep(500);
  rec.steps.fight = { enemies: (await enemies()).length };
  await keep(`fight-${rec.steps.fight.enemies}-enemies`);

  // ---- a shot: the sidearm's flash, light and the streak behind its round, frame by frame ----
  await equip('sidearm');
  for (let k = 0; k < 4; k++) { await stage([types[0]]); await held(`shot-f${k}`, 'muzzleFlashes', k); }
  // ---- the scattergun's pellets ----
  await equip('scatter');
  for (let k = 0; k < 3; k++) { await stage([types[0]]); await held(`pellets-f${k}`, 'muzzleFlashes', k); }
  // ---- the repeater held ----
  await equip('repeater');
  for (let k = 0; k < 2; k++) { await stage([types[0]]); await held(`repeater-f${k}`, 'muzzleFlashes', k, { press: 260 }); }
  // ---- a hit that does not kill: the frames from the one the body's white flash starts on ----
  await equip('sidearm');
  for (let k = 0; k < 4; k++) { await stage([types[0]], { dist: 5.5 }); await held(`hit-f${k}`, 'hitFlashes', k, { height: 1.0 }); }
  // ---- a kill: the enemy worn down first, then the frames from the one its pieces appear on ----
  for (const k of [0, 1, 2, 4, 8]) {
    let row = null;
    for (let tries = 0; tries < 3 && !row; tries++) {
      await stage([types[0]], { dist: 5.5 });
      row = await held(`kill-f${k}`, 'rigid', k, { over: 20, height: 1.3, before: async t => { if (t) await ev(net => { const e = window.__game.forge.enemies().find(e => e.net === net); const c = window.__room; const row = c.tables.enemies.find(r => r.id === e?.type) ?? c.tables.enemies[0]; c.forge.cmd.damage(net, Math.max(1, (Number(row.health) || 60) - 8), 0, [0, 0, -1]); }, t.net); } });
      await ev(() => window.__room.forge.cmd.raw(73, [], []));
    }
    if (!row) rec.errors.push(`no kill held at f${k}`);
  }
  rec.steps.counts = await ev(() => { const d = window.__game.forge.drawn(); return { muzzleFlashes: d.muzzleFlashes, hitFlashes: d.hitFlashes, tracers: d.tracers }; });
  await ev(() => window.__room.ai.clear());

  // ---- N loose pieces at rest: the picture, and what a frame costs with and without them ----
  const cost = async ms => { await ev(() => { window.__hold.cost.length = 0; window.__hold.at.length = 0; }); await sleep(ms); return ev(() => { const h = window.__hold, s = [...h.cost].sort((x, y) => x - y), q = p => s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? 0, n = h.at.length; return { frames: n, fps: n > 1 ? Math.round(((n - 1) / ((h.at[n - 1] - h.at[0]) / 1000)) * 10) / 10 : 0, loopMs: { median: Math.round(q(0.5) * 100) / 100, p95: Math.round(q(0.95) * 100) / 100 } }; }); };
  if (NPIECES > 0) {
    // nobody up and nothing lying, so the two costs differ by the pieces alone
    await ev(() => window.__room.forge.cmd.raw(73, [], []));
    await sleep(800); await heal();
    const eye = await me();
    const before = { ...(await cost(3000)), drawn: await ev(() => { const d = window.__game.forge.drawn(); return { draws: d.draws, rigid: d.rigid, instances: d.instances, casters: d.casters }; }) };
    const lying = await ev(([n, x, z]) => window.__room.render.pieces(n, { at: [x, z], radius: 9 }), [NPIECES, eye[0], eye[2] - 6]);
    await ev(([x, z]) => window.__game.forge.face(x, 0.2, z), [eye[0], eye[2] - 6]);
    await sleep(500);
    const after = { ...(await cost(3000)), drawn: await ev(() => { const d = window.__game.forge.drawn(); return { draws: d.draws, rigid: d.rigid, pieces: d.pieces, instances: d.instances, casters: d.casters, culled: d.culled }; }) };
    rec.steps.pieces = { asked: NPIECES, lying, before, after };
    await keep(`pieces-${lying}-at-rest`);
    console.log(`pieces: ${lying} lying · before ${before.fps} fps, loop ${before.loopMs.median} ms (p95 ${before.loopMs.p95}), ${before.drawn.draws} draws · after ${after.fps} fps, loop ${after.loopMs.median} ms (p95 ${after.loopMs.p95}), ${after.drawn.draws} draws, ${after.drawn.pieces} pieces given, ${after.drawn.casters} casters`);
  }
  await sheetOf(browser, rows, `${dir.split('/').slice(-2).join('/')} · a fight's frames · ${rec.chrome} · WebGPU · ${W}×${H}`, join(out, 'sheet-fight.jpg'), 4);
  await ctx.close();
} catch (e) { rec.errors.push(String(e?.stack ?? e)); console.error(e); }
finally { await browser.close(); await srv.close(); }
rec.ok = rec.errors.length === 0;
writeFileSync(join(out, 'fight.json'), JSON.stringify(rec, null, 2) + '\n');
console.log(`fight: ${rec.ok ? 'ok' : `${rec.errors.length} problems: ${rec.errors.slice(0, 3).join(' | ')}`} · ${rec.frames.length} frames → ${out}`);
process.exitCode = rec.ok ? 0 : 1;
