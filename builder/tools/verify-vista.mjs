// gf-three verify for a vista game (CONTRACT §8 vista; research/super-scenic/PLAN.md §3, THIN_E2E.md): tools/verify.mjs
// hands a game whose runtime is vista to verifyVista, as it hands a forge game to verify-forge.mjs. Every check that
// applies today runs, in WebGPU Chrome (the vista core draws only with WebGPU), through the names the vista boot gives
// window.__game (snapshot, menu, hud, looks, camera, screen, vista.*). A check that does not apply yet is recorded as
// "not yet for vista" with its reason (ok: null, `notYet`), printed so, and never counted as passed. The pass rule is
// passesVista (tools/lib/verdict.mjs: REQUIRED_VISTA, NOT_YET_VISTA).
//
//   1  manifests                      2  kit copies (gf/three, gf/vista with the core and its public files, gf/mp, audio)
//   3  boots to play with no console errors, and the player walks on real keys (the core's walker)
//   5  the two-player live gate (the shared gate: each sees the other, where they really are, one shared world) and
//      vista's sight leg (tools/lib/vista-sight-check.mjs: gf-humanoid-1 bodies, each on the other's screen at the start
//      place, the core's own pixels of the friend, drawn within 0.5 m of where they are after a walk on real keys). The
//      gate's random-input on-screen samples are soft; when they miss, the sight leg is what proves them
//   6  a session reaches results and replays: alone (Studio's override cuts the clock to 25 s; Play again) and with two
//      players (the gate's results, play again and the host's end)
//   14 looks honoured · 18 sounds play (static, the shared checks)
//   17 the world is complete (vista's leg, gate F): the game is on its own islands, as many as its spec lists. Every
//      island config/world.json lists is the spec's (world.islands, or one island of the game's own: kit/config.js
//      specIslands), the core built island 1's place (its key, never the reference island's), and each other island is
//      reached and built in turn (window.__game.vista.hop, a joiner's way: no sail-out), filmed on arrival
//   20 the menu (the shared DOM check) · 21 the HUD (the shared DOM check: the player card, the menu button, the goal)
//   23 looks like its target (the shared judge; no references: passes as "no references")
//   25 playing with friends (the shared friends-page check: names, colours, no bots, each one's own score)
//   32 no WebGPU: a Chrome without WebGPU shows the kit's screen with the game's link, never a blank canvas (vista's own)
//   36 the sea is drawn and moving: a band of open sea under the horizon, read back from the screen twice, is not flat and
//      changes between the two while nothing else moves (vista's own)
//   37 the look is the config's: the core's look state is config/look.json's values, and a value Studio changes
//      (config/look.json /hour through the overrides) reaches the core and changes the sky (vista's own)
//   not yet for vista: NOT_YET_VISTA (each with its reason)
import { checkPlay } from './lib/play-check.mjs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { launchForGame, relPosix, VISTA_KIT } from './lib/paths.mjs';
import { checkKitCopies, kitEditsOverlay } from './lib/kit-check.mjs';
import { validateGame } from '../asset-manifest/validate.mjs';
import { readManifest, validateMultiplayer, startParty } from '../multiplayer/party/lib.mjs';
import { gate } from '../multiplayer/party/gate.mjs';
import { launchChrome, GPU_TROUBLE } from '../qa/browser.mjs';
import { checkMenu, checkHud } from './lib/menu-check.mjs';
import { checkFriends } from './lib/friends-check.mjs';
import { checkFriendsWatch } from './lib/friends-watch-check.mjs';
import { checkVistaSight } from './lib/vista-sight-check.mjs';
import { lockFor, turnBy } from './lib/lock.mjs';
import { stampVerdict, runsHere, NOT_YET_VISTA, writeVerdict } from './lib/verdict.mjs';
import { checkEvents } from './lib/events-check.mjs';
import { judgeScores } from './lib/score-events.mjs';
import { checkGameTests } from './lib/game-tests.mjs';
import { existsSync } from 'node:fs';
import { installAudioTap } from '../audio-gates/qa-gate-v5.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms, what) { const t0 = Date.now(); for (;;) { const v = await fn().catch(() => null); if (v) return v; if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`); await sleep(150); } }
const snap = p => p.evaluate(() => window.__game?.snapshot?.() ?? null);
// the core's own warnings that are not the game's (a terrain with no baked shore field falls back to sampling it)
const CORE_NOTES = /ShoreWaves\.buildDirTexture: no shore field data/;

const STATIC = [check1, check2, check14, check18, check35];
const SOLO = [soloRound, check4, check13, check15, check38, check35, check31, check36, check37, check17, check20, check21];
const AFTER = [check12, check23];

export async function verifyVista(dir, { rec, outDir, add, log, t0, lap, quick = false, only = null, release = false, statics }) {
  rec.notYet = [];
  const checks = rec.checks;
  const want = n => (only === null ? runsHere(n, { release, kind: 'vista' }) : [].concat(only).includes(n));
  const env = {
    dir, rec, outDir, add, log, lap, quick, want, statics, checks,
    notYet: (n, name, why) => { if (!want(n)) return; checks.push({ n, name, ok: null, notYet: why, detail: `not yet for vista: ${why}` }); rec.notYet.push({ n, name, why }); log(`NOT YET FOR VISTA ${n} ${name} — ${why}`); },
    game: JSON.parse(await readFile(join(dir, 'config/game.json'), 'utf8')),
    look: JSON.parse(await readFile(join(dir, 'config/look.json'), 'utf8').catch(() => '{}')),
    mpm: await readManifest(dir),
    shotsForLikeness: [], t: Date.now(),
    // every page's event log (window.__game.events(): the kit's log with the game's events as part `vista`), for 12
    eventLogs: [], coverage: [],
    ownTests: existsSync(join(dir, 'tests')) && (await (await import('node:fs/promises')).readdir(join(dir, 'tests'))).some(n => n.endsWith('.test.json')),
  };
  env.section = async (nums, fn) => { try { await fn(); } catch (e) { for (const [n, name] of nums) if (want(n) && !checks.some(c => c.n === n)) add(n, name, false, `not reached: ${e.message}`); } };
  env.lapNow = name => { lap(name, env.t); env.t = Date.now(); };

  for (const c of STATIC) await c(env);
  for (const [n, [name, why]] of Object.entries(NOT_YET_VISTA)) env.notYet(Number(n), name, why);

  // 5, 6's two-player half and 25: their own servers and browsers, beside the solo session
  const live = env.mpm.manifest?.mode === 'live';
  const duo = live && [5, 6, 25, 34].some(want) ? runDuo(env) : null;

  const needsBrowser = [3, 4, 6, 12, 13, 15, 17, 20, 21, 23, 31, 36, 37, 38].some(want) || (want(35) && env.ownTests);
  if (needsBrowser || want(32)) env.srv = await startParty({ dir, port: 0, overlay: await kitEditsOverlay(dir) });
  env.shot = async (page, name) => { const f = `${String(rec.shots.length + 1).padStart(2, '0')}-${name}.jpg`; rec.shots.push(f); await page.screenshot({ path: join(outDir, f), type: 'jpeg', quality: 80 }).catch(() => {}); return f; };
  env.newPage = async (label, { overrides = null, audio = false, viewport = { width: 1280, height: 720 }, scale = 1, context = {}, b = env.browser, gpu = env.gpu } = {}) => {
    const ctx = await b.newContext({ viewport, deviceScaleFactor: scale, ...context });
    const page = await ctx.newPage();
    const errors = [];
    // the WebGPU Chrome reports a locked mouse's clicks as large moves: the lock is emulated (tools/lib/lock.mjs)
    await lockFor(page, gpu);
    page.on('pageerror', e => errors.push(`${label}: ${e.message}`));
    page.on('console', m => { if (m.type() === 'error' && !GPU_TROUBLE.test(m.text())) errors.push(`${label}: ${m.text().slice(0, 300)}`); });
    page.on('response', r => { if (r.status() >= 400) errors.push(`${label}: HTTP ${r.status()} ${r.url().replace(env.srv?.url ?? '', '')}`); });
    if (overrides) await page.addInitScript(o => { globalThis.__GF_ASSET_OVERRIDES = o; }, overrides);
    if (audio) await installAudioTap(page);
    return { ctx, page, errors };
  };
  if (needsBrowser) {
    const launched = await launchForGame(launchChrome, dir, { place: { runtime: 'vista' } });
    env.browser = launched.browser; env.gpu = launched.gpu;
    rec.chrome = env.browser.version(); rec.renderer = launched.gpu;
    try { for (const c of SOLO) await c(env); }
    finally { await env.browser.close().catch(() => {}); }
  }
  if (want(32)) await check32(env);
  if (env.srv) await env.srv.close().catch(() => {});
  for (const c of AFTER) await c(env);

  const d = duo ? await duo : null;
  // 6's play leg (gate D; tools/lib/play-check.mjs → builder/play/judge.mjs), once every other session has closed
  if (want(6)) { const t = Date.now(); env.play = await checkPlay(dir, { outDir }).catch(e => ({ ok: false, detail: `the play judge stopped: ${e.message}`, record: null, notes: [] })); lap?.('play', t); rec.play = env.play.record; if (env.play.notes?.length) rec.notes.push(...env.play.notes); }
  if (d) { check5(env, d); check6(env, d); check25(env, d); check34(env, d); }
  else if (!live) for (const [n, name] of [[5, 'two-player live gate'], [25, 'playing with friends'], [34, 'watch then play']]) if (want(n)) add(n, name, false, `multiplayer.json mode is ${env.mpm.manifest?.mode ?? 'missing'}, not live`);
  if (want(6) && !checks.some(c => c.n === 6)) check6(env, null);

  // the verdict by gate (tools/lib/verdict.mjs stampVerdict: the pass rule, each measure's gate, rec.gates)
  stampVerdict(rec, { kind: 'vista', release, list: only });
  rec.finished = new Date().toISOString(); rec.seconds = Math.round((Date.now() - t0) / 1000);
  rec.outDir = relPosix(dir, outDir);
  await writeVerdict(outDir, rec);
  return rec;
}

// =====================================================================================================================
// static checks

async function check1({ want, dir, mpm, add, rec }) {
  if (!want(1)) return;
  const v = await validateGame(dir);
  const mv = mpm.error ? { ok: false, problems: [`multiplayer.json is ${mpm.error}`] } : validateMultiplayer(mpm.manifest);
  const live = mpm.manifest?.mode === 'live';
  const gpu = (await readFile(join(dir, 'assets.json'), 'utf8').then(t => JSON.parse(t)).catch(() => ({}))).runtime?.gpu;
  add(1, 'manifests', v.ok && mv.ok && live && gpu === 'webgpu', [v.ok ? `assets.json valid (${v.stats?.slots ?? '?'} slots)` : `assets.json: ${v.errors.slice(0, 4).join('; ')}`, gpu === 'webgpu' ? 'runtime.gpu webgpu' : `runtime.gpu is ${gpu ?? 'missing'} (a vista game needs "webgpu": the gates and the worker's play-tests launch a WebGPU Chrome from it)`, mv.ok ? `multiplayer.json valid, mode ${mpm.manifest?.mode}` : `multiplayer.json: ${mv.problems.join('; ')}`].join(' · '));
  if (v.warnings?.length) rec.notes.push(`assets.json warnings: ${v.warnings.slice(0, 5).join('; ')}`);
}
async function check2({ want, dir, add, rec }) {
  if (!want(2)) return;
  const kc = await checkKitCopies(dir);
  const behind = kc.notes.filter(n => /have changed in research\/|not the current|the current kit is/.test(n));
  add(2, 'kit copies unedited', kc.ok, kc.ok
    ? `gf/three (the shared system without three.js), gf/vista (kit, HUD, the core with its public files, licence and attribution), gf/mp, audio and gf/gf-assets.js are the copies create made, unedited; no vendor/${behind.length ? `. Behind today's kit: ${behind.join('; ')}` : '; all are today\'s kit'}`
    : kc.problems.slice(0, 6).join('; '));
  rec.notes.push(...kc.notes);
}
async function check14({ want, statics }) { if (want(14)) await statics.looks(); }
async function check18({ want, statics }) { if (want(18)) await statics.check18(); }

// =====================================================================================================================
// the solo session (one WebGPU Chrome)

/** 3 and 6 (alone), and the shots 23 reads: a session on real keys, cut to 25 s by Studio's override, then Play again. */
async function soloRound(env) {
  const { want, add, rec, newPage, srv, shot, outDir } = env;
  await env.section([[3, 'boots to play with no console errors'], [6, 'a round reaches results and replays']], async () => {
    if (![3, 6, 23].some(want)) return;
    const roundSeconds = 25;
    const S = await newPage('solo', { overrides: { patches: [{ file: 'config/game.json', pointer: '/round/seconds', value: roundSeconds }] } });
    const p = S.page;
    const t0 = Date.now();
    await p.goto(`${srv.url}?seed=7`, { waitUntil: 'load' });
    await until(async () => (await snap(p))?.phase === 'lobby', 120000, 'the lobby');
    rec.bootSeconds = Math.round((Date.now() - t0) / 100) / 10;
    await shot(p, 'menu');
    const play = await p.locator('#gf-play').boundingBox();
    await p.mouse.click(play.x + play.width / 2, play.y + play.height / 2);
    await until(async () => (await snap(p))?.phase === 'playing', 15000, 'the round to start');
    await sleep(1200);
    const fl = await shot(p, 'first-look'); env.shotsForLikeness.push(join(outDir, fl));
    await p.mouse.click(640, 400);
    let moved = 0;
    const start = (await snap(p)).vista.player;
    const far = async () => { const m = (await snap(p))?.vista?.player; if (m) moved = Math.max(moved, Math.hypot(m.x - start.x, m.z - start.z)); };
    await p.keyboard.down('KeyW'); for (let i = 0; i < 7; i++) { await sleep(200); await far(); } await p.keyboard.up('KeyW');
    await p.keyboard.down('KeyD'); for (let i = 0; i < 4; i++) { await sleep(180); await far(); } await p.keyboard.up('KeyD');
    const pl = await shot(p, 'playing'); env.shotsForLikeness.push(join(outDir, pl));
    for (let i = 0; i < 2; i++) { const c = await p.evaluate(() => window.__game.coverage()).catch(() => null); if (c) env.coverage.push(c); await sleep(1200); }
    await until(async () => (await snap(p))?.phase === 'results', (roundSeconds + 25) * 1000, 'the results');
    const sr = await snap(p);
    await shot(p, 'results');
    const again = await p.locator('#gf-again').boundingBox().catch(() => null);
    if (again) await p.mouse.click(again.x + again.width / 2, again.y + again.height / 2);
    const replayed = await until(async () => { const s = await snap(p); return s && s.round === 2 && ['countdown', 'playing'].includes(s.phase) ? s : null; }, 10000, 'round 2').catch(() => null);
    await sleep(1200);
    await shot(p, 'round-2');
    const errors = S.errors.filter(e => !CORE_NOTES.test(e));
    await keepLog(env, p, 'solo');
    rec.solo = { moved: +moved.toFixed(2), results: sr.results, winners: sr.winners, bootSeconds: rec.bootSeconds, screen: await p.evaluate(() => window.__game.screen()).catch(() => null) };
    env.solo = { ok: sr.phase === 'results' && (sr.results ?? []).length > 0 && !!replayed, results: sr.results ?? [] };
    if (want(3)) add(3, 'boots to play with no console errors', errors.length === 0 && moved > 0.5, `${errors.length ? `console errors: ${[...new Set(errors)].slice(0, 3).join(' | ')}` : 'no console errors'}; the menu came up in ${rec.bootSeconds} s (shaders compiled); the player walked ${moved.toFixed(2)} m on real keys (the vista core's walker); ${rec.solo.screen ? `${rec.solo.screen.api}, ${rec.solo.screen.fps ?? '?'} fps at ${rec.solo.screen.buffer?.join('x')}` : ''}`);
    await S.ctx.close();
    env.lapNow('solo round');
  });
}

/**
 * 13 (the vista leg): the core's own controls work for a new player. In a round: looking around with the mouse turns the
 * view a quarter turn each way and never opens the pause menu, also when the mouse is let go and taken back at the
 * screen's edge (tools/lib/lock.mjs turnBy, as the play tools turn; the T7 play-tester's look steps paused the game,
 * 2026-10-12); R takes the rod out; holding and letting go of the left button casts (the game's rod state follows).
 */
async function check13(env) {
  const { want, add, rec, newPage, srv, shot } = env;
  if (!want(13)) return;
  await env.section([[13, 'controls work']], async () => {
    const C = await newPage('controls');
    const p = C.page;
    try {
      await p.goto(`${srv.url}?seed=7`, { waitUntil: 'load' });
      await until(async () => (await snap(p))?.phase === 'lobby', 120000, 'the lobby');
      await p.keyboard.press('Enter');
      await until(async () => (await snap(p))?.phase === 'playing', 15000, 'the round to start');
      await sleep(800);
      await p.mouse.click(640, 400);   // into the game: the core takes the mouse
      await sleep(300);
      const cam0 = await p.evaluate(() => window.__game.camera());
      const cursor = { x: 640, y: 400 };
      await turnBy(p, cursor, 650, 0);   // a quarter turn right, through the screen's edge (let go and taken back)
      await sleep(500);
      const cam1 = await p.evaluate(() => window.__game.camera());
      const menu1 = await p.evaluate(() => window.__game.menu());
      await turnBy(p, cursor, -1300, 0);   // half a turn back left
      await sleep(500);
      const cam2 = await p.evaluate(() => window.__game.camera());
      const menu2 = await p.evaluate(() => window.__game.menu());
      const turned = (a, b) => { let d = Math.abs(b.yaw - a.yaw) % (2 * Math.PI); return Math.min(d, 2 * Math.PI - d); };
      const right = turned(cam0, cam1), left = turned(cam1, cam2);
      const paused = !!(menu1?.pause || menu2?.pause) || (await snap(p))?.phase !== 'playing';
      await shot(p, 'looked-around');
      const rod0 = (await p.evaluate(() => window.__game.vista.game())).rod;
      await p.keyboard.press('KeyR');
      await sleep(900);
      const rod1 = (await p.evaluate(() => window.__game.vista.game())).rod;
      await p.mouse.down(); await sleep(1100); await p.mouse.up();
      let rod2 = rod1;
      for (let i = 0; i < 12 && ['ready', 'away'].includes(rod2); i++) { await sleep(250); rod2 = (await p.evaluate(() => window.__game.vista.game())).rod; }
      await shot(p, 'cast');
      const errors = C.errors.filter(e => !CORE_NOTES.test(e));
      const ok = right > 0.4 && left > 0.8 && !paused && rod0 === 'away' && rod1 !== 'away' && !['ready', 'away'].includes(rod2) && errors.length === 0;
      rec.controls = { turned: { right: +right.toFixed(2), left: +left.toFixed(2) }, paused, rod: [rod0, rod1, rod2], errors: errors.slice(0, 3) };
      add(13, 'controls work', ok, ok
        ? `the mouse turned the view ${right.toFixed(2)} rad right and ${left.toFixed(2)} rad back left (let go and taken back at the screen's edge) with no pause; R took the rod out (${rod0} → ${rod1}); holding and letting go of the left button cast (${rod2})`
        : [right <= 0.4 || left <= 0.8 ? `looking around turned the view only ${right.toFixed(2)} rad right and ${left.toFixed(2)} rad left (a quarter turn each way was asked)` : '',
          paused ? 'looking around opened the pause menu (letting go of the mouse at the screen\'s edge and taking it back must not pause)' : '',
          rod1 === 'away' ? `R did not take the rod out (rod ${rod0} → ${rod1})` : '',
          ['ready', 'away'].includes(rod2) ? `holding and letting go of the left button did not cast (rod stayed ${rod2})` : '',
          errors.length ? `console: ${errors[0]}` : ''].filter(Boolean).join('; '));
    } finally { await C.ctx.close().catch(() => {}); }
    env.lapNow('controls');
  });
}

/**
 * 15 (the vista leg): the loop is alive. A new player's first minutes, with real input only: R takes the rod out, a held
 * click casts, the bite comes, a click strikes, and the fight is reeled the way the tension bar asks (hold while it is
 * low, let go near the top of the green band) until the fish is landed; then the catch is in the game (the cooler) and
 * the HUD's score and catch show it. Up to four casts in three minutes. The T7 run 2 play-tester could not land a fish
 * and nothing else checked the core loop, the score or a landed fish (2026-10-12); this check is that player.
 */
async function check15(env) {
  const { want, add, rec, newPage, srv, shot } = env;
  if (!want(15)) return;
  await env.section([[15, 'the loop is alive']], async () => {
    // fishing water first: the page starts on the pier head (config/game.json → vista.start, as Studio's override sets
    // it), the deck over water on every island; each island's pier runs its own way (its harbour frame), so the walk out
    // along a pier the reference island's way is not taken (a generated place's start may be up by its plaza)
    const F = await newPage('fishing', { overrides: { patches: [{ file: 'config/game.json', pointer: '/round/seconds', value: 600 }, { file: 'config/game.json', pointer: '/vista/start', value: 'pier-head' }] } });
    const p = F.page;
    const G = () => p.evaluate(() => window.__game.vista.game());
    const me = async () => { const s = await snap(p); return s?.players?.find(x => x.local) ?? null; };
    let down = false;
    const press = async () => { if (!down) { await p.mouse.down(); down = true; } };
    const release = async () => { if (down) { await p.mouse.up(); down = false; } };
    const log = [];
    try {
      await p.goto(`${srv.url}?seed=11`, { waitUntil: 'load' });
      await until(async () => (await snap(p))?.phase === 'lobby', 120000, 'the lobby');
      await p.keyboard.press('Enter');
      await until(async () => (await snap(p))?.phase === 'playing', 15000, 'the round to start');
      await sleep(800);
      await p.mouse.click(640, 400);
      await sleep(300);
      // face the open water off the pier head's far side from the moored boat (the island's own harbour frame)
      const { P, list } = await expectedIslands(env.dir);
      const recipe = P.placeRecipe(list[0].seed, list[0].words), H = P.harbourFrame(recipe), headZ = recipe.pier.zEnd - recipe.pier.headDepth / 2;
      const [ax, az] = H.tw(55, headZ), [bx, bz] = H.tw(45, headZ);
      const want = Math.atan2(-(bx - ax), -(bz - az));
      const cursor = { x: 640, y: 400 };
      const pl0 = (await snap(p))?.vista?.player;
      if (pl0) { let d = want - pl0.yaw; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; await turnBy(p, cursor, -d / 0.0022, 0, { stepPx: 60 }); }
      await sleep(400);
      const at = (await snap(p))?.vista?.player ?? null;
      log.push(`fished from ${at ? `${at.x.toFixed(1)}, ${at.z.toFixed(1)}` : '?'}`);
      const g0 = await G(), score0 = (await me())?.score ?? 0;
      const t0 = Date.now();
      let landed = null, casts = 0, bites = 0, strikes = 0, fights = 0;
      while (!landed && casts < 4 && Date.now() - t0 < 180000) {
        let g = await G();
        if (g.rod === 'away') { await p.keyboard.press('KeyR'); await until(async () => (await G()).rod === 'ready', 5000, 'the rod out'); }
        casts++;
        await press(); await sleep(1100); await release();
        g = await until(async () => { const x = await G(); return ['waiting', 'bite', 'ready'].includes(x.rod) && x.rod !== 'casting' ? x : null; }, 8000, 'the float on the water').catch(() => null);
        if (!g || g.rod === 'ready') { log.push(`cast ${casts}: the float did not stay on the water`); continue; }
        const bite = await until(async () => (await G()).rod === 'bite', 75000, 'a bite', 60).catch(() => null);
        if (!bite) { log.push(`cast ${casts}: no bite in 75 s`); await p.mouse.click(640, 400, { button: 'right' }); continue; }
        bites++;
        await p.mouse.down(); await sleep(80); await p.mouse.up(); strikes++;
        const on = await until(async () => { const x = await G(); return x.rod === 'fight' ? x : (x.rod !== 'bite' && x.rod !== 'waiting' ? 'missed' : null); }, 2500, 'the hook set').catch(() => 'missed');
        if (on === 'missed') { log.push(`cast ${casts}: the strike missed`); continue; }
        fights++;
        const fs = Date.now();
        let x;
        while ((x = await G()).rod === 'fight' && x.fight && Date.now() - fs < 120000) {
          if (x.fight.tension > x.fight.band[1] - 0.12) await release();
          else if (x.fight.tension < x.fight.band[1] - 0.3) await press();
          await sleep(30);
        }
        await release();
        const g1 = await until(async () => { const y = await G(); return y.cooler.count > g0.cooler.count || ['ready', 'away'].includes(y.rod) ? y : null; }, 8000, 'the fight to end').catch(() => null);
        if (g1 && g1.cooler.count > g0.cooler.count) landed = { fightS: Math.round((Date.now() - fs) / 100) / 10, catch: g1.catches?.at(-1) ?? null, cooler: g1.cooler };
        else log.push(`cast ${casts}: the fish got away after ${Math.round((Date.now() - fs) / 1000)} s`);
      }
      await sleep(900);
      const f = await shot(p, 'landed');
      const score1 = (await me())?.score ?? 0;
      await keepLog(env, p, 'fishing');
      env.fished = { landed: !!landed, score0, score1 };
      const hud = await p.evaluate(() => window.__game.hud()).catch(() => null);
      const errors = F.errors.filter(e => !CORE_NOTES.test(e));
      rec.loop = { casts, bites, strikes, fights, landed, score: [score0, score1], log, shot: f };
      const ok = !!landed && score1 !== score0 && errors.length === 0;
      add(15, 'the loop is alive', ok, landed
        ? `with real input: ${casts} cast(s), ${bites} bite(s), ${fights} fight(s); landed ${landed.catch?.name ?? 'a fish'}${landed.catch?.kg ? ` (${landed.catch.kg} kg)` : ''} after a ${landed.fightS} s fight; the cooler holds ${landed.cooler.count}; the score went ${score0} → ${score1}${score1 === score0 ? ' (the rules did not score the first fish landed: a player sees nothing happen)' : ''}${errors.length ? `; console: ${errors[0]}` : ''}${log.length ? `; before: ${log.join('; ')}` : ''}`
        : `no fish landed with real input in ${casts} cast(s) and ${Math.round((Date.now() - t0) / 1000)} s: ${log.join('; ') || 'nothing bit'}`);
    } finally { await release().catch(() => {}); await F.ctx.close().catch(() => {}); }
    env.lapNow('the loop');
  });
}

/** Read a page's event log into env.eventLogs (measure 12 traces every score in it to a counted event). */
async function keepLog(env, page, label) {
  const l = await page.evaluate(() => (typeof window.__game?.events === 'function' ? window.__game.events({ since: 0 }) : null)).catch(() => null);
  if (l) env.eventLogs.push({ label, entries: l.entries, dropped: l.dropped, me: l.me });
}

/** 4 (gate A): slot coverage. Every drawable the core put in the scene, in play (the solo round) and in each preview
 *  subject: a file slot of the core's (kit/core-files.js), look.sea for the sea, a seat's body slot for a friend, or
 *  code-made by the core (exempt, counted apart and named by module: not a file, so nothing to swap yet). */
async function check4(env) {
  const { want, add, rec, dir, newPage, srv } = env;
  if (!want(4)) return;
  await env.section([[4, 'slot coverage 100%']], async () => {
    const assets = JSON.parse(await readFile(join(dir, 'assets.json'), 'utf8'));
    const subj = [];
    for (const q of (assets.showcase ?? []).map(x => x.query)) {
      const T = await newPage(`show ${q}`);
      try {
        await T.page.goto(srv.url + q, { waitUntil: 'load' });
        await until(() => T.page.evaluate(() => window.__game?.ready === true), 120000, q).catch(() => {});
        await sleep(1500);
        subj.push({ q, c: await T.page.evaluate(() => window.__game?.coverage?.() ?? null).catch(() => null), errors: T.errors.filter(e => !CORE_NOTES.test(e)) });
      } finally { await T.ctx.close().catch(() => {}); }
    }
    const all = [...env.coverage, ...subj.map(x => x.c)];
    const untagged = all.flatMap(c => c?.untagged ?? [{ name: 'no coverage report' }]);
    const unknown = [...new Set(all.flatMap(c => c?.unknownSlots ?? []))];
    const empty = all.filter(c => c && !c.meshes).length;
    const play = env.coverage.at(-1);
    rec.coverage = { play: env.coverage.map(c => ({ meshes: c.meshes, tagged: c.tagged, exempt: c.exempt, exemptBy: c.exemptBy, bySlot: c.bySlot })), subjects: subj.map(x => ({ q: x.q, meshes: x.c?.meshes, tagged: x.c?.tagged, exempt: x.c?.exempt })) };
    const ex = play ? Object.entries(play.exemptBy ?? {}).map(([k, n]) => `${n} ${k.replace(/^code-made by the core \((.*)\)$/, '$1')}`).join(', ') : '';
    add(4, 'slot coverage 100%', env.coverage.length > 0 && untagged.length === 0 && unknown.length === 0 && !empty && subj.every(x => !x.errors.length),
      `${play ? `in play ${play.tagged} of ${play.meshes} drawables carry a slot (${Object.entries(play.bySlot ?? {}).map(([s, n]) => `${s} ${n}`).join(', ')}) and ${play.exempt} are code-made by the core, not files (${ex})` : 'no coverage report in play'}; ${subj.map(x => `${x.q.replace('?gf-show=', '')} ${x.c ? `${x.c.tagged}/${x.c.meshes} (+${x.c.exempt} code-made)` : 'no report'}`).join(', ')}${untagged.length ? `; untagged: ${untagged.slice(0, 4).map(u => `${u.path ?? u.name} (${(u.from ?? []).join(' < ')})`).join(', ')}` : ''}${unknown.length ? `; slots assets.json lacks: ${unknown.join(', ')}` : ''}${empty ? `; ${empty} report(s) drew nothing` : ''}`);
    env.lapNow('coverage');
  });
}

/** 12 (gate D): something happens (a fish landed and the score moved on check 15's page, with real input: vista has
 *  no bots) and every score change on every page came from a counted event of that player (vista.catch, vista.sold,
 *  ctx.events.count). */
async function check12(env) {
  const { want, add, rec } = env;
  if (!want(12) || env.checks.some(c => c.n === 12)) return;
  const f = env.fished;
  const happens = !f ? { ok: false, detail: 'the fishing page (measure 15) did not run, so nothing was played to score' }
    : { ok: f.landed && f.score1 !== f.score0, detail: f.landed ? `a fish landed with real input and the score went ${f.score0} → ${f.score1}` : 'no fish landed with real input on the fishing page (measure 15 says why)' };
  const sc = judgeScores({ logs: env.eventLogs, happens });
  rec.scores = sc.record;
  add(12, 'scores come from counted events', sc.ok, sc.detail);
}

/** 38 (gate C): every event the kit's log names this player in (a bite, a catch, a sale, a press, a sound) shows on
 *  their own screen soon (tools/lib/events-check.mjs, on stepped time: the vista boot's ?gf-step=1). */
async function check38(env) {
  const { want, add, rec, newPage, srv, game, shot, log } = env;
  if (!want(38)) return;
  await env.section([[38, 'every event answered']], async () => {
    const soloSounds = env.eventLogs.find(l => l.label === 'solo')?.entries.filter(e => e.k === 'sound') ?? [];
    const ev = await checkEvents({ newPage: (label, o = {}) => newPage(label, o), browser: env.browser, url: srv.url, game, walkKeys: { forward: 'KeyW' }, log, shot, heardAlso: [{ plays: soloSounds }] });
    rec.events = ev.record; if (ev.warnings.length) rec.notes.push(...ev.warnings);
    add(38, 'every event answered', ev.ok, ev.detail);
    env.lapNow('every event answered');
  });
}

/** 35 (gate F): the game's own tests (tools/lib/game-tests.mjs): with none, judged with no browser; with tests, each on
 *  a page of its own on stepped time. */
async function check35(env) {
  const { want, add, rec, dir, log } = env;
  if (!want(35) || env.checks.some(c => c.n === 35)) return;
  if (!!env.browser !== env.ownTests) return;
  const promises = await (async () => { try { return await (await import('./lib/promises.mjs')).promisesFor(dir); } catch { return null; } })();
  const gt = await checkGameTests({ dir, promises, ...(env.ownTests ? { newPage: env.newPage, url: env.srv.url, log } : {}) });
  rec.gameTests = gt.record; if (gt.warnings?.length) rec.notes.push(...gt.warnings);
  add(35, 'the game\'s own tests', gt.ok, gt.detail);
}

/**
 * 31 (the vista leg): sharp on every screen. The core sizes its canvas from CSS pixels; the kit makes it follow the
 * device pixel ratio (gf/vista/kit/host.js followPixelRatio, capped at 3840x2160 pixels a frame). On a page at pixel
 * ratio 2 (a 200 % zoom, a scaled display) the canvas must hold the screen's real pixels, not a quarter of them that
 * the browser stretches (the creator, 2026-10-12: "visually this is much much worse than the original"; the game had
 * drawn 1920x1080 on a 3840x2160 screen).
 */
async function check31(env) {
  const { want, add, rec, newPage, srv, shot } = env;
  if (!want(31)) return;
  await env.section([[31, 'sharp on every screen']], async () => {
    const D = await newPage('pixel-ratio-2', { viewport: { width: 1280, height: 720 }, scale: 2 });
    const p = D.page;
    try {
      await p.goto(`${srv.url}?seed=7`, { waitUntil: 'load' });
      await until(async () => (await snap(p))?.phase === 'lobby', 120000, 'the lobby');
      await p.keyboard.press('Enter');
      await until(async () => (await snap(p))?.phase === 'playing', 15000, 'the round to start');
      await sleep(1500);
      const sc = await p.evaluate(() => { const s = window.__game.screen(); return { ...s, dpr: devicePixelRatio, cssWidth: s.css[0], cssHeight: s.css[1], width: s.buffer[0], height: s.buffer[1] }; });
      const want2 = { w: Math.round(sc.cssWidth * sc.dpr), h: Math.round(sc.cssHeight * sc.dpr) };
      const ok = Math.abs(sc.width - want2.w) <= 2 && Math.abs(sc.height - want2.h) <= 2;
      rec.pixelRatio = { ...sc, want: want2 };
      await shot(p, 'pixel-ratio-2');
      add(31, 'sharp on every screen', ok, ok
        ? `at pixel ratio ${sc.dpr} the ${sc.cssWidth}x${sc.cssHeight} page draws a ${sc.width}x${sc.height} canvas: every screen pixel is drawn`
        : `at pixel ratio ${sc.dpr} the ${sc.cssWidth}x${sc.cssHeight} page draws only a ${sc.width}x${sc.height} canvas (the screen has ${want2.w}x${want2.h}): the browser stretches it and the picture goes soft`);
    } finally { await D.ctx.close().catch(() => {}); }
    env.lapNow('pixel ratio');
  });
}

/** Pixels of a band of the screen (PNG bytes → {w, h, data} over the band), read back in a page at a small size. */
async function bandOf(browser, png, band) {
  const page = await browser.newPage();
  try {
    return await page.evaluate(async ([b64, B]) => {
      const im = new Image(); im.src = 'data:image/png;base64,' + b64; await im.decode();
      const W = 320, H = Math.round(320 * im.height / im.width), c = new OffscreenCanvas(W, H), g = c.getContext('2d');
      g.drawImage(im, 0, 0, W, H);
      const x0 = Math.round(B.x0 * W), x1 = Math.round(B.x1 * W), y0 = Math.max(0, Math.round(B.y0 * H)), y1 = Math.min(H, Math.round(B.y1 * H));
      const d = g.getImageData(x0, y0, Math.max(1, x1 - x0), Math.max(1, y1 - y0));
      return { w: d.width, h: d.height, data: Array.from(d.data) };
    }, [png.toString('base64'), band]);
  } finally { await page.close(); }
}
const lumaStats = px => { let n = 0, s = 0, s2 = 0; for (let i = 0; i < px.data.length; i += 4) { const l = 0.2126 * px.data[i] + 0.7152 * px.data[i + 1] + 0.0722 * px.data[i + 2]; s += l; s2 += l * l; n++; } const m = s / Math.max(1, n); return { mean: m, std: Math.sqrt(Math.max(0, s2 / Math.max(1, n) - m * m)) }; };
/** The mean colour of a band ([r, g, b]): a sky that turns from blue to gold can keep its luma (gate F's 37). */
const colourMean = px => { const m = [0, 0, 0]; let n = 0; for (let i = 0; i < px.data.length; i += 4) { m[0] += px.data[i]; m[1] += px.data[i + 1]; m[2] += px.data[i + 2]; n++; } return m.map(v => v / Math.max(1, n)); };
const changed = (a, b, t = 10) => { let n = 0, c = 0; for (let i = 0; i < a.data.length; i += 4) { n++; if (Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) + Math.abs(a.data[i + 2] - b.data[i + 2]) > t) c++; } return c / Math.max(1, n); };

/**
 * 36: the sea is drawn and moving. A page with the HUD hidden (?gf-ui=0) and the round started: the player stands still
 * at their start place looking out to sea, and a band of open water just under the horizon (from the drawn camera's
 * pitch and field of view) is read back from the screen four times 600 ms apart. The band must not be flat (the waves,
 * glints and colour of a drawn sea) and must change from frame to frame while the player and the camera do not move.
 */
async function check36(env) {
  const { want, add, rec, newPage, srv, shot, browser } = env;
  if (!want(36)) return;
  await env.section([[36, 'the sea is drawn and moving']], async () => {
    const T = await newPage('sea');
    const p = T.page;
    try {
      await p.goto(`${srv.url}?seed=7&gf-ui=0`, { waitUntil: 'load' });
      await until(async () => (await snap(p))?.phase === 'lobby', 120000, 'the lobby');
      await p.keyboard.press('Enter');
      await until(async () => (await snap(p))?.phase === 'playing', 15000, 'the round to start');
      await sleep(1500);
      const cam = await p.evaluate(() => window.__game.camera());
      // the horizon's height on the screen from the camera's pitch and vertical field of view; the band 1.5–8% below it (over the pier head's rail, which stands about 10% below)
      const fovY = (cam.fov ?? 62) * Math.PI / 180, horizon = 0.5 + Math.tan(cam.pitch ?? 0) / (2 * Math.tan(fovY / 2));
      const band = { x0: 0.3, x1: 0.7, y0: Math.min(0.9, horizon + 0.015), y1: Math.min(0.97, horizon + 0.08) };
      const frames = [], where = [];
      for (let i = 0; i < 4; i++) { frames.push(await p.screenshot({ type: 'png' })); where.push((await snap(p)).vista.player); if (i < 3) await sleep(600); }
      const f = await shot(p, 'sea');
      const px = await Promise.all(frames.map(png => bandOf(browser, png, band)));
      const st = lumaStats(px[0]);
      const moves = [changed(px[0], px[1]), changed(px[1], px[2]), changed(px[2], px[3])];
      const still = Math.max(...where.map(w => Math.hypot(w.x - where[0].x, w.z - where[0].z)));
      const look = (await snap(p)).vista.look;
      const water = cam.underwater === false;
      const ok = st.std > 2 && st.mean > 8 && Math.min(...moves) > 0.02 && still < 0.05 && water && T.errors.filter(e => !CORE_NOTES.test(e)).length === 0;
      rec.sea = { band, horizon: +horizon.toFixed(3), luma: { mean: +st.mean.toFixed(1), std: +st.std.toFixed(1) }, changed: moves.map(m => +m.toFixed(3)), playerMoved: +still.toFixed(3), camera: cam, look, shot: f };
      add(36, 'the sea is drawn and moving', ok, ok
        ? `a band of open sea under the horizon (y ${(band.y0 * 100).toFixed(0)}–${(band.y1 * 100).toFixed(0)}% of the screen) has luma ${st.mean.toFixed(0)} ± ${st.std.toFixed(1)} and ${moves.map(m => `${(m * 100).toFixed(0)}%`).join(', ')} of its pixels change between frames 600 ms apart while the player stands still (${look.sea} sea, hour ${look.hour})`
        : `${st.std <= 2 || st.mean <= 8 ? `the band under the horizon is flat (luma ${st.mean.toFixed(1)} ± ${st.std.toFixed(2)}): no sea is drawn there. ` : ''}${Math.min(...moves) <= 0.02 ? `the sea did not move between frames (${moves.map(m => `${(m * 100).toFixed(1)}%`).join(', ')} of the band changed). ` : ''}${still >= 0.05 ? `the player moved ${still.toFixed(2)} m while the frames were read. ` : ''}${!water ? 'the camera is under water. ' : ''}${T.errors.length ? `console: ${T.errors[0]}` : ''}`.trim());
    } finally { await T.ctx.close().catch(() => {}); }
    env.lapNow('the sea');
  });
}

/**
 * 37: the look is the config's. On the game as made, the core's look state is config/look.json's values (the preset,
 * the hour, the sea state, the exposure, the cloud cover when set). Then the hour as Studio changes it (an override of
 * config/look.json /hour: noon for an evening look, else the evening) reaches the core, and the sky above the horizon
 * changes on the screen.
 */
async function check37(env) {
  const { want, add, rec, newPage, srv, shot, browser, look: cfg } = env;
  if (!want(37)) return;
  await env.section([[37, 'the look is the config\'s']], async () => {
    const other = Math.abs((cfg.hour ?? 12) - 12.5) > 3 ? 12.5 : 17.9;
    const view = async (label, overrides) => {
      const T = await newPage(label, overrides ? { overrides } : {});
      await T.page.goto(`${srv.url}?seed=7&gf-ui=0`, { waitUntil: 'load' });
      await until(async () => (await snap(T.page))?.phase === 'lobby', 120000, `the lobby (${label})`);
      await sleep(1200);
      const L = await T.page.evaluate(() => window.__game.vista.look());
      const png = await T.page.screenshot({ type: 'png' });
      const f = await shot(T.page, `look-${label}`);
      const band = await bandOf(browser, png, { x0: 0.3, x1: 0.7, y0: 0.03, y1: 0.18 });   // open sky at the top middle (a stall's roof can stand at the right from the pier's foot)
      const sky = { ...lumaStats(band), rgb: colourMean(band) };
      await T.ctx.close();
      return { L, sky, f, errors: T.errors.filter(e => !CORE_NOTES.test(e)) };
    };
    const a = await view('as-made');
    const b = await view('studio-hour', { patches: [{ file: 'config/look.json', pointer: '/hour', value: other }] });
    const s = a.L.state, want37 = { preset: cfg.preset ?? null, hour: cfg.hour, sea: cfg.sea, exposure: cfg.exposure, ...(cfg.clouds !== undefined ? { clouds: cfg.clouds } : {}) };
    const off = [];
    if ((want37.preset ?? null) !== (s.preset ?? null)) off.push(`preset ${s.preset} (config ${want37.preset})`);
    if (Math.abs(s.hour - want37.hour) > 0.01) off.push(`hour ${s.hour} (config ${want37.hour})`);
    if (s.sea !== want37.sea) off.push(`sea ${s.sea} (config ${want37.sea})`);
    if (Math.abs((s.exposure ?? 0) - (want37.exposure ?? 0)) > 0.01) off.push(`exposure ${s.exposure} (config ${want37.exposure})`);
    if (want37.clouds !== undefined && s.clouds !== null && Math.abs(s.clouds - want37.clouds) > 0.01) off.push(`clouds ${s.clouds} (config ${want37.clouds})`);
    const reached = Math.abs(b.L.state.hour - other) < 0.01;
    // the sky moved: its brightness or its colour (a morning blue and a dusk sky can share a luma)
    const hue = Math.hypot(...a.sky.rgb.map((v, i) => v - b.sky.rgb[i]));
    const skyMoved = Math.max(Math.abs(a.sky.mean - b.sky.mean), hue / 2);
    const ok = off.length === 0 && reached && skyMoved > 4 && !a.errors.length && !b.errors.length;
    rec.lookCheck = { config: want37, state: s, studio: { hour: other, state: b.L.state }, sky: { asMade: +a.sky.mean.toFixed(1), studio: +b.sky.mean.toFixed(1), colour: [a.sky.rgb, b.sky.rgb].map(c => c.map(v => Math.round(v))), colourMoved: +hue.toFixed(1) }, shots: [a.f, b.f] };
    add(37, 'the look is the config\'s', ok, ok
      ? `the core draws config/look.json: ${s.preset} (hour ${s.hour}, ${s.sea} sea, exposure ${s.exposure}${s.clouds !== null ? `, clouds ${s.clouds}` : ''}); Studio's hour ${other} reached the core and the sky went luma ${a.sky.mean.toFixed(0)} → ${b.sky.mean.toFixed(0)}, colour [${a.sky.rgb.map(v => v.toFixed(0))}] → [${b.sky.rgb.map(v => v.toFixed(0))}]`
      : [off.length ? `the core's look is not the config's: ${off.join(', ')}` : '', !reached ? `Studio's hour ${other} did not reach the core (it reads ${b.L.state.hour})` : '', skyMoved <= 4 ? `the sky did not change with the hour (luma ${a.sky.mean.toFixed(1)} → ${b.sky.mean.toFixed(1)}, colour moved ${hue.toFixed(1)})` : '', [...a.errors, ...b.errors].slice(0, 2).join(' | ')].filter(Boolean).join('; '));
    env.lapNow('the look');
  });
}

/**
 * 17 (vista's leg of gate F, "the world is complete"): the game is its spec's islands. The spec (spec.json, as locked)
 * gives the islands through the kit's own rule (kit/config.js specIslands: world.islands, or one island of the game's
 * own); config/world.json must list each of them, the core must have built island 1's place (kit/world/places.js
 * placeKey; the reference island's key fails, whatever the config says), and every other island is gone to and built
 * in turn. A game on the reference island, or with fewer islands than its spec, fails here (regressions
 * vista-reference-island, vista-fewer-islands).
 */
export async function expectedIslands(dir) {
  const spec = JSON.parse(await readFile(join(dir, 'spec.json'), 'utf8'));
  const C = await import(pathToFileURL(join(VISTA_KIT, 'config.js')).href), P = await import(pathToFileURL(join(VISTA_KIT, 'world/places.js')).href);
  return { P, list: C.specIslands(spec).map(it => ({ ...it, key: P.placeKey(P.placeRecipe(it.seed, it.words)) })) };
}

async function check17(env) {
  const { want, add, rec, newPage, srv, shot, dir } = env;
  if (!want(17)) return;
  await env.section([[17, 'the world is complete']], async () => {
    const { P, list } = await expectedIslands(dir);
    const world = JSON.parse(await readFile(join(dir, 'config/world.json'), 'utf8'));
    const cfg = world.islands ?? [];
    const problems = [], seen = [];
    if (cfg.length < list.length) problems.push(`config/world.json lists ${cfg.length} island${cfg.length === 1 ? '' : 's'}, the spec ${list.length}`);
    list.forEach((it, i) => {
      const c = cfg[i];
      if (c && (c.seed !== it.seed || JSON.stringify(c.words ?? {}) !== JSON.stringify(it.words))) problems.push(`config/world.json island ${i + 1} is seed ${c.seed} ${JSON.stringify(c.words ?? {})}, the spec's seed ${it.seed} ${JSON.stringify(it.words)}`);
    });
    const T = await newPage('islands');
    await T.page.goto(`${srv.url}?seed=7&gf-ui=0`, { waitUntil: 'load' });
    await until(async () => (await snap(T.page))?.phase === 'lobby', 120000, 'the lobby (islands)');
    await sleep(800);
    const w0 = (await snap(T.page)).world;
    seen.push({ island: 1, ...w0.place, shot: await shot(T.page, 'island-1') });
    if (w0.place?.reference) problems.push(`the game is on the reference island (place ${w0.place.key}): every vista game has its own islands (world.islands)`);
    else if (w0.place?.key !== list[0].key) problems.push(`island 1 is not the spec's place: the core built ${w0.place?.key} (${w0.place?.name}), the spec's ${list[0].name} is ${list[0].key}`);
    if ((w0.islands ?? 1) < list.length) problems.push(`the game sails between ${w0.islands ?? 1} island${(w0.islands ?? 1) === 1 ? '' : 's'}; the spec lists ${list.length}`);
    for (let i = 1; i < Math.min(list.length, w0.islands ?? 1); i++) {
      const t0 = Date.now();
      const r = await T.page.evaluate(n => window.__game.vista.hop(n), i);
      await sleep(600);
      const w = (await snap(T.page)).world;
      seen.push({ island: i + 1, ...w.place, ms: Date.now() - t0, shot: await shot(T.page, `island-${i + 1}`) });
      if (!r?.ok) problems.push(`island ${i + 1} (${list[i].name}) was not reached: ${r?.why ?? 'no answer'}`);
      else if (w.place?.reference) problems.push(`island ${i + 1} is the reference island`);
      else if (w.place?.key !== list[i].key) problems.push(`island ${i + 1} is not the spec's place: the core built ${w.place?.key}, the spec's ${list[i].name} is ${list[i].key}`);
    }
    const errors = T.errors.filter(e => !CORE_NOTES.test(e));
    if (errors.length) problems.push(`console errors: ${errors.slice(0, 2).join(' | ')}`);
    await T.ctx.close();
    rec.islands = { spec: list.map(({ name, seed, words, key }) => ({ name, seed, words, key })), reference: P.REFERENCE_KEY, seen };
    add(17, 'the world is complete', problems.length === 0, problems.length ? problems.join('; ')
      : `the game is its spec's ${list.length} island${list.length === 1 ? '' : 's'}, each built from its own seed and words: ${seen.map(s => `${s.island}. ${list[s.island - 1].name} (seed ${s.seed}, place ${s.key}${s.ms ? `, built in ${(s.ms / 1000).toFixed(1)} s` : ''})`).join('; ')}; none is the reference island (${P.REFERENCE_KEY})`);
    env.lapNow('the islands');
  });
}

async function check20(env) {
  const { want, add, rec, newPage, srv, game, log, shot } = env;
  if (want(20)) await env.section([[20, 'the menu works']], async () => {
    // phones: false: a vista game is desktop only (WebGPU, desktop; the creator, 2026-10-12), so 20's and 25's phone legs
    // (tools/lib/phone-fit.mjs) don't apply; the live build of 2026-10-12 failed on them through the kit's own menus.
    const r = await checkMenu({ newPage, url: srv.url, game, log, shot, phones: false }); rec.menu = r.record; rec.notes.push(...r.warnings);
    add(20, 'the menu works', r.ok, r.detail);
    env.lapNow('the menu');
  });
}
async function check21(env) {
  const { want, add, rec, newPage, srv, game, log, shot } = env;
  if (want(21)) await env.section([[21, 'the HUD shows your state']], async () => {
    const r = await checkHud({ newPage, url: srv.url, game, log, shot }); rec.hud = r.record; rec.notes.push(...r.warnings);
    add(21, 'the HUD shows your state', r.ok, `${r.detail}${r.ok ? ' (vista: no bots; the HUD parts of the fishing are the vista HUD\'s, gf/vista/hud)' : ''}`);
    env.lapNow('the HUD');
  });
}

/**
 * 32 on vista: a Chrome with no WebGPU (the software renderer: no adapter, or only a fallback one) opens the game: the
 * kit's screen is up (#gf-vista-nowebgpu) with the game's title and its link, window.__game says "unsupported", and the
 * core was never loaded (none of gf/vista/core was asked for).
 */
async function check32(env) {
  const { add, rec, srv, outDir, log, game } = env;
  await env.section([[32, 'no WebGPU: the kit\'s screen']], async () => {
    const browser = await launchChrome({});
    try {
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
      const page = await ctx.newPage();
      const asked = [], errors = [];
      page.on('request', r => asked.push(r.url()));
      page.on('pageerror', e => errors.push(e.message));
      await page.goto(srv.url, { waitUntil: 'load' });
      const g = await until(() => page.evaluate(() => window.__game ?? null), 60000, 'window.__game').catch(() => null);
      await sleep(400);
      const screen = await page.evaluate(() => { const el = document.getElementById('gf-vista-nowebgpu'); if (!el) return null; const r = el.getBoundingClientRect(), a = el.querySelector('a'); return { shown: r.width > 200 && r.height > 200 && getComputedStyle(el).display !== 'none', title: el.querySelector('h1')?.textContent ?? '', link: a?.getAttribute('href') ?? null, text: el.textContent.slice(0, 400) }; });
      const f = `${String(rec.shots.length + 1).padStart(2, '0')}-no-webgpu.jpg`; rec.shots.push(f);
      await page.screenshot({ path: join(outDir, f), type: 'jpeg', quality: 80 }).catch(() => {});
      const title = game.text?.title ?? game.title ?? '';
      const core = asked.filter(u => u.includes('/gf/vista/core/'));
      const linkOk = !!screen?.link && new URL(screen.link, srv.url).href.replace(/\/$/, '') === new URL(srv.url).href.replace(/\/$/, '');
      const ok = !!screen?.shown && screen.title.includes(title) && linkOk && g?.phase === 'unsupported' && core.length === 0 && errors.length === 0;
      rec.noWebgpu = { screen, phase: g?.phase ?? null, reason: g?.unsupported?.reason ?? null, coreRequests: core.length, errors: errors.slice(0, 3), shot: f };
      log(`no-webgpu: ${JSON.stringify(rec.noWebgpu).slice(0, 300)}`);
      add(32, 'no WebGPU: the kit\'s screen', ok, ok
        ? `a Chrome without WebGPU (${g.unsupported?.reason}) shows the kit's screen "${screen.title}" with the game's link, never a blank canvas; none of the core was downloaded`
        : `${!screen ? 'no kit screen (#gf-vista-nowebgpu) on a Chrome without WebGPU' : !screen.shown ? 'the kit screen is not shown' : !screen.title.includes(title) ? `its title "${screen.title}" is not the game's` : !linkOk ? `its link ${screen.link} is not the game's` : ''}${g?.phase !== 'unsupported' ? `; window.__game.phase is ${g?.phase ?? 'missing'}` : ''}${core.length ? `; ${core.length} core files were asked for` : ''}${errors.length ? `; page errors: ${errors[0]}` : ''}`);
    } finally { await browser.close().catch(() => {}); }
    env.lapNow('no WebGPU');
  });
}

// =====================================================================================================================
// after the solo session

async function check23({ want, statics, shotsForLikeness }) { if (want(23)) await statics.look(shotsForLikeness); }

// =====================================================================================================================
// two players (their own browsers, beside the solo session)

async function runDuo(env) {
  const { dir, outDir, rec, log, lap, want } = env;
  const out = {};
  const t = Date.now();
  if (want(5) || want(6)) out.gate = await gate(dir, { out: outDir, seconds: 75, log: line => log(`  gate ${line}`) }).catch(e => ({ verdict: 'fail', checks: [{ name: 'run', ok: false, detail: e.message }] }));
  if (want(5)) out.sight = await checkVistaSight({ dir, outDir, shots: rec.shots, log: line => log(`  ${line}`) }).catch(e => ({ ok: false, detail: `vista sight: ${e.message}`, record: null, warnings: [] }));
  if (want(25)) out.fr = await checkFriends({ dir, outDir, shots: rec.shots, log: line => log(`  ${line}`), phones: false }).catch(e => ({ ok: false, detail: `friends: ${e.message}`, record: null, warnings: [] }));
  // 34 (a release measure): go live in a round, a viewer watches through the streamer's eyes, then joins (vista's Go
  // live and voice go through gf/mp since 2026-10-13, runtimes/vista/kit/watch.js)
  if (want(34)) out.wa = await checkFriendsWatch({ dir, outDir, shots: rec.shots, log: line => log(`  ${line}`) }).catch(e => ({ ok: false, detail: `watch: ${e.message}`, record: null, warnings: [] }));
  lap('two players (gate, friends, watch)', t);
  return out;
}

/** The gate's random-input steps the sight leg proves on purpose. In first person a random walk can leave a friend out
 *  of view (the two on-screen samples), and on the pier head the gate's random keys and clicks do not always carry the
 *  host the 2.5 m its movement step asks for (the final proof run of 2026-10-12 moved it 2.4 m; the joiner drew it
 *  0.00 m off): the sight leg's walk on real keys proves the same thing, to 0.5 m rather than the gate's 5. */
const GATE_LOOKS = ['a-friend-is-on-screen', 'both-see-each-other-on-screen', 'host-movement-shows-on-the-joiner'];
/** 5: the shared live gate and vista's sight leg. A gate step the sight leg stands in for is named in the detail. */
function check5({ want, add, rec }, { gate: g, sight }) {
  if (!want(5) || !g) return;
  const replaced = [], failed = [];
  for (const c of g.checks ?? []) {
    if (c.ok) continue;
    if (GATE_LOOKS.includes(c.name) && sight?.ok) replaced.push(c.name); else failed.push(c);
  }
  // the gate's own verdict counts the random-look checks the sight leg stood in for: those alone never fail check 5
  // (the T7 repair round 3 saw the sight leg pass and check 5 fail on the gate's verdict, 2026-10-12); a gate that
  // failed with no check to show for it (a crash) still fails
  const gateOk = failed.length === 0 && (g.checks?.length ?? 0) > 0 && (g.verdict !== 'fail' || replaced.length > 0);
  rec.gate = { verdict: g.verdict, passed: g.passed, total: g.total, run: g.run ?? null, failed: failed.map(c => `${c.name}${c.soft ? ' (soft)' : ''}: ${c.detail}`), replacedBySight: replaced };
  rec.vistaSight = sight?.record ?? { ok: false, detail: sight?.detail };
  if (replaced.length) rec.notes.push(`check 5: the gate's ${replaced.join(' and ')} (random input in first person) stood in for by vista's sight leg, where each player has the other on screen at the start place, the core's own pixels of the friend are measured, and each walks on real keys and is drawn within 0.5 m of where they are on the other's screen`);
  add(5, 'two-player live gate', gateOk && !!sight?.ok, `gate ${g.verdict} ${g.passed ?? 0}/${g.total ?? 0}${replaced.length ? ` (${replaced.join(', ')}: the sight leg's)` : ''}${failed.length ? `; failed: ${failed.slice(0, 3).map(c => `${c.name}${c.soft ? ' (soft)' : ''}`).join(', ')}` : ''}; sight: ${sight?.detail ?? 'not run'}`);
}
/** 6: a session to results and replay, alone (the solo round) and with two players (the gate's own steps). */
function check6({ want, add, solo, play }, duo) {
  if (!want(6)) return;
  const g = name => (duo?.gate?.checks ?? []).find(c => c.name === name)?.ok === true;
  const soloOk = !!solo?.ok;
  const duoOk = !!duo?.gate && g('both-see-the-same-results') && g('play-again-starts-a-new-round') && g('host-ends-the-round');
  const pl = play ?? null;
  add(6, 'a round reaches results and replays', soloOk && duoOk && (!pl || pl.ok), `${pl && !pl.ok ? `${pl.detail}. ` : ''}alone: ${soloOk ? `results (${(solo.results ?? []).map(r => `${r.name} ${r.value}`).join(', ')}), Play again → round 2` : 'did not reach results and a second round'}; two players: ${duo?.gate ? (duoOk ? 'the same results on both, play again, the host ends round 2' : 'the gate did not show results, play again and end round') : 'not run'}${pl?.ok ? `; ${pl.detail}` : ''}`, pl && !pl.ok ? { area: 'play' } : {});
}
function check34({ want, add, rec }, { wa }) {
  if (!want(34) || !wa) return;
  rec.watch = wa.record; if (wa.warnings?.length) rec.notes.push(...wa.warnings);
  add(34, 'watch then play', wa.ok, wa.detail);
}
function check25({ want, add, rec }, { fr }) {
  if (!want(25) || !fr) return;
  rec.friends = fr.record; if (fr.warnings?.length) rec.notes.push(...fr.warnings);
  add(25, 'playing with friends', fr.ok, fr.detail);
}
